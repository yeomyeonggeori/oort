-- =============================================================================
-- 120_work_run_updated_event.sql — #3517 / ADR-0162 증보 3 D13 (AT-4)
--
-- 팀 보드의 두 번째 출처(호스티드 에이전트의 type=work run)가 바뀔 때 보드가
-- 다시 조회하도록 알리는 실시간 이벤트 `work.run.updated`.
--
-- 왜 트리거인가: agent_run.status 의 쓰기 지점이 여럿이다(생성, 첫 이벤트/claim,
-- 완료, 취소, 승인 보류·재개, 제어 창 정지·재개). 지점마다 emit 을 흩으면 하나가
-- 빠지는 순간 보드가 조용히 낡는다. 한 트리거가 같은 트랜잭션에서 outbox 에 넣으면
-- 새 쓰기 경로가 생겨도 빠지지 않는다(011 의 push_candidate 트리거와 같은 구조).
--
-- 무엇을 보내는가:
--   * 보드 어휘 전환만 — waiting/running/done/failed/stopped 가 바뀔 때. 승인 보류·
--     정지는 보드에서 모두 running 이므로 이벤트가 없다. 단계 표식(output.stages)과
--     step_count 갱신은 status 를 바꾸지 않으므로 이벤트가 없다(D11).
--   * 생성(INSERT)도 하나의 전환이다(보드에 waiting 항목이 새로 생긴다).
--   * 대상: input.type='work' 이고 호스팅 연결을 가진 에이전트의 run 만. mention·managed
--     run 은 v1 보드에 없으므로 이벤트도 없다.
--   * 내용: run_id, 채널, 전환 종류(`to` = 보드 어휘)만. 이름·제목·숫자·산출물 없음.
--     클라는 이벤트에 보드를 다시 조회하고 가시성은 조회가 다시 강제한다.
--
-- 새 테이블 없음. outbox 는 이미 RLS 대상이다.
-- =============================================================================

CREATE FUNCTION work_run_board_state(run_status text) RETURNS text AS $$
  SELECT CASE run_status
    WHEN 'queued' THEN 'waiting'
    WHEN 'running' THEN 'running'
    WHEN 'awaiting_approval' THEN 'running'
    WHEN 'paused' THEN 'running'
    WHEN 'succeeded' THEN 'done'
    WHEN 'failed' THEN 'failed'
    WHEN 'timed_out' THEN 'failed'
    WHEN 'cancelled' THEN 'stopped'
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION work_run_updated_enqueue() RETURNS trigger AS $$
DECLARE
  new_state text := work_run_board_state(NEW.status::text);
  old_state text;
  topic text;
BEGIN
  IF NEW.input->>'type' IS DISTINCT FROM 'work' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_state := work_run_board_state(OLD.status::text);
    IF old_state IS NOT DISTINCT FROM new_state THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM hosted_agent_connection hc
     WHERE hc.workspace_id = NEW.workspace_id AND hc.agent_member_id = NEW.agent_member_id
  ) THEN
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
      -- one key per transition: a run may re-enter a state (running → paused →
      -- running is not a board change, but waiting → running → … is distinct
      -- per target state), and the transaction time separates repeats.
      'idempotency_key', topic || ':work.run.updated:' || NEW.id::text || ':' || new_state
        || ':' || (extract(epoch FROM now()) * 1000000)::bigint::text
    ),
    NEW.channel_id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER work_run_updated_enqueue_ins_trg
  AFTER INSERT ON agent_run
  FOR EACH ROW EXECUTE FUNCTION work_run_updated_enqueue();

CREATE TRIGGER work_run_updated_enqueue_upd_trg
  AFTER UPDATE OF status ON agent_run
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION work_run_updated_enqueue();

COMMENT ON FUNCTION work_run_updated_enqueue() IS
  '#3517 / ADR-0162 증보 3 D13: 호스티드 work run 의 보드 상태 전환만 work.run.updated 로 outbox 에 넣는다.';
