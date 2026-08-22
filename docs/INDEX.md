# oort — 문서 지도 (INDEX)

> **전 문서 단일 색인.** 처음 들어온 사람·도구·Codex가 "무엇이 어디에 있고 무엇이 정본인가"를 한 눈에 잡는다.
> 경로는 모두 **리포 루트 기준 상대경로**(체크아웃 위치와 무관). GitHub: `yeomyeonggeori/oort`.
> **정본 우선순위(충돌 시):** `AGENTS.md`(운영 계약) > `ROADMAP.md`(마일스톤) > `docs/BACKLOG.md`(티켓) > 그 외. 스키마는 `schema_v0.sql`(이동·수정 금지)이 항상 정본.
> 표기: `(검증됨)`=1차 출처 교차확인 · `(추정)`=설계/일정 판단 · **법무 텍스트는 법률 자문 아님 — 외부 변호사 1회 검토.**

---

## 0. 지금 무엇으로 짓는가 (스택 한 눈)

> 이 색인의 많은 문서는 **Swift/macOS 시절에 쓰였다.** 그 문서들을 폐기하지 않고 남겨 두되, 어느 것이 현행이고 어느 것이 은퇴 중인지 여기서 먼저 가른다 — 그러지 않으면 문서를 따르는 사람이 **실패하지 않고 잘못된 것을 성공적으로 짓는다**(#1226).

| 층 | 현행(여기서 짓는다) | 은퇴 중(삭제 대기) |
|---|---|---|
| 서버 | **`server-rust/`** Rust/Axum(ADR-0145) — `cargo` | `server/Sources`(Hummingbird 2) |
| 발행/워커 | `bins/momo-relay` · `momo-agent-worker` · `momo-notifier` | `relay/OutboxRelay` · `workers/*` · `services/*` |
| DDL | **`server/Migrations/*.sql`**(정본, Rust 이미지가 싣는다) + `schema_v0.sql` | — |
| 제품 표면 | **`clients/web`**(React/Vite) · `clients/desktop`(Tauri 2) · `clients/mobile`(RN) | `clients/macOS` · `clients/iOS` |
| 공유 코어 | **`packages/momo-core`**(TS, `@momo/core`) | `clients/Core`(Swift) |
| 기동/배포 | [`docs/SELF_HOST.md`](SELF_HOST.md)(**처음 한 번** — clone→로그인) · [`docs/SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md)(그록봇 3계층 플레이북) · [`docs/RELEASING.md`](RELEASING.md)(서버/이미지 `v0.x` 발행) · [`infra/rust/README.md`](../infra/rust/README.md)(그다음 전부: 이미지+compose) · [`docs/runbooks/ncp-rust-deploy.md`](runbooks/ncp-rust-deploy.md)(라이브 정본) | [`docs/RUN.md`](RUN.md)(Swift 기준 — 상단 배너 참조) |

- **예외 — 은퇴 아님:** `relay/PushRelay`(라이브 푸시 경로가 지금도 빌드·배포) · `clients/web-legacy`(삭제 아님. 라이브 웹=`clients/web`, `server-rust/Dockerfile:147,157,173,231` web-assets / #1228. Swift prod `Dockerfile.web`·e2e `web-init`·`--profile web`가 아직 소비, #1610).
- 현행 스택 빌드·검증 명령의 정본은 [`AGENTS.md`](../AGENTS.md) §3(그리고 `Makefile`의 `build`/`test`).

---

## 0.1 가장 먼저 읽을 것 (Codex/신규 진입)

| 순서 | 문서 | 왜 |
|---|---|---|
| 1 | [`STATUS.md`](../STATUS.md) | **항상 먼저.** 지금 무엇이 컴파일/런타임 검증됐나 — **최상단 항목이 현재**다(이 표에 상태를 적어 두면 즉시 낡는다). |
| 2 | [`AGENTS.md`](../AGENTS.md) | Codex 자율작업 **운영 계약**(빌드·검증 명령, DoD, 다음 티켓 선택법, 브랜치/PR). 충돌 시 최우선. |
| 3 | [`ROADMAP.md`](../ROADMAP.md) | 릴리스 계획 정본. **v0의 단위는 마일스톤 번호가 아니라 축**이다(상단 축 절이 현행, M0~M8 §1~§7은 은퇴 전제의 역사 기록). |
| 4 | [`docs/BACKLOG.md`](BACKLOG.md) | 티켓 정본(MOMO-NNN) — GitHub 이슈 변환원. |
| 5 | [`CODEX.md`](../CODEX.md) | 사람·도구가 읽는 풀 가이드(AGENTS.md와 핵심 동일 — 사본이 둘이라 **같은 PR에서 함께** 고친다). |

---

## 1. 루트 정본 파일

| 파일 | 역할 | 정본 등급 |
|---|---|---|
| [`schema_v0.sql`](../schema_v0.sql) | 정본 스키마(PostgreSQL 18, 24 테이블, `uuidv7()` PK, RLS FORCE) | **정본 — 이동/수정 금지**(확장은 `server/Migrations/00N_*.sql` 신규 + RLS DO-block ARRAY 등록) |
| [`ROADMAP.md`](../ROADMAP.md) | 릴리스 계획 — 상단 **축**(관전·승인·대화)이 현행, M0~M8 §1~§7은 은퇴 전제의 역사 기록 | **상위 정본** |
| [`STATUS.md`](../STATUS.md) | 현재 빌드/검증 상태 | 작업 후 **반드시 갱신** |
| [`BUILD_TICKETS.md`](../BUILD_TICKETS.md) | Phase 0 + v0 데모 의존순 빌드 백로그 + 수용기준 등급 정의 | 빌드 STEPS |
| [`AGENTS.md`](../AGENTS.md) | Codex 자동 머지 운영 계약 | **운영 정본(최우선)** |
| [`CODEX.md`](../CODEX.md) | Codex 자율실행 풀 가이드 | AGENTS.md와 동일 핵심 |
| [`README.md`](../README.md) | 제품 1줄 + 불변식 + 정직성 표(✅🚧💭) + 아키텍처 | 진입점 |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | 기여 정본(영문, DCO·라이선스 게이트). 한국어 원문 [`CONTRIBUTING.ko.md`](../CONTRIBUTING.ko.md) | 커뮤니티 |
| [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Contributor Covenant v2.1. 신고 경로=`SECURITY.md` | 커뮤니티 |
| [`SECURITY.md`](../SECURITY.md) | 취약점 신고(GitHub private advisory). 한국어 판단 자료 [`docs/security/README.ko.md`](security/README.ko.md) | 보안 |
| [`CHANGELOG.md`](../CHANGELOG.md) | Keep a Changelog. 첫 항목 [v0.1.0](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.0) | 릴리스 |
| [`.github/CODEOWNERS`](../.github/CODEOWNERS) | 리뷰 라우팅 최소형 `* @kwakseongjae` | 커뮤니티 |
| [`NOTICE`](../NOTICE) | Apache 2.0 귀속 — 앱 화면 표기 대상 | 법무 |
| [`llms.txt`](../llms.txt) | 그록봇 진입 stub — 제품 한 줄 + `SELF_HOST_AGENT.md` GitHub raw URL + 본인 계정/VM 전용 고지 (#1652) | 에이전트 진입 |
| [`Makefile`](../Makefile) | `build`/`test` = **현행 스택**(cargo + npm), `up`/`down`/`migrate` = dev compose, `swift-build`/`swift-test` = 은퇴 중 트리 | 빌드 명령 |
| [`docs/SELF_HOST.md`](SELF_HOST.md) | **셀프호스트 첫 기동 정본**(#1229): clone → `scripts/self_host_env.sh` → `up -d --build --wait` → 브라우저 로그인. 분기 0. digest pull 예시는 GitHub Releases | 운영 명령 |
| [`docs/SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) | **그록봇 3계층 플레이북**(#1652): 코어 설치(digest·claim·`/workspace` pgdata) → quick tunnel → 사용자 핸드오프. 본인 계정/VM 전용. 진입은 루트 [`llms.txt`](../llms.txt) | 운영 명령(에이전트) |
| [`docs/RELEASING.md`](RELEASING.md) | **서버/이미지 릴리스 정본**(#1628): 승격→발행→digest 수거→태그→Release→SELF_HOST 문면. 데스크탑 next 채널과 경계 | 운영 명령 |
| [`docs/SELF_HOST_FIRST_DAY.md`](SELF_HOST_FIRST_DAY.md) | **셀프호스트 오퍼레이터의 첫 하루**(#1608): 부트스트랩(키 둘) → GUI 초대 → 웹/`oort://join` 합류 → AI 연결 → 첫 멘션 | 운영 명령 |
| [`docs/runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md) | **셀프호스터 pg_dump 백업·복원**(#1654): `/workspace` 덤프, 그록 이탈·B7 트라이얼 잠김·다른 VPS/로컬 이사. 프로덕션 PITR과 별 문서 | 운영 명령 |
| [`infra/rust/README.md`](../infra/rust/README.md) | **현행 스택 심화**: Rust 이미지 + prod형 compose(로컬·푸시·폰·TLS 오버레이 전부) | 운영 명령 |
| [`docs/runbooks/ncp-rust-deploy.md`](runbooks/ncp-rust-deploy.md) | **라이브 배포 정본**(app.oor7.com Rust 스택 — 이미지 태그 교체 + Caddy/헤더 배포) | 운영 명령 |
| [`scripts/verify_merge_tree.sh`](../scripts/verify_merge_tree.sh) | **병합 결과**(브랜치가 아니라 머지된 트리)에서 웹·폰·코어를 컴파일하는 크로스-클라 게이트(#1108) | 운영 명령 |
| [`scripts/local_gate.sh`](../scripts/local_gate.sh) | 로컬 PR evidence 게이트. 현행 usage: `docs\|swift\|diagnostics\|staging-smoke\|host-runtime\|backup\|local-alpha\|internal-alpha\|runtime-*\|external-agent-provider\|m3-dbc\|web-serving\|web\|license\|secrets\|all`. `swift`/`m3-dbc`는 은퇴 중 Swift 트리. 삭제된 프로파일 `macos-ui`는 실행하지 않는다 (#1609) | 운영 명령 |
| [`scripts/collect_diagnostics.sh`](../scripts/collect_diagnostics.sh) | 내부 alpha 장애 공유용 redacted diagnostics bundle(directory + tar.gz + summary.md) 생성 | 운영 명령 |
| [`scripts/goal_status.sh`](../scripts/goal_status.sh) | ready/in-progress/needs-review/blocked issue와 branch/PR/worktree/local gate 상태판 | 운영 명령 |
| [`scripts/goal_claim.sh`](../scripts/goal_claim.sh) | 이슈 claim + canonical branch/worktree 생성 + remote branch lock + status 갱신 | 운영 명령 |
| [`scripts/goal_release.sh`](../scripts/goal_release.sh) | worker 완료 후 issue를 review/blocked/ready 상태로 전환하고 코멘트 기록 | 운영 명령 |
| [`.conductor/setup.sh`](../.conductor/setup.sh) | worktree별 `.env.worktree`, compose namespace, runtime port 자동 분리 | 운영 명령 |

---

## 2. 릴리스 / 배포 / 게이트 (정식 경로)

> **이 절의 상당수는 Swift/Apple 스토어 경로 문서다(은퇴 전제).** 스토어·법무·CI/CD 항목 자체는 여전히 유효하지만, 그 배포 대상이던 Swift 앱은 삭제 대기다 — 현행 배포 경로는 §0의 기동/배포 행(`infra/rust/README.md` · `docs/runbooks/ncp-rust-deploy.md`)이다.
> 🔒 **스토어 배포(M8)는 검수 게이트(M7) PASS 후에만.**

| 문서 | 역할 | 마일스톤 |
|---|---|---|
| [`docs/HANDOFF_2026-07.md`](HANDOFF_2026-07.md) | **2026-07 재설계 실행 인수인계**(Opus 세션→Codex): main 머지분(316/323/301/300/302/318), 317 브랜치 대기, Codex 진입점(303 MomoDS→308/309), 게이트 배비싯 함정(watchdog/포트가드/verifier 누수) | M1/M3 |
| [`docs/RELEASING.md`](RELEASING.md) | **현행** 서버/이미지 `v0.x` 릴리스(승격→GHCR digest→태그→Release). 데스크탑은 `NEXT_CHANNEL.md` | #1628 |
| [`docs/RELEASE_PLAYBOOK.md`](RELEASE_PLAYBOOK.md) | 데스크탑 공증 + iOS App Store + CI/CD **실행 마스터 체크리스트** + 비용/기간 표 + gotcha 집약 | M1~M8 |
| [`docs/DEPLOY.md`](DEPLOY.md) | 백엔드 멀티팀 운영 배포(staging→prod: Caddy 자동TLS/Redis/SOPS+age/pgBackRest PITR/모니터링) | M1, M2 |
| [`docs/AWS_INTERNAL_ALPHA.md`](AWS_INTERNAL_ALPHA.md) | AWS 1주일 internal alpha stack v0: EC2/Lightsail topology, 비용, 보안그룹, DNS/TLS, backup/restore, image-based deploy/rollback, preflight | M1/M7 준비 |
| [`docs/SECRETS_BACKUP_RUNBOOK.md`](SECRETS_BACKUP_RUNBOOK.md) | SOPS+age secret lifecycle + pgBackRest PITR backup/restore skeleton(MOMO-006, 실제 secret 없음) | M1 |
| [`docs/INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md) | **현행** 내부 알파 스모크 A–F: 셀프호스트 웹+Tauri 데스크탑, 초대/합류, 에이전트 멘션, diagnostics. Swift/`macos-ui` 경로 은퇴 | ITO-1~3 |
| [`docs/LOCAL_SOLO_ALPHA_ROADMAP.md`](LOCAL_SOLO_ALPHA_ROADMAP.md) | **은퇴 배너** — Swift 1인 알파+`AWS_READY` 로드맵 원문. 실행은 3-Day 팩 | 사문서 |
| [`docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`](LOCAL_3_DAY_ALPHA_TEST_PACK.md) | **현행** ITO 3일 팩: Day 0~3, `LAUNCH_READY`/`BLOCKED`/`NEEDS_MORE_INTERNAL`, 시나리오 H1–H3·O1–O4·I1–I8 결속 | ITO-1~4 |
| [`docs/INTERNAL_ALPHA_FEEDBACK.md`](INTERNAL_ALPHA_FEEDBACK.md) | 내부 알파 피드백 intake: severity, evidence packet, needs-triage, buildable goal handoff | ITO-4 |
| [`docs/NEXT_CHANNEL.md`](NEXT_CHANNEL.md) | **현행** Tauri next 자동 업데이트 채널(매니페스트·발행·서명) | ITO-3 I5 |
| [`docs/MACOS_ALPHA_UPDATE_CHANNEL.md`](MACOS_ALPHA_UPDATE_CHANNEL.md) | **은퇴 배너** — SwiftUI Sparkle/local-manifest 원문. 실행은 `NEXT_CHANNEL.md` | 사문서 |
| [`docs/QA_GATE.md`](QA_GATE.md) | **M7 검수 게이트 단일 진입점**(G-0~G-H + 베타 전략 + 사용성 체크리스트 + GO 판정) | M7 |
| [`docs/RUN.md`](RUN.md) | **은퇴 중** — Swift 기준 로컬 기동/마이그레이션/롤백 절차. 상단 배너가 현행 경로를 가리킨다. `.env`·compose·마이그레이션 절(§2~§4)은 스택과 무관하게 여전히 유효 | M0/M1 |
| [`docs/INBOUND_MCP.md`](INBOUND_MCP.md) | Inbound MCP v0 서버 skeleton endpoint/security/permission model | M2 |
| [`docs/GWS_INTERNAL_CONSENT_RUNBOOK.md`](GWS_INTERNAL_CONSENT_RUNBOOK.md) | 배포 조직용 GWS 사전 셋업 런북(MOMO-323): GCP 프로젝트 생성 → OAuth consent **Internal**(검증/CASA 면제 전제) → SA 생성/키 발급 → 공유 드라이브 + SA Content Manager 멤버(`boundary_kind=shared_drive_member`, DWD 아님) — 사람 단계 `[manual]` 표기 | M2 |
| [`docs/GITHUB_OPS.md`](GITHUB_OPS.md) | GitHub 운영 구조(마일스톤=릴리스, 라벨 택소노미, Projects, Codex goal 흐름) | 전반 |
| [`docs/LOCAL_PR_GATE.md`](LOCAL_PR_GATE.md) | GitHub Actions disabled/manual-only 기간 로컬 PR gate(명령/evidence/merge cycle) | M1/M6 |
| [`docs/external-agent-provider/README.md`](external-agent-provider/README.md) | external agent runtime smoke 계약: provider secret env 형식, mock/local/external 차이, credentialed 1왕복 gate, token 비저장 boundary | M1 |
| [`docs/external-agent-provider/local-hermes-gpt.md`](external-agent-provider/local-hermes-gpt.md) | local-only Hermes + GPT provider 계약: loopback opt-in, non-loopback HTTP fail-fast, OpenAI credential provider-owned boundary | M1 |
| [`docs/external-agent-provider/local-hermes-codex-oauth-setup.md`](external-agent-provider/local-hermes-codex-oauth-setup.md) | MOMO-257 local Hermes/Codex OAuth provider setup runbook: 사용자가 provider에서 인증하고 oort는 loopback endpoint + Hermes-facing bearer만 검증 | M1/M7 준비 |
| [`docs/external-agent-provider/local-hermes-provider.env.example`](external-agent-provider/local-hermes-provider.env.example) | placeholder-only local Hermes provider env template; `$HOME/.momo/local-hermes-provider.env`로 복사해 사용하며 provider OAuth/API key는 포함 금지 | M1/M7 준비 |
| [`docs/MULTI_SESSION_OPS.md`](MULTI_SESSION_OPS.md) | 5개+ Codex session/worktree 운영 모델(momo-main/worker/handoff/env 충돌 방지) | M1 |
| [`docs/adr/0001-agentic-work-os-repo-topology.md`](adr/0001-agentic-work-os-repo-topology.md) | Agentic Work OS repo topology + plugin ecosystem + Docker/deploy layering ADR | M1.5 |
| [`docs/adr/0002-docker-compose-layering.md`](adr/0002-docker-compose-layering.md) | Docker compose/deploy layer ADR: dev/e2e/prod/install/upgrade/backup 경계, image-based prod, optional external DB/TLS/agent runtime | M1.5 |
| [`docs/adr/0003-macos-packaging-architecture.md`](adr/0003-macos-packaging-architecture.md) | M4 macOS packaging ADR: SwiftPM dev app vs Xcode release app, build-macos-apps 사용 기준, signing/notary/DMG/Sparkle issue split | M4 |
| [`docs/adr/0004-codex-oauth-hermes-provider-boundary.md`](adr/0004-codex-oauth-hermes-provider-boundary.md) | Codex/OpenAI credential boundary: external runtime provider-owned OAuth/API keys, oort evidence redaction/fail-fast | M1 |
| [`docs/adr/0005-macos-alpha-update-channel-v0.md`](adr/0005-macos-alpha-update-channel-v0.md) | macOS alpha update channel ADR: Sparkle 2 우선, manual fallback, SwiftPM placeholder surface, secret boundary | M3/M4 준비 |
| [`docs/adr/0100-decision-governance.md`](adr/0100-decision-governance.md) | **결정 거버넌스 정본(Accepted)**: 결정은 ADR·증거는 STATUS·계획은 ROADMAP, ADR 없는 경계 변경 머지 금지, 소급 결정(SD-1~5) 배정표 | 전반 |
| [`docs/adr/0101-agent-identity-credentials.md`](adr/0101-agent-identity-credentials.md) | **에이전트 신원 ADR(Accepted — Option A)**: 공유 시크릿 → per-agent `agent_bearer` + Phase 2 delegation. 구현: MOMO-337~339 | M1/보안 |
| [`docs/adr/0102-agent-execution-path.md`](adr/0102-agent-execution-path.md) | **에이전트 실행 경로 ADR(Accepted — Option C)**: gateway=BYOA / worker=managed 이중 경로 + 서버 소유 보장 매트릭스 + SD-5 소급 승인 | M1/에이전트 |
| [`docs/architecture/overview.md`](architecture/overview.md) | **아키텍처 정본**: 불변식 6개 + 시스템/수명주기/엔티티 mermaid 다이어그램 + 판정 요약 + ADR 결정 큐. 어긋나는 코드 변경은 같은 PR에서 갱신 | 전반 |
| [`docs/architecture/agent-context-discipline.md`](architecture/agent-context-discipline.md) | **에이전트 컨텍스트 규율 정본**: 서버가 매 턴 싣는 시스템 블록의 실측표(현행 8줄/627자) + 규율 R1~R6(열거·상한·opt-out·**바이트 동일** 증명·소비자 계약 결속·트림 밖 항구비용) + dsh 반면교사 매핑. 시스템 블록을 바꾸는 PR은 §1 표를 같은 PR에서 갱신 | 전반/에이전트 |
| [`docs/architecture/bible/README.md`](architecture/bible/README.md) | **메신저 아키텍처 바이블(학습용 파생 문서, 정본 아님)**: 문제 지도 M1~M11 + oort 뼈대 해설 + Slack/Discord/셀프호스팅 계열 비교 + 결정 큐 대조 — 정본과 어긋나면 정본 우선 | 전반 |
| [`docs/ux-bible/README.md`](ux-bible/README.md) | **UX 바이블 정본**: Slack 코퍼스 36선 기반 원칙 P1~P15 — UI/UX 티켓 수용기준이 원칙 번호를 인용 | M3+ |
| [`docs/design-system/README.md`](design-system/README.md) | **디자인 시스템 정본 「오르트 구름」(ADR-0159)**: 토큰 층(웹 정본 → 폰 번역)·위계 규칙(파괴>주>보조)·상태 규칙 4종·**강제 기제 지도(무엇을 무엇이 재고 무엇이 무검사인가)**·스케일 변경 절차 | M3+ |
| [`docs/planning/README.md`](planning/README.md) | **기획 레이어 운영 정본**: 제품 오너/planner/momo-main/worker 역할, 병렬 planning claim, ADR→티켓→핸드오프 체인, 구현 병렬 최대 5, 이탈 환류 | 전반 |
| [`docs/planning/CURRENT_STATE.md`](planning/CURRENT_STATE.md) | **컨텍스트 압축 복원 정본**: 활성 planning owner, 결정 대기, 구현 handoff, 다음 체크포인트. `momo-main`만 통합 갱신 | 전반 |
| [`docs/planning/HANDOFF_TEMPLATE.md`](planning/HANDOFF_TEMPLATE.md) | 핸드오프 패킷 템플릿 — 기획 맥락을 레포 안에 고정하는 장치, worker 채팅 메시지는 3줄로 | 전반 |
| [`docs/planning/DEVIATION_LOG.md`](planning/DEVIATION_LOG.md) | 계획 이탈 로그 — PR 이탈 보고 → 오케스트레이터 기록 → 기획 판정 → 로드맵 환류 | 전반 |
| [`docs/planning/JOURNAL.md`](planning/JOURNAL.md) | 기획 세션 저널(newest-first, 기존 항목 불변) — Fable↔GPT 5.6 세션 간 이어달리기 | 전반 |
| [`docs/planning/handoffs/`](planning/handoffs/) | 발급된 핸드오프 패킷 (첫 패킷: 2026-07-10 ADR-0101 agent identity 배치) | 전반 |
| [`docs/planning/proposals/2026-07-15-workspace-first-superapp-shell.md`](planning/proposals/2026-07-15-workspace-first-superapp-shell.md) | 2026-07-14 실창 QA를 workspace-first messenger와 governed Work Console 경계로 분할한 실행 제안 | M3/슈퍼앱 |
| [`docs/planning/handoffs/2026-07-15-workspace-first-superapp-shell.md`](planning/handoffs/2026-07-15-workspace-first-superapp-shell.md) | MOMO-383~386 UX buildable queue와 ADR-0113~0116 engine planning lock/handoff | M3/슈퍼앱 |
| [`docs/planning/handoffs/2026-07-16-plugin-platform-fable.md`](planning/handoffs/2026-07-16-plugin-platform-fable.md) | Plugin Platform 제품화를 위한 Fable 엔진 핸드오프: ADR-0113 custody, SE-04A registry, Drive vertical 후보, 동적 discovery | 슈퍼앱/플러그인 |

### 2.1 CI/CD · QA 게이트 상세 (`docs/cicd/`)

| 문서 | 역할 |
|---|---|
| [`docs/cicd/00-apple-cicd-pipeline.md`](cicd/00-apple-cicd-pipeline.md) | Apple CI/CD 파이프라인 설계 근거(인증/match/notary/비용) |
| [`docs/cicd/01-setup-runbook.md`](cicd/01-setup-runbook.md) | 1회 셋업 런북(ASC Key/match) |
| [`docs/cicd/02-secrets-inventory.md`](cicd/02-secrets-inventory.md) | 비밀값 6종 인벤토리 |
| [`docs/cicd/03-store-readiness-gate.md`](cicd/03-store-readiness-gate.md) | 게이트 체크리스트(무엇) + **PASS 블록 정본 기록처** |
| [`docs/cicd/04-codex-tickets.md`](cicd/04-codex-tickets.md) | CI/CD Codex 실행 티켓(CI0~CI5, C1/C2, M1/M2) |
| [`docs/cicd/05-qa-release-gate.md`](cicd/05-qa-release-gate.md) | **게이트 객관 통과기준 정본**(G-0~G-H 수치/정의/1차출처) |
| [`docs/cicd/06-beta-testflight-plan.md`](cicd/06-beta-testflight-plan.md) | TestFlight 내부/외부 + macOS 공증 .dmg 비공개 베타 + 피드백 트리아지 |
| [`docs/cicd/07-crash-analytics-spec.md`](cicd/07-crash-analytics-spec.md) | Sentry Cocoa(self-host) + MetricKit 계측 스펙 |
| [`docs/cicd/08-e2e-accessibility-performance.md`](cicd/08-e2e-accessibility-performance.md) | XCUITest + performAccessibilityAudit + XCTMetric 테스트 plan |
| [`docs/cicd/09-qa-codex-tickets.md`](cicd/09-qa-codex-tickets.md) | QA Codex 티켓(Q0~Q7 의존순) |
| [`docs/cicd/10-ios-signing-identity-runbook.md`](cicd/10-ios-signing-identity-runbook.md) | iOS 서명 아이덴티티 런북(사람이 1회) + **자산 확보 실측표** |
| [`docs/cicd/11-ios-push-device-check.md`](cicd/11-ios-push-device-check.md) | iOS 푸시 실기기 확인 절차(시뮬레이터로 증명 못 하는 것) |
| [`docs/cicd/12-push-relay-deploy-runbook.md`](cicd/12-push-relay-deploy-runbook.md) | PushRelay 배포·검증 런북(ADR-0120 P-3) |
| [`docs/cicd/13-selfhosted-runner-macos.md`](cicd/13-selfhosted-runner-macos.md) | 셀프호스티드 macOS 러너 운영 절차(ADR-0153 D2, 데스크톱 릴리스) |

> **PASS 블록 정본 기록처 = `03-store-readiness-gate.md` 상단**(05 §10 양식). `STATUS.md §5b` 게이트 상태도 OPEN→PASS로 함께 갱신.

---

## 3. 법무 / 행정 선결 (법률 자문 아님 — 외부 변호사 1회 검토)

| 문서 | 역할 |
|---|---|
| [`docs/legal/00-prelaunch-admin-legal-checklist.md`](legal/00-prelaunch-admin-legal-checklist.md) | 출시 전 법무·행정 체크리스트(L0~L8) |
| [`docs/legal/01-entity-apple-runbook.md`](legal/01-entity-apple-runbook.md) | L0/L1 등록 준비: 등록주체(개인/법인), D-U-N-S, Apple Developer Program, 사람/Codex handoff |
| [`docs/legal/02-cost-ledger.md`](legal/02-cost-ledger.md) | 비용 원장(일회성/연간/CI 컴퓨트) |
| [`docs/legal/03-app-privacy-datamap.md`](legal/03-app-privacy-datamap.md) | App Privacy 라벨 ↔ PrivacyInfo.xcprivacy 데이터맵 |
| [`legal/privacy-policy.md`](../legal/privacy-policy.md) | 개인정보처리방침 초안 |
| [`legal/agent-disclosure.md`](../legal/agent-disclosure.md) | 에이전트 LLM 제3자 전송 고지 |
| [`legal/THIRD_PARTY_NOTICES.md`](../legal/THIRD_PARTY_NOTICES.md) | 제3자 라이선스 귀속(permissive) |

---

## 4. 정본 스펙 / 연구 (`research/`)

| 문서 | 역할 |
|---|---|
| [`research/07-deepdive/04-self-build-l4-spec.md`](../research/07-deepdive/04-self-build-l4-spec.md) | **L4 정본 스펙**(아키텍처/스키마/쓰기경로/outbox/비용회계/APNs) |
| [`research/07-deepdive/05-agent-native-experiences.md`](../research/07-deepdive/05-agent-native-experiences.md) | 에이전트 네이티브 경험 설계(D/B/C + v1 프리미티브 P1~P6) |
| [`research/07-deepdive/01-agent-native-mac-messenger.md`](../research/07-deepdive/01-agent-native-mac-messenger.md) | 에이전트 네이티브 mac 메신저 컨셉 |
| [`research/07-deepdive/02-internal-v0-plan.md`](../research/07-deepdive/02-internal-v0-plan.md) | 내부 v0 계획 |
| [`research/07-deepdive/03-distributable-backbone-and-agent-interface.md`](../research/07-deepdive/03-distributable-backbone-and-agent-interface.md) | 배포 가능 backbone + 에이전트 인터페이스 |
| [`research/08-distribution/01-macos-distribution-spec.md`](../research/08-distribution/01-macos-distribution-spec.md) | macOS 배포 스펙(공증/Sparkle) |
| [`research/08-distribution/02-distribution-tickets.md`](../research/08-distribution/02-distribution-tickets.md) | 배포 티켓 |
| [`research/10-local-ai-protocol-trust/01-local-llm-context-broker.md`](../research/10-local-ai-protocol-trust/01-local-llm-context-broker.md) | Apple Foundation Models 적용 경계 + Context Broker + Memory Plane |
| [`research/10-local-ai-protocol-trust/02-agent-protocol-google-workspace.md`](../research/10-local-ai-protocol-trust/02-agent-protocol-google-workspace.md) | Agent Protocol v0 + Google Workspace connector roadmap |
| [`research/10-local-ai-protocol-trust/03-enterprise-trust-local-ops.md`](../research/10-local-ai-protocol-trust/03-enterprise-trust-local-ops.md) | Enterprise Trust + local PR gate + multi-session ops + build-macos-apps plugin 활용 |
| [`research/11-agent-runtime/01-three-agent-runtime-analysis.md`](../research/11-agent-runtime/01-three-agent-runtime-analysis.md) | Hermes agent / internkim / openclaw runtime 분석 |
| [`research/11-agent-runtime/02-memory-cache-protocol-gaps.md`](../research/11-agent-runtime/02-memory-cache-protocol-gaps.md) | Memory Plane · Capability Cache · MCP/A2A/SSE protocol gap |
| [`research/11-agent-runtime/03-roadmap-and-methodology.md`](../research/11-agent-runtime/03-roadmap-and-methodology.md) | Agent runtime 4-plane 방법론 + MOMO-151~172 로드맵 |
| [`research/11-agent-runtime/04-context-packet-v0.md`](../research/11-agent-runtime/04-context-packet-v0.md) | Context Packet v0 정본 스펙(request/scope/source/memory/tool/budget/redaction/runtime envelope) |
| [`research/11-agent-runtime/fixtures/context-packet-v0/`](../research/11-agent-runtime/fixtures/context-packet-v0/) | Context Packet v0 JSON fixtures(mention, slash command, message context action) |
| [`research/11-agent-runtime/05-memory-plane-v0.md`](../research/11-agent-runtime/05-memory-plane-v0.md) | Memory Plane v0 정본 스펙(typed memory/source/visibility/expiry/delete/retrieval permission) |
| [`research/11-agent-runtime/fixtures/memory-plane-v0/`](../research/11-agent-runtime/fixtures/memory-plane-v0/) | Memory Plane v0 JSON fixtures(memory item catalog, retrieval allowed/denied examples) |
| [`research/11-agent-runtime/06-capability-cache-v0.md`](../research/11-agent-runtime/06-capability-cache-v0.md) | Capability Cache v0 정본 스펙(agent/plugin/MCP capability cache, tool schema refs, TTL, invalidation, audit) |
| [`research/11-agent-runtime/fixtures/capability-cache-v0/`](../research/11-agent-runtime/fixtures/capability-cache-v0/) | Capability Cache v0 JSON fixtures(capability list, plugin tool schema projection, invalidation/audit examples) |
| [`research/11-agent-runtime/07-macos-agent-protocol-cards-v0.md`](../research/11-agent-runtime/07-macos-agent-protocol-cards-v0.md) | macOS Agent Protocol card UX 정본(tool_call/approval/tool_result/artifact/cost/memory/source badges + SwiftUI fixture contract) |
| [`research/11-agent-runtime/07-agent-run-lifecycle-v0.md`](../research/11-agent-runtime/07-agent-run-lifecycle-v0.md) | Agent Run Lifecycle v0 정본 스펙(A2A-style Task/Message/Artifact/status mapping, input-required vs awaiting-approval 경계) |
| [`research/11-agent-runtime/08-approval-pause-resume-runtime.md`](../research/11-agent-runtime/08-approval-pause-resume-runtime.md) | Approval Pause/Resume Runtime v0 정본 스펙(tool_call checkpoint, approval decision, same-run resume/terminate, audit) |
| [`research/11-agent-runtime/fixtures/approval-pause-resume-v0/`](../research/11-agent-runtime/fixtures/approval-pause-resume-v0/) | Approval Pause/Resume v0 JSON fixture(risky tool_call → approval_request → approve/deny → resume/terminate) |
| [`research/11-agent-runtime/09-inbound-mcp-server-v0.md`](../research/11-agent-runtime/09-inbound-mcp-server-v0.md) | Inbound MCP Server v0 정본 스펙(search/fetch/post/approval-safe tool call + Context Packet/Memory/Capability 권한 연결) |
| [`research/11-agent-runtime/fixtures/inbound-mcp-server-v0/`](../research/11-agent-runtime/fixtures/inbound-mcp-server-v0/) | Inbound MCP Server v0 JSON fixtures(tools/resources/prompts discovery, approval-safe tool-call proposal) |
| [`research/11-agent-runtime/10-approval-decision-server-contract-v0.md`](../research/11-agent-runtime/10-approval-decision-server-contract-v0.md) | Approval Decision Server Contract v0 정본 스펙(approve/reject/expire/resume API·DB·event·worker/macOS 연결) |
| [`research/11-agent-runtime/fixtures/approval-decision-server-contract-v0/`](../research/11-agent-runtime/fixtures/approval-decision-server-contract-v0/) | Approval Decision Server Contract v0 JSON fixtures(approve/reject request/response, expiry result, resume job payload, decided event) |
| [`research/11-agent-runtime/11-hermes-adapter-contract-v0.md`](../research/11-agent-runtime/11-hermes-adapter-contract-v0.md) | Hermes Adapter Contract v0 정본 스펙(ADR-0102 gateway=BYOA / worker=managed 이중 경로 + 서버 소유 보장 매트릭스) |
| [`research/11-agent-runtime/fixtures/hermes-adapter-contract-v0/`](../research/11-agent-runtime/fixtures/hermes-adapter-contract-v0/) | Hermes Adapter Contract v0 JSON fixtures(OpenAI-compatible SSE input, platform adapter event mapping) |
| [`research/11-agent-runtime/12-google-workspace-connector-v0.md`](../research/11-agent-runtime/12-google-workspace-connector-v0.md) | Google Workspace Connector v0 정본 스펙(per-user OAuth, Drive/Gmail/Calendar read-mostly sync, Context Packet/Memory/Capability projection, approval-gated writes) |
| [`research/11-agent-runtime/fixtures/google-workspace-connector-v0/`](../research/11-agent-runtime/fixtures/google-workspace-connector-v0/) | Google Workspace Connector v0 JSON fixtures(Drive source ref, Gmail thread ref, Calendar availability projection) |
| [`research/11-agent-runtime/13-google-workspace-enterprise-admin-v0.md`](../research/11-agent-runtime/13-google-workspace-enterprise-admin-v0.md) | Google Workspace Enterprise Admin v0 정본 스펙(enterprise admin install, domain-wide delegation option, scope inventory, service account boundary, delegated user, audit export, revoke/delete) |
| [`research/11-agent-runtime/fixtures/google-workspace-enterprise-admin-v0/`](../research/11-agent-runtime/fixtures/google-workspace-enterprise-admin-v0/) | Google Workspace Enterprise Admin v0 JSON fixtures(admin install scope inventory, DWD delegated Context/Memory/Capability projection, audit export revoke flow) |
| [`research/11-agent-runtime/14-realtime-client-subscription-contract-v0.md`](../research/11-agent-runtime/14-realtime-client-subscription-contract-v0.md) | Realtime Client Subscription Contract v0 정본 스펙(connection token, channel naming, subscribe auth, event envelope, `message.seq` replay/gap-fill, reconnect, macOS apply boundary) |
| [`research/11-agent-runtime/fixtures/realtime-client-subscription-contract-v0/`](../research/11-agent-runtime/fixtures/realtime-client-subscription-contract-v0/) | Realtime client subscription JSON fixtures(`message.new`, approval request/decision, `agent.partial`, `agent.status`, gap/backfill scenario) |
| [`research/11-agent-runtime/15-m3-dbc-real-data-readiness.md`](../research/11-agent-runtime/15-m3-dbc-real-data-readiness.md) | M3 D/B/C real-data readiness 정본(MOMO-020/021/022 unblock 조건, endpoints/events, local gate, follow-up MOMO-200~204 후보) |
| [`research/12-agentic-work-os/01-agentic-work-os-market-analysis.md`](../research/12-agentic-work-os/01-agentic-work-os-market-analysis.md) | Paca/OpenHands/Linear/Rovo/GitHub/Slack/MCP/A2A 시장 분석 + oort 제품 포지션(agent execution ledger) |
| [`research/12-agentic-work-os/02-plugin-manifest-v0.md`](../research/12-agentic-work-os/02-plugin-manifest-v0.md) | Plugin Manifest v0 정본 + `plugin_id`/tools/scopes/runtime boundary/license/provenance + Context Packet `tool_grants`/Capability Cache/approval metadata gate + source/audit/signature policy + catalog class/repo split 기준 |
| [`research/12-agentic-work-os/03-agent-host-positioning.md`](../research/12-agentic-work-os/03-agent-host-positioning.md) | MOMO-184 agent host 제품 문장 + channel timeline execution ledger 1페이지 비교 + website/README/sales deck reusable copy |
| [`research/12-agentic-work-os/03-first-party-plugin-repo-strategy.md`](../research/12-agentic-work-os/03-first-party-plugin-repo-strategy.md) | First-party plugin repo strategy 정본(GitHub/GitHub Issues → Google Workspace → Jira-like work items → Docs connector, repo split 순서, plugin surface/audit/source/approval contract) |
| [`research/13-redesign/00-execution-tracker.md`](../research/13-redesign/00-execution-tracker.md) | **재설계 실행 팔로업 보드** — Phase 0~3 × MOMO-300~323 상태(ready/blocked/in-progress/done), 착수 전 실증 항목, 사람 전용 항목. 재설계 티켓 종료 시 STATUS.md와 함께 갱신 |
| [`research/13-redesign/01-agent-native-redesign-2026-07.md`](../research/13-redesign/01-agent-native-redesign-2026-07.md) | **2026-07 재설계 방향 문서** — 코드베이스 진단(P1~P7: 디자인 시스템 부재/테이블스테이크스 공백/에이전트 단발 컨텍스트/프로토콜 고립/보안 갭/온디바이스 반쪽) + 레퍼런스 채택(astryx/openagents/Codex app/Slack Kit/Discord/Compass/FoundationModels/SpeechTranscriber/pgvector) + 6트랙 재설계(MomoDS·코어UX·MCP/A2A/AG-UI·RAG/Context Broker·음성·보안) + MOMO-300~315 티켓 델타 |
| [`research/13-redesign/02-gate-optimization.md`](../research/13-redesign/02-gate-optimization.md) | Local gate 실측 감사(Swift 10회 중복 빌드/worktree 캐시 비공유/2회 마이그레이션) + 3-wave 최적화(diff 기반 `--auto` 프로파일/BuildKit cache mount/공유 빌드 캐시) + 디자인 리뷰 자동화 루프(`.claude/skills/momo-design-taste` + `.claude/agents/design-review`) + MOMO-316~319 |
| [`research/13-redesign/03-google-workspace-files-rag.md`](../research/13-redesign/03-google-workspace-files-rag.md) | Google Drive workspace archive + RAG 역사적 제안. archive는 ADR 전 동결, MOMO-320 재사용 금지; 최신 경로는 superapp engine proposal 참조 |
| [`research/16-plugin-platform/00-plugin-ecosystem-research.md`](../research/16-plugin-platform/00-plugin-ecosystem-research.md) | Codex/Hermes/MCP와 Google Workspace·GitHub·Notion 공식 표면, 라이선스/인증/토큰 경계, plugin 후보 우선순위 조사 |
| [`research/16-plugin-platform/01-momo-plugin-platform-product-proposal.md`](../research/16-plugin-platform/01-momo-plugin-platform-product-proposal.md) | Plugin Center·온보딩 추천·독립 lifecycle projection·Capability Cache discovery·Drive-first 후보 제품 제안 |
| [`research/11-agent-runtime/fixtures/plugin-manifest-v0/`](../research/11-agent-runtime/fixtures/plugin-manifest-v0/) | Plugin Manifest v0 JSON fixtures(GitHub Issues, Google Workspace read-mostly, high-risk write approval policy) |
| `research/01·02·05a` | 유니콘 발굴 방법론 · 섹션 택소노미 · 에이전트 메신저 스캔(배경) |

---

## 5. GitHub 운영 / 부트스트랩

| 파일 | 역할 |
|---|---|
| [`scripts/github_bootstrap.sh`](../scripts/github_bootstrap.sh) | **spine 기반 일괄 부트스트랩**(라벨+마일스톤 M0~M8+시드이슈 MOMO-NNN, 멱등). `.github/labels.json` + `docs/BACKLOG.md` 정합. `--dry-run` 먼저. |
| [`.github/labels.json`](../.github/labels.json) | **라벨 택소노미 정본**(bootstrap이 jq로 읽음) |
| [`scripts/github/labels.tsv`](../scripts/github/labels.tsv) | 라벨 택소노미 사본(labels.json과 동일) |
| [`scripts/github/milestones.tsv`](../scripts/github/milestones.tsv) | 기존 7단계(M0~M6) 마일스톤 — backbone(M0~M8)의 **부분집합**(매핑: ROADMAP §6) |
| [`scripts/github/issues.tsv`](../scripts/github/issues.tsv) | 기존 시드 이슈 TSV(레거시) |
| [`scripts/github/bootstrap.sh`](../scripts/github/bootstrap.sh) | 기존(레거시) 부트스트랩 — 신규는 `scripts/github_bootstrap.sh` 사용 |
| [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/) | 이슈 템플릿(codex-goal/feature/bug/chore/config) |
| [`.github/pull_request_template.md`](../.github/pull_request_template.md) | PR 템플릿(AGENTS.md §5 정본) |
| [`.github/workflows/`](../.github/workflows/) | `ci-build.yml` · `release-ios.yml` · `release-macos.yml`은 비용 방지를 위해 manual-only(`workflow_dispatch`)이며 원격 workflow도 disabled 상태 유지 |

> **마일스톤 매핑:** 본 backbone(M0~M8 9단계)이 상위 정본. 기존 `milestones.tsv`(M0~M6 7단계)는 부분집합 — 매핑은 [`ROADMAP.md §6`](../ROADMAP.md).

---

## 6. 코드 디렉터리 (책임)

**현행 스택:**

| 경로 | 책임 |
|---|---|
| `server-rust/` | **Rust/Axum 워크스페이스**(ADR-0145). `bins/{momo-server,momo-relay,momo-agent-worker,momo-notifier,momo-migrate}` + `crates/momo-*`(messaging=쓰기경로 척추 · outbox · auth · db · agent · provider · push · drive · t3 · wire · settings · ephemeral) |
| `server/Migrations/` | **정본 DDL**(`00N_*.sql`). Rust 이미지가 그대로 싣는다 — 은퇴 아님 |
| `packages/momo-core/` | `@momo/core` — 웹·폰이 공유하는 TS 도메인 코어(레포 루트 npm 워크스페이스). **모델 사본 금지** |
| `clients/web/` | React/Vite SPA — 제품 웹 표면이자 데스크톱이 감싸는 번들. **라이브 서빙**(`server-rust/Dockerfile:147,157,173,231` → `/opt/momo/web/` · `web-assets`, #1228) |
| `clients/desktop/` | Tauri 2 셸(딥링크·mDNS·알림·키체인·업데이터). UI를 포크하지 않는다 |
| `clients/mobile/` | React Native 앱(현재 iOS) |
| `clients/web-legacy/` | ADR-0119 v0 웹 — 삭제 아님. 라이브 서빙은 `clients/web`. Swift prod Dockerfile·e2e web-init·`--profile web`가 아직 소비(#1610). 생성 타입이 `docs/api/openapi.yaml`과 동기화돼야 한다 |
| `adapters/hermes/` · `adapters/prime/` | `momo_adapter.py`(BasePlatformAdapter) + plugin.yaml (py3) · prime-agent 어댑터(스트림 릴레이·하네스 refine·RPC) |
| `infra/rust/` | **라이브 배포 경로** — Rust 이미지 compose + `Caddyfile`(정본) + 푸시/폰 오버레이 |
| `infra/` | dev `docker-compose.yml`(PG18+Centrifugo v6) · e2e `docker-compose.e2e.yml`(local gate boundary) · `centrifugo.json` · `.env.example`. Compose layer 정본은 `docs/adr/0002-docker-compose-layering.md` |

**은퇴 중(삭제 대기) — 읽어서 이해하는 용도이지 확장 대상이 아니다:**

| 경로 | 책임 |
|---|---|
| `clients/Core/` | MomoCore: 공유 모델 + `ChatBackend`/`AgentTransport` 프로토콜 |
| `clients/macOS/` · `clients/iOS/` | MomoMac(SwiftUI D/B/C) · MomoiOSKit |
| `server/Sources/` | MomoServer(Hummingbird 2) — Rust 재작성으로 대체됨 |
| `relay/OutboxRelay/` · `workers/` · `services/` | Swift 실행체(AgentWorker·WorkHostDaemon·NotifierWorker·LinkShort 등) |
| `relay/PushRelay/` | ※ **예외 — 은퇴 아님**: 라이브 푸시 경로가 지금도 빌드·배포한다 |
| `infra/prod/` · `fastlane/` | Swift prod compose(SOPS/age + pgBackRest 예시, 실제 secret 없음) · Apple 배포. ※ `infra/prod/Dockerfile.web`은 **Swift prod 경로**에서 web-legacy dist를 담는다(라이브 알파 아님, #1610) |

---

## 7. 🔒 불변식 요약 (어느 문서를 읽든 동일)

1. **Postgres = SoT, Centrifugo = 전송계층.** 클라는 Centrifugo로 직접 publish 금지(모든 상태변경 = REST→PG commit→outbox→relay publish).
2. **순서 SoT = `message.seq`**(`channel_seq` 행카운터 `UPDATE...RETURNING`, 시퀀스 금지). 에이전트 = 사람과 동일 `member`(kind='agent').
3. **멀티테넌시:** `workspace→channel→membership`, 모든 행 `workspace_id`, RLS FORCE, tx마다 `SET LOCAL app.workspace_id`. BYPASSRLS는 relay/admin-read에만.
4. **`schema_v0.sql` 이동·수정 금지** — 확장은 `server/Migrations/00N_*.sql` 신규 + RLS DO-block ARRAY 등록.
5. **🔒 게이트:** 스토어/공증 배포(M8)·external TestFlight는 검수 게이트(M7) PASS + `docs/cicd/03` PASS 블록 기록 후에만. 기록 없는 release = 규칙 위반.
6. **런타임 미검증 정직 표기:** docker/psql/hermes 없는 환경에선 `runtime-unverified (no docker/psql)`. "검증됨"으로 닫지 말 것.
7. **permissive 라이선스 유지**(Apache-2.0/MIT/PostgreSQL License). 법무 텍스트는 **법률 자문 아님**.
