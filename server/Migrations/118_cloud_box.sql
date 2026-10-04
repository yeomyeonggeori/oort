-- =============================================================================
-- 118_cloud_box.sql — #3500 (ADR-0197 M1, 성재 결재 2026-10-03, 증보 1 Accepted 2026-10-05)
--
-- 개인 클라우드 작업 공간(「박스」)의 서버 쪽 사실. 서버가 가진 것은 박스 행(상태·한도·시각)과
-- 런너가 outbound 로 폴링할 수명 컨트롤 큐뿐이다(D10 「서버에 남는 것」). 터미널 내용, 로그인
-- 상태 세부, 자격, host 키, 페어링 코드는 이 표에 없다 — 컬럼이 아예 없다(시험이 컬럼명으로 잠근다).
--
--   cloud_box           멤버(member_id) × 워크스페이스당 박스 1(D1). 상태 전이 표(D3·D10)를
--                       DB 트리거로도 강제한다(Rust 전이 함수와 같은 표, 쌍별 시험이 일치를 잠근다).
--   cloud_box_control   런너가 폴링해 실행할 수명 컨트롤. 동사 5개(create|start|stop|delete|status)
--                       의 닫힌 목록이고, 자유 payload(jsonb)가 없다 — create 의 한도 4칸만
--                       명시 컬럼이다(D2 「닫힌 컨트롤 스키마」: 알 수 없는 필드를 담을 곳이 없다).
--
-- 불변식
--   * 멤버당 박스 1: (workspace_id, member_id) 부분 UNIQUE WHERE state <> 'deleted'.
--     `deleted` 행은 tombstone(D10)이라 남지만 재생성(D5 「삭제 후 재생성」)을 막지 않는다.
--     `delete_failed` 는 볼륨이 살아 있을 수 있으므로 자리를 계속 차지한다.
--   * 한도 컬럼은 ADR 기본값 이하만 담는다(관리자는 줄일 수만 있다, D3). 올리는 경로가 없다.
--   * 소유자는 같은 워크스페이스의 사람(kind='human')이다. 에이전트는 박스를 갖지 않는다.
--   * RLS FORCE + ws_isolation. 쓰기 경로 BYPASSRLS 없음. 런너는 워크스페이스당 하나(D2)라
--     폴링도 tenant tx(`SET LOCAL app.workspace_id`) 안에서 한다 — 전 테넌트 예외를 늘리지 않는다.
--   * 박스·멤버·워크스페이스를 지우는 FK 는 RESTRICT 다: 박스 행은 `deleted` 확인 전까지
--     지우지 않는다(D10 tombstone). 멤버 탈퇴·워크스페이스 삭제 연쇄는 M6 가 상태 전이로 푼다.
--
-- schema_v0.sql 은 건드리지 않는다.
-- =============================================================================

CREATE TABLE cloud_box (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id          uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  member_id             uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  -- D3 상태 + D10 delete_failed. 「없음」은 행이 없는 것(또는 deleted tombstone)이다.
  state                 text NOT NULL DEFAULT 'creating',
  -- 삭제로 들어간 이유(deleting|delete_failed|deleted 에서만 값이 있다). 자유 문장이 아니다.
  closed_reason         text,
  -- 한도(D3 기본값이 상한). 박스를 만들 때의 값을 박스가 들고 간다.
  cpu_millis            integer NOT NULL DEFAULT 1000,
  memory_mb             integer NOT NULL DEFAULT 2048,
  disk_gb               integer NOT NULL DEFAULT 10,
  pids                  integer NOT NULL DEFAULT 512,
  idle_minutes          integer NOT NULL DEFAULT 30,
  stopped_delete_days   integer NOT NULL DEFAULT 30,
  keep_awake_max_hours  integer NOT NULL DEFAULT 12,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  state_changed_at      timestamptz NOT NULL DEFAULT now(),
  idle_since            timestamptz,
  stopped_at            timestamptz,
  -- 「계속 켜 둠」(D3): 소유자가 명시로 켜고 기본 최대 12시간. 만료 시각만 둔다.
  keep_awake_until      timestamptz,
  last_attached_at      timestamptz,
  deleted_at            timestamptz,
  CONSTRAINT cloud_box_state_ck CHECK (state IN
    ('creating', 'running', 'idle', 'stopped', 'deleting', 'delete_failed', 'deleted')),
  CONSTRAINT cloud_box_closed_reason_ck CHECK (closed_reason IS NULL OR closed_reason IN
    ('owner_delete', 'admin_delete', 'stopped_expired', 'create_failed',
     'member_removed', 'workspace_deleted')),
  CONSTRAINT cloud_box_closed_reason_state_ck CHECK (
    (state IN ('deleting', 'delete_failed', 'deleted')) = (closed_reason IS NOT NULL)),
  CONSTRAINT cloud_box_limits_ck CHECK (
    cpu_millis BETWEEN 1 AND 1000
    AND memory_mb BETWEEN 1 AND 2048
    AND disk_gb BETWEEN 1 AND 10
    AND pids BETWEEN 1 AND 512
    AND idle_minutes BETWEEN 1 AND 30
    AND stopped_delete_days BETWEEN 1 AND 30
    AND keep_awake_max_hours BETWEEN 1 AND 12),
  CONSTRAINT cloud_box_idle_since_ck CHECK ((state = 'idle') = (idle_since IS NOT NULL)),
  CONSTRAINT cloud_box_stopped_at_ck CHECK ((state = 'stopped') = (stopped_at IS NOT NULL)),
  CONSTRAINT cloud_box_keep_awake_ck CHECK (
    keep_awake_until IS NULL OR state IN ('running', 'idle')),
  CONSTRAINT cloud_box_deleted_at_ck CHECK ((state = 'deleted') = (deleted_at IS NOT NULL)),
  -- 컨트롤 표가 (box_id, workspace_id) 복합 FK 로 같은 워크스페이스임을 DB 가 지키게 한다.
  CONSTRAINT cloud_box_id_ws_uk UNIQUE (id, workspace_id)
);

