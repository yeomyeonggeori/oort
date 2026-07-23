#!/usr/bin/env bash
# Static MOMO-406 contract matrix. No real Docker daemon, VPS, DNS, or secret is used.
set -euo pipefail

fail() {
  printf '[install-upgrade-static] FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[install-upgrade-static] PASS: %s\n' "$*"
}

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "must run inside the repository"
cd "$REPO_ROOT"

INSTALL="infra/prod/install.sh"
UPGRADE="infra/prod/upgrade.sh"
LIB="infra/prod/deploy-lib.sh"
for path in "$INSTALL" "$UPGRADE" "$LIB"; do
  [ -x "$path" ] || fail "missing executable deployment script: $path"
done

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo406.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
FAKE_BIN="$TMP_ROOT/bin"
TRACE="$TMP_ROOT/docker.trace"
GH_TRACE="$TMP_ROOT/gh.trace"
DEPLOY_STATE_NAME="deploy-state.env"
mkdir -p "$FAKE_BIN" "$TMP_ROOT/state"

cat > "$FAKE_BIN/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'api_image=%s args=%s\n' "${MOMO_API_IMAGE:-unset}" "$*" >> "${MOMO406_DOCKER_TRACE:?}"
if [ "${1:-}" = "compose" ] && [ "${2:-}" = "version" ]; then
  printf 'Docker Compose version v2.30.0\n'
fi
case " $* " in
  *' ps --status running --services '*) printf 'api\nrelay\nworker\nlinkshort\ncaddy\n' ;;
esac
if [ "${MOMO406_FAIL_NEW_API_ONCE:-0}" = "1" ] &&
   [[ " $* " == *' up -d --no-deps --force-recreate api '* ]] &&
   [ "${MOMO_API_IMAGE:-}" = "${MOMO406_NEW_API_IMAGE:-}" ] &&
   [ ! -f "${MOMO406_FAILURE_MARKER:?}" ]; then
  : > "$MOMO406_FAILURE_MARKER"
  exit 1
fi
SH
chmod +x "$FAKE_BIN/docker"

cat > "$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$FAKE_BIN/getent" <<'SH'
#!/usr/bin/env bash
printf '203.0.113.10 %s\n' "${2:-host}"
SH
chmod +x "$FAKE_BIN/curl" "$FAKE_BIN/getent"

cat > "$FAKE_BIN/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${MOMO406_GH_TRACE:?}"
case "${MOMO406_GH_RESULT:-success}" in
  success) exit 0 ;;
  failure) exit 1 ;;
  *) exit 2 ;;
esac
SH
chmod +x "$FAKE_BIN/gh"

DIGEST_A="$(printf 'a%.0s' {1..64})"
DIGEST_B="$(printf 'b%.0s' {1..64})"
DIGEST_C="$(printf 'c%.0s' {1..64})"
DIGEST_D="$(printf 'd%.0s' {1..64})"
DIGEST_E="$(printf 'e%.0s' {1..64})"
DIGEST_F="$(printf 'f%.0s' {1..64})"
OLD_A="$(printf '1%.0s' {1..64})"
OLD_B="$(printf '2%.0s' {1..64})"
OLD_C="$(printf '3%.0s' {1..64})"
OLD_D="$(printf '4%.0s' {1..64})"
OLD_E="$(printf '5%.0s' {1..64})"
OLD_F="$(printf '6%.0s' {1..64})"
ENV_FILE="$TMP_ROOT/prod.env"

cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=momo-406-static
MOMO_ENV=staging
SECRET_SOURCE=host-local
PUBLIC_BASE_URL=https://api.momo-install.example.net
API_DOMAIN=api.momo-install.example.net
REALTIME_DOMAIN=rt.momo-install.example.net
MOMO_CENTRIFUGO_WS_URL=wss://rt.momo-install.example.net/connection/websocket
CADDY_EMAIL=ops@momo-install.example.net
ACME_EMAIL=ops@momo-install.example.net
HTTP_PORT=80
HTTPS_PORT=443
MOMO_IMAGE_TAG=sha-0123456789abcdef0123456789abcdef01234567
MOMO_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$DIGEST_A
MOMO_API_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$DIGEST_A
MOMO_RELAY_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$DIGEST_A
MOMO_WORKER_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$DIGEST_A
MOMO_MIGRATE_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$DIGEST_A
MOMO_WEB_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$DIGEST_A
MOMO_LINKSHORT_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$DIGEST_A
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD=8d96741fb02c4e1ca8dd803a5f121c11
MIGRATE_DATABASE_URL=postgres://momo:8d96741fb02c4e1ca8dd803a5f121c11@postgres:5432/momo
MOMO_APP_POSTGRES_PASSWORD=8a6f4fe7d8f84bf18486f21d5876050a
MOMO_APP_DATABASE_URL=postgres://momo_app:8a6f4fe7d8f84bf18486f21d5876050a@postgres:5432/momo
RELAY_POSTGRES_PASSWORD=25d89609443e44219a554563e39ac89b
RELAY_DATABASE_URL=postgres://momo_relay:25d89609443e44219a554563e39ac89b@postgres:5432/momo
WORKER_POSTGRES_PASSWORD=39de11bc42c84bc6a28c8634d609565a
WORKER_DATABASE_URL=postgres://momo_worker:39de11bc42c84bc6a28c8634d609565a@postgres:5432/momo
MOMO_INITIAL_OWNER_EMAIL=owner@momo-install.example.net
MOMO_INITIAL_OWNER_PASSWORD=7c35a6867c864598b4c27a91c4cf7822
DB_VOLUME_NAME=momo-406-static-pgdata
REDIS_PASSWORD=1099a519ac6d439fba20c1940d483108
CENTRIFUGO_REDIS_ADDRESS=redis://:1099a519ac6d439fba20c1940d483108@redis:6379/0
REDIS_VOLUME_NAME=momo-406-static-redis
CENT_TOKEN_HMAC=5d5b20976e38402a949e1b19655b0a9b
CENT_API_KEY=69fed31405fb4696b3677e12a4f09737
CENT_PROXY_SECRET=b3b355af9df54d2f9df7b46d51aad7dc
JWT_HMAC=231171fc80c5458a84c0c52cd5b9f284
OUTBOUND_WEBHOOK_MASTER_KEY=1524c03919df48adb80eb29568e8ef1f
AGENT_PROVIDER_MODE=external-hermes
AGENT_MODEL=hermes-agent
HERMES_BASE_URL=https://gateway.momo-install.example.net/v1
HERMES_API_KEY=913df1fc642345ecb78c1d84e52024b0
PGBACKREST_STANZA=momo
PGBACKREST_REPO1_PATH=/var/lib/pgbackrest
PGBACKREST_REPO1_CIPHER_PASS=4611197d28804171910eb3becbdd23aa
PGBACKREST_WAL_ARCHIVE_REQUIRED=1
PGBACKREST_STANZA_CHECK_REQUIRED=1
PGBACKREST_FULL_BACKUP_REQUIRED=1
PGBACKREST_PITR_REHEARSAL_REQUIRED=1
EOF

cat > "$TMP_ROOT/state/$DEPLOY_STATE_NAME" <<EOF
MOMO_IMAGE_TAG=sha-fedcba9876543210fedcba9876543210fedcba98
MOMO_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$OLD_A
MOMO_API_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$OLD_A
MOMO_RELAY_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$OLD_A
MOMO_WORKER_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$OLD_A
MOMO_MIGRATE_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$OLD_A
MOMO_WEB_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$OLD_A
MOMO_LINKSHORT_IMAGE=ghcr.io/dawn-kim-official/momo@sha256:$OLD_A
EOF
chmod 600 "$TMP_ROOT/state/$DEPLOY_STATE_NAME"
cp "$TMP_ROOT/state/$DEPLOY_STATE_NAME" "$TMP_ROOT/state/$DEPLOY_STATE_NAME.previous"

run_capture() {
  local output="$1"
  shift
  PATH="$FAKE_BIN:$PATH" MOMO406_DOCKER_TRACE="$TRACE" MOMO406_GH_TRACE="$GH_TRACE" "$@" >"$output" 2>&1
}

if run_capture "$TMP_ROOT/missing-source.out" "$INSTALL" --dry-run; then
  fail "install accepted a missing env source"
fi
grep -Fq 'missing --env-file FILE or --from-env' "$TMP_ROOT/missing-source.out" ||
  fail "missing env source did not produce an actionable error"
pass "install rejects missing/ambiguous non-interactive input"

