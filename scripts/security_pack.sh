#!/usr/bin/env bash
# =============================================================================
# scripts/security_pack.sh — 공개 CI 「Security pack」 레인 (#4241, SEC-03)
#
#   lint      DB 없이: 선택 목록(infra/security-pack/selection.txt)이 실제 시험을 가리키는지
#             (파일 존재·#[ignore] 존재·여섯 영역 모두 ≥1·중복 없음). 빈 선택이 초록이 되는 것을 막는다.
#   list      선택된 `패키지 타깃` 쌍을 출력.
#   setup     DATABASE_URL(슈퍼유저)에 마이그레이션 + bootstrap_roles.sql 적용.
#   run       선택 시험을 `--ignored --test-threads=1` 로 실행. 타깃마다 `N passed`(N>0)·failed 0 을 요구한다.
#   negative  일회용 DB 에 FORCE 없는 테넌트 테이블 픽스처를 얹고 tenant_catalog_pg 가
#             **그 테이블을 이름으로 지목하며** 빨강인지 확인한다(다른 이유의 빨강은 실패).
#   nightly   선택 밖 PG 시험까지 전부(`--workspace --ignored`) — 야간 잡용.
#
# 환경: SECURITY_PACK_SELECTION(기본 infra/security-pack/selection.txt),
#       SECURITY_PACK_ROOT(기본 레포 루트, 시험 편의), SECURITY_PACK_OUT(로그 디렉터리),
#       DATABASE_URL, PSQL_BIN. 시크릿은 출력하지 않는다(DB URL은 로그에 안 찍는다).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="${SECURITY_PACK_ROOT:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}"
SELECTION="${SECURITY_PACK_SELECTION:-$ROOT/infra/security-pack/selection.txt}"
OUT="${SECURITY_PACK_OUT:-${TMPDIR:-/tmp}/security-pack}"
MANIFEST="$ROOT/server-rust/Cargo.toml"
REQUIRED_DOMAINS="tenant-isolation auth approval push attachment webhook"
NEG_TABLE="sec03_negative_unforced"

die() { echo "[security-pack] $*" >&2; exit 1; }

# 선택 목록의 유효 줄(`영역 패키지 타깃`)만.
entries() { grep -Ev '^[[:space:]]*(#|$)' "$SELECTION"; }

# 패키지 이름 → 크레이트 디렉터리 (server-rust 아래 Cargo.toml 의 name 으로 찾는다).
package_dir() {
  local pkg="$1" f
  for f in "$ROOT"/server-rust/bins/*/Cargo.toml "$ROOT"/server-rust/crates/*/Cargo.toml; do
    [ -e "$f" ] || continue
    if grep -Eq "^name[[:space:]]*=[[:space:]]*\"$pkg\"" "$f"; then
      dirname "$f"; return 0
    fi
  done
  return 1
}

cmd_lint() {
  [ -f "$SELECTION" ] || die "선택 목록이 없어요: $SELECTION"
  local seen="" domains="" n=0 domain pkg test dir file key
  while read -r domain pkg test extra; do
    [ -z "${extra:-}" ] || die "열이 3개를 넘어요: $domain $pkg $test $extra"
    [ -n "$test" ] || die "열이 모자라요: '$domain $pkg'"
    case " $REQUIRED_DOMAINS " in *" $domain "*) ;; *) die "알 수 없는 영역: $domain" ;; esac
    key="$pkg/$test"
    case " $seen " in *" $key "*) die "중복 항목: $key" ;; esac
    seen="$seen $key"
    dir="$(package_dir "$pkg")" || die "패키지를 찾을 수 없어요: $pkg"
    file="$dir/tests/$test.rs"
    [ -f "$file" ] || die "시험 파일이 없어요: ${file#"$ROOT"/}"
    # `--ignored` 로 0개를 돌리고 초록이 되는 것을 막는다.
    grep -Eq '#\[ignore' "$file" || die "#[ignore] 시험이 없어요(--ignored 가 0개를 실행해요): ${file#"$ROOT"/}"
    case " $domains " in *" $domain "*) ;; *) domains="$domains $domain" ;; esac
    n=$((n + 1))
  done < <(entries)
  for domain in $REQUIRED_DOMAINS; do
    case " $domains " in *" $domain "*) ;; *) die "영역에 시험이 하나도 없어요: $domain" ;; esac
  done
  echo "[security-pack] lint OK: ${n}개 타깃, 영역 6/6"
}

