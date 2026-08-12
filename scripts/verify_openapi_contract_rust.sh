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
# ── 세 자격증명 ─────────────────────────────────────────────────────────────
# 등재 목록이 승인 계열 3개에서 자라면서(#1132 이탈 6 / #1143 잔여) 이 패스는
# **사람 bearer 하나로는 닿을 수 없는 표면**을 갖게 됐다. 그래서 호출자가 셋이다:
#
#   * App JWT (`Authorization: Bearer …`) — 로그인이 준다. 대부분의 표본.
#   * agent bearer (`momo_agent_v1.{ws}.{secret}`) — `POST …/work-controls` 전용
#     (momo_auth::agent_scope). 발급 라우트가 없어 SQL 픽스처가 유일한 출처다.
#   * work-host 서명 (`Authorization: MomoHost {hostId}` + v2 서명 3 헤더) —
#     데몬이 `pending-controls` 를 읽고 `…/ack` 로 「실행했다」를 보고하는 경로.
#     ack 을 요청자와 **다른** 자격증명이 하는 것이 #1143 이 연 그 문장이므로,
#     이 패스도 서명 arm 으로 샘플한다. 사람 arm 으로 바꾸면 초록의 뜻이 달라진다.
#
# 그래서 openssl 은 Ed25519 를 할 줄 알아야 한다(macOS 기본 LibreSSL 은 못 한다) —
# 부팅 전에 그 능력을 실제로 시험해 고른다.
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
# `down -v --remove-orphans` 한다. pgdata 볼륨은 게이트 전용 이름으로 덮어쓴다.
# #1238 이후 이 덮어쓰기는 **유일한** 방어선이 아니다 — base compose 의 기본
# 볼륨명이 프로젝트 스코프(`${COMPOSE_PROJECT_NAME}-pgdata`)로 바뀌었으므로 고유
# 프로젝트명만으로도 격리된다. 그래도 명시 이름을 유지하는 이유는 이 게이트가
# 남의 볼륨을 `down -v` 로 지운 사고(#1058 실측)의 당사자였기 때문이다:
# 격리를 compose 기본값 하나에만 의존시키지 않는다.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# 스펙 YAML -> JSON 변환은 1차 패스와 공유하는 한 벌이다(#1185).
# shellcheck source=scripts/openapi_spec_to_json.sh
. "$SCRIPT_DIR/openapi_spec_to_json.sh"

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

# Ed25519 는 이 패스의 **자격증명**이다 — 서명 데몬 픽스처(#1114/#1143)가
# `pending-controls` 폴링과 `work-controls/{id}/ack` 를 그 키로 서명한다.
# macOS 기본 `/usr/bin/openssl` 은 LibreSSL 이고 `genpkey -algorithm ED25519` 를
# 못 하므로, PYTHON_BIN 과 같은 방식으로 **할 수 있는 구현을 찾아** 고정한다.
# 못 찾으면 여기서 멈춘다: 서명 없는 초록은 데몬 경로를 증명하지 않는다.
OPENSSL_BIN=""
for cand in "${OPENSSL:-}" openssl /opt/homebrew/opt/openssl@3/bin/openssl \
  /usr/local/opt/openssl@3/bin/openssl /opt/homebrew/bin/openssl /usr/bin/openssl; do
  [ -n "$cand" ] || continue
  command -v "$cand" >/dev/null 2>&1 || continue
  if "$cand" genpkey -algorithm ED25519 -out /dev/null >/dev/null 2>&1; then
    OPENSSL_BIN="$cand"; break
  fi
done
[ -n "$OPENSSL_BIN" ] || {
  echo "[openapi-rust] no openssl with Ed25519 support (need OpenSSL 3.x; LibreSSL cannot sign the work-host requests)" >&2
  exit 1
}

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
rand_hex() { "$OPENSSL_BIN" rand -hex 24; }

lower_uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }

DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
KIM_INTERN_MEMBER_ID="00000000-0000-7000-8000-000000000102"
GATE_MEMBER_ID="$(lower_uuid)"
GATE_EMAIL="rust-gate-$RUN_ID@momo.local"
GATE_PASSWORD="rust-gate-$(lower_uuid)"
GATE_HANDLE="rust-gate-$RUN_EPOCH"
RUN_UUID="$(lower_uuid)"
APPROVAL_UUID="$(lower_uuid)"

# 승인 계열 밖의 픽스처(#1132 이탈 6 / #1143 잔여를 닫는 데 필요한 것들).
GATE_PEER_ID="$(lower_uuid)"          # DM 상대. 자기 자신과는 DM 이 열리지 않는다.
GATE_PEER_EMAIL="rust-gate-peer-$RUN_ID@momo.local"
GATE_AGENT_ID="$(lower_uuid)"         # work-control 을 요청하는 에이전트.
GATE_AGENT_HANDLE="rust-gate-agent-$RUN_EPOCH"
# agent bearer 는 라우트로 발급되지 않는다(이 서버엔 `…/credentials` 가 없다).
# 형식은 `momo_agent_v1.{ws}.{secret}` 이고 저장되는 것은 sha256 다이제스트뿐
# (momo_auth::agent_bearer). 그래서 SQL 이 유일한 발급 경로이자 픽스처다.
GATE_AGENT_TOKEN="momo_agent_v1.$DEMO_WORKSPACE_ID.$(rand_hex)$(rand_hex)"
CONTROL_RUN_UUID="$(lower_uuid)"      # work-control 이 붙을 running 런.
CANCEL_RUN_UUID="$(lower_uuid)"       # 사람의 「멈춰라」 표본용 queued 런.
INVITE_CODE="rust-gate-invite-$RUN_ID"
JOIN_EMAIL="rust-gate-join-$RUN_ID@momo.local"
JOIN_PASSWORD="rust-gate-join-$(lower_uuid)"
JOIN_HANDLE="rust-gate-join-$RUN_EPOCH"

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
MOMO_MIGRATE_ENV=development
MOMO_PITR_EVIDENCE_REQUIRED=0
MOMO_PITR_BOOTSTRAP_EMPTY=0
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