TAG_ENV="$TMP_ROOT/tag.env"
sed -E "/^MOMO_(IMAGE|API_IMAGE|RELAY_IMAGE|WORKER_IMAGE|MIGRATE_IMAGE|WEB_IMAGE|LINKSHORT_IMAGE)=/s|=.*|=ghcr.io/dawn-kim-official/momo:\${MOMO_IMAGE_TAG}|" \
  "$ENV_FILE" > "$TAG_ENV"
if run_capture "$TMP_ROOT/tag.out" "$INSTALL" --env-file "$TAG_ENV" --mode staging --state-dir "$TMP_ROOT/tag-state" --dry-run; then
  fail "install accepted a tag-only app image"
fi
grep -Fq 'MOMO_IMAGE must be an immutable image ref' "$TMP_ROOT/tag.out" ||
  fail "tag-only image did not reach the installer digest guard"
pass "install requires per-image sha256 digests beyond the shared preflight"

run_capture "$TMP_ROOT/attestation-success.out" "$INSTALL" --env-file "$ENV_FILE" --mode staging \
  --state-dir "$TMP_ROOT/attestation-success-state" --dry-run
[ "$(wc -l < "$GH_TRACE" | tr -d ' ')" -eq 1 ] ||
  fail "install did not converge provenance verification on one momo image"
grep -Fq -- '--repo Dawn-kim-official/momo --predicate-type https://slsa.dev/provenance/v1' "$GH_TRACE" ||
  fail "attestation verification lost the repository/provenance identity policy"
pass "install verifies one pinned momo image against repository SLSA provenance"

if ! bash -c '
  command() {
    if [ "${1:-}" = "-v" ] && [ "${2:-}" = "gh" ]; then
      return 1
    fi
    builtin command "$@"
  }
  # shellcheck source=infra/prod/deploy-lib.sh
  . "$1"
  MOMO_ATTESTATION_POLICY=warn
  verify_momo_image_attestations
' _ "$LIB" >"$TMP_ROOT/attestation-no-gh.out" 2>&1; then
  fail "warn policy failed when GitHub CLI was unavailable"
fi
grep -Fq 'WARNING: GitHub CLI is unavailable; skipping provenance attestation verification' \
  "$TMP_ROOT/attestation-no-gh.out" ||
  fail "missing GitHub CLI did not produce an explicit provenance warning"
pass "missing GitHub CLI is an explicit install warning under the default policy"

MOMO406_GH_RESULT=failure run_capture "$TMP_ROOT/attestation-warn.out" "$INSTALL" --env-file "$ENV_FILE" \
  --mode staging --state-dir "$TMP_ROOT/attestation-warn-state" --dry-run
grep -Fq 'WARNING: no verifiable provenance attestation for MOMO_IMAGE; continuing under warn policy' \
  "$TMP_ROOT/attestation-warn.out" ||
  fail "default attestation policy did not disclose its soft failure"
pass "unpublished attestations are an explicit install warning by default"

REQUIRED_ENV="$TMP_ROOT/attestation-required.env"
{
  printf 'MOMO_ATTESTATION_POLICY=required\n'
  cat "$ENV_FILE"
} > "$REQUIRED_ENV"
if MOMO406_GH_RESULT=failure run_capture "$TMP_ROOT/attestation-required.out" "$INSTALL" \
  --env-file "$REQUIRED_ENV" --mode staging --state-dir "$TMP_ROOT/attestation-required-state" --dry-run; then
  fail "required attestation policy accepted failed provenance verification"
fi
grep -Fq 'provenance attestation verification failed for MOMO_IMAGE' \
  "$TMP_ROOT/attestation-required.out" ||
  fail "required attestation policy did not fail with an actionable image key"
pass "required attestation policy fails closed on unverifiable provenance"

KEY_REUSE_ENV="$TMP_ROOT/key-reuse.env"
sed "s|^OUTBOUND_WEBHOOK_MASTER_KEY=.*|OUTBOUND_WEBHOOK_MASTER_KEY=231171fc80c5458a84c0c52cd5b9f284|" "$ENV_FILE" > "$KEY_REUSE_ENV"
if run_capture "$TMP_ROOT/key-reuse.out" "$INSTALL" --env-file "$KEY_REUSE_ENV" --mode staging \
  --state-dir "$TMP_ROOT/key-reuse-state" --dry-run; then
  fail "install accepted OUTBOUND_WEBHOOK_MASTER_KEY=JWT_HMAC"
