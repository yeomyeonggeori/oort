-- =============================================================================
-- 107_mem_item_embedding.sql — #3173 / ADR-0196 D8 증보 (팀 기억 v2 M3): 항목 임베딩 + 융합 검색
--
-- 결정(성재, 2026-09-30): ② 로컬 임베딩(intfloat/multilingual-e5-small, int8 ONNX, 384차원)을
-- agent-worker 프로세스에서 돌린다. 브라우저(API) 검색은 M3에서 키워드만이다(API 프로세스는 모델을 싣지 않는다).
-- 융합은 가중 RRF(키워드×2 : 벡터×1, k=60)이고, 벡터는 「순위 신호」일 뿐이다 — 어떤 항목이 답에 실릴 수
-- 있는지는 여전히 mem_item_readable_by + mem_item_audience_ok(권한 정의는 하나)만 정한다.
--
-- ── 새 것 ──────────────────────────────────────────────────────────────────────
--   mem_item_embedding      (item_id, model) → vector(384). 테이블 권한 없음(임베딩은 본문 복원 위험이 있어 본문과
--                           같은 등급) — 읽기·쓰기 모두 정의자 함수로만. mem_item 삭제(잊기 포함)와 함께 CASCADE.
--   mem_set_item_embedding  워커 전용. 근거 항목이 이 워크스페이스에 살아 있을 때만, 멱등.
--   mem_items_to_embed      워커 전용. 아직 이 모델의 임베딩이 없는 살아 있는 항목(백필·신규·편집본이 한 길).
--                           뷰어 없이 워크스페이스의 살아 있는 항목 본문을 워커에 내준다 — 워커가 로컬에서 임베딩하기
--                           위해서이고(요약 워커는 이미 모든 채널의 메시지 본문을 읽는다) 프로세스 밖으로 나가는 것은 없다.
--   mem_embedding_stats     워커 전용. 살아 있는 항목 수·임베딩된 수(백필 진행·시험용).
--   mem_serve_gate          소유자 전용. mem_serve_items 의 스위치·요청자·질의 유도를 한 곳으로 모았다(아래).
--   mem_serve_query         워커 전용. 게이트를 통과한 run 의 질의 본문(트리거 메시지에서 @멘션 뺀 앞 400자)만
--                           돌려준다 — 워커가 임베딩할 텍스트가 DB 가 검색에 쓰는 텍스트와 같도록.
--   mem_search_items_fused  소유자 전용(mem_search_items_core 와 같은 이유, M-4). 본체.
--   mem_serve_items_fused   워커 전용. mem_serve_items 의 융합 판(요청자·답 채널·질의는 run 행에서 유도).
--
-- ── 바뀐 것 ───────────────────────────────────────────────────────────────────
--   mem_serve_items(uuid, integer, integer)  시그니처·반환 그대로, 본문만 mem_serve_gate 를 부른다. 키워드 전용
--                           폴백(임베딩 실패·모델 없음)이 융합 판과 같은 스위치·요청자를 쓰게 하려는 것이다.
--
-- ── 설계 결정 ──────────────────────────────────────────────────────────────────
--  * 칼럼이 아니라 별도 테이블(스파이크 §6-1): pgvector 는 차원이 고정된 타입을 요구하므로 모델 교체는 「다른 model
--    값의 새 행」으로 병행 백필한 뒤 전환한다. mem_item 은 손대지 않는다(추가만 원칙, 정의자 열 권한 그대로).
--  * 항목은 불변이라(수정은 새 curated 행 + 옛 행 retired) 한 번 만든 임베딩은 그 행의 수명 동안 유효하다.
--  * mem_digest 는 임베딩하지 않는다: 요약 서빙(mem_serve_candidates)은 청중 규칙이 고르는 방식이라 융합할 질의가
--    없다(M2 키워드 검색도 항목만 대상이다).
--  * ANN 색인(HNSW)을 만들지 않는다(스파이크 §3.5): 워크스페이스당 수천 행 규모에서는 멤버십으로 좁힌 행의 정확
--    스캔이 0.5~3 ms 이고, 필터 걸린 HNSW 는 기본 설정에서 재현율 0.10 이다. 수만 행을 넘으면 iterative_scan 과
--    함께 도입한다(후속).
--  * 필터를 top-N 앞에 둔다(L-3): 벡터 후보는 「멤버십으로 좁힌 행 → 거리순 → readable_by/audience 통과분 K개」
--    이고, 키워드 후보는 core 가 같은 방식으로 K개를 낸다. 융합은 이미 걸러진 두 목록 위에서만 한다.
--  * 문턱 둘: 최근접 이웃은 항상 있으므로 문턱이 없으면 무관한 항목이 실린다. e5 코사인은 좁은 대역에 몰려
--    있어(같은 분야 무관 항목도 0.79~0.86) 절대 문턱(p_min_similarity)만으로는 못 거른다 — 통과한 후보 중 가장
--    가까운 것에서 p_margin 이상 멀어지면 끊는 상대 문턱을 함께 쓰고, 키워드 후보에 없는 벡터 전용 항목은 3개까지만
--    싣는다(무관한 질문에도 「그나마 가까운」 항목이 한도까지 차는 것을 막는다). 문턱 값은 워커 설정이 정한다.
--
-- 재실행 가능한 문장만 쓴다. schema_v0.sql·100~106 은 고치지 않는다.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ── 테이블 ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mem_item_embedding (
  item_id       uuid NOT NULL REFERENCES mem_item(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  model         text NOT NULL,
  dims          integer NOT NULL,
  embedding     vector(384) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, model),
  CONSTRAINT mem_item_embedding_model_ck CHECK (char_length(model) BETWEEN 1 AND 100),
  CONSTRAINT mem_item_embedding_dims_ck CHECK (dims = 384)
);
-- 모델별 커버리지·워크스페이스 범위(정확 스캔은 (workspace_id, model)로 좁힌 행을 읽는다).
CREATE INDEX IF NOT EXISTS mem_item_embedding_ws_idx
  ON mem_item_embedding (workspace_id, model);

