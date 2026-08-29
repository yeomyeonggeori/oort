-- =============================================================================
-- 082_message_reminder.sql — ADR-0175 / #1888 BF-B1 서버 절반
--
-- 메시지 "나중에 알림". 개인 원장이다. pin(채널의 사실)과 달리 한 행은
-- 한 사람의 것이고, 만기 통지는 v1에서 클라 폴링(outbox 팬아웃 없음).
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
--
-- RLS 는 테넌트 GUC(app.workspace_id)에 더해 소유자 GUC(app.member_id)를
-- 요구한다. 워크스페이스 스코프만으로는 타인 행이 보이지 않는다.
-- =============================================================================

CREATE TABLE message_reminder (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  message_id    uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  due_at        timestamptz NOT NULL,
  note          text,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_reminder_note_len_ck
    CHECK (note IS NULL OR char_length(note) <= 500)
);

CREATE INDEX message_reminder_due_idx
  ON message_reminder (workspace_id, member_id, due_at)
  WHERE completed_at IS NULL;

COMMENT ON TABLE message_reminder IS
  'ADR-0175 personal message reminder. Owner-scoped; no outbox fan-out in v1.';
COMMENT ON COLUMN message_reminder.member_id IS
  'Owning human member. RLS matches app.member_id; the API never takes a memberId.';
COMMENT ON COLUMN message_reminder.note IS
  'Optional memo, at most 500 characters. NULL when absent.';
COMMENT ON COLUMN message_reminder.completed_at IS
  'NULL = pending. Set once by PATCH {completed: true}; snooze refuses a completed row.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_reminder'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY reminder_owner ON %I
      USING (
        workspace_id = current_setting('app.workspace_id', true)::uuid
        AND member_id = nullif(current_setting('app.member_id', true), '')::uuid
      )
      WITH CHECK (
        workspace_id = current_setting('app.workspace_id', true)::uuid
        AND member_id = nullif(current_setting('app.member_id', true), '')::uuid
      );
    $f$, t);
  END LOOP;
END $$;
