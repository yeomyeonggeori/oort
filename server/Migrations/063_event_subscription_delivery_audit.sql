-- =============================================================================
-- 063_event_subscription_delivery_audit.sql — 이슈 #1204 / ADR-0150 D3 대칭
--
-- ADR-0150 D3은 웹검색이 대화를 밖으로 내보낸 **사실**을 audit_log에 남기게 했다.
-- 이벤트구독 웹훅은 같은 질문의 다른 문이다: 033이 만든 투영은 멘션·승인요청
-- 페이로드에 `body`(메시지 본문)를 실어 구독 주소로 그대로 보내는데, 그것이
-- 나갔다는 사실은 지금까지 어디에도 남지 않았다. outbox 행은 큐이지 원장이
-- 아니고(설정 상태가 덮어써진다), event_subscription 은 목적지이지 이력이 아니다.
--
--   성재 결정(2026-08-09, #1204): A안(본문 전송 유지 + 고지 강화) + 감사 추가.
--   "시각·구독·이벤트 종류·대상 주소. **본문은 감사에 싣지 않는다** —
--    감사가 두 번째 유출 경로가 되면 안 된다."
--
-- ## 이 함수에 body 파라미터가 없는 것은 실수가 아니라 계약이다
--
-- 감사를 켜는 순간 audit_log는 메시지 본문의 **두 번째 사본**이 될 수 있고, 그
-- 사본은 원본과 달리 채널 권한이 아니라 워크스페이스 관리자 권한으로 읽힌다
-- (AuditRoutes.swift: human + requireAdmin). 즉 본문을 여기 실으면 감사 자체가
-- 새 유출 경로가 된다. 그래서 규율을 주석이 아니라 **시그니처**에 박는다:
-- 호출자가 본문을 넘기고 싶어도 넘길 자리가 없다. detail JSON도 이 함수가
-- 조립하므로 호출자가 임의 키를 끼워 넣을 수 없다.
--
-- ## 열람 권한 준위 (D3와 다른 답, 같은 이유)
--
-- D3의 검색 감사 행은 검색어 = 대화 인용을 담으므로 "채널 멤버 준위"였다. 이
-- 행은 대화를 한 글자도 담지 않는다 — 구독 id, 이벤트 종류, 대상 호스트, 시각뿐.
-- 그래서 기존 `event_subscription.*` 감사와 같은 자리, 즉 **워크스페이스 관리자
-- 준위**에 그대로 놓는다(구독을 만들고 끄는 사람이 무엇이 나갔는지 보는 사람이다).
-- 이 준위가 정당한 이유가 곧 본문 부재이므로, 둘은 한 몸으로 지켜져야 한다.
--
-- ## 무엇을 남기고 무엇을 안 남기는가 (실측 판단)
--
-- 남기는 것: **목적지가 HTTP 상태로 답한 전송** — 2xx, 5xx, 그리고 리다이렉트/
-- 4xx 같은 permanent. 셋 다 바이트가 실제로 그 호스트에 도달했다는 뜻이고,
-- 재시도는 각각이 별개의 egress이므로 시도마다 한 행이 남는다.
--
-- 안 남기는 것: SSRF 가드가 목적지를 거절한 경우와 요청이 던진 경우. 전자는
-- 아무것도 나가지 않았으므로 "전송"이 아니고, 후자는 나갔는지 알 수 없다 —
-- 둘 다 `outbox.last_error`에 이미 남는다(중복 금지). 없는 사실을 감사에
-- 적는 것은 감사를 못 믿게 만드는 가장 빠른 길이다.
-- =============================================================================

-- SECURITY INVOKER (기본): 호출자는 relay의 BYPASSRLS 역할이고 workspace_id를
-- 명시적으로 넘긴다. 033의 enqueue 함수와 같은 규율 — 함수가 권한을 새로
-- 만들지 않는다.
CREATE FUNCTION record_event_subscription_delivery(
  delivery_workspace_id   uuid,
  delivery_subscription_id uuid,
  delivery_event_kind     text,
  delivery_event_id       uuid,
  delivery_target_host    text,
  delivery_outbox_id      bigint,
  delivery_attempt        integer,
  delivery_http_status    integer
) RETURNS uuid AS $$
DECLARE
  audit_id uuid;
BEGIN
  INSERT INTO audit_log
    (workspace_id, actor_member_id, subject_member_id, action,
     target_type, target_id, detail)
  VALUES
    (delivery_workspace_id,
     -- 시스템 이벤트다: 이 전송을 누른 사람은 없고, 구독을 만든 사람은
     -- event_subscription.created 행이 이미 이름으로 안다.
     NULL, NULL,
     'event_subscription.delivered',
     'event_subscription', delivery_subscription_id,
     jsonb_build_object(
       'schema', 'momo.event_subscription.delivered.v1',
       'event_kind', delivery_event_kind,
       'event_id', delivery_event_id,
       -- 호스트만. 전체 URL은 경로/쿼리에 구독자가 심어 둔 토큰이 있을 수 있고,
       -- 그것은 본문과 같은 이유로 감사에 실을 것이 아니다.
       'target_host', delivery_target_host,
       'outbox_id', delivery_outbox_id,
       'attempt', delivery_attempt,
       'http_status', delivery_http_status
     ))
  RETURNING id INTO audit_id;
  RETURN audit_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION record_event_subscription_delivery(
  uuid, uuid, text, uuid, text, bigint, integer, integer
) IS
  'Record that one event-subscription webhook payload left for an external host '
  '(ADR-0150 D3 symmetry, issue #1204). Takes no body/payload argument by '
  'design: the audit ledger must never become a second copy of the message '
  'body, because it is read at workspace-admin level rather than channel level.';
