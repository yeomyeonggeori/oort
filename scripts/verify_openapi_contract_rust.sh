#!/usr/bin/env bash
# =============================================================================
# scripts/verify_openapi_contract_rust.sh — SRV-B7 / #1042
# openapi 계약 게이트의 **2차 샘플 패스: 스펙 ↔ Rust**
#
# 1차 패스(scripts/verify_openapi_contract.sh)는 e2e 컴포즈의 swift:6.2 서버를
# 띄워 docs/api/openapi.yaml 의 전 연산을 샘플한다. 그런데 스펙이 서술하는 대상은
# 이제 Rust 배포본이다(#1040). 그래서 정본이 Rust 로 넘어간 경로에서는 1차 패스의
# 초록이 "스펙대로 배포된다"를 증명하지 못한다 — Swift 가 스펙을 지킨다는 사실만
# 증명한다. 이 스크립트가 그 간극을 닫는다:
#
#   scripts/openapi_sampled_on_rust.txt 에 등재된 연산을,
#   server-rust/Dockerfile 이 만드는 **배포와 동일한 이미지**로,
#   infra/rust/docker-compose.rust.yml 의 **부분집합 스택**(postgres·centrifugo·api)
#   위에서 실제로 왕복시켜, 응답 모양을 같은 스펙과 대조한다.
#
# 매니페스트와 샘플은 양방향으로 강제된다: 등재됐는데 미샘플이면 실패하고,
# 샘플인데 미등재여도 실패한다. "목록에만 있는 경로"도 "목록에 없는 초록"도 없다.
#
# 실행:
#   scripts/verify_openapi_contract_rust.sh          # 단독 실행(이미지 빌드 포함)
#   scripts/verify_openapi_contract.sh               # 1차 패스 뒤 자동으로 이 패스
#
# 환경:
#   MOMO_RUST_IMAGE                    이미 빌드된 이미지를 재사용(빌드 건너뜀).
#                                      비우면 infra/rust/docker-compose.rust.build.yml
#                                      로 checkout 에서 빌드한다 — 배포 이미지
#                                      빌드 경로를 그대로 실측하기 위해서다.
#   OPENAPI_RUST_GATE_COMPOSE_PROJECT  컴포즈 프로젝트명(기본 momo1042rustgate).
#                                      janitor 가 라벨로 회수할 수 있어야 하므로
#                                      infra/rust 의 라벨 세트를 그대로 쓴다.
#   OPENAPI_RUST_GATE_API_PORT         api 호스트 포트(기본 18990).
#   OPENAPI_RUST_GATE_CENT_PORT        centrifugo 호스트 포트(기본 18991).
#   OPENAPI_RUST_GATE_BOOT_TIMEOUT     헬스 대기 상한 초(기본 900).
#   OPENAPI_RUST_GATE_KEEP=1           끝나고 스택을 남긴다(디버깅 전용).
#   OPENAPI_SPEC                       스펙 경로 override.
#
# 자원 회수: 스택은 고유 프로젝트명으로 뜨고, EXIT 트랩이 반드시
# `down -v --remove-orphans` 한다. pgdata 볼륨은 **반드시** 게이트 전용 이름으로
# 덮어쓴다 — infra/rust 의 기본값 `momo-rust-pgdata` 는 프로젝트 스코프가 아닌
# 고정 이름이라, 덮어쓰지 않으면 게이트가 실제 스모크 스택의 볼륨을 붙잡고
# 마지막에 `down -v` 로 지워버린다.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[openapi-rust] missing required command: $1" >&2
    exit 1
  }
}
need curl
need jq
need uuidgen
need docker
need openssl

PYTHON_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON_BIN="$cand"; break
  fi
done
[ -n "$PYTHON_BIN" ] || { echo "[openapi-rust] missing python >= 3.10" >&2; exit 1; }

SPEC_YAML="${OPENAPI_SPEC:-$REPO_ROOT/docs/api/openapi.yaml}"
[ -f "$SPEC_YAML" ] || { echo "[openapi-rust] spec not found: $SPEC_YAML" >&2; exit 1; }

