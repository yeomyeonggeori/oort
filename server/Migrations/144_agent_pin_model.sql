-- =============================================================================
-- 144_agent_pin_model.sql - #4143 (ADR-0203 증보 2026-10-20 「같은 서버 Hermes의 모델 고르기」)
--
-- 같은 서버 Hermes(operator_env 핀)가 어느 제공자의 어느 모델로 답할지를 핀에 함께 적는다.
-- Hermes는 provider 없이 온 model을 조용히 무시하고 기본 모델로 답하므로(/chat/completions,
-- direct_model_requests 기본 off), 둘은 항상 한 쌍으로만 존재한다.
--
--   model_provider  Hermes 제공자 슬러그(예: anthropic, openai-codex). 비밀이 아니다.
--   model_id        그 제공자의 모델 id(예: claude-sonnet-5-5). 비밀이 아니다.
--
-- 둘 다 NULL = 오늘과 같다(워커는 agent.model을 그대로 보내고 provider를 싣지 않는다).
-- operator_env 핀에서만 값을 가질 수 있다. 모든 문장이 가드되어 다시 적용해도 무해하다.
-- 기존 RLS 정책(read/insert/update/delete)과 권한은 열 단위가 아니라 그대로 적용된다.
-- schema_v0.sql 은 건드리지 않는다.
-- =============================================================================

ALTER TABLE agent_provider_pin ADD COLUMN IF NOT EXISTS model_provider text NULL;
ALTER TABLE agent_provider_pin ADD COLUMN IF NOT EXISTS model_id       text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_provider_pin_model_pair_ck') THEN
    ALTER TABLE agent_provider_pin ADD CONSTRAINT agent_provider_pin_model_pair_ck
      CHECK ((model_provider IS NULL) = (model_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_provider_pin_model_kind_ck') THEN
    ALTER TABLE agent_provider_pin ADD CONSTRAINT agent_provider_pin_model_kind_ck
      CHECK (model_provider IS NULL OR kind = 'operator_env');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_provider_pin_model_shape_ck') THEN
    ALTER TABLE agent_provider_pin ADD CONSTRAINT agent_provider_pin_model_shape_ck
      CHECK (model_provider IS NULL OR (
        model_provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
        AND model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$'
      ));
  END IF;
END $$;

COMMENT ON COLUMN agent_provider_pin.model_provider IS
  '#4143 ADR-0203 증보 2026-10-20: operator_env 핀의 Hermes 제공자 슬러그. model_id와 한 쌍(둘 다 NULL = 오늘과 같다). 워커가 /chat/completions 본문에 provider로 싣는다.';
COMMENT ON COLUMN agent_provider_pin.model_id IS
  '#4143 ADR-0203 증보 2026-10-20: operator_env 핀의 모델 id. 서버가 Hermes /api/model/options의 로그인된 제공자 목록 안에서만 쓴다.';
