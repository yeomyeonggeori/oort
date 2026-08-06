-- =============================================================================
-- 061_work_host_last_used.sql — ADR-0125 D6-A "마지막 사용" (#1114 잔여 ③)
--
-- D6-A 의 기본 호스트 규칙은 두 절이다: **로컬 온라인 우선 → 마지막 사용**.
-- 앞 절은 #1132 가 이식했고(`default_spawn_host`), 뒤 절은 "멤버별 마지막으로
-- 사용한 호스트"를 기록할 칸이 없어서 이탈 5 로 남았다. 이 파일이 그 칸이다.
--
-- ## work_session.started_at 로 지어내지 않는 이유 (이탈 5 의 논거 그대로)
--
-- "가장 최근 세션의 host_id" 는 픽커가 **보여주지 못하는** 세션에 기본값을
-- 의존시킨다: 남의 채널에서 돈 세션, 이미 끝난 세션, 에이전트가 소유자 대신
-- 만든 세션이 전부 같은 무게로 들어온다. 여기 쓰이는 것은 그보다 좁은 사실
-- 하나다 — **사람이 호스트를 골랐고 그 선택이 실제로 발사됐다.** 그래서 쓰는
-- 자리는 세 곳뿐이고(자동승인 디스패치 · 승인 결정 디스패치 · resume 대상),
-- 모두 "사람의 권한으로 일이 그 호스트로 갔다" 는 같은 사건이다.
--
-- ## 왜 (workspace_id, member_id) 가 PK 인가
--
-- 질문이 "이 사람의 마지막 호스트는 무엇인가" 하나뿐이라서다. 이력이 필요하면
-- audit_log 와 work_control 이 이미 전부 들고 있다 — 여기 이력을 쌓으면 같은
-- 사실의 두 번째 원장이 되고, 둘이 어긋나는 날 어느 쪽이 정본인지 아무도 모른다.
-- UPSERT 한 행이 곧 답이다.
--
-- ## 경계 (ADR-0125 D2 / ADR-0004)
--
-- 호스트 로컬 경로·환경·프로세스 상태·자격증명은 여기 들어오지 않는다. 이 표는
-- 이미 work_host 에 등록된 id 를 가리키는 참조 하나와 시각뿐이다.
-- =============================================================================

CREATE TABLE work_host_last_used (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 호스트를 고른 사람. 에이전트가 아니라 **후보 목록이 계산된 그 사람**
  -- (세션 소유자 = 에이전트의 owner human, 또는 resume 을 누른 본인)이다.
  member_id    uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  -- 등록이 삭제되면 기본값도 함께 사라진다. 해지(revoked_at)는 삭제가 아니므로
  -- 행은 남고, 후보 판정이 그 호스트를 selectable 에서 떨어뜨린다 — 기본값은
  -- "selectable 한 마지막 사용" 일 때만 쓰인다(default_spawn_host).
  host_id      uuid NOT NULL REFERENCES work_host(id) ON DELETE CASCADE,
  used_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, member_id)
);

COMMENT ON TABLE work_host_last_used IS
  'ADR-0125 D6-A 기본 호스트의 뒷절. 멤버당 한 행 — 이력이 아니라 마지막 선택.';
COMMENT ON COLUMN work_host_last_used.member_id IS
  '후보 목록이 계산된 사람(세션 소유자/resume 호출자). 요청한 에이전트가 아니다.';

CREATE INDEX work_host_last_used_host_idx
  ON work_host_last_used (workspace_id, host_id);

ALTER TABLE work_host_last_used ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_host_last_used FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON work_host_last_used
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
