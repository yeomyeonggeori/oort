-- =============================================================================
-- 117_personal_provider_link.sql — #3396 (ADR-0147 증보 2026-10-03, 성재 결재 2026-10-03)
--
-- 개인 API 키(소유자 있는 BYOK). 조직(운영자)이 한 사람에게 발급한 API 키를, 그 사람의
-- 「본인 전용」 에이전트만 쓴다. 팀 키(provider_link·provider_link_chain, 039·042)와는
-- 다른 표다: 그쪽은 인스턴스 전역·운영자 GUC 전용이고, 이쪽은 워크스페이스 안의 한 사람 것이다.
--
--   personal_provider_link   발급된 키 한 줄. 소유자(owner_member_id, 사람)·봉인된 키·
--                            origin이 묶인 base_url·키 지문·회수 시각.
--   agent.uses_owner_key     owner_only 에이전트의 두뇌가 「소유자의 개인 키」임을 나타내는
--                            사실. 구독 에이전트(subscription_harness)와 서로 배타다.
--
-- 불변식(ADR-0004 증보 1 / ADR-0147 / ADR-0193 D4 를 그대로 잇는다)
--   * 키는 AES-GCM 봉투(PROVIDER_LINK_MASTER_KEY)로만 저장한다. 평문 컬럼 없음.
--   * key_fingerprint 는 「키 1개 = 한 사람」을 DB가 지키는 열쇠다. 봉투는 매번 nonce 가 달라 서로
--     비교할 수 없으므로, 마스터 키로 만든 HMAC-SHA256 지문을 따로 둔다. 지문은 활성 행끼리
--     UNIQUE 이고, 지문만으로는 키를 되돌릴 수 없다(마스터 키 없이는 대조도 못 한다).
--   * 한 소유자에 활성 키는 하나(부분 UNIQUE). 교체는 회수 후 재발급이다. 회수한 행은 남아 감사에 쓰인다.
--     한 소유자의 개인 키 에이전트도 하나다(agent_owner_key_holder_uk).
--   * base_url 은 발급 시 한 번만 정해진다. 수정 경로가 없다 = 키가 다른 origin 으로 따라가지 않는다
--     (ADR-0147 증보 2026-09-28 「키는 origin에 묶인다」와 같은 이유).
--   * RLS FORCE + ws_isolation. app.provider_link_admin GUC 를 일반 멤버 tx 에 켜지 않는다
--     (110_mem_reset.sql 의 경고). 접근 판정(운영자/본인)은 라우트가 하고, 읽는 쪽 SELECT 는
--     봉인 컬럼을 고르지 않는다.
--   * 전 테넌트 워커(momo_worker, BYPASSRLS)만 봉투를 열어 읽는다 — 팀 키와 같은 예외다.
--
-- schema_v0.sql 은 건드리지 않는다.
-- =============================================================================

CREATE TABLE personal_provider_link (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id   uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  -- openai = OpenAI 호환 /chat/completions, anthropic = Messages(ADR-0147 증보 2026-09-27).
  format            text NOT NULL,
  -- 발급 때 validated_base_url 을 통과한 값. 수정 경로 없음.
  base_url          text NOT NULL,
  -- AES-GCM sealed box (version||nonce||ct||tag). 봉투 안의 kind 가 wire 를 정한다.
  bearer_ciphertext bytea NOT NULL,
  -- hex(HMAC-SHA256(masterKey, "momo.personal_link.fp.v1\n" || key)).
  key_fingerprint   text NOT NULL,
  -- 사람이 알아보는 이름(선택). 키 값이 아니다.
  label             text,
  issued_by         uuid REFERENCES member(id) ON DELETE SET NULL,
  issued_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES member(id) ON DELETE SET NULL,
  CONSTRAINT personal_provider_link_format_ck CHECK (format IN ('openai', 'anthropic')),
  CONSTRAINT personal_provider_link_base_url_ck CHECK (length(btrim(base_url)) > 0),
  CONSTRAINT personal_provider_link_bearer_ck CHECK (octet_length(bearer_ciphertext) > 0),
  CONSTRAINT personal_provider_link_fp_ck CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT personal_provider_link_label_ck
    CHECK (label IS NULL OR (length(btrim(label)) BETWEEN 1 AND 80 AND label !~ '[[:cntrl:]]')),
  CONSTRAINT personal_provider_link_revoke_ck
    CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

COMMENT ON TABLE personal_provider_link IS
  '#3396 ADR-0147 증보 2026-10-03: 조직이 한 사람에게 발급한 개인 API 키(소유자 있는 BYOK). 봉인 키 + 키 지문. 소유자 본인 전용 에이전트만 해석한다. 팀 에이전트·다른 멤버의 에이전트는 이 표에 도달하지 않는다.';
COMMENT ON COLUMN personal_provider_link.bearer_ciphertext IS
  'AES-GCM sealed box. 평문은 저장·로그·감사·응답 어디에도 없다.';
COMMENT ON COLUMN personal_provider_link.key_fingerprint IS
  '키 1개 = 한 사람. 활성 행끼리 UNIQUE. 마스터 키로 만든 HMAC-SHA256 — 되돌릴 수 없다. 마스터 키를 회전하면 활성 행을 새 키로 다시 지문 찍어야 한다.';

-- 활성 키끼리만 유일: 같은 키를 두 사람(두 행)에게 줄 수 없다. 회수된 행의 지문은 재발급을 막지 않는다.
CREATE UNIQUE INDEX personal_provider_link_fp_active_uk
  ON personal_provider_link (key_fingerprint) WHERE revoked_at IS NULL;
-- 한 소유자에 활성 키 하나.
CREATE UNIQUE INDEX personal_provider_link_owner_active_uk
  ON personal_provider_link (workspace_id, owner_member_id) WHERE revoked_at IS NULL;
CREATE INDEX personal_provider_link_ws_idx
  ON personal_provider_link (workspace_id, issued_at DESC);

-- 소유자는 같은 워크스페이스의 사람(kind='human')이어야 한다. 에이전트에게 개인 키를 줄 수 없다.
CREATE FUNCTION personal_provider_link_owner_is_human()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.member m
     WHERE m.id = NEW.owner_member_id
       AND m.workspace_id = NEW.workspace_id
       AND m.kind = 'human'
  ) THEN
    RAISE EXCEPTION 'personal_provider_link owner must be a human member of the workspace (ADR-0147 증보 2026-10-03)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER personal_provider_link_owner_human
  BEFORE INSERT ON personal_provider_link
  FOR EACH ROW EXECUTE FUNCTION personal_provider_link_owner_is_human();

