# momo 기획 현재 상태 (Planning Current State)

> 기준일: 2026-07-15 · 기준선: **MOMO-381 슈퍼앱 엔진 기획 통합 + MOMO-383 workspace-first 구현 검수** — PLN-20260714-02 리뷰 결과와 MOMO-382 실행 분할이 main에 랜딩했고, 첫 builder MOMO-383은 ADR-0118 기반 durable workspace name/API/sidebar identity, bootstrap/cache race 보강, workspace root RLS와 locked join lookup, no-cache recovery UX를 구현했다. worker full `runtime-db`와 launch 포함 `macos-ui` gate가 PASS했고 momo-main final rereview가 남았다. Work v0(362..365)·unread(366/367)·ADR-0112 Wave A+MOMO-379 기반은 유지된다 · 통합 책임: `momo-main`
> 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다.
> 결정 근거는 ADR, 검증 증거는 STATUS, 일정은 ROADMAP이 정본이며 이 문서는 그 정본들을 연결하는 포인터다.

## 0. 3분 복원

- 제품 방향: momo는 채널 타임라인을 사람·에이전트의 실행/승인/비용/감사 원장으로 만드는 self-hosted agent messenger다.
- 기획 체계: 성재가 최종 결정권자이고, Fable과 GPT 5.6은 동등한 planner다. `momo-main`은 병렬 기획 결과를 순차 통합하는 유일한 sync authority다.
- 구현 체계: Codex worker가 GitHub Issue 하나를 goal 하나로 claim하고 최대 5개까지 병렬 작업한다. worker는 PR handoff 후 멈춘다.
- 현재 큰 결정: ADR-0100(거버넌스), ADR-0101(per-agent bearer), **ADR-0102(실행 경로 — Option C 이중 경로 + 서버 보장 매트릭스, 2026-07-12)** 전부 Accepted. 다음 결정 큐는 ADR-0103(로드맵 정렬)부터.
- 현재 구현 체인: **workspace-first messenger shell** — ADR-0112 Wave A+MOMO-379로 듀얼 밀도, 채널 헤더, 멤버 디렉터리/DM, 창 크롬을 랜딩했다. MOMO-383은 toolbar capsule을 제거하고 sidebar workspace identity/menu와 ADR-0118의 active-member read/owner-admin rename을 구현했다. 캐시 tenant/account 격리와 authoritative-denial 삭제, 모든 bootstrap await/409 reload의 generation guard, cancellation 보존, workspace root RLS/locked join lookup, fresh migration-before-role bootstrap ACL, no-cache retry UX를 전체 Swift 360 tests와 full runtime-db/macos-ui로 닫았다. merge 후 channel 생성 sheet/tooltip(MOMO-384 `#390`)과 one-click DM/member inspector(MOMO-385 `#391`)를 열고, 둘 뒤 RLS workspace 검색(MOMO-386 `#392`)을 진행한다. `Control+backtick` transcript drawer는 MOMO-375 후보이나 실제 command input은 ADR-0114 승인 전 구현하지 않는다.
- 운영 노트(2026-07-11): compose 컨테이너는 repo config 변경을 자동 반영하지 않는다 — infra config를 바꾼 merge 뒤에는 momo_main Centrifugo 재시작 필요(MOMO-338 config drift로 root gate 107/102 오류 전례). drift guard 자동화 티켓은 성재 승인 대기 제안.
- 이전 Hermes/local-dogfood dirty snapshot은 `codex/archive-local-solo-reconcile-20260710` / `eb09627`에 보존했다. canonical root `main`에는 정식 리뷰·PR을 통과한 변경만 반영한다.

### 0.1 현재 두 트랙 운영

