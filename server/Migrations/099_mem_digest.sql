-- =============================================================================
-- 099_mem_digest.sql — #3161 / ADR-0196 (팀 기억 v2) M1 스키마
--
-- 채널·스레드 요약(L1)의 저장소와 그 읽기 규칙. 새 테이블 5개
--   mem_digest    요약 행(창 → 일 → 주 롤업)
--   mem_evidence  요약이 기댄 원문 메시지 링크(id만; 본문·발췌 저장 금지)
--   mem_cursor    채널별 요약 진행(워터마크 + 리스)
--   mem_serving   에이전트 한 턴의 「기억 n개 참고」 영수증
--   mem_settings  스위치(워크스페이스 / 채널 / 개인)
-- 과 SQL 함수 mem_can_read_channel / mem_can_read_channels.
-- mem_item·mem_topic·mem_event 는 M2/M3 이다 — 여기서 만들지 않는다.
--
-- ── R1: 「채널 읽기 가능」 = 메시지 읽기 경로와 같은 규칙 ─────────────────────────
-- 메시지를 읽는 모든 경로가 `membership.left_at IS NULL` 행 하나로 문을 연다.
--   * REST 이력·스레드 답글  routes/messages.rs `history` → identity.rs:130
--                            `is_channel_member` (channel_id, member_id, left_at IS NULL)
--   * 에이전트 도구          routes/agent_port_tools.rs:427 (같은 함수)
--   * 검색                   momo-messaging/src/search.rs:291-302 (membership JOIN
--                            + member.status='active' AND member.deleted_at IS NULL)
-- 공개 채널이라도 멤버십 행이 없으면 읽지 못한다(비멤버 공개 읽기 경로 없음).
-- guest 는 `membership.role` 값일 뿐 별도 읽기 규칙이 없다. `channel.archived_at`
-- 은 읽기에서 보지 않는다(보관 채널도 멤버는 읽는다). 이 함수는 Rust 규칙보다
-- 넓지 않게 검색의 한 줄(멤버가 active·미삭제)만 더 좁힌다.
--
-- ── 정책 합성 주의 ────────────────────────────────────────────────────────────
-- 같은 명령의 PERMISSIVE 정책은 OR 로 합쳐진다. 그래서 ws_isolation 을 FOR ALL 로
-- 두고 읽기 정책을 더하면 읽기 정책이 무력화된다. 여기서는 명령별로 나눈다:
-- SELECT 는 읽기 정책 하나만, INSERT/UPDATE/DELETE 는 테넌트 정책만 둔다.
-- (UPDATE/DELETE 가 WHERE/RETURNING 으로 행을 읽을 때는 SELECT 정책도 걸린다.)
-- mem_digest 의 읽기 정책이 mem_evidence 를 조회하므로 mem_evidence 의 SELECT
-- 정책은 「테넌트」만이다(더 좁히면 하위 조회가 가려진 근거를 못 보고 NOT EXISTS
-- 가 잘못 통과한다). 근거 행은 id 만 담으며, API 는 읽을 수 있는 요약을 거쳐서만
-- 근거로 간다.
--
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL. 재실행 가능한 문장만 쓴다.
-- =============================================================================

-- ── 「채널 읽기 가능」 ───────────────────────────────────────────────────────────
-- GUC: app.workspace_id(테넌트 tx), app.member_id(읽는 사람; 082 선례). 둘 중
-- 하나라도 비어 있으면 NULL → false(닫힌 쪽). SECURITY INVOKER: BYPASSRLS 역할이
-- 불러도 워크스페이스 일치를 함수 본문이 스스로 확인한다.
CREATE OR REPLACE FUNCTION mem_can_read_channel(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT true
      FROM membership ms
      JOIN member viewer
        ON viewer.id = ms.member_id
       AND viewer.workspace_id = ms.workspace_id
       AND viewer.status = 'active'
       AND viewer.deleted_at IS NULL
     WHERE ms.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
       AND ms.channel_id = p_channel_id
       AND ms.member_id = nullif(current_setting('app.member_id', true), '')::uuid
       AND ms.left_at IS NULL
     LIMIT 1
  ), false)
$$;

COMMENT ON FUNCTION mem_can_read_channel(uuid) IS
  'ADR-0196 D6 / #3161 R1. Can app.member_id read this channel now? membership.left_at IS NULL (== is_channel_member) + active undeleted member (== search.rs). Unset GUC => false.';

