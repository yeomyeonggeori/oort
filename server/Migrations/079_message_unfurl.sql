-- =============================================================================
-- 079_message_unfurl.sql — ADR-0170 / #1698 링크 언퍼얼 서버 표면
--
-- 파생 레코드다. message 본문·seq·channel_seq 를 한 컬럼도 수정하지 않는다.
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
--
-- P9 경계 (ADR-0170 D2): 워커는 메시지에서 URL 문자열만 집어 그 *대상*을
-- 읽는다. 알림 판정·에이전트 컨텍스트가 본문을 읽는 경로가 아니다. 발신자가
-- 사람인지 에이전트인지는 이 파일에도, 도메인 코드에도 분기가 없다.
--
-- 큐는 outbox 가 아니다. message INSERT 트리거가 unfurl_job 한 행을 남기고
-- (http(s) 본문이 있을 때만) 워커가 SKIP LOCKED 로 집어 OG/Twitter 를 fetch
-- 한 뒤 message_unfurl 에 upsert 하고, 광고만 emit_outbox(broadcast) 한다.
-- 신규 outbox_kind 도, 신규 바이너리도 없다 (ADR-0170 기각: 전용 마이크로서비스).
-- =============================================================================

CREATE TABLE workspace_unfurl_setting (
  workspace_id  uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT true,
  updated_by    uuid REFERENCES member(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE workspace_unfurl_setting IS
  'ADR-0170 D4 workspace on/off. Missing row means enabled. Off skips fetch, not just render.';

CREATE TABLE unfurl_job (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  message_id    uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending',
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  CONSTRAINT unfurl_job_status_ck CHECK (status IN ('pending', 'processing', 'done', 'skipped')),
  CONSTRAINT unfurl_job_attempts_ck CHECK (attempts >= 0),
  CONSTRAINT unfurl_job_message_uniq UNIQUE (message_id)
);

CREATE INDEX unfurl_job_pending_idx
  ON unfurl_job (created_at)
  WHERE status = 'pending';

COMMENT ON TABLE unfurl_job IS
  'ADR-0170 async unfurl queue. Produced by the message INSERT trigger; not an outbox kind.';

CREATE TABLE unfurl_url_cache (
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  url_key          text NOT NULL,
  status           text NOT NULL,
  title            text,
  description      text,
  domain           text,
  image_proxy_key  text,
  image_url        text,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  CONSTRAINT unfurl_url_cache_pk PRIMARY KEY (workspace_id, url_key),
  CONSTRAINT unfurl_url_cache_status_ck CHECK (status IN ('ok', 'failed', 'blocked')),
  CONSTRAINT unfurl_url_cache_key_ck CHECK (length(url_key) BETWEEN 1 AND 2048)
);

COMMENT ON TABLE unfurl_url_cache IS
  'Per-workspace normalised-URL cache, TTL 24h. Reuse skips fetch. Never shared across tenants.';

CREATE TABLE message_unfurl (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id       uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  message_id       uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  url_key          text NOT NULL,
  source_url       text NOT NULL,
  status           text NOT NULL,
  title            text,
  description      text,
  domain           text,
  image_proxy_key  text,
  image_url        text,
  fetched_at       timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_unfurl_status_ck CHECK (status IN ('pending', 'ok', 'failed', 'blocked')),
  CONSTRAINT message_unfurl_key_ck CHECK (length(url_key) BETWEEN 1 AND 2048),
  CONSTRAINT message_unfurl_source_ck CHECK (length(source_url) BETWEEN 1 AND 2048),
  CONSTRAINT message_unfurl_message_url_uniq UNIQUE (message_id, url_key)
);

CREATE INDEX message_unfurl_message_idx
  ON message_unfurl (workspace_id, message_id);

COMMENT ON TABLE message_unfurl IS
  'ADR-0170 derived link card. Sidecar of message — never mutates message or consumes seq.';
COMMENT ON COLUMN message_unfurl.image_url IS
  'Remote og:image URL consumed only by the authenticated proxy; never returned to clients.';
COMMENT ON COLUMN message_unfurl.image_proxy_key IS
  'Opaque sha256 of the normalised image URL. The client fetches through the server proxy.';

CREATE TABLE message_unfurl_tombstone (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  message_id    uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  removed_by    uuid REFERENCES member(id) ON DELETE SET NULL,
  removed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id)
);

COMMENT ON TABLE message_unfurl_tombstone IS
  'ADR-0170 D4 message-level removal. DELETE of message_unfurl plus this row blocks regeneration.';

-- ---------------------------------------------------------------------------
-- enqueue: http(s) in the body only. Not an outbox producer (overview.md:
-- the sole message-INSERT outbox producer remains push_candidate).
-- ---------------------------------------------------------------------------

CREATE FUNCTION enqueue_unfurl_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- URL-shape gate only. Extraction (code fences, emails, cap 3) is application
  -- code. The worker no-ops when the body has no remaining http(s) URLs.
  IF NEW.body IS NOT NULL
     AND NEW.deleted_at IS NULL
     AND NEW.body ~* 'https?://' THEN
    INSERT INTO unfurl_job (workspace_id, channel_id, message_id)
    VALUES (NEW.workspace_id, NEW.channel_id, NEW.id)
    ON CONFLICT (message_id) DO NOTHING;
    PERFORM pg_notify('unfurl', NEW.workspace_id::text);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER message_unfurl_enqueue
AFTER INSERT ON message
FOR EACH ROW EXECUTE FUNCTION enqueue_unfurl_job();

COMMENT ON FUNCTION enqueue_unfurl_job() IS
  'ADR-0170: queue a derived unfurl job when a newly inserted body looks like it contains http(s).';

-- ---------------------------------------------------------------------------
-- tenant isolation (048/062/078 form)
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_unfurl_setting',
    'unfurl_job',
    'unfurl_url_cache',
    'message_unfurl',
    'message_unfurl_tombstone'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      workspace_unfurl_setting, unfurl_job, unfurl_url_cache,
      message_unfurl, message_unfurl_tombstone TO momo_app;
  END IF;
  -- webhook-sender drains unfurl_job with RELAY_DATABASE_URL (momo_relay, BYPASSRLS).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      workspace_unfurl_setting, unfurl_job, unfurl_url_cache,
      message_unfurl, message_unfurl_tombstone TO momo_relay;
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_unfurl_setting',
    'unfurl_job',
    'unfurl_url_cache',
    'message_unfurl',
    'message_unfurl_tombstone'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = current_schema()
         AND tablename = t
         AND policyname = 'ws_isolation'
    ) THEN
      RAISE EXCEPTION 'missing ws_isolation policy on %', t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND c.relname = t
         AND c.relrowsecurity
         AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '% is missing FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
