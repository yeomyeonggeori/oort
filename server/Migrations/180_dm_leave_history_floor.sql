-- =============================================================================
-- 180_dm_leave_history_floor.sql — #5822 (ADR-0177 증보 2026-11-14, #5820: D15·D17)
--
-- 사람끼리의 1:1 「대화 나가기」의 저장과 읽기 경계.
--
--   1) membership.history_from_seq   (D15) 이 멤버가 이 채널에서 보는 첫 seq. NULL = 전체 기록.
--                                    ADR-0219 §4.3 의 게스트 칸과 같은 이름·같은 뜻 — 하나만 둔다.
--   2) 정책 dm_leave_history_floor    (D17) message 의 RESTRICTIVE FOR SELECT 하나.
--
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL. 새 표가 없어서 새 RLS 대상도 없다
-- (membership 은 이미 ENABLE + FORCE + ws_isolation, 001_init.sql).
--
-- 요청자 값
--   정책은 `app.requester_member_id` 를 읽는다. momo-db 의 테넌트 tx 도우미가 tx 첫머리에 묶는다
--   (`bind_workspace_guc`, task-local 하나). 사람 principal 의 두 문(require_principal 의 사람 갈래,
--   require_dev_principal)만 값을 넣는다. 주인 범위 값 `app.member_id`(owner_scope.rs)와는 다른 값이다 —
--   그 값은 보내기 정본 길이 비우고 남의 일을 대신할 때 다른 멤버 id 를 넣는다(D17 첫 줄).
--
-- 값이 비면 통과 (D17)
--   relay·알림·agent-worker·에이전트 요청은 요청자가 사람이 아니라서 그대로다. 우회 역할
--   (momo_relay·momo_worker·momo_notifier)은 RLS 자체를 건너뛴다. 이 경계는 「내가 치운 내 대화를
--   다시 내려 주지 않는 약속」이라 통과가 맞다.
--
-- 술어
--   보인다 ⇔ 요청자 값이 비었거나, 요청자의 그 채널 membership 행이 없거나, 그 행의 하한이 NULL 이거나
--   message.seq ≥ 하한. 세 갈래를 그 차례로 쓴다:
--     ① 요청자 값 — 스칼라 부분질의라 문장마다 한 번(InitPlan)만 읽는다.
--     ② 「요청자가 하한을 가진 채널」 집합에 없다 — 상관없는 부분질의라 한 번 만들어 해시로 찾는다
--        (hashed SubPlan). 하한이 없는 보통 채널의 행은 여기서 끝난다.
--     ③ 그 집합의 채널이면 그 행의 하한과 seq 를 비교한다 — 유일 제약 membership_uniq
--        (channel_id, member_id) 로 한 행. 새 인덱스 없음.
--   한 갈래씩의 상관 부분질의(행마다 membership 조회)는 검색처럼 많은 행을 훑는 읽기에서 비용이 행 수에
--   비례해서 이 모양을 골랐다(EXPLAIN 앞뒤는 PR 본문).
--   이 정책을 읽는 비우회 역할(momo_app·momo_helper_read·mem_definer)은 모두 membership 의 표 단위
--   SELECT 를 이미 갖는다.
-- =============================================================================

ALTER TABLE membership
  ADD COLUMN history_from_seq bigint
  CONSTRAINT membership_history_from_seq_ck CHECK (history_from_seq > 0);

COMMENT ON COLUMN membership.history_from_seq IS
  'ADR-0177 D15: this member reads messages with seq >= this value in this channel; NULL = full history. Raised only, never lowered through the API (D16).';

CREATE POLICY dm_leave_history_floor ON message AS RESTRICTIVE FOR SELECT
  USING (
    (SELECT NULLIF(current_setting('app.requester_member_id', true), '')) IS NULL
    OR message.channel_id NOT IN (
      SELECT ms.channel_id
        FROM membership ms
       WHERE ms.member_id = (SELECT NULLIF(current_setting('app.requester_member_id', true), '')::uuid)
         AND ms.history_from_seq IS NOT NULL
    )
    OR message.seq >= (
      SELECT ms.history_from_seq
        FROM membership ms
       WHERE ms.channel_id = message.channel_id
         AND ms.member_id = (SELECT NULLIF(current_setting('app.requester_member_id', true), '')::uuid)
    )
  );
