-- =============================================================================
-- 108_mem_topics.sql — #3172 / ADR-0196 (팀 기억 v2) M3 B단계: 주제(L3) 배정·분할·요약
--
-- 정리 잡(107)의 둘째 반쪽. 항목(L2)을 **같은 채널 안에서만** 주제 트리 노드에 배정하고, 노드가 cap(125)에 닿으면
-- 2~4개 하위 주제로 나누고(company-brain split.ts 식: 160개 표본을 모델이 분류, 나머지는 유사도로 배정), 주제마다
-- 요약을 다시 합성한다(D3 L3, D6-1 「합성도 채널 안에서만」, D10 주제 분할).
--
--   mem_topic / mem_topic_summary       테이블 둘(FORCE RLS). 라벨과 요약은 따로 — 요약은 근거 항목이 하나라도 안 보이면 가려진다.
--   mem_item.topic_id                   항목의 주제(리프). 주제가 지워지면 NULL.
--   mem_topic_unassigned / _leaves      배정 일감 / 배정 대상(리프) 목록 — 워커 전용
--   mem_topic_assign                    항목 하나를 기존 주제 또는 새 루트 주제에 배정 — 워커 전용
--   mem_topic_split_candidates / _apply cap 이상 리프의 표본 / 분할 적용 — 워커 전용
--   mem_topic_summary_work / _set_summary  요약 일감 / 저장(시크릿·괄호 검사) — 워커 전용
--   mem_topic_gc                        빈 주제 정리 — 워커 전용
--   mem_topic_revert                    배정('assigned')·분할('split') 되돌리기 — 워커 전용
--
-- 결정: 모델이 정하는 글은 라벨(≤30자)과 요약(≤700자)뿐이고 둘 다 저장 전에 DB 가 시크릿 모양·괄호·제어문자를 다시
-- 검사한다(Rust 가 먼저 검사; 마지막 방어선). 라벨·요약이 다른 채널 항목을 섞지 못하도록 배정·분할·요약 함수가 채널·소유자
-- 일치를 23514 로 강제한다. 분할은 항목마다 'assigned' 이벤트(from/to)를 남겨 되돌릴 수 있다(이벤트 detail 4KB 한도라 한 이벤트에
-- id 를 다 담지 않는다). 재실행 가능한 문장만.
-- =============================================================================

ALTER TABLE mem_event DROP CONSTRAINT IF EXISTS mem_event_action_ck;
ALTER TABLE mem_event ADD CONSTRAINT mem_event_action_ck
  CHECK (action IN
    ('created', 'confirmed', 'edited', 'merged', 'superseded', 'retired', 'forgotten',
     'served', 'withheld', 'reset', 'proposed', 'rejected', 'expired',
     'reinforced', 'reverted', 'purged', 'assigned', 'split', 'summarized'));

