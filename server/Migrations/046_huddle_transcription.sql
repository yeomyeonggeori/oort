-- =============================================================================
-- 046_huddle_transcription.sql — MOMO-646 / ADR-0122 V-4
--
-- Fail-closed recording consent and the post-call transcription queue.
-- Durable audio/transcript bytes stay on the existing attachment archive
-- contract (ADR-0113/0116); these tables store attachment ids, never paths.
-- =============================================================================

CREATE UNIQUE INDEX attachment_workspace_id_id_uniq
  ON attachment (workspace_id, id);

CREATE TABLE huddle_recording_consent (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  huddle_id     uuid NOT NULL REFERENCES huddle(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  notice_version integer NOT NULL DEFAULT 1 CHECK (notice_version = 1),
  consented_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (huddle_id, member_id)
);
CREATE INDEX huddle_recording_consent_workspace_idx
  ON huddle_recording_consent (workspace_id, huddle_id);

CREATE TABLE huddle_recording (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id       uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  huddle_id          uuid NOT NULL REFERENCES huddle(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  requested_by       uuid NOT NULL REFERENCES member(id),
  model               text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 255),
  status              text NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested','recording','stopped','failed')),
  notice_message_id   uuid NOT NULL REFERENCES message(id),
  egress_id           text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  stopped_at          timestamptz,
  failure_reason      text,
  UNIQUE (huddle_id),
  CONSTRAINT huddle_recording_time_ck CHECK (
    (started_at IS NULL OR started_at >= requested_at)
    AND (stopped_at IS NULL OR stopped_at >= COALESCE(started_at, requested_at))
  )
);
CREATE INDEX huddle_recording_status_idx
  ON huddle_recording (workspace_id, status, requested_at);

CREATE TABLE huddle_transcription_job (
  id                            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id                  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  huddle_id                     uuid NOT NULL REFERENCES huddle(id) ON DELETE CASCADE,
  recording_id                  uuid NOT NULL REFERENCES huddle_recording(id) ON DELETE CASCADE,
  channel_id                    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  model                         text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 255),
  status                        text NOT NULL DEFAULT 'queued'
                                CHECK (status IN ('queued','running','succeeded','failed')),
  merged_transcript_attachment_id uuid,
  queued_at                     timestamptz NOT NULL DEFAULT now(),
  started_at                    timestamptz,
  completed_at                  timestamptz,
  failure_reason                text,
  UNIQUE (recording_id),
  FOREIGN KEY (workspace_id, merged_transcript_attachment_id)
    REFERENCES attachment(workspace_id, id),
  CONSTRAINT huddle_transcription_job_time_ck CHECK (
    (started_at IS NULL OR started_at >= queued_at)
    AND (completed_at IS NULL OR completed_at >= COALESCE(started_at, queued_at))
  )
);
CREATE INDEX huddle_transcription_job_claim_idx
  ON huddle_transcription_job (queued_at, id)
  WHERE status = 'queued';

CREATE TABLE huddle_transcription_track (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id             uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  job_id                   uuid NOT NULL REFERENCES huddle_transcription_job(id) ON DELETE CASCADE,
  member_id                uuid NOT NULL REFERENCES member(id),
  livekit_track_sid        text NOT NULL,
  source_attachment_id     uuid,
  transcript_attachment_id uuid,
  started_at_ms            bigint NOT NULL DEFAULT 0 CHECK (started_at_ms >= 0),
  UNIQUE (job_id, livekit_track_sid),
  FOREIGN KEY (workspace_id, source_attachment_id)
    REFERENCES attachment(workspace_id, id),
  FOREIGN KEY (workspace_id, transcript_attachment_id)
    REFERENCES attachment(workspace_id, id)
);
CREATE INDEX huddle_transcription_track_job_idx
  ON huddle_transcription_track (workspace_id, job_id, member_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'huddle_recording_consent',
    'huddle_recording',
    'huddle_transcription_job',
    'huddle_transcription_track'
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
