-- =============================================================================
-- 145_scheduled_message.sql — #4214 / ADR-0208 예약 메시지
--
-- 보내는 사람의 기기가 꺼져 있어도 서버가 정시에 보낸다. 이 파일이 만드는 것:
--   * scheduled_message            한 행 = 한 사람의 예약. 작성자 범위 RLS(워크스페이스 + 작성자).
--   * scheduled_message_attachment 예약이 점유한 첨부(attachment_id UNIQUE 가 이중 점유를 막는다).
--   * momo_sched_definer           NOLOGIN NOSUPERUSER NOBYPASSRLS. 만기 목록 함수의 소유자.
--                                  열 단위 SELECT(body·channel_id·root_id 없음) + SELECT 전용 정책만 가진다.
--   * momo_schedule_private.due_scheduled_messages / expired_scheduled_messages
--                                  SECURITY DEFINER. (워크스페이스, 예약, 작성자) id 세 개만 돌려준다(D6).
--   * scheduled-message-lockdown   relay·worker·notifier·platform_admin 의 두 표 권한 회수 + 함수 EXECUTE 재부여
--                                  + 자기 점검. bootstrap_roles.sql·bootstrap_runtime_roles.sql 에도 같은 텍스트.
--
-- ── 정책은 082 와 한 곳이 다르다 ───────────────────────────────────────────────
-- 082 의 워크스페이스 항은 `current_setting('app.workspace_id', true)::uuid` 라서, 테넌트 tx 를 한 번 돈
-- 풀 연결(GUC 자리표시가 '' 로 남는다)에서 `''::uuid` 가 22P02 를 낸다. PG 는 허용 정책을 모두 평가하므로
-- 이 정책은 정의자 함수의 읽기에서도 평가된다. 그래서 두 항 모두 NULLIF 로 읽는다(142·100 이 같은 문제를
-- 같은 방법으로 고쳤다). 격리는 그대로이고 「GUC 없음」이 오류 대신 0행이 된다.
--
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
-- 전제: 이 마이그레이션은 역할을 만들고 함수 소유자를 바꿀 수 있는 권한(슈퍼유저)으로 돈다.
-- =============================================================================

CREATE TABLE scheduled_message (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id        uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  author_member_id  uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  root_id           uuid REFERENCES message(id) ON DELETE CASCADE,
  -- 첨부만 있는 예약은 빈 문자열이다. 끝난 행(sent·cancelled)은 본문을 지운다(D14).
  body              text,
  send_at           timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  failure_reason    text,
  -- 시도 횟수. 올리는 곳은 스케줄러의 판정 tx 하나뿐이다(D7).
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz,
  sent_message_id   uuid,
  sent_at           timestamptz,
  client_request_id uuid NOT NULL,
  -- 내용을 마지막으로 쓴 세션 계열(token.session_id). 생성·본문 변경·다시 걸기 때마다 갱신하고
  -- 시각만 바꾸는 수정은 옮기지 않는다(D14). 기기 해제·refresh 재사용이 이 계열의 예약을 멈춘다.
  armed_session_id  uuid,
  rev               integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_message_status_ck
    CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  CONSTRAINT scheduled_message_reason_ck
    CHECK (failure_reason IS NULL OR failure_reason IN (
      'sessions_ended', 'author_inactive', 'missed', 'send_error',
      'not_member', 'root_unavailable', 'attachment_unavailable', 'not_allowed')),
  CONSTRAINT scheduled_message_attempts_ck CHECK (attempts >= 0),
  CONSTRAINT scheduled_message_rev_ck CHECK (rev >= 0),
  -- 네 상태의 모양. 보낸·취소한 행은 본문이 없고, 대기·실패 행은 본문이 있다.
  CONSTRAINT scheduled_message_shape_ck CHECK (
    (status = 'pending'   AND body IS NOT NULL AND failure_reason IS NULL
                          AND sent_message_id IS NULL AND sent_at IS NULL)
    OR (status = 'failed' AND body IS NOT NULL AND failure_reason IS NOT NULL
                          AND sent_message_id IS NULL AND sent_at IS NULL AND next_attempt_at IS NULL)
    OR (status = 'sent'   AND body IS NULL AND failure_reason IS NULL
                          AND sent_message_id IS NOT NULL AND sent_at IS NOT NULL AND next_attempt_at IS NULL)
    OR (status = 'cancelled' AND body IS NULL AND failure_reason IS NULL
                          AND sent_message_id IS NULL AND sent_at IS NULL AND next_attempt_at IS NULL)
  ),
  -- 생성 재시도 멱등.
  CONSTRAINT scheduled_message_request_uq UNIQUE (workspace_id, author_member_id, client_request_id),
  -- 자식 표의 복합 FK 가 가리키는 짝.
  CONSTRAINT scheduled_message_owner_uq UNIQUE (id, workspace_id, author_member_id)
);

