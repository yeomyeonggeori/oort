-- =============================================================================
-- 172_notification_prefs_v2.sql — #4494 N3 (ADR-0206 D5·D13, M-b2, Accepted)
--
-- 알림 설정 v2 의 서버 저장소: 종류×표면 스위치·표현·근무 시간·폰 지연·관통 스위치를
-- 기존 notification_rule(066) 행에 컬럼으로 더한다. 새 표가 아니라서 RLS 정책도 새 GRANT 도
-- 없다(066 의 ws_isolation FORCE, momo_app DML, momo_notifier SELECT 를 그대로 상속).
--
--   kinds                    jsonb     NULL   종류×표면 스위치. 셀 단위로 저장하고 없는 셀은 기본값
--                                            ({"dm":{"phone":false}} 처럼). workDone.phone 은
--                                            여기에 저장하지 않는다 — work_complete_push(115)가
--                                            같은 값의 정본이다(D5 별칭).
--   presentation             jsonb     NULL   종류별 소리 슬롯 ({"sounds":{"dm":"oort.dm"}}).
--   schedule                 jsonb     NULL   근무 시간 {enabled,tz,days,start,end,passThrough}.
--   phone_delay_secs         smallint  NULL   데스크탑이 쓰이는 중일 때 폰 푸시 지연(D4). NULL = 60.
--   keyword_overrides_mute   boolean   NOT NULL DEFAULT true   키워드 알림이 채널 음소거를 뚫는가(D3).
--   approval_time_sensitive  boolean   NOT NULL DEFAULT false  승인 요청을 Time Sensitive 로(D6).
--
-- 행 부재·NULL·DEFAULT = 오늘의 동작(ADR-0206 I5): 읽는 쪽은 모든 NULL 을 종류 표의 기본값으로
-- 읽는다. 기존 쓰기(PUT/PATCH notification-rules, push-kinds, presence 묶음, 시험 알림 한도)는
-- INSERT/UPDATE 에 컬럼을 이름으로 적어서 이 컬럼을 건드리지 않는다 → 구 서버로 롤백해도 이
-- 컬럼은 그대로 남고, 구 서버는 모르는 컬럼이라 무시한다.
--
-- jsonb 컬럼에는 DB CHECK 를 걸지 않는다(ADR-0124 증보 2 D9·090 과 같은 이유): 롤백한 서버의
-- 해제 쓰기가 새 컬럼 때문에 막히면 안 된다. 검증은 API 가 하고(8 KiB 이하, 알려진 종류·표면·소리
-- id 만, schedule 의 tz 는 pg_timezone_names 의 이름만), 읽는 쪽(푸시 판정·API)은 모르는 키와 틀린
-- 모양을 무시하고 기본값으로 읽는다.
--
-- 시간대 평가 함수 notification_local_time(tz, at) (D13) — 판정 후단과 effective.quiet 가 같은
-- 평가를 쓴다. 시각 계산은 Postgres 에 맡기고 Rust 에 시간대 DB 의존을 새로 들이지 않는다. 틀린
-- zone 이름(tzdata 가 바뀐 뒤 저장된 이름이 사라진 경우 등)은 오류가 아니라 NULL 이다: 판정을
-- 깨지 않고 「일정 없음」으로 읽기 위해서다. SECURITY INVOKER, search_path 고정, 읽는 표가
-- 없다(순수 시각 변환). EXECUTE 는 PUBLIC 에서 거두고 momo_app 에게만 준다 — momo_notifier 는
-- 판정 후단(N7)이 이 함수를 부르는 슬라이스가 같은 GRANT 를 더한다(부르지 않는 권한을 미리 주지
-- 않는다: 증보 1 F1 의 over-grant 규칙과 같다).
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

ALTER TABLE notification_rule
  ADD COLUMN IF NOT EXISTS kinds                   jsonb    NULL,
  ADD COLUMN IF NOT EXISTS presentation            jsonb    NULL,
  ADD COLUMN IF NOT EXISTS schedule                jsonb    NULL,
  ADD COLUMN IF NOT EXISTS phone_delay_secs        smallint NULL,
  ADD COLUMN IF NOT EXISTS keyword_overrides_mute  boolean  NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS approval_time_sensitive boolean  NOT NULL DEFAULT false;

COMMENT ON COLUMN notification_rule.kinds IS
  '#4494 / ADR-0206 D5·D13: 종류×표면 스위치(셀 단위, 없는 셀 = 종류 표의 기본값). workDone.phone 은 work_complete_push 가 정본이라 여기에 없다.';
COMMENT ON COLUMN notification_rule.presentation IS
  '#4494 / ADR-0206 D13: 종류별 소리 슬롯 {"sounds":{<kind>:<sound id|"none">}}. NULL = 종류별 기본 소리(D10).';
COMMENT ON COLUMN notification_rule.schedule IS
  '#4494 / ADR-0206 D13: 근무 시간 {enabled,tz,days,start,end,passThrough}. NULL = 꺼짐. tz 는 pg_timezone_names 의 이름(API 가 검증).';
COMMENT ON COLUMN notification_rule.phone_delay_secs IS
  '#4494 / ADR-0206 D4: 데스크탑 활성 시 폰 푸시 지연(0|60|300). NULL = 60. 읽는 곳은 N11.';
COMMENT ON COLUMN notification_rule.keyword_overrides_mute IS
  '#4494 / ADR-0206 D3: 키워드 알림이 채널 음소거를 뚫는가. 읽는 곳은 N5.';
COMMENT ON COLUMN notification_rule.approval_time_sensitive IS
  '#4494 / ADR-0206 D6: 승인 요청을 Time Sensitive 로 보내 달라는 선택. 읽는 곳은 N16.';

CREATE OR REPLACE FUNCTION notification_local_time(tz text, at timestamptz DEFAULT now())
RETURNS timestamp
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN at AT TIME ZONE tz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION notification_local_time(text, timestamptz) IS
  '#4494 / ADR-0206 D13: at 의 tz 현지 시각(timestamp). 틀린 zone 이름은 오류가 아니라 NULL(일정 없음으로 읽는다).';

REVOKE ALL ON FUNCTION notification_local_time(text, timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT EXECUTE ON FUNCTION notification_local_time(text, timestamptz) TO momo_app;
  END IF;
END $$;
