-- =============================================================================
-- 100_mem_digest.sql — #3161 / ADR-0196 (팀 기억 v2) M1 스키마
--
-- 채널·스레드 요약(L1)의 저장소와 그 읽기·쓰기 규칙. 새 테이블 5개
--   mem_digest    요약 행(창 → 일 → 주 롤업)
--   mem_evidence  요약이 기댄 원문 메시지 링크(id만; 본문·발췌 저장 금지)
--   mem_cursor    채널별 요약 진행(워터마크 + 리스)
--   mem_serving   에이전트 한 턴의 「기억 n개 참고」 영수증
--   mem_settings  스위치(워크스페이스 / 채널 / 개인)
-- 과 SQL 함수. mem_item·mem_topic·mem_event 는 M2/M3 이다 — 만들지 않는다.
--
-- ── R1: 「채널 읽기 가능」 = 메시지 읽기 경로와 같은 규칙 ─────────────────────────
-- 메시지를 읽는 모든 경로가 `membership.left_at IS NULL` 행 하나로 문을 연다.
--   * REST 이력·스레드 답글  routes/messages.rs `history` → identity.rs:130
--                            `is_channel_member` (channel_id, member_id, left_at IS NULL)
--   * 에이전트 도구          routes/agent_port_tools.rs:427 (같은 함수)
--   * 검색                   momo-messaging/src/search.rs:291-302 (membership JOIN
--                            + member.status='active' AND member.deleted_at IS NULL)
-- 공개 채널이라도 멤버십 행이 없으면 읽지 못한다. guest 는 `membership.role` 값일
-- 뿐이고 `channel.archived_at` 은 읽기에서 보지 않는다. 이 함수는 Rust 규칙보다
-- 넓지 않고, 검색의 한 줄(멤버가 active·미삭제)만 더 좁힌다.
--
-- ── 쓰기·워커 계약 (보안 검수 #3185 1·2차) ────────────────────────────────────────
-- 역할이 셋이다.
--   momo_app      API. mem_* 는 SELECT(RLS 로 좁혀짐)만, mem_settings 만 직접 쓴다.
--                 워커 전용 함수의 EXECUTE 도, momo_memory 멤버십도 없다.
--   momo_memory   NOLOGIN · NOSUPERUSER · NOBYPASSRLS. 워커 전용 함수의 EXECUTE 를 가진
--                 유일한 역할이다. 테이블 권한은 없다(함수가 정의자 권한으로 쓴다).
--                 `momo_worker` 가 `GRANT momo_memory TO momo_worker WITH INHERIT FALSE,
--                 SET TRUE` 로 SET ROLE 만 할 수 있고, 상속은 받지 못한다.
--   mem_definer   NOLOGIN · NOSUPERUSER · NOBYPASSRLS. 함수 소유자. 테이블 소유자가 아니라
--                 RLS 가 그대로 걸리고, 쓰기 정책이 명시적으로 mem_definer 를 허용한다.
-- mem_digest / mem_evidence / mem_cursor / mem_serving 은 API 역할이 직접 INSERT/UPDATE/DELETE
-- 하지 못한다. (1) 테이블 권한 회수, (2) 쓰기 정책을 mem_definer 에만 부여 — 부트스트랩이
-- 권한을 다시 부여해도 RLS 가 막는다. 쓰기는 SECURITY DEFINER 함수만 통과한다:
--   mem_apply_digest      요약 + 근거를 한 번에 검증·기록(멱등 갱신, stale 해제).
--                         근거마다 워커가 읽은 시점의 edited_at 스냅샷을 받아 그 사이 수정되면
--                         40001 로 거부하고, 스위치(제외·정지)도 확인한다(55000).
--   mem_advance_cursor    워터마크 전진 + 리스(단조 증가, 채널 헤드 이하)
--   mem_record_serving    run 별 영수증(채널은 agent_run 에서, 요약마다 청중 규칙을 통과해야 함)
-- 워커 전용 함수(EXECUTE 는 momo_memory 에만; PUBLIC·momo_app 등 나머지에서 회수):
--   mem_apply_digest, mem_advance_cursor, mem_record_serving,
--   mem_digest_rollup_inputs, mem_channel_switch, mem_digest_live, mem_digest_audience_ok
-- 이들은 읽는 사람(app.member_id)을 보지 않고 정의자 권한으로 돈다 — API 세션이 부르면
-- 비공개 요약이 새거나 요약·커서·영수증이 위조된다. 그래서 API 역할이 부를 수 없어야 한다.
-- 함수는 `search_path = pg_catalog, public, pg_temp` 로 고정하고 객체를 public. 으로 한정하며,
-- 테넌트는 GUC(app.workspace_id)를 함수 안에서 읽는다.
--
-- ── 요약 워커(#3162) 계약 ─────────────────────────────────────────────────────
--   * 워커는 tx 마다 `SET LOCAL ROLE momo_memory`(BYPASSRLS 를 그 tx 동안 벗는다)와
--     `SET LOCAL app.workspace_id` 를 건다. mem_* 를 BYPASSRLS 로 읽거나 쓰지 않는다.
--     원문 메시지는 momo_worker 본래 권한으로 읽되, 읽은 시점과 메시지별 edited_at 을 기억해
--     mem_apply_digest 에 넘긴다.
--   * mem_* 는 위 쓰기 함수로만 기록한다. 롤업 입력(일←창, 주←일)은 mem_digest_rollup_inputs()
--     로 읽는다(stale·삭제/수정/일부 소실된 근거의 요약은 돌려주지 않는다).
--     채널 스위치는 mem_channel_switch().
--   * 영수증은 mem_record_serving(run, 요청자, ...) — 요청자는 agent_run 에 칼럼이 없어
--     인자로 받는다(멘션 잡이 아는 값). 요약마다 mem_digest_audience_ok 를 통과해야 한다.
--   * INSERT ... RETURNING 은 쓰지 않는다(쓰기 함수가 id 를 돌려준다).
--   * 요약 본문 자체는 DB 가 검증하지 못한다 — 함수를 부를 수 있는 코드는 워커뿐이어야 한다.
--
-- ── 정책 합성 주의 ────────────────────────────────────────────────────────────
-- 같은 명령의 PERMISSIVE 정책은 OR 로 합쳐진다. SELECT 는 일반 정책 하나 + mem_definer
-- 전용(테넌트) 정책 하나이고, 후자는 `TO mem_definer` 라 API 역할에는 적용되지 않는다.
-- mem_digest 의 읽기는 mem_digest_evidence_ok(SECURITY DEFINER)에 위임한다. mem_evidence
-- 를 읽는 사람의 정책으로 좁혀 둬도 그 함수는 가려진 근거까지 봐야 하기 때문이다.
--
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL. 재실행 가능한 문장만 쓴다.
-- 전제: 이 마이그레이션은 역할을 만들고 함수 소유자를 바꿀 수 있는 권한(슈퍼유저)으로 돈다.
-- =============================================================================

-- ── 정의자 역할 ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mem_definer') THEN
    CREATE ROLE mem_definer NOLOGIN;
  END IF;
  ALTER ROLE mem_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_memory') THEN
    CREATE ROLE momo_memory NOLOGIN;
  END IF;
  ALTER ROLE momo_memory NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
END $$;
GRANT USAGE ON SCHEMA public TO momo_memory;

GRANT USAGE ON SCHEMA public TO mem_definer;
-- 함수 소유자 변경은 새 소유자의 스키마 CREATE 권한을 요구한다. 아래 끝에서 회수한다.
GRANT CREATE ON SCHEMA public TO mem_definer;
GRANT SELECT ON message, membership, member, channel, channel_seq, agent_run, workspace_membership
  TO mem_definer;

-- 채널 (id, workspace_id) 복합 참조용. 작은 테이블이라 인덱스 비용이 낮다.
CREATE UNIQUE INDEX IF NOT EXISTS channel_id_workspace_uq ON channel (id, workspace_id);

-- ── 「채널 읽기 가능」 ───────────────────────────────────────────────────────────
-- 명시적 멤버로 묻는 형태. GUC 비어 있으면 NULL → false(닫힌 쪽).
CREATE OR REPLACE FUNCTION mem_member_can_read(p_channel_id uuid, p_member_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT true
      FROM public.membership ms
      JOIN public.member viewer
        ON viewer.id = ms.member_id
       AND viewer.workspace_id = ms.workspace_id
       AND viewer.status = 'active'
       AND viewer.deleted_at IS NULL
     WHERE ms.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
       AND ms.channel_id = p_channel_id
       AND ms.member_id = p_member_id
       AND ms.left_at IS NULL
     LIMIT 1
  ), false)
$$;

-- app.member_id 의 사람이 이 채널을 지금 읽을 수 있는가.
CREATE OR REPLACE FUNCTION mem_can_read_channel(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.mem_member_can_read(
    p_channel_id,
    nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid)
$$;

COMMENT ON FUNCTION mem_can_read_channel(uuid) IS
  'ADR-0196 D6 / #3161 R1. Can app.member_id read this channel now? membership.left_at IS NULL (== is_channel_member) + active undeleted member (== search.rs). Unset GUC => false.';

-- 여러 근거 채널을 전부 읽을 수 있어야 true. 빈 배열·NULL 은 false.
CREATE OR REPLACE FUNCTION mem_can_read_channels(p_channel_ids uuid[])
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(pg_catalog.cardinality(p_channel_ids), 0) > 0
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.unnest(p_channel_ids) AS c(id)
        WHERE c.id IS NULL OR NOT public.mem_can_read_channel(c.id)
     )
$$;

COMMENT ON FUNCTION mem_can_read_channels(uuid[]) IS
  'ADR-0196 D6-2. All listed channels readable (intersection rule). Empty/NULL array or NULL element => false.';

-- 워크스페이스 관리자(owner/admin)인가 — app.member_id 기준.
CREATE OR REPLACE FUNCTION mem_is_workspace_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.workspace_membership wm
      JOIN public.member m
        ON m.id = wm.member_id AND m.workspace_id = wm.workspace_id
       AND m.status = 'active' AND m.deleted_at IS NULL
     WHERE wm.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
       AND wm.member_id = nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid
       AND wm.role IN ('owner', 'admin')
  )
