-- #4781 / ADR-0147 (2026-10-30): provenance and public list prices.
-- 157 is reserved for S2 slot 3. Historical rows deliberately remain NULL.
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE usage_ledger DROP CONSTRAINT IF EXISTS usage_ledger_source_ck;
ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_source_ck
  CHECK (source IN ('measured', 'self_reported'));
COMMENT ON COLUMN usage_ledger.source IS
  'Trusted writer provenance: worker=measured, Agent Port/REST=self_reported; NULL historical rows are inferred at read time.';

ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS verified_on date;
COMMENT ON COLUMN model_pricing.verified_on IS
  'Calendar date the public list price at source_url was checked; not a provider invoice.';

-- USD / million tokens = micro-USD / token. Standard global endpoint rates.
-- Normalize dots to dashes exactly as the price reader does. No generic family
-- row: unrelated future models remain unpriced. Effective at this UTC month
-- start for this month's historical ledger; this is not a historical price feed.
SET LOCAL row_security = off;
INSERT INTO model_pricing
  (workspace_id, model, currency, input_micro_usd_per_token,
   output_micro_usd_per_token, cache_write_micro_usd_per_token,
   cache_read_micro_usd_per_token, effective_from, source_url, verified_on)
SELECT NULL, v.model, 'USD', v.i, v.o, v.cw, v.cr,
       '2026-10-01T00:00:00Z'::timestamptz, v.url, '2026-10-30'::date
FROM (VALUES
  ('gpt-6-astra',     10.0, 50.0, 12.5, 1.0,  'https://developers.openai.com/api/docs/pricing'),
  ('gpt-6-1-sol',      2.0, 10.0,  2.5, 0.1,  'https://developers.openai.com/api/docs/pricing'),
  ('gpt-6-1-terra',    1.0,  5.0,  1.25,0.05, 'https://developers.openai.com/api/docs/pricing'),
  ('gpt-6-luna',       0.1,  0.5,  0.125,0.01,'https://developers.openai.com/api/docs/pricing'),
  ('gpt-5-3-codex',    1.75,14.0,  1.75,0.175,'https://developers.openai.com/api/docs/pricing'),
  ('grok-4-7',         2.0,  6.0,  2.0, 0.5,  'https://docs.x.ai/developers/pricing'),
  ('grok-4-6',         2.0,  6.0,  2.0, 0.5,  'https://docs.x.ai/developers/pricing'),
  ('grok-4-5',         2.0,  6.0,  2.0, 0.3,  'https://docs.x.ai/developers/pricing'),
  ('grok-4-3',         1.25, 2.5,  1.25,0.2,  'https://docs.x.ai/developers/pricing'),
  ('grok-4-1-fast',    0.2,  0.5,  0.2, 0.05, 'https://x.ai/news/grok-4-1-fast'),
  ('grok-4-fast',      0.2,  0.5,  0.2, 0.05, 'https://x.ai/news/grok-4-fast')
) AS v(model, i, o, cw, cr, url)
WHERE NOT EXISTS (
  SELECT 1 FROM model_pricing p WHERE p.workspace_id IS NULL
    AND p.model = v.model AND p.currency = 'USD'
    AND p.effective_from = '2026-10-01T00:00:00Z'::timestamptz
);

-- Optional monthly subscription amount, kept separate from metered spend.
CREATE TABLE IF NOT EXISTS agent_subscription_fee (
  agent_member_id uuid PRIMARY KEY REFERENCES agent(member_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  monthly_micro_usd bigint NOT NULL CHECK (monthly_micro_usd BETWEEN 0 AND 1000000000000),
  label text CHECK (length(label) <= 120),
  updated_by uuid REFERENCES member(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agent_subscription_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_subscription_fee FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_fee_read ON agent_subscription_fee;
CREATE POLICY subscription_fee_read ON agent_subscription_fee FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS subscription_fee_write ON agent_subscription_fee;
CREATE POLICY subscription_fee_write ON agent_subscription_fee FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.agent_subscription_fee_admin', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.agent_subscription_fee_admin', true) = 'on'
    AND EXISTS (SELECT 1 FROM agent a WHERE a.member_id = agent_member_id
      AND a.workspace_id = agent_subscription_fee.workspace_id AND a.invocation_scope <> 'owner_only'));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_subscription_fee TO momo_app;
  END IF;
END $$;
