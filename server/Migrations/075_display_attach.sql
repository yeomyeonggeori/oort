-- =============================================================================
-- 075_display_attach.sql — LIVE-1 / ADR-0165 (전송 = WebRTC) + ADR-0125 D10
--
-- 023 은 원격 PTY 한 쌍(`pty_id` + `attach_endpoint`)을 원장에 넣었다. 이 파일은
-- 그 동형을 **화면**에 대해 한 번 더 놓는다: `display_id` + `display_endpoint`.
-- 두 쌍은 같은 문장을 지킨다 — 원장에 들어가는 것은 **어디에 붙는가**뿐이고,
-- 바이트는 들어가지 않는다. PTY 는 터미널 바이트를, display 는 미디어 프레임을
-- 서버·원장·audit 어디에도 남기지 않는다(ADR-0165 D5).
--
-- display kind 의 endpoint 는 호스트(VM)의 **WebRTC 시그널링 WS URL** 이다
-- (ADR-0165 D2). 서버는 시그널링도 미디어도 경유하지 않으므로, 이 칸이 담는
-- 것은 브라우저가 직접 dial 할 credential-free URL 하나다 — 023 의
-- `work_session_attach_endpoint_ck` 와 같은 길이 상한, 같은 문법.
--
-- ## capability 는 새 표가 아니라 kind 한 칸이다
--
-- `terminal_attach_capability` 에 `kind` 를 더한다. 병렬 표를 만들면 만료·sweep·
-- RLS·revoke 조인이 두 벌이 되고, 그중 하나가 낡는 날 "관전을 끊었다"가 절반만
-- 참이 된다. 기존 행은 전부 PTY 이므로 DEFAULT 'pty' 가 곧 사실이다.
--
-- ## 마지막 절이 이 파일의 핵심이다
--
-- `terminal_attach_display_observer_ck` 는 **display capability 는 observer 로만
-- 존재할 수 있다**를 DB 에서 강제한다. control(입력) 경계는 ADR-0004 증보 3 의
-- Accept 전이고, 그 전까지 controller 발급을 막는 잠금장치는 라우트 한 줄이
-- 아니라 스키마여야 한다 — 라우트는 다음 배치가 실수로 지나칠 수 있지만
-- CHECK 는 그럴 수 없다. 경계가 열리는 날 이 절을 지우는 것이 그 결정의
-- 실행 지점이 된다.
-- =============================================================================

ALTER TABLE work_session
  ADD COLUMN display_id text,
  ADD COLUMN display_endpoint text,
  ADD CONSTRAINT work_session_remote_display_pair_ck CHECK (
    (display_id IS NULL AND display_endpoint IS NULL)
    OR (display_id IS NOT NULL AND display_endpoint IS NOT NULL)
  ),
  ADD CONSTRAINT work_session_display_id_ck CHECK (
    display_id IS NULL OR display_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  ADD CONSTRAINT work_session_display_endpoint_ck CHECK (
    display_endpoint IS NULL OR length(display_endpoint) BETWEEN 1 AND 2048
  );

ALTER TABLE terminal_attach_capability
  ADD COLUMN kind text NOT NULL DEFAULT 'pty',
  ADD CONSTRAINT terminal_attach_capability_kind_ck CHECK (kind IN ('pty', 'display')),
  ADD CONSTRAINT terminal_attach_display_observer_ck CHECK (
    kind <> 'display' OR mode = 'observer'
  );

-- 024 의 observer 인덱스 동형. display 발급/무효화가 PTY 관전 조회와 같은
-- 인덱스를 놓고 다투지 않도록 kind 로 좁힌 부분 인덱스를 따로 둔다.
CREATE INDEX terminal_attach_display_expiry_idx
  ON terminal_attach_capability (work_session_id, expires_at DESC)
  WHERE kind = 'display';
