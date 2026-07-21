# MOMO-511-U 핸드오프: macOS SwiftTerm 원격 터미널 attach (D10 UXUI 절반)

> 발급: 2026-07-21 Fable (성재 위임: "UXUI트랙 fleet 진행"). 엔진 절반(511-E)은 main 랜딩·runtime-verified 완료 — 이 goal은 그 계약의 **클라이언트 소비**만.
> 트랙: UXUI · base = track/uxui · PR base = track/uxui · 도메인 = clients/macOS (+Core 필요 시 가산만)

## 목표
성재 숙원의 마지막 클라 퍼즐: T2/T3(원격 호스트·클라우드 샌드박스)의 work_session을 macOS Work 서랍에서 **실제 인터랙티브 TUI로** 본다. 로컬 T1과 동일한 SwiftTerm 뷰, 백엔드만 원격 attach.

## 서버 계약 (이미 main에 있음 — 수정 금지, 소비만)
- `POST /v1/workspaces/{ws}/work-sessions/{sid}/terminal-attach` (openapi.yaml:1134) → `{attach_endpoint, capability_token, pty_id}` 정확히 3필드, **60초 grant**. 세션 소유자 human bearer 전용.
- 오류: 400 잘못된 id / 403 비인간·비소유자 / 404 없음 / 409 세션 종료·PTY 미결속·host revoked / 429.
- **클라이언트는 attach_endpoint에 직접 연결**(WSS/HTTPS) — momo 서버/relay는 PTY 바이트를 절대 중계하지 않는다(ADR-0125 D10, ADR-0004).

## 구현 범위
1. **원격 attach 백엔드**: 기존 `MomoLocalTerminalSession`(로컬 PTY)과 동일한 인터페이스의 `MomoRemoteTerminalSession` — capability 발급 REST 호출 → attach_endpoint에 WebSocket 연결(`capability_token`은 헤더/첫 프레임, URL 쿼리 금지) → stdout 스트림을 SwiftTerm feed로, 키입력을 send_stdin 프레임으로, 뷰 리사이즈를 resize 프레임으로. 프로토콜 프레임은 E2B pty 의미론(create/connect/send_stdin/resize/kill)의 클라측 대응 — 서버가 정한 계약 외 필드 추가 금지.
2. **Work 서랍 통합**: work_session 카드가 원격 PTY 결속(remote binding) 세션이면 "터미널 열기" 액션 노출 → 서랍 터미널 탭이 로컬/원격을 동일 UI로 렌더. 원격 표시는 호스트 표시명 배지 하나만(과시 금지).
3. **수명주기·오류 UX**: 60초 grant 만료 전 연결, 연결 실패/만료/revoked(409)/네트워크 단절 각각에 대해 서랍 안 인라인 배너(재시도 액션 포함, 토스트 금지). 세션 ended → 터미널 read-only 종료 상태. 창 닫힘/앱 종료 시 소켓 정리.
4. **보안 경계(하드)**: capability_token·attach_endpoint를 로그·원장·UserDefaults에 절대 남기지 않는다. 토큰은 메모리 전용, 재연결은 재발급 REST로.

## 수용 기준
- 단위: capability 발급→연결 상태기계(성공/만료/403/409/단절) 테스트, 토큰 비영속 단정, 프레임 인코딩 테스트.
- mock attach 서버(로컬 WebSocket)로 stdout 렌더·stdin 왕복·resize 반영 테스트.
- 기존 macOS 전체 테스트 회귀 0. momo-design-taste 준수(§0 Design Read 라인 필수, 서랍 UI는 기존 토큰만).
- 실 E2B/원격 호스트 실증은 오케스트레이터/성재 수동 게이트(worker 범위 아님) — STATUS에 `runtime-unverified`로 명시.

## 규율
- 커밋 자주(생존), PR 생성 후 멈춤, merge/close 금지. docker/xcodebuild/시뮬레이터 실행 금지(오케스트레이터 몫). schema/server/relay 수정 금지 — 서버 코드가 필요해 보이면 STATUS에 역요청 기록.
