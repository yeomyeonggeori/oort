#!/usr/bin/env bash
# Isolated proofs for the #1332 GHCR notice bundle.
#
# Green alone is not evidence: every RED case below names the mutation.
# No network. Docker is not required here (Dockerfile COPY is a static grep;
# dpkg scans live in check_debian_copyrights.sh / image RUN).
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-ghcr-notice-test.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

CASES=0
fail() { echo "[ghcr-notice-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[ghcr-notice-test] ok: $*"; }

GENERATOR="$REPO_ROOT/scripts/generate_ghcr_notice_bundle.py"
DEBIAN="$REPO_ROOT/scripts/check_debian_copyrights.sh"
[ -x "$DEBIAN" ] || chmod +x "$DEBIAN"
[ -x "$REPO_ROOT/scripts/check_ghcr_notice_bundle.sh" ] || chmod +x "$REPO_ROOT/scripts/check_ghcr_notice_bundle.sh"
chmod +x "$GENERATOR" || true

write_fixture_repo() {
  local root="$1"
  mkdir -p \
    "$root/server-rust" \
    "$root/clients/web/node_modules/fixture-pkg" \
    "$root/legal/generated/spdx-texts" \
    "$root/legal" \
    "$root/infra/rust/postgres-pgbackrest" \
    "$root/crates/fixture-crate"
  printf 'Apache-2.0 project license\n' >"$root/LICENSE"
  printf 'project NOTICE\n' >"$root/NOTICE"
  printf '# index\n' >"$root/legal/THIRD_PARTY_NOTICES.md"
  cp "$REPO_ROOT/legal/generated/spdx-texts/"*.txt "$root/legal/generated/spdx-texts/"
  cat >"$root/legal/generated/license-file-clarify.json" <<'EOF'
{ "comment": "fixture", "cargo": {}, "npm": {} }
EOF
  cat >"$root/server-rust/Cargo.toml" <<'EOF'
[workspace]
members = []
EOF
  # Lockfile bytes only need a stable hash; cargo metadata is injected.
  printf 'version = 3\n' >"$root/server-rust/Cargo.lock"
  mkdir -p "$root/crates/fixture-crate"
  cat >"$root/crates/fixture-crate/LICENSE-MIT" <<'EOF'
Copyright (c) 2024 Fixture Authors
Permission is hereby granted, free of charge.
EOF
  cat >"$root/clients/web/node_modules/fixture-pkg/LICENSE" <<'EOF'
Copyright (c) 2024 Fixture npm
MIT license text
EOF
  cat >"$root/clients/web/package-lock.json" <<'EOF'
{
  "name": "fixture-web",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "fixture-web", "version": "0.0.0" },
    "node_modules/fixture-pkg": { "version": "1.0.0", "license": "MIT" }
  }
}
EOF
  python3 - "$root" <<'PY'
import json, sys
root = sys.argv[1]
manifest = root + "/crates/fixture-crate/Cargo.toml"
metadata = {
  "workspace_members": [],
  "packages": [
    {
      "id": "fixture-crate 1.0.0",
      "name": "fixture-crate",
      "version": "1.0.0",
      "license": "MIT",
      "license_file": None,
      "authors": ["Fixture Authors"],
      "repository": "https://example.invalid/fixture-crate",
      "source": "registry+https://github.com/rust-lang/crates.io-index",
      "manifest_path": manifest,
    }
  ],
}
open(root + "/cargo-metadata.json", "w", encoding="utf-8").write(json.dumps(metadata))
PY
  cat >"$root/server-rust/Dockerfile" <<'EOF'
