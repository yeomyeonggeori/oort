-- =============================================================================
-- 192_expression_agent_grant.sql — #6069 (ADR-0218 증보 13 §19, ADR-0186 v9)
--
-- 왜
--   사람(워크스페이스 관리자)이 한 번 승인한 에이전트는, 그 뒤 스스로 만든 이모티콘을 건마다 묻지 않고 팀 보관함에
--   등록할 수 있다(§19 Y1). 그 「한 번의 승인」과 「등록 시도의 기록」을 둘 곳이 필요하다.
--
-- 무엇
--   expression_agent_grant  에이전트마다 사람의 승인 한 건(Y2.1). 승인한 사람 · 승인 때의 연결 id · 자리(설정/카드)
--                           · 거둔 사람 · 거둔 시각. 한 에이전트에 살아 있는(거두지 않은) 행은 하나다(부분 유니크).
--                           거둔 행은 지우지 않는다 — 다시 허용은 새 행이다.
--   expression_agent_call   승인 기록을 지난 등록 호출마다 한 행(Y2.3): 에이전트 안에서 유일한 clientRequestId,
--                           디코더까지 갔는지, 결과(대기/등록됨/거절)와 닫힌 사유, 등록된 표현 id. 바이트 · 이름 ·
--                           prompt · 꼬리표는 싣지 않는다. 재호출의 답 · 하루 개수 · 하루 시도 · 30일 누적을 모두
--                           여기서 센다(감사 줄은 시간당 합쳐지므로 세는 데 쓰지 않는다). 45일 뒤 api가 지운다.
--   expression.grant_id     카드 없이 등록된 줄의 근거(Y2.5). INSERT 뒤 불변(158의 identity 트리거가 이 열도 덮는다),
--                           approval_id와 함께 채워지지 않고, 채워지면 proposed_by(에이전트)가 있다.
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 승인 행을 쓰는 사람은 그 워크스페이스의 활성 사람 멤버이고 관리자(owner · admin)다. 대상은 에이전트 멤버다
--     (Y2.1 「누가 승인하나」, Y4-2 「승인은 사람만」). 거두는 사람은 사람 멤버다.
--   * 승인 행은 거두기(revoked_by · revoked_at 이 NULL → 값) 하나만 고칠 수 있다. 되살리거나 다른 열을 바꾸지 못한다.
--   * 호출 행은 대기 → 등록됨/거절 한 번만 바뀐다. 결과가 선 행은 불변이다.
--
-- 외래 키
--   expression_agent_grant 는 member · workspace 를 가리킨다(멤버 행은 지워지지 않는다). expression_agent_call 은
--   셈의 원본이라 어느 방향으로도 외래 키를 두지 않는다(189 · 179 와 같은 까닭 — 연쇄는 표 주인 권한으로 돈다).
--   expression.grant_id 는 승인 행을 가리킨다(승인 행은 지워지지 않는다).
--
-- RLS
--   158 · 189 와 같은 방식: ENABLE + FORCE + ws_isolation. 모든 읽기 · 쓰기는 비우회 역할 momo_app 이 그 워크스페이스로
--   묶은 tx 에서 한다.
--
-- 표 권한
--   아래 expression-agent-grant-lockdown 블록: momo_app = 승인 표 SELECT · INSERT · UPDATE(지우기 없음), 호출 표
--   SELECT · INSERT · UPDATE · DELETE. 그 밖의 모든 역할(워커 · relay · notifier · platform_admin, 워커가 SET ROLE 할
--   수 있는 helper 읽기 역할과 momo_memory)은 아무것도 없다 — 워커 · 에이전트 경로의 역할이 승인 행을 쓰지 못한다
--   (Y2.1 「쓰기 권한은 사람 세션이 쓰는 역할에만」). 블록은 이 파일 · bootstrap_roles.sql ·
--   bootstrap_runtime_roles.sql 에 같은 글자로 둔다(두 bootstrap 파일은 마이그레이션 뒤에 ALL TABLES 권한을 다시
--   주므로, 이 파일에서만 거두면 다음 bootstrap 이 되돌린다).
--
-- schema_v0.sql 은 건드리지 않는다. 158 은 고치지 않는다(열 하나와 CHECK 둘을 더할 뿐이다).
-- =============================================================================

