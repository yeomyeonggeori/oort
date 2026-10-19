-- =============================================================================
-- 141_channel_viewing.sql — #4018 (ADR-0204 증보 3, Proposed)
--
-- 「이 사람이 지금 이 채널 화면을 보고 있다」는 존재 신호(하트비트)의 마지막 시각.
-- (channel_id, member_id) 당 한 행. 클라이언트가 화면이 켜진 동안 주기적으로 PUT 하면
-- seen_at 이 now() 로 움직이고, 푸시 판정(momo-push judgment)이 「30초 안에 봤다」를
-- 읽음 커서 대신(과 함께) 이 값으로 잰다.
--
-- 읽음 커서(read_state.last_read_at)는 last_read_seq 가 오를 때만 움직이고 스트림은 seq 를
-- 쓰지 않아서, 스트림을 30초 넘게 지켜본 요청자도 「자리 비움」으로 읽혔다(#4003 known gap).
-- read_state 에 칸을 더하지 않은 이유: read_state INSERT/UPDATE 트리거(126 inbox 투영)를
-- 하트비트가 건드리면 안 된다. 이 표는 휘발성 신호라 트리거·아웃박스가 없다.
--
-- RLS ENABLE + FORCE, uniform ws_isolation. 쓰기는 momo_app(RLS 적용)만, momo_notifier 는 SELECT.
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

CREATE TABLE IF NOT EXISTS channel_viewing (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  member_id    uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, member_id)
);

COMMENT ON TABLE channel_viewing IS
  'ADR-0204 증보 3 (#4018): last presence heartbeat per (channel, member). Volatile signal; no trigger, no outbox. '
  'Push judgment reads seen_at >= now() - window as "looking at this channel".';

ALTER TABLE channel_viewing ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_viewing FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON channel_viewing;
CREATE POLICY ws_isolation ON channel_viewing
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE channel_viewing TO momo_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    GRANT SELECT ON TABLE channel_viewing TO momo_notifier;
  END IF;
END $$;