CREATE TABLE IF NOT EXISTS mem_topic (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL,
  parent_id       uuid REFERENCES mem_topic(id) ON DELETE CASCADE,
  depth           smallint NOT NULL DEFAULT 0,
  -- 개인 공간(사람↔에이전트 DM)의 주제는 그 사람의 것.
  owner_member_id uuid,
  label           text NOT NULL,
  label_key       text NOT NULL,
  split_lock_until timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_topic_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_topic_owner_fk FOREIGN KEY (workspace_id, owner_member_id)
    REFERENCES member (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mem_topic_depth_ck CHECK (depth BETWEEN 0 AND 3 AND ((depth = 0) = (parent_id IS NULL))),
  CONSTRAINT mem_topic_label_ck CHECK (char_length(label) BETWEEN 2 AND 30)
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_topic_label_uq ON mem_topic
  (workspace_id, channel_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
   COALESCE(owner_member_id, '00000000-0000-0000-0000-000000000000'::uuid), label_key);
CREATE INDEX IF NOT EXISTS mem_topic_channel_idx ON mem_topic (workspace_id, channel_id);
CREATE INDEX IF NOT EXISTS mem_topic_parent_idx ON mem_topic (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mem_topic_summary (
  topic_id        uuid PRIMARY KEY REFERENCES mem_topic(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL,
  body            text NOT NULL,
  -- 이 요약이 기댄 항목(최대 40). 하나라도 안 보이면(잊음·근거 삭제) 요약이 가려지고 다시 만들어진다.
  item_ids        uuid[] NOT NULL,
  item_hash       text NOT NULL,
  model           text,
  prompt_version  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_topic_summary_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_topic_summary_body_ck CHECK (char_length(body) BETWEEN 1 AND 700),
  CONSTRAINT mem_topic_summary_items_ck CHECK (cardinality(item_ids) BETWEEN 1 AND 40)
);

ALTER TABLE mem_item ADD COLUMN IF NOT EXISTS topic_id uuid REFERENCES mem_topic(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS mem_item_topic_idx ON mem_item (topic_id) WHERE topic_id IS NOT NULL;
GRANT UPDATE (topic_id) ON mem_item TO mem_definer;

GRANT SELECT, INSERT, UPDATE, DELETE ON mem_topic TO mem_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON mem_topic_summary TO mem_definer;

-- mem.op 표지(107): 항목 UPDATE 목록에 주제 배정·분할·되돌리기를 더한다.
DROP POLICY IF EXISTS mem_item_only_definer_upd ON mem_item;
CREATE POLICY mem_item_only_definer_upd ON mem_item AS RESTRICTIVE FOR UPDATE
  USING (current_user = 'mem_definer'
         AND pg_catalog.current_setting('mem.op', true) IN
             ('add_item', 'edit_item', 'forget_item', 'accept_proposal',
              'cons_retire', 'cons_decay', 'cons_apply', 'cons_revert', 'cons_retention',
              'topic_assign', 'topic_split', 'topic_revert'))
  WITH CHECK (current_user = 'mem_definer'
         AND pg_catalog.current_setting('mem.op', true) IN
             ('add_item', 'edit_item', 'forget_item', 'accept_proposal',
              'cons_retire', 'cons_decay', 'cons_apply', 'cons_revert', 'cons_retention',
              'topic_assign', 'topic_split', 'topic_revert'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_topic', 'mem_topic_summary'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['mem_topic', 'mem_topic_summary'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_sel_definer', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR SELECT TO mem_definer
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$f$, t || '_sel_definer', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_ins', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR INSERT TO mem_definer
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$f$, t || '_ins', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_upd', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR UPDATE TO mem_definer
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$f$, t || '_upd', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_del', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR DELETE TO mem_definer
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$f$, t || '_del', t);
  END LOOP;
END $$;
-- 쓰기(INSERT/UPDATE/DELETE)는 정의자만, 그것도 함수가 표지(mem.op)를 세웠을 때만(L-6). RESTRICTIVE 는 쓰기 명령에만 건다.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_topic', 'mem_topic_summary'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_marked_ins', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_marked_upd', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_marked_del', t);
    EXECUTE format($f$CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT
      WITH CHECK (current_user = 'mem_definer'
             AND pg_catalog.current_setting('mem.op', true) IN ('topic_assign', 'topic_split', 'topic_summary', 'topic_revert'))$f$,
      t || '_marked_ins', t);
    EXECUTE format($f$CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE
      USING (current_user = 'mem_definer'
             AND pg_catalog.current_setting('mem.op', true) IN ('topic_assign', 'topic_split', 'topic_summary', 'topic_revert', 'topic_gc'))
      WITH CHECK (current_user = 'mem_definer'
             AND pg_catalog.current_setting('mem.op', true) IN ('topic_assign', 'topic_split', 'topic_summary', 'topic_revert', 'topic_gc'))$f$,
      t || '_marked_upd', t);
    EXECUTE format($f$CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE
      USING (current_user = 'mem_definer'
             AND pg_catalog.current_setting('mem.op', true) IN ('topic_gc', 'topic_split', 'topic_revert', 'topic_summary'))$f$,
      t || '_marked_del', t);
  END LOOP;
END $$;

-- 읽기: 라벨(주제)은 그 채널을 읽을 수 있는 사람에게(개인 공간이면 소유자만). 요약은 근거 항목을 전부 읽을 수 있을 때만.
DROP POLICY IF EXISTS mem_topic_sel ON mem_topic;
CREATE POLICY mem_topic_sel ON mem_topic FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_can_read_channel(channel_id)
    AND (owner_member_id IS NULL
         OR owner_member_id = nullif(current_setting('app.member_id', true), '')::uuid)
  );

CREATE OR REPLACE FUNCTION mem_topic_summary_ok(p_topic_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT (t.owner_member_id IS NULL
            OR t.owner_member_id = nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid)
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.unnest(s.item_ids) AS x(id)
          WHERE NOT public.mem_item_readable_by(
                  x.id, nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid))
      FROM public.mem_topic_summary s
      JOIN public.mem_topic t ON t.id = s.topic_id AND t.workspace_id = s.workspace_id
     WHERE s.topic_id = p_topic_id
       AND s.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  ), false)
$$;

DROP POLICY IF EXISTS mem_topic_summary_sel ON mem_topic_summary;
CREATE POLICY mem_topic_summary_sel ON mem_topic_summary FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_can_read_channel(channel_id)
    AND CASE WHEN current_user = 'mem_definer' THEN false ELSE mem_topic_summary_ok(topic_id) END
  );

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_topic', 'mem_topic_summary'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
        IF r = 'momo_app' THEN
          EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', t, r);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 라벨 정리: 2..30자, 공백 접기, 괄호·꺾쇠·중괄호·역따옴표·역슬래시·제어문자 없음, 시크릿 모양 아님. 아니면 NULL.
CREATE OR REPLACE FUNCTION mem_topic_label_clean(p_label text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
           WHEN pg_catalog.char_length(c) BETWEEN 2 AND 30
            AND pg_catalog.translate(c, '[]<>{}`\', '') = c
            AND c !~ '[[:cntrl:]]'
            AND NOT public.mem_looks_like_secret(c)
           THEN c END
    FROM (SELECT pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_label, ''), '[[:space:]]+', ' ', 'g')) AS c) x