| 트랙 | 주 실행 위치 | 목적 | 현재 경계 | 다음 체크포인트 |
|---|---|---|---|---|
| **UX/UI + 메신저 기능** | `momo-main` | 성재의 실창 수동 QA를 workspace → channel/DM → timeline 위계와 Slack 기본기로 수렴시키고, 개발자 모드에서 Codex급 실행 상세를 연다. | 한 번에 하나의 구조적 UX goal을 main이 오케스트레이션한다. 창 크롬/overlay/tooltip은 snapshot뿐 아니라 실창 AX와 좁은 창을 검증한다. | MOMO-382 기획 통합 → MOMO-383 workspace-first navigation → 384/385 → 386 |
| **슈퍼앱 엔진** | 별도 planning ID + planning branch/worktree | Work·문서·Google Workspace·plugin/webhook·MCP·승인 실행을 채널 원장 위에서 자동화한다. | engine planner는 자기 ADR/research/proposal만 소유하고 `clients/macOS/**`를 건드리지 않는다. ADR draft는 Accepted가 아니며 builder ready 전 성재 승인이 필요하다. | ADR-0113/0116 병렬 draft → ADR-0114 interactive Work host → ADR-0115 signed webhook ingress |

엔진 준비도(2026-07-14 코드/정본 대조):

- **코드 랜딩·repo-local mock 검증됨:** Work v0(`agent_run` + codex-workbench BYOA), 승인 pause/resume·결정·재개, per-agent bearer, status/partial, 비용·감사 원장.
- **런타임 미검증:** 실제 Codex와 momo 사이의 Work 실행 및 승인/resume 왕복은 아직 `runtime-unverified`다.
- **부분 구현:** 채널 히스토리 컨텍스트 조립 v1은 있으나 Context Broker/Context Packet의 권한·source·memory 실조립은 미완; inbound MCP는 skeleton/spec-to-code bridge 수준이다.
- **스펙만 정본화:** Google Workspace connector/enterprise consent(연구 스펙은 momo connector의 refresh token 암호화 저장을 제안하며, 구현 전 보안 경계 ADR 승인 필요), Plugin Manifest/catalog/repo split, Memory Plane/Capability Cache의 전체 런타임 저장·무효화.
- **자리만 있음:** 채널 설정의 웹훅/연동 탭은 placeholder이며 실제 발급·서명·회전·수신 경로는 아직 없다.

## 1. 활성 기획 레인

| Planning ID | 주제 | Planner owner | 상태 | 결정권자 | 다음 행동 |
|---|---|---|---|---|---|
| `ADR-0102` | AgentWorker SSE vs Hermes Gateway 정본화 | Fable | **`accepted`** (2026-07-12, Option C) | 성재 ✓ | 파생 배치 실행 완료 (2026-07-12 종결) |
| `ADR-0109` | unread/read-state 서버 계약 (UX P7) | Fable | **`accepted`** (2026-07-13) | 성재 ✓ | Wave 2(MOMO-366/367)까지 랜딩 완료 — 후속 없음 |
| `ADR-0111` | Agent Work Surface — 메신저 내 업무·터미널·코드 실행 (성재 발제) | Fable | **`accepted`** (2026-07-13, Option A=BYOA) | 성재 ✓ | 배치 종결 (2026-07-13) |
| `ADR-0112` | 제품 표면 재정렬 — 듀얼 모드·Slack 기본기·Codex급 상호작용 (성재 발제) | Fable | **`accepted`** (2026-07-14) | 성재 ✓ | Wave A+379 종결; B/C는 육안 QA 후 발급 |
| `PLN-20260714-01` | UX/UI 수동 QA + ADR-0112 후속 실행 순서 | `momo-main` | **`superseded`** | 성재 | 2026-07-14 실창 QA를 `PLN-20260715-01`로 이어받음 |
| `PLN-20260714-02` | 슈퍼앱 엔진 실행 로드맵(Work·MCP·GWS·plugin/webhook·approval) | engine planner + `momo-main` review | **`integrated-adr-drafts-pending`** | 성재 | gap audit/review/main 통합 완료(MOMO-381). ADR-0113~0116은 draft goal 발급 후 option 승인 필요 |
| `PLN-20260715-01` | Workspace-first messenger + superapp shell | `momo-main` | **`in-progress`** | 성재 | MOMO-382 정본 통합 후 MOMO-383을 첫 UX builder로 발급 |
| `ADR-0103` | 로드맵 정렬: 멀티팀 알파 vs 로컬 솔로 dogfood | unclaimed | `queued` | 성재 | 내부 팀 알파를 현재 실행 가정으로 검토하되, 확정 표기는 성재 승인과 ADR 정본화 이후로 제한 |
| `ADR-0104` | 에이전트 presence/typing/streaming 이벤트 | unclaimed | `queued` | 성재 | MOMO-350(status/partial) 결과를 전제로 검토 |
| `ADR-0105..0108` | 검색·정체성·CI·서버 스택 | unclaimed | `queued` | 성재 | `docs/architecture/overview.md` 결정 큐 순서 준수 |