cmd_list() { entries | while read -r _d pkg test; do echo "$pkg $test"; done; }

psql_bin() {
  if [ -n "${PSQL_BIN:-}" ]; then echo "$PSQL_BIN"; elif command -v psql >/dev/null 2>&1; then command -v psql; else die "psql 이 없어요"; fi
}

# $1 = 대상 DB URL. 마이그레이션 + 역할 부트스트랩.
setup_db() {
  local url="$1" psql
  psql="$(psql_bin)"
  DATABASE_URL="$url" PSQL_BIN="$psql" sh "$ROOT/scripts/migrate.sh"
  "$psql" "$url" -v ON_ERROR_STOP=1 -q -f "$ROOT/infra/rust/sql/bootstrap_roles.sql"
}

cmd_setup() {
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL(슈퍼유저)이 필요해요"
  setup_db "$DATABASE_URL"
}

# 일부 시험은 사설 PG 클라이언트(psql)를 PGHOST·PGPORT·PGUSER·PGPASSWORD·PGDATABASE 로 띄운다
# (tool_grants_conformance_pg 등). 설정되지 않은 값만 DATABASE_URL 에서 채운다. 값은 출력하지 않는다.
export_pg_env() {
  local url="$1" rest cred hostport
  rest="${url#*://}"; cred="${rest%%@*}"; rest="${rest#*@}"
  hostport="${rest%%/*}"
  export PGUSER="${PGUSER:-${cred%%:*}}" PGPASSWORD="${PGPASSWORD:-${cred#*:}}"
  export PGHOST="${PGHOST:-${hostport%%:*}}" PGPORT="${PGPORT:-${hostport##*:}}"
  rest="${rest#*/}"; export PGDATABASE="${PGDATABASE:-${rest%%\?*}}"
}

# $1=패키지 $2=타깃 $3=로그. 통과 개수(N)를 stdout 으로.
run_target() {
  local pkg="$1" test="$2" log="$3" line passed failed
  export_pg_env "$DATABASE_URL"
  cargo test --locked --manifest-path "$MANIFEST" -p "$pkg" --test "$test" -- --ignored --test-threads=1 >"$log" 2>&1 \
    || { tail -n 40 "$log" >&2; die "빨강: $pkg/$test (전체 로그: $log)"; }
  line="$(grep -E '^test result: ' "$log" | tail -n 1)"
  passed="$(printf '%s' "$line" | sed -E 's/.* ([0-9]+) passed.*/\1/')"
  failed="$(printf '%s' "$line" | sed -E 's/.* ([0-9]+) failed.*/\1/')"
  case "$passed:$failed" in *[!0-9:]*|:*|*:) die "결과 줄을 해석할 수 없어요: $pkg/$test" ;; esac
  [ "$failed" = 0 ] || die "failed=$failed: $pkg/$test"
  [ "$passed" -gt 0 ] || die "0개를 실행했어요(빈 초록): $pkg/$test"
  echo "$passed"
}

cmd_run() {
  cmd_lint
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL(슈퍼유저)이 필요해요"
  mkdir -p "$OUT"
  local total=0 targets=0 start now t0 pkg test n
  start="$(date +%s)"
  while read -r _d pkg test; do
    t0="$(date +%s)"
    n="$(run_target "$pkg" "$test" "$OUT/$pkg.$test.log")"
    total=$((total + n)); targets=$((targets + 1))
    echo "[security-pack] ok $pkg/$test passed=$n seconds=$(( $(date +%s) - t0 ))"
  done < <(entries)
  now="$(date +%s)"
  echo "[security-pack] PASS targets=$targets tests=$total seconds=$((now - start))"
}

