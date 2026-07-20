#!/usr/bin/env bash
#
# Astra Parallax receiver — hardened update path. One script, three consumers:
#
#   1. The Parallax OS auto-update timer (astra-receiver-update.timer) runs it bare: resolve the
#      latest `receiver-v*` release, verify, atomically swap, restart, roll back on failure.
#   2. install.sh runs it with --no-restart and handles the service itself.
#   3. The image build runs it OFFLINE against the pi-gen rootfs:
#        ASTRA_RECEIVER_INSTALL_DIR=$ROOTFS_DIR/opt/astra-receiver \
#          update.sh --from-tarball <tar.gz> --sha256-file <file> --tag receiver-vX.Y.Z --no-restart
#
# Layout it maintains:
#   $INSTALL_DIR/releases/<tag>/   one directory per installed release (current + one previous)
#   $INSTALL_DIR/current           relative symlink to releases/<tag> — the symlink target IS the
#                                  "installed version" stamp, so it can never desync from reality
#
# The swap is atomic (ln + mv -T onto the live name), so the running daemon keeps its already-open
# inodes and a crash mid-update never leaves a half-installed current/.

set -euo pipefail

# Repo name appears exactly once; a rename only needs ASTRA_RECEIVER_REPO (GitHub 301-redirects
# renamed repos, and curl -L follows, so even that is not urgent — deployed devices with the old
# default keep updating through the redirect until a release ships them this new default).
REPO="${ASTRA_RECEIVER_REPO:-Boof2015/parallax-os}"
INSTALL_DIR="${ASTRA_RECEIVER_INSTALL_DIR:-/opt/astra-receiver}"
SERVICE_NAME="astra-receiver"
TARBALL_NAME="astra-receiver-linux-arm64.tar.gz"
RELEASE_TAG_PREFIX="receiver-v"

log() { printf '\033[1;36m[astra-receiver-update]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[astra-receiver-update]\033[0m %s\n' "$*" >&2; exit 1; }

NO_RESTART=0
FROM_TARBALL=""
SHA256_FILE=""
FORCED_TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-restart) NO_RESTART=1 ;;
    --from-tarball) FROM_TARBALL="${2:?--from-tarball needs a path}"; shift ;;
    --sha256-file) SHA256_FILE="${2:?--sha256-file needs a path}"; shift ;;
    --tag) FORCED_TAG="${2:?--tag needs a release tag}"; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
  shift
done

if [ -n "$FROM_TARBALL" ] || [ -n "$SHA256_FILE" ] || [ -n "$FORCED_TAG" ]; then
  if [ -z "$FROM_TARBALL" ] || [ -z "$SHA256_FILE" ] || [ -z "$FORCED_TAG" ]; then
    fail "Offline mode needs all of --from-tarball, --sha256-file and --tag."
  fi
  [ -f "$FROM_TARBALL" ] || fail "Tarball not found: $FROM_TARBALL"
  [ -f "$SHA256_FILE" ] || fail "sha256 file not found: $SHA256_FILE"
fi

mkdir -p "$INSTALL_DIR/releases"

# One updater at a time (timer vs. an interactive installer re-run). flock(1) is Linux-only;
# the mac dev harness just runs unlocked.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$INSTALL_DIR/.update.lock"
  if ! flock -n 9; then
    log "Another update is already running — nothing to do."
    exit 0
  fi
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Atomic on Linux (mv -T renames onto the live name). BSD mv has no -T; the mac harness falls
# back to ln -sfn, which is replace-not-atomic but only ever runs in tests.
swap_current() {
  local target="$1"
  rm -f "$INSTALL_DIR/current.new"
  ln -s "$target" "$INSTALL_DIR/current.new"
  if ! mv -T "$INSTALL_DIR/current.new" "$INSTALL_DIR/current" 2>/dev/null; then
    rm -f "$INSTALL_DIR/current.new"
    ln -sfn "$target" "$INSTALL_DIR/current"
  fi
}

INSTALLED_TARGET="$(readlink "$INSTALL_DIR/current" 2>/dev/null || true)"
INSTALLED_TAG="$(basename "$INSTALLED_TARGET" 2>/dev/null || true)"

# ── Resolve what to install ───────────────────────────────────────────────────
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ -n "$FROM_TARBALL" ]; then
  NEW_TAG="$FORCED_TAG"
  TARBALL_PATH="$FROM_TARBALL"
  SHA_PATH="$SHA256_FILE"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  command -v node >/dev/null 2>&1 || fail "node is required (the installer sets it up)."
  log "Looking up the latest ${RELEASE_TAG_PREFIX}* release in ${REPO}…"
  AUTH_ARGS=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_ARGS=(-H "Authorization: Bearer $GITHUB_TOKEN")
  fi
  RELEASES_JSON="$(curl -fsSL "${AUTH_ARGS[@]}" "https://api.github.com/repos/$REPO/releases?per_page=30")"
  RESOLVED="$(printf '%s' "$RELEASES_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk });
    process.stdin.on("end", () => {
      const releases = JSON.parse(raw);
      for (const release of releases) {
        if (!release.tag_name || !release.tag_name.startsWith(process.argv[1])) continue;
        if (release.draft || release.prerelease) continue;
        const assets = release.assets || [];
        const tarball = assets.find((a) => a.name === process.argv[2]);
        const sha = assets.find((a) => a.name === process.argv[2] + ".sha256");
        if (tarball && sha) {
          console.log(release.tag_name);
          console.log(tarball.browser_download_url);
          console.log(sha.browser_download_url);
          return;
        }
      }
    });
  ' "$RELEASE_TAG_PREFIX" "$TARBALL_NAME")"
  [ -n "$RESOLVED" ] || fail "No published ${RELEASE_TAG_PREFIX}* release with $TARBALL_NAME + .sha256 found in $REPO."
  NEW_TAG="$(printf '%s\n' "$RESOLVED" | sed -n 1p)"
  TARBALL_URL="$(printf '%s\n' "$RESOLVED" | sed -n 2p)"
  SHA_URL="$(printf '%s\n' "$RESOLVED" | sed -n 3p)"

  if [ "$NEW_TAG" = "$INSTALLED_TAG" ]; then
    log "Already on $INSTALLED_TAG — up to date."
    exit 0
  fi

  log "Downloading ${NEW_TAG}…"
  TARBALL_PATH="$TMP_DIR/$TARBALL_NAME"
  SHA_PATH="$TMP_DIR/$TARBALL_NAME.sha256"
  curl -fsSL -o "$TARBALL_PATH" "$TARBALL_URL"
  curl -fsSL -o "$SHA_PATH" "$SHA_URL"
