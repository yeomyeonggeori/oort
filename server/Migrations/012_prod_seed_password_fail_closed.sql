-- =============================================================================
-- 012_prod_seed_password_fail_closed.sql — production seed owner fail-closed
--
-- Migration 005 historically backfilled every human with the deterministic
-- local verifier password. Keep that fixture only when scripts/migrate.sh has
-- explicitly selected demo/e2e seed mode. In the default/prod seed-none mode,
-- revoke the seeded owner's hash only when it still verifies the public
-- dev-password; an operator-owned replacement password must remain untouched.
-- =============================================================================

\if :{?MOMO_AGENT_SEED_ENABLED}
\else
  \set MOMO_AGENT_SEED_ENABLED 0
\endif

SET LOCAL row_security = off;

\if :MOMO_AGENT_SEED_ENABLED
-- Fresh demo/e2e installs already received this hash in migration 005. Keep an
-- explicit repair for fixture databases whose seeded owner hash is empty.
UPDATE human
   SET password_hash = momo_password_hash('dev-password')
 WHERE member_id = '00000000-0000-7000-8000-000000000101'
   AND (password_hash IS NULL OR password_hash = '');
\else
-- Covers both fresh installs (005 -> 012 in one migration run) and existing
-- deployments upgrading after 005. momo_password_verify is NULL-safe and this
-- predicate preserves any password that is no longer the deterministic seed.
-- Review #431 H1: 005 backfilled EVERY human (pre-MOMO-217 join rows had NULL
-- hashes; INTERNAL_ALPHA copy even instructed dev-password signups), so the
-- lock must cover every row still verifying as the deterministic seed — not
-- just the seeded owner. Locking a publicly known password is fail-closed,
-- never over-lock: any operator-changed password fails the verify predicate.
UPDATE human
   SET password_hash = NULL
 WHERE momo_password_verify('dev-password', password_hash);
\endif
