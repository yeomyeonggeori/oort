# 기획 세션 저널 (newest-first, 기존 항목 불변)

> 목적: **기획/오케스트레이션 세션 간 이어달리기.** Fable이든 GPT 5.6이든, 세션을 시작할 때 최근 항목을 읽고, 끝낼 때 항목을 추가한다(`docs/planning/README.md` §1).
> 규칙: 항목당 5줄 이내. 새 항목은 맨 위에 추가하고 기존 항목은 수정하지 않는다. 결정·증거·계획의 정본이 아니다(그건 ADR/STATUS/ROADMAP) — 여기는 "무엇을 하다 어디서 멈췄나"만. 최신이 위.

---

## 2026-07-13 (Codex worker) · MOMO-368 온보딩/로그인 재구성
- 560pt 중앙 단일 구성, 입력 상태 기반 데모/로그인 primary 1개, 낮은 위계의 초대·Keychain·로컬 알파 채우기, Tab/Enter/Esc 및 오류·오프라인 복구를 구현했다.
- 계획 이탈: 없음. 최초 디자인 리뷰 Blocker 1(커스텀 field chrome 설명 부재)과 High 2(오프라인 복구·accent 불일치)는 네이티브 편집 동작 유지 설명, transport/auth 분류+직접 데모, 공용 tint로 해소했다.
- 5개 Swift 패키지 build와 Core 23/server 73/relay 2/worker 29/macOS 비이미지 122 tests, fresh design-review(Blocker 0/High 0/Medium 1) PASS; 기존 headless image snapshot signal 5는 재현됐다.
- 신규 정본 light/dark PNG 4건 재기록과 clean/root `macos-ui`는 오케스트레이터 대기다. DB/Docker/verifier/`local_gate.sh`는 미실행(`runtime-unverified`).

## 2026-07-13 (momo-main/Fable) · Work v0 + Wave 2 배치 종결 (362..367) + 라이브 반영
- merge 순서: 362 `2d5b2ad` → 366 `69facce` → 363 `44f8d35` → 365 `f5aba9f` → 364 `adf159f`(High 반려: 종결 run ephemeral 가림) → 367 `fd8eabe`(스펙 변경 ⌥⇧↑↓ `d9f4e68` + 364와 7파일 rebase는 worker 위임). root full gate 2종 green(`…075706Z…-ra6804669e978`, `…080432Z…-r6738c50ddf08`).
- 교훈: rebase union 해소 후 전 패키지 빌드 검증 필수(Theme/Core brace 유실 2건 수기 수리 전례), 실충돌 다수 rebase는 맥락 가진 worker에 위임이 정확.
- 라이브 반영: dogfood Centrifugo `allow_user_limited_channels` 패치·재기동, server/relay/worker 신 바이너리 재기동(구 프로세스 SIGKILL 정리), read-state 벌크 라이브 확인(201:2/202:6), 앱 재빌드(pid 73174).
- Work 데모 잔여 1: codex 에이전트 시드는 dogfood DB 직접 쓰기 거부(정책 일관) — 성재 opt-in SQL(scratchpad `seed-codex-agent.sql`) 후 credential 발급·codex-workbench 기동은 오케스트레이터 몫. 데모 워크스페이스 `~/momo-workbench-demo` 준비됨.
- 다음: 성재 육안(전체 UI+unread+Cmd+K) → codex 시드 → /work 실데모 → Phase A 운영 단계(GHCR publish·EC2).

## 2026-07-13 (Codex worker) · MOMO-367 rebase on MOMO-364
- `origin/main` `adf159f` 위로 rebase해 Work 카드·컴포저·`⇧⌘W`와 unread·mark-read·`⌥⇧↑↓` union을 보존했다.
- 5개 Swift package build, Core 23 tests, macOS 비이미지 116 tests와 MOMO-367 snapshot 클래스는 green이다.
- 필터 없는 macOS test는 main 기존 `AgentCredentialSnapshotTests`의 headless 1x/정본 2x `NSImage` fatal로 중단; 정본 재기록은 오케스트레이터 대기다.

## 2026-07-13 (Codex worker) · MOMO-367 review spec correction
- 계획 이탈: planner 승인(momo-main/Fable)에 따라 unread 순회를 macOS 텍스트 선택과 충돌하는 `⇧⌘↑↓`에서 Slack 문법 `⌥⇧↑↓`로 변경했다.
- BUILD_TICKETS 정본 문구 갱신과 신규 light/dark PNG 기록은 오케스트레이터 대기다.

## 2026-07-13 (momo-main/Fable) · UI Wave 1 종결 (358 랜딩) + Work v0·Wave 2 발급
- MOMO-358 랜딩: 리뷰 High(⌘1..9 서수 술어 ≠ 사이드바 표시 술어) 반려→공용 ordered source 공유+Cmd+K 토글(`b261aea`), 스위처 정본 4종 재기록·육안 확인, clean gate PASS, PR #356 merge(`5ac5fa9`) — **W1 종결(357/358/359)**. root runtime-agent PASS(`…20260713T050905Z…-r3cfb32a2aaf2.md`); root macos-ui는 이 정본화 커밋이 게이트 중 root를 dirty로 만들어 1회 FAIL(자충수) → 커밋 후 재실행.
- ADR-0111·0109 파생 배치 발급: 패킷 2종(agent-work-surface, ui-wave2-unread) + BUILD_TICKETS 362..367 수용기준. 선행 362(work run 계약)·366(read-state 계약) 스폰, 363/364/365/367은 선행 랜딩 후.
- 다음: root macos-ui 재실행 green 확인 → 362/366 랜딩 사이클 → 성재 육안(새 UI + Cmd+K는 라이브 앱 재빌드 필요).

## 2026-07-13 (Codex worker) · MOMO-358 fresh review fix
- 사이드바·퀵 스위처·`Cmd+1...9`가 non-archived 일반 채널→DM ordered source를 공유하게 하고 `Cmd+K` 재입력 닫힘을 추가했다.
- 후속 기록(이 PR 수정 금지): AGENT 배지 공용화, 패널 radius 14 분화, SF Symbol 혼용, 에러 원문 덤프 노출, viewport 높이 과소평가.
- 정본 light/dark PNG 재기록과 DB/Docker/verifier/gate는 계속 오케스트레이터 대기다.

