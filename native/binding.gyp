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
        "src/dsp_utils.cpp"
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
          }
        }],
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/O2"]
            }
          }
        }],
        ["OS=='linux'", {
          "cflags_cc": ["-std=c++17", "-O3", "-ffast-math", "-fPIC"],
          "ldflags": ["-Wl,-z,now"]
        }]
      ]
    },
    {
      "target_name": "native_audio",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17", "-O3", "-ffast-math"],
      "sources": [
        "src/native_audio_bindings.cpp",
        "src/native_audio.cpp",
        "src/dsp_utils.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src",
        "vendor"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          },
          "libraries": [
            "-framework CoreAudio",
            "-framework AudioToolbox",
            "-framework CoreFoundation"
          ]
        }],
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/O2"]
            }
          }
        }],
        ["OS=='linux'", {
          "cflags_cc": ["-std=c++17", "-O3", "-ffast-math", "-fPIC"],
          "ldflags": ["-Wl,-z,now"],
          "libraries": [
            "-lpthread",
            "-lm",
            "-ldl"
          ]
        }]
      ]
    }
  ]
}