$$;

-- 채널 관리자(채널 멤버십 role 이 owner/admin)인가 — app.member_id 기준.
CREATE OR REPLACE FUNCTION mem_is_channel_admin(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.membership ms
     WHERE ms.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
       AND ms.channel_id = p_channel_id
       AND ms.member_id = nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid
       AND ms.left_at IS NULL
       AND ms.role IN ('owner', 'admin')
  )
$$;

-- ── 테이블 ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mem_digest (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 가장 좁은 곳: 요약이 저장되는 채널 하나(D6-1). 근거는 mem_evidence.
  channel_id      uuid NOT NULL,
  thread_root_id  uuid REFERENCES message(id) ON DELETE CASCADE,
  level           text NOT NULL,
  -- 채널 seq 구간(양끝 포함). 롤업도 자기가 덮는 구간을 그대로 가진다.
  from_seq        bigint NOT NULL,
  to_seq          bigint NOT NULL,
  body            text NOT NULL,
  -- 근거 행 수와 같다(mem_apply_digest 가 강제).
  source_count    integer NOT NULL DEFAULT 0,
  -- 롤업 계보(일 ← 창, 주 ← 일). FK 없음: 창 요약은 90일 뒤 지워진다(D10).
  source_digest_ids uuid[] NOT NULL DEFAULT '{}',
  -- 모델 출처(#3162 가 채움). ADR-0147 「기본 AI」 summary 행이 고른 모델.
  model           text,
  model_source    text,
  prompt_version  text NOT NULL,
  -- 수정·삭제된 근거를 포함해 다시 만들어야 함(D6-5). true 면 읽기에서 가려진다.
  stale           boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_digest_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_digest_level_ck CHECK (level IN ('window', 'day', 'week')),
  CONSTRAINT mem_digest_seq_ck CHECK (from_seq >= 0 AND to_seq >= from_seq),
  CONSTRAINT mem_digest_source_count_ck CHECK (source_count >= 0),
  CONSTRAINT mem_digest_body_ck CHECK (char_length(body) > 0)
);

-- 멱등: 같은 (채널, 스레드, 레벨, 끝 seq) 는 한 행. 스레드 요약은 채널 seq 를
-- 공유하므로 thread_root_id 가 키에 들어간다(ADR 의 (channel_id, level, to_seq)
-- 에서 스레드 축을 더한 것; NULL 은 「채널 전체」 한 값으로 취급).
CREATE UNIQUE INDEX IF NOT EXISTS mem_digest_idem_uq
  ON mem_digest (channel_id, level, to_seq, thread_root_id) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS mem_digest_latest_idx
  ON mem_digest (workspace_id, channel_id, level, to_seq DESC);

-- digest_id | item_id 정확히 하나. item_id 의 FK 는 mem_item 이 생기는 M2 가 붙인다.
-- message 삭제(하드)는 근거 행을 지우고, 근거가 0 이 된 요약은 읽기 정책이 가린다.
CREATE TABLE IF NOT EXISTS mem_evidence (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  digest_id     uuid REFERENCES mem_digest(id) ON DELETE CASCADE,
  item_id       uuid,
  message_id    uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  -- 그 메시지의 채널(비정규화). 쓰기 함수가 message.channel_id 와의 일치를 강제하고
  -- 읽기 정책도 다시 확인한다(message 복합 FK 는 큰 테이블 인덱스 비용 때문에 생략).
  channel_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_evidence_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_evidence_owner_ck
    CHECK ((digest_id IS NOT NULL) <> (item_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_evidence_digest_msg_uq
  ON mem_evidence (digest_id, message_id) WHERE digest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_evidence_digest_idx
  ON mem_evidence (digest_id) WHERE digest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_evidence_message_idx
  ON mem_evidence (message_id);

CREATE TABLE IF NOT EXISTS mem_cursor (
  channel_id     uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 요약 적용과 같은 tx 에서만 전진한다(#3162; 충돌 시 구간 누락 방지).
  last_seq       bigint NOT NULL DEFAULT 0,
  lease_token    uuid,
  leased_until   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_cursor_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_cursor_last_seq_ck CHECK (last_seq >= 0),
  CONSTRAINT mem_cursor_lease_ck CHECK ((lease_token IS NULL) = (leased_until IS NULL))
);
CREATE INDEX IF NOT EXISTS mem_cursor_ws_idx ON mem_cursor (workspace_id);

-- run 하나에 영수증 하나. channel_id 는 ADR 칼럼 목록에 없는 추가분: 답이 올라간
-- 채널(mem_record_serving 이 agent_run 에서 가져온다).
CREATE TABLE IF NOT EXISTS mem_serving (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL UNIQUE REFERENCES agent_run(id) ON DELETE CASCADE,
  channel_id     uuid NOT NULL,
  digest_ids     uuid[] NOT NULL DEFAULT '{}',
  item_ids       uuid[] NOT NULL DEFAULT '{}',
  -- 청중 규칙으로 싣지 않은 개수만(내용 없음). RLS 가 가린 행은 세지 않는다.
  withheld_count integer NOT NULL DEFAULT 0,
  budget_chars   integer NOT NULL DEFAULT 0,
  used_chars     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_serving_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_serving_counts_ck
    CHECK (withheld_count >= 0 AND budget_chars >= 0 AND used_chars >= 0
           AND used_chars <= budget_chars)
);
CREATE INDEX IF NOT EXISTS mem_serving_channel_idx
  ON mem_serving (workspace_id, channel_id, created_at DESC);

-- 한 테이블, scope 로 구분. 칼럼이 적용되지 않는 scope 에서는 기본값이어야 한다.
--   workspace: enabled(D9 스위치; 기본 켜짐), paused, daily_token_cap, reset_epoch
--   channel:   excluded(채널 제외), paused
--   member:    paused(개인 일시정지; 본인만 읽고 쓴다)
CREATE TABLE IF NOT EXISTS mem_settings (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  scope            text NOT NULL,
  channel_id       uuid,
  member_id        uuid,
  enabled          boolean NOT NULL DEFAULT true,
  paused           boolean NOT NULL DEFAULT false,
  excluded         boolean NOT NULL DEFAULT false,
  daily_token_cap  integer,
  reset_epoch      bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_settings_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_settings_member_fk FOREIGN KEY (workspace_id, member_id)
    REFERENCES member (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mem_settings_scope_ck CHECK (scope IN ('workspace', 'channel', 'member')),
  CONSTRAINT mem_settings_target_ck CHECK (
    (scope = 'workspace' AND channel_id IS NULL AND member_id IS NULL)
    OR (scope = 'channel' AND channel_id IS NOT NULL AND member_id IS NULL)
    OR (scope = 'member' AND member_id IS NOT NULL AND channel_id IS NULL)
  ),
  CONSTRAINT mem_settings_scope_cols_ck CHECK (
    (scope = 'workspace' AND excluded = false)
    OR (scope = 'channel' AND enabled = true AND daily_token_cap IS NULL AND reset_epoch = 0)
    OR (scope = 'member' AND enabled = true AND excluded = false
        AND daily_token_cap IS NULL AND reset_epoch = 0)
  ),
  CONSTRAINT mem_settings_cap_ck CHECK (daily_token_cap IS NULL OR daily_token_cap >= 0),
  CONSTRAINT mem_settings_epoch_ck CHECK (reset_epoch >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_settings_workspace_uq
  ON mem_settings (workspace_id) WHERE scope = 'workspace';
CREATE UNIQUE INDEX IF NOT EXISTS mem_settings_channel_uq
  ON mem_settings (workspace_id, channel_id) WHERE scope = 'channel';
CREATE UNIQUE INDEX IF NOT EXISTS mem_settings_member_uq
  ON mem_settings (workspace_id, member_id) WHERE scope = 'member';

GRANT SELECT, INSERT, UPDATE, DELETE ON mem_digest, mem_evidence, mem_cursor, mem_serving
  TO mem_definer;
GRANT SELECT ON mem_settings TO mem_definer;

DROP POLICY IF EXISTS mem_digest_sel ON mem_digest;
DROP FUNCTION IF EXISTS mem_digest_evidence_ok(uuid, uuid);
-- ── 정의자 읽기 도우미 ─────────────────────────────────────────────────────────
-- 요약의 읽기 가능 여부(RLS 정책이 부른다 — 그래서 PUBLIC 이 EXECUTE 한다). 저장 채널은
-- mem_digest 에서 직접 읽는다(호출자가 채널을 주지 못한다). 저장 채널·모든 근거 채널을
-- app.member_id 가 읽을 수 있고, 근거가 source_count 개 이상 있으며(일부만 하드 삭제되면
-- 가려진다), 모든 근거가 (그 채널에 속한, 삭제·수정되지 않은) 메시지일 때 true.
-- 수정: 근거가 기록된 뒤 메시지가 수정되면 그 요약은 가려진다(재생성 전까지).
-- 이 함수는 mem_digest 를 읽으므로 정책은 mem_definer 에게는 이 함수를 부르지 않는다(CASE).
CREATE OR REPLACE FUNCTION mem_digest_evidence_ok(p_digest_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT public.mem_can_read_channel(d.channel_id)
       AND d.source_count > 0
       AND (SELECT pg_catalog.count(*) FROM public.mem_evidence ev
             WHERE ev.digest_id = d.id AND ev.workspace_id = d.workspace_id) >= d.source_count
       AND NOT EXISTS (
         SELECT 1 FROM public.mem_evidence ev
          WHERE ev.digest_id = d.id AND ev.workspace_id = d.workspace_id
            AND NOT (
              public.mem_can_read_channel(ev.channel_id)
              AND EXISTS (
                SELECT 1 FROM public.message m
                 WHERE m.id = ev.message_id
                   AND m.channel_id = ev.channel_id
                   AND m.workspace_id = ev.workspace_id
                   AND m.deleted_at IS NULL
                   AND m.state <> 'deleted'
                   AND (m.edited_at IS NULL OR m.edited_at <= ev.created_at)
              )
            )
       )
      FROM public.mem_digest d
     WHERE d.id = p_digest_id
       AND d.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  ), false)
$$;

-- 읽는 사람 없이(워커 전용): 근거가 source_count 개 이상 있고 전부 살아 있는가
-- (삭제·수정 안 됨, 그 채널 소속).
CREATE OR REPLACE FUNCTION mem_digest_live(p_digest_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT d.source_count > 0
       AND (SELECT pg_catalog.count(*) FROM public.mem_evidence ev
             WHERE ev.digest_id = d.id AND ev.workspace_id = d.workspace_id) >= d.source_count
       AND NOT EXISTS (
         SELECT 1 FROM public.mem_evidence ev
          WHERE ev.digest_id = d.id AND ev.workspace_id = d.workspace_id
            AND NOT EXISTS (
              SELECT 1 FROM public.message m
               WHERE m.id = ev.message_id
                 AND m.channel_id = ev.channel_id
                 AND m.workspace_id = ev.workspace_id
                 AND m.deleted_at IS NULL
                 AND m.state <> 'deleted'
                 AND (m.edited_at IS NULL OR m.edited_at <= ev.created_at)
            )
       )
      FROM public.mem_digest d
     WHERE d.id = p_digest_id
       AND d.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  ), false)
$$;

-- ── 청중 규칙 (ADR-0196 D6-4; #3163 이 쓴다) ───────────────────────────────────
-- 채널 X 에 올라갈 에이전트 답에 이 요약을 실어도 되는가.
--   * 기본: 저장 채널과 모든 근거 채널이 답이 올라갈 채널 X 자신일 때만.
--   * X 가 요청자와 에이전트만 있는 1:1 DM 이면 (사람↔에이전트 DM, 활성 멤버 정확히 2명)
--     요청자가 읽을 수 있는 채널의 근거까지 허용한다(요청자 권한 합집합, 그 DM 에서만).
--   * 요청자가 X 를 읽을 수 없거나, stale·삭제·수정된 근거가 있으면 false.
-- 요청자는 GUC 가 아니라 인자로 받는다(멘션 잡 생성 tx 에서 명시).
CREATE OR REPLACE FUNCTION mem_digest_audience_ok(
  p_digest_id uuid, p_answer_channel_id uuid, p_requester_member_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_home uuid;
  v_stale boolean;
  v_dm boolean;
BEGIN
  IF v_ws IS NULL OR p_requester_member_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT d.channel_id, d.stale INTO v_home, v_stale
    FROM public.mem_digest d
   WHERE d.id = p_digest_id AND d.workspace_id = v_ws;
  IF NOT FOUND OR v_stale THEN
    RETURN false;
  END IF;
  IF NOT public.mem_digest_live(p_digest_id) THEN
    RETURN false;
  END IF;
  -- 요청자는 답이 올라갈 채널을 읽을 수 있어야 한다.
  IF NOT public.mem_member_can_read(p_answer_channel_id, p_requester_member_id) THEN
    RETURN false;
  END IF;
  SELECT (c.kind = 'dm'
          AND (SELECT pg_catalog.count(*) FROM public.membership x
                WHERE x.channel_id = c.id AND x.workspace_id = c.workspace_id
                  AND x.left_at IS NULL) = 2
          AND EXISTS (SELECT 1 FROM public.membership x
                        JOIN public.member mm ON mm.id = x.member_id
                       WHERE x.channel_id = c.id AND x.left_at IS NULL
                         AND x.member_id = p_requester_member_id AND mm.kind = 'human')
          AND EXISTS (SELECT 1 FROM public.membership x
                        JOIN public.member mm ON mm.id = x.member_id
                       WHERE x.channel_id = c.id AND x.left_at IS NULL
                         AND mm.kind = 'agent' AND mm.status = 'active'
                         AND mm.deleted_at IS NULL))
    INTO v_dm
    FROM public.channel c
   WHERE c.id = p_answer_channel_id AND c.workspace_id = v_ws;
  IF v_dm IS NULL THEN
    RETURN false;
  END IF;
  -- 저장 채널
  IF NOT (v_home = p_answer_channel_id
          OR (v_dm AND public.mem_member_can_read(v_home, p_requester_member_id))) THEN
    RETURN false;
  END IF;
  -- 모든 근거 채널
  RETURN NOT EXISTS (
    SELECT 1 FROM public.mem_evidence ev
     WHERE ev.digest_id = p_digest_id AND ev.workspace_id = v_ws
       AND NOT (ev.channel_id = p_answer_channel_id
                OR (v_dm AND public.mem_member_can_read(ev.channel_id, p_requester_member_id)))
  );
END
$$;

-- 워커용 읽기(읽는 사람 없음): 롤업 입력. 일 ← 창, 주 ← 일. stale·삭제·수정된 근거 제외.
CREATE OR REPLACE FUNCTION mem_digest_rollup_inputs(
  p_channel_id uuid, p_thread_root_id uuid, p_target_level text,
  p_from_seq bigint, p_to_seq bigint)
RETURNS TABLE (id uuid, level text, from_seq bigint, to_seq bigint, body text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.id, d.level, d.from_seq, d.to_seq, d.body
    FROM public.mem_digest d
   WHERE d.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
     AND d.channel_id = p_channel_id
     AND d.thread_root_id IS NOT DISTINCT FROM p_thread_root_id
     AND d.level = CASE p_target_level WHEN 'day' THEN 'window' WHEN 'week' THEN 'day' END
     AND d.from_seq >= p_from_seq AND d.to_seq <= p_to_seq
     AND NOT d.stale
     AND public.mem_digest_live(d.id)
   ORDER BY d.to_seq
$$;

-- 워커용 읽기: 이 채널을 요약해도 되는가(워크스페이스 enabled/paused, 채널 excluded/paused).
-- 행이 없으면 기본은 켜짐(D9). 개인 일시정지·DM 규칙은 이 함수의 범위 밖이다.
CREATE OR REPLACE FUNCTION mem_channel_switch(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
           SELECT s.enabled AND NOT s.paused FROM public.mem_settings s
            WHERE s.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
              AND s.scope = 'workspace'), true)
     AND NOT COALESCE((
           SELECT s.excluded OR s.paused FROM public.mem_settings s
            WHERE s.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
              AND s.scope = 'channel' AND s.channel_id = p_channel_id), false)
$$;

-- ── 쓰기 함수 (SECURITY DEFINER; 입력 검증) ────────────────────────────────────
-- 요약 + 근거를 한 번에 기록한다. 같은 (채널, 스레드, 레벨, to_seq) 가 있으면 갱신하고
-- 근거를 갈아 끼우며 stale 을 푼다. 저장 채널 하나에만 쓴다(D6-1): 모든 근거 메시지는
-- 그 채널·그 워크스페이스·그 seq 구간·(스레드면 그 스레드)에 속한 살아 있는 메시지여야 한다.
DROP FUNCTION IF EXISTS mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[]);
CREATE OR REPLACE FUNCTION mem_apply_digest(
  p_channel_id uuid, p_thread_root_id uuid, p_level text,
  p_from_seq bigint, p_to_seq bigint, p_body text,
  p_source_digest_ids uuid[], p_model text, p_model_source text, p_prompt_version text,
  p_evidence_message_ids uuid[], p_evidence_edited_at timestamptz[], p_read_at timestamptz)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_n integer := COALESCE(pg_catalog.cardinality(p_evidence_message_ids), 0);
  v_src uuid[] := COALESCE(p_source_digest_ids, '{}');
  v_id uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_apply_digest: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_level IS NULL OR p_level NOT IN ('window', 'day', 'week') THEN
    RAISE EXCEPTION 'mem_apply_digest: bad level' USING ERRCODE = '23514';
  END IF;
  IF p_from_seq IS NULL OR p_to_seq IS NULL OR p_from_seq < 0 OR p_to_seq < p_from_seq THEN
    RAISE EXCEPTION 'mem_apply_digest: bad seq range' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.channel c WHERE c.id = p_channel_id AND c.workspace_id = v_ws) THEN
    RAISE EXCEPTION 'mem_apply_digest: channel not in workspace' USING ERRCODE = '23503';
  END IF;
  -- 스위치(D9): 워크스페이스가 꺼졌거나 정지, 채널이 제외·정지면 기록하지 않는다.
  IF NOT public.mem_channel_switch(p_channel_id) THEN
    RAISE EXCEPTION 'mem_apply_digest: memory is disabled, paused or excluded for this channel'
      USING ERRCODE = '55000';
  END IF;
  IF p_thread_root_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.message r
        WHERE r.id = p_thread_root_id AND r.channel_id = p_channel_id
          AND r.workspace_id = v_ws AND r.root_id IS NULL) THEN
    RAISE EXCEPTION 'mem_apply_digest: thread root not in channel' USING ERRCODE = '23503';
  END IF;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'mem_apply_digest: at least one evidence message is required' USING ERRCODE = '23514';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT e) FROM pg_catalog.unnest(p_evidence_message_ids) AS e) <> v_n THEN
    RAISE EXCEPTION 'mem_apply_digest: duplicate or NULL evidence message' USING ERRCODE = '23514';
  END IF;
  -- 워커가 읽은 시점 스냅샷: 근거마다 그때의 edited_at (수정 안 됐으면 NULL 원소).
  IF p_read_at IS NULL OR p_read_at > pg_catalog.now()
     OR p_evidence_edited_at IS NULL
     OR pg_catalog.cardinality(p_evidence_edited_at) <> v_n
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_evidence_edited_at) AS t(x) WHERE t.x > p_read_at) THEN
    RAISE EXCEPTION 'mem_apply_digest: bad read snapshot (read_at / per-evidence edited_at)'
      USING ERRCODE = '23514';
  END IF;
  -- 근거: 그 채널·워크스페이스·구간(·스레드)의 살아 있는 메시지, 전부.
  IF (SELECT pg_catalog.count(*) FROM public.message m
       WHERE m.id = ANY (p_evidence_message_ids)
         AND m.channel_id = p_channel_id AND m.workspace_id = v_ws
         AND m.seq BETWEEN p_from_seq AND p_to_seq
         AND m.deleted_at IS NULL AND m.state <> 'deleted'
         AND (p_thread_root_id IS NULL OR m.id = p_thread_root_id OR m.root_id = p_thread_root_id)
     ) <> v_n THEN
    RAISE EXCEPTION 'mem_apply_digest: evidence message is not a live message of this channel/range/thread'
      USING ERRCODE = '23503';
  END IF;
  -- 읽은 뒤 수정됐으면 거부(요약이 옛 본문을 기댄다). 읽은 뒤 삭제됐으면 위 검사가 이미 거부했다.
  -- 이 검사 뒤 커밋 전에 또 수정돼도 근거의 created_at = 읽은 시점이라 읽기 정책이 그 요약을 가린다.
  IF EXISTS (SELECT 1
               FROM ROWS FROM (pg_catalog.unnest(p_evidence_message_ids), pg_catalog.unnest(p_evidence_edited_at)) AS s(mid, snap)
               JOIN public.message m ON m.id = s.mid
              WHERE m.edited_at IS DISTINCT FROM s.snap) THEN
    RAISE EXCEPTION 'mem_apply_digest: evidence was edited after it was read' USING ERRCODE = '40001';
  END IF;
  -- 계보: 창은 하위 요약이 없고, 일/주는 한 단계 아래 요약을 가진다.
  IF p_level = 'window' THEN
    IF pg_catalog.cardinality(v_src) <> 0 THEN
      RAISE EXCEPTION 'mem_apply_digest: a window digest has no source digests' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF pg_catalog.cardinality(v_src) = 0 THEN
      RAISE EXCEPTION 'mem_apply_digest: a rollup needs source digests' USING ERRCODE = '23514';
    END IF;
    IF (SELECT pg_catalog.count(*) FROM public.mem_digest s
         WHERE s.id = ANY (v_src) AND s.workspace_id = v_ws AND s.channel_id = p_channel_id
           AND s.thread_root_id IS NOT DISTINCT FROM p_thread_root_id
           AND s.level = CASE p_level WHEN 'day' THEN 'window' ELSE 'day' END
           AND s.from_seq >= p_from_seq AND s.to_seq <= p_to_seq
       ) <> (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(v_src) AS x) THEN
      RAISE EXCEPTION 'mem_apply_digest: source digests must be one level below, same channel/thread, inside the range'
        USING ERRCODE = '23503';
    END IF;
    -- 롤업의 근거는 하위 요약 근거 합집합의 상위집합이어야 한다.
    IF EXISTS (SELECT 1 FROM public.mem_evidence se
                WHERE se.digest_id = ANY (v_src) AND se.workspace_id = v_ws
                  AND se.message_id <> ALL (p_evidence_message_ids)) THEN
      RAISE EXCEPTION 'mem_apply_digest: rollup evidence must cover every source digest evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT d.id INTO v_id FROM public.mem_digest d
   WHERE d.workspace_id = v_ws AND d.channel_id = p_channel_id AND d.level = p_level
     AND d.to_seq = p_to_seq AND d.thread_root_id IS NOT DISTINCT FROM p_thread_root_id
   FOR UPDATE;
  IF FOUND THEN
    UPDATE public.mem_digest
       SET from_seq = p_from_seq, body = p_body, source_count = v_n,
           source_digest_ids = v_src, model = p_model, model_source = p_model_source,
           prompt_version = p_prompt_version, stale = false, created_at = pg_catalog.now()
     WHERE id = v_id;
    DELETE FROM public.mem_evidence WHERE digest_id = v_id;
  ELSE
    INSERT INTO public.mem_digest
      (workspace_id, channel_id, thread_root_id, level, from_seq, to_seq, body,
       source_count, source_digest_ids, model, model_source, prompt_version)
    VALUES
      (v_ws, p_channel_id, p_thread_root_id, p_level, p_from_seq, p_to_seq, p_body,
       v_n, v_src, p_model, p_model_source, p_prompt_version)
    RETURNING id INTO v_id;
  END IF;
  INSERT INTO public.mem_evidence (workspace_id, digest_id, message_id, channel_id, created_at)
  SELECT v_ws, v_id, e, p_channel_id, p_read_at FROM pg_catalog.unnest(p_evidence_message_ids) AS e;
  RETURN v_id;
END
$$;

-- 워터마크 전진 + 리스. 뒤로 가지 못하고 채널 헤드(channel_seq.last_seq)를 넘지 못하며,
-- 다른 토큰이 쥔 살아 있는 리스가 있으면 55P03.
CREATE OR REPLACE FUNCTION mem_advance_cursor(
  p_channel_id uuid, p_last_seq bigint, p_lease_token uuid, p_leased_until timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_head bigint;
  v_cur public.mem_cursor%ROWTYPE;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_advance_cursor: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_last_seq IS NULL OR p_last_seq < 0 OR p_lease_token IS NULL OR p_leased_until IS NULL THEN
    RAISE EXCEPTION 'mem_advance_cursor: bad arguments' USING ERRCODE = '23514';
  END IF;
  SELECT cs.last_seq INTO v_head FROM public.channel_seq cs
   WHERE cs.channel_id = p_channel_id AND cs.workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_advance_cursor: channel not in workspace' USING ERRCODE = '23503';
  END IF;
  IF p_last_seq > v_head THEN
    RAISE EXCEPTION 'mem_advance_cursor: cursor beyond channel head' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_cur FROM public.mem_cursor c
   WHERE c.channel_id = p_channel_id AND c.workspace_id = v_ws FOR UPDATE;
  IF FOUND THEN
    IF p_last_seq < v_cur.last_seq THEN
      RAISE EXCEPTION 'mem_advance_cursor: cursor cannot move backwards' USING ERRCODE = '23514';
    END IF;
    IF v_cur.lease_token IS NOT NULL AND v_cur.leased_until > pg_catalog.now()
       AND v_cur.lease_token <> p_lease_token THEN
      RAISE EXCEPTION 'mem_advance_cursor: lease held by another worker' USING ERRCODE = '55P03';
    END IF;
    UPDATE public.mem_cursor
       SET last_seq = p_last_seq, lease_token = p_lease_token,
           leased_until = p_leased_until, updated_at = pg_catalog.now()
     WHERE channel_id = p_channel_id;
  ELSE
    INSERT INTO public.mem_cursor (channel_id, workspace_id, last_seq, lease_token, leased_until)
    VALUES (p_channel_id, v_ws, p_last_seq, p_lease_token, p_leased_until);
  END IF;
  RETURN p_last_seq;
END
$$;

-- run 별 영수증. 채널은 agent_run 에서 가져온다(호출자가 정하지 않는다). 요청자는 agent_run 에
-- 칼럼이 없어 인자로 받는다. 서빙한 요약은 이 워크스페이스에 있고 청중 규칙을 통과해야 한다. 같은 run 에 두 번 쓰면 23505.
DROP FUNCTION IF EXISTS mem_record_serving(uuid, uuid[], uuid[], integer, integer, integer);
CREATE OR REPLACE FUNCTION mem_record_serving(
  p_run_id uuid, p_requester_member_id uuid, p_digest_ids uuid[], p_item_ids uuid[],
  p_withheld_count integer, p_budget_chars integer, p_used_chars integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_channel uuid;
  v_digests uuid[] := COALESCE(p_digest_ids, '{}');
  v_id uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_record_serving: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  SELECT r.channel_id INTO v_channel FROM public.agent_run r
   WHERE r.id = p_run_id AND r.workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_record_serving: run not in workspace' USING ERRCODE = '23503';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.mem_digest d
       WHERE d.id = ANY (v_digests) AND d.workspace_id = v_ws)
     <> (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(v_digests) AS x) THEN
    RAISE EXCEPTION 'mem_record_serving: unknown digest' USING ERRCODE = '23503';
  END IF;
  -- 실은 요약은 전부 이 답 채널의 청중 규칙(D6-4)을 통과해야 한다.
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_digests) AS x(id)
              WHERE NOT public.mem_digest_audience_ok(x.id, v_channel, p_requester_member_id)) THEN
    RAISE EXCEPTION 'mem_record_serving: a digest is not servable to this answer channel'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.mem_serving
    (workspace_id, run_id, channel_id, digest_ids, item_ids, withheld_count, budget_chars, used_chars)
  VALUES
    (v_ws, p_run_id, v_channel, v_digests, COALESCE(p_item_ids, '{}'),
     COALESCE(p_withheld_count, 0), COALESCE(p_budget_chars, 0), COALESCE(p_used_chars, 0))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- ── 함수 소유자·권한 ────────────────────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_digest_evidence_ok(uuid)', 'mem_digest_live(uuid)',
    'mem_digest_audience_ok(uuid, uuid, uuid)',
    'mem_digest_rollup_inputs(uuid, uuid, text, bigint, bigint)',
    'mem_channel_switch(uuid)',
    'mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)',
    'mem_advance_cursor(uuid, bigint, uuid, timestamptz)',
    'mem_record_serving(uuid, uuid, uuid[], uuid[], integer, integer, integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO mem_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- ── RLS ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_digest', 'mem_evidence', 'mem_cursor', 'mem_serving', 'mem_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- 쓰기(INSERT/UPDATE/DELETE) 정책은 mem_definer 에만 붙는다. 다른 역할은 정책이 없어
