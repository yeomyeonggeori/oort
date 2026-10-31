-- =============================================================================
-- 164_thread_follow.sql — #4889 (ADR-0206 증보 1 F1, Proposed)
--
-- 「내가 따라가는 스레드」: (스레드 루트, 멤버) 당 한 행. 스레드에 새 답글이 달렸을 때 알림을
-- 받을 사람(= 스레드 따라가기, Slack 의 thread follow)을 서버가 쥔다. 이 표를 읽는 알림 판정
-- (`thread_reply` arm)과 notifier 는 2단계(S5)의 일이고, 이 파일은 표와 쓰기 길만 연다.
--
-- 상태 셋(CHECK):
--   auto        서버가 보내기 tx 안에서 만든 행 (답글 단 사람 · 루트 작성자 · 스레드에서 멘션된 사람)
--   followed    사람이 「따라가기」를 직접 누른 행
--   unfollowed  사람이 「그만 따라가기」를 누른 행
-- 따라간다 = auto 또는 followed. 행이 없으면 따라가지 않는다 (행 부재 = 오늘의 동작, ADR-0206 I5).
--
-- 병합 규칙(ADR 증보 1 F1 의 표)을 DB 가 아니라 쓰는 문장이 쥔다:
--   자동  INSERT ... ON CONFLICT (root_id, member_id) DO NOTHING   → unfollowed 는 자동으로 돌아오지 않는다
--   직접  ON CONFLICT ... DO UPDATE SET state = 'followed' | 'unfollowed'
-- 행을 지우는 길은 없다. 「그만 따라가기」는 행을 지우지 않고 unfollowed 로 바꾼다 — 지우면 자동
-- 경로가 다시 만들기 때문이다. 멤버·채널·루트 메시지·워크스페이스가 지워지면 CASCADE 로 사라진다.
--
-- 왜 새 표인가: `thread.participant_ids` 는 답글 작성자 집합이라 멘션·직접 따라가기·「그만」을 담지
-- 못하고, 루트 작성자는 답글을 달기 전에는 거기 없다. `channel_id` 는 판정과 API 가 멤버십을 따로
-- 조인하지 않고도 채널을 알게 하려고 둔다.
--
-- RLS ENABLE + FORCE, uniform ws_isolation (141 과 같은 모양). 쓰기는 momo_app(RLS 적용)과 에이전트
-- worker 의 보내기(momo_worker, BYPASSRLS 라서 쓰는 문장이 workspace_id 술어를 직접 명시한다)만 한다.
-- 트리거·아웃박스·브로드캐스트가 없다.
--
-- momo_notifier 에는 권한을 주지 않는다: notifier 의 쓰기 줄은 ThreadPolicy::Skip 이라 이 쓰기를
-- 지나지 않고, 읽는 문장이 아직 없어서 SELECT 를 미리 주면 scripts/tests/test_notifier_role_grants.sh
-- 가 over-grant 로 빨개진다. SELECT 한 줄은 2단계가 판정 읽기와 함께 더한다.
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

CREATE TABLE IF NOT EXISTS thread_follow (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  root_id      uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  member_id    uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  state        text NOT NULL CHECK (state IN ('auto', 'followed', 'unfollowed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_id, member_id)
);

-- 멤버가 지워질 때의 CASCADE 가 표를 훑지 않게 하고, 「내가 따라가는 스레드」 목록(후속)의 입구다.
-- (루트 쪽 CASCADE 와 판정의 (root_id, member_id) 조회는 PK 가 맡는다.)
CREATE INDEX IF NOT EXISTS thread_follow_member_idx ON thread_follow (member_id);

COMMENT ON TABLE thread_follow IS
  'ADR-0206 증보 1 (#4889): who follows which thread. state auto|followed|unfollowed; following = auto or followed; '
  'no row = not following. Auto writes are INSERT ... ON CONFLICT DO NOTHING so unfollowed never flips back by itself. '
  'Read by the thread_reply push arm (stage 2); momo_notifier has no grant until that arm exists.';

ALTER TABLE thread_follow ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_follow FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON thread_follow;
CREATE POLICY ws_isolation ON thread_follow
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE thread_follow TO momo_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    GRANT SELECT, INSERT ON TABLE thread_follow TO momo_worker;
  END IF;
END $$;
