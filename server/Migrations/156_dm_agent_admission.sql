-- ADR-0217 / #4792: unanimous human consent before an agent joins a DM.
CREATE TABLE dm_agent_admission (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspace(id),
    channel_id uuid NOT NULL REFERENCES channel(id),
    agent_member_id uuid NOT NULL REFERENCES member(id),
    requested_by uuid NOT NULL REFERENCES member(id),
    trigger_message_id uuid NOT NULL REFERENCES message(id),
    required_human_ids uuid[] NOT NULL CHECK (cardinality(required_human_ids) > 0),
    connection_id uuid REFERENCES hosted_agent_connection(id),
    expires_at timestamptz NOT NULL,
    admitted_at timestamptz,
    admitted_after_seq bigint,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((admitted_at IS NULL) = (admitted_after_seq IS NULL))
);
CREATE INDEX dm_agent_admission_room ON dm_agent_admission(workspace_id, channel_id, agent_member_id);
CREATE UNIQUE INDEX dm_agent_admission_active ON dm_agent_admission(workspace_id, channel_id, agent_member_id)
    WHERE admitted_at IS NOT NULL AND revoked_at IS NULL;
ALTER TABLE dm_agent_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_agent_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON dm_agent_admission
    USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- SECURITY INVOKER: the tenant policy is retained. The trigger exception is one
-- message, never its quoted message, thread root, or the preceding history.
CREATE FUNCTION dm_agent_message_visible(p_ws uuid, p_channel uuid, p_agent uuid,
                                        p_message uuid, p_created timestamptz, p_seq bigint)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT NOT EXISTS (SELECT 1 FROM channel WHERE workspace_id = p_ws AND id = p_channel AND kind = 'dm')
    OR (
        EXISTS (SELECT 1 FROM membership ms JOIN member m ON m.id = ms.member_id AND m.workspace_id = ms.workspace_id
                WHERE ms.workspace_id = p_ws AND ms.channel_id = p_channel AND ms.member_id = p_agent
                  AND ms.left_at IS NULL AND m.status = 'active' AND m.deleted_at IS NULL)
        AND (
            EXISTS (SELECT 1 FROM dm_agent_admission d
                    WHERE d.workspace_id = p_ws AND d.channel_id = p_channel AND d.agent_member_id = p_agent
                      AND d.admitted_at IS NOT NULL AND d.revoked_at IS NULL
                      AND ((p_created >= d.admitted_at AND p_seq > d.admitted_after_seq) OR p_message = d.trigger_message_id))
            OR (NOT EXISTS (SELECT 1 FROM dm_agent_admission d WHERE d.workspace_id = p_ws AND d.channel_id = p_channel AND d.agent_member_id = p_agent)
                AND (SELECT count(*) FROM membership ms WHERE ms.workspace_id = p_ws AND ms.channel_id = p_channel AND ms.left_at IS NULL) = 2)
        )
    )
$$;

-- One request-local actor, bound by momo-db. Covers nested quotes, search,
-- threads, attachments joined through message, and every REST/Agent Port read.
CREATE POLICY dm_agent_read_boundary ON message AS RESTRICTIVE FOR SELECT
    USING (NULLIF(current_setting('app.agent_member_id', true), '') IS NULL
        OR dm_agent_message_visible(workspace_id, channel_id,
             NULLIF(current_setting('app.agent_member_id', true), '')::uuid, id, created_at, seq));

-- All writers, including the BYPASSRLS worker, meet the same departure gate.
-- Lock the membership until commit, so removal waits for an in-flight write;
-- after removal commits no later write can pass. Server notices are human-authored.
CREATE FUNCTION guard_dm_agent_write() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM channel WHERE id = NEW.channel_id AND workspace_id = NEW.workspace_id AND kind = 'dm')
       AND EXISTS (SELECT 1 FROM member WHERE id = NEW.author_member_id AND workspace_id = NEW.workspace_id AND kind = 'agent') THEN
        PERFORM 1 FROM membership ms JOIN member m ON m.id = ms.member_id AND m.workspace_id = ms.workspace_id
            WHERE ms.workspace_id = NEW.workspace_id AND ms.channel_id = NEW.channel_id
              AND ms.member_id = NEW.author_member_id AND ms.left_at IS NULL
              AND m.status = 'active' AND m.deleted_at IS NULL FOR SHARE OF ms;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'agent is not an active DM member' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER dm_agent_write_boundary BEFORE INSERT OR UPDATE ON message
    FOR EACH ROW EXECUTE FUNCTION guard_dm_agent_write();

-- Keep ADR-0162's 1:1 coverage verbatim and add only a consented current seat,
-- pinned to the runtime identity everyone actually consented to.
ALTER FUNCTION hosted_connection_channel_ids(uuid, uuid) RENAME TO hosted_connection_channel_ids_before_dm_admission;
CREATE FUNCTION hosted_connection_channel_ids(p_workspace_id uuid, p_connection_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT COALESCE(array_agg(DISTINCT channel_id), '{}'::uuid[]) FROM (
        SELECT unnest(hosted_connection_channel_ids_before_dm_admission(p_workspace_id, p_connection_id)) AS channel_id
        UNION
        SELECT d.channel_id FROM dm_agent_admission d
        JOIN hosted_agent_connection hc ON hc.workspace_id = d.workspace_id AND hc.id = d.connection_id AND hc.agent_member_id = d.agent_member_id
        JOIN agent a ON a.workspace_id = hc.workspace_id AND a.member_id = hc.agent_member_id
        JOIN member o ON o.workspace_id = a.workspace_id AND o.id = a.owner_human_id AND o.kind = 'human' AND o.status = 'active' AND o.deleted_at IS NULL
        JOIN membership ms ON ms.workspace_id = d.workspace_id AND ms.channel_id = d.channel_id AND ms.member_id = d.agent_member_id AND ms.left_at IS NULL
        JOIN channel c ON c.workspace_id = d.workspace_id AND c.id = d.channel_id AND c.archived_at IS NULL AND c.kind = 'dm'
        WHERE d.workspace_id = p_workspace_id AND hc.id = p_connection_id AND hc.confirmed_by = a.owner_human_id
          AND d.admitted_at IS NOT NULL AND d.revoked_at IS NULL
    ) covered
$$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
        GRANT SELECT, INSERT, UPDATE ON TABLE dm_agent_admission TO momo_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
        GRANT SELECT ON TABLE dm_agent_admission TO momo_notifier;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay') THEN
        GRANT SELECT ON TABLE dm_agent_admission TO momo_relay;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
        GRANT SELECT ON TABLE dm_agent_admission TO momo_worker;
    END IF;
END $$;
