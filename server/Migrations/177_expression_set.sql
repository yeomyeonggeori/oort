-- =============================================================================
-- 177_expression_set.sql — #5459 S1a (ADR-0218 증보 6 §12 L3·L7·L8·L10, Accepted 2026-11-07)
--
-- 이모티콘 세트의 서버 임시 보관. 팀 AI(oort 도우미)가 Hermes로 만드는 그림 최대 40장을 승인 전에
-- 서버가 세 렌디션으로 쌓아 두는 자리다. 159(`expression_assembly`)의 형제이고 같은 불변 픽셀 CHECK를
-- 받는다. 제안은 `setId`만 가리킨다(그림 바이트는 제안 본문에 없다). 이 파일은 보관만 만든다:
-- 문·카드(S1b)·결정 tx(S2)·도우미 도구(S5a)는 다른 칸이다.
--
-- 표 넷
--   expression_set         머리. 계획 열(제목·앞머리·prompt·참조 id)은 begin의 INSERT가 한 번 쓰고 그 뒤 바뀌지
--                          않는다(끝 길에서 prompt를 NULL로 비우는 것 하나만 예외). 상태는 앞으로만 간다.
--   expression_set_slot    계획이 정한 칸. begin이 모두 만들고, 칸마다 상태는 planned -> ready|gray 한 번만 바뀐다.
--   expression_set_image   칸별 세 렌디션(158과 같은 CHECK). 한 칸의 한 렌디션은 한 번만 쓰이고 UPDATE는 없다.
--   expression_set_notice  멤버가 참조 그림 고지를 처음 본 때. (워크스페이스, 멤버)당 한 행, UPDATE는 없다.
--
-- 쓰기 주체는 BYPASSRLS momo_worker다(ADR-0218 §12 L10.1, F15). BYPASSRLS라서 RLS가 마지막 문이 못 되므로
--   (1) 아래 expression-set-lockdown 블록이 역할마다 코드가 쓰는 동사만 남기고,
--   (2) 도메인 함수의 모든 SQL이 workspace_id와 소유 조건(에이전트·요청자·run)을 직접 쓰며,
--   (3) 이 파일의 복합 외래 키와 트리거가 BYPASSRLS 쓰기에서도 교차 테넌트 참조·두 번 쓰기·되돌리기를 거절한다.
-- 블록은 이 파일·bootstrap_roles.sql·bootstrap_runtime_roles.sql에 같은 글자로 있다(두 bootstrap 파일은
-- 마이그레이션 뒤에 ALL TABLES 권한을 다시 주므로 이 파일에서만 거두면 다음 bootstrap이 되돌린다).
-- 이 파일 안의 권한 부여 문장은 그 블록 하나뿐이다(정적 가드 시험이 센다).
--
-- schema_v0.sql 은 건드리지 않는다. 기존 표의 변경은 expression_draft의 candidate_index CHECK 하나뿐이다
-- (세트 초안은 후보 번호 0~39를 쓴다. expression.create의 후보 4개 천장은 앱과 스키마가 계속 지킨다).
-- =============================================================================

