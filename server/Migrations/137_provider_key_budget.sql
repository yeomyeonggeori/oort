-- =============================================================================
-- 137_provider_key_budget.sql — #3886 (ADR-0147 증보 2026-10-16 「키 확인·한도·남은 크레딧」)
--
-- 성재 결재 2026-10-16: 「API 키 발급받았어. API 키 연동하는 부분과 키 확인 및
-- verification으로 유효한 키인지 확인하는 절차. 그리고 해당 키 기준으로 한도 및 현재
-- 크레딧이 얼마 남았는지 등을 보여주는 인터페이스까지 작업해줘.」
--
-- Anthropic·OpenAI는 일반 API 키로 남은 크레딧을 읽을 수 있는 엔드포인트가 없다(콘솔 전용;
-- 사용·비용 보고서는 관리자 키 필요). 그래서 운영자가 회사별로 「월 크레딧」(예: Max 5x
-- $100)을 직접 적어 두고, oort가 usage_ledger 토큰 × model_pricing 로 이번 달 지출을
-- **추정**해 비교한다. 이 표는 그 예산 숫자 하나만 담는다 — 키·봉투·URL이 없다.
--
--   provider_key_budget   회사(anthropic|openai|xai|openrouter)당 최대 한 줄, 인스턴스 전역.
--                         provider_link 와 같은 이유로 테넌트 칸이 없다.
--
-- RLS (ENABLE + FORCE): 읽기·쓰기 모두 app.provider_link_admin = 'on' 일 때만. 그 GUC 는
-- 인스턴스 운영자 게이트를 통과한 라우트가 with_provider_link_admin_tx 로만 켠다.
--
-- model_pricing 글로벌 단가(workspace_id NULL): 현행 Anthropic 모델. 단가는 USD/백만 토큰이 곧
-- micro_usd/토큰이다(예: $2/MTok = 2.000000). 출처 = Anthropic 가격표(2026-09-25 캐시본,
-- claude-api 스킬). 캐시 쓰기 = 입력의 1.25배(5분), 캐시 읽기는 공개된 값(Opus 5.5·Sonnet 5.5
-- $0.20, Fable 5.1 $0.25), 그 외는 입력의 0.1배. OpenAI·xAI·OpenRouter 모델은 단가를 확인하지
-- 못해 넣지 않는다 — 화면이 「단가 없음」으로 정직하게 보인다.
--
-- schema_v0.sql 은 건드리지 않는다. 모든 문장이 가드되어 다시 적용해도 무해하다.
-- =============================================================================

CREATE TABLE IF NOT EXISTS provider_key_budget (
  company                  text PRIMARY KEY,
  monthly_budget_micro_usd bigint NOT NULL,
  updated_by               uuid REFERENCES member(id) ON DELETE SET NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_key_budget_company_ck
    CHECK (company IN ('anthropic', 'openai', 'xai', 'openrouter')),
  -- $0 ~ $1,000,000 per month; a typo cannot overflow later arithmetic.
  CONSTRAINT provider_key_budget_amount_ck
    CHECK (monthly_budget_micro_usd >= 0 AND monthly_budget_micro_usd <= 1000000000000)
);

COMMENT ON TABLE provider_key_budget IS
  '#3886 ADR-0147 증보 2026-10-16: 운영자가 적은 회사별 월 크레딧(예산). 공급사 잔액이 아니라 oort 추정과 견주는 기준선. 자격 물질 없음. 읽기·쓰기 모두 app.provider_link_admin.';

ALTER TABLE provider_key_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_key_budget FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provider_key_budget_operator ON provider_key_budget;
CREATE POLICY provider_key_budget_operator ON provider_key_budget
  USING (current_setting('app.provider_link_admin', true) = 'on')
  WITH CHECK (current_setting('app.provider_link_admin', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE provider_key_budget TO momo_app;
  END IF;
END $$;

-- ---- model_pricing: Anthropic 글로벌 단가 -----------------------------------
-- 002_seed.sql 과 같은 이유로 이 tx 한정 RLS 우회(정책 WITH CHECK 가 NULL 쓰기를 거절).
SET LOCAL row_security = off;

-- NULL workspace_id 는 UNIQUE 에서 서로 다르게 취급되어 ON CONFLICT 가 막지 못한다: NOT EXISTS 로 막는다.
INSERT INTO model_pricing
  (workspace_id, model, currency,
   input_micro_usd_per_token, output_micro_usd_per_token,
   cache_write_micro_usd_per_token, cache_read_micro_usd_per_token,
   reasoning_micro_usd_per_token, effective_from)
SELECT v.workspace_id, v.model, v.currency, v.i, v.o, v.cw, v.cr, v.r, v.eff
  FROM (VALUES
  (NULL::uuid, 'claude-fable-5-1', 'USD', 10.000000, 50.000000, 12.500000, 0.250000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-fable-5',   'USD', 10.000000, 50.000000, 12.500000, 1.000000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-opus-5-5',  'USD',  4.000000, 20.000000,  5.000000, 0.200000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-opus-5',    'USD',  5.000000, 25.000000,  6.250000, 0.500000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-opus-4-8',  'USD',  5.000000, 25.000000,  6.250000, 0.500000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-opus-4-7',  'USD',  5.000000, 25.000000,  6.250000, 0.500000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-opus-4-6',  'USD',  5.000000, 25.000000,  6.250000, 0.500000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-sonnet-5-5','USD',  2.000000, 10.000000,  2.500000, 0.200000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-sonnet-5',  'USD',  2.000000, 10.000000,  2.500000, 0.200000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-sonnet-4-6','USD',  3.000000, 15.000000,  3.750000, 0.300000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz),
  (NULL::uuid, 'claude-haiku-4-5', 'USD',  1.000000,  5.000000,  1.250000, 0.100000, NULL::numeric, '2026-01-01T00:00:00Z'::timestamptz)
  ) AS v(workspace_id, model, currency, i, o, cw, cr, r, eff)
 WHERE NOT EXISTS (
   SELECT 1 FROM model_pricing p
    WHERE p.workspace_id IS NULL AND p.model = v.model
      AND p.currency = v.currency AND p.effective_from = v.eff);
