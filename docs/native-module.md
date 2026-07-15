# Native visualizer module — packaging & troubleshooting

Astra ships a native C++ addon, **`visualizer_dsp.node`**, that powers the high‑performance
audio visualizers. If it fails to load, several scopes go blank. This guide is for anyone
**packaging Astra from source** (distro maintainers, third‑party repackagers) and for triaging
"my scope stopped working" reports.

## What depends on the native module

`visualizer_dsp.node` is required by the **native‑only** scopes — without it they render nothing
usable and Astra now shows a *"Native DSP unavailable"* notice in their place:

- Spectrum
- Oscilloscope
- Spectrogram
- LUFS meter

The remaining scopes have JavaScript fallbacks and keep working (at reduced quality) even when the
addon is missing:

- Vectorscope
- Waveform
- VU meter

> **Quick triage:** *spectrum/oscilloscope blank but the vectorscope still animates* ⇒ the native
> DSP addon did not load. This is almost always a packaging or environment problem, not an Astra
> rendering bug — the fallbacks and blank scopes are exactly what a missing addon produces.

## How the module is loaded at runtime

The addon is `require`d once in the preload and exposed to the renderer as `window.visualizerAPI`
([`src/preload/index.ts`](../src/preload/index.ts)):

- **Development:** `native/build/Release/visualizer_dsp.node` (relative to the preload output).
- **Packaged:** **`<app>/resources/native/visualizer_dsp.node`** (`process.resourcesPath/native/…`).

If that `require` throws, it is caught: `window.visualizerAPI` becomes `null` and the app keeps
running with the fallbacks/notice above. The failure reason is logged to the DevTools console and
surfaced in the in‑app notice.

## Building & bundling the addon (for packagers)

1. **Build dependencies** (Linux): `build-essential`, `python3`, and **`libasound2-dev`** — the
   addon links ALSA (`-lasound`). macOS needs the Xcode Command Line Tools; Windows needs the
   Visual Studio Build Tools.

2. **Compile against the shipping Electron ABI**, not system Node:

   ```bash
   npm run rebuild:native      # node-gyp rebuild --target=<electron ver> --dist-url=electron headers
   ```

   A plain `node-gyp rebuild` / `npm run build:native` compiles against your system Node's ABI; the
   resulting `.node` will throw at load time inside Electron. Always use `rebuild:native`.

3. **Place the binary at `resources/native/visualizer_dsp.node`.** The official
   [`electron-builder`](../package.json) config does this automatically via `extraResources`
   (`native/build/Release/*.node` → `resources/native/`). If you repackage the app by hand or with
   a different tool, you must reproduce that layout — moving or flattening `resources/` breaks the
   packaged `require` path.

4. **Verify the artifact exists — the compile step is non‑fatal.** `postinstall` runs
   `npm run rebuild:native || echo '…'`, so a failed native build does **not** fail `npm install`;
   a broken package can ship silently. Mirror the CI check
   ([`.github/workflows/main.yml`](../.github/workflows/main.yml),
   [`release.yml`](../.github/workflows/release.yml)) and hard‑fail if the file is absent:

   ```bash
   test -f native/build/Release/visualizer_dsp.node || { echo "native module missing"; exit 1; }
   ```

> The reference AUR binary package sidesteps all of this by extracting the official prebuilt
> AppImage, which already contains a correctly‑placed `.node`. Building from source or repackaging
> a different artifact does not get that for free.

## Diagnosing a missing/broken module

Open DevTools (**Ctrl+Shift+I** / **F12** → Console) and look for:

```
Failed to load native visualizer DSP module: <error>
```

The `<error>` tells you which class of problem it is:

| Error text | Meaning | Fix |
|---|---|---|
| `ENOENT` / "no such file or directory" | The `.node` was not included at `resources/native/` | Fix packaging layout (step 3) |
| `cannot open shared object file: libasound.so.2` (or similar) | The binary is present but a shared library it links is missing/moved | Ensure `libasound`/`libstdc++`/`glibc` are present; rebuild for the target environment |
| `undefined symbol …` / `NODE_MODULE_VERSION` mismatch | Built against the wrong ABI (system Node instead of Electron) | Rebuild with `npm run rebuild:native` (step 2) |

Note that a binary which **worked before and then stopped after a system update** points to the
shared‑library / ABI cases above (the distro moved underneath a dynamically‑linked build), not a
missing file. The same reason string is shown in the in‑app *"Native DSP unavailable"* notice, so
users can report it without opening DevTools.