GRANT SELECT, INSERT ON mem_item_embedding TO mem_definer;

-- ── 서빙 게이트 (mem_serve_items 의 앞부분을 한 곳으로) ───────────────────────────────
-- 105 의 mem_serve_items 가 하던 것 그대로: 요청자(run 행에서 유도)·답 채널·스위치(워크스페이스·채널·요청자 개인
-- 일시정지)·요청자의 채널 읽기·질의(트리거 메시지에서 @멘션 뺀 앞 400자). 걸린 스위치·요청자 없음·질의 없음은 행 0개.
-- 소유자 전용 — 요청자를 돌려주므로 워커가 직접 부를 이유가 없다(mem_serve_query 가 질의만 내준다).
CREATE OR REPLACE FUNCTION mem_serve_gate(p_run_id uuid)
RETURNS TABLE (g_requester uuid, g_channel uuid, g_query text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_channel uuid;
  v_trigger uuid;
  v_req uuid;
  v_query text;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_serve_items: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  SELECT r.channel_id, r.trigger_message_id INTO v_channel, v_trigger
    FROM public.agent_run r WHERE r.id = p_run_id AND r.workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_serve_items: run not in workspace' USING ERRCODE = '23503';
  END IF;
  v_req := public.mem_serve_requester(p_run_id);
  IF v_req IS NULL THEN
    RETURN;
  END IF;
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
  SELECT pg_catalog.regexp_replace(pg_catalog.left(COALESCE(tm.body, ''), 400), '@[^[:space:]]+', ' ', 'g')
    INTO v_query
    FROM public.message tm
   WHERE tm.id = v_trigger AND tm.workspace_id = v_ws AND tm.deleted_at IS NULL;
  IF v_query IS NULL OR pg_catalog.btrim(v_query) = '' THEN
    RETURN;
  END IF;
  g_requester := v_req;
  g_channel := v_channel;
  g_query := v_query;
  RETURN NEXT;
END
$$;

CREATE OR REPLACE FUNCTION mem_serve_query(p_run_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT g.g_query FROM public.mem_serve_gate(p_run_id) g
$$;

-- 105 판과 같은 시그니처·같은 반환. 게이트만 위 함수로 옮겼다(스위치가 두 곳에서 어긋나지 않게).
CREATE OR REPLACE FUNCTION mem_serve_items(p_run_id uuid, p_limit integer, p_body_max integer)
RETURNS TABLE (
  requester_member_id uuid,
  answer_channel_id   uuid,
  item_id             uuid,
  item_channel_id     uuid,
  space_kind          text,
  kind                text,
  origin              text,
  body                text,
  valid_from          timestamptz,
  source_count        integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_req uuid;
  v_channel uuid;
  v_query text;
  v_limit integer := least(greatest(COALESCE(p_limit, 8), 1), 20);
  v_body_max integer := least(greatest(COALESCE(p_body_max, 600), 50), 600);
BEGIN
  SELECT g.g_requester, g.g_channel, g.g_query INTO v_req, v_channel, v_query
    FROM public.mem_serve_gate(p_run_id) g;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT v_req, v_channel, s.id, s.channel_id, s.space_kind, s.kind,
         (SELECT i.origin FROM public.mem_item i WHERE i.id = s.id),
         pg_catalog.left(s.body, v_body_max), s.valid_from,
         (SELECT i.source_count FROM public.mem_item i WHERE i.id = s.id)
    FROM public.mem_search_items_for(v_req, v_query, v_limit, v_channel) s;
END
$$;

-- ── 융합 검색 본체 ───────────────────────────────────────────────────────────────
-- 서빙 전용(답 채널 필수; 브라우저 판은 만들지 않는다). 소유자(mem_definer) 말고는 부를 수 없다.
--   키워드 후보  mem_search_items_core(...serve=true) 가 낸 상위 K — 멤버십 좁히기·readable_by·청중 좁히기가 그
--                안에서 걸린 뒤의 순위(L-3: 거르고 나서 자른다).
--   벡터 후보    같은 멤버십 좁히기 → 최소 유사도 → 코사인 거리순 → readable_by → mem_item_audience_ok, 통과한 K개.
--   융합         2/(60+키워드순위) + 1/(60+벡터순위), 없는 쪽은 0. 동점은 core 와 같은 규칙(현재 유효 → 최신 → id).
-- p_query_vec 가 NULL 이거나 모델이 다르면(임베딩 실패·모델 교체 중) 키워드 결과 그대로다.
-- 벡터는 문자열 '[0.1,0.2,…]'(pgvector 텍스트 형식)이다 — 서버에 벡터 타입 바인딩 크레이트를 들이지 않는다.
CREATE OR REPLACE FUNCTION mem_search_items_fused(
  p_viewer uuid, p_query text, p_limit integer, p_answer_channel_id uuid,
  p_query_vec text, p_model text, p_min_similarity real, p_margin real)
RETURNS TABLE (
  id uuid, channel_id uuid, space_kind text, kind text, body text,
  valid_from timestamptz, valid_to timestamptz, recorded_at timestamptz,
  score real, evidence_message_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_k integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1) * 3, 50);
  v_min real := LEAST(GREATEST(COALESCE(p_min_similarity, 0.8), 0), 1);
  v_margin real := LEAST(GREATEST(COALESCE(p_margin, 1), 0), 1);
  v_best real;
  -- 키워드 후보에 없는 벡터 전용 항목은 이만큼만 실린다: 최근접 이웃은 항상 있어서(질문이 기억과 무관해도)
  -- 상한이 없으면 매 답변 프롬프트에 「그나마 가까운」 항목이 한도까지 채워진다. 조정은 후속(게이팅 튜닝).
  v_vector_only_cap CONSTANT integer := 3;
  v_q public.vector;
  v_vec_ids uuid[] := ARRAY[]::uuid[];
  r record;
BEGIN
  IF p_answer_channel_id IS NULL THEN
    RAISE EXCEPTION 'mem_search_items_fused: serving requires an answer channel' USING ERRCODE = '22023';
  END IF;
  IF v_ws IS NULL OR p_viewer IS NULL THEN
    RETURN;
  END IF;
  IF p_query_vec IS NULL OR p_model IS NULL THEN
    RETURN QUERY
    SELECT * FROM public.mem_search_items_core(p_viewer, p_query, v_limit, p_answer_channel_id, true);
    RETURN;
  END IF;
  -- 잘못된 벡터는 22P02(형식)·22000(차원) 로 멈춘다 — 워커는 키워드 전용으로 되돌아간다.
  v_q := p_query_vec::public.vector;
  IF public.vector_dims(v_q) <> 384 THEN
    RAISE EXCEPTION 'mem_search_items_fused: expected a 384-dimension query vector' USING ERRCODE = '22023';
  END IF;
  IF public.vector_norm(v_q) = 0 THEN
    RAISE EXCEPTION 'mem_search_items_fused: zero query vector' USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT e.item_id AS eid, (1 - (e.embedding OPERATOR(public.<=>) v_q))::real AS sim
      FROM public.mem_item_embedding e
      JOIN public.mem_item i ON i.id = e.item_id AND i.workspace_id = e.workspace_id
     WHERE e.workspace_id = v_ws
       AND e.model = p_model
       AND i.retired_at IS NULL
       AND NOT i.stale
       -- M-1(키워드 경로와 같은 좁히기): 뷰어의 활성 멤버십 채널(개인 공간이면 소유자 본인)에 있는 항목만
       -- 거리 계산을 받는다 — 못 읽는 채널의 항목 수가 응답 시간에 드러나지 않는다(타이밍 오라클).
       AND (i.channel_id IN (SELECT ms.channel_id FROM public.membership ms
                              WHERE ms.workspace_id = v_ws AND ms.member_id = p_viewer
                                AND ms.left_at IS NULL)
            OR (i.space_kind = 'personal' AND i.owner_member_id = p_viewer))
       AND (1 - (e.embedding OPERATOR(public.<=>) v_q)) >= v_min
     ORDER BY e.embedding OPERATOR(public.<=>) v_q, i.id
  LOOP
    IF NOT public.mem_item_readable_by(r.eid, p_viewer) THEN
      CONTINUE;
    END IF;
    IF NOT public.mem_item_audience_ok(r.eid, p_answer_channel_id, p_viewer) THEN
      CONTINUE;
    END IF;
    -- 상대 문턱: 통과한 후보 중 가장 가까운 것에서 margin 이상 멀어지면 거기서 끊는다(거리순이라 뒤는 더 멀다).
    -- 절대 문턱만으로는 e5 의 좁은 유사도 대역에서 「같은 분야의 그럭저럭 비슷한 항목」이 줄줄이 딸려 온다.
    IF v_best IS NULL THEN
      v_best := r.sim;
    ELSIF r.sim < v_best - v_margin THEN
      EXIT;
    END IF;
    v_vec_ids := v_vec_ids || r.eid;
    EXIT WHEN pg_catalog.cardinality(v_vec_ids) >= v_k;
  END LOOP;

  RETURN QUERY
  WITH kw AS (
    SELECT c.id AS kid, c.ord AS krank
      FROM public.mem_search_items_core(p_viewer, p_query, v_k, p_answer_channel_id, true)
             WITH ORDINALITY AS c(id, channel_id, space_kind, kind, body, valid_from, valid_to,
                                  recorded_at, score, evidence_message_ids, ord)
  ),
  vec AS (
    SELECT x.vid, x.vrank
      FROM pg_catalog.unnest(v_vec_ids) WITH ORDINALITY AS x(vid, vrank)
  ),
  fused AS (
    SELECT COALESCE(kw.kid, vec.vid) AS fid,
           (kw.kid IS NULL) AS vonly,
           vec.vrank AS vrank,
           (COALESCE(2.0 / (60 + kw.krank), 0) + COALESCE(1.0 / (60 + vec.vrank), 0)) AS rrf
      FROM kw FULL OUTER JOIN vec ON vec.vid = kw.kid
  ),
  capped AS (
    SELECT f.*, pg_catalog.row_number() OVER (PARTITION BY f.vonly ORDER BY f.vrank) AS vo_n
      FROM fused f
  )
  SELECT i.id, i.channel_id, i.space_kind, i.kind, i.body, i.valid_from, i.valid_to, i.recorded_at,
         f.rrf::real,
         (SELECT pg_catalog.array_agg(ev.message_id ORDER BY ev.message_id)
            FROM public.mem_evidence ev
           WHERE ev.item_id = i.id AND ev.workspace_id = v_ws)
    FROM capped f
    JOIN public.mem_item i ON i.id = f.fid AND i.workspace_id = v_ws
   WHERE NOT f.vonly OR f.vo_n <= v_vector_only_cap
   ORDER BY f.rrf DESC, (i.valid_to IS NULL) DESC, i.recorded_at DESC, i.id
   LIMIT v_limit;
END
$$;

-- 서빙 진입점(융합 판): 요청자·답 채널·질의는 run 행에서 DB 가 정한다(mem_serve_items 와 같은 게이트).
CREATE OR REPLACE FUNCTION mem_serve_items_fused(
  p_run_id uuid, p_limit integer, p_body_max integer,
  p_query_vec text, p_model text, p_min_similarity real, p_margin real)
RETURNS TABLE (
  requester_member_id uuid,
  answer_channel_id   uuid,
  item_id             uuid,
  item_channel_id     uuid,
  space_kind          text,
  kind                text,
  origin              text,
  body                text,
  valid_from          timestamptz,
  source_count        integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_req uuid;
  v_channel uuid;
  v_query text;
  v_limit integer := least(greatest(COALESCE(p_limit, 8), 1), 20);
  v_body_max integer := least(greatest(COALESCE(p_body_max, 600), 50), 600);
BEGIN
  SELECT g.g_requester, g.g_channel, g.g_query INTO v_req, v_channel, v_query
    FROM public.mem_serve_gate(p_run_id) g;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT v_req, v_channel, s.id, s.channel_id, s.space_kind, s.kind,
         (SELECT i.origin FROM public.mem_item i WHERE i.id = s.id),
         pg_catalog.left(s.body, v_body_max), s.valid_from,
         (SELECT i.source_count FROM public.mem_item i WHERE i.id = s.id)
    FROM public.mem_search_items_fused(
           v_req, v_query, v_limit, v_channel, p_query_vec, p_model, p_min_similarity, p_margin) s;
END
$$;

-- ── 임베딩 쓰기·백필 (워커 전용) ───────────────────────────────────────────────────
-- 항목이 이 워크스페이스에 살아 있을 때만(폐기·stale 이면 조용히 false), 멱등(이미 있으면 false).
-- 차원·영벡터·형식 오류는 22023/22P02 로 멈춘다.
CREATE OR REPLACE FUNCTION mem_set_item_embedding(p_item_id uuid, p_model text, p_embedding text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_vec public.vector;
  v_rows integer;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_set_item_embedding: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_model IS NULL OR pg_catalog.char_length(p_model) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'mem_set_item_embedding: bad model id' USING ERRCODE = '22023';
  END IF;
  v_vec := p_embedding::public.vector;
  IF public.vector_dims(v_vec) <> 384 THEN
    RAISE EXCEPTION 'mem_set_item_embedding: expected 384 dimensions' USING ERRCODE = '22023';
  END IF;
  IF public.vector_norm(v_vec) = 0 THEN
    RAISE EXCEPTION 'mem_set_item_embedding: zero vector' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.mem_item_embedding (item_id, workspace_id, model, dims, embedding)
  SELECT i.id, v_ws, p_model, 384, v_vec
    FROM public.mem_item i
   WHERE i.id = p_item_id AND i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale
  ON CONFLICT (item_id, model) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END
$$;

-- 이 모델의 임베딩이 아직 없는 살아 있는 항목(최신순). 신규·편집(curated) 사본·수락된 제안·백필이 한 길이다.
CREATE OR REPLACE FUNCTION mem_items_to_embed(p_model text, p_limit integer)
RETURNS TABLE (item_id uuid, body text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 32), 1), 500);
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_items_to_embed: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT i.id, i.body
    FROM public.mem_item i
   WHERE i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale
     AND NOT EXISTS (SELECT 1 FROM public.mem_item_embedding e
                      WHERE e.item_id = i.id AND e.model = p_model)
   ORDER BY i.recorded_at DESC, i.id
   LIMIT v_limit;
END
$$;

CREATE OR REPLACE FUNCTION mem_embedding_stats(p_model text)
RETURNS TABLE (live_items bigint, embedded_items bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_embedding_stats: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.mem_item_embedding e
                                                    WHERE e.item_id = i.id AND e.model = p_model))
    FROM public.mem_item i
   WHERE i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale;
END
$$;

-- ── 소유자·권한 ────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO mem_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_serve_gate(uuid)', 'mem_serve_query(uuid)',
    'mem_search_items_fused(uuid, text, integer, uuid, text, text, real, real)',
    'mem_serve_items_fused(uuid, integer, integer, text, text, real, real)',
    'mem_set_item_embedding(uuid, text, text)', 'mem_items_to_embed(text, integer)',
    'mem_embedding_stats(text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO mem_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- ── RLS ────────────────────────────────────────────────────────────────────────
ALTER TABLE mem_item_embedding ENABLE ROW LEVEL SECURITY;
ALTER TABLE mem_item_embedding FORCE ROW LEVEL SECURITY;

-- 정의자 말고는 어떤 역할에도 정책이 없다(읽기 포함): momo_app 이 우연히 SELECT 권한을 받아도 0행이다.
DROP POLICY IF EXISTS mem_item_embedding_ins ON mem_item_embedding;
CREATE POLICY mem_item_embedding_ins ON mem_item_embedding FOR INSERT TO mem_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_item_embedding_sel_definer ON mem_item_embedding;
CREATE POLICY mem_item_embedding_sel_definer ON mem_item_embedding FOR SELECT TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- 추가만: 수정·삭제 정책이 없고, 나중에 누가 허용 정책을 더해도 RESTRICTIVE 는 AND 라 못 뚫는다.
-- (mem_item 삭제의 FK CASCADE 는 참조 무결성 동작이라 행 보안을 거치지 않는다.)
DROP POLICY IF EXISTS mem_item_embedding_only_definer_ins ON mem_item_embedding;
CREATE POLICY mem_item_embedding_only_definer_ins ON mem_item_embedding AS RESTRICTIVE FOR INSERT
  WITH CHECK (current_user = 'mem_definer');
DROP POLICY IF EXISTS mem_item_embedding_no_update ON mem_item_embedding;
CREATE POLICY mem_item_embedding_no_update ON mem_item_embedding AS RESTRICTIVE FOR UPDATE
  USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS mem_item_embedding_no_delete ON mem_item_embedding;
CREATE POLICY mem_item_embedding_no_delete ON mem_item_embedding AS RESTRICTIVE FOR DELETE
  USING (false);

-- ── 런타임 역할 권한 (이 마이그레이션이 만든 객체만) ─────────────────────────────────
-- 101 의 공용 잠금 블록은 건드리지 않는다(mem_* 테이블을 동적으로 순회하므로 부트스트랩이 다시 돌면 이 테이블도
-- 잠긴다 — 시험이 확인한다). 여기서는 마이그레이션 시점에 같은 상태를 만든다: 테이블은 어떤 런타임 역할에도
-- 권한 없음(momo_app 포함 — 임베딩은 본문과 같은 등급), 워커 전용 함수는 momo_memory 에만 EXECUTE,
-- 소유자 전용 함수(게이트·융합 본체)는 momo_memory 도 못 부른다.
DO $$
DECLARE
  r text;
  f text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
  worker_only text[] := ARRAY[
    'mem_serve_query(uuid)',
    'mem_serve_items_fused(uuid, integer, integer, text, text, real, real)',
    'mem_set_item_embedding(uuid, text, text)',
    'mem_items_to_embed(text, integer)',
    'mem_embedding_stats(text)'
  ];
  owner_only text[] := ARRAY[
    'mem_serve_gate(uuid)',
    'mem_search_items_fused(uuid, text, integer, uuid, text, text, real, real)'
  ];
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE public.mem_item_embedding FROM PUBLIC';
  FOREACH r IN ARRAY runtime_roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.mem_item_embedding FROM %I', r);
    END IF;
  END LOOP;
  FOREACH f IN ARRAY owner_only LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    FOREACH r IN ARRAY runtime_roles LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_memory') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM momo_memory', f);
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
     WHERE n.nspname = current_schema() AND c.relname = 'mem_item_embedding'
       AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'mem_item_embedding is missing FORCE ROW LEVEL SECURITY';
  END IF;
  FOR f IN SELECT p.proname FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.prosecdef AND p.proname LIKE 'mem\_%'
              AND pg_get_userbyid(p.proowner) <> 'mem_definer' LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % is not owned by mem_definer', f;
  END LOOP;
