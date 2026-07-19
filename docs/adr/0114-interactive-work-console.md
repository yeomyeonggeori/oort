# ADR-0114: Interactive Work Console — 앱 내 터미널에서 Claude Code·Codex·OpenCode를 돌리는 개발자 슈퍼앱 층

- Status: **Proposed** (2026-07-19, Fable 기안 — 성재 승인 대기)
- 관련: ADR-0102(실행 경로 Option C — 이 ADR은 그 "interactive 반쪽"), ADR-0111(BYOA), ADR-0004·MOMO-234(provider credential 비유입 — 본 ADR의 하드 경계), ADR-0113(커넥터 경계), MOMO-375(Control+backtick transcript drawer — 본 ADR의 표면 승계), BUILD_TICKETS "ADR-gated 후속" 절, docs/planning/SUPERAPP_ENGINE_GAP_2026-07-19.md(L5 갭 진단)
- 발단: 초기 비전 "agent-friendly messenger 안에 터미널을 배치해 개발자가 Claude Code/Codex/OpenCode TUI로 작업하는 슈퍼앱"(성재, 2026-07-19 재확인). L1~L4는 랜딩 완료, L5(개발자 콘솔)만 이 ADR이 게이트.

## Context

1. **하드 경계는 이미 확정**: momo 서버는 user-owned execution host의 process·provider credential을 보관하거나 proxy하지 않는다(ADR-0004, MOMO-234 verifier 고정). 따라서 PTY와 도구 프로세스는 반드시 사용자 소유 머신에서 돈다 — 서버가 가질 수 있는 것은 **원장과 전송뿐**이다.
2. **원장·전송 절반은 준비됨**: agent_run 원장·승인 pause/resume·비용/감사·`agent.partial/status` 스트리밍·outbox→relay 전송·per-agent bearer가 랜딩돼 있다(Work v0). 이 ADR은 "헤드리스 run 경로"와 별개의 **interactive 경로**를 정의하며 둘을 혼합하지 않는다.
3. **표면 자리도 예약됨**: MOMO-375가 Control+backtick transcript/activity drawer까지 계획했고, command input·PTY·도구 세션은 본 ADR Accepted 전 구현 금지로 게이트돼 있다.
4. 참고 지형: VS Code(내장 터미널=로컬 PTY, 원격은 별도 데몬), Warp(로컬 PTY+선택적 클라우드 공유), Zed(로컬 우선). 공통 패턴 — **raw 스트림은 기기 밖으로 내보내지 않고, 공유는 명시적 행위**.

## Options

### D1. 실행 호스트 — PTY는 어디서 도는가
- **A (권고, v0) — 앱 내장 PTY**: macOS 클라이언트 프로세스가 직접 PTY를 spawn(로그인 셸 → 도구 명령). 자격증명은 도구가 원래 쓰던 로컬 저장소(~/.codex, Claude keychain 등)를 그대로 사용 — momo는 만지지 않는다. 제약: 세션 수명=앱 수명(detach 없음, v0 명시 한계).
- B (v1 예약) — 로컬 호스트 데몬(momo-workd): 앱과 분리된 사용자 데몬이 PTY 소유 → 앱 재시작 생존, 추후 iOS/웹 원격 attach의 유일한 진화 경로. v0에서 A의 PTY 관리 코드를 데몬으로 승격 가능한 내부 경계(프로토콜 분리)로 설계해 둔다.
- C — 서버측 실행: 하드 경계 위반. **기각.**

### D2. 원장 경계 — 무엇이 서버에 남는가 (프라이버시 핵심)
- **A (권고) — 수명주기만 원장, raw 스트림은 기기 밖 불출**: 서버에는 `work_session` 원장(시작/종료·exit code·도구 종류·사용자 지정 라벨)과 outbox `work.session.started/ended` 이벤트만. 키 입력·터미널 출력은 서버·relay를 절대 경유하지 않는다. cwd는 전체 경로 대신 **사용자 라벨**만 저장(경로 유출 방지). 산출물 공유는 사용자의 명시적 행위(선택 영역을 코드블록 메시지로 전송 — 기존 메시지 경로 재사용)로만.
- B — 전체 transcript 서버 저장: 시크릿(env 출력, 토큰 echo) 유출 면적이 원장 전체로 확대. **기각**(팀 감사가 필요해지면 옵트인 후속 ADR).
- C — 완전 로컬 기능(원장 0): momo 정체성(채널=실행 원장)과 단절, 팀원이 "누가 어떤 작업 중"을 볼 수 없음. **기각.**

