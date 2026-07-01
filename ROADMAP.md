# momo — 릴리스 ROADMAP (M0 → M8)

> **목표:** 현재(Phase 0 = 5개 Swift 패키지 컴파일 통과, 런타임 미검증)에서 출발해
> **(A) macOS 데스크탑 공증 다운로드(Developer ID + notarytool)** 와 **(B) iOS App Store 정식 출시(업로드/심사/배포)** 까지 가는 정식 마일스톤 backbone.
>
> **실행 주체:** 계획은 이 문서(릴리스 PM), 실제 구현은 **Codex가 goal로 자율 실행**. 각 티켓은 Codex가 읽고 바로 착수 가능하도록 `id / epic / milestone / platform / deps / acceptance(체크가능) / labels / estimate` 로 작성됨.
>
> **불변식(스토어 게이트):** 🔒 **스토어/공증 배포(M8, external TestFlight 포함)는 사용성 검수 게이트(M7)가 PASS 된 후에만 진행한다.** "빌드 파일이 실제로 사용 가능"함을 빡세게 판명(=`docs/cicd/05-qa-release-gate.md` 객관 통과기준)하기 전에는 `release-ios.yml`/`release-macos.yml`을 트리거하지 않는다.
>
> **사실 근거:** Apple 1차 출처(2026 기준) 교차확인. 추정은 `(추정)` 표기. 비용/기간은 정확 수치. **법무 항목은 법률 자문이 아님 — 외부 변호사 1회 검토 필요.**

---

## 0. 현재 위치 (You Are Here)

```
M0 ── M1 ── M2 ─┐
                ├──► M7 (검수 게이트 🔒) ──► M8 (스토어/공증 배포)
M3 ── M4 ───────┤                            │
M3 ── M5 ───────┘                            │
M6 (CI/CD) ─────────────── 게이트/배포 자동화 ┘

  ▲
  └─ 현재: M1 런타임 G-0의 핵심 4개 게이트(MOMO-001~004)는 Docker Desktop으로 검증됨.
     · 5개 Swift 패키지 `swift build/test` green (MomoCore/MomoServer/OutboxRelay/AgentWorker/MomoMac)
     · 남은 M1 = MOMO-005/006/007로 staging/prod compose, SOPS/pgBackRest skeleton, local smoke gate는 준비됨
     · MOMO-220에서 local image 기반 internal host-runtime smoke를 추가해 prod+internal-smoke boot/health/migrate/message/relay/mock-agent 왕복을 검증한다
     · MOMO-221에서 prod/internal-host env preflight를 추가해 placeholder/dev-insecure/default secret bootstrap을 fail-fast로 막는다
     · MOMO-222에서 repo-local backup restore rehearsal gate를 추가해 temporary PG18 dump→separate restore→evidence markdown/json을 검증한다
     · MOMO-225에서 host-runtime + backup + macOS real-backend UI + diagnostics를 `internal-alpha` combined local gate evidence packet으로 묶는다
     · MOMO-228에서 internal alpha quickstart/feedback/known-limitations packet을 추가해 팀원이 local stack + MomoMacDevApp + invite/join + 김인턴 + diagnostics를 한 흐름으로 테스트할 수 있게 한다
     · MOMO-230에서 credentials가 있는 환경 전용 `external-agent-provider` opt-in gate를 추가해 real Hermes/Kim Intern SSE + local momo `@김인턴` 1왕복을 검증한다
     · MOMO-234에서 Codex OAuth token은 provider-owned이고 momo app/API/DB/local gate가 보관하지 않는 boundary를 ADR/verifier evidence/fail-fast guard로 고정한다
     · MOMO-231에서 internal alpha feedback을 `status:needs-triage` intake issue → severity/evidence/labels/milestone → buildable goal → worker PR/review 흐름으로 고정한다
     · MOMO-232에서 macOS real-server 내부 알파 사용성(초대 관리, 복구 가능한 오류, session reset, Kim Intern 상태 chip)을 보강한다
     · MOMO-229에서 public/staging host preflight를 보강해 DNS/TLS, pinned registry images, SOPS/age secret source, DB/Redis volumes, pgBackRest WAL/full-backup/PITR required env를 fail-fast하고 redacted markdown/json evidence packet을 만든다
     · MOMO-233에서 AWS 1주일 internal alpha stack v0를 EC2/Lightsail topology, 비용, 보안그룹, DNS/TLS, backup/restore, image-based deploy/rollback, static preflight로 고정한다
     · 실제 staging URL/TLS, SOPS 복호화, pgBackRest stanza/check/full backup/WAL/PITR restore rehearsal, 외부 hermes staging 연결은 public host-runtime 검증 필요
     · clients/macOS = SwiftPM dev app 가능 단계, 릴리스용 Xcode .app은 M4에서 진행
     · clients/iOS = 미존재, M5에서 생성
     · GitHub Actions는 비용/결제 이슈로 disabled + manual-only. 당분간 local gate가 PR merge 기준이며 `runtime-relay` profile은 MOMO-115, `runtime-live` profile은 MOMO-196, `runtime-agent` agent live-channel 검증은 MOMO-212에서 자동화됨
     · Docker compose/deploy layer 정본은 MOMO-182 ADR로 고정: dev(`infra/docker-compose.yml`), e2e(`infra/docker-compose.e2e.yml`), image-based prod, install/upgrade, backup/PITR
     · M2 진입: MOMO-010에서 schema_v0.sql 정본을 건드리지 않고 003_onboarding.sql 초대코드 DB 확장을 시작
     · CI/CD·QA·법무 문서는 선작성됨(docs/cicd/*, legal/*) — M7 실측/판정은 미진행
```

**Phase 0 baseline 상세는 `STATUS.md`. 빌드 백로그는 `BUILD_TICKETS.md`. 정본 스키마는 `schema_v0.sql`(이동·수정 금지, 확장은 `server/Migrations/00N_*.sql` 신규 파일).**

> 📌 **마일스톤 번호 매핑(기존 `scripts/github/milestones.tsv`와의 정합):** 본 ROADMAP은 가이드의 M0~M8 9단계 backbone이다. 기존 GitHub 마일스톤 7개(M0~M6)는 본 backbone의 **부분집합**이며, 본 문서가 상위 정본이다. 매핑은 §6 참조. (TSV는 이 ROADMAP에 맞춰 갱신 가능.)

---

## 1. 마일스톤 표 (정본)

> 트랙: 🖥 데스크탑(macOS) · 📱 모바일(iOS) · ⚙️ 공유/백엔드. 데스크탑·모바일은 **공유 Swift 코어(MomoCore)** 위에서 병렬 진행.

