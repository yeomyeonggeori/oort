# LIVE-2 핸드오프 패킷 — 웹 라이브 화면 관전(view-only display observer) UXUI 축

> 2026-08-15 Fable 발급. **성재 연속 편성 결재(2026-08-15 — LIVE-1 랜딩 시 자동 발사) 근거로 가동.** 워커: 단발 무명 Opus 5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: GitHub Issue **#1412**(status:ready — metadata-only binding). 수용기준 정본 = 본 패킷 §4.
> 근거: ADR-0165 **Accepted**(WebRTC·webrtcbin·호스트 직결 시그널링) · LIVE-1(#1409, PR #1410) 서버 계약 · `research/2026-08-15-in-chat-interactive-vm-takeover.md` §4. **control(직접 조작)·owner_only owner 예외는 스코프 밖**(LIVE-3 파도 — 성재 결재).

## 0. 발주 전 랜딩분 대조

- base = **`track/engine@7179f3e5`** (LIVE-1 #1410 squash 랜딩 HEAD, 2026-08-15).
- LIVE-1이 랜딩한 서버 계약(이 goal이 소비하는 전부): `POST …/work-sessions/{s}/display-attach`(human, observer-only) → `{display_endpoint, capability_token, display_id, mode}` · 세션 DTO `remoteDisplayAvailable` · 시그널링 프로토콜 계약=`infra/cubesandbox/display-template/template.spec.json`+`scripts/display_signaling_probe.py`(서브프로토콜·capability 제시·SDP에 application m-line 부재=view-only).
- 웹 display 렌더는 전무(그린필드) — PTY 관전(ObserverTerminal)이 유일 선례.

## 1. 미션 요약

WorkPanel/워크콘솔의 세션 상세에서, `remoteDisplayAvailable` 세션에 **"라이브 화면" view-only 관전**을 연다:

1. **momo-core 결선**: `api.ts`에 `issueDisplayAttach(workspaceId, sessionId)`(PTY `issueObserverTerminalAttach` 동형·snake_case 응답 타입) + `WorkSession.remoteDisplayAvailable` 필드.
2. **DisplayObserver 컴포넌트**(신설): capability 발급 → `display_endpoint` 시그널링 WS 직결 → RTCPeerConnection 수신 전용(recvonly) → `<video>` 렌더. **입력 이벤트를 VM으로 보내는 코드 자체를 만들지 않는다**(view-only는 산물의 부재 — ADR-0165 D4의 클라이언트 반쪽). 시그널링 프로토콜은 §0의 계약 파일이 정본 — 발명 금지.
3. **상태 어휘 재사용**: `observerStream.ts`의 `ObserverLink(live|quiet|offline|unverified)`·실패 분류(`cspBlockedHost` 포함)·재발급 루프를 display에 이식(공용화 가능하면 공용화 — 두 벌 금지).
4. **표면 결선**: `WorkSessionDetail`에 PTY 터미널 옆 display 탭/섹션(둘 다 있으면 병렬 — `remote_attach_available`과 `remoteDisplayAvailable`은 독립). 워크콘솔은 같은 Detail 재사용이라 자동.

## 2. 필독 코드 좌표 (base 기준)

- `clients/web/src/features/work/ObserverTerminal.tsx:144`(유일 선례 — capability 발급→WS 직결→렌더 수명주기)·`:357`(발급 호출)·`:398-400`(서브프로토콜 인증 WS).
- `clients/web/src/features/work/observerStream.ts` — `:154 OBSERVER_SUBPROTOCOL`·`:168 attachSocketUrl`·`:254 cspBlockedHost`·`:283 OBSERVER_FAILURE_COPY`·`:497 ObserverLink`. display 동형을 여기 또는 병렬 모듈로.
- `clients/web/src/features/work/WorkSessionDetail.tsx:929`(ObserverTerminal 유일 렌더 지점 — display 분기 자리)·`WorkPanel.tsx:589`·`workConsole/WorkConsoleRoute.tsx:470`(같은 Detail 소비 — 자동 상속 확인만).
- `packages/momo-core/src/lib/api.ts:2300-2320 WorkSession`·`:2407-2424 TerminalAttachGrant/issueObserverTerminalAttach`(display 동형의 원형).
- 서버 계약(수정 금지·참조만): `server-rust/bins/momo-server/src/routes/display_attach.rs`·`dto.rs`(DisplayAttachCapabilityResponse) · `infra/cubesandbox/display-template/template.spec.json` · `scripts/display_signaling_probe.py`(시그널링 왕복의 정본 — 모의 producer 로직 재사용 근거).
- 디자인: `docs/design-system/README.md` + momo-design-taste-web 프리플라이트(Dawn 토큰·4상태 의무·키보드/포커스).

## 3. 지켜야 할 계약

- **view-only = 코드 부재**: 입력 캡처·전송 경로를 만들지 않는다(설정·플래그로 끄는 방식 금지 — ADR-0165 D4 클라이언트 반쪽).
- **프레임 비저장**: 스크린샷·녹화·프레임 캡처 API 사용 금지(ADR-0165 D5).
- **어휘**: "라이브 화면"·"보기" — **"인수" 단어 금지**(ADR-0004 증보 3 D1: control≠인수, UI 카피 혼동 방지). 관전자 수 배지는 kind-blind 기존 계수 그대로(새 숫자 발명 금지).
- `owner_only` 세션: display 발급이 서버에서 403 — UI는 이를 4상태 중 명확한 empty/제한 상태로(오류로 위장 금지). owner 예외는 LIVE-3 파도(스코프 밖).
- 모바일 가드: RN에 attach 내부 비반입(`clients/mobile/__tests__/workConsole.test.tsx:635`) — 폰 전 범위 밖.
- **실화면 E2E는 불가**(도달성 스파이크 #1411 선행 — 성재 결재): 통합 검증은 **로컬 모의 producer**(probe의 시그널링 로직 동형)로. 실 샌드박스 주장 금지 — `runtime-unverified(live sandbox display)` 정직 라벨.
- CSP: 원격 시그널링 WS 직결의 connect-src 함정은 `cspBlockedHost` 분류로 사용자에게 정직하게 — CSP 정책 파일 변경이 필요하면 추측 수정 금지, 동결+이탈 보고(infra 경계).

## 4. 수용 기준 (계약 정본)

1. momo-core: `issueDisplayAttach`+`remoteDisplayAvailable` 결선, 타입 정합(snake_case 응답 그대로), 기존 테스트 무회귀.
2. DisplayObserver: 발급→시그널링→recvonly 트랙 렌더 수명주기, 60초 capability 재검증 루프(PTY 동형), 4상태(연결 중/라이브/끊김·재시도/불가) 전부 실장.
3. 입력 부재 증명: 컴포넌트 트리에 입력 전송 경로가 없음을 테스트로 고정(모의 producer가 입력 요청 시 UI가 보내지 않음 — probe red proof의 클라이언트 대응물).
4. `owner_only` 403·비광고 호스트 409·`remoteDisplayAvailable=false`의 각 상태가 구분 렌더(오류 뭉개기 금지).
5. 워크콘솔 표면 자동 상속 확인 + PTY 관전 무회귀(둘 다 있는 세션에서 병렬 동작).
6. 게이트: 웹 typecheck+테스트·momo-core 테스트·기존 게이트 무회귀. **design-review 에이전트 Blocker 0**(momo-design-taste-web 프리플라이트 선행).

## 5. 작업 규율

- 워크트리 `~/projects/momo-tracks/momo-worktrees/live2-web-display` · 브랜치 `feat/live2-web-display-observer` · base §0.
- 단발 무명, 중간 보고 없음, 로컬 커밋 동결만(push/PR/이슈 조작 금지). 미결 경계=동결+이탈 보고. UI 카피는 core 단일 소스(CRUN-3 규율).

## 6. 리뷰 폐곡선

동결 → Fable 기획검수 → **design-review(신선 컨텍스트, Blocker 0)** → 수리 → grok 리뷰어 C freeze → push→PR(track/engine)→CI→머지. 랜딩 시: 관전 축 "라이브 화면" 절 STATUS/overview 반영 확인. LIVE-3/4는 owner_only 예외와 함께 별도 파도(ADR-0004 증보 3 Accepted — 편성은 성재 신호).

## 7. 컨텍스트 델타

- 도달성 3형상은 미확정(스파이크 #1411 진행) — 이 goal은 UI·계약 층만 완결하고 실 샌드박스 연결은 스파이크 결과에 무결속(시그널링 URL은 서버가 주는 값을 그대로 dial).
- LIVE-1 이탈 3건은 전부 판정 완료(DEVIATION_LOG 2026-08-15) — 이 goal에 이관된 것 없음.