-- 만기 스캔: 전 테넌트 스캔이라 워크스페이스가 앞에 서지 않는다. 함수는 기한 지난 행만 읽어 워크스페이스·
-- 시각으로 정렬한다(워크스페이스를 앞세운 인덱스를 더해도 플래너가 쓰지 않았다, ADR 「설계 실측」).
CREATE INDEX scheduled_message_due_idx
  ON scheduled_message (send_at, id) WHERE status = 'pending';
-- 보존 정리 스캔.
CREATE INDEX scheduled_message_purge_idx
  ON scheduled_message (updated_at) WHERE status <> 'pending';
-- 목록·상한 계산·자격 회수(작성자의 대기·실패 행).
CREATE INDEX scheduled_message_owner_idx
  ON scheduled_message (workspace_id, author_member_id, status, send_at);

COMMENT ON TABLE scheduled_message IS
  'ADR-0208 scheduled message. Owner-scoped (workspace + author) FORCE RLS; the body is readable by its author only and is erased once the row is sent or cancelled.';
COMMENT ON COLUMN scheduled_message.armed_session_id IS
  'token.session_id of the sign-in that last wrote the content (create, body change, re-arm). Device unlink and refresh reuse hold the schedules of that lineage.';
COMMENT ON COLUMN scheduled_message.attempts IS
  'Raised only by the scheduler''s decision transaction, once per attempt (ADR-0208 D7).';

-- 예약이 점유한 첨부. 첨부 1건당 1행, 한 첨부는 한 예약만 쥔다.
CREATE TABLE scheduled_message_attachment (
  scheduled_message_id uuid NOT NULL,
  workspace_id         uuid NOT NULL,
  member_id            uuid NOT NULL,
  attachment_id        uuid NOT NULL REFERENCES attachment(id) ON DELETE CASCADE,
  position             integer NOT NULL,
  PRIMARY KEY (scheduled_message_id, position),
  CONSTRAINT scheduled_message_attachment_position_ck CHECK (position BETWEEN 0 AND 19),
  CONSTRAINT scheduled_message_attachment_uq UNIQUE (attachment_id),
  -- 부모와 같은 워크스페이스·같은 작성자임을 DB 가 보장한다.
  CONSTRAINT scheduled_message_attachment_owner_fk
    FOREIGN KEY (scheduled_message_id, workspace_id, member_id)
    REFERENCES scheduled_message (id, workspace_id, author_member_id) ON DELETE CASCADE
);

COMMENT ON TABLE scheduled_message_attachment IS
  'ADR-0208 D11: the attachments a scheduled message holds. attachment_id UNIQUE is the reservation; rows are deleted when the schedule is sent or cancelled.';

ALTER TABLE scheduled_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_message FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_message_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_message_attachment FORCE ROW LEVEL SECURITY;