-- 거부된다(테이블 권한을 부트스트랩이 되돌려도 마찬가지).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_digest', 'mem_evidence', 'mem_cursor', 'mem_serving'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_ins', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR INSERT TO mem_definer
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
    $f$, t || '_ins', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_upd', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR UPDATE TO mem_definer
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
    $f$, t || '_upd', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_del', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR DELETE TO mem_definer
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
    $f$, t || '_del', t);
    -- 정의자 함수가 자기 쓰기·검증에 쓰는 테넌트 읽기.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_sel_definer', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR SELECT TO mem_definer
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
    $f$, t || '_sel_definer', t);
  END LOOP;
END $$;

-- mem_digest 읽기(D6-2, M5): stale 이 아니고, 저장 채널·모든 근거 채널을 읽을 수 있고,
-- 근거가 있으며 전부 살아 있을 때만 보인다(mem_digest_evidence_ok).
DROP POLICY IF EXISTS mem_digest_sel ON mem_digest;
CREATE POLICY mem_digest_sel ON mem_digest FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND NOT stale
    AND CASE WHEN current_user = 'mem_definer' THEN false ELSE mem_digest_evidence_ok(id) END
  );

-- 근거 행: 그 채널을 읽을 수 있는 사람만(채널·메시지 id 가 새지 않게).
DROP POLICY IF EXISTS mem_evidence_sel ON mem_evidence;
CREATE POLICY mem_evidence_sel ON mem_evidence FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_can_read_channel(channel_id)
  );

