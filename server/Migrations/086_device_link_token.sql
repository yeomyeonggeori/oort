-- =============================================================================
-- 086_device_link_token.sql — ADR-0180 / #1959 M0s 서버 절반
--
-- 기기 연결 1회용 QR 링크 토큰. 원문은 발급 응답에만 실리고 저장은 sha256.
-- TTL 120s · 1회 소비 · 발급자 세션에 귀속. schema_v0.sql 은 불변.
--
-- 공개 오리진 모드(D4)에서만 sas 4자리를 채운다. 루프백/LAN 은 NULL.
-- 소비 시 새 세션을 심고, sas 가 있으면 token.pending_sas 로 access 를 붙든다.
--
-- token.device_label 은 M0w 기기 목록용 nullable 추가(결정): 세션 토큰에
-- 기기명이 없었으므로 이 마이그레이션이 한 컬럼을 보탠다. pending_sas 는
-- 같은 행의 활성화 게이트다(기본 false — 기존 세션은 즉시 유효).
--
-- 브리프 컬럼 목록 밖의 가산(결정 주석):
--   device_platform          소비 기기 플랫폼. GET device? 투영.
--   redeemed_access_token_id  SAS 확인이 풀 세션 행.
--   redeemed_refresh_token_id 同上.
--   sas_confirmed_at         confirm-sas 멱등.
-- 만료 행 청소는 발급/소비 시 게으른 삭제. cron 없음.
-- =============================================================================

CREATE TABLE device_link_token (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id               uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id                  uuid NOT NULL,
  issued_session_token_id    uuid NOT NULL,
  token_hash                 bytea NOT NULL,
  sas                        text,
  expires_at                 timestamptz NOT NULL,
  consumed_at                timestamptz,
  device_label               text,
  device_platform            text,
  redeemed_access_token_id   uuid,
  redeemed_refresh_token_id  uuid,
  sas_confirmed_at           timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_link_token_member_fk
    FOREIGN KEY (workspace_id, member_id)
    REFERENCES member(workspace_id, id),
  CONSTRAINT device_link_token_issued_session_fk
    FOREIGN KEY (workspace_id, issued_session_token_id)
    REFERENCES token(workspace_id, id),
  CONSTRAINT device_link_token_redeemed_access_fk
    FOREIGN KEY (workspace_id, redeemed_access_token_id)
    REFERENCES token(workspace_id, id),
  CONSTRAINT device_link_token_redeemed_refresh_fk
    FOREIGN KEY (workspace_id, redeemed_refresh_token_id)
    REFERENCES token(workspace_id, id),
  CONSTRAINT device_link_token_hash_len_ck CHECK (octet_length(token_hash) = 32),
  CONSTRAINT device_link_token_expires_ck CHECK (expires_at > created_at),
  CONSTRAINT device_link_token_sas_ck CHECK (sas IS NULL OR sas ~ '^[0-9]{4}$'),
  CONSTRAINT device_link_token_hash_uniq UNIQUE (token_hash)
);

ALTER TABLE device_link_token
  ADD CONSTRAINT device_link_token_workspace_id_uniq UNIQUE (workspace_id, id);

CREATE INDEX device_link_token_expires_idx
  ON device_link_token (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX device_link_token_member_idx
  ON device_link_token (workspace_id, member_id, created_at DESC);

COMMENT ON TABLE device_link_token IS
  'ADR-0180 device-link QR token. SHA-256 of the raw token only; plaintext is never stored. TTL 120s, single-use.';
COMMENT ON COLUMN device_link_token.issued_session_token_id IS
  'Issuer access-token row. Redeem fails closed if this session is revoked (logout / password reset).';
COMMENT ON COLUMN device_link_token.sas IS
  'Four-digit SAS derived from the token hash. NULL in loopback/LAN mode (D4).';
COMMENT ON COLUMN device_link_token.device_label IS
  'Redeeming device name. Set at consume; GET status projects it.';

ALTER TABLE token
  ADD COLUMN device_label text;
ALTER TABLE token
  ADD COLUMN pending_sas boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN token.device_label IS
  'ADR-0180 optional device name on a session row. NULL for ordinary login/join/claim sessions. M0w device list reads this.';
COMMENT ON COLUMN token.pending_sas IS
  'ADR-0180 D4: true until the issuer confirms SAS in public-origin mode. Access/refresh with pending_sas are 401.';

ALTER TABLE device_link_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_link_token FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON device_link_token
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Same chicken-and-egg as invite join (009) and claim (078): the caller holds
-- only the raw token, so the tenant GUC cannot be set until this returns one
-- uuid. It returns no tenant row. EXECUTE is momo_app only.
CREATE FUNCTION momo_join_private.device_link_workspace_id(raw_token text)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT c.workspace_id
    FROM public.device_link_token AS c
    JOIN public.workspace AS w
      ON w.id = c.workspace_id
     AND w.deleted_at IS NULL
   WHERE c.token_hash = public.digest(raw_token, 'sha256')
   LIMIT 1;
$$;

COMMENT ON FUNCTION momo_join_private.device_link_workspace_id(text) IS
  'Device-link preflight only: maps one raw link token to its workspace UUID; returns no tenant row data.';

REVOKE ALL ON FUNCTION momo_join_private.device_link_workspace_id(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay') THEN
    REVOKE ALL ON FUNCTION momo_join_private.device_link_workspace_id(text) FROM momo_relay;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    REVOKE ALL ON FUNCTION momo_join_private.device_link_workspace_id(text) FROM momo_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_platform_admin') THEN
    REVOKE ALL ON FUNCTION momo_join_private.device_link_workspace_id(text) FROM momo_platform_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    REVOKE ALL ON FUNCTION momo_join_private.device_link_workspace_id(text) FROM momo_notifier;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT EXECUTE ON FUNCTION momo_join_private.device_link_workspace_id(text) TO momo_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE device_link_token TO momo_app;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename = 'device_link_token'
       AND policyname = 'ws_isolation'
  ) THEN
    RAISE EXCEPTION 'missing ws_isolation policy on device_link_token';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = 'device_link_token'
       AND c.relrowsecurity
       AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'device_link_token is missing FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