## 2026-07-13 (momo-main/Fable) · UI W1(357/359)+Phase A(360/361) 랜딩 — 358만 잔여
- merge 순서: MOMO-360 `6980e64` → 361 `1c044e6` → 359 `6b75260`(Blocker 반려 1회: 복사 칩 `.opacity` 밖 상시 노출 → 수정 후 timeline+bubble 정본 재기록) → 357 `94e9244`(High 반려 1회: 멤버 mutation 비마우스 경로 → context menu 복원, Theme은 354 adaptive 토큰과 union). root runtime-agent+macos-ui full gate green(`…20260713T041003Z…`, `…20260713T041531Z…`).
- 게이트 운영 교훈: 워크트리 macos-ui는 compose 스택 필요 — 수동 `up`은 Centrifugo fingerprint 부재로 drift guard FAIL(→`MOMO_CENTRIFUGO_AUTO_RECREATE=1` recreate), verifier는 api 포트 비점유 필요(compose api/relay/worker stop 후 실행). worker capacity/스트림 오류 3회는 전부 세션 resume으로 복구.
- MOMO-358(Cmd+K, `#351`) 스폰 — W1 잔여 1건. 랜딩 시 W1 종결 → Work 배치(362..365)+Wave 2(unread) 발급 조건 충족.
- 다음: 358 랜딩 사이클, 라이브 앱 재빌드로 성재 육안 확인(새 사이드바·타임라인), Work/Wave 2 티켓 발급.

## 2026-07-13 (Codex worker) · MOMO-357 fresh review fix
- 멤버 context menu에 add/remove를 추가해 키보드·VoiceOver mutation 경로를 복원하고, workspace gear의 비가시 hit-test/accessibility를 차단했다. 개명 전 고아 snapshot PNG 2장도 삭제했다.
- 후속 기록(이번 PR 수정 금지): profilePresenceBadge의 "나" 추정 휴리스틱, 비적응형 white `subtlePanelBorder`, 앱 전역 radius scale 통합.
- 검증 후 같은 브랜치에 push하고 PR #355는 `status:needs-review`에서 유지한다. 신규 light/dark PNG 정본은 오케스트레이터 재기록 대기다.

## 2026-07-13 (Codex worker) · MOMO-357 UI W1 셸·사이드바
- `NavigationSplitView` 폭 토큰과 워크스페이스/채널/DM/멤버 계층, 하단 승인·개발 유틸리티, hover 멤버 액션, server-roster presence 숨김을 구현했다.
- 계획 이탈: repo 전체 design pre-flight는 티켓 밖 기존 view의 fixed font 41건을 반환한다. 변경 파일은 0 hit이며 MOMO-359 경계인 `MessageListView`/`MessageBubble` 등은 수정하지 않았다.
- 검증: macOS build, 비스냅샷 82 tests, light/dark raster 1 test PASS. 새 light/dark 정본 PNG는 reference-wait skip, 전체 snapshot은 기존 host signal 5로 오케스트레이터 대기(`runtime-unverified`).
- 다음: fresh design-review 후 worker PR handoff; 오케스트레이터가 정본 PNG 재기록과 clean `macos-ui` gate를 수행한다.

## 2026-07-13 (Codex worker) · MOMO-360 GHCR 이미지 발행
- api/relay/worker는 공용 Swift Dockerfile, migrate는 기존 source-checkout-free SQL/shell 전용 Dockerfile로 linux/arm64 GHCR 발행 계약을 추가했다.
- 계획 이탈: 핸드오프의 “4종 모두 swift-service.Dockerfile 기반”은 실행 파일이 없는 migrate에 적용 불가해 기존 전용 Dockerfile을 재사용했다.
- prod compose/env/preflight를 shared SHA tag·per-image digest rollback·migrate-first로 정렬했다. Docker/AWS/verifier/local gate는 미실행(`runtime-unverified`).

## 2026-07-13 (momo-main/Fable) · ADR-0111 기안 (Agent Work Surface, 성재 발제) + UI W1/Phase A 스폰
- 성재 발제: 메신저 내 업무·터미널·코드 작업(특화 에이전트 + codex 오픈소스 활용) → ADR-0111 Proposed 기안. Option A(BYOA 실행: momo 서버는 코드 실행 안 함, codex CLI=에이전트 호스트 엔진, sandbox→승인 티어 매핑, capability 배지 명시 선택) 권장.
- ROADMAP §1.4 overlay 추가, MOMO-362..365 예약(Accepted 전 발급 금지). ADR-0109(unread)도 같은 날 Proposed.
- UI W1(357 `#347`/359 `#348`)+Phase A(360 `#349`/361 `#350`) worker 4기 스폰, 358 `#351`은 357 랜딩 대기.
- 성재 판정(같은 날): **ADR-0111 Accepted (Option A=BYOA)** + **ADR-0109 Accepted**. Work 배치·Wave 2 모두 현행 배치 랜딩 후 발급으로 확정.
- 다음: 현행 goal 랜딩 사이클(348/349/350 PR 검수, 347 capacity-오류 resume 진행 중) → 종결 시 MOMO-362..365 + Wave 2 발급.

## 2026-07-13 (momo-main/Fable) · Phase 0 dogfood 무결성 배치 종결 (354/355/356)
- merge 순서: MOMO-356 `0a4bf37`(+오케스트레이터 python≥3.10 pin) → MOMO-355 `ac00ef3`(context verifier self-seed 반려 1회) → MOMO-354 `9ca9c93`(design-review High 2건 반려→profile gate+NSHostingView 캡처 수정, 정본 PNG 재기록 `6f00f05` 후 멤버 행+AGENT 배지 픽셀 육안 확인).
- root post-merge full gate green: `local-gate-runtime-agent-20260712T170955Z-…-rfc58973d57b9.md` + `local-gate-macos-ui-20260712T171443Z-…-r88f66c1ce253.md`.
- 발견: `cleanup-seeded-agents`는 102·103 동시 은퇴인데 앱 pairing은 기존 hermes 멤버 재사용이라 103 재생성 product 경로 부재 — 라이브는 REST 채널 멤버십 제거로 김인턴만 invite-gated 처리, full retire는 pairing 표면 후속 티켓 이후. design-review Medium 5건 BUILD_TICKETS 이월.
- 다음: 라이브 반영(김인턴 채널 제거→gateway env/plugin 갱신→재기동→앱 재빌드) 후 성재 육안 검증. 이어서 UI Wave 1 + ADR-0109 기안 + Phase A 티켓.