SAMPLED_ON_RUST="$SCRIPT_DIR/openapi_sampled_on_rust.txt"
[ -f "$SAMPLED_ON_RUST" ] || {
  echo "[openapi-rust] manifest not found: $SAMPLED_ON_RUST" >&2
  exit 1
}

COMPOSE_BASE="$REPO_ROOT/infra/rust/docker-compose.rust.yml"
COMPOSE_BUILD="$REPO_ROOT/infra/rust/docker-compose.rust.build.yml"
PROJECT="${OPENAPI_RUST_GATE_COMPOSE_PROJECT:-momo1042rustgate}"
API_PORT="${OPENAPI_RUST_GATE_API_PORT:-18990}"
CENT_PORT="${OPENAPI_RUST_GATE_CENT_PORT:-18991}"
BOOT_TIMEOUT="${OPENAPI_RUST_GATE_BOOT_TIMEOUT:-900}"

RUN_EPOCH="$(date -u +%s)"
RUN_ID="${RUN_EPOCH}-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-openapi-rust-gate-$RUN_ID"
mkdir -p "$TMP_DIR"
chmod 700 "$TMP_DIR"
SPEC_JSON="$TMP_DIR/openapi.json"
MANIFEST="$TMP_DIR/manifest.jsonl"
: >"$MANIFEST"

# ---- Failure accumulation (1차 패스와 같은 규율: 모으고 계속) ----------------
FAILURE_LOG="$TMP_DIR/failures.txt"
: >"$FAILURE_LOG"
FAILURE_COUNT=0

gate_fail() {
  local name="$1" detail="$2" body="${3:-}"
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
  printf '%s\n' "[$FAILURE_COUNT] $name: $detail" >>"$FAILURE_LOG"
  echo "[openapi-rust] FAIL $name: $detail" >&2
  [ -n "$body" ] && printf '%s\n' "$body" >&2
  return 0
}

print_failure_summary() {
  [ "$FAILURE_COUNT" -gt 0 ] || return 0
  echo "" >&2
  echo "[openapi-rust] ===== $FAILURE_COUNT failed assertion(s) =====" >&2
  cat "$FAILURE_LOG" >&2
  echo "[openapi-rust] ============================================" >&2
}

# ---- Run-scoped secrets ------------------------------------------------------
# 커밋된 자리표시자(change-me-*)는 절대 쓰지 않는다. 이 값들은 런과 함께 나고
# 죽으며, 파일은 TMP_DIR(0700) 안에 0600 으로만 존재한다.
rand_hex() { openssl rand -hex 24; }

DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
KIM_INTERN_MEMBER_ID="00000000-0000-7000-8000-000000000102"
GATE_MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
GATE_EMAIL="rust-gate-$RUN_ID@momo.local"
GATE_PASSWORD="rust-gate-$(uuidgen | tr '[:upper:]' '[:lower:]')"
GATE_HANDLE="rust-gate-$RUN_EPOCH"
RUN_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
APPROVAL_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

PG_DB="momo"
PG_USER="momo"
PG_PASSWORD="$(rand_hex)"
APP_PASSWORD="$(rand_hex)"
RELAY_PASSWORD="$(rand_hex)"
WORKER_PASSWORD="$(rand_hex)"

# 볼륨 이름은 프로젝트명에서 파생한다: infra/rust 의 기본값은 고정 이름이라
# 게이트가 실제 스모크 스택의 데이터를 붙잡을 수 있다(그리고 down -v 로 지운다).
GATE_DB_VOLUME="${PROJECT}-pgdata"

# 이미지: 주어지면 재사용, 아니면 checkout 에서 배포 빌드 경로로 만든다.
RUST_IMAGE="${MOMO_RUST_IMAGE:-}"
BUILD_IMAGE=0
if [ -z "$RUST_IMAGE" ]; then
  RUST_IMAGE="momo-rust:openapi-gate"
  BUILD_IMAGE=1
fi

