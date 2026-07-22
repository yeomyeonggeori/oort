#!/usr/bin/env sh
# =============================================================================
# scripts/migrate.sh — momo SQL 마이그레이션 러너 (L4 스펙 §8.7)
#
# 역할: server/Migrations/*.sql 를 파일명 번호순으로 psql 에 적용하고,
#       schema_migrations 테이블에 적용 이력을 추적(멱등 재실행 안전).
#
# 의존: psql (PostgreSQL client). 없으면 안내 출력 후 비-실패(또는 옵션) 종료.
#       PostgresNIO 직접접근 스택이라 ORM 마이그레이션이 없고, 이 번호순
#       .sql + schema_migrations 가 정본 마이그레이션 메커니즘이다(스펙 §8.7).
#
# 연결: DATABASE_URL 환경변수(예: postgres://momo:pw@localhost:5432/momo).
#       infra/.env.example 참고. 없으면 표준 PG* 환경변수(PGHOST 등) 폴백.
#
# 사용:  make migrate            (Makefile 이 `sh scripts/migrate.sh` 호출)
#    또는 DATABASE_URL=... sh scripts/migrate.sh
#
# 멱등성 1-run evidence (MOMO-316):
#   기본값으로 apply 패스 직후 같은 프로세스(=같은 컨테이너 실행) 안에서 verify
#   패스를 한 번 더 돈다. verify 패스는 apply 패스와 동일한 skip 판정 루프
#   (schema_migrations 조회 → SKIP/APPLY)를 재실행하므로 "러너를 두 번 실행"하던
#   기존 2-run 증명과 판정 경로가 동일하고, 두 번째 패스에서 신규 적용(applied>0)이
#   발생하면 즉시 실패한다 — 기존 grep '스킵' 증명보다 강한 단정(전 파일 SKIP +
#   신규 적용 0). 성공 시 아래 마커를 남긴다:
#     [migrate] IDEMPOTENCY_OK second-pass applied=0 skipped=<N>
#   `docker compose logs migrate` 또는 local gate 로그에서 이 마커를 evidence로
#   캡처한다. verify 패스는 read-only skip 판정만 수행하므로 기본 on이 안전하고,
#   MIGRATE_IDEMPOTENCY_CHECK=0 으로 끌 수 있다.
#
# MOMO-001 runtime-verified: PG18 Docker + psql 18 apply 001/002 and idempotent
# re-run pass. Later M1 tickets cover relay/RLS/hermes runtime gates.
# =============================================================================
set -eu

# Agent identities are product data, not persistent/local-alpha bootstrap data.
# Only deterministic demo/e2e runners may opt into the legacy agent fixtures.
case "${MOMO_AGENT_SEED_MODE:-none}" in
  none)
    MOMO_AGENT_SEED_ENABLED=0
    ;;
  demo|e2e)
    MOMO_AGENT_SEED_ENABLED=1
    ;;
  *)
    echo "[migrate] MOMO_AGENT_SEED_MODE must be one of: none, demo, e2e" >&2
    exit 2
    ;;
esac

# --- 경로 해석: 스크립트 위치 기준으로 repo 루트/Migrations 디렉터리 고정 ----------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
MIGRATIONS_DIR="$REPO_ROOT/server/Migrations"

# Fail before psql discovery/connection: two files with the same numeric prefix
# would otherwise both apply because schema_migrations tracks full filenames.
"$REPO_ROOT/scripts/check_migration_numbers.sh" "$MIGRATIONS_DIR"

# --- psql 확인: Homebrew libpq keg-only 설치도 자동 감지 -----------------------
if command -v psql >/dev/null 2>&1; then
  PSQL_BIN=$(command -v psql)
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  cat <<'EOF'
[migrate] psql 을 찾을 수 없습니다 → 마이그레이션을 적용할 수 없습니다.
          runtime-unverified (no docker/psql).

  적용하려면:
    1) PostgreSQL 18 client 설치 (psql)
    2) DB 기동:        make up            # infra/docker-compose.yml (PG18)
    3) 연결 문자열 지정: export DATABASE_URL=postgres://momo:<pw>@localhost:5432/momo
    4) 재실행:          make migrate

  적용 대상(번호순):
