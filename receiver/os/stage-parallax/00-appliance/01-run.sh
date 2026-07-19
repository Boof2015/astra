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
