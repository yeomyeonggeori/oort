#!/usr/bin/env bash
# No-secret, local-only PostgreSQL 18 pgBackRest PITR rehearsal (#1330).
#
# This launcher builds the exact current Dockerfiles, creates ephemeral
# owner-only secrets outside the repository, and runs the isolated closed loop.
# It never pushes, dispatches, or contacts a production deployment.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)"

fail() {
  printf '[pgbackrest-pitr-e2e] RED %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 0 ] || fail "arguments_forbidden; use PITR_E2E_OUT_DIR for output"
for command in docker git openssl python3; do
  command -v "$command" >/dev/null 2>&1 || fail "missing_command name=$command"
done
docker info >/dev/null 2>&1 || fail "docker_unavailable"

for env_name in $(compgen -e); do
  case "$env_name" in
    PGBACKREST_*|PGBACKREST) fail "ambient_pgbackrest_env_forbidden name=$env_name" ;;
  esac
done

git_commit="$(git -C "$ROOT" rev-parse --verify HEAD)"
[[ "$git_commit" =~ ^[0-9a-f]{40}$ ]] || fail "git_commit_invalid"

if [ -n "${PITR_E2E_OUT_DIR:-}" ]; then
  evidence_dir="$PITR_E2E_OUT_DIR"
  [[ "$evidence_dir" == /* ]] || fail "PITR_E2E_OUT_DIR_not_absolute"
  [[ "$evidence_dir" =~ ^/[A-Za-z0-9._/+@%=-]+(/[A-Za-z0-9._+@%=-]+)*$ ]] \
    || fail "PITR_E2E_OUT_DIR_invalid"
  if [ -e "$evidence_dir" ]; then
    [ ! -L "$evidence_dir" ] && [ -d "$evidence_dir" ] \
      || fail "PITR_E2E_OUT_DIR_not_real_directory"
  else
    mkdir -p "$evidence_dir"
    chmod 700 "$evidence_dir"
  fi
else
  evidence_dir="$(mktemp -d "${TMPDIR:-/tmp}/momo-pitr-e2e-evidence.XXXXXX")"
fi

secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/momo-pitr-e2e-secrets.XXXXXX")"
postgres_tag=""
candidate_tag=""
postgres_tag_created=0
candidate_tag_created=0
cleanup() {
  if [ "$candidate_tag_created" -eq 1 ]; then
    docker image rm "$candidate_tag" >/dev/null 2>&1 || true
  fi
  if [ "$postgres_tag_created" -eq 1 ]; then
    docker image rm "$postgres_tag" >/dev/null 2>&1 || true
  fi
  if [ -d "$secret_dir" ]; then
    find "$secret_dir" -depth -delete >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cipher_secret="$secret_dir/pgbackrest_repo1_cipher_pass"
hmac_key="$secret_dir/momo_pitr_hmac_key"
openssl rand -hex -out "$cipher_secret" 48
openssl rand -hex -out "$hmac_key" 48
chmod 600 "$cipher_secret" "$hmac_key"

nonce="$(openssl rand -hex 6)"
run_id="pitr-e2e-$(date -u +%Y%m%dT%H%M%S)-$nonce"
compose_project="momopitre2e$nonce"
postgres_tag="momo-pitr-e2e-postgres:${run_id}"
candidate_tag="momo-pitr-e2e-migrate:${run_id}"
! docker image inspect "$postgres_tag" >/dev/null 2>&1 || fail "postgres_tag_collision"
! docker image inspect "$candidate_tag" >/dev/null 2>&1 || fail "candidate_tag_collision"
postgres_tag_created=1
printf '[pgbackrest-pitr-e2e] build postgres=%s commit=%s\n' "$postgres_tag" "$git_commit"
docker build --provenance=false \
  --build-arg "MOMO_BUILD_SHA=$git_commit" \
  -f "$ROOT/infra/rust/postgres-pgbackrest/Dockerfile" \
  -t "$postgres_tag" "$ROOT"
candidate_tag_created=1
printf '[pgbackrest-pitr-e2e] build candidate=%s commit=%s\n' "$candidate_tag" "$git_commit"
docker build --provenance=false \
  --build-arg "MOMO_BUILD_SHA=$git_commit" \
  -f "$ROOT/server-rust/Dockerfile" \
  -t "$candidate_tag" "$ROOT"

printf '[pgbackrest-pitr-e2e] runtime-unverified(local-build-id) postgres_tag=%s candidate_tag=%s\n' \
  "$postgres_tag" "$candidate_tag"
"$ROOT/scripts/verify_pgbackrest_pitr.sh" \
  --mode isolated \
  --run-id "$run_id" \
  --compose-project "$compose_project" \
  --postgres-image-local-tag "$postgres_tag" \
  --candidate-migrate-image-local-tag "$candidate_tag" \
  --git-commit "$git_commit" \
  --cipher-secret "$cipher_secret" \
  --hmac-key "$hmac_key" \
  --evidence-dir "$evidence_dir"

printf '[pgbackrest-pitr-e2e] PASS evidence_dir=%s\n' "$evidence_dir"
