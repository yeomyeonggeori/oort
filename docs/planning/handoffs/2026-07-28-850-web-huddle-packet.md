# goal #850 — MOMO-643: 웹 허들 복원 (시작·참가·나가기·live 배지)

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/uxui`.** 모델: gpt-5.6-sol medium.

## 0. 착수 전 필수
1. `git status` clean 선검사. `pwd` 확인.
2. **자격증명 탐색 금지. `.env` 읽기 금지.** 시크릿 커밋 금지.
3. **PR 생성 후 STOP. merge/close 금지.**
4. `npm run typecheck`·`npm test`·`npm run build`·lint·preflight는 돌려라. Playwright 게이트·실오디오는 오케스트레이터 몫 — 명령줄만 PR에 적어라.
5. **심볼·필드는 쓰기 전에 grep으로 실재 확인.** 아래 계약은 오케스트레이터가 코드에서 확인한 것이지만 네가 재확인해라.

## 1. 서버 계약 (검증 완료 — 이대로다)
- REST 4종(`HuddleRoutes.swift`): `POST /v1/workspaces/:ws/channels/:ch/huddles`(start) · `POST /v1/workspaces/:ws/huddles/:huddle/join` · `POST /v1/workspaces/:ws/huddles/:huddle/leave` · `GET /v1/workspaces/:ws/channels/:ch/huddles/active`.
- DTO: `HuddleDTO { id, workspaceId, channelId, startedBy, startedAtMs, endedAtMs?, participants[{memberId, displayName, joinedAtMs}] }`.
- **join 응답이 `livekitUrl`을 준다**: `{ huddle, livekitUrl, token, expiresAtMs, ttlSeconds }`. **LiveKit 주소를 serverBase에서 유도하지 마라** — ADR-0110과 동형으로 서버가 유일한 주소 권위다.
- leave 응답 `{ huddle, ended: Bool }` — 마지막 참가자 퇴장 시 `ended:true`. 이 전이를 화면에 반영해라.
- **미구성 시 전 허들 API가 503 `허들 미구성`** (fail-closed). 이건 오류가 아니라 **상태**다 — self-host 운영자가 LiveKit을 안 켠 것. 고장처럼 보이게 하지 마라.
- 실시간: relay가 채널 토픽으로 **`huddle_started` · `huddle_participants_changed` · `huddle_ended`** 를 보낸다(`clients/Core/RealtimeEnvelope.swift:44-46`이 정본 이름). `clients/web/src/lib/realtime.ts`에 이 3종 파서를 추가해라 — 기존 `work.session.*` 파서들과 같은 방어적 스타일(타입 전도 시 null)로.

## 2. 만들 것
1. **채널 헤더 허들 표면**: 시작 / 활성 허들 참가 / 나가기. 활성 시 live 배지 + 참가자(displayName). 상태 4종 — 미구성(503) · 활성 없음 · 참가 중 · 오류.
2. **LiveKit 오디오만**: `livekit-client`(npm, Apache-2.0)를 추가하되 **xterm과 같은 lazy-load 패턴**(`terminalRuntime.ts:1-27` 주석이 이유까지 적어둔 선례)으로 코드 스플릿해라 — 허들을 안 여는 사람에게 0 비용. CDN·원격 자산 금지(CSP `script-src 'self'`; `connect-src`는 넓어서 LiveKit ws 연결은 통과한다).
3. 참가 중 탭/앱 이탈 시 **leave 보장**(macOS `MomoHuddleLiveKitSession.swift`가 leave/disconnect 보장을 어떻게 했는지 참조). 토큰 ttl 만료 전 재발급은 v0 범위 밖 — 만료 시 정직하게 끊겼다고 말해라.
4. **관리자 아님·오프라인·마이크 권한 거부** 각각의 상태를 침묵 없이 말해라.

## 3. 함정 (레포가 이미 답을 적어둔 것 — 다시 밟지 마라)
- 다이얼로그는 **열려 있는 동안만 마운트**(`CreateChannelDialog.tsx:402`). `DialogContent`에 `opener` prop 있다. 설정 라우트 Escape 리스너와의 충돌은 `PluginSection.tsx` 동의 다이얼로그가 선례. 진행 중 컨트롤은 disabled가 아니라 `aria-busy`(`tokens.md §5b` — 흐림 2.2:1 회귀 금지).
- **게이트가 목 타이밍 덕에 초록이 되게 하지 마라** — #839에서 두 번 당했다. 활성 허들 픽스처는 응답 지연을 어긋나게 하는 케이스를 포함해라.
- **Tauri WKWebView 마이크**: `getUserMedia` 권한이 셸에서 다르게 동작할 수 있다. **네가 해결하려 하지 마라** — 브라우저 경로만 구현하고, 셸 실측은 오케스트레이터 몫으로 PR에 명시해라(NSMicrophoneUsageDescription 등 셸 변경이 필요해 보이면 **고치지 말고 보고**).

## 4. 검증
- typecheck · test(무회귀) · build · preflight 10/10 · **`gate:wire`/`gate:shell`/`gate:csp` 무회귀**(오케스트레이터 실행).
- **게이트로 잠글 것**: 미구성 503이 고장이 아니라 상태로 렌더됨 · 활성 허들 배지·참가자 · `huddle_ended` 수신 시 배지 소멸. **레드 증명 절차 명시.**
- design-review는 오케스트레이터가 fresh context로 돌린다.

## 5. PR
`feat/850-momo-643-web-huddle` → `track/uxui`. 본문: 상태 4종 스크린샷 경로, lazy-load 번들 크기 전후, 셸 마이크 이슈 보고, 오케스트레이터 실행 명령줄, 계획 이탈. **PR 후 STOP.**