fi
grep -Fq 'OUTBOUND_WEBHOOK_MASTER_KEY must not reuse JWT_HMAC' "$TMP_ROOT/key-reuse.out" ||
  fail "webhook/JWT key reuse did not reach the preflight independence guard"
pass "install rejects outbound webhook/JWT key reuse"

NO_OWNER_ENV="$TMP_ROOT/no-owner.env"
grep -Ev '^MOMO_INITIAL_OWNER_(EMAIL|PASSWORD)=' "$ENV_FILE" > "$NO_OWNER_ENV"
if run_capture "$TMP_ROOT/no-owner.out" "$INSTALL" --env-file "$NO_OWNER_ENV" --mode staging \
  --state-dir "$TMP_ROOT/no-owner-state" --dry-run; then
  fail "install accepted missing initial owner credentials"
fi
grep -Fq 'MOMO_INITIAL_OWNER_EMAIL is required for installation' "$TMP_ROOT/no-owner.out" ||
  fail "missing initial owner input did not fail before install mutation"
pass "install requires env-only initial owner credentials"

run_capture "$TMP_ROOT/install.out" "$INSTALL" --env-file "$ENV_FILE" --mode staging \
  --state-dir "$TMP_ROOT/install-state" --dry-run
grep -Fq 'pull one pinned multi-command image -> start postgres/redis/centrifugo -> provision runtime roles -> run migrate -> set initial owner -> run web-init -> start api/relay/worker/linkshort/caddy' "$TMP_ROOT/install.out" ||
  fail "install dry-run plan lost the ordered migration/start contract"
grep -Fq 'config --quiet' "$TRACE" || fail "install did not render docker compose config"
if grep -Fq '7c35a6867c864598b4c27a91c4cf7822' "$TMP_ROOT/install.out"; then
  fail "install printed the initial owner password"
fi
pass "install dry-run validates preflight/digests/compose and ordered idempotent plan"

if run_capture "$TMP_ROOT/no-backup.out" "$UPGRADE" --env-file "$ENV_FILE" --mode staging \
  --state-dir "$TMP_ROOT/state"; then
  fail "upgrade accepted a real run without backup evidence"
fi
grep -Fq 'required file is missing' "$TMP_ROOT/no-backup.out" ||
  fail "missing backup evidence did not fail before mutation"
pass "real upgrade requires explicit backup evidence"

run_capture "$TMP_ROOT/upgrade.out" "$UPGRADE" --env-file "$ENV_FILE" --mode staging \
  --state-dir "$TMP_ROOT/state" --dry-run
grep -Fq 'pull new multi-command digest -> provision runtime roles -> run forward migration and web-init -> restart api/relay/worker/linkshort/caddy' "$TMP_ROOT/upgrade.out" ||
  fail "upgrade dry-run lost migration/restart ordering"
grep -Fq 'automatically restore previous api/relay/worker/web/LinkShort digests' "$TMP_ROOT/upgrade.out" ||
  fail "upgrade dry-run lost the previous-image rollback path"
grep -Fq 'database remains forward-only' "$TMP_ROOT/upgrade.out" ||
  fail "upgrade dry-run did not disclose forward-only database migrations"
pass "upgrade dry-run exposes sequential restart and app-only rollback asymmetry"

for deploy_script in "$INSTALL" "$UPGRADE"; do
  role_line="$(grep -n 'run --rm --no-deps runtime-roles' "$deploy_script" | head -n 1 | cut -d: -f1)"
  migrate_line="$(grep -n 'run --rm --no-deps migrate' "$deploy_script" | head -n 1 | cut -d: -f1)"
  [ -n "$role_line" ] && [ -n "$migrate_line" ] && [ "$role_line" -lt "$migrate_line" ] ||
    fail "$deploy_script must provision runtime roles before invoking migrate"
done
pass "install and upgrade consume runtime-role provisioning before migrations"

