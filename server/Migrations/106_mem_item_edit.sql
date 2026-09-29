-- =============================================================================
-- 106_mem_item_edit.sql — #3208 / ADR-0196 (팀 기억 v2) M2: 기억 브라우저의 편집·잊기
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

-- ── 제안 경로의 억제 검사 (#3210 의 105_mem_proposal.sql 함수에 한 블록씩만 더한 재정의) ─────────────────
-- 본문은 105 것을 그대로 옮겼고(게스트 규칙·M-1 창 대체·L-2 락 순서 포함) 각 함수에 억제 검사 한 블록만 더했다.
-- CREATE OR REPLACE 라 소유자·EXECUTE 권한(mem_propose_item = momo_memory, mem_accept_proposal = API)은 그대로다.
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
  -- #3208 M-5: 사람이 잊은 (채널, 해시)는 다시 제안하지 않는다(제안 없음 = NULL, 중복과 같은 답).
  IF EXISTS (SELECT 1 FROM public.mem_suppress s
              WHERE s.workspace_id = v_ws AND s.channel_id = v_channel AND s.content_hash = v_hash) THEN
    RETURN NULL;
  END IF;
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
  -- #3208 M-5: 잊은 내용의 제안은 수락할 수 없다(삽입 트리거가 조용히 건너뛰면 아래가 NULL 로 이어져 알 수 없는
  -- 오류가 되므로 먼저 분명히 거절한다. 55000 → API 409, 다른 「더는 결정할 수 없음」 거절과 같은 매핑).
  IF EXISTS (SELECT 1 FROM public.mem_suppress s
              WHERE s.workspace_id = v_ws AND s.channel_id = v_p.channel_id AND s.content_hash = v_hash) THEN
    RAISE EXCEPTION 'mem_accept_proposal: this memory was forgotten' USING ERRCODE = '55000';
  END IF;

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

-- ── L-1: mem_definer 소유 SECURITY DEFINER 함수 허용 목록 (104·105 것 + 이 파일의 2개) ─────────────
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
    'mem_edit_item', 'mem_forget_item'
  ];
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'mem_definer'
              AND p.proname <> ALL (allow) LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % owned by mem_definer is not in the allow-list', f;
  END LOOP;
END $$;