END $$;

-- ── L-1: mem_definer 소유 SECURITY DEFINER 함수 허용 목록 (106 것 + 이 파일의 7개) ─────────────
-- 새 정의자 함수를 만들면 이 목록과 시험(mem_schema_conformance_pg.rs 의 DEFINER_ALLOW_LIST)에
-- 이름을 올려야 한다.
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
    'mem_serve_requester', 'mem_serve_candidates', 'mem_serving_of',
    'mem_item_evidence_ok', 'mem_item_readable_by', 'mem_item_live', 'mem_item_audience_ok', 'mem_add_item',
    'mem_search_items_core', 'mem_search_items_for', 'mem_search_items', 'mem_looks_like_secret',
    'mem_proposal_evidence_ok', 'mem_propose_item', 'mem_proposal_decider',
    'mem_accept_proposal', 'mem_reject_proposal',
    'mem_serve_items', 'mem_serving_record_of',
    'mem_edit_item', 'mem_forget_item',
    'mem_serve_gate', 'mem_serve_query', 'mem_search_items_fused', 'mem_serve_items_fused',
    'mem_set_item_embedding', 'mem_items_to_embed', 'mem_embedding_stats'
  ];
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'mem_definer'
              AND p.proname <> ALL (allow) LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % owned by mem_definer is not in the allow-list', f;
  END LOOP;
END $$;
