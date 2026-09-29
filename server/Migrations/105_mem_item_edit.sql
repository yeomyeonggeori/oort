-- =============================================================================
-- 105_mem_item_edit.sql — #3208 / ADR-0196 (팀 기억 v2) M2: 기억 브라우저의 편집·잊기
--
-- 새 정의자 함수 둘 (API 세션이 부른다 — 읽기 전용이던 mem_search_items 와 같은 신뢰 경계)
--   mem_edit_item(항목, 본문, 종류?)   편집 = 새 항목(origin='curated') 추가 + 옛 항목 retired_reason='edited'
--   mem_forget_item(항목)              잊기 = 그 항목과 옛 버전 사슬의 즉시 영구 삭제 + mem_event 에 id 만
--
-- ── 왜 API 가 직접 부르는 정의자 함수인가 (워커 경유가 아니라) ────────────────────────────────
--  * 사용자의 동기 조작이다: 눌렀을 때 바로 새 항목이 보이거나 사라져야 한다. 워커 경유는 큐·폴링·결과
--    회신 경로를 새로 만들고, 쓰기 권한을 API 보다 넓은 역할(momo_memory)에 맡기는 것이라 보안상 이득이 없다.
--  * 신뢰 경계는 읽기와 같다: 행위자는 호출자가 인자로 주지 못한다 — app.member_id(GUC)에서만 유도한다.
--    API 는 그 GUC 를 인증된 principal 로만 묶는다(bind_mem_reader_guc, LOCAL). 함수 안에서 다시 확인한다:
--    ① session_user 가 momo_app(또는 슈퍼유저)이 아니면 42501 — BYPASSRLS 로그인이 GUC 를 스스로 정해
--    남의 이름으로 쓰는 길을 막는다(mem_search_items 와 같은 가드, 역할이 마이그레이션보다 늦게 생겨도
--    EXECUTE 부여 순서에 기대지 않는다). ② 행위자는 이 워크스페이스의 활성 사람(kind='human')이어야 한다.
--    ③ 권한 규칙은 새로 만들지 않는다: mem_item_readable_by(항목, 행위자) 하나가 정의다.
--
-- ── 누가 편집·잊을 수 있나 (ADR-0196 D9 표 그대로) ─────────────────────────────────────────────
--   편집  「근거 채널 멤버」            잊기  「근거 채널 멤버(개인은 본인)」
--   = 저장 채널과 모든 근거 채널을 지금 읽을 수 있고 근거 메시지가 살아 있는 사람(개인 공간은 소유자). 관리자
--   전용으로 좁히지 않았다 — ADR 이 침묵하지 않는다. 읽을 수 없는 항목은 없는 항목과 똑같이 P0002(→ 404):
--   존재 여부가 새지 않는다(#3199 F1 영수증 오라클 교훈). 읽을 수 있지만 할 수 없는 상태(이미 내려간 항목,
--   새 버전이 있는 옛 버전)만 55000(→ 409)이고, 그건 읽을 수 있는 사람에게만 닿는다.
--
-- ── 편집 (D4 추가만) ───────────────────────────────────────────────────────────────────────────
--  * 새 행: origin='curated', supersedes_id=옛 행, 같은 저장 채널·공간·소유자·valid_from·subject_key, 종류는
--    주면 바꾼다(5종). 옛 행: retired_at=now(), retired_reason='edited' 만 바꾼다 — 본문은 이력으로 남는다.
--    (지우려면 편집이 아니라 잊기다: 사슬 전체를 지운다.)
--  * 근거는 옛 항목 것을 그대로 옮긴다(created_at 까지 — 읽기 규칙의 「근거 뒤 수정」 비교가 느슨해지지
--    않게). 편집자가 그 근거를 전부 읽을 수 있는지는 mem_item_readable_by 가 이미 확인했다(저장 채널·모든
--    근거 채널·메시지 생존). mem_item 행 FOR UPDATE 를 먼저 잡고, 그다음 mem_add_item 과 같은 순서(근거 메시지 행 FOR KEY SHARE → 채널 advisory 공유 잠금)로 잡는다 — 뒤의 둘은 공유 모드라 mem_add_item 과 서로 막지 않는다.
--  * 새 본문도 mem_add_item 과 같은 마지막 방어선을 지난다: 1..600자, 시크릿 모양 거부, content_hash 같은 식.
--  * 이벤트: 새 행 'edited'({supersedes}), 옛 행 'superseded'({superseded_by}). 본문·발췌 없음(id·종류만).
--
-- ── 잊기 (D9·D10: 즉시 영구 삭제) ──────────────────────────────────────────────────────────────
--  * D9 「잊기 = 즉시 영구 삭제 + mem_event 에 id만」, D10 「잊기·초기화는 즉시 영구 삭제」. 그래서 숨김
--    (retired_reason='forgotten')이 아니라 행을 지운다 — 본문이 DB 에 남지 않는다. 근거 링크가 함께 지워지고
--    (mem_evidence 명시 삭제), mem_event 는 FK 가 없어 id 만 원장에 남는다.
--  * 편집의 옛 버전(supersedes 사슬)에도 같은 본문이 들어 있으니 사슬 전체를 지운다. 새 버전이 있는 옛
--    버전만 골라 잊는 것은 거부한다(55000: 최신 버전을 잊어라) — 그러지 않으면 지운 줄 아는 내용이
--    이어진 사슬로 되살아난다.
--  * 알려진 한계(기록): 같은 창의 근거로 요약이 다시 만들어지면 추출이 같은 내용을 새 행으로 넣을 수 있다.
--    억제 표(무덤)는 M3 정리 잡(#3172)의 몫이다.
--
-- ── 권한 확장 (mem_definer) ────────────────────────────────────────────────────────────────────
--  104 는 mem_definer 의 UPDATE 를 stale 하나로 묶었다(L-5). 이 파일은 딱 필요한 만큼만 넓힌다:
--  UPDATE(retired_at, retired_reason) 와 DELETE(+ 허용 정책). 그 밖의 열(본문 등)은 여전히 못 고친다. 다른
--  역할의 쓰기는 104 의 RESTRICTIVE 정책이 계속 막는다(current_user = 'mem_definer' 만 통과).
--
-- ── 보안 검수 반영 (PR #3209) ──────────────────────────────────────────────────────────────────
--  M-1  잊기는 같은 (채널, content_hash)의 죽은·내려간 쌍둥이 행(재추출이 남긴 stale 등)도 지운다 — 본문이
--       DB 에 남지 않는다(D10). 살아 있는 쌍둥이는 손대지 않는다(행위자가 읽을 수 있는지 모른다).
--  M-2  편집은 INSERT 전에 같은 해시의 살아 있는 행을 본다. 죽었으면(mem_item_live=false) stale 로 내리고
--       계속한다. 살아 있으면 읽을 수 있든 없든 **똑같은** 22023(→ 일반 422, 「변경 없음」과 같은 메시지)이다:
--       409 로 「이 채널에 같은 본문의 숨은 항목이 있다」를 알리지 않는다. 동시 편집의 unique 충돌도 같은 22023.
--  M-4  supersedes_id·merged_into_id 부분 인덱스(잊기의 사슬 걷기·「새 버전이 있나」 검사, FK ON DELETE SET NULL).
--  M-5  mem_suppress(해시만): 잊은 (채널, 해시)의 재추출을 막는다. mem_item 의 BEFORE INSERT 트리거가 모든 삽입
--       경로(mem_add_item·#3169 제안 수락 등)에서 origin<>'curated' 인 삽입을 조용히 건너뛴다(사람이 직접 고쳐 쓴
--       curated 는 예외). 요약(digest) 본문에는 사실이 요약이 다시 만들어질 때까지 남아 있을 수 있다(M3 #3172).
--  M-6  채널(및 워크스페이스) guest 는 편집·잊기를 못 한다(42501 → 403). 읽기는 RLS 대로다. 읽을 수 있는 사람에게만
--       닿는 답이라 존재 오라클이 아니다. 새 본문 작성자는 mem_event('edited').actor 로 남는다.
--  L-1  이 파일의 함수가 스스로 올리는 오류는 전부 「mem_edit_item:」/「mem_forget_item:」 메시지 접두사를 가진다 —
--       API 는 그 접두사가 있을 때만 SQLSTATE 를 HTTP 로 옮기고, 그 밖(권한·RLS·CHECK)은 500 이다.
--
-- 재실행 가능한 문장만 쓴다. schema_v0.sql·100~104 는 고치지 않는다.
-- =============================================================================

-- ── 권한 ───────────────────────────────────────────────────────────────────────
GRANT UPDATE (retired_at, retired_reason) ON mem_item TO mem_definer;
GRANT DELETE ON mem_item TO mem_definer;
DROP POLICY IF EXISTS mem_item_del ON mem_item;
CREATE POLICY mem_item_del ON mem_item FOR DELETE TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ── 인덱스 (M-4) ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS mem_item_supersedes_idx ON mem_item (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_item_merged_into_idx ON mem_item (merged_into_id) WHERE merged_into_id IS NOT NULL;

-- ── 잊은 내용의 재추출 억제 (M-5) ──────────────────────────────────────────────────
-- 해시만 담는다(본문 없음). API 역할에는 정책이 없어 FORCE RLS 아래에서 한 행도 안 보이고 쓸 수도 없다.
CREATE TABLE IF NOT EXISTS mem_suppress (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL,
  content_hash  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, channel_id, content_hash),
  CONSTRAINT mem_suppress_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE
);
ALTER TABLE mem_suppress ENABLE ROW LEVEL SECURITY;
ALTER TABLE mem_suppress FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON mem_suppress TO mem_definer;
DROP POLICY IF EXISTS mem_suppress_ins ON mem_suppress;
CREATE POLICY mem_suppress_ins ON mem_suppress FOR INSERT TO mem_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_suppress_sel ON mem_suppress;
CREATE POLICY mem_suppress_sel ON mem_suppress FOR SELECT TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- 정의자 말고는 무엇도 못 하게(나중에 누가 허용 정책을 더해도 RESTRICTIVE 는 AND 라 못 뚫는다).
DROP POLICY IF EXISTS mem_suppress_only_definer ON mem_suppress;
CREATE POLICY mem_suppress_only_definer ON mem_suppress AS RESTRICTIVE FOR ALL
  USING (current_user = 'mem_definer') WITH CHECK (current_user = 'mem_definer');

-- 모든 삽입 경로가 지나는 자리: 잊은 (채널, 해시)의 추출·확정 삽입은 조용히 건너뛴다(NULL 반환 = 행 없음,
-- mem_add_item 은 「이미 있음」과 같이 NULL 을 돌려준다). 사람이 직접 고쳐 쓴 curated 는 막지 않는다.
CREATE OR REPLACE FUNCTION mem_item_suppressed_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.origin <> 'curated'
     AND EXISTS (SELECT 1 FROM public.mem_suppress s
                  WHERE s.workspace_id = NEW.workspace_id AND s.channel_id = NEW.channel_id
                    AND s.content_hash = NEW.content_hash) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS mem_item_suppressed ON mem_item;
CREATE TRIGGER mem_item_suppressed BEFORE INSERT ON mem_item
  FOR EACH ROW EXECUTE FUNCTION mem_item_suppressed_guard();

-- 마이그레이션 시점의 잠금(공용 mem-lockdown 블록은 건드리지 않는다): 런타임 역할 전부 접근 없음.
DO $$
DECLARE r text;
BEGIN
  REVOKE ALL ON TABLE public.mem_suppress FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.mem_suppress FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ── 편집 ───────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS mem_edit_item(uuid, text, text);
CREATE OR REPLACE FUNCTION mem_edit_item(p_item_id uuid, p_body text, p_kind text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_actor uuid := nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid;
  v_body text := pg_catalog.btrim(COALESCE(p_body, ''));
  o public.mem_item%ROWTYPE;
  v_kind text;
  v_norm text;
  v_hash text;
  v_n integer;
  v_ins integer;
  v_id uuid;
  v_twin uuid;
BEGIN
  IF session_user::text <> 'momo_app'
     AND NOT COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user::text), false) THEN
    RAISE EXCEPTION 'mem_edit_item: only the API role may edit items' USING ERRCODE = '42501';
  END IF;
  IF v_ws IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'mem_edit_item: no acting member' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.member m
                  WHERE m.id = v_actor AND m.workspace_id = v_ws AND m.kind = 'human'
                    AND m.status = 'active' AND m.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'mem_edit_item: the acting member must be an active human' USING ERRCODE = '42501';
  END IF;

  -- 입력 검증(항목과 무관하므로 존재 여부를 드러내지 않는다).
  IF pg_catalog.char_length(v_body) NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'mem_edit_item: body must be 1..600 characters' USING ERRCODE = '23514';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('decision', 'fact', 'commitment', 'preference', 'procedure') THEN
    RAISE EXCEPTION 'mem_edit_item: unknown kind' USING ERRCODE = '23514';
  END IF;
  IF public.mem_looks_like_secret(v_body) THEN
    RAISE EXCEPTION 'mem_edit_item: body looks like a credential' USING ERRCODE = '23514';
  END IF;

  -- 읽을 수 없으면 없는 것과 같다(P0002 → 404). 잠금 전에 한 번, 잠근 뒤에 한 번 묻는다.
  IF NOT public.mem_item_readable_by(p_item_id, v_actor) THEN
    RAISE EXCEPTION 'mem_edit_item: item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO o FROM public.mem_item i
   WHERE i.id = p_item_id AND i.workspace_id = v_ws
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_edit_item: item not found' USING ERRCODE = 'P0002';
  END IF;
  -- 락 순서는 어디서나 「메시지 행 → 채널 advisory」(102 H-1, mem_add_item 과 같다).
  PERFORM 1 FROM public.message m
   WHERE m.id IN (SELECT ev.message_id FROM public.mem_evidence ev
                   WHERE ev.item_id = o.id AND ev.workspace_id = v_ws)
     AND m.workspace_id = v_ws
   ORDER BY m.id
   FOR KEY SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_digest:' || o.channel_id::text, 0));
  IF NOT public.mem_item_readable_by(o.id, v_actor) THEN
    RAISE EXCEPTION 'mem_edit_item: item not found' USING ERRCODE = 'P0002';
  END IF;
  -- 여기부터는 읽을 수 있는 사람에게만 닿는다.
  -- M-6: guest 는 읽을 수는 있어도 고치지 못한다(읽을 수 있는 사람에게만 닿는 답).
  IF EXISTS (SELECT 1 FROM public.membership ms
              WHERE ms.workspace_id = v_ws AND ms.member_id = v_actor AND ms.left_at IS NULL
                AND ms.role = 'guest'
                AND (ms.channel_id = o.channel_id
                     OR ms.channel_id IN (SELECT ev.channel_id FROM public.mem_evidence ev
                                           WHERE ev.item_id = o.id AND ev.workspace_id = v_ws)))
     OR EXISTS (SELECT 1 FROM public.workspace_membership wm
                 WHERE wm.workspace_id = v_ws AND wm.member_id = v_actor AND wm.role = 'guest') THEN
    RAISE EXCEPTION 'mem_edit_item: guests may not change memory items' USING ERRCODE = '42501';
  END IF;
  IF o.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'mem_edit_item: the item is already retired' USING ERRCODE = '55000';
  END IF;

  v_kind := COALESCE(p_kind, o.kind);
  IF v_kind = o.kind AND v_body = pg_catalog.btrim(o.body) THEN
    RAISE EXCEPTION 'mem_edit_item: nothing to change' USING ERRCODE = '22023';
  END IF;
  v_norm := pg_catalog.lower(pg_catalog.regexp_replace(v_body, '[[:space:]]+', ' ', 'g'));
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_kind || ':' || v_norm, 'UTF8')), 'hex');

  SELECT pg_catalog.count(*) INTO v_n FROM public.mem_evidence ev
   WHERE ev.item_id = o.id AND ev.workspace_id = v_ws;

  -- M-2: 같은 채널·같은 해시의 다른 살아 있는 행. 근거를 잃은(죽은) 행이면 stale 로 내리고 계속한다
  -- (mem_add_item 과 같은 정리). 진짜 살아 있으면 읽을 수 있든 없든 「변경 없음」과 똑같은 22023 — 숨은 항목의
  -- 존재가 409 로 새지 않는다.
  SELECT t.id INTO v_twin FROM public.mem_item t
   WHERE t.workspace_id = v_ws AND t.channel_id = o.channel_id AND t.content_hash = v_hash
     AND t.retired_at IS NULL AND NOT t.stale AND t.id <> o.id
   FOR UPDATE;
  IF FOUND THEN
    IF public.mem_item_live(v_twin) THEN
      RAISE EXCEPTION 'mem_edit_item: nothing to change' USING ERRCODE = '22023';
    END IF;
    UPDATE public.mem_item SET stale = true WHERE id = v_twin;
  END IF;

  -- 옛 행을 먼저 내려야 멱등 인덱스(살아 있는 행만)가 같은 채널의 같은 내용과 충돌하지 않는다.
  UPDATE public.mem_item SET retired_at = pg_catalog.now(), retired_reason = 'edited' WHERE id = o.id;
  BEGIN
    INSERT INTO public.mem_item
      (workspace_id, space_kind, channel_id, owner_member_id, kind, origin, body, subject_key,
       valid_from, confidence, content_hash, extractor_version, model, source_count, supersedes_id)
    VALUES
      (v_ws, o.space_kind, o.channel_id, o.owner_member_id, v_kind, 'curated', v_body, o.subject_key,
       o.valid_from, 1, v_hash, 'curated-edit.v1', NULL, v_n, o.id)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- 동시에 같은 본문을 넣은 편집: 위와 같은 답.
    RAISE EXCEPTION 'mem_edit_item: nothing to change' USING ERRCODE = '22023';
  END;
  INSERT INTO public.mem_evidence (workspace_id, item_id, message_id, channel_id, created_at)
  SELECT v_ws, v_id, ev.message_id, ev.channel_id, ev.created_at
    FROM public.mem_evidence ev
   WHERE ev.item_id = o.id AND ev.workspace_id = v_ws;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  IF v_ins <> v_n THEN
    RAISE EXCEPTION 'mem_edit_item: copied % evidence rows, expected %', v_ins, v_n USING ERRCODE = '23503';
  END IF;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id, detail)
  VALUES
    (v_ws, 'item', v_id, 'edited', v_actor,
     pg_catalog.jsonb_build_object('supersedes', o.id, 'kind', v_kind, 'source_count', v_n)),
    (v_ws, 'item', o.id, 'superseded', v_actor,
     pg_catalog.jsonb_build_object('superseded_by', v_id, 'reason', 'edited'));
  RETURN v_id;