CREATE TABLE expression_agent_grant (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT uuidv7(),
  agent_member_id uuid NOT NULL,
  granted_by      uuid NOT NULL,
  granted_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  connection_id   uuid NOT NULL,
  granted_via     text NOT NULL CHECK (granted_via IN ('settings', 'card')),
  revoked_by      uuid,
  revoked_at      timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_member_id) REFERENCES member(workspace_id, id),
  FOREIGN KEY (workspace_id, granted_by) REFERENCES member(workspace_id, id),
  FOREIGN KEY (workspace_id, revoked_by) REFERENCES member(workspace_id, id),
  CONSTRAINT expression_agent_grant_revoked_ck CHECK ((revoked_by IS NULL) = (revoked_at IS NULL)),
  CONSTRAINT expression_agent_grant_order_ck CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

COMMENT ON TABLE expression_agent_grant IS
  '#6069 (ADR-0218 §19 Y2.1): one person''s standing approval for one agent to register its own team expressions without a card. Written only by an active human administrator (trigger), revoked never deleted, one live row per agent. momo_app alone holds privileges on it.';

-- 한 에이전트에 살아 있는 승인은 하나.
CREATE UNIQUE INDEX expression_agent_grant_live_uq ON expression_agent_grant (workspace_id, agent_member_id)
  WHERE revoked_at IS NULL;

CREATE TABLE expression_agent_call (
  workspace_id      uuid NOT NULL,
  id                uuid NOT NULL DEFAULT uuidv7(),
  agent_member_id   uuid NOT NULL,
  grant_id          uuid NOT NULL,
  client_request_id uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  decoded           boolean NOT NULL DEFAULT false,
  outcome           text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'registered', 'refused')),
  reason            text CHECK (reason IN ('daily_cap', 'attempt_cap', 'period_cap', 'store_cap', 'invalid_arguments',
                                           'media_invalid', 'name_reserved', 'quota', 'not_allowed')),
  expression_id     uuid,
  settled_at        timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT expression_agent_call_request_uq UNIQUE (workspace_id, agent_member_id, client_request_id),
  CONSTRAINT expression_agent_call_registered_ck CHECK ((outcome = 'registered') = (expression_id IS NOT NULL)),
  CONSTRAINT expression_agent_call_refused_ck CHECK ((outcome = 'refused') = (reason IS NOT NULL)),
  CONSTRAINT expression_agent_call_settled_ck CHECK ((outcome = 'pending') = (settled_at IS NULL))
);

COMMENT ON TABLE expression_agent_call IS
  '#6069 (ADR-0218 §19 Y2.3): one row per register call that passed the grant — the source of the idempotent replay and of the daily, attempt and 30-day counts. No bytes, name, prompt or tag. No foreign key in either direction on purpose. Swept by the api after 45 days. momo_app alone holds privileges on it.';

CREATE INDEX expression_agent_call_agent_idx ON expression_agent_call (workspace_id, agent_member_id, created_at);

-- 승인 행: 활성 사람 관리자만 쓰고(대상은 에이전트), 거두기 하나만 고칠 수 있다.
CREATE FUNCTION expression_agent_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM member m JOIN workspace_membership wm ON (wm.workspace_id, wm.member_id) = (m.workspace_id, m.id)
                       WHERE m.workspace_id = NEW.workspace_id AND m.id = NEW.granted_by AND m.kind = 'human'
                         AND m.status = 'active' AND m.deleted_at IS NULL AND wm.role IN ('owner', 'admin'))
       OR NOT EXISTS (SELECT 1 FROM member m WHERE m.workspace_id = NEW.workspace_id AND m.id = NEW.agent_member_id
                         AND m.kind = 'agent') THEN
      RAISE EXCEPTION 'an expression grant is given by an active human administrator to an agent' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['revoked_by', 'revoked_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_by', 'revoked_at'])
     OR NOT EXISTS (SELECT 1 FROM member m WHERE m.workspace_id = NEW.workspace_id AND m.id = NEW.revoked_by AND m.kind = 'human') THEN
    RAISE EXCEPTION 'an expression grant is revoked once by a person and is otherwise immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expression_agent_grant_guard BEFORE INSERT OR UPDATE ON expression_agent_grant
  FOR EACH ROW EXECUTE FUNCTION expression_agent_grant_guard();

