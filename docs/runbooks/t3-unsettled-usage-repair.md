# T3 migration 051 중복 미정산 usage 복구

대상 오류:

```text
cannot enforce one unsettled T3 usage per host; violating host(s): <host UUID> (<count>); run docs/runbooks/t3-unsettled-usage-repair.md, then retry migration
```

이 오류는 유료 host에 미정산 usage가 둘 이상 있어 migration 051이 의도적으로
중단한 상태다. usage 행을 삭제하거나 `settled_at`만 직접 수정하지 않는다. Migration
050이 설치한 repair 함수는 각 session을 049의 `settle_t3_work_session`으로 정산해
interval 마감, credit debit, slot 해제, host revoke와 destroy intent를 한 트랜잭션에
처리한다.

아래 명령은 production compose checkout에서 실행한다. 운영 중 쓰기가 새 usage를 만들지
않도록 API/relay/worker를 먼저 중지하고, migration-owner 연결을 가진 `migrate` image만
사용한다. 실행 전 DB snapshot/PITR 시점을 확보한다.

```bash
cd /opt/momo/current/momo-deploy
export MOMO_PROD_ENV_FILE='/run/momo/prod.env'
export MOMO_PROD_COMPOSE='infra/prod/docker-compose.prod.yml'

docker compose --env-file "$MOMO_PROD_ENV_FILE" -f "$MOMO_PROD_COMPOSE" \
  stop api relay worker
```

## 1. 위반 host와 session 진단

오류에 나온 host가 현재 DB에도 같은 count로 남아 있는지 확인한다. UUID 텍스트는
`lower()`로 정규화한다.

```bash
docker compose --env-file "$MOMO_PROD_ENV_FILE" -f "$MOMO_PROD_COMPOSE" \
  run --rm --no-deps --entrypoint sh migrate -lc '
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc -P pager=off -c "
      WITH duplicate_hosts AS (
        SELECT host_id, count(*) AS usage_count
          FROM work_host_usage
         WHERE settled_at IS NULL
         GROUP BY host_id
        HAVING count(*) > 1
      )
      SELECT lower(usage.host_id::text) AS host_id,
             duplicates.usage_count,
             lower(usage.session_id::text) AS session_id
        FROM work_host_usage AS usage
        JOIN duplicate_hosts AS duplicates USING (host_id)
       WHERE usage.settled_at IS NULL
       ORDER BY usage.host_id, usage.session_id;
    "
  '
```

결과가 migration 오류와 다르거나 비어 있으면 repair를 실행하지 말고 쓰기 프로세스가
정말 중지됐는지와 대상 DB를 다시 확인한다.

## 2. repair 실행

한 번의 함수 호출이 진단된 session 전부를 원자적으로 정산한다. 출력의
`host_id`/`usage_count`는 repair 전 진단값이고 `settled`는 모두 `t`여야 한다.

```bash
docker compose --env-file "$MOMO_PROD_ENV_FILE" -f "$MOMO_PROD_COMPOSE" \
  run --rm --no-deps --entrypoint sh migrate -lc '
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc -P pager=off -c "
      SELECT lower(host_id::text) AS host_id,
             usage_count,
             lower(session_id::text) AS session_id,
             settled
        FROM repair_t3_duplicate_unsettled_usage()
       ORDER BY host_id, session_id;
    "
  '
```

직접 정산되지 않은 중복이 0건인지 확인한다. 아래 쿼리는 행을 반환하지 않아야 한다.

```bash
docker compose --env-file "$MOMO_PROD_ENV_FILE" -f "$MOMO_PROD_COMPOSE" \
  run --rm --no-deps --entrypoint sh migrate -lc '
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc -P pager=off -c "
      SELECT lower(host_id::text) AS host_id, count(*) AS usage_count
        FROM work_host_usage
       WHERE settled_at IS NULL
       GROUP BY host_id
      HAVING count(*) > 1
       ORDER BY host_id;
    "
  '
```

## 3. migration 재적용과 멱등 확인

```bash
docker compose --env-file "$MOMO_PROD_ENV_FILE" -f "$MOMO_PROD_COMPOSE" \
  run --rm --no-deps migrate 2>&1 | tee /tmp/momo-t3-migration-repair.log

grep -F '[migrate] IDEMPOTENCY_OK second-pass applied=0' \
  /tmp/momo-t3-migration-repair.log

docker compose --env-file "$MOMO_PROD_ENV_FILE" -f "$MOMO_PROD_COMPOSE" \
  run --rm --no-deps --entrypoint sh migrate -lc '
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc -Atc "
      SELECT
        EXISTS (
          SELECT 1 FROM schema_migrations
           WHERE version = '\''051_t3_unsettled_usage_constraint.sql'\''
        )
        AND to_regclass(
          '\''public.work_host_usage_one_unsettled_per_host_idx'\''
        ) IS NOT NULL;
    "
  ' | grep -Fx t
```

## 4. 서비스 기동 확인

```bash
docker compose --env-file "$MOMO_PROD_ENV_FILE" -f "$MOMO_PROD_COMPOSE" \
  up -d --no-build --wait api relay worker

docker compose --env-file "$MOMO_PROD_ENV_FILE" -f "$MOMO_PROD_COMPOSE" \
  ps api relay worker

curl -fsS "https://${API_DOMAIN}/health" | jq -e \
  '.status == "ok" and .service == "MomoServer"'
```

`api`, `relay`, `worker`가 모두 running이고 health가 200일 때만 복구 완료로 기록한다.
실패하면 서비스를 다시 중지하고 migration 로그와 각 서비스의 최근 로그를 로컬에서
검토한다. DB URL, bearer, provider key나 원문 환경 파일은 티켓·채팅·evidence에 붙이지
않는다.