ENV_FILE="$TMP_DIR/rust-gate.env"
: >"$ENV_FILE"
chmod 600 "$ENV_FILE"
cat >"$ENV_FILE" <<ENV
MOMO_RUST_IMAGE=$RUST_IMAGE
MOMO_ENV=local
LOG_LEVEL=info

POSTGRES_DB=$PG_DB
POSTGRES_USER=$PG_USER
POSTGRES_PASSWORD=$PG_PASSWORD
MIGRATE_DATABASE_URL=postgres://$PG_USER:$PG_PASSWORD@postgres:5432/$PG_DB

MOMO_APP_POSTGRES_PASSWORD=$APP_PASSWORD
RELAY_POSTGRES_PASSWORD=$RELAY_PASSWORD
WORKER_POSTGRES_PASSWORD=$WORKER_PASSWORD
MOMO_APP_DATABASE_URL=postgres://momo_app:$APP_PASSWORD@postgres:5432/$PG_DB
RELAY_DATABASE_URL=postgres://momo_relay:$RELAY_PASSWORD@postgres:5432/$PG_DB

JWT_HMAC=$(rand_hex)
CENT_TOKEN_HMAC=$(rand_hex)
CENT_API_KEY=$(rand_hex)
CENT_PROXY_SECRET=$(rand_hex)
PROVIDER_LINK_MASTER_KEY=$(rand_hex)

MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:$CENT_PORT/connection/websocket

MOMO_RUST_API_PORT=$API_PORT
CENT_HOST_PORT=$CENT_PORT

# 게이트 픽스처는 시드된 김인턴 에이전트 위에 얹힌다(1차 패스와 동일한 전제).
MOMO_AGENT_SEED_MODE=e2e
MIGRATE_IDEMPOTENCY_CHECK=1
MOMO_INITIAL_OWNER_EMAIL=
MOMO_INITIAL_OWNER_PASSWORD=

DB_VOLUME_NAME=$GATE_DB_VOLUME
ENV

COMPOSE_ARGS=(--env-file "$ENV_FILE" -p "$PROJECT" -f "$COMPOSE_BASE")
[ "$BUILD_IMAGE" -eq 1 ] && COMPOSE_ARGS+=(-f "$COMPOSE_BUILD")

compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

MANAGED_STACK=0
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  print_failure_summary
  if [ "$MANAGED_STACK" -eq 1 ]; then
    if [ "${OPENAPI_RUST_GATE_KEEP:-0}" = "1" ]; then
      echo "[openapi-rust] OPENAPI_RUST_GATE_KEEP=1 — leaving compose project '$PROJECT' up"
    else
      echo "[openapi-rust] tearing down compose project '$PROJECT'"
      compose down -v --remove-orphans >/dev/null 2>&1 || true
      # `down -v` 는 컴포즈가 아는 볼륨만 지운다. 이름을 우리가 지정했으므로
      # 남아 있으면 직접 회수한다 — 자원 누적은 이 레포의 하드 룰이다.
      docker volume rm -f "$GATE_DB_VOLUME" >/dev/null 2>&1 || true
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- 1) 스펙 YAML -> JSON (1차 패스와 같은 변환) -----------------------------
if command -v ruby >/dev/null 2>&1 && ruby -ryaml -rjson -e \
  'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))' \
  "$SPEC_YAML" >"$SPEC_JSON" 2>/dev/null; then
  :
else
  "$PYTHON_BIN" -c '
import json, sys, yaml
with open(sys.argv[1], encoding="utf-8") as handle:
    json.dump(yaml.safe_load(handle), sys.stdout)
' "$SPEC_YAML" >"$SPEC_JSON" || {
    echo "[openapi-rust] cannot convert spec to JSON (need ruby or python yaml)" >&2
    exit 1
  }
fi

# ---- 2) 매니페스트 적재 ------------------------------------------------------
EXPECTED_OPS="$TMP_DIR/expected-ops.txt"
sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$SAMPLED_ON_RUST" \
  | awk 'NF { print tolower($1) " " $2 }' | sort -u >"$EXPECTED_OPS"
