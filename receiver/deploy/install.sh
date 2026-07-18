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

# ── Audio output selection ────────────────────────────────────────────────────
# Enumerate sound cards from /proc/asound/cards (no alsa-utils dependency) and let the user pick
# where the receiver should play. Piped installs have the script on stdin, so the prompt reads
# from /dev/tty; without a terminal (automation) we keep the current/default device — the daemon
# still has its own runtime fallback. Re-running the installer is the supported way to change
# the device later; the menu defaults to whatever is currently configured.
CARDS_FILE="${ASTRA_RECEIVER_CARDS_FILE:-/proc/asound/cards}"
SELECTED_DEVICE=""

current_config_device() {
  [ -f "$INSTALL_DIR/config.json" ] || return 0
  "$NODE_BIN" -e '
    try {
      const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      if (typeof config.audioDevice === "string") process.stdout.write(config.audioDevice)
    } catch {}
  ' "$INSTALL_DIR/config.json" 2>/dev/null || true
}

choose_audio_device() {
  local card_names=() card_descs=() line name
  if [ -r "$CARDS_FILE" ]; then
    while IFS= read -r line; do
      if [[ "$line" =~ ^[[:space:]]*[0-9]+[[:space:]]+\[([^]]+)\]:[[:space:]]*(.*)$ ]]; then
        name="$(printf '%s' "${BASH_REMATCH[1]}" | sed 's/[[:space:]]*$//')"
        card_names+=("$name")
        card_descs+=("${BASH_REMATCH[2]}")
      fi
    done < "$CARDS_FILE"
  fi

  if [ "${#card_names[@]}" -eq 0 ]; then
    log "No sound cards detected yet — keeping the default device; the daemon retries at startup."
    return 0
  fi

  local current_device
  current_device="$(current_config_device)"

  if [ "${#card_names[@]}" -eq 1 ]; then
    SELECTED_DEVICE="plughw:${card_names[0]},0"
    log "Audio output: ${card_names[0]} (${card_descs[0]})"
    return 0
  fi

  local default_index=1 index
  for index in "${!card_names[@]}"; do
    if [ "plughw:${card_names[$index]},0" = "$current_device" ]; then
      default_index=$((index + 1))
    fi
  done

  if ! { : < /dev/tty; } 2>/dev/null; then
    SELECTED_DEVICE="${current_device:-plughw:${card_names[0]},0}"
    log "No terminal available — keeping audio output '$SELECTED_DEVICE'. Re-run interactively to change it."
    return 0
  fi

  {
    printf '\n\033[1mWhich output should this receiver play through?\033[0m\n'
    printf '(HDMI ports are usually named vc4hdmi…; the 3.5mm jack is usually Headphones)\n'
    for index in "${!card_names[@]}"; do
      printf '  %d) %-16s %s\n' "$((index + 1))" "${card_names[$index]}" "${card_descs[$index]}"
    done
    printf 'Choice [%d]: ' "$default_index"
  } > /dev/tty

  local choice=""
  read -r choice < /dev/tty || choice=""
  case "$choice" in
    ''|*[!0-9]*) choice="$default_index" ;;
  esac
  if [ "$choice" -lt 1 ] || [ "$choice" -gt "${#card_names[@]}" ]; then
    choice="$default_index"
  fi
  SELECTED_DEVICE="plughw:${card_names[$((choice - 1))]},0"
  log "Audio output: $SELECTED_DEVICE"
}

choose_audio_device

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

# Apply the chosen audio device by MERGING into the existing config — a re-run must never wipe
# the endpoint UUID or the pairing credential stored alongside it.
if [ -n "$SELECTED_DEVICE" ]; then
  "$NODE_BIN" -e '
    const fs = require("fs")
    const path = process.argv[1]
    let config = {}
    try { config = JSON.parse(fs.readFileSync(path, "utf8")) } catch {}
    config.audioDevice = process.argv[2]
    config.audioBackend = "alsa"
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
  ' "$INSTALL_DIR/config.json" "$SELECTED_DEVICE"
fi
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
log "Logs: journalctl -u $SERVICE_NAME -f   |   Update or change audio output: re-run this installer."
