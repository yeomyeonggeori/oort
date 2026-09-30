-- =============================================================================
-- 110_mem_reset.sql — #3212 / ADR-0196 (팀 기억 v2) M2: 기억 초기화(워크스페이스 관리자) + 팀 고지의 서버 쪽
--
-- 정의자 함수 둘 (API 세션이 부른다 — 106 의 mem_edit_item / mem_forget_item 과 같은 신뢰 경계)
--   mem_reset_workspace(기대 세대)   D9 「초기화 = 워크스페이스 관리자, 전량 영구 삭제(reset_epoch)」
--   mem_summary_provider()           팀 고지: 요약이 어느 제공자·모델로 가는가(키·링크 비밀 없음, 라벨과 모델 id 만)
--
-- ── 초기화가 지우는 것 / 남기는 것 (D9 · D10 「잊기·초기화는 즉시 영구 삭제. 이벤트 원장은 id만 남는다」) ──────────────
--  지운다(이 워크스페이스의 모든 행, mem.op='reset' 표지 아래 명시적으로):
--    mem_topic_summary · mem_cons_pair · mem_item_embedding · mem_proposal · mem_evidence(요약·항목 근거 전부) ·
--    mem_item(옛 버전 사슬 포함) · mem_topic · mem_digest · mem_serving(영수증) · mem_cons_state
--  남긴다(이유):
--    mem_settings   스위치(enabled/paused/채널 제외/개인 일시정지/토큰 상한)는 그대로 — 초기화는 데이터를 지우는 것이지
--                   설정을 되돌리는 것이 아니다. reset_epoch 만 +1.
--    mem_suppress · mem_suppress_msg   「잊은」 해시·메시지 id. 본문이 없다(해시·id 뿐). 사람이 명시적으로 잊은 사실이
--                   관리자의 초기화 뒤에 다시 추출되면 개인정보 조치가 뒤집힌다 — 초기화가 잊기를 무르지 않는다.
--    mem_usage      일일 토큰 사용량(비용 원장, 기억 내용 아님). 지우면 초기화로 일일 상한을 우회할 수 있다.
--    mem_event      추가 전용 원장(UPDATE/DELETE 는 RESTRICTIVE false 로 막혀 있다). id·종류·개수뿐이라 본문이 없다.
--                   초기화는 여기에 ('workspace', ws, 'reset') 한 줄(행위자·세대·지운 행 수)만 더한다. 이 행은 채널 열이 없어
--                   읽기 정책(mem_event_sel)에 누구에게도 보이지 않는다 — 사람이 보는 흔적은 API 가 쓰는 audit_log
--                   `memory.reset`(행위자만)이다.
--    mem_cursor     지우지 않고 **채널 헤드로 옮긴다**(아래).
--
-- ── 커서: 초기화 뒤에는 새 메시지에서만 다시 쌓는다 ─────────────────────────────────────────────────────────
--  커서를 지우면 워커는 채널을 「처음 보는 채널」로 여기고 backfill(기본 14일) 만큼의 옛 메시지를 곧바로 다시 요약한다 —
--  방금 지운 기억이 그대로 되살아난다. 그래서 워크스페이스의 모든 채널 커서를 지금의 채널 헤드로 옮기고(없으면 만들고),
--  reset_floor_seq 에 같은 값을 적는다. 리스는 푼다.
--
-- ── 경합: 진행 중인 요약·항목 추출이 초기화 뒤에 옛 내용을 되살리지 못한다 ────────────────────────────────────────
--  기억의 「내용」이 메시지에서 새로 만들어지는 쓰기는 둘뿐이다: mem_apply_digest(메시지 → 요약)와 mem_add_item(요약 →
--  항목). 그 밖의 워커 쓰기(정리·임베딩·주제)는 이미 있는 항목·주제의 id 를 참조하므로 초기화가 그 행을 지우면 스스로 실패한다
--  (FK / 「없음」). 사람·에이전트가 지금 하는 행위(편집·수락·제안)는 초기화 이후의 의사 표시라 막지 않는다.
--   ① 직렬화(어드바이저리 락): 두 함수는 시작부에서 `mem_reset:<ws>` 락을 공유로, mem_reset_workspace 는 배타로 잡는다.
--      요약이 커밋 전이면 초기화는 그 커밋까지 기다렸다가 결과를 지우고, 초기화가 커밋 전이면 요약은 그 뒤에야 진행한다.
--   ② 세대 울타리(epoch 검사의 메시지판): 초기화가 커밋된 **뒤** 옛 메시지를 읽어 두었던 워커가 요약을 쓰려 하면, 근거 메시지
--      seq 가 채널의 reset_floor_seq 이하라 mem_apply_digest 가 40001 로 거부한다(워커는 이 코드를 「다시 읽기」로 다룬다).
--      항목은 그 요약(이미 지워짐)에 기대므로 mem_add_item 의 「근거 ⊆ 요약 근거」 검사가 23503 으로 거부한다.
--      시계도, 워커가 들고 다니는 세대 값도 필요 없다 — 새 코드가 세대를 잊을 수 없다(울타리가 DB 안에 있다).
--   락 순서: 「메시지 행 → 채널 advisory → 워크스페이스 reset advisory → 행」. 초기화는 워크스페이스 락만 잡고 행을 지운다.
--   초기화가 행 락으로 다른 tx(정리·편집)와 맞물려 교착(40P01)하면 PG 가 한쪽을 중단한다 — API 가 초기화를 재시도한다.
--
-- ── reset_epoch 는 함수만 올린다 ──────────────────────────────────────────────────────────────────────────
--  mem_settings 는 관리자가 직접 쓰는 표(momo_app INSERT/UPDATE)라 「세대만 올리고 지우지는 않은」 상태가 될 수 있었다(이슈 #3212의
--  「오인」). BEFORE 트리거가 reset_epoch 변경을 mem.op='reset' 을 세운 mem_definer 의 +1 로만 허용한다.
--
-- ── 팀 고지 데이터 ───────────────────────────────────────────────────────────────────────────────────────
--  provider_default_ai 는 운영자 전용 RLS(app.provider_link_admin='on') 표다. 그 GUC 를 일반 멤버 tx 에 켜면 provider_link 의
--  봉인된 키까지 열리므로 켜지 않는다. 대신 mem_definer 에게 (role, link_endpoint_label, model_id) 세 열의 SELECT 와
--  role='summary' 한 행만 여는 정책을 주고, mem_summary_provider() 가 그것만 돌려준다.
--
-- 재실행 가능한 문장만 쓴다. schema_v0.sql·100~109 는 고치지 않는다(mem_apply_digest·mem_add_item 은 108 정의를 CREATE OR
-- REPLACE 한다 — 바뀐 곳에 「#3212」 주석).
-- =============================================================================

-- ── 채널 커서: 초기화 울타리 ────────────────────────────────────────────────────────
ALTER TABLE mem_cursor ADD COLUMN IF NOT EXISTS reset_floor_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE mem_cursor DROP CONSTRAINT IF EXISTS mem_cursor_floor_ck;
ALTER TABLE mem_cursor ADD CONSTRAINT mem_cursor_floor_ck
  CHECK (reset_floor_seq >= 0 AND reset_floor_seq <= last_seq);

-- ── 정의자 권한 ─────────────────────────────────────────────────────────────────────
-- 세대를 올리는 쓰기: 워크스페이스 행의 reset_epoch·updated_at 뿐(행이 없으면 만든다 — 다른 열은 기본값).
GRANT INSERT (workspace_id, scope, reset_epoch, updated_at) ON mem_settings TO mem_definer;
GRANT UPDATE (reset_epoch, updated_at) ON mem_settings TO mem_definer;
DROP POLICY IF EXISTS mem_settings_reset_ins ON mem_settings;
CREATE POLICY mem_settings_reset_ins ON mem_settings FOR INSERT TO mem_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
              AND scope = 'workspace');