# 프로세스 환경은 --env-file 을 **이깁니다**. 문서가 권하는 `MOMO_RUST_IMAGE=`
# (빈 값 = 빌드하라) 로 호출하면 그 빈 값이 그대로 이겨서
# `x-rust-image: ${MOMO_RUST_IMAGE:?…}` 가 보간 단계에서 죽는다. 여기서
# 해석된 태그를 다시 export 해 두 층이 같은 값을 보게 한다.
export MOMO_RUST_IMAGE="$RUST_IMAGE"

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

# ---- 1) 스펙 YAML -> JSON (1차 패스와 **같은 함수**) -------------------------
# "같은 변환"이라고 적어 두고 사본을 뒀던 자리다(#1185). 사본에는 psych 3 재시도가
# 없어서, 로그인 셸이 /usr/bin/ruby 2.6 을 먼저 잡는 기계에서는 이 줄이 곧장 python
# 갈래로 떨어졌고 그 python 에 PyYAML 이 없어 여기서 죽었다 — 직접 실주행은 초록인
# 채로. 이제 두 패스가 한 함수를 부른다.
momo_openapi_spec_to_json "$SPEC_YAML" "$SPEC_JSON" openapi-rust "$PYTHON_BIN" || exit 1

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
# 를 끌고 오고, relay/agent-worker 는 뜨지 않는다 — 등재된 연산의 응답은 전부
# 같은 트랜잭션 안에서 나오고, 브로드캐스트는 `outbox` 행으로 끝나기 때문이다.
# (relay 가 그 행을 언제 빼 가는지는 이 패스가 대조하는 모양이 아니다.)
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
# 등재된 연산이 **왕복하는 데 실제로 필요한 행만** 심는다. 규칙은 하나다:
# HTTP 로 만들 수 있는 것은 HTTP 로 만들고(그건 픽스처가 아니라 표본이다),
# 이 서버가 REST 로 만들 길을 주지 않는 것만 SQL 로 심는다. 그래서 여기 있는
# 것은 전부 「REST 로는 못 만드는 것」이다:
#
#   * 사람 멤버 둘 — 로그인할 비밀번호를 아는 계정이 필요하고(가입 라우트는
#     초대 코드가 있어야 하며 그건 아래 코드가 준다), DM 은 상대가 있어야 열린다.
#   * agent 멤버 + `agent` 행 + **agent bearer 토큰** — 이 서버엔 자격증명 발급
#     라우트가 없다(`…/agents/{id}/credentials` 는 Swift 쪽 표면이다). 그런데
#     `POST …/work-controls` 는 agent bearer 전용이라(momo_auth::agent_scope),
#     이 행이 없으면 #1132 이탈 6 이 가리킨 5 개 연산 중 어느 것도 왕복하지 않는다.
#   * `agent_run` 세 개 — 승인 하나(awaiting_approval), work-control 이 붙을
#     running 하나, 사람의 「멈춰라」가 끝낼 queued 하나. 상태가 곧 자격이라
#     한 행을 돌려 쓸 수 없다(control_run_binding_in_tx 는 queued|running 만 받는다).
#   * pending 승인 하나 — 생산자는 agent worker 이고 이 부분집합엔 없다.
#   * 초대 코드 하나 — `POST /v1/workspaces/{ws}/invites` 는 **스펙에 없는 라우트**라
#     표본이 될 수 없다. 등재 대상 밖의 라우트를 픽스처로 쓰면 매니페스트가
#     그것을 「샘플인데 미등재」로 잡으므로, 발급은 SQL 로 한다.
run_sql() {
  compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}

echo "[openapi-rust] installing gate fixtures (members/agent-bearer/runs/approval/invite)"
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
        'OpenAPI Rust Gate', '$GATE_HANDLE'),
       ('$GATE_PEER_ID', '$DEMO_WORKSPACE_ID', 'human', 'active',
        'OpenAPI Rust Gate Peer', '$GATE_HANDLE-peer'),
       ('$GATE_AGENT_ID', '$DEMO_WORKSPACE_ID', 'agent', 'active',
        'OpenAPI Rust Gate Agent', '$GATE_AGENT_HANDLE');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$GATE_MEMBER_ID', '$DEMO_WORKSPACE_ID', '$GATE_EMAIL', true,
        momo_password_hash('$GATE_PASSWORD'), 'UTC'),
       ('$GATE_PEER_ID', '$DEMO_WORKSPACE_ID', '$GATE_PEER_EMAIL', true,
        momo_password_hash('$GATE_PASSWORD'), 'UTC');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_MEMBER_ID', 'admin'),
       ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_PEER_ID', 'member'),
       ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_AGENT_ID', 'member');

INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GATE_MEMBER_ID', 'admin'),
       ('$DEMO_WORKSPACE_ID', '$GATE_PEER_ID', 'member'),
       ('$DEMO_WORKSPACE_ID', '$GATE_AGENT_ID', 'member');

-- owner_human_id 가 게이트 사람인 것이 요점이다. spawn 자동승인은 요청자
-- 에이전트의 **owner human** 에 대해 조회되므로(spawn_is_auto_approved_in_tx),
-- 게이트가 PUT …/work-auto-approvals/codex 로 쓴 그 행이 곧 이 에이전트의
-- 자동승인이 된다. 다른 사람 소유로 심으면 control 이 pending_approval 에
-- 머물러 ack 표본이 성립하지 않는다.
INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES ('$GATE_AGENT_ID', '$DEMO_WORKSPACE_ID', 'hermes-agent',
        'https://hermes.openapi.example.test/v1',
        'openapi rust sample pass', '$GATE_MEMBER_ID');

-- 원문 토큰은 이 셸에만 있고 PostgreSQL 에는 sha256 다이제스트만 들어간다.
INSERT INTO token
  (workspace_id, kind, actor_member_id, subject_member_id, token_hash, scopes, label)
VALUES ('$DEMO_WORKSPACE_ID', 'agent_bearer', '$GATE_AGENT_ID', NULL,
        digest('$GATE_AGENT_TOKEN'::text, 'sha256'),
        ARRAY['work:control'], 'openapi rust gate');

-- /v1/join 표본의 코드. 원문은 이 런에만 있고 저장되는 것은 해시다.
INSERT INTO invite_code
  (workspace_id, code_hash, code_preview, role, max_uses, expires_at, created_by)
VALUES ('$DEMO_WORKSPACE_ID', momo_invite_code_hash('$INVITE_CODE'), '',
        'member', 5, now() + interval '1 day', '$GATE_MEMBER_ID');

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key)
VALUES ('$RUN_UUID', '$DEMO_WORKSPACE_ID', '$KIM_INTERN_MEMBER_ID',
        '$GENERAL_CHANNEL_ID', 'awaiting_approval',
        '{"prompt":"openapi rust sample pass"}'::jsonb, 'openapi-rust-gate-$RUN_ID'),
       ('$CONTROL_RUN_UUID', '$DEMO_WORKSPACE_ID', '$GATE_AGENT_ID',
        '$GENERAL_CHANNEL_ID', 'running',
        '{"prompt":"openapi rust work control"}'::jsonb,
        'openapi-rust-control-$RUN_ID'),
       ('$CANCEL_RUN_UUID', '$DEMO_WORKSPACE_ID', '$KIM_INTERN_MEMBER_ID',
        '$GENERAL_CHANNEL_ID', 'queued',
        '{"prompt":"openapi rust cancel"}'::jsonb,
        'openapi-rust-cancel-$RUN_ID');

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

# 사람 자격증명으로는 도달할 수 없는 호출자가 하나 있다: **서명 데몬**.
# `Authorization: MomoHost {hostId}` + v2 서명 3 헤더가 그 자격증명이고, 서명이
# 덮는 바이트는 메서드·**원문 경로**·워크스페이스·호스트·시각·본문 SHA-256·요청
# id 다(momo_wire::request_payload). 요청 id 는 한 번만 소비되므로 매 호출이
# 새 id 를 만든다 — 재사용은 401 이고, 그건 재생 방벽이 살아 있다는 뜻이다.
now_ms() { "$PYTHON_BIN" -c 'import time; print(time.time_ns() // 1_000_000)'; }

work_host_signed_sample() {
  local name="$1" method="$2" template="$3" path="$4" expected="$5"
  local host_id="$6" private_key="$7" body="${8:-}"
  local sent_at request_id body_hash payload signature verb
  local out="$TMP_DIR/last-response.json"
  sent_at="$(now_ms)"
  request_id="$(lower_uuid)"
  body_hash="$(printf '%s' "$body" | "$OPENSSL_BIN" dgst -sha256 | awk '{print $NF}')"
  verb="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"
  payload="$TMP_DIR/work-host-request-$name.bin"
  printf 'momo.work_host.request.v2\n%s\n%s\n%s\n%s\n%s\n%s\n%s' \
    "$verb" "$path" \
    "$(printf '%s' "$WS" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at" "$body_hash" "$request_id" >"$payload"
  signature="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$private_key" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$verb"
    -H 'Content-Type: application/json'
    -H "Authorization: MomoHost $host_id"
    -H "X-Momo-Work-Host-Sent-At: $sent_at"
    -H "X-Momo-Work-Host-Signature: $signature"
    -H "X-Momo-Work-Host-Request-ID: $request_id")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
  record_sample "$name" "$method" "$template" "$expected"
}