COMMENT ON TABLE cloud_box IS
  '#3500 ADR-0197 M1: 멤버 개인 클라우드 박스 행(상태·한도·시각). 멤버당 활성 박스 1. 자격·host 키·터미널 내용·로그인 상태 세부는 이 표에 없다(D10).';

-- 멤버당 박스 1(D1). tombstone(deleted)은 제외한다.
CREATE UNIQUE INDEX cloud_box_member_live_uk
  ON cloud_box (workspace_id, member_id) WHERE state <> 'deleted';
-- 워크스페이스 동시 켜짐 상한(D3)과 관리자 목록.
CREATE INDEX cloud_box_ws_state_idx ON cloud_box (workspace_id, state);

-- 소유자는 같은 워크스페이스의 사람이다.
CREATE FUNCTION cloud_box_owner_is_human()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.member m
     WHERE m.id = NEW.member_id
       AND m.workspace_id = NEW.workspace_id
       AND m.kind = 'human'
  ) THEN
    RAISE EXCEPTION 'cloud_box owner must be a human member of the workspace (ADR-0197 D1)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cloud_box_owner_human
  BEFORE INSERT ON cloud_box
  FOR EACH ROW EXECUTE FUNCTION cloud_box_owner_is_human();

-- 새 행은 「만드는 중」에서만 시작한다.
CREATE FUNCTION cloud_box_initial_state()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state <> 'creating' THEN
    RAISE EXCEPTION 'cloud_box starts in creating (ADR-0197 D3), not %', NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cloud_box_initial_state_guard
  BEFORE INSERT ON cloud_box
  FOR EACH ROW EXECUTE FUNCTION cloud_box_initial_state();

