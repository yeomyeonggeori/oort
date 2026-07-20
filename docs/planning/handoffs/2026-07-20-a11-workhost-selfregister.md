# 핸드오프 패킷 — A-11: 로컬 Mac을 work_host로 자기등록 (동생/UXUI)

- 발행: 2026-07-20, Fable (엔진 트랙)
- 대상: UXUI 트랙 (동생), track/uxui
- 선행: main `09dcb07`(A-10 + 엔진 483/484/486/487/488 전량 랜딩)
- 관련: ADR-0114(D1/D8), ADR-0125(D1 work_host), ENGINE_HANDOFF A-11, QA_FOLLOWUP Q1

## 왜 필요한가 (배경)

A-10은 483/484만 보고 구현됐다. 그 뒤 랜딩한 **MOMO-487**이 서버에 강제 규칙을 추가했다: `POST /v1/workspaces/:ws/work-controls`는 `target_host_id`가 **등록된·미revoke work_host**가 아니면 404로 거부한다.

그런데 A-10의 `MomoWorkHostIdentity.resolve()`는 로컬 랜덤 UUID를 UserDefaults에 만들 뿐 **서버에 등록하지 않는다**. 결과: 에이전트가 이 Mac을 대상으로 spawn하면 서버가 대상 host를 몰라 404 → **A-10 단독으로는 Work Console 실사용(Q1)이 라우팅되지 않는다.**

또한 AgentWorker(486)는 `MOMO_WORK_HOST_ID` 환경변수로 대상 host를 고정한다. 즉 "에이전트가 겨냥하는 host_id"와 "이 Mac이 소비하는 host_id"가 **같은 등록된 host**여야 한다.

## 수용기준

1. **자기등록**: 서버 세션 연결(로그인) 직후, 앱이 로컬 Ed25519 신원으로 `POST /v1/workspaces/:ws/work-hosts` 호출.
   - body: `{scope:"member", type:"app", displayName:<기기명 등 표시 이름>, publicKey:<32바이트 Ed25519 raw base64>, capabilities:{...선택}}`
   - **Ed25519 키페어를 로컬 생성·0600 저장**(Keychain 또는 앱 지원 디렉터리). relay/PushRelay의 로컬 키 관리가 선례. 자격증명이므로 로그·서버 원장에 개인키 절대 미유입.
   - 반환된 `work_host.id`를 이 앱의 hostId로 채택(기존 로컬 랜덤 UUID 대체). 워크스페이스별 1개 재사용(재로그인 시 기존 host 재사용 — 중복 등록 방지: 로컬에 host_id 영속 후 존재하면 재등록 생략, revoke됐으면 재등록).
2. **hostId 노출**: 설정/Work 서랍에 현재 host_id를 표시(복사 가능)해, 성재가 AgentWorker `MOMO_WORK_HOST_ID`를 이 값으로 맞출 수 있게 한다. (v0 수동 조율 — v1에서 서버가 채널 기본 host를 정하면 제거)
3. **online heartbeat (선택, 권장)**: 주기적 서명 heartbeat(`POST .../work-hosts/:id/heartbeat`, `momo.work_host.heartbeat.v1` 바이트 계약)로 online 표시. 없어도 control 라우팅은 됨(routing은 등록+미revoke만 확인) — v0는 생략 가능하나 UX상 online 배지에 권장.
4. **A-10 소비 경로 유지**: 등록 후에도 dispatched control 소비는 기존 realtime(`work.control.dispatched`, targetHostId 필터) 그대로. workd처럼 poll하지 않는다(A-10=in-app realtime 호스트).
5. **X-6 연동(엔진 랜딩 시)**: auto-approve 현재값 GET이 열리면 앱 시작 시 상태 복원에 사용(현재 `unknown` 대체). X-6은 별도 엔진 티켓 — 랜딩 전까지는 현행 유지.
6. **경계 유지**: 개인키·raw·cwd·토큰 서버 미유입 불변(A-10 기존 테스트 유지). 등록 실패 시 Work Console은 "호스트 등록 실패" 상태로 fail-closed(거짓 준비 표시 금지).

## 검증

- 계약 테스트: 등록 요청 body에 개인키·경로·토큰 부재 단정, 재로그인 시 재등록 생략, revoke 감지 시 재등록.
- macos-ui 게이트 + 실서버 smoke(등록→host_id 노출→dispatched 소비).
- 실 E2E(Q1)는 성재 수동 QA — 이 티켓 랜딩이 Q1의 선행조건.

## 포인터

- 서버: `server/Sources/MomoServer/Routes/WorkHostRoutes.swift`(register/heartbeat, Ed25519 pubkey 검증 `validatedPublicKey`), openapi
- 앱: `clients/macOS/Sources/MomoMac/MomoWorkConsoleController.swift`(`MomoWorkHostIdentity.resolve` 교체 지점, hostId 소비), `MomoServerRESTChatBackend.swift`(work REST)
- 키 관리 선례: `relay/PushRelay`(Ed25519 로컬 생성·서명)
- verifier 참고: `scripts/verify_work_host.sh`(등록·서명 heartbeat 계약)

## 하드 룰

- track/uxui에서 작업, main 머지는 성재 승인. clients/macOS만 수정(clients/Core 계약 변경 필요 시 ENGINE_HANDOFF 역요청). 개인키 커밋·로그 금지. momo-design-taste + design-review(UI 변경).
