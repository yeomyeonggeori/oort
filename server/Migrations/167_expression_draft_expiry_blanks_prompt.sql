-- =============================================================================
-- 167_expression_draft_expiry_blanks_prompt.sql — #4900 (ADR-0218 D2, 보안 검수 2회차 후속)
--
-- 왜
--   표현 초안(`expression_draft`)의 `origin.prompt` 에는 에이전트가 쓴 글이 최대 2,000자까지 들어간다.
--   그 글은 승인 카드가 열려 있는 동안만 쓸모가 있는데, 초안이 만료·거절·취소로 `expired` 가 된 뒤에도
--   행(기록)과 함께 남아 있었다. 조립 보관(159)은 이미 만료 때 바이트와 헤더를 함께 지운다(C1b).
--   초안의 헤더는 「기록으로 남는다」가 설계라서(ADR-0218 D2, 158 의 불변 트리거) 행을 지우지 않고
--   **글만 비운다**: `origin.prompt` 를 JSON null 로. 종류·출처 주소·원본 사진 포인터·이름·상태는 그대로다.
--
-- 무엇
--   `expression_immutable()` 의 초안 갈래가 `origin` 의 단 한 가지 변경만 허락한다: 새 상태가 `expired` 이고
--   새 origin 이 「옛 origin 에서 prompt 만 JSON null 로 바꾼 것」과 같을 때. (이미 `expired` 인 행의 같은
--   변경도 같은 문장이라 허락된다 — 아래 한 번의 정리가 그 길을 쓴다.) 그 밖의 origin 변경, 다른 열의 변경,
--   활성화된 초안의 어떤 변경도 158 에서와 똑같이 거절된다. 나머지 갈래(DELETE·픽셀·표현)는 158 그대로다.
--   이 migration 뒤로 만료 스윕(`sweep_in_tx`)과 승인이 닫힐 때의 회수(`reclaim_in_tx`)가 같은 UPDATE 에서
--   prompt 를 비운다(앱 코드).
--
--   이미 `expired` 인 행의 prompt 는 이 파일이 한 번 비운다. 이 표는 FORCE RLS 라서 테넌트 설정 없이는 행이
--   보이지 않으므로, migration 한정으로 row_security 를 끈다(002·005·012·055·064 와 같은 방식; migrate 는
--   파일 단위 트랜잭션이고 DB 소유자/슈퍼유저 컨텍스트다).
--
-- RLS
--   새 표가 없다. 158 의 ws_isolation·FORCE·권한은 그대로다.
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다(함수는 OR REPLACE, 정리는 멱등).
-- =============================================================================

CREATE OR REPLACE FUNCTION expression_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A tenant deletion may cascade; a living tenant's names never disappear.
    IF EXISTS (SELECT 1 FROM workspace WHERE id=OLD.workspace_id) THEN
      RAISE EXCEPTION 'expression name tombstones are permanent' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  ELSIF TG_TABLE_NAME IN ('expression_image','expression_draft_image') THEN
    RAISE EXCEPTION 'expression pixels are immutable' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'expression' THEN
    IF (to_jsonb(NEW) - ARRAY['display_name','tags','status','version','hidden_at','deleted_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['display_name','tags','status','version','hidden_at','deleted_at']) OR
       (OLD.status = 'deleted' AND NEW.status <> 'deleted') OR
       (OLD.status = 'hidden' AND NEW.status = 'active') THEN
      RAISE EXCEPTION 'expression identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- A draft: everything but revision/state/code/submission/receipt is fixed once inserted, and
    -- `origin` moves in exactly one way (167): when the draft is `expired`, the agent's words in
    -- it are blanked. The new origin must be the old one with `prompt` set to JSON null, nothing else.
    IF OLD.state = 'activated' OR
       (to_jsonb(NEW) - ARRAY['revision','state','code','submitted_by','submitted_revision','submitted_sha256','receipt','origin']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['revision','state','code','submitted_by','submitted_revision','submitted_sha256','receipt','origin']) OR
       (NEW.origin IS DISTINCT FROM OLD.origin AND NOT
         (NEW.state = 'expired' AND NEW.origin = jsonb_set(OLD.origin, '{prompt}', 'null'::jsonb))) THEN
      RAISE EXCEPTION 'draft identity and receipt are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Drafts that expired before this file: blank the words they still hold (the trigger above allows
-- exactly this change on an `expired` row).
SET LOCAL row_security = off;
UPDATE expression_draft
   SET origin = jsonb_set(origin, '{prompt}', 'null'::jsonb)
 WHERE state = 'expired' AND jsonb_typeof(origin -> 'prompt') = 'string';
