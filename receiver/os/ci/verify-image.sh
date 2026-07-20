#!/usr/bin/env bash
#
# Post-build verification of the exported Parallax OS image: loop-mount the raw .img and
# re-assert the load-bearing facts against the ACTUAL artifact. The in-stage checks
# (stage-parallax/03-verify) ran against the rootfs; this catches rootfs→image export bugs.
# Needs root (losetup/mount): the workflow runs it with sudo.
#
# Usage: verify-image.sh <path-to.img>

set -euo pipefail

IMG="${1:?usage: verify-image.sh <path-to.img>}"
[ -f "$IMG" ] || { echo "No such image: $IMG" >&2; exit 1; }

fail() { echo "verify-image FAILED: $*" >&2; exit 1; }
check() { echo "verify-image: $*"; }

MOUNT_DIR="$(mktemp -d)"
BOOT_DIR="$(mktemp -d)"
LOOP_DEV=""
cleanup() {
  if mountpoint -q "$BOOT_DIR"; then umount "$BOOT_DIR"; fi
  if mountpoint -q "$MOUNT_DIR"; then umount "$MOUNT_DIR"; fi
  if [ -n "$LOOP_DEV" ]; then losetup -d "$LOOP_DEV"; fi
  rmdir "$BOOT_DIR" "$MOUNT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

LOOP_DEV="$(losetup -fP --show "$IMG")"
[ -b "${LOOP_DEV}p2" ] || fail "expected two partitions on $LOOP_DEV (boot + root)"
mount -o ro "${LOOP_DEV}p2" "$MOUNT_DIR"
mount -o ro "${LOOP_DEV}p1" "$BOOT_DIR"

check "boot partition looks like a Pi boot partition"
ls "$BOOT_DIR"/*.dtb >/dev/null 2>&1 || [ -f "$BOOT_DIR/config.txt" ] || fail "no config.txt/dtb in boot partition"
[ -f "$BOOT_DIR/custom.toml.example" ] || fail "custom.toml.example missing from boot partition"

check "daemon installed under current/"
CURRENT_TARGET="$(readlink "$MOUNT_DIR/opt/astra-receiver/current")" || fail "current symlink missing"
case "$CURRENT_TARGET" in
  releases/receiver-v*) ;;
  *) fail "current -> $CURRENT_TARGET (expected releases/receiver-v<version>)" ;;
esac
[ -f "$MOUNT_DIR/opt/astra-receiver/current/astra-receiver.mjs" ] || fail "astra-receiver.mjs missing"
[ -f "$MOUNT_DIR/opt/astra-receiver/current/astra_receiver_alsa.node" ] || fail "ALSA addon missing"
[ -x "$MOUNT_DIR/opt/astra-receiver/current/update.sh" ] || fail "update.sh missing or not executable"

check "units enabled with appliance settings"
UNIT="$MOUNT_DIR/etc/systemd/system/astra-receiver.service"
grep -q '^Type=notify' "$UNIT" || fail "unit is not Type=notify"
grep -q '^AmbientCapabilities=CAP_NET_BIND_SERVICE' "$UNIT" || fail "unit lacks CAP_NET_BIND_SERVICE"
[ -L "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/astra-receiver.service" ] \
  || fail "astra-receiver.service not enabled"
[ -L "$MOUNT_DIR/etc/systemd/system/timers.target.wants/astra-receiver-update.timer" ] \
  || fail "update timer not enabled"

check "baked config"
grep -q '"webPort": 80' "$MOUNT_DIR/opt/astra-receiver/config.json" || fail "config.json lacks webPort 80"
grep -q '"endpointUuid"' "$MOUNT_DIR/opt/astra-receiver/config.json" \
  && fail "config.json must not bake an endpointUuid"

check "hostname + appliance drop-ins"
[ "$(tr -d ' \t\n\r' < "$MOUNT_DIR/etc/hostname")" = "parallax" ] || fail "hostname is not parallax"
[ -f "$MOUNT_DIR/etc/systemd/system.conf.d/10-parallax-watchdog.conf" ] || fail "watchdog drop-in missing"
[ -f "$MOUNT_DIR/etc/apt/apt.conf.d/51unattended-upgrades-parallax" ] || fail "unattended-upgrades config missing"

check "node baked at /usr/bin/node"
[ -e "$MOUNT_DIR/usr/bin/node" ] || fail "/usr/bin/node missing"

check "AP setup: polkit rule, captive DNS, apSetup baked, parallax user locked"
[ -f "$MOUNT_DIR/etc/polkit-1/rules.d/50-parallax-network.rules" ] || fail "polkit rule missing"
grep -q 'org.freedesktop.login1.reboot' "$MOUNT_DIR/etc/polkit-1/rules.d/50-parallax-network.rules" \
  || fail "polkit rule lacks the reboot grant"
grep -q 'address=/#/10.42.0.1' "$MOUNT_DIR/etc/NetworkManager/dnsmasq-shared.d/parallax-captive.conf" \
  || fail "captive dnsmasq drop-in missing"
grep -q '"apSetup": true' "$MOUNT_DIR/opt/astra-receiver/config.json" || fail "config.json lacks apSetup"
grep -q '^parallax:!' "$MOUNT_DIR/etc/shadow" || fail "parallax user is not locked"
if [ -f "$MOUNT_DIR/var/lib/NetworkManager/NetworkManager.state" ]; then
  grep -q 'WirelessEnabled=false' "$MOUNT_DIR/var/lib/NetworkManager/NetworkManager.state" \
    && fail "Wi-Fi is administratively disabled — WPA_COUNTRY missing from the pi-gen config"
fi
[ -f "$MOUNT_DIR/usr/share/icons/parallax-blank/cursors/left_ptr" ] || fail "blank cursor theme missing"
[ -f "$MOUNT_DIR/etc/rc_keymaps/parallax_cec.toml" ] || fail "CEC remote keymap missing"
grep -q 'rc-cec parallax_cec.toml' "$MOUNT_DIR/etc/rc_maps.cfg" || fail "rc_maps.cfg lacks the CEC keymap entry"

check "TV mode: kiosk detect enabled, kiosk unit present but not enabled"
[ -L "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/parallax-kiosk-detect.service" ] \
  || fail "kiosk detect service not enabled"
[ -f "$MOUNT_DIR/etc/systemd/system/parallax-kiosk.service" ] || fail "kiosk unit missing"
[ ! -e "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/parallax-kiosk.service" ] \
  || fail "kiosk unit must not be enabled directly (detect service starts it)"
[ -x "$MOUNT_DIR/usr/local/lib/parallax/hdmi-connected.sh" ] || fail "hdmi-connected.sh missing"
grep -q '"cecControl": true' "$MOUNT_DIR/opt/astra-receiver/config.json" \
  || fail "config.json lacks cecControl"

check "OK — image verified"
