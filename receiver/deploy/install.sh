#!/usr/bin/env bash
#
# Astra Parallax receiver — one-line installer for Raspberry Pi (64-bit) and other arm64 Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Boof2015/astra/dev/receiver/deploy/install.sh -o /tmp/astra-receiver-install.sh && sudo bash /tmp/astra-receiver-install.sh
#
# (Download-then-run rather than `| sudo bash`: modern sudo runs commands on a private pty, and
# with the script arriving on stdin there is no route for keyboard input — the audio-output
# question would be skipped. With the file form, stdin stays your terminal and prompts work.)
#
# What it does:
#   1. Installs Node.js 24 LTS unless Node >= 22.19 is present (bundled undici requires 22.19+).
#   2. Runs update.sh (shared with the Parallax OS auto-updater): downloads the latest
#      `receiver-v*` release tarball, sha256-verifies it, and atomically installs it under
#      /opt/astra-receiver/releases/<tag> with a `current` symlink.
#   3. Creates a service user in the `audio` group.
#   4. Writes + enables a systemd unit (Type=notify + watchdog). Re-running = update.
#
# After install: open http://<this-device>:38405/ and pair from Astra on the host machine.

set -euo pipefail

# Where this script itself lives (for self-referential instructions). The releases repo name
# lives in update.sh (overridable via ASTRA_RECEIVER_REPO) — releases stay in a dedicated repo
# so they never mix with the Astra app's own releases.
REPO_SOURCE="Boof2015/astra"
INSTALL_DIR="/opt/astra-receiver"
SERVICE_NAME="astra-receiver"
SERVICE_USER="astra-receiver"
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
  if ! read -r choice < /dev/tty 2>/dev/null; then
    choice=""
    log "Could not read from the terminal (piped install) — using option $default_index."
    log "To choose interactively, run the download-then-run form:"
    log "  curl -fsSL https://raw.githubusercontent.com/$REPO_SOURCE/dev/receiver/deploy/install.sh -o /tmp/astra-receiver-install.sh && sudo bash /tmp/astra-receiver-install.sh"
  fi
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

# ── Install the latest release via the shared updater ─────────────────────────
# update.sh owns download + sha256 verification + the atomic releases/<tag> + current symlink
# swap (also used by the Parallax OS auto-update timer). No service stop needed: the swap is
# a rename, and the running daemon keeps its open inodes until we restart it below.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/update.sh" ]; then
  cp "$SCRIPT_DIR/update.sh" "$TMP_DIR/update.sh"
else
  curl -fsSL -o "$TMP_DIR/update.sh" \
    "https://raw.githubusercontent.com/$REPO_SOURCE/dev/receiver/deploy/update.sh"
fi
bash "$TMP_DIR/update.sh" --no-restart
[ -f "$INSTALL_DIR/current/astra-receiver.mjs" ] || fail "update.sh did not produce $INSTALL_DIR/current/."

# Pre-0.2.0 installs kept the bundle flat in $INSTALL_DIR — remove so nothing stale lingers.
rm -f "$INSTALL_DIR/astra-receiver.mjs" "$INSTALL_DIR/astra_receiver_alsa.node"

# ── Service user ──────────────────────────────────────────────────────────────
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating service user '$SERVICE_USER' (audio group)…"
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin --groups audio "$SERVICE_USER"
else
  usermod -aG audio "$SERVICE_USER" 2>/dev/null || true
fi

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
# Type=notify + WatchdogSec: the daemon (>= 0.2.0) sends READY=1 when it is genuinely serving
# and WATCHDOG=1 keepalives via the addon's sd_notify. StartLimitIntervalSec=0: a 24/7 node
# must never give up restarting.
log "Writing systemd unit…"
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=Astra Parallax receiver (headless zone speaker)
After=network-online.target sound.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=notify
User=$SERVICE_USER
ExecStart=$NODE_BIN $INSTALL_DIR/current/astra-receiver.mjs
Environment=ASTRA_RECEIVER_CONFIG=$INSTALL_DIR/config.json
Environment=ASTRA_RECEIVER_ALSA_ADDON=$INSTALL_DIR/current/astra_receiver_alsa.node
Restart=always
RestartSec=3
WatchdogSec=30
TimeoutStartSec=90
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

STARTED=0
for _ in $(seq 1 20); do
  if systemctl is-active --quiet "$SERVICE_NAME"; then STARTED=1; break; fi
  sleep 1
done
if [ "$STARTED" -ne 1 ]; then
  fail "Service failed to start — check: journalctl -u $SERVICE_NAME -n 50"
fi

IP_HINT="$(hostname -I 2>/dev/null | awk '{print $1}')"
log "Done. The receiver is running and discoverable on your network."
log "Pairing + status page: http://${IP_HINT:-$(hostname)}:$WEB_PORT/"
log "Pair from Astra on the host machine (Parallax → Add Sink), approve on the page above."
log "Logs: journalctl -u $SERVICE_NAME -f   |   Update or change audio output: re-run this installer."
