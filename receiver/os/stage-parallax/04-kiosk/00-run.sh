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

# Transparent 1x1 Xcursor theme: cage has no hide-cursor option but honors XCURSOR_THEME
# (set in the kiosk unit), and without this a default arrow sits dead-center on the TV forever.
# The 68 constant bytes (Xcursor header + one TOC entry + one 1x1 transparent ARGB image) are
# emitted directly — this runs HOST-side in pi-gen's container, which has no python, and the
# bytes never change. Layout: "Xcur", u32le hdrsize=16/version/ntoc=1; TOC 0xFFFD0002/size 1/
# offset 28; image chunk hdr 36/type/size/version/w=1/h=1/xhot/yhot/delay; pixel 0x00000000.
mkdir -p "${ROOTFS_DIR}/usr/share/icons/parallax-blank/cursors"
printf '[Icon Theme]\nName=parallax-blank\n' > "${ROOTFS_DIR}/usr/share/icons/parallax-blank/index.theme"
printf '\130\143\165\162\020\000\000\000\000\000\001\000\001\000\000\000\002\000\375\377\001\000\000\000\034\000\000\000\044\000\000\000\002\000\375\377\001\000\000\000\001\000\000\000\001\000\000\000\001\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000' \
  > "${ROOTFS_DIR}/usr/share/icons/parallax-blank/cursors/left_ptr"
ln -sf left_ptr "${ROOTFS_DIR}/usr/share/icons/parallax-blank/cursors/default"

on_chroot << CHROOT
set -e
if ! id -u parallax-kiosk >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/parallax-kiosk \
    --shell /usr/sbin/nologin --groups video,render,input parallax-kiosk
fi
usermod -aG video astra-receiver
systemctl enable parallax-kiosk-detect.service
CHROOT
