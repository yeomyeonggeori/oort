-- =============================================================================
-- 105_mem_proposal.sql — #3169 / ADR-0196 (팀 기억 v2) M2: 질의 조립 항목 서빙 · 에이전트 기억 제안
--
-- 세 가지를 한다.
--   1. 항목 서빙   mem_serve_items         run 행에서 요청자·답 채널·질의를 DB 가 정해 mem_search_items_for 로
--                                          청중 규칙(D6-4)을 통과한 항목만 돌려준다(워커 전용).
--                  mem_record_serving      영수증: 실은 항목도 청중 규칙을 통과해야 하고, 요청자는 run 행에서
--                                          다시 유도한 사람과 같아야 한다(같은 시그니처로 교체).
--                  mem_serving_record_of   재시도 시 처음 영수증의 요약·항목 id 를 함께 읽는다(mem_serving_of 는 요약만).
--   2. 제안 저장   mem_proposal            「기억해 둘게요」 제안. **mem_item 과 다른 테이블**이다 — 검색·서빙·정책이
--                                          읽는 표면(mem_item)에는 사람이 수락하기 전까지 아무것도 들어가지 않는다.
--                  mem_propose_item        에이전트가 부르는 도구의 DB 쪽(워커 전용). 에이전트·요청자·채널은 run 행에서,
--                                          인자는 글과 근거 메시지 id 뿐이다.
--   3. 수락·거절   mem_accept_proposal     API 쪽(momo_app 세션만, 뷰어 = app.member_id). 근거를 다시 전부 검증하고
--                  mem_reject_proposal     origin='confirmed' 항목을 넣는다. 거절은 mem_event 만 남긴다.
--
-- ── 결정(ADR-0196) ──────────────────────────────────────────────────────────────
--  * 에이전트는 제안만 한다(D4 「에이전트는 도구로 제안만」, plan §4.5). 저장·권한은 서버가 집행한다.
--  * 누가 수락하나: 제안된 채널을 지금 읽을 수 있는 활성 **사람** 멤버 누구나. 근거는 전부 그 채널의 메시지라
--    「근거를 읽을 수 있는 사람」과 같은 집합이다. 근거: D4(사람의 제안 카드 수락 = origin=confirmed), D9 표
--    (편집·잊기 = 근거 채널 멤버), D6-2(읽기 = 근거를 전부 읽을 수 있을 때). 요청자만으로 좁히지 않는 이유는 plan V3 가
--    「채널 타임라인 위 1급 객체」라서다 — 요청자가 자리를 비웠다고 채널의 결정이 기억되지 못하면 안 된다.
--    개인 공간(사람↔에이전트 DM)에서는 DM 의 사람이 곧 유일한 멤버다. 에이전트는 수락할 수 없다.
--  * 수락 = 새 항목 origin='confirmed'(정리 잡이 자동 감쇠·병합하지 않는다, D4). 소유는 저장 채널의 성격을 따른다
--    (DM 이면 개인 공간, 소유자는 DM 의 사람).
--  * 수락·거절 뒤에는 제안 행에서 본문·근거 id 를 지운다(내용은 항목이 갖는다). 잊기(영구 삭제)가 제안 쪽에 본문을
--    남기지 않게 하려는 것이다.
--  * 제안은 14일 뒤 만료(수락 불가, 목록에서 사라짐). 만료·근거 삭제된 제안의 본문 정리는 M3 정리 잡(#3172)의 몫이다.
--  * 제안 요율 제한: run 당 3건, 채널의 대기 제안 20건, 에이전트당 시간당 30건. 넘으면 SQLSTATE 54000.
--
-- 재실행 가능한 문장만 쓴다. schema_v0.sql·100~104 는 고치지 않는다.
-- =============================================================================

-- ── mem_event 어휘 확장 ────────────────────────────────────────────────────────
-- 제안·거절은 항목이 없는 사건이다. target_kind 에 proposal, action 에 proposed/rejected 를 더한다.
-- (수락은 새 항목에 대한 created + confirmed 로 남는다.)
ALTER TABLE mem_event DROP CONSTRAINT IF EXISTS mem_event_target_ck;
ALTER TABLE mem_event ADD CONSTRAINT mem_event_target_ck
  CHECK (target_kind IN ('item', 'digest', 'topic', 'workspace', 'proposal'));
ALTER TABLE mem_event DROP CONSTRAINT IF EXISTS mem_event_action_ck;
ALTER TABLE mem_event ADD CONSTRAINT mem_event_action_ck
  CHECK (action IN
    ('created', 'confirmed', 'edited', 'merged', 'superseded', 'retired', 'forgotten',
     'served', 'withheld', 'reset', 'proposed', 'rejected', 'expired'));

-- ── 제안 테이블 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mem_proposal (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id         uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id           uuid NOT NULL,
  -- 제안한 run(지워져도 제안은 남는다). 에이전트·요청자는 run 행에서 DB 가 정한 값이다.
  run_id               uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  agent_member_id      uuid NOT NULL,
  requester_member_id  uuid NOT NULL,
  kind                 text NOT NULL,
  -- 결정 전에만 있다(수락·거절 뒤 NULL). 항목이 본문을 갖는다.
  body                 text,
  subject_key          text,
  evidence_message_ids uuid[] NOT NULL DEFAULT '{}',
  content_hash         text NOT NULL,
  status               text NOT NULL DEFAULT 'pending',
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL DEFAULT now() + interval '14 days',
  decided_by           uuid,
  decided_at           timestamptz,
  item_id              uuid REFERENCES mem_item(id) ON DELETE SET NULL,
  CONSTRAINT mem_proposal_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_proposal_agent_fk FOREIGN KEY (workspace_id, agent_member_id)
    REFERENCES member (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mem_proposal_requester_fk FOREIGN KEY (workspace_id, requester_member_id)
    REFERENCES member (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mem_proposal_kind_ck CHECK (kind IN ('decision', 'fact', 'commitment', 'preference', 'procedure')),
  CONSTRAINT mem_proposal_status_ck CHECK (status IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT mem_proposal_subject_ck CHECK (subject_key IS NULL OR char_length(subject_key) BETWEEN 1 AND 80),
  CONSTRAINT mem_proposal_shape_ck CHECK (
    (status = 'pending'
       AND body IS NOT NULL AND char_length(btrim(body)) BETWEEN 1 AND 600
       AND cardinality(evidence_message_ids) BETWEEN 1 AND 8
       AND decided_at IS NULL AND decided_by IS NULL AND item_id IS NULL)
    OR (status IN ('accepted', 'rejected')
       AND body IS NULL AND subject_key IS NULL AND cardinality(evidence_message_ids) = 0
       AND decided_at IS NOT NULL AND decided_by IS NOT NULL
       AND (item_id IS NULL OR status = 'accepted'))
  )
);
-- 같은 채널에서 같은 내용의 대기 제안은 하나(에이전트가 다시 시도해도 카드가 겹치지 않는다).
CREATE UNIQUE INDEX IF NOT EXISTS mem_proposal_pending_uq
  ON mem_proposal (workspace_id, channel_id, content_hash) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS mem_proposal_channel_idx
  ON mem_proposal (workspace_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mem_proposal_run_idx
  ON mem_proposal (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_proposal_agent_idx
  ON mem_proposal (workspace_id, agent_member_id, created_at DESC);

-- 정의자는 자기 테이블을 읽고 넣고, 결정할 때 바뀌는 열만 고친다.
GRANT SELECT, INSERT ON mem_proposal TO mem_definer;
GRANT UPDATE (status, body, subject_key, evidence_message_ids, decided_by, decided_at, item_id)
  ON mem_proposal TO mem_definer;

-- ── 읽기 도우미 (RLS 정책이 부른다 → PUBLIC EXECUTE, 뷰어 = GUC) ─────────────────────
-- 대기 제안의 근거가 지금도 살아 있는가: 전부 제안 채널의 메시지이고, 지워지지 않았고, 제안 뒤에 수정되지 않았다.
-- 근거가 사라지면 제안의 본문(그 메시지를 옮긴 글)도 보이지 않아야 한다.
CREATE OR REPLACE FUNCTION mem_proposal_evidence_ok(p_proposal_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT pg_catalog.cardinality(p.evidence_message_ids) >= 1
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.unnest(p.evidence_message_ids) AS e(mid)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.message m
             WHERE m.id = e.mid
               AND m.channel_id = p.channel_id
               AND m.workspace_id = p.workspace_id
               AND m.deleted_at IS NULL
               AND m.state <> 'deleted'
               AND (m.edited_at IS NULL OR m.edited_at <= p.created_at)))
      FROM public.mem_proposal p
     WHERE p.id = p_proposal_id
       AND p.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  ), false)
$$;

-- ── 제안 (에이전트 도구의 DB 쪽; 워커 전용) ──────────────────────────────────────────
-- 인자는 종류·글·근거 메시지 id 뿐이다. 에이전트(= run 의 에이전트)·채널(= run 의 채널)·요청자(= run 행에서
-- 유도)는 호출자가 정하지 못한다. 근거는 run 의 채널의 살아 있는 사람 메시지여야 하고, 트리거 메시지보다
-- 뒤의 것이나 너무 오래된 것(200개 앞)은 「지금 대화」가 아니다. 에이전트가 읽지 못하는(채널 멤버가 아닌) 곳의 메시지,
-- 다른 채널의 메시지, 에이전트·봇 발언, run 이 시작된 뒤 수정된 메시지는 거부한다.
--   NULL 반환 = 이미 기억하고 있거나 이미 제안 중인 같은 내용(새 행 없음).
--   23514 내용 거부(종류·길이·시크릿 모양·에이전트 발언) · 23503 근거가 대화에 없음 · 40001 근거가 그 사이 수정됨
--   55000 이 자리에서는 제안할 수 없음(스위치·요청자 없음·끝난 run) · 54000 요율 제한
DROP FUNCTION IF EXISTS mem_propose_item(uuid, text, text, text, uuid[]);
CREATE OR REPLACE FUNCTION mem_propose_item(
  p_run_id uuid, p_kind text, p_body text, p_subject_key text, p_evidence_message_ids uuid[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_n integer := COALESCE(pg_catalog.cardinality(p_evidence_message_ids), 0);
  v_body text := pg_catalog.btrim(COALESCE(p_body, ''));
  v_subject text := nullif(pg_catalog.btrim(COALESCE(p_subject_key, '')), '');
  v_channel uuid;
  v_agent uuid;
  v_trigger uuid;
  v_status public.run_status;
  v_run_created timestamptz;
  v_trigger_seq bigint;
  v_req uuid;
  v_norm text;
  v_hash text;
  v_id uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_propose_item: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('decision', 'fact', 'commitment', 'preference', 'procedure') THEN
    RAISE EXCEPTION 'mem_propose_item: unknown kind' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.char_length(v_body) NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'mem_propose_item: body must be 1..600 characters' USING ERRCODE = '23514';
  END IF;
  IF v_subject IS NOT NULL AND pg_catalog.char_length(v_subject) > 80 THEN
    RAISE EXCEPTION 'mem_propose_item: subject_key is at most 80 characters' USING ERRCODE = '23514';
  END IF;
  IF public.mem_looks_like_secret(v_body) OR public.mem_looks_like_secret(COALESCE(v_subject, '')) THEN
    RAISE EXCEPTION 'mem_propose_item: body looks like a credential' USING ERRCODE = '23514';
  END IF;
  IF v_n = 0 OR v_n > 8 THEN
    RAISE EXCEPTION 'mem_propose_item: 1..8 evidence messages are required' USING ERRCODE = '23514';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT e) FROM pg_catalog.unnest(p_evidence_message_ids) AS e) <> v_n THEN
    RAISE EXCEPTION 'mem_propose_item: duplicate or NULL evidence message' USING ERRCODE = '23514';
  END IF;

  -- 에이전트·채널은 run 행에서. 호출자가 정하지 않는다.
  SELECT r.channel_id, r.agent_member_id, r.trigger_message_id, r.status, r.created_at
    INTO v_channel, v_agent, v_trigger, v_status, v_run_created
    FROM public.agent_run r WHERE r.id = p_run_id AND r.workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_propose_item: run not in workspace' USING ERRCODE = '23503';
  END IF;
  IF v_status IN ('succeeded', 'failed', 'cancelled', 'timed_out') THEN
    RAISE EXCEPTION 'mem_propose_item: the run has ended' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.member a
                  WHERE a.id = v_agent AND a.workspace_id = v_ws AND a.kind = 'agent'
                    AND a.status = 'active' AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'mem_propose_item: only an active agent proposes' USING ERRCODE = '55000';
  END IF;
  v_req := public.mem_serve_requester(p_run_id);
  IF v_req IS NULL THEN
    RAISE EXCEPTION 'mem_propose_item: this run has no human requester' USING ERRCODE = '55000';
  END IF;
  -- 스위치: 워크스페이스·채널·DM 규칙(mem_channel_eligible) + 요청자의 개인 일시정지.
  IF NOT public.mem_channel_eligible(v_channel) THEN
    RAISE EXCEPTION 'mem_propose_item: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mem_settings s
              WHERE s.workspace_id = v_ws AND s.scope = 'member'
                AND s.member_id = v_req AND s.paused) THEN
    RAISE EXCEPTION 'mem_propose_item: the requester paused memory' USING ERRCODE = '55000';
  END IF;
  -- 에이전트도 요청자도 이 채널을 읽을 수 있어야 한다(에이전트가 못 읽는 곳의 메시지를 인용할 수 없다).
  IF NOT public.mem_member_can_read(v_channel, v_agent)
     OR NOT public.mem_member_can_read(v_channel, v_req) THEN
    RAISE EXCEPTION 'mem_propose_item: the agent and the requester must both read the channel'
      USING ERRCODE = '55000';
  END IF;

  IF v_trigger IS NOT NULL THEN
    SELECT tm.seq INTO v_trigger_seq FROM public.message tm
     WHERE tm.id = v_trigger AND tm.workspace_id = v_ws AND tm.channel_id = v_channel;
  END IF;
  -- M-1 (보안 검수): 「지금 대화」의 기준 seq 는 절대 비지 않는다. 트리거가 없는 run(parent_run_id 로 이어진 자식 run)
  -- 이나 트리거 행을 못 찾는 run 은 「run 이 시작될 때의 채널 머리 seq」를 기준으로 삼는다 — 에이전트가 그 시점에 볼 수
  -- 있던 최신 메시지다. 창(200개)을 건너뛰는 fail-open 을 두지 않는다. 거부(55000) 대신 폴백을 고른 이유: A2A 위임 자식
  -- run 도 요청자(사슬)가 있어 정당하게 제안할 수 있고, 머리 seq 는 그 run 이 볼 수 있던 범위의 상한이라 트리거 기준과
  -- 같은 성질(뒤의 메시지·오래된 메시지 거부)을 유지한다. 빈 채널이면 0 이라 어떤 근거도 통과하지 못한다.
  IF v_trigger_seq IS NULL THEN
    SELECT COALESCE(pg_catalog.max(hm.seq), 0) INTO v_trigger_seq FROM public.message hm
     WHERE hm.workspace_id = v_ws AND hm.channel_id = v_channel AND hm.created_at <= v_run_created;
  END IF;

  -- 락 순서는 어디서나 「메시지 행 → 채널 advisory」(102 H-1).
  PERFORM 1 FROM public.message m
   WHERE m.id = ANY (p_evidence_message_ids) AND m.workspace_id = v_ws AND m.channel_id = v_channel
   ORDER BY m.id
   FOR KEY SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_digest:' || v_channel::text, 0));

  -- 근거: 이 run 의 채널의 살아 있는 메시지, 트리거 근방(뒤의 것·200개 앞보다 오래된 것은 대화 밖), DM 은 합류 이후만.
  IF (SELECT pg_catalog.count(*) FROM public.message m
       WHERE m.id = ANY (p_evidence_message_ids)
         AND m.channel_id = v_channel AND m.workspace_id = v_ws
         AND m.deleted_at IS NULL AND m.state <> 'deleted'
         -- 에이전트도 요청자도 그 메시지의 채널을 읽을 수 있어야 한다(위의 「같은 채널」과 독립된 벽).
         AND public.mem_member_can_read(m.channel_id, v_agent)
         AND public.mem_member_can_read(m.channel_id, v_req)
         AND (m.seq <= v_trigger_seq AND m.seq > v_trigger_seq - 200)
         AND (NOT EXISTS (SELECT 1 FROM public.channel dc WHERE dc.id = m.channel_id AND dc.kind = 'dm')
              OR m.created_at >= (
                   SELECT pg_catalog.max(x.joined_at) FROM public.membership x
                    WHERE x.channel_id = m.channel_id AND x.workspace_id = m.workspace_id
                      AND x.left_at IS NULL))
     ) <> v_n THEN
    RAISE EXCEPTION 'mem_propose_item: evidence must be live messages of this run''s conversation'
      USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM public.message m
              WHERE m.id = ANY (p_evidence_message_ids)
                AND m.edited_at IS NOT NULL AND m.edited_at > v_run_created) THEN
    RAISE EXCEPTION 'mem_propose_item: evidence was edited after the run began' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.message m
               JOIN public.member au ON au.id = m.author_member_id AND au.workspace_id = m.workspace_id
              WHERE m.id = ANY (p_evidence_message_ids) AND au.kind <> 'human') THEN
    RAISE EXCEPTION 'mem_propose_item: evidence written by an agent or bot cannot support a memory'
      USING ERRCODE = '23514';
  END IF;

  -- L-2: 같은 채널의 제안은 중복 검사 **전에** 직렬화한다(동시에 같은 내용이 들어와 둘 다 검사를 통과한 뒤 23505 로
  -- 터지는 길을 막는다). 요율 제한의 카운트도 이 락 아래에서 센다. 아래 INSERT 의 ON CONFLICT 는 두 번째 벽이다.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mem_proposal:' || v_channel::text, 0));

  -- 같은 채널·같은 내용: 이미 기억하고 있거나 이미 제안 중이면 새로 만들지 않는다.
  v_norm := pg_catalog.lower(pg_catalog.regexp_replace(v_body, '[[:space:]]+', ' ', 'g'));
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_kind || ':' || v_norm, 'UTF8')), 'hex');
  -- 만료된 대기 제안이 같은 내용을 막지 않게 정리한다(본문·근거 id 를 지우고 거절 껍데기로 닫는다).
  -- L-7: `decided_by` 는 NOT NULL·shape CHECK 가 결정자를 요구해서 **제안한 에이전트**로 채운다 — 사람의 결정이 아니다.
  -- 그래서 사건을 `rejected` 가 아니라 `expired`(행위자 = 에이전트, detail.by='expiry')로 남긴다. UI 는 `expired` 이벤트가
  -- 있는 껍데기를 「사람이 거절함」으로 읽지 말 것(만료 카드는 목록에도 나오지 않는다).
  WITH closed AS (
    UPDATE public.mem_proposal
       SET status = 'rejected', body = NULL, subject_key = NULL, evidence_message_ids = '{}',
           decided_by = v_agent, decided_at = pg_catalog.now()
     WHERE workspace_id = v_ws AND channel_id = v_channel AND content_hash = v_hash
       AND status = 'pending' AND expires_at <= pg_catalog.now()
    RETURNING id
  )
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id, detail)
  SELECT v_ws, 'proposal', c.id, 'expired', v_agent, pg_catalog.jsonb_build_object('by', 'expiry')
    FROM closed c;
  IF EXISTS (SELECT 1 FROM public.mem_item i
              WHERE i.workspace_id = v_ws AND i.channel_id = v_channel AND i.content_hash = v_hash
                AND i.retired_at IS NULL AND NOT i.stale AND public.mem_item_live(i.id))
     OR EXISTS (SELECT 1 FROM public.mem_proposal p
                 WHERE p.workspace_id = v_ws AND p.channel_id = v_channel
                   AND p.content_hash = v_hash AND p.status = 'pending') THEN
    RETURN NULL;
  END IF;

  -- 요율 제한(위의 채널 락 아래에서 센다: 동시에 여러 개가 한도를 함께 넘지 못한다).
  IF (SELECT pg_catalog.count(*) FROM public.mem_proposal p
       WHERE p.workspace_id = v_ws AND p.run_id = p_run_id) >= 3
     OR (SELECT pg_catalog.count(*) FROM public.mem_proposal p
          WHERE p.workspace_id = v_ws AND p.channel_id = v_channel
            AND p.status = 'pending' AND p.expires_at > pg_catalog.now()) >= 20
     OR (SELECT pg_catalog.count(*) FROM public.mem_proposal p
          WHERE p.workspace_id = v_ws AND p.agent_member_id = v_agent
            AND p.created_at > pg_catalog.now() - interval '1 hour') >= 30 THEN
    RAISE EXCEPTION 'mem_propose_item: too many proposals' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.mem_proposal
    (workspace_id, channel_id, run_id, agent_member_id, requester_member_id, kind, body,
     subject_key, evidence_message_ids, content_hash)
  VALUES
    (v_ws, v_channel, p_run_id, v_agent, v_req, p_kind, v_body, v_subject,
     (SELECT pg_catalog.array_agg(e ORDER BY e) FROM pg_catalog.unnest(p_evidence_message_ids) AS e),
     v_hash)
  ON CONFLICT (workspace_id, channel_id, content_hash) WHERE status = 'pending' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id, detail)
  VALUES (v_ws, 'proposal', v_id, 'proposed', v_agent,
          pg_catalog.jsonb_build_object('run_id', p_run_id, 'kind', p_kind, 'evidence_count', v_n));
  RETURN v_id;
