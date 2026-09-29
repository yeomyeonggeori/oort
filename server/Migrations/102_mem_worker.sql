-- =============================================================================
-- 102_mem_worker.sql — #3162 / ADR-0196 (팀 기억 v2) M1 요약 워커가 쓰는 DB 면
--
-- 100_mem_digest.sql 의 워커 계약(momo_memory 만 EXECUTE, 함수가 정의자 권한으로 기록)을
-- 지키면서, 요약 워커가 「읽어야만 하는 것」과 「스스로 닫을 수 없는 경쟁」을 채운다.
--
--   1. mem_channel_eligible   요약해도 되는 채널인가 — mem_channel_switch + 보관 여부 +
--                             DM 규칙(D9-③: 사람끼리 DM 제외, 사람↔에이전트 DM 만, 개인 일시정지 존중).
--                             mem_apply_digest 도 이 함수를 통과해야 기록한다(DB 가 집행).
--   2. mem_cursor_state       워터마크·리스·채널 헤드(mem_cursor 를 momo_memory 가 못 읽으므로).
--   3. mem_digest_index       채널의 요약 색인(스레드 진행·롤업 존재 확인). 본문·근거는 주지 않는다.
--   4. mem_stale_digests      stale 요약의 재생성 대상.
--   5. mem_drop_digest        stale 이면서 되살릴 원문이 하나도 없는 요약을 지운다(stale 만).
--   6. mem_usage + mem_token_budget / mem_reserve_tokens / mem_adjust_tokens
--                             워크스페이스 일일 토큰 상한(plan §6.6). 상한은 mem_settings.daily_token_cap.
--   7. L-2 (보안 검수 #3185): 메시지가 수정·삭제되면 같은 tx 안에서 그 메시지를 근거로 든
--      요약을 stale 로 표시하고, 채널 단위 advisory lock 으로 mem_apply_digest 와 직렬화한다.
--      apply 가 먼저면 편집 tx 가 락 뒤에서 방금 커밋된 근거를 보고 stale 로 만들고,
--      편집이 먼저면 apply 가 락 뒤에서 edited_at 스냅샷 불일치(40001)를 만난다. 읽기 정책의
--      `edited_at <= evidence.created_at` 만으로는 「읽은 뒤 커밋된 편집」을 못 잡던 틈이다.
--
-- 새 함수는 전부 SECURITY DEFINER · 소유자 mem_definer · EXECUTE 는 momo_memory 에만.
-- 재실행 가능한 문장만 쓴다. schema_v0.sql 은 불변.
-- =============================================================================

-- ── 일일 토큰 사용량 (테넌트 테이블, RLS FORCE) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS mem_usage (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- UTC 날짜. 워크스페이스 시간대와 무관하게 한 날의 경계를 하나로 둔다.
  day           date NOT NULL,
  tokens        bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, day),
  CONSTRAINT mem_usage_tokens_ck CHECK (tokens >= 0)
);
GRANT SELECT, INSERT, UPDATE ON mem_usage TO mem_definer;
ALTER TABLE mem_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE mem_usage FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mem_usage_sel ON mem_usage;
CREATE POLICY mem_usage_sel ON mem_usage FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_is_workspace_admin()
  );
DROP POLICY IF EXISTS mem_usage_sel_definer ON mem_usage;
CREATE POLICY mem_usage_sel_definer ON mem_usage FOR SELECT TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_usage_ins ON mem_usage;
CREATE POLICY mem_usage_ins ON mem_usage FOR INSERT TO mem_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_usage_upd ON mem_usage;
CREATE POLICY mem_usage_upd ON mem_usage FOR UPDATE TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT USAGE ON SCHEMA public TO mem_definer;
GRANT CREATE ON SCHEMA public TO mem_definer;