$$;

-- ── 배정 일감 ────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mem_topic_unassigned(p_channel_id uuid, p_limit integer)
RETURNS TABLE (item_id uuid, kind text, body text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_topic_unassigned: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF NOT public.mem_channel_eligible(p_channel_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT i.id, i.kind, i.body FROM public.mem_item i
   WHERE i.workspace_id = v_ws AND i.channel_id = p_channel_id AND i.topic_id IS NULL
     AND i.retired_at IS NULL AND NOT i.stale AND public.mem_item_live(i.id)
   ORDER BY i.recorded_at, i.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
END
$$;

-- 배정 대상(리프) 주제. live_count = 살아 있는 항목 수.
CREATE OR REPLACE FUNCTION mem_topic_leaves(p_channel_id uuid)
RETURNS TABLE (topic_id uuid, label text, depth integer, live_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_topic_leaves: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF NOT public.mem_channel_eligible(p_channel_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT t.id, t.label, t.depth::integer,
         (SELECT pg_catalog.count(*)::integer FROM public.mem_item i
           WHERE i.topic_id = t.id AND i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale)
    FROM public.mem_topic t
   WHERE t.workspace_id = v_ws AND t.channel_id = p_channel_id
     AND NOT EXISTS (SELECT 1 FROM public.mem_topic c WHERE c.parent_id = t.id)
   ORDER BY t.created_at, t.id;
END
$$;

-- 항목 하나를 기존 리프 주제(p_topic_id) 또는 새 루트 주제(p_new_label)에 배정한다. 같은 채널·같은 공간(개인 공간이면 같은
-- 소유자)만 — 어기면 23514. 라벨은 DB 가 다시 검사한다(23514). NULL = 지금은 배정하지 않음(그 사이 상태가 바뀜, 루트 상한).
CREATE OR REPLACE FUNCTION mem_topic_assign(
  p_item_id uuid, p_topic_id uuid, p_new_label text, p_max_roots integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  i public.mem_item%ROWTYPE;
  t public.mem_topic%ROWTYPE;
  v_label text;
  v_topic uuid;
  v_new boolean := false;
BEGIN
  PERFORM public.mem_op('topic_assign');
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_topic_assign: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF (p_topic_id IS NULL) = (p_new_label IS NULL) THEN
    RAISE EXCEPTION 'mem_topic_assign: exactly one of topic and new label is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO i FROM public.mem_item x WHERE x.id = p_item_id AND x.workspace_id = v_ws FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT public.mem_channel_eligible(i.channel_id) THEN
    RAISE EXCEPTION 'mem_topic_assign: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;
  IF i.retired_at IS NOT NULL OR i.stale OR i.topic_id IS NOT NULL OR NOT public.mem_item_live(i.id) THEN
    RETURN NULL;
  END IF;
  IF p_topic_id IS NOT NULL THEN
    SELECT * INTO t FROM public.mem_topic x WHERE x.id = p_topic_id AND x.workspace_id = v_ws FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF t.channel_id <> i.channel_id OR t.owner_member_id IS DISTINCT FROM i.owner_member_id
       OR EXISTS (SELECT 1 FROM public.mem_topic c WHERE c.parent_id = t.id) THEN
      RAISE EXCEPTION 'mem_topic_assign: a leaf topic of the item''s own channel and space is required'
        USING ERRCODE = '23514';
    END IF;
    v_topic := t.id;
  ELSE
    v_label := public.mem_topic_label_clean(p_new_label);
    IF v_label IS NULL THEN
      RAISE EXCEPTION 'mem_topic_assign: the label is not acceptable' USING ERRCODE = '23514';
    END IF;
    SELECT x.id INTO v_topic FROM public.mem_topic x
     WHERE x.workspace_id = v_ws AND x.channel_id = i.channel_id AND x.parent_id IS NULL
       AND x.owner_member_id IS NOT DISTINCT FROM i.owner_member_id AND x.label_key = pg_catalog.lower(v_label);
    IF v_topic IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.mem_topic c WHERE c.parent_id = v_topic) THEN
        RETURN NULL;
      END IF;
    ELSE
      IF (SELECT pg_catalog.count(*) FROM public.mem_topic x
           WHERE x.workspace_id = v_ws AND x.channel_id = i.channel_id AND x.parent_id IS NULL)
         >= GREATEST(COALESCE(p_max_roots, 60), 1) THEN
        RETURN NULL;
      END IF;
      INSERT INTO public.mem_topic (workspace_id, channel_id, owner_member_id, label, label_key)
      VALUES (v_ws, i.channel_id, i.owner_member_id, v_label, pg_catalog.lower(v_label))
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_topic;
      IF v_topic IS NULL THEN RETURN NULL; END IF;
      v_new := true;
      INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
      VALUES (v_ws, 'topic', v_topic, 'created', i.channel_id, i.owner_member_id,
              pg_catalog.jsonb_build_object('depth', 0));
    END IF;
  END IF;
  UPDATE public.mem_item SET topic_id = v_topic WHERE id = i.id;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
  VALUES (v_ws, 'item', i.id, 'assigned', i.channel_id, i.owner_member_id,
          pg_catalog.jsonb_build_object('from', NULL::uuid, 'to', v_topic, 'new_topic', v_new));
  RETURN v_topic;
END
$$;

-- ── 분할 ─────────────────────────────────────────────────────────────────────────────────────────
-- 살아 있는 항목이 p_cap 이상인 리프(깊이 < 3, 잠기지 않음)마다 가장 최근 p_sample 개 표본.
CREATE OR REPLACE FUNCTION mem_topic_split_candidates(p_channel_id uuid, p_cap integer, p_sample integer)
RETURNS TABLE (topic_id uuid, label text, live_count integer, item_id uuid, body text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_topic_split_candidates: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF NOT public.mem_channel_eligible(p_channel_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH big AS (
    SELECT t.id AS tid, t.label AS tlabel,
           (SELECT pg_catalog.count(*)::integer FROM public.mem_item i
             WHERE i.topic_id = t.id AND i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale) AS n
      FROM public.mem_topic t
     WHERE t.workspace_id = v_ws AND t.channel_id = p_channel_id AND t.depth < 3
       AND (t.split_lock_until IS NULL OR t.split_lock_until <= pg_catalog.now())
       AND NOT EXISTS (SELECT 1 FROM public.mem_topic c WHERE c.parent_id = t.id)
  )
  SELECT b.tid, b.tlabel, b.n, s.id, s.body
    FROM big b
    CROSS JOIN LATERAL (
      SELECT i.id, i.body FROM public.mem_item i
       WHERE i.topic_id = b.tid AND i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale
       ORDER BY i.recorded_at DESC, i.id
       LIMIT LEAST(GREATEST(COALESCE(p_sample, 160), 10), 400)) s
   WHERE b.n >= GREATEST(COALESCE(p_cap, 125), 2)
   ORDER BY b.tid, s.id;
END
$$;

-- 표본 분류를 적용한다: 2~4개 하위 주제를 만들고(라벨 검사, 서로 다름), 표본 항목은 모델이 고른 칸(p_slots, 1부터)으로,
-- 나머지 항목은 표본과 가장 비슷한 칸으로 옮긴다. 두 칸 이상이 쓰이지 않으면 아무것도 바꾸지 않고 6시간 잠근다.
-- 항목마다 'assigned'(from/to) 이벤트, 주제에 'split'(개수만). 반환 = 옮긴 항목 수(0 = 분할하지 않음).
CREATE OR REPLACE FUNCTION mem_topic_split_apply(
  p_topic_id uuid, p_labels text[], p_items uuid[], p_slots integer[], p_cap integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  t public.mem_topic%ROWTYPE;
  v_n integer := COALESCE(pg_catalog.cardinality(p_labels), 0);
  v_labels text[] := '{}';
  v_children uuid[] := '{}';
  v_label text;
  v_child uuid;
  v_moved integer := 0;
  v_slot integer;
  m record;
BEGIN
  PERFORM public.mem_op('topic_split');
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_topic_split_apply: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF v_n NOT BETWEEN 2 AND 4
     OR COALESCE(pg_catalog.cardinality(p_items), 0) <> COALESCE(pg_catalog.cardinality(p_slots), -1) THEN
    RAISE EXCEPTION 'mem_topic_split_apply: 2..4 labels and one slot per item are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO t FROM public.mem_topic x WHERE x.id = p_topic_id AND x.workspace_id = v_ws FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF NOT public.mem_channel_eligible(t.channel_id) THEN
    RAISE EXCEPTION 'mem_topic_split_apply: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;
  IF t.depth >= 3 OR EXISTS (SELECT 1 FROM public.mem_topic c WHERE c.parent_id = t.id)
     OR (t.split_lock_until IS NOT NULL AND t.split_lock_until > pg_catalog.now())
     OR (SELECT pg_catalog.count(*) FROM public.mem_item i
          WHERE i.topic_id = t.id AND i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale)
        < GREATEST(COALESCE(p_cap, 125), 2) THEN
    RETURN 0;
  END IF;
  FOR v_slot IN 1..v_n LOOP
    v_label := public.mem_topic_label_clean(p_labels[v_slot]);
    IF v_label IS NULL OR pg_catalog.lower(v_label) = ANY (v_labels) THEN
      RAISE EXCEPTION 'mem_topic_split_apply: a label is not acceptable or repeats' USING ERRCODE = '23514';
    END IF;
    v_labels := v_labels || pg_catalog.lower(v_label);
  END LOOP;
  -- 표본은 이 주제의 살아 있는 항목이어야 하고, 칸은 1..n.
  IF EXISTS (SELECT 1 FROM (SELECT p_items[g] AS id, p_slots[g] AS slot FROM pg_catalog.generate_subscripts(p_items, 1) AS g) AS s
              WHERE s.slot NOT BETWEEN 1 AND v_n OR s.slot IS NULL
                 OR NOT EXISTS (SELECT 1 FROM public.mem_item i
                                 WHERE i.id = s.id AND i.topic_id = t.id AND i.workspace_id = v_ws
                                   AND i.retired_at IS NULL AND NOT i.stale)) THEN
    RAISE EXCEPTION 'mem_topic_split_apply: the sample must be live items of this topic in slots 1..n' USING ERRCODE = '23514';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT s.slot) FROM pg_catalog.unnest(p_slots) AS s(slot)) < 2 THEN
    UPDATE public.mem_topic SET split_lock_until = pg_catalog.now() + interval '6 hours' WHERE id = t.id;
    RETURN 0;
  END IF;
  FOR v_slot IN 1..v_n LOOP
    INSERT INTO public.mem_topic (workspace_id, channel_id, parent_id, depth, owner_member_id, label, label_key)
    VALUES (v_ws, t.channel_id, t.id, t.depth + 1, t.owner_member_id,
            public.mem_topic_label_clean(p_labels[v_slot]), v_labels[v_slot])
    RETURNING id INTO v_child;
    v_children := v_children || v_child;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
    VALUES (v_ws, 'topic', v_children[v_slot], 'created', t.channel_id, t.owner_member_id,
            pg_catalog.jsonb_build_object('depth', t.depth + 1, 'parent', t.id));
  END LOOP;
  FOR m IN
    SELECT i.id, i.owner_member_id,
           COALESCE(
             (SELECT s.slot FROM (SELECT p_items[g] AS id, p_slots[g] AS slot FROM pg_catalog.generate_subscripts(p_items, 1) AS g) AS s WHERE s.id = i.id),
             (SELECT s.slot
                FROM (SELECT p_items[g] AS id, p_slots[g] AS slot FROM pg_catalog.generate_subscripts(p_items, 1) AS g) AS s
                JOIN public.mem_item si ON si.id = s.id
               GROUP BY s.slot
               ORDER BY pg_catalog.max(public.similarity(i.body, si.body)) DESC, s.slot
               LIMIT 1)) AS slot
      FROM public.mem_item i
     WHERE i.topic_id = t.id AND i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale
     ORDER BY i.id
       FOR UPDATE OF i
  LOOP
    UPDATE public.mem_item SET topic_id = v_children[m.slot] WHERE id = m.id;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
    VALUES (v_ws, 'item', m.id, 'assigned', t.channel_id, m.owner_member_id,
            pg_catalog.jsonb_build_object('from', t.id, 'to', v_children[m.slot], 'via', 'split'));
    v_moved := v_moved + 1;
  END LOOP;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
  VALUES (v_ws, 'topic', t.id, 'split', t.channel_id, t.owner_member_id,
          pg_catalog.jsonb_build_object('children', v_n, 'moved', v_moved));
  RETURN v_moved;
END
$$;

-- ── 요약 ─────────────────────────────────────────────────────────────────────────────────────────
-- 요약이 없거나 근거 항목 묶음(가장 최근 p_per_topic 개의 id 해시)이 달라진 리프(살아 있는 항목 >= p_min_items).
CREATE OR REPLACE FUNCTION mem_topic_summary_work(
  p_channel_id uuid, p_limit integer, p_min_items integer, p_per_topic integer)
RETURNS TABLE (topic_id uuid, label text, item_id uuid, body text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_per integer := LEAST(GREATEST(COALESCE(p_per_topic, 30), 1), 40);
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_topic_summary_work: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF NOT public.mem_channel_eligible(p_channel_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH leaf AS (
    SELECT t.id AS tid, t.label AS tlabel FROM public.mem_topic t
     WHERE t.workspace_id = v_ws AND t.channel_id = p_channel_id
       AND NOT EXISTS (SELECT 1 FROM public.mem_topic c WHERE c.parent_id = t.id)
  ), members AS (
    SELECT l.tid, l.tlabel, m.id, m.body, m.rn
      FROM leaf l
      CROSS JOIN LATERAL (
        SELECT i.id, i.body, pg_catalog.row_number() OVER (ORDER BY i.recorded_at DESC, i.id) AS rn
          FROM public.mem_item i
         WHERE i.topic_id = l.tid AND i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale
           AND public.mem_item_live(i.id)
         ORDER BY i.recorded_at DESC, i.id
         LIMIT v_per) m
  ), todo AS (
    SELECT mm.tid FROM members mm
     GROUP BY mm.tid
    HAVING pg_catalog.count(*) >= GREATEST(COALESCE(p_min_items, 3), 1)
       AND NOT EXISTS (
         SELECT 1 FROM public.mem_topic_summary s
          WHERE s.topic_id = mm.tid AND s.workspace_id = v_ws
            AND s.item_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                  pg_catalog.string_agg(mm.id::text, ',' ORDER BY mm.id), 'UTF8')), 'hex'))
     ORDER BY mm.tid
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 20)
  )
  SELECT mm.tid, mm.tlabel, mm.id, mm.body FROM members mm JOIN todo d ON d.tid = mm.tid
   ORDER BY mm.tid, mm.rn;
END
$$;

-- 요약 저장: 근거 항목은 이 주제의 살아 있는 항목 1..40개. 본문은 DB 가 다시 검사한다(시크릿 모양 23514, 1..700자,
-- 대괄호는 전각으로 — 요약이 다른 프롬프트에서 `[n]` 근거 표시를 흉내 낼 수 없게).
CREATE OR REPLACE FUNCTION mem_topic_set_summary(
  p_topic_id uuid, p_body text, p_item_ids uuid[], p_model text, p_prompt_version text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  t public.mem_topic%ROWTYPE;
  v_body text;
  v_n integer := COALESCE(pg_catalog.cardinality(p_item_ids), 0);
BEGIN
  PERFORM public.mem_op('topic_summary');
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_topic_set_summary: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  v_body := pg_catalog.btrim(pg_catalog.translate(COALESCE(p_body, ''), E'[]\n\r\t', '［］   '));
  IF pg_catalog.char_length(v_body) NOT BETWEEN 1 AND 700 OR public.mem_looks_like_secret(v_body)
     OR v_body ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'mem_topic_set_summary: the summary is not acceptable' USING ERRCODE = '23514';
  END IF;
  IF v_n NOT BETWEEN 1 AND 40
     OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_item_ids) AS x) <> v_n THEN
    RAISE EXCEPTION 'mem_topic_set_summary: 1..40 distinct items are required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO t FROM public.mem_topic x WHERE x.id = p_topic_id AND x.workspace_id = v_ws FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT public.mem_channel_eligible(t.channel_id) THEN
    RAISE EXCEPTION 'mem_topic_set_summary: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.mem_item i
       WHERE i.id = ANY (p_item_ids) AND i.topic_id = t.id AND i.workspace_id = v_ws
         AND i.channel_id = t.channel_id AND i.retired_at IS NULL AND NOT i.stale
         AND public.mem_item_live(i.id)) <> v_n THEN
    RAISE EXCEPTION 'mem_topic_set_summary: every source must be a live item of this topic' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.mem_topic_summary
    (topic_id, workspace_id, channel_id, body, item_ids, item_hash, model, prompt_version)
  VALUES (t.id, v_ws, t.channel_id, v_body, p_item_ids,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            (SELECT pg_catalog.string_agg(x::text, ',' ORDER BY x) FROM pg_catalog.unnest(p_item_ids) AS x), 'UTF8')), 'hex'),
          p_model, COALESCE(p_prompt_version, 'topic-v1'))
  ON CONFLICT (topic_id) DO UPDATE
    SET body = EXCLUDED.body, item_ids = EXCLUDED.item_ids, item_hash = EXCLUDED.item_hash,
        model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version, created_at = pg_catalog.now();
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
  VALUES (v_ws, 'topic', t.id, 'summarized', t.channel_id, t.owner_member_id,
          pg_catalog.jsonb_build_object('items', v_n));
  RETURN true;
