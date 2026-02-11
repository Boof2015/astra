# Astra

An audiophile-grade desktop music player with real-time visualizers, a professional equalizer, and full library management. Built with Electron, React, and native C++ DSP.


![code size](https://img.shields.io/github/languages/code-size/Boof2015/astra)
![GitHub Release](https://img.shields.io/github/v/release/Boof2015/astra?include_prereleases)
![GitHub License](https://img.shields.io/github/license/Boof2015/astra)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/Boof2015/astra/main.yml)


## Features

**Playback**
- Gapless playback with pre-buffering
- Supports MP3, FLAC, WAV, OGG, AAC, M4A, OPUS, WMA, and AIFF
- FFmpeg compatibility fallback decode when primary browser decode fails (for example, some EC-3/JOC M4A files)
- Atmos (EC-3/JOC) metadata detection with compatibility FFmpeg decode into channel-based PCM (up to 5.1); not native Atmos object rendering/passthrough
- Shuffle, repeat (one/all), and queue management with drag-and-drop
- Track badges for Atmos and multichannel channel counts in library/now-playing/fullscreen views
- Optional Discord Rich Presence integration with live track/playback state updates

**Visualizers** (native C++ accelerated)
- Oscilloscope with pitch-lock detection
- Spectrum analyzer with configurable FFT
- Vectorscope for stereo phase imaging
- Analyzer path is tapped post-normalization and independent from output routing/remap, so scopes stay source-faithful

**Equalizer**
- Up to 10 bands (low shelf, peaking, high shelf)
- Built-in presets: Bass Boost, Treble Boost, Vocal, Loudness
- Preamp control (-12 to +12 dB)
- Real-time frequency response graph with spectrum overlay
- AutoEQ profile import support (`ParametricEQ.txt`) with preamp/filter parsing into Astra presets (up to 10 bands)

**Library**
- Scan and manage multiple music folders
- Browse by artist, album, or track
- Full-text search
- Automatic metadata extraction and album artwork caching

**Audio Settings**
- Loudness normalization (LUFS-based)
- Audio output device selection
- Output channel capability detection (per selected hardware device)
- Stereo-safe default mode with optional multichannel output mode
- Per-output channel remapping (including mute) with one-click reset to automatic routing
- Channel routing panel with mapped-channel status and downmix indicators

## Audio Pipeline

Current playback and analysis paths are intentionally split:

```text
Playback path:
Source Buffer
  -> (optional remap matrix: splitter/merger)
  -> Normalization Gain
  -> Preamp / EQ chain
  -> EQ Analyser (for EQ/fullscreen ambient overlays)
  -> Master Gain (volume/mute)
  -> Audio Destination

Analysis path (scopes):
Source Buffer
  -> Analysis Normalization Gain
  -> AudioWorklet tap
  -> Silent sink (keeps worklet pulled)
```

This keeps oscilloscope/spectrum/vectorscope data post-normalization but outside hardware routing/downmix decisions.

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

This project is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html). See [LICENSE](LICENSE) for the full text.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Boof2015/astra&type=date&legend=top-left)](https://www.star-history.com/#Boof2015/astra&type=date&legend=top-left)