END
$$;

-- ── 수락·거절 (API 쪽; momo_app 세션만, 뷰어 = app.member_id) ───────────────────────
-- 두 함수는 같은 권한 규칙을 쓴다. 제안이 없거나 못 읽는 것과 권한 없음은 같은 42501 이다(존재 오라클 없음).
-- 상태 충돌(이미 결정됨·만료·스위치 꺼짐)은 55000, 근거가 그 사이 지워짐 23503, 수정됨 40001.
CREATE OR REPLACE FUNCTION mem_proposal_decider(p_proposal_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_viewer uuid := nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid;
  v_channel uuid;
BEGIN
  IF session_user::text <> 'momo_app'
     AND NOT COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user::text), false) THEN
    RAISE EXCEPTION 'mem_proposal: only the API role decides proposals' USING ERRCODE = '42501';
  END IF;
  IF v_ws IS NULL OR v_viewer IS NULL THEN
    RAISE EXCEPTION 'mem_proposal: no viewer' USING ERRCODE = '42501';
  END IF;
  SELECT p.channel_id INTO v_channel FROM public.mem_proposal p
   WHERE p.id = p_proposal_id AND p.workspace_id = v_ws;
  IF v_channel IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.member h
                     WHERE h.id = v_viewer AND h.workspace_id = v_ws AND h.kind = 'human'
                       AND h.status = 'active' AND h.deleted_at IS NULL)
     OR NOT public.mem_member_can_read(v_channel, v_viewer)
     -- M-2 (보안 검수, #3209 와 같은 결정): 게스트는 수락·거절할 수 없다 — 워크스페이스 역할이 guest 이거나 이 채널의
     -- 멤버십 역할이 guest 이면 DB 가 42501 로 거부한다(라우트의 검사는 두 번째 벽). 읽기(목록)는 그대로다.
     OR EXISTS (SELECT 1 FROM public.workspace_membership wm
                 WHERE wm.workspace_id = v_ws AND wm.member_id = v_viewer AND wm.role = 'guest')
     OR EXISTS (SELECT 1 FROM public.membership gm
                 WHERE gm.workspace_id = v_ws AND gm.channel_id = v_channel AND gm.member_id = v_viewer
                   AND gm.left_at IS NULL AND gm.role = 'guest') THEN
    RAISE EXCEPTION 'mem_proposal: not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN v_viewer;
END
$$;

CREATE OR REPLACE FUNCTION mem_reject_proposal(p_proposal_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_viewer uuid := public.mem_proposal_decider(p_proposal_id);
  v_p public.mem_proposal%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM public.mem_proposal p
   WHERE p.id = p_proposal_id AND p.workspace_id = v_ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_reject_proposal: not allowed' USING ERRCODE = '42501';
  END IF;
  IF v_p.status <> 'pending' THEN
    RAISE EXCEPTION 'mem_reject_proposal: already decided' USING ERRCODE = '55000';
  END IF;
  UPDATE public.mem_proposal
     SET status = 'rejected', body = NULL, subject_key = NULL, evidence_message_ids = '{}',
         decided_by = v_viewer, decided_at = pg_catalog.now()
   WHERE id = p_proposal_id;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id, detail)
  VALUES (v_ws, 'proposal', p_proposal_id, 'rejected', v_viewer,
          pg_catalog.jsonb_build_object('kind', v_p.kind, 'run_id', v_p.run_id,
                                        'agent_member_id', v_p.agent_member_id));
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION mem_accept_proposal(p_proposal_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_viewer uuid := public.mem_proposal_decider(p_proposal_id);
  v_p public.mem_proposal%ROWTYPE;
  v_n integer;
  v_ckind public.channel_kind;
  v_space text := 'channel';
  v_owner uuid;
  v_valid_from timestamptz;
  v_norm text;
  v_hash text;
  v_old uuid;
  v_old_body text;
  v_item uuid;
  v_new boolean := false;
BEGIN
  SELECT * INTO v_p FROM public.mem_proposal p
   WHERE p.id = p_proposal_id AND p.workspace_id = v_ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_accept_proposal: not allowed' USING ERRCODE = '42501';
  END IF;
  IF v_p.status <> 'pending' THEN
    RAISE EXCEPTION 'mem_accept_proposal: already decided' USING ERRCODE = '55000';
  END IF;
  IF v_p.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'mem_accept_proposal: the proposal expired' USING ERRCODE = '55000';
  END IF;
  v_n := pg_catalog.cardinality(v_p.evidence_message_ids);

  -- 락 순서: 메시지 행 → 채널 advisory(102 H-1).
  PERFORM 1 FROM public.message m
   WHERE m.id = ANY (v_p.evidence_message_ids) AND m.workspace_id = v_ws
   ORDER BY m.id
   FOR KEY SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_digest:' || v_p.channel_id::text, 0));
  IF NOT public.mem_channel_eligible(v_p.channel_id) THEN
    RAISE EXCEPTION 'mem_accept_proposal: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;

  -- 수락하는 사람이 근거를 전부 읽을 수 있어야 한다. 제안을 믿지 않고 다시 확인한다:
  --   ① 메시지가 제안 채널의 것이고 ② 지금 살아 있고(삭제·제안 뒤 수정 없음) ③ 수락하는 사람이 그 메시지의 채널을
  --   읽을 수 있고 ④ 작성자가 사람이며 ⑤ DM 이면 합류 이후. ①과 ③은 서로 독립된 벽이다.
  IF (SELECT pg_catalog.count(*) FROM public.message m
       WHERE m.id = ANY (v_p.evidence_message_ids)
         AND m.workspace_id = v_ws
         AND m.channel_id = v_p.channel_id
         AND m.deleted_at IS NULL AND m.state <> 'deleted'
         AND public.mem_member_can_read(m.channel_id, v_viewer)
         AND (NOT EXISTS (SELECT 1 FROM public.channel dc WHERE dc.id = m.channel_id AND dc.kind = 'dm')
              OR m.created_at >= (
                   SELECT pg_catalog.max(x.joined_at) FROM public.membership x
                    WHERE x.channel_id = m.channel_id AND x.workspace_id = m.workspace_id
                      AND x.left_at IS NULL))
     ) <> v_n THEN
    RAISE EXCEPTION 'mem_accept_proposal: an evidence message is gone or not readable by the accepter'
      USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM public.message m
              WHERE m.id = ANY (v_p.evidence_message_ids)
                AND m.edited_at IS NOT NULL AND m.edited_at > v_p.created_at) THEN
    RAISE EXCEPTION 'mem_accept_proposal: evidence was edited after it was proposed' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.message m
               JOIN public.member au ON au.id = m.author_member_id AND au.workspace_id = m.workspace_id
              WHERE m.id = ANY (v_p.evidence_message_ids) AND au.kind <> 'human') THEN
    RAISE EXCEPTION 'mem_accept_proposal: evidence written by an agent or bot cannot support a memory'
      USING ERRCODE = '23514';
  END IF;
  IF public.mem_looks_like_secret(v_p.body) OR public.mem_looks_like_secret(COALESCE(v_p.subject_key, '')) THEN
    RAISE EXCEPTION 'mem_accept_proposal: body looks like a credential' USING ERRCODE = '23514';
  END IF;

  SELECT c.kind INTO v_ckind FROM public.channel c WHERE c.id = v_p.channel_id AND c.workspace_id = v_ws;
  IF v_ckind = 'dm' THEN
    -- mem_channel_eligible 가 사람 정확히 1명 + 활성 에이전트 1명인 DM 만 통과시켰다.
    v_space := 'personal';
    SELECT x.member_id INTO STRICT v_owner
      FROM public.membership x
      JOIN public.member mm ON mm.id = x.member_id AND mm.workspace_id = x.workspace_id
     WHERE x.channel_id = v_p.channel_id AND x.workspace_id = v_ws AND x.left_at IS NULL AND mm.kind = 'human';
  END IF;

  SELECT pg_catalog.max(m.created_at) INTO v_valid_from
    FROM public.message m WHERE m.id = ANY (v_p.evidence_message_ids);
  v_norm := pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(v_p.body), '[[:space:]]+', ' ', 'g'));
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_p.kind || ':' || v_norm, 'UTF8')), 'hex');

  -- 같은 내용의 살아 있는 항목이 이미 있으면 그것을 가리킨다(추가만: 고치지 않는다). 죽은 옛 행이면 stale 로 내리고 새로 넣는다.
  SELECT i.id, i.body INTO v_old, v_old_body FROM public.mem_item i
   WHERE i.workspace_id = v_ws AND i.channel_id = v_p.channel_id AND i.content_hash = v_hash
     AND i.retired_at IS NULL AND NOT i.stale
   FOR UPDATE;
  IF FOUND THEN
    IF pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(v_old_body), '[[:space:]]+', ' ', 'g')) <> v_norm THEN
      RAISE EXCEPTION 'mem_accept_proposal: content hash collision' USING ERRCODE = '23514';
    END IF;
    IF public.mem_item_live(v_old) THEN
      v_item := v_old;
    ELSE
      UPDATE public.mem_item SET stale = true WHERE id = v_old;
    END IF;
  END IF;

  IF v_item IS NULL THEN
    INSERT INTO public.mem_item
      (workspace_id, space_kind, channel_id, owner_member_id, kind, origin, body, subject_key,
       valid_from, confidence, forget_after, content_hash, extractor_version, model, source_count)
    VALUES
      (v_ws, v_space, v_p.channel_id, v_owner, v_p.kind, 'confirmed', pg_catalog.btrim(v_p.body),
       v_p.subject_key, v_valid_from, 1, NULL, v_hash, 'proposal-v1', NULL, v_n)
    RETURNING id INTO v_item;
    INSERT INTO public.mem_evidence (workspace_id, item_id, message_id, channel_id, created_at)
    SELECT v_ws, v_item, e, v_p.channel_id, v_p.created_at
      FROM pg_catalog.unnest(v_p.evidence_message_ids) AS e;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, detail)
    VALUES (v_ws, 'item', v_item, 'created',
            pg_catalog.jsonb_build_object(
              'kind', v_p.kind, 'space', v_space, 'origin', 'confirmed', 'proposal_id', p_proposal_id,
              'source_count', v_n, 'extractor_version', 'proposal-v1'));
    v_new := true;
  END IF;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id, detail)
  VALUES (v_ws, 'item', v_item, 'confirmed', v_viewer,
          pg_catalog.jsonb_build_object(
            'proposal_id', p_proposal_id, 'agent_member_id', v_p.agent_member_id,
            'run_id', v_p.run_id, 'duplicate', NOT v_new));
  UPDATE public.mem_proposal
     SET status = 'accepted', body = NULL, subject_key = NULL, evidence_message_ids = '{}',
         decided_by = v_viewer, decided_at = pg_catalog.now(), item_id = v_item
   WHERE id = p_proposal_id;
  RETURN v_item;
