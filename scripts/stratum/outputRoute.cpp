// Read-only route guard. No stream, microphone or device-setting operations.
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>

std::string currentOutput() {
  AudioObjectPropertyAddress address{kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, &device)) return {};
  address.mSelector = kAudioDevicePropertyDeviceUID;
  CFStringRef uid = nullptr;
  size = sizeof(uid);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &uid) || !uid) return {};
  char text[2048]{};
  bool valid = CFStringGetCString(uid, text, sizeof(text), kCFStringEncodingUTF8);
  CFRelease(uid);
  return valid ? text : "";
}
int main(int argc, char** argv) {
  if (argc != 3) return 2;
  const bool once = std::string(argv[2]) == "once";
  for (int i = 0; i < (once ? 1 : 360); ++i) {
    if (currentOutput() != argv[1]) { std::cout << "ROUTE_CHANGED" << std::endl; return 1; }
    if (!i) std::cout << "ROUTE_VERIFIED" << std::endl;
    if (!once) std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  return once ? 0 : 1;
}