# DATABASE_URL 의 DB 이름만 바꾼 URL.
url_with_db() { printf '%s' "${DATABASE_URL%/*}/$1"; }

cmd_negative() {
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL(슈퍼유저)이 필요해요"
  local url log
  NEG_PSQL="$(psql_bin)"; NEG_DB="sec03_negative_$$"; url="$(url_with_db "$NEG_DB")"
  mkdir -p "$OUT"; log="$OUT/negative.log"
  "$NEG_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $NEG_DB"
  trap '"$NEG_PSQL" "$DATABASE_URL" -q -c "DROP DATABASE IF EXISTS $NEG_DB" >/dev/null 2>&1 || true' EXIT
  setup_db "$url"
  "$NEG_PSQL" "$url" -v ON_ERROR_STOP=1 -q -f "$ROOT/infra/security-pack/negative/unforced_tenant_table.sql"
  if DATABASE_URL="$url" cargo test --locked --manifest-path "$MANIFEST" -p momo-db --test tenant_catalog_pg -- --ignored --test-threads=1 >"$log" 2>&1; then
    tail -n 30 "$log" >&2
    die "음성 대조 실패: FORCE 없는 테넌트 테이블이 있는데 tenant_catalog_pg 가 초록이에요"
  fi
  grep -Fq "public.$NEG_TABLE: RLS is not FORCEd" "$log" \
    || { tail -n 30 "$log" >&2; die "빨강이지만 'public.$NEG_TABLE: RLS is not FORCEd' 를 지목하지 않았어요 — 다른 이유의 빨강일 수 있어요"; }
  echo "[security-pack] negative OK: tenant_catalog_pg 가 $NEG_TABLE 의 FORCE 누락을 지목하며 빨강"
}

cmd_nightly() {
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL(슈퍼유저)이 필요해요"
  mkdir -p "$OUT"
  export_pg_env "$DATABASE_URL"
  local rc=0 skips t
  # momo-blind-pty/tests/loopback.rs 는 PG 시험이 아니라 성능 측정이다(#4696). PR CI 에서 빼며 `#[ignore]` 가
  # 됐고 perf-nightly.yml 이 릴리스 빌드로 돌린다. 여기서는 건너뛰기만 한다(디버그 빌드로 164초를 또 쓰지 않는다).
  skips=" --skip handshake_echo_latency_and_reconnect_over_loopback_tcp"
  # prod_role_conformance_pg 는 cluster-global 역할 비밀번호를 재설정해 이후 타깃을 오염시킨다.
  # 1) 그 타깃의 시험만 건너뛰고 나머지 전량을 돌린 뒤, 2) 마지막 순서로 따로 돌린다.
  for t in every_notifier_job_iteration_runs_as_its_production_role \
           a_hosted_work_run_push_and_run_status_trigger_run_as_the_notifier_role \
           the_run_stall_and_ledger_retention_sweeps_do_real_work_as_their_production_roles; do
    skips="$skips --skip $t"
  done
  # shellcheck disable=SC2086
  cargo test --locked --manifest-path "$MANIFEST" --workspace --no-fail-fast -- --ignored --test-threads=1 $skips \
    >"$OUT/nightly.log" 2>&1 || rc=1
  tail -n 40 "$OUT/nightly.log"
  cargo test --locked --manifest-path "$MANIFEST" -p momo-notifier --test prod_role_conformance_pg -- --ignored --test-threads=1 \
    >"$OUT/nightly-prod-role.log" 2>&1 || rc=1
  tail -n 40 "$OUT/nightly-prod-role.log"
  return "$rc"
}

case "${1:-}" in
  lint) cmd_lint ;;
  list) cmd_list ;;
  setup) cmd_setup ;;
  run) cmd_run ;;
  negative) cmd_negative ;;
  nightly) cmd_nightly ;;
  *) die "usage: scripts/security_pack.sh {lint|list|setup|run|negative|nightly}" ;;
esac