### D3. TUI 표면
- **A (권고) — SwiftTerm(MIT) 임베드**: alternate screen·마우스·256색 등 TUI 완전 호환이 필수(세 도구 모두 full-screen TUI). MOMO-375의 Control+backtick 서랍을 승계해 **Work 서랍 = 세션 목록 + 활성 터미널**로 확장. 폰트·색은 MomoDS 토큰(agentPayloadMono 계열), momo-design-taste 준수.
- B — 자체 최소 에뮬레이터: TUI 호환에 수개월 낭비. **기각.**

### D4. 도구 세션 모델
- **A (권고) — 도구-불가지 프로파일**: 프로파일 = {이름, 명령 템플릿, cwd, env 화이트리스트}. 기본 제공 3종(claude / codex / opencode) + 임의 셸. momo는 도구 내부와 통합하지 않는다 — interactive는 PTY 그대로, 헤드리스 자동화는 기존 agent_run(L2)이 담당한다는 **경로 분리 선언**.
- B — 도구별 딥 통합(세션 이어받기·transcript 파싱): 도구 3사 내부 포맷에 결합 — v0 과설계. **후속 예약**(도구별 플러그인으로).

### D5. cwd/worktree·저장소 바인딩
- **A (권고, v0) — 바인딩 없음**: 세션은 프로파일 cwd에서 시작하고 세션 카드에 라벨·브랜치를 표시만 한다. 채널↔repo 바인딩(채널에서 "이 repo로 세션 열기")은 Work v1 후속 — 지금 결정하면 채널 모델에 조기 결합.

### D6. 원장 이벤트 계약 (D2-A의 구체화)
- 신규 테이블 `work_session`(id, workspace_id, member_id, tool, label, started_at, ended_at, exit_code — RLS FORCE, 신규 migration) + REST `POST/PATCH /v1/workspaces/:ws/work-sessions` + outbox `work.session.started/ended`(Core kind 가산 — unknown-skip 전제로 구클라 안전). 단일 쓰기경로(REST→PG→outbox→relay) 준수. 서버 확장은 이것이 전부다 — **본 ADR의 서버 면적은 의도적으로 소형**.

## Decision (Proposed 권고안)

D1-A(앱 내장 PTY, 데몬 승격 경계 예약) · D2-A(수명주기만 원장, raw 불출) · D3-A(SwiftTerm+Work 서랍) · D4-A(도구-불가지 프로파일) · D5-A(바인딩 v0 제외) · D6(소형 서버 계약). 성재 승인 시 Accepted.

## 파생 (Accepted 후 발급 예약)

- **MOMO-483** (엔진): `work_session` migration + REST + outbox 2 kind + Core 디코드 + verifier(`verify_work_session.sh` — 수명주기/RLS/라벨만 저장·경로 비저장 단정) `[runtime-db]`
- **MOMO-484** (UXUI, A큐 등재): SwiftTerm 임베드 + Control+backtick Work 서랍(세션 목록·터미널·프로파일 3종) + 명시적 "선택 영역 메시지로 공유". MOMO-375 승계·종결.
- 후속 예약: momo-workd 데몬(D1-B), 채널↔repo 바인딩(D5), transcript 옵트인 공유(D2-B 완화), 도구별 플러그인(D4-B).

## Consequences

- (+) 슈퍼앱 차별화 층이 열리되 서버 신뢰 경계는 불변(자격증명·프로세스·raw 스트림 전부 로컬). 서버 추가 면적 = 테이블 1 + REST 2 + kind 2.
- (+) 팀원은 채널 옆 Work 서랍에서 "누가 어떤 도구로 작업 중"을 실시간으로 본다 — 원장 철학 유지.
- (−) v0 세션은 앱 수명에 묶임(detach 불가), iOS/웹에서는 세션 카드 열람만 가능(터미널 없음).
- (−) raw 미저장이므로 사후 감사는 수명주기 수준 — 팀 정책상 전체 기록이 필요해지면 별도 옵트인 ADR.