FROM debian:bookworm-slim
COPY LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md legal/generated/GHCR_THIRD_PARTY_NOTICES.txt /usr/share/licenses/momo-rust/
COPY legal/generated/GHCR_NOTICE_BUNDLE.sha256 /usr/share/licenses/momo-rust/
COPY --chown=momo:momo LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md legal/generated/GHCR_THIRD_PARTY_NOTICES.txt /opt/momo/web/legal/
RUN cd /usr/share/licenses/momo-rust && sha256sum -c GHCR_NOTICE_BUNDLE.sha256
COPY scripts/check_debian_copyrights.sh /usr/local/bin/check_debian_copyrights.sh
RUN test -s /usr/share/licenses/momo-rust/LICENSE; \
    test -s /usr/share/licenses/momo-rust/NOTICE; \
    test -s /usr/share/licenses/momo-rust/THIRD_PARTY_NOTICES.md; \
    test -s /usr/share/licenses/momo-rust/GHCR_THIRD_PARTY_NOTICES.txt; \
    test -s /opt/momo/web/legal/GHCR_THIRD_PARTY_NOTICES.txt
EOF
  cat >"$root/infra/rust/postgres-pgbackrest/Dockerfile" <<'EOF'
FROM debian:trixie
COPY LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md legal/generated/GHCR_THIRD_PARTY_NOTICES.txt /usr/share/licenses/oort-postgres/
COPY legal/generated/GHCR_NOTICE_BUNDLE.sha256 /usr/share/licenses/oort-postgres/
RUN cd /usr/share/licenses/oort-postgres && sha256sum -c GHCR_NOTICE_BUNDLE.sha256
COPY scripts/check_debian_copyrights.sh /usr/local/bin/check_debian_copyrights.sh
RUN test -s /usr/share/licenses/oort-postgres/LICENSE; \
    test -s /usr/share/licenses/oort-postgres/NOTICE; \
    test -s /usr/share/licenses/oort-postgres/THIRD_PARTY_NOTICES.md; \
    test -s /usr/share/licenses/oort-postgres/GHCR_THIRD_PARTY_NOTICES.txt
EOF
}

rewrite_metadata_paths() {
  local root="$1"
  python3 - "$root" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
path = root / "cargo-metadata.json"
data = json.loads(path.read_text(encoding="utf-8"))
for pkg in data.get("packages") or []:
    pkg["manifest_path"] = str(root / "crates/fixture-crate/Cargo.toml")
path.write_text(json.dumps(data), encoding="utf-8")
PY
}

generate_fixture() {
  local root="$1"
  rewrite_metadata_paths "$root"
  python3 "$GENERATOR" generate \
    --repo-root "$root" \
    --cargo-metadata "$root/cargo-metadata.json" \
    --web-root "$root/clients/web"
}

check_fixture() {
  local root="$1"
  python3 "$GENERATOR" check \
    --repo-root "$root" \
    --cargo-metadata "$root/cargo-metadata.json" \
    --web-root "$root/clients/web" \
    --require-regenerate
}

# -----------------------------------------------------------------------------
# Byte-identical: two generates, cmp -s
# -----------------------------------------------------------------------------
FIX_A="$SANDBOX/ident-a"
FIX_B="$SANDBOX/ident-b"
write_fixture_repo "$FIX_A"
cp -a "$FIX_A" "$FIX_B"
generate_fixture "$FIX_A"
generate_fixture "$FIX_B"
cmp -s \
  "$FIX_A/legal/generated/GHCR_THIRD_PARTY_NOTICES.txt" \
  "$FIX_B/legal/generated/GHCR_THIRD_PARTY_NOTICES.txt" \
  || fail "two generates from identical inputs were not byte-identical (bundle)"
cmp -s \
  "$FIX_A/legal/generated/GHCR_NOTICE_MANIFEST.json" \
  "$FIX_B/legal/generated/GHCR_NOTICE_MANIFEST.json" \
  || fail "two generates from identical inputs were not byte-identical (manifest)"
cmp -s \
  "$FIX_A/legal/generated/GHCR_NOTICE_BUNDLE.sha256" \
  "$FIX_B/legal/generated/GHCR_NOTICE_BUNDLE.sha256" \
  || fail "two generates from identical inputs were not byte-identical (sha256sum)"
