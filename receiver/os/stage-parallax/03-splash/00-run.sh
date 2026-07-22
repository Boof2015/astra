#!/bin/bash -e
# Install the Parallax Plymouth theme, enable it in every shipped kernel initramfs, and keep
# the boot command line single-line. Plymouth owns Esc so details mode remains a native fallback.

THEME_DIR="${ROOTFS_DIR}/usr/share/plymouth/themes/parallax"
mkdir -p "${THEME_DIR}"
install -m 0644 files/parallax/parallax.plymouth "${THEME_DIR}/parallax.plymouth"
install -m 0644 files/parallax/parallax.script "${THEME_DIR}/parallax.script"
install -m 0644 files/parallax/*.png "${THEME_DIR}/"
install -D -m 0644 files/plymouthd.conf "${ROOTFS_DIR}/etc/plymouth/plymouthd.conf"
install -D -m 0644 files/plymouth-quit.service.d/10-parallax-retain-splash.conf \
  "${ROOTFS_DIR}/etc/systemd/system/plymouth-quit.service.d/10-parallax-retain-splash.conf"

CMDLINE_FILE="${ROOTFS_DIR}/boot/firmware/cmdline.txt"
if [ "$(awk 'END { print NR }' "${CMDLINE_FILE}")" -ne 1 ]; then
  echo "cmdline.txt must contain exactly one line before splash configuration" >&2
  exit 1
fi
CMDLINE_TEXT="$(cat "${CMDLINE_FILE}")"
read -r -a CMDLINE_TOKENS <<< "${CMDLINE_TEXT}"
for required_token in console=tty1 quiet splash logo.nologo \
  plymouth.ignore-serial-consoles vt.global_cursor_default=0; do
  token_found=false
  for existing_token in "${CMDLINE_TOKENS[@]}"; do
    if [ "${existing_token}" = "${required_token}" ]; then
      token_found=true
      break
    fi
  done
  if [ "${token_found}" = false ]; then
    CMDLINE_TOKENS+=("${required_token}")
  fi
done
printf '%s\n' "${CMDLINE_TOKENS[*]}" > "${CMDLINE_FILE}"

# auto_initramfs selects initramfs8 for the Pi 3 kernel and initramfs_2712 for the Pi 5 kernel.
# disable_splash suppresses the firmware rainbow so the first intentional graphic is Plymouth.
CONFIG_FILE="${ROOTFS_DIR}/boot/firmware/config.txt"
if ! grep -q '^# Parallax OS boot splash$' "${CONFIG_FILE}"; then
  cat >> "${CONFIG_FILE}" <<'CONFIG'

# Parallax OS boot splash
[all]
auto_initramfs=1
disable_splash=1
CONFIG
fi

# pi-gen disables initramfs updates in stage0. Re-enable them before selecting the theme so
# both installed Raspberry Pi kernel families receive Plymouth and its fallback plugins.
INITRAMFS_CONFIG="${ROOTFS_DIR}/etc/initramfs-tools/update-initramfs.conf"
if grep -q '^update_initramfs=' "${INITRAMFS_CONFIG}"; then
  sed -i 's/^update_initramfs=.*/update_initramfs=yes/' "${INITRAMFS_CONFIG}"
else
  printf '\nupdate_initramfs=yes\n' >> "${INITRAMFS_CONFIG}"
fi

on_chroot <<'CHROOT'
set -e
plymouth-set-default-theme parallax

kernel_count=0
for module_dir in /lib/modules/*; do
  [ -d "${module_dir}" ] || continue
  kernel_version="${module_dir##*/}"
  kernel_count=$((kernel_count + 1))
  if [ -f "/boot/initrd.img-${kernel_version}" ]; then
    update-initramfs -u -k "${kernel_version}"
  else
    update-initramfs -c -k "${kernel_version}"
  fi
done
[ "${kernel_count}" -gt 0 ]
CHROOT
