-- =============================================================================
-- 187_work_item.sql — #6066 (ADR-0222 원장-1, Accepted 2026-11-09 · 증보 2026-11-12)
--
-- 「작업 #142」처럼 번호로 부르는 작업의 서버 쪽 사실. 진행 기록(원장-2)·링크(원장-3)·팀 묶음은
-- 이 파일에 없다.
--
--   work_item_counter   워크스페이스마다 한 행, 마지막으로 준 작업 번호. 번호는 이 행을 잠그고
--                       올려서만 생긴다(아래 work_item_assign_number 트리거). 그래서 어떤 쓰기
--                       경로도 번호를 고르지 못하고, 동시에 만들어도 중복·빈 번호가 없다
--                       (트랜잭션이 되돌려지면 카운터도 같이 되돌려진다).
--   work_item           작업 한 건. 네 칸(D2):
--                         담당자   assignee_member_id      사람만(트리거) · 비울 수 없음
--                         진행     doer_member_id          사람이나 에이전트 · 비면 「대기 중」
--                         요청한 사람 requested_by_member_id  만들 때 쓰고 바꾸지 못함(트리거)
--                         대신한 사람 on_behalf_of_member_id 사람만 · 요청한 사람이 사람이면 같은 값
--   agent_run / work_session   NULL 허용 work_item_id(하위 작업 연결). agent_run 에는 요청한
--                       사람·대신한 사람 칸(옛 행은 NULL). 자식 run 의 작업은 부모 run 의 작업과
--                       같다 — 비워 두면 트리거가 부모 것을 물려 쓰고, 다르면 거절한다.
--
-- 불변식
--   * 담당자와 대신한 사람은 같은 워크스페이스의 member.kind='human' 이다. 앱 검사를 빼도 DB 가
--     check_violation 으로 거절한다(INSERT·UPDATE 모두 — 118 cloud_box_owner_is_human 과 같은
--     방식이고, 여기는 UPDATE 도 막는다).
--   * 새 표 둘은 workspace_id NOT NULL + RLS ENABLE·FORCE + ws_isolation. 쓰기 경로 BYPASSRLS 없음.
--   * 사람·채널을 가리키는 칸은 모두 (workspace_id, id) 복합 FK 라 다른 워크스페이스를 가리키지
--     못한다.
--   * 제목: 다듬은 뒤 1~200자, 제어·보이지 않는·방향을 바꾸는 문자 금지. Rust 쪽 규칙
--     (momo_wire::report_text::checked_text)이 이 CHECK 를 포함하므로 CHECK 가 먼저 터지지 않는다.
--
-- LOCK NOTE (운영): agent_run·work_session 의 ALTER TABLE 은 커밋까지 ACCESS EXCLUSIVE 를 쥔다.
-- 기본값 없는 NULL 허용 칸 추가는 메타데이터만 바꾸고, FK 는 NOT VALID 로 더해 옛 행을 훑지 않는다
-- (새 칸이라 옛 행은 모두 NULL 이다 — 168 과 같은 까닭으로 VALIDATE 하지 않는다).
--
-- schema_v0.sql 은 건드리지 않는다.
-- =============================================================================

-- ---- 작업 번호 카운터 ------------------------------------------------------------
CREATE TABLE work_item_counter (
  workspace_id  uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  last_number   bigint NOT NULL CHECK (last_number >= 1)
);

COMMENT ON TABLE work_item_counter IS
  '#6066 ADR-0222 D2: 워크스페이스마다 마지막으로 준 작업 번호. work_item_assign_number 트리거만 올린다.';

