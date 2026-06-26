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
     · 실제 staging URL/TLS, SOPS 복호화, pgBackRest PITR restore rehearsal, 외부 hermes staging 연결은 host-runtime 검증 필요
     · clients/macOS = SwiftPM dev app 가능 단계, 릴리스용 Xcode .app은 M4에서 진행
     · clients/iOS = 미존재, M5에서 생성
     · GitHub Actions는 비용/결제 이슈로 disabled + manual-only. 당분간 local gate가 PR merge 기준
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
| **M3** | 데스크탑 v0 UX (D/B/C 실데이터) | 🖥 | macOS 클라가 D Live Tool-Call · B 비용 호흡 · C 승인 인박스를 **실데이터**로 렌더 | MomoMac 실데이터 바인딩(VM↔LiveBackend) | D/B/C 3경험이 staging 실데이터로 동작(아직 라이브러리/스모크 단계 OK) | M1 (data), M0 (UI 골격) |
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
| `MOMO-111` | M1 | GitHub Actions 비주요 기간용 local PR gate | `scripts/local_gate.sh --profile docs|swift|staging-smoke|runtime-db|runtime-relay|runtime-agent|macos-ui|all` + PR evidence 출력 |
| `MOMO-112` | M1 | 5개+ Codex session/worktree 운영 자동화 | `scripts/goal_status.sh` board + `goal_claim/release` + `.conductor/setup.sh` + handoff/충돌 방지 정본 |
| `MOMO-005` | M1 | staging/prod compose skeleton | Caddy 자동 TLS, PostgreSQL 18, Redis, Centrifugo v6 Redis engine, api/relay/worker compose skeleton |
| `MOMO-006` | M1 | SOPS/age + pgBackRest skeleton | secret template, pgBackRest config/cron, PITR rehearsal runbook; 실제 host rehearsal은 `runtime-unverified` |
| `MOMO-007` | M1 | local/staging smoke 운영 gate | `scripts/verify_staging_smoke.sh` + `local_gate --profile staging-smoke`; 실제 URL/TLS/PITR는 host-runtime |
| `MOMO-150` | M1.5 | Hermes/Kim Intern/openclaw agent runtime 분석 | `research/11-agent-runtime/*` + runtime gap/roadmap 정리 |
| `MOMO-151` | M1.5 | Context Packet v0 심화 | `research/11-agent-runtime/04-context-packet-v0.md` + mention/command/message-action fixtures |
| `MOMO-152` | M1.5 | Memory Plane v0 심화 | `research/11-agent-runtime/05-memory-plane-v0.md` + typed memory/retrieval permission fixtures |
| `MOMO-153` | M1.5 | Capability Cache v0 | `research/11-agent-runtime/06-capability-cache-v0.md` + agent/plugin/MCP capability cache, tool schema refs, invalidation, policy/capability version |
| `MOMO-120` | M2 | Context Packet v0 | `{goal,constraints,decisions,sources,permissions,budget,redactions}` 스펙/fixture |
| `MOMO-121` | M2 | Memory Plane v0 | typed memory(decision/preference/artifact/task_state/source_ref) + 권한/삭제 모델 |
| `MOMO-122` | M2 | Google Workspace connector v0 | per-user OAuth + Drive/Gmail/Calendar read-mostly sync |
| `MOMO-123` | M2 | Google Workspace enterprise admin | domain-wide delegation/admin install/scope inventory/audit export 설계 |
| `MOMO-130` | M3 | macOS Foundation Models capability probe | `canImport`/availability/fallback 경로 검증 |
| `MOMO-131` | M3 | Local Context Copilot | 요약/분류/컨텍스트 압축/PII redaction preview UX |
| `MOMO-132` | M3 | Agent Protocol v0 | `agent_request/context_packet/tool_call/approval/tool_result/usage/audit` DB/wire/Swift/card 정합 |
| `MOMO-133` | M3 | Google Workspace "ask my work" UX | source citation + approval-gated external writes |
| `MOMO-134` | M3 | build-macos-apps 기반 macOS dev run loop | SwiftPM GUI `.app` staging + Codex Run action + `--verify/--logs` |
| `MOMO-160` | M2 | A2A-style agent_run lifecycle alignment | `research/11-agent-runtime/07-agent-run-lifecycle-v0.md` + Task/Message/Artifact/status mapping |
| `MOMO-161` | M2 | approval pause/resume runtime | `research/11-agent-runtime/08-approval-pause-resume-runtime.md` + worker pause slice; server decision/resume endpoint remains follow-up runtime |
| `MOMO-166` | M2 | approval decision server contract v0 | `research/11-agent-runtime/10-approval-decision-server-contract-v0.md` + request/response fixtures; connects MOMO-161 runtime checkpoint to MOMO-171 macOS decision intent |
| `MOMO-162` | M2 | Hermes adapter contract verification | platform adapter path vs AgentWorker SSE canonical path 결정 |
| `MOMO-163` | M2 | inbound MCP server v0 | governed search/fetch/post/approval-safe tool call surface + resources/prompts/fixtures |
| `MOMO-172` | M2 | inbound MCP server v0 skeleton/spec-to-code bridge | server registry/routes/stub + endpoint/security docs |
| `MOMO-170` | M3 | macOS agent protocol cards | `tool_call`/approval/result/artifact cards + Context Packet/Memory/Capability/source/cost badges + SwiftUI fixture contract |
| `MOMO-171` | M3 | macOS approval_request card decisions | Approve/Reject buttons call `ChatBackend.decideApproval(ApprovalDecisionRequest)` and reconcile receipt/realtime state |
| `MOMO-174` | M3 | local LLM context compaction | source-preserving summaries + server fallback |
| `MOMO-140` | M7 | Enterprise Trust Gate | SOC2/ISO/Pentest/SBOM/threat model/security whitepaper evidence를 QA gate 입력화 |

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
- **백엔드 런타임/배포**(M1): 단일 강력 VPS + docker-compose + Caddy(자동 TLS) + Centrifugo Redis 엔진 + PG18 + pgBackRest(PITR) + SOPS/age 시크릿 + 경량 모니터링. staging/prod 분리. MOMO-007의 `staging-smoke` local gate가 prod compose/Caddy/Centrifugo/secrets/pgBackRest checklist를 실제 VPS 시크릿 없이 먼저 검증하고, 실제 URL/TLS/PITR restore는 host-runtime으로 닫는다.
- **멀티팀 온보딩**(M2): `003_onboarding.sql` 첫 slice는 `invite_code` + redemption audit로 시작한다(MOMO-010). invite code 운영 REST(create/list/revoke + authenticated redeem 최소 slice)는 MOMO-011에서 완료했고, macOS에서 먼저 확인 가능한 invite UI thin slice는 MOMO-012, production `/v1/join` self-signup member/human/membership 생성 + audit_log는 MOMO-014에서 서버 runtime slice로 추가했다. `platform_admin` 전역 추적은 MOMO-013로 분리한다. `schema_v0.sql` 정본은 수정 금지, 신규 마이그레이션으로만 확장한다.