-- 여러 근거 채널을 전부 읽을 수 있어야 true. 빈 배열은 false(근거 없는 행은 안 보인다).
CREATE OR REPLACE FUNCTION mem_can_read_channels(p_channel_ids uuid[])
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(cardinality(p_channel_ids), 0) > 0
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_channel_ids) AS c(id)
        WHERE NOT mem_can_read_channel(c.id)
     )
$$;

COMMENT ON FUNCTION mem_can_read_channels(uuid[]) IS
  'ADR-0196 D6-2. All listed channels readable (intersection rule). Empty/NULL => false.';

-- ── mem_digest ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mem_digest (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 가장 좁은 곳: 요약이 저장되는 채널 하나(D6-1). 근거 채널 전체는 mem_evidence.
  channel_id      uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  thread_root_id  uuid REFERENCES message(id) ON DELETE CASCADE,
  level           text NOT NULL,
  -- 채널 seq 구간(양끝 포함). 롤업도 자기가 덮는 구간을 그대로 가진다.
  from_seq        bigint NOT NULL,
  to_seq          bigint NOT NULL,
  body            text NOT NULL,
  -- 창: 읽은 메시지 수 / 롤업: 합친 하위 요약 수
  source_count    integer NOT NULL DEFAULT 0,
  -- 롤업 계보(일 ← 창, 주 ← 일). FK 없음: 창 요약은 90일 뒤 지워진다(D10).
  source_digest_ids uuid[] NOT NULL DEFAULT '{}',
  -- 모델 출처(#3162 가 채움). ADR-0147 「기본 AI」 summary 행이 고른 모델.
  model           text,
  model_source    text,
  prompt_version  text NOT NULL,
  -- 삭제 메시지를 포함해 다시 만들어야 함(D6-5). 읽기 정책과 별개의 재생성 표지.
  stale           boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
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

-- ── mem_evidence ───────────────────────────────────────────────────────────────
-- digest_id | item_id 정확히 하나. item_id 의 FK 는 mem_item 이 생기는 M2 가 붙인다.
CREATE TABLE IF NOT EXISTS mem_evidence (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  digest_id     uuid REFERENCES mem_digest(id) ON DELETE CASCADE,
  item_id       uuid,
  message_id    uuid NOT NULL REFERENCES message(id),
  -- 그 메시지의 채널(비정규화). 읽기 정책이 message.channel_id 와의 일치를 확인한다.
  channel_id    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_evidence_owner_ck
    CHECK ((digest_id IS NOT NULL) <> (item_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_evidence_digest_msg_uq
  ON mem_evidence (digest_id, message_id) WHERE digest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_evidence_digest_idx
  ON mem_evidence (digest_id) WHERE digest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_evidence_message_idx
  ON mem_evidence (message_id);

-- ── mem_cursor ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mem_cursor (
  channel_id     uuid PRIMARY KEY REFERENCES channel(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 요약 적용과 같은 tx 에서만 전진한다(#3162; 충돌 시 구간 누락 방지).
  last_seq       bigint NOT NULL DEFAULT 0,
  lease_token    uuid,
  leased_until   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_cursor_last_seq_ck CHECK (last_seq >= 0),
  CONSTRAINT mem_cursor_lease_ck CHECK ((lease_token IS NULL) = (leased_until IS NULL))
);
CREATE INDEX IF NOT EXISTS mem_cursor_ws_idx ON mem_cursor (workspace_id);

-- ── mem_serving ────────────────────────────────────────────────────────────────
-- run 하나에 영수증 하나. channel_id 는 ADR 칼럼 목록에 없는 추가분: 답이 올라간
-- 채널. 영수증은 그 채널을 읽을 수 있는 사람에게만 보인다(D7 「답글의 칩」).
CREATE TABLE IF NOT EXISTS mem_serving (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL UNIQUE REFERENCES agent_run(id) ON DELETE CASCADE,
  channel_id     uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  digest_ids     uuid[] NOT NULL DEFAULT '{}',
  item_ids       uuid[] NOT NULL DEFAULT '{}',
  -- 청중 규칙으로 싣지 않은 개수만(내용 없음). RLS 가 가린 행은 세지 않는다.
  withheld_count integer NOT NULL DEFAULT 0,
  budget_chars   integer NOT NULL DEFAULT 0,
  used_chars     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_serving_counts_ck
    CHECK (withheld_count >= 0 AND budget_chars >= 0 AND used_chars >= 0)
);
CREATE INDEX IF NOT EXISTS mem_serving_channel_idx
  ON mem_serving (workspace_id, channel_id, created_at DESC);

-- ── mem_settings ───────────────────────────────────────────────────────────────
-- 한 테이블, scope 로 구분. 칼럼이 적용되지 않는 scope 에서는 기본값이어야 한다.
--   workspace: enabled(D9 스위치; 기본 켜짐), paused, daily_token_cap, reset_epoch
--   channel:   excluded(채널 제외), paused
--   member:    paused(개인 일시정지; 본인만 읽고 쓴다)
CREATE TABLE IF NOT EXISTS mem_settings (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  scope            text NOT NULL,
  channel_id       uuid REFERENCES channel(id) ON DELETE CASCADE,
  member_id        uuid REFERENCES member(id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT true,
  paused           boolean NOT NULL DEFAULT false,
  excluded         boolean NOT NULL DEFAULT false,
  daily_token_cap  integer,
  reset_epoch      bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
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

-- ── RLS ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_digest', 'mem_evidence', 'mem_cursor', 'mem_serving', 'mem_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- 쓰기(INSERT/UPDATE/DELETE): 테넌트만. 누가 쓸 수 있는지는 경로(요약 워커·라우트)의
-- 몫이다. 읽기: 아래 명령별 정책.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_digest', 'mem_evidence', 'mem_cursor', 'mem_serving'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_ins', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR INSERT
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
    $f$, t || '_ins', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_upd', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR UPDATE
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
    $f$, t || '_upd', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_del', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR DELETE
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
    $f$, t || '_del', t);
  END LOOP;
END $$;

-- mem_cursor / mem_evidence: 내용이 없는 id·워터마크. SELECT 는 테넌트만
-- (mem_evidence 사유는 파일 머리말 참고).
DROP POLICY IF EXISTS mem_cursor_sel ON mem_cursor;
CREATE POLICY mem_cursor_sel ON mem_cursor FOR SELECT
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_evidence_sel ON mem_evidence;
CREATE POLICY mem_evidence_sel ON mem_evidence FOR SELECT
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- mem_digest 읽기(D6-2): 저장 채널을 읽을 수 있고, 근거가 1개 이상 있고, 근거 전부가
-- (읽을 수 있는 채널의, 그 채널에 속한, 삭제되지 않은 메시지)일 때만 보인다.
-- 하나라도 어긋나면 행 전체가 가려진다(교집합). 삭제는 deleted_at 또는 state
-- (interaction.rs:1053 가 둘 다 세운다). 근거 행 없음도 가림(닫힌 쪽).
DROP POLICY IF EXISTS mem_digest_sel ON mem_digest;
CREATE POLICY mem_digest_sel ON mem_digest FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_can_read_channel(channel_id)
    AND EXISTS (
      SELECT 1 FROM mem_evidence ev WHERE ev.digest_id = mem_digest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM mem_evidence ev
       WHERE ev.digest_id = mem_digest.id
         AND NOT (
           mem_can_read_channel(ev.channel_id)
           AND EXISTS (
             SELECT 1 FROM message m
              WHERE m.id = ev.message_id
                AND m.channel_id = ev.channel_id
                AND m.deleted_at IS NULL
                AND m.state <> 'deleted'
           )
         )
    )
  );

-- mem_serving 읽기(D7): 답이 올라간 채널을 읽을 수 있는 사람.
DROP POLICY IF EXISTS mem_serving_sel ON mem_serving;
CREATE POLICY mem_serving_sel ON mem_serving FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_can_read_channel(channel_id)
  );

-- mem_settings: 워크스페이스·채널 행은 테넌트 전원, 개인 행은 본인만(082 선례).
-- 관리자만 바꾸는 규칙은 라우트가 집행한다. 개인 행은 DB 도 본인만 쓰게 한다.
DROP POLICY IF EXISTS mem_settings_scope ON mem_settings;
CREATE POLICY mem_settings_scope ON mem_settings
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND (scope <> 'member'
         OR member_id = nullif(current_setting('app.member_id', true), '')::uuid)
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND (scope <> 'member'
         OR member_id = nullif(current_setting('app.member_id', true), '')::uuid)
  );

-- ── 자기 검사: ENABLE + FORCE 와 명령별 정책 누락을 마이그레이션이 스스로 거부 ────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_digest', 'mem_evidence', 'mem_cursor', 'mem_serving', 'mem_settings'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND c.relname = t
         AND c.relrowsecurity
         AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '% is missing FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
