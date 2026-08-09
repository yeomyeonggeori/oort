#!/usr/bin/env bash
# SwiftPM transitive-license gate and THIRD_PARTY notice generator (MOMO-556).
# Bash 3.2 compatible. Package.resolved files remain untracked by repository policy;
# a fresh checkout is resolved before its checkout LICENSE files are inspected.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/check_spm_licenses.sh --check|--write

  --check  Fail when legal/THIRD_PARTY_NOTICES.md differs from the resolved graph.
  --write  Regenerate the SwiftPM section of legal/THIRD_PARTY_NOTICES.md.

Environment (fixture/test use only):
  SPM_LICENSE_REPO_ROOT       Repository root override.
  SPM_LICENSE_EXPECTED_ROOTS  Expected remote SwiftPM package-root count (default: 10).
  SPM_LICENSE_SKIP_RESOLVE=1  Require existing Package.resolved/checkouts.
EOF
}

MODE="${1:-}"
case "$MODE" in
  --check|--write) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

if [ -n "${SPM_LICENSE_REPO_ROOT:-}" ]; then
  REPO_ROOT="$SPM_LICENSE_REPO_ROOT"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "SPM LICENSE FAIL: run inside a git repository" >&2
    exit 1
  }
fi
cd "$REPO_ROOT"

EXPECTED_ROOTS="${SPM_LICENSE_EXPECTED_ROOTS:-10}"
EXCEPTIONS_FILE="${SPM_LICENSE_EXCEPTIONS_FILE:-scripts/spm_license_exceptions.tsv}"
NOTICES_FILE="${SPM_LICENSE_NOTICES_FILE:-legal/THIRD_PARTY_NOTICES.md}"
BEGIN_MARKER="<!-- BEGIN GENERATED: SPM LICENSES (scripts/check_spm_licenses.sh) -->"
END_MARKER="<!-- END GENERATED: SPM LICENSES -->"

command -v jq >/dev/null 2>&1 || {
  echo "SPM LICENSE FAIL: jq is required" >&2
  exit 1
}
[ -f "$EXCEPTIONS_FILE" ] || {
  echo "SPM LICENSE FAIL: missing exception policy: $EXCEPTIONS_FILE" >&2
  exit 1
}

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-spm-licenses.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM
ROOTS_FILE="$TMP_ROOT/package-roots.txt"
PINS_FILE="$TMP_ROOT/pins.tsv"
ROWS_FILE="$TMP_ROOT/rows.tsv"
SECTION_FILE="$TMP_ROOT/section.md"
GENERATED_FILE="$TMP_ROOT/THIRD_PARTY_NOTICES.md"

find . -name Package.swift -not -path '*/.build/*' -not -path '*/.swiftpm/*' -print |
  while IFS= read -r manifest; do
    if grep -Eq '\.package[[:space:]]*\([^)]*url[[:space:]]*:' "$manifest"; then
      dirname "$manifest"
    fi
  done | LC_ALL=C sort -u > "$ROOTS_FILE"

ROOT_COUNT="$(wc -l < "$ROOTS_FILE" | tr -d ' ')"
if [ "$ROOT_COUNT" != "$EXPECTED_ROOTS" ]; then
  echo "SPM LICENSE FAIL: expected $EXPECTED_ROOTS remote SwiftPM roots, found $ROOT_COUNT" >&2
  sed 's/^/  - /' "$ROOTS_FILE" >&2
  exit 1
fi

resolve_root() {
  root="$1"
  if [ "${SPM_LICENSE_SKIP_RESOLVE:-0}" = "1" ]; then
    [ -f "$root/Package.resolved" ] && [ -d "$root/.build/checkouts" ] || {
      echo "SPM LICENSE FAIL: fixture root lacks Package.resolved/checkouts: $root" >&2
      return 1
    }
    return 0
  fi
  # Always ask SwiftPM to reconcile Package.swift with Package.resolved. With a
  # valid lock/checkouts this is local and fast; after a manifest edit it avoids
  # auditing a stale ignored lockfile.
  echo "==> swift package resolve ($root)"
  (cd "$root" && swift package --disable-sandbox resolve)
}

