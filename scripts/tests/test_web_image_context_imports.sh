#!/usr/bin/env bash
# #3123: the server image's web stage runs `tsc -b` over all of clients/web/src
# (tests included). Every repo-relative file those sources import from outside
# clients/web and packages/momo-core must be COPY'd into the image, or the
# release build fails with TS2307 (#3037, #3123). This checks each such import
# against the Dockerfile's COPY sources.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
dockerfile=server-rust/Dockerfile
copies=$(awk '/^COPY /{print $2}' "$dockerfile")
while IFS= read -r f; do
  [ -n "$f" ] || continue
  dir=$(dirname "$f")
  { grep -hoE "from ['\"](\.\./)+[^'\"]+['\"]" "$f" || true; } | sed -E "s/^from ['\"]//; s/['\"]$//" | while IFS= read -r rel; do
    target=$(python3 -c 'import os,sys;print(os.path.relpath(os.path.normpath(os.path.join(sys.argv[1],sys.argv[2])),sys.argv[3]))' "$dir" "$rel" "$root")
    case "$target" in clients/web/*|packages/momo-core/*) continue;; esac
    ok=0
    for c in $copies; do
      # shellcheck disable=SC2254
      case "$target" in $c|$c/*) ok=1; break;; esac
    done
    if [ "$ok" = 0 ]; then echo "NOT IN IMAGE: $f imports $target"; echo x >> "${TMPDIR:-/tmp}/wici.$$"; fi
  done
done < <(git ls-files -- 'clients/web/src/*.ts' 'clients/web/src/*.tsx')
if [ -s "${TMPDIR:-/tmp}/wici.$$" ]; then rm -f "${TMPDIR:-/tmp}/wici.$$"; echo "[web-image-imports] FAIL"; exit 1; fi
echo "[web-image-imports] PASS every out-of-tree import is COPY'd into the image"
