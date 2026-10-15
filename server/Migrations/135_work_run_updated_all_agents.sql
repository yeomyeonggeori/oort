-- =============================================================================
-- 135_work_run_updated_all_agents.sql — #3853 / ADR-0202 D3·D4 (E1)
--
-- 「작업」 화면의 줄은 어느 에이전트에게든 맡긴 일이다(ADR-0202 D3). 보드 읽기가
-- `include=jobs`로 출처를 넓혔으니(관리형·BYOA·팀 AI의 work run, 맡긴 일이 된 멘션
-- run), 다시 조회하라는 신호 `work.run.updated`(migration 120)도 같이 넓힌다.
-- 120은 「type=work 이고 호스팅 연결이 있는 에이전트」의 run에서만 냈다.
--
-- 무엇이 바뀌는가:
--   * type=work run: 에이전트 종류와 무관하게 보드 어휘 전환마다(생성 포함) 낸다.
--     호스팅 연결 EXISTS 술어를 뺀다.
--   * 최상위 멘션 run(input.surface='mention', parent_run_id IS NULL): **마지막 전환**
--     (done·failed·stopped)에서만 낸다. 짧은 멘션 답은 줄이 없으므로 생성·running
--     전환까지 내면 답 하나마다 outbox 행이 셋 생긴다. 마지막 전환은 결과·걸린 시간이
--     정해지는 순간이라 줄이 생기거나 바뀌는 때와 맞는다. 60초 문턱을 넘는 순간은
--     어떤 쓰기도 없으므로 이벤트가 될 수 없다(클라이언트는 포커스 때 다시 읽는다).
--   * 하위 run(parent_run_id 있음)·그 밖의 run: 내지 않는다(보드 줄이 아니다).
--
-- 바뀌지 않는 것: 프레임 이름·모양(run_id, channel_id, to)·idempotency 키·토픽.
-- 배포된 클라이언트는 이 프레임에 보드를 다시 읽을 뿐이고, 가시성은 그 조회가 다시
-- 강제한다(채널 토픽 구독자 = 그 채널 멤버). 새 테이블 없음. outbox는 이미 RLS 대상이다.
-- schema_v0.sql 불변.
-- =============================================================================

CREATE OR REPLACE FUNCTION work_run_updated_enqueue() RETURNS trigger AS $$
DECLARE
  new_state text := work_run_board_state(NEW.status::text);
  old_state text;
  topic text;
  is_work boolean := NEW.input->>'type' IS NOT DISTINCT FROM 'work';
  is_top_mention boolean := NEW.input->>'surface' IS NOT DISTINCT FROM 'mention'
                            AND NEW.parent_run_id IS NULL;
BEGIN
  IF NOT is_work AND NOT is_top_mention THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_state := work_run_board_state(OLD.status::text);
    IF old_state IS NOT DISTINCT FROM new_state THEN
      RETURN NEW;
    END IF;
  END IF;
  -- A mention run is a board row only once it has an outcome worth a row; its
  -- creation and start are not announced (see the header).
  IF NOT is_work AND new_state NOT IN ('done', 'failed', 'stopped') THEN
    RETURN NEW;
  END IF;

  topic := 'ch:ws' || upper(NEW.workspace_id::text) || '.' || upper(NEW.channel_id::text);
  INSERT INTO outbox (workspace_id, kind, status, method, payload, partition_key)
  VALUES (
    NEW.workspace_id,
    'broadcast',
    'pending',
    'publish',
    jsonb_build_object(
      'channel', topic,
      'data', jsonb_build_object(
        'type', 'work.run.updated',
        'v', 1,
        'ts', (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
        'payload', jsonb_build_object(
          'run_id', NEW.id,
          'channel_id', NEW.channel_id,
          'to', new_state
        )
      ),
      'idempotency_key', topic || ':work.run.updated:' || NEW.id::text || ':' || new_state
        || ':' || (extract(epoch FROM now()) * 1000000)::bigint::text
    ),
    NEW.channel_id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION work_run_updated_enqueue() IS
  '#3853 / ADR-0202 D3·D4: 모든 에이전트의 work run 보드 상태 전환 + 최상위 멘션 run의 마지막 전환을 work.run.updated 로 outbox 에 넣는다(120을 넓힘).';