-- 진행 상태·영수증: 그 채널(영수증은 답이 올라간 채널)을 읽을 수 있는 사람만.
DROP POLICY IF EXISTS mem_cursor_sel ON mem_cursor;
CREATE POLICY mem_cursor_sel ON mem_cursor FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_can_read_channel(channel_id)
  );
DROP POLICY IF EXISTS mem_serving_sel ON mem_serving;
CREATE POLICY mem_serving_sel ON mem_serving FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_can_read_channel(channel_id)
  );

-- mem_settings: 읽기 — 워크스페이스 행은 전원, 채널 행은 그 채널을 읽을 수 있는 사람,
-- 개인 행은 본인. 쓰기 — 개인 행은 본인, 워크스페이스 행은 owner/admin, 채널 행은
-- 그 채널을 읽을 수 있고 워크스페이스 또는 채널의 owner/admin 인 사람(M2).
DROP POLICY IF EXISTS mem_settings_scope ON mem_settings;
DROP POLICY IF EXISTS mem_settings_sel ON mem_settings;
CREATE POLICY mem_settings_sel ON mem_settings FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND (scope = 'workspace'
         OR (scope = 'channel' AND mem_can_read_channel(channel_id))
         OR (scope = 'member'
             AND member_id = nullif(current_setting('app.member_id', true), '')::uuid))
  );
