# Parallax OS

Flashable SD-card image that turns a Raspberry Pi into a zero-maintenance Parallax zone
speaker: flash, boot, open `http://parallax.local/`, pair from Astra, and explicitly approve on
the page or display — 24/7 from there. HDMI-CEC and a TV remote are optional.

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
  playing, and goes to standby after 10 idle minutes. CEC is best-effort, not a setup
  requirement; pairing can always be approved or rejected at `http://parallax.local/`.
- **Wi-Fi onboarding** (`apSetup`): with no network for ~2 minutes, the daemon raises an open
  **Parallax-Setup** hotspot with a captive portal — join it with a phone (a connected TV shows
  the instructions and a join QR), pick your Wi-Fi, enter the password, done. Wrong password →
  the hotspot reappears with the error shown. Backed by NetworkManager + a polkit rule for the
  service user + a shared-mode dnsmasq drop-in for the captive DNS. A `parallax` user is baked
  but LOCKED, so an uncustomized image has no usable login.

Noninteractive first-boot provisioning uses Raspberry Pi OS Trixie's native cloud-init NoCloud
datasource. Parallax supplies safe, active `user-data` and `network-config` templates on the boot
partition; their examples are commented out so the normal captive-portal path remains the
default.

## Flashing

1. Flash `parallax-os-v*.img.xz` with Raspberry Pi Imager (*Use custom*), Etcher, or `dd`.
   Imager's OS-customization dialog is not offered for a locally selected third-party image;
   use the boot-partition files below if you want unattended setup.
2. Boot the Pi (first boot takes 2–3 minutes: filesystem resize + cloud-init + reboot).
   On Ethernet there is nothing more to set up. On Wi-Fi, wait ~2 minutes for the
   **Parallax-Setup** network to appear, join it with your phone, and pick your Wi-Fi in the
   portal that opens (a connected TV shows the instructions + a join QR).
3. Open `http://parallax.local/` on a phone or computer on the same LAN, then start pairing from
   Astra (Parallax → Add Sink). Enter the 6-digit PIN shown on the page or connected display,
   then explicitly approve before the pairing window expires:
   - **Headless:** use the Approve/Reject controls on `http://parallax.local/`.
   - **TV with working CEC:** use the TV remote on the display, or use the web page instead.
   - **TV without CEC or without a usable remote:** use the web page on the other device; no TV
     remote is required.
   After pairing, pick the audio output on the page (HDMI / headphone jack / USB DAC).

### Optional unattended setup

After flashing and before the first boot, open the FAT boot partition and edit these active files
in place:

- `user-data`: delete its `{}` no-op line and uncomment the example to choose the login name and
  install an SSH public key. The recommended configuration keeps password authentication locked
  and explicitly enables SSH. For console/password login, use the documented SHA-512
  password-hash form; never put a plaintext password or private SSH key on the card. Naming the
  account `parallax` retains the baked name; another name renames the UID-1000 account and
  preserves its Raspberry Pi OS groups.
- `network-config`: uncomment the complete example and set the Wi-Fi country, SSID, and password.
  It retains DHCP on Ethernet as a fallback. Leave it commented to use Parallax-Setup onboarding.

These two files are the only supported user-editable inputs for noninteractive provisioning;
leave `meta-data` unchanged. The files are not consumed or deleted. Cloud-init applies their
per-instance settings on the first boot but continues to use the seed on later boots, so keep the
filenames and files in place and do not expect later edits to reprovision an existing card.

The boot partition is FAT and does not protect file contents with useful Unix permissions. Anyone
with the card can read any password hash or Wi-Fi credential left there. Parallax performs no
automatic credential cleanup: prefer key-only SSH and physically protect provisioned cards.

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

## Hardware release gate

Keep every image release as a draft until fresh cards pass on both Pi 3B and Pi 5:

1. Boot an unmodified flash twice. Confirm `cloud-init status --long` succeeds, `parallax`
   remains locked, SSH is unavailable, and Parallax-Setup appears when no network is available.
2. Make a second flash, edit both cloud-init files with disposable credentials, and boot twice.
   Confirm the requested user and console password hash work, SSH accepts the supplied key but
   not a password, Wi-Fi connects, Parallax-Setup is skipped, and cloud-init does not reapply
   per-instance setup on the second boot.
3. Confirm `user-data`, `network-config`, and `meta-data` remain on the boot partition exactly as
   documented. Destroy the disposable credentials after the test.

Iteration cost warning: every change to the stage means a full image build + flash + boot on
real hardware. Put anything checkable at build time into `stage-parallax/99-verify/00-run.sh`
(rootfs asserts) or `ci/verify-image.sh` (mounted-image asserts) instead of finding out on a Pi.

Daemon behavior changes do NOT need an image release — they ship as `receiver-v*` releases and
every flashed device picks them up via the auto-update timer. Image releases are only for
OS-level changes (packages, units, base-image bumps).
