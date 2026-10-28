#!/usr/bin/env bash
# =============================================================================
# 야간 시험 실행기 (#4707) — cargo 가 시험 실행 파일마다 `이 스크립트 <실행 파일> <인자…>` 로 부른다
# (`CARGO_TARGET_<TRIPLE>_RUNNER`, scripts/security_pack.sh nightly 가 건다). infra/security-pack/ 아래라
# 이 파일만 고쳐도 PR CI 의 Rust 레인(Security pack 잡)이 켜져 scripts/tests/test_security_pack.sh 가 돈다.
#
# 왜: 야간 전량 실행은 273개 실행 파일을 **한 DB** 에서 차례로 돌렸다. 앞 타깃이 남긴 것(대기 작업 큐·DDL 찌꺼기·
#   테이블 팽창)이 뒤 타깃을 깨서, 시험 하나의 잘못이 다른 패키지의 빨강으로 나타났다(probe_3162 →
#   tenant_catalog_pg 5개, 남은 에이전트 작업 → remote_host_r0 3개, token 팽창 → member_sweep_lock_order_pg).
#
# 무엇: 실행 파일에 `#[ignore]` 시험이 있으면 **그 실행 파일만의 새 DB**(마이그레이션·역할 준비가 끝난 템플릿의
#   복제)를 DATABASE_URL·PGDATABASE 로 주고, 끝나면(실패·중단 포함) 지운다. `#[ignore]` 시험이 없는 실행 파일은
#   그대로 실행한다. 출력·종료 코드는 건드리지 않는다(cargo 의 보고·요약 파서가 그대로 읽는다).
#
# 환경: NIGHTLY_DB_TEMPLATE(템플릿 DB 이름, 필수) · DATABASE_URL(슈퍼유저 URL) · PSQL_BIN(선택).
#   PGUSER·PGPASSWORD·PGHOST·PGPORT 는 호출자가 이미 export 했다(security_pack.sh export_pg_env).
# =============================================================================
set -uo pipefail

err() { echo "[nightly-target-db] $*" >&2; }

[ "$#" -ge 1 ] || { err "usage: nightly-target-db.sh <시험 실행 파일> [인자…]"; exit 2; }
exe="$1"; shift
[ -n "${NIGHTLY_DB_TEMPLATE:-}" ] || { err "NIGHTLY_DB_TEMPLATE 이 필요해요"; exit 2; }
[ -n "${DATABASE_URL:-}" ] || { err "DATABASE_URL 이 필요해요"; exit 2; }
psql_cmd="${PSQL_BIN:-psql}"

# `#[ignore]` 시험이 하나도 없으면 DB 가 필요 없다(단위 시험·DB 없는 통합 시험). **목록 출력만** 보고 판단한다 —
# 일부 실행 파일은 `--list` 에도 0 이 아닌 코드로 끝난다(tenant_catalog_pg 는 시험 38개를 찍고 101). 종료 코드를
# 따지면(pipefail) 그런 실행 파일이 "시험 없음"으로 오판돼 새 DB 없이 공용 DB 에서 돈다.
listing="$("$exe" --list --ignored 2>/dev/null || true)"
if ! grep -Eq ': test$' <<<"$listing"; then
  exec "$exe" "$@"
fi

# DATABASE_URL = postgres://사용자:비밀번호@호스트:포트/DB[?옵션] → 같은 접속에서 DB 이름만 바꾼 URL.
base="${DATABASE_URL%%\?*}"
query="${DATABASE_URL#"$base"}"
root="${base%/*}"
url_for() { printf '%s/%s%s' "$root" "$1" "$query"; }
admin() { "$psql_cmd" "$(url_for postgres)" -qAt -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }

name="nt_$(date +%s)_$$"
cleanup() { admin "DROP DATABASE IF EXISTS \"$name\" WITH (FORCE)" 2>/dev/null || err "새 DB 를 못 지웠어요: $name"; }
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

tries=0
until admin "CREATE DATABASE \"$name\" TEMPLATE \"$NIGHTLY_DB_TEMPLATE\""; do
  tries=$((tries + 1))
  [ "$tries" -lt 3 ] || { err "템플릿 복제에 실패했어요: $NIGHTLY_DB_TEMPLATE → $name"; exit 99; }
  sleep 1
done

export DATABASE_URL="$(url_for "$name")" PGDATABASE="$name"
"$exe" "$@"
exit $?