CREATE POLICY scheduled_message_author ON scheduled_message
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND author_member_id = NULLIF(current_setting('app.member_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND author_member_id = NULLIF(current_setting('app.member_id', true), '')::uuid
  );

CREATE POLICY scheduled_message_attachment_author ON scheduled_message_attachment
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND member_id = NULLIF(current_setting('app.member_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND member_id = NULLIF(current_setting('app.member_id', true), '')::uuid
  );

-- ── 정의자 역할(D6) ─────────────────────────────────────────────────────────────
-- 슈퍼유저가 아니라 최소 권한 역할이 함수를 소유한다. 이 역할이 읽을 수 있는 것은 열 단위로 정해 둔
-- 일곱 칸과, 아래 SELECT 전용 정책이 보여 주는 행(기한이 된 대기 예약 또는 정리 대상인 끝난 행)뿐이다.
-- 함수가 나중에 잘못 고쳐져도 본문에 닿지 못하고, 기한이 안 된 예약과 최근 행은 정책에서 보이지 않는다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_sched_definer') THEN
    CREATE ROLE momo_sched_definer NOLOGIN;
  END IF;
  ALTER ROLE momo_sched_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
END $$;

GRANT USAGE ON SCHEMA public TO momo_sched_definer;
GRANT SELECT (id, workspace_id, author_member_id, status, send_at, next_attempt_at, updated_at)
  ON scheduled_message TO momo_sched_definer;

CREATE POLICY scheduled_message_sched_definer ON scheduled_message
  FOR SELECT TO momo_sched_definer
  USING (
    (status = 'pending' AND send_at <= now()
       AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
    OR (status IN ('sent', 'cancelled') AND updated_at < now() - interval '7 days')
    OR (status = 'failed' AND updated_at < now() - interval '30 days')
  );

-- ── 함수 둘(D6) ─────────────────────────────────────────────────────────────────
-- 정확한 생성이 의도다: 이미 있는 스키마·함수는 신뢰 경계가 어긋난 것이므로 채택하지 않고 abort 한다(009).
CREATE SCHEMA momo_schedule_private;
REVOKE ALL ON SCHEMA momo_schedule_private FROM PUBLIC;

-- 기한이 된 대기 예약. 워크스페이스마다 25건까지만 `send_at, id` 순으로 고르고 워크스페이스를 번갈아
-- 돌려준다(전역 ORDER BY send_at LIMIT 이면 한 테넌트의 백로그가 배치를 다 채워 다른 테넌트가 굶는다).
CREATE FUNCTION momo_schedule_private.due_scheduled_messages(p_limit integer)
RETURNS TABLE (workspace_id uuid, scheduled_message_id uuid, author_member_id uuid)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT d.workspace_id, d.id, d.author_member_id
    FROM (
      SELECT s.workspace_id, s.id, s.author_member_id, s.send_at,
             row_number() OVER (PARTITION BY s.workspace_id ORDER BY s.send_at, s.id) AS rn
        FROM public.scheduled_message AS s
       WHERE s.status = 'pending'
         AND s.send_at <= now()
         AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())
    ) AS d
   WHERE d.rn <= 25
   ORDER BY d.rn, d.send_at, d.id
   LIMIT least(greatest(p_limit, 1), 200);
$$;

-- 보존 기간이 지난 행: 보낸·취소한 것 7일, 실패한 것 30일.
CREATE FUNCTION momo_schedule_private.expired_scheduled_messages(p_limit integer)
RETURNS TABLE (workspace_id uuid, scheduled_message_id uuid, author_member_id uuid)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT s.workspace_id, s.id, s.author_member_id
    FROM public.scheduled_message AS s
   WHERE (s.status IN ('sent', 'cancelled') AND s.updated_at < now() - interval '7 days')
      OR (s.status = 'failed' AND s.updated_at < now() - interval '30 days')
   ORDER BY s.updated_at, s.id
   LIMIT least(greatest(p_limit, 1), 200);
$$;

COMMENT ON FUNCTION momo_schedule_private.due_scheduled_messages(integer) IS
  'Scheduler tick only: the due pending schedules as (workspace, schedule, author) ids, at most 25 per workspace, workspaces interleaved. No body, channel or root.';
COMMENT ON FUNCTION momo_schedule_private.expired_scheduled_messages(integer) IS
  'Scheduler tick only: rows past retention (sent/cancelled 7 days, failed 30 days) as ids.';

-- 함수 소유자 변경은 새 소유자의 스키마 CREATE 권한을 요구한다. 바로 회수한다(100_mem_digest.sql 와 같은 절차).
GRANT CREATE ON SCHEMA momo_schedule_private TO momo_sched_definer;
ALTER FUNCTION momo_schedule_private.due_scheduled_messages(integer) OWNER TO momo_sched_definer;
ALTER FUNCTION momo_schedule_private.expired_scheduled_messages(integer) OWNER TO momo_sched_definer;
REVOKE CREATE ON SCHEMA momo_schedule_private FROM momo_sched_definer;

REVOKE ALL ON FUNCTION momo_schedule_private.due_scheduled_messages(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION momo_schedule_private.expired_scheduled_messages(integer) FROM PUBLIC;

-- BEGIN scheduled-message-lockdown (#4214; ADR-0208 D3·D6). Identical in 145_scheduled_message.sql,
-- bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text between the markers.
-- Idempotent and order-proof: a pass before the migration (no tables, no functions) or before the runtime
-- roles exist finishes what it can; the pass after lands the rest. The BYPASSRLS roles skip RLS, so their
-- table privileges are what keeps a pending body away from them. momo_app keeps all four (the tick and the
-- retention sweep DELETE as momo_app). Then the self-check fails loudly: without it the tick would read
-- nothing and report nothing.
DO $$
DECLARE
  t text;
  r text;
  f text;
  sealed text[] := ARRAY['momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
BEGIN
  FOREACH t IN ARRAY ARRAY['scheduled_message', 'scheduled_message_attachment'] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM momo_app', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO momo_app', t);
    END IF;
  END LOOP;
  IF to_regnamespace('momo_schedule_private') IS NOT NULL THEN
    REVOKE ALL ON SCHEMA momo_schedule_private FROM PUBLIC;
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      EXECUTE format('REVOKE ALL ON SCHEMA momo_schedule_private FROM %I', r);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      GRANT USAGE ON SCHEMA momo_schedule_private TO momo_app;
    END IF;
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'momo_schedule_private.due_scheduled_messages(integer)',
    'momo_schedule_private.expired_scheduled_messages(integer)'
  ] LOOP
    CONTINUE WHEN to_regprocedure(f) IS NULL;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO momo_app', f);
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  t text;
  r text;
  f text;
  p text;
  sealed text[] := ARRAY['momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
BEGIN
  FOREACH t IN ARRAY ARRAY['scheduled_message', 'scheduled_message_attachment'] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, format('public.%I', t), p) THEN
          RAISE EXCEPTION 'role % must hold no % on %', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF NOT has_table_privilege('momo_app', format('public.%I', t), p) THEN
          RAISE EXCEPTION 'momo_app must hold % on %', p, t;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF to_regnamespace('momo_schedule_private') IS NOT NULL THEN
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      IF has_schema_privilege(r, 'momo_schedule_private', 'USAGE') THEN
        RAISE EXCEPTION 'role % must not use schema momo_schedule_private', r;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app')
       AND NOT has_schema_privilege('momo_app', 'momo_schedule_private', 'USAGE') THEN
      RAISE EXCEPTION 'momo_app must use schema momo_schedule_private';
    END IF;
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'momo_schedule_private.due_scheduled_messages(integer)',
    'momo_schedule_private.expired_scheduled_messages(integer)'
  ] LOOP
    CONTINUE WHEN to_regprocedure(f) IS NULL;
    IF has_function_privilege('public', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC must not execute %', f;
    END IF;
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION 'role % must not execute %', r, f;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app')
       AND NOT has_function_privilege('momo_app', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'momo_app must execute %', f;
    END IF;
    -- 소유자 posture: 최소 권한 정의자 역할, 본문 열 권한 없음, 어느 런타임 역할의 멤버도 아님.
    IF NOT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
          WHERE p.oid = to_regprocedure(f)
            AND o.rolname = 'momo_sched_definer'
            AND NOT (o.rolsuper OR o.rolbypassrls OR o.rolcanlogin)
       ) THEN
      RAISE EXCEPTION '% must be owned by the NOLOGIN NOSUPERUSER NOBYPASSRLS role momo_sched_definer', f;
    END IF;
    IF has_column_privilege('momo_sched_definer', 'public.scheduled_message', 'body', 'SELECT') THEN
      RAISE EXCEPTION 'momo_sched_definer must not read scheduled_message.body';
    END IF;
    FOREACH r IN ARRAY (sealed || ARRAY['momo_app']) LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      IF pg_has_role(r, 'momo_sched_definer', 'MEMBER') THEN
        RAISE EXCEPTION 'runtime role % must not be a member of momo_sched_definer', r;
      END IF;
    END LOOP;
  END LOOP;
END
$$;
-- END scheduled-message-lockdown