-- ── 요약해도 되는 채널인가 ──────────────────────────────────────────────────────────
-- 워크스페이스·채널 스위치(mem_channel_switch) + 보관 안 됨 + DM 규칙.
--   * 공개·비공개 채널: 스위치만.
--   * DM: 활성 에이전트가 참여한 DM 만(사람↔에이전트). 사람끼리 DM 은 제외한다 — 「참여자
--     전원이 켜야 포함」하는 옵트인 설정이 아직 없으므로 기본 제외가 유일한 안전한 값이다.
--     참여한 사람 누구라도 개인 일시정지(mem_settings scope=member)면 제외한다.
CREATE OR REPLACE FUNCTION mem_channel_eligible(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT public.mem_channel_switch(c.id)
       AND c.archived_at IS NULL
       AND (
         c.kind <> 'dm'
         OR (
           EXISTS (
             SELECT 1 FROM public.membership x
               JOIN public.member mm ON mm.id = x.member_id AND mm.workspace_id = x.workspace_id
              WHERE x.channel_id = c.id AND x.workspace_id = c.workspace_id
                AND x.left_at IS NULL
                AND mm.kind = 'agent' AND mm.status = 'active' AND mm.deleted_at IS NULL)
           AND NOT EXISTS (
             SELECT 1 FROM public.membership x
               JOIN public.mem_settings s
                 ON s.workspace_id = x.workspace_id AND s.scope = 'member'
                AND s.member_id = x.member_id AND s.paused
              WHERE x.channel_id = c.id AND x.workspace_id = c.workspace_id
                AND x.left_at IS NULL)
         )
       )
      FROM public.channel c
     WHERE c.id = p_channel_id
       AND c.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  ), false)
$$;

