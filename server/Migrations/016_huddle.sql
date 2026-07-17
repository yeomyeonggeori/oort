-- =============================================================================
-- 016_huddle.sql — MOMO-468 / ADR-0122 V-1
--
-- Channel-bound, ephemeral voice huddles. PostgreSQL owns lifecycle and
-- participant history; LiveKit receives only short-lived room grants.
-- =============================================================================

CREATE TABLE huddle (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  started_by    uuid NOT NULL REFERENCES member(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  CONSTRAINT huddle_time_ck CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- One active huddle per channel. Historical rows remain queryable.
CREATE UNIQUE INDEX huddle_channel_active_uniq
  ON huddle (channel_id)
  WHERE ended_at IS NULL;
CREATE INDEX huddle_workspace_channel_time_idx
  ON huddle (workspace_id, channel_id, started_at DESC);

CREATE TABLE huddle_participant (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  huddle_id     uuid NOT NULL REFERENCES huddle(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  left_at       timestamptz,
  PRIMARY KEY (huddle_id, member_id, joined_at),
  CONSTRAINT huddle_participant_time_ck
    CHECK (left_at IS NULL OR left_at >= joined_at)
);

-- A member can re-enter after leaving, but can have only one current presence.
CREATE UNIQUE INDEX huddle_participant_active_uniq
  ON huddle_participant (huddle_id, member_id)
  WHERE left_at IS NULL;
CREATE INDEX huddle_participant_current_idx
  ON huddle_participant (workspace_id, huddle_id, joined_at)
  WHERE left_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['huddle','huddle_participant'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;
