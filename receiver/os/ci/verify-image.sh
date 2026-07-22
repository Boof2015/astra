#!/usr/bin/env bash
#
# Post-build verification of the exported Parallax OS image: loop-mount the raw .img and
# re-assert the load-bearing facts against the ACTUAL artifact. The in-stage checks
# (stage-parallax/99-verify) ran against the rootfs; this catches rootfs→image export bugs.
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

check "active cloud-init inputs are present in the exported boot partition"
for seed_file in meta-data user-data network-config; do
  [ -f "$BOOT_DIR/$seed_file" ] || fail "$seed_file missing from boot partition"
done
[ "$(head -n 1 "$BOOT_DIR/user-data")" = "#cloud-config" ] \
  || fail "user-data is not cloud-config"
ACTIVE_USER_DATA="$(awk '!/^[[:space:]]*(#|$)/' "$BOOT_DIR/user-data")"
if [ "$ACTIVE_USER_DATA" != "{}" ]; then
  fail "user-data is not an empty-map no-op by default"
fi
if grep -Eq '^[[:space:]]*[^#[:space:]]' "$BOOT_DIR/network-config"; then
  fail "network-config is not a safe no-op by default"
fi
grep -q '^# user:$' "$BOOT_DIR/user-data" || fail "user-data lacks the account example"
grep -q 'ssh_authorized_keys:' "$BOOT_DIR/user-data" || fail "user-data lacks SSH-key setup"
grep -q 'lock_passwd: true' "$BOOT_DIR/user-data" || fail "user-data lacks key-only password locking"
grep -q 'systemctl, enable, --now, ssh' "$BOOT_DIR/user-data" \
  || fail "user-data does not enable SSH"
grep -q 'REPLACE_WITH_YOUR_PUBLIC_KEY' "$BOOT_DIR/user-data" \
  || fail "user-data lacks a public-key placeholder"
grep -q 'REPLACE_WITH_A_SHA512_CRYPT_HASH' "$BOOT_DIR/user-data" \
  || fail "user-data lacks a password-hash placeholder"
grep -q 'BEGIN .*PRIVATE KEY' "$BOOT_DIR/user-data" \
  && fail "user-data contains private-key material"
grep -q 'does not delete the' "$BOOT_DIR/user-data" \
  || fail "user-data lacks the credential-lifecycle warning"
grep -q 'renderer: NetworkManager' "$BOOT_DIR/network-config" \
  || fail "network-config does not select NetworkManager"
grep -q 'ethernets:' "$BOOT_DIR/network-config" || fail "network-config lacks wired DHCP"
grep -q 'wifis:' "$BOOT_DIR/network-config" || fail "network-config lacks Wi-Fi setup"
grep -q 'regulatory-domain:' "$BOOT_DIR/network-config" \
  || fail "network-config lacks the regulatory domain"
grep -q 'REPLACE_WITH_WIFI_NAME' "$BOOT_DIR/network-config" \
  || fail "network-config lacks the SSID placeholder"
grep -q 'REPLACE_WITH_WIFI_PASSWORD' "$BOOT_DIR/network-config" \
  || fail "network-config lacks the Wi-Fi password placeholder"
grep -q 'physically protect the card' "$BOOT_DIR/network-config" \
  || fail "network-config lacks the credential warning"
LEGACY_PROVISIONING_FILE="custom."toml
[ ! -e "$BOOT_DIR/$LEGACY_PROVISIONING_FILE" ] \
  || fail "legacy TOML provisioning file present on boot partition"
[ ! -e "$BOOT_DIR/$LEGACY_PROVISIONING_FILE.example" ] \
  || fail "legacy TOML provisioning example present on boot partition"

check "cloud-init installed and enabled in the exported root filesystem"
[ -x "$MOUNT_DIR/usr/bin/cloud-init" ] || fail "cloud-init executable missing"
[ -f "$MOUNT_DIR/var/lib/dpkg/info/cloud-init.list" ] || fail "cloud-init package not installed"
[ -f "$MOUNT_DIR/var/lib/dpkg/info/rpi-cloud-init-mods.list" ] \
  || fail "rpi-cloud-init-mods package not installed"
[ -f "$MOUNT_DIR/var/lib/dpkg/info/netplan.io.list" ] || fail "netplan.io package not installed"
CLOUD_INIT_CFG="$MOUNT_DIR/etc/cloud/cloud.cfg.d/99_raspberry-pi.cfg"
[ -f "$CLOUD_INIT_CFG" ] || fail "Raspberry Pi cloud-init configuration missing"
grep -Eq 'seedfrom:[[:space:]]*file:///boot/firmware/?$' "$CLOUD_INIT_CFG" \
  || fail "NoCloud datasource does not read /boot/firmware"
[ -x "$MOUNT_DIR/usr/lib/systemd/system-generators/cloud-init-generator" ] \
  || fail "cloud-init systemd generator missing"
[ -f "$MOUNT_DIR/usr/lib/systemd/system/cloud-init.target" ] \
  || fail "cloud-init.target missing"
[ ! -e "$MOUNT_DIR/etc/cloud/cloud-init.disabled" ] || fail "cloud-init disabled by marker file"
if grep -Eq '(^|[[:space:]])cloud-init=disabled([[:space:]]|$)' "$BOOT_DIR/cmdline.txt"; then
  fail "cloud-init disabled on the kernel command line"
fi
for unit in cloud-init-main.service cloud-init-local.service cloud-init-network.service \
  cloud-config.service cloud-final.service; do
  [ -f "$MOUNT_DIR/usr/lib/systemd/system/$unit" ] || fail "$unit missing"
  [ -L "$MOUNT_DIR/etc/systemd/system/cloud-init.target.wants/$unit" ] \
    || fail "$unit not enabled for cloud-init.target"