DIFF_LOG="$SANDBOX/byte-identical.diff"
if diff -u \
  "$FIX_A/legal/generated/GHCR_THIRD_PARTY_NOTICES.txt" \
  "$FIX_B/legal/generated/GHCR_THIRD_PARTY_NOTICES.txt" >"$DIFF_LOG"; then
  :
else
  fail "diff -u on identical generates was non-empty"
fi
[ ! -s "$DIFF_LOG" ] || fail "byte-identical diff file was not empty"
echo "[ghcr-notice-test] byte-identical diff (empty expected):"
cat "$DIFF_LOG"
pass "identical inputs generate byte-identical bundle/manifest/sha256 twice"

check_fixture "$FIX_A" >/dev/null || fail "fixture check was red on a fresh generate"
pass "fixture check is green after generate"

# -----------------------------------------------------------------------------
# Mutation 1 — dependency/version change → stale RED
# -----------------------------------------------------------------------------
FIX_VER="$SANDBOX/mut-version"
cp -a "$FIX_A" "$FIX_VER"
python3 - "$FIX_VER" <<'PY'
import json, sys
root = sys.argv[1]
lock = json.loads(open(root + "/clients/web/package-lock.json", encoding="utf-8").read())
lock["packages"]["node_modules/fixture-pkg"]["version"] = "1.0.1"
open(root + "/clients/web/package-lock.json", "w", encoding="utf-8").write(json.dumps(lock, indent=2) + "\n")
PY
set +e
VER_OUT="$(python3 "$GENERATOR" check --repo-root "$FIX_VER" --cargo-metadata "$FIX_VER/cargo-metadata.json" --web-root "$FIX_VER/clients/web" --stale-only 2>&1)"
VER_STATUS=$?
set -e
[ "$VER_STATUS" -ne 0 ] || fail "version change left the stale check green"
case "$VER_OUT" in
  *stale*) ;;
  *) fail "version-change red output did not say stale: $VER_OUT" ;;
esac
echo "[ghcr-notice-test] mutation version RED log:"
printf '%s\n' "$VER_OUT"
pass "dependency/version change turns stale bundle RED"

# -----------------------------------------------------------------------------
# Mutation 2 — license file deleted → generate RED
# -----------------------------------------------------------------------------
FIX_DEL="$SANDBOX/mut-delete"
cp -a "$FIX_A" "$FIX_DEL"
rewrite_metadata_paths "$FIX_DEL"
rm -f "$FIX_DEL/crates/fixture-crate/LICENSE-MIT"
set +e
DEL_OUT="$(python3 "$GENERATOR" generate --repo-root "$FIX_DEL" --cargo-metadata "$FIX_DEL/cargo-metadata.json" --web-root "$FIX_DEL/clients/web" 2>&1)"
DEL_STATUS=$?
set -e
[ "$DEL_STATUS" -ne 0 ] || fail "deleting LICENSE-MIT still generated a bundle"
case "$DEL_OUT" in
  *LICENSE*|*license-file-clarify*) ;;
  *) fail "license-delete red output did not name the missing file: $DEL_OUT" ;;
esac
echo "[ghcr-notice-test] mutation license-delete RED log:"
printf '%s\n' "$DEL_OUT"
pass "deleting a crate LICENSE file turns generate RED"

# Committed bundle hash tamper (NOTICE/license deletion from the artifact)
FIX_TAMPER="$SANDBOX/mut-tamper"
cp -a "$FIX_A" "$FIX_TAMPER"
printf 'tampered\n' >"$FIX_TAMPER/legal/generated/GHCR_THIRD_PARTY_NOTICES.txt"
set +e
TAMPER_OUT="$(python3 "$GENERATOR" check --repo-root "$FIX_TAMPER" --cargo-metadata "$FIX_TAMPER/cargo-metadata.json" --web-root "$FIX_TAMPER/clients/web" --stale-only 2>&1)"
TAMPER_STATUS=$?
set -e
[ "$TAMPER_STATUS" -ne 0 ] || fail "tampered bundle stayed green"
echo "[ghcr-notice-test] mutation bundle-tamper RED log:"
printf '%s\n' "$TAMPER_OUT"
pass "deleting/replacing committed bundle bytes turns check RED"

