# momo 기획 현재 상태 (Planning Current State)

> 기준일: 2026-07-12 · 기준선: main `51db851` (MOMO-347 merge — 배치 2 완료. runtime-agent root full gate green) · 통합 책임: `momo-main`
> 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다.
> 결정 근거는 ADR, 검증 증거는 STATUS, 일정은 ROADMAP이 정본이며 이 문서는 그 정본들을 연결하는 포인터다.

## 0. 3분 복원

- 제품 방향: momo는 채널 타임라인을 사람·에이전트의 실행/승인/비용/감사 원장으로 만드는 self-hosted agent messenger다.
- 기획 체계: 성재가 최종 결정권자이고, Fable과 GPT 5.6은 동등한 planner다. `momo-main`은 병렬 기획 결과를 순차 통합하는 유일한 sync authority다.
- 구현 체계: Codex worker가 GitHub Issue 하나를 goal 하나로 claim하고 최대 5개까지 병렬 작업한다. worker는 PR handoff 후 멈춘다.
- 현재 큰 결정: ADR-0100(거버넌스), ADR-0101(per-agent bearer)은 Accepted. ADR-0102(Worker/Gateway 실행 경로)는 Proposed이며 성재 결정 대기다.
- 현재 구현 체인: **ADR-0101 Phase 1 + 후속(347) 완료, verifier 격리 체인 342~346 완료** — root `runtime-agent` full gate green. 남은 ready goal: **MOMO-348(`#325`)** 하나 — macos-ui 프로파일 격리, 이것까지 landing되면 root 전 프로파일 green.
- 운영 노트(2026-07-11): compose 컨테이너는 repo config 변경을 자동 반영하지 않는다 — infra config를 바꾼 merge 뒤에는 momo_main Centrifugo 재시작 필요(MOMO-338 config drift로 root gate 107/102 오류 전례). drift guard 자동화 티켓은 성재 승인 대기 제안.
- 이전 Hermes/local-dogfood dirty snapshot은 `codex/archive-local-solo-reconcile-20260710` / `eb09627`에 보존했다. canonical root `main`에는 정식 리뷰·PR을 통과한 변경만 반영한다.

## 1. 활성 기획 레인

| Planning ID | 주제 | Planner owner | 상태 | 결정권자 | 다음 행동 |
|---|---|---|---|---|---|
| `ADR-0102` | AgentWorker SSE vs Hermes Gateway 정본화 | Fable (기안 완료) | `decision-needed` | 성재 | Option C 권고안을 검토해 Accept/수정/Reject |
| `ADR-0103` | 로드맵 정렬: 멀티팀 알파 vs 로컬 솔로 dogfood | unclaimed | `queued` | 성재 | ADR-0102 결정 또는 명시적 우선순위 지시 후 claim |
| `ADR-0104` | 에이전트 presence/typing/streaming 이벤트 | unclaimed | `queued` | 성재 | ADR-0102의 실행 경로 보장 매트릭스와 함께 검토 |
| `ADR-0105..0109` | 검색·정체성·CI·서버 스택·메신저 기본기 | unclaimed | `queued` | 성재 | `docs/architecture/overview.md` 결정 큐 순서 준수 |

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
| verifier 격리 체인 | issue `#325` 본문 | MOMO-348 `#325` | `ready` — 유일한 대기 goal | 다음 |

동적 GitHub/worktree 상태는 이 문서에 복사하지 않는다. `scripts/goal_status.sh`를 실행해 확인한다.

## 3. 확정된 경계 (다시 토론하지 않음)

- Postgres가 SoT이고 Centrifugo는 transport only다.
- 모든 user-visible write는 REST → Postgres transaction → outbox → relay 경로를 지난다.
- 에이전트는 `member.kind='agent'`인 1급 멤버다.
- provider OAuth/token은 momo에 들어오지 않는다.
- 공개 API, 보안 경계, DB 계약, 제품 방향, 기술스택 변경은 Accepted ADR 없이 구현 티켓으로 만들지 않는다.
- 로드맵/ADR의 최종 승인자는 성재다.

## 4. 다음 체크포인트

1. 성재가 ADR-0102를 결정한다. Accepted라면 `momo-main`이 파생 티켓/패킷/ROADMAP을 한 change set으로 통합한다.
2. MOMO-348(`#325`)로 macos-ui full gate까지 root green을 완성한다 — verifier 격리의 마지막 조각.
3. ~~MOMO-346/347~~ — 2026-07-12 완료 (runtime-agent root green + popover 하드닝).
4. Hermes gateway 중복 실행 방지 claim/lease + takeover는 MOMO-341 — 착수 대기.
5. ADR-0102 결정을 완료해 AgentWorker SSE와 Hermes Gateway의 제품 기본 경로를 정본화한다.

## 5. 이 문서 갱신 규칙

- `momo-main`만 canonical `main`의 이 파일을 갱신한다. planner는 변경 제안을 자기 planning branch/ADR에 남긴다.
- 갱신 시 기준일, 기준 커밋, 활성 레인, 구현 handoff, 다음 체크포인트를 함께 확인한다.
- 세션 종료 시 `JOURNAL.md`에 5줄 이내 checkpoint를 남긴다.
- 채팅에만 남은 결정/할 일은 존재하지 않는 것으로 취급한다.
- 빠른 복원은 `scripts/planning_context.sh`, GitHub Issue/PR/worktree 실시간 상태까지는 `scripts/planning_context.sh --github`를 사용한다.
