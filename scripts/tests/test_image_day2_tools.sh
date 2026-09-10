#!/usr/bin/env bash
# SH-11e-2 / #2346 — in-image T2 doctor --json and backup --tier t2.
#
# The runtime image must carry PGDG postgresql-client-18 and python3 (json)
# so Railway T2 one-offs can reach MIGRATE_DATABASE_URL on .railway.internal.
# Docker missing is RED (no silent skip). Sabotage: purge client-18 → backup
# RED; hide python3 → --json RED. Each sabotage is a throwaway container;
# the built image is not mutated.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

CASES=0
fail() { echo "[image-day2-tools] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[image-day2-tools] ok: $*"; }

bash -n "$SCRIPT_DIR/test_image_day2_tools.sh" || fail "bash -n self"
bash -n "$REPO_ROOT/scripts/oort" \
  "$REPO_ROOT/scripts/lib/oort_doctor.sh" \
  "$REPO_ROOT/scripts/lib/oort_day2.sh" \
  "$REPO_ROOT/scripts/lib/pg_dump_custom.sh" \
  "$REPO_ROOT/scripts/self_host_pg_dump.sh" || fail "bash -n day-2 scripts"

command -v docker >/dev/null 2>&1 || fail "docker 없음"
docker info >/dev/null 2>&1 || fail "docker daemon unavailable"
command -v openssl >/dev/null 2>&1 || fail "openssl 없음"
command -v python3 >/dev/null 2>&1 || fail "python3 없음 (host JSON parse)"

DOCKERFILE="$REPO_ROOT/server-rust/Dockerfile"
KEY="$REPO_ROOT/server-rust/apt/ACCC4CF8.asc"
[ -f "$DOCKERFILE" ] || fail "missing $DOCKERFILE"
[ -s "$KEY" ] || fail "missing PGDG key $KEY"

if command -v sha256sum >/dev/null 2>&1; then
  KEY_SHA="$(sha256sum "$KEY" | awk '{ print $1 }')"
else
  KEY_SHA="$(shasum -a 256 "$KEY" | awk '{ print $1 }')"
fi
[ "$KEY_SHA" = "0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76" ] || \
  fail "ACCC4CF8.asc sha256 drifted: $KEY_SHA"
grep -Fq "$KEY_SHA" "$DOCKERFILE" || fail "Dockerfile does not pin ACCC4CF8.asc sha256"
grep -Fq "postgresql-client-18=18.6-1.pgdg12+2" "$DOCKERFILE" || \
  fail "Dockerfile does not pin postgresql-client-18=18.6-1.pgdg12+2"
if grep -E '^[[:space:]]*(RUN|CMD).*apt[.]postgresql[.]org[.]sh' "$DOCKERFILE" >/dev/null; then
  fail "Dockerfile still invokes the PGDG convenience installer script"
fi
if grep -Eq 'curl[[:space:]]*\|[[:space:]]*sh' "$DOCKERFILE"; then
  fail "Dockerfile uses curl | sh"
fi
grep -Fq "COPY server-rust/apt/ACCC4CF8.asc" "$DOCKERFILE" || \
  fail "Dockerfile does not COPY the committed PGDG key"
grep -Fq "python3 -c 'import json'" "$DOCKERFILE" || \
  fail "Dockerfile does not prove python3 json at build"
grep -Fq 'python3=3.11.*' "$DOCKERFILE" || \
  fail "Dockerfile does not pin python3=3.11.*"
grep -Fq "python3 --version | grep -E '^Python 3\\.11\\.'" "$DOCKERFILE" || \
  fail "Dockerfile does not prove python3 3.11 at build"
grep -Eq '^[[:space:]]+postgresql-client[[:space:]]*\\[[:space:]]*$' "$DOCKERFILE" && \
  fail "Dockerfile still installs unversioned debian postgresql-client"
pass "Dockerfile contract: PGDG pin, key sha256, no curl|sh, python3 json"

