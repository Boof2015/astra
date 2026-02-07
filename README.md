# Astra

An audiophile-grade desktop music player with real-time visualizers, a professional equalizer, and full library management. Built with Electron, React, and native C++ DSP.

## Features

**Playback**
- Gapless playback with pre-buffering
- Supports MP3, FLAC, WAV, OGG, AAC, M4A, OPUS, WMA, and AIFF
- Shuffle, repeat (one/all), and queue management with drag-and-drop

**Visualizers** (native C++ accelerated)
- Oscilloscope with pitch-lock detection
- Spectrum analyzer with configurable FFT
- Vectorscope for stereo phase imaging

**Equalizer**
- Up to 10 bands (low shelf, peaking, high shelf)
- Built-in presets: Bass Boost, Treble Boost, Vocal, Loudness
- Preamp control (-12 to +12 dB)
- Real-time frequency response graph with spectrum overlay

**Library**
- Scan and manage multiple music folders
- Browse by artist, album, or track
- Full-text search
- Automatic metadata extraction and album artwork caching

**Audio Settings**
- Loudness normalization (LUFS-based)
- Audio output device selection

## Download

Prebuilt binaries for Windows, macOS, and Linux are available on the [Releases](https://github.com/Boof2015/astra/releases) page.

## Building from Source

### Prerequisites

- Node.js 18+
- npm
- A C++ compiler toolchain (for the native module)
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio Build Tools
  - Linux: `build-essential`

### Install

```bash
git clone https://github.com/Boof2015/astra.git
cd astra
npm install
```

The `postinstall` script automatically compiles the native C++ visualizer module for your platform.

### Development

```bash
npm run dev
```

### Build

```bash
npm run build            # Build application assets
npm run dist             # Package for current platform
npm run dist:mac         # macOS (DMG + ZIP)
npm run dist:win         # Windows (NSIS + Portable)
npm run dist:linux       # Linux (AppImage + DEB)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 40 |
| UI | React 19, Tailwind CSS 4 |
| State | Zustand |
| Build | Vite, electron-vite |
| Audio | Web Audio API |
| DSP | Native C++ (N-API) |
| Database | sql.js (SQLite) |
| Metadata | music-metadata |
| Language | TypeScript |

## Project Structure

```
src/
  main/           Electron main process, IPC handlers, library DB
  preload/        Context bridge
  renderer/
    audio/        AudioEngine, native module loader, visualizers
    components/   React UI (layout, library, visualizers, EQ, queue, settings)
    stores/       Zustand stores (player, library, EQ, audio settings)
    types/        TypeScript type definitions
native/
  src/            C++ visualizer implementations (oscilloscope, spectrum, vectorscope)
```

## Support

If you find Astra useful, consider supporting development:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/boof2015)

## License

This project is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).

You are free to share and adapt this work for non-commercial purposes, with appropriate credit, under the same license. See [LICENSE](LICENSE) for details.
