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
# The Xcursor binary format is simple enough to emit directly — no cursor tooling needed.
mkdir -p "${ROOTFS_DIR}/usr/share/icons/parallax-blank/cursors"
printf '[Icon Theme]\nName=parallax-blank\n' > "${ROOTFS_DIR}/usr/share/icons/parallax-blank/index.theme"
python3 - "${ROOTFS_DIR}/usr/share/icons/parallax-blank/cursors/left_ptr" << 'PYEOF'
import struct, sys
# Xcursor: magic, header size, version, ntoc; one TOC entry; one 1x1 fully transparent image.
header = struct.pack('<4sIII', b'Xcur', 16, 0x10000, 1)
toc = struct.pack('<III', 0xFFFD0002, 1, 28)
image = struct.pack('<IIIIIIIII', 36, 0xFFFD0002, 1, 1, 1, 1, 0, 0, 0) + struct.pack('<I', 0)
with open(sys.argv[1], 'wb') as handle:
    handle.write(header + toc + image)
PYEOF
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
