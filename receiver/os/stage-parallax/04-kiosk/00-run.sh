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

# Transparent Xcursor theme: cage has no hide-cursor option but honors XCURSOR_THEME (set in
# the kiosk unit), and without this a default arrow sits dead-center on the TV forever. The
# cursor is 24x24 at NOMINAL SIZE 24 — matching the default XCURSOR_SIZE, because wlroots falls
# back to its compiled-in arrow when a theme has no usable size (a 1x1/size-1 theme did exactly
# that on the first TV test). Emitted host-side with printf+dd (pi-gen's container has no
# python): 64-byte header/TOC/chunk prefix, then 24*24 transparent ARGB pixels (2304 zeros).
mkdir -p "${ROOTFS_DIR}/usr/share/icons/parallax-blank/cursors"
printf '[Icon Theme]\nName=parallax-blank\n' > "${ROOTFS_DIR}/usr/share/icons/parallax-blank/index.theme"
CURSOR_FILE="${ROOTFS_DIR}/usr/share/icons/parallax-blank/cursors/left_ptr"
printf '\130\143\165\162\020\000\000\000\000\000\001\000\001\000\000\000\002\000\375\377\030\000\000\000\034\000\000\000\044\000\000\000\002\000\375\377\030\000\000\000\001\000\000\000\030\000\000\000\030\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000' \
  > "${CURSOR_FILE}"
dd if=/dev/zero bs=2304 count=1 >> "${CURSOR_FILE}" 2>/dev/null
[ "$(wc -c < "${CURSOR_FILE}")" -eq 2368 ]
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
