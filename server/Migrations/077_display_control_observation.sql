-- =============================================================================
-- 077_display_control_observation.sql — LIVE-5a / ADR-0004 증보 3
--
-- 076 built the control window and said what must be true while a person is
-- typing: the agent is stopped, its runs are parked, and nothing the person
-- types enters this database. This file adds the clause 076 could not state
-- because LIVE-3 had not yet decided it — **who else may watch.**
--
-- ## Why control has to close observation
--
-- A control window exists so a person can do on the VM the one thing an agent
-- must not see them do: log in. 증보 3 D2 keeps that out of the transcript, the
-- audit log and the Memory Plane, and D3 keeps it out of the agent's reach. All
-- of which is undone by a teammate who happened to press 관전 thirty seconds
-- earlier and is now watching the same screen frame by frame, with the password
-- on it. `observation = 'open'` is a perfectly reasonable setting for an agent's
-- work session and a catastrophic one for a login, and nobody is going to
-- remember to flip it first.
--
-- So the window flips it: opening control forces `observation = 'owner_only'`,
-- and closing control puts back exactly what was there. The teammate's live
-- stream is cut by the machine LIVE-2 already built — the producer re-validates
-- every 30 seconds and the validate join re-reads `observation` every time
-- (`validate_attach_capability_in_tx`), so a capability that was legal when it
-- was minted stops being legal within one re-validation period. No new
-- revocation path, no new event.
--
-- ## Why the previous value is a COLUMN and not a re-derivation
--
-- The restore cannot ask "what should observation be" — only the session's
-- owner knows, and they set it before any of this happened. Defaulting to
-- `'open'` on close would silently widen a session the owner had deliberately
-- closed; defaulting to `'owner_only'` would silently narrow one they had
-- deliberately opened. Both are a setting changed by a system the person never
-- asked about it, which is the failure this repository names first.
--
-- So the window carries the value it displaced, and the close writes it back.
-- NULL means **this window changed nothing** — the session was already
-- `owner_only` when control opened — and the restore is then a no-op rather
-- than a write that could invent a state.
--
-- ## Why it lives on the window and not on the session
--
-- Same argument 076 made about the window itself. A `pre_control_observation`
-- column on `work_session` would be a second mutable field two writers race for,
-- and it would survive the window that owns it. Here it is born and dies with
-- the row whose whole purpose is to be reverted, and the partial unique index
-- (`display_control_window_open_uniq`) already guarantees exactly one live
-- holder of it per session.
-- =============================================================================

ALTER TABLE display_control_window
  ADD COLUMN prior_observation text;

-- The same closed vocabulary `work_session_observation_ck` (024) enforces on the
-- column this one restores. Stated again here rather than trusted, because the
-- restore writes this value straight back into `work_session.observation`: a row
-- carrying anything else would either violate 024 at close time — leaving a
-- window that can never be closed and an agent that never resumes — or, worse,
-- get there through a path that dropped 024 first.
ALTER TABLE display_control_window
  ADD CONSTRAINT display_control_window_prior_observation_ck CHECK (
    prior_observation IS NULL
    OR prior_observation IN ('open', 'owner_only')
  );
