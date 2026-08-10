-- =============================================================================
-- 066_notification_rule.sql — ADR-0124 증보 1 (W-B2-3) member-global notification
-- rules: DND and the mention-exception-to-mute switch.
--
-- This is the second input to the P9 notifier judgment (018 was the first). 018
-- `notification_pref` is PER CHANNEL — one row silences one (member, channel)
-- pair. This table is PER MEMBER, workspace-global, and carries no channel_id:
--
--   * dnd = true                 → suppress EVERY push for this member in this
--                                  workspace (DM, mention, approval included),
--                                  the same total meaning 018 has, but tenant-wide.
--   * mention_overrides_mute = true → a channel this member muted in 018 STILL
--                                  notifies them on reason='mention'. This is the
--                                  switch ADR-0124 D3 reserved as "notifier 조건
--                                  1줄", now made real.
--
-- ROW ABSENCE IS THE DEFAULT: no row means both false, which is exactly the
-- behaviour before this migration. Existing members are untouched.
--
-- Unread/read-state stays a separate ledger (ADR-0124 D2). These rules only
-- change "will a push be delivered", never the badge.
--
-- Judgment precedence (momo-push judge_targets): dnd > channel-mute(018, with the
-- mention exception applied) > per-reason logic. Suppression leaves no
-- push_dispatch_log row, exactly like 018 (no log pollution).
-- =============================================================================

CREATE TABLE notification_rule (
  workspace_id           uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id              uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  dnd                    boolean NOT NULL DEFAULT false,
  mention_overrides_mute boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, member_id)
);

ALTER TABLE notification_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON notification_rule
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