# -----------------------------------------------------------------------------
# Mutation 3 — Docker COPY removed → RED
# -----------------------------------------------------------------------------
FIX_DOCKER="$SANDBOX/mut-docker"
cp -a "$FIX_A" "$FIX_DOCKER"
grep -v 'COPY LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md legal/generated/GHCR_THIRD_PARTY_NOTICES.txt /usr/share/licenses/momo-rust/' \
  "$FIX_DOCKER/server-rust/Dockerfile" >"$FIX_DOCKER/server-rust/Dockerfile.mut"
mv "$FIX_DOCKER/server-rust/Dockerfile.mut" "$FIX_DOCKER/server-rust/Dockerfile"
set +e
DOCKER_OUT="$(python3 "$GENERATOR" check --repo-root "$FIX_DOCKER" --cargo-metadata "$FIX_DOCKER/cargo-metadata.json" --web-root "$FIX_DOCKER/clients/web" --stale-only 2>&1)"
DOCKER_STATUS=$?
set -e
[ "$DOCKER_STATUS" -ne 0 ] || fail "removing Docker COPY of the four notices stayed green"
case "$DOCKER_OUT" in
  *"missing required fragment"*|*"COPY LICENSE NOTICE"*) ;;
  *) fail "docker COPY red output did not name the fragment: $DOCKER_OUT" ;;
esac
echo "[ghcr-notice-test] mutation docker-copy RED log:"
printf '%s\n' "$DOCKER_OUT"
pass "removing Docker COPY of the notice bundle turns check RED"

# -----------------------------------------------------------------------------
# Mutation — per-Dockerfile dockerignore excludes COPY sources → RED
# -----------------------------------------------------------------------------
FIX_IGN="$SANDBOX/mut-ignore"
cp -a "$FIX_A" "$FIX_IGN"
cat >"$FIX_IGN/server-rust/Dockerfile.dockerignore" <<'EOF'
legal
scripts
EOF
set +e
IGN_OUT="$(python3 "$GENERATOR" check --repo-root "$FIX_IGN" --cargo-metadata "$FIX_IGN/cargo-metadata.json" --web-root "$FIX_IGN/clients/web" --stale-only 2>&1)"
IGN_STATUS=$?
set -e
[ "$IGN_STATUS" -ne 0 ] || fail "dockerignore that excludes legal/ still passed COPY-path check"
case "$IGN_OUT" in
  *"excluded by"*|*"legal/"*) ;;
  *) fail "dockerignore RED output did not name the excluded COPY path: $IGN_OUT" ;;
esac
echo "[ghcr-notice-test] mutation dockerignore RED log:"
printf '%s\n' "$IGN_OUT"
pass "per-Dockerfile dockerignore excluding legal/ turns check RED"

