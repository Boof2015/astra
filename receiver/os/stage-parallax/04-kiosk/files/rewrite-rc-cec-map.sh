#!/bin/bash
set -euo pipefail

# ir-keytable merges every matching rc_maps.cfg row; it does not stop at the first or last
# match. Emit a canonical configuration with every active rc-cec row removed and exactly one
# Parallax mapping appended. Comments and mappings for other RC devices are preserved.

RC_MAPS_FILE="${1:?usage: rewrite-rc-cec-map.sh <rc_maps.cfg>}"

awk '
  function flush_blanks() {
    while (pending_blanks > 0) {
      print ""
      pending_blanks--
    }
  }

  /^[[:space:]]*$/ {
    pending_blanks++
    next
  }

  /^[[:space:]]*# Parallax OS: TV-remote passthrough for the kiosk \(see parallax_cec\.toml\)\.[[:space:]]*$/ {
    next
  }

  {
    candidate = $0
    sub(/^[[:space:]]*/, "", candidate)
    if (candidate !~ /^#/) {
      field_count = split(candidate, fields, /[[:space:]]+/)
      if (field_count >= 2 && fields[2] == "rc-cec")
        next
    }

    flush_blanks()
    print
    emitted = 1
  }

  END {
    if (emitted)
      print ""
    print "# Parallax OS: TV-remote passthrough for the kiosk (see parallax_cec.toml)."
    print "* rc-cec parallax_cec.toml"
  }
' "${RC_MAPS_FILE}"