### 병렬 기획 claim 규칙

1. 기획의 잠금 단위는 `ADR-01NN` 또는 명시적인 `PLN-YYYYMMDD-NN`이다. 같은 ID를 두 planner가 동시에 소유하지 않는다.
2. planner는 `momo-main`에 claim을 요청하고, 현재 `momo-main` 담당이 이 표의 `Planner owner`를 바꾸는 planning-only 변경으로 잠근다. planner 자신이 `momo-main`이면 직접 반영한다.
3. planner는 자기 ADR/research/proposal만 작성한다. `ROADMAP.md`, `BUILD_TICKETS.md`, `STATUS.md`, GitHub Issue 발급은 성재 승인 뒤 `momo-main`이 순차 통합한다.
4. 다른 planner의 초안은 직접 덮어쓰지 않는다. 반대 의견은 ADR Option/Review Notes 또는 별도 research 문서로 남긴다.

## 2. 활성 구현 handoff

| Batch | Handoff packet | Goal | 상태 | 머지 순서 |
|---|---|---|---|---|
| ADR-0101 Phase 1 | `docs/planning/handoffs/2026-07-10-adr-0101-agent-identity.md` | MOMO-337 `#307` | `done` (PR #310, main `8d97c82`) | 1 완료 |
| ADR-0101 Phase 1 | 같은 패킷 | MOMO-338 `#308` | `done` (adapter bearer + private `agentwork:` self-only) | 2 완료 |
| ADR-0101 Phase 1 | 같은 패킷 (Status `done`) | MOMO-339 `#309` | `done` (PR #323, main `881518b`) | 3 완료 — 배치 종결 |
| verifier 격리 체인 | issue 본문이 패킷 역할 (`#318` 패턴 승계) | MOMO-346 `#322` | `done` (PR #326, main `beceaa1`) — 캐스케이드 종결 | 완료 |
| MOMO-339 후속 | issue `#324` 본문 (design review High/Medium) | MOMO-347 `#324` | `done` (PR #327, main `51db851`) | 완료 |
| verifier 격리 체인 | issue `#325` 본문 | MOMO-348 `#325` | `done` (PR #328, main `444ee59`) — 캐스케이드 전 프로파일 종결 | 완료 |
| **ADR-0102 실행 경로** | `docs/planning/handoffs/2026-07-12-adr-0102-execution-path.md` | MOMO-349 `#329` | `done` (PR #337, `b5b39df`) — 승인 왕복 실트래픽 랜딩 | 1 완료 |
| ADR-0102 실행 경로 | 같은 패킷 | MOMO-350 `#330` | `done` (PR #338, `f079279`) — 실행 과정 가시화 랜딩 | 2 완료 |
| ADR-0102 실행 경로 | 같은 패킷 | MOMO-341 `#333` | `done` (PR #339, `6fcb870`) — 중복 실행 방지 랜딩 | 3 완료 |
| ADR-0102 실행 경로 | 같은 패킷 (Status `done`) | MOMO-352 `#332` | `done` (PR #340, `bb76152`) — 호환 창 종료 조건 충족 | 4 완료 — **배치 종결** |
| ADR-0102 실행 경로 | 같은 패킷 | MOMO-351 `#331` (docs) | `done` (PR #335, `ebb3a52`) | 병렬 완료 |
| 독립 tooling | issue `#334` 본문 | MOMO-353 `#334` (drift-guard) | `done` (PR #336, `8337ae2`) — 실전 자가 실증 | 병렬 완료 |
| **Phase 0 dogfood 무결성** | issue `#343` 본문 | MOMO-356 `#343` (adapter 공지 유출 차단) | `done` (PR #344, `0a4bf37`) | 1 완료 |
| Phase 0 dogfood 무결성 | issue `#342` 본문 | MOMO-355 `#342` (seed opt-in) | `done` (PR #345, `ac00ef3`) | 2 완료 |
| Phase 0 dogfood 무결성 | issue `#341` 본문 | MOMO-354 `#341` (roster SoT) | `done` (PR #346, `9ca9c93`) — **배치 종결** | 3 완료 |
| **UI Wave 1** | `2026-07-13-ui-wave1.md` | MOMO-357 `#347` (셸·사이드바) | `done` (PR #355, `94e9244`) — 리뷰 반려 1회(접근성 High) | 3 완료 |
| UI Wave 1 | 같은 패킷 | MOMO-359 `#348` (타임라인 그루핑) | `done` (PR #354, `6b75260`) — 리뷰 반려 1회(Blocker: 복사 칩 상시 노출) | 4 완료 |
| UI Wave 1 | 같은 패킷 | MOMO-358 `#351` (Cmd+K 스위처) | `done` (PR #356, `5ac5fa9`) — 리뷰 반려 1회(⌘서수 술어) — **W1 종결** | 5 완료 |
| **Agent Work Surface v0** | `2026-07-13-agent-work-surface.md` | MOMO-362 `#357` → 363 `#358` → 364 `#359` · 365 `#360` | `done` (PR #363/`2d5b2ad` · #365/`44f8d35` · #367/`adf159f` · #366/`f5aba9f`) — **배치 종결** | 완료 |
| **UI Wave 2 unread** | `2026-07-13-ui-wave2-unread.md` | MOMO-366 `#361` → 367 `#362` | `done` (PR #364/`69facce` · #368/`fd8eabe`, ⌥⇧↑↓ 스펙 변경 `d9f4e68`) — **배치 종결** | 완료 |
| **Phase A AWS** | `2026-07-13-phase-a-aws.md` | MOMO-360 `#349` (이미지 발행 워크플로) | `done` (PR #352, `6980e64`) | 1 완료 |
| Phase A AWS | 같은 패킷 | MOMO-361 `#350` (배포 번들+runbook) | `done` (PR #353, `1c044e6`) | 2 완료 |
| **ADR-0112 Wave A** | ADR-0112 + issue contracts | MOMO-370 `#378` → 371 `#376` → 372 `#377` | `done` (`6f4090c` → `c9ed890` → `e254cc6`) — **Wave A 종결** | 완료 |
| ADR-0112 D6 hotfix | issue `#379`/PR `#380` | MOMO-379 창 크롬 정합 2차 | `done` (`cef7430`, planning baseline `b5e572b`) | 완료 |
| 슈퍼앱 엔진 기획 통합 | `2026-07-14-pln-20260714-02-superapp-engine.md` | MOMO-381 `#383` | `done` (PR #384, main `011b630`) | 완료 — ADR draft queue 대기 |
| Workspace-first UX planning | `2026-07-15-workspace-first-superapp-shell.md` | MOMO-382 `#385` | `done` (PR #386, main `6f89d3b`) | 실행 체인 정본화 완료 |
| Workspace-first UX builders | 같은 패킷 | MOMO-383 `#387` → MOMO-384 `#390` / MOMO-385 `#391` → MOMO-386 `#392` | `in-progress` | 383 review fix·full worker gates 완료, momo-main final rereview 후 390/391 unblock |

동적 GitHub/worktree 상태는 이 문서에 복사하지 않는다. `scripts/goal_status.sh`를 실행해 확인한다.

## 3. 확정된 경계 (다시 토론하지 않음)

- Postgres가 SoT이고 Centrifugo는 transport only다.
- 모든 user-visible write는 REST → Postgres transaction → outbox → relay 경로를 지난다.
- 에이전트는 `member.kind='agent'`인 1급 멤버다.
- upstream Codex/OpenAI의 OAuth access/refresh token과 API key는 momo에 들어오지 않는다.
- momo runtime은 Hermes-facing bearer를 runtime secret으로 사용할 수 있다. upstream provider 자격증명과 혼동하지 않는다.
- 공개 API, 보안 경계, DB 계약, 제품 방향, 기술스택 변경은 Accepted ADR 없이 구현 티켓으로 만들지 않는다.
- 로드맵/ADR의 최종 승인자는 성재다.

## 4. 다음 체크포인트

1. ~~Phase 0 / UI W1 / Phase A / Work v0 / Wave 2 / ADR-0112 Wave A / MOMO-379 / MOMO-381~~ — **2026-07-14까지 종결**. canonical main은 `011b630`이다.
2. **UX 즉시 체인:** MOMO-382 정본 통합 → MOMO-383 `#387` workspace-first navigation → MOMO-384 `#390` native channel sheet/tooltip + MOMO-385 `#391` member inspector/one-click DM → MOMO-386 `#392` RLS workspace search.
3. **Work Console 경계:** MOMO-375는 transcript/activity drawer까지만 Accepted 범위다. 실제 `Control+backtick` command input, cwd/worktree/process lifecycle, Codex/Claude/OpenCode session은 ADR-0114 승인 뒤 새 child로 발급한다.
4. **엔진 다음 단계:** ADR-0113(credential/capability/action)과 ADR-0116(context/memory retention)을 병렬 draft하고, ADR-0114(interactive Work host), ADR-0115(signed webhook ingress)를 분리한다. draft는 구현 승인 아님이며 성재 option 승인 뒤 foundation builder chain을 연다.
5. **엔진 ID/잠금:** MOMO-307은 Context Broker로 강화 유지하고, MOMO-308은 `ready`를 취소한 non-claimable MCP umbrella다(SE-03A/B/C 새 ID 대기). MOMO-310은 advanced RAG, MOMO-320은 완료된 env drift 전용, MOMO-321/322는 후속 archive/wiki로 동결한다. engine PR은 기본적으로 `clients/macOS`를 수정하지 않는다.
6. **Phase A 운영 단계**: GHCR publish 1회 → EC2 provision → `docs/runbooks/aws-internal-alpha-deploy.md` 절차 — AWS 리소스 생성은 성재 결정.
7. **legacy gateway secret 물리 제거** — 보안 정리 티켓 발급은 성재 승인 대기 (호환 창 종료 조건 충족, M7 전 시한). agent 신규 pairing 표면 티켓(103 은퇴 후 재생성 경로)도 함께 검토.
8. MOMO-354 design-review Medium 5건 이월 (BUILD_TICKETS 기록) — presence 하드코딩·비활성 author 표시·subscribe 순서 의존·에러 카피·데모 서사. 성재 판단 대기.
9. dogfood 실사용 확인 권장: @hermes 승인 왕복(349), 실행 중 상태/부분응답(350), 실제 Codex Work 실행 + 승인/resume 왕복.

## 5. 이 문서 갱신 규칙

- `momo-main`만 canonical `main`의 이 파일을 갱신한다. planner는 변경 제안을 자기 planning branch/ADR에 남긴다.
- 갱신 시 기준일, 기준 커밋, 활성 레인, 구현 handoff, 다음 체크포인트를 함께 확인한다.
- 세션 종료 시 `JOURNAL.md`에 5줄 이내 checkpoint를 남긴다.
- 채팅에만 남은 결정/할 일은 존재하지 않는 것으로 취급한다.
- 빠른 복원은 `scripts/planning_context.sh`, GitHub Issue/PR/worktree 실시간 상태까지는 `scripts/planning_context.sh --github`를 사용한다.
