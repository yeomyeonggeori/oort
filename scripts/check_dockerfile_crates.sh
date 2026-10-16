#!/usr/bin/env bash
# #3876 — server-rust/Dockerfile's dependency-cache COPY list must mirror the
# Cargo workspace exactly: one manifest line per member, and no line for a
# member that no longer exists.
#
# Why a static guard
#   The `build` stage copies every workspace manifest on a line of its own,
#   stubs the sources and compiles the ~200 third-party crates (a cacheable
#   layer) before the real sources arrive. Cargo loads EVERY member manifest up
#   front, so a crate the list forgot is not a cache miss, it is a hard
#   failure — `failed to read /src/server-rust/crates/<c>/Cargo.toml` — and
#   only the IMAGE build hits it: `cargo build`, `cargo test` and PR CI stay
#   green. It has happened twice:
#     #1111  9b437626e  crates/momo-drive was added, the list was not touched
#     #3837  -> #3876   crates/momo-workspace-actions was added; the v0.1.27
#                       publish run 38833028390 failed on amd64 and arm64
#   The mirror image — a COPY line whose crate was deleted — breaks the same
#   build with "not found".
#
# What is checked (static: bash + grep, plus sort/tr — no cargo, no docker)
#   1. server-rust/Cargo.toml `[workspace] members` only names `crates/*` and
#      `bins/*`, and has no `exclude`. Any other shape is a member root this
#      guard (and the Dockerfile's stub loop, which also walks exactly those
#      two roots) has never seen -> exit 2, so it cannot slip past unnoticed.
#   2. Every directory under crates/* and bins/* that holds a Cargo.toml — the
#      same set the Dockerfile's stub loop iterates — has exactly this line:
#          COPY server-rust/<kind>/<name>/Cargo.toml <kind>/<name>/
#      A commented-out line, a `--from=` copy, a wrong destination or a
#      different layout does not count.
#   3. Every `COPY ... server-rust/<kind>/<name>/Cargo.toml` names a manifest
#      that exists (a stale line fails the build exactly like a missing one).
#
# Everything wrong is reported in ONE run, with the line to add or delete, so
# a drifted tree costs one edit instead of one edit per rebuild.
#
# Fail-closed: no workspace members, or not one manifest COPY line parsed from
# the Dockerfile, is never a pass — the Dockerfile was restructured or this
# parser drifted, and the guard has to be updated with it.
#
# Adding a crate or bin: add the one COPY line next to its siblings in the
# dependency-cache block of the `build` stage (the failure message prints it).
#
# Usage: scripts/check_dockerfile_crates.sh [--root DIR] [--dockerfile PATH]
# Exit:  0 in sync · 1 drift (each offender named) · 2 cannot judge
set -euo pipefail
export LC_ALL=C

TAG="[dockerfile-crates]"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE=""

usage() {
  cat <<'EOF'
Usage: scripts/check_dockerfile_crates.sh [--root DIR] [--dockerfile PATH]

  --root DIR         Tree to check (the directory that holds server-rust/).
                     Default: the repository this script lives in.
  --dockerfile PATH  Dockerfile to read. Default: DIR/server-rust/Dockerfile.

Exit 0 = the dependency-cache COPY list mirrors the workspace, 1 = drift (each
offending crate/bin/line is named), 2 = cannot judge (unusable input, or a
workspace shape this guard does not model).
EOF
}

die2() {
  echo "$TAG ERROR: $*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      [ "$#" -ge 2 ] || die2 "--root needs a directory"
      ROOT="$2"
      shift 2
      ;;
    --dockerfile)
      [ "$#" -ge 2 ] || die2 "--dockerfile needs a path"
      DOCKERFILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "$TAG unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ROOT_ARG="$ROOT"
ROOT="$(CDPATH='' cd -- "$ROOT_ARG" 2>/dev/null && pwd)" || die2 "--root is not a directory: $ROOT_ARG"
WS="$ROOT/server-rust"
WS_MANIFEST="$WS/Cargo.toml"
[ -n "$DOCKERFILE" ] || DOCKERFILE="$WS/Dockerfile"
[ -f "$WS_MANIFEST" ] || die2 "missing workspace manifest: $WS_MANIFEST"
[ -f "$DOCKERFILE" ] || die2 "missing Dockerfile: $DOCKERFILE"