END
$$;

-- ── 항목 서빙 (워커 전용) ────────────────────────────────────────────────────────
-- 요청자·답 채널·질의를 run 행에서 DB 가 정한다(페이로드에서 받지 않는다). 질의는 트리거 메시지 본문(@멘션 제외,
-- 앞 400자). 스위치는 mem_serve_candidates(103)와 같다: 워크스페이스·답 채널·요청자 개인 일시정지·요청자의 채널
-- 읽기. 후보는 mem_search_items_for 만 통과한다 — 청중 좁히기(mem_item_audience_ok)는 그 함수 안에 있고 여기서 다시
-- 거르지 않는다. 걸린 스위치·요청자 없음·질의 없음은 행 0개.
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
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_channel uuid;
  v_trigger uuid;
  v_req uuid;
  v_query text;
  v_limit integer := least(greatest(COALESCE(p_limit, 8), 1), 20);
  v_body_max integer := least(greatest(COALESCE(p_body_max, 600), 50), 600);
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

  RETURN QUERY
  SELECT v_req, v_channel, s.id, s.channel_id, s.space_kind, s.kind,
         (SELECT i.origin FROM public.mem_item i WHERE i.id = s.id),
         pg_catalog.left(s.body, v_body_max), s.valid_from,
         (SELECT i.source_count FROM public.mem_item i WHERE i.id = s.id)
    FROM public.mem_search_items_for(v_req, v_query, v_limit, v_channel) s;