DROP POLICY IF EXISTS mem_settings_sel_definer ON mem_settings;
CREATE POLICY mem_settings_sel_definer ON mem_settings FOR SELECT TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DO $$
DECLARE
  w text := $w$
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND (
      (scope = 'member'
        AND member_id = nullif(current_setting('app.member_id', true), '')::uuid)
      OR (scope = 'workspace' AND mem_is_workspace_admin())
      OR (scope = 'channel' AND mem_can_read_channel(channel_id)
          AND (mem_is_workspace_admin() OR mem_is_channel_admin(channel_id)))
    )$w$;
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS mem_settings_ins ON mem_settings';
  EXECUTE format('CREATE POLICY mem_settings_ins ON mem_settings FOR INSERT WITH CHECK (%s)', w);
  EXECUTE 'DROP POLICY IF EXISTS mem_settings_upd ON mem_settings';
  EXECUTE format('CREATE POLICY mem_settings_upd ON mem_settings FOR UPDATE USING (%s) WITH CHECK (%s)', w, w);
  EXECUTE 'DROP POLICY IF EXISTS mem_settings_del ON mem_settings';
  EXECUTE format('CREATE POLICY mem_settings_del ON mem_settings FOR DELETE USING (%s)', w);
END $$;

-- ── 런타임 역할 권한 ────────────────────────────────────────────────────────────
-- 역할이 이 마이그레이션보다 늦게 생기면 infra/rust/sql/bootstrap_*.sql 이 같은 블록을 다시
-- 돈다(부트스트랩은 ALL TABLES 를 다시 부여하므로). 세 곳의 블록은 글자 그대로 같다.
-- #3161 team memory lockdown (ADR-0196 D6-6). Identical in 100_mem_digest.sql,
-- bootstrap_roles.sql and bootstrap_runtime_roles.sql. Runs after the runtime roles exist and
-- after any ALL TABLES grant. Worker-only functions: EXECUTE for momo_memory only; the
-- BYPASSRLS roles never touch mem_* rows; momo_app reads (RLS) and edits only its settings.
DO $$
DECLARE
  r text;
  t text;
  f text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
  worker_only text[] := ARRAY[
    'mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)',
    'mem_advance_cursor(uuid, bigint, uuid, timestamptz)',
    'mem_record_serving(uuid, uuid, uuid[], uuid[], integer, integer, integer)',
    'mem_digest_rollup_inputs(uuid, uuid, text, bigint, bigint)',
    'mem_channel_switch(uuid)',
    'mem_digest_live(uuid)',
    'mem_digest_audience_ok(uuid, uuid, uuid)'
  ];
