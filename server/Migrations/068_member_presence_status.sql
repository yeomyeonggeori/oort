-- =============================================================================
-- 068_member_presence_status.sql — ADR-0160 ③ 선언 상태 (사용자 프레즌스 6b)
--
-- 번호: 처음엔 066 이었다(그때 origin 최신이 065). 같은 검수 배치의 병렬 워커 둘이
-- 먼저 랜딩해 — W-B2-3 의 066_notification_rule, W-B2-2 의 067_workspace_avatar —
-- 리베이스에서 068 로 재부여했다. 067 이 자기 앞 충돌에 한 것과 같은 처리이고,
-- 패킷이 예고한 「충돌 시 리베이스로 재부여」 그대로다. 마이그레이션 집합은 연속이어야
-- 하므로(momo-db `migrate::tests`) 번호를 비워 두고 건너뛰지 않는다. **SQL 본문은
-- 재부여로 한 줄도 바뀌지 않았다** — 바뀐 것은 파일명과 이 머리주석뿐이다.
--
-- 프레즌스는 momo에서 세 어휘다: ①연결(클라 로컬)·②가용성(휘발·Centrifugo)·
-- ③선언 상태(내구). 이 마이그레이션은 ③만 담는다 — **화면에 찍히는 유효 프레즌스는
-- 저장하지 않는다**(f(선언,가용성)을 읽기/렌더 경계에서 계산). ②는 PG를 절대
-- 건드리지 않으므로 여기에 컬럼이 없다(ADR-0160 D1·D3).
--
-- ## 왜 새 enum이고 member_status를 재사용하지 않나
--
-- `member_status`(001_init.sql:12)는 **수명주기**다 — active/invited/suspended/
-- deleted. 프레즌스는 수명주기가 아니라 사용자 의도이고, 두 축을 한 컬럼에 접으면
-- "자리 비움"이 "정지됨"과 같은 자리에서 다툰다. 그래서 별도 enum이며, 그 첫 라벨은
-- **`auto`**다(`active` 회피 — 수명주기 enum과 충돌). auto = "수동 오버라이드 없음":
-- 접속해 있으면 online, 아니면 offline으로 **읽기 경계에서** 계산된다.
--
-- ## 불변식과의 관계 (ADR-0160 불변식 대조)
--
--   * Postgres = SoT — 유지. 선언 상태는 내구. 재접속에 살아남는다(특히 dnd는 알림을
--     억제하므로, 내구가 아니면 재접속이 조용히 dnd를 풀어 사용자를 다시 깨운다).
--   * 단일 쓰기경로 — 유지. 이 컬럼은 REST→PG→emit_outbox(Broadcast)→relay로만
--     바뀐다. 두 번째 쓰기 이음매를 만들지 않는다(momo_messaging::presence).
--   * 에이전트 = member — 유지. 컬럼은 member 전체에 있지만 프레즌스는 **사람 전용**
--     이다(ADR-0160 D4). set 라우트는 require_human, 로스터 투영은 human만 싣는다.
--     에이전트 행의 'auto'는 기본값으로 남되 어디에도 표면화되지 않는다.
--   * RLS FORCE — member는 이미 ws_isolation(FOR ALL) 아래 있다. 이 컬럼은 그
--     테넌트 경계를 그대로 상속하고, set은 actor 자신의 행(member_id = principal)만
--     바꾼다.
--
-- ## 되돌리기
--
-- 라우트를 끄고 이 컬럼을 DROP하면 선언 상태는 잔여물 없이 사라진다. 유효 프레즌스
-- 컬럼이 없으므로 드리프트할 비정규화 값도 없다. 한 방향 문이 아니다.
-- =============================================================================

CREATE TYPE presence_status AS ENUM ('auto', 'away', 'dnd');

ALTER TABLE member
  ADD COLUMN presence_status presence_status NOT NULL DEFAULT 'auto';

COMMENT ON COLUMN member.presence_status IS
  'ADR-0160 ③ 선언 상태(내구). auto=수동 오버라이드 없음(접속 시 online 계산). 사람 전용 — 에이전트 행에는 auto로 남되 표면화되지 않는다. 유효 프레즌스는 저장하지 않는다.';