## 2026-07-13 (Codex worker) · MOMO-354 review fix — profile gate + roster pixels
- server-SoT에서 로컬 프로필 편집 버튼/컨텍스트 메뉴를 비활성화하고 서버 관리 안내를 표시하며, `applyLocalProfile`도 같은 경계에서 no-op한다.
- 계획 이탈: 최초 `ImageRenderer` snapshot이 `ScrollView/LazyVStack` roster 픽셀을 누락했다. `NSHostingView` 2x 캡처로 교체하고 light/dark `AGENT` accent pixel assertion을 추가했다.
- 검증: macOS build, 비스냅샷 79 tests, roster snapshot 3 tests(정본 대기 2 skip + pixel 1 PASS), Python static contract/design pre-flight, fresh design-review PASS(Blocker 0/High 0/Medium 0/Low 0). DB/Docker/verifier/gate 금지 유지.
- 다음: 같은 PR 추가 커밋 push. 정본 PNG는 오케스트레이터 재기록 대기.

## 2026-07-13 (Codex worker) · MOMO-354 real-server roster SoT
- 반영: REST backend fixture fallback과 이름 기반 agent 숨김을 제거하고 `/roster` active membership를 사이드바·멘션·작성자·agent realtime 구독의 공통 권위로 연결했다. login/join은 ADR-0110의 `realtimeWebSocketUrl`을 광고하며 앱 env보다 우선한다.
- verifier: 기존 marker/OID-owned DB·per-run UUID·대문자 CENT_CHANNEL·source digest·exit 96 경계를 보존한 채 roster/realtime discovery assertion만 추가했다.
- 검증: server 63 tests, macOS 비스냅샷 79 tests, 신규 snapshot 2종 reference-wait skip, Python no-DB contract, shell syntax/권한, design-review PASS(Blocker 0/High 0/Medium 1). Docker/DB/verifier/local gate는 금지 범위로 미실행(`runtime-unverified`).
- 다음: 오케스트레이터가 snapshot 2종 재기록과 clean `macos-ui` 후 PR을 검수하고 momo-main이 merge/root gate를 맡는다.