BEGIN
  IF to_regclass('public.mem_digest') IS NULL THEN
    RETURN;
  END IF;
  FOR t IN SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'mem\_%' LOOP
    FOREACH r IN ARRAY runtime_roles LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      IF r = 'momo_app' THEN
        IF t <> 'mem_settings' THEN
          EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
        END IF;
      ELSE
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY worker_only LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    FOREACH r IN ARRAY runtime_roles LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_memory') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO momo_memory', f);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_memory') THEN
    FOREACH r IN ARRAY runtime_roles LOOP
      IF r <> 'momo_worker' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
         AND pg_has_role(r, 'momo_memory', 'MEMBER') THEN
        EXECUTE format('REVOKE momo_memory FROM %I', r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
      GRANT momo_memory TO momo_worker WITH INHERIT FALSE, SET TRUE;
    END IF;
  END IF;
END
$$;

-- ── 자기 검사 ─────────────────────────────────────────────────────────────────
DO $$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_digest', 'mem_evidence', 'mem_cursor', 'mem_serving', 'mem_settings'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND c.relname = t AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '% is missing FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('mem_definer', 'momo_memory')
              AND (rolbypassrls OR rolsuper OR rolcanlogin)) THEN
    RAISE EXCEPTION 'mem_definer / momo_memory must be NOLOGIN NOSUPERUSER NOBYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app')
     AND (pg_has_role('momo_app', 'momo_memory', 'MEMBER')
          OR has_function_privilege('momo_app', 'public.mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'momo_app must not be a momo_memory member or execute worker-only functions';
  END IF;
  FOR f IN SELECT p.proname FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.prosecdef AND p.proname LIKE 'mem\_%'
              AND pg_get_userbyid(p.proowner) <> 'mem_definer' LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % is not owned by mem_definer', f;
  END LOOP;
END $$;