FIX_IGN_OK="$SANDBOX/mut-ignore-ok"
cp -a "$FIX_A" "$FIX_IGN_OK"
cat >"$FIX_IGN_OK/server-rust/Dockerfile.dockerignore" <<'EOF'
legal/privacy-policy.md
legal/agent-disclosure.md
scripts/**
!scripts/check_debian_copyrights.sh
EOF
python3 "$GENERATOR" check \
  --repo-root "$FIX_IGN_OK" \
  --cargo-metadata "$FIX_IGN_OK/cargo-metadata.json" \
  --web-root "$FIX_IGN_OK/clients/web" \
  --stale-only >/dev/null \
  || fail "dockerignore with notice-file un-ignores stayed red"
pass "dockerignore un-ignore of notice COPY paths is green"

# -----------------------------------------------------------------------------
# Mutation 4 — GPL classified as permissive → RED
# -----------------------------------------------------------------------------
GPL_CLASS="$(python3 "$GENERATOR" classify-debian "GPL-2+")"
[ "$GPL_CLASS" = "copyleft" ] || fail "classify-debian GPL-2+ was '$GPL_CLASS', not copyleft"
LGPL_CLASS="$(python3 "$GENERATOR" classify-debian "LGPL-2.1")"
[ "$LGPL_CLASS" = "copyleft" ] || fail "classify-debian LGPL-2.1 was '$LGPL_CLASS', not copyleft"
MIT_CLASS="$(python3 "$GENERATOR" classify-debian "MIT")"
[ "$MIT_CLASS" = "permissive" ] || fail "classify-debian MIT was '$MIT_CLASS', not permissive"
SH_GPL="$("$DEBIAN" --classify "GPL-2+")"
[ "$SH_GPL" = "copyleft" ] || fail "sh classify GPL-2+ was '$SH_GPL', not copyleft"
SH_LGPL="$("$DEBIAN" --classify "LGPL-2.1")"
[ "$SH_LGPL" = "copyleft" ] || fail "sh classify LGPL-2.1 was '$SH_LGPL', not copyleft"
pass "GPL/LGPL classify as copyleft, MIT as permissive"

BAD_INV="$SANDBOX/bad-debian-inventory.txt"
printf '%s\n' '# debian-copyright-inventory/v1' >"$BAD_INV"
printf '%s\t%s\t%s\t%s\t%s\n' \
  "libc6" "2.36-9+deb12u10" "GPL-2" "permissive" "/usr/share/doc/libc6/copyright" \
  >>"$BAD_INV"
set +e
GPL_OUT="$("$DEBIAN" --verify-inventory "$BAD_INV" 2>&1)"
GPL_STATUS=$?
set -e
[ "$GPL_STATUS" -ne 0 ] || fail "GPL-as-permissive inventory stayed green"
case "$GPL_OUT" in
  *permissive*copyleft*|*copyleft*) ;;
  *) fail "GPL misclassification red output was opaque: $GPL_OUT" ;;
esac
echo "[ghcr-notice-test] mutation GPL-as-permissive RED log:"
printf '%s\n' "$GPL_OUT"
pass "Debian inventory that labels GPL as permissive turns RED"

GOOD_INV="$SANDBOX/good-debian-inventory.txt"
printf '%s\n' '# debian-copyright-inventory/v1' >"$GOOD_INV"
printf '%s\t%s\t%s\t%s\t%s\n' \
  "libc6" "2.36-9+deb12u10" "GPL-2" "copyleft" "/usr/share/doc/libc6/copyright" \
  >>"$GOOD_INV"
"$DEBIAN" --verify-inventory "$GOOD_INV" >/dev/null \
  || fail "honest GPL copyleft inventory was rejected"
pass "honest GPL-as-copyleft inventory is accepted"

# -----------------------------------------------------------------------------
# Fail-closed: empty SPDX
# -----------------------------------------------------------------------------
FIX_SPDX="$SANDBOX/mut-spdx"
cp -a "$FIX_A" "$FIX_SPDX"
rewrite_metadata_paths "$FIX_SPDX"
python3 - "$FIX_SPDX" <<'PY'
import json, sys
root = sys.argv[1]
lock = json.loads(open(root + "/clients/web/package-lock.json", encoding="utf-8").read())
del lock["packages"]["node_modules/fixture-pkg"]["license"]
open(root + "/clients/web/package-lock.json", "w", encoding="utf-8").write(json.dumps(lock, indent=2) + "\n")
PY
set +e
SPDX_OUT="$(python3 "$GENERATOR" generate --repo-root "$FIX_SPDX" --cargo-metadata "$FIX_SPDX/cargo-metadata.json" --web-root "$FIX_SPDX/clients/web" 2>&1)"
SPDX_STATUS=$?
set -e
[ "$SPDX_STATUS" -ne 0 ] || fail "empty SPDX still generated"
echo "[ghcr-notice-test] empty SPDX RED log:"
printf '%s\n' "$SPDX_OUT"
pass "empty SPDX is fail-closed"

echo "[ghcr-notice-test] PASS $CASES cases"
