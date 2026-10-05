-- =============================================================================
-- 120_cloud_box_relay.sql — #3511 (ADR-0197 M4, 증보 2). The server's side of the blind relay's trust chain.
--
-- 서버는 아래를 **저장·전달만** 한다. 만들 수 없다: 위조는 기기(S2 DeviceClient)와 box-agent가 각자 검증해 거부한다.
--
--   cloud_box_runner.signing_public_key   런너 Ed25519 공개키(set-once). 지문 컬럼은 없다 — 기기가 공개키로 직접 계산한다.
--   cloud_box_trust                       소유자의 첫 DeviceList(불투명 바이트)와 HostPin(불투명 바이트).
--   cloud_box_agent                       box-agent 등록 슬롯(대기) → 런너 증명 뒤 active. active 가 되면 host 키는 바뀌지 않는다.
--
-- 불변식
--   * 페어링 코드·시드·세션 키·터미널 내용을 담을 컬럼이 없다(시험이 컬럼명으로 잠근다). mac 은 서버가 검증할 수 없는
--     HMAC 값(코드를 아는 것은 런너와 박스뿐)이라 비밀이 아니다.
--   * active 인 cloud_box_agent 는 host 키·host_id·증명이 바뀌지 않고 되돌릴 수 없고 지워지지 않는다(재등록 덮어쓰기 금지).
--   * 소유자 목록은 박스가 creating 인 동안만 쓴다(그 뒤의 목록 갱신은 후속 이슈).
--   * RLS ENABLE+FORCE ws_isolation. 쓰기 경로 BYPASSRLS 없음.
-- schema_v0.sql 은 건드리지 않는다.
-- =============================================================================

-- ---- 런너 신원 -------------------------------------------------------------------
ALTER TABLE cloud_box_runner ADD COLUMN signing_public_key bytea;
ALTER TABLE cloud_box_runner ADD CONSTRAINT cloud_box_runner_signing_key_ck
  CHECK (signing_public_key IS NULL OR octet_length(signing_public_key) = 32);

-- 119 의 불변 규칙 + 서명 공개키는 set-once(NULL → 값, 이후 불변).
CREATE OR REPLACE FUNCTION cloud_box_runner_immutable()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.registered_by IS DISTINCT FROM OLD.registered_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cloud_box_runner workspace, name and registrant cannot change (ADR-0197 D2)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.credential_hash IS DISTINCT FROM OLD.credential_hash) THEN
    RAISE EXCEPTION 'a revoked cloud_box_runner stays revoked (ADR-0197 D2)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.signing_public_key IS NOT NULL
     AND NEW.signing_public_key IS DISTINCT FROM OLD.signing_public_key THEN
    RAISE EXCEPTION 'the runner signing key is set once (ADR-0197 증보 2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---- 소유자 첫 목록 · HostPin -------------------------------------------------------
