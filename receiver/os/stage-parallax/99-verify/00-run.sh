#!/bin/bash -e
# In-build assertions — any failure kills the image build BEFORE an image exists. Iterating on
# this image costs a full build + flash + boot on real hardware, so everything checkable at
# build time is checked at build time. ci/verify-image.sh re-asserts the key facts against the
# exported .img (this stage can't catch rootfs→image export bugs).

RECEIVER_TAG="$(cat ../02-daemon/files/payload/receiver-tag.txt)"

check() {
  echo "verify: $1"
}

check "daemon files under releases/${RECEIVER_TAG}"
[ -f "${ROOTFS_DIR}/opt/astra-receiver/releases/${RECEIVER_TAG}/astra-receiver.mjs" ]
[ -f "${ROOTFS_DIR}/opt/astra-receiver/releases/${RECEIVER_TAG}/astra_receiver_alsa.node" ]
[ -f "${ROOTFS_DIR}/opt/astra-receiver/releases/${RECEIVER_TAG}/update.sh" ]
[ -x "${ROOTFS_DIR}/opt/astra-receiver/releases/${RECEIVER_TAG}/update.sh" ]

check "current symlink is relative and points at the baked release"
[ "$(readlink "${ROOTFS_DIR}/opt/astra-receiver/current")" = "releases/${RECEIVER_TAG}" ]

check "units present with the appliance settings"
grep -q '^Type=notify' "${ROOTFS_DIR}/etc/systemd/system/astra-receiver.service"
grep -q '^WatchdogSec=' "${ROOTFS_DIR}/etc/systemd/system/astra-receiver.service"
grep -q '^TimeoutStopSec=15s$' "${ROOTFS_DIR}/etc/systemd/system/astra-receiver.service"
grep -q '^AmbientCapabilities=CAP_NET_BIND_SERVICE' "${ROOTFS_DIR}/etc/systemd/system/astra-receiver.service"
grep -q '^ExecStart=/usr/bin/node /opt/astra-receiver/current/' "${ROOTFS_DIR}/etc/systemd/system/astra-receiver.service"
[ -f "${ROOTFS_DIR}/etc/systemd/system/astra-receiver-update.timer" ]

check "units enabled (wants symlinks)"
[ -L "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/astra-receiver.service" ]
[ -L "${ROOTFS_DIR}/etc/systemd/system/timers.target.wants/astra-receiver-update.timer" ]

check "baked config parses with webPort 80 and no endpointUuid"
on_chroot << 'CHROOT'
set -e
node -e '
  const config = JSON.parse(require("fs").readFileSync("/opt/astra-receiver/config.json", "utf8"))
  if (config.webPort !== 80) throw new Error("webPort is " + config.webPort)
  if (config.audioBackend !== "alsa") throw new Error("audioBackend is " + config.audioBackend)
  if ("endpointUuid" in config) throw new Error("endpointUuid must not be baked into the image")
'
CHROOT

check "node meets the undici floor and lives at the unit ExecStart path"
on_chroot << 'CHROOT'
set -e
[ -x /usr/bin/node ]
REQUIRED="22.19.0"
CURRENT="$(/usr/bin/node -v | tr -d v)"
[ "$(printf '%s\n%s\n' "$REQUIRED" "$CURRENT" | sort -V | head -n1)" = "$REQUIRED" ]
CHROOT

check "hostname is parallax"
[ "$(tr -d ' \t\n\r' < "${ROOTFS_DIR}/etc/hostname")" = "parallax" ]

check "cloud-init packages, Raspberry Pi NoCloud datasource, and enabled unit chain"
on_chroot << 'CHROOT'
set -e
dpkg -s cloud-init rpi-cloud-init-mods netplan.io >/dev/null
command -v cloud-init >/dev/null
cloud-init schema --config-file /boot/firmware/user-data >/dev/null
python3 -c 'import yaml; yaml.safe_load(open("/boot/firmware/network-config", encoding="utf-8"))'
CHROOT
CLOUD_INIT_CFG="${ROOTFS_DIR}/etc/cloud/cloud.cfg.d/99_raspberry-pi.cfg"
[ -f "${CLOUD_INIT_CFG}" ]
grep -Eq 'seedfrom:[[:space:]]*file:///boot/firmware/?$' "${CLOUD_INIT_CFG}"
[ -x "${ROOTFS_DIR}/usr/lib/systemd/system-generators/cloud-init-generator" ]
[ -f "${ROOTFS_DIR}/usr/lib/systemd/system/cloud-init.target" ]
[ ! -e "${ROOTFS_DIR}/etc/cloud/cloud-init.disabled" ]
if grep -Eq '(^|[[:space:]])cloud-init=disabled([[:space:]]|$)' \
  "${ROOTFS_DIR}/boot/firmware/cmdline.txt"; then
  echo "cloud-init is disabled on the kernel command line" >&2
  exit 1
