-- =============================================================================
-- 140_github_app.sql — #3947 E-GH1 (ADR-0205 D1·D2·D5·D6)
--
-- GitHub App 연동의 저장소. 인스턴스가 GitHub App 자격증명(개인키·webhook secret)을 **봉인해서**
-- 가진다. 사람의 OAuth 토큰이 아니라 인스턴스 자신의 통합 자격증명이다(ADR-0113 D1-B는 다시 열리지 않는다).
--
--   github_app                   인스턴스 싱글턴. 봉인한 pem·webhook_secret(현재 + 이전 + previous_valid_until).
--                                `client_secret` 칸은 **없다** — 변환 응답에서 받는 즉시 버린다(수용 6).
--   github_app_installation      전역(workspace_id 는 연결 전 NULL). 비밀 없음. 설치 → 워크스페이스 라우팅 표.
--   github_link_claim            tenant. 일회용 state 의 해시(앱 만들기 CSRF · 설치 연결 claim).
--   github_channel_subscription  tenant. 채널이 받을 저장소·기능 목록(E-GH2 가 쓴다).
--   github_receipt               tenant. (workspace_id, delivery_id) 멱등(E-GH2 가 쓴다).
--
-- 봉인 키는 독립 마스터키 `GITHUB_APP_MASTER_KEY`(도메인 `momo.github_app.key.v1\n`)다. DB 는 암호문만
-- 안다. PEM 을 여는 함수의 호출 지점은 1단계 바이너리에 0 이다(ADR-0205 D1, 수용 7 — grep 가드).
--
-- RLS (전부 ENABLE + FORCE)
--   * github_app: 두 갈래 GUC 정책 —
--       app.github_app_admin = 'on'  전체(SELECT·INSERT·UPDATE·DELETE). 라우트가 인스턴스 운영자
--                                    게이트(MOMO-583 쓰기형: PLATFORM_ADMIN_EMAILS)를 통과한 **뒤에만**
--                                    with_github_app_admin_tx 로 켠다(039 provider_link 모양).
--       app.github_ingress   = 'on'  SELECT 만(웹훅 서명 검증). 서명을 통과한 수신 함수 안에서만 켠다(E-GH2).
--     tenant 세션(app.workspace_id 만 켠 일반 tx)은 이 표를 **보지도 쓰지도 못한다**.
--   * github_app_installation: 세 갈래 —
--       SELECT  ingress | admin | (연결된 자기 워크스페이스 행)
--       INSERT  ingress 만(서명 검증을 통과한 수신 함수)
--       UPDATE  ingress | admin (연결 확정·정지·제거 표시). DELETE 정책 없음 = 기본 거부.
--     그래서 tenant 세션은 **연결 안 된 설치도 남의 설치도 SELECT 하지 못한다**(수용: RLS) — 인스턴스 안
--     다른 워크스페이스의 GitHub 계정 이름이 새지 않는다.
--   * 나머지 셋은 uniform ws_isolation. 쓰기 경로 BYPASSRLS 는 없다. 전 테넌트 BYPASSRLS 역할
--     (momo_relay·momo_worker)은 설계상 읽는다 — provider_link 와 같은 기존 예외이고 새 경로가 아니다.
--
-- 한 GitHub 계정(= installation_id)은 인스턴스당 한 워크스페이스에만 연결된다(PK = installation_id).
-- schema_v0.sql 은 건드리지 않는다. 모든 문장이 가드되어 다시 적용해도 무해하다.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- github_app — 싱글턴
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_app (
  -- 싱글턴 가드(039 provider_link 와 같다): id=true 한 행만 존재한다.
  id                                 boolean PRIMARY KEY DEFAULT true,
  app_id                             bigint NOT NULL,
  slug                               text NOT NULL,
  client_id                          text NOT NULL,
  owner_login                        text NOT NULL,
  owner_type                         text NOT NULL,
  -- AES-GCM 봉인(version || nonce || ct || tag). 평문은 저장·로그·감사에 오르지 않는다.
  pem_ciphertext                     bytea NOT NULL,
  webhook_secret_ciphertext          bytea NOT NULL,
  -- 회전 겹침 창(ADR-0205 D7): 창 안에서는 이전 값도 서명 검증을 통과한다.
  webhook_secret_previous_ciphertext bytea,
  previous_valid_until               timestamptz,
  -- 어떻게 들어왔나: 매니페스트 흐름 또는 손으로 만든 앱 붙여 넣기.
  source                             text NOT NULL,
  created_by                         uuid REFERENCES member(id) ON DELETE SET NULL,
  created_at                         timestamptz NOT NULL DEFAULT now(),
  updated_at                         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_app_singleton_ck CHECK (id = true),
  CONSTRAINT github_app_slug_ck CHECK (length(btrim(slug)) > 0 AND length(slug) <= 200),
  CONSTRAINT github_app_client_id_ck CHECK (length(btrim(client_id)) > 0 AND length(client_id) <= 200),
  CONSTRAINT github_app_owner_login_ck CHECK (length(btrim(owner_login)) > 0 AND length(owner_login) <= 200),
  CONSTRAINT github_app_owner_type_ck CHECK (owner_type IN ('User', 'Organization')),
  CONSTRAINT github_app_source_ck CHECK (source IN ('manifest', 'paste')),
  CONSTRAINT github_app_pem_ck CHECK (octet_length(pem_ciphertext) > 0),
  CONSTRAINT github_app_webhook_secret_ck CHECK (octet_length(webhook_secret_ciphertext) > 0),
  CONSTRAINT github_app_previous_pair_ck CHECK (
    (webhook_secret_previous_ciphertext IS NULL AND previous_valid_until IS NULL)
    OR (webhook_secret_previous_ciphertext IS NOT NULL AND previous_valid_until IS NOT NULL)
  )
);

