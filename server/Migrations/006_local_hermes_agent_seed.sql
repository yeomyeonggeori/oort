-- =============================================================================
-- 006_local_hermes_agent_seed.sql — Local Hermes Agent Bridge v0 seed
--
-- Adds a deterministic first-class Hermes agent only for demo/e2e fixtures.
-- Persistent dogfood/local-alpha must invite Hermes through pairing instead.
-- =============================================================================

\if :{?MOMO_AGENT_SEED_ENABLED}
\else
  \set MOMO_AGENT_SEED_ENABLED 0
\endif

SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000001';

\if :MOMO_AGENT_SEED_ENABLED
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('00000000-0000-7000-8000-000000000103',
        '00000000-0000-7000-8000-000000000001',
        'agent', 'active', 'Hermes', 'hermes')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      display_name = EXCLUDED.display_name,
      handle = EXCLUDED.handle;

INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt,
                   owner_human_id, max_concurrent_runs, max_run_steps)
VALUES ('00000000-0000-7000-8000-000000000103',
        '00000000-0000-7000-8000-000000000001',
        'hermes-agent',
        'http://localhost:8088/v1',
        'You are Hermes, a local first-class momo agent. Work from channel context, keep side effects behind approval, and write durable results back to the timeline.',
        '00000000-0000-7000-8000-000000000101',
        1, 12)
ON CONFLICT (member_id) DO UPDATE
  SET model = EXCLUDED.model,
      base_url = EXCLUDED.base_url,
      system_prompt = EXCLUDED.system_prompt,
      max_concurrent_runs = EXCLUDED.max_concurrent_runs,
      max_run_steps = EXCLUDED.max_run_steps;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES ('00000000-0000-7000-8000-000000000305',
        '00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000201',
        '00000000-0000-7000-8000-000000000103', 'member')
ON CONFLICT (channel_id, member_id) DO UPDATE
  SET left_at = NULL,
      role = EXCLUDED.role;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES ('00000000-0000-7000-8000-000000000306',
        '00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000202',
        '00000000-0000-7000-8000-000000000103', 'member')
ON CONFLICT (channel_id, member_id) DO UPDATE
  SET left_at = NULL,
      role = EXCLUDED.role;
\endif
