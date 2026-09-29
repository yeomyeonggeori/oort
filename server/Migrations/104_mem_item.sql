-- =============================================================================
-- 104_mem_item.sql — #3168 / ADR-0196 (팀 기억 v2) M2: 항목(L2)·이벤트 원장·추가만 쓰기·키워드 검색
--
-- 새 테이블 둘
--   mem_item   결정·사실·약속(·선호·절차) 항목. 저장 채널 하나(개인 공간이면 소유자도) + 근거 링크.
--   mem_event  추가만(append-only) 생애주기 원장. 본문·발췌를 담지 않는다(id·종류·개수만).
-- 와 mem_evidence.item_id 의 FK(100 이 미뤄 둔 것), 그리고 SQL 함수들.
--
-- ── 무엇이 어디서 정해지나 ─────────────────────────────────────────────────────
--   쓰기      mem_add_item          워커 전용(EXECUTE 는 momo_memory 에만). 요약(mem_apply_digest)과
--                                   같은 memory tx 에서 부른다. 근거 검증·스위치·잠금은 이 함수가 집행한다.
--   읽기      mem_item 의 RLS 정책 → mem_item_evidence_ok(GUC 뷰어) → mem_item_readable_by(뷰어 명시)
--   검색      mem_search_items      API 판(GUC 뷰어, momo_app 세션만). mem_search_items_for 가 본체(워커 전용,
--                                   뷰어를 인자로) — 후보를 낱말 유사도로 좁힌 뒤 같은 읽기 규칙으로 거른다.
--   청중      mem_item_audience_ok  워커 전용. 검색의 청중 좁히기와 #3169 서빙이 쓴다(mem_digest_audience_ok 의 짝).
--
-- ── 결정(ADR D3~D6) ────────────────────────────────────────────────────────────
--  * 가장 좁은 곳에 저장(D6-1): 항목 하나 = 채널 하나. 사람↔에이전트 1:1 DM 에서 나온 항목은 개인 공간
--    (space_kind='personal', owner_member_id = 그 사람)이다 — 소유자는 호출자가 아니라 DM 멤버십에서 정한다.
--  * 읽기(D6-2): 저장 채널·모든 근거 채널을 지금 읽을 수 있고, 근거가 source_count 개 이상 있으며(하드
--    삭제로 줄면 가려진다), 모든 근거 메시지가 살아 있고(삭제·수정 안 됨) 항목이 stale 이 아닐 때만 보인다.
--    개인 공간은 소유자만. 근거 메시지가 수정돼도 가려진다(요약과 같은 이유: 옛 본문에 기댄 주장).
--  * 원본 변화 연쇄(D6-5, M2 범위): 삭제·수정은 정책이 즉시 가린다. `retired_reason=source_deleted/edited`
--    로 내리는 정리 잡은 M3(#3172)다. 같은 내용이 다시 추출되면 mem_add_item 이 죽은 옛 행을 stale 로
--    표시하고 새 행을 넣는다(멱등 인덱스가 stale 을 제외한다).
--  * 봇·에이전트 발언은 근거가 될 수 없다(D4). 근거 작성자가 member.kind='agent' 이면 DB 가 거부한다.
--    시크릿 모양 본문은 Rust 가 LLM 전후에 차단하고, DB 도 마지막 방어선으로 알려진 토큰 모양을 거부한다.
--  * 추가만(D4): 이 파일의 쓰기 함수는 새 행을 넣을 뿐 기존 항목을 고치지 않는다(죽은 중복의 stale 표시 제외).
--    수정·병합·기간 닫기·감쇠는 M3. valid_to·supersedes_id·merged_into_id 등은 그때 쓸 자리를 미리 둔다.
--  * mem_event 는 UPDATE/DELETE 를 RESTRICTIVE 정책 (false) 으로 막는다 — 나중에 누가 허용 정책을 더해도
--    permissive 는 OR 로 합쳐지므로 막지 못한다.
--
-- ── 검색 인덱스에 대한 실측(스파이크 #3159 의 후속) ──────────────────────────────────
-- pg_trgm 의 `<%` 는 leakproof 가 아니다. RLS 가 걸린 읽기(정의자 포함: mem_definer 도 FORCE RLS 아래다)에서는
-- 정책이 「보안 장벽」이라 leakproof 가 아닌 술어는 정책보다 먼저 평가되지도, 인덱스 조건으로 쓰이지도 못한다.
-- 그래서 body 의 GIN(trgm) 인덱스는 어느 경로에서도 쓰이지 않는다(EXPLAIN 으로 확인) — 만들지 않는다. 대신
-- (workspace_id, …) 인덱스가 테넌트 범위를 좁히고 그 범위 안에서 낱말 비교를 한다: 지연은 워크스페이스 항목
-- 수에 비례한다(측정은 아래 검색 절과 PR 본문). 정책 함수를 모든 행에 먼저 돌리지 않는 것이 핵심이다.
--
-- 재실행 가능한 문장만 쓴다. schema_v0.sql·100~102 는 고치지 않는다.
-- =============================================================================

-- ── 테이블 ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mem_item (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  space_kind        text NOT NULL,
  -- 가장 좁은 곳: 항목이 저장되는 채널 하나(개인 공간이면 그 DM). 근거는 mem_evidence.
  channel_id        uuid NOT NULL,
  owner_member_id   uuid,
  kind              text NOT NULL,
  origin            text NOT NULL DEFAULT 'extracted',
  body              text NOT NULL,
  subject_key       text,
  -- 사실 시간(M3 가 valid_to 로 기간을 닫는다)과 시스템 시간(retired_*)을 섞지 않는다.
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  retired_at        timestamptz,
  retired_reason    text,
  supersedes_id     uuid REFERENCES mem_item(id) ON DELETE SET NULL,
  merged_into_id    uuid REFERENCES mem_item(id) ON DELETE SET NULL,
  confidence        real NOT NULL DEFAULT 0.5,
  reinforce_count   integer NOT NULL DEFAULT 0,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  forget_after      timestamptz,
  content_hash      text NOT NULL,
  extractor_version text NOT NULL,
  model             text,
  -- 근거 행 수와 같다(mem_add_item 이 강제). 읽기 정책이 「근거가 이만큼 남아 있는가」를 본다.
  source_count      integer NOT NULL,
  -- 근거가 죽은 옛 행(같은 내용이 다시 추출될 때 mem_add_item 이 표시) — 읽기에서 가려진다.
  stale             boolean NOT NULL DEFAULT false,
  CONSTRAINT mem_item_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_item_owner_fk FOREIGN KEY (workspace_id, owner_member_id)
    REFERENCES member (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mem_item_space_ck CHECK (
    (space_kind = 'channel' AND owner_member_id IS NULL)
    OR (space_kind = 'personal' AND owner_member_id IS NOT NULL)),
  CONSTRAINT mem_item_kind_ck CHECK (kind IN ('decision', 'fact', 'commitment', 'preference', 'procedure')),
  CONSTRAINT mem_item_origin_ck CHECK (origin IN ('extracted', 'confirmed', 'curated', 'synthesized')),
  CONSTRAINT mem_item_body_ck CHECK (char_length(btrim(body)) BETWEEN 1 AND 600),
  CONSTRAINT mem_item_subject_ck CHECK (subject_key IS NULL OR char_length(subject_key) BETWEEN 1 AND 80),
  CONSTRAINT mem_item_source_count_ck CHECK (source_count >= 1),
  CONSTRAINT mem_item_confidence_ck CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT mem_item_valid_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT mem_item_retired_ck CHECK ((retired_at IS NULL) = (retired_reason IS NULL)),
  CONSTRAINT mem_item_retired_reason_ck CHECK (retired_reason IS NULL OR retired_reason IN
    ('wrong', 'forgotten', 'merged', 'edited', 'decayed', 'source_deleted', 'source_edited'))
);

-- 멱등: 같은 채널(개인 공간이면 그 DM)에서 같은 종류·같은 내용은 살아 있는 행 하나.
CREATE UNIQUE INDEX IF NOT EXISTS mem_item_content_uq
  ON mem_item (workspace_id, channel_id, content_hash)
  WHERE retired_at IS NULL AND NOT stale;
-- 테넌트·채널 범위가 검색과 목록의 인덱스 경로다(GIN trgm 은 RLS 아래에서 못 쓴다 — 위 주석).
CREATE INDEX IF NOT EXISTS mem_item_channel_idx
  ON mem_item (workspace_id, channel_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS mem_item_recent_idx
  ON mem_item (workspace_id, recorded_at DESC);

-- 100 이 미뤄 둔 FK. 근거는 항목과 함께 지워진다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mem_evidence_item_fk') THEN
    ALTER TABLE mem_evidence
      ADD CONSTRAINT mem_evidence_item_fk FOREIGN KEY (item_id) REFERENCES mem_item(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS mem_evidence_item_msg_uq
  ON mem_evidence (item_id, message_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_evidence_item_idx
  ON mem_evidence (item_id) WHERE item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mem_event (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  target_kind      text NOT NULL,
  -- FK 없음: 잊은 항목의 흔적(id 만)이 원장에 남아야 한다(D3 「잊기는 본문 없이 id만」).
  target_id        uuid NOT NULL,
  action           text NOT NULL,
  actor_member_id  uuid,
  -- id·종류·개수만. 본문·발췌를 넣지 않는다(쓰는 함수가 그렇게만 만든다).
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mem_event_target_ck CHECK (target_kind IN ('item', 'digest', 'topic', 'workspace')),
  CONSTRAINT mem_event_action_ck CHECK (action IN
    ('created', 'confirmed', 'edited', 'merged', 'superseded', 'retired', 'forgotten',
     'served', 'withheld', 'reset')),
  CONSTRAINT mem_event_detail_ck CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 4096)
);
CREATE INDEX IF NOT EXISTS mem_event_target_idx
  ON mem_event (workspace_id, target_kind, target_id, created_at);

-- L-5: 정의자는 stale 표시 말고는 행을 고치지 못한다(열 권한). 그 밖의 쓰기는 아래 RESTRICTIVE 정책이 막는다.
GRANT SELECT, INSERT ON mem_item TO mem_definer;
GRANT UPDATE (stale) ON mem_item TO mem_definer;
GRANT SELECT, INSERT ON mem_event TO mem_definer;

-- ── 읽기 도우미 ────────────────────────────────────────────────────────────────
-- 「이 사람(p_viewer)이 이 항목을 읽을 수 있는가」의 유일한 정의. 요약의 mem_digest_evidence_ok 와 같은
-- 규칙을 명시적 뷰어로 묻는 형태다: 저장 채널·모든 근거 채널을 읽을 수 있고, 근거가 source_count 개 이상
-- 남아 있고(하드 삭제로 줄면 가려진다), 모든 근거 메시지가 살아 있고(삭제·수정 안 됨), stale 이 아닐 때만
-- true. 개인 공간은 소유자만. 뷰어가 NULL 이면 false(닫힌 쪽).
-- 워커 전용(EXECUTE 는 momo_memory 에만): 임의의 뷰어로 물을 수 있으므로 API 세션이 부르면 「누가 무엇을
-- 읽을 수 있나」를 캐 낼 수 있다. RLS 정책은 아래 GUC 판을 부른다.
CREATE OR REPLACE FUNCTION mem_item_readable_by(p_item_id uuid, p_viewer uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT NOT i.stale
       AND i.source_count > 0
       -- L-2: 「틀렸다·잊었다」로 내린 항목은 이력 화면에서도 보이지 않는다(edited·merged 등은 이력으로 남는다).
       AND (i.retired_reason IS NULL OR i.retired_reason NOT IN ('forgotten', 'wrong'))
       AND (i.space_kind = 'channel'
            OR (i.space_kind = 'personal' AND i.owner_member_id = p_viewer))
       AND public.mem_member_can_read(i.channel_id, p_viewer)
       AND (SELECT pg_catalog.count(*) FROM public.mem_evidence ev
             WHERE ev.item_id = i.id AND ev.workspace_id = i.workspace_id) >= i.source_count
       AND NOT EXISTS (
         SELECT 1 FROM public.mem_evidence ev
          WHERE ev.item_id = i.id AND ev.workspace_id = i.workspace_id
            AND NOT (
              public.mem_member_can_read(ev.channel_id, p_viewer)
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
      FROM public.mem_item i
     WHERE i.id = p_item_id
       AND i.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  ), false)
$$;

-- RLS 정책이 부르는 판(그래서 PUBLIC 이 EXECUTE 한다): 뷰어는 GUC(app.member_id)뿐이라 호출자가 남의 이름으로
-- 물을 수 없다. 이 함수는 mem_item 을 읽으므로 정책은 mem_definer 에게는 이 함수를 부르지 않는다(CASE) —
-- 그러지 않으면 정의자의 읽기가 정책 → 함수 → 읽기로 무한 재귀한다.
CREATE OR REPLACE FUNCTION mem_item_evidence_ok(p_item_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.mem_item_readable_by(
    p_item_id, nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid)
$$;

-- 읽는 사람 없이(워커 전용): 근거가 source_count 개 이상 있고 전부 살아 있는가.
CREATE OR REPLACE FUNCTION mem_item_live(p_item_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT i.source_count > 0
       AND (SELECT pg_catalog.count(*) FROM public.mem_evidence ev
             WHERE ev.item_id = i.id AND ev.workspace_id = i.workspace_id) >= i.source_count
       AND NOT EXISTS (
         SELECT 1 FROM public.mem_evidence ev
          WHERE ev.item_id = i.id AND ev.workspace_id = i.workspace_id
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
      FROM public.mem_item i
     WHERE i.id = p_item_id
       AND i.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  ), false)
$$;

-- ── 청중 규칙 (ADR-0196 D6-4; #3169 가 쓴다) ────────────────────────────────────
-- 채널 X 에 올라갈 에이전트 답에 이 항목을 실어도 되는가. mem_digest_audience_ok 의 짝이다.
--   * 기본: 저장 채널과 모든 근거 채널이 답이 올라갈 채널 X 자신일 때만.
--   * X 가 요청자와 에이전트만 있는 1:1 DM 이면 요청자가 읽을 수 있는 채널의 근거까지 허용(그 DM 에서만).
--   * 개인 공간 항목은 소유자 = 요청자일 때만. 요청자가 X 를 읽을 수 없거나, 죽은(삭제·수정된) 근거가 있거나,
--     원천 채널의 스위치(제외·정지)가 걸렸거나, 폐기(retired)·stale 이면 false.
CREATE OR REPLACE FUNCTION mem_item_audience_ok(
  p_item_id uuid, p_answer_channel_id uuid, p_requester_member_id uuid)
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
  v_retired timestamptz;
  v_space text;
  v_owner uuid;
  v_dm boolean;
BEGIN
  IF v_ws IS NULL OR p_requester_member_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT i.channel_id, i.stale, i.retired_at, i.space_kind, i.owner_member_id
    INTO v_home, v_stale, v_retired, v_space, v_owner
    FROM public.mem_item i
   WHERE i.id = p_item_id AND i.workspace_id = v_ws;
  IF NOT FOUND OR v_stale OR v_retired IS NOT NULL THEN
    RETURN false;
  END IF;
  IF v_space = 'personal' AND v_owner IS DISTINCT FROM p_requester_member_id THEN
    RETURN false;
  END IF;
  IF NOT public.mem_item_live(p_item_id) THEN
    RETURN false;
  END IF;
  IF NOT public.mem_channel_switch(v_home) THEN
    RETURN false;
  END IF;
  -- M-3: 서빙의 스위치는 mem_serve_candidates(103)와 같다 — 답 채널의 워크스페이스·채널 스위치와
  -- 요청자 개인 일시정지.
  IF NOT public.mem_channel_switch(p_answer_channel_id) THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM public.mem_settings s
              WHERE s.workspace_id = v_ws AND s.scope = 'member'
                AND s.member_id = p_requester_member_id AND s.paused) THEN
    RETURN false;
  END IF;
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
  IF NOT (v_home = p_answer_channel_id
          OR (v_dm AND public.mem_member_can_read(v_home, p_requester_member_id))) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.mem_evidence ev
     WHERE ev.item_id = p_item_id AND ev.workspace_id = v_ws
       AND NOT (ev.channel_id = p_answer_channel_id
                OR (v_dm AND public.mem_member_can_read(ev.channel_id, p_requester_member_id)))
  );
END
$$;

-- ── 시크릿 모양 (M-6) ──────────────────────────────────────────────────────────
-- Rust 의 momo_agent::memory::looks_like_secret 과 같은 판정이다. 두 구현이 같은 예/아니오 목록
-- (server-rust/crates/momo-agent/tests/fixtures/memory_secret_shapes.json)을 시험한다.
CREATE OR REPLACE FUNCTION mem_looks_like_secret(p_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
    p_text ~ '(sk-[A-Za-z0-9_-]{20,}|sk_(live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|ya29[.][A-Za-z0-9_-]{20,}|SG[.][A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9+/=_-]{16,}|eyJ[A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}[.]|-----BEGIN [A-Z ]*PRIVATE KEY)'
    OR p_text ~* 'bearer[[:space:]]+[A-Za-z0-9._~+/=-]{20,}'
    OR p_text ~* '[a-z][a-z0-9+.-]*://[^[:space:]/:@]+:[^[:space:]/@]+@'
    OR p_text ~* '(비밀번호|패스워드|암호|password|passwd|pwd)[[:space:]]*(는|은|이|가|:|=|[[:space:]]is)?[[:space:]]*(?=[^[:space:]]*[0-9!@#$%^&*])[!-~]{6,}',
    false)
$$;

-- ── 쓰기 함수 (SECURITY DEFINER; 입력 검증) ────────────────────────────────────
-- 방금(또는 이전에) 적용한 창 요약의 근거 중에서 항목 하나를 추가한다. 추가만 한다.
--   * 근거 ⊆ 그 요약의 근거(mem_evidence.digest_id). 근거 스냅샷(edited_at)은 요약이 이미 검증했고, 이
--     함수는 그 뒤 수정(40001)·삭제(23503)를 다시 확인한다. 같은 tx 에서 mem_apply_digest 바로 뒤에 부르면
--     잠금도 이미 쥐고 있다. 다른 tx 에서 불러도 잠금 순서는 같다(메시지 행 FOR KEY SHARE → 채널 advisory).
--   * 근거 작성자는 전부 사람(member.kind='human'). 에이전트·봇 발언은 사실로 쓰지 않는다(D4).
--   * 스위치·DM 규칙: mem_channel_eligible. DM(사람↔에이전트)이면 개인 공간, 소유자는 DM 의 사람.
--   * 멱등: 같은 (채널, 내용 해시) 의 살아 있는 항목이 있으면 아무것도 넣지 않고 NULL 을 돌려준다.
--     그 행이 근거를 잃은(죽은) 행이면 stale 로 표시하고 새로 넣는다.
DROP FUNCTION IF EXISTS mem_add_item(uuid, text, text, text, uuid[], real, boolean, text, text);
CREATE OR REPLACE FUNCTION mem_add_item(
  p_digest_id uuid, p_kind text, p_body text, p_subject_key text,
  p_evidence_message_ids uuid[], p_confidence real, p_ephemeral boolean,
  p_extractor_version text, p_model text)
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
  v_dstale boolean;
  v_dlevel text;
  v_ckind public.channel_kind;
  v_space text := 'channel';
  v_owner uuid;
  v_valid_from timestamptz;
  v_hash text;
  v_norm text;
  v_old_body text;
  v_inserted integer;
  v_id uuid;
  v_old uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_add_item: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('decision', 'fact', 'commitment') THEN
    RAISE EXCEPTION 'mem_add_item: an extracted item is a decision, fact or commitment' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.char_length(v_body) NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'mem_add_item: body must be 1..600 characters' USING ERRCODE = '23514';
  END IF;
  IF v_subject IS NOT NULL AND pg_catalog.char_length(v_subject) > 80 THEN
    RAISE EXCEPTION 'mem_add_item: subject_key is at most 80 characters' USING ERRCODE = '23514';
  END IF;
  IF p_extractor_version IS NULL OR pg_catalog.btrim(p_extractor_version) = '' THEN
    RAISE EXCEPTION 'mem_add_item: extractor_version is required' USING ERRCODE = '23514';
  END IF;
  -- 마지막 방어선: 알려진 시크릿 모양은 본문도 subject_key 도 저장하지 않는다(Rust 가 먼저 걸러 낸다).
  IF public.mem_looks_like_secret(v_body) OR public.mem_looks_like_secret(COALESCE(v_subject, '')) THEN
    RAISE EXCEPTION 'mem_add_item: body looks like a credential' USING ERRCODE = '23514';
  END IF;
  IF v_n = 0 OR v_n > 8 THEN
    RAISE EXCEPTION 'mem_add_item: 1..8 evidence messages are required' USING ERRCODE = '23514';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT e) FROM pg_catalog.unnest(p_evidence_message_ids) AS e) <> v_n THEN
    RAISE EXCEPTION 'mem_add_item: duplicate or NULL evidence message' USING ERRCODE = '23514';
  END IF;

  SELECT d.channel_id, d.stale, d.level INTO v_channel, v_dstale, v_dlevel
    FROM public.mem_digest d WHERE d.id = p_digest_id AND d.workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_add_item: digest not in workspace' USING ERRCODE = '23503';
  END IF;
  IF v_dlevel <> 'window' OR v_dstale THEN
    RAISE EXCEPTION 'mem_add_item: items come from a live window digest' USING ERRCODE = '23514';
  END IF;

  -- 락 순서는 어디서나 「메시지 행 → 채널 advisory」(102 H-1). 이미 쥐고 있으면 그대로다.
  PERFORM 1 FROM public.message m
   WHERE m.id = ANY (p_evidence_message_ids) AND m.workspace_id = v_ws AND m.channel_id = v_channel
   ORDER BY m.id
   FOR KEY SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_digest:' || v_channel::text, 0));
  IF NOT public.mem_channel_eligible(v_channel) THEN
    RAISE EXCEPTION 'mem_add_item: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;

  -- 근거 ⊆ 요약의 근거.
  IF (SELECT pg_catalog.count(*) FROM public.mem_evidence de
       WHERE de.digest_id = p_digest_id AND de.workspace_id = v_ws
         AND de.message_id = ANY (p_evidence_message_ids)) <> v_n THEN
    RAISE EXCEPTION 'mem_add_item: evidence must be a subset of the digest evidence' USING ERRCODE = '23503';
  END IF;
  -- 살아 있는 이 채널의 메시지(DM 은 합류 이후만), 요약이 읽은 뒤 수정되지 않았을 것.
  IF (SELECT pg_catalog.count(*) FROM public.message m
       WHERE m.id = ANY (p_evidence_message_ids)
         AND m.channel_id = v_channel AND m.workspace_id = v_ws
         AND m.deleted_at IS NULL AND m.state <> 'deleted'
         AND (NOT EXISTS (SELECT 1 FROM public.channel dc WHERE dc.id = m.channel_id AND dc.kind = 'dm')
              OR m.created_at >= (
                   SELECT pg_catalog.max(x.joined_at) FROM public.membership x
                    WHERE x.channel_id = m.channel_id AND x.workspace_id = m.workspace_id
                      AND x.left_at IS NULL))
     ) <> v_n THEN
    RAISE EXCEPTION 'mem_add_item: evidence message is not a live message of the digest channel'
      USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mem_evidence de
               JOIN public.message m ON m.id = de.message_id
              WHERE de.digest_id = p_digest_id AND de.workspace_id = v_ws
                AND de.message_id = ANY (p_evidence_message_ids)
                AND m.edited_at IS NOT NULL AND m.edited_at > de.created_at) THEN
    RAISE EXCEPTION 'mem_add_item: evidence was edited after it was read' USING ERRCODE = '40001';
  END IF;
  -- 봇·에이전트 발언은 근거가 될 수 없다.
  IF EXISTS (SELECT 1 FROM public.message m
               JOIN public.member au ON au.id = m.author_member_id AND au.workspace_id = m.workspace_id
              WHERE m.id = ANY (p_evidence_message_ids) AND au.kind <> 'human') THEN
    RAISE EXCEPTION 'mem_add_item: evidence written by an agent or bot cannot support a memory item'
      USING ERRCODE = '23514';
  END IF;

  SELECT c.kind INTO v_ckind FROM public.channel c WHERE c.id = v_channel AND c.workspace_id = v_ws;
  IF v_ckind = 'dm' THEN
    -- mem_channel_eligible 가 사람 정확히 1명 + 활성 에이전트 1명인 DM 만 통과시켰다.
    v_space := 'personal';
    SELECT x.member_id INTO STRICT v_owner
      FROM public.membership x
      JOIN public.member mm ON mm.id = x.member_id AND mm.workspace_id = x.workspace_id
     WHERE x.channel_id = v_channel AND x.workspace_id = v_ws AND x.left_at IS NULL AND mm.kind = 'human';
  END IF;

  SELECT pg_catalog.max(m.created_at) INTO v_valid_from
    FROM public.message m WHERE m.id = ANY (p_evidence_message_ids);
  v_norm := pg_catalog.lower(pg_catalog.regexp_replace(v_body, '[[:space:]]+', ' ', 'g'));
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_kind || ':' || v_norm, 'UTF8')), 'hex');

  -- 같은 내용의 옛 행이 근거를 잃었다면(삭제·수정) 죽은 행이다 — stale 로 내리고 새로 넣는다.
  SELECT i.id, i.body INTO v_old, v_old_body FROM public.mem_item i
   WHERE i.workspace_id = v_ws AND i.channel_id = v_channel AND i.content_hash = v_hash
     AND i.retired_at IS NULL AND NOT i.stale
   FOR UPDATE;
  IF FOUND THEN
    -- L-6: 해시가 같아도 본문이 다르면 같은 내용이 아니다(충돌) — 조용히 버리지 않고 거부한다.
    IF pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(v_old_body), '[[:space:]]+', ' ', 'g')) <> v_norm THEN
      RAISE EXCEPTION 'mem_add_item: content hash collision' USING ERRCODE = '23514';
    END IF;
    IF public.mem_item_live(v_old) THEN
      RETURN NULL;
    END IF;
    UPDATE public.mem_item SET stale = true WHERE id = v_old;
  END IF;

  INSERT INTO public.mem_item
    (workspace_id, space_kind, channel_id, owner_member_id, kind, origin, body, subject_key,
     valid_from, confidence, forget_after, content_hash, extractor_version, model, source_count)
  VALUES
    (v_ws, v_space, v_channel, v_owner, p_kind, 'extracted', v_body, v_subject,
     v_valid_from, LEAST(GREATEST(COALESCE(p_confidence, 0.5), 0), 1),
     CASE WHEN COALESCE(p_ephemeral, false) THEN pg_catalog.now() + interval '14 days' END,
     v_hash, p_extractor_version, p_model, v_n)
  ON CONFLICT (workspace_id, channel_id, content_hash) WHERE retired_at IS NULL AND NOT stale
  DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.mem_evidence (workspace_id, item_id, message_id, channel_id, created_at)
  SELECT v_ws, v_id, de.message_id, v_channel, de.created_at
    FROM public.mem_evidence de
   WHERE de.digest_id = p_digest_id AND de.workspace_id = v_ws
     AND de.message_id = ANY (p_evidence_message_ids);
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> v_n THEN
    RAISE EXCEPTION 'mem_add_item: inserted % evidence rows, expected %', v_inserted, v_n
      USING ERRCODE = '23503';
  END IF;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, detail)
  VALUES (v_ws, 'item', v_id, 'created',
          pg_catalog.jsonb_build_object(
            'kind', p_kind, 'space', v_space, 'digest_id', p_digest_id,
            'source_count', v_n, 'extractor_version', p_extractor_version, 'model', p_model));
  RETURN v_id;
