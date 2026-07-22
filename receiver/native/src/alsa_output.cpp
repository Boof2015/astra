// Minimal push-model ALSA playback addon for the standalone Parallax receiver.
//
// One PCM handle per process (the daemon drives exactly one device). The JS PlayoutDriver
// renders interleaved Float32 blocks and pushes them here; `delayFrames` (snd_pcm_delay) reports
// how much pushed audio has not yet left the DAC, which is the daemon's output-latency source —
// the replacement for the renderer's AudioContext latency estimates, with better precision.
//
// The device is opened in non-blocking mode and writes are capped to snd_pcm_avail_update, so
// `write` never blocks the event loop. xruns recover via snd_pcm_prepare and are counted.
//
// Intentionally uses SND_PCM_FORMAT_FLOAT_LE: with 'default'/'plughw' devices the ALSA plug
// layer converts to whatever the hardware speaks. Raw 'hw:' devices must support float natively.

#include <napi.h>

#ifdef __linux__
#include <alsa/asoundlib.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <cstddef>
#include <cstdlib>
#include <cstring>

namespace {

snd_pcm_t* g_pcm = nullptr;
unsigned int g_channels = 2;
unsigned int g_sample_rate = 48000;
uint64_t g_underruns = 0;

void ThrowAlsa(const Napi::Env& env, const char* what, int err) {
  std::string message = std::string(what) + ": " + snd_strerror(err);
  Napi::Error::New(env, message).ThrowAsJavaScriptException();
}

Napi::Value Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "open(device, sampleRate, channels)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_pcm != nullptr) {
    snd_pcm_close(g_pcm);
    g_pcm = nullptr;
  }
  std::string device = info[0].As<Napi::String>().Utf8Value();
  g_sample_rate = info[1].As<Napi::Number>().Uint32Value();
  g_channels = info[2].As<Napi::Number>().Uint32Value();
  if (g_channels < 1 || g_channels > 8 || g_sample_rate < 8000 || g_sample_rate > 384000) {
    Napi::RangeError::New(env, "Invalid sampleRate/channels").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  int err = snd_pcm_open(&g_pcm, device.c_str(), SND_PCM_STREAM_PLAYBACK, SND_PCM_NONBLOCK);
  if (err < 0) {
    g_pcm = nullptr;
    ThrowAlsa(env, "snd_pcm_open failed", err);
    return env.Undefined();
  }
  // Explicit hw_params instead of snd_pcm_set_params: the convenience helper picks ~4 periods
  // per buffer — ~125 ms periods for a 500 ms buffer. The hardware pointer (and therefore
  // snd_pcm_delay, our emission clock) only advances per period, so a write-ahead loop holding
  // ~120 ms sees the queue "full" for a whole period, freezes, then bursts — a built-in ~125 ms
  // sawtooth the sync loop reads as drift and audibly chases (slew/snap oscillation observed on
  // the first Pi 5 listen). Small periods make delay near-continuous; the buffer stays ~500 ms.
  snd_pcm_hw_params_t* hw_params;
  snd_pcm_hw_params_alloca(&hw_params);
  snd_pcm_hw_params_any(g_pcm, hw_params);
  err = snd_pcm_hw_params_set_access(g_pcm, hw_params, SND_PCM_ACCESS_RW_INTERLEAVED);
  if (err >= 0) err = snd_pcm_hw_params_set_format(g_pcm, hw_params, SND_PCM_FORMAT_FLOAT_LE);
  if (err >= 0) err = snd_pcm_hw_params_set_channels(g_pcm, hw_params, g_channels);
  unsigned int negotiated_rate = g_sample_rate;
  if (err >= 0) err = snd_pcm_hw_params_set_rate_near(g_pcm, hw_params, &negotiated_rate, nullptr);
  snd_pcm_uframes_t period_frames = 1024;  // ~21 ms at 48 kHz
  int period_dir = 0;
  if (err >= 0) err = snd_pcm_hw_params_set_period_size_near(g_pcm, hw_params, &period_frames, &period_dir);
  snd_pcm_uframes_t buffer_frames = period_frames * 24;  // ~500 ms at 48 kHz
  if (err >= 0) err = snd_pcm_hw_params_set_buffer_size_near(g_pcm, hw_params, &buffer_frames);
  if (err >= 0) err = snd_pcm_hw_params(g_pcm, hw_params);
  if (err < 0) {
    snd_pcm_close(g_pcm);
    g_pcm = nullptr;
    ThrowAlsa(env, "snd_pcm_hw_params failed", err);
    return env.Undefined();
  }
  g_sample_rate = negotiated_rate;

  // snd_pcm_set_params sets the start threshold to (roughly) the full buffer size. A write-ahead
  // loop that keeps only ~120 ms queued never crosses a 500 ms threshold, so the device sits in
  // PREPARED forever — absorbing writes, reporting sane delay, playing nothing (observed on
  // vc4hdmi: healthy daemon, total silence). Start as soon as the first driver block lands.
  {
    snd_pcm_sw_params_t* sw_params;
    snd_pcm_sw_params_alloca(&sw_params);
    if (snd_pcm_sw_params_current(g_pcm, sw_params) >= 0) {
      snd_pcm_sw_params_set_start_threshold(g_pcm, sw_params, 2048);
      snd_pcm_sw_params(g_pcm, sw_params);
    }
  }

  g_underruns = 0;
  Napi::Object result = Napi::Object::New(env);
  result.Set("sampleRate", Napi::Number::New(env, g_sample_rate));
  return result;
}

