-- =============================================================================
-- 108_mem_consolidate.sql — #3172 / ADR-0196 (팀 기억 v2) M3: 정리 잡(중복 병합 · 결정 기간 닫기 · 감쇠 · 보존 삭제)
--
-- 백그라운드 정리(D4 「정리」 열)의 DB 쪽. agent-worker 의 정리 루프(consolidate.rs)가 momo_memory 로
-- SET LOCAL ROLE 한 memory tx 안에서 이 함수들만 부른다. 테이블 권한도 BYPASSRLS 도 없다.
--
--   mem_cons_begin / mem_cons_finish      채널 리스 + 일일 슬롯(이미 오늘 돌았으면 false)
--   mem_cons_retire_dead                  근거가 죽은 항목 → retired_reason=source_deleted/source_edited (D6-5)
--   mem_cons_decay                        forget_after 경과 + 재관찰 없음 → decayed (extracted/synthesized 만)
--   mem_cons_pairs                        같은 채널·같은 종류 후보 쌍(키워드 유사도; 벡터는 #3173 이 이 자리에 붙는다)
--   mem_cons_apply                        LLM 판정 하나(duplicate / supersedes / distinct)를 적용한다
--   mem_cons_retention                    retired 90일 뒤 영구 삭제 + 롤업이 덮은 창 요약 90일 뒤 정리 (D10·§6.3·§6.5)
--   mem_cons_purge_proposals              만료·근거 삭제·잊은 해시의 대기 제안 삭제 (#3210 이월)
--   mem_cons_revert                       정리 한 건 되돌리기(merged / superseded(contradiction) / retired(decayed))
--   mem_suppressed_messages               잊은 항목의 근거 메시지(요약 재생성 입력에서 뺄 것)
--
-- ── 결정 ─────────────────────────────────────────────────────────────────────────────────────────
--  * 정리는 사실을 지우지 않는다(잊기·보존 삭제만 지운다). 병합은 진 쪽에 merged_into_id, 기간 닫기는 옛 결정의
--    valid_to(Graphiti: 기존 invalid_at = 새 valid_at)만 바꾼다. 둘 다 mem_event 에 되돌릴 값을 남긴다.
--  * 결정 닫기는 supersedes_id 를 쓰지 않는다: 잊기(mem_forget_item)가 supersedes 사슬을 통째로 지우고 새 버전이
--    있는 옛 버전을 못 잊게 하기 때문이다(편집의 의미). 닫기는 closed_by_id/closed_at 과 valid_to 만이다.
--  * 사람이 확정한 것(origin curated/confirmed)은 자동으로 바꾸지 않는다. 지는 쪽·옛 쪽이 그 둘이면
--    mem_proposal(op='merge'|'close')만 만든다. 사람이 수락해야 적용된다(mem_accept_proposal 이 나눈다).
--    자동 병합에서 이기는 쪽이 사람 확정이면 이긴 쪽은 손대지 않는다(근거 합치기 없음).
--  * 근거가 죽은 항목은 origin 을 가리지 않고 내린다(D6-5 는 삭제 위생이다 — 감쇠·병합의 예외 규칙과 다르다).
--    근거가 하나라도 죽으면 읽기 규칙(mem_item_readable_by)이 이미 가리고 있으니 눈에 보이는 변화는 없다.
--  * 모든 정리는 같은 워크스페이스·같은 채널 안에서만 한다(D6-1). 다른 채널 항목끼리는 함수가 23514 로 거부한다.
--  * LLM 은 「같은 내용인가 / 새 결정이 옛 결정을 대체하나 / 별개인가」 세 값만 정한다. 글은 쓰지 않는다 — 그래서
--    모델 출력을 DB 에 저장하는 경로가 이 파일에 없다(주제 요약·라벨은 PR B 에서 시크릿 검사를 지난다).
--
-- ── 이 파일이 함께 닫는 이월 항목 ───────────────────────────────────────────────────────────────────
--  #3200 L-7  mem_evidence_sel 이 항목 근거 id 를 항목이 읽히는지와 무관하게 채널 독자에게 보이던 것 → 항목 근거는
--             그 항목을 읽을 수 있을 때만.
--  #3200 L-8  mem_event 는 항목이 지워지면 보이지 않았다 → 이벤트가 channel_id(+개인 공간 소유자)를 가져 「id만」
--             남은 잊기·병합 흔적도 채널 독자에게 보인다(본문 없음).
--  #3200 L-9  정의자 함수 허용 목록을 이름이 아니라 **전체 시그니처**로(오버로드가 몰래 끼지 못하게), 워커 전용 함수를
--             공용 잠금 블록의 worker_only 목록에 올림(bootstrap 두 파일; 101 의 블록은 역사 기록으로 둔다).
--  #3209 L-2  잊기 이벤트에 channel_id (열 + detail).
--  #3209 L-3  검색의 채널·종류 조건이 top-N 뒤에 적용되던 것 → 스캔 안으로(mem_search_items 인자).
--  #3209 L-6  mem.op 표지: mem_item/mem_evidence 의 정의자 UPDATE/DELETE 는 함수가 스스로 밝힌 표지 없이는 RESTRICTIVE
--             정책이 거부한다(방어 심층; 새 정의자 함수가 실수로 지우는 길을 막는다).
--  #3209 L-7  forget_after 는 편집에서 복사하지 않는다(결정): 편집은 origin=curated 를 만들고 curated 는 감쇠하지 않는다.
--             잊기는 merged_into 사슬(진 쪽)도 지운다 — 진 쪽 본문이 이긴 쪽과 같기 때문이다.
--  #3210      만료·근거 삭제·잊은 해시의 대기 제안 본문 삭제(mem_cons_purge_proposals).
--  #3209      잊은 항목을 근거로 든 요약(digest)은 stale 로 내려 다시 만든다. 다시 만들 때 잊은 항목의 근거 메시지는
--             입력에서 뺀다(mem_suppress_msg, id 만) — 안 그러면 같은 메시지에서 같은 사실이 되살아난다.
--
-- 재실행 가능한 문장만 쓴다. schema_v0.sql·100~106 은 고치지 않는다.
-- =============================================================================

-- ── mem_item: 기간 닫기 열 + 정리 인덱스 ────────────────────────────────────────────────────────
ALTER TABLE mem_item ADD COLUMN IF NOT EXISTS closed_by_id uuid REFERENCES mem_item(id) ON DELETE SET NULL;
ALTER TABLE mem_item ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE mem_item DROP CONSTRAINT IF EXISTS mem_item_closed_ck;
ALTER TABLE mem_item ADD CONSTRAINT mem_item_closed_ck
  CHECK ((closed_at IS NULL AND closed_by_id IS NULL) OR valid_to IS NOT NULL);
CREATE INDEX IF NOT EXISTS mem_item_closed_by_idx ON mem_item (closed_by_id) WHERE closed_by_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_item_retired_idx ON mem_item (workspace_id, retired_at) WHERE retired_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_item_decay_idx ON mem_item (workspace_id, forget_after)
  WHERE forget_after IS NOT NULL AND retired_at IS NULL;

-- 정의자가 새로 고칠 수 있는 열(정리 잡의 몫). 본문·근거 열은 여전히 못 고친다.
GRANT UPDATE (valid_to, closed_by_id, closed_at, merged_into_id, source_count, reinforce_count,
              last_seen_at, forget_after) ON mem_item TO mem_definer;

-- ── L-6: mem.op 표지 ────────────────────────────────────────────────────────────────────────────
-- 정의자 함수가 항목·근거를 고치거나 지우려면 스스로 표지를 세운다(트랜잭션 로컬). 표지 없는 UPDATE/DELETE 는
-- RESTRICTIVE 정책이 거부하므로, 나중에 만든 정의자 함수가 (버그·주입으로) 항목을 지우는 길이 하나 더 막힌다.
-- mem_op 는 그냥 set_config 다 — 권한이 필요 없고, 표지만으로는 아무것도 할 수 없다(테이블 권한과 current_user 가
-- 그대로 필요하다).
CREATE OR REPLACE FUNCTION mem_op(p_op text)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_catalog.set_config('mem.op', COALESCE(p_op, ''), true)
$$;

DROP POLICY IF EXISTS mem_item_only_definer_upd ON mem_item;
CREATE POLICY mem_item_only_definer_upd ON mem_item AS RESTRICTIVE FOR UPDATE
  USING (current_user = 'mem_definer'
         AND pg_catalog.current_setting('mem.op', true) IN
             ('add_item', 'edit_item', 'forget_item', 'accept_proposal',
              'cons_retire', 'cons_decay', 'cons_apply', 'cons_revert', 'cons_retention'))
  WITH CHECK (current_user = 'mem_definer'
         AND pg_catalog.current_setting('mem.op', true) IN
             ('add_item', 'edit_item', 'forget_item', 'accept_proposal',
              'cons_retire', 'cons_decay', 'cons_apply', 'cons_revert', 'cons_retention'));
DROP POLICY IF EXISTS mem_item_only_definer_del ON mem_item;
CREATE POLICY mem_item_only_definer_del ON mem_item AS RESTRICTIVE FOR DELETE
  USING (current_user = 'mem_definer'
         AND pg_catalog.current_setting('mem.op', true) IN ('forget_item', 'cons_retention'));

-- 근거 행: 항목 근거의 삭제는 표지가 있을 때만(요약 근거의 삭제·재작성은 mem_apply_digest 의 몫이라 표지가 필요 없다).
-- UPDATE 는 아무도 하지 않는다.
DROP POLICY IF EXISTS mem_evidence_no_update ON mem_evidence;
CREATE POLICY mem_evidence_no_update ON mem_evidence AS RESTRICTIVE FOR UPDATE
  USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS mem_evidence_marked_del ON mem_evidence;
CREATE POLICY mem_evidence_marked_del ON mem_evidence AS RESTRICTIVE FOR DELETE
  USING (digest_id IS NOT NULL
         OR pg_catalog.current_setting('mem.op', true) IN ('forget_item', 'cons_retention', 'cons_revert'));

-- ── L-7 (#3200): 항목 근거 행은 그 항목을 읽을 수 있을 때만 ────────────────────────────────────────────
-- mem_item_evidence_ok 는 정의자로 mem_evidence 를 읽는다. mem_definer 에게는 이 정책을 평가하지 않는다(CASE) —
-- 안 그러면 정책 → 함수 → 읽기 → 정책으로 무한 재귀한다(mem_item_sel 과 같은 방식). 정의자의 읽기는 _sel_definer 정책이 연다.
DROP POLICY IF EXISTS mem_evidence_sel ON mem_evidence;
CREATE POLICY mem_evidence_sel ON mem_evidence FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND mem_can_read_channel(channel_id)
    AND CASE WHEN current_user = 'mem_definer' THEN false
             ELSE (item_id IS NULL OR mem_item_evidence_ok(item_id)) END
  );

-- ── mem_event: 채널·소유자 열 + 어휘 + 읽기 정책 (L-8, #3209 L-2) ─────────────────────────────────────
-- 이벤트는 id·종류·개수만 담는다(본문 없음). 그래서 항목이 지워진 뒤에도(잊기·보존 삭제) 그 흔적은 「그 채널을 읽을 수
-- 있는 사람」에게 보인다 — 개인 공간이면 소유자만. 108 이전에 쓰인 이벤트(channel_id 없음)는 옛 규칙(항목을 읽을 수
-- 있을 때만)을 그대로 따른다.
ALTER TABLE mem_event ADD COLUMN IF NOT EXISTS channel_id uuid;
ALTER TABLE mem_event ADD COLUMN IF NOT EXISTS owner_member_id uuid;
ALTER TABLE mem_event DROP CONSTRAINT IF EXISTS mem_event_action_ck;
ALTER TABLE mem_event ADD CONSTRAINT mem_event_action_ck
  CHECK (action IN
    ('created', 'confirmed', 'edited', 'merged', 'superseded', 'retired', 'forgotten',
     'served', 'withheld', 'reset', 'proposed', 'rejected', 'expired',
     'reinforced', 'reverted', 'purged'));
CREATE INDEX IF NOT EXISTS mem_event_channel_idx ON mem_event (workspace_id, channel_id, created_at)
  WHERE channel_id IS NOT NULL;

DROP POLICY IF EXISTS mem_event_sel ON mem_event;
CREATE POLICY mem_event_sel ON mem_event FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND CASE
          WHEN current_user = 'mem_definer' THEN false
          WHEN channel_id IS NOT NULL THEN
            mem_can_read_channel(channel_id)
            AND (owner_member_id IS NULL
                 OR owner_member_id = nullif(current_setting('app.member_id', true), '')::uuid)
          ELSE target_kind = 'item' AND mem_item_evidence_ok(target_id)
        END
  );

-- ── mem_proposal: 정리 제안(op) ─────────────────────────────────────────────────────────────────────
-- 사람이 확정한 항목(curated/confirmed)을 정리 잡이 자동으로 바꾸지 않는다(D4) — 병합·기간 닫기 「제안」만 만든다.
-- 에이전트도 요청자도 없는 제안이라 그 열은 op='add' 에서만 채워진다. 목록·상세 API 는 op='add' 만 돌려준다
-- (정리 제안 카드는 UI 후속; 그때까지는 만들어지고 만료되기만 한다 — 수락 경로는 아래 mem_accept_proposal 에 이미 있다).
ALTER TABLE mem_proposal ADD COLUMN IF NOT EXISTS op text NOT NULL DEFAULT 'add';
ALTER TABLE mem_proposal ADD COLUMN IF NOT EXISTS target_item_id uuid REFERENCES mem_item(id) ON DELETE CASCADE;
ALTER TABLE mem_proposal ADD COLUMN IF NOT EXISTS other_item_id uuid REFERENCES mem_item(id) ON DELETE CASCADE;
ALTER TABLE mem_proposal ALTER COLUMN agent_member_id DROP NOT NULL;
ALTER TABLE mem_proposal ALTER COLUMN requester_member_id DROP NOT NULL;
ALTER TABLE mem_proposal DROP CONSTRAINT IF EXISTS mem_proposal_op_ck;
ALTER TABLE mem_proposal ADD CONSTRAINT mem_proposal_op_ck CHECK (op IN ('add', 'merge', 'close'));
ALTER TABLE mem_proposal DROP CONSTRAINT IF EXISTS mem_proposal_op_shape_ck;
ALTER TABLE mem_proposal ADD CONSTRAINT mem_proposal_op_shape_ck CHECK (
  (op = 'add' AND target_item_id IS NULL AND other_item_id IS NULL
     AND agent_member_id IS NOT NULL AND requester_member_id IS NOT NULL)
  OR (op <> 'add' AND target_item_id IS NOT NULL AND other_item_id IS NOT NULL
     AND target_item_id <> other_item_id
     AND agent_member_id IS NULL AND requester_member_id IS NULL));
CREATE INDEX IF NOT EXISTS mem_proposal_target_idx ON mem_proposal (target_item_id) WHERE target_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_proposal_other_idx ON mem_proposal (other_item_id) WHERE other_item_id IS NOT NULL;

-- 삭제(정리 잡의 만료 정리)는 표지가 있을 때만. 105 는 누구도 못 지우게 (false) 로 막아 두었다.
GRANT DELETE ON mem_proposal TO mem_definer;
DROP POLICY IF EXISTS mem_proposal_del ON mem_proposal;
CREATE POLICY mem_proposal_del ON mem_proposal FOR DELETE TO mem_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS mem_proposal_only_definer_del ON mem_proposal;
CREATE POLICY mem_proposal_only_definer_del ON mem_proposal AS RESTRICTIVE FOR DELETE
  USING (current_user = 'mem_definer'
         AND pg_catalog.current_setting('mem.op', true) = 'cons_purge');

-- ── 새 테이블 ───────────────────────────────────────────────────────────────────────────────────
-- 채널별 정리 진행: 마지막으로 돈 시각 + 리스. 요약 커서(mem_cursor)와 따로 둔다 — 요약이 밀려도 정리는 돌고
-- 정리가 오래 걸려도 요약은 리스를 기다리지 않는다.
CREATE TABLE IF NOT EXISTS mem_cons_state (
  channel_id     uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  last_run_at    timestamptz,
  -- 토큰 상한 등으로 중간에 멈췄으면 이 시각 전에는 다시 시작하지 않는다.
  retry_after    timestamptz,
  lease_token    uuid,
  leased_until   timestamptz,
  CONSTRAINT mem_cons_state_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT mem_cons_state_lease_ck CHECK ((lease_token IS NULL) = (leased_until IS NULL))
);
CREATE INDEX IF NOT EXISTS mem_cons_state_ws_idx ON mem_cons_state (workspace_id);

-- 판정한 쌍의 캐시: 항목 본문은 바뀌지 않으므로(추가만) 같은 쌍을 다시 묻지 않는다. 사람이 되돌린 병합·닫기는
-- 'distinct' 로 덮어써 다시 적용되지 않게 한다. 항목이 지워지면 함께 사라진다.
CREATE TABLE IF NOT EXISTS mem_cons_pair (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  low_id        uuid NOT NULL REFERENCES mem_item(id) ON DELETE CASCADE,
  high_id       uuid NOT NULL REFERENCES mem_item(id) ON DELETE CASCADE,
  verdict       text NOT NULL,
  judged_at     timestamptz NOT NULL DEFAULT now(),
  -- 'deferred'(제안 한도) · 'unparsed'(모델이 세 단어로 답하지 않음)는 이 시각까지만 다시 묻지 않는다(L-2). 확정 판정은 NULL.
  retry_after   timestamptz,
  PRIMARY KEY (low_id, high_id),
  CONSTRAINT mem_cons_pair_order_ck CHECK (low_id < high_id),
  CONSTRAINT mem_cons_pair_verdict_ck CHECK (verdict IN ('duplicate', 'supersedes', 'distinct', 'deferred', 'unparsed')),
  CONSTRAINT mem_cons_pair_retry_ck CHECK ((verdict IN ('deferred', 'unparsed')) = (retry_after IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mem_cons_pair_high_idx ON mem_cons_pair (high_id);

-- 잊은 항목의 근거 메시지(id 만). 요약을 다시 만들 때 입력에서 뺀다. 메시지가 하드 삭제되면 함께 사라진다.
CREATE TABLE IF NOT EXISTS mem_suppress_msg (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL,
  message_id    uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id),
  CONSTRAINT mem_suppress_msg_channel_fk FOREIGN KEY (channel_id, workspace_id)
    REFERENCES channel (id, workspace_id) ON DELETE CASCADE
);

GRANT SELECT, INSERT, UPDATE ON mem_cons_state TO mem_definer;
GRANT SELECT, INSERT, UPDATE ON mem_cons_pair TO mem_definer;
GRANT SELECT, INSERT ON mem_suppress_msg TO mem_definer;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_cons_state', 'mem_cons_pair', 'mem_suppress_msg'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_sel', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR SELECT TO mem_definer
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$f$, t || '_sel', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_ins', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR INSERT TO mem_definer
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$f$, t || '_ins', t);
    IF t <> 'mem_suppress_msg' THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_upd', t);
      EXECUTE format($f$CREATE POLICY %I ON %I FOR UPDATE TO mem_definer
        USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
        WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$f$, t || '_upd', t);
    END IF;
    -- 정의자 말고는 무엇도 못 하게. 나중에 누가 허용 정책을 더해도 RESTRICTIVE 는 AND 라 못 뚫는다.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_only_definer', t);
    EXECUTE format($f$CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL
      USING (current_user = 'mem_definer') WITH CHECK (current_user = 'mem_definer')$f$, t || '_only_definer', t);
  END LOOP;
END $$;

-- 마이그레이션 시점의 잠금(공용 mem-lockdown 블록은 그대로 두고 여기서 같은 상태를 만든다): 런타임 역할 접근 없음.
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mem_cons_state', 'mem_cons_pair', 'mem_suppress_msg'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;


-- ── 정리 잡: 진행·리스 ───────────────────────────────────────────────────────────────────────────
-- 채널 하나의 정리는 하루에 한 번(p_slot_start = 워크스페이스 현지 시각 정리 슬롯의 시작) 돈다: 마지막으로 돈 시각이
-- 슬롯 시작보다 앞서고, 다른 워커가 리스를 쥐고 있지 않고, 토큰 상한으로 멈춘 뒤의 대기(retry_after)가 지났을 때만 true.
CREATE OR REPLACE FUNCTION mem_cons_begin(
  p_channel_id uuid, p_lease_token uuid, p_lease_seconds double precision, p_slot_start timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_secs double precision := LEAST(GREATEST(COALESCE(p_lease_seconds, 300), 1), 3600);
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_begin: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_lease_token IS NULL OR p_slot_start IS NULL THEN
    RAISE EXCEPTION 'mem_cons_begin: lease token and slot start are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.channel c WHERE c.id = p_channel_id AND c.workspace_id = v_ws) THEN
    RETURN false;
  END IF;
  INSERT INTO public.mem_cons_state (channel_id, workspace_id) VALUES (p_channel_id, v_ws)
    ON CONFLICT (channel_id) DO NOTHING;
  UPDATE public.mem_cons_state s
     SET lease_token = p_lease_token,
         leased_until = pg_catalog.now() + pg_catalog.make_interval(secs => v_secs)
   WHERE s.channel_id = p_channel_id AND s.workspace_id = v_ws
     AND (s.leased_until IS NULL OR s.leased_until <= pg_catalog.now() OR s.lease_token = p_lease_token)
     AND (s.last_run_at IS NULL OR s.last_run_at < p_slot_start)
     AND (s.retry_after IS NULL OR s.retry_after <= pg_catalog.now());
  RETURN FOUND;
END
$$;

-- 리스를 놓는다. p_done=true 면 오늘 몫을 마친 것(다음 슬롯까지 쉼), false 면 상한 등으로 중간에 멈춘 것(p_retry_seconds 뒤 재시도).
CREATE OR REPLACE FUNCTION mem_cons_finish(
  p_channel_id uuid, p_lease_token uuid, p_done boolean, p_retry_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_finish: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  UPDATE public.mem_cons_state s
     SET last_run_at = CASE WHEN p_done THEN pg_catalog.now() ELSE s.last_run_at END,
         retry_after = CASE WHEN p_done THEN NULL
                            ELSE pg_catalog.now() + pg_catalog.make_interval(
                                   secs => GREATEST(COALESCE(p_retry_seconds, 1800), 60)) END,
         lease_token = NULL, leased_until = NULL
   WHERE s.channel_id = p_channel_id AND s.workspace_id = v_ws AND s.lease_token = p_lease_token;
  RETURN FOUND;
END
$$;

-- M-6: 모델 호출이 끝날 때마다 리스를 늘린다(긴 판정 뒤에도 다른 워커가 채널을 가로채지 않게).
CREATE OR REPLACE FUNCTION mem_cons_renew(p_channel_id uuid, p_lease_token uuid, p_lease_seconds double precision)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_renew: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  UPDATE public.mem_cons_state s
     SET leased_until = pg_catalog.now() + pg_catalog.make_interval(
           secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 300), 1), 3600))
   WHERE s.channel_id = p_channel_id AND s.workspace_id = v_ws AND s.lease_token = p_lease_token;
  RETURN FOUND;
END
$$;

-- L-2: 모델이 세 단어로 답하지 않은 쌍은 하루 동안 다시 묻지 않는다(매일 같은 쌍에 토큰을 태우지 않는다).
CREATE OR REPLACE FUNCTION mem_cons_defer_pair(p_a uuid, p_b uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.mem_cons_pair (workspace_id, low_id, high_id, verdict, retry_after)
  SELECT nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid,
         LEAST(p_a, p_b), GREATEST(p_a, p_b), 'unparsed', pg_catalog.now() + interval '1 day'
   WHERE EXISTS (SELECT 1 FROM public.mem_item i WHERE i.id = p_a
                    AND i.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
     AND EXISTS (SELECT 1 FROM public.mem_item i WHERE i.id = p_b
                    AND i.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  ON CONFLICT (low_id, high_id) DO UPDATE
    SET verdict = 'unparsed', retry_after = pg_catalog.now() + interval '1 day', judged_at = pg_catalog.now()
    WHERE public.mem_cons_pair.verdict IN ('deferred', 'unparsed')
$$;


-- ── 원인이 사라지면 결과도 되돌린다 (H-2) ─────────────────────────────────────────────────────────────
-- 항목이 내려가거나(근거 소멸·감쇠) 보존 삭제로 지워지기 **직전에** 부른다(지운 뒤에는 FK SET NULL 이 closed_by_id 를 지워 버린다).
--   * 그 항목이 닫았던 결정: 후속 버전(편집)이나 합쳐 들어간 이긴 쪽이 살아 있으면 거기로 옮기고, 없으면 다시 연다.
--   * 그 항목에 합쳐졌던 진 쪽: 후속 버전이 있으면 거기로 옮기고, 없으면 진 쪽 자신의 근거가 살아 있을 때 되살린다.
-- 이벤트 'reverted'(이유·id 만). 호출자가 mem.op 표지를 이미 세웠다.
CREATE OR REPLACE FUNCTION mem_cons_release(p_dying uuid[], p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  r record;
  v_succ uuid;
  v_n integer := 0;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_release: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(pg_catalog.cardinality(p_dying), 0) = 0 THEN
    RETURN 0;
  END IF;
  FOR r IN
    SELECT i.id, i.closed_by_id, i.channel_id, i.owner_member_id FROM public.mem_item i
     WHERE i.workspace_id = v_ws AND i.closed_by_id = ANY (p_dying) AND i.valid_to IS NOT NULL
       AND i.retired_at IS NULL
     ORDER BY i.id FOR UPDATE OF i
  LOOP
    SELECT s.id INTO v_succ FROM public.mem_item s
     WHERE s.workspace_id = v_ws AND s.retired_at IS NULL AND NOT s.stale AND s.id <> ALL (p_dying)
       AND (s.supersedes_id = r.closed_by_id
            OR s.id = (SELECT c.merged_into_id FROM public.mem_item c
                        WHERE c.id = r.closed_by_id AND c.retired_reason = 'merged'))
     ORDER BY s.recorded_at LIMIT 1;
    IF v_succ IS NOT NULL THEN
      UPDATE public.mem_item SET closed_by_id = v_succ WHERE id = r.id;
    ELSE
      UPDATE public.mem_item SET valid_to = NULL, closed_by_id = NULL, closed_at = NULL WHERE id = r.id;
      INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
      VALUES (v_ws, 'item', r.id, 'reverted', r.channel_id, r.owner_member_id,
              pg_catalog.jsonb_build_object('what', 'superseded', 'reason', p_reason,
                                            'closer', r.closed_by_id, 'channel_id', r.channel_id));
      v_n := v_n + 1;
    END IF;
  END LOOP;
  FOR r IN
    SELECT i.id, i.merged_into_id, i.channel_id, i.owner_member_id FROM public.mem_item i
     WHERE i.workspace_id = v_ws AND i.merged_into_id = ANY (p_dying) AND i.retired_reason = 'merged'
     ORDER BY i.id FOR UPDATE OF i
  LOOP
    SELECT s.id INTO v_succ FROM public.mem_item s
     WHERE s.workspace_id = v_ws AND s.retired_at IS NULL AND NOT s.stale AND s.id <> ALL (p_dying)
       AND s.supersedes_id = r.merged_into_id
     ORDER BY s.recorded_at LIMIT 1;
    IF v_succ IS NOT NULL THEN
      UPDATE public.mem_item SET merged_into_id = v_succ WHERE id = r.id;
    ELSIF public.mem_item_live(r.id) THEN
      BEGIN
        UPDATE public.mem_item SET merged_into_id = NULL, retired_at = NULL, retired_reason = NULL WHERE id = r.id;
        INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
        VALUES (v_ws, 'item', r.id, 'reverted', r.channel_id, r.owner_member_id,
                pg_catalog.jsonb_build_object('what', 'merged', 'reason', p_reason,
                                              'winner', r.merged_into_id, 'channel_id', r.channel_id));
        v_n := v_n + 1;
      EXCEPTION WHEN unique_violation THEN
        -- 같은 내용의 살아 있는 항목이 이미 있다 — 되살릴 이유가 없다.
        NULL;
      END;
    END IF;
  END LOOP;
  RETURN v_n;
END
$$;

-- ── 근거가 죽은 항목 내리기 (D6-5) ──────────────────────────────────────────────────────────────────
-- 항목의 근거 메시지가 삭제·수정돼 더는 항목을 받쳐 주지 못하면(mem_item_live=false) retired_reason 을 source_deleted
-- (근거가 지워졌거나 하드 삭제로 줄었을 때) 또는 source_edited(살아 있지만 근거를 읽은 뒤 수정됐을 때)로 내린다.
-- 재추출이 남긴 stale 행도 같이 내린다(그래야 보존 삭제가 걷어 간다). origin 을 가리지 않는다: 삭제 위생이지 자동 변경이 아니다.
-- 스위치(일시정지·제외)와 무관하게 돈다 — 지워진 원문에 기댄 글을 붙들고 있으면 안 된다.
CREATE OR REPLACE FUNCTION mem_cons_retire_dead(p_channel_id uuid, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  r record;
  v_n integer := 0;
  v_reason text;
  v_gone boolean;
  v_ids uuid[] := '{}';
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_retire_dead: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  PERFORM public.mem_op('cons_retire');
  FOR r IN
    SELECT i.id, i.owner_member_id, i.source_count, i.stale
      FROM public.mem_item i
     WHERE i.workspace_id = v_ws AND i.channel_id = p_channel_id AND i.retired_at IS NULL
       AND (i.stale OR NOT public.mem_item_live(i.id))
     ORDER BY i.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)
       FOR UPDATE OF i SKIP LOCKED
  LOOP
    -- stale 는 mem_add_item/편집이 「근거가 죽은 옛 행」에 붙이는 표시라 그 자체로 source_deleted 다.
    v_gone := r.stale
              OR (SELECT pg_catalog.count(*) FROM public.mem_evidence ev
                   WHERE ev.item_id = r.id AND ev.workspace_id = v_ws) < r.source_count
              OR EXISTS (SELECT 1 FROM public.mem_evidence ev
                          WHERE ev.item_id = r.id AND ev.workspace_id = v_ws
                            AND NOT EXISTS (
                              SELECT 1 FROM public.message m
                               WHERE m.id = ev.message_id AND m.workspace_id = ev.workspace_id
                                 AND m.channel_id = ev.channel_id
                                 AND m.deleted_at IS NULL AND m.state <> 'deleted'));
    v_reason := CASE WHEN v_gone THEN 'source_deleted' ELSE 'source_edited' END;
    UPDATE public.mem_item SET retired_at = pg_catalog.now(), retired_reason = v_reason WHERE id = r.id;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
    VALUES (v_ws, 'item', r.id, 'retired', p_channel_id, r.owner_member_id,
            pg_catalog.jsonb_build_object('reason', v_reason));
    v_n := v_n + 1;
    v_ids := v_ids || r.id;
  END LOOP;
  PERFORM public.mem_cons_release(v_ids, 'closer_source_gone');
  RETURN v_n;
END
$$;

-- ── 감쇠 (D4 ③, §6.4) ────────────────────────────────────────────────────────────────────────────
-- forget_after 가 지났는데 재관찰(mem_add_item 이 forget_after 를 늘린다)이 없던 항목 → retired_reason=decayed.
-- origin 이 extracted/synthesized 인 것만: curated/confirmed 는 forget_after 가 있어도(있어서는 안 되지만) 건드리지 않는다.
-- 스위치가 꺼진 채널은 건너뛴다(일시정지는 「데이터 유지」다).
CREATE OR REPLACE FUNCTION mem_cons_decay(p_channel_id uuid, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  r record;
  v_n integer := 0;
  v_ids uuid[] := '{}';
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_decay: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF NOT public.mem_channel_switch(p_channel_id) THEN
    RETURN 0;
  END IF;
  PERFORM public.mem_op('cons_decay');
  FOR r IN
    SELECT i.id, i.owner_member_id, i.forget_after, i.reinforce_count
      FROM public.mem_item i
     WHERE i.workspace_id = v_ws AND i.channel_id = p_channel_id
       AND i.retired_at IS NULL AND NOT i.stale
       AND i.origin IN ('extracted', 'synthesized')
       AND i.forget_after IS NOT NULL AND i.forget_after <= pg_catalog.now()
     ORDER BY i.forget_after, i.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)
       FOR UPDATE OF i SKIP LOCKED
  LOOP
    UPDATE public.mem_item SET retired_at = pg_catalog.now(), retired_reason = 'decayed' WHERE id = r.id;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
    VALUES (v_ws, 'item', r.id, 'retired', p_channel_id, r.owner_member_id,
            pg_catalog.jsonb_build_object(
              'reason', 'decayed', 'forget_after', r.forget_after, 'reinforce_count', r.reinforce_count));
    v_n := v_n + 1;
    v_ids := v_ids || r.id;
  END LOOP;
  PERFORM public.mem_cons_release(v_ids, 'closer_decayed');
  RETURN v_n;
END
$$;

-- ── 잊은 항목의 요약 정합 ───────────────────────────────────────────────────────────────────────────
-- 잊은 항목의 근거 메시지(mem_suppress_msg)를 근거로 든 요약은 모두 다시 만들어져야 한다. 잊기(mem_forget_item)가 즉시 표시하지만,
-- 그 사이에 막 만들어진 요약을 놓치지 않도록 정리 잡이 한 번 더 훑는다. 다시 만든 요약의 근거에는 이 메시지들이 없으므로
-- (mem_suppressed_messages 로 입력에서 뺀다) 이 조건은 고칠 수 있다 — 무한히 stale 이 되지 않는다.
CREATE OR REPLACE FUNCTION mem_cons_reconcile(p_channel_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_n integer;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_reconcile: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  UPDATE public.mem_digest d SET stale = true
   WHERE d.workspace_id = v_ws AND d.channel_id = p_channel_id AND NOT d.stale
     AND EXISTS (SELECT 1 FROM public.mem_evidence e
                   JOIN public.mem_suppress_msg s ON s.message_id = e.message_id
                  WHERE e.digest_id = d.id AND e.workspace_id = v_ws);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- 요약을 다시 만들 때 입력에서 뺄 메시지(잊은 항목의 근거). id 만 오간다.
CREATE OR REPLACE FUNCTION mem_suppressed_messages(p_channel_id uuid, p_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.message_id FROM public.mem_suppress_msg s
   WHERE s.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
     AND s.channel_id = p_channel_id
     AND s.message_id = ANY (p_ids)
$$;

-- ── 후보 쌍 ──────────────────────────────────────────────────────────────────────────────────────
-- 같은 채널·같은 공간(개인 공간이면 같은 소유자)·같은 종류의 살아 있는 항목 쌍 중 아직 판정하지 않은 것.
--   * 중복 후보: 본문 trigram 유사도 >= p_merge_sim (키워드 신호 — 벡터 거리 후보는 #3173 이 이 함수의 UNION 으로 붙는다).
--   * 결정 닫기 후보(결정 두 개, 둘 다 기간이 열려 있음): 같은 subject_key 이거나 유사도 >= p_close_sim.
-- a 가 옛 쪽(valid_from 이 앞선 쪽)이다. 본문을 돌려주는 것은 워커가 판정 프롬프트를 만들기 위해서다(워커 전용).
-- 게이트: 채널이 정리 대상이 아니면(mem_channel_eligible=false) 아무것도 주지 않는다.
CREATE OR REPLACE FUNCTION mem_cons_pairs(
  p_channel_id uuid, p_merge_sim real, p_close_sim real, p_limit integer)
RETURNS TABLE (
  a_id uuid, b_id uuid, kind text, a_body text, b_body text,
  a_valid_from timestamptz, b_valid_from timestamptz, a_origin text, b_origin text,
  sim real, same_subject boolean)
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
    RAISE EXCEPTION 'mem_cons_pairs: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF NOT public.mem_channel_eligible(p_channel_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH live AS (
    SELECT i.id, i.kind, i.body, i.valid_from, i.valid_to, i.origin, i.subject_key, i.space_kind,
           i.owner_member_id, i.recorded_at
      FROM public.mem_item i
     WHERE i.workspace_id = v_ws AND i.channel_id = p_channel_id
       AND i.retired_at IS NULL AND NOT i.stale AND public.mem_item_live(i.id)
     ORDER BY i.recorded_at DESC, i.id
     LIMIT 300
  ), scored AS (
    SELECT a.id AS aid, b.id AS bid, a.kind AS k, a.body AS abody, b.body AS bbody,
           a.valid_from AS afrom, b.valid_from AS bfrom, a.origin AS aorigin, b.origin AS borigin,
           public.similarity(a.body, b.body) AS s,
           (a.subject_key IS NOT NULL AND a.subject_key = b.subject_key) AS subj,
           (a.kind = 'decision' AND a.valid_to IS NULL AND b.valid_to IS NULL) AS closable,
           (a.valid_to IS NOT DISTINCT FROM b.valid_to) AS same_validity
      FROM live a
      JOIN live b
        ON (a.valid_from, a.id) < (b.valid_from, b.id)
       AND a.kind = b.kind AND a.space_kind = b.space_kind
       AND a.owner_member_id IS NOT DISTINCT FROM b.owner_member_id
  )
  SELECT sc.aid, sc.bid, sc.k, sc.abody, sc.bbody, sc.afrom, sc.bfrom, sc.aorigin, sc.borigin, sc.s, sc.subj
    FROM scored sc
   WHERE NOT EXISTS (SELECT 1 FROM public.mem_cons_pair cp
                      WHERE cp.workspace_id = v_ws
                        AND cp.low_id = LEAST(sc.aid, sc.bid) AND cp.high_id = GREATEST(sc.aid, sc.bid)
                        AND (cp.retry_after IS NULL OR cp.retry_after > pg_catalog.now()))
     -- H-1: 같은 내용이라도 유효 기간이 다른 두 항목(닫힌 것과 열린 것)은 중복 후보가 아니다.
     AND ((sc.s >= p_merge_sim AND sc.same_validity)
          OR (sc.closable AND (sc.subj OR sc.s >= p_close_sim)))
   -- 같은 subject_key 를 가진 결정 쌍이 먼저(가장 강한 신호), 그다음 유사도 순.
   ORDER BY sc.subj DESC, sc.s DESC, sc.aid, sc.bid
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END
$$;

-- origin 순위: 사람이 만든 것이 앞선다(병합에서 이기는 쪽을 정한다).
CREATE OR REPLACE FUNCTION mem_origin_rank(p_origin text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_origin WHEN 'curated' THEN 3 WHEN 'confirmed' THEN 2 WHEN 'synthesized' THEN 1 ELSE 0 END
$$;


-- 게스트가 쓴 메시지를 근거로 든 항목은 자동으로 병합·닫기하지 않는다(제안만): 게스트의 발언으로 팀의 결정을 닫는 길을 막는다(M-1).
CREATE OR REPLACE FUNCTION mem_item_guest_authored(p_item_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.mem_evidence e
      JOIN public.message m ON m.id = e.message_id AND m.workspace_id = e.workspace_id
     WHERE e.item_id = p_item_id
       AND e.workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
       AND (EXISTS (SELECT 1 FROM public.workspace_membership wm
                     WHERE wm.workspace_id = m.workspace_id AND wm.member_id = m.author_member_id AND wm.role = 'guest')
            OR EXISTS (SELECT 1 FROM public.membership ms
                        WHERE ms.workspace_id = m.workspace_id AND ms.channel_id = m.channel_id
                          AND ms.member_id = m.author_member_id AND ms.role = 'guest')))
$$;

-- ── 병합·닫기의 알맹이 (내부 함수; 호출자가 잠금과 게이트를 이미 잡았다) ───────────────────────────────
-- 진 쪽(loser)을 이긴 쪽(winner)에 합친다. 자동 경로(p_proposal_id NULL)는 진 쪽이 사람 확정(curated/confirmed)이면
-- 23514 로 거부한다 — 사람이 확정한 것은 사람이 수락한 제안(p_proposal_id)으로만 바뀐다. 이긴 쪽이 사람 확정이면 이긴 쪽은
-- 손대지 않는다(근거를 합치지 않는다): 진 쪽은 자기 근거를 그대로 가진 채 merged 로 내려간다.
-- 되돌릴 값(합쳐 넣은 근거 메시지, 이전 카운트)은 진 쪽의 merged 이벤트 detail 에 남는다. false = 지금은 적용할 수 없다.
CREATE OR REPLACE FUNCTION mem_cons_merge_items(
  p_loser uuid, p_winner uuid, p_actor uuid, p_proposal_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  l public.mem_item%ROWTYPE;
  w public.mem_item%ROWTYPE;
  v_added uuid[] := '{}';
  v_room integer;
  v_forget timestamptz;
  v_reinforce integer;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_merge_items: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO l FROM public.mem_item i WHERE i.id = p_loser AND i.workspace_id = v_ws;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO w FROM public.mem_item i WHERE i.id = p_winner AND i.workspace_id = v_ws;
  IF NOT FOUND THEN RETURN false; END IF;
  -- 가장 좁은 곳(D6-1): 채널·공간·소유자·종류가 같아야 한다. 어기면 조용히 넘기지 않고 멈춘다.
  IF l.id = w.id OR l.channel_id <> w.channel_id OR l.space_kind <> w.space_kind
     OR l.owner_member_id IS DISTINCT FROM w.owner_member_id OR l.kind <> w.kind THEN
    RAISE EXCEPTION 'mem_cons_merge_items: items must be different and share channel, space and kind'
      USING ERRCODE = '23514';
  END IF;
  IF l.origin IN ('curated', 'confirmed') AND p_proposal_id IS NULL THEN
    RAISE EXCEPTION 'mem_cons_merge_items: a curated or confirmed item is never merged automatically'
      USING ERRCODE = '23514';
  END IF;
  IF p_proposal_id IS NULL AND (public.mem_item_guest_authored(l.id) OR public.mem_item_guest_authored(w.id)) THEN
    RAISE EXCEPTION 'mem_cons_merge_items: an item resting on a guest''s message is never merged automatically'
      USING ERRCODE = '23514';
  END IF;
  -- H-1: 열린 결정과 닫힌 결정(또는 기간이 다른 둘)은 같은 내용이어도 하나가 아니다 — 합치면 현재 결정이 사라진다.
  IF l.valid_to IS DISTINCT FROM w.valid_to THEN
    RAISE EXCEPTION 'mem_cons_merge_items: items with different validity are never merged' USING ERRCODE = '23514';
  END IF;
  IF l.retired_at IS NOT NULL OR w.retired_at IS NOT NULL OR l.stale OR w.stale THEN
    RETURN false;
  END IF;

  IF w.origin NOT IN ('curated', 'confirmed') THEN
    -- 근거 합치기: 이긴 쪽에 없는 진 쪽 근거 메시지를 (최대 16개까지) 이긴 쪽 근거로 더한다.
    v_room := GREATEST(16 - (SELECT pg_catalog.count(*)::integer FROM public.mem_evidence we
                              WHERE we.item_id = w.id AND we.workspace_id = v_ws), 0);
    SELECT COALESCE(pg_catalog.array_agg(x.message_id ORDER BY x.message_id), '{}'::uuid[]) INTO v_added
      FROM (SELECT le.message_id FROM public.mem_evidence le
             WHERE le.item_id = l.id AND le.workspace_id = v_ws
               AND NOT EXISTS (SELECT 1 FROM public.mem_evidence we
                                WHERE we.item_id = w.id AND we.message_id = le.message_id)
             ORDER BY le.message_id
             LIMIT v_room) x;
    INSERT INTO public.mem_evidence (workspace_id, item_id, message_id, channel_id, created_at)
    SELECT v_ws, w.id, le.message_id, le.channel_id, le.created_at
      FROM public.mem_evidence le
     WHERE le.item_id = l.id AND le.workspace_id = v_ws AND le.message_id = ANY (v_added);
    v_reinforce := l.reinforce_count + 1;
    v_forget := CASE WHEN w.forget_after IS NULL OR l.forget_after IS NULL THEN NULL
                     ELSE GREATEST(w.forget_after, l.forget_after) END;
    UPDATE public.mem_item
       SET source_count = source_count + pg_catalog.cardinality(v_added),
           reinforce_count = reinforce_count + v_reinforce,
           last_seen_at = GREATEST(last_seen_at, l.last_seen_at),
           forget_after = v_forget
     WHERE id = w.id;
  END IF;

  UPDATE public.mem_item
     SET merged_into_id = w.id, retired_at = pg_catalog.now(), retired_reason = 'merged'
   WHERE id = l.id;
  -- 진 쪽이 닫았던 결정의 닫은 자리는 이긴 쪽이 이어받는다(같은 내용이다).
  UPDATE public.mem_item SET closed_by_id = w.id WHERE closed_by_id = l.id AND workspace_id = v_ws;

  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id,
                                channel_id, owner_member_id, detail)
  VALUES
    (v_ws, 'item', l.id, 'merged', p_actor, l.channel_id, l.owner_member_id,
     pg_catalog.jsonb_build_object(
       'into', w.id, 'added', pg_catalog.to_jsonb(v_added),
       'reinforce_delta', CASE WHEN w.origin IN ('curated', 'confirmed') THEN 0 ELSE v_reinforce END,
       'prev_last_seen_at', w.last_seen_at, 'prev_forget_after', w.forget_after,
       'winner_protected', w.origin IN ('curated', 'confirmed'),
       'proposal_id', p_proposal_id)),
    (v_ws, 'item', w.id, 'merged', p_actor, w.channel_id, w.owner_member_id,
     pg_catalog.jsonb_build_object('absorbed', l.id, 'evidence_added', pg_catalog.cardinality(v_added),
                                   'proposal_id', p_proposal_id));
  RETURN true;
END
$$;

-- 새 결정(newer)이 옛 결정(older)을 대체한다: 옛 결정의 valid_to 를 새 결정의 valid_from 으로 닫는다(Graphiti 의
-- 기존 invalid_at = 새 valid_at). 지우지 않고 supersedes_id 도 쓰지 않는다(잊기가 사슬을 통째로 지우는 것을 피한다).
-- 자동 경로에서 옛 결정이 사람 확정이면 23514(제안만). false = 지금은 적용할 수 없다.
CREATE OR REPLACE FUNCTION mem_cons_close_item(
  p_older uuid, p_newer uuid, p_actor uuid, p_proposal_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  o public.mem_item%ROWTYPE;
  n public.mem_item%ROWTYPE;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_close_item: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO o FROM public.mem_item i WHERE i.id = p_older AND i.workspace_id = v_ws;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO n FROM public.mem_item i WHERE i.id = p_newer AND i.workspace_id = v_ws;
  IF NOT FOUND THEN RETURN false; END IF;
  IF o.id = n.id OR o.channel_id <> n.channel_id OR o.space_kind <> n.space_kind
     OR o.owner_member_id IS DISTINCT FROM n.owner_member_id
     OR o.kind <> 'decision' OR n.kind <> 'decision' THEN
    RAISE EXCEPTION 'mem_cons_close_item: two different decisions of one channel and space are required'
      USING ERRCODE = '23514';
  END IF;
  IF o.origin IN ('curated', 'confirmed') AND p_proposal_id IS NULL THEN
    RAISE EXCEPTION 'mem_cons_close_item: a curated or confirmed decision is never closed automatically'
      USING ERRCODE = '23514';
  END IF;
  IF p_proposal_id IS NULL AND (public.mem_item_guest_authored(o.id) OR public.mem_item_guest_authored(n.id)) THEN
    RAISE EXCEPTION 'mem_cons_close_item: a decision resting on a guest''s message is never closed automatically'
      USING ERRCODE = '23514';
  END IF;
  IF o.retired_at IS NOT NULL OR n.retired_at IS NOT NULL OR o.stale OR n.stale
     OR o.valid_to IS NOT NULL OR NOT (o.valid_from < n.valid_from) THEN
    RETURN false;
  END IF;
  UPDATE public.mem_item
     SET valid_to = n.valid_from, closed_by_id = n.id, closed_at = pg_catalog.now()
   WHERE id = o.id;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id,
                                channel_id, owner_member_id, detail)
  VALUES (v_ws, 'item', o.id, 'superseded', p_actor, o.channel_id, o.owner_member_id,
          pg_catalog.jsonb_build_object(
            'reason', 'contradiction', 'superseded_by', n.id, 'prior_valid_to', NULL::timestamptz,
            'valid_to', n.valid_from, 'proposal_id', p_proposal_id));
  RETURN true;
END
$$;

-- 사람이 확정한 항목의 병합·닫기는 제안으로만 만든다. 본문은 서버가 항목 본문에서 조립한다(모델이 쓴 글이 아니다).
-- NULL = 만들지 않았다(같은 제안이 이미 대기 중이거나, 채널의 대기 정리 제안이 5건이라 잠시 미룬다).
CREATE OR REPLACE FUNCTION mem_cons_propose(p_op text, p_target uuid, p_other uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  t public.mem_item%ROWTYPE;
  o public.mem_item%ROWTYPE;
  v_hash text;
  v_body text;
  v_evidence uuid[];
  v_id uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_propose: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_op NOT IN ('merge', 'close') THEN
    RAISE EXCEPTION 'mem_cons_propose: unknown op' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO t FROM public.mem_item i WHERE i.id = p_target AND i.workspace_id = v_ws;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM public.mem_item i WHERE i.id = p_other AND i.workspace_id = v_ws;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF t.channel_id <> o.channel_id OR t.space_kind <> o.space_kind
     OR t.owner_member_id IS DISTINCT FROM o.owner_member_id OR t.kind <> o.kind OR t.id = o.id THEN
    RAISE EXCEPTION 'mem_cons_propose: items must share channel, space and kind' USING ERRCODE = '23514';
  END IF;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              'cons:' || p_op || ':' || t.id::text || ':' || o.id::text, 'UTF8')), 'hex');
  IF EXISTS (SELECT 1 FROM public.mem_proposal p
              WHERE p.workspace_id = v_ws AND p.channel_id = t.channel_id
                AND p.content_hash = v_hash AND p.status = 'pending')
     OR (SELECT pg_catalog.count(*) FROM public.mem_proposal p
          WHERE p.workspace_id = v_ws AND p.channel_id = t.channel_id
            AND p.status = 'pending' AND p.op <> 'add') >= 5 THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(m.message_id ORDER BY m.ord, m.message_id), '{}'::uuid[]) INTO v_evidence
    FROM (SELECT z.message_id, z.ord
            FROM (SELECT DISTINCT ON (e.message_id) e.message_id,
                         CASE WHEN e.item_id = t.id THEN 0 ELSE 1 END AS ord
                    FROM public.mem_evidence e
                   WHERE e.item_id IN (t.id, o.id) AND e.workspace_id = v_ws
                   ORDER BY e.message_id, CASE WHEN e.item_id = t.id THEN 0 ELSE 1 END) z
           ORDER BY z.ord, z.message_id
           LIMIT 8) m;
  IF pg_catalog.cardinality(v_evidence) = 0 THEN RETURN NULL; END IF;
  v_body := CASE p_op
    WHEN 'merge' THEN '중복 정리 제안 — 남길 기억: ' || pg_catalog.left(o.body, 250)
                      || ' / 합칠 기억: ' || pg_catalog.left(t.body, 250)
    ELSE '결정 변경 제안 — 새 결정: ' || pg_catalog.left(o.body, 250)
         || ' / 이전 결정: ' || pg_catalog.left(t.body, 250) END;
  IF public.mem_looks_like_secret(v_body) THEN RETURN NULL; END IF;
  INSERT INTO public.mem_proposal
    (workspace_id, channel_id, kind, body, evidence_message_ids, content_hash, op, target_item_id, other_item_id)
  VALUES (v_ws, t.channel_id, t.kind, v_body, v_evidence, v_hash, p_op, t.id, o.id)
  ON CONFLICT (workspace_id, channel_id, content_hash) WHERE status = 'pending' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
    VALUES (v_ws, 'proposal', v_id, 'proposed', t.channel_id, t.owner_member_id,
            pg_catalog.jsonb_build_object('op', p_op, 'target', t.id, 'other', o.id));
  END IF;
  RETURN v_id;
END
$$;

-- 판정 캐시(다시 묻지 않는다). 사람이 되돌린 것은 distinct 로 덮어써 다시 적용되지 않게 한다.
CREATE OR REPLACE FUNCTION mem_cons_note_pair(p_a uuid, p_b uuid, p_verdict text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.mem_cons_pair (workspace_id, low_id, high_id, verdict)
  VALUES (nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid,
          LEAST(p_a, p_b), GREATEST(p_a, p_b), p_verdict)
  ON CONFLICT (low_id, high_id) DO UPDATE
    SET verdict = EXCLUDED.verdict, judged_at = pg_catalog.now(), retry_after = NULL
$$;

CREATE OR REPLACE FUNCTION mem_cons_defer(p_a uuid, p_b uuid, p_verdict text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.mem_cons_pair (workspace_id, low_id, high_id, verdict, retry_after)
  VALUES (nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid,
          LEAST(p_a, p_b), GREATEST(p_a, p_b), p_verdict, pg_catalog.now() + interval '1 day')
  ON CONFLICT (low_id, high_id) DO UPDATE
    SET verdict = EXCLUDED.verdict, retry_after = EXCLUDED.retry_after, judged_at = pg_catalog.now()
    WHERE public.mem_cons_pair.verdict IN ('deferred', 'unparsed')
$$;

-- ── 판정 하나의 적용 (워커 → DB) ────────────────────────────────────────────────────────────────────
-- 워커는 후보 쌍(mem_cons_pairs)에 대한 LLM 의 세 값 중 하나만 넘긴다. 모든 검증은 여기서 다시 한다:
--   duplicate  같은 내용 → 이긴 쪽(사람 확정 > 근거 많음 > 먼저 기록)에 진 쪽을 합친다. 진 쪽이 사람 확정이면 제안만.
--   supersedes 뒤(valid_from 이 늦은) 결정이 앞 결정을 대체 → 앞 결정을 닫는다. 앞 결정이 사람 확정이면 제안만.
--   distinct   별개 → 캐시만.
-- 돌려주는 값: merged · closed · proposed_merge · proposed_close · distinct · skipped(그 사이 상태가 바뀜) · deferred(제안 한도).
-- 다른 채널·공간·종류의 쌍은 23514, 정리 대상이 아닌 채널은 55000.
CREATE OR REPLACE FUNCTION mem_cons_apply(p_a uuid, p_b uuid, p_verdict text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  x public.mem_item%ROWTYPE;
  y public.mem_item%ROWTYPE;
  older public.mem_item%ROWTYPE;
  newer public.mem_item%ROWTYPE;
  w public.mem_item%ROWTYPE;
  l public.mem_item%ROWTYPE;
  v_msgs uuid[];
  v_prop uuid;
  v_guest boolean;
BEGIN
  PERFORM public.mem_op('cons_apply');
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_apply: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN
    RAISE EXCEPTION 'mem_cons_apply: two different items are required' USING ERRCODE = '22023';
  END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('duplicate', 'supersedes', 'distinct') THEN
    RAISE EXCEPTION 'mem_cons_apply: unknown verdict' USING ERRCODE = '22023';
  END IF;
  -- 두 행을 id 순으로 잠근다(같은 쌍을 두 워커가 반대 순서로 잡아 교착하지 않게).
  PERFORM 1 FROM public.mem_item i WHERE i.id IN (p_a, p_b) AND i.workspace_id = v_ws ORDER BY i.id FOR UPDATE;
  SELECT * INTO x FROM public.mem_item i WHERE i.id = p_a AND i.workspace_id = v_ws;
  IF NOT FOUND THEN RETURN 'skipped'; END IF;
  SELECT * INTO y FROM public.mem_item i WHERE i.id = p_b AND i.workspace_id = v_ws;
  IF NOT FOUND THEN RETURN 'skipped'; END IF;
  -- 가장 좁은 곳(D6-1): 채널·공간·소유자·종류가 다르면 정리하지 않는다.
  IF x.channel_id <> y.channel_id OR x.space_kind <> y.space_kind
     OR x.owner_member_id IS DISTINCT FROM y.owner_member_id OR x.kind <> y.kind THEN
    RAISE EXCEPTION 'mem_cons_apply: items must share channel, space and kind' USING ERRCODE = '23514';
  END IF;
  -- 락 순서: 항목 행 → 근거 메시지 행(FOR KEY SHARE, id 순) → 채널 advisory 공유(mem_edit_item 과 같다).
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT ev.message_id), '{}'::uuid[]) INTO v_msgs
    FROM public.mem_evidence ev WHERE ev.item_id IN (x.id, y.id) AND ev.workspace_id = v_ws;
  PERFORM 1 FROM public.message m
   WHERE m.id = ANY (v_msgs) AND m.workspace_id = v_ws ORDER BY m.id FOR KEY SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_digest:' || x.channel_id::text, 0));
  IF NOT public.mem_channel_eligible(x.channel_id) THEN
    RAISE EXCEPTION 'mem_cons_apply: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;
  IF x.retired_at IS NOT NULL OR y.retired_at IS NOT NULL OR x.stale OR y.stale
     OR NOT public.mem_item_live(x.id) OR NOT public.mem_item_live(y.id) THEN
    RETURN 'skipped';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mem_cons_pair cp
              WHERE cp.workspace_id = v_ws AND cp.low_id = LEAST(x.id, y.id) AND cp.high_id = GREATEST(x.id, y.id)
                AND (cp.retry_after IS NULL OR cp.retry_after > pg_catalog.now())) THEN
    RETURN 'skipped';
  END IF;
  v_guest := public.mem_item_guest_authored(x.id) OR public.mem_item_guest_authored(y.id);

  IF p_verdict = 'distinct' THEN
    PERFORM public.mem_cons_note_pair(x.id, y.id, 'distinct');
    RETURN 'distinct';
  END IF;

  IF (x.valid_from, x.id) <= (y.valid_from, y.id) THEN
    older := x; newer := y;
  ELSE
    older := y; newer := x;
  END IF;

  IF p_verdict = 'duplicate' THEN
    -- H-1: an open decision and a closed one (or two different validity periods) are not duplicates, whatever the model says.
    IF x.valid_to IS DISTINCT FROM y.valid_to THEN
      PERFORM public.mem_cons_note_pair(x.id, y.id, 'distinct');
      RETURN 'distinct';
    END IF;
    IF public.mem_origin_rank(x.origin) > public.mem_origin_rank(y.origin)
       OR (public.mem_origin_rank(x.origin) = public.mem_origin_rank(y.origin)
           AND (x.source_count > y.source_count
                OR (x.source_count = y.source_count AND (x.recorded_at, x.id) <= (y.recorded_at, y.id)))) THEN
      w := x; l := y;
    ELSE
      w := y; l := x;
    END IF;
    IF l.origin IN ('curated', 'confirmed') OR v_guest THEN
      v_prop := public.mem_cons_propose('merge', l.id, w.id);
      IF v_prop IS NULL THEN
        PERFORM public.mem_cons_defer(x.id, y.id, 'deferred');
        RETURN 'deferred';
      END IF;
      PERFORM public.mem_cons_note_pair(x.id, y.id, 'duplicate');
      RETURN 'proposed_merge';
    END IF;
    IF NOT public.mem_cons_merge_items(l.id, w.id, NULL, NULL) THEN
      RETURN 'skipped';
    END IF;
    PERFORM public.mem_cons_note_pair(x.id, y.id, 'duplicate');
    RETURN 'merged';
  END IF;

  -- supersedes: 결정끼리만, 옛 쪽의 기간이 열려 있고 새 쪽이 나중일 때.
  IF x.kind <> 'decision' OR older.valid_to IS NOT NULL OR NOT (older.valid_from < newer.valid_from) THEN
    RETURN 'skipped';
  END IF;
  IF older.origin IN ('curated', 'confirmed') OR v_guest THEN
    v_prop := public.mem_cons_propose('close', older.id, newer.id);
    IF v_prop IS NULL THEN
      PERFORM public.mem_cons_defer(x.id, y.id, 'deferred');
      RETURN 'deferred';
    END IF;
    PERFORM public.mem_cons_note_pair(x.id, y.id, 'supersedes');
    RETURN 'proposed_close';
  END IF;
  IF NOT public.mem_cons_close_item(older.id, newer.id, NULL, NULL) THEN
    RETURN 'skipped';
  END IF;
  PERFORM public.mem_cons_note_pair(x.id, y.id, 'supersedes');
  RETURN 'closed';
END
$$;

-- 정리 제안 수락(내부; mem_accept_proposal 이 op<>'add' 에서 부른다). 수락하는 사람이 두 항목을 읽을 수 있어야 한다.
CREATE OR REPLACE FUNCTION mem_cons_accept(p_proposal_id uuid, p_viewer uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  p public.mem_proposal%ROWTYPE;
  v_ok boolean;
BEGIN
  SELECT * INTO p FROM public.mem_proposal q WHERE q.id = p_proposal_id AND q.workspace_id = v_ws;
  IF NOT FOUND OR p.op = 'add' THEN
    RAISE EXCEPTION 'mem_accept_proposal: not allowed' USING ERRCODE = '42501';
  END IF;
  -- 락 순서는 mem_cons_apply 와 같다: 항목 행(id 순) → 근거 메시지 행(FOR KEY SHARE, id 순) → 채널 advisory 공유.
  PERFORM 1 FROM public.mem_item i WHERE i.id IN (p.target_item_id, p.other_item_id) AND i.workspace_id = v_ws
   ORDER BY i.id FOR UPDATE;
  PERFORM 1 FROM public.message m
   WHERE m.workspace_id = v_ws
     AND m.id IN (SELECT ev.message_id FROM public.mem_evidence ev
                   WHERE ev.item_id IN (p.target_item_id, p.other_item_id) AND ev.workspace_id = v_ws)
   ORDER BY m.id FOR KEY SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('mem_digest:' || p.channel_id::text, 0));
  -- 수락은 활성 사람(게스트 아님)이 읽을 수 있는 채널에서만(mem_accept_proposal 이 열릴 때 라우트의 검사와 겹치는 두 번째 벽).
  IF NOT EXISTS (SELECT 1 FROM public.member h
                  WHERE h.id = p_viewer AND h.workspace_id = v_ws AND h.kind = 'human'
                    AND h.status = 'active' AND h.deleted_at IS NULL)
     OR NOT public.mem_member_can_read(p.channel_id, p_viewer)
     OR EXISTS (SELECT 1 FROM public.workspace_membership wm
                 WHERE wm.workspace_id = v_ws AND wm.member_id = p_viewer AND wm.role = 'guest')
     OR EXISTS (SELECT 1 FROM public.membership gm
                 WHERE gm.workspace_id = v_ws AND gm.channel_id = p.channel_id AND gm.member_id = p_viewer
                   AND gm.left_at IS NULL AND gm.role = 'guest') THEN
    RAISE EXCEPTION 'mem_accept_proposal: not allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT public.mem_channel_eligible(p.channel_id) THEN
    RAISE EXCEPTION 'mem_accept_proposal: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;
  -- 수락하는 사람은 두 항목을 지금 읽을 수 있어야 한다(제안을 믿지 않고 다시 확인한다).
  IF NOT (public.mem_item_readable_by(p.target_item_id, p_viewer)
          AND public.mem_item_readable_by(p.other_item_id, p_viewer)) THEN
    RAISE EXCEPTION 'mem_accept_proposal: an item is gone or not readable by the accepter' USING ERRCODE = '23503';
  END IF;
  IF p.op = 'merge' THEN
    v_ok := public.mem_cons_merge_items(p.target_item_id, p.other_item_id, p_viewer, p.id);
  ELSE
    v_ok := public.mem_cons_close_item(p.target_item_id, p.other_item_id, p_viewer, p.id);
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'mem_accept_proposal: the proposal no longer applies' USING ERRCODE = '55000';
  END IF;
  PERFORM public.mem_cons_note_pair(p.target_item_id, p.other_item_id,
                                    CASE WHEN p.op = 'merge' THEN 'duplicate' ELSE 'supersedes' END);
  UPDATE public.mem_proposal
     SET status = 'accepted', body = NULL, subject_key = NULL, evidence_message_ids = '{}',
         decided_by = p_viewer, decided_at = pg_catalog.now(), item_id = p.other_item_id
   WHERE id = p.id;
  RETURN p.other_item_id;
END
$$;

-- ── 보존 삭제 (D10, §6.3·§6.5) ─────────────────────────────────────────────────────────────────────
--   * retired 항목은 retired_at 이 p_retired_days 일 지나면 영구 삭제(근거 링크 포함). 이벤트에는 id·이유만 남는다.
--   * 창 요약은 p_window_days 일이 지나면, 그 구간을 덮는 살아 있는(stale 아닌) 일간·주간 롤업이 있을 때만 정리한다
--     (롤업이 없으면 원문 대신 남길 것이 없다). 스레드 요약은 롤업에 들어가지 않아 손대지 않는다.
-- 스위치가 꺼진 채널은 건너뛴다(일시정지는 「데이터 유지」다).
CREATE OR REPLACE FUNCTION mem_cons_retention(
  p_channel_id uuid, p_retired_days integer, p_window_days integer, p_limit integer)
RETURNS TABLE (items_deleted integer, windows_pruned integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  r record;
  v_items integer := 0;
  v_windows integer := 0;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_retention: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF p_retired_days IS NULL OR p_retired_days < 1 OR p_window_days IS NULL OR p_window_days < 1 THEN
    RAISE EXCEPTION 'mem_cons_retention: retention days must be at least 1' USING ERRCODE = '22023';
  END IF;
  IF NOT public.mem_channel_switch(p_channel_id) THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;
  PERFORM public.mem_op('cons_retention');
  FOR r IN
    SELECT i.id, i.owner_member_id, i.retired_reason
      FROM public.mem_item i
     WHERE i.workspace_id = v_ws AND i.channel_id = p_channel_id AND i.retired_at IS NOT NULL
       -- M-4: 사람이 확정·고친 항목(curated/confirmed)은 4배 오래 둔다(사람의 결정이 기계 기한으로 사라지지 않게).
       AND i.retired_at < pg_catalog.now() - pg_catalog.make_interval(
             days => p_retired_days * CASE WHEN i.origin IN ('curated', 'confirmed') THEN 4 ELSE 1 END)
     ORDER BY i.retired_at, i.id
     LIMIT v_lim
       FOR UPDATE OF i SKIP LOCKED
  LOOP
    -- H-2: 이 항목이 닫았거나 합쳐 들인 것들을 지우기 전에 놓아 준다(지운 뒤에는 closed_by_id 가 조용히 NULL 이 된다).
    PERFORM public.mem_cons_release(ARRAY[r.id], 'closer_purged');
    DELETE FROM public.mem_evidence ev WHERE ev.item_id = r.id AND ev.workspace_id = v_ws;
    DELETE FROM public.mem_item i WHERE i.id = r.id AND i.workspace_id = v_ws;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
    VALUES (v_ws, 'item', r.id, 'purged', p_channel_id, r.owner_member_id,
            pg_catalog.jsonb_build_object('reason', 'retention', 'retired_reason', r.retired_reason));
    v_items := v_items + 1;
  END LOOP;
  FOR r IN
    SELECT d.id, d.from_seq, d.to_seq
      FROM public.mem_digest d
     WHERE d.workspace_id = v_ws AND d.channel_id = p_channel_id AND d.level = 'window'
       AND d.thread_root_id IS NULL AND NOT d.stale
       AND d.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_window_days)
       AND EXISTS (SELECT 1 FROM public.mem_digest u
                    WHERE u.workspace_id = v_ws AND u.channel_id = p_channel_id AND u.thread_root_id IS NULL
                      AND u.level IN ('day', 'week') AND NOT u.stale
                      AND u.from_seq <= d.from_seq AND u.to_seq >= d.to_seq)
     ORDER BY d.created_at, d.id
     LIMIT v_lim
  LOOP
    DELETE FROM public.mem_digest d WHERE d.id = r.id AND d.workspace_id = v_ws;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, detail)
    VALUES (v_ws, 'digest', r.id, 'purged', p_channel_id,
            pg_catalog.jsonb_build_object('reason', 'window_retention', 'from_seq', r.from_seq, 'to_seq', r.to_seq));
    v_windows := v_windows + 1;
  END LOOP;
  RETURN QUERY SELECT v_items, v_windows;
END
$$;

-- ── 대기 제안 정리 (#3210 이월) ────────────────────────────────────────────────────────────────────
-- 대기 제안의 본문은 메시지를 옮긴 글이다. 만료됐거나, 근거 메시지가 삭제·수정됐거나, 잊은 내용(mem_suppress 의 해시)이면
-- 행째 지운다(이벤트에는 id·이유만). 스위치와 무관하게 돈다 — 지워야 할 글을 붙들고 있지 않는다.
CREATE OR REPLACE FUNCTION mem_cons_purge_proposals(p_channel_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  r record;
  v_n integer := 0;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_purge_proposals: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  PERFORM public.mem_op('cons_purge');
  FOR r IN
    SELECT p.id, p.op,
           CASE WHEN p.expires_at <= pg_catalog.now() THEN 'expired'
                WHEN EXISTS (SELECT 1 FROM public.mem_suppress s
                              WHERE s.workspace_id = p.workspace_id AND s.channel_id = p.channel_id
                                AND s.content_hash = p.content_hash) THEN 'suppressed'
                ELSE 'evidence_gone' END AS reason
      FROM public.mem_proposal p
     WHERE p.workspace_id = v_ws AND p.channel_id = p_channel_id AND p.status = 'pending'
       AND (p.expires_at <= pg_catalog.now()
            OR EXISTS (SELECT 1 FROM public.mem_suppress s
                        WHERE s.workspace_id = p.workspace_id AND s.channel_id = p.channel_id
                          AND s.content_hash = p.content_hash)
            OR NOT public.mem_proposal_evidence_ok(p.id))
     ORDER BY p.id
     LIMIT 500
       FOR UPDATE OF p SKIP LOCKED
  LOOP
    DELETE FROM public.mem_proposal p WHERE p.id = r.id AND p.workspace_id = v_ws;
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, detail)
    VALUES (v_ws, 'proposal', r.id, CASE WHEN r.reason = 'expired' THEN 'expired' ELSE 'purged' END,
            p_channel_id, pg_catalog.jsonb_build_object('reason', r.reason, 'op', r.op));
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$$;

-- ── 되돌리기 ──────────────────────────────────────────────────────────────────────────────────────
-- 정리 이벤트 한 건을 되돌린다: 병합('merged' 진 쪽 이벤트), 기간 닫기('superseded' + reason=contradiction),
-- 감쇠('retired' + reason=decayed). 이벤트에 남은 값으로 상태를 복원하고 'reverted' 를 남긴다. 되돌린 쌍은 distinct 로
-- 캐시해 정리 잡이 다시 적용하지 않는다(사람의 결정을 이긴다). 잊기·보존 삭제는 되돌릴 수 없다(id 만 남는다).
-- 알맹이는 mem_cons_revert_core(내부). 호출자가 둘이다: 워커 전용 mem_cons_revert(행위자 없음)와 API 가 부르는
-- mem_revert_consolidation(사람이 읽을 수 있는 항목의 되돌리기; 권한·스위치·잊은 내용 검사는 그쪽이 한다).
CREATE OR REPLACE FUNCTION mem_cons_revert_core(p_event_id uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  e public.mem_event%ROWTYPE;
  l public.mem_item%ROWTYPE;
  w public.mem_item%ROWTYPE;
  v_added uuid[];
  v_kind text;
BEGIN
  PERFORM public.mem_op('cons_revert');
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'mem_cons_revert: app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM public.mem_event x WHERE x.id = p_event_id AND x.workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_cons_revert: event not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mem_event r
              WHERE r.workspace_id = v_ws AND r.action = 'reverted' AND r.detail ->> 'of' = p_event_id::text) THEN
    RAISE EXCEPTION 'mem_cons_revert: already reverted' USING ERRCODE = '55000';
  END IF;
  IF e.target_kind <> 'item' THEN
    RAISE EXCEPTION 'mem_cons_revert: only item events can be reverted' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO l FROM public.mem_item i WHERE i.id = e.target_id AND i.workspace_id = v_ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mem_cons_revert: the item is gone' USING ERRCODE = '55000';
  END IF;

  IF e.action = 'merged' AND e.detail ? 'into' THEN
    v_kind := 'merged';
    IF l.retired_reason IS DISTINCT FROM 'merged' OR l.merged_into_id IS DISTINCT FROM (e.detail ->> 'into')::uuid THEN
      RAISE EXCEPTION 'mem_cons_revert: the merge no longer stands' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO w FROM public.mem_item i WHERE i.id = l.merged_into_id AND i.workspace_id = v_ws FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mem_cons_revert: the winner is gone' USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(a::uuid), '{}'::uuid[]) INTO v_added
      FROM pg_catalog.jsonb_array_elements_text(e.detail -> 'added') AS a;
    IF NOT COALESCE((e.detail ->> 'winner_protected')::boolean, false) THEN
      DELETE FROM public.mem_evidence ev
       WHERE ev.item_id = w.id AND ev.workspace_id = v_ws AND ev.message_id = ANY (v_added);
      UPDATE public.mem_item
         SET source_count = GREATEST(source_count - pg_catalog.cardinality(v_added), 1),
             reinforce_count = GREATEST(reinforce_count - COALESCE((e.detail ->> 'reinforce_delta')::integer, 0), 0),
             last_seen_at = COALESCE((e.detail ->> 'prev_last_seen_at')::timestamptz, last_seen_at),
             forget_after = (e.detail ->> 'prev_forget_after')::timestamptz
       WHERE id = w.id;
    END IF;
    BEGIN
      UPDATE public.mem_item SET merged_into_id = NULL, retired_at = NULL, retired_reason = NULL WHERE id = l.id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'mem_cons_revert: an identical live item exists' USING ERRCODE = '55000';
    END;
    PERFORM public.mem_cons_note_pair(l.id, w.id, 'distinct');
  ELSIF e.action = 'superseded' AND e.detail ->> 'reason' = 'contradiction' THEN
    v_kind := 'superseded';
    IF l.valid_to IS NULL OR l.retired_at IS NOT NULL
       OR (l.closed_by_id IS NOT NULL AND l.closed_by_id IS DISTINCT FROM (e.detail ->> 'superseded_by')::uuid) THEN
      RAISE EXCEPTION 'mem_cons_revert: the closing no longer stands' USING ERRCODE = '55000';
    END IF;
    UPDATE public.mem_item SET valid_to = NULL, closed_by_id = NULL, closed_at = NULL WHERE id = l.id;
    IF (e.detail ->> 'superseded_by') IS NOT NULL THEN
      PERFORM public.mem_cons_note_pair(l.id, (e.detail ->> 'superseded_by')::uuid, 'distinct');
    END IF;
  ELSIF e.action = 'retired' AND e.detail ->> 'reason' = 'decayed' THEN
    v_kind := 'decayed';
    IF l.retired_reason IS DISTINCT FROM 'decayed' THEN
      RAISE EXCEPTION 'mem_cons_revert: the decay no longer stands' USING ERRCODE = '55000';
    END IF;
    BEGIN
      -- 되살린 항목은 새로 14일을 얻는다(안 그러면 곧바로 다시 감쇠한다).
      UPDATE public.mem_item
         SET retired_at = NULL, retired_reason = NULL, forget_after = pg_catalog.now() + interval '14 days'
       WHERE id = l.id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'mem_cons_revert: an identical live item exists' USING ERRCODE = '55000';
    END;
  ELSE
    RAISE EXCEPTION 'mem_cons_revert: this event cannot be reverted' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id,
                                channel_id, owner_member_id, detail)
  VALUES (v_ws, 'item', l.id, 'reverted', p_actor, l.channel_id, l.owner_member_id,
          pg_catalog.jsonb_build_object('of', p_event_id, 'what', v_kind, 'channel_id', l.channel_id));
  RETURN v_kind;
END
$$;

CREATE OR REPLACE FUNCTION mem_cons_revert(p_event_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.mem_cons_revert_core(p_event_id, NULL)
$$;

-- M-2: 사람의 되돌리기(API). mem_edit_item / mem_forget_item 과 같은 신뢰 경계: PUBLIC EXECUTE + 함수 안의 session_user 가드,
-- 행위자는 app.member_id 에서만(활성 사람, 게스트 아님), 읽을 수 없는 이벤트는 없는 것과 같은 P0002(→ 404).
--   * 되돌릴 수 있는 것: 병합('merged' 진 쪽 이벤트), 기간 닫기('superseded'+contradiction), 감쇠('retired'+decayed).
--   * 항목(병합이면 진 쪽과 이긴 쪽 둘 다)을 행위자가 읽을 수 있어야 하고, 채널이 지금 요약·정리 대상이어야 한다(55000).
--   * 잊은 내용을 되살리지 않는다: 항목의 (채널, 해시)가 mem_suppress 에 있거나 근거가 죽었으면(mem_item_live=false) 55000.
CREATE OR REPLACE FUNCTION mem_revert_consolidation(p_event_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ws uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_actor uuid := nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid;
  e public.mem_event%ROWTYPE;
  i public.mem_item%ROWTYPE;
  v_other uuid;
BEGIN
  PERFORM public.mem_op('cons_revert');
  IF session_user::text <> 'momo_app'
     AND NOT COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user::text), false) THEN
    RAISE EXCEPTION 'mem_revert_consolidation: only the API role may revert' USING ERRCODE = '42501';
  END IF;
  IF v_ws IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'mem_revert_consolidation: no acting member' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.member m
                  WHERE m.id = v_actor AND m.workspace_id = v_ws AND m.kind = 'human'
                    AND m.status = 'active' AND m.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'mem_revert_consolidation: the acting member must be an active human' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM public.mem_event x WHERE x.id = p_event_id AND x.workspace_id = v_ws;
  IF NOT FOUND OR e.target_kind <> 'item' THEN
    RAISE EXCEPTION 'mem_revert_consolidation: event not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO i FROM public.mem_item x WHERE x.id = e.target_id AND x.workspace_id = v_ws;
  IF NOT FOUND OR NOT public.mem_item_readable_by(i.id, v_actor)
     OR NOT (e.action = 'merged' OR e.action = 'superseded' OR e.action = 'retired') THEN
    RAISE EXCEPTION 'mem_revert_consolidation: event not found' USING ERRCODE = 'P0002';
  END IF;
  -- 병합이면 이긴 쪽도 읽을 수 있어야 한다.
  IF e.action = 'merged' THEN
    v_other := (e.detail ->> 'into')::uuid;
    IF v_other IS NULL OR NOT public.mem_item_readable_by(v_other, v_actor) THEN
      RAISE EXCEPTION 'mem_revert_consolidation: event not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  -- 게스트는 읽을 수는 있어도 되돌리지 못한다(편집·잊기와 같은 결정, D9).
  IF EXISTS (SELECT 1 FROM public.membership ms
              WHERE ms.workspace_id = v_ws AND ms.member_id = v_actor AND ms.left_at IS NULL AND ms.role = 'guest'
                AND (ms.channel_id = i.channel_id
                     OR ms.channel_id IN (SELECT ev.channel_id FROM public.mem_evidence ev
                                           WHERE ev.item_id = i.id AND ev.workspace_id = v_ws)))
     OR EXISTS (SELECT 1 FROM public.workspace_membership wm
                 WHERE wm.workspace_id = v_ws AND wm.member_id = v_actor AND wm.role = 'guest') THEN
    RAISE EXCEPTION 'mem_revert_consolidation: guests may not change memory items' USING ERRCODE = '42501';
  END IF;
  IF NOT public.mem_channel_eligible(i.channel_id) THEN
    RAISE EXCEPTION 'mem_revert_consolidation: memory is disabled, paused, excluded or not allowed for this channel'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mem_suppress s
              WHERE s.workspace_id = v_ws AND s.channel_id = i.channel_id AND s.content_hash = i.content_hash)
     OR NOT public.mem_item_live(i.id) THEN
    RAISE EXCEPTION 'mem_revert_consolidation: forgotten or unsupported content is not brought back' USING ERRCODE = '55000';
  END IF;
  RETURN public.mem_cons_revert_core(p_event_id, v_actor);
END
$$;


-- ── mem_apply_digest (102 의 재정의): 창이 정리된 stale 롤업은 메시지에서 다시 만든다 (H-3) ─────────────────
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
            AND d.to_seq = p_to_seq AND d.thread_root_id IS NOT DISTINCT FROM p_thread_root_id AND d.stale) THEN
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


-- ── 104·106 함수의 재정의 (mem.op 표지 · 재관찰 · 이벤트 채널 · 정리 제안 수락) ─────────────────────────
-- 본문은 각 원본 그대로이고 바뀐 곳에 「#3172」 주석이 있다. CREATE OR REPLACE 라 소유자·EXECUTE 권한은 그대로다.

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
  PERFORM public.mem_op('edit_item');
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
  -- H-2: 옛 버전이 닫았거나 합쳐 들인 것들은 새 버전이 이어받는다(편집은 같은 결정의 고침이다).
  UPDATE public.mem_item SET merged_into_id = v_id WHERE merged_into_id = o.id AND workspace_id = v_ws;
  UPDATE public.mem_item SET closed_by_id = v_id WHERE closed_by_id = o.id AND workspace_id = v_ws;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id,
                                channel_id, owner_member_id, detail)
  VALUES
    (v_ws, 'item', v_id, 'edited', v_actor, o.channel_id, o.owner_member_id,
     pg_catalog.jsonb_build_object('supersedes', o.id, 'kind', v_kind, 'source_count', v_n)),
    (v_ws, 'item', o.id, 'superseded', v_actor, o.channel_id, o.owner_member_id,
     pg_catalog.jsonb_build_object('superseded_by', v_id, 'reason', 'edited'));
  RETURN v_id;
END
$$;


-- ── 잊기 (106 의 재정의) ─────────────────────────────────────────────────────────────────────────────
-- 106 과 같은 계약(즉시 영구 삭제, 권한·오류 코드 그대로)에 이 파일의 것을 더했다.
--   * 사슬: supersedes 사슬(옛 버전) 외에 **merged_into 사슬**(이 항목들에 합쳐진 진 쪽, 재귀)도 지운다 — 진 쪽 본문은 이긴 쪽과
--     같은 내용이다(#3209 L-7). 진 쪽만 잊는 것은 그대로 가능하다(이긴 쪽은 남는다).
--   * 이 항목의 기간 닫기로 닫혀 있던 옛 결정은 다시 연다(닫은 항목이 사라지면 닫힌 채 남을 이유가 없다).
--   * 이 항목들의 근거 메시지를 mem_suppress_msg 에 남기고(id 만), 그 메시지를 근거로 든 요약은 stale 로 내린다 — 요약을
--     다시 만들 때 이 메시지는 입력에서 빠진다. 같은 원문에서 잊은 사실이 되살아나지 않게 하는 유일한 방법이다.
--   * 이벤트에 channel_id(열 + detail)와 개인 공간 소유자를 남겨 지운 뒤에도 채널 독자가 흔적을 본다(id 만; L-8, #3209 L-2).
--   * mem.op 표지(L-6).
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
  v_reopen uuid[];
BEGIN
  PERFORM public.mem_op('forget_item');
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

  -- 사슬: 옛 버전(supersedes_id, 아래로)과 합쳐진 진 쪽(merged_into_id, 재귀). 간선은 「누구에서 누구로」 한 방향이다.
  WITH RECURSIVE edges(from_id, to_id) AS (
    SELECT i.id, i.supersedes_id FROM public.mem_item i
     WHERE i.workspace_id = v_ws AND i.supersedes_id IS NOT NULL
    UNION ALL
    SELECT i.merged_into_id, i.id FROM public.mem_item i
     WHERE i.workspace_id = v_ws AND i.merged_into_id IS NOT NULL
  ), chain(id) AS (
    SELECT o.id
    UNION
    SELECT e.to_id FROM chain c JOIN edges e ON e.from_id = c.id
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

  -- 요약 정합: 이 항목들의 근거 메시지를 요약 입력에서 뺀다(id 만)... 그리고 그 메시지를 근거로 든 요약을 stale 로.
  INSERT INTO public.mem_suppress_msg (workspace_id, channel_id, message_id)
  SELECT DISTINCT ev.workspace_id, ev.channel_id, ev.message_id
    FROM public.mem_evidence ev
   WHERE ev.item_id = ANY (v_all) AND ev.workspace_id = v_ws
  ON CONFLICT DO NOTHING;
  UPDATE public.mem_digest d SET stale = true
   WHERE d.workspace_id = v_ws AND NOT d.stale
     AND EXISTS (SELECT 1 FROM public.mem_evidence e
                   JOIN public.mem_evidence f ON f.message_id = e.message_id
                  WHERE e.digest_id = d.id AND e.workspace_id = v_ws
                    AND f.item_id = ANY (v_all) AND f.workspace_id = v_ws);

  -- 이 항목들이 닫았던 옛 결정은 다시 연다.
  SELECT COALESCE(pg_catalog.array_agg(i.id), '{}'::uuid[]) INTO v_reopen
    FROM public.mem_item i
   WHERE i.workspace_id = v_ws AND i.closed_by_id = ANY (v_all) AND i.id <> ALL (v_all);
  UPDATE public.mem_item SET valid_to = NULL, closed_by_id = NULL, closed_at = NULL
   WHERE id = ANY (v_reopen) AND workspace_id = v_ws;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id,
                                channel_id, owner_member_id, detail)
  SELECT v_ws, 'item', i.id, 'reverted', v_actor, i.channel_id, i.owner_member_id,
         pg_catalog.jsonb_build_object('what', 'superseded', 'reason', 'closer_forgotten',
                                       'channel_id', i.channel_id)
    FROM public.mem_item i WHERE i.id = ANY (v_reopen) AND i.workspace_id = v_ws;

  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id,
                                channel_id, owner_member_id, detail)
  SELECT v_ws, 'item', i.id, 'forgotten', v_actor, i.channel_id, i.owner_member_id,
         CASE WHEN i.id = o.id
              THEN pg_catalog.jsonb_build_object('versions', pg_catalog.cardinality(v_chain),
                                                 'channel_id', i.channel_id)
              ELSE pg_catalog.jsonb_build_object('via', o.id, 'channel_id', i.channel_id) END
    FROM public.mem_item i WHERE i.id = ANY (v_all) AND i.workspace_id = v_ws;
  DELETE FROM public.mem_evidence ev WHERE ev.item_id = ANY (v_all) AND ev.workspace_id = v_ws;
  DELETE FROM public.mem_item i WHERE i.id = ANY (v_all) AND i.workspace_id = v_ws;
  RETURN pg_catalog.cardinality(v_all);
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
  PERFORM public.mem_op('accept_proposal');
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
  -- #3172: 정리 잡이 만든 병합·기간 닫기 제안은 새 항목을 만들지 않고 두 항목에 적용한다.
  -- M-7: 정리 제안(merge/close)은 카드(UI, #3174)가 붙기 전까지 API 로는 결정할 수 없다. 적용 알맹이(mem_cons_accept)는 있고
  -- 자기 검사(활성 사람·게스트 아님·읽을 수 있는 채널·정리 대상 채널·락 순서)를 갖췄지만 아직 여기서 열지 않는다.
  IF v_p.op <> 'add' THEN
    RAISE EXCEPTION 'mem_accept_proposal: this proposal cannot be decided yet' USING ERRCODE = '55000';
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
    INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, channel_id, owner_member_id, detail)
    VALUES (v_ws, 'item', v_item, 'created', v_p.channel_id, v_owner,
            pg_catalog.jsonb_build_object(
              'kind', v_p.kind, 'space', v_space, 'origin', 'confirmed', 'proposal_id', p_proposal_id,
              'source_count', v_n, 'extractor_version', 'proposal-v1'));
    v_new := true;
  END IF;
  INSERT INTO public.mem_event (workspace_id, target_kind, target_id, action, actor_member_id,
                                channel_id, owner_member_id, detail)
  VALUES (v_ws, 'item', v_item, 'confirmed', v_viewer, v_p.channel_id, v_owner,
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


-- ── 검색: 채널·종류 조건을 스캔 안으로 (#3209 L-3), 서빙은 열린 결정만 ─────────────────────────────────
-- 본체의 시그니처가 바뀌어 옛 것을 지운다(호출자는 mem_search_items_for·mem_search_items 뿐이다). 열람 함수는 인자 두 개를
-- 더하고 기본값 NULL 이라 기존 호출(mem_search_items(q, n))은 그대로 돈다.
DROP FUNCTION IF EXISTS mem_search_items(text, integer);
DROP FUNCTION IF EXISTS mem_search_items_for(uuid, text, integer, uuid);
DROP FUNCTION IF EXISTS mem_search_items_core(uuid, text, integer, uuid, boolean);

CREATE OR REPLACE FUNCTION mem_search_items_core(
  p_viewer uuid, p_query text, p_limit integer, p_answer_channel_id uuid, p_serve boolean,
  p_channel_id uuid DEFAULT NULL, p_kind text DEFAULT NULL)
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
       -- L-3 (#3209): 채널·종류 조건은 상위 N개를 자르기 전에 스캔 안에서 건다(뒤에서 거르면 N개가 비어 버린다).
       AND (p_channel_id IS NULL OR i.channel_id = p_channel_id)
       AND (p_kind IS NULL OR i.kind = p_kind)
       -- 서빙은 지금 유효한 것만 싣는다: 새 결정에 닫힌 옛 결정(valid_to)은 답 컨텍스트에서 현재 결정과 충돌한다.
       -- 열람(브라우저·타임라인)은 닫힌 항목도 본다.
       AND (NOT p_serve OR i.valid_to IS NULL)
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
  SELECT * FROM public.mem_search_items_core(p_viewer, p_query, p_limit, p_answer_channel_id, true, NULL, NULL)
$$;

CREATE OR REPLACE FUNCTION mem_search_items(
  p_query text, p_limit integer DEFAULT 10, p_channel_id uuid DEFAULT NULL, p_kind text DEFAULT NULL)
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
    nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid, p_query, p_limit, NULL, false,
    p_channel_id, p_kind);
END
$$;



-- ── 벡터 팔의 닫힌 결정 제외 (107 의 mem_search_items_fused 재정의; 소유자·권한은 그대로) ────────────────────────
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
       -- #3172: 서빙은 새 결정에 닫힌 옛 결정(valid_to)을 싣지 않는다 — 키워드 경로(mem_search_items_core)와 같다.
       AND i.valid_to IS NULL
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


-- ── 소유자·권한 ────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO mem_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_cons_begin(uuid, uuid, double precision, timestamptz)', 'mem_cons_finish(uuid, uuid, boolean, integer)',
    'mem_cons_retire_dead(uuid, integer)', 'mem_cons_decay(uuid, integer)', 'mem_cons_reconcile(uuid)',
    'mem_suppressed_messages(uuid, uuid[])', 'mem_cons_pairs(uuid, real, real, integer)',
    'mem_cons_merge_items(uuid, uuid, uuid, uuid)', 'mem_cons_close_item(uuid, uuid, uuid, uuid)',
    'mem_cons_propose(text, uuid, uuid)', 'mem_cons_note_pair(uuid, uuid, text)',
    'mem_cons_apply(uuid, uuid, text)', 'mem_cons_accept(uuid, uuid)',
    'mem_cons_retention(uuid, integer, integer, integer)', 'mem_cons_purge_proposals(uuid)',
    'mem_cons_revert(uuid)', 'mem_cons_renew(uuid, uuid, double precision)', 'mem_cons_defer_pair(uuid, uuid)',
    'mem_cons_defer(uuid, uuid, text)', 'mem_cons_release(uuid[], text)', 'mem_item_guest_authored(uuid)',
    'mem_cons_revert_core(uuid, uuid)', 'mem_revert_consolidation(uuid)',
    'mem_search_items_core(uuid, text, integer, uuid, boolean, uuid, text)',
    'mem_search_items_for(uuid, text, integer, uuid)', 'mem_search_items(text, integer, uuid, text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO mem_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM mem_definer;

-- ── 런타임 역할 권한 (이 마이그레이션이 만든 객체만) ─────────────────────────────────────
-- 테이블은 런타임 역할 접근 없음(위). 워커 전용 함수는 momo_memory 에만 EXECUTE. 내부 함수(병합·닫기·제안·수락·판정 캐시,
-- 검색 본체)는 소유자 말고는 아무도 못 부른다 — momo_memory 도. mem_accept_proposal 은 API 함수라 PUBLIC 그대로다
-- (함수 안의 session_user 검사가 막는다).
DO $$
DECLARE
  r text;
  f text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
  worker_only text[] := ARRAY[
    'mem_cons_begin(uuid, uuid, double precision, timestamptz)', 'mem_cons_finish(uuid, uuid, boolean, integer)',
    'mem_cons_retire_dead(uuid, integer)', 'mem_cons_decay(uuid, integer)', 'mem_cons_reconcile(uuid)',
    'mem_suppressed_messages(uuid, uuid[])', 'mem_cons_pairs(uuid, real, real, integer)',
    'mem_cons_apply(uuid, uuid, text)', 'mem_cons_retention(uuid, integer, integer, integer)',
    'mem_cons_purge_proposals(uuid)', 'mem_cons_revert(uuid)', 'mem_cons_renew(uuid, uuid, double precision)',
    'mem_cons_defer_pair(uuid, uuid)',
    'mem_search_items_for(uuid, text, integer, uuid)'
  ];
  internal_only text[] := ARRAY[
    'mem_cons_merge_items(uuid, uuid, uuid, uuid)', 'mem_cons_close_item(uuid, uuid, uuid, uuid)',
    'mem_cons_propose(text, uuid, uuid)', 'mem_cons_note_pair(uuid, uuid, text)', 'mem_cons_accept(uuid, uuid)',
    'mem_cons_defer(uuid, uuid, text)', 'mem_cons_release(uuid[], text)', 'mem_item_guest_authored(uuid)',
    'mem_cons_revert_core(uuid, uuid)',
    'mem_search_items_core(uuid, text, integer, uuid, boolean, uuid, text)'
  ];
BEGIN
  FOREACH f IN ARRAY internal_only || worker_only LOOP
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
  FOREACH t IN ARRAY ARRAY['mem_cons_state', 'mem_cons_pair', 'mem_suppress_msg'] LOOP
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

-- ── L-9 (#3200): mem_definer 소유 SECURITY DEFINER 함수 허용 목록 — 이름이 아니라 **전체 시그니처** ──────────
-- 이름만 보면 같은 이름의 오버로드(다른 인자, 다른 권한)가 몰래 끼어도 통과한다. 이제 regprocedure 문자열이 목록에
-- 있어야 한다. 새 정의자 함수는 여기와 시험(mem_schema_conformance_pg.rs 의 DEFINER_ALLOW_LIST)에 시그니처를 올린다.
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
    'mem_suppressed_messages(uuid,uuid[])', 'mem_token_budget(bigint)'
  ];
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'mem_definer'
              AND p.oid::regprocedure::text <> ALL (allow) LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % owned by mem_definer is not in the allow-list', f;
  END LOOP;
END $$;