COMMENT ON TABLE github_app IS
  'ADR-0205 D1: instance-singleton GitHub App credentials. pem and webhook secrets are AES-GCM '
  'sealed under GITHUB_APP_MASTER_KEY (domain momo.github_app.key.v1). No client_secret column exists '
  'by design: it is discarded the moment the manifest conversion returns.';
COMMENT ON COLUMN github_app.pem_ciphertext IS
  'Sealed GitHub App private key. Phase 1 never opens it (ADR-0205 D1, acceptance 7).';

ALTER TABLE github_app ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_app FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS github_app_operator ON github_app;
CREATE POLICY github_app_operator ON github_app
  USING (current_setting('app.github_app_admin', true) = 'on')
  WITH CHECK (current_setting('app.github_app_admin', true) = 'on');

DROP POLICY IF EXISTS github_app_ingress_read ON github_app;
CREATE POLICY github_app_ingress_read ON github_app
  FOR SELECT
  USING (current_setting('app.github_ingress', true) = 'on');

-- ---------------------------------------------------------------------------
-- github_app_installation — 전역 라우팅 표(비밀 없음)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_app_installation (
  installation_id      bigint PRIMARY KEY,
  account_login        text NOT NULL,
  account_type         text NOT NULL,
  repository_selection text NOT NULL,
  -- 연결 전 NULL. 연결되면 한 워크스페이스에만 묶인다(PK 가 한 계정 = 한 행을 보장).
  workspace_id         uuid REFERENCES workspace(id) ON DELETE SET NULL,
  linked_at            timestamptz,
  suspended_at         timestamptz,
  removed_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_app_installation_login_ck
    CHECK (length(btrim(account_login)) > 0 AND length(account_login) <= 200),
  CONSTRAINT github_app_installation_type_ck
    CHECK (account_type IN ('User', 'Organization')),
  CONSTRAINT github_app_installation_selection_ck
    CHECK (repository_selection IN ('all', 'selected')),
  CONSTRAINT github_app_installation_link_pair_ck
    CHECK ((workspace_id IS NULL) = (linked_at IS NULL))
);

CREATE INDEX IF NOT EXISTS github_app_installation_workspace_idx
  ON github_app_installation (workspace_id) WHERE workspace_id IS NOT NULL;

COMMENT ON TABLE github_app_installation IS
  'ADR-0205 D5: instance-global installation routing table. No secrets. workspace_id is NULL until '
  'both signals (setup-url claim + signed installation.created) meet. A tenant session can read only '
  'the rows linked to its own workspace.';

