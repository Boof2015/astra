{
  "targets": [
    {
      "target_name": "native_audio_processing",
      "type": "static_library",
      "cflags_cc": ["-std=c++17", "-O3", "-fno-fast-math"],
      "sources": [
        "src/audio_processing.cpp"
      ],
      "include_dirs": [
        "src",
        "../third_party/r8brain-free-src"
      ],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/O2", "/fp:strict"]
            }
          }
        }]
      ]
    },
    {
      "target_name": "native_playback_state_tests",
      "type": "executable",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "dependencies": ["native_audio_processing"],
      "cflags_cc": ["-std=c++17"],
      "sources": [
        "src/playback_engine.cpp",
        "test/playback_engine_state_test.cpp"
      ],
      "include_dirs": ["src"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
          }
        }],
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1 }
          }
        }]
      ]
    },
    {
      "target_name": "visualizer_dsp",
      "dependencies": ["native_audio_processing"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17", "-O3", "-ffast-math"],
      "sources": [
        "src/main.cpp",
        "src/oscilloscope.cpp",
        "src/spectrum.cpp",
        "src/spectrogram.cpp",
        "src/vectorscope.cpp",
        "src/multiband.cpp",
        "src/waveform.cpp",
        "src/vumeter.cpp",
        "src/lufsmeter.cpp",
        "src/dsp_utils.cpp",
        "src/playback_engine.cpp",
        "src/coreaudio_hal_sink.cpp",
        "src/alsa_hw_sink.cpp",
        "src/wasapi_exclusive_sink.cpp",
        "src/parallax_loopback.cpp",
        "src/process_memory.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++"
          },
          "link_settings": {
            "libraries": [
              "-framework CoreAudio",
              "-framework AudioToolbox",
              "-framework CoreFoundation"
            ]
          }
        }],
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/O2"]
            }
          },
          "link_settings": {
            "libraries": [
              "Ole32.lib",
              "Avrt.lib",
              "Mmdevapi.lib",
              "Uuid.lib",
              "Psapi.lib"
            ]
          }
        }],
        ["OS=='linux'", {
          "cflags_cc": ["-std=c++17", "-O3", "-ffast-math", "-fPIC"],
          "ldflags": ["-Wl,-z,now"],
          "link_settings": {
            "libraries": [
              "-lasound"
            ]
          }
        }]
      ]
    }
  ]
}