CREATE TABLE cloud_box_trust (
  box_id        uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  -- 소유자 기기가 서명한 DeviceList 바이트(불투명). 서버는 파싱·검증하지 않는다: box-agent 와 기기가 한다.
  owner_list    bytea,
  owner_list_at timestamptz,
  -- 소유자 기기가 서명한 HostPin 바이트(불투명).
  pin           bytea,
  pin_at        timestamptz,
  CONSTRAINT cloud_box_trust_box_fk FOREIGN KEY (box_id, workspace_id)
    REFERENCES cloud_box (id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT cloud_box_trust_list_ck CHECK (
    (owner_list IS NULL) = (owner_list_at IS NULL)
    AND (owner_list IS NULL OR octet_length(owner_list) BETWEEN 1 AND 2048)),
  CONSTRAINT cloud_box_trust_pin_ck CHECK (
    (pin IS NULL) = (pin_at IS NULL)
    AND (pin IS NULL OR octet_length(pin) BETWEEN 1 AND 2048))
);

COMMENT ON TABLE cloud_box_trust IS
  '#3511 ADR-0197 M4: 소유자 첫 DeviceList·HostPin 의 불투명 사본. 서버는 만들지 못하고 저장·전달만 한다.';

-- ---- box-agent 등록 슬롯 ------------------------------------------------------------
CREATE TABLE cloud_box_agent (
  box_id          uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  state           text NOT NULL DEFAULT 'pending',
  host_public_key bytea NOT NULL,
  -- HMAC-SHA256(코드, "momo.box.register.v1" || box_id || host_pub). 서버는 검증하지 못한다(런너가 한다).
  mac             bytea NOT NULL,
  registered_at   timestamptz NOT NULL DEFAULT now(),
  -- active 가 되면 채워진다.
  host_id         uuid REFERENCES work_host(id) ON DELETE RESTRICT,
  attestation     bytea,
  runner_id       uuid,
  activated_at    timestamptz,
  CONSTRAINT cloud_box_agent_box_fk FOREIGN KEY (box_id, workspace_id)
    REFERENCES cloud_box (id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT cloud_box_agent_runner_fk FOREIGN KEY (runner_id, workspace_id)
    REFERENCES cloud_box_runner (id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT cloud_box_agent_state_ck CHECK (state IN ('pending', 'active')),
  CONSTRAINT cloud_box_agent_shape_ck CHECK (
    octet_length(host_public_key) = 32 AND octet_length(mac) = 32
    AND ((state = 'active') = (host_id IS NOT NULL AND attestation IS NOT NULL
                               AND runner_id IS NOT NULL AND activated_at IS NOT NULL))
    AND (attestation IS NULL OR octet_length(attestation) = 64)),
  CONSTRAINT cloud_box_agent_host_uk UNIQUE (host_id)
);

COMMENT ON TABLE cloud_box_agent IS
  '#3511 ADR-0197 M4: box-agent 등록 슬롯. pending 은 마지막 쓰기가 이긴다(런너가 거부하기 전까지), active 가 되면 host 키는 바뀌지 않는다.';

CREATE FUNCTION cloud_box_agent_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state = 'active' THEN
      RAISE EXCEPTION 'an active cloud_box_agent is never deleted (ADR-0197 증보 2)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.box_id IS DISTINCT FROM OLD.box_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'cloud_box_agent box and workspace cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'active' AND (
       NEW.state IS DISTINCT FROM OLD.state
       OR NEW.host_public_key IS DISTINCT FROM OLD.host_public_key
       OR NEW.mac IS DISTINCT FROM OLD.mac
       OR NEW.host_id IS DISTINCT FROM OLD.host_id
       OR NEW.attestation IS DISTINCT FROM OLD.attestation
       OR NEW.runner_id IS DISTINCT FROM OLD.runner_id
       OR NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
    RAISE EXCEPTION 'an active cloud_box_agent host key is never overwritten (ADR-0197 증보 2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cloud_box_agent_guard_upd BEFORE UPDATE ON cloud_box_agent
  FOR EACH ROW EXECUTE FUNCTION cloud_box_agent_guard();
CREATE TRIGGER cloud_box_agent_guard_del BEFORE DELETE ON cloud_box_agent
  FOR EACH ROW EXECUTE FUNCTION cloud_box_agent_guard();

ALTER TABLE cloud_box_trust ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_box_trust FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON cloud_box_trust
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

ALTER TABLE cloud_box_agent ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_box_agent FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON cloud_box_agent
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---- 서명 컨트롤의 nonce 장부가 새 종류 둘을 받는다 -------------------------------------------------------
-- `human_control_nonce.kind` 는 서명이 덮은 `kind` 줄이다(감사용). M4 의 두 종류(`cloud_pty_attach`,
-- `cloud_box_owner_list`)가 같은 장부로 1회용이 된다. 095 의 제약을 넓힌다(기존 값은 그대로).
ALTER TABLE human_control_nonce DROP CONSTRAINT human_control_nonce_kind_ck;
ALTER TABLE human_control_nonce ADD CONSTRAINT human_control_nonce_kind_ck
  CHECK (kind IN ('spawn', 'input', 'permission', 'bundle_manifest', 'host_register',
                  'cloud_pty_attach', 'cloud_box_owner_list'));
