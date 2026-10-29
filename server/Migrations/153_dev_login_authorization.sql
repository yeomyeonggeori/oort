-- =============================================================================
-- 153_dev_login_authorization.sql — #4700 (ADR-0216 D6 나 「브라우저 승인」, E3)
--
-- `oort login` 이 브라우저에서 사람 동의를 받으면 서버는 60초·1회용 코드를 만든다. 이 표가 그 코드의
-- 원장이다. 호스티드 OAuth 의 원장(074 hosted_oauth_authorization_request)과 같은 모양이지만 **다른 표**다:
-- 주체가 에이전트 연결이 아니라 사람 멤버이고, 코드가 사 주는 것이 `token_kind='dev'` 로그인 계보(152)이기
-- 때문이다. 두 원장이 한 표를 쓰면 한쪽의 CHECK·정책·청소가 다른 쪽을 건드린다.
--
--   - 서명된 승인 요청 봉투의 nonce(`request_nonce`)마다 최종 결정은 하나다(UNIQUE). 승인 두 번·거절 뒤 승인은
--     두 번째 INSERT 가 충돌해서 아무것도 만들지 못한다.
--   - 코드는 **봉투 전체의 SHA-256 만** 저장한다(`code_hash`). 원문은 승인 응답 한 번에만 있다. 접두가
--     `momo_devc_v1.` 이라 같은 비밀 바이트를 다른 접두(`momo_dev_v1`·`momo_devr_v1`·`momo_oauth_code_v1`)로
--     바꿔 내도 어떤 행과도 맞지 않는다(152 와 같은 원리).
--   - status 는 네 값이다. approved(교환 대기) → consumed(교환됨, 그 코드가 만든 계보 `session_id` 를 기억 →
--     코드가 다시 오면 그 계보를 끝낸다) / revoked(교환 전에 태워 버림: 비밀번호 변경·재설정 sweep, 또는 교환
--     시점 정책 재판정 거절). denied 는 코드가 없는 최종 결정이다.
--   - 비밀번호 변경·재설정은 같은 tx 에서 이 멤버의 approved 행을 revoked 로 만든다(dev_token.rs
--     `revoke_member_dev_tokens_in_tx`). 안 하면 변경 직후 60초 안에 새 로그인 계보가 생긴다(D7 연쇄의 구멍).
--
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL. 새 enum 값 없음(text + CHECK).
--
-- RLS: ENABLE + FORCE, 표준 ws_isolation(146·084·141 과 같은 문법). 공개 토큰 라우트는 코드 접두의
-- 워크스페이스로 tx 를 열고 `SET LOCAL app.workspace_id` 를 건 뒤에야 이 표를 본다(BYPASSRLS 아님).
-- =============================================================================