# `sample` 의 기록 절반만: 요청을 이미 다른 자격증명으로 보낸 호출자가 쓴다.
record_sample() {
  local name="$1" method="$2" template="$3" expected="$4"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
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

# 픽스처 호출: 상태만 단정하고 매니페스트에는 넣지 않는다. 등재 연산을 준비
# 단계로 한 번 더 부르는 경우(스레드 루트의 답글, ack 이 묶일 세션 …)와 스펙에
# 아예 없는 라우트는 여기로 간다 — 표본이 아니라 전제이기 때문이다.
expect() {
  local label="$1" method="$2" path="$3" expected="$4" body="${5:-}" token="${6:-}"
  api "$method" "$path" "$body" "$token"
  [ "$RESPONSE_STATUS" = "$expected" ] && return 0
  echo "[openapi-rust] FAIL fixture $label: expected HTTP $expected, got $RESPONSE_STATUS" >&2
  echo "$RESPONSE_BODY" >&2
  exit 1
}

WS="$DEMO_WORKSPACE_ID"

# 데몬의 서명 키. 등록은 HTTP 로 하고(그 자체가 표본이다), 개인키는 TMP_DIR
# (0700) 안에만 존재한다.
HOST_KEY="$TMP_DIR/work-host.pem"
"$OPENSSL_BIN" genpkey -algorithm ED25519 -out "$HOST_KEY" >/dev/null 2>&1
chmod 600 "$HOST_KEY"
HOST_PUBLIC_KEY="$("$OPENSSL_BIN" pkey -in "$HOST_KEY" -pubout -outform DER 2>/dev/null \
  | tail -c 32 | "$OPENSSL_BIN" base64 -A)"

heartbeat_body() {
  local host_id="$1" sent_at payload signature
  sent_at="$(now_ms)"
  payload="$TMP_DIR/work-host-heartbeat-$host_id.bin"
  printf 'momo.work_host.heartbeat.v1\n%s\n%s\n%s' \
    "$(printf '%s' "$WS" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at" >"$payload"
  signature="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$HOST_KEY" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
  jq -cn --argjson sent "$sent_at" --arg signature "$signature" \
    '{sentAtMs:$sent,signature:$signature}'
}

# ---------------------------------------------------------------------------
# auth — 아래 모든 표본의 자격증명 출처.
# ---------------------------------------------------------------------------
sample login post "/v1/auth/login" "/v1/auth/login" 200 \
  "$(jq -cn --arg e "$GATE_EMAIL" --arg p "$GATE_PASSWORD" --arg w "$WS" \
      '{email:$e,password:$p,workspace:$w}')"
ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken // empty')"
REFRESH="$(printf '%s' "$RESPONSE_BODY" | jq -r '.refreshToken // empty')"
[ -n "$ACCESS" ] || {
  echo "[openapi-rust] login produced no accessToken — nothing below can be sampled" >&2
  echo "$RESPONSE_BODY" >&2
  exit 1
}

# refresh 는 **단일 사용 회전**이다: 제시한 토큰은 원자적으로 revoke 되고 새 쌍이
# 나온다. 그러므로 한 번만 부르고, 이후 전부 새 쌍을 쓴다.
sample refresh post "/v1/auth/refresh" "/v1/auth/refresh" 200 \
  "$(jq -cn --arg r "$REFRESH" '{refreshToken:$r}')"
ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -er '.accessToken')"
REFRESH="$(printf '%s' "$RESPONSE_BODY" | jq -er '.refreshToken')"

sample realtime-token post "/v1/auth/realtime-token" "/v1/auth/realtime-token" 200 \
  "" "$ACCESS"
guard_jq '.tokenType == "centrifugo.connection.jwt" and (.expiresAtMs | type == "number")' \
  "realtime token is a centrifugo connection jwt"

# ---------------------------------------------------------------------------
# 승인 계열 (#1042 최초 등재분)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 로스터 · 채널
# ---------------------------------------------------------------------------
sample roster get "/v1/workspaces/{workspaceId}/roster" \
  "/v1/workspaces/$WS/roster" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MEMBER_ID" 'any(.members[]; (.id | ascii_downcase) == $id)' \
  "roster contains the gate member"
sample members-alias get "/v1/workspaces/{workspaceId}/members" \
  "/v1/workspaces/$WS/members" 200 "" "$ACCESS"

sample channels-list get "/v1/workspaces/{workspaceId}/channels" \
  "/v1/workspaces/$WS/channels" 200 "" "$ACCESS"
guard_jq --arg id "$GENERAL_CHANNEL_ID" 'any(.channels[]; (.id | ascii_downcase) == $id)' \
  "channel list contains #general"

sample channel-create post "/v1/workspaces/{workspaceId}/channels" \
  "/v1/workspaces/$WS/channels" 201 \
  "$(jq -cn --arg n "rust-gate-$RUN_EPOCH" \
      '{kind:"public",name:$n,topic:"openapi rust sample pass"}')" "$ACCESS"
GATE_CHANNEL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.channel.id')"

# 갓 만든 채널에 건다 — #general 의 상태를 게이트가 바꾸면 뒤따르는 read-state
# 표본이 자기가 만든 부작용을 읽게 된다.
sample notification-pref put \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/notification-pref" \
  "/v1/workspaces/$WS/channels/$GATE_CHANNEL_ID/notification-pref" 200 \
  '{"muted":true}' "$ACCESS"
guard_jq '.muted == true' "notification preference echoes the effective mute state"

# ---------------------------------------------------------------------------
# 메시지 · 스레드 · 반응 · 고정 · 검색 · 읽음
# ---------------------------------------------------------------------------
sample message-send post \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages" 201 \
  "$(jq -cn --arg c "$(lower_uuid)" \
      '{clientMsgId:$c,body:"openapi rust sample pass"}')" "$ACCESS"