- **Context Broker + Memory Plane**(M2~M3): 서버 agent로 바로 넘기지 않고 messenger layer가 권한, 컨텍스트 범위, source refs, cost budget, redaction, local/server model routing을 결정한다. 정본: `research/10-local-ai-protocol-trust/01-local-llm-context-broker.md`.
- **Agent Runtime Spec**(M1.5~M3): Hermes/Kim Intern/openclaw를 기준으로 memory/cache/protocol gap을 메우고, momo가 agent host로서 context/capability/execution/ledger 4-plane을 소유한다. Context Packet v0 정본은 `research/11-agent-runtime/04-context-packet-v0.md`, Memory Plane v0 정본은 `research/11-agent-runtime/05-memory-plane-v0.md`, Capability Cache v0 정본은 `research/11-agent-runtime/06-capability-cache-v0.md`, Agent Run Lifecycle v0 정본은 `research/11-agent-runtime/07-agent-run-lifecycle-v0.md`, Approval Pause/Resume v0 정본은 `research/11-agent-runtime/08-approval-pause-resume-runtime.md`, Approval Decision Server Contract v0 정본은 `research/11-agent-runtime/10-approval-decision-server-contract-v0.md`이며, runtime gap/roadmap 정본은 `research/11-agent-runtime/*`.
- **Agent Protocol v0**(M3): `agent_request`, `context_packet`, `tool_call`, `approval_request`, `tool_result`, `usage_ledger`, `audit_log`를 DB/wire/Swift/macOS card에서 동일 의미로 유지한다. Approval은 client-only card가 아니라 `agent_run.status='awaiting_approval'`로 멈추는 protocol checkpoint다. 정본: `research/10-local-ai-protocol-trust/02-agent-protocol-google-workspace.md`, `research/11-agent-runtime/02-memory-cache-protocol-gaps.md`, `research/11-agent-runtime/08-approval-pause-resume-runtime.md`, `research/11-agent-runtime/10-approval-decision-server-contract-v0.md`.
- **Google Workspace connector**(M2~M3): v0는 per-user OAuth + read-mostly sync(Drive metadata/excerpt, Gmail thread read, Calendar read)로 시작하고, external write는 approval card 뒤에 둔다. Domain-wide delegation은 enterprise 옵션.
- **Local PR gate / multi-session ops**(M1): GitHub Actions는 현재 비용/결제 이슈로 disabled/manual-only이며, PR body local evidence와 worktree branch lock을 하드 운영 규칙으로 둔다. 정본: `docs/LOCAL_PR_GATE.md`, `docs/MULTI_SESSION_OPS.md`.

