-- =============================================================================
-- 027_memory_plane.sql — MOMO-526 / ADR-0129 D1, D2, D5
--
-- PG-native memory ledger. Message text is never copied into source refs;
-- memory_source_ref contains identifiers only. Provider credentials and raw
-- runtime context have no columns in this schema.
-- =============================================================================

-- Composite keys make tenant identity part of every memory foreign key.
CREATE UNIQUE INDEX IF NOT EXISTS member_workspace_id_uniq
  ON member (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_workspace_id_uniq
  ON channel (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS message_workspace_id_uniq
  ON message (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS message_channel_id_uniq
  ON message (channel_id, id);

CREATE TABLE memory_item (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id               uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  scope                      text NOT NULL,
  subject_member_id          uuid,
  agent_member_id            uuid,
  channel_id                 uuid,
  kind                       text NOT NULL,
  -- 델타 3: v1 추출원 확장(첨부·Drive·웹훅) 대비 — v0는 'message' 고정.
  source_kind                text NOT NULL DEFAULT 'message',
  body                       text NOT NULL,
  confidence                 double precision NOT NULL DEFAULT 0.5,
  valid_at                   timestamptz NOT NULL DEFAULT now(),
  invalid_at                 timestamptz,
  invalidated_by_memory_id   uuid,
  created_by_kind            text NOT NULL,
  created_by_member_id       uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_item_workspace_id_uniq UNIQUE (workspace_id, id),
  CONSTRAINT memory_item_scope_ck
    CHECK (scope IN ('workspace', 'member', 'agent', 'conversation')),
  CONSTRAINT memory_item_kind_ck
    CHECK (kind IN ('profile', 'fact', 'episode', 'procedure')),
  CONSTRAINT memory_item_body_ck CHECK (length(btrim(body)) BETWEEN 1 AND 16384),
  CONSTRAINT memory_item_confidence_ck CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT memory_item_creator_kind_ck
    CHECK (created_by_kind IN ('human', 'agent', 'worker')),
  CONSTRAINT memory_item_scope_subject_ck CHECK (
    (scope = 'workspace' AND subject_member_id IS NULL AND agent_member_id IS NULL AND channel_id IS NULL)
    OR (scope = 'member' AND subject_member_id IS NOT NULL AND agent_member_id IS NULL AND channel_id IS NULL)
    OR (scope = 'agent' AND subject_member_id IS NULL AND agent_member_id IS NOT NULL AND channel_id IS NULL)
    OR (scope = 'conversation' AND subject_member_id IS NULL AND channel_id IS NOT NULL)
  ),
  CONSTRAINT memory_item_invalid_time_ck
    CHECK (invalid_at IS NULL OR invalid_at >= valid_at),
  CONSTRAINT memory_item_subject_fk
    FOREIGN KEY (workspace_id, subject_member_id)
    REFERENCES member(workspace_id, id),
  CONSTRAINT memory_item_agent_fk
    FOREIGN KEY (workspace_id, agent_member_id)
    REFERENCES member(workspace_id, id),
  CONSTRAINT memory_item_channel_fk
    FOREIGN KEY (workspace_id, channel_id)
    REFERENCES channel(workspace_id, id),
  CONSTRAINT memory_item_creator_fk
    FOREIGN KEY (workspace_id, created_by_member_id)
    REFERENCES member(workspace_id, id),
  CONSTRAINT memory_item_invalidator_fk
    FOREIGN KEY (workspace_id, invalidated_by_memory_id)
    REFERENCES memory_item(workspace_id, id),
  CONSTRAINT memory_item_invalidator_ck
    CHECK (invalidated_by_memory_id IS NULL OR invalid_at IS NOT NULL)
);

CREATE INDEX memory_item_active_scope_idx
  ON memory_item (workspace_id, scope, kind, valid_at DESC, id)
  WHERE invalid_at IS NULL;
CREATE INDEX memory_item_subject_idx
  ON memory_item (workspace_id, subject_member_id, valid_at DESC)
  WHERE subject_member_id IS NOT NULL AND invalid_at IS NULL;
CREATE INDEX memory_item_agent_idx
  ON memory_item (workspace_id, agent_member_id, valid_at DESC)
  WHERE agent_member_id IS NOT NULL AND invalid_at IS NULL;
CREATE INDEX memory_item_channel_idx
  ON memory_item (workspace_id, channel_id, valid_at DESC)
  WHERE channel_id IS NOT NULL AND invalid_at IS NULL;

CREATE TABLE memory_source_ref (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  memory_id     uuid NOT NULL,
  message_id    uuid NOT NULL,
  channel_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_source_ref_uniq UNIQUE (memory_id, message_id),
  CONSTRAINT memory_source_ref_memory_fk
    FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memory_item(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT memory_source_ref_message_fk
    FOREIGN KEY (workspace_id, message_id)
    REFERENCES message(workspace_id, id),
  CONSTRAINT memory_source_ref_channel_fk
    FOREIGN KEY (workspace_id, channel_id)
    REFERENCES channel(workspace_id, id),
  CONSTRAINT memory_source_ref_message_channel_fk
    FOREIGN KEY (channel_id, message_id)
    REFERENCES message(channel_id, id)
);
CREATE INDEX memory_source_ref_message_idx
  ON memory_source_ref (workspace_id, channel_id, message_id);

-- 델타 1(2026-07-21 비전 정합 검토): 스코프 기본을 넘는 명시 접근 권한.
-- v0는 스키마+RLS만 — 서빙 필터 소비는 MOMO-528, 관리 UI는 MOMO-529.
CREATE TABLE memory_visibility_grant (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  memory_id     uuid NOT NULL,
  grantee_kind  text NOT NULL,
  grantee_id    uuid NOT NULL,
  granted_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  CONSTRAINT memory_visibility_grant_kind_ck
    CHECK (grantee_kind IN ('member', 'agent')),
  CONSTRAINT memory_visibility_grant_uniq UNIQUE (memory_id, grantee_kind, grantee_id),
  CONSTRAINT memory_visibility_grant_memory_fk
    FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memory_item(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX memory_visibility_grant_grantee_idx
  ON memory_visibility_grant (workspace_id, grantee_kind, grantee_id)
  WHERE revoked_at IS NULL;

CREATE TABLE memory_lifecycle_event (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  memory_id         uuid,
  candidate_id      uuid,
  action            text NOT NULL,
  actor_member_id   uuid,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_lifecycle_event_action_ck CHECK (action IN (
    'created', 'updated', 'invalidated', 'deleted', 'noop',
    'candidate_created', 'candidate_applied', 'candidate_rejected'
  )),
  CONSTRAINT memory_lifecycle_event_memory_fk
    FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memory_item(workspace_id, id) ON DELETE SET NULL (memory_id),
  CONSTRAINT memory_lifecycle_event_actor_fk
    FOREIGN KEY (workspace_id, actor_member_id)
    REFERENCES member(workspace_id, id)
);
CREATE INDEX memory_lifecycle_event_memory_idx
  ON memory_lifecycle_event (workspace_id, memory_id, created_at DESC, id DESC);

CREATE TABLE memory_candidate (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id       uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL,
  operation          text NOT NULL,
  target_memory_id   uuid,
  scope              text NOT NULL,
  subject_member_id  uuid,
  agent_member_id    uuid,
  kind               text NOT NULL,
  body               text NOT NULL,
  confidence         double precision NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  extractor_kind     text NOT NULL,
  extractor_version  text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  applied_at         timestamptz,
  CONSTRAINT memory_candidate_workspace_id_uniq UNIQUE (workspace_id, id),
  CONSTRAINT memory_candidate_operation_ck
    CHECK (operation IN ('ADD', 'UPDATE', 'INVALIDATE', 'NOOP')),
  CONSTRAINT memory_candidate_scope_ck
    CHECK (scope IN ('workspace', 'member', 'agent', 'conversation')),
  CONSTRAINT memory_candidate_kind_ck
    CHECK (kind IN ('profile', 'fact', 'episode', 'procedure')),
  CONSTRAINT memory_candidate_body_ck CHECK (length(btrim(body)) BETWEEN 1 AND 16384),
  CONSTRAINT memory_candidate_confidence_ck CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT memory_candidate_status_ck
    CHECK (status IN ('pending', 'applied', 'rejected')),
  CONSTRAINT memory_candidate_scope_subject_ck CHECK (
    (scope = 'workspace' AND subject_member_id IS NULL AND agent_member_id IS NULL)
    OR (scope = 'member' AND subject_member_id IS NOT NULL AND agent_member_id IS NULL)
    OR (scope = 'agent' AND subject_member_id IS NULL AND agent_member_id IS NOT NULL)
    OR scope = 'conversation'
  ),
  CONSTRAINT memory_candidate_operation_target_ck CHECK (
    (operation = 'ADD' AND target_memory_id IS NULL)
    OR (operation IN ('UPDATE', 'INVALIDATE') AND target_memory_id IS NOT NULL)
    OR operation = 'NOOP'
  ),
  CONSTRAINT memory_candidate_channel_fk
    FOREIGN KEY (workspace_id, channel_id)
    REFERENCES channel(workspace_id, id),
  CONSTRAINT memory_candidate_target_fk
    FOREIGN KEY (workspace_id, target_memory_id)
    REFERENCES memory_item(workspace_id, id),
  CONSTRAINT memory_candidate_subject_fk
    FOREIGN KEY (workspace_id, subject_member_id)
    REFERENCES member(workspace_id, id),
  CONSTRAINT memory_candidate_agent_fk
    FOREIGN KEY (workspace_id, agent_member_id)
    REFERENCES member(workspace_id, id)
);
CREATE INDEX memory_candidate_pending_idx
  ON memory_candidate (workspace_id, channel_id, created_at, id)
  WHERE status = 'pending';

-- Durable per-channel watermark. It advances only in the same transaction as
-- candidate application, so a crash cannot silently skip a message range.
CREATE TABLE memory_extraction_cursor (
  workspace_id       uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL,
  last_extracted_seq bigint NOT NULL DEFAULT 0 CHECK (last_extracted_seq >= 0),
  lease_token        uuid,
  leased_until       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, channel_id),
  CONSTRAINT memory_extraction_cursor_channel_fk
    FOREIGN KEY (workspace_id, channel_id)
    REFERENCES channel(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX memory_extraction_cursor_claim_idx
  ON memory_extraction_cursor (leased_until, updated_at, workspace_id, channel_id);

-- Workspace administrators own this switch. enabled=false is coupled to a
-- server-side bulk purge transaction; clients cannot issue per-item DELETE.
CREATE TABLE workspace_memory_policy (
  workspace_id  uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT true,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_memory_policy_updater_fk
    FOREIGN KEY (workspace_id, updated_by)
    REFERENCES member(workspace_id, id)
);

ALTER TABLE memory_lifecycle_event
  ADD CONSTRAINT memory_lifecycle_event_candidate_fk
  FOREIGN KEY (workspace_id, candidate_id)
  REFERENCES memory_candidate(workspace_id, id) ON DELETE SET NULL (candidate_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memory_item', 'memory_source_ref', 'memory_lifecycle_event',
    'memory_candidate', 'memory_extraction_cursor', 'workspace_memory_policy',
    'memory_visibility_grant'
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

COMMENT ON TABLE memory_source_ref IS
  'Source identifiers only. Message body, excerpts, provider credentials, and raw runtime context are forbidden.';
COMMENT ON TABLE memory_extraction_cursor IS
  'Per-channel periodic extraction watermark advanced atomically with candidate application.';