ALTER TABLE github_app_installation ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_app_installation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS github_app_installation_select ON github_app_installation;
CREATE POLICY github_app_installation_select ON github_app_installation
  FOR SELECT
  USING (
    current_setting('app.github_ingress', true) = 'on'
    OR current_setting('app.github_app_admin', true) = 'on'
    OR (workspace_id IS NOT NULL
        AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  );

DROP POLICY IF EXISTS github_app_installation_insert ON github_app_installation;
CREATE POLICY github_app_installation_insert ON github_app_installation
  FOR INSERT
  WITH CHECK (current_setting('app.github_ingress', true) = 'on');

DROP POLICY IF EXISTS github_app_installation_update ON github_app_installation;
CREATE POLICY github_app_installation_update ON github_app_installation
  FOR UPDATE
  USING (current_setting('app.github_ingress', true) = 'on'
         OR current_setting('app.github_app_admin', true) = 'on')
  WITH CHECK (current_setting('app.github_ingress', true) = 'on'
              OR current_setting('app.github_app_admin', true) = 'on');

-- ---------------------------------------------------------------------------
-- github_link_claim — tenant, 일회용 state 해시
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_link_claim (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  -- 'app_manifest': 운영자의 「GitHub 앱 만들기」 CSRF state(E-GH1).
  -- 'install'     : 워크스페이스 「GitHub 연결」 state(E-GH2, D3).
  purpose         text NOT NULL,
  -- SHA-256(state). 원문 state 는 저장하지 않는다.
  state_hash      bytea NOT NULL,
  -- 'install' 의 setup URL 이 돌려준 값(위조될 수 있어 서명 이벤트와 만나야 확정). 'app_manifest' 는 NULL.
  installation_id bigint,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_link_claim_purpose_ck CHECK (purpose IN ('app_manifest', 'install')),
  CONSTRAINT github_link_claim_hash_ck CHECK (octet_length(state_hash) = 32),
  CONSTRAINT github_link_claim_manifest_shape_ck
    CHECK (purpose <> 'app_manifest' OR installation_id IS NULL),
  CONSTRAINT github_link_claim_state_uq UNIQUE (state_hash)
);

CREATE INDEX IF NOT EXISTS github_link_claim_expiry_idx ON github_link_claim (expires_at);

COMMENT ON TABLE github_link_claim IS
  'ADR-0205 D2/D3: one-time state (hash only) for the manifest flow CSRF and the installation claim.';

ALTER TABLE github_link_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_link_claim FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON github_link_claim;
CREATE POLICY ws_isolation ON github_link_claim
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- github_channel_subscription — tenant (E-GH2 가 쓴다)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_channel_subscription (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id       uuid NOT NULL,
  installation_id  bigint NOT NULL REFERENCES github_app_installation(installation_id) ON DELETE CASCADE,
  -- 첫 이벤트에서 채워질 수 있다(ADR-0205 D5).
  repo_id          bigint,
  repo_full_name   text NOT NULL,
  -- 켠 기능. 기본은 Slack 앱을 본뜬 PR·이슈 기본 알림이고, 나머지는 선택(기본 꺼짐; D6).
  features         text[] NOT NULL DEFAULT ARRAY['pulls', 'issues']::text[],
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES member(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_channel_subscription_channel_fk
    FOREIGN KEY (channel_id, workspace_id) REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT github_channel_subscription_repo_ck
    CHECK (length(btrim(repo_full_name)) > 0 AND length(repo_full_name) <= 300),
  CONSTRAINT github_channel_subscription_features_ck
    CHECK (features <@ ARRAY['pulls', 'issues', 'reviews', 'comments', 'checks', 'commits', 'releases']::text[]),
  CONSTRAINT github_channel_subscription_uq UNIQUE (channel_id, installation_id, repo_full_name)
);

COMMENT ON TABLE github_channel_subscription IS
  'ADR-0205 D5: which repository a channel listens to and which features are on. Written by E-GH2 (#3954).';

-- 구독은 **자기 워크스페이스에 연결된** 설치만 가리킬 수 있다. FK 검사는 RLS 를 거치지 않으므로
-- 남의 installation_id 를 이름 붙이는 길을 DB 가 막는다. 트리거는 invoker 권한으로 돌아서
-- github_app_installation 의 tenant SELECT 정책이 그대로 적용된다(남의 설치는 보이지 않는다).
CREATE OR REPLACE FUNCTION github_channel_subscription_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.github_app_installation i
     WHERE i.installation_id = NEW.installation_id
       AND i.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'github_channel_subscription must name an installation linked to its own workspace (ADR-0205 D5)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS github_channel_subscription_guard ON github_channel_subscription;
CREATE TRIGGER github_channel_subscription_guard
  BEFORE INSERT OR UPDATE OF workspace_id, installation_id
  ON github_channel_subscription
  FOR EACH ROW EXECUTE FUNCTION github_channel_subscription_guard();

ALTER TABLE github_channel_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_channel_subscription FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON github_channel_subscription;
CREATE POLICY ws_isolation ON github_channel_subscription
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- github_receipt — tenant, delivery 멱등 (E-GH2 가 쓴다)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_receipt (
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- X-GitHub-Delivery. 재전송도 같은 GUID 라 중복으로 처리된다(서명에 시각이 없다; ADR-0205 D4).
  delivery_id      text NOT NULL,
  installation_id  bigint NOT NULL,
  event            text NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, delivery_id),
  CONSTRAINT github_receipt_delivery_ck CHECK (length(delivery_id) BETWEEN 1 AND 100),
  CONSTRAINT github_receipt_event_ck CHECK (length(event) BETWEEN 1 AND 100)
);

COMMENT ON TABLE github_receipt IS
  'ADR-0205 D4: (workspace_id, delivery_id) idempotence ledger. Written by E-GH2 (#3954).';

ALTER TABLE github_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_receipt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON github_receipt;
CREATE POLICY ws_isolation ON github_receipt
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