fi
for unit in cloud-init-main.service cloud-init-local.service cloud-init-network.service \
  cloud-config.service cloud-final.service; do
  [ -f "${ROOTFS_DIR}/usr/lib/systemd/system/${unit}" ]
  [ -L "${ROOTFS_DIR}/etc/systemd/system/cloud-init.target.wants/${unit}" ]
done

check "active, credential-free cloud-init templates on the boot partition"
for seed_file in meta-data user-data network-config; do
  [ -f "${ROOTFS_DIR}/boot/firmware/${seed_file}" ]
done
[ "$(head -n 1 "${ROOTFS_DIR}/boot/firmware/user-data")" = "#cloud-config" ]
ACTIVE_USER_DATA="$(awk '!/^[[:space:]]*(#|$)/' "${ROOTFS_DIR}/boot/firmware/user-data")"
if [ "${ACTIVE_USER_DATA}" != "{}" ]; then
  echo "user-data must contain only its empty-map no-op until the example is uncommented" >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*[^#[:space:]]' "${ROOTFS_DIR}/boot/firmware/network-config"; then
  echo "network-config must be a no-op until its example is uncommented" >&2
  exit 1
fi
grep -q '^# user:$' "${ROOTFS_DIR}/boot/firmware/user-data"
grep -q 'ssh_authorized_keys:' "${ROOTFS_DIR}/boot/firmware/user-data"
grep -q 'lock_passwd: true' "${ROOTFS_DIR}/boot/firmware/user-data"
grep -q 'systemctl, enable, --now, ssh' "${ROOTFS_DIR}/boot/firmware/user-data"
grep -q 'REPLACE_WITH_YOUR_PUBLIC_KEY' "${ROOTFS_DIR}/boot/firmware/user-data"
grep -q 'REPLACE_WITH_A_SHA512_CRYPT_HASH' "${ROOTFS_DIR}/boot/firmware/user-data"
if grep -q 'BEGIN .*PRIVATE KEY' "${ROOTFS_DIR}/boot/firmware/user-data"; then
  echo "user-data contains private-key material" >&2
  exit 1
fi
grep -q 'does not delete the' "${ROOTFS_DIR}/boot/firmware/user-data"
grep -q 'renderer: NetworkManager' "${ROOTFS_DIR}/boot/firmware/network-config"
grep -q 'ethernets:' "${ROOTFS_DIR}/boot/firmware/network-config"
grep -q 'wifis:' "${ROOTFS_DIR}/boot/firmware/network-config"
grep -q 'regulatory-domain:' "${ROOTFS_DIR}/boot/firmware/network-config"
grep -q 'REPLACE_WITH_WIFI_NAME' "${ROOTFS_DIR}/boot/firmware/network-config"
grep -q 'REPLACE_WITH_WIFI_PASSWORD' "${ROOTFS_DIR}/boot/firmware/network-config"
grep -q 'physically protect the card' "${ROOTFS_DIR}/boot/firmware/network-config"
LEGACY_PROVISIONING_FILE="custom."toml
[ ! -e "${ROOTFS_DIR}/boot/firmware/${LEGACY_PROVISIONING_FILE}" ]
[ ! -e "${ROOTFS_DIR}/boot/firmware/${LEGACY_PROVISIONING_FILE}.example" ]

check "AP setup: polkit rule, captive DNS drop-in, NetworkManager, locked user"
[ -f "${ROOTFS_DIR}/etc/polkit-1/rules.d/50-parallax-network.rules" ]
[ -f "${ROOTFS_DIR}/etc/NetworkManager/dnsmasq-shared.d/parallax-captive.conf" ]
grep -q 'address=/#/10.42.0.1' "${ROOTFS_DIR}/etc/NetworkManager/dnsmasq-shared.d/parallax-captive.conf"

check "Wi-Fi radio not administratively disabled (WPA_COUNTRY was set)"
# Without a regulatory domain, pi-gen writes WirelessEnabled=false and the setup AP can never
# start — the first flash failed exactly this way.
if [ -f "${ROOTFS_DIR}/var/lib/NetworkManager/NetworkManager.state" ]; then
  if grep -q 'WirelessEnabled=false' "${ROOTFS_DIR}/var/lib/NetworkManager/NetworkManager.state"; then
    echo "Wi-Fi is administratively disabled — WPA_COUNTRY missing from the pi-gen config" >&2
    exit 1
  fi
fi

check "blank cursor theme for the kiosk (24x24 — smaller themes make wlroots fall back)"
[ "$(wc -c < "${ROOTFS_DIR}/usr/share/icons/parallax-blank/cursors/left_ptr")" -eq 2368 ]
[ "$(wc -c < "${ROOTFS_DIR}/usr/share/icons/default/cursors/left_ptr")" -eq 2368 ]
grep -q 'XCURSOR_THEME=parallax-blank' "${ROOTFS_DIR}/etc/systemd/system/parallax-kiosk.service"
grep -q 'XCURSOR_SIZE=24' "${ROOTFS_DIR}/etc/systemd/system/parallax-kiosk.service"

check "polkit rule covers NetworkManager, timedate1, reboot, and the updater unit"
grep -q 'org.freedesktop.timedate1' "${ROOTFS_DIR}/etc/polkit-1/rules.d/50-parallax-network.rules"
grep -q 'org.freedesktop.login1.reboot' "${ROOTFS_DIR}/etc/polkit-1/rules.d/50-parallax-network.rules"
grep -q 'astra-receiver-update.service' "${ROOTFS_DIR}/etc/polkit-1/rules.d/50-parallax-network.rules"
on_chroot << 'CHROOT'
set -e
dpkg -s network-manager polkitd >/dev/null
command -v nmcli >/dev/null
# The baked user must be locked — a shipped image with a usable password would be a backdoor.
passwd -S parallax | awk '{ exit ($2 == "L") ? 0 : 1 }'
node -e '
  const config = JSON.parse(require("fs").readFileSync("/opt/astra-receiver/config.json", "utf8"))
  if (config.apSetup !== true) throw new Error("apSetup not baked on")
'
CHROOT

check "appliance drop-ins present"
[ -f "${ROOTFS_DIR}/etc/systemd/system.conf.d/10-parallax-watchdog.conf" ]
[ -f "${ROOTFS_DIR}/etc/systemd/journald.conf.d/10-parallax-journald.conf" ]
[ -f "${ROOTFS_DIR}/etc/apt/apt.conf.d/20auto-upgrades" ]
[ -f "${ROOTFS_DIR}/etc/apt/apt.conf.d/51unattended-upgrades-parallax" ]

check "required packages installed"
on_chroot << 'CHROOT'
set -e
dpkg -s avahi-daemon unattended-upgrades nodejs alsa-utils >/dev/null
CHROOT

check "Parallax Plymouth theme, native details fallback, and retained final framebuffer"
SPLASH_THEME_DIR="${ROOTFS_DIR}/usr/share/plymouth/themes/parallax"
on_chroot << 'CHROOT'
set -e
dpkg -s plymouth plymouth-label fonts-dejavu-core >/dev/null
[ "$(plymouth-set-default-theme)" = "parallax" ]

kernel_count=0
for module_dir in /lib/modules/*; do
  [ -d "${module_dir}" ] || continue
  kernel_version="${module_dir##*/}"
  initramfs="/boot/initrd.img-${kernel_version}"
  [ -s "${initramfs}" ]
  initramfs_listing="$(lsinitramfs "${initramfs}")"
  grep -q 'usr/share/plymouth/themes/parallax/parallax.script$' <<< "${initramfs_listing}"
  grep -q 'usr/share/plymouth/themes/parallax/pulse-23.png$' <<< "${initramfs_listing}"
  grep -q '/details.so$' <<< "${initramfs_listing}"
  grep -q '/text.so$' <<< "${initramfs_listing}"
  if ! grep -q '/label-pango.so$' <<< "${initramfs_listing}"; then
    echo "${initramfs} lacks the Plymouth Pango text-rendering plugin" >&2
    exit 1
  fi
  grep -q '/DejaVuSans.ttf$' <<< "${initramfs_listing}"
  kernel_count=$((kernel_count + 1))
