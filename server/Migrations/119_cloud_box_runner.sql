-- =============================================================================
-- 119_cloud_box_runner.sql — #3505 (ADR-0197 M2, 성재 결재 2026-10-03, 증보 1 Accepted 2026-10-05)
--
-- 런너(`momo-box-runner`)의 서버 쪽 사실 두 가지:
--
--   cloud_box_runner   워크스페이스당 런너 1(D2 「한 런너 VM은 한 워크스페이스의 박스만」). 런너의 자격은
--                      평문이 아니라 SHA-256 해시만 저장한다(등록·회전 응답에서 한 번만 보인다). 등록·회전·폐기는
--                      인스턴스 운영자 몫이고(D2 역할 분리) 런너 라우트는 이 자격 하나만 받는다.
--   cloud_box_control  M1 의 큐에 펜싱(`lease_id`+`attempts`+`runner_id`)과 보고 칸을 더한다. 보고 칸은 전부 닫힌
--                      값이다: `observed`(running|stopped|absent), 삭제 검증(`container_absent`·`volume_absent`).
--                      자유 문장·jsonb 는 없다(inspect·env 를 담을 곳이 없다).
--
-- 불변식
--   * 활성 런너 1: (workspace_id) 부분 UNIQUE WHERE revoked_at IS NULL. 폐기된 행은 감사용으로 남는다.
--   * 자격 평문·시드 컬럼 없음: `credential_hash`(sha256, 32바이트)와 표시용 `credential_fingerprint`뿐이다.
--   * 폐기는 되돌릴 수 없다(revoked_at 은 NULL→값으로만). 행은 지우지 않는다(감사·FK).
--   * claimed 컨트롤은 반드시 runner_id 와 lease_id 를 가진다. 같은 컨트롤을 다시 내줄 때마다 lease_id 가
--     바뀌므로 지난 lease 로는 완료할 수 없다(펜싱).
--   * 시도 횟수 상한: attempts 는 Rust 상수(MAX_CONTROL_ATTEMPTS)에서 poison 처리되고, DB 는 그 위 하드 상한(10)을 둔다.
--   * RLS ENABLE+FORCE `ws_isolation`. 런너는 워크스페이스당 하나라 폴링도 tenant tx 안에서 한다.
--
-- schema_v0.sql 은 건드리지 않는다.
-- =============================================================================

