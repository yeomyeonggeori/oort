-- =============================================================================
-- 114_work_session_share.sql — #2862 / ADR-0190 증보 D4-b (Accepted) + ADR-0194 D4·D8·D9
--
-- 「공유」 L 세션(origin = 'local_pty', 113)의 공유 범위 S1 확장. 주인 기기가 host
-- 서명 PATCH 로 올리는 것만 담는다: 저장소 표시 이름·브랜치·하네스·파생 상태·단계
-- 표지·diff 숫자·PR URL·마지막 활동 시각. 커밋 제목·파일 이름·경로·원격 URL·raw 출력은
-- 컬럼이 없다(없는 필드는 보낼 수도, 저장될 수도 없다).
--
-- 저장: 새 테이블 `work_session_share`(세션당 한 행). 해제와 보존 삭제가 행 삭제 하나로
-- 끝나고 `work_session` 원장 컬럼과 섞이지 않는다. RLS FORCE 대상이다.
--
-- 같은 파일에서 `work_session.tool` CHECK 도 넓힌다(ADR-0190 D3: L 칸 하네스의 정본은
-- 로컬 감지이고 `grok`·`other` 가 닫힌 목록에 있다).
-- =============================================================================

-- ---- tool CHECK 확장 ---------------------------------------------------------
ALTER TABLE work_session DROP CONSTRAINT work_session_tool_ck;
ALTER TABLE work_session
  ADD CONSTRAINT work_session_tool_ck
    CHECK (tool IN ('claude', 'codex', 'opencode', 'shell', 'grok', 'other'));

-- 복합 FK 의 대상(workspace_id 가 어긋난 share 행을 구조적으로 막는다). id 는 이미 PK 라 유일.
ALTER TABLE work_session
  ADD CONSTRAINT work_session_workspace_id_id_uk UNIQUE (workspace_id, id);

-- ---- 단계 표지 검증 함수 -----------------------------------------------------
-- 개수 ≤ 12, 각 문자열 1..80자, 제어 문자(ESC 포함) 없음. CHECK 안에서는 서브쿼리를 못 쓰므로
-- 함수로 둔다(IMMUTABLE: 입력만 읽는다).
CREATE FUNCTION work_session_share_stage_markers_ok(markers jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT jsonb_typeof(markers) = 'array'
     AND jsonb_array_length(markers) <= 12
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(markers) AS e(v)
        WHERE jsonb_typeof(e.v) <> 'string'
           OR char_length(e.v #>> '{}') NOT BETWEEN 1 AND 80
           OR (e.v #>> '{}') ~ '[[:cntrl:]\u00ad\u061c\u2028-\u202e\u2060-\u206f/\\]'
     )
$$;

-- ---- 테이블 ------------------------------------------------------------------
CREATE TABLE work_session_share (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL,
  -- 저장소 표시 이름: 최상위 폴더의 마지막 요소만. 경로 구분자·제어 문자 불가.
  -- NULL = 모름(git 저장소가 아닌 폴더의 셸 칸). core ShareSummaryS1.repo 와 같다.
  repo_label      text,
  -- NULL = 분리된 HEAD. 절대 경로처럼 보이는 값(/ ~ 로 시작, 드라이브 문자, 역슬래시) 불가.
  branch          text,
  harness         text NOT NULL,
  derived_state   text NOT NULL,
  stage_markers   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- diff 숫자만(integer 범위 안의 0 이상). NULL = 모름. 파일 이름 컬럼은 없다.
  diff_added      integer,
  diff_deleted    integer,
  diff_files      integer,
  commits_ahead   integer,
  commits_behind  integer,
  uncommitted     integer,
  -- 한 줄 URL. 형식 검증의 정본은 서버 코드(허용 호스트는 설정). 여기는 모양만 한 번 더 잠근다.
  pr_url          text,
  last_activity_at timestamptz,
  shared_at       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id),
  FOREIGN KEY (workspace_id, session_id)
    REFERENCES work_session (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT work_session_share_repo_label_ck CHECK (
    repo_label IS NULL OR (
      length(btrim(repo_label)) BETWEEN 1 AND 100
      AND repo_label !~ '[/\\[:cntrl:]\u00ad\u061c\u2028-\u202e\u2060-\u206f]'
    )
  ),
  CONSTRAINT work_session_share_branch_ck CHECK (
    branch IS NULL OR (
      length(btrim(branch)) BETWEEN 1 AND 200
      AND branch !~ '[\\[:cntrl:][:space:]~^:?*\[\u00ad\u061c\u2028-\u202e\u2060-\u206f]'
      AND branch !~ '^[/~]'
      AND branch !~ '^[A-Za-z]:'
    )
  ),
  CONSTRAINT work_session_share_harness_ck
    CHECK (harness IN ('claude', 'codex', 'grok', 'opencode', 'shell', 'other')),
  CONSTRAINT work_session_share_state_ck CHECK (
    derived_state IN ('waiting', 'running', 'review', 'idle', 'done', 'stopped')
  ),
  CONSTRAINT work_session_share_stage_markers_ck
    CHECK (work_session_share_stage_markers_ok(stage_markers)),
  CONSTRAINT work_session_share_numbers_ck CHECK (
    (diff_added IS NULL OR diff_added >= 0)
    AND (diff_deleted IS NULL OR diff_deleted >= 0)
    AND (diff_files IS NULL OR diff_files >= 0)
    AND (commits_ahead IS NULL OR commits_ahead >= 0)
    AND (commits_behind IS NULL OR commits_behind >= 0)
    AND (uncommitted IS NULL OR uncommitted >= 0)
  ),
  CONSTRAINT work_session_share_pr_url_ck CHECK (
    pr_url IS NULL OR (
      length(pr_url) <= 300
      AND pr_url ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[1-9][0-9]{0,8}$'
    )
  )
);

COMMENT ON TABLE work_session_share IS
  'ADR-0190 D4-b / ADR-0194 D9: 공유 L 세션의 S1 확장(세션당 한 행). 커밋 제목·파일 이름·경로·원격 URL·raw 출력 컬럼 없음. 해제·보존(종료 30일) 삭제는 행 삭제.';

-- 이 테이블은 origin = 'local_pty' 세션에만 달린다. 라우트가 먼저 거절하지만, 어떤 경로로
-- INSERT/UPDATE 해도(워커·배치·미래의 라우트) 같은 거절을 하도록 트리거로도 막는다.
CREATE FUNCTION work_session_share_local_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.work_session ws
     WHERE ws.id = NEW.session_id
       AND ws.workspace_id = NEW.workspace_id
       AND ws.origin = 'local_pty'
  ) THEN
    RAISE EXCEPTION 'work_session_share applies to local_pty sessions only (ADR-0194 D4)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER work_session_share_local_only
  BEFORE INSERT OR UPDATE OF session_id, workspace_id ON work_session_share
  FOR EACH ROW EXECUTE FUNCTION work_session_share_local_only();

-- ---- RLS FORCE ---------------------------------------------------------------
ALTER TABLE work_session_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_session_share FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON work_session_share
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
