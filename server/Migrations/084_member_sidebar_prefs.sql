-- =============================================================================
-- 084_member_sidebar_prefs.sql — ADR-0177 / #1932 BT-4 서버 절반
--
-- 사이드바 조직화(커스텀 섹션·채널 배치·별표)의 로밍 저장소. ADR-0177 D1/D2:
-- 소유는 **멤버별**이고, 워크스페이스 공유 구조는 v2 명시 보류다. 한 멤버당
-- 한 행, 구조 전체가 `payload` JSONB 한 덩어리 — 정규화 테이블은 v1 규모에서
-- 검증·마이그레이션·경합 전부 더 비싸다(ADR 기각 대안 3).
--
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
--
-- RLS 는 ADR-0177 D2 가 명시한 대로 `ws_isolation` 동형이다(066 문법 그대로).
-- 082 `message_reminder` 는 소유자 GUC(app.member_id)를 겹치지만 그 표는
-- **목록 라우트**가 있어 술어를 빠뜨릴 자리가 있다. 여기엔 목록이 없다:
-- 경로가 `/members/me` 하나뿐이고 member_id 는 언제나 자격증명의 것이라
-- 요청이 남의 행을 지목할 철자 자체가 없다. 그래서 멤버 경계는 라우트가,
-- 테넌트 경계는 이 정책이 잡는다.
--
-- 이벤트 없음(ADR-0177 D2): outbox 트리거도, relay 팬아웃도 만들지 않는다.
-- 자기 기기는 즉시 반영, 타 기기는 부트스트랩 GET 으로 수렴한다(#1888 전례).
--
-- 접기 상태는 여기에 들어오지 않는다(ADR-0177 D4 — 접힘은 기기 성향이라
-- 클라 localStorage 가 정본). payload 는 구조만 담는다.
-- =============================================================================

CREATE TABLE member_sidebar_prefs (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id    uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, member_id),
  CONSTRAINT member_sidebar_prefs_payload_object_ck
    CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE member_sidebar_prefs IS
  'ADR-0177 D2 member-owned sidebar organization (sections, channel placement, stars). One row per (workspace, member). No outbox fan-out in v1.';
COMMENT ON COLUMN member_sidebar_prefs.member_id IS
  'Owning human member. The API path is /members/me and binds the credential''s member id; no request may name another member.';
COMMENT ON COLUMN member_sidebar_prefs.payload IS
  'ADR-0177 D3 payload v1: {version:1, sections:[{id,name,order,channelIds[]}], starredChannelIds[], sectionSort?}. Server validates shape and size caps only — channel membership is NOT verified (tolerant contract; the client filters dead ids at render time).';

ALTER TABLE member_sidebar_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_sidebar_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON member_sidebar_prefs
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
