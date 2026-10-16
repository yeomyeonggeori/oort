#!/usr/bin/env bash
# Stale-bundle + Dockerfile COPY gate for the GHCR notice files (#1332).
#
# Role boundary vs #1225:
#   scripts/check_cargo_licenses.sh / scripts/check_npm_licenses.mjs
#     = allow/deny POLICY over cargo + npm graphs
#   this script
#     = ATTRIBUTION artifact freshness (lockfile hashes, committed bundle
#       bytes, Docker COPY of LICENSE/NOTICE/index/generated bundle, hash file)
#
# #3876: this is also the carrier of scripts/check_dockerfile_crates.sh, which
# keeps server-rust/Dockerfile's dependency-cache COPY list in step with the
# Cargo workspace (a crate the list forgot broke the v0.1.27 image build while
# cargo and PR CI stayed green). It rides here because this script is already
# run on EVERY PR by pr-ci's `alignment` job (`--stale-only`) and by
# `local_gate.sh --profile license|all`, and is not a protected policy path —
# so the guard runs wherever the Dockerfile COPY gate for the notices runs,
# without a policy-path edit. Both checks always run and both report; the
# exit status is the notice check's when it fails, else the crate guard's.
#
# The guard judges THIS repository's tree. When the notice check is aimed at a
# fixture tree (`--repo-root` / `--app-dockerfile`, the options
# scripts/tests/test_ghcr_notice_bundle.sh hands the generator), that tree has
# no server-rust workspace to compare, so the guard is skipped and says so;
# scripts/tests/test_dockerfile_crates_gate.sh proves that skip and the wiring.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

rc=0
case " $* " in
  *" --repo-root"*|*" --app-dockerfile"*)
    echo "[dockerfile-crates] skipped: the notice check is aimed at another tree (--repo-root/--app-dockerfile)" >&2
    ;;
  *)
    bash "$SCRIPT_DIR/check_dockerfile_crates.sh" --root "$REPO_ROOT" || rc=$?
    ;;
esac

python3 "$SCRIPT_DIR/generate_ghcr_notice_bundle.py" check "$@" || rc=$?
exit "$rc"
