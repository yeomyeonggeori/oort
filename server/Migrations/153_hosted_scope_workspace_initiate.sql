-- =============================================================================
-- 153_hosted_scope_workspace_initiate.sql — ADR-0186 증보 v5 U-b (#4704, N3-A)
--
-- hosted 스코프 어휘에 `workspace:initiate` 한 줄을 더한다. 사람이 부르지 않았는데
-- 에이전트가 소유자 DM에 승인 카드를 올리는 도구(`oort_action_initiate`)의 문이다.
-- 테이블·컬럼·인덱스 추가 없음. `schema_v0.sql` 무접촉. 087과 같은 방식이다.
--
-- ## 왜 CHECK 세 개를 한 번에
--
-- 스코프 어휘는 text[] 열**에 더해** CHECK 제약 세 개가 열거한다(087 머리말).
--
--   * `hosted_agent_connection_scopes_ck`  사람이 승인할 수 있는 집합
--   * `token_hosted_binding_ck`            자격증명이 실을 수 있는 집합
--   * `hosted_oauth_request_scope_ck`      OAuth 로 요청·승인되는 집합
--
-- 하나만 늘리면 「스코프가 있는데 도구가 안 열린다」는 진단 불가능한 반쪽 상태가
-- 된다. 셋은 같은 한 가지 사실의 세 위치다.
--
-- ## 넓히지 않는 것
--
-- * 기존 연결의 승인 범위(`approved_scopes`)는 그대로다. 이 마이그레이션은 어휘만
--   넓히고 어떤 행도 바꾸지 않는다. 새 능력은 재연결(관리자의 confirm/consent)로만
--   생긴다 — 조용한 승격이 없다.
-- * `agent:port:connect` 필수 규칙, generic/hosted 분기, audience 고정,
--   `approved_scopes <@ requested_scopes`, denied 분기는 그대로다.
-- * generic agent bearer 의 허용 스코프는 건드리지 않는다.
-- * `workspace:initiate` 는 어떤 REST 라우트도 열지 않는다
--   (`momo_auth::agent_scope::required_agent_scope` 표에 의도적으로 없다).
-- =============================================================================

-- 사람이 승인할 수 있는 집합.
ALTER TABLE hosted_agent_connection
  DROP CONSTRAINT hosted_agent_connection_scopes_ck,
  ADD CONSTRAINT hosted_agent_connection_scopes_ck CHECK (
    approved_scopes <@ ARRAY[
      'agent:port:connect','agent:inbox:read','messages:read','messages:write',
      'agent:jobs:read','agent:runs:callback','workspace:propose','workspace:initiate'
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
        'workspace:propose', 'workspace:initiate'
      ]::text[])
  );

-- OAuth 로 요청·승인되는 집합. 승인이 요청을 넓히지 못한다는 규칙은 불변.
ALTER TABLE hosted_oauth_authorization_request
  DROP CONSTRAINT hosted_oauth_request_scope_ck,
  ADD CONSTRAINT hosted_oauth_request_scope_ck CHECK (
    requested_scopes <@ ARRAY[
      'agent:port:connect','agent:inbox:read','messages:read','messages:write',
      'agent:jobs:read','agent:runs:callback','workspace:propose','workspace:initiate'
    ]::text[]
    AND 'agent:port:connect' = ANY(requested_scopes)
    AND approved_scopes <@ requested_scopes
    AND (status = 'denied' OR 'agent:port:connect' = ANY(approved_scopes))
  );
