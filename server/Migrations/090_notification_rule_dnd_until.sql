-- =============================================================================
-- 090_notification_rule_dnd_until.sql — ADR-0124 증보 2 (#2850)
--
-- 알림 일시 중지(notification_rule.dnd)에 만료 시각을 달고, 선언 상태 방해 금지
-- (member.presence_status='dnd')를 알림 일시 중지와 묶는다(성재 2026-09-27 「묶어」).
--
-- ## 만료 — lazy, sweeper 없음
--
--   * notification_rule.dnd_until — NULL이면 기한 없음. 푸시 판정(momo-push
--     judge_targets)은 `dnd AND (dnd_until IS NULL OR dnd_until > now())`일 때만
--     억제한다. 지난 기한은 판정 시점에 비교되어 그냥 전달로 떨어진다. 018
--     notification_pref.muted_until과 같은 패턴이다.
--   * member.presence_dnd_until — 선언 상태 방해 금지의 만료. 읽기 경계에서
--     지난 기한의 'dnd'는 'auto'로 투영된다(083 status_expires_at과 같은 lazy).
--
-- ## 묶음 기억 (presence_prev_*)
--
-- 방해 금지를 켜면 서버가 같은 트랜잭션에서 알림 일시 중지도 켠다. 켜기 전 값을
-- presence_prev_dnd / presence_prev_dnd_until에 한 번 적어 두고, 방해 금지를 풀면
-- 그 값으로 되돌린다. presence_prev_dnd IS NOT NULL 이 "묶음이 걸려 있음"이다.
-- 사용자가 알림 규칙을 직접 PUT하면 묶음이 끊긴다(기억을 지운다) — 방해 금지를
-- 풀 때 사용자가 직접 고른 값을 덮지 않기 위해서다.
--
-- ## 불변식
--
-- 새 테이블은 없다. notification_rule(066)과 member는 이미 RLS FORCE
-- ws_isolation 아래 있고 새 컬럼은 그 경계를 상속한다. schema_v0.sql은 건드리지
-- 않는다. 행 부재 = 기존 동작 그대로.
-- =============================================================================

ALTER TABLE notification_rule
  ADD COLUMN dnd_until               timestamptz NULL,
  ADD COLUMN presence_prev_dnd       boolean     NULL,
  ADD COLUMN presence_prev_dnd_until timestamptz NULL;

ALTER TABLE notification_rule
  ADD CONSTRAINT notification_rule_dnd_until_ck
    CHECK (dnd_until IS NULL OR dnd),
  ADD CONSTRAINT notification_rule_presence_prev_ck
    CHECK (presence_prev_dnd_until IS NULL OR presence_prev_dnd IS TRUE);

COMMENT ON COLUMN notification_rule.dnd_until IS
  'ADR-0124 증보 2. 알림 일시 중지 만료. NULL=기한 없음. 판정 시점 비교(lazy), sweeper 없음.';
COMMENT ON COLUMN notification_rule.presence_prev_dnd IS
  'ADR-0124 증보 2 묶음 기억. 방해 금지로 켜기 전 dnd 값. NULL=묶음 없음.';
COMMENT ON COLUMN notification_rule.presence_prev_dnd_until IS
  'ADR-0124 증보 2 묶음 기억. 방해 금지로 켜기 전 dnd_until 값.';

ALTER TABLE member
  ADD COLUMN presence_dnd_until timestamptz NULL;

ALTER TABLE member
  ADD CONSTRAINT member_presence_dnd_until_ck
    CHECK (presence_dnd_until IS NULL OR presence_status = 'dnd');

COMMENT ON COLUMN member.presence_dnd_until IS
  'ADR-0124 증보 2. 선언 상태 방해 금지 만료. NULL=기한 없음. 읽기 경계에서 지난 기한의 dnd는 auto로 투영.';
