-- =============================================================================
-- 181_dm_leave_floor_index.sql — #5823 (ADR-0177 증보 2026-11-14, #5820: D15·D17)
--
-- 180 의 message 읽기 정책 dm_leave_history_floor 는 사람 요청의 message 문장마다
-- 「요청자가 하한을 가진 채널」 집합을 한 번 만든다(member_id = 요청자 AND history_from_seq IS NOT NULL).
-- member_id 만으로 찾는 인덱스가 없어서 그 집합이 membership 을 한 번 순차로 훑었다.
--
-- 이 부분 인덱스는 하한이 있는 행(1:1 대화에서 나간 행)만 담는다. 거의 모든 행은 NULL 이라
-- 인덱스는 아주 작고, 그 집합을 만드는 비용이 membership 크기가 아니라 하한 행 수를 따른다.
-- 쓰기 비용은 하한을 올리는 UPDATE(나가기)에서만 생긴다.
--
-- 새 표·정책·권한 없음. schema_v0.sql 은 불변.
-- =============================================================================

CREATE INDEX membership_history_floor_member_idx
  ON membership (member_id)
  WHERE history_from_seq IS NOT NULL;
