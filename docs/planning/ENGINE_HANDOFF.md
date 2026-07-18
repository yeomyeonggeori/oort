# 엔진 → UXUI 핸드오프 큐

> 규칙: `docs/TRACKS.md` §4. 엔진이 랜딩한 "UI가 이제 소비할 수 있는 것"의 큐.
> 상태: `ready`(엔진 완료, UI 대기) → `proposed`(UXUI가 성재에게 제안) → `in-progress` → `done`.
> UXUI 세션은 세션 시작 시 이 파일을 읽고 ready 항목을 성재에게 "이거 구현할까요?"로 제안한다.

| # | 상태 | 엔진 완료물 | UI가 할 수 있는 것 | 계약 포인터 | 랜딩 |
|---|---|---|---|---|---|
| H-1 | `ready` | 플러그인 registry+grant+추천 REST 전체 (SE-04A/C, MOMO-458) | 마켓플레이스(#462, 현재 로컬 fixture)를 실서버 연동: 카탈로그 조회(`recommended` 필드로 추천 섹션), 설치/해제, grant 발급/회수 | `GET/POST/DELETE /v1/workspaces/:ws/plugins...` — `docs/api/openapi.yaml` 명세 완비, PluginRoutes.swift | 2026-07-17 |
| H-2 | `ready` | 채널 webhook 발급/회전/revoke + Slack-호환 수신 (SE-04B, MOMO-412) | 채널 설정의 웹훅 탭 placeholder를 실물로: 발급(one-time secret 표시 — 재조회 불가 UX 필수), 회전, revoke, 수신 URL 복사 | WebhookRoutes.swift, openapi 명세, one-time reveal 계약 | 2026-07-17 |
| H-3 | `ready` | 음성 허들 서버·인프라·macOS v0 (ADR-0122 V-1~V-3) | 허들 UI 폴리시: design High 2건(disabled 사유 키보드 접근성, 상태별 시각 증거), 실창 QA. iOS 참가(V-3b)는 엔진 트랙 예약 | HuddleRoutes.swift, MomoHuddle*.swift, compose `--profile huddle` | 2026-07-18 |
| H-4 | `ready` | 초대 단축 링크 리다이렉터 (ADR-0121 S-4 v0, MOMO-460) | 초대 발급 UI에서 단축 링크(`/i/<code>`) 복사 노출(서비스 URL은 도메인 결정 전까지 로컬) | services/LinkShort, `MOMO_LINKSHORT_TARGET_BASE_URL` | 2026-07-17 |
| H-5 | `ready` | 검색→메시지 점프 서버 한계 명시 (MOMO-448) | MOMO-386(워크스페이스 검색 v0)가 서버 FTS를 요구하면 엔진에 역요청으로 등록할 것 — 현재 로컬 검색은 정직 스코프 유지 | 이슈 #392, handoff 2026-07-17-momo-447 | 2026-07-17 |

## UXUI → 엔진 역방향 로그

| # | 상태 | UXUI에서 확인·수정한 엔진 소유 항목 | 엔진 액션 | 근거 |
|---|---|---|---|---|
| X-1 | `needs-engine-sync` | `scripts/macos_dev_run.sh`가 SwiftPM 바이너리 프레임워크·리소스 번들을 개발용 `.app`에 스테이징하도록 보완 | `track/engine`에 동일 수정 이식 후 엔진 트랙 빌드로 재검증 | LiveKit 도입 후 `@rpath/LiveKitWebRTC.framework/LiveKitWebRTC` 누락으로 앱이 시작 즉시 DYLD 종료; UXUI 트랙 `--verify` 프로세스+창 PASS (2026-07-18) |
| X-2 | `needs-engine-contract` | 메시지 반응 집계·스레드·작성자 전용 수정/삭제 UX를 구현. 실서버 REST의 `editMessage`·`addReaction`은 현재 501이고 remove/delete 계약도 없어, 네 동작 전체가 영속 가능한 백엔드에서만 UI를 노출하도록 capability gate 적용 | REST edit/add/remove/delete 명령과 권한 오류·realtime 확인 이벤트를 모두 연결한 뒤 `MomoMessageInteractionBackend` capability를 실서버에 부여 | macOS `MessageInteractionModel.swift`, `ChatViewModel.toggleReaction/deleteMessage`, `MessageInteractionTests` (2026-07-18) |
