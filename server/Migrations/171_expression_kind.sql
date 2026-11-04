-- =============================================================================
-- 171_expression_kind.sql — #4961 (ADR-0218 증보 4 §10 J1·J3·J5)
--
-- 왜
--   폰 시트의 네 탭(이모티콘·이모지·팀 이모지·GIF)이 같은 보관함을 두 번 보여 주는 까닭은 등록에 「작은
--   팀 이모지인가 큰 이모티콘인가」를 말하는 값이 없어서다. 등록마다 종류 값 하나를 둔다. 158 의 `expression`
--   표에 열 하나를 더하는 일이다. 새 표는 없다.
--
-- 무엇
--   expression.kind  text NOT NULL DEFAULT 'sticker'  CHECK (kind IN ('emoji','sticker'))
--     emoji   작은 팀 이모지(글자 크기, 글 사이·반응에 쓴다)
--     sticker 큰 이모티콘(단독으로 보낸다, 움직이면 GIF 탭)
--   `expression_draft` 에는 열을 더하지 않는다: 종류는 등록(활성화) 순간에 정해진다(J3).
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 닫힌 목록: CHECK. 서버의 `Kind` enum 이 같은 두 값만 받지만, 다른 경로(운영자 SQL·옛 코드)가 다른 값을
--     쓰는 길은 이 CHECK 가 막는다.
--   * 옛 행: 열의 DEFAULT 가 채운다 → 모두 'sticker'. 옛 고르개의 이모티콘·GIF 탭 구성이 그대로 남는다.
--     상수 DEFAULT 의 열 추가는 테이블을 다시 쓰지 않고 행에 대한 트리거도 일으키지 않는다. 옛 행을 큰 그림으로
--     다시 계산해 채우는 backfill 은 하지 않는다(J5: UPDATE 가 `expression_identity` 트리거를 꺼야 한다).
--   * 기본값이 열에 있으므로 이 열을 모르는 INSERT(옛 바이너리의 롤링 배포 중 쓰기)도 그대로 성공한다.
--   * 불변: 158 의 `expression_immutable()` 가 「열 목록 밖의 어떤 열도 바뀌면 거절」이라서, 새 열은 따로
--     손대지 않아도 INSERT 뒤 불변이다(`expression` 은 표시 이름·태그·상태·버전·숨김·삭제 시각만 바뀐다).
--     등록 뒤 종류 바꾸기는 후속이다(그러려면 그 함수의 허용 목록을 바꿔야 한다: 이 파일은 보안 경계 함수를
--     건드리지 않는다).
--
-- RLS
--   기존 표의 열 추가라서 정책·FORCE·권한은 그대로다(158 의 ws_isolation 과 momo_app 표 단위 GRANT 가 새 열에도
--   걸린다). 새 테넌트 표가 없으므로 정책 목록에 더할 것이 없다.
--
-- schema_v0.sql 은 건드리지 않는다.
-- =============================================================================

ALTER TABLE expression
  ADD COLUMN kind text NOT NULL DEFAULT 'sticker',
  ADD CONSTRAINT expression_kind_ck CHECK (kind IN ('emoji','sticker'));