### 3.2 🖥 데스크탑 트랙 (macOS)
- **v0 UX**(M3): D/B/C 실데이터 바인딩.
- **Local LLM UX**(M3): Foundation Models availability probe 후 local summarization/classification/context compaction/PII redaction preview를 macOS에서 먼저 구현한다. 미지원 OS와 CI/local gate는 server fallback/stub으로 green 유지.
- **macOS 개발 loop**(M3): `build-macos-apps` 플러그인은 SwiftPM build/test/triage와 GUI 실행 표준화에 사용한다. 후속 `MOMO-134`에서 `script/build_and_run.sh`가 `dist/MomoMacDevApp.app`을 staging하고 Codex Run action을 연결한다.
- **Onboarding dev UX**(M2/M3 bridge): MOMO-012는 실제 서버 join API 전에도 `MomoMacDevApp`에서 invite code 입력, join 성공/실패, workspace join 상태를 `LiveChatBackend` stub으로 확인할 수 있게 한다.
- **Agent protocol cards**(M3): `MOMO-170`은 macOS timeline에서 `tool_call`, `approval_request`, `tool_result`, `artifact`, cost, memory citation, source badge를 Context Packet/Memory Plane/Capability Cache projection으로 렌더하는 v0 contract다. `MOMO-171`은 `approval_request` 카드의 Approve/Reject 개발 UX를 `ChatBackend` approval decision 계약에 연결한다. 정본: `research/11-agent-runtime/07-macos-agent-protocol-cards-v0.md`.
- **패키징**(M4): Xcode `.app` → bottom-up codesign(`--options runtime --timestamp`) → Developer ID Application → create-dmg → **notarytool submit --wait** → stapler staple → `spctl` 검증 → Sparkle 2(EdDSA, appcast). **App Store 트랙과 별개**(공증=직접배포, App Store≠공증).
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
| **G-0 런타임 e2e** | docker 기동 → migrate 멱등 → `/health` → seq 갭리스 → outbox→relay→publish 왕복 → RLS 격리 → 김인턴 멘션 SSE 1왕복 + reserve/reconcile | M1 staging |
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
