#!/bin/bash -e
# Standard pi-gen stage prerun: start from the previous stage's rootfs.
if [ ! -d "${ROOTFS_DIR}" ]; then
  copy_previous
fi