-- ── 워터마크·리스·헤드 ─────────────────────────────────────────────────────────────
-- 커서 행이 없으면 last_seq = 0, 리스 없음. head_seq 는 채널 헤드(없는 채널이면 0 행).
CREATE OR REPLACE FUNCTION mem_cursor_state(p_channel_id uuid)
RETURNS TABLE (last_seq bigint, lease_token uuid, leased_until timestamptz, head_seq bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(c.last_seq, 0), c.lease_token, c.leased_until, cs.last_seq
    FROM public.channel_seq cs
    LEFT JOIN public.mem_cursor c
      ON c.channel_id = cs.channel_id AND c.workspace_id = cs.workspace_id
   WHERE cs.channel_id = p_channel_id
     AND cs.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
$$;

-- ── 요약 색인 ─────────────────────────────────────────────────────────────────────
-- 한 채널의 특정 레벨 요약(to_seq >= p_from_seq). 본문·근거는 주지 않는다.
CREATE OR REPLACE FUNCTION mem_digest_index(p_channel_id uuid, p_level text, p_from_seq bigint)
RETURNS TABLE (id uuid, thread_root_id uuid, from_seq bigint, to_seq bigint, stale boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.id, d.thread_root_id, d.from_seq, d.to_seq, d.stale
    FROM public.mem_digest d
   WHERE d.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
     AND d.channel_id = p_channel_id
     AND d.level = p_level
     AND d.to_seq >= COALESCE(p_from_seq, 0)
   ORDER BY d.to_seq
   LIMIT 2000
$$;

-- ── stale 재생성 대상 ──────────────────────────────────────────────────────────────
-- 창 → 일 → 주 순(하위가 먼저 다시 만들어져야 롤업이 그 위에 선다).
CREATE OR REPLACE FUNCTION mem_stale_digests(p_limit integer)
RETURNS TABLE (id uuid, channel_id uuid, thread_root_id uuid, level text, from_seq bigint, to_seq bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.id, d.channel_id, d.thread_root_id, d.level, d.from_seq, d.to_seq
    FROM public.mem_digest d
   WHERE d.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
     AND d.stale
   ORDER BY CASE d.level WHEN 'window' THEN 0 WHEN 'day' THEN 1 ELSE 2 END, d.to_seq
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500)
$$;

-- stale 요약만 지운다(살아 있는 요약은 이 함수로 지울 수 없다).
CREATE OR REPLACE FUNCTION mem_drop_digest(p_digest_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_drop_digest: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.mem_digest d
   WHERE d.id = p_digest_id AND d.workspace_id = v_ws AND d.stale;
  RETURN FOUND;
END
$$;

-- ── 일일 토큰 상한 (plan §6.6) ─────────────────────────────────────────────────────
-- 상한: mem_settings(scope=workspace).daily_token_cap, 없으면 호출자가 준 기본값.
CREATE OR REPLACE FUNCTION mem_token_budget(p_default_cap bigint)
RETURNS TABLE (cap bigint, used bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
           (SELECT s.daily_token_cap::bigint FROM public.mem_settings s
             WHERE s.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
               AND s.scope = 'workspace'),
           p_default_cap),
         COALESCE(
           (SELECT u.tokens FROM public.mem_usage u
             WHERE u.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
               AND u.day = (pg_catalog.now() AT TIME ZONE 'UTC')::date),
           0)
$$;

-- LLM 을 부르기 전에 예상 토큰을 예약한다. 상한을 넘기면 false(아무것도 더하지 않음).
CREATE OR REPLACE FUNCTION mem_reserve_tokens(p_tokens bigint, p_default_cap bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_day date := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
  v_cap bigint;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_reserve_tokens: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_tokens IS NULL OR p_tokens < 0 THEN
    RAISE EXCEPTION 'mem_reserve_tokens: bad amount' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(
           (SELECT s.daily_token_cap::bigint FROM public.mem_settings s
             WHERE s.workspace_id = v_ws AND s.scope = 'workspace'),
           p_default_cap) INTO v_cap;
  IF v_cap IS NULL THEN
    RAISE EXCEPTION 'mem_reserve_tokens: no cap' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.mem_usage (workspace_id, day, tokens) VALUES (v_ws, v_day, 0)
    ON CONFLICT (workspace_id, day) DO NOTHING;
  UPDATE public.mem_usage
     SET tokens = tokens + p_tokens, updated_at = pg_catalog.now()
   WHERE workspace_id = v_ws AND day = v_day AND tokens + p_tokens <= v_cap;
  RETURN FOUND;
END
$$;

-- 호출이 끝난 뒤 실제 사용량과 예약의 차이를 반영한다(음수면 돌려준다). 0 미만으로는 내려가지 않는다.
CREATE OR REPLACE FUNCTION mem_adjust_tokens(p_delta bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_day date := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
  v_tokens bigint;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_adjust_tokens: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.mem_usage (workspace_id, day, tokens) VALUES (v_ws, v_day, 0)
    ON CONFLICT (workspace_id, day) DO NOTHING;
  UPDATE public.mem_usage
     SET tokens = GREATEST(tokens + COALESCE(p_delta, 0), 0), updated_at = pg_catalog.now()
   WHERE workspace_id = v_ws AND day = v_day
  RETURNING tokens INTO v_tokens;
  RETURN v_tokens;
END
$$;

-- ── L-2: 수정·삭제 → stale, 그리고 apply 와의 직렬화 ────────────────────────────────
-- 채널 단위 advisory lock 키. apply 는 shared, 이 트리거는 exclusive 로 잡는다.
-- 트리거 함수는 SECURITY DEFINER 라 mem_definer 의 UPDATE 정책(테넌트 GUC 필요)을 탄다 —
-- 편집 tx 는 API 의 테넌트 tx 라 GUC 가 이미 그 워크스페이스로 잡혀 있지만, GUC 가 비어 있는
-- 경로(관리 스크립트)에서도 조용히 0행이 되지 않게 이 행의 워크스페이스로 잠시 맞췄다 되돌린다.
CREATE OR REPLACE FUNCTION mem_message_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_prev text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mem_digest:' || OLD.channel_id::text, 0));
  v_prev := pg_catalog.current_setting('app.workspace_id', true);
  PERFORM pg_catalog.set_config('app.workspace_id', OLD.workspace_id::text, true);
  UPDATE public.mem_digest d
     SET stale = true
   WHERE d.workspace_id = OLD.workspace_id
     AND d.channel_id = OLD.channel_id
     AND NOT d.stale
     AND EXISTS (SELECT 1 FROM public.mem_evidence e
                  WHERE e.digest_id = d.id AND e.workspace_id = d.workspace_id
                    AND e.message_id = OLD.id);
  PERFORM pg_catalog.set_config('app.workspace_id', COALESCE(v_prev, ''), true);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS mem_message_changed_trg ON message;

-- mem_apply_digest: 100 의 정의에 (1) 채널 shared advisory lock, (2) mem_channel_eligible
-- 를 더했다. 나머지 검증은 그대로다.
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
  -- L-2: 이 채널의 수정·삭제 트리거(exclusive)와 직렬화한다. 이후 문장은 락을 얻은 뒤의
  -- 새 스냅샷으로 돈다(READ COMMITTED) — 먼저 커밋된 편집은 아래 40001 검사가 잡는다.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_digest:' || p_channel_id::text, 0));
  -- 스위치(D9)·DM 규칙: 꺼졌거나 정지·제외·보관됐거나 사람끼리 DM 이면 기록하지 않는다.
  IF NOT public.mem_channel_eligible(p_channel_id) THEN
    RAISE EXCEPTION 'mem_apply_digest: memory is disabled, paused, excluded or not allowed for this channel'
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
  IF p_read_at IS NULL OR p_read_at > pg_catalog.now()
     OR p_evidence_edited_at IS NULL
     OR pg_catalog.cardinality(p_evidence_edited_at) <> v_n
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_evidence_edited_at) AS t(x) WHERE t.x > p_read_at) THEN
    RAISE EXCEPTION 'mem_apply_digest: bad read snapshot (read_at / per-evidence edited_at)'
      USING ERRCODE = '23514';
  END IF;
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
  IF EXISTS (SELECT 1
               FROM ROWS FROM (pg_catalog.unnest(p_evidence_message_ids), pg_catalog.unnest(p_evidence_edited_at)) AS s(mid, snap)
               JOIN public.message m ON m.id = s.mid
              WHERE m.edited_at IS DISTINCT FROM s.snap) THEN
    RAISE EXCEPTION 'mem_apply_digest: evidence was edited after it was read' USING ERRCODE = '40001';
  END IF;
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

-- ── 소유자·권한 ────────────────────────────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_channel_eligible(uuid)', 'mem_cursor_state(uuid)',
    'mem_digest_index(uuid, text, bigint)', 'mem_stale_digests(integer)',
    'mem_drop_digest(uuid)', 'mem_token_budget(bigint)',
    'mem_reserve_tokens(bigint, bigint)', 'mem_adjust_tokens(bigint)',
    'mem_message_changed()',
    'mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO mem_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- 트리거는 함수 소유자 권한이 아니라 CREATE TRIGGER 시점의 권한만 본다. 그래서 직접 호출은
-- 막아 둔다(트리거 함수는 어차피 SQL 에서 부를 수 없다).
REVOKE ALL ON FUNCTION mem_message_changed() FROM PUBLIC;

-- 수정·삭제만 잡는다. 스트리밍 본문 갱신(edited_at 불변)은 이 트리거를 타지 않는다.
CREATE TRIGGER mem_message_changed_trg
  BEFORE UPDATE ON message
  FOR EACH ROW
  WHEN (OLD.edited_at IS DISTINCT FROM NEW.edited_at
        OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
        OR (NEW.state = 'deleted' AND OLD.state IS DISTINCT FROM NEW.state))
  EXECUTE FUNCTION mem_message_changed();

-- ── 런타임 역할 권한 (이 마이그레이션이 만든 객체만) ─────────────────────────────────
-- 공용 잠금 블록(101 의 BEGIN/END mem-lockdown, 부트스트랩 두 파일과 글자 그대로 같음)은 건드리지
-- 않는다: 그 블록은 이후 마이그레이션의 함수를 몰라도 되게 설계됐다(101 L-1 주석). 대신 여기서
-- 새 테이블 mem_usage 와 새 함수 9개를 직접 잠근다 — 워커 전용 함수는 momo_memory 에만 EXECUTE.
DO $$
DECLARE
  r text;
  f text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
  worker_only text[] := ARRAY[
    'mem_channel_eligible(uuid)',
    'mem_cursor_state(uuid)',
    'mem_digest_index(uuid, text, bigint)',
    'mem_stale_digests(integer)',
    'mem_drop_digest(uuid)',
    'mem_token_budget(bigint)',
    'mem_reserve_tokens(bigint, bigint)',
    'mem_adjust_tokens(bigint)',
    'mem_message_changed()',
    'mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)'
  ];
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE public.mem_usage FROM PUBLIC';
  FOREACH r IN ARRAY runtime_roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.mem_usage FROM %I', r);
    END IF;
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
END
$$;

-- ── 자기 검사 ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = 'mem_usage'
       AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'mem_usage is missing FORCE ROW LEVEL SECURITY';
  END IF;
  FOR f IN SELECT p.proname FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.prosecdef AND p.proname LIKE 'mem\_%'
              AND pg_get_userbyid(p.proowner) <> 'mem_definer' LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % is not owned by mem_definer', f;
  END LOOP;
END $$;
