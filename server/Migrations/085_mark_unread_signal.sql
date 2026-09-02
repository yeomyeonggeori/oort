-- =============================================================================
-- 085_mark_unread_signal.sql — ADR-0178 / #1934 BT-6 서버 절반
--
-- mark-unread 를 **단조 커서를 부수지 않고** 얹는다. ADR-0178 D1: `last_read_seq`
-- 의 GREATEST 계약은 불변이다 — 그것은 순서 불변식(`message.seq`)의 파생 규율이고,
-- 알림 dedupe·워터마크 등 단조를 가정하는 소비자가 이미 그 위에 서 있다.
-- 되돌릴 수 있어야 하는 것은 커서가 아니라 **사람이 남긴 표식**이므로, D2 대로
-- 커서와 독립한 신호 컬럼 하나를 더한다.
--
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
--
-- ## 왜 nullable 인가 (기본값 없음)
--
-- NULL 은 「표식 없음」이고 그것이 압도적 다수의 행이다. 0 을 센티넬로 쓰면
-- `min(marked, last_read+1)` 합성(D3)이 모든 행에서 0 으로 접혀 채널 전체가
-- 안 읽음이 된다 — 센티넬과 진짜 값이 같은 산술을 지나가는 자리다.
--
-- ## 왜 read_state 인가 (ADR 문면의 channel_read_state 아님)
--
-- ADR-0178 D2 는 표를 `channel_read_state` 로 적었지만 이 레포의 실물 정본은
-- `read_state`(001_init.sql:251)다 — per-(channel, member) 읽기 커서 그 표.
-- 표식은 커서와 같은 입도·같은 수명·같은 RLS 스코프를 가지므로 같은 행에 산다.
-- (ADR 문면 정정은 별도 랜딩.)
--
-- ## 제약이 이것뿐인 이유
--
-- `> 0` 만 건다. 「해당 채널에 실존하는 seq」검증(D5)은 라우트가 같은 트랜잭션
-- 안에서 `message` 를 조회해 수행하고 400 으로 거절한다 — 그 술어는 다른 표를
-- 읽어야 하므로 CHECK 로 표현할 수 없다. head 상한도 마찬가지다(`channel_seq`).
-- 여기 남는 것은 어떤 경로로도 참이어야 하는 최소 형상뿐이다.
-- =============================================================================

ALTER TABLE read_state
  ADD COLUMN marked_unread_before_seq bigint;

ALTER TABLE read_state
  ADD CONSTRAINT read_state_marked_unread_before_seq_positive_ck
    CHECK (marked_unread_before_seq IS NULL OR marked_unread_before_seq > 0);

COMMENT ON COLUMN read_state.marked_unread_before_seq IS
  'ADR-0178 D2 mark-unread signal: "treat this channel as unread from this seq onward (inclusive)". NULL = no mark. Independent of last_read_seq, which stays monotone (D1/GREATEST), so a stale re-advertisement from another device cannot push the mark away. Cleared only by an explicit-open read advertisement in the same transaction (D4). Composition into an effective unread start lives in exactly one momo-core function (D3).';
