-- =============================================================================
-- 080_hosted_agent_doorbell.sql — ADR-0171 / #1734 hosted 커넥션 도어벨
--
-- active hosted connection 에 운영자가 등록하는 wake URL + Bearer 시크릿.
-- 시크릿은 AEAD 봉인만 저장한다. 원문은 컬럼에 없다.
--
-- 큐는 outbox 가 아니다. hosted inbox append 파생을 momo-webhook-sender 가
-- 폴링으로 소비한다. 이 파일은 CREATE TRIGGER 를 추가하지 않으며 INSERT INTO
-- outbox 도 없다 (ADR-0171 D3 — 신규 outbox 생산자 트리거 신설 금지).
-- schema_v0.sql 은 불변.
-- =============================================================================

CREATE TABLE hosted_agent_doorbell (
  workspace_id          uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  connection_id         uuid NOT NULL,
  url                   text NOT NULL,
  secret_sealed         bytea NOT NULL,
  secret_masked         text NOT NULL,
  registered_at         timestamptz NOT NULL DEFAULT now(),
  registered_by         uuid NOT NULL,
  last_fired_at         timestamptz,
  last_status           text,
  last_seen_inbox_seq   bigint NOT NULL DEFAULT 0 CHECK (last_seen_inbox_seq >= 0),
  pending_trailing      boolean NOT NULL DEFAULT false,
  window_started_at     timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id),
  CONSTRAINT hosted_agent_doorbell_connection_fk
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES hosted_agent_connection(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT hosted_agent_doorbell_registered_by_fk
    FOREIGN KEY (workspace_id, registered_by)
    REFERENCES member(workspace_id, id),
  CONSTRAINT hosted_agent_doorbell_url_ck CHECK (
    length(url) BETWEEN 1 AND 2048
  ),
  CONSTRAINT hosted_agent_doorbell_secret_sealed_ck CHECK (
    octet_length(secret_sealed) >= 29
  ),
  CONSTRAINT hosted_agent_doorbell_secret_masked_ck CHECK (
    length(secret_masked) BETWEEN 1 AND 32
  )
);

CREATE INDEX hosted_agent_doorbell_workspace_idx
  ON hosted_agent_doorbell (workspace_id, connection_id);

COMMENT ON TABLE hosted_agent_doorbell IS
  'ADR-0171 connection-scoped doorbell destination. Secret is AEAD-sealed; no outbox producer trigger.';
COMMENT ON COLUMN hosted_agent_doorbell.secret_sealed IS
  'AES-GCM sealed operator Bearer. Plaintext never stored.';
COMMENT ON COLUMN hosted_agent_doorbell.secret_masked IS
  'Non-secret display tail for GET; never enough to reconstruct the Bearer.';
COMMENT ON COLUMN hosted_agent_doorbell.last_seen_inbox_seq IS
  'Highest hosted_agent_inbox_counter.last_seq consumed by the sender. Not a channel sequence.';

ALTER TABLE hosted_agent_doorbell ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agent_doorbell FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON hosted_agent_doorbell
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hosted_agent_doorbell TO momo_app;
  END IF;
  -- webhook-sender drains with RELAY_DATABASE_URL (momo_relay, BYPASSRLS).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hosted_agent_doorbell TO momo_relay;
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hosted_agent_doorbell'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = current_schema() AND tablename = t AND policyname = 'ws_isolation'
    ) THEN
      RAISE EXCEPTION 'missing ws_isolation policy on %', t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relname = t
         AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS FORCE missing on %', t;
    END IF;
  END LOOP;
END $$;
