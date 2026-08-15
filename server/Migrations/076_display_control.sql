-- =============================================================================
-- 076_display_control.sql — LIVE-3 / ADR-0004 증보 3 (Accepted 2026-08-15)
--
-- 075 ended with a sentence about this file:
--
--   > 경계가 열리는 날 이 절을 지우는 것이 그 결정의 실행 지점이 된다.
--
-- The 절 is `terminal_attach_display_observer_ck`, the decision is ADR-0004
-- 증보 3, and this is that day. What follows is the two halves of opening it:
-- the lock comes off, and the thing the lock was standing in for arrives.
--
-- ## Why removing a CHECK is not, by itself, the change
--
-- 075 refused `kind = 'display' AND mode = 'controller'` because control had no
-- decision behind it. Dropping the constraint alone would leave a build that can
-- mint a controllable screen and has nowhere to write down that it did — and the
-- whole of 증보 3 is about what must be TRUE while such a grant is live:
--
--   * D3 비관측 — while a person is typing into that screen, the agent's own
--     access to the session is refused. That is a predicate, and a predicate
--     needs a row to read.
--   * D2 자격 비유입 — the password the person types exists nowhere in this
--     database. So the row records **boundary facts only**: who, when it opened,
--     when it closed, and why. There is no column here that could hold a
--     keystroke, and that absence is the design.
--   * D6 — the VM stays `running` and stays billable (ADR-0140 untouched). What
--     stops is the agent's run layer, and `display_control_window` is what the
--     run layer consults. Nothing in this file touches `work_session.status`.
--
-- ## Why a window is a ROW and not a flag on work_session
--
-- A boolean on the session would answer "is control open" and nothing else. The
-- questions this ledger is actually asked are historical — when did the agent
-- stop, when did it resume, why did the window close — and 증보 3 D3 names
-- exactly those as the events an agent may learn ("정지 시각·재개 시각").
-- A flag cannot answer them after the fact, and a flag that is flipped twice by
-- two racing requests leaves no evidence it happened.
--
-- The partial unique index below is the other half of that argument: **one open
-- window per session**, enforced here rather than by a route remembering to
-- check. Two open windows would mean two people typing into one screen with the
-- agent blocked by whichever row was read first.
--
-- ## The lease, and why it is not the capability's `expires_at`
--
-- `terminal_attach_capability.expires_at` is a **dial** window — 60 seconds
-- bounding the gap between minting a bearer and connecting with it, after which
-- the producer re-validates with `stream: true` and the expiry clause is
-- deliberately skipped (`terminal_attach.rs` module header, MOMO-674). A live
-- stream therefore runs on an already-expired row, by design.
--
-- So keying the control window to that timestamp would reopen the agent's screen
-- access sixty seconds into a login the person is still performing, which is the
-- exact failure 증보 3 D3 exists to prevent. Instead the window carries its own
-- `lease_expires_at`, renewed by the same re-validation that keeps the stream
-- alive. Control is open while the producer keeps saying the stream is open; the
-- window lapses when it stops. The direction of that failure is the safe one:
-- a producer that dies leaves a window that closes on its own, and a producer
-- that keeps talking keeps the agent out.
-- =============================================================================

-- The lock 075 installed, removed by the decision it was waiting for. The Rust
-- half (`AttachKind::permits_mode`) and the route's 403 move in the same commit —
-- 075's comment promised all three would.
ALTER TABLE terminal_attach_capability
  DROP CONSTRAINT terminal_attach_display_observer_ck;

CREATE TABLE display_control_window (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  work_session_id     uuid NOT NULL REFERENCES work_session(id) ON DELETE CASCADE,
  -- The human who holds control. v0 is the session owner and only the session
  -- owner (증보 3 D1: control is a person's act on their own session), but the
  -- column names the grantee rather than restating "owner" so that widening the
  -- grant later is a policy change and not a migration.
  grantee_member_id   uuid NOT NULL REFERENCES member(id),
  -- The grant this window was opened by. Kept so an auditor can walk from a
  -- boundary event to the capability that caused it; deliberately NOT a source
  -- of truth for liveness (see the lease note in the header).
  capability_id       uuid NOT NULL REFERENCES terminal_attach_capability(id) ON DELETE CASCADE,
  started_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at    timestamptz NOT NULL,
  ended_at            timestamptz,
  end_reason          text,
  CONSTRAINT display_control_window_end_pair_ck CHECK (
    (ended_at IS NULL AND end_reason IS NULL)
    OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)
  ),
  -- 'returned'      the person handed control back (explicit REST)
  -- 'expired'       the lease lapsed — the producer stopped re-validating
  -- 'session_ended' the work session ended underneath it
  CONSTRAINT display_control_window_end_reason_ck CHECK (
    end_reason IS NULL
    OR end_reason IN ('returned', 'expired', 'session_ended')
  ),
  CONSTRAINT display_control_window_time_ck CHECK (
    ended_at IS NULL OR ended_at >= started_at
  ),
  CONSTRAINT display_control_window_lease_ck CHECK (
    lease_expires_at > started_at
  )
);

-- One open window per session (header). A partial unique index rather than an
-- application check, for 075's reason about CHECKs: a route can be rewritten by
-- a batch that never read this file, and an index cannot be talked out of it.
CREATE UNIQUE INDEX display_control_window_open_uniq
  ON display_control_window (work_session_id)
  WHERE ended_at IS NULL;

-- The read the agent's run path makes on every session-scoped control it
-- requests (`work_controls::create`). It is the hottest query this table has and
-- it always asks the same question, so it gets the index that answers it
-- directly: is there an unended row for this session whose lease still stands.
CREATE INDEX display_control_window_active_idx
  ON display_control_window (workspace_id, work_session_id, lease_expires_at DESC)
  WHERE ended_at IS NULL;

-- History, for the boundary events an agent and an operator both read back.
CREATE INDEX display_control_window_session_history_idx
  ON display_control_window (work_session_id, started_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['display_control_window'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;
