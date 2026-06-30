{
  "targets": [
    {
      "target_name": "visualizer_dsp",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17", "-O3", "-ffast-math"],
      "sources": [
        "src/main.cpp",
        "src/oscilloscope.cpp",
        "src/spectrum.cpp",
        "src/vectorscope.cpp",
        "src/dsp_utils.cpp",
        "src/playback_engine.cpp",
        "src/coreaudio_hal_sink.cpp",
        "src/alsa_hw_sink.cpp",
        "src/wasapi_exclusive_sink.cpp",
        "src/parallax_loopback.cpp"
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
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
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
              "Uuid.lib"
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