done

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
grep -q '^TimeoutStopSec=15s$' "$UNIT" || fail "unit stop timeout is not 15 seconds"
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

check "Parallax Plymouth theme and selected configuration"
[ -f "$MOUNT_DIR/var/lib/dpkg/info/plymouth.list" ] || fail "plymouth package not installed"
[ -f "$MOUNT_DIR/var/lib/dpkg/info/plymouth-label.list" ] \
  || fail "plymouth-label package not installed"
[ -f "$MOUNT_DIR/var/lib/dpkg/info/fonts-dejavu-core.list" ] \
  || fail "DejaVu font package not installed"
SPLASH_THEME_DIR="$MOUNT_DIR/usr/share/plymouth/themes/parallax"
[ -f "$SPLASH_THEME_DIR/parallax.plymouth" ] || fail "Parallax theme descriptor missing"
[ -f "$SPLASH_THEME_DIR/parallax.script" ] || fail "Parallax theme script missing"
[ "$(find "$SPLASH_THEME_DIR" -maxdepth 1 -type f -name '*.png' | wc -l)" -eq 25 ] \
  || fail "Parallax theme does not contain the base logo plus 24 pulse frames"
grep -q '^Theme=parallax$' "$MOUNT_DIR/etc/plymouth/plymouthd.conf" \
  || fail "Parallax is not the selected Plymouth theme"
grep -q '^ExecStart=-/usr/bin/plymouth quit --retain-splash$' \
  "$MOUNT_DIR/etc/systemd/system/plymouth-quit.service.d/10-parallax-retain-splash.conf" \
  || fail "Plymouth final framebuffer is not retained"
grep -q '^update_initramfs=yes$' "$MOUNT_DIR/etc/initramfs-tools/update-initramfs.conf" \
  || fail "initramfs regeneration is disabled"
grep -q 'eased_t = 3 \* t \* t - 2 \* t \* t \* t' "$SPLASH_THEME_DIR/parallax.script" \
  || fail "splash does not use the smoothstep Easy Ease curve"
grep -q 'SetKeyboardInputFunction' "$SPLASH_THEME_DIR/parallax.script" \
  && fail "custom theme captures keyboard input instead of leaving Esc to Plymouth"

check "single-line boot parameters preserve tty1, serial, and root arguments"
[ "$(wc -l < "$BOOT_DIR/cmdline.txt")" -eq 1 ] || fail "cmdline.txt is not one line"
CMDLINE_TEXT="$(cat "$BOOT_DIR/cmdline.txt")"
read -r -a CMDLINE_TOKENS <<< "$CMDLINE_TEXT"
has_cmdline_token() {
  local wanted="$1"
  local token
  for token in "${CMDLINE_TOKENS[@]}"; do
    [ "$token" = "$wanted" ] && return 0
  done
  return 1
}
has_cmdline_prefix() {
  local wanted_prefix="$1"
  local token
  for token in "${CMDLINE_TOKENS[@]}"; do
    case "$token" in
      "$wanted_prefix"*) return 0 ;;
    esac
  done
  return 1
}
for required_token in console=tty1 quiet splash logo.nologo \
  plymouth.ignore-serial-consoles vt.global_cursor_default=0; do
  has_cmdline_token "$required_token" || fail "cmdline.txt lacks $required_token"
done
serial_console_present=false
for token in "${CMDLINE_TOKENS[@]}"; do
  case "$token" in
    console=serial0,*|console=ttyAMA0,*|console=ttyS0,*) serial_console_present=true ;;
  esac
done
[ "$serial_console_present" = true ] || fail "cmdline.txt lost its serial console"
has_cmdline_prefix 'root=' || fail "cmdline.txt lost its root argument"
has_cmdline_prefix 'rootfstype=' || fail "cmdline.txt lost its rootfstype argument"
has_cmdline_token 'plymouth.enable=0' && fail "splash is disabled in cmdline.txt"
has_cmdline_token 'nosplash' && fail "splash is disabled by nosplash"
grep -q '^auto_initramfs=1$' "$BOOT_DIR/config.txt" || fail "auto_initramfs is not enabled"
grep -q '^disable_splash=1$' "$BOOT_DIR/config.txt" || fail "firmware rainbow is not disabled"

check "Pi 3/Pi 5 boot initramfs files contain graphical and fallback themes"
command -v lsinitramfs >/dev/null || fail "host lacks lsinitramfs (install initramfs-tools-core)"
verify_boot_initramfs() {
  local image="$1"
  local listing
  [ -s "$image" ] || fail "$(basename "$image") missing or empty"
  listing="$(lsinitramfs "$image")"
  grep -q 'usr/share/plymouth/themes/parallax/parallax.script$' <<< "$listing" \
    || fail "$(basename "$image") lacks the Parallax theme"
  grep -q 'usr/share/plymouth/themes/parallax/pulse-23.png$' <<< "$listing" \
    || fail "$(basename "$image") lacks pulse frames"
  grep -q '/details.so$' <<< "$listing" || fail "$(basename "$image") lacks details fallback"
  grep -q '/text.so$' <<< "$listing" || fail "$(basename "$image") lacks text fallback"
  grep -q '/label-pango.so$' <<< "$listing" \
    || fail "$(basename "$image") lacks the Pango text-rendering plugin"
  grep -q '/DejaVuSans.ttf$' <<< "$listing" || fail "$(basename "$image") lacks its UI font"
}
verify_boot_initramfs "$BOOT_DIR/initramfs8"
verify_boot_initramfs "$BOOT_DIR/initramfs_2712"

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