CREATE TABLE expression_set (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  agent_member_id uuid NOT NULL,            -- 제안하는 도우미
  requester_member_id uuid NOT NULL,        -- 부탁한 사람(run의 트리거 작성자)
  run_id uuid NOT NULL,
  channel_id uuid NOT NULL,                 -- 카드가 서는 대화 = run의 채널
  -- 계획 열: begin이 한 번 쓰고 그 뒤 UPDATE는 트리거가 거절한다(prompt만 끝 길에서 NULL로 비울 수 있다)
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40 AND title !~ '[[:cntrl:]@<>\[\]`\\]'),
  prefix text NOT NULL CHECK (prefix ~ '^[a-z0-9]{2,12}$'),
  backend text NOT NULL CHECK (backend IN ('hermes','team_image_model')),
  subject_member_id uuid,
  prompt text CHECK (prompt IS NULL OR char_length(prompt) BETWEEN 1 AND 800),
  -- L18.5: 첨부를 여는 열쇠가 아니라 기록용 포인터다. 외래 키 없음(첨부가 지워져도 남는다).
  reference_attachment_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(reference_attachment_ids) <= 4),
  -- 상태 열
  state text NOT NULL DEFAULT 'staging' CHECK (state IN ('staging','proposed','decided','expired')),
  plan_confirmed_at timestamptz,            -- 「이대로 만들기」가 한 번 쓴다. NULL인 동안 읽기·주소 발급·위임 호출이 0이다
  notice_shown boolean NOT NULL DEFAULT false,
  stored_bytes bigint NOT NULL DEFAULT 0 CHECK (stored_bytes BETWEEN 0 AND 25165824),
  approval_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- staging에만 sweep이 건다. plan_confirmed_at이 값을 얻는 같은 UPDATE가 plan_confirmed_at + 2시간으로 한 번 다시 쓴다.
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '2 hours'),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,approval_id),
  FOREIGN KEY (workspace_id,agent_member_id) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,requester_member_id) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,subject_member_id) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,approval_id) REFERENCES approval(workspace_id,id),
  -- 검수 L3: BYPASSRLS 쓰기에서 다른 워크스페이스·다른 에이전트·다른 대화의 run을 가리키는 행을 DB가 거절한다.
  -- (workspace, run, agent, channel) 한 묶음으로 가리키므로 run의 에이전트·채널과 다른 값은 들어올 수 없다.
  FOREIGN KEY (workspace_id,run_id,agent_member_id,channel_id) REFERENCES agent_run(workspace_id,id,agent_member_id,channel_id),
  FOREIGN KEY (workspace_id,channel_id) REFERENCES channel(workspace_id,id),
  CHECK (state = 'expired' OR ((state IN ('proposed','decided')) = (approval_id IS NOT NULL))),
  -- #4900의 「만료된 행에 에이전트가 쓴 글은 남지 않는다」를 머리에도: 끝 길이 prompt를 비우지 않으면 UPDATE 자체가 실패한다.
  CHECK (state <> 'expired' OR prompt IS NULL)
);
-- 「에이전트마다 미결정 세트 1개」를 DB가 쥔다(L8-1). 앱 코드가 틀려도 지켜진다.
CREATE UNIQUE INDEX expression_set_one_undecided ON expression_set(workspace_id,agent_member_id) WHERE state IN ('staging','proposed');
-- proposed는 승인의 끝이 옮기므로 보관 TTL의 대상이 아니다(L8-3, A29).
CREATE INDEX expression_set_ttl_idx ON expression_set(workspace_id,expires_at) WHERE state = 'staging';

