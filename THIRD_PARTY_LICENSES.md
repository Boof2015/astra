# Third-Party Licenses

Astra is licensed under the GNU General Public License v3.0 (see `LICENSE`).
It incorporates the third-party components below. Full corresponding source
for the vendored components is available in this repository (including the
`third_party/` submodules and the build scripts under `scripts/build/`). The
zlib source linked through Emscripten's official port is identified below.

## Spatial audio renderer (`spatial-renderer.wasm`, `spatial-hrtf-prep.wasm`)

The binaural renderer and off-thread HRTF preparation module are built from
`native/spatial-wasm/` by `scripts/build/build-spatial-wasm.sh`. They include
the following third-party components:

### libspatialaudio (HRTF interface glue)

Copyright © VideoLabs, VideoLAN and contributors.
Licensed under the GNU Lesser General Public License v2.1 or later
(`third_party/libspatialaudio/LICENSE`). Files without a per-file notice,
including `source/hrtf/mit_hrtf.cpp`, `include/hrtf/hrtf.h` and
`include/hrtf/mit_hrtf.h`, are used under this license. Distributed here as
part of a GPLv3 application with complete corresponding source.

### MIT HRTF C Library

Copyright © 2007 Aristotel Digenis. Credit: Bill Gardner and Keith Martin.
Licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to
> deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
> sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
> FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
> IN THE SOFTWARE.

The embedded head-related transfer functions are derived from the KEMAR
dummy-head measurements by Bill Gardner and Keith Martin, © 1994 MIT Media
Laboratory, provided free with the request that the authors be cited:
B. Gardner and K. Martin, "HRTF Measurements of a KEMAR Dummy-Head
Microphone," MIT Media Lab Perceptual Computing Technical Report #280, 1994.

### libmysofa

Copyright © 2016–2017 Symonics GmbH and Christian Hoene. All rights reserved.
Licensed under the BSD 3-Clause License (`third_party/libmysofa/LICENSE`).
The source is pinned at commit `90531bdb0b485dd36e8a14b3e37ce1c47c54d669`
in the `third_party/libmysofa` submodule.

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice,
> this list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice,
> this list of conditions and the following disclaimer in the documentation
> and/or other materials provided with the distribution.
> 3. The name of the author may not be used to endorse or promote products
> derived from this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE AUTHOR “AS IS” AND ANY EXPRESS OR IMPLIED
> WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO
> EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
> SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
> PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
> OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
> WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
> OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
> ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### Speex resampler (vendored by libmysofa)

Copyright © 2007–2008 Jean-Marc Valin and © 2008 Thorvald Natvig. Licensed
under the BSD 3-Clause License; the complete notice is retained in
`third_party/libmysofa/src/resampler/speex_resampler.c` and
`speex_resampler.h`. The resampler is compiled into `spatial-hrtf-prep.wasm`
to convert imported HRIRs to the active AudioContext rate.

### zlib

Copyright © 1995–2026 Jean-loup Gailly and Mark Adler. `zlib` 1.3.2 is linked
into `spatial-hrtf-prep.wasm` through Emscripten's official `-sUSE_ZLIB=1`
port to read compressed HDF5 data in SOFA files.

> This software is provided “as-is”, without any express or implied warranty.
> In no event will the authors be held liable for any damages arising from the
> use of this software.
>
> Permission is granted to anyone to use this software for any purpose,
> including commercial applications, and to alter it and redistribute it
> freely, subject to the following restrictions:
>
> 1. The origin of this software must not be misrepresented; you must not claim
> that you wrote the original software. If you use this software in a product,
> an acknowledgment in the product documentation would be appreciated but is
> not required.
> 2. Altered source versions must be plainly marked as such, and must not be
> misrepresented as being the original software.
> 3. This notice may not be removed or altered from any source distribution.

### SOFA test fixture

`test/fixtures/sofa/MIT_KEMAR_normal_pinna.sofa` is used by the artifact tests.
The measurements are Copyright © 1994 MIT Media Laboratory, Bill Gardner and
Keith Martin, and are provided free without use restrictions provided the
authors are cited (`test/fixtures/sofa/LICENSE.MIT_KEMAR_pinnae`).

### Kiss FFT

Copyright © 2003–2010 Mark Borgerding. All rights reserved.
Licensed under the BSD 3-Clause License:

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> * Redistributions of source code must retain the above copyright notice,
>   this list of conditions and the following disclaimer.
> * Redistributions in binary form must reproduce the above copyright notice,
>   this list of conditions and the following disclaimer in the documentation
>   and/or other materials provided with the distribution.
> * Neither the author nor the names of any contributors may be used to
>   endorse or promote products derived from this software without specific
>   prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

## IAMF decoder (`iamf-decoder.wasm`)

The Eclipsa Audio / IAMF decoder is built from `native/iamf-wasm/iamf_wrapper.c`
by `scripts/build/build-iamf-wasm.sh` and includes the following components
(pinned as submodules under `third_party/`). AAC substream support is
deliberately not compiled: libiamf's AAC path requires the Fraunhofer FDK AAC
library, whose license is incompatible with GPLv3 distribution.

### libiamf

Copyright © Alliance for Open Media and contributors.
Licensed under the BSD 3-Clause Clear License
(`third_party/libiamf/LICENSE`) with the Alliance for Open Media Patent
License 1.0 (`third_party/libiamf/PATENTS`). Pinned at tag v1.1.0. The build
compiles the core decoder (`code/src/common`, `code/src/iamf_dec` with the
Opus/FLAC/PCM codec glue); it includes the vendored Speex resampler
(`resample.c`, BSD, Copyright © 2003–2008 Jean-Marc Valin).

### Opus

Copyright © Xiph.Org Foundation and contributors.
Licensed under the BSD 3-Clause License (`third_party/opus/COPYING`).
Pinned at tag v1.4, compiled with emscripten and statically linked.

### FLAC (libFLAC)

Copyright © 2000–2009 Josh Coalson, 2011–2023 Xiph.Org Foundation.
Licensed under the BSD 3-Clause License (`third_party/flac/COPYING.Xiph`).
Pinned at tag 1.4.3, compiled with emscripten and statically linked.

### IAMF conformance test fixtures

The files under `src/shared/iamf/__fixtures__/` are conformance vectors from
the libiamf repository (`tests/` directory), used by the automated tests and
covered by the same BSD 3-Clause Clear License.

## Astra Signal (`@boof2015/astra-signal`)

Copyright © 2026 Boof2015.
Licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Bundled decoder binaries

Astra bundles `ffmpeg` and `ffprobe` binaries via the `ffmpeg-static` and
`ffprobe-static` npm packages. FFmpeg is a trademark of Fabrice Bellard;
the binaries are licensed under the GPL (see https://ffmpeg.org/legal.html).

## r8brain-free-src

Astra's Exclusive DSP output uses r8brain-free-src 7.1, vendored (headers
only) under `third_party/r8brain-free-src`. r8brain-free-src is Copyright
(c) Aleksey Vaneev and licensed under the MIT License; see
`third_party/r8brain-free-src/LICENSE` for the complete license text.