DROP POLICY IF EXISTS mem_settings_reset_upd ON mem_settings;
CREATE POLICY mem_settings_reset_upd ON mem_settings FOR UPDATE TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
         AND scope = 'workspace')
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
              AND scope = 'workspace');

-- 정리 상태·판정 캐시의 삭제(지금까지 삭제 권한도 정책도 없었다).
GRANT DELETE ON mem_cons_state, mem_cons_pair TO mem_definer;
DROP POLICY IF EXISTS mem_cons_state_del ON mem_cons_state;
CREATE POLICY mem_cons_state_del ON mem_cons_state FOR DELETE TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_cons_pair_del ON mem_cons_pair;
CREATE POLICY mem_cons_pair_del ON mem_cons_pair FOR DELETE TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- 삭제 표지 목록에 'reset' 을 더한다(RESTRICTIVE 는 AND 라 표지 없는 삭제는 여전히 거부된다).
DROP POLICY IF EXISTS mem_item_only_definer_del ON mem_item;
CREATE POLICY mem_item_only_definer_del ON mem_item AS RESTRICTIVE FOR DELETE
  USING (current_user = 'mem_definer'
         AND pg_catalog.current_setting('mem.op', true) IN ('forget_item', 'cons_retention', 'reset'));
DROP POLICY IF EXISTS mem_evidence_marked_del ON mem_evidence;
CREATE POLICY mem_evidence_marked_del ON mem_evidence AS RESTRICTIVE FOR DELETE
  USING (digest_id IS NOT NULL
         OR pg_catalog.current_setting('mem.op', true) IN ('forget_item', 'cons_retention', 'cons_revert', 'reset'));
DROP POLICY IF EXISTS mem_proposal_only_definer_del ON mem_proposal;
CREATE POLICY mem_proposal_only_definer_del ON mem_proposal AS RESTRICTIVE FOR DELETE
  USING (current_user = 'mem_definer'
         AND pg_catalog.current_setting('mem.op', true) IN ('cons_purge', 'reset'));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_topic', 'mem_topic_summary'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_marked_del', t);
    EXECUTE format($f$CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE
      USING (current_user = 'mem_definer'
             AND pg_catalog.current_setting('mem.op', true) IN ('topic_gc', 'topic_split', 'topic_revert', 'topic_summary', 'reset'))$f$,
      t || '_marked_del', t);
  END LOOP;
