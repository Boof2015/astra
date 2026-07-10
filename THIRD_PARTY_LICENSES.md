# Third-Party Licenses

Astra is licensed under the GNU General Public License v3.0 (see `LICENSE`).
It incorporates the third-party components below. Full corresponding source
for everything listed here is available in this repository (including the
`third_party/` submodules and the build scripts under `scripts/build/`).

## Spatial audio renderer (`spatial-renderer.wasm`)

The binaural renderer is built from `native/spatial-wasm/spatial_wrapper.cpp`
by `scripts/build/build-spatial-wasm.sh` and includes the following code from
the [libspatialaudio](https://github.com/videolabs/libspatialaudio) repository
(pinned as a submodule at `third_party/libspatialaudio`):

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

## Bundled decoder binaries

Astra bundles `ffmpeg` and `ffprobe` binaries via the `ffmpeg-static` and
`ffprobe-static` npm packages. FFmpeg is a trademark of Fabrice Bellard;
the binaries are licensed under the GPL (see https://ffmpeg.org/legal.html).
