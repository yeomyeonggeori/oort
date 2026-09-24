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
-- NULL은 이 마이그레이션 전의 행이다. 이전 세션은 첫 회전에서 계보를 얻고, 폰은
-- 실행할 때마다(부팅 회전 뒤) 다시 등록하므로 등록도 곧 계보에 묶인다. 계보가
-- 없는 등록은 어느 한 세션의 logout도 건드리지 않는다(누구의 것인지 모르므로).
-- 멤버의 세션이 전부 끝나는 경로는 계보와 무관하게 전부 끝낸다.
--
-- 단순 nullable 컬럼 둘과 부분 인덱스 하나(ADR-0100 「단순 인덱스/컬럼 추가는
-- 제외」). 새 테이블·새 정책·새 권한 없음. schema_v0.sql 무접촉.
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
