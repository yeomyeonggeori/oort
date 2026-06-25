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
# MOMO-001 runtime-verified: PG18 Docker + psql 18 apply 001/002 and idempotent
# re-run pass. Later M1 tickets cover relay/RLS/hermes runtime gates.
# =============================================================================
set -eu

# --- 경로 해석: 스크립트 위치 기준으로 repo 루트/Migrations 디렉터리 고정 ----------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
MIGRATIONS_DIR="$REPO_ROOT/server/Migrations"

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
PSQL_FLAGS="-v ON_ERROR_STOP=1 --no-psqlrc --quiet"

# --- 마이그레이션 디렉터리 확인 --------------------------------------------------
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[migrate] 마이그레이션 디렉터리 없음: $MIGRATIONS_DIR" >&2
  exit 1
fi

# --- schema_migrations 추적 테이블 보장(없으면 생성) ----------------------------
# version = 파일명(번호 prefix 포함). 적용 시각 기록. 재실행 시 SKIP 판정 근거.
$PSQL $PSQL_FLAGS <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
SQL

echo "[migrate] 대상 디렉터리: $MIGRATIONS_DIR"

# --- 번호순으로 .sql 적용 (LANG=C 로 안정적 정렬) -------------------------------
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

echo "[migrate] 완료 — 적용 $applied, 스킵 $skipped."
