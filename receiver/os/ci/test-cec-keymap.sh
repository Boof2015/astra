#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REWRITE_SCRIPT="${SCRIPT_DIR}/../stage-parallax/04-kiosk/files/rewrite-rc-cec-map.sh"
CEC_KEYMAP="${SCRIPT_DIR}/../stage-parallax/04-kiosk/files/parallax_cec.toml"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

assert_canonical() {
  local file="$1"

  awk '
    /^[[:space:]]*#/ { next }
    NF >= 2 && $2 == "rc-cec" {
      count++
      if ($1 != "*" || $3 != "parallax_cec.toml" || NF != 3)
        invalid = 1
    }
    END { exit !(count == 1 && !invalid) }
  ' "${file}"

  [ "$(grep -c '^# Parallax OS: TV-remote passthrough for the kiosk (see parallax_cec.toml).$' "${file}")" -eq 1 ]
}

run_fixture() {
  local name="$1"
  local input="${TEST_DIR}/${name}.cfg"
  local once="${TEST_DIR}/${name}.once.cfg"
  local twice="${TEST_DIR}/${name}.twice.cfg"

  bash "${REWRITE_SCRIPT}" "${input}" > "${once}"
  bash "${REWRITE_SCRIPT}" "${once}" > "${twice}"
  assert_canonical "${once}"
  cmp "${once}" "${twice}"
}

cat > "${TEST_DIR}/stock.cfg" <<'EOF'
# Stock mappings
* rc-cec cec.toml
* rc-other other.toml
EOF
run_fixture stock
grep -q '^# Stock mappings$' "${TEST_DIR}/stock.once.cfg"
grep -q '^\* rc-other other.toml$' "${TEST_DIR}/stock.once.cfg"
if grep -q '^\* rc-cec cec.toml$' "${TEST_DIR}/stock.once.cfg"; then
  echo "stock rc-cec mapping survived the rewrite" >&2
  exit 1
fi

cat > "${TEST_DIR}/duplicated.cfg" <<'EOF'
* rc-cec cec.toml
* rc-cec parallax_cec.toml
vc4 rc-cec vendor-cec.toml
driver rc-unrelated unrelated.toml
EOF
run_fixture duplicated
grep -q '^driver rc-unrelated unrelated.toml$' "${TEST_DIR}/duplicated.once.cfg"

cat > "${TEST_DIR}/commented.cfg" <<'EOF'
# * rc-cec cec.toml

* rc-unrelated unrelated.toml
EOF
run_fixture commented
grep -q '^# \* rc-cec cec.toml$' "${TEST_DIR}/commented.once.cfg"

cat > "${TEST_DIR}/correct.cfg" <<'EOF'
# Keep this unrelated comment.
* rc-unrelated unrelated.toml

# Parallax OS: TV-remote passthrough for the kiosk (see parallax_cec.toml).
* rc-cec parallax_cec.toml
EOF
run_fixture correct
grep -q '^# Keep this unrelated comment\.$' "${TEST_DIR}/correct.once.cfg"

for cec_power_code in 0x40 0x6b 0x6c 0x6d; do
  grep -Eq "^${cec_power_code}[[:space:]]*=[[:space:]]*\"KEY_RESERVED\"" "${CEC_KEYMAP}"
done
if grep -Eq '"KEY_(POWER|SLEEP|WAKEUP)"' "${CEC_KEYMAP}"; then
  echo "CEC keymap exposes a power-family Linux input key" >&2
  exit 1
fi

echo "CEC keymap rewrite fixtures passed"