done
[ "${kernel_count}" -ge 2 ]
CHROOT
[ -f "${SPLASH_THEME_DIR}/parallax.plymouth" ]
[ -f "${SPLASH_THEME_DIR}/parallax.script" ]
[ "$(find "${SPLASH_THEME_DIR}" -maxdepth 1 -type f -name '*.png' | wc -l)" -eq 25 ]
grep -q '^ModuleName=script$' "${SPLASH_THEME_DIR}/parallax.plymouth"
grep -q '^Theme=parallax$' "${ROOTFS_DIR}/etc/plymouth/plymouthd.conf"
grep -q '^ShowDelay=0$' "${ROOTFS_DIR}/etc/plymouth/plymouthd.conf"
grep -q 'eased_t = 3 \* t \* t - 2 \* t \* t \* t' "${SPLASH_THEME_DIR}/parallax.script"
grep -q 'cycle_frame < 27' "${SPLASH_THEME_DIR}/parallax.script"
grep -q 'animation.tick % 69' "${SPLASH_THEME_DIR}/parallax.script"
if grep -q 'SetKeyboardInputFunction' "${SPLASH_THEME_DIR}/parallax.script"; then
  echo "the custom theme must leave Esc handling to Plymouth" >&2
  exit 1
fi
grep -q '^update_initramfs=yes$' \
  "${ROOTFS_DIR}/etc/initramfs-tools/update-initramfs.conf"
