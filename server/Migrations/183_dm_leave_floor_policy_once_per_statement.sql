-- =============================================================================
-- 183_dm_leave_floor_policy_once_per_statement.sql — #5857 (ADR-0177 증보 2026-11-14, #5820: D17)
--
-- 180 의 message 읽기 정책 dm_leave_history_floor 의 모양만 바꾼다. 무엇이 보이는지는 같다:
--   보인다 ⇔ 요청자 값이 비었거나, 요청자의 그 채널 membership 행이 없거나, 그 행의 하한이 NULL 이거나
--   message.seq ≥ 하한.
--
-- 왜 바꾸나
--   180 은 「요청자가 하한을 가진 채널」 집합을 hashed SubPlan 으로, 그 채널의 하한을 행마다 도는 SubPlan
--   으로 읽었다. 플래너는 hashed SubPlan 을 만드는 비용을 그 정책이 붙은 message 훑기를 **다시 읽을
--   때마다** 낸다고 본다. 그래서 message 가 조인의 안쪽에 오는 읽기(이력·스레드·받은함의 인용 조인)에서,
--   표 전체의 하한 행이 늘면(멤버당 평균 10개 안팎부터) 행마다 색인으로 찾는 대신 방 전체를 한 번에 읽어
--   두는 계획으로 바뀌었다. 계획은 요청자가 아니라 통계로 정해져서 요청자 없는 읽기까지 같이 느려졌다.
--
-- 새 모양
--   요청자의 하한 지도(채널 → 하한, jsonb)를 문장마다 한 번(InitPlan) 만들고 행마다 그 지도에서 찾는다.
--   행마다 도는 부분질의도, 다시 읽을 때마다 비용이 붙는 부분질의도 없다. 지도를 만드는 비용은 요청자의
--   하한 행 수를 따르고(부분 인덱스 181), 플래너는 그것을 문장에 한 번만 센다.
--     ① 요청자 값이 비었으면 통과 (InitPlan — 180 과 같다).
--     ② 요청자에게 하한이 하나도 없으면 통과 (지도가 NULL). 행마다 일이 없다.
--     ③ 그 밖에는 이 행 채널의 하한을 지도에서 찾아 seq 와 비교한다. 지도에 없는 채널은 0 → 통과.
--   EXPLAIN (ANALYZE) 앞뒤(멤버당 하한 0·10·30·100)는 PR 본문.
--
-- 새 표·열·권한 없음. 정책 이름·RESTRICTIVE·FOR SELECT 는 그대로(ALTER POLICY 는 식만 바꾼다).
-- 이 정책을 읽는 비우회 역할은 membership 의 표 단위 SELECT 를 이미 갖는다(180 과 같다).
-- schema_v0.sql 은 불변.
-- =============================================================================

ALTER POLICY dm_leave_history_floor ON message
  USING (
    (SELECT NULLIF(current_setting('app.requester_member_id', true), '')) IS NULL
    OR (
      SELECT jsonb_object_agg(ms.channel_id::text, ms.history_from_seq)
        FROM membership ms
       WHERE ms.member_id = (SELECT NULLIF(current_setting('app.requester_member_id', true), '')::uuid)
         AND ms.history_from_seq IS NOT NULL
    ) IS NULL
    OR message.seq >= COALESCE(((
      SELECT jsonb_object_agg(ms.channel_id::text, ms.history_from_seq)
        FROM membership ms
       WHERE ms.member_id = (SELECT NULLIF(current_setting('app.requester_member_id', true), '')::uuid)
         AND ms.history_from_seq IS NOT NULL
    ) ->> message.channel_id::text)::bigint, 0)
  );
