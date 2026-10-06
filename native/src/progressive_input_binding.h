#pragma once
#include <napi.h>
#include "playback_engine.h"

namespace NativePlayback {
using SnapshotObjectFactory = Napi::Object (*)(Napi::Env, const PlaybackSnapshot&);
void RegisterProgressiveInputBinding(Napi::Env env, Napi::Object exports,
    PlaybackEngine& engine, SnapshotObjectFactory snapshotFactory);
}
