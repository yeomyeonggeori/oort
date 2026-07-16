-- =============================================================================
-- 014_signed_webhook_ingress.sql — MOMO-412 / ADR-0115 SE-04B
--
-- Native HMAC and Slack-compatible incoming webhook installations. Raw native
-- secrets and Slack URL tokens are never stored: native keys persist only an
-- opaque derivation reference, while Slack keys persist a SHA-256 digest.
-- =============================================================================

-- MOMO-410's registry is the installation ledger for every plugin-shaped
-- integration. This server-owned reference plugin is deliberately not
-- installable through the generic MCP catalog route; WebhookRoutes creates the
-- workspace_plugin_install row together with the channel-bound installation.
WITH seed(plugin_id, version, manifest) AS (
  VALUES (
    'external_webhook',
    '1.0.0',
    $manifest$
    {
      "schemaVersion":"momo.plugin.v1",
      "plugin":{"id":"external_webhook","name":"Incoming Webhook","version":"1.0.0","description":"Server-owned signed and Slack-compatible incoming webhook","publisher":{"id":"momo","name":"momo","verified":true},"license":{"spdx":"Apache-2.0","kind":"open_source"},"provenance":{"sourceURL":"https://github.com/Dawn-kim-official/momo","releaseRef":"ADR-0115","verified":true}},
      "mcp":{"protocolVersion":"2025-06-18","transport":"streamable_http","url":"https://webhook.momo.invalid/mcp-disabled","server":{"name":"momo/external-webhook","version":"1.0.0"},"tools":[{"name":"external_webhook.receive","description":"Registry-only marker; ingress is available only through the webhook REST surface","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"schemaDigest":"sha256:4444444444444444444444444444444444444444444444444444444444444444","scopes":["webhook:receive"],"risk":"admin","approvalPolicy":"deny"}]},
      "skill":{"reference":null,"optional":true},
      "momo":{"approvalTier":{"external_webhook.receive":"network_write"},"risk":"high","egressDomains":["webhook.momo.invalid"],"recommendedFor":["ci-notifications","monitoring-alerts"],"serverPolicy":{"installAllowed":false,"enabledByDefault":false,"allowedRoles":["owner","admin"]}}
    }
    $manifest$::jsonb
  )
)
INSERT INTO plugin_registry (plugin_id, version, manifest, manifest_digest, official)
SELECT plugin_id,
       version,
       manifest,
       'sha256:' || encode(sha256(convert_to(manifest::text, 'UTF8')), 'hex'),
       true
  FROM seed
ON CONFLICT (plugin_id) DO NOTHING;

CREATE TABLE webhook_installation (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id          uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  plugin_install_id   uuid NOT NULL REFERENCES workspace_plugin_install(id),
  author_member_id    uuid NOT NULL REFERENCES member(id),
  mode                text NOT NULL,
  label               text NOT NULL,
  created_by          uuid NOT NULL REFERENCES member(id),
  created_audit_id    uuid NOT NULL REFERENCES audit_log(id),
  revoked_at          timestamptz,
  revoked_by          uuid REFERENCES member(id),
  revoked_audit_id    uuid REFERENCES audit_log(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_installation_mode_ck CHECK (mode IN ('native', 'slack_compatible')),
  CONSTRAINT webhook_installation_label_ck CHECK (length(label) BETWEEN 1 AND 80),
  CONSTRAINT webhook_installation_revoke_ck CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoked_audit_id IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_audit_id IS NOT NULL)
  )
);

CREATE TABLE webhook_secret_key (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  installation_id     uuid NOT NULL REFERENCES webhook_installation(id) ON DELETE CASCADE,
  mode                text NOT NULL,
  -- Native only: random, non-secret reference used with the server master key.
  -- The derived HMAC secret is revealed once and is never persisted.
  secret_ref          text,
  -- Slack-compatible only: SHA-256 of the complete high-entropy URL token.
  token_hash          text,
  valid_from          timestamptz NOT NULL DEFAULT now(),
  valid_until         timestamptz,
  revoked_at          timestamptz,
  created_by          uuid NOT NULL REFERENCES member(id),
  created_audit_id    uuid NOT NULL REFERENCES audit_log(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_secret_key_mode_ck CHECK (mode IN ('native', 'slack_compatible')),
  CONSTRAINT webhook_secret_key_material_ck CHECK (
    (mode = 'native' AND secret_ref IS NOT NULL AND token_hash IS NULL)
    OR
    (mode = 'slack_compatible' AND secret_ref IS NULL AND token_hash IS NOT NULL)
  ),
  CONSTRAINT webhook_secret_key_ref_ck CHECK (
    secret_ref IS NULL OR secret_ref ~ '^[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT webhook_secret_key_hash_ck CHECK (
    token_hash IS NULL OR token_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT webhook_secret_key_window_ck CHECK (
    valid_until IS NULL OR valid_until >= valid_from
  )
);

CREATE UNIQUE INDEX webhook_secret_token_hash_uniq
  ON webhook_secret_key (workspace_id, token_hash)
  WHERE token_hash IS NOT NULL;
CREATE INDEX webhook_secret_install_active_idx
  ON webhook_secret_key (workspace_id, installation_id, valid_until)
  WHERE revoked_at IS NULL;

CREATE TABLE webhook_receipt (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  installation_id     uuid NOT NULL REFERENCES webhook_installation(id) ON DELETE CASCADE,
  mode                text NOT NULL,
  delivery_id         text,
  body_sha256         text NOT NULL,
  dedupe_window_start timestamptz,
  client_msg_id       uuid NOT NULL,
  message_id          uuid REFERENCES message(id) ON DELETE SET NULL,
  message_seq         bigint,
  received_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_receipt_mode_ck CHECK (mode IN ('native', 'slack_compatible')),
  CONSTRAINT webhook_receipt_hash_ck CHECK (body_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT webhook_receipt_shape_ck CHECK (
    (mode = 'native' AND delivery_id IS NOT NULL AND dedupe_window_start IS NULL)
    OR
    (mode = 'slack_compatible' AND delivery_id IS NULL AND dedupe_window_start IS NOT NULL)
  ),
  CONSTRAINT webhook_receipt_message_ck CHECK (
    (message_id IS NULL AND message_seq IS NULL)
    OR
    (message_id IS NOT NULL AND message_seq IS NOT NULL)
  )
);

CREATE UNIQUE INDEX webhook_receipt_native_uniq
  ON webhook_receipt (workspace_id, installation_id, delivery_id)
  WHERE mode = 'native';
CREATE UNIQUE INDEX webhook_receipt_slack_uniq
  ON webhook_receipt (workspace_id, installation_id, body_sha256, dedupe_window_start)
  WHERE mode = 'slack_compatible';
CREATE INDEX webhook_receipt_install_time_idx
  ON webhook_receipt (workspace_id, installation_id, received_at DESC);

COMMENT ON TABLE webhook_installation IS
  'Channel-bound external_webhook installation and dedicated non-login author identity.';
COMMENT ON TABLE webhook_secret_key IS
  'Secret metadata only. Never stores a raw native HMAC secret or Slack URL token.';
COMMENT ON TABLE webhook_receipt IS
  'Verified ingress idempotency ledger; message/outbox are committed in the same tenant transaction.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'webhook_installation','webhook_secret_key','webhook_receipt'
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
