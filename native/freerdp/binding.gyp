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
        ]
      ]
    }
  ]
}
