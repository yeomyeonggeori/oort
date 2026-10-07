-- =============================================================================
-- 121_work_host_folder.sql — #3590 N5 / ADR-0188 D6 / ADR-0198 증보 1 D7
--
-- The allowed folders a work host has issued, as the host announces them in its
-- signed heartbeat: an opaque id and a name to show, never a path. ADR-0188 D6
-- 「폰은 host가 발급한 불투명 폴더 id만 보낸다. 경로는 서버에 싣지 않는다」 is
-- kept in the table itself, not only at the REST boundary:
--   * `folder_id` is a closed alphabet, so it cannot be a path;
--   * `display_name` may not contain a path separator, so a host that sends
--     `/Users/x/project` instead of `project` is refused at insert.
-- `kind = 'question'` is the host-issued empty 「질문용 폴더」 (at most one per
-- host); `project` is a folder the owner allowed on the desktop.
-- =============================================================================

CREATE TABLE work_host_folder (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  host_id       uuid NOT NULL REFERENCES work_host(id) ON DELETE CASCADE,
  folder_id     text NOT NULL,
  display_name  text NOT NULL,
  kind          text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, folder_id),
  CONSTRAINT work_host_folder_id_ck
    CHECK (folder_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT work_host_folder_name_ck
    CHECK (
      length(btrim(display_name)) BETWEEN 1 AND 80
      AND display_name !~ '[/\\]'
      AND display_name !~ '[[:cntrl:]]'
    ),
  CONSTRAINT work_host_folder_kind_ck
    CHECK (kind IN ('project', 'question'))
);

-- At most one 「질문용 폴더」 per host: the default is a single answer.
CREATE UNIQUE INDEX work_host_folder_one_question_idx
  ON work_host_folder (host_id)
  WHERE kind = 'question';
CREATE INDEX work_host_folder_workspace_idx
  ON work_host_folder (workspace_id, host_id);

COMMENT ON TABLE work_host_folder IS
  'ADR-0188 D6: allowed folders a work host issued (opaque id + display name). '
  'Host-local paths never enter this table (#3590).';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_host_folder'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;