GATE_MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"

sample message-history get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages?limit=50" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MESSAGE_ID" 'any(.messages[]; (.id | ascii_downcase) == $id)' \
  "history projects the message that was just sent"
GATE_MESSAGE_SEQ="$(printf '%s' "$RESPONSE_BODY" \
  | jq -er --arg id "$GATE_MESSAGE_ID" '.messages[] | select((.id|ascii_downcase) == $id) | .seq')"

# 답글은 같은 쓰기 경로를 `rootId` 로 부를 뿐 두 번째 경로가 아니다 — 그래서
# 표본이 아니라 스레드 읽기의 전제다.
expect thread-root post "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages" 201 \
  "$(jq -cn --arg c "$(lower_uuid)" --arg r "$GATE_MESSAGE_ID" \
      '{clientMsgId:$c,rootId:$r,body:"openapi rust sample reply"}')" "$ACCESS"

sample thread-replies get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages/{rootId}/replies" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages/$GATE_MESSAGE_ID/replies?limit=50" \
  200 "" "$ACCESS"
guard_jq --arg root "$GATE_MESSAGE_ID" \
  '(.messages | length) >= 1 and all(.messages[]; (.rootId | ascii_downcase) == $root)' \
  "thread page carries only replies of the requested root"

sample message-edit patch "/v1/workspaces/{workspaceId}/messages/{messageId}" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID" 200 \
  '{"body":"openapi rust sample pass (edited)"}' "$ACCESS"
guard_jq '.state == "edited"' "edit records the tombstone-free edited state"

# 이모지는 경로 세그먼트라 퍼센트 인코딩해 보낸다(👍 = U+1F44D).
THUMBS_UP="%F0%9F%91%8D"
sample reaction-add put \
  "/v1/workspaces/{workspaceId}/messages/{messageId}/reactions/{emoji}" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID/reactions/$THUMBS_UP" 200 "" "$ACCESS"
# `ReactionDelta` 는 고정 델타와 달리 `changed` 를 싣지 않는다(스펙 required 4개).
# 그러니 여기서 볼 수 있는 사실은 「어느 멤버가 어느 메시지에 무엇을 달았나」다.
guard_jq --arg id "$GATE_MESSAGE_ID" --arg m "$GATE_MEMBER_ID" \
  '.action == "added" and (.messageId | ascii_downcase) == $id
   and (.memberId | ascii_downcase) == $m and .emoji == "👍"' \
  "the add delta names the member, the message and the emoji"

sample reaction-snapshot get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/reactions" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/reactions" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MESSAGE_ID" \
  'to_entries | map(select((.key | ascii_downcase) == $id)) | length == 1' \
  "reaction snapshot carries the reacted message"

sample reaction-remove delete \
  "/v1/workspaces/{workspaceId}/messages/{messageId}/reactions/{emoji}" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID/reactions/$THUMBS_UP" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MESSAGE_ID" \
  '.action == "removed" and (.messageId | ascii_downcase) == $id and .emoji == "👍"' \
  "the remove delta names the same reaction"

sample pin-add put "/v1/workspaces/{workspaceId}/messages/{messageId}/pin" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID/pin" 200 "" "$ACCESS"
guard_jq '.action == "pinned" and .changed == true' "first pin is a change"

sample pin-list get "/v1/workspaces/{workspaceId}/channels/{channelId}/pins" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/pins" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MESSAGE_ID" \
  'any(.pins[]; (.messageId | ascii_downcase) == $id)' \
  "pin list carries the pinned message"

sample pin-remove delete "/v1/workspaces/{workspaceId}/messages/{messageId}/pin" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID/pin" 200 "" "$ACCESS"
guard_jq '.action == "unpinned" and .changed == true' "unpinning is a change"

sample message-search get "/v1/workspaces/{workspaceId}/search/messages" \
  "/v1/workspaces/$WS/search/messages?q=openapi&limit=20" 200 "" "$ACCESS"
guard_jq '(.hits | length) >= 1' "search finds the messages this run wrote"

sample read-state-put put \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/read-state" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/read-state" 200 \
  "$(jq -cn --argjson s "$GATE_MESSAGE_SEQ" '{last_read_seq:$s}')" "$ACCESS"
guard_jq --argjson s "$GATE_MESSAGE_SEQ" '.last_read_seq == $s' \
  "read cursor records the requested seq"

sample read-state-list get "/v1/workspaces/{workspaceId}/read-state" \
  "/v1/workspaces/$WS/read-state" 200 "" "$ACCESS"
guard_jq --arg id "$GENERAL_CHANNEL_ID" \
  'any(.read_states[]; (.channel_id | ascii_downcase) == $id)' \
  "read-state projection contains #general"

# 삭제는 마지막이다 — 위의 모든 표본이 이 메시지를 필요로 한다.
sample message-delete delete "/v1/workspaces/{workspaceId}/messages/{messageId}" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID" 200 "" "$ACCESS"
guard_jq '.state == "deleted"' "delete leaves a tombstone, not a hole"

# ---------------------------------------------------------------------------
# DM · 가입
# ---------------------------------------------------------------------------
sample dm-open post "/v1/workspaces/{workspaceId}/dms" \
  "/v1/workspaces/$WS/dms" 201 \
  "$(jq -cn --arg m "$GATE_PEER_ID" '{memberId:$m}')" "$ACCESS"