Napi::Value Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_pcm == nullptr) {
    return Napi::Number::New(env, 0);
  }
  if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "write(float32Interleaved, frames)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Float32Array samples = info[0].As<Napi::Float32Array>();
  int64_t frames = info[1].As<Napi::Number>().Int64Value();
  if (frames <= 0) return Napi::Number::New(env, 0);
  int64_t max_frames = static_cast<int64_t>(samples.ElementLength() / g_channels);
  if (frames > max_frames) frames = max_frames;

  snd_pcm_sframes_t avail = snd_pcm_avail_update(g_pcm);
  if (avail == -EPIPE) {
    g_underruns += 1;
    snd_pcm_prepare(g_pcm);
    avail = snd_pcm_avail_update(g_pcm);
  }
  if (avail < 0) {
    snd_pcm_recover(g_pcm, static_cast<int>(avail), 1);
    avail = snd_pcm_avail_update(g_pcm);
    if (avail < 0) return Napi::Number::New(env, 0);
  }
  if (avail < frames) frames = avail;
  if (frames <= 0) return Napi::Number::New(env, 0);

  snd_pcm_sframes_t written = snd_pcm_writei(g_pcm, samples.Data(), static_cast<snd_pcm_uframes_t>(frames));
  if (written == -EAGAIN) return Napi::Number::New(env, 0);
  if (written == -EPIPE) {
    g_underruns += 1;
    snd_pcm_prepare(g_pcm);
    written = snd_pcm_writei(g_pcm, samples.Data(), static_cast<snd_pcm_uframes_t>(frames));
  }
  if (written < 0) {
    written = snd_pcm_recover(g_pcm, static_cast<int>(written), 1);
    if (written < 0) return Napi::Number::New(env, 0);
    return Napi::Number::New(env, 0);
  }
  return Napi::Number::New(env, static_cast<double>(written));
}

Napi::Value DelayFrames(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_pcm == nullptr) return Napi::Number::New(env, 0);
  snd_pcm_sframes_t delay = 0;
  int err = snd_pcm_delay(g_pcm, &delay);
  if (err < 0 || delay < 0) return Napi::Number::New(env, 0);
  return Napi::Number::New(env, static_cast<double>(delay));
}

Napi::Value Underruns(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), static_cast<double>(g_underruns));
}

Napi::Value Close(const Napi::CallbackInfo& info) {
  if (g_pcm != nullptr) {
    // Service shutdown/reboot has no audible-completion contract. Drop queued frames instead of
    // draining them so a stalled device cannot block Node until systemd's stop deadline.
    snd_pcm_drop(g_pcm);
    snd_pcm_close(g_pcm);
    g_pcm = nullptr;
  }
  return info.Env().Undefined();
}

// sd_notify without libsystemd: NOTIFY_SOCKET is an AF_UNIX datagram socket, which Node's
// dgram module (UDP-only) cannot reach. Sending from this process keeps systemd's default
// NotifyAccess=main PID attribution intact. Returns false (never throws) when NOTIFY_SOCKET
// is unset or the send fails — the daemon treats notification as best-effort.
Napi::Value SdNotify(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "sdNotify(state)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const char* socket_path = std::getenv("NOTIFY_SOCKET");
  if (socket_path == nullptr || socket_path[0] == '\0') {
    return Napi::Boolean::New(env, false);
  }
  std::string state = info[0].As<Napi::String>().Utf8Value();

  struct sockaddr_un addr;
  std::memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  size_t path_len = std::strlen(socket_path);
  if (path_len > sizeof(addr.sun_path)) {
    return Napi::Boolean::New(env, false);
  }
  std::memcpy(addr.sun_path, socket_path, path_len);
  // Leading '@' names an abstract-namespace socket (systemd in containers): byte 0 becomes NUL.
  if (addr.sun_path[0] == '@') addr.sun_path[0] = '\0';

  int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return Napi::Boolean::New(env, false);
  socklen_t addr_len = static_cast<socklen_t>(offsetof(struct sockaddr_un, sun_path) + path_len);
  ssize_t sent = sendto(fd, state.data(), state.size(), 0,
                        reinterpret_cast<const struct sockaddr*>(&addr), addr_len);
  close(fd);
  return Napi::Boolean::New(env, sent == static_cast<ssize_t>(state.size()));
}

}  // namespace

#else  // !__linux__ — stub so an accidental build off-Linux fails at runtime, not compile time.

namespace {

Napi::Value Open(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), "ALSA output is only available on Linux.").ThrowAsJavaScriptException();
  return info.Env().Undefined();
}
Napi::Value Write(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), 0); }
Napi::Value DelayFrames(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), 0); }
Napi::Value Underruns(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), 0); }
Napi::Value Close(const Napi::CallbackInfo& info) { return info.Env().Undefined(); }
Napi::Value SdNotify(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), false); }

}  // namespace

#endif

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("open", Napi::Function::New(env, Open));
  exports.Set("write", Napi::Function::New(env, Write));
  exports.Set("delayFrames", Napi::Function::New(env, DelayFrames));
  exports.Set("underruns", Napi::Function::New(env, Underruns));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("sdNotify", Napi::Function::New(env, SdNotify));
  return exports;
}

NODE_API_MODULE(astra_receiver_alsa, Init)
