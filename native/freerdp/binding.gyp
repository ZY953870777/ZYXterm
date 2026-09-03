{
  "targets": [
    {
      "target_name": "freerdp",
      "sources": [ "src/rdp_session.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "/usr/include/freerdp3",
        "/usr/include/winpr3"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NODE_ADDON_API_CPP_EXCEPTIONS=1"
      ],
      "cflags_cc": [ "-std=c++17", "-fexceptions" ],
      "libraries": [ "-lfreerdp3", "-lwinpr3" ],
      "ldflags": [ "-Wl,-rpath,'$$ORIGIN'" ],
      "conditions": [
        [
          "OS=='win'",
          {
            "include_dirs": [
              "third_party/freerdp/include"
            ],
            "libraries": [
              "-lfreerdp3.lib",
              "-lwinpr3.lib"
            ],
            "library_dirs": [
              "third_party/freerdp/lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ],
        [
          "OS=='mac'",
          {
            "include_dirs": [
              "third_party/mac_include",
              "/usr/local/include",
              "/usr/local/include/freerdp3",
              "/opt/homebrew/include",
              "/opt/homebrew/include/freerdp3"
            ],
            "libraries": [ "-lfreerdp3", "-lwinpr3" ],
            "library_dirs": [
              "third_party/mac_lib",
              "/usr/local/lib",
              "/opt/homebrew/lib"
            ],
            "xcode_settings": {
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "GCC_ENABLE_CPP_RTTI": "YES",
              "OTHER_CPLUSPLUSFLAGS": [ "-fexceptions" ],
              "OTHER_LDFLAGS": [ "-Wl,-rpath,@loader_path" ]
            }
          }
        ]
      ]
    }
  ]
}