ALTER TABLE work_item_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON work_item_counter
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---- 작업 ------------------------------------------------------------------------
CREATE TABLE work_item (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id            uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 트리거가 카운터에서 정한다. INSERT 가 무엇을 넣든 덮어쓴다.
  number                  bigint NOT NULL,
  home_channel_id         uuid NOT NULL,
  title                   text NOT NULL,
  state                   text NOT NULL DEFAULT 'open',
  assignee_member_id      uuid NOT NULL,
  doer_member_id          uuid,
  requested_by_member_id  uuid NOT NULL,
  on_behalf_of_member_id  uuid NOT NULL,
  created_by_member_id    uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  closed_by_member_id     uuid,
  CONSTRAINT work_item_number_uk UNIQUE (workspace_id, number),
  -- agent_run·work_session 이 (workspace_id, work_item_id) 로 가리킨다.
  CONSTRAINT work_item_ws_id_uk UNIQUE (workspace_id, id),
  CONSTRAINT work_item_number_ck CHECK (number >= 1),
  CONSTRAINT work_item_state_ck CHECK (state IN ('open', 'done', 'cancelled')),
  CONSTRAINT work_item_closed_ck CHECK (
    (state = 'open') = (closed_at IS NULL)
    AND (state = 'open') = (closed_by_member_id IS NULL)),
  CONSTRAINT work_item_title_ck CHECK (
    title = btrim(title)
    AND char_length(title) BETWEEN 1 AND 200
    AND title !~ '[[:cntrl:]­؜​-‏\u2028-‮⁠-⁯﻿]'),
  CONSTRAINT work_item_home_channel_fk FOREIGN KEY (workspace_id, home_channel_id)
    REFERENCES channel (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT work_item_assignee_fk FOREIGN KEY (workspace_id, assignee_member_id)
    REFERENCES member (workspace_id, id),
  CONSTRAINT work_item_doer_fk FOREIGN KEY (workspace_id, doer_member_id)
    REFERENCES member (workspace_id, id),
  CONSTRAINT work_item_requested_by_fk FOREIGN KEY (workspace_id, requested_by_member_id)
    REFERENCES member (workspace_id, id),
  CONSTRAINT work_item_on_behalf_of_fk FOREIGN KEY (workspace_id, on_behalf_of_member_id)
    REFERENCES member (workspace_id, id),
  CONSTRAINT work_item_created_by_fk FOREIGN KEY (workspace_id, created_by_member_id)
    REFERENCES member (workspace_id, id),
  CONSTRAINT work_item_closed_by_fk FOREIGN KEY (workspace_id, closed_by_member_id)
    REFERENCES member (workspace_id, id)
);

COMMENT ON TABLE work_item IS
  '#6066 ADR-0222 D2: 작업(워크스페이스마다 1부터 오르는 번호, 제목, 집 채널). 담당자·대신한 사람은 사람만(트리거), 요청한 사람은 바꾸지 못함.';

CREATE INDEX work_item_home_channel_idx ON work_item (workspace_id, home_channel_id, number DESC);
CREATE INDEX work_item_assignee_open_idx ON work_item (workspace_id, assignee_member_id)
  WHERE state = 'open';

-- 번호는 카운터 행을 잠그고 올려서만 생긴다. 첫 작업은 카운터 행을 만든다(ON CONFLICT 가 행
-- 잠금을 잡으므로 동시에 처음 만드는 두 트랜잭션도 차례로 1·2 를 받는다).
CREATE FUNCTION work_item_assign_number()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.work_item_counter AS c (workspace_id, last_number)
  VALUES (NEW.workspace_id, 1)
  ON CONFLICT (workspace_id) DO UPDATE SET last_number = c.last_number + 1
  RETURNING c.last_number INTO NEW.number;
  RETURN NEW;
END $$;

CREATE TRIGGER work_item_assign_number
  BEFORE INSERT ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_item_assign_number();

-- 같은 워크스페이스의 사람인가. 담당자·대신한 사람 검사가 이 한 함수를 쓴다(agent_run 도).
CREATE FUNCTION work_item_member_is_human(p_workspace_id uuid, p_member_id uuid)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.member m
     WHERE m.workspace_id = p_workspace_id
       AND m.id = p_member_id
       AND m.kind = 'human')
$$;

-- 담당자·대신한 사람은 사람만, 요청한 사람이 사람이면 대신한 사람은 같은 사람(D2·데이터 계약).
-- UPDATE 에서는 번호·워크스페이스·요청한 사람·만든 이·만든 시각을 바꾸지 못한다.
CREATE FUNCTION work_item_people_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.number IS DISTINCT FROM OLD.number
       OR NEW.requested_by_member_id IS DISTINCT FROM OLD.requested_by_member_id
       OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'work_item number, workspace, requester and creator cannot change (ADR-0222 D2)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT public.work_item_member_is_human(NEW.workspace_id, NEW.assignee_member_id) THEN
    RAISE EXCEPTION 'work_item assignee must be a human member of the workspace (ADR-0222 D2)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.work_item_member_is_human(NEW.workspace_id, NEW.on_behalf_of_member_id) THEN
    RAISE EXCEPTION 'work_item on-behalf-of must be a human member of the workspace (ADR-0222 D2)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF public.work_item_member_is_human(NEW.workspace_id, NEW.requested_by_member_id)
     AND NEW.on_behalf_of_member_id IS DISTINCT FROM NEW.requested_by_member_id THEN
    RAISE EXCEPTION 'work_item on-behalf-of must equal a human requester (ADR-0222 D2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER work_item_people_guard
  BEFORE INSERT OR UPDATE ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_item_people_guard();