-- 호출 행: 대기 → 등록됨/거절 한 번. 그때 바뀌는 열은 결과 · 사유 · 표현 id · 끝난 시각뿐이다.
CREATE FUNCTION expression_agent_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.outcome <> 'pending' OR NEW.outcome = 'pending'
     OR (to_jsonb(NEW) - ARRAY['outcome', 'reason', 'expression_id', 'settled_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['outcome', 'reason', 'expression_id', 'settled_at']) THEN
    RAISE EXCEPTION 'an expression agent call settles once and is otherwise immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expression_agent_call_guard BEFORE UPDATE ON expression_agent_call
  FOR EACH ROW EXECUTE FUNCTION expression_agent_call_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['expression_agent_grant', 'expression_agent_call'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY ws_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true)::uuid)', t);
  END LOOP;
END $$;

-- 카드 없이 등록된 줄의 근거. 158 의 expression_immutable 트리거는 to_jsonb 전체를 견주므로 이 열도 INSERT 뒤 불변이다.
ALTER TABLE expression ADD COLUMN grant_id uuid;
ALTER TABLE expression ADD CONSTRAINT expression_grant_fk
  FOREIGN KEY (workspace_id, grant_id) REFERENCES expression_agent_grant(workspace_id, id);
ALTER TABLE expression ADD CONSTRAINT expression_grant_shape_ck
  CHECK (grant_id IS NULL OR (approval_id IS NULL AND proposed_by IS NOT NULL));
-- 에이전트당 · 워크스페이스 합계 보관 상한(Y3)을 세는 자리.
CREATE INDEX expression_self_registered_idx ON expression (workspace_id, proposed_by)
  WHERE grant_id IS NOT NULL;

-- BEGIN expression-agent-grant-lockdown (#6069; ADR-0218 증보 13 §19 Y2.1 · Y2.3). Identical in
-- 192_expression_agent_grant.sql, bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text between
-- the markers. A row of expression_agent_grant lets one agent register team expressions nobody looks at first, and
-- expression_agent_call is the source of that agent's daily, attempt and 30-day counts, and the BYPASSRLS roles skip
-- RLS, so their table privileges are what keeps a forged, widened or deleted row away from a role with no business
-- touching one. Only the api uses these tables, on a person's session (grant, revoke, read) and on the Agent Port
-- register tool (count, record): momo_app reads and writes grants (SELECT, INSERT, UPDATE — a revoked grant is kept,
-- never deleted) and calls (SELECT, INSERT, UPDATE, DELETE — the 45-day sweep). Nobody else holds anything — not the
-- worker, relay, notifier, platform_admin, nor the two roles the worker may SET ROLE to (the helper's read role and
-- momo_memory; named because a membership granted WITH INHERIT FALSE is invisible to has_table_privilege). Idempotent
-- and order-proof (a pass before the tables or the roles exist finishes what it can, the pass after lands the rest),
-- and it fails loudly if the result is not what is written here.
DO $$
DECLARE
  t text;
  r text;
  p text;
  allowed text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['expression_agent_grant', 'expression_agent_call'] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin', 'momo_helper_read', 'momo_memory'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      allowed := CASE
        WHEN r = 'momo_app' AND t = 'expression_agent_grant' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']
        WHEN r = 'momo_app' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
        ELSE ARRAY[]::text[]
      END;
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      IF cardinality(allowed) > 0 THEN
        EXECUTE format('GRANT %s ON TABLE public.%I TO %I', array_to_string(allowed, ', '), t, r);
      END IF;
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, 'public.' || t, p) IS DISTINCT FROM (p = ANY (allowed)) THEN
          RAISE EXCEPTION 'role % must % % on %',
            r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
-- END expression-agent-grant-lockdown