CREATE TABLE expression_set_slot (
  workspace_id uuid NOT NULL,
  set_id uuid NOT NULL,
  slot_index integer NOT NULL CHECK (slot_index BETWEEN 0 AND 39),
  kind text NOT NULL CHECK (kind IN ('still','gif')),
  name text NOT NULL CHECK (name ~ '^[a-z0-9_-]{2,30}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40 AND display_name !~ '[[:cntrl:]@<>\[\]`\\]'),
  tags jsonb NOT NULL CHECK (expression_tags_valid(tags) AND jsonb_array_length(tags) <= 5),
  -- 정지 칸의 장면 글: 계획 열, 끝 길에서 NULL
  scene text CHECK (scene IS NULL OR char_length(scene) BETWEEN 1 AND 300),
  -- GIF 칸의 바탕 정지 칸과 움직임: 계획 열
  base_index integer,
  motion text CHECK (motion IN ('bounce','wobble','pulse','sparkle')),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','ready','gray')),
  code text CHECK (code IN ('refused','failed','not_made','base_missing')),
  PRIMARY KEY (workspace_id,set_id,slot_index),
  UNIQUE (workspace_id,set_id,name),
  FOREIGN KEY (workspace_id,set_id) REFERENCES expression_set(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,set_id,base_index) REFERENCES expression_set_slot(workspace_id,set_id,slot_index),
  CHECK ((state = 'gray') = (code IS NOT NULL)),
  CHECK ((kind = 'gif') = (motion IS NOT NULL)),
  CHECK ((kind = 'gif') = (base_index IS NOT NULL)),
  CHECK (kind = 'still' OR scene IS NULL),
  CHECK (base_index IS NULL OR (base_index BETWEEN 0 AND 39 AND base_index <> slot_index))
);

-- 칸별 세 렌디션. 158의 CHECK(바이트·치수·GIF/PNG 모양·sha256 = sha256(bytes))를 그대로 받는다.
-- LIKE는 외래 키와 트리거를 복사하지 않는다: 표 자체의 외래 키와 아래 트리거를 따로 만든다.
CREATE TABLE expression_set_image (
  LIKE expression_image INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  set_id uuid NOT NULL,
  slot_index integer NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,set_id,slot_index,variant),   -- 한 칸의 한 렌디션은 한 번만(L7.3-1)
  FOREIGN KEY (workspace_id,set_id,slot_index) REFERENCES expression_set_slot(workspace_id,set_id,slot_index) ON DELETE CASCADE
);
ALTER TABLE expression_set_image DROP COLUMN expression_id;

-- 멤버가 참조 그림 고지를 처음 본 때(L19.1): (워크스페이스, 멤버)당 한 행, 첫 시각은 바뀌지 않는다.
CREATE TABLE expression_set_notice (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id uuid NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,member_id),
  FOREIGN KEY (workspace_id,member_id) REFERENCES member(workspace_id,id)
);

-- 세트 초안은 기존 expression_draft 행이다(approval_id를 갖고 태어난다). 바뀌는 것은 이 CHECK 하나뿐이다.
ALTER TABLE expression_draft DROP CONSTRAINT expression_draft_candidate_index_check;
ALTER TABLE expression_draft ADD CONSTRAINT expression_draft_candidate_index_check CHECK (candidate_index BETWEEN 0 AND 39);

-- ---------------------------------------------------------------------------
-- 불변·한쪽 방향 트리거 (검수 L4). LIKE ... INCLUDING CONSTRAINTS는 트리거를 복사하지 않으므로 표마다 따로 만든다.
-- 메시지에는 글·바이트를 싣지 않는다.
-- ---------------------------------------------------------------------------

-- 머리: 태어날 때 모양을 고정하고, 그 뒤 계획 열은 바뀌지 않으며, 상태는 앞으로만 간다.
CREATE FUNCTION expression_set_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'staging' OR NEW.stored_bytes <> 0 OR NEW.approval_id IS NOT NULL
       OR NEW.plan_confirmed_at IS NOT NULL
       OR NEW.expires_at <= clock_timestamp() OR NEW.expires_at > clock_timestamp() + interval '2 hours' THEN
      RAISE EXCEPTION 'an expression set is born staging, empty and expiring within two hours' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- 정체성과 계획 열
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agent_member_id IS DISTINCT FROM OLD.agent_member_id
     OR NEW.requester_member_id IS DISTINCT FROM OLD.requester_member_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.title IS DISTINCT FROM OLD.title OR NEW.prefix IS DISTINCT FROM OLD.prefix
     OR NEW.backend IS DISTINCT FROM OLD.backend
     OR NEW.subject_member_id IS DISTINCT FROM OLD.subject_member_id
     OR NEW.reference_attachment_ids IS DISTINCT FROM OLD.reference_attachment_ids
     OR NEW.notice_shown IS DISTINCT FROM OLD.notice_shown THEN
    RAISE EXCEPTION 'expression set identity and plan are immutable' USING ERRCODE = '23514';
  END IF;
  -- prompt: 끝 길에서 NULL로 비우는 것 하나만
  IF NEW.prompt IS DISTINCT FROM OLD.prompt AND NOT (NEW.prompt IS NULL AND NEW.state = 'expired') THEN
    RAISE EXCEPTION 'expression set prompt can only be blanked when the set expires' USING ERRCODE = '23514';
  END IF;
  -- 상태는 앞으로만: staging -> proposed -> decided, 어느 쪽에서든 expired로, 되돌아오지 않는다
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'staging' AND NEW.state IN ('proposed','expired'))
    OR (OLD.state = 'proposed' AND NEW.state IN ('decided','expired'))) THEN
    RAISE EXCEPTION 'expression set state only moves forward' USING ERRCODE = '23514';
  END IF;
  -- 보관 바이트는 staging 동안만 늘고 줄지 않는다
  IF NEW.stored_bytes IS DISTINCT FROM OLD.stored_bytes
     AND NOT (OLD.state = 'staging' AND NEW.state = 'staging' AND NEW.stored_bytes > OLD.stored_bytes) THEN
    RAISE EXCEPTION 'expression set stored bytes only grow while staging' USING ERRCODE = '23514';
  END IF;
  -- approval_id: NULL에서 값으로 한 번, staging -> proposed 와 함께
  IF NEW.approval_id IS DISTINCT FROM OLD.approval_id
     AND NOT (OLD.approval_id IS NULL AND OLD.state = 'staging' AND NEW.state = 'proposed') THEN
    RAISE EXCEPTION 'expression set approval is bound once, when it is proposed' USING ERRCODE = '23514';
  END IF;
  -- plan_confirmed_at: NULL에서 값으로 한 번(staging 안에서), 그리고 같은 UPDATE가 expires_at을 정확히
  -- plan_confirmed_at + 2시간으로 다시 쓴다. 그 밖에는 expires_at이 움직이지 않는다(만료를 늘리는 길이 없다).
  IF NEW.plan_confirmed_at IS DISTINCT FROM OLD.plan_confirmed_at THEN
    IF OLD.plan_confirmed_at IS NOT NULL OR NEW.plan_confirmed_at IS NULL
       OR OLD.state <> 'staging' OR NEW.state <> 'staging'
       OR NEW.plan_confirmed_at < OLD.created_at OR NEW.plan_confirmed_at > clock_timestamp()
       OR NEW.expires_at IS DISTINCT FROM NEW.plan_confirmed_at + interval '2 hours' THEN
      RAISE EXCEPTION 'expression set plan is confirmed once, and the confirmation restarts the two hours' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'expression set expiry moves only with the plan confirmation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expression_set_head_guard BEFORE INSERT OR UPDATE ON expression_set
  FOR EACH ROW EXECUTE FUNCTION expression_set_head_guard();

-- 만료한 머리는 칸의 장면 글도 남기지 않는다. 머리와 칸은 한 tx에서 따로 UPDATE되므로 커밋 때 센다.
CREATE FUNCTION expression_set_expired_keeps_no_scene() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'expired' AND EXISTS (
       SELECT 1 FROM expression_set_slot s
        WHERE s.workspace_id = NEW.workspace_id AND s.set_id = NEW.id AND s.scene IS NOT NULL) THEN
    RAISE EXCEPTION 'an expired expression set keeps no scene text' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expression_set_expired_keeps_no_scene AFTER INSERT OR UPDATE ON expression_set
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION expression_set_expired_keeps_no_scene();

-- 칸: planned에서 시작해 ready|gray로 한 번만 바뀐다. 그림 칸은 렌디션 셋이 있어야 ready, 회색 칸은 그림이 없어야 gray.
CREATE FUNCTION expression_set_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head_state text;
  head_prefix text;
  renditions integer;
BEGIN
  SELECT h.state, h.prefix INTO head_state, head_prefix
    FROM expression_set h WHERE h.workspace_id = NEW.workspace_id AND h.id = NEW.set_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'planned' OR NEW.code IS NOT NULL THEN
      RAISE EXCEPTION 'an expression set slot starts planned' USING ERRCODE = '23514';
    END IF;
    IF head_state IS DISTINCT FROM 'staging' THEN
      RAISE EXCEPTION 'an expression set slot is planned only while the set is staging' USING ERRCODE = '23514';
    END IF;
    -- L9: 이름은 <앞머리>_<나머지>이고 나머지는 1자 이상이다
    IF left(NEW.name, char_length(head_prefix) + 1) <> head_prefix || '_' OR char_length(NEW.name) <= char_length(head_prefix) + 1 THEN
      RAISE EXCEPTION 'an expression set slot name starts with the set prefix and an underscore' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- 계획 열은 바뀌지 않는다. 장면 글은 NULL로 비우는 것만 허용한다(끝 길).
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.set_id IS DISTINCT FROM OLD.set_id
     OR NEW.slot_index IS DISTINCT FROM OLD.slot_index OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.name IS DISTINCT FROM OLD.name OR NEW.display_name IS DISTINCT FROM OLD.display_name
     OR NEW.tags IS DISTINCT FROM OLD.tags OR NEW.base_index IS DISTINCT FROM OLD.base_index
     OR NEW.motion IS DISTINCT FROM OLD.motion THEN
    RAISE EXCEPTION 'expression set slot plan is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.scene IS DISTINCT FROM OLD.scene AND NEW.scene IS NOT NULL THEN
    RAISE EXCEPTION 'expression set slot scene can only be blanked' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.code IS DISTINCT FROM OLD.code THEN
    IF OLD.state <> 'planned' THEN
      RAISE EXCEPTION 'an expression set slot is written once' USING ERRCODE = '23514';
    END IF;
    IF head_state IS DISTINCT FROM 'staging' THEN
      RAISE EXCEPTION 'an expression set slot closes only while the set is staging' USING ERRCODE = '23514';
    END IF;
    SELECT count(DISTINCT i.variant) INTO renditions FROM expression_set_image i
     WHERE i.workspace_id = NEW.workspace_id AND i.set_id = NEW.set_id AND i.slot_index = NEW.slot_index;
    IF NEW.state = 'ready' AND renditions <> 3 THEN
      RAISE EXCEPTION 'a ready expression set slot holds all three renditions' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'gray' AND renditions <> 0 THEN
      RAISE EXCEPTION 'a gray expression set slot holds no pixels' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expression_set_slot_guard BEFORE INSERT OR UPDATE ON expression_set_slot
  FOR EACH ROW EXECUTE FUNCTION expression_set_slot_guard();

-- 렌디션: 픽셀은 바뀌지 않는다. 쓰기는 planned 칸, staging 머리, 만료 전에만 들어온다.
CREATE FUNCTION expression_set_image_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  slot_state text;
  head_state text;
  head_expires timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'expression set pixels are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT s.state, h.state, h.expires_at INTO slot_state, head_state, head_expires
    FROM expression_set_slot s
    JOIN expression_set h ON h.workspace_id = s.workspace_id AND h.id = s.set_id
   WHERE s.workspace_id = NEW.workspace_id AND s.set_id = NEW.set_id AND s.slot_index = NEW.slot_index;
  IF slot_state IS DISTINCT FROM 'planned' OR head_state IS DISTINCT FROM 'staging' OR head_expires <= clock_timestamp() THEN
    RAISE EXCEPTION 'expression set pixels are written only to a planned slot of a live staging set' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expression_set_image_guard BEFORE INSERT OR UPDATE ON expression_set_image
  FOR EACH ROW EXECUTE FUNCTION expression_set_image_guard();

-- 고지 기록: 첫 시각이 남는다. 어떤 UPDATE도 없다.
CREATE FUNCTION expression_set_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the first time a member saw the notice is kept' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER expression_set_notice_guard BEFORE UPDATE ON expression_set_notice
  FOR EACH ROW EXECUTE FUNCTION expression_set_notice_guard();

-- 신규 테넌트 표: ENABLE + FORCE + ws_isolation (USING·WITH CHECK 모두 app.workspace_id).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['expression_set','expression_set_slot','expression_set_image','expression_set_notice'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY ws_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true)::uuid)',t);
  END LOOP;
END $$;

-- BEGIN expression-set-lockdown (#5459 S1a; ADR-0218 증보 6 §12 L10.1, threat T20). Identical in
-- 177_expression_set.sql, bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text
-- between the markers. The set tables hold what the team AI planned and made before any person approved
-- it (a prompt, scene text, up to 24 MiB of pictures per set), the writer is the BYPASSRLS momo_worker, and
-- every BYPASSRLS role skips RLS, so their table privileges are what keeps a forged or foreign row away
-- from a role with no business writing one. Each runtime role gets exactly what the code does:
-- momo_worker stages (INSERT), closes slots and heads (UPDATE) and takes pixels back (DELETE on the images);
-- momo_app decides and reclaims (moves the head, blanks the scene text, deletes the pixels) and records
-- the first notice a member saw; momo_notifier only discovers which tenants hold an expired staging set,
-- through three columns and never the prompt; nobody deletes a head, a slot or a notice (a foreign-key
-- cascade from the workspace runs as the table's owner, so deleting a parent still clears its rows) and
-- nobody changes a pixel or a notice. relay, platform_admin and the helper's read role do not touch the
-- tables at all. Idempotent and order-proof (a pass before the tables or the roles exist finishes what it
-- can, the pass after lands the rest), and it fails loudly if the result is not what is written here.
DO $$
DECLARE
  t text;
  r text;
  p text;
  c text;
  allowed text[];
  want boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['expression_set', 'expression_set_slot', 'expression_set_image', 'expression_set_notice'] LOOP
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin', 'momo_helper_read'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      allowed := CASE t || '/' || r
        WHEN 'expression_set/momo_worker' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']
        WHEN 'expression_set/momo_app' THEN ARRAY['SELECT', 'UPDATE']
        WHEN 'expression_set_slot/momo_worker' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']
        WHEN 'expression_set_slot/momo_app' THEN ARRAY['SELECT', 'UPDATE']
        WHEN 'expression_set_image/momo_worker' THEN ARRAY['SELECT', 'INSERT', 'DELETE']
        WHEN 'expression_set_image/momo_app' THEN ARRAY['SELECT', 'DELETE']
        WHEN 'expression_set_notice/momo_worker' THEN ARRAY['SELECT']
        WHEN 'expression_set_notice/momo_app' THEN ARRAY['SELECT', 'INSERT']
        ELSE ARRAY[]::text[]
      END;
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      IF cardinality(allowed) > 0 THEN
        EXECUTE format('GRANT %s ON TABLE public.%I TO %I', array_to_string(allowed, ', '), t, r);
      END IF;
    END LOOP;
  END LOOP;
  -- the one cross-tenant read: the TTL sweep finds the tenants whose staging set is due (workspace ids only)
  IF to_regclass('public.expression_set') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    GRANT SELECT (workspace_id, state, expires_at) ON expression_set TO momo_notifier;
  END IF;
  FOREACH t IN ARRAY ARRAY['expression_set', 'expression_set_slot', 'expression_set_image', 'expression_set_notice'] LOOP
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin', 'momo_helper_read'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      allowed := CASE t || '/' || r
        WHEN 'expression_set/momo_worker' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']
        WHEN 'expression_set/momo_app' THEN ARRAY['SELECT', 'UPDATE']
        WHEN 'expression_set_slot/momo_worker' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']
        WHEN 'expression_set_slot/momo_app' THEN ARRAY['SELECT', 'UPDATE']
        WHEN 'expression_set_image/momo_worker' THEN ARRAY['SELECT', 'INSERT', 'DELETE']
        WHEN 'expression_set_image/momo_app' THEN ARRAY['SELECT', 'DELETE']
        WHEN 'expression_set_notice/momo_worker' THEN ARRAY['SELECT']
        WHEN 'expression_set_notice/momo_app' THEN ARRAY['SELECT', 'INSERT']
        ELSE ARRAY[]::text[]
      END;
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, format('public.%I', t), p) IS DISTINCT FROM (p = ANY (allowed)) THEN
          RAISE EXCEPTION 'role % must % % on %',
            r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p, t;
        END IF;
      END LOOP;
      FOR c IN SELECT a.attname::text FROM pg_attribute a
                WHERE a.attrelid = format('public.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped LOOP
        FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
          want := p = ANY (allowed)
                  OR (p = 'SELECT' AND t = 'expression_set' AND r = 'momo_notifier'
                      AND c IN ('workspace_id', 'state', 'expires_at'));
          IF has_column_privilege(r, format('public.%I', t), c, p) IS DISTINCT FROM want THEN
            RAISE EXCEPTION 'role % must % % on %.%',
              r, CASE WHEN want THEN 'hold' ELSE 'not hold' END, p, t, c;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
-- END expression-set-lockdown
