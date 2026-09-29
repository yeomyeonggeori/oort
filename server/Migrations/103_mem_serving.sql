-- =============================================================================
-- 103_mem_serving.sql — #3163 / ADR-0196 (팀 기억 v2) M1 서빙: 요약을 에이전트 컨텍스트에 싣는다
--
-- 에이전트 워커가 한 턴의 컨텍스트를 만들 때 「이 답에 실어도 되는 요약」을 읽는 DB 면.
-- 새 테이블은 없다(mem_serving 은 100 의 것). 새 함수 둘, 전부 SECURITY DEFINER · 소유자
-- mem_definer · EXECUTE 는 momo_memory 에만(워커가 tx 마다 SET LOCAL ROLE momo_memory 로 부른다).
--
--   mem_serve_requester   이 run 의 「묻는 사람」. 잡 페이로드가 아니라 DB 가 정한다(M-2):
--                         agent_run.trigger_message_id → message.author_member_id(활성 human).
--                         트리거가 없거나(환영·예약·작업 run) 에이전트가 쓴 것이면 parent_run_id →
--                         (없으면) 트리거 메시지를 쓴 run(message.run_id) 순으로 사슬을 오르며 가장
--                         가까운 사람을 찾는다(깊이 8). 없으면 NULL.
--   mem_serve_candidates  그 요청자에게 이 run 의 답에 실어도 되는 요약(청중 규칙 통과분)과,
--                         「요청자는 읽을 수 있지만 청중 규칙 때문에 못 싣는」 개수(보류).
--
-- 규칙(ADR-0196 D6-4 · D7 · D9):
--   * 스위치: 워크스페이스 enabled/paused · 답 채널 excluded/paused(mem_channel_switch) ·
--     요청자의 개인 일시정지. 하나라도 걸리면 행이 0개(보류도 0) — 영수증을 남길 일이 없다.
--   * 요청자가 없으면(NULL) 아무것도 싣지 않는다. mem_digest_audience_ok 가 요청자 NULL 에
--     false 라서 같은 채널 요약도 실리지 않는다 — 환영·예약 run 은 사람의 질문이 아니다.
--   * 싣는 것 = 요청자가 읽을 수 있고(저장 채널 + 모든 근거 채널, stale·삭제·수정 없음, 원천
--     채널의 스위치 통과) AND mem_digest_audience_ok(요약, 답 채널, 요청자). 사후 필터가 아니라
--     이 SQL 안에서 가른다.
--   * 겹침 제거: 일 요약이 자기 창 요약들을, 주 요약이 일 요약들을 덮는다(source_digest_ids).
--     실을 수 있는 롤업이 있으면 그 원천은 뺀다(같은 내용을 두 번 싣지 않는다). 롤업이 못
--     실리면(청중 규칙) 원천은 그대로 실릴 수 있다.
--   * 순서: 이 run 이 스레드 안이면 그 스레드 요약 먼저 → 답 채널 자신의 요약 → 최근 구간(to_seq)
--     순. p_before_seq 는 대화 창이 이미 싣는 구간(창의 가장 오래된 seq)보다 앞에서 시작하는
--     답 채널 요약만 남긴다(중복 절감이지 권한이 아니다).
--   * 보류 개수는 스캔 범위가 있다: 요청자가 읽을 수 있는 가장 최근 요약 200개(SCAN). 그보다 오래된
--     것은 서빙에도 보류에도 세지 않는다. RLS 가 가린(읽을 수 없는) 행은 세지 않는다(D7).
--
-- 재실행 가능한 문장만 쓴다. schema_v0.sql · 100~102 는 고치지 않는다.
-- =============================================================================

