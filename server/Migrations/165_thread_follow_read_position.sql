-- =============================================================================
-- 165_thread_follow_read_position.sql — #4889 2단계 (ADR-0206 증보 1, Accepted)
--
-- 두 가지를 한다.
--
-- 1. thread_follow.last_read_reply_seq — 「어디까지 읽었는지」 (owner 10-31 23:49, #4878 코멘트)
--    따라가는 스레드마다 보는 사람이 마지막으로 읽은 답글의 seq(= message.seq, 채널 안에서 단조 증가).
--    안 읽은 답글 수는 이 값보다 큰 seq 의 남의 답글을 세어서 낸다(읽는 곳은 기록 페이지의 스레드 요약).
--    규칙은 이 열을 쓰는 문장이 쥔다:
--      * 앞으로만: 읽음 신호(PUT …/messages/{root}/read)가 GREATEST(현재, LEAST(요청, 스레드의 마지막 답글 seq))로 올린다.
--        뒤로 가는 요청은 무시되고, 스레드 머리를 넘는 요청은 머리까지만 올라간다(채널 읽음 커서와 같은 규율).
--      * 새 행의 처음 값: 자동 따라가기는 답글 단 사람 = 그 답글 seq(답글을 달았으면 거기까지 본 것),
--        나머지(루트 작성자·멘션된 사람) = 그 답글 seq - 1(그 답글부터가 새 소식). 직접 따라가기(PUT …/follow)로
--        만든 새 행은 그 시점의 마지막 답글 seq(따라가기는 「지금부터」). 이미 있는 행의 값은 자동·직접 따라가기가
--        바꾸지 않는다.
--      * 행이 없는 스레드(따라가지 않음)에는 읽음 신호가 행을 만들지 않는다 — 행이 없으면 값도 없다.
--    DEFAULT 0 은 이 마이그레이션 전에 만들어진 행(1단계가 쌓은 것)의 값이다: 0 = 모든 남의 답글이 안 읽음.
--
-- 2. momo_notifier 가 thread_follow 를 읽는 권한 — thread_reply 푸시 판정(momo-push judgment)이 읽는다
--    1단계(164)가 일부러 안 준 SELECT 한 줄이다: 그때는 읽는 문장이 없어서 scripts/tests/test_notifier_role_grants.sh 가
--    over-grant 로 빨개졌다. 이제 읽는 문장이 있다. SELECT 만이다 — INSERT·UPDATE·DELETE 없음: notifier 의 쓰기 줄은
--    ThreadPolicy::Skip 이라 자동 따라가기를 지나지 않고, 행을 만들고 바꾸는 쪽은 momo_app·momo_worker 다.
--    새 BYPASSRLS 역할은 없다. notifier 는 channel_viewing(141)·notification_pref 를 읽는 방식 그대로 이 표를 읽는다:
--    판정 문장이 workspace_id 를 명시하고, 후보마다 with_tenant_tx 안에서 돈다.
--
-- 운영 메모(락): ALTER TABLE 은 ACCESS EXCLUSIVE 를 커밋까지 잡는다. 상수 기본값을 가진 열 추가는 메타데이터만 바꾼다
-- (PG 11+). CHECK 는 NOT VALID 로 더해 기존 행을 훑지 않는다 — 열이 방금 생겨 기존 행이 모두 0 이라 어길 수 없고,
-- 새로 쓰는 행(INSERT·UPDATE)은 NOT VALID 여도 검사된다. 배포 순서: migrate → api. 새 api 의 자동 따라가기 INSERT 가
-- 이 열을 이름 대기 때문에 표보다 먼저 뜨면 스레드 답글 보내기가 실패한다. 반대로 새 DB 에 구 api 는 열을 모르는 채
-- 오늘대로 돈다(INSERT 가 열을 안 쓰면 DEFAULT 0).
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

ALTER TABLE thread_follow
  ADD COLUMN IF NOT EXISTS last_read_reply_seq bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.thread_follow'::regclass
       AND conname = 'thread_follow_last_read_reply_seq_ck'
  ) THEN
    ALTER TABLE thread_follow
      ADD CONSTRAINT thread_follow_last_read_reply_seq_ck
      CHECK (last_read_reply_seq >= 0) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN thread_follow.last_read_reply_seq IS
  'ADR-0206 증보 1 (#4889 2단계): the seq of the last reply this member has read in this thread. '
  'Only ever moves forward (PUT .../messages/{root}/read: GREATEST(current, LEAST(requested, thread head))). '
  'unreadReplyCount = other people''s replies with seq above it. Meaningful for auto/followed rows; kept for unfollowed rows so a re-follow does not resurface read replies.';

COMMENT ON TABLE thread_follow IS
  'ADR-0206 증보 1 (#4889): who follows which thread. state auto|followed|unfollowed; following = auto or followed; '
  'no row = not following. Auto writes are INSERT ... ON CONFLICT DO NOTHING so unfollowed never flips back by itself. '
  'Read by the thread_reply push arm (momo_notifier: SELECT only, migration 165) and by the thread summary''s unreadReplyCount.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    GRANT SELECT ON TABLE thread_follow TO momo_notifier;
  END IF;
END $$;
