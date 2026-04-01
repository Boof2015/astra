#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "Usage: $0 <release-tag> <aur-version> <appimage-url> <sha256>" >&2
  exit 1
fi

release_tag="$1"
aur_version="$2"
appimage_url="$3"
sha256="$4"

pkg_version="${release_tag#v}"
expected_aur_version="${pkg_version//-/.}"

if [ "${aur_version}" != "${expected_aur_version}" ]; then
  echo "Normalized AUR version '${aur_version}' does not match release tag '${release_tag}'." >&2
  exit 1
fi

if ! printf '%s' "${sha256}" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "SHA256 must be a lowercase 64-character hex string." >&2
  exit 1
fi

escape_sed_replacement() {
  local _value="$1"
  _value="${_value//\\/\\\\}"
  _value="${_value//&/\\&}"
  _value="${_value//|/\\|}"
  printf '%s' "${_value}"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
pkgbuild_path="${repo_root}/.github/aur/PKGBUILD"
tmp_file="$(mktemp)"

trap 'rm -f "${tmp_file}"' EXIT

escaped_url="$(escape_sed_replacement "${appimage_url}")"
escaped_sha="$(escape_sed_replacement "${sha256}")"

sed \
  -e "s/^pkgver=.*/pkgver=${aur_version}/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s|^source=.*|source=(\"astra-${aur_version}.AppImage::${escaped_url}\")|" \
  -e "s/^sha256sums=.*/sha256sums=('${escaped_sha}')/" \
  "${pkgbuild_path}" > "${tmp_file}"

mv "${tmp_file}" "${pkgbuild_path}"
chmod 644 "${pkgbuild_path}"
