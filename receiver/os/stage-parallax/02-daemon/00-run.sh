#!/bin/bash -e
# Install the receiver daemon into the image. The CI workflow injects into files/payload/:
#   astra-receiver-linux-arm64.tar.gz(.sha256)  — the receiver release being baked
#   receiver-tag.txt                            — its receiver-v<version> tag
#   update.sh                                   — receiver/deploy/update.sh from this checkout
#
# The unpack itself is update.sh in OFFLINE mode against the rootfs from the HOST side (no
# network and no token inside the chroot) — the exact code path the on-device auto-updater
# runs, so the image build exercises it on every release.

RECEIVER_TAG="$(cat files/payload/receiver-tag.txt)"

on_chroot << CHROOT
set -e
if ! id -u astra-receiver >/dev/null 2>&1; then
  useradd --system --home-dir /opt/astra-receiver --shell /usr/sbin/nologin --groups audio astra-receiver
fi
CHROOT

ASTRA_RECEIVER_INSTALL_DIR="${ROOTFS_DIR}/opt/astra-receiver" bash files/payload/update.sh \
  --from-tarball files/payload/astra-receiver-linux-arm64.tar.gz \
  --sha256-file files/payload/astra-receiver-linux-arm64.tar.gz.sha256 \
  --tag "${RECEIVER_TAG}" \
  --no-restart

# Seed config: ALSA on the status-page port 80 (the unit grants CAP_NET_BIND_SERVICE).
# endpointUuid and sinkName are deliberately ABSENT — the daemon generates a unique UUID on
# first boot and the name defaults to the hostname, so every flashed device is distinct.
install -m 0600 files/config.json "${ROOTFS_DIR}/opt/astra-receiver/config.json"

install -m 0644 files/astra-receiver.service \
  "${ROOTFS_DIR}/etc/systemd/system/astra-receiver.service"
install -m 0644 files/astra-receiver-update.service \
  "${ROOTFS_DIR}/etc/systemd/system/astra-receiver-update.service"
install -m 0644 files/astra-receiver-update.timer \
  "${ROOTFS_DIR}/etc/systemd/system/astra-receiver-update.timer"

on_chroot << CHROOT
set -e
chown -R astra-receiver:astra-receiver /opt/astra-receiver
systemctl enable astra-receiver.service astra-receiver-update.timer
CHROOT
