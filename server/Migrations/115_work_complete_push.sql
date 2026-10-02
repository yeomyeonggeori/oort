-- =============================================================================
-- 115_work_complete_push.sql — #3341 / ADR-0120 부록 A (Accepted 2026-10-02)
--
-- 폰 「작업 끝남」 푸시(`reason = work_session_idle`)의 판정 입력 두 개.
--
-- 1) work_session.turn_started_at — 지금 도는 「턴」이 시작된 시각.
--    「1분 이상 돈 작업만 알린다」(성재 2026-10-02)의 1분은 세션 생성 이후가
--    아니라 **이번 턴**의 길이다. 세션은 idle ↔ running 을 오가며 여러 턴을
--    살고, 3초짜리 후속 턴이 생성 시각 기준으로 「오래 돌았다」고 판정되면
--    푸시가 턴마다 쏟아진다. running 으로 들어가는 두 경로(호스트 서명
--    PATCH running, 재조정 resume)가 이 시각을 갱신한다. idle 카드는 전이 시점의
--    턴 길이(ms)와 이 시각을 props 에 박아 둔다 — 판정은 나중에(notifier) 돌므로
--    그 사이 세션이 다시 running 이 되어도 이 값은 변하지 않는다.
--
-- 2) notification_rule.work_complete_push — 이 멤버가 작업 끝남 푸시를 받는가.
--    기본 true(행이 없거나 새 행도 true): 성재 결재가 「내가 시작한 세션」에 한해
--    기본으로 연다. 끄는 길은 PATCH …/notification-rules/push-kinds.
--
-- 새 테이블 없음. 두 테이블 모두 이미 RLS FORCE 대상이다(019·066).
-- =============================================================================

ALTER TABLE work_session
  ADD COLUMN turn_started_at timestamptz;

UPDATE work_session SET turn_started_at = started_at WHERE turn_started_at IS NULL;

ALTER TABLE work_session
  ALTER COLUMN turn_started_at SET DEFAULT now(),
  ALTER COLUMN turn_started_at SET NOT NULL;

COMMENT ON COLUMN work_session.turn_started_at IS
  '#3341: 현재 턴(마지막 running 진입)의 시작 시각. 생성 시 now(), running 복귀 때 갱신. 「작업 끝남」 푸시의 60초 판정 입력.';

ALTER TABLE notification_rule
  ADD COLUMN work_complete_push boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN notification_rule.work_complete_push IS
  '#3341 / ADR-0120 부록 A: false면 내가 시작한 세션의 「작업 끝남」 푸시(work_session_idle)를 받지 않는다. 기본 true.';