END
$$;

-- 재시도 때 처음 영수증에 기록된 요약·항목 id(없으면 행 0개).
CREATE OR REPLACE FUNCTION mem_serving_record_of(p_run_id uuid)
RETURNS TABLE (served_digest_ids uuid[], served_item_ids uuid[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.digest_ids, s.item_ids FROM public.mem_serving s
   WHERE s.run_id = p_run_id
     AND s.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
$$;

-- ── 영수증 (같은 시그니처로 교체) ────────────────────────────────────────────────
-- 100 판에서 바뀐 것:
--   * 요청자는 run 행에서 유도한 사람(mem_serve_requester)과 같아야 한다 — 호출자가 다른 사람의 이름으로 청중 규칙을
--     묻는 길을 막는다(22023).
--   * 실은 항목도 요약처럼 존재해야 하고(같은 워크스페이스) 답 채널의 청중 규칙(mem_item_audience_ok)을 통과해야
--     한다. 100 판은 item_ids 를 검증 없이 저장했다(23514).
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
  v_items uuid[] := COALESCE(p_item_ids, '{}');
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
  IF p_requester_member_id IS DISTINCT FROM public.mem_serve_requester(p_run_id) THEN
    RAISE EXCEPTION 'mem_record_serving: the requester is not the run''s' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(v_digests) > 50 OR pg_catalog.cardinality(v_items) > 50 THEN
    RAISE EXCEPTION 'mem_record_serving: too many entries' USING ERRCODE = '23514';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.mem_digest d
       WHERE d.id = ANY (v_digests) AND d.workspace_id = v_ws)
     <> (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(v_digests) AS x) THEN
    RAISE EXCEPTION 'mem_record_serving: unknown digest' USING ERRCODE = '23503';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.mem_item i
       WHERE i.id = ANY (v_items) AND i.workspace_id = v_ws)
     <> (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(v_items) AS x)
     OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(v_items) AS x)
        <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'mem_record_serving: unknown or repeated item' USING ERRCODE = '23503';
  END IF;
  -- 실은 요약·항목은 전부 이 답 채널의 청중 규칙(D6-4)을 통과해야 한다.
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_digests) AS x(id)
              WHERE NOT public.mem_digest_audience_ok(x.id, v_channel, p_requester_member_id)) THEN
    RAISE EXCEPTION 'mem_record_serving: a digest is not servable to this answer channel'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_items) AS x(id)
              WHERE NOT public.mem_item_audience_ok(x.id, v_channel, p_requester_member_id)) THEN
    RAISE EXCEPTION 'mem_record_serving: an item is not servable to this answer channel'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.mem_serving
    (workspace_id, run_id, channel_id, digest_ids, item_ids, withheld_count, budget_chars, used_chars)
  VALUES
    (v_ws, p_run_id, v_channel, v_digests, v_items,
     COALESCE(p_withheld_count, 0), COALESCE(p_budget_chars, 0), COALESCE(p_used_chars, 0))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- ── 소유자·권한 ────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO mem_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_proposal_evidence_ok(uuid)', 'mem_propose_item(uuid, text, text, text, uuid[])',
    'mem_proposal_decider(uuid)', 'mem_accept_proposal(uuid)', 'mem_reject_proposal(uuid)',
    'mem_serve_items(uuid, integer, integer)', 'mem_serving_record_of(uuid)',
    'mem_record_serving(uuid, uuid, uuid[], uuid[], integer, integer, integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO mem_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- ── RLS ────────────────────────────────────────────────────────────────────────