END $$;

-- ── reset_epoch 는 mem_reset_workspace 만 올린다 ─────────────────────────────────────
-- 트리거 함수는 SECURITY INVOKER 다(mem_item_suppressed_guard 와 같은 자리): 지금 쓰는 역할이 mem_definer 이고 함수가 표지를 세웠을 때만.
CREATE OR REPLACE FUNCTION mem_settings_epoch_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- INSERT 는 ON CONFLICT DO UPDATE 의 첫 단계이기도 하다(행이 이미 있으면 UPDATE 가지가 +1 을 다시 검사한다).
  IF TG_OP = 'INSERT' THEN
    IF NEW.reset_epoch <> 0
       AND NOT (current_user = 'mem_definer'
                AND pg_catalog.current_setting('mem.op', true) = 'reset' AND NEW.reset_epoch >= 1) THEN
      RAISE EXCEPTION 'mem_settings: reset_epoch is raised by mem_reset_workspace only' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.reset_epoch IS DISTINCT FROM OLD.reset_epoch THEN
    IF NOT (current_user = 'mem_definer'
            AND pg_catalog.current_setting('mem.op', true) = 'reset'
            AND NEW.reset_epoch = OLD.reset_epoch + 1) THEN
      RAISE EXCEPTION 'mem_settings: reset_epoch is raised by mem_reset_workspace only' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS mem_settings_epoch_guard_trg ON mem_settings;
CREATE TRIGGER mem_settings_epoch_guard_trg
  BEFORE INSERT OR UPDATE OF reset_epoch ON mem_settings
  FOR EACH ROW EXECUTE FUNCTION mem_settings_epoch_guard();

-- ── 워커가 울타리를 안다: mem_cursor_state 에 reset_floor_seq (보안 검수 H-1) ───────────────────────────
-- 워커는 mem_* 를 읽지 못하므로 커서 상태 함수로만 안다. 반환 열이 바뀌어 DROP 후 다시 만든다(워커 전용 ACL 복원).
DROP FUNCTION IF EXISTS mem_cursor_state(uuid);
CREATE FUNCTION mem_cursor_state(p_channel_id uuid)
RETURNS TABLE (last_seq bigint, lease_token uuid, leased_until timestamptz, head_seq bigint, reset_floor_seq bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(c.last_seq, 0), c.lease_token, c.leased_until, cs.last_seq, COALESCE(c.reset_floor_seq, 0)
    FROM public.channel_seq cs
    LEFT JOIN public.mem_cursor c
      ON c.channel_id = cs.channel_id AND c.workspace_id = cs.workspace_id
   WHERE cs.channel_id = p_channel_id
     AND cs.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
$$;
GRANT CREATE ON SCHEMA public TO mem_definer;
ALTER FUNCTION mem_cursor_state(uuid) OWNER TO mem_definer;
REVOKE CREATE ON SCHEMA public FROM mem_definer;
DO $$
DECLARE r text;
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.mem_cursor_state(uuid) FROM PUBLIC';
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.mem_cursor_state(uuid) FROM %I', r);
    END IF;
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.mem_cursor_state(uuid) TO momo_memory';
END $$;

-- ── reset_epoch 는 줄지 않는다 (보안 검수 L-5) ───────────────────────────────────────────────────────
-- 워크스페이스 행을 지웠다 다시 넣으면 세대가 0 으로 돌아가 낡은 expectedEpoch 가 다시 통한다. 세대가 오른 워크스페이스 행의 삭제는
-- 워크스페이스 자체가 사라질 때(FK 연쇄)만 허용한다.
CREATE OR REPLACE FUNCTION mem_settings_epoch_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.scope = 'workspace' AND OLD.reset_epoch > 0
     AND EXISTS (SELECT 1 FROM public.workspace w WHERE w.id = OLD.workspace_id) THEN
    RAISE EXCEPTION 'mem_settings: the workspace settings row (reset_epoch %) cannot be deleted', OLD.reset_epoch
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS mem_settings_epoch_no_delete_trg ON mem_settings;
CREATE TRIGGER mem_settings_epoch_no_delete_trg
  BEFORE DELETE ON mem_settings
  FOR EACH ROW EXECUTE FUNCTION mem_settings_epoch_no_delete();

-- ── 팀 고지: 요약 제공자 읽기 (열 세 개, 한 행) ──────────────────────────────────────
GRANT SELECT (role, link_endpoint_label, model_id) ON provider_default_ai TO mem_definer;
DROP POLICY IF EXISTS provider_default_ai_summary_mem ON provider_default_ai;
CREATE POLICY provider_default_ai_summary_mem ON provider_default_ai FOR SELECT TO mem_definer
  USING (role = 'summary');

-- 이 인스턴스의 요약이 갈 곳: 「기본 AI」 summary 행의 (엔드포인트 라벨, 모델 id). 행이 없으면 0행.
-- 라벨은 저장 당시의 redacted_endpoint_label(사용자정보·쿼리·조각 없음)이다. 링크가 그 뒤에 바뀌었는지(linkResolved)는
-- provider_link 를 읽어야 알 수 있어 여기서 하지 않는다(그 표는 봉인된 키를 담고 있다).
-- 호출자: 이 워크스페이스의 활성 사람 멤버 누구나(게스트 포함 — 자기 메시지가 어디로 가는지 알 권리). 에이전트·다른 워크스페이스는
-- 42501. session_user 가 momo_app(또는 슈퍼유저)이 아니면 42501(106 과 같은 가드).
CREATE OR REPLACE FUNCTION mem_summary_provider()
RETURNS TABLE (endpoint_label text, model_id text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_actor uuid := nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid;
BEGIN
  IF session_user::text <> 'momo_app'
     AND NOT COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user::text), false) THEN
    RAISE EXCEPTION 'mem_summary_provider: only the API role may read this' USING ERRCODE = '42501';
  END IF;
  IF v_ws IS NULL OR v_actor IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.member m
        WHERE m.id = v_actor AND m.workspace_id = v_ws AND m.kind = 'human'
          AND m.status = 'active' AND m.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'mem_summary_provider: the acting member must be an active human' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT d.link_endpoint_label, d.model_id FROM public.provider_default_ai d WHERE d.role = 'summary';
