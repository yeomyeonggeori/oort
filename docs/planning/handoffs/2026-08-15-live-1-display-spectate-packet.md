# LIVE-1 핸드오프 패킷 — T3 관전 라이브 화면(display view-only) 엔진 축 · WebRTC

> 2026-08-15 Fable 발급, **성재 발사 결재 완료(발사+연속 편성 — LIVE-2까지 자동 이어감)**. 워커: 단발 무명 Opus 5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 본 패킷 v1(noVNC 판 — 성재 결재로 WebRTC 개정)
> 정본 goal: GitHub Issue **#1409**(status:ready — metadata-only binding). 수용기준 정본은 본 패킷 §4.
> 근거: `docs/planning/research/2026-08-15-in-chat-interactive-vm-takeover.md` §4~5 후보 A + **ADR-0165 Proposed(전송=처음부터 WebRTC — 방향은 성재 결재 완료, 문서 Accept가 머지 관문)**. **control(직접 조작)·로그인 핸드오프는 스코프 밖** — ADR-0004 증보 3 Accept 대기(LIVE-3/4).

## 0. 발주 전 랜딩분 대조 (완료)

- base = **`track/engine@99d42244`** (#1369 UX4 랜딩 HEAD, 2026-08-15). HAP 축 E1~E7+UX1~4 전부 랜딩됨.
- display/VNC/WebRTC 스트림 축은 소스 전체 그레펩 **0건 실측**(2026-08-15) — 그린필드 확정, 헛발주 없음.
- 신규 마이그레이션 = **075**(engine 트랙 최신 074_hosted_agent_oauth — `scripts/check_migration_numbers.sh` 통과 필수).

## 1. 미션 요약

T3 관리형(cubesandbox) 세션의 관전을 "PTY 로그를 본다"에서 "라이브 화면을 본다(view-only)"로 올리는 **서버·기질 축** (전송=WebRTC, ADR-0165):

1. **display 바인딩 원장**: `work_session`에 `display_endpoint`(마이그 023 동형 제약 — 길이 1..2048·credential-free URL·host-signed 경로만 기록) 추가. display kind의 endpoint는 **호스트(VM)의 WebRTC 시그널링 WS URL**이다(ADR-0165 D2). 짝 식별자(`display_id`)가 시그널링 타깃 지정에 필요하면 pty_id 동형으로 — 불요 판단이면 이탈 보고로 근거를 남겨라.
2. **attach kind 축**: capability 발급·검증에 kind(`pty | display`)를 추가(기존 `terminal_attach_capability` 재사용 권고 — 별도 테이블로 가면 이탈 보고). **display는 `mode=observer`만 발급**(controller 요청은 403 — ADR-0004 증보 3 Accept 전 경계의 잠금장치, 서버 강제).
3. **DTO 투영**: `remote_display_available`(= `remote_attach_available` 동형 — raw endpoint는 세션 DTO로 비유출, capability 응답에서만).
4. **기질·workd 결선**: CubeSandbox 템플릿 사양에 WebRTC producer(Selkies-GStreamer 계열 1순위, 대안 GStreamer webrtcbin — ADR-0165 D1, 실측으로 확정하고 판단 근거를 보고) + 시그널링 WS + **view-only = 입력 datachannel 자체 미개설**(ADR-0165 D4 — 클라 플래그 신뢰 금지). workd가 display 바인딩을 host-signed 경로로 등록 + `work_host.capabilities` jsonb에 display 광고(boolean — 021 제약 준수). **광고 없는 호스트에는 display capability 발급 거부(fail-closed — BYOC 자동 배제)**.

웹 렌더(WebRTC 소비·view-only 관전 UI·design-review)는 **LIVE-2(UXUI 트랙, 별도 패킷 — 연속 편성 결재됨)**. 이 goal의 산출물은 LIVE-2가 소비할 서버·시그널링 계약 완결이다.

## 2. 필독 코드 좌표 (base 기준)

- `server-rust/crates/momo-t3/src/terminal_attach.rs` — attach 기계 전체: `:69-92 AttachMode(controller|observer)` · `:95-109 RemotePtyBinding` · `:111-133 validated_binding`(pairing+`is_credential_free_stream_url`) · `:174-200 AttachTarget/is_attachable` · `:305 issue_attach_capability_in_tx` · `:382 validate_attach_capability_in_tx` · `:48 CAPABILITY_TTL_SECONDS=60`. display는 이 기계의 kind 확장이다 — 병렬 기계를 새로 만들지 마라.
- `server-rust/crates/momo-t3/src/reattach.rs:130-166` — `REATTACH_COLUMNS`(`:155`의 `remote_attach_available` 술어가 확장 지점). 동형 사본 2곳 주의: `lifecycle.rs:475-493`(DETAIL_COLUMNS/RETURNING)·`lifecycle.rs:642-643`(list 인라인) — **세 곳 모두** 갱신하고 드리프트 테스트로 못 박아라.
- `server-rust/bins/momo-server/src/dto.rs:871-883 WorkSessionDto` · `:1000-1006 TerminalAttachCapabilityResponse`(endpoint가 나가는 유일한 곳 — "momo never proxies" 주석이 계약: **서버는 시그널링도 미디어도 비경유**) · `routes/terminal_attach.rs:127 issue`·`:306 validate` · `routes/work_sessions.rs:171-175/:372-376`(human-bearer 경로의 binding 거부 — display도 동일 거부) · 라우트 등록 `lib.rs:659-660/:830-831`.
- `server/Migrations/023_terminal_attach.sql:10-23` — pty 바인딩 컬럼·체크 제약의 원형(075는 이것의 display 동형) · `021_work_host.sql:23`(`type IN ('app','workd','cloud')`)·`:28-35`(capabilities jsonb boolean 제약).
- `server-rust/crates/momo-t3/src/provider/cubesandbox.rs:356-380 create_body`(`templateID` 선택 지점 — producer 탑재 템플릿은 여기서 갈린다) · `provider/registry.rs:46 CUBESANDBOX_PROVIDER_ID`·`:29 BYOC_PROVIDER_ID`·`:249-256 environment_keys(…_IMAGE_REF)` · `provision.rs:180 can_create`.
- 클라 계약 소비자(참고 — LIVE-1은 수정 금지): `packages/momo-core/src/lib/api.ts:2300-2320 WorkSession`·`:2407-2424 TerminalAttachGrant/issueObserverTerminalAttach` · `clients/web/src/features/work/observerStream.ts:154 OBSERVER_SUBPROTOCOL="momo.terminal.v1"`·`:168 attachSocketUrl`·`:254 cspBlockedHost`.
- conformance 선례: `server-rust/crates/momo-t3/tests/cubesandbox_conformance.rs` · `bins/momo-server/tests/cloud_provisioner_conformance_pg.rs`.

## 3. 지켜야 할 계약

- **호스트 직결 토폴로지 유지**(ADR-0165 D2): 서버는 capability 토큰+시그널링 endpoint 발급까지만. 시그널링·미디어의 서버 경유(프록시/SFU) 금지.
- **view-only는 producer 층에서 강제**(ADR-0165 D4): view-only 발급에 입력 datachannel 미개설. 클라이언트 플래그 신뢰 금지.
- **ICE 경계**(ADR-0165 D3): 1차는 직결/host-reflexive ICE. 제3자 TURN 금지 — TURN 필요가 실측되면 동결+보고(oort 운영분 도입은 ADR 증보 사안).
- **프레임 비저장**(ADR-0165 D5): 서버·원장·audit에 프레임 비유입. 녹화 금지.
- 관측 권한 = 기존 `observation(open|owner_only)`·observer capability 계수 그대로(신규 권한 모델 발명 금지).
- 하드 불변식: 단일 쓰기경로(REST→PG→outbox→relay)·RLS FORCE·`schema_v0.sql` 불가침·시크릿 커밋 금지·provider 자격 비유입(ADR-0004).
- 마이그레이션 075 단일·번호 스크립트 통과. `terminal_attach_capability` 기존 행·검증 무회귀(pty 경로 기존 verifier green 유지).
- 모바일 가드 준수: RN 클라에 attach 내부 비반입(`clients/mobile/__tests__/workConsole.test.tsx:635`) — 폰은 전 범위 밖.
- 함정: ①**풀 microVM WebRTC는 선례가 얇다**(Selkies는 컨테이너 중심) — producer 선택·기동은 실측 근거로, 로컬에서 실 CubeSandbox 템플릿 빌드·기동이 불가능하면 **계약·모의 시그널링으로 증명하고 `runtime-unverified(cubesandbox webrtc producer)` 정직 라벨**(E5 교훈 — 추측 성공 주장 금지) ②microVM→전용 호스트의 포트 노출(시그널링 WS·ICE/UDP)은 실측 항목 — 불가 판정도 근거와 함께 보고 ③CSP/connect-src의 원격 시그널링 직결 실측은 LIVE-2 소관(observerStream.ts:254 참고만) ④테스트 캔어리는 결정적 단언만(확률적 텍스트 매칭 금지).

## 4. 수용 기준 (계약 정본)

1. 마이그 075: display 바인딩 컬럼+제약(023 동형) — 적용·롤포워드 검증.
2. host-signed 경로로만 display 바인딩 기록, human-bearer는 거부(기존 pty 거부 동형).
3. capability: kind=display·mode=observer 발급/검증 성립, **mode=controller 요청은 403**, 비광고 호스트·BYOC provider엔 발급 거부(fail-closed).
4. `remote_display_available` 투영이 REATTACH/DETAIL/list **3곳 동형** + 드리프트 방지 테스트.
5. CubeSandbox 템플릿 사양에 WebRTC producer+시그널링 WS+view-only(입력 채널 미개설) 결선 + workd 등록 경로. 실기동 불가 시 §3 정직 라벨 + **로컬 모의 시그널링 왕복**(두 피어 로컬)으로 계약 증명.
6. 신규 `scripts/verify_display_attach.sh`(소유권 계약: 호출 라벨+trap+부재 증명) — 3의 발급/거부 매트릭스+4의 투영을 커버. 기존 verifier(terminal attach·agent port·reattach) 무회귀.
7. 게이트: workspace clippy `-D warnings`·전체 테스트·소유 파일 fmt·마이그 번호. **로컬 docs gate 실행 금지**(#1376) — 문서 정확성은 PR CI 관문.

## 5. 작업 규율 (E6 동형)

- 워크트리 `~/projects/momo-tracks/momo-worktrees/live1-display-spectate` · 브랜치 `feat/live1-display-spectate` · base `track/engine@99d42244`.
- 단발 무명, 중간 보고 없음, **로컬 커밋 동결만**(push/PR/머지/이슈 조작 금지). 미결 경계 결정은 추측 금지 — 동결+이탈 보고.
- 문서: STATUS 절·`docs/architecture/overview.md` 관전 절·OpenAPI·CURRENT_STATE(engine 계보) supersede.

## 6. 리뷰 폐곡선

구현 동결 → Fable 기획검수(C/H/M) → 수리 → **grok 리뷰어 C freeze**(C0/H0/M0 — sol usage-limit 8/20까지) → push→PR(base track/engine)→CI→머지. **머지 전 ADR-0165 문서 Accept 확인**(전송 스택 경계 — 방향 결재는 완료됨, E7의 ADR-0162 증보 1 선례). 랜딩 시 **연속 편성 결재에 따라 LIVE-2(UXUI: 웹 WebRTC 소비·view-only 관전 UI·design-review Blocker 0) 패킷 발급+발사** — LIVE-3(control)·LIVE-4(로그인 핸드오프)는 ADR-0004 증보 3 Accept 후.

## 7. 컨텍스트 델타

- 전송은 성재 결재로 **noVNC 권고를 기각하고 WebRTC 직행**(ADR-0165) — 리서치 정본 §4의 "noVNC 1차" 권고는 이 결재로 superseded.
- 이 goal은 ADR-0004 증보 3(Proposed)의 **선행 조각 A**다 — 경계는 "display 발급이 observer 한정임을 서버가 강제"하는 것으로 지켜지고, controller 개방은 증보 Accept 후 별도 goal이다.
- HAP 다이얼인 봇(Grok 등)의 화면은 provider VM이라 이 축 밖(관측 프록시도 provider API 없이는 불가 — 08-12 판정).
