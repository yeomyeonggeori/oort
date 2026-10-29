-- =============================================================================
-- 155_agent_initiative_limits.sql — ADR-0186 증보 v5 U-d (#4704, N3-B 한도·감사)
--
-- 먼저 제안(`oort_action_initiate`)의 속도 한도·중복 쿨다운·감사를 받치는 DDL 세 개.
-- `schema_v0.sql` 무접촉. 새 enum 값 없음(text + CHECK). 기존 행은 바꾸지 않는다.
--
-- ## 1. agent_run 부분 인덱스 — 속도 한도의 셈(Low L5)
--
-- 시간당 6·하루 20은 `agent_run`에서 먼저 제안이 낳는 키(`agent_initiated:<AGENT>:<ID>`)의 행을
-- 에이전트별·시각 범위로 센다. 기존 `agent_run_idem_uniq (workspace_id, idempotency_key)` 는
-- 접두 LIKE 에 쓸 수 없다(기본 콜레이션에서 LIKE 접두 탐색은 btree 를 타지 않고, 범위 비교도
-- 접두가 연속 구간이라는 보장이 없다). 그래서 먼저 제안의 행만 담는 부분 인덱스를 둔다.
-- 조회는 같은 술어를 **문장에 리터럴로** 적는다(바인드 매개변수면 계획이 부분 인덱스를
-- 증명하지 못한다). 인덱스는 먼저 제안 행에만 서므로 쓰기 비용은 카드 한 장당 한 항목이다.
--
-- ## 2. approval 부분 인덱스 — 중복·쿨다운 조회
--
-- 같은 제안이 대기 중인지, 거절된 지 24시간 안인지는 에이전트의 먼저 제안 승인만 훑는다.
-- 기존 인덱스(`approval_pending_idx`)는 대기 행만 덮어서 「거절됨」 쪽 조회가 워크스페이스의
-- 승인 전체를 읽게 된다. 먼저 제안 승인만 담는 부분 인덱스로 둘 다 좁힌다.
--
-- ## 3. agent_initiative_refusal — 거절 감사 「시간당 1행」의 상태(Medium M5)
--
-- `agent.initiative.refused` 는 (에이전트, reason)당 시간당 정확히 1행이고, 가려진 횟수는 다음
-- 창의 첫 행에 실린다. 가려진 횟수를 세려면 **상태**가 필요하다: 이미 쓴 감사 행을 고쳐 쓰면
-- 감사가 아니고, 프로세스 메모리는 재시작·복제본에서 한 시간에 행을 둘 쓴다. 그래서 (워크스페이스,
-- 에이전트, reason)마다 한 행 — 창을 연 시각과 그 창에서 가려진 횟수 — 을 둔다. 쓰는 곳은
-- 먼저 제안 도구 하나(에이전트별 advisory 락 안, `routes::agent_initiative`)다.
--
--   * 읽는 사람은 없다(운영자가 보는 것은 감사 행의 `suppressed`).
--   * 에이전트가 지워지면 같이 지워진다(FK CASCADE). 한 에이전트당 최대 9행이라 따로 청소하지 않는다.
--   * RLS: ENABLE + FORCE, 표준 ws_isolation. 쓰기는 `momo_app` 의 테넌트 tx 에서만이다.
-- =============================================================================

CREATE INDEX agent_run_initiative_rate_idx
  ON agent_run (workspace_id, agent_member_id, created_at)
  WHERE idempotency_key LIKE 'agent_initiated:%';

CREATE INDEX approval_initiative_idx
  ON approval (workspace_id, requested_by)
  WHERE payload->>'origin' = 'agent_initiated';

CREATE TABLE agent_initiative_refusal (
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_member_id   uuid NOT NULL,
  -- 닫힌 어휘 아홉 개(`momo_agent::initiative::RefusalReason`). 감사 행의 `detail.reason` 과 같다.
  reason            text NOT NULL,
  -- 이 이유의 현재 창을 연 시각. 한 시간이 지나면 다음 거절이 새 창을 연다.
  window_started_at timestamptz NOT NULL DEFAULT now(),
  -- 현재 창에서 감사 행 없이 가려진 거절의 수. 다음 창의 첫 감사 행이 이 값을 싣고 0으로 돌아간다.
  suppressed        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, agent_member_id, reason),
  CONSTRAINT agent_initiative_refusal_agent_fk
    FOREIGN KEY (workspace_id, agent_member_id)
    REFERENCES member (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_initiative_refusal_reason_ck CHECK (reason IN (
    'switch_off', 'no_owner', 'owner_cannot_decide', 'target_unavailable',
    'rate_limited', 'pending_full', 'duplicate', 'cooldown', 'invalid_arguments')),
  CONSTRAINT agent_initiative_refusal_suppressed_ck CHECK (suppressed >= 0)
);

COMMENT ON TABLE agent_initiative_refusal IS
  'ADR-0186 v5 U-d (#4704): the one-hour window of `agent.initiative.refused` audit rows per (agent, reason). Holds how many refusals the window held back; the next window''s first audit row carries that count (detail.suppressed). Written only by the unasked-card tool, inside the agent''s advisory lock.';
COMMENT ON COLUMN agent_initiative_refusal.suppressed IS
  'Refusals of this reason since window_started_at that wrote no audit row. Reset to 0 when the next window opens, after its first row has carried the count.';

ALTER TABLE agent_initiative_refusal ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_initiative_refusal FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON agent_initiative_refusal
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- 153 과 같은 방어: 런타임 역할이 이미 있으면(운영·격리 DB) 새 표 권한을 명시한다. 없으면(역할 이전의
-- 새 DB) bootstrap_*.sql 의 ALL TABLES 부여가 뒤따른다. 이 표는 DELETE 를 쓰지 않는다(FK CASCADE 가 청소).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE agent_initiative_refusal TO momo_app;
  END IF;
END $$;
