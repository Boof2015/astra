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
[ "$(cat "${ROOTFS_DIR}/etc/hostname" | tr -d ' \t\n\r')" = "parallax" ]

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

check "TV mode: kiosk packages, units, detect enabled, CEC group"
on_chroot << 'CHROOT'
set -e
dpkg -s cage cog v4l-utils >/dev/null
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