END
$$;

-- ── 잊기 ───────────────────────────────────────────────────────────────────────
-- 지운 항목 수(최신 버전 + 옛 버전 사슬 + 죽은 쌍둥이 행)를 돌려준다.
DROP FUNCTION IF EXISTS mem_forget_item(uuid);
CREATE OR REPLACE FUNCTION mem_forget_item(p_item_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_actor uuid := nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid;
  o public.mem_item%ROWTYPE;
  v_chain uuid[];
  v_twins uuid[];
  v_all uuid[];
BEGIN
  IF session_user::text <> 'momo_app'
     AND NOT COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user::text), false) THEN
    RAISE EXCEPTION 'mem_forget_item: only the API role may forget items' USING ERRCODE = '42501';
  END IF;
  IF v_ws IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'mem_forget_item: no acting member' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.member m
                  WHERE m.id = v_actor AND m.workspace_id = v_ws AND m.kind = 'human'
                    AND m.status = 'active' AND m.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'mem_forget_item: the acting member must be an active human' USING ERRCODE = '42501';
  END IF;
  IF NOT public.mem_item_readable_by(p_item_id, v_actor) THEN
    RAISE EXCEPTION 'mem_forget_item: item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO o FROM public.mem_item i
   WHERE i.id = p_item_id AND i.workspace_id = v_ws
   FOR UPDATE;
  IF NOT FOUND OR NOT public.mem_item_readable_by(o.id, v_actor) THEN
    RAISE EXCEPTION 'mem_forget_item: item not found' USING ERRCODE = 'P0002';
  END IF;
  -- M-6: guest 는 못 잊는다.
  IF EXISTS (SELECT 1 FROM public.membership ms
              WHERE ms.workspace_id = v_ws AND ms.member_id = v_actor AND ms.left_at IS NULL
                AND ms.role = 'guest'
                AND (ms.channel_id = o.channel_id
                     OR ms.channel_id IN (SELECT ev.channel_id FROM public.mem_evidence ev
                                           WHERE ev.item_id = o.id AND ev.workspace_id = v_ws)))
     OR EXISTS (SELECT 1 FROM public.workspace_membership wm
                 WHERE wm.workspace_id = v_ws AND wm.member_id = v_actor AND wm.role = 'guest') THEN
    RAISE EXCEPTION 'mem_forget_item: guests may not change memory items' USING ERRCODE = '42501';
  END IF;
  -- 새 버전이 있는 옛 버전만 잊는 것은 거부한다(읽을 수 있는 사람에게만 닿는다).
  IF EXISTS (SELECT 1 FROM public.mem_item s WHERE s.supersedes_id = o.id AND s.workspace_id = v_ws) THEN
    RAISE EXCEPTION 'mem_forget_item: a newer version exists; forget the newest version' USING ERRCODE = '55000';
  END IF;

  WITH RECURSIVE chain(id) AS (
    SELECT o.id
    UNION
    SELECT i.supersedes_id FROM public.mem_item i JOIN chain c ON i.id = c.id
     WHERE i.supersedes_id IS NOT NULL AND i.workspace_id = v_ws
  )
  SELECT pg_catalog.array_agg(c.id) INTO v_chain FROM chain c;

  -- M-5: 잊은 (채널, 해시)를 기억해 재추출이 되살리지 못하게 한다(해시만).
  INSERT INTO public.mem_suppress (workspace_id, channel_id, content_hash)
  SELECT DISTINCT i.workspace_id, i.channel_id, i.content_hash
    FROM public.mem_item i WHERE i.id = ANY (v_chain) AND i.workspace_id = v_ws
  ON CONFLICT DO NOTHING;
  -- M-1: 같은 해시의 죽은·내려간 쌍둥이(예: 재추출이 남긴 stale 행)도 지운다. 살아 있는 쌍둥이는 두지 않는다
  -- (행위자가 그것을 읽을 수 있는지 알 수 없다).
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT t.id), '{}'::uuid[]) INTO v_twins
    FROM public.mem_item t
    JOIN public.mem_item c ON c.id = ANY (v_chain) AND c.workspace_id = v_ws
   WHERE t.workspace_id = v_ws AND t.channel_id = c.channel_id AND t.content_hash = c.content_hash
     AND t.id <> ALL (v_chain) AND (t.stale OR t.retired_at IS NOT NULL);
  v_all := v_chain || v_twins;

  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id, detail)
  SELECT v_ws, 'item', c.id, 'forgotten', v_actor,
         CASE WHEN c.id = o.id THEN pg_catalog.jsonb_build_object('versions', pg_catalog.cardinality(v_chain))
              ELSE pg_catalog.jsonb_build_object('via', o.id) END
    FROM pg_catalog.unnest(v_all) AS c(id);
  DELETE FROM public.mem_evidence ev WHERE ev.item_id = ANY (v_all) AND ev.workspace_id = v_ws;
  DELETE FROM public.mem_item i WHERE i.id = ANY (v_all) AND i.workspace_id = v_ws;
  RETURN pg_catalog.cardinality(v_all);
END
$$;

-- ── 소유자·권한 ────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO mem_definer;
ALTER FUNCTION mem_edit_item(uuid, text, text) OWNER TO mem_definer;
ALTER FUNCTION mem_forget_item(uuid) OWNER TO mem_definer;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- 이 두 함수는 mem_search_items 처럼 PUBLIC EXECUTE + 함수 안의 session_user 가드다(역할이 마이그레이션보다
-- 늦게 생겨도 부여 순서에 기대지 않는다). 런타임 역할에서 EXECUTE 를 빼는 것은 워커 전용 함수뿐이라
-- 여기서 하지 않는다. (공용 mem-lockdown 블록은 건드리지 않는다.)

-- ── L-1: mem_definer 소유 SECURITY DEFINER 함수 허용 목록 (104 것 + 이 파일의 2개) ─────────────
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
    'mem_edit_item', 'mem_forget_item'
  ];
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'mem_definer'
              AND p.proname <> ALL (allow) LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % owned by mem_definer is not in the allow-list', f;
  END LOOP;
END $$;