END
$$;

-- ── 검색 ───────────────────────────────────────────────────────────────────────
-- 키워드 검색(D5, M0 스파이크 #3159 의 권장: pg_trgm 단독).
--
-- 왜 SECURITY DEFINER 인가(측정): RLS 아래에서는 정책이 「보안 장벽」이라 leakproof 가 아닌 `<%` 보다 정책이
-- 먼저 평가된다 — 정책의 mem_item_evidence_ok 가 워크스페이스의 모든 행에 돌고 나서야 낱말 비교가 돈다
-- (행당 ~30µs, 워크스페이스 항목 5천 개에서 검색 ~165ms, 선형 증가; EXPLAIN 과 수치는 PR 본문·평가 시험).
-- 그래서 이 함수는 정의자로 돌며 후보를 낱말 유사도로 먼저 좁히고(테넌트 술어만 걸린 스캔), 점수 순으로
-- 걷다가 **정책이 부르는 것과 같은 함수**(mem_item_readable_by)로 읽기 가능 여부를 확인해 limit 개가 찰
-- 때까지만 확인한다. 권한 규칙의 정의는 여전히 하나이고, 시험이 「검색 결과 == RLS 로 읽히는 행 ∩ 일치」
-- 를 뷰어별로 대조한다.
--   * mem_search_items_core(...)         본체. 소유자(mem_definer) 말고는 누구도 EXECUTE 하지 못한다(M-4).
--   * mem_search_items_for(viewer, 질의, limit, 답 채널)  서빙(#3169) — 워커 전용, 답 채널 필수(NULL 이면 22023).
--   * mem_search_items(질의, limit)     열람 API 판(청중 좁히기 없음). 뷰어는 GUC(app.member_id)뿐. 세션 사용자가 momo_app(또는
--                                        슈퍼유저)이 아니면 거부한다 — BYPASSRLS 역할이 GUC 를 스스로 정해
--                                        본문을 읽는 길을 막는다(역할이 이 마이그레이션보다 늦게 생겨도 EXECUTE
--                                        부여 순서에 기대지 않도록 함수 안에서 검사한다).
--   * 낱말: 공백·구두점으로 쪼개(최대 8), 세 글자 이상은 끝의 조사를 뗀 변형도 함께 쓴다. 낱말 하나라도
--     body 에 `<%`(word_similarity ≥ 0.5)면 후보, 점수는 낱말별 최고 유사도의 합.
--   * p_answer_channel_id 가 있으면 청중 좁히기(D6-4): mem_item_audience_ok 를 통과해야 한다(서빙 규칙 그대로:
--     저장·근거 채널이 그 채널 자신이거나 요청자↔에이전트 DM 의 합집합, 원천 채널 스위치, 폐기·stale 제외).
--     없으면 브라우저용 — 읽을 수 있는 모든 항목.
--   * 폐기(retired)된 항목은 제외. 현재 유효(valid_to IS NULL)가 같은 점수에서 앞선다.
CREATE OR REPLACE FUNCTION mem_search_items_core(
  p_viewer uuid, p_query text, p_limit integer, p_answer_channel_id uuid, p_serve boolean)
RETURNS TABLE (
  id uuid, channel_id uuid, space_kind text, kind text, body text,
  valid_from timestamptz, valid_to timestamptz, recorded_at timestamptz,
  score real, evidence_message_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET pg_trgm.word_similarity_threshold = '0.5'
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_raw text[];
  v_stem text[];
  v_all text[];
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_found integer := 0;
  r record;
BEGIN
  -- M-4: 서빙(p_serve)은 청중 좁히기 없이 돌지 않는다, 열람은 좁히기를 받지 않는다. 호출자가 플래그와 채널을
  -- 어긋나게 주면 조용히 넓게 돌지 말고 멈춘다.
  IF p_serve IS DISTINCT FROM (p_answer_channel_id IS NOT NULL) THEN
    RAISE EXCEPTION 'mem_search_items_core: serving requires an answer channel (and browsing takes none)'
      USING ERRCODE = '22023';
  END IF;
  IF v_ws IS NULL OR p_viewer IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_catalog.array_agg(t.raw ORDER BY t.ord),
         pg_catalog.array_agg(t.stem ORDER BY t.ord)
    INTO v_raw, v_stem
    FROM (
      SELECT w.raw, w.ord,
             CASE WHEN pg_catalog.char_length(w.raw) >= 3
                  THEN pg_catalog.regexp_replace(w.raw,
                         '(에서|에게|으로|이랑|까지|부터|처럼|보다|이나|에는|은|는|이|가|을|를|의|도|만|와|과|로|에)$', '')
                  ELSE w.raw END AS stem
        FROM (
          SELECT DISTINCT ON (s.w) s.w AS raw, s.ord
            FROM pg_catalog.regexp_split_to_table(
                   pg_catalog.lower(pg_catalog.left(COALESCE(p_query, ''), 200)),  -- M-1: 질의 길이 상한
                   '[[:space:],.;:!?()"''`\[\]{}<>]+') WITH ORDINALITY AS s(w, ord)
           WHERE pg_catalog.char_length(s.w) >= 2
           ORDER BY s.w, s.ord
        ) w
       ORDER BY w.ord
       LIMIT 8
    ) t;
  IF v_raw IS NULL THEN
    RETURN;
  END IF;
  -- 조사를 뗀 결과가 한 글자로 줄면 원래 낱말을 쓴다.
  SELECT pg_catalog.array_agg(CASE WHEN pg_catalog.char_length(x.st) >= 2 THEN x.st ELSE x.rw END ORDER BY x.n)
    INTO v_stem
    FROM unnest(v_raw, v_stem) WITH ORDINALITY AS x(rw, st, n);
  SELECT pg_catalog.array_agg(DISTINCT z.w) INTO v_all
    FROM (SELECT pg_catalog.unnest(v_raw) AS w UNION SELECT pg_catalog.unnest(v_stem)) z;

  FOR r IN
    SELECT i.id AS item_id, i.channel_id AS item_channel, i.space_kind AS item_space, i.kind AS item_kind,
           i.body AS item_body, i.valid_from AS item_from, i.valid_to AS item_to,
           i.recorded_at AS item_recorded, sc.s AS item_score
      FROM public.mem_item i
      CROSS JOIN LATERAL (
        SELECT pg_catalog.sum(GREATEST(
                 public.word_similarity(t.rw, i.body), public.word_similarity(t.st, i.body))) AS s
          FROM unnest(v_raw, v_stem) AS t(rw, st)
      ) sc
     WHERE i.workspace_id = v_ws
       AND i.retired_at IS NULL
       AND NOT i.stale
       -- M-1: 뷰어의 활성 멤버십 채널(개인 공간이면 소유자 본인)에 있는 항목만 낱말 비교를 받는다 —
       -- 못 읽는 채널 항목이 응답 시간에 드러나지 않고(타이밍 오라클), 스캔도 줄어든다. 읽기 가능 여부는
       -- 아래 readable_by 가 그대로 판정한다(이 술어는 좁히기일 뿐 권한이 아니다).
       AND (i.channel_id IN (SELECT ms.channel_id FROM public.membership ms
                              WHERE ms.workspace_id = v_ws AND ms.member_id = p_viewer
                                AND ms.left_at IS NULL)
            OR (i.space_kind = 'personal' AND i.owner_member_id = p_viewer))
       AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_all) AS w WHERE w <% i.body)
     ORDER BY sc.s DESC, (i.valid_to IS NULL) DESC, i.recorded_at DESC, i.id
  LOOP
    -- 정책이 부르는 것과 같은 규칙(뷰어 명시), 그다음 청중 좁히기.
    IF NOT public.mem_item_readable_by(r.item_id, p_viewer) THEN
      CONTINUE;
    END IF;
    IF p_serve
       AND NOT public.mem_item_audience_ok(r.item_id, p_answer_channel_id, p_viewer) THEN
      CONTINUE;
    END IF;
    id := r.item_id;
    channel_id := r.item_channel;
    space_kind := r.item_space;
    kind := r.item_kind;
    body := r.item_body;
    valid_from := r.item_from;
    valid_to := r.item_to;
    recorded_at := r.item_recorded;
    score := r.item_score;
    evidence_message_ids := (SELECT pg_catalog.array_agg(ev.message_id ORDER BY ev.message_id)
                               FROM public.mem_evidence ev
                              WHERE ev.item_id = r.item_id AND ev.workspace_id = v_ws);
    RETURN NEXT;
    v_found := v_found + 1;
    EXIT WHEN v_found >= v_limit;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION mem_search_items_for(
  p_viewer uuid, p_query text, p_limit integer, p_answer_channel_id uuid)
RETURNS TABLE (
  id uuid, channel_id uuid, space_kind text, kind text, body text,
  valid_from timestamptz, valid_to timestamptz, recorded_at timestamptz,
  score real, evidence_message_ids uuid[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM public.mem_search_items_core(p_viewer, p_query, p_limit, p_answer_channel_id, true)
$$;

CREATE OR REPLACE FUNCTION mem_search_items(p_query text, p_limit integer DEFAULT 10)
RETURNS TABLE (
  id uuid, channel_id uuid, space_kind text, kind text, body text,
  valid_from timestamptz, valid_to timestamptz, recorded_at timestamptz,
  score real, evidence_message_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user::text <> 'momo_app'
     AND NOT COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user::text), false) THEN
    RAISE EXCEPTION 'mem_search_items: only the API role may search items' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT * FROM public.mem_search_items_core(
    nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid, p_query, p_limit, NULL, false);
END
$$;

-- ── 소유자·권한 ────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO mem_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_item_evidence_ok(uuid)', 'mem_item_readable_by(uuid, uuid)', 'mem_item_live(uuid)',
    'mem_item_audience_ok(uuid, uuid, uuid)',
    'mem_add_item(uuid, text, text, text, uuid[], real, boolean, text, text)',
    'mem_search_items_core(uuid, text, integer, uuid, boolean)',
    'mem_search_items_for(uuid, text, integer, uuid)',
    'mem_search_items(text, integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO mem_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- ── RLS ────────────────────────────────────────────────────────────────────────
ALTER TABLE mem_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE mem_item FORCE ROW LEVEL SECURITY;
ALTER TABLE mem_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE mem_event FORCE ROW LEVEL SECURITY;

-- mem_item: 쓰기는 mem_definer 에만(다른 역할은 정책이 없어 거부).
DROP POLICY IF EXISTS mem_item_ins ON mem_item;
CREATE POLICY mem_item_ins ON mem_item FOR INSERT TO mem_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_item_upd ON mem_item;
CREATE POLICY mem_item_upd ON mem_item FOR UPDATE TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_item_sel_definer ON mem_item;
CREATE POLICY mem_item_sel_definer ON mem_item FOR SELECT TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- 읽기(D6-2): 저장 채널·모든 근거 채널을 읽을 수 있고 근거가 살아 있을 때만(mem_item_evidence_ok).
DROP POLICY IF EXISTS mem_item_sel ON mem_item;
CREATE POLICY mem_item_sel ON mem_item FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND CASE WHEN current_user = 'mem_definer' THEN false ELSE mem_item_evidence_ok(id) END
  );

-- L-5: mem_item 의 쓰기는 정의자만. 나중에 누가 permissive 쓰기 정책을 더해도 RESTRICTIVE 는 AND 라 못 뚫는다
-- (정의자의 UPDATE 는 열 권한으로 stale 하나뿐이다).
DROP POLICY IF EXISTS mem_item_only_definer_ins ON mem_item;
CREATE POLICY mem_item_only_definer_ins ON mem_item AS RESTRICTIVE FOR INSERT
  WITH CHECK (current_user = 'mem_definer');
DROP POLICY IF EXISTS mem_item_only_definer_upd ON mem_item;
CREATE POLICY mem_item_only_definer_upd ON mem_item AS RESTRICTIVE FOR UPDATE
  USING (current_user = 'mem_definer') WITH CHECK (current_user = 'mem_definer');
DROP POLICY IF EXISTS mem_item_only_definer_del ON mem_item;
CREATE POLICY mem_item_only_definer_del ON mem_item AS RESTRICTIVE FOR DELETE
  USING (current_user = 'mem_definer');

-- mem_event: 쓰기(INSERT)는 mem_definer 에만, UPDATE·DELETE 는 누구도(RESTRICTIVE false).
DROP POLICY IF EXISTS mem_event_ins ON mem_event;
CREATE POLICY mem_event_ins ON mem_event FOR INSERT TO mem_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_event_sel_definer ON mem_event;
CREATE POLICY mem_event_sel_definer ON mem_event FOR SELECT TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- 항목 이벤트는 그 항목을 읽을 수 있는 사람만. 요약 등 다른 대상은 M3 가 규칙을 정한다(지금은 가림).
DROP POLICY IF EXISTS mem_event_sel ON mem_event;
CREATE POLICY mem_event_sel ON mem_event FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND target_kind = 'item'
    AND CASE WHEN current_user = 'mem_definer' THEN false ELSE mem_item_evidence_ok(target_id) END
  );
