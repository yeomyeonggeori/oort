-- =============================================================================
-- 087_hosted_scope_workspace_propose.sql — ADR-0186 D2 / #2508 AX-3a
--
-- hosted 스코프 어휘에 `workspace:propose` 한 줄을 더한다. 테이블·컬럼·인덱스
-- 추가 없음. `schema_v0.sql` 무접촉.
--
-- ## ADR-0186 D7 정정
--
-- D7은 「DDL 무접촉 — 자격 스코프(text[])로 충분하다」고 적었다. 그 문장은 사실이
-- 아니었다. hosted 스코프 어휘는 text[] 컬럼**에 더해** CHECK 제약 세 개가
-- 여섯 개를 그대로 열거하고 있다:
--
--   * `hosted_agent_connection_scopes_ck`  (069:65)  사람이 승인할 수 있는 집합
--   * `token_hosted_binding_ck`            (074:60)  자격증명이 실을 수 있는 집합
--   * `hosted_oauth_request_scope_ck`      (074:223) OAuth 로 요청·승인되는 집합
--     (테이블 이름은 `hosted_oauth_authorization_request`)
--
-- 즉 이 마이그레이션 없이는 `workspace:propose` 를 사람이 승인할 수도, 토큰이
-- 실을 수도, OAuth 로 요청할 수도 없다 — D2 자체가 구현 불가능해진다. D7의 뜻
-- (새 테이블·새 컬럼·새 outbox 생산자 0)은 그대로 지키고, 닫힌 어휘를 열거한
-- CHECK 만 그 어휘가 자란 만큼 다시 쓴다.
--
-- ## 왜 세 개를 한 번에
--
-- 셋은 같은 한 가지 사실의 세 위치다(승인·자격·요청). 하나만 늘리면 승인은 되는데
-- 토큰을 못 실거나, 토큰은 실리는데 OAuth 가 막히는 반쪽 상태가 되고, 그 상태는
-- 「스코프가 있는데 도구가 안 열린다」는 진단 불가능한 증상으로만 보인다.
--
-- ## 넓히지 않는 것
--
-- * `agent:port:connect` 필수 규칙, generic/hosted 분기, audience 고정,
--   `approved_scopes <@ requested_scopes`, denied 분기 — 전부 그대로다. 각 CHECK
--   에서 바뀌는 것은 배열 리터럴 한 줄뿐이다.
-- * generic agent bearer 의 허용 스코프(`GRANTABLE_AGENT_CREDENTIAL_SCOPES`)는
--   건드리지 않는다. Agent Port 도구는 hosted 자격증명만 도달한다.
-- * `workspace:propose` 는 어떤 REST 라우트도 열지 않는다
--   (`momo_auth::agent_scope::required_agent_scope` 표에 의도적으로 없다).
-- =============================================================================

-- 사람이 승인할 수 있는 집합.
ALTER TABLE hosted_agent_connection
  DROP CONSTRAINT hosted_agent_connection_scopes_ck,
  ADD CONSTRAINT hosted_agent_connection_scopes_ck CHECK (
    approved_scopes <@ ARRAY[
      'agent:port:connect','agent:inbox:read','messages:read','messages:write',
      'agent:jobs:read','agent:runs:callback','workspace:propose'
    ]::text[]
    AND (cardinality(approved_scopes) = 0 OR 'agent:port:connect' = ANY(approved_scopes))
  );

-- 자격증명이 실을 수 있는 집합. 074 의 세 credential_class 분기를 그대로 둔다.
ALTER TABLE token
  DROP CONSTRAINT token_hosted_binding_ck,
  ADD CONSTRAINT token_hosted_binding_ck CHECK (
    (credential_class = 'generic' AND hosted_connection_id IS NULL AND audience IS NULL)
    OR (credential_class IN ('hosted_active','hosted_oauth_access','hosted_oauth_refresh')
      AND hosted_connection_id IS NOT NULL
      AND audience = '/v1/mcp/agent-port'
      AND 'agent:port:connect' = ANY(scopes)
      AND scopes <@ ARRAY[
        'agent:port:connect', 'agent:inbox:read', 'messages:read',
        'messages:write', 'agent:jobs:read', 'agent:runs:callback',
        'workspace:propose'
      ]::text[])
  );

-- OAuth 로 요청·승인되는 집합. 승인이 요청을 넓히지 못한다는 규칙은 불변.
ALTER TABLE hosted_oauth_authorization_request
  DROP CONSTRAINT hosted_oauth_request_scope_ck,
  ADD CONSTRAINT hosted_oauth_request_scope_ck CHECK (
    requested_scopes <@ ARRAY[
      'agent:port:connect','agent:inbox:read','messages:read','messages:write',
      'agent:jobs:read','agent:runs:callback','workspace:propose'
    ]::text[]
    AND 'agent:port:connect' = ANY(requested_scopes)
    AND approved_scopes <@ requested_scopes
    AND (status = 'denied' OR 'agent:port:connect' = ANY(approved_scopes))
  );