END
$$;

-- ── 정리·되돌리기 ──────────────────────────────────────────────────────────────────────────────────
-- 살아 있는 항목이 없는 리프를 지운다(이어서 빈 부모도). 이벤트에는 id 만.
CREATE OR REPLACE FUNCTION mem_topic_gc(p_channel_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  r record;
  v_n integer := 0;
  v_round integer;
BEGIN
  PERFORM public.mem_op('topic_gc');
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_topic_gc: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  FOR v_round IN 1..4 LOOP
    FOR r IN
      SELECT t.id, t.owner_member_id FROM public.mem_topic t
       WHERE t.workspace_id = v_ws AND t.channel_id = p_channel_id
         AND NOT EXISTS (SELECT 1 FROM public.mem_topic c WHERE c.parent_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM public.mem_item i
                          WHERE i.topic_id = t.id AND i.workspace_id = v_ws AND i.retired_at IS NULL AND NOT i.stale)
       ORDER BY t.id LIMIT 200 FOR UPDATE OF t SKIP LOCKED
    LOOP
      DELETE FROM public.mem_topic WHERE id = r.id AND workspace_id = v_ws;
      INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
      VALUES (v_ws, 'topic', r.id, 'purged', p_channel_id, r.owner_member_id,
              pg_catalog.jsonb_build_object('reason', 'empty'));
      v_n := v_n + 1;
    END LOOP;
  END LOOP;
  RETURN v_n;
END
$$;

-- 배정('assigned', from 이 있는 것) 또는 분할('split')을 되돌린다. 처음 배정(from NULL)은 항목을 다시 미배정으로 돌리며,
-- 다음 정리에서 모델이 다시 배정할 수 있다(되돌림은 다음 패스까지의 사람 손질이다).
CREATE OR REPLACE FUNCTION mem_topic_revert(p_event_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  e public.mem_event%ROWTYPE;
  i public.mem_item%ROWTYPE;
  t public.mem_topic%ROWTYPE;
  v_from uuid;
  v_moved integer;
BEGIN
  PERFORM public.mem_op('topic_revert');
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_topic_revert: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM public.mem_event x WHERE x.id = p_event_id AND x.workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_topic_revert: event not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mem_event r
              WHERE r.workspace_id = v_ws AND r.action = 'reverted' AND r.detail ->> 'of' = p_event_id::text) THEN
    RAISE EXCEPTION 'mem_topic_revert: already reverted' USING ERRCODE = '55000';
  END IF;
  IF e.action = 'assigned' AND e.target_kind = 'item' THEN
    SELECT * INTO i FROM public.mem_item x WHERE x.id = e.target_id AND x.workspace_id = v_ws FOR UPDATE;
    IF NOT FOUND OR i.topic_id IS DISTINCT FROM (e.detail ->> 'to')::uuid THEN
      RAISE EXCEPTION 'mem_topic_revert: the assignment no longer stands' USING ERRCODE = '55000';
    END IF;
    v_from := (e.detail ->> 'from')::uuid;
    IF v_from IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.mem_topic x WHERE x.id = v_from AND x.workspace_id = v_ws) THEN
      v_from := NULL;
    END IF;
    UPDATE public.mem_item SET topic_id = v_from WHERE id = i.id;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
    VALUES (v_ws, 'item', i.id, 'reverted', i.channel_id, i.owner_member_id,
            pg_catalog.jsonb_build_object('of', p_event_id, 'what', 'assigned'));
    RETURN 'assigned';
  ELSIF e.action = 'split' AND e.target_kind = 'topic' THEN
    SELECT * INTO t FROM public.mem_topic x WHERE x.id = e.target_id AND x.workspace_id = v_ws FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.mem_topic c WHERE c.parent_id = t.id) THEN
      RAISE EXCEPTION 'mem_topic_revert: the split no longer stands' USING ERRCODE = '55000';
    END IF;
    UPDATE public.mem_item i2 SET topic_id = t.id
     WHERE i2.workspace_id = v_ws AND i2.topic_id IN (SELECT c.id FROM public.mem_topic c WHERE c.parent_id = t.id);
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    DELETE FROM public.mem_topic WHERE parent_id = t.id AND workspace_id = v_ws;
    UPDATE public.mem_topic SET split_lock_until = pg_catalog.now() + interval '24 hours' WHERE id = t.id;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
    VALUES (v_ws, 'topic', t.id, 'reverted', t.channel_id, t.owner_member_id,
            pg_catalog.jsonb_build_object('of', p_event_id, 'what', 'split', 'moved', v_moved));
    RETURN 'split';
  END IF;
  RAISE EXCEPTION 'mem_topic_revert: this event cannot be reverted' USING ERRCODE = '22023';
