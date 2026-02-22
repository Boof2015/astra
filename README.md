# Astra

A desktop music player for people who still have a music library.

![code size](https://img.shields.io/github/languages/code-size/Boof2015/astra)
![GitHub Release](https://img.shields.io/github/v/release/Boof2015/astra?include_prereleases)
![GitHub License](https://img.shields.io/github/license/Boof2015/astra)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/Boof2015/astra/main.yml)
![Discord](https://img.shields.io/discord/1474647789148573950)

![Astra home page](assets/home.png)

Astra is a music player built for local files — your FLACs, your MP3s, your carefully tagged collection. It's designed to sound right, look good, and stay out of the way. Under the hood it uses the Web Audio API and a native C++ DSP module for real-time analysis, but from the outside it's just a nice place to listen to music.

![Astra fullscreen mode](assets/Fullscreen.png)

## Playback

Gapless playback with pre-buffering, so albums flow the way they're meant to. Supports MP3, FLAC, WAV, OGG, AAC, M4A, OPUS, WMA, and AIFF, with an FFmpeg fallback for anything the browser can't decode natively. Shuffle, repeat, and a drag-and-drop queue round out the basics.

## Visualizers

Three real-time visualizers powered by native C++ — an oscilloscope with pitch-lock detection, a spectrum analyzer with configurable FFT, and a vectorscope for stereo phase imaging. The analysis path is tapped independently from your output routing, so the scopes always reflect the source material.

## Equalizer

A fully parametric EQ with up to 10 bands, a live frequency response graph with spectrum overlay, and built-in presets. You can save your own presets, and if you use AutoEQ, you can import headphone calibration profiles directly.

![Astra equalizer](assets/EQ.png)

## Library

Point Astra at your music folders and it handles the rest — metadata extraction, album artwork, and a searchable library you can browse by artist, album, or track. Favorites and recently played are tracked automatically.

## The rest of the experience

Astra has a fullscreen mode with an album art backdrop and ambient spectrum, a mini player for when you want it out of the way, and a home page with a sky that changes with the time of day. The interface adapts its accent color to whatever album art is playing, or you can pick from a handful of dark themes and set your own accent. There's an info sidebar for when you want to see the technical details of a track, and Discord Rich Presence if you like sharing what you're listening to.

## Audio settings

Output device selection, loudness normalization, multichannel support with per-channel remapping, and delay calibration for wireless or Bluetooth speaker setups.

## Download

Prebuilt binaries for Windows, macOS, and Linux are available on the [Releases](https://github.com/Boof2015/astra/releases) page.

## Building from source

You'll need Node.js 18+, npm, and a C++ compiler toolchain (Xcode CLI tools on macOS, Visual Studio Build Tools on Windows, or `build-essential` on Linux).

```bash
git clone https://github.com/Boof2015/astra.git
cd astra
npm install
```

The `postinstall` script compiles the native C++ visualizer module for your platform.

```bash
npm run dev              # Development
npm run build            # Build application assets
npm run dist             # Package for current platform
npm run dist:mac         # macOS (DMG + ZIP)
npm run dist:win         # Windows (NSIS + Portable)
npm run dist:linux       # Linux (AppImage + DEB)
```

## Documentation

For detailed technical documentation — audio pipeline, project structure, architecture, and more — see the [Wiki](https://github.com/Boof2015/astra/wiki).

## Support

If you find Astra useful, and want to support a broke college student, consider supporting development:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/boof2015)

## License

This project is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html). See [LICENSE](LICENSE) for the full text.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Boof2015/astra&type=date&legend=top-left)](https://www.star-history.com/#Boof2015/astra&type=date&legend=top-left)
