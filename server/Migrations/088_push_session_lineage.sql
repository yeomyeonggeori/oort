-- =============================================================================
-- 088_push_session_lineage.sql — #2677 (ADR-0120 D4 「로그아웃 시 invalidate」의
-- 서버측 이행, ADR-0180 D5 연결 기기 해제와 같은 결)
--
-- 푸시 등록은 그것을 만든 세션만큼 산다.
--
-- 지금까지 `device`/`push_token`은 세션을 몰랐고, 세션(`token`)은 기기를 몰랐다.
-- 그래서 logout은 세션 토큰만 회수하고 등록은 남겼다. 판정(momo-push
-- `judge_targets`)은 `push_token.invalidated_at IS NULL`만 거르고, 폰 알림
-- 확장은 세션이 없으면 relay 자리표시를 그대로 띄우므로(fail-open), 로그아웃한
-- 폰이 앞 사람의 「oort / 새 알림」과 배지 수를 계속 받았다.
--
-- 등록 요청의 access id를 적는 것만으로는 부족하다. access는 약 15분마다 새로
-- 발급되고, 로그아웃 때 들고 오는 pair는 등록 때의 pair가 아니다. 그래서 세션의
-- 계보 id를 둔다.
--
--   token.session_id       한 로그인(가입·claim·비밀번호 교체·기기 연결 포함)이
--                          여는 세션의 계보. access·refresh 두 반쪽이 같은 값을
--                          갖고, refresh 회전이 새 pair에 그대로 물려준다.
--                          인증 판정은 이 컬럼을 읽지 않는다 — 폐기·만료·SAS
--                          판단은 그대로다.
--   push_token.session_id  이 등록을 만든 세션(등록 요청 access row의 계보).
--
-- 세션을 끝내는 경로가 그 계보(또는 멤버 전체)의 살아 있는 등록에
-- `invalidated_at`을 쓴다. 판정 SQL과 notifier 권한은 건드리지 않는다 —
-- notifier는 `token`을 읽지 않는다(#2448이 좁힌 권한 그대로).
--
-- NULL은 이 마이그레이션 전의 행이다. 이전 세션은 첫 회전에서 계보를 얻는다.
-- 등록은 저절로 묶이지 않는다. 로그인 중인 폰은 다음 콜드스타트에 다시 등록하며
-- 묶이지만, 이미 로그아웃한 폰은 다시 등록하지 않는다. 그 행은 끝낼 세션이 없어
-- 어느 logout도 닿지 못한다(#2677 리뷰 H1). 그래서 이 파일 끝의 백필이 계보 없는
-- 살아 있는 등록을 한 번 모두 무효화한다.
--
-- 그 뒤에도 계보 없는 행은 생길 수 있다. 배포 중 아직 돌던 옛 서버가 쓴 행,
-- 세션이 아닌 자격증명의 등록이다. 그런 행은 어느 한 세션의 logout도 건드리지
-- 않는다(누구의 것인지 모르므로). 다음 실행의 재등록이 계보에 묶고, 멤버의
-- 세션이 전부 끝나는 경로는 계보와 무관하게 끝낸다.
--
-- 단순 nullable 컬럼 둘과 부분 인덱스 하나(ADR-0100 「단순 인덱스/컬럼 추가는
-- 제외」), 그리고 기존 행의 `invalidated_at`을 채우는 데이터 문장 하나. 새
-- 테이블·새 정책·새 권한 없음. schema_v0.sql 무접촉.
-- =============================================================================

ALTER TABLE token
  ADD COLUMN session_id uuid;

ALTER TABLE push_token
  ADD COLUMN session_id uuid;

-- 세션이 끝날 때 그 계보의 살아 있는 등록을 찾는 길.
CREATE INDEX push_token_session_active_idx
  ON push_token (workspace_id, session_id)
  WHERE session_id IS NOT NULL AND invalidated_at IS NULL;

COMMENT ON COLUMN token.session_id IS
  '#2677 session lineage: shared by the access/refresh halves of a sign-in and inherited by every refresh rotation. Never read by authentication. NULL = row minted before 088.';
COMMENT ON COLUMN push_token.session_id IS
  '#2677 the session (token.session_id) that made this registration. Ending that session invalidates the row. NULL = registered before 088, or by a non-session credential.';

-- -----------------------------------------------------------------------------
-- 백필 — 088 이전의 등록 (#2677 리뷰 H1, 통합자 결정 (b) 전면형)
--
-- 088 이전의 등록은 계보가 없다. 그중 이미 로그아웃한 폰의 행은 끝낼 세션이
-- 없다. 이 문장이 없으면 그 폰은 업그레이드 뒤에도 계속 푸시를 받는다(리뷰 실측
-- REVIEW-GAP-A `dispatches=1`, 공용 기기나 양도된 기기면 남의 알림이다). 어느
-- 행이 로그아웃한 폰의 것인지 가릴 수 없으므로 계보 없는 살아 있는 행을 모두
-- 한 번 무효화한다. 행을 지우지 않는다(`invalidated_at`만 쓴다).
--
-- 근거와 비용
--   * 외부 사용자가 아직 없다(목표 A). oort-team의 사람 멤버는 owner 한 명이다.
--   * 로그인 중인 폰도 함께 꺼진다. 다음 콜드스타트에 부팅 회전이 088 이전
--     세션에 계보를 주고, PushProvider가 같은 기기·APNs 토큰으로 다시 등록하면
--     `register_device`의 reclaim UPDATE가 그 행을 새 계보에 묶어 되살린다.
--     비용은 다음 실행까지 푸시가 없는 것뿐이고, 사실상 0이다.
--   * (a) 보수형(살아 있는 refresh가 없는 멤버의 행만)은 기각했다. 데스크톱에
--     로그인 중인 멤버의 고아 폰 행을 놓친다.
--
-- push_token은 RLS FORCE이고 마이그레이션에는 app.workspace_id가 없다. 전
-- 테넌트를 훑어야 하므로 002/005/012/055/064와 같은 자리에서 같은 우회를 쓴다.
-- 우회 권한(슈퍼유저·BYPASSRLS)이 없는 역할이면 정책에 걸려 조용히 0행이 되는
-- 대신 오류로 멈춘다(2026-09-24 격리 PG에서 두 경우를 실측). --single-transaction
-- 이므로 위의 ALTER와 이 UPDATE는 함께 커밋되고, SET LOCAL은 파일 끝에서 풀린다.
-- -----------------------------------------------------------------------------
SET LOCAL row_security = off;

UPDATE push_token
   SET invalidated_at = now(),
       updated_at = now()
 WHERE session_id IS NULL
   AND invalidated_at IS NULL;

SET LOCAL row_security = on;