END
$$;

-- ── 초기화 ─────────────────────────────────────────────────────────────────────────
-- 반환: {"epoch": 새 세대, "deleted": {테이블: 지운 행 수}}. 오류는 전부 「mem_reset_workspace:」 접두사(API 는 이 접두사일 때만 매핑).
--   42501  API 세션이 아님 / 행위자 없음·사람 아님 / 워크스페이스 owner·admin 아님(게스트 포함)
--   22023  기대 세대가 없다/음수
--   55000  기대 세대 ≠ 현재 세대 — 이미 초기화됐거나 다른 관리자가 먼저 했다(두 번 누름/재시도 방지 → 409)
--   40001  삭제 뒤에도 초기화 전의 행이 남았다(경합) — 통째로 되돌렸다. 시도를 반복하면 된다(API 가 3회까지 재시도)
CREATE OR REPLACE FUNCTION mem_reset_workspace(p_expected_epoch bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_actor uuid := nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid;
  v_epoch bigint;
  v_pass integer;
  v_n integer;
  v_round integer;
  v_started timestamptz := pg_catalog.clock_timestamp();
  v_topic_summaries bigint := 0;
  v_pairs bigint := 0;
  v_embeddings bigint := 0;
  v_proposals bigint := 0;
  v_evidence bigint := 0;
  v_items bigint := 0;
  v_topics bigint := 0;
  v_digests bigint := 0;
  v_servings bigint := 0;
  v_cons bigint := 0;
  v_deleted jsonb;
BEGIN
  PERFORM public.mem_op('reset');
  IF session_user::text <> 'momo_app'
     AND NOT COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user::text), false) THEN
    RAISE EXCEPTION 'mem_reset_workspace: only the API role may reset memory' USING ERRCODE = '42501';
  END IF;
  IF v_ws IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'mem_reset_workspace: no acting member' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.member m
                  WHERE m.id = v_actor AND m.workspace_id = v_ws AND m.kind = 'human'
                    AND m.status = 'active' AND m.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'mem_reset_workspace: the acting member must be an active human' USING ERRCODE = '42501';
  END IF;
  -- owner / admin 만(guest·member 는 아니다).
  IF NOT public.mem_is_workspace_admin() THEN
    RAISE EXCEPTION 'mem_reset_workspace: only a workspace owner or admin may reset memory' USING ERRCODE = '42501';
  END IF;
  IF p_expected_epoch IS NULL OR p_expected_epoch < 0 THEN
    RAISE EXCEPTION 'mem_reset_workspace: expected epoch is required' USING ERRCODE = '22023';
  END IF;

  -- 진행 중인 요약·항목 추출과 직렬화한다(위 「경합」 ①). 첫 락이다.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mem_reset:' || v_ws::text, 0));

  -- 기대 세대(두 번 누름 방지). 행이 있으면 잠그고 비교한다.
  SELECT s.reset_epoch INTO v_epoch FROM public.mem_settings s
   WHERE s.workspace_id = v_ws AND s.scope = 'workspace'
   FOR UPDATE;
  v_epoch := COALESCE(v_epoch, 0);
  IF v_epoch <> p_expected_epoch THEN
    RAISE EXCEPTION 'mem_reset_workspace: the memory was already reset (epoch is now %)', v_epoch
      USING ERRCODE = '55000';
  END IF;

  -- 커서: 모든 채널을 지금의 헤드로 옮기고 울타리를 세운다(없으면 만든다). 리스는 푼다.
  INSERT INTO public.mem_cursor (channel_id, workspace_id, last_seq, reset_floor_seq)
  SELECT cs.channel_id, cs.workspace_id, cs.last_seq, cs.last_seq
    FROM public.channel_seq cs
   WHERE cs.workspace_id = v_ws
  ON CONFLICT (channel_id) DO UPDATE
     SET last_seq = GREATEST(public.mem_cursor.last_seq, EXCLUDED.last_seq),
         reset_floor_seq = GREATEST(public.mem_cursor.last_seq, EXCLUDED.last_seq),
         lease_token = NULL, leased_until = NULL, updated_at = pg_catalog.now();

  -- 삭제: 잎 → 뿌리 순서. 한 번의 DELETE 는 시작 시점의 스냅샷만 보므로, 우리를 기다리게 했던 tx(편집·수락·정리)가 그 사이 커밋한
  -- 새 행을 놓칠 수 있다 — 더 지울 것이 없을 때까지(최대 5회) 되풀이한다. 그 tx 들은 지운 행을 참조하므로 두 번째 회차에서 끝난다.
  FOR v_pass IN 1..5 LOOP
    v_round := 0;
    DELETE FROM public.mem_topic_summary WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_topic_summaries := v_topic_summaries + v_n; v_round := v_round + v_n;
    DELETE FROM public.mem_cons_pair WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_pairs := v_pairs + v_n; v_round := v_round + v_n;
    DELETE FROM public.mem_item_embedding WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_embeddings := v_embeddings + v_n; v_round := v_round + v_n;
    -- 제안을 항목보다 먼저: 수락 tx 가 제안 행을 쥐고 있으면 그 커밋(=새 항목)까지 기다렸다가 아래 항목 삭제가 그것을 본다.
    DELETE FROM public.mem_proposal WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_proposals := v_proposals + v_n; v_round := v_round + v_n;
    DELETE FROM public.mem_evidence WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_evidence := v_evidence + v_n; v_round := v_round + v_n;
    DELETE FROM public.mem_item WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_items := v_items + v_n; v_round := v_round + v_n;
    DELETE FROM public.mem_topic WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_topics := v_topics + v_n; v_round := v_round + v_n;
    DELETE FROM public.mem_digest WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_digests := v_digests + v_n; v_round := v_round + v_n;
    DELETE FROM public.mem_serving WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_servings := v_servings + v_n; v_round := v_round + v_n;
    DELETE FROM public.mem_cons_state WHERE workspace_id = v_ws;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_cons := v_cons + v_n; v_round := v_round + v_n;
    EXIT WHEN v_round = 0;
    IF v_pass = 5 THEN
      -- 5회를 돌고도 계속 새 행이 나온다: 조용히 나가지 않고 통째로 되돌린다(API 가 다시 시도한다).
      RAISE EXCEPTION 'mem_reset_workspace: rows kept appearing during the reset; nothing was changed'
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  -- 사후 검사: RLS 는 삭제할 수 없는 행을 오류 없이 건너뛴다(예: 표지 정책이 어긋났을 때). 그러면 「세대만 오른 채 데이터가 남는」
  -- 가장 나쁜 상태가 되므로, 초기화가 시작되기 전에 있던 행이 하나라도 남아 있으면 통째로 되돌린다(40001 — API 가 다시 시도한다).
  -- 시작 뒤에 다른 tx 가 새로 만든 행(recorded_at/created_at > 시작)은 초기화 뒤의 행동이라 세지 않는다.
  IF EXISTS (SELECT 1 FROM public.mem_item i WHERE i.workspace_id = v_ws AND i.recorded_at <= v_started)
     OR EXISTS (SELECT 1 FROM public.mem_digest d WHERE d.workspace_id = v_ws AND d.created_at <= v_started)
     OR EXISTS (SELECT 1 FROM public.mem_topic t WHERE t.workspace_id = v_ws AND t.created_at <= v_started)
     OR EXISTS (SELECT 1 FROM public.mem_proposal p WHERE p.workspace_id = v_ws AND p.created_at <= v_started)
     OR EXISTS (SELECT 1 FROM public.mem_topic_summary ts WHERE ts.workspace_id = v_ws AND ts.created_at <= v_started) THEN
    RAISE EXCEPTION 'mem_reset_workspace: rows survived the reset; nothing was changed' USING ERRCODE = '40001';
  END IF;

  -- 세대 +1 (행이 없었으면 1 로 만든다). 다른 열(스위치)은 건드리지 않는다.
  INSERT INTO public.mem_settings (workspace_id, scope, reset_epoch, updated_at)
  VALUES (v_ws, 'workspace', v_epoch + 1, pg_catalog.now())
  ON CONFLICT (workspace_id) WHERE scope = 'workspace'
  DO UPDATE SET reset_epoch = EXCLUDED.reset_epoch, updated_at = EXCLUDED.updated_at;

  v_deleted := pg_catalog.jsonb_build_object(
    'digests', v_digests, 'items', v_items, 'evidence', v_evidence, 'topics', v_topics,
    'topicSummaries', v_topic_summaries, 'embeddings', v_embeddings, 'proposals', v_proposals,
    'servings', v_servings, 'consolidationPairs', v_pairs, 'consolidationState', v_cons);
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id, detail)
  VALUES (v_ws, 'workspace', v_ws, 'reset', v_actor,
          pg_catalog.jsonb_build_object('epoch', v_epoch + 1, 'deleted', v_deleted));
  RETURN pg_catalog.jsonb_build_object('epoch', v_epoch + 1, 'deleted', v_deleted);
