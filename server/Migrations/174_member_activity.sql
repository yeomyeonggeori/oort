-- =============================================================================
-- 174_member_activity.sql — #4497 N11 (ADR-0206 D4·DB 계약 M-e, Accepted 2026-10-25)
--
-- 왜
--   멤버가 웹·데스크탑을 지금 쓰는 중이면(창이 앞에 있고 마지막 입력이 5분 안) 그 사람 폰으로 가는 일반
--   메시지 푸시를 잠깐(기본 60초) 미루고, 그 사이 읽었으면 보내지 않는다(Slack 방식, ADR-0206 D4). 서버는
--   그동안 「데스크탑이 지금 쓰이는지」를 몰랐다(`channel_viewing`은 채널별이고 폰도 보내서 가를 수 없다).
--   웹·데스크탑이 20초 이하 주기로 `PUT /v1/workspaces/{ws}/presence/activity`를 보내면 이 표의 한 줄이
--   now()로 움직이고, 푸시 판정 후단(momo-push `refine_targets`)이 「30초 안의 신호」를 활성으로 읽는다.
--
-- 무엇
--   member_activity  (workspace_id, member_id)당 한 행. seen_at = 그 사람의 웹·데스크탑이 마지막으로 쓰인 시각.
--                    휘발 신호라 트리거도 아웃박스도 브로드캐스트도 없다(141 channel_viewing과 같다).
--                    한 사람당 한 줄이라 정리 작업이 없고, 행이 없거나 30초가 지났으면 「활성 아님」이다.
--
-- 규칙을 DB가 쥐는 곳
--   * 복합 외래 키 (workspace_id, member_id) → member(workspace_id, id) ON DELETE CASCADE: 다른 워크스페이스의
--     멤버를 이 워크스페이스 줄에 묶는 행은 만들 수 없고(RLS의 WITH CHECK는 workspace_id 열만 본다), 멤버나
--     워크스페이스가 지워지면 행도 함께 사라진다.
--
-- RLS
--   141과 같은 방식: ENABLE + FORCE + ws_isolation(USING·WITH CHECK 모두 app.workspace_id). 새 테넌트 표다.
--
-- 표 권한
--   momo_app       SELECT·INSERT·UPDATE  PUT이 쓴다(ON CONFLICT … DO UPDATE는 SELECT도 요구한다). 이 GRANT는
--                                         DELETE를 주지 않는다(FK CASCADE가 지운다. bootstrap의 기본 권한이
--                                         따로 줄 수는 있다).
--   momo_notifier  SELECT                판정 후단이 읽기만 한다. 쓰기·DELETE 없음(운영 역할 파일의 한 줄과
--                                         같은 내용이다. 두 곳을 시험이 고정한다).
--   그 밖의 런타임 역할은 bootstrap의 기본 권한을 그대로 받는다(ADR-0206 DB 계약: 141과 같은 모양).
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

CREATE TABLE IF NOT EXISTS member_activity (
  workspace_id uuid        NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id    uuid        NOT NULL,
  seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, member_id),
  CONSTRAINT member_activity_member_fkey FOREIGN KEY (workspace_id, member_id)
    REFERENCES member (workspace_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE member_activity IS
  'ADR-0206 D4 (#4497): last "a web or desktop client of this member is in use" heartbeat per (workspace, member). '
  'Volatile signal; no trigger, no outbox, no broadcast, no read API. The push judgment tail reads seen_at >= now() - 30s '
  'as "my desktop is active" and holds a phone push for the member''s phone_delay_secs; a missing row means not active.';

ALTER TABLE member_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_activity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON member_activity;
CREATE POLICY ws_isolation ON member_activity
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE member_activity TO momo_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    GRANT SELECT ON TABLE member_activity TO momo_notifier;
  END IF;
END $$;
