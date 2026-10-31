-- =============================================================================
-- 166_team_ai_alias_follow_name.sql — #4966 (ADR-0201 증보 2026-10-31 v3 B10, 슬라이스 S3)
--
-- 「별칭이 이름을 따라가요」: 관리자가 도우미(oort 도우미)의 표시 이름을 바꾸면, 새 이름에서 만든
-- 별칭 하나가 있는 별칭에 **더해진다**(기본 `oort`·`오르트`·`claude` 와 옛 이름 별칭은 그대로).
-- 별칭은 워크스페이스당 최대 4개이고, 넘으면 서버 함수(`sync_team_ai_aliases_in_tx`)가 가장 오래된
-- 것부터 하나씩 지운다. 이 파일은 그 DB 계약만 연다.
--
-- 1. member_handle_alias_v2_set_ck (138) — 별칭을 `oort`·`오르트`·`claude` 셋으로 고정하던 CHECK 를
--    지운다. 모양 규칙(member_handle_alias_shape_ck: 소문자, `[a-z0-9_가-힣-]{2,16}`)은 그대로 남는다.
--
-- 2. member_handle_alias_guard — 셋 고정이 하던 일을 이 트리거가 이어받는다. 삽입·갱신마다:
--      ① member_id 가 그 워크스페이스의 도우미 멤버(`workspace.settings.team_ai_agent_member_id`)인가.
--         CHECK 는 다른 표의 행을 볼 수 없어서 트리거로 둔다. 「대상이 도우미 멤버뿐」은 앱 규율이 아니라
--         DB 가 보장한다(임의 멤버에게 별칭을 다는 길은 사칭 표면이라 계속 만들지 않는다, H2-2).
--      ② 그 워크스페이스에 이미 다른 별칭이 4개 있으면 5개째를 거절한다. 앱 함수를 우회한 직접 INSERT
--         도 4개를 넘지 못한다. 이미 있는 별칭을 `ON CONFLICT DO NOTHING` 으로 다시 넣는 것은 행을
--         늘리지 않으므로 세지 않는다(BEFORE 트리거는 충돌 판정보다 먼저 돈다) — 이미 4개인 도우미를
--         다시 켜는 호출이 500 으로 끝나지 않게 한다.
--    같은 워크스페이스의 별칭 쓰기는 advisory lock 한 줄로 줄 세운다(두 트랜잭션이 동시에 3개를 보고
--    둘 다 넣어 5개가 되는 일을 막는다). 서버 함수도 같은 키를 먼저 잡는다.
--
-- RLS·권한은 138 의 표 그대로다(ENABLE + FORCE + ws_isolation, momo_app SELECT/INSERT/DELETE,
-- momo_worker SELECT). 갱신 권한을 더하지 않는다 — 서버는 지우고 넣는다.
-- schema_v0.sql 은 건드리지 않는다. 모든 문장이 가드되어 다시 적용해도 무해하다.
-- =============================================================================

-- ── 1. 셋 고정 CHECK 를 지운다 (모양 규칙만 남는다) ───────────────────────────────
ALTER TABLE member_handle_alias DROP CONSTRAINT IF EXISTS member_handle_alias_v2_set_ck;

COMMENT ON TABLE member_handle_alias IS
  '#3894 ADR-0201 증보 v2 H2 + #4966 v3 B10: 도우미(oort 도우미)를 부르는 별칭. 기본 oort·오르트·claude 에 새 이름의 별칭이 더해지고 워크스페이스당 최대 4개다(트리거 member_handle_alias_guard, 넘으면 서버가 가장 오래된 것부터 지운다). 실제 멤버의 핸들이 언제나 이긴다(트리거 member_handle_alias_release). 서버만 쓴다.';

-- ── 2. 대상은 도우미뿐 · 워크스페이스당 4개 ──────────────────────────────────────
CREATE OR REPLACE FUNCTION member_handle_alias_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  helper text;
  others integer;
BEGIN
  -- ① 도우미 멤버만. 서버만 쓰는 설정 키라서 PATCH 로 지명할 수 없다(ADR-0201 D8).
  SELECT w.settings ->> 'team_ai_agent_member_id' INTO helper
    FROM public.workspace w
   WHERE w.id = NEW.workspace_id;
  IF helper IS DISTINCT FROM NEW.member_id::text THEN
    RAISE EXCEPTION 'member_handle_alias.member_id must be the workspace team AI member (ADR-0201 증보 v3 B10-4)'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ② 최대 4개. 같은 워크스페이스의 쓰기를 줄 세운 다음 센다.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('team-ai-alias:' || NEW.workspace_id::text, 0));
  SELECT count(*) INTO others
    FROM public.member_handle_alias a
   WHERE a.workspace_id = NEW.workspace_id
     AND a.alias_norm <> NEW.alias_norm
     AND NOT (TG_OP = 'UPDATE'
              AND a.workspace_id = OLD.workspace_id
              AND a.alias_norm = OLD.alias_norm);
  IF others >= 4 THEN
    RAISE EXCEPTION 'a workspace holds at most 4 team AI aliases (ADR-0201 증보 v3 B10-3)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- UPDATE OF 는 정체성·의미 열만: created_at 같은 열의 갱신이나 FK 의 연쇄 갱신이 막히지 않게 한다.
DROP TRIGGER IF EXISTS member_handle_alias_guard_trg ON member_handle_alias;
CREATE TRIGGER member_handle_alias_guard_trg
  BEFORE INSERT OR UPDATE OF workspace_id, member_id, alias, alias_norm
  ON member_handle_alias
  FOR EACH ROW EXECUTE FUNCTION member_handle_alias_guard();