-- ── 묻는 사람 ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mem_serve_requester(p_run_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE chain (run_id, trigger_message_id, parent_run_id, depth) AS (
    SELECT r.id, r.trigger_message_id, r.parent_run_id, 0
      FROM public.agent_run r
     WHERE r.id = p_run_id
       AND r.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
    UNION ALL
    SELECT n.id, n.trigger_message_id, n.parent_run_id, c.depth + 1
      FROM chain c
      JOIN public.agent_run n
        ON n.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
       AND n.id = COALESCE(
             c.parent_run_id,
             (SELECT tm.run_id FROM public.message tm
               WHERE tm.id = c.trigger_message_id
                 AND tm.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid))
     WHERE c.depth < 8
  )
  SELECT m.author_member_id
    FROM chain c
    JOIN public.message m
      ON m.id = c.trigger_message_id
     AND m.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
    JOIN public.member mm
      ON mm.id = m.author_member_id
     AND mm.workspace_id = m.workspace_id
     AND mm.kind = 'human' AND mm.status = 'active' AND mm.deleted_at IS NULL
   ORDER BY c.depth
   LIMIT 1
$$;

-- ── 서빙 후보 ──────────────────────────────────────────────────────────────────
-- 항상 최소 한 행을 돌려준다(실을 게 없어도 보류 개수를 알리기 위해: digest_id 가 NULL). 스위치가
-- 걸렸거나 요청자가 없으면 행이 없다.
DROP FUNCTION IF EXISTS mem_serve_candidates(uuid, bigint, integer, integer);
CREATE OR REPLACE FUNCTION mem_serve_candidates(
  p_run_id uuid, p_before_seq bigint, p_limit integer, p_body_max integer)
RETURNS TABLE (
  requester_member_id uuid,
  digest_id           uuid,
  digest_channel_id   uuid,
  thread_root_id      uuid,
  level               text,
  from_seq            bigint,
  to_seq              bigint,
  covered_from        timestamptz,
  covered_to          timestamptz,
  body                text,
  withheld_count      integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_channel uuid;
  v_trigger uuid;
  v_req uuid;
  v_root uuid;
  v_limit integer := least(greatest(COALESCE(p_limit, 12), 1), 50);
  v_body_max integer := least(greatest(COALESCE(p_body_max, 3000), 100), 20000);
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_serve_candidates: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  SELECT r.channel_id, r.trigger_message_id INTO v_channel, v_trigger
    FROM public.agent_run r
   WHERE r.id = p_run_id AND r.workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_serve_candidates: run not in workspace' USING ERRCODE = '23503';
  END IF;

  v_req := public.mem_serve_requester(p_run_id);
  IF v_req IS NULL THEN
    RETURN;
  END IF;
  -- 스위치(D9): 워크스페이스 · 답 채널 · 요청자 개인.
  IF NOT public.mem_channel_switch(v_channel) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.mem_settings s
              WHERE s.workspace_id = v_ws AND s.scope = 'member'
                AND s.member_id = v_req AND s.paused) THEN
    RETURN;
  END IF;
  IF NOT public.mem_member_can_read(v_channel, v_req) THEN
    RETURN;
  END IF;
  -- 스레드 안에서 부른 run 이면 그 스레드(트리거 메시지의 root_id)를 먼저 싣는다.
  SELECT tm.root_id INTO v_root FROM public.message tm
   WHERE tm.id = v_trigger AND tm.workspace_id = v_ws;

  RETURN QUERY
  WITH readable AS (
    -- SCAN: 요청자가 지금 읽을 수 있는 가장 최근 요약 200개.
    SELECT d.*
      FROM public.mem_digest d
     WHERE d.workspace_id = v_ws
       AND NOT d.stale
       AND public.mem_member_can_read(d.channel_id, v_req)
       AND public.mem_channel_switch(d.channel_id)
       AND public.mem_digest_live(d.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.mem_evidence ev
          WHERE ev.digest_id = d.id AND ev.workspace_id = v_ws
            AND NOT public.mem_member_can_read(ev.channel_id, v_req))
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT 200
  ), scored AS (
    SELECT rd.*, public.mem_digest_audience_ok(rd.id, v_channel, v_req) AS servable
      FROM readable rd
  ), served AS (
    SELECT s.*,
           pg_catalog.row_number() OVER (
             ORDER BY (v_root IS NOT NULL AND s.thread_root_id IS NOT DISTINCT FROM v_root) DESC,
                      (s.channel_id = v_channel) DESC,
                      s.to_seq DESC, s.created_at DESC, s.id DESC) AS rn
      FROM scored s
     WHERE s.servable
       AND (s.channel_id <> v_channel OR p_before_seq IS NULL OR s.from_seq < p_before_seq)
       AND NOT EXISTS (SELECT 1 FROM scored x
                        WHERE x.servable AND s.id = ANY (x.source_digest_ids))
  ), top AS (
    SELECT * FROM served WHERE served.rn <= v_limit
  ), wh AS (
    SELECT pg_catalog.count(*)::integer AS n
      FROM scored s
     WHERE NOT s.servable
       AND NOT EXISTS (SELECT 1 FROM scored x
                        WHERE NOT x.servable AND s.id = ANY (x.source_digest_ids))
  )
  SELECT v_req, t.id, t.channel_id, t.thread_root_id, t.level, t.from_seq, t.to_seq,
         (SELECT pg_catalog.min(m.created_at) FROM public.mem_evidence ev
            JOIN public.message m ON m.id = ev.message_id AND m.workspace_id = ev.workspace_id
           WHERE ev.digest_id = t.id AND ev.workspace_id = v_ws),
         (SELECT pg_catalog.max(m.created_at) FROM public.mem_evidence ev
            JOIN public.message m ON m.id = ev.message_id AND m.workspace_id = ev.workspace_id
           WHERE ev.digest_id = t.id AND ev.workspace_id = v_ws),
         pg_catalog.left(t.body, v_body_max),
         wh.n
    FROM wh LEFT JOIN top t ON true
   ORDER BY t.rn NULLS LAST;
END
$$;

-- ── 소유자·권한 ────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO mem_definer;
GRANT CREATE ON SCHEMA public TO mem_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_serve_requester(uuid)',
    'mem_serve_candidates(uuid, bigint, integer, integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO mem_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- 정의자가 읽는 표면(100/102 가 이미 준 것 + 이 함수들이 쓰는 mem_settings/mem_evidence/mem_digest).
-- agent_run · message · member · membership 의 SELECT 는 100 이 mem_definer 에게 줬다.

-- 런타임 역할 권한: 101 의 공용 잠금 블록(부트스트랩과 글자 그대로 같음)은 건드리지 않고 이
-- 파일이 만든 함수만 직접 잠근다(102 와 같은 방식).
DO $$
DECLARE
  r text;
  f text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
  worker_only text[] := ARRAY[
    'mem_serve_requester(uuid)',
    'mem_serve_candidates(uuid, bigint, integer, integer)'
  ];
BEGIN
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
  FOR f IN SELECT p.proname FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.prosecdef AND p.proname LIKE 'mem\_%'
              AND pg_get_userbyid(p.proowner) <> 'mem_definer' LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % is not owned by mem_definer', f;
  END LOOP;
END $$;

-- ── L-1: mem_definer 소유 SECURITY DEFINER 함수 허용 목록 (102 것 + 이 파일의 2개) ───────
-- 102 는 머지된 마이그레이션이라 고치지 않는다. 새 정의자 함수를 만들면 이 목록과 시험
-- (mem_schema_conformance_pg.rs 의 DEFINER_ALLOW_LIST)에 이름을 올려야 한다. 목록 밖 함수는
-- RLS 를 우회하는 새 통로이므로 여기서 멈춘다.
DO $$
DECLARE
  f text;
  allow text[] := ARRAY[
    'mem_digest_evidence_ok', 'mem_digest_live', 'mem_digest_audience_ok',
    'mem_digest_rollup_inputs', 'mem_channel_switch',
    'mem_apply_digest', 'mem_advance_cursor', 'mem_record_serving',
    'mem_channel_eligible', 'mem_cursor_state', 'mem_digest_index', 'mem_stale_digests',
    'mem_drop_digest', 'mem_token_budget', 'mem_reserve_tokens', 'mem_adjust_tokens',
    'mem_message_changed',
    'mem_serve_requester', 'mem_serve_candidates'
  ];
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'mem_definer'
              AND p.proname <> ALL (allow) LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % owned by mem_definer is not in the allow-list', f;
  END LOOP;
END $$;
