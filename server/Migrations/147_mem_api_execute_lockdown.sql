-- 147_mem_api_execute_lockdown.sql — #4381 (SEC-04 #4371 후속, #4372 조사)
--
-- 105~108·110 이 만든 API 쪽 mem_* SECURITY DEFINER 함수 10개는 Postgres 기본값(PUBLIC EXECUTE)을 회수하지 않은 채
-- 남아 있었다(역할이 마이그레이션보다 늦게 생겨도 깨지지 않게 하려는 선택이었다). 정의자 함수는 소유자(mem_definer,
-- RLS 우회)로 돌기 때문에, 함수 안의 session_user 가드가 마지막 벽이 되는 상태는 좋지 않다. 여기서 EXECUTE 를
-- momo_app 에만 남긴다(110 의 mem_reset_workspace / mem_summary_provider 와 같은 모양).
--
-- 호출자 표 (코드로 확인):
--   함수                            호출자                                                      남기는 EXECUTE
--   mem_search_items                API momo-messaging memory.rs (momo_app 세션)                  momo_app
--   mem_edit_item / mem_forget_item API routes/memory.rs → momo-messaging (momo_app 세션)         momo_app
--   mem_accept_proposal / _reject_  API routes/memory.rs (momo_app 세션, 뷰어 = app.member_id)    momo_app
--   mem_revert_consolidation        API routes/memory.rs (momo_app 세션)                          momo_app
--   mem_digest_evidence_ok          RLS 정책 mem_digest_sel 이 평가(정책은 TO PUBLIC, 읽는 역할 몫)  momo_app (+ 소유자)
--   mem_item_evidence_ok            RLS 정책 mem_item_sel / mem_evidence_sel / mem_event_sel        momo_app (+ 소유자)
--   mem_proposal_evidence_ok        RLS 정책 mem_proposal_sel                                      momo_app (+ 소유자)
--   mem_topic_summary_ok            RLS 정책 mem_topic_summary_sel                                 momo_app (+ 소유자)
--   워커(momo_worker)·릴레이·알림 역할은 부르지 않는다: mem_* 테이블 권한이 없고(100/101 의 lockdown), 워커용
--   쌍둥이(mem_search_items_for 등)는 momo_memory 전용이다. 정책 함수는 mem_* 테이블에 SELECT 가 있는 역할만 평가하는데
--   그건 momo_app 뿐이다(그 밖의 런타임 역할은 BYPASSRLS 라 정책을 평가하지 않는다).
--   이슈 본문은 정책 함수를 3개로 적었지만 pg_policy 를 실측하면 4개다(item/digest/proposal/topic_summary).
--
-- 역할이 이 마이그레이션보다 늦게 생기면 부트스트랩(bootstrap_roles.sql · bootstrap_runtime_roles.sql)이 같은
-- REVOKE/GRANT 를 다시 준다. 함수 안의 session_user 가드와 GUC 행위자는 그대로다(벽이 둘).

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_accept_proposal(uuid)', 'mem_digest_evidence_ok(uuid)', 'mem_edit_item(uuid,text,text)',
    'mem_forget_item(uuid)', 'mem_item_evidence_ok(uuid)', 'mem_proposal_evidence_ok(uuid)',
    'mem_reject_proposal(uuid)', 'mem_revert_consolidation(uuid)',
    'mem_search_items(text,integer,uuid,text)', 'mem_topic_summary_ok(uuid)'
  ] LOOP
    IF to_regprocedure('public.' || f) IS NULL THEN
      RAISE EXCEPTION 'mem API function % is missing', f;
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO momo_app', f);
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       WHERE p.oid = to_regprocedure('public.' || f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'PUBLIC can still execute %', f;
    END IF;
  END LOOP;
END
$$;
