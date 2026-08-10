#!/usr/bin/env bash
# =============================================================================
# scripts/verify_webhook_rust.sh — #1222 (T13) 웹훅·이벤트구독 Rust 런타임 검증기
#
# 기존 `verify_event_subscription.sh` 는 **Swift** 스택을 띄운다
# (`infra/docker-compose.e2e.yml:287` = `swift:6.2` relay). 이 파일은 같은 폐곡선을
# **Rust** 구현에 대고 잰다. 둘은 OutboxRelay 삭제(W-S)까지 공존한다.
#
# 폐곡선:
#   설치      실제 REST 8연산 (webhook_admin_conformance_pg)
#   발생      033 mention 트리거 → outbox 행
#   전송      sender 1회 drain → 실제 소켓 POST → 실제 수신기
#   서명검증  수신기가 HMAC-SHA256("<ts>." || body) 를 독립 재계산
#   감사행    record_event_subscription_delivery 1행 (본문 없음·호스트만)
#   재시도    5xx → backoff → 실패 원장 → 임계치 자동 disable
#
# red proof (제품 소스를 실제로 깨고 빨강을 확인한 뒤 되돌린다):
#   WEBHOOK_RUST_PROVE_RED_AUDIT=1   #1204 감사 기록 제거 → 감사 단정 FAIL
#   WEBHOOK_RUST_PROVE_RED_SIGNATURE=1  서명에서 timestamp 제거 → 서명 단정 FAIL
# 둘 다 "expected FAIL" 이며, 초록이 나오면 그 단정이 아무것도 재고 있지 않다는 뜻이므로
# 이 스크립트가 실패로 보고한다.
#
# Docker 실행은 오케스트레이터 몫이다. 워커는 `bash -n` 만 돌린다.
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[webhook-rust] missing required command: $1" >&2
    exit 1
  }
}
need docker
need cargo

if command -v psql >/dev/null 2>&1; then
  PSQL_DIR="$(dirname "$(command -v psql)")"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_DIR=/opt/homebrew/opt/libpq/bin
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_DIR=/usr/local/opt/libpq/bin
else
  echo "[webhook-rust] psql not found; install the PostgreSQL 18 client / libpq." >&2
  exit 1
fi
export PATH="$PSQL_DIR:$PATH"

# 프로젝트 접두는 고정이다: 이 스택은 다른 워크트리의 볼륨을 절대 건드리지 않는다.
PROJECT="${WEBHOOK_RUST_PROJECT:-w1222-webhook-verify}"
PG_CONTAINER="${PROJECT}-pg"
PG_PORT="${WEBHOOK_RUST_PG_PORT:-24522}"
PG_IMAGE="pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e"
KEEP_STACK="${WEBHOOK_RUST_KEEP_STACK:-0}"

reclaim() {
  if [ "$KEEP_STACK" = "1" ]; then
    echo "[webhook-rust] keeping ${PG_CONTAINER} (WEBHOOK_RUST_KEEP_STACK=1)"
    return
  fi
  echo "[webhook-rust] reclaiming ${PG_CONTAINER} (container + volume)"
  docker rm -f -v "$PG_CONTAINER" >/dev/null 2>&1 || true
}

# 소스를 되돌리는 것은 어떤 경로로 빠져나가든 반드시 일어나야 한다.
RESTORE_LIST=()
restore_sources() {
  local entry file backup
  for entry in "${RESTORE_LIST[@]:-}"; do
    [ -n "$entry" ] || continue
    file="${entry%%::*}"
    backup="${entry##*::}"
    cp "$backup" "$file"
    rm -f "$backup"
    echo "[webhook-rust] restored $file"
  done
  RESTORE_LIST=()
}
trap 'restore_sources; reclaim' EXIT INT TERM

patch_source() {
  # patch_source <file> <python-replacement-snippet-file>
  local file="$1" snippet="$2" backup
  backup="$(mktemp)"
  cp "$file" "$backup"
  RESTORE_LIST+=("${file}::${backup}")
  python3 "$snippet" "$file"
}

