# Native third-party notices

## Markdig 1.6.0

Source: https://github.com/xoofx/markdig/tree/1.6.0

License: BSD-2-Clause. The following notice is retained from the fixed release's
`license.txt`. This library is bundled in the application, not downloaded at runtime.

```text
Copyright (c) 2016-2026, Alexandre Mutel
All rights reserved.

Redistribution and use in source and binary forms, with or without modification
, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Native diagram renderer

Mermaider/Sugiyama 0.17.0, Svg.Skia-family 5.2.3, SkiaSharp 4.148.0, HarfBuzzSharp 14.2.0, ObjectPool 11.0.0 and ExCSS 4.3.1 are included for offline diagrams. Exact dependency versions/source commits and full notices are distributed in `third_party/diagrams/`. Keep that complete directory with the application. Svg.Custom is MS-PL, not MIT; native Skia/HarfBuzz also retain their own third-party notices. No runtime package or font download is performed.