ALTER TABLE mem_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE mem_proposal FORCE ROW LEVEL SECURITY;

-- 쓰기는 mem_definer 에만. 나중에 누가 permissive 쓰기 정책을 더해도 RESTRICTIVE 는 AND 라 못 뚫는다.
DROP POLICY IF EXISTS mem_proposal_ins ON mem_proposal;
CREATE POLICY mem_proposal_ins ON mem_proposal FOR INSERT TO mem_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_proposal_upd ON mem_proposal;
CREATE POLICY mem_proposal_upd ON mem_proposal FOR UPDATE TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_proposal_sel_definer ON mem_proposal;
CREATE POLICY mem_proposal_sel_definer ON mem_proposal FOR SELECT TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_proposal_only_definer_ins ON mem_proposal;
CREATE POLICY mem_proposal_only_definer_ins ON mem_proposal AS RESTRICTIVE FOR INSERT
  WITH CHECK (current_user = 'mem_definer');
DROP POLICY IF EXISTS mem_proposal_only_definer_upd ON mem_proposal;
CREATE POLICY mem_proposal_only_definer_upd ON mem_proposal AS RESTRICTIVE FOR UPDATE
  USING (current_user = 'mem_definer') WITH CHECK (current_user = 'mem_definer');
DROP POLICY IF EXISTS mem_proposal_only_definer_del ON mem_proposal;
CREATE POLICY mem_proposal_only_definer_del ON mem_proposal AS RESTRICTIVE FOR DELETE
  USING (false);

