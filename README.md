# Astra

A desktop music player for people who still have a music library. <a href="https://repology.org/project/astra-music/versions">
    <img src="https://repology.org/badge/vertical-allrepos/astra-music.svg" alt="Packaging status" align="right">
</a>

![code size](https://img.shields.io/github/languages/code-size/Boof2015/astra)
![GitHub Release](https://img.shields.io/github/v/release/Boof2015/astra?include_prereleases)
![GitHub License](https://img.shields.io/github/license/Boof2015/astra)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/Boof2015/astra/main.yml)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/boof2015/astra/total)
![WinGet Package Version](https://img.shields.io/winget/v/Boof2015.Astra)


![Astra home screen](assets/Homescreen.png)

Astra plays your local music - FLACs, MP3s, whatever your collection looks like. It has a native C++ DSP engine, real-time visualizers, a parametric EQ, Dolby Atmos decoding, and a UI that adapts to your music. No telemetry, no accounts, no streaming.

## Playback

Gapless playback with pre-buffering so albums flow the way they were intended. Supports MP3, FLAC, WAV, OGG, AAC, M4A, OPUS, WMA, and AIFF natively, with an FFmpeg fallback for anything else. Dolby Atmos multichannel decoding works without Atmos-compatible hardware.

## Visualizers

Seven real-time visualizers powered by a native C++ module - oscilloscope, spectrum analyzer, vectorscope, and more. The entire scope rack is customizable: pick your scopes, drag and resize them into any layout, and save presets. The analysis path runs independently from output routing, so scopes always reflect the source material.

## Equalizer

A fully parametric EQ with up to 10 bands, a live frequency response graph with spectrum overlay, and built-in presets. Save your own, or import AutoEQ headphone calibration profiles directly.

![Astra equalizer](assets/EQ.png)

## Library

Point Astra at your music folders and it handles metadata extraction, album artwork, and a searchable library you can browse by artist, album, or track. Favorites and recently played are tracked automatically, and the built-in metadata editor lets you fix tags without leaving the player. A Quick Launch shortcut gets you anywhere without touching the mouse.

## Audio Settings

Output device selection, loudness normalization, per-channel remapping for multichannel setups, and delay calibration for wireless or Bluetooth speakers.

## Interface

Fullscreen mode shows album art with an ambient spectrum backdrop.

![Astra fullscreen mode](assets/Fullscreen.png)

The mini player keeps controls accessible when you want Astra out of the way.

![Astra mini player](assets/Miniplayer.png)

There's also synced lyrics with auto-scroll, pulled automatically from embedded lyrics, an .lrc file, or from LRCLIB.

![Astra lyrics](assets/Lyrics.png)

## Integrations

Everything that touches the network is optional and off by default.

- **Discord Rich Presence** - show what you're listening to with cover art
- **Last.fm** - automatic scrobbling
- **Jellyfin & Navidrome** - browse and play your self-hosted media server library directly inside Astra

## Astra API

An optional local REST API lets external tools read the current track, playback position, and cover art, or control playback. Loopback only, bearer token auth, disabled by default. See the [API docs](https://github.com/Boof2015/astra/wiki/Astra-API) for details.

## Download

Prebuilt binaries for Windows, macOS, and Linux are available on the [Releases](https://github.com/Boof2015/astra/releases) page.

Also available on the [AUR](https://aur.archlinux.org/packages/astra-music-bin) (`astra-music-bin`).

## Building from Source

**Prerequisites:** Node.js 18+, npm, and a C++ compiler toolchain.

| Platform | Toolchain |
|----------|-----------|
| macOS | Xcode Command Line Tools |
| Windows | Visual Studio Build Tools |
| Linux | `build-essential`, `python3`, `libasound2-dev` |

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

For detailed technical documentation, see the [Wiki](https://github.com/Boof2015/astra/wiki).

## Support

If you find Astra useful and want to support a broke college student, consider supporting development:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/boof2015)

## License

This project is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html). See [LICENSE](LICENSE) for the full text.

## Star History

<a href="https://www.star-history.com/#Boof2015/astra&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Boof2015/astra&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Boof2015/astra&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Boof2015/astra&type=date&legend=top-left" />
 </picture>
</a>