-- 상태 전이 표(D3·D10)를 DB 에서도 강제한다. Rust `cloud_box::next_state` 와 같은 표이고,
-- 시험이 7×7 모든 쌍에서 두 표가 일치함을 잠근다. 같은 상태로의 UPDATE 는 통과(다른 컬럼 갱신).
--   creating      → running | deleting | deleted(생성 실패)
--   running       → idle | stopped | deleting
--   idle          → running | stopped | deleting
--   stopped       → running | deleting
--   deleting      → deleted | delete_failed
--   delete_failed → deleting
--   deleted       → (없음, 종결)
CREATE FUNCTION cloud_box_transition_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cloud_box owner and workspace cannot change (ADR-0197 D1)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF (OLD.state, NEW.state) IN (
       ('creating', 'running'), ('creating', 'deleting'), ('creating', 'deleted'),
       ('running', 'idle'), ('running', 'stopped'), ('running', 'deleting'),
       ('idle', 'running'), ('idle', 'stopped'), ('idle', 'deleting'),
       ('stopped', 'running'), ('stopped', 'deleting'),
       ('deleting', 'deleted'), ('deleting', 'delete_failed'),
       ('delete_failed', 'deleting')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'cloud_box transition % -> % is not in the lifecycle table (ADR-0197 D3)',
    OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER cloud_box_transition_guard
  BEFORE UPDATE ON cloud_box
  FOR EACH ROW EXECUTE FUNCTION cloud_box_transition_guard();

ALTER TABLE cloud_box ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_box FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON cloud_box
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---- 컨트롤 큐 -----------------------------------------------------------------
CREATE TABLE cloud_box_control (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  -- 같은 박스에 대한 컨트롤의 전달 순서(런너는 seq 순으로 받는다).
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  box_id           uuid NOT NULL,
  -- D2 허용 동사 5개. exec·cp·commit·export·snapshot 은 목록에 없다 → 넣을 수 없다.
  verb             text NOT NULL,
  -- create 가 받는 것은 {box_id, 한도} 뿐이다(D2). 이미지·명령·마운트·네트워크·env 는 컬럼이 없다.
  cpu_millis       integer,
  memory_mb        integer,
  disk_gb          integer,
  pids             integer,
  requested_by     uuid REFERENCES member(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'pending',
  result_code      text,
  attempts         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  lease_expires_at timestamptz,
  completed_at     timestamptz,
  CONSTRAINT cloud_box_control_box_fk FOREIGN KEY (box_id, workspace_id)
    REFERENCES cloud_box (id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT cloud_box_control_verb_ck CHECK (verb IN
    ('create', 'start', 'stop', 'delete', 'status')),
  CONSTRAINT cloud_box_control_status_ck CHECK (status IN
    ('pending', 'claimed', 'done', 'failed', 'cancelled')),
  CONSTRAINT cloud_box_control_result_ck CHECK (result_code IS NULL OR result_code IN ('ok', 'failed')),
  CONSTRAINT cloud_box_control_limits_ck CHECK (
    (verb = 'create'
       AND cpu_millis IS NOT NULL AND memory_mb IS NOT NULL
       AND disk_gb IS NOT NULL AND pids IS NOT NULL
       AND cpu_millis BETWEEN 1 AND 1000 AND memory_mb BETWEEN 1 AND 2048
       AND disk_gb BETWEEN 1 AND 10 AND pids BETWEEN 1 AND 512)
    OR (verb <> 'create'
       AND cpu_millis IS NULL AND memory_mb IS NULL AND disk_gb IS NULL AND pids IS NULL)),
  CONSTRAINT cloud_box_control_shape_ck CHECK (
    (status = 'pending' AND claimed_at IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
    OR (status = 'claimed' AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('done', 'failed') AND completed_at IS NOT NULL AND result_code IS NOT NULL)
    OR (status = 'cancelled' AND completed_at IS NOT NULL))
);

COMMENT ON TABLE cloud_box_control IS
  '#3500 ADR-0197 D2: 런너가 outbound 로 폴링하는 수명 컨트롤 큐. 동사 5개의 닫힌 목록, 자유 payload 없음. 박스당 진행 중 컨트롤 1개.';

-- 박스당 진행 중(pending|claimed) 컨트롤 1개. 새 컨트롤은 앞의 것이 끝나거나 취소돼야 들어간다.
CREATE UNIQUE INDEX cloud_box_control_in_flight_uk
  ON cloud_box_control (box_id) WHERE status IN ('pending', 'claimed');
CREATE INDEX cloud_box_control_poll_idx
  ON cloud_box_control (workspace_id, seq) WHERE status IN ('pending', 'claimed');

-- 컨트롤이 무엇을 하라는 것인지(동사·박스·한도)는 만든 뒤 바꿀 수 없다.
CREATE FUNCTION cloud_box_control_immutable()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.box_id IS DISTINCT FROM OLD.box_id
     OR NEW.verb IS DISTINCT FROM OLD.verb
     OR NEW.cpu_millis IS DISTINCT FROM OLD.cpu_millis
     OR NEW.memory_mb IS DISTINCT FROM OLD.memory_mb
     OR NEW.disk_gb IS DISTINCT FROM OLD.disk_gb
     OR NEW.pids IS DISTINCT FROM OLD.pids
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cloud_box_control verb, box and limits cannot change (ADR-0197 D2)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('done', 'failed', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'cloud_box_control finished status cannot change (ADR-0197 D2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cloud_box_control_immutable_guard
  BEFORE UPDATE ON cloud_box_control
  FOR EACH ROW EXECUTE FUNCTION cloud_box_control_immutable();

ALTER TABLE cloud_box_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_box_control FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON cloud_box_control
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