-- 읽기: 제안된 채널을 읽을 수 있는 사람만. 대기 중인 제안은 만료 전이고 근거가 전부 살아 있을 때만 보인다
-- (지운 메시지를 옮긴 글이 카드로 남으면 안 된다). 결정된 제안은 본문이 없는 껍데기(상태·항목 id)다.
DROP POLICY IF EXISTS mem_proposal_sel ON mem_proposal;
CREATE POLICY mem_proposal_sel ON mem_proposal FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_can_read_channel(channel_id)
    AND CASE WHEN current_user = 'mem_definer' THEN false
             ELSE (status <> 'pending' OR (expires_at > now() AND mem_proposal_evidence_ok(id)))
        END
  );

-- ── 런타임 역할 권한 (이 마이그레이션이 만든 객체만) ─────────────────────────────────
-- 테이블은 momo_app 이 SELECT(RLS 로 좁혀짐)만. 워커 전용 함수는 momo_memory 에만 EXECUTE.
-- API 쪽 함수(mem_accept/reject_proposal)와 정책 도우미(mem_proposal_evidence_ok)는
-- PUBLIC 이다 — 함수 안의 session_user 검사와 GUC 뷰어가 막는다(mem_search_items 와 같은 방식).
DO $$
DECLARE
  r text;
  f text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
  worker_only text[] := ARRAY[
    'mem_propose_item(uuid, text, text, text, uuid[])',
    'mem_serve_items(uuid, integer, integer)',
    'mem_serving_record_of(uuid)',
    -- 내부 도우미: 수락·거절(정의자)만 부른다. 외부 호출 표면을 두지 않는다.
    'mem_proposal_decider(uuid)'
  ];
  internal_only text[] := ARRAY['mem_proposal_decider(uuid)'];
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE public.mem_proposal FROM PUBLIC';
  FOREACH r IN ARRAY runtime_roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.mem_proposal FROM %I', r);
      IF r = 'momo_app' THEN
        EXECUTE format('GRANT SELECT ON TABLE public.mem_proposal TO %I', r);
      END IF;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY worker_only LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    FOREACH r IN ARRAY runtime_roles LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', f, r);
      END IF;
    END LOOP;
    IF f <> ALL (internal_only) AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_memory') THEN
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
     WHERE n.nspname = current_schema() AND c.relname = 'mem_proposal' AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'mem_proposal is missing FORCE ROW LEVEL SECURITY';
  END IF;
  FOR f IN SELECT p.proname FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.prosecdef AND p.proname LIKE 'mem\_%'
              AND pg_get_userbyid(p.proowner) <> 'mem_definer' LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % is not owned by mem_definer', f;
  END LOOP;
END $$;

-- ── L-1: mem_definer 소유 SECURITY DEFINER 함수 허용 목록 (102~104 것 + 이 파일의 7개) ────────
-- 새 정의자 함수를 만들면 이 목록과 시험(mem_schema_conformance_pg.rs 의 DEFINER_ALLOW_LIST)에
-- 이름을 올려야 한다. 목록 밖 함수는 RLS 를 우회하는 새 통로이므로 여기서 멈춘다.
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
    'mem_serve_items', 'mem_serving_record_of'
  ];
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'mem_definer'
              AND p.proname <> ALL (allow) LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % owned by mem_definer is not in the allow-list', f;
  END LOOP;
END $$;