IMAGE="${MOMO_RUST_IMAGE:-}"
BUILT_HERE=0
PREFIX="oort2346t$$"
NET="${PREFIX}-net"
PG_NAME="${PREFIX}-pg"
APP_TAG="momo-rust:day2-${PREFIX}"
# Colima/macOS: default TMPDIR (/var/folders) and /tmp are not bind-mounted
# into the VM. Keep the sandbox under the worktree (/Users/...) so -v works.
SANDBOX="$(mktemp -d "$REPO_ROOT/.tmp-${PREFIX}.XXXXXX")"
PG_CID=""
NET_CREATED=0

cleanup() {
  [ -n "$PG_CID" ] && docker rm -f "$PG_CID" >/dev/null 2>&1 || true
  if [ "$NET_CREATED" = 1 ]; then
    docker network rm "$NET" >/dev/null 2>&1 || true
  fi
  rm -rf "$SANDBOX"
  if [ "$BUILT_HERE" = 1 ]; then
    docker rmi -f "$APP_TAG" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [ -z "$IMAGE" ]; then
  IMAGE="$APP_TAG"
  BUILT_HERE=1
  SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  echo "[image-day2-tools] docker build -f server-rust/Dockerfile (image $IMAGE sha=$SHA)"
  docker build -f server-rust/Dockerfile --build-arg "MOMO_BUILD_SHA=$SHA" -t "$IMAGE" "$REPO_ROOT"
else
  echo "[image-day2-tools] using existing image $IMAGE"
  docker image inspect "$IMAGE" >/dev/null || fail "MOMO_RUST_IMAGE=$IMAGE is not a local image"
fi

docker run --rm --entrypoint /bin/sh "$IMAGE" -c '
  set -eu
  pg_dump --version | grep -E "^pg_dump \\(PostgreSQL\\) 18\\." >/dev/null
  test -x /usr/lib/postgresql/18/bin/pg_dump
  python3 --version | grep -E "^Python 3\\.11\\." >/dev/null
  python3 -c "import json"
  test -x /opt/momo/scripts/oort
  test -s /opt/momo/scripts/lib/oort_doctor.sh
  test -s /opt/momo/scripts/lib/pg_dump_custom.sh
  id -u | grep -qx 10001
' || fail "built image missing client-18 / python3 json / day-2 scripts / non-root user"
pass "image has pg_dump 18, python3 json, /opt/momo/scripts/oort, uid 10001"

AFTER_BYTES="$(docker image inspect -f '{{.Size}}' "$IMAGE")"
echo "[image-day2-tools] image_bytes_after=${AFTER_BYTES}"

docker network create "$NET" >/dev/null
NET_CREATED=1

TOKEN_PG="$(openssl rand -hex 12)"
docker run -d --name "$PG_NAME" --network "$NET" \
  -e POSTGRES_USER=momo \
  -e POSTGRES_PASSWORD="$TOKEN_PG" \
  -e POSTGRES_DB=momo \
  pgvector/pgvector:0.8.5-pg18-trixie >/dev/null
PG_CID="$PG_NAME"

i=0
while [ "$i" -lt 40 ]; do
  docker exec "$PG_NAME" pg_isready -U momo >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 1
done
docker exec "$PG_NAME" pg_isready -U momo >/dev/null 2>&1 || \
  fail "throwaway pgvector/pgvector:0.8.5-pg18-trixie did not become ready"

docker exec -i "$PG_NAME" psql -U momo -d momo -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE TABLE message (id int);
INSERT INTO message(id) VALUES (1);
CREATE TABLE outbox (
  kind text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  lease_acquired_at timestamptz
);
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
pass "PG18 fixture ready on network ${NET}"

T2_URL="postgres://momo:${TOKEN_PG}@${PG_NAME}:5432/momo"
ENV_FILE="$SANDBOX/t2.env"
printf 'MIGRATE_DATABASE_URL=%s\nMOMO_SELF_HOST_PLATFORM=railway\nMOMO_RUST_IMAGE=oort:local\n' \
  "$T2_URL" >"$ENV_FILE"
chmod 644 "$ENV_FILE"

OUT_DIR="$SANDBOX/out"
mkdir -p "$OUT_DIR"

DOC_JSON="$SANDBOX/doctor.json"
DOC_ERR="$SANDBOX/doctor.err"
set +e
docker run --rm --user 0 --network "$NET" --entrypoint /bin/bash \
  -v "$SANDBOX:/mnt/test:ro" \
  "$IMAGE" \
  -c 'set -euo pipefail
test -f /mnt/test/t2.env
install -o momo -g momo -m 600 /mnt/test/t2.env /home/momo/t2.env
exec su -s /bin/bash momo -c "/opt/momo/scripts/oort doctor --tier t2 --json --env /home/momo/t2.env"' \
  >"$DOC_JSON" 2>"$DOC_ERR"
DOC_RC=$?
set -e
python3 - "$DOC_JSON" <<'PY' || fail "doctor --json did not parse: $(head -c 400 "$DOC_JSON") stderr=$(head -c 400 "$DOC_ERR")"
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    doc = json.load(fh)
assert isinstance(doc, dict), type(doc)
assert "summary" in doc and "checks" in doc
ids = [c.get("id") for c in doc["checks"] if isinstance(c, dict)]
needed = [
    "stack.compose_ps",
    "stack.healthz",
    "stack.agent_port",
    "stack.outbox",
    "stack.migrate_idempotency",
]
missing = [i for i in needed if i not in ids]
if missing:
    raise SystemExit("missing stack.* ids: " + ",".join(missing) + " have=" + ",".join(ids))
print("stack_ids=" + ",".join(needed))
print("n_checks=" + str(len(ids)))
print("verdict=" + str(doc.get("summary", {}).get("verdict")))
PY
if grep -F -- "$TOKEN_PG" "$DOC_JSON" "$DOC_ERR" >/dev/null 2>&1; then
  fail "doctor --json leaked postgres password"
fi
if grep -Fq "$T2_URL" "$DOC_JSON" "$DOC_ERR"; then
  fail "doctor --json leaked MIGRATE_DATABASE_URL"
fi
pass "in-image doctor --tier t2 --json parses; stack.* ids present (exit ${DOC_RC})"

BAK_CID="${PREFIX}-bak"
BAK_OUT="$SANDBOX/backup.out"
BAK_ERR="$SANDBOX/backup.err"
docker rm -f "$BAK_CID" >/dev/null 2>&1 || true
set +e
docker run --name "$BAK_CID" --user 0 --network "$NET" --entrypoint /bin/bash \
  -v "$SANDBOX:/mnt/test:ro" \
  "$IMAGE" \
  -c 'set -euo pipefail
test -f /mnt/test/t2.env
install -o momo -g momo -m 600 /mnt/test/t2.env /home/momo/t2.env
mkdir -p /tmp/out && chown momo:momo /tmp/out
su -s /bin/bash momo -c "/opt/momo/scripts/oort backup --tier t2 --env /home/momo/t2.env --out /tmp/out"' \
  >"$BAK_OUT" 2>"$BAK_ERR"
BAK_RC=$?
set -e
[ "$BAK_RC" = "0" ] || {
  docker rm -f "$BAK_CID" >/dev/null 2>&1 || true
  fail "in-image backup exit $BAK_RC stdout=$(cat "$BAK_OUT") stderr=$(cat "$BAK_ERR")"
}
DUMP_PATH="$(awk -F': ' '$1 == "[oort backup] path" { print $2; exit }' "$BAK_OUT")"
[ -n "$DUMP_PATH" ] || {
  docker rm -f "$BAK_CID" >/dev/null 2>&1 || true
  fail "backup printed no path: $(cat "$BAK_OUT")"
}
docker cp "$BAK_CID:$DUMP_PATH" "$OUT_DIR/" >/dev/null
docker rm -f "$BAK_CID" >/dev/null 2>&1 || true
DUMP_HOST="${OUT_DIR}/$(basename "$DUMP_PATH")"
[ -s "$DUMP_HOST" ] || fail "dump missing on host: $DUMP_HOST (container path $DUMP_PATH)"
DUMP_BYTES="$(wc -c <"$DUMP_HOST" | tr -d '[:space:]')"
[ "$DUMP_BYTES" -gt 0 ] || fail "dump was 0 bytes"

TOC="$(docker run --rm --user 0 --entrypoint pg_restore \
  -v "$OUT_DIR:/tmp/dump:ro" \
  "$IMAGE" -l "/tmp/dump/$(basename "$DUMP_HOST")" \
  | awk '/^[0-9]+;/{ n++ } END { print n + 0 }')"
[ "$TOC" -ge 1 ] || fail "pg_restore TOC < 1 (got ${TOC})"
if grep -F -- "$TOKEN_PG" "$BAK_OUT" "$BAK_ERR" >/dev/null 2>&1; then
  fail "backup leaked postgres password"
fi
if grep -Fq "$T2_URL" "$BAK_OUT" "$BAK_ERR"; then
  fail "backup leaked MIGRATE_DATABASE_URL"
fi
pass "in-image backup --tier t2 pg_dump exit 0 bytes=${DUMP_BYTES} TOC=${TOC}"

# --- sabotage 1: remove client-18. Throwaway container; image restored by not committing.
SAB1_OUT="$SANDBOX/sab1.out"
SAB1_ERR="$SANDBOX/sab1.err"
set +e
docker run --rm --user 0 --network "$NET" --entrypoint /bin/bash \
  -v "$SANDBOX:/mnt/test:ro" \
  "$IMAGE" -c '
    set -eu
    dpkg --purge postgresql-client-18 >/dev/null 2>&1 || true
    rm -f /usr/bin/pg_dump /usr/lib/postgresql/18/bin/pg_dump /usr/bin/pg_dump.pg_wrapper
    if command -v pg_dump >/dev/null 2>&1; then
      echo "sabotage-1: pg_dump still on PATH: $(command -v pg_dump)" >&2
      exit 97
    fi
    test -f /mnt/test/t2.env
    install -o momo -g momo -m 600 /mnt/test/t2.env /home/momo/t2.env
    mkdir -p /tmp/out && chown momo:momo /tmp/out
    su -s /bin/bash momo -c "/opt/momo/scripts/oort backup --tier t2 --env /home/momo/t2.env --out /tmp/out"
  ' >"$SAB1_OUT" 2>"$SAB1_ERR"
SAB1_RC=$?
set -e
[ "$SAB1_RC" != "0" ] || fail "sabotage remove client-18 still exited 0: $(cat "$SAB1_OUT") $(cat "$SAB1_ERR")"
[ "$SAB1_RC" != "97" ] || fail "sabotage did not actually remove pg_dump"
pass "sabotage remove postgresql-client-18 → in-image backup RED (exit ${SAB1_RC})"

# --- sabotage 2: remove python3. Throwaway container.
SAB2_OUT="$SANDBOX/sab2.out"
SAB2_ERR="$SANDBOX/sab2.err"
set +e
docker run --rm --user 0 --network "$NET" --entrypoint /bin/bash \
  -v "$SANDBOX:/mnt/test:ro" \
  "$IMAGE" -c '
    set -eu
    dpkg --purge python3 python3.11 python3-minimal python3.11-minimal >/dev/null 2>&1 || true
    rm -f /usr/bin/python3 /usr/bin/python3.11 /usr/bin/python3.11-minimal
    if command -v python3 >/dev/null 2>&1; then
      echo "sabotage-2: python3 still on PATH: $(command -v python3)" >&2
      exit 97
    fi
    test -f /mnt/test/t2.env
    install -o momo -g momo -m 600 /mnt/test/t2.env /home/momo/t2.env
    su -s /bin/bash momo -c "/opt/momo/scripts/oort doctor --tier t2 --json --env /home/momo/t2.env"
  ' >"$SAB2_OUT" 2>"$SAB2_ERR"
SAB2_RC=$?
set -e
[ "$SAB2_RC" != "0" ] || fail "sabotage remove python3 still exited 0: $(cat "$SAB2_OUT") $(cat "$SAB2_ERR")"
[ "$SAB2_RC" != "97" ] || fail "sabotage did not actually remove python3"
if python3 -c 'import json,sys; json.load(open(sys.argv[1],encoding="utf-8"))' "$SAB2_OUT" 2>/dev/null; then
  fail "sabotage remove python3 still emitted parseable JSON"
fi
pass "sabotage remove python3 → in-image doctor --json RED (exit ${SAB2_RC})"

echo "[image-day2-tools] PASS cases=${CASES} image_bytes_after=${AFTER_BYTES} dump_bytes=${DUMP_BYTES} toc=${TOC}"
