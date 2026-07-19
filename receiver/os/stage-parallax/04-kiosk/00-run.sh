#!/bin/bash -e
# TV mode: kiosk user + units + HDMI detect scripts. Also puts the daemon's service user in the
# `video` group — the kernel CEC device (/dev/cec0) is root:video, and the daemon drives the TV
# via cec-ctl when cecControl is set in its config.

install -D -m 0755 files/hdmi-connected.sh \
  "${ROOTFS_DIR}/usr/local/lib/parallax/hdmi-connected.sh"
install -D -m 0755 files/parallax-kiosk-launch.sh \
  "${ROOTFS_DIR}/usr/local/lib/parallax/parallax-kiosk-launch.sh"
install -m 0644 files/parallax-kiosk.service \
  "${ROOTFS_DIR}/etc/systemd/system/parallax-kiosk.service"
install -m 0644 files/parallax-kiosk-detect.service \
  "${ROOTFS_DIR}/etc/systemd/system/parallax-kiosk-detect.service"

on_chroot << CHROOT
set -e
if ! id -u parallax-kiosk >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/parallax-kiosk \
    --shell /usr/sbin/nologin --groups video,render,input parallax-kiosk
fi
usermod -aG video astra-receiver
systemctl enable parallax-kiosk-detect.service
CHROOT
