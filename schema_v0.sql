-- =============================================================================
-- momo messenger — PostgreSQL 18 schema (v0)
-- Agents are first-class members. Multi-tenant (workspace_id) with RLS isolation.
-- Targets PG18 (native uuidv7()). For PG<=17, see compat note at bottom.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid fallback
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- message body search (optional)

-- ---- enums -----------------------------------------------------------------
CREATE TYPE member_kind     AS ENUM ('human', 'agent');
CREATE TYPE member_status   AS ENUM ('active', 'invited', 'suspended', 'deleted');
CREATE TYPE channel_kind    AS ENUM ('public', 'private', 'dm');
CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'member', 'guest');
CREATE TYPE message_type    AS ENUM (
  'text', 'tool_call', 'tool_result', 'diff', 'artifact', 'approval_request', 'system'
);
CREATE TYPE message_state   AS ENUM ('sent', 'edited', 'deleted', 'failed');
CREATE TYPE run_status      AS ENUM (
  'queued', 'running', 'awaiting_approval', 'paused', 'succeeded', 'failed', 'cancelled', 'timed_out'
);
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'expired', 'cancelled');
CREATE TYPE token_kind      AS ENUM ('session', 'agent_bearer', 'delegation', 'invite');

-- =============================================================================
-- TENANT ROOT
-- =============================================================================
CREATE TABLE workspace (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  slug         text NOT NULL,
  name         text NOT NULL,
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT workspace_slug_uniq UNIQUE (slug)
);

-- =============================================================================
-- MEMBER ABSTRACTION
-- One row per principal in a workspace. kind discriminates human vs agent.
-- Every message author, every actor references member.id — humans & agents equal.
-- human/agent specifics live in child tables (1:1, shared PK).
-- =============================================================================
CREATE TABLE member (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind          member_kind NOT NULL,
  status        member_status NOT NULL DEFAULT 'active',
  display_name  text NOT NULL,
  handle        text NOT NULL,                 -- @handle, unique per workspace
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT member_handle_uniq UNIQUE (workspace_id, handle)
);
CREATE INDEX member_ws_kind_idx ON member (workspace_id, kind) WHERE deleted_at IS NULL;

-- human (kind='human'): auth identity for a person
CREATE TABLE human (
  member_id     uuid PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  email         text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  password_hash text,                          -- nullable if SSO-only
  tz            text NOT NULL DEFAULT 'UTC',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT human_email_uniq UNIQUE (workspace_id, email)
);