EXPECTED_COUNT="$(wc -l <"$EXPECTED_OPS" | tr -d ' ')"
[ "$EXPECTED_COUNT" -gt 0 ] || {
  echo "[openapi-rust] $SAMPLED_ON_RUST lists no operations — nothing to prove" >&2
  exit 1
}
echo "[openapi-rust] sampled-on-rust manifest: $EXPECTED_COUNT operation(s)"

# 등재된 경로가 스펙에 실재하는지 먼저 본다. 오타 한 글자가 "샘플은 초록인데
# 아무것도 검증하지 않는" 상태를 만들 수 있기 때문이다.
"$PYTHON_BIN" - "$SPEC_JSON" "$EXPECTED_OPS" <<'PY' || exit 1
import json, sys
spec_path, ops_path = sys.argv[1], sys.argv[2]
with open(spec_path, encoding="utf-8") as handle:
    spec = json.load(handle)
documented = {
    (method.lower(), path)
    for path, item in (spec.get("paths") or {}).items()
    for method in item
    if method.lower() in {"get", "put", "post", "delete", "patch", "head", "options", "trace"}
}
missing = []
with open(ops_path, encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if not line:
            continue
        method, _, path = line.partition(" ")
        if (method.lower(), path) not in documented:
            missing.append(f"{method.upper()} {path}")
if missing:
    print(
        "[openapi-rust] FAIL sampled-on-rust manifest lists operations the spec "
        "does not document:",
        file=sys.stderr,
    )
    for entry in missing:
        print(f"    - {entry}", file=sys.stderr)
    sys.exit(1)
print(f"[openapi-rust] PASS manifest entries all exist in the spec")
PY

# ---- 3) Rust 부분집합 스택 ---------------------------------------------------
port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}
for p in "$API_PORT" "$CENT_PORT"; do
  if port_in_use "$p"; then
    if [ -z "$(compose ps -q --status running 2>/dev/null)" ]; then
      echo "[openapi-rust] host port $p is busy and not owned by compose project '$PROJECT'." >&2
      echo "[openapi-rust] Override with OPENAPI_RUST_GATE_API_PORT / OPENAPI_RUST_GATE_CENT_PORT." >&2
      exit 1
    fi
  fi
done

BASE_URL="http://127.0.0.1:$API_PORT"
MANAGED_STACK=1

if [ "$BUILD_IMAGE" -eq 1 ]; then
  # 배포 이미지 빌드 경로 그대로(server-rust/Dockerfile, context=repo root).
  # 커밋된 build 오버레이를 쓰므로 그 배선이 썩으면 여기서 먼저 드러난다.
  echo "[openapi-rust] building $RUST_IMAGE from the checkout (server-rust/Dockerfile)"
  compose build api
else
  echo "[openapi-rust] reusing prebuilt image $RUST_IMAGE (MOMO_RUST_IMAGE)"
fi

# 부분집합: api 만 올린다. depends_on 이 postgres·centrifugo·runtime-roles·migrate
# 를 끌고 오고, relay/agent-worker 는 승인 계열 왕복에 필요 없으므로 뜨지 않는다.
echo "[openapi-rust] booting rust subset stack '$PROJECT' (api on $BASE_URL)"
compose up -d api

echo "[openapi-rust] waiting for $BASE_URL/health (timeout ${BOOT_TIMEOUT}s)"
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    echo "[openapi-rust] timed out waiting for server health" >&2
    compose logs --tail 80 api >&2 || true
    compose logs --tail 40 migrate >&2 || true
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    echo "[openapi-rust] api container exited before health became green" >&2
    compose logs --tail 120 api >&2 || true
    compose logs --tail 40 migrate >&2 || true
    exit 1
  fi
  sleep 2
done
echo "[openapi-rust] server health is green"

# ---- 4) 픽스처 --------------------------------------------------------------
# 1차 패스의 픽스처 중 **승인 계열이 실제로 요구하는 것만**: 사람 멤버 하나,
# 그 사람의 #general 멤버십, 시드된 김인턴의 awaiting_approval 런, 그리고 그
# 런에 달린 pending 승인 하나.
run_sql() {
  compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}

echo "[openapi-rust] installing gate fixtures (member/run/approval)"
run_sql <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID';
SET LOCAL row_security = off;

DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent WHERE member_id = '$KIM_INTERN_MEMBER_ID'
  ) THEN
    RAISE EXCEPTION
      'agent seed missing — the rust stack must migrate with MOMO_AGENT_SEED_MODE=e2e';
  END IF;
END \$\$;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$GATE_MEMBER_ID', '$DEMO_WORKSPACE_ID', 'human', 'active',
        'OpenAPI Rust Gate', '$GATE_HANDLE');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$GATE_MEMBER_ID', '$DEMO_WORKSPACE_ID', '$GATE_EMAIL', true,
        momo_password_hash('$GATE_PASSWORD'), 'UTC');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_MEMBER_ID', 'admin');

INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GATE_MEMBER_ID', 'admin');

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key)
VALUES ('$RUN_UUID', '$DEMO_WORKSPACE_ID', '$KIM_INTERN_MEMBER_ID',
        '$GENERAL_CHANNEL_ID', 'awaiting_approval',
        '{"prompt":"openapi rust sample pass"}'::jsonb, 'openapi-rust-gate-$RUN_ID');

INSERT INTO approval
  (id, workspace_id, run_id, channel_id, requested_by, action_type, payload,
   status, expires_at)
VALUES ('$APPROVAL_UUID', '$DEMO_WORKSPACE_ID', '$RUN_UUID',
        '$GENERAL_CHANNEL_ID', '$KIM_INTERN_MEMBER_ID', 'tool_call',
        '{"tool_call":{"call_id":"rust-gate-1","name":"github.search_issues","arguments":{}},"estimated_micro_usd":4200,"is_reversible":true,"on_behalf_of":"$GATE_MEMBER_ID"}'::jsonb,
        'pending', now() + interval '1 hour');

COMMIT;
SQL

# ---- 5) 매니페스트 등재 연산 샘플 -------------------------------------------
RESPONSE_BODY=""
RESPONSE_STATUS=""
SAMPLE_INDEX=0

api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local out="$TMP_DIR/last-response.json" verb
  verb="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$verb" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}

sample() {
  local name="$1" method="$2" template="$3" path="$4" expected="$5" body="${6:-}" token="${7:-}"
  api "$method" "$path" "$body" "$token"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    # 잘못된 상태의 본문은 매니페스트에 넣지 않는다 — 그러면 커버리지 검사가
    # 그 연산을 '미샘플'로 잡아 초록이 될 수 없다.
    gate_fail "$name" "expected HTTP $expected, got $RESPONSE_STATUS" "$RESPONSE_BODY"
    return 0
  fi
  SAMPLE_INDEX=$((SAMPLE_INDEX + 1))
  local file
  file="$(printf '%s/sample-%02d-%s.json' "$TMP_DIR" "$SAMPLE_INDEX" "$name")"
  printf '%s' "$RESPONSE_BODY" >"$file"
  jq -cn --arg name "$name" --arg method "$method" --arg path "$template" \
    --arg status "$expected" --arg body_file "$file" \
    '{name:$name, method:$method, path:$path, status:$status, body_file:$body_file}' \
    >>"$MANIFEST"
  echo "[openapi-rust] SAMPLE $name -> $expected"
}

guard_jq() {
  local label="${*: -1}"
  set -- "${@:1:$(($# - 1))}"
  printf '%s' "$RESPONSE_BODY" | jq -e "$@" >/dev/null \
    || gate_fail "guard" "$label" "$RESPONSE_BODY"
  return 0
}

WS="$DEMO_WORKSPACE_ID"

# auth — 아래 두 승인 샘플의 자격증명 출처.
sample login post "/v1/auth/login" "/v1/auth/login" 200 \
  "$(jq -cn --arg e "$GATE_EMAIL" --arg p "$GATE_PASSWORD" --arg w "$WS" \
      '{email:$e,password:$p,workspace:$w}')"
ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken // empty')"
[ -n "$ACCESS" ] || {
  echo "[openapi-rust] login produced no accessToken — cannot sample the approval family" >&2
  echo "$RESPONSE_BODY" >&2
  exit 1
}