start_pg() {
  docker rm -f -v "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" \
    --label com.momo.janitor.managed=true \
    -e POSTGRES_DB=momo -e POSTGRES_USER=momo -e POSTGRES_PASSWORD=momo \
    -p "127.0.0.1:${PG_PORT}:5432" \
    "$PG_IMAGE" >/dev/null
  local attempt
  for attempt in $(seq 1 60); do
    : "$attempt"
    if docker exec "$PG_CONTAINER" pg_isready -U momo -d momo >/dev/null 2>&1; then
      echo "[webhook-rust] postgres ready on 127.0.0.1:${PG_PORT}"
      return 0
    fi
    sleep 1
  done
  echo "[webhook-rust] postgres did not become ready" >&2
  return 1
}

export DATABASE_URL="postgres://momo:momo@127.0.0.1:${PG_PORT}/momo"

run_suites() {
  ( cd server-rust && cargo test -p momo-server --test webhook_admin_conformance_pg \
      -- --ignored --test-threads=1 ) || return 1
  ( cd server-rust && cargo test -p momo-webhook-sender --test webhook_delivery_conformance_pg \
      -- --include-ignored --test-threads=1 ) || return 1
  ( cd server-rust && cargo test -p momo-webhook ) || return 1
  return 0
}

# ---- red proof snippets ------------------------------------------------------
RED_AUDIT_SNIPPET="$(mktemp)"
cat >"$RED_AUDIT_SNIPPET" <<'PY'
import sys
path = sys.argv[1]
source = open(path).read()
needle = """        if let Some(status) = result.delivered_status() {"""
assert needle in source, "red-proof anchor moved; update verify_webhook_rust.sh"
source = source.replace(needle, """        if false {""", 1)
open(path, "w").write(source)
PY

RED_SIGNATURE_SNIPPET="$(mktemp)"
cat >"$RED_SIGNATURE_SNIPPET" <<'PY'
import sys
path = sys.argv[1]
source = open(path).read()
needle = """    mac.update(timestamp.as_bytes());
    mac.update(b".");
"""
assert needle in source, "red-proof anchor moved; update verify_webhook_rust.sh"
source = source.replace(needle, "", 1)
open(path, "w").write(source)
PY
# shellcheck disable=SC2064
trap "rm -f '$RED_AUDIT_SNIPPET' '$RED_SIGNATURE_SNIPPET'; restore_sources; reclaim" EXIT INT TERM

SENDER_LIB="server-rust/bins/momo-webhook-sender/src/lib.rs"
CRYPTO="server-rust/crates/momo-webhook/src/crypto.rs"

start_pg

if [ "${WEBHOOK_RUST_PROVE_RED_AUDIT:-0}" = "1" ]; then
  echo "[webhook-rust] RED PROOF: removing the #1204 egress audit write (expected FAIL)"
  patch_source "$SENDER_LIB" "$RED_AUDIT_SNIPPET"
  if run_suites; then
    echo "[webhook-rust] FAIL — the suites stayed green with the audit removed;" >&2
    echo "               the #1204 assertions are not measuring anything." >&2
    exit 1
  fi
  echo "[webhook-rust] PASS — the audit assertions went red as required."
  exit 0
fi

if [ "${WEBHOOK_RUST_PROVE_RED_SIGNATURE:-0}" = "1" ]; then
  echo "[webhook-rust] RED PROOF: dropping the timestamp from the delivery signature (expected FAIL)"
  patch_source "$CRYPTO" "$RED_SIGNATURE_SNIPPET"
  if run_suites; then
    echo "[webhook-rust] FAIL — the suites stayed green with an unbound timestamp;" >&2
    echo "               the signature assertions are not measuring anything." >&2
    exit 1
  fi
  echo "[webhook-rust] PASS — the signature assertions went red as required."
  exit 0
fi

echo "[webhook-rust] running the #1222 closed loop against ${DATABASE_URL%%:*}…"
run_suites
echo "[webhook-rust] PASS — 설치·전송·서명검증·감사행·재시도·자동disable 폐곡선 그린."