END
$$;

-- ── 소유자·권한 ────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO mem_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_topic_unassigned(uuid, integer)',
    'mem_topic_leaves(uuid)',
    'mem_topic_assign(uuid, uuid, text, integer)',
    'mem_topic_split_candidates(uuid, integer, integer)',
    'mem_topic_split_apply(uuid, text[], uuid[], integer[], integer)',
    'mem_topic_summary_work(uuid, integer, integer, integer)',
    'mem_topic_set_summary(uuid, text, uuid[], text, text)',
    'mem_topic_gc(uuid)',
    'mem_topic_revert(uuid)',
    'mem_topic_summary_ok(uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO mem_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- 워커 전용 함수는 momo_memory 에만 EXECUTE. mem_topic_summary_ok 는 RLS 정책이 독자 역할로 부르는 도우미라 PUBLIC 이다
-- (뷰어는 GUC 뿐이라 남의 이름으로 물을 수 없다).
DO $$
DECLARE
  r text;
  f text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
  worker_only text[] := ARRAY[
    'mem_topic_unassigned(uuid, integer)',
    'mem_topic_leaves(uuid)',
    'mem_topic_assign(uuid, uuid, text, integer)',
    'mem_topic_split_candidates(uuid, integer, integer)',
    'mem_topic_split_apply(uuid, text[], uuid[], integer[], integer)',
    'mem_topic_summary_work(uuid, integer, integer, integer)',
    'mem_topic_set_summary(uuid, text, uuid[], text, text)',
    'mem_topic_gc(uuid)',
    'mem_topic_revert(uuid)'
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

DO $$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_topic', 'mem_topic_summary'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relname = t AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '% is missing FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
  FOR f IN SELECT p.proname FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.prosecdef AND p.proname LIKE 'mem\_%'
              AND pg_get_userbyid(p.proowner) <> 'mem_definer' LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % is not owned by mem_definer', f;
  END LOOP;
END $$;

-- ── L-9: mem_definer 소유 SECURITY DEFINER 함수 허용 목록 (전체 시그니처; 107 것 + 이 파일의 10개) ──────────────
DO $$
DECLARE
  f text;
  allow text[] := ARRAY[
    'mem_accept_proposal(uuid)', 'mem_add_item(uuid,text,text,text,uuid[],real,boolean,text,text)',
    'mem_adjust_tokens(bigint)', 'mem_advance_cursor(uuid,bigint,uuid,timestamp with time zone)',
    'mem_apply_digest(uuid,uuid,text,bigint,bigint,text,uuid[],text,text,text,uuid[],timestamp with time zone[],timestamp with time zone)',
    'mem_channel_eligible(uuid)', 'mem_channel_switch(uuid)', 'mem_cons_accept(uuid,uuid)',
    'mem_cons_apply(uuid,uuid,text)', 'mem_cons_begin(uuid,uuid,double precision,timestamp with time zone)',
    'mem_cons_close_item(uuid,uuid,uuid,uuid)', 'mem_cons_decay(uuid,integer)',
    'mem_cons_finish(uuid,uuid,boolean,integer)', 'mem_cons_merge_items(uuid,uuid,uuid,uuid)',
    'mem_cons_note_pair(uuid,uuid,text)', 'mem_cons_pairs(uuid,real,real,integer)',
    'mem_cons_propose(text,uuid,uuid)', 'mem_cons_purge_proposals(uuid)', 'mem_cons_reconcile(uuid)',
    'mem_cons_retention(uuid,integer,integer,integer)', 'mem_cons_retire_dead(uuid,integer)',
    'mem_cons_revert(uuid)', 'mem_cursor_state(uuid)', 'mem_digest_audience_ok(uuid,uuid,uuid)',
    'mem_digest_evidence_ok(uuid)', 'mem_digest_index(uuid,text,bigint)', 'mem_digest_live(uuid)',
    'mem_digest_rollup_inputs(uuid,uuid,text,bigint,bigint)', 'mem_drop_digest(uuid)',
    'mem_edit_item(uuid,text,text)', 'mem_forget_item(uuid)', 'mem_item_audience_ok(uuid,uuid,uuid)',
    'mem_item_evidence_ok(uuid)', 'mem_item_live(uuid)', 'mem_item_readable_by(uuid,uuid)',
    'mem_message_changed()', 'mem_proposal_decider(uuid)', 'mem_proposal_evidence_ok(uuid)',
    'mem_propose_item(uuid,text,text,text,uuid[])',
    'mem_record_serving(uuid,uuid,uuid[],uuid[],integer,integer,integer)', 'mem_reject_proposal(uuid)',
    'mem_reserve_tokens(bigint,bigint)', 'mem_search_items(text,integer,uuid,text)',
    'mem_search_items_core(uuid,text,integer,uuid,boolean,uuid,text)',
    'mem_search_items_for(uuid,text,integer,uuid)', 'mem_serve_candidates(uuid,bigint,integer,integer)',
    'mem_serve_items(uuid,integer,integer)', 'mem_serve_requester(uuid)', 'mem_serving_of(uuid)',
    'mem_serving_record_of(uuid)', 'mem_stale_digests(integer,integer)',
    'mem_suppressed_messages(uuid,uuid[])', 'mem_token_budget(bigint)',
    'mem_topic_assign(uuid,uuid,text,integer)', 'mem_topic_gc(uuid)', 'mem_topic_leaves(uuid)',
    'mem_topic_revert(uuid)', 'mem_topic_set_summary(uuid,text,uuid[],text,text)',
    'mem_topic_split_apply(uuid,text[],uuid[],integer[],integer)',
    'mem_topic_split_candidates(uuid,integer,integer)', 'mem_topic_summary_ok(uuid)',
    'mem_topic_summary_work(uuid,integer,integer,integer)', 'mem_topic_unassigned(uuid,integer)'
  ];
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'mem_definer'
              AND p.oid::regprocedure::text <> ALL (allow) LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % owned by mem_definer is not in the allow-list', f;
  END LOOP;
END $$;