# 승인 계열: 인박스 투영과 결정 영수증.
sample approvals-list get "/v1/workspaces/{workspaceId}/approvals" \
  "/v1/workspaces/$WS/approvals?status=pending" 200 "" "$ACCESS"
guard_jq --arg id "$APPROVAL_UUID" '.approvals | map(select(.id == $id)) | length == 1' \
  "pending approvals include the rust gate fixture"

sample approval-decision post \
  "/v1/workspaces/{workspaceId}/approvals/{approvalId}/decision" \
  "/v1/workspaces/$WS/approvals/$APPROVAL_UUID/decision" 200 \
  "$(jq -cn --arg a "$APPROVAL_UUID" --arg d "$(uuidgen)" \
      '{approval_id:$a,approve:true,reason:"openapi rust sample pass",client_decision_id:$d}')" \
  "$ACCESS"
guard_jq '.status == "approved"' "decision receipt reports approved"

# ---- 6) 스펙 대조 + 매니페스트 양방향 커버리지 ------------------------------
jq -s '{samples: .}' "$MANIFEST" >"$TMP_DIR/manifest.json"
SAMPLE_COUNT="$(jq '.samples | length' "$TMP_DIR/manifest.json")"
echo "[openapi-rust] validating $SAMPLE_COUNT sample(s) against the spec"

SHAPE_RC=0
if [ "$SAMPLE_COUNT" -gt 0 ]; then
  "$PYTHON_BIN" "$SCRIPT_DIR/openapi_shape_check.py" \
    --spec "$SPEC_JSON" \
    --manifest "$TMP_DIR/manifest.json" || SHAPE_RC=$?
else
  echo "[openapi-rust] no samples were recorded" >&2
  SHAPE_RC=1
fi

# 양방향: 등재됐는데 미샘플 → 실패, 샘플인데 미등재 → 실패.
ACTUAL_OPS="$TMP_DIR/actual-ops.txt"
jq -r '.method + " " + .path' "$MANIFEST" \
  | awk 'NF { print tolower($1) " " $2 }' | sort -u >"$ACTUAL_OPS"

COVERAGE_RC=0
UNSAMPLED="$(comm -23 "$EXPECTED_OPS" "$ACTUAL_OPS")"
UNLISTED="$(comm -13 "$EXPECTED_OPS" "$ACTUAL_OPS")"
report_ops() {
  # 한 줄 = "method /path" — 공백이 있으므로 while read 로 그대로 흘린다.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '    - %s %s\n' \
      "$(printf '%s' "${line%% *}" | tr '[:lower:]' '[:upper:]')" "${line#* }" >&2
  done
}
if [ -n "$UNSAMPLED" ]; then
  COVERAGE_RC=1
  echo "[openapi-rust] FAIL sampled-on-rust coverage — listed but never sampled on Rust:" >&2
  printf '%s\n' "$UNSAMPLED" | report_ops
fi
if [ -n "$UNLISTED" ]; then
  COVERAGE_RC=1
  echo "[openapi-rust] FAIL sampled-on-rust coverage — sampled on Rust but not listed" >&2
  echo "[openapi-rust]      (add it to scripts/openapi_sampled_on_rust.txt — the list only grows):" >&2
  printf '%s\n' "$UNLISTED" | report_ops
fi
[ "$COVERAGE_RC" -eq 0 ] && \
  echo "[openapi-rust] PASS sampled-on-rust coverage ($EXPECTED_COUNT operation(s) round-tripped on the Rust stack)"

if [ "$FAILURE_COUNT" -gt 0 ] || [ "$SHAPE_RC" -ne 0 ] || [ "$COVERAGE_RC" -ne 0 ]; then
  echo "[openapi-rust] FAIL spec↔Rust sample pass — $FAILURE_COUNT assertion failure(s), shape rc=$SHAPE_RC, coverage rc=$COVERAGE_RC (evidence: $TMP_DIR)" >&2
  exit 1
fi

echo "[openapi-rust] PASS spec↔Rust sample pass (evidence: $TMP_DIR)"