CREATE TABLE dev_login_authorization (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id           uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 승인(또는 거절)한 사람이자, 코드가 열 계보의 주인.
  member_id              uuid NOT NULL,
  -- 서명된 승인 요청 봉투가 실어 온 서버 발급 nonce. 이 키로 결정이 하나만 남는다.
  request_nonce          uuid NOT NULL,
  client_id              text NOT NULL CHECK (client_id = 'oort-cli'),
  redirect_uri           text NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2000),
  resource               text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2000),
  requested_scopes       text[] NOT NULL,
  approved_scopes        text[] NOT NULL DEFAULT '{}',
  code_challenge         text NOT NULL CHECK (octet_length(code_challenge) BETWEEN 43 AND 128),
  code_challenge_method  text NOT NULL CHECK (code_challenge_method = 'S256'),
  -- 연결하는 쪽이 정한 이름(검증된 사실이 아니다). 152 token.dev_device_name 과 같은 제약.
  device_name            text CHECK (
    device_name IS NULL
    OR (char_length(device_name) BETWEEN 1 AND 80 AND device_name !~ '[[:cntrl:]]')
  ),
  status                 text NOT NULL CHECK (status IN ('approved','denied','consumed','revoked')),
  decided_at             timestamptz NOT NULL DEFAULT now(),
  -- 봉투 전체의 digest 만. 원문 코드는 승인 응답 한 번에만 있다.
  code_hash              bytea,
  code_expires_at        timestamptz,
  code_consumed_at       timestamptz,
  -- 이 코드가 연 로그인 계보(token.session_id). consumed 에서만 있고, 코드 재제시 때 이 계보를 끝낸다.
  session_id             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dev_login_authorization_nonce_uniq UNIQUE (workspace_id, request_nonce),
  CONSTRAINT dev_login_authorization_member_fk
    FOREIGN KEY (workspace_id, member_id) REFERENCES member (workspace_id, id) ON DELETE CASCADE,
  -- 범위는 152 의 dev 어휘 안이고, 승인 ⊆ 요청이며, 승인에는 dev:identity 가 있다.
  CONSTRAINT dev_login_authorization_scope_ck CHECK (
    requested_scopes <@ ARRAY[
      'dev:identity','dev:channels:read','dev:messages:read','dev:messages:write','dev:inbox:read'
    ]::text[]
    AND 'dev:identity' = ANY(requested_scopes)
    AND approved_scopes <@ requested_scopes
    AND (status = 'denied' OR 'dev:identity' = ANY(approved_scopes))
  ),
  CONSTRAINT dev_login_authorization_shape_ck CHECK (
    (status = 'denied'
      AND code_hash IS NULL AND code_expires_at IS NULL AND code_consumed_at IS NULL
      AND session_id IS NULL AND cardinality(approved_scopes) = 0)
    OR (status = 'approved'
      AND code_hash IS NOT NULL AND code_expires_at IS NOT NULL AND code_consumed_at IS NULL
      AND session_id IS NULL)
    OR (status = 'consumed'
      AND code_hash IS NOT NULL AND code_consumed_at IS NOT NULL AND session_id IS NOT NULL)
    OR (status = 'revoked'
      AND code_hash IS NOT NULL AND code_expires_at IS NOT NULL AND code_consumed_at IS NULL
      AND session_id IS NULL)
  )
);

-- 코드로 행을 찾는 유일한 길(토큰 교환). 같은 워크스페이스 안에서 digest 는 유일하다.
CREATE UNIQUE INDEX dev_login_authorization_code_hash_uniq
  ON dev_login_authorization (workspace_id, code_hash) WHERE code_hash IS NOT NULL;

-- 비밀번호 변경·재설정 sweep 이 이 멤버의 교환 대기 코드를 한 번에 태운다.
CREATE INDEX dev_login_authorization_pending_idx
  ON dev_login_authorization (workspace_id, member_id) WHERE status = 'approved';

COMMENT ON TABLE dev_login_authorization IS
  'ADR-0216 D6 (#4700): ledger of `oort login` browser approvals — one terminal decision per signed request nonce, a 60 s single-use code stored only as a SHA-256 digest, and the login lineage (token.session_id) the code opened. A re-presented consumed code ends that lineage.';
COMMENT ON COLUMN dev_login_authorization.member_id IS
  'The human who approved (or denied) and who will own the login lineage. Re-judged (active, human, role admitted by the access switch) at code exchange as well as at consent (D6: two evaluation points).';
COMMENT ON COLUMN dev_login_authorization.code_hash IS
  'SHA-256 of the whole `momo_devc_v1.<workspace>.<secret>` envelope. The raw code exists once, in the approval response.';
COMMENT ON COLUMN dev_login_authorization.status IS
  'approved = awaiting exchange; consumed = exchanged (session_id names the lineage); revoked = burned before exchange (password change/reset sweep, or refused by the exchange-time policy re-judgement); denied = terminal refusal, no code.';
COMMENT ON COLUMN dev_login_authorization.device_name IS
  'Chosen by the connecting side, shown on the consent screen as such. Not a verified fact.';

ALTER TABLE dev_login_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_login_authorization FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON dev_login_authorization
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- 146 과 같은 방어: 런타임 역할이 이미 있으면(운영·격리 DB) 새 표 권한을 명시한다. 없으면(역할 이전의
-- 새 DB) bootstrap_*.sql 의 ALL TABLES 부여가 뒤따른다. 이 표는 DELETE 를 쓰지 않는다(청소는 후속).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE dev_login_authorization TO momo_app;
  END IF;
END $$;