ALTER TABLE work_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON work_item
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---- 하위 작업 연결 --------------------------------------------------------------
ALTER TABLE agent_run
  ADD COLUMN work_item_id uuid,
  ADD COLUMN requested_by_member_id uuid,
  ADD COLUMN on_behalf_of_member_id uuid;

ALTER TABLE agent_run
  ADD CONSTRAINT agent_run_work_item_fk FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES work_item (workspace_id, id) ON DELETE SET NULL (work_item_id) NOT VALID,
  ADD CONSTRAINT agent_run_requested_by_fk FOREIGN KEY (workspace_id, requested_by_member_id)
    REFERENCES member (workspace_id, id) NOT VALID,
  ADD CONSTRAINT agent_run_on_behalf_of_fk FOREIGN KEY (workspace_id, on_behalf_of_member_id)
    REFERENCES member (workspace_id, id) NOT VALID;

CREATE INDEX agent_run_work_item_idx ON agent_run (workspace_id, work_item_id)
  WHERE work_item_id IS NOT NULL;

-- 자식 run 의 작업은 부모 run 의 작업과 같다(D2 「서버가 만들 때 쓴다」). 비워 두면 부모 것을
-- 물려 쓰고, 다른 값이면 거절한다. 자식이 있는 run 의 작업은 바꾸지 못한다(사슬이 어긋나므로).
-- 대신한 사람은 사람만, 요청한 사람이 사람이면 같은 사람이다(데이터 계약 「하위 작업」).
CREATE FUNCTION agent_run_work_item_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_item uuid;
BEGIN
  IF NEW.parent_run_id IS NOT NULL THEN
    SELECT p.work_item_id INTO parent_item
      FROM public.agent_run p
     WHERE p.id = NEW.parent_run_id AND p.workspace_id = NEW.workspace_id;
    IF NEW.work_item_id IS NULL THEN
      NEW.work_item_id := parent_item;
    ELSIF NEW.work_item_id IS DISTINCT FROM parent_item THEN
      RAISE EXCEPTION 'agent_run work item must equal its parent run''s (ADR-0222 D2)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
     AND EXISTS (SELECT 1 FROM public.agent_run c
                  WHERE c.parent_run_id = NEW.id AND c.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'agent_run with child runs cannot change its work item (ADR-0222 D2)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.on_behalf_of_member_id IS NOT NULL THEN
    IF NOT public.work_item_member_is_human(NEW.workspace_id, NEW.on_behalf_of_member_id) THEN
      RAISE EXCEPTION 'agent_run on-behalf-of must be a human member of the workspace (ADR-0222 D2)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.requested_by_member_id IS NOT NULL
       AND public.work_item_member_is_human(NEW.workspace_id, NEW.requested_by_member_id)
       AND NEW.on_behalf_of_member_id IS DISTINCT FROM NEW.requested_by_member_id THEN
      RAISE EXCEPTION 'agent_run on-behalf-of must equal a human requester (ADR-0222 D2)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_run_work_item_guard
  BEFORE INSERT OR UPDATE OF parent_run_id, work_item_id, requested_by_member_id,
    on_behalf_of_member_id
  ON agent_run
  FOR EACH ROW EXECUTE FUNCTION agent_run_work_item_guard();

ALTER TABLE work_session
  ADD COLUMN work_item_id uuid;

ALTER TABLE work_session
  ADD CONSTRAINT work_session_work_item_fk FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES work_item (workspace_id, id) ON DELETE SET NULL (work_item_id) NOT VALID;

CREATE INDEX work_session_work_item_idx ON work_session (workspace_id, work_item_id)
  WHERE work_item_id IS NOT NULL;