while IFS= read -r root; do
  resolve_root "$root"
  jq -e '.pins | type == "array"' "$root/Package.resolved" >/dev/null || {
    echo "SPM LICENSE FAIL: invalid Package.resolved: $root/Package.resolved" >&2
    exit 1
  }
  jq -r --arg root "$root" '.pins[] | [
      $root,
      (.identity | ascii_downcase),
      (.location // ""),
      (.state.version // .state.revision // "UNKNOWN")
    ] | @tsv' "$root/Package.resolved" >> "$PINS_FILE"
done < "$ROOTS_FILE"

copyleft_name() {
  grep -Eil 'GNU (AFFERO |LESSER )?GENERAL PUBLIC LICENSE|Mozilla Public License|Server Side Public License|Business Source License|Elastic License|(^|[^A-Z])(A?GPL|LGPL|MPL|EPL|CDDL|SSPL|EUPL|OSL|CPAL|BUSL)([- .]|$)|CC-BY-(SA|NC)' "$@" >/dev/null 2>&1
}

classify_license() {
  apache=0 mit=0 isc=0 bsd2=0 bsd3=0
  grep -Eiq 'Apache License([[:space:]]*,)? Version 2\.0|Apache License[[:space:]]+Version 2\.0' "$@" && apache=1
  grep -Eiq 'Permission is hereby granted, free of charge' "$@" && mit=1
  grep -Eiq 'Permission to use, copy, modify, and/or distribute this software' "$@" && isc=1
  if grep -Eiq 'Redistribution and use in source and binary forms, with or without modification, are permitted' "$@"; then
    if grep -Eiq 'Neither the name of .* nor the names of its contributors' "$@"; then
      bsd3=1
    else
      bsd2=1
    fi
  fi

  expression=""
  for candidate in Apache-2.0 MIT ISC BSD-2-Clause BSD-3-Clause; do
    case "$candidate" in
      Apache-2.0) present="$apache" ;;
      MIT) present="$mit" ;;
      ISC) present="$isc" ;;
      BSD-2-Clause) present="$bsd2" ;;
      BSD-3-Clause) present="$bsd3" ;;
    esac
    if [ "$present" = "1" ]; then
      if [ -n "$expression" ]; then expression="$expression OR $candidate"; else expression="$candidate"; fi
    fi
  done
  printf '%s\n' "$expression"
}

spdx_atom_allowed() {
  case "$1" in
    MIT|MIT-0|Apache-2.0|ISC|BSD-2-Clause|BSD-3-Clause|0BSD) return 0 ;;
    *) return 1 ;;
  esac
}

# Match scripts/check_npm_licenses.mjs: OR passes if any branch is
# allowed; AND requires every branch. Parentheses around the whole expression
# are accepted, while copyleft tokens always fail before expression evaluation.
spdx_expression_allowed() {
  expression="$1"
  expression="${expression#(}"
  expression="${expression%)}"
  case "$expression" in
    *' OR '*)
      old_ifs="$IFS"; IFS='|'
      branches="$(printf '%s' "$expression" | sed 's/ OR /|/g')"
      for branch in $branches; do
        atom="$(printf '%s' "$branch" | sed 's/^ *//;s/ *$//')"
        if spdx_atom_allowed "$atom"; then IFS="$old_ifs"; return 0; fi
      done
      IFS="$old_ifs"; return 1 ;;
    *' AND '*)
      old_ifs="$IFS"; IFS='|'
      branches="$(printf '%s' "$expression" | sed 's/ AND /|/g')"
      for branch in $branches; do
        atom="$(printf '%s' "$branch" | sed 's/^ *//;s/ *$//')"
        if ! spdx_atom_allowed "$atom"; then IFS="$old_ifs"; return 1; fi
      done
      IFS="$old_ifs"; return 0 ;;
    *) spdx_atom_allowed "$(printf '%s' "$expression" | sed 's/^ *//;s/ *$//')" ;;
  esac
}

exception_for() {
  identity="$1"
  awk -F '\t' -v identity="$identity" '
    $0 !~ /^#/ && tolower($1) == identity {
      if ($2 == "" || $3 == "") exit 2
      print $2 "\t" $3
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$EXCEPTIONS_FILE"
}

: > "$ROWS_FILE"
while IFS="$(printf '\t')" read -r root identity location version; do
  checkout=""
  while IFS= read -r candidate; do
    candidate_name="$(basename "$candidate" | tr '[:upper:]' '[:lower:]')"
    if [ "$candidate_name" = "$identity" ]; then checkout="$candidate"; break; fi
  done <<EOF