rel() { printf '%s' "${1#"$ROOT"/}"; }

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# in_list ITEM LIST — LIST is newline separated. A here-string rather than a
# pipe: `printf | grep -q` under pipefail reports SIGPIPE as a miss.
in_list() { grep -Fxq -- "$1" <<<"$2"; }

count_lines() {
  local n=0 l
  while IFS= read -r l; do
    if [ -n "$l" ]; then n=$((n + 1)); fi
  done <<<"$1"
  printf '%s' "$n"
}

# workspace_array KEY FILE — prints the quoted entries of `KEY = [ ... ]` in the
# [workspace] table, one per line. The array may span lines and carry comments.
# Returns 1 when the key is absent.
workspace_array() {
  local key="$1" file="$2" line body buf="" in_ws=0 in_arr=0 found=0
  local re_key="^${key}[[:space:]]*=[[:space:]]*(.*)\$"
  while IFS= read -r line || [ -n "$line" ]; do
    body="$(trim "${line%%#*}")"
    if [ "$in_arr" -eq 0 ]; then
      case "$body" in
        '[workspace]') in_ws=1; continue ;;
        '['*) in_ws=0; continue ;;
      esac
      [ "$in_ws" -eq 1 ] || continue
      [[ $body =~ $re_key ]] || continue
      buf="${BASH_REMATCH[1]}"
      in_arr=1
      found=1
    else
      buf="$buf $body"
    fi
    case "$buf" in
      *']'*) break ;;
    esac
  done <"$file"
  [ "$found" -eq 1 ] || return 1
  buf="${buf#*[}"
  buf="${buf%%]*}"
  printf '%s\n' "$buf" | grep -oE "\"[^\"]*\"|'[^']*'" | tr -d "\"'" || true
}

# --- 1. what the workspace declares -----------------------------------------
globs="$(workspace_array members "$WS_MANIFEST")" ||
  die2 "$(rel "$WS_MANIFEST") has no [workspace] members array — this guard only models 'members = [\"crates/*\", \"bins/*\"]'"
[ -n "$globs" ] || die2 "$(rel "$WS_MANIFEST") [workspace] members is empty"

if workspace_array exclude "$WS_MANIFEST" >/dev/null; then
  die2 "$(rel "$WS_MANIFEST") [workspace] now has an 'exclude' list; this guard does not model it — extend scripts/check_dockerfile_crates.sh (and check the Dockerfile stub loop) before relying on it"
fi

kinds=""
unknown=""
while IFS= read -r g; do
  [ -n "$g" ] || continue
  case "$g" in
    'crates/*'|'bins/*') kinds="${kinds}${g%/\*}"$'\n' ;;
    *) unknown="${unknown}${g} " ;;
  esac
done <<<"$globs"
if [ -n "$unknown" ]; then
  die2 "$(rel "$WS_MANIFEST") [workspace] members contains ${unknown% }, outside the crates/* and bins/* roots this guard models. The Dockerfile stub loop only walks those two roots as well — extend both scripts/check_dockerfile_crates.sh and server-rust/Dockerfile for the new root"
fi

expected=""
for kind in $kinds; do
  for dir in "$WS/$kind"/*/; do
    [ -f "${dir}Cargo.toml" ] || continue
    name="${dir%/}"
    name="${name##*/}"
    expected="${expected}${kind}/${name}"$'\n'
  done
done
expected="$(printf '%s' "$expected" | sort -u)"
[ -n "$expected" ] || die2 "no workspace member with a Cargo.toml found under $(rel "$WS")/{crates,bins}/ — refusing to pass vacuously"