guard_jq '.created == true and .channel.kind == "dm"' "first open creates the DM"

# 같은 쌍을 다시 열면 200 이다. 두 상태코드는 서로 다른 문장이라 둘 다 대조한다.
sample dm-reopen post "/v1/workspaces/{workspaceId}/dms" \
  "/v1/workspaces/$WS/dms" 200 \
  "$(jq -cn --arg m "$GATE_PEER_ID" '{memberId:$m}')" "$ACCESS"
guard_jq '.created == false' "reopening the same pair is idempotent"

sample dms-list get "/v1/workspaces/{workspaceId}/dms" \
  "/v1/workspaces/$WS/dms" 200 "" "$ACCESS"
guard_jq '(.channels | length) >= 1' "DM list contains the opened conversation"

sample join post "/v1/join" "/v1/join" 201 \
  "$(jq -cn --arg c "$INVITE_CODE" --arg e "$JOIN_EMAIL" --arg p "$JOIN_PASSWORD" \
      --arg h "$JOIN_HANDLE" \
      '{code:$c,email:$e,password:$p,displayName:"OpenAPI Rust Gate Join",
        handle:$h,timeZone:"UTC"}')"
guard_jq --arg ws "$WS" '(.workspaceId | ascii_downcase) == $ws
  and (.accessToken | type == "string")' \
  "join mints a member of the invited workspace"

# ---------------------------------------------------------------------------
# provider(자격증명 없는 읽기) · tier 정책
# ---------------------------------------------------------------------------
sample provider-effort-table get "/v1/provider/effort-table" \
  "/v1/provider/effort-table" 200 "" "$ACCESS"
guard_jq '.schema == "momo.provider.effort_table.v0" and (.levels | length) > 0' \
  "effort table projects the canonical level superset"

# 두 정책 다 `ask` 로 둔다 — `auto` 는 아래 resume 표본을 한 호스트에 못 박아
# 무관한 호스트 변경을 가짜 드리프트로 만든다(1차 패스와 같은 이유).
sample work-tier-policy-get get "/v1/workspaces/{workspaceId}/work-tier-policy" \
  "/v1/workspaces/$WS/work-tier-policy" 200 "" "$ACCESS"
sample work-tier-policy-put put "/v1/workspaces/{workspaceId}/work-tier-policy" \
  "/v1/workspaces/$WS/work-tier-policy" 200 '{"mode":"ask"}' "$ACCESS"
guard_jq '.workTierPolicy.mode == "ask"' "workspace default records the ask policy"
sample work-tier-policy-me-get get "/v1/workspaces/{workspaceId}/work-tier-policy/me" \
  "/v1/workspaces/$WS/work-tier-policy/me" 200 "" "$ACCESS"
sample work-tier-policy-me-put put "/v1/workspaces/{workspaceId}/work-tier-policy/me" \
  "/v1/workspaces/$WS/work-tier-policy/me" 200 '{"mode":"ask"}' "$ACCESS"
guard_jq '.workTierPolicy.mode == "ask" and .workTierPolicy.inherited == false' \
  "member override stops inheriting the workspace default"

# ---------------------------------------------------------------------------
# 에이전트 — 초대·프로필·정지·모델 어휘, 그리고 사람의 「멈춰라」
# ---------------------------------------------------------------------------
sample agent-create post "/v1/workspaces/{workspaceId}/agents" \
  "/v1/workspaces/$WS/agents" 201 \
  "$(jq -cn --arg h "rust-gate-created-$RUN_EPOCH" \
      '{displayName:"OpenAPI Rust Gate Created",handle:$h,model:"hermes-agent",
        baseUrl:"https://hermes.openapi.example.test/v1",
        systemPrompt:"openapi rust sample pass"}')" "$ACCESS"
guard_jq --arg h "rust-gate-created-$RUN_EPOCH" '.agent.handle == $h' \
  "agent creation returns the created member identity"

# PUT 이 먼저다: `agent_profile` 행은 이 쓰기가 만들고, GET 도 pause 도 그 행이
# 없으면 404 다.
sample agent-profile-put put \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/profile" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/profile" 200 \
  '{"instructions":"openapi rust sample pass"}' "$ACCESS"
sample agent-profile-get get \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/profile" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/profile" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_AGENT_ID" '(.profile.agentMemberId | ascii_downcase) == $id' \
  "profile read answers for the agent that was named"
sample agent-pause put "/v1/workspaces/{workspaceId}/agents/{agentId}/pause" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/pause" 200 '{"paused":false}' "$ACCESS"
guard_jq '.profile.paused == false' "pause write returns the effective state"
sample agent-allowed-models get \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/allowed-models" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/allowed-models" 200 "" "$ACCESS"
guard_jq '(.allowedAgentModels | length) >= 1' "picker vocabulary is non-empty"

sample agent-run-cancel post \
  "/v1/workspaces/{workspaceId}/agent-runs/{runId}/cancel" \
  "/v1/workspaces/$WS/agent-runs/$CANCEL_RUN_UUID/cancel" 200 "" "$ACCESS"
guard_jq '.status == "cancelled"' "a person's stop ends the run"