grep -q '^ExecStart=-/usr/bin/plymouth quit --retain-splash$' \
  "${ROOTFS_DIR}/etc/systemd/system/plymouth-quit.service.d/10-parallax-retain-splash.conf"

check "Pi 3/Pi 5 firmware initramfs images and splash boot parameters"
[ -s "${ROOTFS_DIR}/boot/firmware/initramfs8" ]
[ -s "${ROOTFS_DIR}/boot/firmware/initramfs_2712" ]
grep -q '^auto_initramfs=1$' "${ROOTFS_DIR}/boot/firmware/config.txt"
grep -q '^disable_splash=1$' "${ROOTFS_DIR}/boot/firmware/config.txt"
CMDLINE_FILE="${ROOTFS_DIR}/boot/firmware/cmdline.txt"
[ "$(wc -l < "${CMDLINE_FILE}")" -eq 1 ]
CMDLINE_TEXT="$(cat "${CMDLINE_FILE}")"
read -r -a CMDLINE_TOKENS <<< "${CMDLINE_TEXT}"
for required_token in console=tty1 quiet splash logo.nologo \
  plymouth.ignore-serial-consoles vt.global_cursor_default=0; do
  token_found=false
  for token in "${CMDLINE_TOKENS[@]}"; do
    [ "${token}" = "${required_token}" ] && token_found=true
  done
  [ "${token_found}" = true ]
done
serial_console_present=false
root_argument_present=false
rootfstype_argument_present=false
splash_disabled=false
for token in "${CMDLINE_TOKENS[@]}"; do
  case "${token}" in
    console=serial0,*|console=ttyAMA0,*|console=ttyS0,*) serial_console_present=true ;;
    root=*) root_argument_present=true ;;
    rootfstype=*) rootfstype_argument_present=true ;;
    plymouth.enable=0|nosplash) splash_disabled=true ;;
  esac
done
[ "${serial_console_present}" = true ]
[ "${root_argument_present}" = true ]
[ "${rootfstype_argument_present}" = true ]
if [ "${splash_disabled}" = true ]; then
  echo "splash is disabled on the baked kernel command line" >&2
  exit 1
fi

check "TV-remote passthrough: keymap installed and registered"
[ -f "${ROOTFS_DIR}/etc/rc_keymaps/parallax_cec.toml" ]
grep -q 'rc-cec parallax_cec.toml' "${ROOTFS_DIR}/etc/rc_maps.cfg"

check "TV mode: kiosk packages, units, detect enabled, CEC group"
on_chroot << 'CHROOT'
set -e
dpkg -s cage cog v4l-utils ir-keytable >/dev/null
id -u parallax-kiosk >/dev/null
id -nG astra-receiver | grep -qw video
CHROOT
[ -x "${ROOTFS_DIR}/usr/local/lib/parallax/hdmi-connected.sh" ]
[ -x "${ROOTFS_DIR}/usr/local/lib/parallax/parallax-kiosk-launch.sh" ]
grep -q '^Conflicts=getty@tty1.service' "${ROOTFS_DIR}/etc/systemd/system/parallax-kiosk.service"
grep -q '/display' "${ROOTFS_DIR}/etc/systemd/system/parallax-kiosk.service"
[ -L "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/parallax-kiosk-detect.service" ]
# The kiosk unit itself must NOT be enabled — the detect service starts it only when HDMI is up.
[ ! -e "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/parallax-kiosk.service" ]

check "CEC control baked on"
on_chroot << 'CHROOT'
set -e
node -e '
  const config = JSON.parse(require("fs").readFileSync("/opt/astra-receiver/config.json", "utf8"))
  if (config.cecControl !== true) throw new Error("cecControl not baked on")
'
CHROOT

check "all assertions passed"
