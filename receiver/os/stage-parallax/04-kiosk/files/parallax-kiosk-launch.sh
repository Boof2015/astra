#!/usr/bin/env bash
# Boot-time TV-mode detect, run by parallax-kiosk-detect.service (oneshot). DRM connector state
# can settle a few seconds after boot, so poll briefly; if an HDMI display is connected, start
# the kiosk. The kiosk unit is deliberately NOT enabled directly: its Conflicts=getty@tty1 must
# only ever fire when a TV is actually present, and a systemd Condition* can't read sysfs
# file CONTENT — hence this launcher.
set -u
for _ in $(seq 1 10); do
  if /usr/local/lib/parallax/hdmi-connected.sh; then
    exec systemctl start --no-block parallax-kiosk.service
  fi
  sleep 1
done
# No display — stay headless.
exit 0
