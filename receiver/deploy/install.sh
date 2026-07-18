#!/usr/bin/env bash
#
# Astra Parallax receiver — one-line installer for Raspberry Pi (64-bit) and other arm64 Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Boof2015/astra/dev/receiver/deploy/install.sh | sudo bash
#
# What it does:
#   1. Installs Node.js 24 LTS unless Node >= 22.19 is present (bundled undici requires 22.19+).
#   2. Downloads the latest `receiver-v*` release tarball (prebuilt bundle + ALSA addon).
#   3. Installs to /opt/astra-receiver, creates a service user in the `audio` group.
#   4. Writes + enables a systemd unit. Re-running the script updates in place.
#
# After install: open http://<this-device>:38405/ and pair from Astra on the host machine.

set -euo pipefail

# Releases live in a dedicated repo so they never mix with the Astra app's own releases.
REPO="Boof2015/astra-receiver"
INSTALL_DIR="/opt/astra-receiver"
SERVICE_NAME="astra-receiver"
SERVICE_USER="astra-receiver"
TARBALL_NAME="astra-receiver-linux-arm64.tar.gz"
RELEASE_TAG_PREFIX="receiver-v"
WEB_PORT=38405

log() { printf '\033[1;36m[astra-receiver]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[astra-receiver]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Please run with sudo: curl -fsSL <url> | sudo bash"
[ "$(uname -s)" = "Linux" ] || fail "This installer is for Linux (Raspberry Pi OS and similar)."

ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
  fail "Prebuilt packages are arm64-only (found: $ARCH). On a 32-bit Pi OS, reinstall the 64-bit
image, or build from source — see receiver/README.md in the Astra repo."
fi

command -v curl >/dev/null 2>&1 || fail "curl is required."

# ── Node.js ────────────────────────────────────────────────────────────────────
# The bundle inlines undici, whose engines field requires Node >= 22.19.0 (it calls e.g.
# worker_threads.markAsUncloneable unguarded). Compare full versions, not just the major — a
# Node 22.5 passes a major check and still crashes at startup.
REQUIRED_NODE_VERSION="22.19.0"
NODE_BIN="$(command -v node || true)"
node_is_new_enough() {
  [ -n "$NODE_BIN" ] || return 1
  CURRENT_NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null | tr -d 'v')"
  [ -n "$CURRENT_NODE_VERSION" ] || return 1
  [ "$(printf '%s\n%s\n' "$REQUIRED_NODE_VERSION" "$CURRENT_NODE_VERSION" | sort -V | head -n1)" = "$REQUIRED_NODE_VERSION" ]
}
if ! node_is_new_enough; then
  if [ -n "$NODE_BIN" ]; then
    log "Node $("$NODE_BIN" -v 2>/dev/null || echo '?') is older than $REQUIRED_NODE_VERSION — installing Node.js 24 LTS…"
  else
    log "Node.js not found — installing Node.js 24 LTS…"
  fi
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
  NODE_BIN="$(command -v node)"
fi
log "Using Node $("$NODE_BIN" -v) at $NODE_BIN"

# ── Locate the latest receiver release ────────────────────────────────────────
log "Looking up the latest receiver release…"
RELEASES_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30")"
DOWNLOAD_URL="$(printf '%s' "$RELEASES_JSON" | "$NODE_BIN" -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk });
  process.stdin.on("end", () => {
    const releases = JSON.parse(raw);
    for (const release of releases) {
      if (!release.tag_name || !release.tag_name.startsWith(process.argv[1])) continue;
      if (release.draft || release.prerelease) continue;
      const asset = (release.assets || []).find((a) => a.name === process.argv[2]);
      if (asset) { console.log(asset.browser_download_url); return; }
    }
  });
' "$RELEASE_TAG_PREFIX" "$TARBALL_NAME")"
[ -n "$DOWNLOAD_URL" ] || fail "No published '${RELEASE_TAG_PREFIX}*' release with $TARBALL_NAME found.
Run the 'Receiver Release' GitHub workflow first, or install from source (receiver/README.md)."
log "Downloading $DOWNLOAD_URL"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fsSL -o "$TMP_DIR/$TARBALL_NAME" "$DOWNLOAD_URL"
mkdir -p "$TMP_DIR/extracted"
tar -xzf "$TMP_DIR/$TARBALL_NAME" -C "$TMP_DIR/extracted"
[ -f "$TMP_DIR/extracted/astra-receiver.mjs" ] || fail "Tarball is missing astra-receiver.mjs."
[ -f "$TMP_DIR/extracted/astra_receiver_alsa.node" ] || fail "Tarball is missing the ALSA addon."

# ── Install files + service user ──────────────────────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  log "Stopping running service for update…"
  systemctl stop "$SERVICE_NAME"
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating service user '$SERVICE_USER' (audio group)…"
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin --groups audio "$SERVICE_USER"
else
  usermod -aG audio "$SERVICE_USER" 2>/dev/null || true
fi

mkdir -p "$INSTALL_DIR"
install -m 0644 "$TMP_DIR/extracted/astra-receiver.mjs" "$INSTALL_DIR/astra-receiver.mjs"
install -m 0644 "$TMP_DIR/extracted/astra_receiver_alsa.node" "$INSTALL_DIR/astra_receiver_alsa.node"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

# ── systemd unit ──────────────────────────────────────────────────────────────
log "Writing systemd unit…"
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=Astra Parallax receiver (headless zone speaker)
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
ExecStart=$NODE_BIN $INSTALL_DIR/astra-receiver.mjs
Environment=ASTRA_RECEIVER_CONFIG=$INSTALL_DIR/config.json
Environment=ASTRA_RECEIVER_ALSA_ADDON=$INSTALL_DIR/astra_receiver_alsa.node
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

sleep 2
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  fail "Service failed to start — check: journalctl -u $SERVICE_NAME -n 50"
fi

IP_HINT="$(hostname -I 2>/dev/null | awk '{print $1}')"
log "Done. The receiver is running and discoverable on your network."
log "Pairing + status page: http://${IP_HINT:-$(hostname)}:$WEB_PORT/"
log "Pair from Astra on the host machine (Parallax → Add Sink), approve on the page above."
log "Logs: journalctl -u $SERVICE_NAME -f   |   Update: re-run this installer."
