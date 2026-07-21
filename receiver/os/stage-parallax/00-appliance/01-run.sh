#!/bin/bash -e
# Appliance base configuration: hardware watchdog, journal cap, unattended security upgrades.
# (avahi-daemon needs no configuration — stock behavior advertises TARGET_HOSTNAME.local and
# auto-renames on conflict, which is exactly the parallax.local story.)

install -D -m 0644 files/10-parallax-watchdog.conf \
  "${ROOTFS_DIR}/etc/systemd/system.conf.d/10-parallax-watchdog.conf"
install -D -m 0644 files/10-parallax-journald.conf \
  "${ROOTFS_DIR}/etc/systemd/journald.conf.d/10-parallax-journald.conf"
install -D -m 0644 files/20auto-upgrades \
  "${ROOTFS_DIR}/etc/apt/apt.conf.d/20auto-upgrades"
install -D -m 0644 files/51unattended-upgrades-parallax \
  "${ROOTFS_DIR}/etc/apt/apt.conf.d/51unattended-upgrades-parallax"

# pi-gen's Trixie stage installs generic active NoCloud inputs on the FAT boot partition.
# Replace them with Parallax-specific, credential-free templates that power users can edit in
# place before first boot. meta-data stays owned by pi-gen because it supplies the instance ID
# and local datasource mode needed to consume these files.
install -D -m 0644 files/user-data \
  "${ROOTFS_DIR}/boot/firmware/user-data"
install -D -m 0644 files/network-config \
  "${ROOTFS_DIR}/boot/firmware/network-config"

# Captive-portal Wi-Fi onboarding: the daemon may drive NetworkManager (polkit rule), and the
# hotspot's shared-mode dnsmasq resolves every name to the AP so phones auto-open the portal.
install -D -m 0644 files/50-parallax-network.rules \
  "${ROOTFS_DIR}/etc/polkit-1/rules.d/50-parallax-network.rules"
install -D -m 0644 files/parallax-captive.conf \
  "${ROOTFS_DIR}/etc/NetworkManager/dnsmasq-shared.d/parallax-captive.conf"

# The baked `parallax` UID-1000 user gives Raspberry Pi OS cloud-init an account to retain or
# rename from user-data (pi-gen demands a FIRST_USER_PASS; the workflow injects a throwaway).
# Lock it after the build: an uncustomized image ships no usable login.
on_chroot << CHROOT
set -e
passwd -l parallax
CHROOT