-- agent (kind='agent'): an autonomous member. OpenAI-compatible endpoint config.
CREATE TABLE agent (
  member_id        uuid PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  model            text NOT NULL,              -- e.g. 'hermes-agent', 'gpt-4o'
  base_url         text NOT NULL,              -- OpenAI-compat /v1 base
  -- bearer secret is NOT stored here; lives in token table (kind=agent_bearer)
  system_prompt    text,
  tool_schema      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- OpenAI function defs
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- temp, max_tokens, etc.
  owner_human_id   uuid REFERENCES member(id),          -- human who operates it
  -- loop safety guards (day-1, see agent_run)
  max_concurrent_runs   int NOT NULL DEFAULT 1 CHECK (max_concurrent_runs >= 1),
  max_run_steps         int NOT NULL DEFAULT 50 CHECK (max_run_steps >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- CHANNELS
-- =============================================================================
CREATE TABLE channel (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind          channel_kind NOT NULL,
  name          text,                          -- null for dm
  topic         text,
  -- dm_key: canonical hash of sorted member ids -> guarantees one DM per pair/group
  dm_key        text,
  created_by    uuid REFERENCES member(id),
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_name_required_ck
    CHECK (kind = 'dm' OR name IS NOT NULL),
  CONSTRAINT channel_dm_key_required_ck
    CHECK (kind <> 'dm' OR dm_key IS NOT NULL)
);
-- unique channel name per workspace (non-dm, non-archived)
CREATE UNIQUE INDEX channel_name_uniq
  ON channel (workspace_id, lower(name))
  WHERE kind <> 'dm' AND archived_at IS NULL;
-- one DM channel per participant set
CREATE UNIQUE INDEX channel_dm_uniq
  ON channel (workspace_id, dm_key)
  WHERE kind = 'dm';

-- =============================================================================
-- MEMBERSHIP (member <-> channel)
-- =============================================================================
CREATE TABLE membership (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  role          membership_role NOT NULL DEFAULT 'member',
  -- per-channel read cursor lives in read_state; muted flag etc here:
  muted         boolean NOT NULL DEFAULT false,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  left_at       timestamptz,
  CONSTRAINT membership_uniq UNIQUE (channel_id, member_id)
);
CREATE INDEX membership_member_idx ON membership (workspace_id, member_id) WHERE left_at IS NULL;
CREATE INDEX membership_channel_idx ON membership (channel_id) WHERE left_at IS NULL;

-- =============================================================================
-- PER-CHANNEL SEQUENCE COUNTER
-- One row per channel. Claim next seq via UPDATE ... RETURNING under row lock.
-- Serializes writes per-channel only (NOT globally). Gapless within committed tx.
-- =============================================================================
CREATE TABLE channel_seq (
  channel_id    uuid PRIMARY KEY REFERENCES channel(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  last_seq      bigint NOT NULL DEFAULT 0
);

-- =============================================================================
-- MESSAGE
-- Ordering key = (channel_id, seq) monotonic gapless BIGINT.
-- HLC stored decomposed: hlc_ts (physical ms) + hlc_count (logical) for causal
-- ordering across distributed producers; seq is the authoritative per-channel order.
-- author_member_id: human OR agent — fully symmetric.
-- =============================================================================
CREATE TABLE message (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id       uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  seq              bigint NOT NULL,            -- monotonic per channel, gapless
  -- Hybrid Logical Clock (decomposed for queryability)
  hlc_ts           bigint NOT NULL,            -- physical wall-clock ms
  hlc_count        integer NOT NULL DEFAULT 0, -- logical counter
  author_member_id uuid NOT NULL REFERENCES member(id),
  type             message_type NOT NULL DEFAULT 'text',
  state            message_state NOT NULL DEFAULT 'sent',
  body             text,                       -- rendered text (text/system)
  -- type-specific structured payload:
  --   tool_call    -> {name, arguments, call_id}
  --   tool_result  -> {call_id, output, is_error}
  --   diff         -> {path, patch, lang}
  --   artifact     -> {file_id, kind, title}
  --   approval_request -> {approval_id}
  props            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- threading
  root_id          uuid REFERENCES message(id), -- null = top-level; else thread root
  reply_to_id      uuid REFERENCES message(id), -- direct reply target
  -- agent provenance (which run produced this)
  run_id           uuid,                        -- FK added after agent_run defined
  -- client idempotency: dedup retried sends
  client_msg_id    uuid,
  edited_at        timestamptz,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_seq_uniq UNIQUE (channel_id, seq),
  CONSTRAINT message_client_idem_uniq UNIQUE (channel_id, author_member_id, client_msg_id)
);
-- primary read path: paginate a channel newest->oldest by seq
CREATE INDEX message_channel_seq_idx ON message (channel_id, seq DESC);
-- thread fetch
CREATE INDEX message_thread_idx ON message (root_id, seq) WHERE root_id IS NOT NULL;
-- causal/debug ordering by HLC
CREATE INDEX message_hlc_idx ON message (channel_id, hlc_ts, hlc_count);
-- agent output trace
CREATE INDEX message_run_idx ON message (run_id) WHERE run_id IS NOT NULL;
-- full-text-ish search
CREATE INDEX message_body_trgm_idx ON message USING gin (body gin_trgm_ops)
  WHERE deleted_at IS NULL AND body IS NOT NULL;

-- =============================================================================
-- THREAD (denormalized rollup of a root message's replies; optional but cheap)
-- =============================================================================
CREATE TABLE thread (
  root_id          uuid PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id       uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  reply_count      integer NOT NULL DEFAULT 0,
  last_reply_seq   bigint,
  last_reply_at    timestamptz,
  participant_ids  uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX thread_channel_idx ON thread (channel_id, last_reply_at DESC);

-- =============================================================================
-- REACTION
-- =============================================================================
CREATE TABLE reaction (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  message_id    uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  emoji         text NOT NULL,                 -- :shortcode: or unicode
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reaction_uniq UNIQUE (message_id, member_id, emoji)
);
CREATE INDEX reaction_message_idx ON reaction (message_id);

-- =============================================================================
-- FILE (object-storage backed; row is metadata)
-- =============================================================================
CREATE TABLE file (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  uploader_id   uuid NOT NULL REFERENCES member(id),
  channel_id    uuid REFERENCES channel(id) ON DELETE SET NULL,
  message_id    uuid REFERENCES message(id) ON DELETE SET NULL,
  storage_key   text NOT NULL,                 -- s3://bucket/key
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 bytea,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb, -- width/height/duration
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT file_storage_key_uniq UNIQUE (workspace_id, storage_key)
);
CREATE INDEX file_channel_idx ON file (channel_id) WHERE deleted_at IS NULL;

-- =============================================================================
-- READ STATE (per member, per channel cursor)
-- =============================================================================
CREATE TABLE read_state (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  last_read_seq bigint NOT NULL DEFAULT 0,
  last_read_at  timestamptz NOT NULL DEFAULT now(),
  mention_count integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, member_id)
);
CREATE INDEX read_state_member_idx ON read_state (workspace_id, member_id);

-- =============================================================================
-- AGENT RUN — task state machine
-- One row per agent invocation/turn. Drives loop-safety & concurrency.
-- =============================================================================
CREATE TABLE agent_run (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_member_id   uuid NOT NULL REFERENCES member(id),   -- the agent
  channel_id        uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  trigger_message_id uuid REFERENCES message(id),          -- what kicked it off
  parent_run_id     uuid REFERENCES agent_run(id),         -- sub-run / loop chain
  status            run_status NOT NULL DEFAULT 'queued',
  step_count        integer NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  max_steps         integer NOT NULL DEFAULT 50,
  -- loop safety: depth of run chain; reject beyond cap in app layer
  depth             integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  input             jsonb NOT NULL DEFAULT '{}'::jsonb,
  output            jsonb,
  error             jsonb,
  -- idempotency: a trigger message produces at most one live run
  idempotency_key   text,
  started_at        timestamptz,
  finished_at       timestamptz,
  deadline_at       timestamptz,                            -- for timed_out
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_run_step_cap_ck CHECK (step_count <= max_steps),
  CONSTRAINT agent_run_idem_uniq UNIQUE (workspace_id, idempotency_key)
);
-- enforce per-agent concurrency cap via partial unique on live runs + app check
CREATE INDEX agent_run_active_idx
  ON agent_run (agent_member_id)
  WHERE status IN ('queued','running','awaiting_approval','paused');
CREATE INDEX agent_run_channel_idx ON agent_run (channel_id, created_at DESC);
CREATE INDEX agent_run_chain_idx ON agent_run (parent_run_id) WHERE parent_run_id IS NOT NULL;

-- now wire message.run_id -> agent_run
ALTER TABLE message
  ADD CONSTRAINT message_run_fk
  FOREIGN KEY (run_id) REFERENCES agent_run(id) ON DELETE SET NULL;

-- =============================================================================
-- APPROVAL — human-in-the-loop gate for agent actions
-- =============================================================================
CREATE TABLE approval (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id            uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  channel_id        uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  request_message_id uuid REFERENCES message(id),  -- the approval_request message
  requested_by      uuid NOT NULL REFERENCES member(id),  -- the agent
  -- what is being approved
  action_type       text NOT NULL,             -- 'tool_call','deploy','spend', etc
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            approval_status NOT NULL DEFAULT 'pending',
  -- who must / did decide
  decided_by        uuid REFERENCES member(id),  -- a human
  decided_at        timestamptz,
  decision_reason   text,
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_decided_ck
    CHECK ((status IN ('approved','rejected')) = (decided_by IS NOT NULL))
);
CREATE INDEX approval_pending_idx ON approval (workspace_id, status) WHERE status = 'pending';
CREATE INDEX approval_run_idx ON approval (run_id);

-- =============================================================================
-- TOKEN / DELEGATION — auth + actor/subject delegation
-- delegation = a token where actor (agent) acts on behalf of subject (human).
-- =============================================================================
CREATE TABLE token (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind            token_kind NOT NULL,
  -- actor: the principal that authenticates with this token
  actor_member_id   uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  -- subject: the principal on whose behalf actor acts (delegation). NULL = self.
  subject_member_id uuid REFERENCES member(id) ON DELETE CASCADE,
  token_hash      bytea NOT NULL,              -- sha256 of secret; never store raw
  scopes          text[] NOT NULL DEFAULT '{}',
  label           text,
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_by      uuid REFERENCES member(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT token_hash_uniq UNIQUE (token_hash),
  CONSTRAINT token_delegation_ck
    CHECK (kind <> 'delegation' OR subject_member_id IS NOT NULL)
);
CREATE INDEX token_actor_idx ON token (actor_member_id) WHERE revoked_at IS NULL;
CREATE INDEX token_subject_idx ON token (subject_member_id) WHERE subject_member_id IS NOT NULL;

-- =============================================================================
-- AUDIT LOG — every consequential action. actor (agent or human) on subject.
-- =============================================================================
CREATE TABLE audit_log (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- actor: who did it (commonly an agent). subject: who/what it affected.
  actor_member_id   uuid REFERENCES member(id),   -- nullable for system events
  subject_member_id uuid REFERENCES member(id),   -- e.g. the human acted on
  action            text NOT NULL,                -- 'message.delete','run.start'...
  target_type       text,                         -- 'message','channel','run'...
  target_id         uuid,
  -- delegation provenance: which token authorized this
  via_token_id      uuid REFERENCES token(id),
  run_id            uuid REFERENCES agent_run(id),
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_addr           inet,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_ws_time_idx ON audit_log (workspace_id, created_at DESC);
CREATE INDEX audit_actor_idx ON audit_log (actor_member_id, created_at DESC);
CREATE INDEX audit_subject_idx ON audit_log (subject_member_id, created_at DESC);
CREATE INDEX audit_target_idx ON audit_log (target_type, target_id);

-- =============================================================================
-- ROW-LEVEL SECURITY — tenant isolation by workspace_id
-- App sets: SET LOCAL app.workspace_id = '<uuid>'; per request/transaction.
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'member','human','agent','channel','membership','channel_seq','message',
    'thread','reaction','file','read_state','agent_run','approval','token','audit_log'
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

-- =============================================================================
-- ENRICHMENT TABLES (L4 spec §2.2–2.4) — outbox / cost-accounting / APNs push
-- Appended after the base RLS block; a second RLS block below covers these.
-- Deviations from spec (documented): budget_window gains workspace_id for uniform
-- RLS; model_pricing keeps NULLable workspace_id (global defaults) → custom policy.
-- =============================================================================

-- ---- TRANSACTIONAL OUTBOX (durable SoT→Centrifugo relay + agent job queue) ----
-- Column set is a SUPERSET of Centrifugo's native PG outbox consumer schema
-- (id BIGSERIAL, method, payload, partition, created_at) for future no-code migration.
CREATE TYPE outbox_kind   AS ENUM ('broadcast', 'agent_job');
CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'done', 'failed');

CREATE TABLE outbox (
  id            BIGSERIAL PRIMARY KEY,            -- Centrifugo-compat
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind          outbox_kind NOT NULL,
  status        outbox_status NOT NULL DEFAULT 'pending',
  method        text NOT NULL DEFAULT 'publish',  -- publish/broadcast (Centrifugo-compat)
  payload       jsonb NOT NULL,                   -- {channel, data, version, idempotency_key,...}
  partition     integer NOT NULL DEFAULT 0,       -- Centrifugo per-partition order
  partition_key uuid,                             -- channel_id (broadcast) | agent_member_id (job)
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  available_at  timestamptz NOT NULL DEFAULT now(),  -- backoff
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (kind, available_at, id) WHERE status = 'pending';
CREATE INDEX outbox_partition_idx ON outbox (partition_key, id) WHERE status = 'pending';
CREATE OR REPLACE FUNCTION outbox_notify() RETURNS trigger AS $$
BEGIN PERFORM pg_notify('outbox', NEW.kind::text); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER outbox_notify_trg AFTER INSERT ON outbox
  FOR EACH ROW EXECUTE FUNCTION outbox_notify();

-- ---- COST / TOKEN ACCOUNTING ----
-- model_pricing: unit prices only (numeric); cost rolled up as integer micro_usd.
-- workspace_id NULL = global default (visible to all tenants, seeded by admin role).
CREATE TABLE model_pricing (
  id                              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id                    uuid REFERENCES workspace(id) ON DELETE CASCADE,
  model                           text NOT NULL,
  currency                        char(3) NOT NULL DEFAULT 'USD',
  input_micro_usd_per_token       numeric(20,6) NOT NULL DEFAULT 0,
  output_micro_usd_per_token      numeric(20,6) NOT NULL DEFAULT 0,
  cache_write_micro_usd_per_token numeric(20,6) NOT NULL DEFAULT 0,
  cache_read_micro_usd_per_token  numeric(20,6) NOT NULL DEFAULT 0,
  reasoning_micro_usd_per_token   numeric(20,6),    -- NULL → use output rate
  effective_from                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_pricing_uniq UNIQUE (workspace_id, model, currency, effective_from)
);

-- usage_ledger: immutable system-of-record, one row per request.
CREATE TABLE usage_ledger (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id            uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  agent_member_id   uuid NOT NULL REFERENCES member(id),
  channel_id        uuid REFERENCES channel(id) ON DELETE SET NULL,
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cached_tokens     integer NOT NULL DEFAULT 0,
  reasoning_tokens  integer NOT NULL DEFAULT 0,
  cost_micro_usd    bigint  NOT NULL DEFAULT 0,
  was_estimated     boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_run_idx ON usage_ledger (run_id);
CREATE INDEX usage_ledger_ws_time_idx ON usage_ledger (workspace_id, created_at DESC);

-- budget grain + hot-row rollup (SoT for the cost circuit breaker).
CREATE TYPE budget_grain AS ENUM
  ('workspace','agent','channel','workspace_agent','agent_channel');

CREATE TABLE budget (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  grain           budget_grain NOT NULL,
  agent_member_id uuid REFERENCES member(id),
  channel_id      uuid REFERENCES channel(id),
  limit_micro_usd      bigint NOT NULL,
  period_seconds       integer NOT NULL DEFAULT 86400,  -- rolling window
  soft_limit_micro_usd bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- budget_window: hot decrement counter. period_start gives lazy-inline rollover.
-- NOTE: workspace_id added (vs spec) so the uniform RLS policy applies.
CREATE TABLE budget_window (
  budget_id          uuid NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  period_start       timestamptz NOT NULL,
  reserved_micro_usd bigint NOT NULL DEFAULT 0,   -- pre-call reservation (trip gate)
  spent_micro_usd    bigint NOT NULL DEFAULT 0,   -- post-reconcile actual
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (budget_id, period_start)
);

-- ---- APNs DEVICE / PUSH TOKENS ----
CREATE TYPE device_platform AS ENUM ('ios','macos');
CREATE TYPE push_env        AS ENUM ('sandbox','production');

CREATE TABLE device (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  platform      device_platform NOT NULL,
  app_build     text,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_member_idx ON device (workspace_id, member_id);

CREATE TABLE push_token (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  device_id      uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  member_id      uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  apns_token     text NOT NULL,                   -- hex device token
  env            push_env NOT NULL,
  topic          text NOT NULL,                   -- bundle id
  invalidated_at timestamptz,                     -- set on 410/400
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_token_uniq UNIQUE (apns_token, env)
);
CREATE INDEX push_token_active_idx ON push_token (member_id) WHERE invalidated_at IS NULL;

CREATE TABLE push_dispatch_log (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  message_id    uuid REFERENCES message(id) ON DELETE SET NULL,
  member_id     uuid NOT NULL REFERENCES member(id),
  push_token_id uuid REFERENCES push_token(id) ON DELETE SET NULL,
  collapse_id   text,
  apns_status   integer,                          -- 200/400/410...
  apns_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_dispatch_msg_idx ON push_dispatch_log (message_id);

-- =============================================================================
-- RLS for enrichment tables.
-- Uniform ws_isolation for tables that carry a NOT NULL workspace_id.
-- Background consumers (outbox relay, cost/push workers) connect as a BYPASSRLS
-- role (e.g. momo_relay LOGIN BYPASSRLS) to poll across tenants.
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'outbox','usage_ledger','budget','budget_window',
    'device','push_token','push_dispatch_log'
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

-- model_pricing: NULLable workspace_id = global default visible to every tenant.
-- Global rows (workspace_id IS NULL) are seeded by the admin/BYPASSRLS role; the
-- WITH CHECK forbids tenants from writing global rows.
ALTER TABLE model_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_pricing FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON model_pricing
  USING (workspace_id IS NULL
         OR workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