fi

if [ "$NEW_TAG" = "$INSTALLED_TAG" ]; then
  log "Already on $INSTALLED_TAG — up to date."
  exit 0
fi

# ── Verify + unpack ───────────────────────────────────────────────────────────
# Compare digests directly instead of `sha256sum -c` so the tarball's on-disk name never matters.
EXPECTED_SHA="$(awk 'NF { print $1; exit }' "$SHA_PATH")"
ACTUAL_SHA="$(sha256_of "$TARBALL_PATH")"
if [ -z "$EXPECTED_SHA" ] || [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  fail "sha256 mismatch for $NEW_TAG (expected $EXPECTED_SHA, got $ACTUAL_SHA) — refusing to install."
fi
log "sha256 verified."

STAGING_DIR="$INSTALL_DIR/releases/.staging-$NEW_TAG"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
tar -xzf "$TARBALL_PATH" -C "$STAGING_DIR"
[ -f "$STAGING_DIR/astra-receiver.mjs" ] || fail "Tarball is missing astra-receiver.mjs."
[ -f "$STAGING_DIR/astra_receiver_alsa.node" ] || fail "Tarball is missing the ALSA addon."
if [ -f "$STAGING_DIR/update.sh" ]; then
  chmod +x "$STAGING_DIR/update.sh"
fi
# Extracted as root; the service user only ever needs to read these.
chmod -R a+rX "$STAGING_DIR"
rm -rf "${INSTALL_DIR:?}/releases/$NEW_TAG"
mv "$STAGING_DIR" "$INSTALL_DIR/releases/$NEW_TAG"

# ── Swap + restart + health gate ──────────────────────────────────────────────
swap_current "releases/$NEW_TAG"
log "Installed $NEW_TAG (current -> releases/$NEW_TAG)."

service_healthy() {
  for _ in $(seq 1 60); do
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      # Active once (with Type=notify that means READY=1 arrived) — hold for 10 s to catch an
      # immediate crash loop before declaring the update good.
      sleep 10
      systemctl is-active --quiet "$SERVICE_NAME" && return 0
      return 1
    fi
    sleep 1
  done
  return 1
}

if [ "$NO_RESTART" -eq 1 ]; then
  log "Skipping service restart (--no-restart)."
else
  command -v systemctl >/dev/null 2>&1 || fail "systemctl not found — use --no-restart."
  log "Restarting ${SERVICE_NAME}…"
  systemctl restart "$SERVICE_NAME" || true
  if service_healthy; then
    log "Service healthy on $NEW_TAG."
  elif [ -n "$INSTALLED_TARGET" ] && [ -e "$INSTALL_DIR/$INSTALLED_TARGET" ]; then
    log "Service unhealthy on $NEW_TAG — rolling back to $INSTALLED_TAG."
    swap_current "$INSTALLED_TARGET"
    systemctl restart "$SERVICE_NAME" || true
    if service_healthy; then
      log "Rolled back to $INSTALLED_TAG; $NEW_TAG kept in releases/ for inspection."
    else
      log "Service still unhealthy after rollback — check: journalctl -u $SERVICE_NAME -n 50"
    fi
    exit 1
  else
    fail "Service unhealthy on $NEW_TAG and no previous release to roll back to — check: journalctl -u $SERVICE_NAME -n 50"
  fi
  # A unit from the pre-0.2.0 flat layout still points at $INSTALL_DIR/astra-receiver.mjs and
  # would silently keep running the old bundle.
  if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ] \
    && ! grep -q "$INSTALL_DIR/current/" "/etc/systemd/system/$SERVICE_NAME.service"; then
    log "WARNING: the systemd unit does not run from $INSTALL_DIR/current/ — re-run install.sh to migrate it."
  fi
fi

# ── Prune: keep the new current + one previous ────────────────────────────────
CURRENT_TARGET="$(readlink "$INSTALL_DIR/current" 2>/dev/null || true)"
for dir in "$INSTALL_DIR"/releases/*/ "$INSTALL_DIR"/releases/.staging-*/; do
  [ -d "$dir" ] || continue
  name="releases/$(basename "$dir")"
  if [ "$name" != "$CURRENT_TARGET" ] && [ "$name" != "$INSTALLED_TARGET" ]; then
    rm -rf "$dir"
  fi
done