# ---------------------------------------------------------------------------
# work host 레지스트리 — 등록 · 서명 하트비트 · 폴링 목록
# ---------------------------------------------------------------------------
sample work-host-register post "/v1/workspaces/{workspaceId}/work-hosts" \
  "/v1/workspaces/$WS/work-hosts" 201 \
  "$(jq -cn --arg key "$HOST_PUBLIC_KEY" \
      '{scope:"member",type:"app",displayName:"OpenAPI rust gate host",publicKey:$key,
        capabilities:{"tool.codex":true}}')" "$ACCESS"
WORK_HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id')"

sample work-host-heartbeat post \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}/heartbeat" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID/heartbeat" 200 \
  "$(heartbeat_body "$WORK_HOST_ID")"
guard_jq '.workHost.online == true and (.workHost.lastSeenAtMs | type == "number")' \
  "signed heartbeat marks the host online"

sample work-host-list get "/v1/workspaces/{workspaceId}/work-hosts" \
  "/v1/workspaces/$WS/work-hosts" 200 "" "$ACCESS"
guard_jq --arg host "$(printf '%s' "$WORK_HOST_ID" | tr '[:upper:]' '[:lower:]')" \
  'any(.workHosts[]; (.id | ascii_downcase) == $host and .online == true)' \
  "polling list contains the signed-online host"

# 데몬의 첫 폴링: 아직 아무 지시도 없다. 빈 목록도 왕복이고, 무엇보다 이 서명
# 경로가 열려 있다는 증거다(#1143 이 연 자리).
work_host_signed_sample work-host-pending-controls-empty get \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}/pending-controls" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID/pending-controls" 200 \
  "$WORK_HOST_ID" "$HOST_KEY"
guard_jq '.workControls == []' "a fresh host has nothing dispatched to it"

# ---------------------------------------------------------------------------
# work session 원장 — 생성 · 활성 목록 · 소유자의 종료
# ---------------------------------------------------------------------------
sample work-session-create post "/v1/workspaces/{workspaceId}/work-sessions" \
  "/v1/workspaces/$WS/work-sessions" 201 \
  "$(jq -cn --arg ch "$GENERAL_CHANNEL_ID" --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,hostId:$host,tool:"codex",label:"OpenAPI rust gate"}')" "$ACCESS"
WORK_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"

sample work-session-list get "/v1/workspaces/{workspaceId}/work-sessions" \
  "/v1/workspaces/$WS/work-sessions?active=1" 200 "" "$ACCESS"
guard_jq --arg id "$(printf '%s' "$WORK_SESSION_ID" | tr '[:upper:]' '[:lower:]')" \
  'any(.workSessions[]; (.id | ascii_downcase) == $id and .status == "running")' \
  "active list contains the created session"

sample work-session-end patch \
  "/v1/workspaces/{workspaceId}/work-sessions/{workSessionId}" \
  "/v1/workspaces/$WS/work-sessions/$WORK_SESSION_ID" 200 \
  '{"status":"ended","exitCode":0}' "$ACCESS"
guard_jq '.workSession.status == "ended" and .workSession.exitCode == 0' \
  "the session ends with an exit status"

# ---------------------------------------------------------------------------
# work control 원장 (#1132) + 서명 데몬 폐곡선 (#1143)
#
# 다섯 연산이 한 문장으로 이어진다: 사람이 도구를 미리 허가하고 → 에이전트가
# 자기 bearer 로 spawn 을 요청하면 카드 없이 dispatched 가 되고 → **데몬이**
# 자기 서명으로 그 지시를 읽고 → 자기 서명으로 「실행했다」를 보고한다.
# ack 의 자격증명이 요청자와 다른 것이 요점이다 — 요청과 보고를 한 자격증명이
# 다 하면 호스트가 본 적 없는 세션을 있다고 보고할 수 있다.
# ---------------------------------------------------------------------------
sample work-auto-approval-enable put \
  "/v1/workspaces/{workspaceId}/work-auto-approvals/{tool}" \
  "/v1/workspaces/$WS/work-auto-approvals/codex" 200 "" "$ACCESS"
guard_jq '.tool == "codex" and .enabled == true' "auto-approval enables codex"

sample work-auto-approvals-list get \
  "/v1/workspaces/{workspaceId}/work-auto-approvals" \
  "/v1/workspaces/$WS/work-auto-approvals" 200 "" "$ACCESS"
guard_jq '(.tools | index("codex")) != null' "the snapshot contains the enabled tool"

sample work-control-create post "/v1/workspaces/{workspaceId}/work-controls" \
  "/v1/workspaces/$WS/work-controls" 201 \
  "$(jq -cn --arg ch "$GENERAL_CHANNEL_ID" --arg run "$CONTROL_RUN_UUID" \
      --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,runId:$run,targetHostId:$host,kind:"spawn",
        payload:{tool:"codex",label:"OpenAPI rust control"}}')" "$GATE_AGENT_TOKEN"
WORK_CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id')"
guard_jq '.workControl.kind == "spawn" and .workControl.status == "dispatched"' \
  "a pre-authorised spawn dispatches without a card"

# ack 이 묶을 세션. `spawn_ack_session_matches_in_tx` 는 요청자가 에이전트일 때
# **그 에이전트의 owner human 이 소유한** running 세션만 받으므로, 게이트 사람이
# 같은 채널·같은 호스트로 여는 이 세션이 정확히 그 행이다. 표본이 아니라 전제다
# (POST …/work-sessions 는 이미 위에서 등재됐다).
expect ack-session post "/v1/workspaces/$WS/work-sessions" 201 \
  "$(jq -cn --arg ch "$GENERAL_CHANNEL_ID" --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,hostId:$host,tool:"codex",label:"OpenAPI rust control"}')" "$ACCESS"
