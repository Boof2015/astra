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

# Lands on the FAT boot partition: the flasher's drive already sits mounted on their desk, so
# setup = rename to custom.toml + edit. (Raspberry Pi Imager won't show its customization
# dialog for third-party images — this template replaces it.)
install -D -m 0644 files/custom.toml.example \
  "${ROOTFS_DIR}/boot/firmware/custom.toml.example"

# Captive-portal Wi-Fi onboarding: the daemon may drive NetworkManager (polkit rule), and the
# hotspot's shared-mode dnsmasq resolves every name to the AP so phones auto-open the portal.
install -D -m 0644 files/50-parallax-network.rules \
  "${ROOTFS_DIR}/etc/polkit-1/rules.d/50-parallax-network.rules"
install -D -m 0644 files/parallax-captive.conf \
  "${ROOTFS_DIR}/etc/NetworkManager/dnsmasq-shared.d/parallax-captive.conf"

# The baked `parallax` user exists only so the first-boot wizard never squats on tty1 (pi-gen
# demands a FIRST_USER_PASS for that; the workflow injects a throwaway). Lock it: nothing
# shipped is loginable until a custom.toml sets a real password or SSH keys.
on_chroot << CHROOT
set -e
passwd -l parallax
CHROOT
