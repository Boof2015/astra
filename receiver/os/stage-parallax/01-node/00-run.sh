#!/bin/bash -e
# Node.js 24 LTS from NodeSource's keyring-based apt repo (their `nodistro` layout is
# release-agnostic). Deterministic and shellcheck-able, unlike piping setup_24.x. The daemon
# bundle inlines undici, which hard-requires Node >= 22.19.0 — assert, don't assume.

on_chroot << CHROOT
set -e
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs

REQUIRED="22.19.0"
CURRENT="\$(node -v | tr -d v)"
if [ "\$(printf '%s\n%s\n' "\$REQUIRED" "\$CURRENT" | sort -V | head -n1)" != "\$REQUIRED" ]; then
  echo "Node \$CURRENT is older than \$REQUIRED (bundled undici floor)" >&2
  exit 1
fi
CHROOT