# --- 2. what the Dockerfile copies ------------------------------------------
present=""
bad_dest=""
stale=""
re_copy='^[[:space:]]*COPY[[:space:]]+server-rust/(crates|bins)/([^/[:space:]]+)/Cargo\.toml[[:space:]]+([^[:space:]]+)[[:space:]]*$'
cands="$(grep -nE '^[[:space:]]*COPY[[:space:]].*server-rust/(crates|bins)/' "$DOCKERFILE" || true)"
while IFS= read -r cand; do
  [ -n "$cand" ] || continue
  lineno="${cand%%:*}"
  text="${cand#*:}"
  if [[ $text =~ $re_copy ]]; then
    kind="${BASH_REMATCH[1]}"
    name="${BASH_REMATCH[2]}"
    dst="${BASH_REMATCH[3]}"
    if [ "$dst" = "$kind/$name/" ]; then
      present="${present}${kind}/${name}"$'\n'
    else
      bad_dest="${bad_dest}${lineno}|${kind}/${name}|${dst}"$'\n'
    fi
  fi
  # Whatever shape the line has, a manifest it names must exist in the context.
  toks="$(printf '%s\n' "$text" | grep -oE 'server-rust/(crates|bins)/[^/[:space:]]+/Cargo\.toml' || true)"
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    if [ ! -f "$ROOT/$tok" ]; then
      stale="${stale}${lineno}|${tok}"$'\n'
    fi
  done <<<"$toks"
done <<<"$cands"

if [ -z "$present$bad_dest" ]; then
  die2 "no 'COPY server-rust/{crates,bins}/<name>/Cargo.toml <kind>/<name>/' line could be parsed from $(rel "$DOCKERFILE") — the dependency-cache block was restructured or this parser drifted; update scripts/check_dockerfile_crates.sh together with the Dockerfile"
fi

missing=""
while IFS= read -r m; do
  [ -n "$m" ] || continue
  if ! in_list "$m" "$present"; then
    missing="${missing}${m}"$'\n'
  fi
done <<<"$expected"

# --- 3. verdict ---------------------------------------------------------------
DF="$(rel "$DOCKERFILE")"
if [ -z "$missing$stale$bad_dest" ]; then
  n_all="$(count_lines "$expected")"
  n_crates="$(count_lines "$(grep '^crates/' <<<"$expected" || true)")"
  n_bins="$(count_lines "$(grep '^bins/' <<<"$expected" || true)")"
  echo "$TAG PASS: all $n_all workspace members ($n_crates crates + $n_bins bins) have their dependency-cache COPY line in $DF, and every COPY line names an existing manifest"
  exit 0
fi

{
  echo "$TAG FAIL: the dependency-cache COPY list in $DF does not mirror the Cargo workspace (#3876)."
  echo "$TAG cargo build/test cannot see this drift; the Docker image build fails on it (the v0.1.27 publish run did)."
  if [ -n "$missing" ]; then
    echo "$TAG"
    echo "$TAG missing — the workspace member has no manifest line (build error: failed to read /src/server-rust/<member>/Cargo.toml):"
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      echo "$TAG   - $m"
      echo "$TAG       add:  COPY server-rust/$m/Cargo.toml $m/"
    done <<<"$missing"
  fi
  if [ -n "$stale" ]; then
    echo "$TAG"
    echo "$TAG stale — the COPY names a manifest that no longer exists (delete the line):"
    while IFS='|' read -r ln tok; do
      [ -n "$ln" ] || continue
      echo "$TAG   - $DF:$ln  $tok"
    done <<<"$stale"
  fi
  if [ -n "$bad_dest" ]; then
    echo "$TAG"
    echo "$TAG wrong destination — the manifest must land in its own directory (<kind>/<name>/, trailing slash):"
    while IFS='|' read -r ln member dst; do
      [ -n "$ln" ] || continue
      echo "$TAG   - $DF:$ln  server-rust/$member/Cargo.toml -> $dst   (expected: $member/)"
    done <<<"$bad_dest"
  fi
  echo "$TAG"
  echo "$TAG Fix: give the dependency-cache block of the 'build' stage in $DF exactly one"
  echo "$TAG      'COPY server-rust/<kind>/<name>/Cargo.toml <kind>/<name>/' line per workspace member."
} >&2
exit 1