-- 회수는 한 방향이다: 소유자·키·origin·워크스페이스를 바꾸거나 회수를 되돌릴 수 없다.
CREATE FUNCTION personal_provider_link_immutable()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.owner_member_id IS DISTINCT FROM OLD.owner_member_id
     OR NEW.format IS DISTINCT FROM OLD.format
     OR NEW.base_url IS DISTINCT FROM OLD.base_url
     OR NEW.bearer_ciphertext IS DISTINCT FROM OLD.bearer_ciphertext
     OR NEW.key_fingerprint IS DISTINCT FROM OLD.key_fingerprint
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'personal_provider_link key, owner and origin cannot change; revoke and issue a new key (ADR-0147 증보 2026-10-03)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- `revoked_by` may go to NULL (its FK is ON DELETE SET NULL: the revoking member left);
  -- it may not change to anyone else, and the revocation itself cannot be undone.
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR (NEW.revoked_by IS DISTINCT FROM OLD.revoked_by AND NEW.revoked_by IS NOT NULL)) THEN
    RAISE EXCEPTION 'personal_provider_link revocation cannot be undone (ADR-0147 증보 2026-10-03)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER personal_provider_link_immutable_guard
  BEFORE UPDATE ON personal_provider_link
  FOR EACH ROW EXECUTE FUNCTION personal_provider_link_immutable();

ALTER TABLE personal_provider_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_provider_link FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON personal_provider_link
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---- agent: 「두뇌 = 소유자의 개인 키」 ------------------------------------------
-- 089 의 owner_only 모양을 넓힌다: owner_only 는 소유자가 있고, 두뇌가 정확히 하나다 —
-- 구독(subscription_harness) 또는 소유자의 개인 키(uses_owner_key). 둘 다이거나 둘 다 없을 수 없다.
ALTER TABLE agent
  ADD COLUMN uses_owner_key boolean NOT NULL DEFAULT false;

ALTER TABLE agent DROP CONSTRAINT agent_owner_only_shape;
ALTER TABLE agent
  ADD CONSTRAINT agent_owner_only_shape CHECK (
    (invocation_scope = 'owner_only') = (subscription_harness IS NOT NULL OR uses_owner_key)
    AND NOT (subscription_harness IS NOT NULL AND uses_owner_key)
    AND (invocation_scope <> 'owner_only' OR owner_human_id IS NOT NULL)
  );

-- 한 사람에 개인 키 에이전트 하나. 키를 회수·재발급해도 같은 에이전트가 이어 쓴다(정체성은 유지,
-- 새 키의 origin 은 발급 감사에 「이전 endpoint → 새 endpoint」로 남는다).
CREATE UNIQUE INDEX agent_owner_key_holder_uk
  ON agent (workspace_id, owner_human_id) WHERE uses_owner_key;

COMMENT ON COLUMN agent.uses_owner_key IS
  '#3396 ADR-0147 증보 2026-10-03: owner_only 에이전트의 두뇌가 소유자(owner_human_id)의 개인 API 키(personal_provider_link)다. subscription_harness 와 배타. owner_only 행에서 한 방향(agent_owner_only_final_guard).';

-- 089 의 한 방향 트리거에 이 컬럼을 더한다(owner_only 행에서 두뇌 종류를 바꿀 수 없다).
CREATE OR REPLACE FUNCTION agent_owner_only_is_final()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.invocation_scope = 'owner_only' THEN
    IF NEW.invocation_scope IS DISTINCT FROM OLD.invocation_scope THEN
      RAISE EXCEPTION 'owner_only agent cannot be reopened to the workspace (ADR-0193 D4)';
    END IF;
    IF NEW.owner_human_id IS DISTINCT FROM OLD.owner_human_id THEN
      RAISE EXCEPTION 'owner_only agent owner cannot change (ADR-0193 D4)';
    END IF;
    IF NEW.subscription_harness IS DISTINCT FROM OLD.subscription_harness THEN
      RAISE EXCEPTION 'owner_only agent harness cannot change (ADR-0193 D4)';
    END IF;
    IF NEW.uses_owner_key IS DISTINCT FROM OLD.uses_owner_key THEN
      RAISE EXCEPTION 'owner_only agent brain cannot change (ADR-0147 증보 2026-10-03)';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER agent_owner_only_final_guard ON agent;
CREATE TRIGGER agent_owner_only_final_guard
BEFORE UPDATE OF invocation_scope, owner_human_id, subscription_harness, uses_owner_key ON agent
FOR EACH ROW EXECUTE FUNCTION agent_owner_only_is_final();