END
$$;


-- ── 108 정의의 재정의: 초기화 락 + 울타리 (본문은 108 그대로, 바뀐 곳에 「#3212」 주석) ───────────────────────────
-- CREATE OR REPLACE 라 소유자·EXECUTE 권한은 그대로다.

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
  -- H-1: 락 순서는 어디서나 「메시지 행 → 채널 advisory」. 편집 tx 는 메시지 행을 FOR UPDATE 로
  -- 쥔 채 트리거에서 advisory(exclusive)를 기다린다. 여기서 advisory(shared)를 먼저 쥐고 나중에
  -- mem_evidence FK 가 같은 행에 FOR KEY SHARE 를 요청하면 교착(40P01)이다. 그래서 근거 행을
  -- id 순으로 먼저 잠근다(편집이 먼저면 여기서 기다리고, 우리가 먼저면 편집이 커밋까지 기다린다).
  PERFORM 1 FROM public.message m
   WHERE m.id = ANY (p_evidence_message_ids) AND m.workspace_id = v_ws AND m.channel_id = p_channel_id
   ORDER BY m.id
   FOR KEY SHARE;
  -- L-2: 이 채널의 수정·삭제 트리거(exclusive)와 직렬화한다. 이후 문장은 락을 얻은 뒤의
  -- 새 스냅샷으로 돈다(READ COMMITTED) — 먼저 커밋된 편집은 아래 40001 검사가 잡는다.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_digest:' || p_channel_id::text, 0));
  -- #3212: 워크스페이스 초기화(mem_reset_workspace)와 직렬화한다. 락 순서는 「메시지 행 → 채널 advisory → 워크스페이스
  -- reset advisory」 — 초기화는 이 마지막 락 하나만 배타로 잡고 그 뒤에 행을 지우므로 (메시지 행·채널 락을 기다리지 않아) 순환하지
  -- 않는다. 초기화가 먼저면 여기서 그 커밋까지 기다리고, 우리가 먼저면 초기화가 이 tx 의 커밋까지 기다렸다가 결과를 지운다.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_reset:' || v_ws::text, 0));
  -- 스위치(D9)·DM 규칙: 꺼졌거나 정지·제외·보관됐거나 사람끼리 DM 이면 기록하지 않는다.
  IF NOT public.mem_channel_eligible(p_channel_id) THEN
    RAISE EXCEPTION 'mem_apply_digest: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;
  -- #3212: 초기화 울타리. 초기화는 채널마다 reset_floor_seq(그때의 채널 헤드)를 남긴다. 그 이하의 메시지는 초기화로 지워진
  -- 내용이므로 어떤 요약의 근거도 될 수 없다 — 스레드 뿌리도 예외가 아니다(보안 검수 M-1). 워커는 이 값을 mem_cursor_state 로
  -- 알고 읽기 단계에서 미리 걸러 모델을 부르지 않는다; 이 검사는 경합 뒤의 마지막 벽이다. 다시 읽어도 소용없으므로(40001 이 아니라)
  -- 전용 SQLSTATE 55R01 을 쓴다 — 워커는 재시도하지 않고 건너뛴다.
  IF EXISTS (SELECT 1
               FROM public.mem_cursor c
               JOIN public.message m
                 ON m.workspace_id = c.workspace_id AND m.channel_id = c.channel_id
              WHERE c.workspace_id = v_ws AND c.channel_id = p_channel_id AND c.reset_floor_seq > 0
                AND m.id = ANY (p_evidence_message_ids)
                AND m.seq <= c.reset_floor_seq) THEN
    RAISE EXCEPTION 'mem_apply_digest: evidence predates a memory reset' USING ERRCODE = '55R01';
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
  -- A-3: 잊은 사실의 메시지(mem_suppress_msg)는 어떤 요약의 근거도 될 수 없다 — 워커가 빼는 것에 기대지 않고 DB 가 거부한다.
  IF EXISTS (SELECT 1 FROM public.mem_suppress_msg sm
              WHERE sm.workspace_id = v_ws AND sm.channel_id = p_channel_id
                AND sm.message_id = ANY (p_evidence_message_ids)) THEN
    RAISE EXCEPTION 'mem_apply_digest: a message of a forgotten fact cannot be digest evidence'
      USING ERRCODE = '23514';
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
         -- M-3: DM 은 현재 활성 멤버 모두가 합류한 뒤(가장 늦은 합류 이후)의 메시지만 근거가 될 수 있다(소급 요약 금지).
         AND (NOT EXISTS (SELECT 1 FROM public.channel dc WHERE dc.id = m.channel_id AND dc.kind = 'dm')
              OR m.created_at >= (
                   SELECT pg_catalog.max(x.joined_at) FROM public.membership x
                    WHERE x.channel_id = m.channel_id AND x.workspace_id = m.workspace_id
                      AND x.left_at IS NULL))
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
    -- #3172 H-3: a rollup normally rolls up window digests. The one exception: an existing STALE rollup whose windows
    -- retention has removed (D10) is rebuilt from the live messages of its range (the evidence checks above still hold).
    IF pg_catalog.cardinality(v_src) = 0 AND NOT EXISTS (
         SELECT 1 FROM public.mem_digest d
          WHERE d.workspace_id = v_ws AND d.channel_id = p_channel_id AND d.level = p_level
            AND d.to_seq = p_to_seq AND d.thread_root_id IS NOT DISTINCT FROM p_thread_root_id AND d.stale)
       -- A-3: 「입력 창이 정말 없을 때」만: 범위 안에 한 단계 아래 요약이 하나라도 있으면 그것으로 굴려야 한다.
       OR (pg_catalog.cardinality(v_src) = 0 AND EXISTS (
         SELECT 1 FROM public.mem_digest s
          WHERE s.workspace_id = v_ws AND s.channel_id = p_channel_id
            AND s.thread_root_id IS NOT DISTINCT FROM p_thread_root_id
            AND s.level = CASE p_level WHEN 'day' THEN 'window' ELSE 'day' END
            AND s.from_seq >= p_from_seq AND s.to_seq <= p_to_seq)) THEN
      RAISE EXCEPTION 'mem_apply_digest: a rollup needs source digests' USING ERRCODE = '23514';
    END IF;
    IF pg_catalog.cardinality(v_src) > 0 AND (SELECT pg_catalog.count(*) FROM public.mem_digest s
         WHERE s.id = ANY (v_src) AND s.workspace_id = v_ws AND s.channel_id = p_channel_id
           AND s.thread_root_id IS NOT DISTINCT FROM p_thread_root_id
           AND s.level = CASE p_level WHEN 'day' THEN 'window' ELSE 'day' END
           AND s.from_seq >= p_from_seq AND s.to_seq <= p_to_seq
       ) <> (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(v_src) AS x) THEN
      RAISE EXCEPTION 'mem_apply_digest: source digests must be one level below, same channel/thread, inside the range'
        USING ERRCODE = '23503';
    END IF;
    IF pg_catalog.cardinality(v_src) > 0 AND EXISTS (SELECT 1 FROM public.mem_evidence se
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
  PERFORM public.mem_op('add_item');
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
  -- #3212: 워크스페이스 초기화(mem_reset_workspace)와 직렬화한다. 락 순서는 「메시지 행 → 채널 advisory → 워크스페이스
  -- reset advisory」 — 초기화는 이 마지막 락 하나만 배타로 잡고 그 뒤에 행을 지우므로 (메시지 행·채널 락을 기다리지 않아) 순환하지
  -- 않는다. 초기화가 먼저면 여기서 그 커밋까지 기다리고, 우리가 먼저면 초기화가 이 tx 의 커밋까지 기다렸다가 결과를 지운다.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_reset:' || v_ws::text, 0));
  IF NOT public.mem_channel_eligible(v_channel) THEN
    RAISE EXCEPTION 'mem_add_item: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;
  -- #3212: 초기화 울타리(보안 검수 M-1/L-3) — 초기화 이전 메시지는 근거가 될 수 없다(55R01).
  IF EXISTS (SELECT 1
               FROM public.mem_cursor c
               JOIN public.message m
                 ON m.workspace_id = c.workspace_id AND m.channel_id = c.channel_id
              WHERE c.workspace_id = v_ws AND c.channel_id = v_channel AND c.reset_floor_seq > 0
                AND m.id = ANY (p_evidence_message_ids)
                AND m.seq <= c.reset_floor_seq) THEN
    RAISE EXCEPTION 'mem_add_item: evidence predates a memory reset' USING ERRCODE = '55R01';
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
      -- #3172 (D10 감쇠): 같은 내용이 **새 근거로** 다시 관찰되면 reinforce_count+1, 감쇠하는 항목이면 forget_after 를
      -- 14일 뒤로 늘린다. 같은 근거로 요약을 다시 만든 것은 재관찰이 아니다(근거가 새로 늘지 않는다).
      IF EXISTS (SELECT 1 FROM pg_catalog.unnest(p_evidence_message_ids) AS e(mid)
                  WHERE NOT EXISTS (SELECT 1 FROM public.mem_evidence oe
                                     WHERE oe.item_id = v_old AND oe.message_id = e.mid)) THEN
        UPDATE public.mem_item
           SET reinforce_count = reinforce_count + 1,
               last_seen_at = pg_catalog.now(),
               forget_after = CASE WHEN forget_after IS NULL THEN NULL
                                   ELSE GREATEST(forget_after, pg_catalog.now() + interval '14 days') END
         WHERE id = v_old;
        INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
        VALUES (v_ws, 'item', v_old, 'reinforced', v_channel, v_owner,
                pg_catalog.jsonb_build_object('digest_id', p_digest_id));
      END IF;
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
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
  VALUES (v_ws, 'item', v_id, 'created', v_channel, v_owner,
          pg_catalog.jsonb_build_object(
            'kind', p_kind, 'space', v_space, 'digest_id', p_digest_id,
            'source_count', v_n, 'extractor_version', p_extractor_version, 'model', p_model));
  RETURN v_id;
END
$$;


-- mem_propose_item (106 정의 + 초기화 락·울타리; 본문은 그대로, 바뀐 곳에 「#3212」)
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
  -- #3212 L-3: 초기화와 직렬화한다(락 순서: 메시지 행 → 채널 → 워크스페이스 reset → 행).
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_reset:' || v_ws::text, 0));
  -- #3212: 초기화 울타리(보안 검수 M-1/L-3) — 초기화 이전 메시지는 근거가 될 수 없다(55R01).
  IF EXISTS (SELECT 1
               FROM public.mem_cursor c
               JOIN public.message m
                 ON m.workspace_id = c.workspace_id AND m.channel_id = c.channel_id
              WHERE c.workspace_id = v_ws AND c.channel_id = v_channel AND c.reset_floor_seq > 0
                AND m.id = ANY (p_evidence_message_ids)
                AND m.seq <= c.reset_floor_seq) THEN
    RAISE EXCEPTION 'mem_propose_item: evidence predates a memory reset' USING ERRCODE = '55R01';
  END IF;

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

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────────────
-- 두 함수는 API 가 부른다(PUBLIC EXECUTE 는 106 의 mem_edit_item 과 같은 이유: 역할 생성 순서에 기대지 않고, 함수 안의 session_user
-- 가드와 GUC 행위자가 벽이다). 시험이 상태를 고정한다.
GRANT CREATE ON SCHEMA public TO mem_definer;
ALTER FUNCTION mem_reset_workspace(bigint) OWNER TO mem_definer;
ALTER FUNCTION mem_summary_provider() OWNER TO mem_definer;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- 보안 검수 L-6: 새 API 함수는 PUBLIC 이 아니라 momo_app 에만 EXECUTE 를 준다(session_user 가드는 그대로 둔다 — 벽이 둘이다).
-- 역할이 이 마이그레이션보다 늦게 생기면 부트스트랩(bootstrap_roles.sql · bootstrap_runtime_roles.sql)이 같은 GRANT 를 다시 준다.
REVOKE ALL ON FUNCTION mem_reset_workspace(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION mem_summary_provider() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT EXECUTE ON FUNCTION mem_reset_workspace(bigint) TO momo_app;
    GRANT EXECUTE ON FUNCTION mem_summary_provider() TO momo_app;
  END IF;
END $$;

-- ── L-9: mem_definer 소유 SECURITY DEFINER 함수 허용 목록 (전체 시그니처; 109 것 + 이 파일의 2개: mem_reset_workspace, mem_summary_provider) ──────────────
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
    'mem_cons_defer(uuid,uuid,text)', 'mem_cons_defer_pair(uuid,uuid)',
    'mem_cons_finish(uuid,uuid,boolean,integer)', 'mem_cons_merge_items(uuid,uuid,uuid,uuid)',
    'mem_cons_note_pair(uuid,uuid,text)', 'mem_cons_pairs(uuid,real,real,integer)',
    'mem_cons_propose(text,uuid,uuid)', 'mem_cons_purge_proposals(uuid)', 'mem_cons_reconcile(uuid)',
    'mem_cons_release(uuid[],text)', 'mem_cons_renew(uuid,uuid,double precision)',
    'mem_cons_retention(uuid,integer,integer,integer)', 'mem_cons_retire_dead(uuid,integer)',
    'mem_cons_revert(uuid)', 'mem_cons_revert_core(uuid,uuid)', 'mem_cursor_state(uuid)',
    'mem_digest_audience_ok(uuid,uuid,uuid)', 'mem_digest_evidence_ok(uuid)',
    'mem_digest_index(uuid,text,bigint)', 'mem_digest_live(uuid)',
    'mem_digest_rollup_inputs(uuid,uuid,text,bigint,bigint)', 'mem_drop_digest(uuid)',
    'mem_edit_item(uuid,text,text)', 'mem_embedding_stats(text)', 'mem_forget_item(uuid)',
    'mem_item_audience_ok(uuid,uuid,uuid)', 'mem_item_embedding_cleanup()', 'mem_item_evidence_ok(uuid)',
    'mem_item_guest_authored(uuid)', 'mem_item_live(uuid)', 'mem_item_readable_by(uuid,uuid)',
    'mem_items_to_embed(text,integer)', 'mem_message_changed()', 'mem_proposal_decider(uuid)',
    'mem_proposal_evidence_ok(uuid)', 'mem_propose_item(uuid,text,text,text,uuid[])',
    'mem_record_serving(uuid,uuid,uuid[],uuid[],integer,integer,integer)', 'mem_reject_proposal(uuid)',
    'mem_reset_workspace(bigint)', 'mem_summary_provider()',
    'mem_reserve_tokens(bigint,bigint)', 'mem_revert_consolidation(uuid)',
    'mem_search_items(text,integer,uuid,text)',
    'mem_search_items_core(uuid,text,integer,uuid,boolean,uuid,text)',
    'mem_search_items_for(uuid,text,integer,uuid)',
    'mem_search_items_fused(uuid,text,integer,uuid,text,text,real,real)',
    'mem_serve_candidates(uuid,bigint,integer,integer)', 'mem_serve_gate(uuid)',
    'mem_serve_items(uuid,integer,integer)',
    'mem_serve_items_fused(uuid,integer,integer,text,text,real,real)', 'mem_serve_query(uuid)',
    'mem_serve_requester(uuid)', 'mem_serving_of(uuid)', 'mem_serving_record_of(uuid)',
    'mem_set_item_embedding(uuid,text,text)', 'mem_stale_digests(integer,integer)',
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