$(find "$root/.build/checkouts" -mindepth 1 -maxdepth 1 -type d -print | LC_ALL=C sort)
EOF
  [ -n "$checkout" ] || {
    echo "SPM LICENSE FAIL: checkout missing for $identity in $root" >&2
    exit 1
  }

  license_files="$(find "$checkout" -maxdepth 1 -type f \( -iname 'LICENSE' -o -iname 'LICENSE.*' -o -iname 'COPYING' -o -iname 'COPYING.*' \) -print | LC_ALL=C sort)"
  [ -n "$license_files" ] || {
    echo "SPM LICENSE FAIL: root LICENSE/COPYING missing for $identity ($checkout)" >&2
    exit 1
  }

  # Intentional word splitting: each path is one line and Swift checkouts must
  # not use newlines/spaces in root LICENSE filenames.
  # shellcheck disable=SC2086
  if copyleft_name $license_files; then
    echo "SPM LICENSE FAIL: copyleft license detected for $identity ($checkout)" >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  license="$(classify_license $license_files)"
  if [ -z "$license" ]; then
    if exception="$(exception_for "$identity")"; then
      tab="$(printf '\t')"
      license="${exception%%"$tab"*}"
      reason="${exception#*"$tab"}"
      [ -n "$reason" ] || {
        echo "SPM LICENSE FAIL: exception lacks review reason for $identity" >&2
        exit 1
      }
      echo "SPM LICENSE REVIEWED EXCEPTION: $identity = $license ($reason)"
    else
      echo "SPM LICENSE FAIL: unknown or unreviewed license for $identity ($checkout)" >&2
      exit 1
    fi
  fi
  if ! spdx_expression_allowed "$license"; then
    echo "SPM LICENSE FAIL: non-permissive SPDX expression for $identity: $license" >&2
    exit 1
  fi
  printf '%s\t%s\t%s\t%s\n' "$identity" "$version" "$license" "$location" >> "$ROWS_FILE"
done < "$PINS_FILE"

if ! awk -F '\t' '
  {
    signature = $3 FS $4
    if (($1 in seen) && seen[$1] != signature) {
      print "SPM LICENSE FAIL: inconsistent license/source for " $1 > "/dev/stderr"
      failed = 1
    }
    seen[$1] = signature
  }
  END { exit failed ? 1 : 0 }
' "$ROWS_FILE"; then
  exit 1
fi

LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2,2 -u "$ROWS_FILE" |
  awk -F '\t' 'BEGIN { OFS = FS }
    NR == 1 { identity = $1; versions = $2; license = $3; location = $4; next }
    $1 == identity { versions = versions ", " $2; next }
    { print identity, versions, license, location; identity = $1; versions = $2; license = $3; location = $4 }
    END { if (NR > 0) print identity, versions, license, location }
  ' > "$TMP_ROOT/unique-rows.tsv"
mv "$TMP_ROOT/unique-rows.tsv" "$ROWS_FILE"
DEPENDENCY_COUNT="$(wc -l < "$ROWS_FILE" | tr -d ' ')"

{
  printf '%s\n' "$BEGIN_MARKER"
  echo "## Swift Package Manager dependencies"
  echo
  echo "> Generated from $ROOT_COUNT Package.resolved graphs and checkout LICENSE files. Do not edit this section manually."
  echo
  echo "| Package | Version | License | Source |"
  echo "|---|---|---|---|"
  while IFS="$(printf '\t')" read -r identity version license location; do
    safe_location="$(printf '%s' "$location" | sed 's/|/%7C/g')"
    printf '| %s | %s | %s | %s |\n' "$identity" "$version" "$license" "$safe_location"
  done < "$ROWS_FILE"
  printf '%s\n' "$END_MARKER"
} > "$SECTION_FILE"

if [ -f "$NOTICES_FILE" ] && grep -Fq "$BEGIN_MARKER" "$NOTICES_FILE"; then
  awk -v begin="$BEGIN_MARKER" '$0 == begin { exit } { print }' "$NOTICES_FILE" > "$GENERATED_FILE"
  cat "$SECTION_FILE" >> "$GENERATED_FILE"
  awk -v end="$END_MARKER" 'seen { print } $0 == end { seen = 1 }' "$NOTICES_FILE" >> "$GENERATED_FILE"
else
  {
    echo "# Third-party notices"
    echo
    cat "$SECTION_FILE"
    echo
    if [ -f "$NOTICES_FILE" ]; then
      awk '/^## npm([[:space:](]|$)/ { keep = 1 } keep { print }' "$NOTICES_FILE"
    fi
  } > "$GENERATED_FILE"
fi

case "$MODE" in
  --write)
    mkdir -p "$(dirname "$NOTICES_FILE")"
    cp "$GENERATED_FILE" "$NOTICES_FILE"
    echo "SPM LICENSE PASS: wrote $NOTICES_FILE ($DEPENDENCY_COUNT unique dependencies across $ROOT_COUNT roots)"
    ;;
  --check)
    if ! cmp -s "$GENERATED_FILE" "$NOTICES_FILE"; then
      echo "SPM LICENSE FAIL: $NOTICES_FILE drifted; run scripts/check_spm_licenses.sh --write" >&2
      diff -u "$NOTICES_FILE" "$GENERATED_FILE" || true
      exit 1
    fi
    echo "SPM LICENSE PASS: $DEPENDENCY_COUNT unique dependencies across $ROOT_COUNT roots; notices are current"
    ;;
esac