CREATE TABLE cloud_box_runner (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id           uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  -- 박스 만들기 동의 화면이 보여 줄 런너 이름(D2). 자유 문장이 아니라 짧은 라벨이다.
  name                   text NOT NULL,
  credential_hash        bytea NOT NULL,
  -- 해시 앞 8바이트의 16진 표기: 운영자가 어느 자격인지 알아보는 표시. 해시 자체는 응답에 싣지 않는다.
  credential_fingerprint text NOT NULL,
  registered_by          uuid REFERENCES member(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  rotated_at             timestamptz,
  last_seen_at           timestamptz,
  revoked_at             timestamptz,
  CONSTRAINT cloud_box_runner_name_ck CHECK (char_length(name) BETWEEN 1 AND 64),
  CONSTRAINT cloud_box_runner_hash_ck CHECK (octet_length(credential_hash) = 32),
  CONSTRAINT cloud_box_runner_fingerprint_ck CHECK (credential_fingerprint ~ '^[0-9a-f]{16}$'),
  CONSTRAINT cloud_box_runner_id_ws_uk UNIQUE (id, workspace_id)
);

COMMENT ON TABLE cloud_box_runner IS
  '#3505 ADR-0197 M2: 워크스페이스당 활성 런너 1. 자격은 sha256 해시만 저장한다(평문은 등록·회전 응답에 한 번).';

CREATE UNIQUE INDEX cloud_box_runner_one_live_uk
  ON cloud_box_runner (workspace_id) WHERE revoked_at IS NULL;

-- 이름·소유 워크스페이스·등록자·생성 시각은 못 바꾼다. 폐기는 되돌릴 수 없다. 자격 해시는 회전으로만 바뀐다.
CREATE FUNCTION cloud_box_runner_immutable()
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
  RETURN NEW;
END $$;

CREATE TRIGGER cloud_box_runner_immutable_guard
  BEFORE UPDATE ON cloud_box_runner
  FOR EACH ROW EXECUTE FUNCTION cloud_box_runner_immutable();

-- 런너 행은 지우지 않는다(폐기만). 권한 REVOKE 와 별개로 DB 가 삭제 자체를 거부한다.
CREATE FUNCTION cloud_box_runner_delete_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'cloud_box_runner rows are revoked, never deleted (ADR-0197 D2)'
    USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER cloud_box_runner_delete_guard
  BEFORE DELETE ON cloud_box_runner
  FOR EACH ROW EXECUTE FUNCTION cloud_box_runner_delete_guard();

ALTER TABLE cloud_box_runner ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_box_runner FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON cloud_box_runner
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---- 컨트롤 큐: 펜싱·보고 ------------------------------------------------------
-- M1 로 만들어진 claimed 행이 있다면(런너가 없었으므로 있을 수 없지만) 새 모양 검사를 통과하도록 pending 으로 돌린다.
UPDATE cloud_box_control
   SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL
 WHERE status = 'claimed';

ALTER TABLE cloud_box_control
  ADD COLUMN runner_id        uuid,
  ADD COLUMN lease_id         uuid,
  -- `status` 컨트롤의 보고: 닫힌 세 값뿐(inspect 출력·env 가 아니다).
  ADD COLUMN observed         text,
  -- `delete` 컨트롤의 삭제 검증 보고(D10): 런너가 컨테이너·볼륨 부재를 직접 확인한 결과.
  ADD COLUMN container_absent boolean,
  ADD COLUMN volume_absent    boolean;

ALTER TABLE cloud_box_control
  ADD CONSTRAINT cloud_box_control_runner_fk FOREIGN KEY (runner_id, workspace_id)
    REFERENCES cloud_box_runner (id, workspace_id) ON DELETE RESTRICT;

ALTER TABLE cloud_box_control DROP CONSTRAINT cloud_box_control_result_ck;
ALTER TABLE cloud_box_control ADD CONSTRAINT cloud_box_control_result_ck
  CHECK (result_code IS NULL OR result_code IN ('ok', 'failed', 'poisoned'));

ALTER TABLE cloud_box_control DROP CONSTRAINT cloud_box_control_shape_ck;
ALTER TABLE cloud_box_control ADD CONSTRAINT cloud_box_control_shape_ck CHECK (
  (status = 'pending' AND claimed_at IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL
     AND runner_id IS NULL AND lease_id IS NULL)
  OR (status = 'claimed' AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL
     AND runner_id IS NOT NULL AND lease_id IS NOT NULL)
  OR (status IN ('done', 'failed') AND completed_at IS NOT NULL AND result_code IS NOT NULL)
  OR (status = 'cancelled' AND completed_at IS NOT NULL));

-- poison 은 실패의 한 갈래다(상한을 넘겨 더는 내주지 않는다). 끝난 컨트롤에서만 값이 있고 done 일 수 없다.
ALTER TABLE cloud_box_control ADD CONSTRAINT cloud_box_control_poison_ck
  CHECK (result_code IS DISTINCT FROM 'poisoned' OR status = 'failed');
ALTER TABLE cloud_box_control ADD CONSTRAINT cloud_box_control_attempts_ck
  CHECK (attempts BETWEEN 0 AND 10);
-- 보고 칸은 맞는 동사의 끝난 컨트롤에서만 값이 있다.
ALTER TABLE cloud_box_control ADD CONSTRAINT cloud_box_control_report_ck CHECK (
  (observed IS NULL OR (verb = 'status' AND status = 'done' AND observed IN ('running', 'stopped', 'absent')))
  AND ((container_absent IS NULL AND volume_absent IS NULL)
       OR (verb = 'delete' AND status IN ('done', 'failed')
           AND container_absent IS NOT NULL AND volume_absent IS NOT NULL)));

CREATE INDEX cloud_box_control_runner_idx ON cloud_box_control (runner_id) WHERE runner_id IS NOT NULL;
