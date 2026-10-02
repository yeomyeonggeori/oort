-- =============================================================================
-- 112_work_session_origin.sql — #2793 / ADR-0190 D4 (Accepted): 「공유」 L 세션
--
-- 로컬 터미널 칸(L 레인)을 팀에 「공유」하면 서버에는 이름·폴더 표시 이름·상태만
-- 올라간다. 그 세션은 별도 종류(`origin = 'local_pty'`)로 기록하고, 서버는 그
-- 종류의 세션에 대한 모든 `work_control`(input·read·kill·permission, 그리고 spawn
-- 의 세션 바인딩) 생성을 **거부한다**. 호스트가 받고 무시하는 방식이 아니다 —
-- 강제 없는 경계는 깨진다(ADR-0143 D3와 같은 이유).
--
-- 강제는 두 겹이다. 라우트는 읽기 쉬운 코드(`local_session_no_control`)로 먼저
-- 거절하고, 이 파일의 트리거가 **어떤 경로로 INSERT/UPDATE 해도** 같은 거절을
-- 한다(에이전트 워커·배치·미래의 새 라우트 포함). 트리거 메시지는
-- `momo_t3::error::classify_pg`가 같은 도메인 오류로 옮긴다.
--
-- 서버에 싣지 않는 것: 폴더 전체 경로, raw 바이트(ADR-0188 §3). `folder_label`은
-- 경로 구분자·제어 문자를 CHECK로 막아 「마지막 경로 요소」만 표현할 수 있다.
-- 새 테이블이 없다. work_session은 019에서 RLS FORCE 대상이고 그대로 유지된다.
-- =============================================================================

ALTER TABLE work_session
  ADD COLUMN origin text NOT NULL DEFAULT 'host',
  ADD COLUMN folder_label text,
  ADD CONSTRAINT work_session_origin_ck
    CHECK (origin IN ('host', 'local_pty')),
  -- 폴더 표시 이름: 마지막 경로 요소만. 구분자(/ \)·제어 문자 불가.
  ADD CONSTRAINT work_session_folder_label_ck CHECK (
    folder_label IS NULL
    OR (
      origin = 'local_pty'
      AND length(btrim(folder_label)) BETWEEN 1 AND 80
      AND folder_label !~ '[/\\[:cntrl:]]'
    )
  ),
  -- 공유 L 세션의 이름도 경로가 될 수 없다.
  ADD CONSTRAINT work_session_local_pty_label_ck CHECK (
    origin = 'host' OR label !~ '[/\\[:cntrl:]]'
  ),
  -- 공유 L 세션은 원격 PTY·화면 바인딩을 갖지 못한다(raw 관전은 D6, 목표 A 뒤).
  ADD CONSTRAINT work_session_local_pty_unbound_ck CHECK (
    origin = 'host'
    OR (
      pty_id IS NULL AND attach_endpoint IS NULL
      AND display_id IS NULL AND display_endpoint IS NULL
    )
  );

COMMENT ON COLUMN work_session.origin IS
  'ADR-0190 D4: host = work_host가 실행한 세션(기본), local_pty = 데스크탑 로컬 칸의 「공유」 기록(이름·폴더 표시 이름·상태만). 불변.';
COMMENT ON COLUMN work_session.folder_label IS
  'ADR-0190 D4: 폴더의 마지막 경로 요소만(local_pty 전용). 전체 경로는 서버에 없다.';

-- origin은 한번 정해지면 바뀌지 않는다: local_pty → host 로 되돌려 컨트롤 거부를
-- 우회하는 길을 닫는다.
CREATE FUNCTION work_session_origin_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'work_session origin is immutable (ADR-0190 D4)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER work_session_origin_immutable
  BEFORE UPDATE OF origin ON work_session
  FOR EACH ROW EXECUTE FUNCTION work_session_origin_immutable();

-- 공유 L 세션에는 어떤 컨트롤도 걸리지 않는다. INSERT와, spawn이 ack 뒤 세션을
-- 바인딩하는 UPDATE(session_id) 모두 막는다. 세션 조회는 호출자와 같은
-- app.workspace_id RLS 아래에서, 같은 workspace_id로만 한다.
CREATE FUNCTION work_control_refuse_local_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.session_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.work_session ws
     WHERE ws.id = NEW.session_id
       AND ws.workspace_id = NEW.workspace_id
       AND ws.origin = 'local_pty'
  ) THEN
    RAISE EXCEPTION 'local_pty session accepts no work control (ADR-0190 D4)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER work_control_refuse_local_session
  BEFORE INSERT OR UPDATE OF session_id ON work_control
  FOR EACH ROW EXECUTE FUNCTION work_control_refuse_local_session();
