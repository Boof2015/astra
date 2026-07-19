#!/usr/bin/env bash
# Exit 0 iff any HDMI connector currently reports a connected display (vc4 DRM sysfs).
# Used by parallax-kiosk-launch.sh at boot to decide TV mode vs. headless.
set -u
for status in /sys/class/drm/card*-HDMI-*/status; do
  [ -f "$status" ] || continue
  if [ "$(cat "$status")" = "connected" ]; then
    exit 0
  fi
done
exit 1