owner_line="$(grep -n 'run --rm --no-deps migrate set-owner' "$INSTALL" | head -n 1 | cut -d: -f1)"
install_migrate_line="$(grep -n 'run --rm --no-deps migrate ||' "$INSTALL" | head -n 1 | cut -d: -f1)"
web_line="$(grep -n 'run --rm --no-deps web-init' "$INSTALL" | head -n 1 | cut -d: -f1)"
[ -n "$owner_line" ] && [ "$install_migrate_line" -lt "$owner_line" ] && [ "$owner_line" -lt "$web_line" ] ||
  fail "install must set the initial owner after migration and before service startup"
if grep -Fq 'migrate set-owner' "$UPGRADE"; then
  fail "upgrade must not overwrite an established owner credential"
fi
pass "install bootstraps the owner once while upgrade preserves established credentials"

mkdir -p "$TMP_ROOT/legacy-state"
grep -Ev '^MOMO_(IMAGE|WEB_IMAGE|LINKSHORT_IMAGE)=' "$TMP_ROOT/state/$DEPLOY_STATE_NAME" > "$TMP_ROOT/legacy-state/$DEPLOY_STATE_NAME"
chmod 600 "$TMP_ROOT/legacy-state/$DEPLOY_STATE_NAME"
run_capture "$TMP_ROOT/legacy-upgrade.out" "$UPGRADE" --env-file "$ENV_FILE" --mode staging \
  --state-dir "$TMP_ROOT/legacy-state" --dry-run
grep -Fq 'legacy deploy state has no web image' "$TMP_ROOT/legacy-upgrade.out" ||
  fail "first web-enabled upgrade did not accept legacy four-image deploy state"
grep -Fq 'legacy deploy state has no LinkShort image' "$TMP_ROOT/legacy-upgrade.out" ||
  fail "first LinkShort-enabled upgrade did not accept a legacy deploy state"
pass "legacy four-image deploy state upgrades without losing rollback safety disclosure"

printf '{"result":"PASS"}\n' > "$TMP_ROOT/backup.json"
FAILURE_MARKER="$TMP_ROOT/new-api-failed"
if PATH="$FAKE_BIN:$PATH" MOMO406_DOCKER_TRACE="$TRACE" \
  MOMO406_FAIL_NEW_API_ONCE=1 MOMO406_NEW_API_IMAGE="ghcr.io/dawn-kim-official/momo@sha256:$DIGEST_A" \
  MOMO406_FAILURE_MARKER="$FAILURE_MARKER" \
  "$UPGRADE" --env-file "$ENV_FILE" --mode staging --state-dir "$TMP_ROOT/state" \
  --backup-evidence "$TMP_ROOT/backup.json" >"$TMP_ROOT/failed-upgrade.out" 2>&1; then
  fail "simulated new-api failure unexpectedly reported upgrade success"
fi
[ -f "$FAILURE_MARKER" ] || fail "simulated new-api restart failure did not execute"
grep -Fq "api_image=ghcr.io/dawn-kim-official/momo@sha256:$OLD_A args=" "$TRACE" ||
  fail "failed upgrade did not execute the previous-api digest rollback"
grep -Fq 'previous app images restored, database migrations remain forward-only' "$TMP_ROOT/failed-upgrade.out" ||
  fail "failed upgrade did not report successful app rollback and DB asymmetry"
pass "simulated restart failure executes previous-digest app rollback"

run_capture "$TMP_ROOT/rollback.out" "$UPGRADE" --env-file "$ENV_FILE" --mode staging \
  --state-dir "$TMP_ROOT/state" --rollback-only \
  --rollback-state "$TMP_ROOT/state/$DEPLOY_STATE_NAME.previous" --dry-run
grep -Fq 'restore previous api/relay/worker/web/LinkShort digests; do not reverse migrations' "$TMP_ROOT/rollback.out" ||
  fail "manual rollback dry-run path is missing"
pass "documented manual rollback state is executable in dry-run mode"

grep -Fq 'run_prod_preflight' "$INSTALL" || fail "install lost prod_env_preflight wiring"
grep -Fq 'run_prod_preflight' "$UPGRADE" || fail "upgrade lost prod_env_preflight wiring"
grep -Fq 'ADR-0120 P-3 / ADR-0121 S-5 placeholder' "$INSTALL" ||
  fail "optional relay registration placeholder is missing"
# shellcheck disable=SC2016 # literal source-code contract, not shell expansion
grep -Fq 'MOMO_API_IMAGE="$OLD_API"' "$UPGRADE" || fail "rollback image override is missing"
pass "preflight, relay placeholder, and rollback source wiring are present"