| ID | 이름 | 트랙 | 목표(goal) | 핵심 산출물 | 종료 기준(exit) | 의존 |
|---|---|---|---|---|---|---|
| **M0** | Foundation (완료) | ⚙️ | 리포 골격 + 5개 Swift 패키지 컴파일 + 정본 스키마/인프라/마이그레이션 파일 | `swift build` green ×5, schema_v0.sql, infra/*, Migrations/* | 컴파일 green ×5 + 파일 정합 (=Phase 0 baseline, **달성됨**) | — |
| **M1** | Backend 런타임 + 배포(staging) | ⚙️ | docker(PG18+Centrifugo v6+hermes)에서 서버 런타임 검증 + staging 배포(TLS/리버스프록시/시크릿/백업/모니터링) | 동작하는 staging 스택, RUN 런북 갱신 | 런타임 e2e PASS(아래 G-0) + staging URL 헬스 green | M0 |
| **M2** | 멀티팀 온보딩 | ⚙️ | 워크스페이스 스핀업 + 스핀업별 고유 초대코드 → 자가가입 + 플랫폼 관리자 전체 추적 | `003_onboarding.sql`, 온보딩 REST, 관리자 추적 뷰 | 3개+ 팀(10인=1팀) 격리 + 초대코드 자가가입 e2e + 관리자 전역 조회 | M1 |
| **M3** | 데스크탑 v0 UX (D/B/C 실데이터) | 🖥 | macOS 클라가 D Live Tool-Call · B 비용 호흡 · C 승인 인박스를 **실데이터**로 렌더 | MomoMac 실데이터 바인딩(VM↔LiveBackend) + `m3-dbc` local gate evidence | D/B/C 3경험이 local gate 실데이터/fixture 경로로 동작하고, external staging/Hermes는 별도 host-runtime 후속으로 남김 | M1 (data), M0 (UI 골격) |
| **M4** | 데스크탑 패키징 | 🖥 | macOS Xcode `.app` + Developer ID 서명 + 공증(notarytool) + DMG + Sparkle 자동업데이트 | `MomoMac.xcodeproj`, 공증 `.dmg`, appcast | 공증 `.dmg`가 타 맥에서 Gatekeeper 통과(`spctl --assess`) + Sparkle 업데이트 1회 | M3, (M8-선결: 게이트) |
| **M5** | iOS 앱 | 📱 | iOS Xcode App 타깃 + Push capability + 계정 삭제 + UGC 모더레이션 + privacy manifest | `MomoiOS.xcodeproj`, App Privacy, 모더레이션 4종 | 실기기에서 G-1/G-2 시나리오 통과(로그인→채널→메시지→에이전트 응답) | M3 (공유 UX), M2 (멀티팀) |
| **M6** | CI/CD | ⚙️ | fastlane(match/pilot/deliver/notarytool) + ASC API Key + GitHub Actions 자동화. 단, 2026-06-26부터 과금 방지를 위해 Actions는 disabled/manual-only이고 local gate가 우선 | `.github/workflows/{ci-build,release-ios,release-macos}.yml`, `fastlane/*`, `docs/LOCAL_PR_GATE.md` | local gate evidence 운영 + CI 재활성 시 green + (게이트 전) release 워크플로우 dry-run 성공 | M0 (skeleton), C1/C2(M4/M5 프로젝트), owner approval |
| **M7** | QA · 사용성 검수 게이트 🔒 | ⚙️ | "사용 가능 완전 판명" 객관 통과기준(크래시-free/e2e/접근성/성능/베타/Enterprise Trust) 측정·PASS | 계측(Sentry/MetricKit), XCUITest, PASS 기록 | **G-0~G-H 전부 PASS + 증거 첨부** (`05-qa-release-gate.md`) | M1,M3,M4,M5,M6 |
| **M8** | 스토어 제출 (App Store + Developer ID) | 🖥📱 | macOS 공증 DMG 공개 다운로드 + iOS App Store 업로드/심사/배포 | 공개 다운로드 페이지, App Store 출시 | App Store 승인·배포 + 공증 DMG 공개 + Sparkle 라이브 | **M7 (게이트 PASS 필수)**, M4, M5, M6 |

### 1.1 Local AI · Agent Protocol · Trust overlay

이 overlay는 기존 M1~M8 backbone을 깨지 않고, momo의 포지션을 "채팅앱"에서 "context/memory/policy가 있는 agent work OS"로 끌어올리는 제품·운영 축이다.

| Ticket | Milestone | 역할 | 종료 기준 |
|---|---|---|---|
| `MOMO-110` | M1 | Local LLM/agent protocol/Google Workspace/trust 리서치와 로드맵 문서화 | `research/10-local-ai-protocol-trust/*`, ROADMAP/BACKLOG/STATUS 갱신 |
| `MOMO-154` | M1 | GitHub Actions 자동 실행 차단 + local gate 우선순위 격상 | 원격 workflow disabled, workflow 파일 manual-only, 운영 문서/STATUS 갱신 |
| `MOMO-111` | M1 | GitHub Actions 비주요 기간용 local PR gate | `scripts/local_gate.sh --profile docs|swift|diagnostics|staging-smoke|host-runtime|backup|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|macos-ui|m3-dbc|all` + PR evidence 출력 |
| `MOMO-112` | M1 | 5개+ Codex session/worktree 운영 자동화 | `scripts/goal_status.sh` board + `goal_claim/release` + `.conductor/setup.sh` + handoff/충돌 방지 정본 |
| `MOMO-115` | M1 | runtime-relay local gate 자동화 | `scripts/verify_relay.sh` + `local_gate --profile runtime-relay`로 server send→outbox pending→relay claim→Centrifugo history→outbox done→`version=message.seq` evidence |
| `MOMO-199` | M1 | stale local worktree read-only audit | `scripts/goal_status.sh`가 closed issue/merged PR 연결 worktree를 `done-candidate`/`stale-warning`으로 분리하고 안전 cleanup command만 안내 |
| `MOMO-209` | M1 | stale worktree Docker Compose janitor | `scripts/compose_janitor.sh`가 stale `momo_` worktree Compose container/network를 dry-run 우선으로 목록화하고 명시적 `--cleanup`에서만 제거 |
| `MOMO-005` | M1 | staging/prod compose skeleton | Caddy 자동 TLS, PostgreSQL 18, Redis, Centrifugo v6 Redis engine, api/relay/worker compose skeleton |
| `MOMO-006` | M1 | SOPS/age + pgBackRest skeleton | secret template, pgBackRest config/cron, PITR rehearsal runbook; 실제 host rehearsal은 `runtime-unverified` |
| `MOMO-007` | M1 | local/staging smoke 운영 gate | `scripts/verify_staging_smoke.sh` + `local_gate --profile staging-smoke`; 실제 URL/TLS/PITR는 host-runtime |
| `MOMO-216` | M1 | internal single-node hosting smoke gate v0 | `infra/prod/docker-compose.internal-smoke.yml` + `internal-smoke.env.example` + `scripts/verify_internal_hosting_smoke.sh`; `local_gate --profile staging-smoke`에 포함, public TLS/DNS는 `runtime-unverified(public TLS/DNS)` |
| `MOMO-220` | M1 | internal single-node host-runtime smoke v0 | `scripts/verify_internal_host_runtime.sh` + `local_gate --profile host-runtime`; local images로 prod+internal-smoke boot, migrate idempotency, `/health`, REST send, relay publish, mock Hermes agent roundtrip 검증. public TLS/DNS/registry/SOPS/PITR는 `runtime-unverified(public host)` |
| `MOMO-221` | M1 | production secret/bootstrap hardening v0 | `scripts/prod_env_preflight.sh` + staging/internal-smoke/host-runtime verifier 연결; prod/internal-host placeholder/dev-insecure/default secret fail-fast, internal-smoke local placeholder 허용 경계와 SOPS operator checklist 문서화 |
| `MOMO-222` | M1 | Backup/PITR restore rehearsal gate v0 | `scripts/verify_backup_restore_rehearsal.sh` + `local_gate --profile backup`; repo-local PG18 dump→separate restore→marker checksum→markdown/json evidence. `host-runtime`에도 포함, real pgBackRest PITR는 `runtime-unverified(public host)` |
| `MOMO-229` | M1 | Public host preflight + deploy evidence packet v0 | `scripts/prod_env_preflight.sh --evidence-dir` + `local_gate --profile staging-smoke`; public/staging env shape, pinned registry images, SOPS/age source, named DB/Redis volumes, pgBackRest/WAL/PITR required env를 fail-fast하고 redacted markdown/json evidence 생성 |
| `MOMO-233` | M1/M7 준비 | AWS internal alpha stack v0 | `docs/AWS_INTERNAL_ALPHA.md` + `infra/prod/aws-internal-alpha.env.example` + `scripts/aws_internal_alpha_preflight.sh`; 최소/권장/분리 topology, Lightsail vs EC2 추천/비용, 보안그룹, DNS/TLS, backup/restore, image-based deploy/rollback을 static preflight로 고정 |
| `MOMO-227` | M1 | Kim Intern runtime config + health/status visibility v0 | `AGENT_PROVIDER_MODE` local/internal-host/external Hermes contract, staging/prod/internal-host external-provider fail-fast, `/v1/agent-runtime/status` secret-redacted projection, macOS compact Kim Intern availability chip, host-runtime status/redaction evidence |
| `MOMO-230` | M1 | External Kim Intern/Hermes provider smoke gate v0 | `scripts/verify_external_agent_provider.sh` + `local_gate --profile external-agent-provider`; credentials가 있으면 OpenAI-compatible SSE preflight + local server/worker/relay `@김인턴` 1왕복, 없으면 `runtime-unverified(external provider credentials)` evidence |
| `MOMO-234` | M1 | Hermes Codex OAuth provider boundary v0 | `docs/adr/0004-codex-oauth-hermes-provider-boundary.md` + external provider verifier evidence/guard; Codex OAuth access/refresh token은 provider-owned이고 momo app/API/DB/local gate에는 저장/전달하지 않음 |
| `MOMO-224` | M1 | internal alpha diagnostics/observability bundle v0 | `scripts/collect_diagnostics.sh` + `local_gate --profile diagnostics`; server/relay/worker/Centrifugo/macOS/local-gate evidence와 redacted env shape/commit을 directory + tar.gz + summary.md로 수집 |
| `MOMO-225` | M1 | Internal alpha combined local gate v0 | `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha`; host-runtime boot/health/migrate/message/relay/mock Kim Intern, backup restore rehearsal, MomoMacDevApp real-backend process/window, diagnostics bundle path를 한 evidence packet으로 수집 |
| `MOMO-228` | M3/M7 준비 | internal alpha runbook and feedback packet v0 | `docs/INTERNAL_ALPHA.md` + RUN/INDEX/LOCAL_PR_GATE/STATUS/ROADMAP/BUILD_TICKETS 연결; local stack, MomoMacDevApp, invite/join, 김인턴, diagnostics, bug report, known limitations를 팀원용 절차로 고정 |
| `MOMO-231` | M3/M7 준비 | internal alpha feedback intake + triage workflow v0 | GitHub `Internal alpha feedback` template + `docs/INTERNAL_ALPHA_FEEDBACK.md` + `status:needs-triage` board; severity/evidence/labels/milestone을 buildable goal과 worker handoff로 연결 |
| `MOMO-150` | M1.5 | Hermes/Kim Intern/openclaw agent runtime 분석 | `research/11-agent-runtime/*` + runtime gap/roadmap 정리 |
| `MOMO-151` | M1.5 | Context Packet v0 심화 | `research/11-agent-runtime/04-context-packet-v0.md` + mention/command/message-action fixtures |
| `MOMO-152` | M1.5 | Memory Plane v0 심화 | `research/11-agent-runtime/05-memory-plane-v0.md` + typed memory/retrieval permission fixtures |
| `MOMO-153` | M1.5 | Capability Cache v0 | `research/11-agent-runtime/06-capability-cache-v0.md` + agent/plugin/MCP capability cache, tool schema refs, invalidation, policy/capability version |
| `MOMO-180` | M1.5 | Agentic Work OS 시장/레포 topology 정렬 | `research/12-agentic-work-os/01-agentic-work-os-market-analysis.md` + `docs/adr/0001-agentic-work-os-repo-topology.md`; core monorepo 유지, plugin/catalog/SDK/MCP/landing repo split 기준, dev/e2e/prod deploy layering |
| `MOMO-181` | M1.5 | Plugin manifest v0 + catalog split criteria | `research/12-agentic-work-os/02-plugin-manifest-v0.md` + JSON fixtures; `plugin_id`/tools/scopes/runtime boundary/license/provenance, capability grants, approval metadata gate, audit/source/signature policy와 `momo-plugins`/first-party plugin/SDK repo split 기준 |
| `MOMO-182` | M1.5 | Docker compose layer ADR/dev-e2e-prod plan | `docs/adr/0002-docker-compose-layering.md`; dev/e2e/prod/install/upgrade/backup 경계, image-based prod deploy, optional external DB/TLS/agent runtime 방향 |
| `MOMO-186` | M1.5 | Deterministic e2e compose stack for local gates | `infra/docker-compose.e2e.yml` + `infra/e2e/bootstrap_roles.sql`; api/relay/worker/mock-Hermes/Postgres/Centrifugo boundary와 `local_gate --profile docs` config validation |
| `MOMO-183` | M1.5 | First-party plugin repo strategy | `research/12-agentic-work-os/03-first-party-plugin-repo-strategy.md`; GitHub/GitHub Issues → Google Workspace → Jira-like work items → Docs connector 우선순위, repo split 순서, plugin surface/audit/source/approval contract |
| `MOMO-184` | M1.5 | Agent host positioning/product messaging | `research/12-agentic-work-os/03-agent-host-positioning.md` + README reusable copy; channel timeline execution ledger 중심 제품 문장 |
| `MOMO-120` | M2 | Context Packet v0 | `{goal,constraints,decisions,sources,permissions,budget,redactions}` 스펙/fixture |
| `MOMO-121` | M2 | Memory Plane v0 | typed memory(decision/preference/artifact/task_state/source_ref) + 권한/삭제 모델 |
| `MOMO-122` | M2 | Google Workspace connector v0 | `research/11-agent-runtime/12-google-workspace-connector-v0.md` + Drive/Gmail/Calendar fixtures; per-user OAuth + read-mostly sync + approval-gated writes |
| `MOMO-123` | M2 | Google Workspace enterprise admin | `research/11-agent-runtime/13-google-workspace-enterprise-admin-v0.md` + enterprise admin install/DWD/scope inventory/audit export/revoke fixtures |
| `MOMO-130` | M3 | macOS Foundation Models capability probe | 완료: `canImport`/availability/fallback 경로 + MomoMac state surface |
| `MOMO-131` | M3 | Local Context Copilot | 진행 중: macOS sidebar preview shell + Foundation Models/fallback route + source-preserving deterministic preview |
| `MOMO-132` | M3 | Agent Protocol v0 | `agent_request/context_packet/tool_call/approval/tool_result/usage/audit` DB/wire/Swift/card 정합 |
| `MOMO-133` | M3 | Google Workspace "ask my work" UX | source citation + approval-gated external writes |
| `MOMO-134` | M3 | build-macos-apps 기반 macOS dev run loop | 완료: `scripts/macos_dev_run.sh` dev `.app` staging + Codex Run action + `--verify/--logs` + local gate opt-in |
| `MOMO-160` | M2 | A2A-style agent_run lifecycle alignment | `research/11-agent-runtime/07-agent-run-lifecycle-v0.md` + Task/Message/Artifact/status mapping |
| `MOMO-161` | M2 | approval pause/resume runtime | `research/11-agent-runtime/08-approval-pause-resume-runtime.md` + worker pause slice; server decision endpoint/resume job contract is MOMO-167, approved deterministic resume executor is MOMO-178 |
| `MOMO-166` | M2 | approval decision server contract v0 | `research/11-agent-runtime/10-approval-decision-server-contract-v0.md` + request/response fixtures; connects MOMO-161 runtime checkpoint to MOMO-171 macOS decision intent |
| `MOMO-167` | M2 | approval decision endpoint runtime | server REST decision endpoint + `approval_decision` idempotency ledger + audit/outbox resume contract + `runtime-db` verifier |
| `MOMO-178` | M2 | AgentWorker approved tool resume executor v0 | `method='resume_approval'` worker branch + fail-closed approved metadata/frozen payload checks + deterministic mock tool_result/audit runtime smoke |
| `MOMO-162` | M2 | Hermes adapter contract verification | `research/11-agent-runtime/11-hermes-adapter-contract-v0.md` + fixtures; AgentWorker SSE product default, platform adapter optional interop |
| `MOMO-168` | M2 | Hermes adapter repo-local smoke harness | `adapters/hermes/tests/smoke_momo_adapter.py` + `local_gate --profile docs`; live Hermes plugin load/e2e remains runtime-unverified |
| `MOMO-163` | M2 | inbound MCP server v0 | governed search/fetch/post/approval-safe tool call surface + resources/prompts/fixtures |
| `MOMO-172` | M2 | inbound MCP server v0 skeleton/spec-to-code bridge | server registry/routes/stub + endpoint/security docs |
| `MOMO-170` | M3 | macOS agent protocol cards | `tool_call`/approval/result/artifact cards + Context Packet/Memory/Capability/source/cost badges + SwiftUI fixture contract |
| `MOMO-171` | M3 | macOS approval_request card decisions | Approve/Reject buttons call `ChatBackend.decideApproval(ApprovalDecisionRequest)` and reconcile receipt/realtime state |
| `MOMO-174` | M3 | local LLM context compaction | 완료: source-preserving Context Packet compaction v1 + availability-safe Foundation Models route + deterministic fallback |
| `MOMO-177` | M3 | macOS MomoServer REST ChatBackend v0 | 완료: `MOMO_SERVER_BASE_URL` dev config로 REST login/history/send 사용, LiveChatBackend fallback 유지 |
| `MOMO-197` | M3 | Server channel list + macOS dynamic channel loading v0 | 완료: `GET /v1/workspaces/{ws}/channels` + macOS REST bootstrap server channel list, LiveChatBackend fallback 유지 |
| `MOMO-214` | M2/M3 | Channel create + membership management runtime v0 | owner/admin `POST /channels`, member add/remove endpoints, human/agent channel membership, `channel_seq` provisioning, cross-workspace guard; `scripts/verify_channel_management.sh` + `runtime-db` local gate |
| `MOMO-179` | M3 | Realtime client subscription contract v0 | `research/11-agent-runtime/14-realtime-client-subscription-contract-v0.md` + fixtures; exact channel/token boundary, MomoCore event mapping, `message.seq` replay/gap-fill/reconnect; live SwiftCentrifuge remains runtime-unverified |
| `MOMO-192` | M3 | Server realtime-token endpoint v0 | `POST /v1/auth/realtime-token` protected by app access JWT; active member recheck under tenant RLS; short-lived Centrifugo connection JWT with member/workspace claims; subscribe proxy keeps channel membership boundary |
| `MOMO-193` | M3 | SwiftCentrifuge RealtimeSubscriptionDriver v0 | `MomoCore` realtime driver/replay controller + macOS REST backend injection seam; duplicate/gap/backfill tests pass; actual SwiftCentrifuge adapter/live e2e remains runtime-unverified |
| `MOMO-196` | M3 | Realtime WebSocket live subscribe verifier v0 | `scripts/verify_realtime_live.sh` + `local_gate --profile runtime-live`; dev compose PG/Centrifugo + host API/relay + `api:8080` proxy token→subscribe→REST send→live `message.new` with `payload.message.seq` evidence; SwiftCentrifuge adapter/reconnect UX remains runtime-unverified |
| `MOMO-198` | M3 | D/B/C real-data readiness spec | `research/11-agent-runtime/15-m3-dbc-real-data-readiness.md`; stale MOMO-020/021/022 blockers remapped to current code and MOMO-200~204 follow-up slices |
| `MOMO-200` | M3 | macOS SwiftCentrifuge live adapter | SwiftCentrifuge 0.9.0 MIT dependency + `/v1/auth/realtime-token` connection token getter + `ch:ws<workspace>.<channel>` `RealtimeEnvelopeSubscriptionTransport` injection; `runtime-live` channel subscribe evidence PASS; `agent:` live boundary is covered by MOMO-212, production reconnect UX polish remains follow-up |
| `MOMO-201` | M3 | D Live Tool-Call fixture/local gate | 완료: mock SSE/runtime fixture emits `agent.partial` tool-call progress with bounded args + final `tool_result`/`message.new`; MomoMac reconciles progress card to final `message.seq` timeline |
| `MOMO-202` | M3 | Cost projection + CostSnapshot binding | 완료: `GET /v1/workspaces/{ws}/channels/{ch}/cost-snapshots` server-owned projection + macOS `CostSnapshot` binding; runtime-agent endpoint evidence |
| `MOMO-203` | M3 | Approval pending projection + inbox gate | `GET /v1/workspaces/{ws}/approvals?status=pending` server-owned read model + macOS C inbox initial load + receipt/`approval.decided` reconciliation; two-workspace/member guard covered by `runtime-db` |
| `MOMO-204` | M3 | Combined M3 D/B/C local gate profile | `scripts/local_gate.sh --profile m3-dbc`가 D tool-call, B cost projection, C approval decision, macOS REST/UI evidence를 한 block으로 수집; #12(MOMO-020)는 profile PASS+merge 후 close-ready |
| `MOMO-205` | M3 | macOS real-backend dev app smoke gate | `scripts/verify_macos_real_backend_ui.sh` + `local_gate --profile macos-ui`; Docker+migrate+host MomoServer REST login/channel list/history/send plus approval/cost fixture evidence, with `LOCAL_GATE_LAUNCH_UI=1` process/window launch still opt-in |
| `MOMO-207` | M3 | macOS realtime reconnect status UX | 완료: `MomoCore` realtime status model + SwiftCentrifuge lifecycle status stream + `ChatViewModel` retry + MomoMac Live/REST fallback banner; swift/macos-ui gates PASS |
| `MOMO-212` | M3 | Agent channel live subscription verifier v0 | 완료: Centrifugo `agent:ws<workspace>.<agentMember>` subscribe proxy + server shared-channel membership guard + `scripts/verify_agent_live_channel.sh`; authorized member receives `agent.status`/`agent.partial`, invalid token/no-shared-channel/other-workspace/direct publish denied; `runtime-agent` covers agent live-channel evidence |
| `MOMO-213` | M3 | macOS real-server session/onboarding UI v0 | `MomoMacDevApp` first-run/session surface can enter server URL/email/password/optional invite code, login or `/v1/join`, and open the existing channel/timeline/approval/cost UI against a real MomoServer while preserving explicit demo fallback |
| `MOMO-218` | M3 | macOS channel management UI v0 | macOS real-server sidebar can create public/private channels and add/remove human/agent members using MOMO-214 REST endpoints; roster projection carries active `channelIds`; `macos-ui` smoke covers channel create + agent add/remove |
| `MOMO-215` | M3 | Agent mention routing e2e v0 | 완료: REST `POST /messages`의 `@김인턴`/agent mention이 same-channel `agent_run` + `agent_job`으로 이어지고, duplicate `client_msg_id`는 job dedupe, non-channel agent는 audit no-op, mock SSE는 `agent:` progress + final channel `message.new`로 reconcile |
| `MOMO-217` | M2/M3 | Auth password verification runtime hardening v0 | `POST /v1/auth/login` password stub 제거, pgcrypto `momo_password_hash`/`momo_password_verify`, demo/join 계정 password_hash 검증, platform admin secret 분리, `runtime-db`/`swift` local gate |
| `MOMO-219` | M3 | macOS agent mention UX v0 | 완료: macOS agent roster click/context action inserts `@김인턴`/`@kim-intern`, optimistic/progress/final reconcile is visible, REST fallback refreshes durable final history, LiveChatBackend has deterministic Kim Intern mention response |
| `MOMO-223` | M3 | macOS session/account/server switch + logout polish v0 | 완료: session bar/details에서 server/workspace/member/realtime fallback 상태를 확인하고, Switch/Log Out이 token/workspace/channel/realtime cache와 password-sensitive state를 지운 뒤 chooser로 돌아간다 |
| `MOMO-226` | M3 | macOS invite/admin onboarding real-backend polish v0 | 완료: real-server session bar에서 invite create/list/revoke compact admin surface를 제공하고, `/v1/join` second-user smoke 후 workspace/channel/member state load를 `macos-ui` evidence에 포함 |
| `MOMO-232` | M3 | macOS internal alpha usability polish v0 | 진행: invite admin 중복 submit/progress/retry/copy-code, session switch/logout stale-state cleanup, recoverable error retry/dismiss, Kim Intern provider chip mode/diagnostics polish |
| `MOMO-140` | M7 | Enterprise Trust Gate | SOC2/ISO/Pentest/SBOM/threat model/security whitepaper evidence를 QA gate 입력화 |

### 1.2 Agentic Work OS ecosystem overlay

MOMO-180은 Paca/OpenHands/Linear/Rovo/GitHub Copilot/Slack/MCP/A2A 흐름을 기준으로 momo의 생태계 방향을 고정한다. MOMO-184는 이를 제품 메시지로 압축해 "Paca를 복제하지 않고, 채널 타임라인을 context/approval/cost/audit execution ledger로 만드는 self-hosted enterprise agent host"를 reusable copy로 고정한다.

로드맵 영향:

- `momo` core monorepo는 M3/M4까지 유지한다. server/relay/worker/clients/schema/protocol이 아직 함께 움직이므로 조기 split은 금지한다.
- repo split은 ecosystem surface부터 시작한다: `momo-plugins`, first-party plugin repos, plugin SDK repos, `momo-mcp`, `momo-landing`, private `momo-signing`.
- plugin v0는 `research/12-agentic-work-os/02-plugin-manifest-v0.md`를 정본으로 manifest/capability grants/Context Packet `tool_grants`/Capability Cache `plugin_tool_schema`/approval metadata gate/audit/source/signature/catalog 중심으로 먼저 고정한다. WASM runtime은 M5+ 후속 선택지이며, v0 기본값은 governed connector + approval/cost/audit ledger다.
- first-party plugin 순서는 `research/12-agentic-work-os/03-first-party-plugin-repo-strategy.md`를 정본으로 둔다: `momo-plugin-github`(GitHub/GitHub Issues) → private-first `momo-plugin-google-workspace` → neutral `momo-plugin-work-items` → `momo-plugin-docs`. 각 plugin은 slash command, message context action, approval card, source provider, audit event를 Manifest v0 / Context Packet `tool_grants` / Capability Cache / Memory Plane permission model에 연결해야 한다.
- Docker/deploy는 `docs/adr/0002-docker-compose-layering.md`를 정본으로 dev/e2e/prod/install/backup layer를 분리한다. 실제 prod deploy, image publish, installer 구현은 후속 티켓에서만 수행한다.
- product messaging은 `research/12-agentic-work-os/03-agent-host-positioning.md`를 정본으로 둔다. 핵심 문장: channel timeline execution ledger, first-class agent member, protocol surface, self-hosted trust boundary, local LLM future.

후속 빌더블 후보:

- `MOMO-181`: Plugin manifest/catalog split criteria.
- `MOMO-182`: Docker compose layer ADR/dev-e2e-prod plan. 완료 후 정본은 `docs/adr/0002-docker-compose-layering.md`.
- `MOMO-186`: Deterministic e2e compose stack. 완료 후 정본은 `infra/docker-compose.e2e.yml` + docs/static local gate config validation.
- `MOMO-183`: First-party plugin repo strategy. 완료 후 정본은 `research/12-agentic-work-os/03-first-party-plugin-repo-strategy.md`.
- `MOMO-184`: Agent host positioning/product messaging. 완료 후 정본은 `research/12-agentic-work-os/03-agent-host-positioning.md`.

### 비용 / 기간 (정확 수치 · Apple 1차 출처, 2026 기준)

| 항목 | 비용 | 비고 |
|---|---|---|
| Apple Developer Program (조직) | **$99 USD/년** | 법인격 + D-U-N-S Number 필요. [출처: developer.apple.com/help/account/membership/program-enrollment/] |
| D-U-N-S Number | **무료**, Apple 반영 최대 영업일 2일(D&B 최대 5영업일, expedite 불가) | 회사/교육기관만 필수, 개인 불필요. [developer.apple.com/help/account/membership/D-U-N-S/] |
| iOS 업로드 SDK 요건 | 비용 0 (게이트) | **2026-04-28부터 iOS 26 SDK + Xcode 26 이상으로 빌드해야 App Store Connect 업로드 가능.** [developer.apple.com/news/?id=fxu2qp7b] |
| privacy manifest | 비용 0 (필수) | 2024-11-12부터 데이터 수집/required-reason API/특정 SDK 포함 시 제출 필수. [developer.apple.com/news/?id=pvszzano] |
| macOS 공증 | 비용 0 (Developer ID 포함) | altool 폐기(2023-11-01) → **notarytool 유일 경로**. [developer.apple.com/documentation/security/customizing-the-notarization-workflow] |
| App Review 심사기간 | — | 다수 24~48h 내 결과 `(추정 — Apple 미보장, UGC/첫제출은 더 김)`. |
| TestFlight | 비용 0 | 내부 ≤100(심사 없음), 외부 ≤10,000(첫 빌드 Beta App Review), 빌드 90일 만료. |
| GitHub Actions macOS 러너 | $0.062/분 (2026 인하 후) | 무료 쿼터는 macOS 10x 승수 → Free 2,000분 ≈ macOS 200분/월. |
| VPS (staging/prod 1대) | ~$30~50/월 `(추정)` | 전용 vCPU 4코어/16GB급. 주문 시점 단가 재확인. |

> 도메인 10~20/yr · PostgreSQL 셀프호스트 0 · 백업 오브젝트스토리지 월 $1 미만~수달러 `(추정)`.

---

## 2. 의존 그래프

### 2.1 마일스톤 레벨

```
        ┌──────────────────────────── 공유 Swift 코어 (MomoCore) ────────────────────────────┐
        │                                                                                      │
M0 ─────┼──► M1(런타임+staging) ──► M2(멀티팀 온보딩) ──┐                                       │
Foundation │         │                                  │                                       │
(완료)     │         └──► M3(데스크탑 v0 UX, D/B/C) ─────┤                                       │
        │                          │                    │                                       │
        │            ┌─────────────┴──────────┐         │                                       │
        │            ▼ (🖥 데스크탑 트랙)       ▼ (📱 모바일 트랙)                                │
        │          M4(패키징: Xcode/공증/DMG/Sparkle)  M5(iOS 앱: Push/계정삭제/UGC/manifest)    │
        │            │                          │       │                                       │
        └────────────┼──────────────┬──────────┘       │                                       │
                     │              │                   │                                       │
M6(CI/CD: fastlane/ASC Key) ────────┴───────────────────┤  (M4/M5 Xcode 프로젝트 = C1/C2 선결)   │
                                                         │                                       │
                                                         ▼                                       │
                                  ┌──────────────────────────────────────────┐                  │
                                  │  M7  QA · 사용성 검수 게이트 🔒            │                  │
                                  │  (M1·M3·M4·M5·M6 전부 입력)                │                  │
                                  │  G-0 런타임 e2e · G-A 크래시-free ·        │                  │
                                  │  G-B e2e 8/8 · G-C 접근성 · G-D 성능 ·     │                  │
                                  │  G-E 베타 · G-F 피드백 · G-G 릴리스준비     │                  │
                                  │  G-H Enterprise Trust evidence              │                  │
                                  └────────────────────┬─────────────────────┘                  │
                                                       │ PASS만 통과                            │
                                                       ▼                                         │
                                  ┌──────────────────────────────────────────┐                  │
                                  │  M8  스토어 제출                          │ ◄────────────────┘
                                  │  🖥 Developer ID 공증 DMG 공개 다운로드 + Sparkle 라이브       │
                                  │  📱 App Store Connect 업로드 → App Review → phased/즉시 배포   │
                                  └──────────────────────────────────────────┘
```

### 2.2 임계 경로(critical path)

```
M0 → M1 → M2 → M5(iOS) → M7(게이트) → M8(App Store)   ← 모바일 임계 경로
M0 → M1 → M3 → M4(공증) → M7(게이트) → M8(공증 DMG)    ← 데스크탑 임계 경로
```

- **데스크탑/모바일 병렬:** M3 이후 M4(🖥)와 M5(📱)는 **공유 코어(MomoCore) 위에서 병렬**. M6(CI/CD)도 병렬로 진행하되 release 잡 활성화는 M4/M5의 Xcode 프로젝트(C1/C2), 게이트(M7), owner approval에 종속된다. 현재 Actions는 비용 방지를 위해 disabled/manual-only다.
- **🔒 게이트 컷:** M4·M5·M6가 기술적으로 "배포 가능" 상태여도, **M7 PASS 전에는 M8(external TestFlight 포함)을 절대 진행하지 않는다.** 이것이 본 로드맵의 단일 차단 불변식.

---

## 3. 트랙 분리 (데스크탑 / 모바일 / 공유)

### 3.1 ⚙️ 공유 / 백엔드 트랙
- **MomoCore**(`clients/Core`): 모델 + `ChatBackend`/`AgentTransport` 프로토콜 — 데스크탑/모바일 공유 단일 진실원천.
- **백엔드 런타임/배포**(M1): 단일 강력 VPS + docker-compose + Caddy(자동 TLS) + Centrifugo Redis 엔진 + PG18 + pgBackRest(PITR) + SOPS/age 시크릿 + 경량 모니터링. staging/prod 분리. MOMO-007의 `staging-smoke` local gate가 prod compose/Caddy/Centrifugo/secrets/pgBackRest checklist를 실제 VPS 시크릿 없이 먼저 검증하고, MOMO-221의 prod env preflight가 placeholder/dev-insecure/default secret bootstrap을 fail-fast로 막으며, MOMO-222의 `backup` gate가 repo-local restore evidence를 만든다. MOMO-227부터 Kim Intern/Hermes는 `AGENT_PROVIDER_MODE`로 local mock/internal-host mock/external Hermes 경계를 명시하고, staging/prod/internal-host에서 unsafe external provider config를 fail-fast 처리하며, `/v1/agent-runtime/status`와 macOS compact status surface로 secret-redacted availability를 노출한다. MOMO-230은 real external provider side effect를 기본 mock gate에서 분리해 `external-agent-provider` opt-in profile로 닫는다. MOMO-234는 Codex OAuth access/refresh token이 Hermes/Kim Intern provider-owned이며 momo app/API/DB/local gate에 저장/전달되지 않는 credential boundary를 ADR과 verifier fail-fast guard로 고정한다. 실제 URL/TLS/pgBackRest stanza·WAL·time-target PITR restore는 public host-runtime으로 닫고, credentials 없는 real provider smoke는 `runtime-unverified(external provider credentials)`로 남긴다.
- **Agentic Work OS ecosystem**(M1.5~M4): Paca류 task/board OS를 복제하지 않고, momo는 channel timeline을 agent execution ledger로 유지한다. 정본은 `research/12-agentic-work-os/01-agentic-work-os-market-analysis.md`와 `docs/adr/0001-agentic-work-os-repo-topology.md`. repo split은 core monorepo 안정화 이후 plugin catalog/SDK/MCP/landing/signing 경계부터 진행한다.
- **멀티팀 온보딩**(M2): `003_onboarding.sql` 첫 slice는 `invite_code` + redemption audit로 시작한다(MOMO-010). invite code 운영 REST(create/list/revoke + authenticated redeem 최소 slice)는 MOMO-011에서 완료했고, macOS에서 먼저 확인 가능한 invite UI thin slice는 MOMO-012, production `/v1/join` self-signup member/human/membership 생성 + audit_log는 MOMO-014에서 서버 runtime slice로 추가했다. `platform_admin` 전역 추적은 MOMO-013에서 별도 BYPASSRLS + SELECT-only read path로 추가했고 runtime-db local gate에서 2개+ workspace 전역 조회를 검증한다. MOMO-176은 normal tenant token + active membership guard + RLS 경로로 workspace human/agent roster REST를 추가해 M2/M3 실데이터 surface를 열었고, MOMO-214는 owner/admin channel create + human/agent member add/remove runtime path를 같은 tenant/RLS 원칙으로 추가한다. `schema_v0.sql` 정본은 수정 금지, 신규 마이그레이션으로만 확장한다.

- **Context Broker + Memory Plane**(M2~M3): 서버 agent로 바로 넘기지 않고 messenger layer가 권한, 컨텍스트 범위, source refs, cost budget, redaction, local/server model routing을 결정한다. 정본: `research/10-local-ai-protocol-trust/01-local-llm-context-broker.md`.
- **Agent Runtime Spec**(M1.5~M3): Hermes/Kim Intern/openclaw를 기준으로 memory/cache/protocol gap을 메우고, momo가 agent host로서 context/capability/execution/ledger 4-plane을 소유한다. Context Packet v0 정본은 `research/11-agent-runtime/04-context-packet-v0.md`, Memory Plane v0 정본은 `research/11-agent-runtime/05-memory-plane-v0.md`, Capability Cache v0 정본은 `research/11-agent-runtime/06-capability-cache-v0.md`, Agent Run Lifecycle v0 정본은 `research/11-agent-runtime/07-agent-run-lifecycle-v0.md`, Approval Pause/Resume v0 정본은 `research/11-agent-runtime/08-approval-pause-resume-runtime.md`, Approval Decision Server Contract v0 정본은 `research/11-agent-runtime/10-approval-decision-server-contract-v0.md`, MOMO-167은 이 contract의 server runtime endpoint/ledger/resume job slice이며, Hermes Adapter Contract v0 정본은 `research/11-agent-runtime/11-hermes-adapter-contract-v0.md`이다. runtime gap/roadmap 정본은 `research/11-agent-runtime/*`.
- **Agent Protocol v0**(M3): `agent_request`, `context_packet`, `tool_call`, `approval_request`, `tool_result`, `usage_ledger`, `audit_log`를 DB/wire/Swift/macOS card에서 동일 의미로 유지한다. Approval은 client-only card가 아니라 `agent_run.status='awaiting_approval'`로 멈추는 protocol checkpoint다. 정본: `research/10-local-ai-protocol-trust/02-agent-protocol-google-workspace.md`, `research/11-agent-runtime/02-memory-cache-protocol-gaps.md`, `research/11-agent-runtime/08-approval-pause-resume-runtime.md`, `research/11-agent-runtime/10-approval-decision-server-contract-v0.md`.
- **Google Workspace connector**(M2~M3): v0는 per-user OAuth + read-mostly sync(Drive changes/selected excerpts, Gmail thread/search, Calendar availability/events)로 시작하고, Context Packet `sources`, Memory Plane `external_source_ref`, Capability Cache `tool_grants`로만 투영한다. external write는 approval card 뒤에 둔다. Domain-wide delegation은 기본값이 아니라 enterprise-only 옵션이며 admin consent, service account boundary, scope inventory, delegated user, audit export, revoke/delete는 `research/11-agent-runtime/13-google-workspace-enterprise-admin-v0.md`가 정본이다. per-user OAuth 정본: `research/11-agent-runtime/12-google-workspace-connector-v0.md`.
- **Local PR gate / multi-session ops**(M1): GitHub Actions는 현재 비용/결제 이슈로 disabled/manual-only이며, PR body local evidence와 worktree branch lock을 하드 운영 규칙으로 둔다. `runtime-relay`는 MOMO-115부터 Docker compose/migrate/server send/outbox/relay/Centrifugo evidence까지 자동화되고, `runtime-live`는 MOMO-196부터 dev compose PG/Centrifugo + host API/relay + `api:8080` proxy 기반 live WebSocket subscribe evidence까지 자동화된다. MOMO-186부터 docs/static local gate는 `infra/docker-compose.e2e.yml` config validation으로 e2e stack boundary drift도 잡는다. MOMO-199부터 `scripts/goal_status.sh`는 closed issue/merged PR 연결 worktree를 read-only로 audit하고, clean/pushed candidate에만 cleanup command를 출력한다. MOMO-209부터 `scripts/compose_janitor.sh`는 stale `momo_` worktree Docker Compose container/network를 dry-run 우선으로 목록화하고 명시적 cleanup에서만 제거한다. 정본: `docs/LOCAL_PR_GATE.md`, `docs/MULTI_SESSION_OPS.md`.

### 3.2 🖥 데스크탑 트랙 (macOS)
- **v0 UX**(M3): D/B/C 실데이터 바인딩. MOMO-204부터 `scripts/local_gate.sh --profile m3-dbc`가 M3 exit용 combined local evidence를 수집하며, 오래된 MOMO-020 staging/Hermes 문구는 이 local-gate 기준으로 재판정한다.
- **Local LLM UX**(M3): Foundation Models availability probe는 `MomoMac` target 안에서 완료했다(MOMO-130). MOMO-131은 macOS sidebar에서 local summarization/classification/context compaction/PII redaction preview shell을 추가하고, 미지원 OS와 CI/local gate는 deterministic fallback/stub으로 green 유지한다. MOMO-174는 source id/URI/citation을 보존하는 Context Packet compaction v1과 availability-safe Foundation Models generation wrapper를 추가했다.
- **macOS 개발 loop**(M3): `build-macos-apps` 플러그인은 SwiftPM build/test/triage와 GUI 실행 표준화에 사용한다. MOMO-134에서 repo convention에 맞춘 `scripts/macos_dev_run.sh`가 `dist/MomoMacDevApp.app`을 staging하고 Codex Run action 및 `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui`와 연결된다.
- **REST 실데이터 바인딩**(M3): MOMO-177에서 `MomoMacDevApp`은 `MOMO_SERVER_BASE_URL` 설정 시 MomoServer REST `/v1/auth/login` + message history/send를 사용한다. MOMO-197에서 서버 `GET /v1/workspaces/{ws}/channels`와 macOS REST bootstrap dynamic channel loading을 추가해 demo-fixed channel list 의존을 제거했다. MOMO-205에서 `macos-ui` local gate는 Docker+migrate+host MomoServer REST login/channel list/history/send와 approval/cost structured history evidence를 남기며, UI process/window launch는 `LOCAL_GATE_LAUNCH_UI=1` opt-in으로 유지한다. MOMO-213에서 env-only 의존을 낮추고 앱 안 session/onboarding UI가 server URL/email/password/optional invite code를 받아 login 또는 `/v1/join` 후 기존 D/B/C UI로 진입한다. MOMO-217에서 demo/join account password_hash verification을 닫았고, MOMO-223에서 session/account/server switch, logout, reconnect/fallback status polish를 닫았다. MOMO-226에서 real-server session chrome에 invite create/list/revoke admin surface를 추가하고, `macos-ui` smoke가 fresh invite second-user join 및 workspace/channel/member state load까지 검증한다.
- **Realtime subscription contract/driver**(M3): MOMO-179는 SwiftCentrifuge 구현 전 `ch:ws<workspace>.<channel>` / `agent:ws<workspace>.<agent>` channel naming, realtime-token source, subscribe proxy boundary, `RealtimeEnvelope` shape, `message.seq` duplicate/gap/reconnect replay, REST backfill, and macOS `ChatViewModel` apply boundary를 고정했다. MOMO-193은 이를 `MomoCore.RealtimeSubscriptionDriver`/`RealtimeReplayController`와 macOS REST backend injection seam으로 코드화했다. MOMO-196은 repo-local WebSocket helper로 dev compose PG/Centrifugo + host API/relay + `api:8080` proxy에서 realtime-token→Centrifugo subscribe→REST send→live `message.new` 수신을 검증한다. MOMO-200은 macOS SwiftCentrifuge dependency/adapter를 추가하고 같은 `runtime-live` channel subscribe path를 PASS로 확인했다. MOMO-207은 channel live connection/subscription/reconnect/error status stream과 manual retry, REST fallback banner를 MomoMac UI에 노출했다. MOMO-212는 `agent:ws<workspace>.<agentMember>` subscribe proxy/shared-channel guard와 authorized `agent.status`/`agent.partial` live evidence를 닫았다. MOMO-215는 REST 채널 send의 자연어 `@agent` mention이 same-channel `agent_job`으로 이어지고 mock SSE progress와 final durable `message.new`가 각각 `agent:`/`ch:` live surface로 돌아오는 제품 경로를 닫았다. MOMO-219는 이 runtime path를 macOS roster/composer UX로 노출하고 REST fallback에서도 durable final history refresh로 결과를 보이게 한다. Presence/APNs는 후속 범위다. 정본: `research/11-agent-runtime/14-realtime-client-subscription-contract-v0.md`, `research/11-agent-runtime/15-m3-dbc-real-data-readiness.md`.
- **Onboarding dev UX**(M2/M3 bridge): MOMO-012는 실제 서버 join API 전에도 `MomoMacDevApp`에서 invite code 입력, join 성공/실패, workspace join 상태를 `LiveChatBackend` stub으로 확인할 수 있게 한다.
- **Agent protocol cards**(M3): `MOMO-170`은 macOS timeline에서 `tool_call`, `approval_request`, `tool_result`, `artifact`, cost, memory citation, source badge를 Context Packet/Memory Plane/Capability Cache projection으로 렌더하는 v0 contract다. `MOMO-171`은 `approval_request` 카드의 Approve/Reject 개발 UX를 `ChatBackend` approval decision 계약에 연결한다. `MOMO-198`은 old D/B/C tickets를 그대로 닫지 않고 MOMO-200~204의 builder-friendly blockers로 쪼갠다. 정본: `research/11-agent-runtime/07-macos-agent-protocol-cards-v0.md`, `research/11-agent-runtime/15-m3-dbc-real-data-readiness.md`.
- **패키징**(M4): 정본 ADR = `docs/adr/0003-macos-packaging-architecture.md`. SwiftPM `MomoMacDevApp`은 개발/로컬 게이트용으로 유지한다. MOMO-211부터 릴리스용 Xcode `MomoMac.app` thin host가 `clients/macOS/MomoMac.xcodeproj`에 있으며 `MomoMac`/`MomoCore`를 로컬 SwiftPM 의존으로 소비하고 무서명 build gate를 통과한다. 이후 순서: bottom-up codesign(`--options runtime --timestamp`) → Developer ID Application → create-dmg → **notarytool submit --wait** → stapler staple → `spctl` 검증 → Sparkle 2(EdDSA, appcast). **App Store 트랙과 별개**(공증=직접배포, App Store≠공증).
- **배포 채널 순서:** Developer ID 공증 DMG + Sparkle 먼저, Mac App Store는 추후(샌드박스 강제·심사·Sparkle 불가).

### 3.3 📱 모바일 트랙 (iOS)
- **iOS 앱**(M5): Xcode App 타깃 + explicit Bundle ID + Push capability + APNs(.p8 ES256) + **계정 삭제(5.1.1(v))** + **UGC 모더레이션 4종(필터/신고/차단/공개연락처, 1.2)** + EULA 무관용 + **PrivacyInfo.xcprivacy**.
- **업로드 요건:** 2026-04-28부터 iOS 26 SDK + Xcode 26 이상.
- **배포:** Archive → Validate → Distribute → TestFlight(내부 즉시 / 외부 첫 빌드 Beta App Review) → App Review → 배포. (외부 TestFlight·제출은 **게이트 PASS 후**.)

---

## 4. 🔒 사용성 검수 게이트 (M7) — 스토어 제출 선행

> **정본 객관 통과기준:** `docs/cicd/05-qa-release-gate.md`. 체크리스트(무엇): `docs/cicd/03-store-readiness-gate.md`.
> **불변식:** 아래 **전부 PASS + 증거 첨부** → 03 상단에 PASS 블록(날짜+커밋해시+빌드#+증거 링크) 기록 → 그 이후에만 M8 release 트리거. **기록 없는 release = 규칙 위반.**

| 게이트 | 통과기준 | 방법/도구 |
|---|---|---|
| **G-0 런타임 e2e** | docker 기동 → migrate 멱등 → `/health` → seq 갭리스 → outbox→relay→publish 왕복 → RLS 격리 → 김인턴 멘션 SSE 1왕복 + reserve/reconcile + backup restore rehearsal evidence | M1 staging/local gates |
| **G-A 크래시-free** | 세션 ≥ 99.5% AND 유저 ≥ 99.0% `(추정 임계)` + 신규 P0/P1 crash 0 | Sentry Release Health / MetricKit |
| **G-B 핵심플로우 e2e** | 8/8 PASS, 치명 결함 0 | XCUITest + 수동 스모크 |
| **G-C 접근성** | `performAccessibilityAudit` 치명 위반 0 + VoiceOver 핵심플로우 조작 가능 | Xcode 15+ audit |
| **G-D 성능** | 콜드 런치 p90 < 2s `(추정 임계)`, hang ≈ 0 (실기기·Release) | XCTMetric / MetricKit |
| **G-E 베타** | iOS TestFlight(내부≤100/외부≤10,000) + macOS 공증 DMG 비공개 베타 통과 | TestFlight / spctl |
| **G-F 베타 피드백** | 전수 트리아지, P0/P1 잔여 0 | TestFlight + ASC API |
| **G-G 릴리스 준비** | 메타/프라이버시/암호화 신고(ITSAppUsesNonExemptEncryption)/버전·빌드번호 100% | 05 §9 체크리스트 |
| **G-H Enterprise Trust** | threat model + SBOM/license scan + secret scanning + pentest/VDP 계획 + SOC2/ISO readiness evidence | `MOMO-140`, `research/10-local-ai-protocol-trust/03-enterprise-trust-local-ops.md` |

---

## 5. 법무 선결 (법률 자문 아님 — 외부 변호사 1회 검토 필수)

> 산출물: `legal/*`, `docs/legal/*`, `NOTICE`. 아래는 스토어/공증 배포의 **선결**이며 M2(개인정보처리방침)~M7(App Privacy)~M8(제출)에 걸쳐 게이팅한다.

- **L0 등록 주체 + D-U-N-S**: 개인 vs 법인 결정. 법인은 D-U-N-S 무료·약 7영업일(expedite 불가). 사람 handoff와 Codex 산출물 경계는 `docs/legal/01-entity-apple-runbook.md`. [developer.apple.com/help/account/membership/D-U-N-S/]
- **L1 Apple 등록 + 비용**: Apple Developer Program $99/년. 실제 계약 동의·결제·Team ID 확보는 사람 `[manual]`. (M8 선결)
- **L3 개인정보처리방침 URL**: 모든 앱 필수(미수집도). (M2~M7 선결)
- **L5 App Privacy 라벨**: 제3자/LLM(hermes) 전송 포함 정직 신고. privacy manifest와 일관. (M7 선결)
- **L6 한국 법규**: 부가통신 신고는 자본금 1억원 이하 면제(전기통신사업법 시행령 30조). 위치 미수집이라 위치기반서비스 비해당 `(추정 — 법인화 시 재확인)`.
- **L7 NOTICE(Apache 2.0 귀속)** + **L8 에이전트 LLM 제3자 전송 고지**(온보딩 동의 + 승인 인박스 고지).
- **EULA**: UGC(채팅) 앱 → objectionable content 무관용 명시(1.2). 외부 변호사 검토.

---

## 6. 에픽 ↔ 마일스톤 ↔ 기존 GitHub 마일스톤 매핑

| ROADMAP 마일스톤 | 에픽(이 문서) | 기존 `milestones.tsv` 매핑 |
|---|---|---|
| M0 Foundation | EP-FND | M0 Phase0 (Phase 0 baseline) |
| M1 Backend 런타임+배포 | EP-RT, EP-DEPLOY | M0 Phase0 런타임 검증 (런타임 부분) |
| M2 멀티팀 온보딩 | EP-TENANCY, EP-ADMIN, EP-LEGAL(L0/L1·L3/L5) | M2 멀티팀/테넌시 |
| M3 데스크탑 v0 UX | EP-UX-DBC | M1 v0 데모 (D/B/C) |
| M4 데스크탑 패키징 | EP-MAC-PKG | M4 데스크탑 공증 배포 |
| M5 iOS 앱 | EP-IOS, EP-UGC, EP-LEGAL(L7/EULA) | M5 iOS 앱스토어 (앱 부분) |
| M6 CI/CD | EP-CICD | (신규 — TSV에 추가 권장) |
| M7 QA·게이트 | EP-QA-GATE | M3 검수 게이트 |
| M8 스토어 제출 | EP-STORE | M4/M5 (제출 부분) |
| (후속) v1 프리미티브 P1~P6 | EP-PRIMITIVES | M6 v1 경험 |

> 표기 규약(Codex 입력): 각 티켓은 `MOMO-NNN`. `acceptance`는 모두 체크 가능한 동사구. `platform` ∈ {shared, backend, macos, ios, ci, legal}. `labels`는 `scripts/github/labels.tsv` 택소노미 사용.

---

## 7. Codex 작업 컨벤션 (요약)

- **다음 티켓 선택법:** `deps`가 전부 done인 가장 낮은 의존 깊이를 고른다. `legal`/`manual` 티켓은 Codex가 파일/문서만 준비하고 실제 발급/계약은 런북으로 사람에게 위임 표시.
- **수용기준 등급:** `[swift]`=`swift build` green · `[infra]`=파일 존재+정합 · `[sql]`=정본 정합 · `[xcode]`=`xcodebuild` 산출 · `[ci]`=워크플로우 syntax/lint · `[runtime]`=docker/psql 필요(미가용 시 `runtime-unverified` 표기) · `[manual]`=사람 1회.
- **정합 원칙:** 이전 티켓 산출물을 깨지 말 것. `schema_v0.sql`은 정본(이동·수정 금지) — 확장은 `server/Migrations/00N_*.sql` 신규 + RLS DO-block ARRAY에 신규 테이블 등록.
- **DoD 기록:** 각 티켓 종료 시 검증 명령 결과를 `STATUS.md`에 기록. 미검증은 정직 표기(`runtime-unverified`).
- **🔒 release:** 게이트(M7) PASS + 03 PASS 블록 기록 전 `release-*.yml` 트리거 금지(태그 자제 또는 environment protection).

---

> 정본 참조: `STATUS.md`(현재 상태) · `BUILD_TICKETS.md`(빌드 백로그) · `schema_v0.sql`(스키마) · `docs/cicd/*`(CI/CD·게이트) · `legal/*`·`docs/legal/*`(법무) · `research/07-deepdive/04·05`(스펙·경험).
