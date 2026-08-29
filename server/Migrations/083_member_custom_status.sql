-- =============================================================================
-- 083_member_custom_status.sql — ADR-0176 / #1889 BF-B2 서버 절반
--
-- 선언 프레즌스(auto/away/dnd, 068)와 직교하는 「무엇을 하고 있는가」축.
-- 저장 위치는 조사 결과 그대로 `member` — `presence_status` 와 같은 행, 같은
-- RLS 스코프(ws_isolation FOR ALL, FORCE). 새 테이블·새 정책·새 레일 없음.
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
--
-- 만료는 지연 삭제: 컬럼은 남을 수 있고, 읽기(roster / own GET / 브로드캐스트
-- 페이로드)가 `status_expires_at <= now()` 이면 세 필드를 모두 없는 것처럼
-- 다룬다. 만료 잡 없음.
-- =============================================================================

ALTER TABLE member
  ADD COLUMN status_emoji text,
  ADD COLUMN status_text text,
  ADD COLUMN status_expires_at timestamptz;

ALTER TABLE member
  ADD CONSTRAINT member_status_emoji_len_ck
    CHECK (status_emoji IS NULL OR char_length(status_emoji) <= 32),
  ADD CONSTRAINT member_status_text_len_ck
    CHECK (status_text IS NULL OR char_length(status_text) <= 80);

COMMENT ON COLUMN member.status_emoji IS
  'ADR-0176 custom status emoji. Nullable. Server caps length/code points (≤32 scalars); not a strict emoji classifier. Human-only on the wire.';
COMMENT ON COLUMN member.status_text IS
  'ADR-0176 custom status text, trimmed, at most 80 characters. Nullable.';
COMMENT ON COLUMN member.status_expires_at IS
  'ADR-0176 optional expiry. Reached expiry is ignored on read (lazy delete); no sweeper job.';