EOF
  if [ -d "$MIGRATIONS_DIR" ]; then
    for f in "$MIGRATIONS_DIR"/*.sql; do
      [ -e "$f" ] || continue
      echo "    - $(basename "$f")"
    done
  else
    echo "    (server/Migrations 디렉터리 없음)"
  fi
  # psql 부재는 "환경 미비"이지 스크립트 실패가 아니므로 0 종료(파이프라인 친화).
  exit 0
fi

# --- 연결 인자 구성: DATABASE_URL 우선, 없으면 표준 PG* 환경변수 사용 -----------
if [ "${DATABASE_URL:-}" != "" ]; then
  PSQL="$PSQL_BIN ${DATABASE_URL}"
else
  echo "[migrate] DATABASE_URL 미설정 → 표준 PG* 환경변수(PGHOST/PGUSER/...) 로 연결 시도."
  PSQL="$PSQL_BIN"
fi

# psql 공통 플래그: 에러 시 즉시 중단, 자동커밋 OFF(파일 단위 tx), 조용히.
PSQL_FLAGS="-v ON_ERROR_STOP=1 --set=MOMO_AGENT_SEED_ENABLED=${MOMO_AGENT_SEED_ENABLED} --no-psqlrc --quiet"

# --- schema_migrations 추적 테이블 보장(없으면 생성) ----------------------------
# version = 파일명(번호 prefix 포함). 적용 시각 기록. 재실행 시 SKIP 판정 근거.
$PSQL $PSQL_FLAGS <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
SQL

echo "[migrate] 대상 디렉터리: $MIGRATIONS_DIR"
echo "[migrate] agent seed mode: ${MOMO_AGENT_SEED_MODE:-none} (enabled=${MOMO_AGENT_SEED_ENABLED})"

# --- 번호순으로 .sql 적용 (LANG=C 로 안정적 정렬) -------------------------------
# run_pass <label>: apply/verify 두 패스가 완전히 같은 판정 루프를 공유한다.
# (verify 패스가 별도의 "약한" 검사가 되지 않도록 — 2-run 증명과 동일 경로 보장)
run_pass() {
  pass_label=$1
  applied=0
  skipped=0
  for f in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | LANG=C sort); do
    version=$(basename "$f")

    # 이미 적용된 버전인가? (schema_migrations 조회)
    already=$($PSQL $PSQL_FLAGS -tA \
      -c "SELECT 1 FROM schema_migrations WHERE version = '${version}';" 2>/dev/null || true)

    if [ "$already" = "1" ]; then
      echo "  = SKIP  $version (이미 적용됨)"
      skipped=$((skipped + 1))
      continue
    fi

    echo "  + APPLY $version"
    # 각 마이그레이션 파일과 이력 기록을 하나의 트랜잭션으로 묶는다(원자적 적용).
    # -1(--single-transaction): 파일 전체 + INSERT 가 함께 commit/rollback.
    $PSQL $PSQL_FLAGS --single-transaction \
      -f "$f" \
      -c "INSERT INTO schema_migrations (version) VALUES ('${version}');"
    applied=$((applied + 1))
  done
  echo "[migrate] (${pass_label}) 완료 — 적용 $applied, 스킵 $skipped."
}

run_pass apply

# --- 멱등성 1-run verify 패스 (MOMO-316) ---------------------------------------
# 같은 프로세스 안에서 동일 판정 루프를 재실행: 전 파일이 SKIP이어야 하고
# 신규 적용이 하나라도 나오면 멱등성 위반으로 즉시 실패한다.
if [ "${MIGRATE_IDEMPOTENCY_CHECK:-1}" = "1" ]; then
  echo "[migrate] 멱등성 verify 패스 시작 (single-run evidence)"
  run_pass verify
  if [ "$applied" -ne 0 ]; then
    echo "[migrate] IDEMPOTENCY_FAIL second-pass applied=$applied (재실행에서 신규 적용 발생 — 멱등성 위반)" >&2
    exit 1
  fi
  echo "[migrate] IDEMPOTENCY_OK second-pass applied=0 skipped=$skipped"
fi