DROP POLICY IF EXISTS mem_event_no_update ON mem_event;
CREATE POLICY mem_event_no_update ON mem_event AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS mem_event_no_delete ON mem_event;
CREATE POLICY mem_event_no_delete ON mem_event AS RESTRICTIVE FOR DELETE USING (false);

-- ── 런타임 역할 권한 (이 마이그레이션이 만든 객체만) ─────────────────────────────────
-- 공용 잠금 블록(101 의 BEGIN/END mem-lockdown, 부트스트랩 두 파일과 글자 그대로 같음)은 건드리지
-- 않는다 — 102 와 같은 방식이다. 그 블록은 mem_* 이름의 테이블을 동적으로 순회하므로 mem_item·mem_event 도
-- 부트스트랩이 다시 돌 때 자동으로 잠긴다(시험이 확인한다). 여기서는 마이그레이션 시점에 같은 상태를 만든다:
-- 테이블은 momo_app 이 SELECT(RLS 로 좁혀짐)만, 워커 전용 함수는 momo_memory 에만 EXECUTE.
DO $$
DECLARE
  r text;
  t text;
  f text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
  worker_only text[] := ARRAY[
    'mem_add_item(uuid, text, text, text, uuid[], real, boolean, text, text)',
    'mem_item_live(uuid)',
    'mem_item_readable_by(uuid, uuid)',
    'mem_item_audience_ok(uuid, uuid, uuid)',
    'mem_search_items_for(uuid, text, integer, uuid)'
  ];
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_item', 'mem_event'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY runtime_roles LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
        IF r = 'momo_app' THEN
          EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', t, r);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  -- 본체는 소유자 말고는 부를 수 없다: momo_memory 도 못 부른다(M-4).
  EXECUTE 'REVOKE ALL ON FUNCTION public.mem_search_items_core(uuid, text, integer, uuid, boolean) FROM PUBLIC';
  FOREACH r IN ARRAY runtime_roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.mem_search_items_core(uuid, text, integer, uuid, boolean) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_memory') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.mem_search_items_core(uuid, text, integer, uuid, boolean) FROM momo_memory';
  END IF;
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
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_item', 'mem_event'] LOOP
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

-- ── L-1: mem_definer 소유 SECURITY DEFINER 함수 허용 목록 (102·103 것 + 이 파일의 9개) ────────
-- 새 정의자 함수를 만들면 이 목록과 시험(mem_schema_conformance_pg.rs 의 DEFINER_ALLOW_LIST)에
-- 이름을 올려야 한다. mem_serve_requester·mem_serve_candidates 는 #3163(103)의 것이다 — 그 마이그레이션이
-- 이 파일보다 먼저 적용되든 나중이든 이 검사가 깨지지 않게 미리 올려 둔다(없는 이름은 무해하다).
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
    'mem_search_items_core', 'mem_search_items_for', 'mem_search_items', 'mem_looks_like_secret'
  ];
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'mem_definer'
              AND p.proname <> ALL (allow) LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % owned by mem_definer is not in the allow-list', f;
  END LOOP;
END $$;
