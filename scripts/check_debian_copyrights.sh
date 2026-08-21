#!/bin/sh
# Verify every dpkg package has /usr/share/doc/<pkg>/copyright and write an
# inventory. GPL/LGPL/AGPL are classified copyleft — never permissive.
# Intended to run inside a Debian image as root. Host --classify / --verify-inventory
# paths are for the #1332 mutation proofs.
set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/check_debian_copyrights.sh [--output PATH]
  scripts/check_debian_copyrights.sh --classify 'License-field-text'
  scripts/check_debian_copyrights.sh --verify-inventory PATH
EOF
}

classify_debian_license_fields() {
  fields=$1
  if [ -z "$fields" ]; then
    printf 'unknown\n'
    return 0
  fi
  # Word-ish match so LGPL is not swallowed by a naive GPL substring, and GPL
  # is still detected. Never return permissive when copyleft tokens are present.
  if printf '%s\n' "$fields" | grep -qiE '(^|[^A-Za-z])(AGPL|LGPL|GPL)($|[^A-Za-z])'; then
    printf 'copyleft\n'
    return 0
  fi
  if printf '%s\n' "$fields" | grep -qiE 'MIT|BSD|Apache|ISC|Zlib|PostgreSQL|Artistic|MPL|Unlicense|Boost|BSL|0BSD'; then
    printf 'permissive\n'
    return 0
  fi
  printf 'other\n'
}

verify_inventory() {
  path=$1
  [ -s "$path" ] || {
    echo "DEBIAN COPYRIGHT FAIL: missing inventory $path" >&2
    exit 1
  }
  bad=0
  # skip comments/header
  while IFS="$(printf '\t')" read -r pkg version fields class copyright_path; do
    case "$pkg" in
      ''|\#*) continue ;;
    esac
    expected=$(classify_debian_license_fields "$fields")
    if [ "$class" = "permissive" ]; then
      case "$expected" in
        copyleft)
          echo "DEBIAN COPYRIGHT FAIL: $pkg classified permissive but license fields are copyleft: $fields" >&2
          bad=1
          ;;
      esac
    fi
    if [ "$expected" = "copyleft" ] && [ "$class" = "permissive" ]; then
      bad=1
    fi
  done <"$path"
  [ "$bad" -eq 0 ] || exit 1
  echo "DEBIAN COPYRIGHT PASS: inventory $path has no GPL/LGPL-as-permissive rows"
}

scan_image() {
  out=$1
  if ! command -v dpkg-query >/dev/null 2>&1; then
    echo "DEBIAN COPYRIGHT FAIL: dpkg-query not found (run inside a Debian image)" >&2
    exit 1
  fi
  tmp="${out}.tmp"
  pkgs="${out}.pkgs"
  {
    printf '%s\n' '# debian-copyright-inventory/v1'
    printf '%s\n' '# columns: package <TAB> version <TAB> license_fields <TAB> class <TAB> copyright_path'
    printf '%s\n' '# class copyleft includes GPL/LGPL/AGPL and is never written as permissive.'
    printf '%s\n' '# this is file-existence evidence, not a legal-sufficiency declaration.'
  } >"$tmp"
  dpkg-query -W -f='${Package}\t${Version}\n' | LC_ALL=C sort >"$pkgs"
  missing=0
  tab=$(printf '\t')
  while IFS="$tab" read -r pkg version; do
    [ -n "$pkg" ] || continue
    copyright="/usr/share/doc/${pkg}/copyright"
    if [ ! -s "$copyright" ]; then
      echo "DEBIAN COPYRIGHT FAIL: missing $copyright" >&2
      missing=1
      continue
    fi
    fields=$(grep -E '^License:' "$copyright" 2>/dev/null | sed 's/^License:[[:space:]]*//' | LC_ALL=C sort -u | tr '\n' '|' | sed 's/|$//')
    [ -n "$fields" ] || fields="(no License: field)"
    class=$(classify_debian_license_fields "$fields")
    printf '%s\t%s\t%s\t%s\t%s\n' "$pkg" "$version" "$fields" "$class" "$copyright" >>"$tmp"
  done <"$pkgs"
  rm -f "$pkgs"
  if [ "$missing" -ne 0 ]; then
    rm -f "$tmp"
    exit 1
  fi
  verify_inventory "$tmp"
  mv "$tmp" "$out"
  echo "DEBIAN COPYRIGHT PASS: wrote $out"
}

OUTPUT=/usr/share/licenses/momo-rust/DEBIAN_COPYRIGHT_INVENTORY.txt
MODE=scan

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      OUTPUT=$2
      shift 2
      ;;
    --classify)
      classify_debian_license_fields "$2"
      exit 0
      ;;
    --verify-inventory)
      verify_inventory "$2"
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

scan_image "$OUTPUT"
