# Parallax OS

Flashable SD-card image that turns a Raspberry Pi into a zero-maintenance Parallax zone
speaker: flash, boot, open `http://parallax.local/`, pair from Astra — 24/7 from there.

Built with [pi-gen](https://github.com/RPi-Distro/pi-gen) (Raspberry Pi OS Lite base + the
`stage-parallax` custom stage in this directory). The **Parallax OS Release** GitHub workflow
uploads each build as a `parallax-os-v*` **draft** release in the receiver releases repo —
flash and test the draft's `.img.xz` on hardware, then publish it (release page "Publish
release" with "Set as the latest release" unchecked, or
`gh release edit parallax-os-v<version> --repo <releases repo> --draft=false --latest=false`).
Drafts are invisible to non-collaborators, so an untested image is never downloadable.

## What the image adds on top of Pi OS Lite

- The astra-receiver daemon (latest `receiver-v*` release baked in) under
  `/opt/astra-receiver/releases/<tag>` with the `current` symlink layout, service user, and a
  `Type=notify` unit — status page on **port 80** (`AmbientCapabilities=CAP_NET_BIND_SERVICE`).
- Hostname `parallax` + stock avahi → `http://parallax.local/` (auto-renames on conflict).
- Auto-update: `astra-receiver-update.timer` (daily 03:30 + 10 min after boot) runs
  `current/update.sh` — sha256-verified, atomic symlink swap, health-gated rollback.
- `unattended-upgrades` for security patches (auto-reboot 04:30 when a kernel update needs it).
- Watchdogs: daemon `WatchdogSec=30` via sd_notify keepalives, plus the Pi hardware watchdog
  (`RuntimeWatchdogSec=15`) for kernel hangs. `Restart=always` with no start limit.
- Node.js 24 LTS (NodeSource), journald capped at 64 M for SD longevity.

- **TV mode** (Phase 2): if an HDMI display is connected at boot, a Cage + WPE kiosk starts on
  tty1 showing the daemon's `/display` page — Zone-Display-style artwork + title/artist. No
  display → the Pi stays headless; nothing else changes. HDMI-CEC is on by default
  (`cecControl` in the daemon config): the TV wakes and switches input when a stream starts
  playing, and goes to standby after 10 idle minutes.
- **Wi-Fi onboarding** (`apSetup`): with no network for ~2 minutes, the daemon raises an open
  **Parallax-Setup** hotspot with a captive portal — join it with a phone (a connected TV shows
  the instructions and a join QR), pick your Wi-Fi, enter the password, done. Wrong password →
  the hotspot reappears with the error shown. Backed by NetworkManager + a polkit rule for the
  service user + a shared-mode dnsmasq drop-in for the captive DNS. A `parallax` user is baked
  but LOCKED (no login possible) purely so the first-boot wizard never blocks the kiosk.

Deliberately stock: the first-boot user wizard and Raspberry Pi Imager's OS-customization
(user, Wi-Fi, hostname override, SSH) work exactly like on plain Pi OS.

## Flashing

1. Flash `parallax-os-v*.img.xz` with Raspberry Pi Imager (*Use custom*), Etcher, or `dd`.
   Imager's OS-customization dialog is NOT offered for third-party images — that's expected,
   and with AP onboarding it isn't needed.
2. Boot the Pi (first boot takes 2–3 minutes: filesystem resize + first-run config + reboot).
   On Ethernet there is nothing more to set up. On Wi-Fi, wait ~2 minutes for the
   **Parallax-Setup** network to appear, join it with your phone, and pick your Wi-Fi in the
   portal that opens (a connected TV shows the instructions + a join QR).
3. Open `http://parallax.local/`, pair from Astra (Parallax → Add Sink), pick the audio output
   on the page (HDMI / headphone jack / USB DAC), done.

Power users: for SSH or a console login, put a `custom.toml` on the boot partition before
first boot (template ships there as `custom.toml.example` — same mechanism Imager's dialog
drives; consumed + deleted on first boot). It can also pre-set Wi-Fi, skipping the AP step.

## Building locally (Linux, needs Docker or a Debian-ish host)

```sh
git clone --branch arm64 https://github.com/RPi-Distro/pi-gen && cd pi-gen
git checkout <PI_GEN_REF from the workflow>
cp ../receiver/os/config config
cp -r ../receiver/os/stage-parallax .
# inject a receiver release into stage-parallax/02-daemon/files/payload/:
#   astra-receiver-linux-arm64.tar.gz + .sha256 + receiver-tag.txt + receiver/deploy/update.sh
touch stage2/SKIP_IMAGES
sudo ./build-docker.sh -c config
sudo ../receiver/os/ci/verify-image.sh deploy/*.img
```

Iteration cost warning: every change to the stage means a full image build + flash + boot on
real hardware. Put anything checkable at build time into `stage-parallax/03-verify/00-run.sh`
(rootfs asserts) or `ci/verify-image.sh` (mounted-image asserts) instead of finding out on a Pi.

Daemon behavior changes do NOT need an image release — they ship as `receiver-v*` releases and
every flashed device picks them up via the auto-update timer. Image releases are only for
OS-level changes (packages, units, base-image bumps).