python3 - infra/prod/docker-compose.prod.yml infra/docker-compose.e2e.yml <<'PY' ||
import re
import sys

for compose_path in sys.argv[1:]:
    services = {}
    current = None
    in_services = False
    for line in open(compose_path, encoding="utf-8"):
        if line == "services:\n":
            in_services = True
            continue
        if in_services and re.match(r"^[A-Za-z]", line):
            break
        service_match = re.match(r"^  ([a-zA-Z0-9_-]+):\s*$", line)
        if in_services and service_match:
            current = service_match.group(1)
            services[current] = {"mem_limit": False, "labels": False, "images": []}
            continue
        if current is None:
            continue
        stripped = line.strip()
        if stripped.startswith("mem_limit:"):
            services[current]["mem_limit"] = True
        elif stripped == "labels: *momo-janitor-labels":
            services[current]["labels"] = True
        elif stripped.startswith("image:"):
            services[current]["images"].append(stripped.split(":", 1)[1].strip())

    if not services:
        raise SystemExit(f"{compose_path}: no services parsed")
    for service, contract in services.items():
        if not contract["mem_limit"]:
            raise SystemExit(f"{compose_path}: service {service} has no mem_limit")
        if not contract["labels"]:
            raise SystemExit(f"{compose_path}: service {service} has no janitor label set")
        for image in contract["images"]:
            if image.startswith("${") or image.startswith("momo-"):
                continue
            if not re.search(r"@sha256:[0-9a-f]{64}$", image):
                raise SystemExit(f"{compose_path}: service {service} has tag-only external image {image}")
PY
  fail "compose resource/digest policy is incomplete"
pass "prod and e2e compose give every service a memory ceiling, janitor label, and pinned external image"

for env_key in MOMO_ATTESTATION_POLICY MOMO_CADDY_MEM_LIMIT MOMO_POSTGRES_MEM_LIMIT \
  MOMO_REDIS_MEM_LIMIT MOMO_CENTRIFUGO_MEM_LIMIT MOMO_API_MEM_LIMIT MOMO_RELAY_MEM_LIMIT \
  MOMO_WORKER_MEM_LIMIT MOMO_MIGRATE_MEM_LIMIT MOMO_RUNTIME_ROLES_MEM_LIMIT \
  MOMO_WEB_INIT_MEM_LIMIT MOMO_LINKSHORT_MEM_LIMIT MOMO_EVE_DB_ROLES_MEM_LIMIT \
  MOMO_EVE_MEM_LIMIT MOMO_MINIO_MEM_LIMIT MOMO_MINIO_INIT_MEM_LIMIT; do
  grep -Eq "^${env_key}=" infra/prod/.env.example ||
    fail "infra/prod/.env.example is missing $env_key"
  grep -Eq "^${env_key}=" infra/prod/secrets.env.example ||
    fail "infra/prod/secrets.env.example is missing $env_key"
done
pass "both production env templates expose the same attestation and memory policy keys"

grep -Fq 'com.momo.janitor.match-label: com.docker.compose.project' \
  infra/prod/docker-compose.prod.yml ||
  fail "prod compose janitor label does not name the Compose project authority"
grep -Fq 'com.momo.janitor.match-label: com.docker.compose.project' \
  infra/docker-compose.e2e.yml ||
  fail "e2e compose janitor label does not name the Compose project authority"
grep -Fq 'label=com.docker.compose.project' scripts/compose_janitor.sh ||
  fail "janitor no longer discovers resources through the Compose project label"
pass "compose janitor labels use the same project authority as cleanup matching"

# grep(POSIX)만 사용 — rg는 이 게이트 체인의 가용 전제가 아니며, 부재 시
# exit 127이 "매치 없음"으로 오독되어 검사가 조용히 스킵된다 (review #429 M1).
if grep -En '(echo|printf).*(PASSWORD|HMAC|API_KEY|TOKEN|SECRET|DATABASE_URL|HERMES)' \
  "$INSTALL" "$UPGRADE" "$LIB" >/dev/null; then
  fail "deployment scripts contain a secret-value echo/printf pattern"
fi
pass "deployment scripts contain no secret-value echo path"

printf '[install-upgrade-static] PASS: MOMO-406 static argument/rollback matrix complete\n'