## 2026-07-13 (Codex worker) · MOMO-355 review fix — context verifier fixture
- 오케스트레이터 clean `runtime-agent`에서 context verifier가 seed-none DB의 human(…101)/Hermes(…103) FK를 migration seed에 의존한 누락을 확인했다.
- workspace·human·agent·target/other channel+seq·membership을 verifier-owned fixture로 추가하고, seed-none verifier의 고정 101/102/103 참조를 전수 점검했다.
- 계획 이탈: 최초 정적 계약이 migration mode/격리 경계만 확인해 context의 FK fixture 완결성을 증명하지 못했다. context fixture 조각을 contract test에 추가했다.
- 다음: shell/Python/diff 정적 검증과 같은 브랜치 push 후, 오케스트레이터가 DB/Docker clean `runtime-agent`를 재실행한다 (`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-355 dogfood agent seed opt-in
- persistent/local-alpha migration은 human+기본 채널만 만들고 agent 0으로 시작하며, 역사적 김인턴/Hermes seed는 demo/e2e 러너만 명시 opt-in한다. `schema_v0.sql`/신규 destructive migration은 없다.
- `scripts/momo`를 gateway-init → pairing invite → credential 발급 → env 순서로 정렬하고, 기존 고정 seed 둘은 exact identity/DB-owner/`--yes` guard가 있는 soft-retire 명령으로만 정리한다.
- runtime-agent/macos-ui verifier는 seed none + 자체 marker/OID fixture 계약을 비접속 Python test로 고정했다. shell/Python/diff, 5패키지 build, Core 18/Server 61/Relay 1/Worker 29/macOS 비스냅샷 78 tests PASS; 기존 image snapshot은 sandbox signal 5로 미실행·PNG 무변경이다.
- 다음: worker PR handoff 후 momo-main이 clean/root runtime-agent+macos-ui와 snapshot 영향 없음 확인 후 merge한다 (`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-356 gateway 운영 공지 timeline 차단
- 어댑터 direct message write를 momo `run_id`가 있는 실제 agent final로 제한하고, Hermes reset/home/`/resume`·`/sethome`/model-provider 공지는 성공 처리+본문 비포함 로컬 로그로만 남겼다. native gateway final은 `/gateway/complete` 유지.
- Hermes 정식 `MOMO_HOME_CHANNEL`을 plugin/enablement/`hermes-gateway-init` 신규·기존 env에 연결해 설정 요구를 기동 전에 해결했다. `schema_v0.sql`·UI·스냅샷 변경 없음.
- adapter contract 54 tests+smoke+pycompile, 실제 SDK result 및 신규·legacy home env init, 수정 shell `bash -n`/실행권한, diff check PASS. verifier DB assertion/runtime-agent gate는 worker 금지로 미실행.
- 다음: 오케스트레이터가 clean/root `runtime-agent`를 수행하고 gate 체크박스/merge를 맡는다.

## 2026-07-13 (Fable) · momo-main · dogfood 첫 실사용 → Phase 0 착수 + 내부알파 방향 확정
- dogfood 실증: gpt-5.5→**gpt-5.6-luna/high** 프로바이더 교체(Hermes config), per-agent bearer 라이브 연결·일반 왕복(@hermes 응답) 실동작 확인. 승인 왕복은 아직 라이브 미검증.
- 실사용 버그 3건 발견·발급: MOMO-354(#341 앱이 roster 대신 demo fixture)·355(#342 에이전트 pre-seed→초대 게이팅 위반)·356(#343 어댑터 운영공지가 durable message 오염). 게이트/verifier가 자체 fixture로 격리돼 안 걸린 종류 — 실사용에서만 드러남.
- **성재 방향 결정(ADR-0103 실질)**: 멀티팀 내부 알파 + **AWS 단일 EC2 실배포** 호스팅. Phase 0(354/355/356 정합)→A(호스팅+클라배포)→B(10인 용량)→C(온보딩 킷).
- 다음: Phase 0 배치 3-worker 스폰(진행 중). 랜딩 후 ADR-0103 정본화 + Phase A 티켓.

## 2026-07-12 (Fable) · momo-main · ADR-0102 배치 전체 종결 (350/341/352 랜딩)
- 랜딩: MOMO-350(#338 `f079279` — status/partial, outbox 경유+상한) → MOMO-341(#339 `6fcb870` — lease/takeover, 게이트가 회귀 2건 검출→resume 반려 2회→시나리오별 단위 테스트 고정) → **MOMO-352(#340 `bb76152` — 동등성 verifier)**. 전 건 clean+root gate PASS.
- **배치 종결**: root runtime-agent full gate에 동등성 검증 상시 포함 — worker/gateway가 run 전이·approval·usage/audit·durable message·realtime publication에서 완전 동일함이 매 게이트마다 증명된다. **legacy secret 호환 창 종료 조건 충족** (ADR-0102 §폐기 일정 2단계).
- 후속(성재 승인 대기): legacy header/`AGENT_GATEWAY_SECRET`/`MOMO_ALLOW_LEGACY_GATEWAY_SECRET` 물리 제거 보안 정리 티켓 (M7 전).
- 다음: ADR-0103 결정 순번. dogfood에서 승인 인박스/스트리밍 실사용 확인 권장.

## 2026-07-12 (Codex worker) · MOMO-352 agent path equivalence verifier
- worker(managed)와 gateway(BYOA) 정본 verifier를 fresh marker/OID DB·per-run 대문자 channel에서 각각 실행하고, trigger→approval→resume→final의 run/approval/usage/audit/message/realtime 보장 manifest를 완전 일치 비교하는 종결 verifier를 추가했다.
- allowlist는 timing/provider metadata/gateway lease/path-channel identity로 코드에 고정했고, source digest EXIT trap과 양 경로 pre-marker exit 96 exact-OID rollback을 자체 강제한다. `schema_v0.sql` 변경 없음.
- `runtime-agent` auto-classify/shell-syntax/add_cmd/coverage에 배선했다. `bash -n`·`git diff --check` PASS; Docker/DB/verifier/local gate는 worker 금지로 미실행(`runtime-unverified`).
- 다음: 오케스트레이터가 clean/root `runtime-agent` 두 경로 PASS와 fresh 보안/correctness 리뷰를 수행하고, legacy secret 물리 제거는 별도 후속 change로 넘긴다.

## 2026-07-12 (Codex worker) · MOMO-341 review fix — lease rejection 4xx audit
- clean `runtime-agent` 2차 게이트에서 takeover 뒤 crashed owner callback이 409 대신 500으로 새는 회귀를 확인했다. 원인은 PostgresNIO가 transaction closure 내부의 `HTTPError(.conflict)`를 `PostgresTransactionError`로 감싸는 데 있었다.
- `/gateway/events`(approval 포함)와 `/gateway/complete`의 lease 부재·불일치·만료·stale owner 거부를 transaction 결과값으로 반환하고 transaction 밖에서 409로 매핑했다. renew/release는 기존부터 UPDATE 결과를 밖에서 409로 매핑했으며, 누락 lease도 409로 통일했다. actor mismatch 403은 유지했다.
- server 단위 테스트에 동시 consumer 단일 claim, crash expiry/takeover, stale owner event/complete/renew/release 거부, expiry reclaim, missing/settled fail-closed를 추가해 61/61 PASS. DB/Docker/verifier는 worker 금지 범위라 오케스트레이터 재검증 대기다.

## 2026-07-12 (Codex worker) · MOMO-341 review fix — approval-held 409
- clean `runtime-agent`에서 승인 대기 late complete가 lease preflight를 먼저 타 500이 된 회귀를 확인했다. migration/claim/renew/release 설계는 변경하지 않았다.
- `awaiting_approval`/`paused`를 lease DTO·DB 검증 전에 `approvalHeld`로 판정해 MOMO-349의 409 human-decision guard를 복원했고, queued/running/terminal의 exact-owner lease 검증은 유지했다.
- server 56 tests PASS. DB/Docker/verifier 재실행은 오케스트레이터 대기(`runtime-unverified`).

## 2026-07-12 (Codex worker) · MOMO-341 gateway durable claim/lease
- 반영: `008_gateway_job_lease.sql` + actor-bound `FOR UPDATE SKIP LOCKED` claim, bounded renew/release, exact job+lease callback 결속, expiry takeover를 outbox SoT에 추가했다. `schema_v0.sql` 변경 없음.
- 어댑터: realtime은 wake-up 전용을 유지하고 serial claim(limit=1)만 provider를 시작한다. 실행 중 lease renew를 감독하며 owner 상실 시 provider task를 취소한다.
- verifier: 같은 agent 두 consumer 동시 claim=capability 1개, active lease 차단, simulated crash expiry/takeover, stale callback·non-owner renew/release 409, owner release/reclaim/complete 시나리오를 격리 DB 패턴에 추가했다.
- 검증: server build+55 tests, adapter 52 tests, py_compile, verifier `bash -n`/실행권한 PASS. DB/Docker/runtime-agent는 미실행(`runtime-unverified`); 오케스트레이터가 merge 전 clean/root gate와 fresh 리뷰를 수행한다.

## 2026-07-12 (Codex worker) · MOMO-350 gateway status/partial
- 반영: actor/run-bound gateway `thinking`/`streaming`을 bounded `agent.status`/`agent.partial` outbox로 투영하고 bearer per-member limit + run당 240 events/minute 하드캡, 2 KiB detail/8 KiB delta 상한을 적용했다.
- 어댑터/클라: provider stream을 512-byte/250ms 단위로 전달하며 macOS REST backend가 exact observable `agent:`를 구독해 기존 `AgentPartialView` state로 합친다. private `agentwork:`와 분리 유지.
- 검증: server 54 tests, adapter 49 tests, macOS 비스냅샷 78 tests(실렌더 타깃 포함), py_compile·verifier `bash -n`/실행권한 PASS. DB/Docker/verifier 미실행(`runtime-unverified`).
- 다음: 오케스트레이터가 격리 DB status/partial 시나리오와 clean/root `runtime-agent`를 수행하고, momo-main이 체크박스·merge를 맡는다.

## 2026-07-12 (Fable) · momo-main · 배치 4 랜딩 — 승인 왕복 실트래픽 도달 (349/351/353)
- 랜딩 3건: MOMO-351(#335, `ebb3a52` — 이중 경로 문서 정본화) → MOMO-353(#336, `8337ae2` — drift-guard, 배치 내 구세대 컨테이너 3곳을 실전 감지·이관하며 자가 실증) → **MOMO-349(#337, `b5b39df` — gateway 승인 왕복, ADR-0102 기함)**. 전 건 clean+root gate PASS.
- 검수 하이라이트: 349 보안 리뷰에서 actor↔run binding이 `requireRunActorBinding` 핸들러 진입점 상속임을 확인(Blocker 0). 353 격리 테스트(합성 dogfood 비접촉) 오케스트레이터 재실행 green.
- momo_main Centrifugo를 fingerprint 컨테이너로 1회 이관(opt-in 재생성) — 이후 config drift는 게이트가 자동 검출한다.
- 다음: MOMO-350(`#330`) 의존 충족·spawn 대기(성재 트리거) → 341 → 352(동등성 verifier, legacy secret 호환 창 종료 게이트).

## 2026-07-12 (Codex worker) · MOMO-349 gateway 승인 왕복
- 반영: actor-bound `approval_request` callback을 기존 approval/message/run/outbox/audit transaction에 연결하고, human approve/reject를 private gateway resume `agent.job`으로 전달한다.
- 어댑터: approval-required tool result를 callback으로 pause하고 approved resume은 재개, rejected resume은 provider 미호출 cancellation ack로 정산한다. terminal late completion도 409 fail-closed다.
- 검증: server build + 51 tests PASS, adapter contract 46 tests PASS, diff 보안 리뷰 Blocker 0. verifier는 격리 DB approval/approve/reject/actor/inbox 시나리오를 추가하고 `bash -n`/실행권한만 확인했다.
- 다음: 오케스트레이터가 merge 전 clean `runtime-agent`와 fresh 보안 리뷰를 수행하고, momo-main이 merge/root gate·잔여 체크박스 갱신을 맡는다.

## 2026-07-12 (Codex worker) · MOMO-353 local gate drift-guard
- 반영: Centrifugo 컨테이너 생성 시 repo config fingerprint를 고정하고 pre/post-start guard가 running fingerprint drift를 fail-closed하며 명시 opt-in에서만 해당 서비스를 재생성한다.
- 안전 경계: gate run marker(uid/repo/run/pid-start)+상속 env+repo command가 모두 맞는 프로세스만 stale/EXIT cleanup한다. unmarked dogfood MomoServer와 사용자 프로세스는 충돌로 남긴다.
- 검증: shell syntax/shellcheck/diff/make dry-run + fake Docker/합성 process-table 오탐 방지 테스트 PASS. 실제 Docker/DB/verifier 및 clean/root gate는 미실행(`runtime-unverified`), 오케스트레이터가 merge 전 수행.
- 다음: worker PR handoff 후 momo-main이 running-config match/drift/opt-in과 실패-run reaping, dogfood 28180 생존을 실제 gate에서 확인한다.

## 2026-07-12 (Codex worker) · MOMO-351 이중 실행 경로 문서 정렬
- 반영: adapter contract·L4 §6·README·architecture를 gateway=BYOA / worker=managed + 서버 소유 보장 매트릭스로 정렬하고 ADR-0102에 SD-5 표면을 소급 승인했다.
- 신원: 두 경로의 `agent_bearer` 수렴과 legacy secret의 equivalence-gate 후 제거·M7 전 시한을 ADR-0101/0102에 연결했다.
- 경계: 코드·shell·DB·Docker 변경/접속 없음. 349/350/341/352 미완 셀은 규범 계약으로 표시하고 완료 evidence로 쓰지 않았다.
- 검증: 링크/앵커 + dirty 허용 `docs` profile PASS; 오케스트레이터가 merge 전 clean docs gate와 체크박스 갱신을 맡는다.

## 2026-07-12 (Fable) · momo-main · ADR-0102 Accepted + 파생 배치 발급
- 결정: 성재가 ADR-0102 **Option C 수락** (gateway=BYOA / worker=managed 이중 경로 + 서버 보장 매트릭스). drift-guard 발급 승인, design-review Medium 2 보류, MOMO-341은 0102 배치 합류.
- 발급: MOMO-349 `#329`(gateway 승인 왕복) → 350 `#330`(status/partial) → 341 `#333`(claim/lease) → 352 `#332`(동등성 verifier), 병렬 351 `#331`(docs)·353 `#334`(drift-guard). 패킷 `handoffs/2026-07-12-adr-0102-execution-path.md`.
- 핵심: 349가 landing되면 **승인 인박스가 실트래픽에서 처음 동작** — agent-native 시그니처 경험 실물화.
- 다음: 성재 트리거로 349부터 codex-fleet spawn. 다음 결정 순번 ADR-0103.

## 2026-07-12 (Fable) · momo-main · MOMO-348 랜딩 — verifier 격리 캐스케이드 전 프로파일 종결 (배치 3)
- 랜딩: goal-325 worker PR #328 검수 — 배치 2 교훈(per-run 채널 UUID + CENT_CHANNEL 대문자)이 프롬프트 반영으로 첫 커밋부터 준수됨. worktree bootstrap+단독+clean full gate PASS 후 merge (`444ee59`), #325 close.
- **종결: root main `macos-ui` full gate PASS** (digest 보존) — runtime-agent에 이어 전 프로파일 green. MOMO-342→348 캐스케이드 완전 닫힘.
- 운영 노트: 1차 worker가 API 무응답 행(CPU 0, 2.5h) → stall 감지 watcher 도입 후 재스폰 10분 완주. 실패 게이트 런의 잔류 MomoServer 포트 점유 재발(오늘 3회) → drift-guard 티켓 제안에 잔류 프로세스 자동 정리 병합.
- 다음: ready 구현 goal 없음. ADR-0102 결정(성재), drift-guard 티켓 승인(성재), design-review 잔여 Medium 2 발급 여부(성재), MOMO-341.

## 2026-07-12 (Codex worker) · MOMO-348 macos-ui real-backend verifier 격리
- 반영: macOS verifier를 unique marker/OID-owned migrated DB와 marker-bound app/worker/relay role로 분리하고 per-run #agent-lab UUID, demo/Hermes·approval/cost fixture를 자체 seed한다.
- 경계: source dogfood DB는 광범위 digest 전후 비교만 하며 exact OID+marker cleanup, marker-bound role cleanup, pre-marker COMMENT 실패(exit 96) rollback 회귀를 `macos-ui`에 배선했다.
- 검증: DB/Docker/verifier 실행 없이 수정·신규 shell `bash -n` PASS; acceptance/gate 체크박스는 미체크 유지한다.
- 다음: 오케스트레이터가 merge 전 fresh REST assertion·성공/실패 digest·clean `macos-ui`를 수행하고, momo-main이 merge/root gate를 맡는다.

## 2026-07-12 (Fable) · momo-main · MOMO-347 랜딩 — codex-fleet 배치 2 완료
- 랜딩: goal-324 worker PR #327 검수 — main 위 rebase(JOURNAL 충돌 해소), 스냅샷 3종 정본 머신 재기록(UI 변경분 2 + 신규 290pt), fresh-context design-review 재판정 **PASS(Blocker 0/High 0)** — 이전 High 2·Medium 4 전부 해소 확인. worktree macos-ui gate full PASS 후 merge (`51db851`), #324 close.
- 잔여: 재판정의 신규 Medium 2(전역 error 행 귀속 오독, 상태 칩 세로 스캔)·Nitpick 3은 티켓 미발급, BUILD_TICKETS에 기록 — 성재가 필요 판단 시 발급.
- 배치 2 결산: 346+347 랜딩, runtime-agent root full gate green, resume 피드백 루프·순서 의존 결함 검시 실증.
- 다음: **MOMO-348(`#325`)이 유일한 ready goal** — landing 시 root 전 프로파일 green. ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex) · worker #324 · MOMO-347 pairing popover hardening
- 반영: 340pt popover를 max-height ScrollView로 제한하고 credential을 flat section으로 임베딩했다. 290pt에서 긴 label/status/menu가 수직 fallback하며 폐기 notice는 해당 행에 붙는다.
- refresh: 일반 중복 조회는 coalesce하고 발급/폐기 뒤에는 기존 in-flight 응답 이후 최신 목록을 재조회한다. mutation 성공 후 목록 조회 실패 시 one-time reveal/폐기 결과는 로컬 메타데이터에 보존한다.
- 검증: macOS build PASS, snapshot suite 제외 77 tests PASS, 신규 290pt snapshot PASS, targeted credential 3 tests PASS. 기존 PNG는 재기록하지 않았고 nominal large-type reference는 동일 바이트로 constrained-window 이름만 정직화했다.
- 리뷰: fresh-context design-review PASS(Blocker 0/High 0, diff-scoped 새 pre-flight 위반 0). 남은 것은 오케스트레이터 정본 snapshot 재기록/clean `macos-ui` gate 후 PR 검수·merge.

## 2026-07-12 (Fable) · momo-main · MOMO-346 랜딩 — verifier 격리 캐스케이드 종결 (codex-fleet 배치 2)
- 랜딩: goal-322 worker PR #326 검수 중 full gate 순서 의존 결함을 격리 DB 실시간 검시로 2단 규명 — ① relay version=seq stale skip(공유 Centrifugo, 성공 응답이며 조용히 drop) → worker resume 반려로 per-run 채널 UUID(`1706590`) ② 채널명 대소문자 불일치(Swift 대문자 vs python 소문자) → CENT_CHANNEL 정규화 직접 수정(`0bb685e`). merge `beceaa1`, #322 close.
- 종결: **root main runtime-agent full gate PASS** — context/live/bridge/gateway 4-verifier digest 보존. MOMO-342→346 캐스케이드 닫힘. 잔여: MOMO-348(macos-ui 프로파일).
- 관찰: 실패 게이트 런의 MomoServer 잔류 누수(MOMO-319 유형) 2건 수동 정리. 파이프라인 실증: codex exec resume 리뷰 피드백 루프 첫 사용.
- 다음: MOMO-347 랜딩(rebase+design-review 재판정+macos-ui gate), 이후 MOMO-348 착수 가능. ADR-0102 성재 대기.

## 2026-07-11 (Codex worker) · MOMO-346 Hermes bridge/gateway verifier 격리
- 반영: external-provider/bridge와 gateway verifier를 각각 unique marker/OID-owned migrated DB로 분리하고 marker-bound runtime role 및 Hermes/#agent-lab fixture를 자체 seed한다.
- 경계: source dogfood DB는 digest 전후 비교만 하며 exact OID+marker cleanup, marker-bound role cleanup, 두 verifier의 pre-marker COMMENT 실패(exit 96) rollback 회귀를 `runtime-agent`에 배선했다.
- 검증: DB/Docker/verifier 실행 없이 수정·신규 shell `bash -n`만 PASS; acceptance/gate 체크박스는 미체크 유지했다.
- 다음: 오케스트레이터가 merge 전 fresh invite/roundtrip/bearer assertions·성공/실패 digest·clean runtime-agent를 수행하고, momo-main이 merge/root gate를 맡는다.

## 2026-07-11 (Fable) · momo-main · MOMO-339 랜딩 — ADR-0101 Phase 1 종결 (codex-fleet 배치 1 완료)
- 랜딩: goal-309 worker PR #323을 검수 — 스냅샷 참조 6종 정본 머신 재기록(worker 샌드박스 렌더링 불일치), main 위 rebase, fresh-context design-review **PASS Blocker 0**, worktree macos-ui gate full PASS 후 merge (`881518b`). ADR-0101 Phase 1 배치(337/338/339) 종결, 패킷 Status `done`.
- 발급 2건: MOMO-347 `#324`(design review High 2·Medium 4 후속), MOMO-348 `#325`(root macos-ui gate가 `verify_macos_real_backend_ui.sh` dogfood 결합으로 중단 — hermes 멤버십 drift로 mention→agent_job 0건, 346 후속).
- 파이프라인 교훈: named 팀메이트(tmux) spawn은 mailbox 미전달 좀비化 — 리뷰 서브에이전트는 이름 없는 일반 spawn (codex-fleet 스킬 반영).
- 다음: MOMO-346‖347 병렬 착수 가능(성재 트리거), 348은 346 후. root full gate green = 346+348. ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex) · worker #309 · MOMO-339 macOS credential pairing UI
- 반영: 초대 후 per-agent bearer 발급, transient one-time reveal, env 복사/권한 안내, 프로필·페어링 목록의 상태/회전/grace/확인 후 폐기/401 복구를 연결했다.
- 보안: raw bearer는 매니페스트·UserDefaults·로그·오류·실제 snapshot fixture에 저장하지 않고 REST create 응답→sheet state에서만 유지한다.
- 검증: macOS build PASS, credential+snapshot 포함 82 tests PASS(기존 MessageBubble snapshot 2개 signal 5 제외), light/dark/고대비/큰 글자 스냅샷 6종 PASS, design-review Blocker 0.
- 남은 것: 오케스트레이터가 merge 전 `macos-ui` 런타임 게이트와 실제 pairing/profile integration·폐기 dialog smoke를 수행한다.

## 2026-07-11 (Fable) · momo-main · MOMO-345 랜딩 + MOMO-346 발급 (codex-fleet 배치 1)
- 랜딩: codex-fleet worker(goal-320)가 만든 PR #321을 리뷰(MOMO-344 패턴 정합 확인)·worktree clean gate full PASS 후 merge (`5854c2f`), #320 close.
- 실증: root post-merge에서 live verifier가 drift 있는 dogfood DB 위에서 PASS + digest 보존. full gate는 hermes bridge/gateway verifier의 dogfood 결합(Hermes `…103` 멤버십 drift + roundtrip이 dogfood 채널에 메시지 작성)에서 중단 → MOMO-346 `#322` 발급 (캐스케이드 종결 티켓, `status:ready`).
- 병행: goal-309(MOMO-339 pairing credential UI) worker 실행 중. 파이프라인 개선: worktree 커밋은 `--add-dir <메인repo>/.git` 필요.
- 다음: MOMO-346 착수(성재 트리거), goal-309 완주 시 검수 사이클, ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex worker) · MOMO-345 live channel verifier 격리
- 반영: live verifier를 unique marker/OID-owned migrated DB와 marker-bound app(NOBYPASSRLS)·worker/relay(BYPASSRLS) role로 분리하고 authorized/negative fixture를 자체 seed한다.
- 경계: source dogfood DB는 agent queue/run/approval/message digest 전후 비교만 하며, exact OID+marker cleanup과 pre-marker COMMENT 실패 rollback helper를 추가했다.
- 검증: DB/Docker/verifier 실행 없이 `bash -n`만 PASS; fresh bootstrap·live assertions·clean/root `runtime-agent` evidence는 오케스트레이터 merge 전 대기.
- 다음: PR 리뷰/런타임 gate 후 momo-main이 merge·root post-merge gate·체크박스 갱신.

## 2026-07-11 (Fable) · momo-main · MOMO-344 검수 마무리 + MOMO-345 발급
- 마무리: GPT sol이 중단한 MOMO-344를 인계받아 재리뷰(P1 4건 반영 확인 + 실행권한 결함 1건 수정), 타깃 검증·clean gate PASS 후 PR #319 merge (`0b2c94a`), #318 close.
- 발견 1: root post-merge gate에서 `verify_agent_live_channel.sh`가 dogfood DB demo 시드 drift(agent 멤버십 left_at)로 실패 → 스코프 확장 대신 MOMO-345 `#320` 발급 (`status:ready`).
- 발견 2: momo_main Centrifugo가 MOMO-338 이전 running-config로 기동 상태(107/102 오류) → 재시작으로 해소. drift guard 티켓은 성재 승인 대기 제안.
- 다음: MOMO-339 `#309`(macOS pairing credential UI)와 MOMO-345 `#320` 병렬 착수 가능. ADR-0102 결정은 계속 성재 대기.

## 2026-07-11 (Codex) · momo-main · MOMO-344 context verifier 격리
- 발견: PR #317 post-merge root gate에서 `verify_agent_context.sh`가 persistent dogfood DB의 unrelated `resume_approval` job을 claim해 context trigger가 starvation 됐다.
- 결정: production Worker claim 정책은 바꾸지 않고 verifier에 unique migrated DB, marker-bound NOBYPASS app/BYPASS worker role, exact OID+marker cleanup을 적용한다.
- 검증 계획: source queue/run/approval/message digest 보존 + 기존 context assertions + full runtime-agent + 리뷰 + root post-merge gate.

## 2026-07-11 (Codex) · momo-main · MOMO-343 fresh bootstrap 회귀
- 발견: MOMO-342 merge 후 root main 새 포트에서 psql `-c` marker 변수가 치환되지 않아 fresh verifier DB bootstrap이 syntax error로 중단되고 unmarked DB가 남았다.
- 반영: COMMENT를 psql stdin SQL로 이동하고, cleanup 직전 exact generation marker를 재검증하며 동일 marker의 전용 role만 NOLOGIN/제거한다. role bootstrap은 트랜잭션화했고 unique DB의 실패 rollback, fresh 성공, persistent 재실행을 한 회귀 helper로 고정했다.
- 추가 발견: cold worktree dependency materialization이 MomoServer health timeout에 포함됐다. 세 runtime binary를 timeout 전에 동기 build하도록 분리했다.
- 검증: fresh DB bootstrap + persistent 재실행 + root main runtime-agent post-merge gate 예정.
- 다음: #316 merge/root gate 후 MOMO-339 pairing credential UI로 복귀.

## 2026-07-11 (Codex) · momo-main · MOMO-342 main gate 복구
- 발견: MOMO-338 merge 후 persistent main DB에서 user-owned Hermes membership이 제거돼 AgentWorker verifier가 migration seed를 잘못 전제했다.
- 반영: source DB와 물리적으로 분리된 marker-owned migration DB, generation별 fixture UUID, verifier-only workspace/human/channel/agent/budget, 고정 ID/alias 소유권 guard, exact client-message 기반 cleanup, empty run fail-fast 진단을 추가했다.
- 리뷰 반영: body/agent-wide 삭제를 제거하고 unrelated message/pending job/membership/Hermes 보존 sentinel, marker-bound 전용 app/relay/worker role, 전역 consumer의 isolated DB 연결, source/system/unmarked DB 거부, runtime-agent 2회 실행을 추가했다. 서버는 사전 build executable을 직접 띄워 SwiftPM planning lock도 피한다.
- 검증: 동일 persistent verifier DB에서 AgentWorker verifier 연속 2회 PASS, source DB untouched 확인; 전체 runtime-agent gate와 main 재검증 예정.
- 다음: #314 리뷰/merge/root main gate 후 MOMO-339 pairing credential UI 착수.

## 2026-07-11 (Codex) · momo-main · MOMO-338 보안 재리뷰
- 발견: realtime payload 직접 실행, run/channel 위조, credential-coarse realtime revocation, token-shaped error/argv 노출을 P1/P2로 확인.
- 반영: realtime wake-only + pending REST 재조회, exact `meta.token_id` liveness, agent run binding, 양단 redaction과 stdin verifier를 적용.
- 검증: adapter 40 tests, server 49 tests, terminal 401/4xx·full-page·reconnect/shutdown race, revoked JWT/cross-channel run/private agentwork 및 gateway verifier PASS.
- 다음: clean gates와 재리뷰 후 PR merge/root main fast-forward. 다중 instance lease는 MOMO-341.

## 2026-07-10 (Codex) · momo-main · MOMO-338 리뷰 보강
- 발견: `agent:` 하나에 observer progress와 private Context Packet job이 섞여 보안 self-only 수정이 기존 live UX를 깨뜨렸다.
- 반영: `agent:` progress / `agentwork:` private job 분리, cancellation/reconnect/recovery/backpressure 및 verifier secret lifecycle 하드닝.
- 검증: adapter 33 tests(실시간/recovery 단일 provider worker), server 48 tests, exact-channel agent live + private agentwork WebSocket/relay + Hermes gateway runtime verifier PASS.
- 다음: clean docs/runtime-agent gate와 PR merge 후 root main fast-forward. 다중 instance lease는 MOMO-341.

## 2026-07-10 (Codex) · momo-main · MOMO-338 통합 준비
- 한 일: Hermes adapter를 per-agent bearer 하나로 단일화하고 login/shared-secret을 제거. realtime-first reconnect + bounded recovery/cache + legacy env migration을 추가.
- 리뷰 반영: 다른 agent의 Context Packet을 볼 수 있던 subscribe proxy를 self-only로 강화하고 actor/env 교차검증, non-loopback TLS 기본값, smoke session revoke를 적용.
- 이탈: Python adapter 범위에서 server transport auth까지 확대(보안 blocker, DEVIATION_LOG accepted). 중복 gateway lease는 후속 티켓.
- 다음: runtime-agent clean gate·PR merge 후 root main fast-forward. 그다음 MOMO-339 및 gateway lease 티켓.

## 2026-07-10 (Codex) · momo-main · MOMO-337 통합
- 한 일: PR #310 보안/성능 리뷰에서 one-time token no-store, 발급자 provenance, pending `available_at`을 수정하고 main `8d97c82`로 merge. post-merge `runtime-agent` PASS.
- 이탈: 예상만 있던 `/gateway/jobs/pending`을 actor-bound recovery endpoint로 신설. #308에는 realtime-first + bounded recovery 계약을 추가.
- 현재: #307 done, #308(M1)/#309(M3) ready·병렬 가능. ADR-0102는 여전히 성재 결정 대기.
- 다음: runtime 임계경로인 MOMO-338을 먼저 claim하고, 별도 worker에서 MOMO-339를 병렬 진행 가능.

## 2026-07-10 (Codex) · GPT 5.6 · 기획 체계 보강
- 한 일: Fable 인수 내용을 검토하고 `CURRENT_STATE.md` 중심의 압축 복원, planner 병렬 claim, `momo-main` 순차 통합, versioned handoff 규칙을 정본에 추가.
- 열린 것: ADR-0102는 성재 결정 대기. GitHub 실측상 MOMO-337(#307)은 이미 별도 worktree에서 in-progress(PR 없음). root main의 기존 Hermes/local-dogfood 변경은 분리 유지.
- 다음: #307 PR handoff를 기다리며 ADR-0102 결정. 병렬 planner는 `CURRENT_STATE.md`에서 서로 다른 planning ID를 먼저 claim.

## 2026-07-10 (오후) · Fable · 기획+오케스트레이션
- 한 일: 협업 파이프라인 정본화(docs/planning/* 신설, CLAUDE.md, momo-planning 스킬, PR 이탈 섹션). 이슈 #307(ready)/#308/#309(blocked) 발급 + 핸드오프 패킷. ADR-0102 기안(Proposed).
- 열린 것: **ADR-0102 성재 결정 대기(권고 C)** · #307 착수는 성재가 Codex에 직접 요청 예정 · 기획/문서 배치는 main에 커밋됨(성재 승인, 이전 세션의 코드 핫픽스 변경은 여전히 미커밋 — 그 배치의 주인이 처리).
- 다음: 성재의 0102 결정 → 파생 티켓. #307 PR 오면 momo-main 리뷰 사이클 가동.

## 2026-07-10 (오전) · Fable · 기획
- 한 일: ADR-0100(거버넌스)·0101(에이전트 신원, Option A) 성재 승인 → Accepted. ux-bible/architecture 정본 신설. MOMO-337~339 수용기준 발급(BUILD_TICKETS).
- 열린 것: 없음 (전부 오후 세션으로 인계됨).

## 2026-07-09 · Fable · 진단
- 한 일: 6방향 코드베이스 감사 + Slack UX 딥리서치(36소스) → 진단 아티팩트(https://claude.ai/code/artifact/1e7d94cf-094c-4b66-b2b9-dbef028bee06). 판정: 골격 견고 / 신원·체감 레이어가 봇 수준 / 전면 리라이트 비추천. ADR 결정 큐 0100~0109 수립.
- 열린 것: 결정 큐 0102~0109 (0100·0101은 다음 날 처리됨).