ACK_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"

work_host_signed_sample work-host-pending-controls get \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}/pending-controls" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID/pending-controls" 200 \
  "$WORK_HOST_ID" "$HOST_KEY"
guard_jq --arg id "$(printf '%s' "$WORK_CONTROL_ID" | tr '[:upper:]' '[:lower:]')" \
  'any(.workControls[]; (.id | ascii_downcase) == $id and .status == "dispatched")' \
  "the daemon reads the instruction addressed to it"

work_host_signed_sample work-control-ack post \
  "/v1/workspaces/{workspaceId}/work-controls/{workControlId}/ack" \
  "/v1/workspaces/$WS/work-controls/$WORK_CONTROL_ID/ack" 200 \
  "$WORK_HOST_ID" "$HOST_KEY" \
  "$(jq -cn --arg session "$ACK_SESSION_ID" '{ok:true,sessionId:$session}')"
guard_jq --arg session "$(printf '%s' "$ACK_SESSION_ID" | tr '[:upper:]' '[:lower:]')" \
  '.workControl.status == "acked" and (.workControl.sessionId | ascii_downcase) == $session' \
  "the signing host binds the session it actually opened"

sample work-auto-approval-disable delete \
  "/v1/workspaces/{workspaceId}/work-auto-approvals/{tool}" \
  "/v1/workspaces/$WS/work-auto-approvals/codex" 200 "" "$ACCESS"
guard_jq '.tool == "codex" and .enabled == false' "auto-approval disables codex"

expect ack-session-end patch "/v1/workspaces/$WS/work-sessions/$ACK_SESSION_ID" 200 \
  '{"status":"ended","exitCode":0}' "$ACCESS"

# ---------------------------------------------------------------------------
# resume — 고아가 된 세션만 다른 호스트에서 이어진다
#
# `orphaned` 를 만드는 것은 호스트 유실 sweep(NotifierWorker)이고 이 부분집합은
# 그 프로필을 띄우지 않는다. 그래서 전제만 SQL 로 심고 resume 자체는 실 HTTP 다
# — 1차 패스가 같은 자리에서 하는 것과 같은 분업이다.
# ---------------------------------------------------------------------------
expect resume-source post "/v1/workspaces/$WS/work-sessions" 201 \
  "$(jq -cn --arg ch "$GENERAL_CHANNEL_ID" --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,hostId:$host,tool:"codex",label:"OpenAPI rust resume source"}')" \
  "$ACCESS"
RESUME_SOURCE_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"

# 이어받을 호스트는 소스와 **달라야** 한다(resume_target_rejection_in_tx).
expect resume-target-host post "/v1/workspaces/$WS/work-hosts" 201 \
  "$(jq -cn --arg key "$HOST_PUBLIC_KEY" \
      '{scope:"member",type:"app",displayName:"OpenAPI rust gate host 2",publicKey:$key,
        capabilities:{"tool.codex":true}}')" "$ACCESS"
RESUME_HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id')"
expect resume-target-heartbeat post \
  "/v1/workspaces/$WS/work-hosts/$RESUME_HOST_ID/heartbeat" 200 \
  "$(heartbeat_body "$RESUME_HOST_ID")"

run_sql <<SQL
UPDATE work_session SET status = 'orphaned', idle_at = NULL
 WHERE workspace_id = '$WS' AND id = '$RESUME_SOURCE_SESSION_ID';
SQL

sample work-session-resume post \
  "/v1/workspaces/{workspaceId}/work-sessions/{workSessionId}/resume" \
  "/v1/workspaces/$WS/work-sessions/$RESUME_SOURCE_SESSION_ID/resume" 201 \
  "$(jq -cn --arg host "$RESUME_HOST_ID" '{targetHostId:$host}')" "$ACCESS"
guard_jq --arg source "$(printf '%s' "$RESUME_SOURCE_SESSION_ID" | tr '[:upper:]' '[:lower:]')" \
  '.workSession.status == "running"
   and (.workSession.resumedFromSessionId | ascii_downcase) == $source' \
  "resume opens a new Run with durable lineage"
RESUMED_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"
expect resumed-session-end patch "/v1/workspaces/$WS/work-sessions/$RESUMED_SESSION_ID" 200 \
  '{"status":"ended","exitCode":0}' "$ACCESS"

# 해지는 마지막이다: 해지된 호스트는 서명할 수도, 폴링될 수도 없다.
sample work-host-revoke delete \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}" \
  "/v1/workspaces/$WS/work-hosts/$RESUME_HOST_ID" 200 "" "$ACCESS"
guard_jq '.workHost.online == false and (.workHost.revokedAtMs | type == "number")' \
  "a revoked host is durably offline"

# 로그아웃은 자기가 쓴 자격증명을 죽이므로 정말 마지막이다.
sample logout post "/v1/auth/logout" "/v1/auth/logout" 200 \
  "$(jq -cn --arg r "$REFRESH" '{refreshToken:$r}')" "$ACCESS"
guard_jq '.status == "ok" and .revokedAccess == true' "logout revokes the presented pair"

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
