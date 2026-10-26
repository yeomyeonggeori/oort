-- =============================================================================
-- 151_audit_attachment_name_scrub.sql — #4443 / ADR-0151 증보 2 D3 (owner 승인 2026-10-26, 조건 C)
--
-- 왜
--   감사 `attachment.upload_started` 의 detail 에는 schema v1 까지 파일 이름(`name`)이 들어 있었다.
--   이름은 사람의 것일 수 있다(`급여명세서.pdf`). 새 행은 v2 부터 이름 없이 쓴다(attachment.rs). 이 마이그레이션은
--   **이미 쓰인 v1 행에서 `name` 키 하나만** 지운다. 해시로 바꾸지 않는다: 파일 이름은 짧고 추측하기 쉬워서
--   키 없는 해시는 사전 대입 한 번이면 이름으로 돌아가고, 키 있는 해시는 새 비밀과 회전 문제를 만든다.
--
-- 감사 표의 무결성 장치를 먼저 확인했다 (owner 조건: 「깨면 하지 말고 보고」)
--   해시 체인·이전 행 해시 열: 없다(audit_log 열은 id·workspace_id·actor/subject_member_id·action·target_type·
--   target_id·via_token_id·run_id·detail·ip_addr·created_at).
--   UPDATE/DELETE 를 막는 트리거·규칙·정책: 없다(사용자 정의 트리거 0, 규칙 0, 정책은 ws_isolation FOR ALL 하나).
--   권한: 런타임 역할 momo_app 은 이 표에 SELECT·INSERT·UPDATE·DELETE 를 가진다(bootstrap_runtime_roles.sql).
--   문서 약속: 「추가 전용」「위변조 방지」라고 적힌 곳이 없다. 오히려 audit.rs 머리말은 행동이 롤백되면 감사 행도
--   함께 사라진다고 적는다. 관리자가 감사 행을 읽는 REST 경로도 없다(docs/security/README.ko.md 「현재 한계」).
--   `detail.name` 을 읽는 코드도 없다(서버는 action·target 존재 여부만 읽는다). 그래서 이 정정은 어떤 보장도
--   깨지 않는다.
--
-- 무엇 (그리고 무엇이 아닌가)
--   action = 'attachment.upload_started' 이고 detail 에 최상위 `name` 키가 있는 행에서 그 키만 지운다.
--   schema 문자열은 고치지 않는다(v1 행은 v1 로 남고, 이름만 없다). 다른 action 의 행은 `name` 키가 있어도
--   (예: member.renamed) 건드리지 않는다. 아바타 업로드 감사(member/workspace.avatar_upload_started)의 `name` 은
--   별개 표면(ADR-0161)이라 이 정정의 범위 밖이다.
--   schema 가 v1 인지 묻지 않는 이유: 옛 서버가 쓴 행에는 schema 키가 없을 수 있고, 이 정정의 목적은 이름을
--   남기지 않는 것이라 키가 있는 행을 모두 지운다.
--
-- 멱등
--   두 번째 실행은 0행이다(조건에 `detail ? 'name'` 이 있다). 배포 중에는 아직 이전 버전의 api 가 v1 행을
--   쓰고 있을 수 있어서 이 실행 뒤에도 이름 있는 행이 한두 개 생길 수 있다 — 그래서 아래 단정은 「0이어야 한다」가
--   아니라 숫자를 남기기만 한다(거짓 실패로 배포를 멈추지 않는다). 남은 수는 infra/rust/sql/attachment_reclaim_check.sql
--   이 센다. 배포가 끝난 뒤에도 0이 아니면 아래 UPDATE 한 문장을 같은 조건으로 다시 돌리면 된다.
--
-- 운영 적용
--   audit_log 는 FORCE RLS 이고 마이그레이션에는 app.workspace_id 가 없다. 전 테넌트를 고쳐야 하므로 150 과 같은
--   자리에서 같은 줄을 건다(row_security = off). migration 은 정책을 우회하는 역할(슈퍼유저·BYPASSRLS)로 돌아서 이
--   줄은 우회 스위치가 아니라 안전망이다: 그런 권한이 없는 역할이면 정책에 걸려 조용히 0행이 되는 대신 오류로 멈춘다.
--   이 파일은 감사 행을 수정하는 유일한 마이그레이션이다. 운영 적용은 배포의 사전 덤프 뒤에 일어난다.
--   표를 한 번 훑는다(action 에 인덱스가 없다). 행 잠금은 고치는 행에만 걸린다.
--
-- 앞뒤 행 수는 RAISE NOTICE 로 남는다(행이 사라지지 않았다는 증거: after ≥ before).
-- =============================================================================

SET LOCAL row_security = off;

DO $$
DECLARE
  rows_before   bigint;
  scrubbed      bigint;
  rows_after    bigint;
  still_named   bigint;
BEGIN
  SELECT count(*) INTO rows_before FROM audit_log;

  WITH touched AS (
    UPDATE audit_log
       SET detail = detail - 'name'
     WHERE action = 'attachment.upload_started'
       AND detail ? 'name'
    RETURNING 1
  )
  SELECT count(*) INTO scrubbed FROM touched;

  SELECT count(*) INTO rows_after FROM audit_log;
  SELECT count(*) INTO still_named
    FROM audit_log
   WHERE action = 'attachment.upload_started' AND detail ? 'name';

  RAISE NOTICE '151 audit scrub: audit_log rows before=% after=% (a concurrent insert can make after larger); attachment.upload_started rows scrubbed=%; still carrying a name=% (only a row an old api wrote during the deploy)',
    rows_before, rows_after, scrubbed, still_named;
END $$;
