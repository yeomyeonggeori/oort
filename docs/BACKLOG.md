# momo — BACKLOG (마일스톤 → 에픽 → 티켓)

> **목적:** spine 전체 티켓을 **GitHub 이슈로 그대로 옮길 수 있는 단일 백로그 정본**. 각 티켓은 Codex가 읽고 바로 착수 가능하도록 `id / 제목 / 마일스톤 / 에픽 / 플랫폼 / deps / 수용기준(체크박스) / 라벨 / 추정` 을 모두 포함한다.
>
> **정합(ground-truth):** 이 문서는 `ROADMAP.md`(상위 정본) · `STATUS.md`(현재 상태) · `schema_v0.sql`(정본 스키마) · `research/07-deepdive/04-self-build-l4-spec.md`(빌드 스펙) · `research/07-deepdive/05-agent-native-experiences.md`(경험) · `docs/cicd/*`(CI/CD·게이트) · `docs/legal/*`·`legal/*`(법무)에 정합한다. 마일스톤 ID·에픽 ID·티켓 ID는 spine JSON과 **100% 일치**한다.
>
> **실행 주체:** 계획은 워크플로우(릴리스 PM), 실제 작업은 **Codex가 goal로 자율 실행**. 다음 티켓 선택법·DoD·검증 명령은 §컨벤션 참조.
>
> **🔒 불변식(스토어 게이트):** 스토어/공증 배포(M8, external TestFlight 포함)는 **검수 게이트(M7)가 PASS 된 후에만** 진행한다. 게이트 PASS + `docs/cicd/03-store-readiness-gate.md` 상단 PASS 블록 기록 전에는 `release-ios.yml`/`release-macos.yml`을 트리거하지 않는다.
>
> **사실 근거:** Apple 1차 출처(2026 기준) 교차확인. 추정은 `(추정)` 표기. **법무 항목은 법률 자문이 아님 — 외부 변호사 1회 검토 필요.**

---

## 0. 현재 위치 (You Are Here)

```
M0(완료 baseline) ── M1 ── M2 ─┐
                                ├──► M7 (검수 게이트 🔒) ──► M8 (스토어/공증 배포)
                    M3 ── M4 ───┤
                    M3 ── M5 ───┘
                    M6 (CI/CD) ───────── 게이트/배포 자동화
```

- **M0 Foundation 달성됨**: 5개 Swift 패키지(`MomoCore/MomoServer/OutboxRelay/AgentWorker/MomoMac`) `swift build` green + 정본 스키마/인프라/마이그레이션 파일 정합. (상세: `STATUS.md`)
- **현재 닫을 차례 = M1 운영/배포 축**: MOMO-001~004로 Docker Desktop 기반 seq/outbox/RLS/AgentWorker 비용 회계는 검증됨. GitHub Actions는 비용/결제 이슈로 disabled/manual-only이며, 남은 M1은 staging 배포(MOMO-005~007)와 local gate/worktree 운영 정본화(MOMO-111~112).
- `clients/macOS`는 SwiftPM dev app 가능 단계이며, 릴리스용 Xcode `.app`은 M4에서 진행. `clients/iOS`는 미존재.
- CI/CD·QA·법무 문서는 선작성됨(`docs/cicd/*`, `docs/legal/*`, `legal/*`) — 실행/측정은 미진행(게이트 OPEN).

> 정본 참조: `STATUS.md` · `BUILD_TICKETS.md` · `schema_v0.sql`(이동·수정 금지) · `ROADMAP.md`.

---

## 1. 마일스톤 (8 + 후속)

| ID | 이름 | 트랙 | 목표(요약) | 의존 | 종료 기준(요약) |
|---|---|---|---|---|---|
| **M0** | Foundation (완료) | ⚙️ | 리포 골격 + 5개 Swift 패키지 컴파일 + 정본 스키마/인프라/마이그레이션 | — | `swift build` green ×5 + 파일 정합 (**달성됨**) |
| **M1** | Backend 런타임 + 배포(staging) | ⚙️ | docker(PG18+Centrifugo v6+hermes) 런타임 검증 + staging 배포 | M0 | G-0 런타임 e2e PASS + staging URL 헬스 green |
| **M2** | 멀티팀 온보딩 | ⚙️ | 워크스페이스 스핀업 + 고유 초대코드→자가가입 + 플랫폼 관리자 추적 | M1 | 3개+ 팀(10인=1팀) 격리 + 자가가입 e2e + 전역 조회 |
| **M3** | 데스크탑 v0 UX (D/B/C 실데이터) | 🖥 | macOS 클라가 D Live Tool-Call · B 비용 호흡 링 · C 승인 인박스를 실데이터로 렌더 | M1 | D/B/C 3경험이 staging 실데이터로 동작 |
| **M4** | 데스크탑 패키징 | 🖥 | Xcode `.app` + Developer ID + notarytool 공증 + DMG + Sparkle 2 | M3 | 공증 `.dmg` 타 맥 Gatekeeper 통과 + Sparkle 업데이트 1회 |
| **M5** | iOS 앱 | 📱 | iOS Xcode App + Push + APNs .p8 + 계정 삭제 + UGC 모더레이션 + privacy manifest | M3, M2 | 실기기 로그인→채널→메시지→에이전트 응답 + 자가가입 시나리오 |
| **M6** | CI/CD | ⚙️ | fastlane(match/pilot/deliver/notarytool) + ASC API Key + GitHub Actions. 현재는 비용 방지를 위해 disabled/manual-only | M0, M4, M5, owner approval | local gate 운영 + CI 재활성 시 green + release 워크플로우 dry-run(게이트 전 미트리거) |
| **M7** | QA · 사용성 검수 게이트 🔒 | ⚙️ | "사용 가능 완전 판명" 객관 통과기준(G-0~G-H) 측정·PASS | M1, M3, M4, M5, M6 | **G-0~G-H 전부 PASS + 증거 첨부 + 03 PASS 블록 기록** |
| **M8** | 스토어 제출 (App Store + Developer ID) | 🖥📱 | macOS 공증 DMG 공개 다운로드 + iOS App Store 업로드/심사/배포 | **M7**, M4, M5, M6 | App Store 승인·배포 + 공증 DMG 공개 + Sparkle 라이브 |
| (후속) | v1 신규 프리미티브 P1~P6 | ⚙️ | branch_id·reversibility_tier·belief·autonomy_level·decision_ledger·scheduled trigger | M8 | v0 데모엔 불필요, 스토어 출시 후 후속 |

> 마일스톤 ↔ 기존 GitHub `milestones.tsv`(M0~M6 부분집합) 매핑은 `ROADMAP.md §6` 참조. 본 backbone(M0~M8)이 상위 정본.

---

## 2. 에픽 (14)

| 에픽 ID | 제목 | 마일스톤 | 요약 |
|---|---|---|---|
| **EP-FND** | Foundation 골격 (완료 baseline) | M0 | 리포 골격 + 5개 Swift 패키지 컴파일 + 정본 스키마/인프라/마이그레이션. Phase 0 달성. |
| **EP-RT** | Backend 런타임 검증 | M1 | docker 환경 서버↔PG18↔Centrifugo↔hermes 런타임 e2e(seq/outbox/relay/RLS/SSE/비용회계). |
| **EP-DEPLOY** | Staging 배포 인프라 | M1 | 단일 VPS + docker-compose + Caddy 자동TLS + Centrifugo Redis 엔진 + pgBackRest PITR + SOPS/age + 경량 모니터링. |
| **EP-TENANCY** | 멀티테넌시 온보딩 (워크스페이스/초대코드/자가가입) | M2 | `003_onboarding.sql`(invite_code) + 온보딩 REST + 자가가입 플로우. schema_v0.sql 정본 확장. |
| **EP-ADMIN** | 플랫폼 관리자 전체 추적 | M2 | `platform_admin` 테이블 + BYPASSRLS 전역 조회 뷰/엔드포인트로 전 테넌트 추적. |
| **EP-UX-DBC** | 데스크탑 v0 경험 D/B/C 실데이터 | M3 | MomoMac이 Live Tool-Call(D) · 비용 호흡 링(B) · 승인 인박스(C)를 staging 실데이터로 바인딩. |
| **EP-MAC-PKG** | macOS 패키징·공증·배포 | M4 | Xcode `.app` + Developer ID 서명 + notarytool 공증 + DMG + Sparkle 2 자동업데이트. |
| **EP-IOS** | iOS 앱 타깃·Push·계정삭제 | M5 | `MomoiOS.xcodeproj` + explicit Bundle ID + Push capability + APNs .p8 + 계정 삭제 + privacy manifest. |
| **EP-UGC** | UGC 모더레이션 (App Store 1.2) | M5 | 게시 전 필터 + 신고 + 차단 + 공개 연락처 + EULA 무관용. 에이전트 생성 콘텐츠 모더레이션 정책 포함. |
| **EP-CICD** | CI/CD 파이프라인 (fastlane·ASC Key) | M6 | fastlane match/pilot/deliver/notarytool + ASC API Key(Team) + GitHub Actions. 현재 Actions는 비용 방지를 위해 disabled/manual-only이며, release 잡은 게이트 전 비활성. |
| **EP-QA-GATE** | QA · 사용성 검수 게이트 | M7 | 계측(Sentry/MetricKit) + XCUITest e2e/접근성/성능 + 베타 + Enterprise Trust evidence(G-H) PASS 판정. |
| **EP-STORE** | 스토어 제출 (App Store + Developer ID) | M8 | iOS 업로드/심사/배포 + macOS 공증 DMG 공개 다운로드 + Sparkle 라이브. |
| **EP-LEGAL** | 법무 선결 (법률 자문 아님) | M2 | 등록주체/D-U-N-S + 개인정보처리방침 + App Privacy + NOTICE + 에이전트 LLM 고지 + EULA. 외부 변호사 1회 검토 필수. |
| **EP-PRIMITIVES** | v1 신규 프리미티브 P1~P6 (후속) | M8 | branch_id(P1) · reversibility_tier(P2) · belief(P3) · autonomy_level(P4) · decision_ledger(P5) · scheduled trigger(P6). |
| **EP-OPS** | Local Gate · Multi-session Worktree | M1 | GitHub Actions 비주요 기간에도 local evidence로 PR 품질을 유지하고, 5개+ Codex 세션이 이슈/branch/worktree 단위로 충돌 없이 작업. |
| **EP-CONTEXT** | Context Broker · Memory Plane | M2 | messenger layer가 권한, source refs, budget, redaction, local/server model routing을 결정. |
| **EP-AGENT-PROTOCOL** | Agent Protocol · Plugin Work Surface | M3 | agent/plugin 실행을 `context_packet/tool_call/approval/tool_result/usage/audit`로 프로토콜화하고 macOS 카드와 정합. |
| **EP-AGENT-RUNTIME** | Agent Runtime · Memory · Capability Cache | M1.5/M2/M3 | Hermes/Kim Intern/openclaw 분석을 바탕으로 context/capability/execution/ledger 4-plane 계약과 A2A/MCP 경계를 정리. |
| **EP-GWORKSPACE** | Google Workspace Sync | M2/M3 | per-user OAuth read-mostly sync, source citation, approval-gated writes, domain-wide delegation은 enterprise 옵션. |
| **EP-TRUST** | Enterprise Trust | M7 | NIST SSDF/SBOM/license scan/secret scanning/pentest/VDP/SOC2/ISO readiness를 QA gate 입력으로 승격. |

---

## 3. 의존 그래프 요약

### 3.1 마일스톤 임계 경로 (critical path)

```
M0 → M1 → M2 → M5(iOS)  → M7(게이트 🔒) → M8(App Store)     ← 모바일 임계 경로
M0 → M1 → M3 → M4(공증) → M7(게이트 🔒) → M8(공증 DMG)      ← 데스크탑 임계 경로
M6(CI/CD)는 M0 위에서 병렬, release 활성화는 C1/C2(M4/M5 Xcode 프로젝트)+게이트(M7)+owner approval에 종속. 2026-06-26 현재 Actions는 비용 방지를 위해 disabled/manual-only이며 local gate가 primary merge gate다.
```

### 3.2 티켓 의존 그래프 (deps DAG)

> 표기: `A → B` = B가 A에 의존. M0은 baseline(완료)이므로 의존 루트.

```
M0(baseline)
 ├─ MOMO-001 ─┬─ MOMO-002 ── MOMO-004 ─┬─ MOMO-020 ─┬─ MOMO-030 ─┬─ MOMO-031 ── MOMO-032
 │            │                        │            │            │                    │
 │            ├─ MOMO-003 ── MOMO-010 ─┤            │            └─ MOMO-050 ┐        │
 │            │              (003_onboarding.sql)   │                        │        │
 │            │                        │            ├─ MOMO-021              │        │
 │            ├─ MOMO-005 ─┬─ MOMO-006 ─ MOMO-007   ├─ MOMO-022              │        │
 │            │            └─ MOMO-007              │                        │        │
 │            │                                     ├─ MOMO-040 ─┬─ MOMO-041 │        │
 │            └─(MOMO-063 입력 G-0)                 │            ├─ MOMO-042  │        │
 │                                                  │            ├─ MOMO-043  │        │
 MOMO-010 ─┬─ MOMO-011 ── MOMO-012                  │            ├─ MOMO-044  │        │
 │         └─ MOMO-013                              │            └─ MOMO-050 ─┘        │
 │                                                  │                  │              │
 │                                          MOMO-050 ── MOMO-051 ── MOMO-052          │
 │                                                                       │            │
 MOMO-080 ── MOMO-081 ── MOMO-082 (법무 트랙, 독립 진행)                  │            │
 │                                                                       │            │
 MOMO-060 ─┬─ MOMO-061 ── MOMO-062 ───────────────────────────────────────┐          │
 (deps: 030,040)        (deps: 052,061)                                    │          │
                                                                           ▼          │
       [MOMO-063  게이트 PASS 판정]  deps: 001, 060, 061, 062 ─── 🔒 M7 게이트 ───────┤
                                                                           │          │
                              ┌────────────────────────────────────────────┘          │
                              ▼ (게이트 PASS 이후에만)                                  ▼
                   MOMO-070 ── MOMO-071 (iOS 스토어)            MOMO-072 (macOS 공개) ─ deps: 063, 032
                              │
                   MOMO-090~095 (P1~P6 프리미티브) deps: 071, 072 (전부 후속)
```

### 3.3 차단 관계(불변식)

- **MOMO-063 (게이트 PASS 판정)** 이 닫히기 전에는 **MOMO-070/071/072(스토어 제출)** 및 release 워크플로우 트리거 **금지**. (`docs/cicd/03-store-readiness-gate.md` PASS 블록 = 단일 차단점)
- **schema_v0.sql 정본 불변**: 스키마 확장은 `server/Migrations/00N_*.sql` 신규 + RLS DO-block ARRAY 등록으로만. (MOMO-010 참조)
- **법무 트랙(MOMO-080~082)** 은 백엔드/클라 트랙과 독립 진행되나, M8 제출의 선결(개인정보처리방침/App Privacy/EULA/NOTICE)을 게이팅.
- **MOMO-090~095(P1~P6)** 는 전부 **스토어 출시(071/072) 후 후속** — v0 데모엔 불필요.

### 3.4 다음 착수 가능 티켓 (deps가 baseline=M0뿐)

- **MOMO-001** (런타임 e2e 루트) — 거의 모든 백엔드 티켓의 선행.
- **MOMO-080** (법무 L0/L1) — deps 없음, 사람 위임 런북 준비.

---

## 4. 티켓 (41 + Local AI/Trust 확장)

> 표기 규약: `acceptance`는 전부 체크 가능한 동사구. `platform` ∈ {backend, macos, ios, ci, shared, legal}. `labels`는 `scripts/github/labels.tsv` 택소노미. `deps`는 선행 티켓/마일스톤 ID. 수용기준 등급: `[runtime]`=docker/psql 필요(미가용 시 `status:runtime-unverified` 표기) · `[swift]`=`swift build` green · `[xcode]`=`xcodebuild` 산출 · `[sql]`=정본 정합 · `[ci]`=워크플로우 syntax/lint · `[manual]`=사람 1회.

---

### EP-RT — Backend 런타임 검증 (M1)

#### MOMO-001 · docker 런타임 e2e: migrate 멱등 + /health + seq 갭리스
- **마일스톤:** M1 · **에픽:** EP-RT · **플랫폼:** backend · **추정:** M
- **deps:** M0
- **수용기준:**
  - [ ] [runtime] docker(PG18+Centrifugo v6) 기동 후 `make migrate`(001→002) 멱등 적용(재실행 무오류)
  - [ ] [runtime] MomoServer 기동 → `GET /health` 200
  - [ ] [runtime] 메시지 송신 → `channel_seq UPDATE...RETURNING` 으로 갭리스 seq 발급(동시 송신 직렬화 확인)
- **라벨:** `type:infra`, `area:server`, `area:infra`, `status:runtime-unverified`, `gate:qa`
- **참조:** L4 §3.1, §8.1 · `schema_v0.sql`(channel_seq/message/outbox) · `BUILD_TICKETS.md` T05

#### MOMO-002 · outbox→relay→Centrifugo publish 왕복 검증
- **마일스톤:** M1 · **에픽:** EP-RT · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-001
- **수용기준:**
  - [ ] [runtime] 메시지 INSERT와 outbox INSERT가 단일 tx로 commit
  - [ ] [runtime] OutboxRelay가 SKIP LOCKED 클레임 → Centrifugo `/api/publish` 호출 → `status=done`
  - [ ] [runtime] 구독 클라가 `version=seq` 이벤트 수신(멱등 키 중복 무손실)
- **라벨:** `type:infra`, `area:relay`, `area:infra`, `status:runtime-unverified`, `gate:qa`
- **참조:** L4 §8.1 · `BUILD_TICKETS.md` T06

#### MOMO-003 · RLS 테넌트 격리 런타임 검증
- **마일스톤:** M1 · **에픽:** EP-RT · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-001
- **수용기준:**
  - [ ] [runtime] `SET LOCAL app.workspace_id` 누락 시 행 미노출 확인
  - [ ] [runtime] 워크스페이스 A 컨텍스트에서 B의 message/channel/member 행 조회 불가
  - [ ] [runtime] relay/worker BYPASSRLS 역할만 전 테넌트 폴링 가능
- **라벨:** `type:infra`, `area:schema`, `area:tenancy`, `status:runtime-unverified`, `gate:qa`
- **참조:** L4 §1.3, §9.1 · `schema_v0.sql` RLS FORCE 정책

#### MOMO-004 · AgentWorker↔hermes SSE 실연결 + 비용 reserve/reconcile
- **마일스톤:** M1 · **에픽:** EP-RT · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-002
- **수용기준:**
  - [ ] [runtime] 김인턴 멘션 → outbox(agent_job) 클레임 → agent_run 게이트(step/depth) 통과
  - [ ] [runtime] hermes OpenAI 호환 `/v1/chat/completions` SSE 델타를 message PATCH 스트리밍으로 게시
  - [ ] [runtime] 호출 전 `budget_window` reserve → 호출 후 `usage_ledger` reconcile 기록(서킷브레이커 트립 경로 동작)
- **라벨:** `type:feature`, `area:worker`, `status:runtime-unverified`, `gate:qa`
- **참조:** L4 §3.3(6중 게이트), §3.5, §6.2, §8.5 · `BUILD_TICKETS.md` T07/T08

---

### EP-DEPLOY — Staging 배포 인프라 (M1)

#### MOMO-005 · docker-compose.prod: Caddy 자동TLS + Centrifugo Redis 엔진
- **마일스톤:** M1 · **에픽:** EP-DEPLOY · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-001
- **수용기준:**
  - [ ] [infra] `infra/prod/docker-compose.prod.yml`: caddy(자동 HTTPS) + redis 추가, relay/worker 실서비스 승격
  - [ ] [infra] `infra/prod/Caddyfile`: api/rt 도메인 라우팅 + 보안 헤더, Centrifugo subscribe proxy 내부 콜백은 compose 네트워크 내 유지
  - [ ] [runtime] Centrifugo Memory→Redis 엔진 전환(presence/recovery 안정)
- **라벨:** `type:infra`, `area:infra`, `status:runtime-unverified`
- **참조:** L4 §1.4(수평확장), §4.2 · `docs/RUN.md`

#### MOMO-006 · 시크릿 관리(SOPS+age) + DB 백업(pgBackRest PITR)
- **마일스톤:** M1 · **에픽:** EP-DEPLOY · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-005
- **수용기준:**
  - [ ] [infra] SOPS+age로 암호화한 `.env`를 git 버전관리 + 배포 시 메모리 복호화(평문 디스크 미접촉)
  - [ ] [infra] `change-me`/`dev-insecure` 기본값을 `openssl rand` 로 교체
  - [ ] [runtime] pgBackRest 주간 풀 + 연속 WAL 아카이빙 구성 + 복원(PITR) 1회 검증
- **라벨:** `type:infra`, `area:infra`, `status:runtime-unverified`
- **참조:** L4 §8.7 · `infra/.env.example` · `docs/RUN.md`

#### MOMO-007 · staging 배포 + 경량 모니터링 + RUN 런북 갱신
- **마일스톤:** M1 · **에픽:** EP-DEPLOY · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-005, MOMO-006
- **수용기준:**
  - [ ] [runtime] staging VPS에 스택 기동 → staging URL 헬스 green + TLS 정상
  - [ ] [runtime] 구조화 로그(run_id/workspace_id 상관) + healthcheck + 핵심 메트릭(outbox lag/예산 트립율/APNs 실패)
  - [ ] [infra] `docs/RUN.md`에 staging 기동/롤백/시크릿/백업 절차 추가
- **라벨:** `type:infra`, `area:infra`, `type:docs`, `status:runtime-unverified`
- **참조:** L4 §8.8(관측성) · `docs/RUN.md`

---

### EP-OPS — Local Gate · Multi-session Worktree (M1)

#### MOMO-110 · Local LLM · Agent Protocol · Enterprise Trust roadmap
- **마일스톤:** M1 · **에픽:** EP-OPS/EP-CONTEXT/EP-AGENT-PROTOCOL/EP-TRUST · **플랫폼:** shared · **추정:** M
- **deps:** M0
- **수용기준:**
  - [ ] [docs] `research/10-local-ai-protocol-trust/*`에 Apple local LLM, Context Broker, Agent Protocol, Google Workspace, Trust, local ops 리서치 문서화
  - [ ] [docs] `ROADMAP.md`, `BUILD_TICKETS.md`, `docs/BACKLOG.md`, `docs/INDEX.md`, `STATUS.md` 갱신
  - [ ] [docs] build-macos-apps 플러그인의 SwiftPM/macOS 개발 활용 방침 기록
- **라벨:** `type:docs`, `type:spec`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/*`

#### MOMO-154 · disable GitHub Actions auto-runs and prioritize local gate
- **마일스톤:** M1 · **에픽:** EP-OPS/EP-CICD · **플랫폼:** ci · **추정:** S
- **deps:** MOMO-110
- **수용기준:**
  - [ ] [ci] 원격 `ci-build`, `release-ios`, `release-macos` workflow를 `disabled_manually` 상태로 확인
  - [ ] [ci] `.github/workflows/*.yml` 자동 `push`/`pull_request`/tag 트리거 제거, `workflow_dispatch` 전용 유지
  - [ ] [docs] local gate가 당분간 primary merge gate임을 `docs/LOCAL_PR_GATE.md`, `docs/GITHUB_OPS.md`, `ROADMAP.md`, `STATUS.md`에 반영
- **라벨:** `type:infra`, `area:ci`, `type:docs`, `priority:p0`, `size:s`, `agent:codex-ok`
- **참조:** `docs/LOCAL_PR_GATE.md`, `.github/workflows/*.yml`

#### MOMO-111 · local PR gate script and evidence flow
- **마일스톤:** M1 · **에픽:** EP-OPS · **플랫폼:** ci · **추정:** M
- **deps:** MOMO-110, MOMO-154
- **수용기준:**
  - [ ] [ci] `scripts/local_gate.sh --profile docs|swift|runtime-db|runtime-relay|runtime-agent|macos-ui|all` 추가
  - [ ] [ci] PR body에 machine/toolchain/commands/runtime coverage evidence를 붙일 수 있는 출력 제공
  - [ ] [docs] GitHub Actions 비주요 기간의 merge 기준을 `docs/LOCAL_PR_GATE.md`와 PR template에 반영
- **라벨:** `type:infra`, `area:ci`, `type:docs`, `priority:p0`, `size:m`, `agent:codex-ok`
- **참조:** `docs/LOCAL_PR_GATE.md`

#### MOMO-112 · 5+ Codex session/worktree orchestration
- **마일스톤:** M1 · **에픽:** EP-OPS · **플랫폼:** infra · **추정:** M
- **deps:** MOMO-110, MOMO-111
- **수용기준:**
  - [ ] [infra] `scripts/goal_status.sh`가 issue/branch/worktree/PR/local gate 상태를 한눈에 표시
  - [ ] [infra] `scripts/goal_claim.sh`, `scripts/goal_release.sh`, `.conductor/setup.sh`가 status board 운영 흐름과 연결
  - [ ] [infra] worktree별 `.env.worktree` 포트/compose project 충돌 방지 확인
  - [ ] [docs] `momo-main` orchestration + worker handoff prompt + merge/review cycle을 문서화
- **라벨:** `type:infra`, `area:infra`, `type:docs`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `docs/MULTI_SESSION_OPS.md`

---

### EP-AGENT-RUNTIME — Agent Runtime · Memory · Capability Cache (M1.5)

#### MOMO-150 · Hermes/Kim Intern/openclaw agent runtime research and roadmap
- **마일스톤:** M1.5 · **에픽:** EP-AGENT-RUNTIME/EP-CONTEXT/EP-AGENT-PROTOCOL · **플랫폼:** shared · **추정:** M
- **deps:** MOMO-110
- **수용기준:**
  - [ ] [docs] `research/11-agent-runtime/*`에 Hermes agent, internkim/Kim Intern, openclaw 분석 문서 추가
  - [ ] [docs] memory/cache/protocol gap을 Context Packet, Memory Plane, Capability Cache, A2A lifecycle, approval pause/resume 관점으로 정리
  - [ ] [docs] ROADMAP.md, BUILD_TICKETS.md, docs/INDEX.md, STATUS.md 갱신
  - [ ] [docs] 코드/스키마 구현 없이 문서/스펙만 변경
- **라벨:** `type:docs`, `type:spec`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/*`

#### MOMO-151 · Context Packet v0 deep spec and fixtures
- **마일스톤:** M1.5 · **에픽:** EP-AGENT-RUNTIME/EP-CONTEXT · **플랫폼:** shared · **추정:** M
- **deps:** MOMO-150
- **수용기준:**
  - [ ] [spec] `research/11-agent-runtime/04-context-packet-v0.md`에 Context Packet top-level shape, request/scope/goal/source/memory/tool/budget/redaction/runtime envelope 정의
  - [ ] [spec] mention, slash command, message context action fixture 3종 작성. 각 fixture는 source ref, memory ref, tool grant, budget, redaction/withheld context 중 하나 이상 포함
  - [ ] [spec] agent runtime에 주입 가능한 필드와 금지 필드 정의
  - [ ] [spec] Hermes/Kim Intern/OpenAI-compatible SSE 호출의 context envelope 정의
  - [ ] [spec] openclaw식 approval availability/presentation/transport/interactions/observe 분리를 momo Context Broker/clients/server/Postgres 경계로 매핑
- **라벨:** `type:spec`, `area:core`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/04-context-packet-v0.md`, `research/11-agent-runtime/fixtures/context-packet-v0/`

#### MOMO-152 · Memory Plane v0 deep spec and permission model
- **마일스톤:** M1.5 · **에픽:** EP-AGENT-RUNTIME/EP-CONTEXT · **플랫폼:** shared · **추정:** M
- **deps:** MOMO-151
- **수용기준:**
  - [ ] [spec] `research/11-agent-runtime/05-memory-plane-v0.md`에 Memory Plane v0 정본 추가
  - [ ] [spec] `decision/preference/artifact_ref/task_state/external_source_ref/agent_skill_note` memory type 확정
  - [ ] [spec] source attribution, visibility, expiry, delete path, revocation, retrieval-time permission check 정의
  - [ ] [spec] raw chat exhaust 자동 장기 저장 금지와 local LLM compaction 기준 문서화
  - [ ] [spec] `research/11-agent-runtime/fixtures/memory-plane-v0/`에 memory type fixtures와 permission examples 추가
  - [ ] [spec] Context Packet v0의 `memory_refs` projection 규칙과 연결
- **라벨:** `type:spec`, `area:core`, `area:tenancy`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/02-memory-cache-protocol-gaps.md`, `research/11-agent-runtime/05-memory-plane-v0.md`

#### MOMO-153 · Capability Cache v0 spec and invalidation model
- **마일스톤:** M1.5 · **에픽:** EP-AGENT-RUNTIME/EP-AGENT-PROTOCOL · **플랫폼:** shared · **추정:** M
- **deps:** MOMO-151, MOMO-152
- **수용기준:**
  - [ ] [spec] `research/11-agent-runtime/06-capability-cache-v0.md`에 Capability Cache v0 정본 추가
  - [ ] [spec] `agent_capability/plugin_tool_schema/mcp_tool_list/model_pricing` cache kind 확정
  - [ ] [spec] workspace/visibility/source/expires_at/policy_version/capability_version/schema_hash 필수화
  - [ ] [spec] plugin version, MCP list-changed, provider grant revoke, workspace policy change, manual refresh invalidation 경로 정의
  - [ ] [spec] Context Packet v0 `tool_grants.input_schema_ref` projection과 Memory Plane provider grant revalidation 관계 연결
  - [ ] [spec] `research/11-agent-runtime/fixtures/capability-cache-v0/`에 capability list, plugin schema, invalidation/audit fixture 추가
- **라벨:** `type:spec`, `area:core`, `area:worker`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/02-memory-cache-protocol-gaps.md`, `research/11-agent-runtime/06-capability-cache-v0.md`

---

### EP-TENANCY — 멀티테넌시 온보딩 (M2)

#### MOMO-010 · 003_onboarding.sql: invite_code 테이블 + RLS 등록
- **마일스톤:** M2 · **에픽:** EP-TENANCY · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-003
- **수용기준:**
  - [ ] [sql] `server/Migrations/003_onboarding.sql` 신규(schema_v0.sql **미수정**): `invite_code{id uuidv7, workspace_id FK, code, role, max_uses, used_count, expires_at, revoked_at, created_by}`
  - [ ] [sql] 고엔트로피 랜덤 code + 만료 + 사용횟수 한정 + revoke 컬럼
  - [ ] [sql] RLS DO-block ARRAY에 `invite_code` 등록(FORCE), `schema_v0.sql` 정본은 그대로 둠
- **라벨:** `type:spec`, `area:schema`, `area:tenancy`, `status:runtime-unverified`
- **참조:** L4 §1.3 · `schema_v0.sql`(workspace/membership/RLS DO-block 컨벤션) · ROADMAP §3.1

#### MOMO-011 · 워크스페이스 스핀업 REST + 초대코드 자동 발급
- **마일스톤:** M2 · **에픽:** EP-TENANCY · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-010
- **수용기준:**
  - [ ] [swift] `POST /v1/workspaces`: 워크스페이스 + 초기 owner + 고유 invite_code 1개 자동 발급
  - [ ] [swift] `POST /v1/invites`: owner/admin이 초대코드 생성(role/max_uses/expires_at)
  - [ ] [runtime] 트랜잭션마다 `SET LOCAL app.workspace_id` 설정 후 INSERT
- **라벨:** `type:feature`, `area:server`, `area:tenancy`, `status:runtime-unverified`
- **참조:** L4 §5.1(REST), §7.1/§7.2(권한)

#### MOMO-012 · 초대코드 자가가입 플로우 + audit_log
- **마일스톤:** M2 · **에픽:** EP-TENANCY · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-011
- **수용기준:**
  - [ ] [swift] `POST /v1/join`: 초대코드 검증(만료/사용횟수/revoke) → member/membership 생성 → used_count 증가
  - [ ] [runtime] 초대코드의 workspace_id로 `app.workspace_id` 컨텍스트 설정 후 가입 행 생성
  - [ ] [runtime] 가입 사건 `audit_log` 기록(actor/subject/via_token)
  - [ ] [runtime] 3개+ 팀(10인=1팀) 자가가입 e2e + 워크스페이스 격리 재확인
- **라벨:** `type:feature`, `area:server`, `area:tenancy`, `status:runtime-unverified`, `gate:qa`
- **참조:** L4 §7.3(actor/subject 델리게이션) · `schema_v0.sql`(member/membership/audit_log)

---

### EP-ADMIN — 플랫폼 관리자 전체 추적 (M2)

#### MOMO-013 · platform_admin 전역 추적 뷰/엔드포인트 (BYPASSRLS 읽기)
- **마일스톤:** M2 · **에픽:** EP-ADMIN · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-010
- **수용기준:**
  - [ ] [sql] `platform_admin` 테이블 + BYPASSRLS 읽기 전용 경로(쓰기 경로엔 BYPASSRLS 금지)
  - [ ] [swift] `GET /v1/platform/workspaces`, `/v1/platform/members`: 전 테넌트 전수 조회(팀/멤버/초대코드 사용현황)
  - [ ] [runtime] 일반 테넌트 토큰으로는 접근 불가(권한 분리 확인)
- **라벨:** `type:feature`, `area:server`, `area:tenancy`, `status:runtime-unverified`
- **참조:** L4 §7.2(권한 매트릭스) · `schema_v0.sql`(RLS 역할 분리)

---

### EP-CONTEXT / EP-GWORKSPACE — Context Broker · Memory · Google Workspace (M2)

#### MOMO-120 · Context Packet v0 spec and fixtures
- **마일스톤:** M2 · **에픽:** EP-CONTEXT · **플랫폼:** shared · **추정:** M
- **deps:** MOMO-003, MOMO-110
- **수용기준:**
  - [ ] [spec] `Context Packet v0` 구조를 `{goal,constraints,decisions,sources,permissions,budget,redactions}`로 확정
  - [ ] [spec] channel/thread/message/plugin/google source refs fixture 작성
  - [ ] [swift] MomoCore에 protocol/model 초안 추가 시 기존 5패키지 build/test green 유지
- **라벨:** `type:spec`, `area:core`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/01-local-llm-context-broker.md`

#### MOMO-121 · Memory Plane v0 spec and permission model
- **마일스톤:** M2 · **에픽:** EP-CONTEXT · **플랫폼:** shared · **추정:** M
- **deps:** MOMO-120
- **수용기준:**
  - [ ] [spec] memory type을 `decision/preference/artifact/task_state/external_source_ref`로 제한
  - [ ] [spec] source attribution, visibility, expiry, delete path, retrieval-time permission check를 필수 필드로 정의
  - [ ] [spec] raw chat exhaust를 장기 메모리로 자동 저장하지 않는 정책 문서화
- **라벨:** `type:spec`, `area:core`, `area:tenancy`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/01-local-llm-context-broker.md`

#### MOMO-122 · Google Workspace connector v0: per-user OAuth read-mostly sync
- **마일스톤:** M2 · **에픽:** EP-GWORKSPACE · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-120, MOMO-121
- **수용기준:**
  - [ ] [spec] per-user OAuth scope inventory와 token storage policy 정의
  - [ ] [runtime] Drive metadata/excerpt, Gmail search/thread read, Calendar read 최소 동기화 검증
  - [ ] [spec] external write는 `tool_call -> approval_request -> tool_result -> audit_log` 뒤로 제한
- **라벨:** `type:feature`, `area:server`, `area:worker`, `priority:p1`, `size:l`, `status:runtime-unverified`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/02-agent-protocol-google-workspace.md`

#### MOMO-123 · Google Workspace domain-wide delegation and admin install design
- **마일스톤:** M2 · **에픽:** EP-GWORKSPACE/EP-TRUST · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-122
- **수용기준:**
  - [ ] [spec] domain-wide delegation을 enterprise-only 옵션으로 문서화
  - [ ] [spec] admin approval, scope inventory, audit export, revoke path 정의
  - [ ] [manual] 실제 Google Workspace admin 승인/검증은 사람 위임 런북으로 분리
- **라벨:** `type:spec`, `area:server`, `area:legal`, `priority:p2`, `size:m`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/02-agent-protocol-google-workspace.md`

---

### EP-UX-DBC — 데스크탑 v0 경험 D/B/C 실데이터 (M3)

#### MOMO-020 · D Live Tool-Call 실데이터 렌더
- **마일스톤:** M3 · **에픽:** EP-UX-DBC · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-004
- **수용기준:**
  - [ ] [swift] `MessageBubble`가 tool_call/tool_result/diff 1급 메시지를 실데이터로 렌더
  - [ ] [swift] `AgentPartialView`가 `agent.partial` 스트리밍 델타 실시간 표시
  - [ ] [runtime] staging 백엔드 접속하여 김인턴 응답 1회 렌더 확인
- **라벨:** `type:feature`, `area:macos`
- **참조:** 경험 D(`research/07-deepdive/05-agent-native-experiences.md`) · L4 §5.2, §5.3(ChatBackend)

#### MOMO-021 · B 비용 호흡 링 실데이터 바인딩
- **마일스톤:** M3 · **에픽:** EP-UX-DBC · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-004
- **수용기준:**
  - [ ] [swift] `CostBreathingRing`이 `usage_ledger`/`budget_window` 실데이터에 바인딩
  - [ ] [swift] 예산 소진율에 따라 링 시각 변화 + soft/hard limit 표시
  - [ ] [runtime] staging 실데이터로 비용 누적 반영 확인
- **라벨:** `type:feature`, `area:macos`
- **참조:** 경험 B(05) · L4 §8.5(2단계 회계)

#### MOMO-022 · C 승인 인박스 실데이터 왕복
- **마일스톤:** M3 · **에픽:** EP-UX-DBC · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-004
- **수용기준:**
  - [ ] [swift] `ApprovalInboxView`가 approval(pending) 실데이터 표시
  - [ ] [runtime] 승인/거절 액션 → 서버 PATCH → agent_run 게이트 해제 왕복
  - [ ] [runtime] 결정 `audit_log` 기록 확인
- **라벨:** `type:feature`, `area:macos`
- **참조:** 경험 C(05) · L4 §5.2, §7.3 · `schema_v0.sql`(approval/agent_run)

---

### EP-AGENT-PROTOCOL — Local LLM UX · Agent Protocol Cards (M3)

#### MOMO-130 · macOS Foundation Models capability probe
- **마일스톤:** M3 · **에픽:** EP-AGENT-PROTOCOL · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-110
- **수용기준:**
  - [ ] [swift] `#if canImport(FoundationModels)`와 OS availability guard로 빌드 호환성 유지
  - [ ] [swift] 미지원 OS에서는 server AgentWorker fallback 또는 deterministic local stub 사용
  - [ ] [swift] Core는 Foundation-only 유지, FoundationModels import는 macOS/iOS target에만 둠
- **라벨:** `type:feature`, `area:macos`, `area:core`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/01-local-llm-context-broker.md`

#### MOMO-131 · Local Context Copilot
- **마일스톤:** M3 · **에픽:** EP-AGENT-PROTOCOL · **플랫폼:** macos · **추정:** L
- **deps:** MOMO-120, MOMO-130
- **수용기준:**
  - [ ] [swift] visible channel/thread context에서 요약, 분류, 컨텍스트 압축, PII redaction preview 제공
  - [ ] [swift] local model unsupported 시 동일 UI가 server fallback/stub으로 동작
  - [ ] [manual] 고위험 외부 write/법무/재무 판단은 local-only 자동 처리하지 않음
- **라벨:** `type:feature`, `area:macos`, `priority:p1`, `size:l`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/01-local-llm-context-broker.md`

#### MOMO-132 · Agent Protocol v0 DB/wire/Swift/card alignment
- **마일스톤:** M3 · **에픽:** EP-AGENT-PROTOCOL · **플랫폼:** shared · **추정:** L
- **deps:** MOMO-120, MOMO-121, MOMO-004
- **수용기준:**
  - [ ] [spec] `agent_request/context_packet/tool_call/approval_request/tool_result/usage_ledger/audit_log`의 DB/wire/Swift 의미 정합
  - [ ] [swift] macOS card renderer가 같은 protocol object를 사용
  - [ ] [runtime] external write는 approval card 없이 실행되지 않음
- **라벨:** `type:spec`, `type:feature`, `area:core`, `area:macos`, `area:worker`, `priority:p1`, `size:l`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/02-agent-protocol-google-workspace.md`

#### MOMO-133 · Google Workspace "ask my work" UX
- **마일스톤:** M3 · **에픽:** EP-GWORKSPACE/EP-AGENT-PROTOCOL · **플랫폼:** macos · **추정:** L
- **deps:** MOMO-122, MOMO-132
- **수용기준:**
  - [ ] [swift] Drive/Gmail/Calendar source refs를 답변에 cite
  - [ ] [swift] external write action은 approval card를 거쳐야 함
  - [ ] [runtime] source permission이 없는 문서는 Context Packet에서 제외
- **라벨:** `type:feature`, `area:macos`, `area:server`, `priority:p1`, `size:l`, `status:runtime-unverified`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/02-agent-protocol-google-workspace.md`

#### MOMO-134 · build-macos-apps based SwiftPM GUI run loop
- **마일스톤:** M3 · **에픽:** EP-AGENT-PROTOCOL/EP-OPS · **플랫폼:** macos · **추정:** S
- **deps:** MOMO-110
- **수용기준:**
  - [ ] [swift] `script/build_and_run.sh`가 `clients/macOS` SwiftPM GUI executable을 빌드하고 `dist/MomoMacDevApp.app`으로 staging
  - [ ] [xcode] Codex app `.codex/environments/environment.toml` Run action이 script를 호출
  - [ ] [manual] `--verify`, `--logs`, `--telemetry`, `--debug` 모드 중 최소 `--verify` 검증
- **라벨:** `type:infra`, `area:macos`, `priority:p1`, `size:s`, `agent:codex-ok`
- **참조:** `research/10-local-ai-protocol-trust/03-enterprise-trust-local-ops.md`

#### MOMO-160 · A2A-style agent_run lifecycle alignment
- **마일스톤:** M2 · **에픽:** EP-AGENT-RUNTIME/EP-AGENT-PROTOCOL · **플랫폼:** shared · **추정:** M
- **deps:** MOMO-151, MOMO-004
- **수용기준:**
  - [ ] [spec] A2A Task/Message/Artifact/status를 momo `agent_run/message/artifact_ref/agent.status`에 매핑
  - [ ] [spec] queued/running/input-required/awaiting-approval/succeeded/failed/cancelled 상태 의미 확정
  - [ ] [spec] `input-required`(추가 입력)와 `awaiting-approval`(승인 게이트)을 분리
  - [ ] [swift/sql] Swift model/DB migration/AgentWorker runtime 영향 범위 기록
  - [ ] [swift] 후속 구현 시 기존 5패키지 build/test green 유지
- **라벨:** `type:spec`, `area:core`, `area:worker`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/07-agent-run-lifecycle-v0.md`

#### MOMO-161 · approval pause/resume runtime
- **마일스톤:** M2 · **에픽:** EP-AGENT-RUNTIME/EP-AGENT-PROTOCOL · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-160
- **수용기준:**
  - [x] [spec] approval pause/resume 정본 문서와 same-run resume 모델 정의
  - [x] [swift] risky `tool_call`이 `approval(status=pending)`과 `message.type='approval_request'`를 만들고 `agent_run.status='awaiting_approval'`로 멈추는 AgentWorker pause slice
  - [x] [swift] 승인/거절/만료 decision outcome smoke test
  - [ ] [runtime] server approval decision endpoint가 동일 run을 resume하거나 terminate하고 `audit_log`에 기록
- **라벨:** `type:feature`, `area:server`, `area:worker`, `priority:p1`, `size:l`, `status:runtime-unverified`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/08-approval-pause-resume-runtime.md`

#### MOMO-162 · Hermes adapter contract verification
- **마일스톤:** M2 · **에픽:** EP-AGENT-RUNTIME · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-150, MOMO-004
- **수용기준:**
  - [ ] [runtime] Hermes platform adapter path와 momo AgentWorker SSE path를 각각 검증하거나 제품 기본 경로를 하나로 확정
  - [ ] [python] `adapters/hermes/momo_adapter.py`가 현재 Hermes adapter API와 정합하는지 live/static check 기록
  - [ ] [docs] compatibility path와 canonical execution path를 RUN/STATUS에 구분 기록
- **라벨:** `type:spec`, `type:docs`, `area:adapter`, `area:worker`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/01-three-agent-runtime-analysis.md`

#### MOMO-163 · inbound MCP server v0
- **마일스톤:** M2 · **에픽:** EP-AGENT-RUNTIME/EP-AGENT-PROTOCOL · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-151, MOMO-153
- **수용기준:**
  - [ ] [spec] 외부 에이전트용 search messages, fetch thread, post message, create approval-safe tool call surface 정의
  - [ ] [runtime] MCP 호출도 RLS/membership/plugin policy를 우회하지 않음
  - [ ] [runtime] write tool은 approval/audit 경로를 사용
- **라벨:** `type:feature`, `area:server`, `area:worker`, `priority:p1`, `size:l`, `status:runtime-unverified`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/02-memory-cache-protocol-gaps.md`

#### MOMO-172 · inbound MCP server v0 skeleton/spec-to-code bridge
- **마일스톤:** M2 · **에픽:** EP-AGENT-RUNTIME/EP-AGENT-PROTOCOL · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-163
- **GitHub:** #80
- **수용기준:**
  - [x] [swift] `server` package에 MCP registry/model/route skeleton 추가
  - [x] [swift] `momo.search_messages`, `momo.fetch_thread`, `momo.post_message`, `momo.create_tool_call` descriptor 구조 추가
  - [x] [swift] MCP JSON-RPC transport/tool execution은 compile-safe stub + `TODO(#80)`
  - [x] [docs] MCP endpoint/security/permission model 갱신
  - [x] [swift] descriptor/security smoke test 추가
  - [ ] [swift] `scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부
- **라벨:** `type:feature`, `area:server`, `priority:p1`, `size:m`, `status:runtime-unverified`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/09-inbound-mcp-server-v0.md`, `docs/INBOUND_MCP.md`

#### MOMO-170 · macOS agent protocol cards
- **마일스톤:** M3 · **에픽:** EP-AGENT-RUNTIME/EP-AGENT-PROTOCOL · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-132, MOMO-161
- **수용기준:**
  - [ ] [swift] tool_call, approval, artifact, cost, memory citation, source badge cards 렌더
  - [ ] [swift] cards use shared protocol semantics, not one-off UI-only props
  - [ ] [runtime] approval card decisions update server state
- **라벨:** `type:feature`, `area:macos`, `area:core`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/03-roadmap-and-methodology.md`

#### MOMO-171 · agent memory inspector
- **마일스톤:** M3 · **에픽:** EP-AGENT-RUNTIME/EP-CONTEXT · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-152, MOMO-170
- **수용기준:**
  - [ ] [swift] 답변에 사용된 memory/source refs를 사용자가 확인
  - [ ] [swift] personal/workspace memory view, delete, block 경로 제공
  - [ ] [runtime] 권한 없는 memory는 표시/주입되지 않음
- **라벨:** `type:feature`, `area:macos`, `area:core`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/03-roadmap-and-methodology.md`

#### MOMO-174 · local LLM context compaction
- **마일스톤:** M3 · **에픽:** EP-AGENT-RUNTIME/EP-AGENT-PROTOCOL · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-130, MOMO-151
- **수용기준:**
  - [ ] [swift] local model로 source-preserving channel/thread summary 생성
  - [ ] [swift] 미지원 OS에서는 server fallback/stub으로 동작
  - [ ] [spec] summary가 source IDs를 잃지 않도록 fixture 검증
- **라벨:** `type:feature`, `area:macos`, `area:core`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/03-roadmap-and-methodology.md`

---

### EP-MAC-PKG — macOS 패키징·공증·배포 (M4)

#### MOMO-030 · C1: MomoMac.xcodeproj (Developer ID, hardened runtime)
- **마일스톤:** M4 · **에픽:** EP-MAC-PKG · **플랫폼:** macos · **추정:** L
- **deps:** MOMO-020
- **수용기준:**
  - [ ] [xcode] `clients/macOS/MomoMac.xcodeproj` 생성(MomoCore/MomoMac 로컬 SwiftPM 의존, 앱 타깃만 Xcode)
  - [ ] [xcode] scheme `MomoMac`, Bundle ID `com.dawnkim.momo`, hardened runtime ON, entitlements(네트워크/keychain)
  - [ ] [xcode] `xcodebuild build -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` 성공
- **라벨:** `type:infra`, `area:macos`, `area:store`
- **참조:** `docs/cicd/04-codex-tickets.md` C1 · `research/08-distribution/01-macos-distribution-spec.md` · L4 §9.3

#### MOMO-031 · macOS codesign + notarytool 공증 + stapler
- **마일스톤:** M4 · **에픽:** EP-MAC-PKG · **플랫폼:** macos · **추정:** L
- **deps:** MOMO-030
- **수용기준:**
  - [ ] [manual] bottom-up codesign(`--options runtime --timestamp --entitlements`) + Developer ID Application
  - [ ] [manual] create-dmg → `xcrun notarytool submit --wait` Accepted → stapler staple(.app/.dmg)
  - [ ] [manual] 타 맥에서 `spctl --assess` 통과(Gatekeeper) + `codesign --verify --deep --strict` 통과
- **라벨:** `type:infra`, `area:macos`, `area:store`, `gate:qa`
- **참조:** `research/08-distribution/01-macos-distribution-spec.md` · altool 폐기(2023-11-01)→notarytool 유일

#### MOMO-032 · Sparkle 2 EdDSA 자동업데이트 + appcast
- **마일스톤:** M4 · **에픽:** EP-MAC-PKG · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-031
- **수용기준:**
  - [ ] [manual] Sparkle 2 EdDSA `generate_keys` → `SUPublicEDKey`/`SUFeedURL` Info.plist 설정
  - [ ] [manual] `generate_appcast`로 appcast.xml 생성(각 릴리스 .app 공증·staple 필수)
  - [ ] [manual] 구버전→신버전 자동업데이트 1회 성공
- **라벨:** `type:feature`, `area:macos`, `area:store`
- **참조:** `research/08-distribution/01-macos-distribution-spec.md` Sparkle 섹션

---

### EP-IOS — iOS 앱 타깃·Push·계정삭제 (M5)

#### MOMO-040 · C2: MomoiOS.xcodeproj (iOS 26 SDK, Push capability)
- **마일스톤:** M5 · **에픽:** EP-IOS · **플랫폼:** ios · **추정:** L
- **deps:** MOMO-020
- **수용기준:**
  - [ ] [xcode] `clients/iOS/` 생성 + `MomoiOS.xcodeproj`(MomoCore 공유), iOS 26 SDK + Xcode 26 빌드
  - [ ] [xcode] scheme `MomoiOS`, explicit Bundle ID + Push Notifications capability(+Background Modes remote notification)
  - [ ] [xcode] `xcodebuild build-for-testing -scheme MomoiOS -destination 'platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO` 성공
- **라벨:** `type:infra`, `area:ios`, `area:store`
- **참조:** `docs/cicd/04-codex-tickets.md` C2 · 2026-04-28 iOS 26 SDK 업로드 요건 · L4 §5.3

#### MOMO-041 · APNs .p8(ES256) 연결 + push_token 등록 경로
- **마일스톤:** M5 · **에픽:** EP-IOS · **플랫폼:** ios · **추정:** M
- **deps:** MOMO-040
- **수용기준:**
  - [ ] [swift] APNs Auth Key .p8(ES256) 기반 provider JWT(1h 수명) 갱신 액터
  - [ ] [runtime] 디바이스 토큰 등록 → `push_token`(env/topic=bundle id) 저장 + 410/400 시 `invalidated_at`
  - [ ] [runtime] `push_dispatch_log`로 발송 결과 추적
- **라벨:** `type:feature`, `area:ios`, `area:server`
- **참조:** L4 §2.4(APNs DDL), §8.3(운영 상수) · `schema_v0.sql`(push_token/push_dispatch_log)

#### MOMO-042 · 앱 내 계정 삭제 흐름 (5.1.1(v))
- **마일스톤:** M5 · **에픽:** EP-IOS · **플랫폼:** ios · **추정:** M
- **deps:** MOMO-040
- **수용기준:**
  - [ ] [swift] 설정에 '계정 삭제'(비활성화 아님) 진입점 + 확인
  - [ ] [runtime] 서버 삭제 엔드포인트: member/human 및 연관 데이터 삭제 처리 + `audit_log`
  - [ ] [runtime] 삭제 후 재로그인 불가 확인
- **라벨:** `type:feature`, `area:ios`, `area:server`, `gate:qa`
- **참조:** App Store 5.1.1(v) · `docs/legal/00-prelaunch-admin-legal-checklist.md`

#### MOMO-043 · PrivacyInfo.xcprivacy + 암호화 export 신고
- **마일스톤:** M5 · **에픽:** EP-IOS · **플랫폼:** ios · **추정:** M
- **deps:** MOMO-040
- **수용기준:**
  - [ ] [xcode] `PrivacyInfo.xcprivacy`: 수집 데이터 유형 + `NSPrivacyAccessedAPITypes`(required reason) + 포함 SDK(APNSwift 등) 반영
  - [ ] [xcode] Info.plist `ITSAppUsesNonExemptEncryption` 설정(표준 TLS/APNs만이면 면제 NO, 자체 암호화 있으면 YES — 의존성 전수 확인)
  - [ ] [manual] App Privacy 라벨과 manifest 내용 일관
- **라벨:** `type:infra`, `area:ios`, `area:store`, `type:docs`
- **참조:** privacy manifest 2024-11-12 필수 · `docs/legal/03-app-privacy-datamap.md` · L9 암호화 수출규제

---

### EP-UGC — UGC 모더레이션 (M5)

#### MOMO-044 · UGC 모더레이션 4종 + EULA 무관용 (1.2)
- **마일스톤:** M5 · **에픽:** EP-UGC · **플랫폼:** ios · **추정:** L
- **deps:** MOMO-040
- **수용기준:**
  - [ ] [swift] 게시 전 objectionable material 필터링 + 신고(report) + 차단(block) + 공개 연락처
  - [ ] [manual] EULA에 objectionable content 무관용 명시(외부 변호사 검토)
  - [ ] [swift] 에이전트 생성 콘텐츠 모더레이션 정책 별도 명시(에이전트=1급 멤버)
- **라벨:** `type:feature`, `area:ios`, `area:store`, `gate:qa`
- **참조:** App Store 1.2(UGC 4종) · `docs/legal/00-prelaunch-admin-legal-checklist.md` L4 EULA

---

### EP-CICD — CI/CD 파이프라인 (M6)

#### MOMO-050 · ci-build.yml: swift build/test + xcode-apps 빌드
- **마일스톤:** M6 · **에픽:** EP-CICD · **플랫폼:** ci · **추정:** M
- **deps:** MOMO-030, MOMO-040
- **수용기준:**
  - [ ] [ci] `.github/workflows/ci-build.yml` swift build/test 잡 green
  - [ ] [ci] `xcode-apps` 잡 주석 해제 → iOS+macOS 무서명 빌드 green(경로/scheme 정합)
  - [ ] [ci] `actionlint` 통과
- **라벨:** `type:infra`, `area:ci`
- **참조:** `docs/cicd/04-codex-tickets.md` CI1/CI2 · `docs/cicd/00-apple-cicd-pipeline.md`

#### MOMO-051 · ASC API Key(Team) + fastlane match 초기화
- **마일스톤:** M6 · **에픽:** EP-CICD · **플랫폼:** ci · **추정:** M
- **deps:** MOMO-050
- **수용기준:**
  - [ ] [manual] App Store Connect API Key(.p8/key_id/issuer_id, **Team Key**) 발급 + base64 단일 secret 보관
  - [ ] [manual] fastlane match appstore(iOS) + developer_id(macOS) 최초 동기화(별도 signing repo, CI readonly)
  - [ ] [manual] `gh secret list --repo Dawn-kim-official/momo` 에 6개 필수 secret 존재
- **라벨:** `type:infra`, `area:ci`
- **참조:** `docs/cicd/01-setup-runbook.md` · `docs/cicd/02-secrets-inventory.md` · Individual Key 불가(provisioning/notaryTool 제한)

#### MOMO-052 · release-ios/release-macos 워크플로우 dry-run (게이트 전 미트리거)
- **마일스톤:** M6 · **에픽:** EP-CICD · **플랫폼:** ci · **추정:** M
- **deps:** MOMO-051
- **수용기준:**
  - [ ] [ci] `release-ios.yml`(gym→pilot) + `release-macos.yml`(notarytool submit --wait→stapler) syntax/lint 통과
  - [ ] [ci] dry-run 성공(태그 미푸시 또는 environment protection으로 실배포 차단)
  - [ ] [ci] altool 미사용(notarytool 전용) 확인
- **라벨:** `type:infra`, `area:ci`, `gate:qa`
- **참조:** `docs/cicd/04-codex-tickets.md` CI3/CI4 · 🔒 게이트 PASS 전 트리거 금지

---

### EP-QA-GATE — QA · 사용성 검수 게이트 (M7)

#### MOMO-060 · 크래시/분석 계측 (Sentry Cocoa + MetricKit)
- **마일스톤:** M7 · **에픽:** EP-QA-GATE · **플랫폼:** shared · **추정:** M
- **deps:** MOMO-030, MOMO-040
- **수용기준:**
  - [ ] [swift] Sentry Cocoa(self-host) Release Health(crash-free 세션/유저) + MetricKit(MXCrashDiagnostic/MXHangDiagnostic) 인입
  - [ ] [swift] macOS는 TestFlight 없으므로 크래시-free를 Sentry/MetricKit에 의존(실기기 페이로드)
  - [ ] [manual] App Privacy 라벨에 Sentry/MetricKit 수집 데이터 반영
- **라벨:** `type:feature`, `area:macos`, `area:ios`, `gate:qa`
- **참조:** `docs/cicd/07-crash-analytics-spec.md` · `docs/cicd/05-qa-release-gate.md` G-A

#### MOMO-061 · 핵심 8플로우 XCUITest + 접근성 + 성능 측정
- **마일스톤:** M7 · **에픽:** EP-QA-GATE · **플랫폼:** shared · **추정:** L
- **deps:** MOMO-060
- **수용기준:**
  - [ ] [xcode] 핵심 8플로우 XCUITest 자동화 8/8 PASS + 수동 스모크, 치명 결함 0
  - [ ] [xcode] `performAccessibilityAudit` 치명 위반 0 + VoiceOver 핵심플로우 조작 가능
  - [ ] [xcode] `XCTApplicationLaunchMetric` 콜드 런치 p90<2s, hang≈0(실기기·Release 구성)
- **라벨:** `type:feature`, `area:macos`, `area:ios`, `gate:qa`
- **참조:** `docs/cicd/08-e2e-accessibility-performance.md` · `docs/cicd/05-qa-release-gate.md` G-B/G-C/G-D

#### MOMO-062 · 베타 배포 (TestFlight 내부 + macOS 공증 DMG 비공개)
- **마일스톤:** M7 · **에픽:** EP-QA-GATE · **플랫폼:** shared · **추정:** M
- **deps:** MOMO-052, MOMO-061
- **수용기준:**
  - [ ] [manual] iOS: fastlane pilot로 TestFlight 내부(≤100) 업로드(**외부는 게이트 PASS 후**)
  - [ ] [manual] macOS: Developer ID 공증 .dmg 비공개 베타 → 타 맥 spctl/Gatekeeper 통과
  - [ ] [manual] 베타 피드백 ASC API 수집 → P0/P1 전수 트리아지
- **라벨:** `type:infra`, `area:ci`, `gate:qa`
- **참조:** `docs/cicd/06-beta-testflight-plan.md` · `docs/cicd/05-qa-release-gate.md` G-E/G-F

#### MOMO-063 · 게이트 PASS 판정 + 03 PASS 블록 기록
- **마일스톤:** M7 · **에픽:** EP-QA-GATE · **플랫폼:** shared · **추정:** S
- **deps:** MOMO-001, MOMO-060, MOMO-061, MOMO-062
- **수용기준:**
  - [ ] [manual] G-0~G-H 전부 PASS + 증거(크래시-free 지표/분모/윈도우, e2e 결과, 접근성 감사, 성능 수치, 베타 피드백, trust evidence) 첨부
  - [ ] [manual] `docs/cicd/03-store-readiness-gate.md` 상단에 PASS 블록(날짜+커밋해시+빌드#+증거 링크) 기록
  - [ ] [manual] `STATUS.md` 게이트 상태 OPEN→PASS 갱신
- **라벨:** `type:docs`, `gate:qa`, `priority:p0`
- **참조:** `docs/cicd/05-qa-release-gate.md` §10 PASS 양식 · 🔒 **이 티켓 closed 전 MOMO-070/071/072 착수 금지**

---

### EP-TRUST — Enterprise Trust Gate (M7)

#### MOMO-140 · Enterprise Trust Gate evidence package
- **마일스톤:** M7 · **에픽:** EP-TRUST/EP-QA-GATE · **플랫폼:** shared · **추정:** L
- **deps:** MOMO-111, MOMO-112, MOMO-132
- **수용기준:**
  - [ ] [spec] threat model, data flow, deployment hardening, agent execution ledger 설명을 security whitepaper 초안으로 작성
  - [ ] [ci] SBOM/license scan/secret scanning 결과를 local gate 또는 release evidence에 포함
  - [ ] [manual] external pentest/VDP/SOC2 Type I/II/ISO27001/CSA STAR/ISMS-P 로드맵과 책임자를 문서화
  - [ ] [docs] `docs/cicd/05-qa-release-gate.md`에 G-H Enterprise Trust gate 반영
- **라벨:** `type:spec`, `type:docs`, `area:legal`, `area:ci`, `gate:qa`, `priority:p1`, `size:l`
- **참조:** `research/10-local-ai-protocol-trust/03-enterprise-trust-local-ops.md`

---

### EP-STORE — 스토어 제출 (M8)

#### MOMO-070 · iOS App Store 메타/스크린샷/연령등급/App Privacy 제출
- **마일스톤:** M8 · **에픽:** EP-STORE · **플랫폼:** ios · **추정:** M
- **deps:** MOMO-063
- **수용기준:**
  - [ ] [manual] App Store Connect 앱 레코드 + 메타(이름/부제/설명/키워드/지원URL) + 현 규격 스크린샷(6.9/6.5 iPhone, 13 iPad — 제출 직전 재확인)
  - [ ] [manual] App Privacy 라벨(제3자/LLM 포함) + 연령등급 설문(UGC 반영)
  - [ ] [manual] 심사용 데모 워크스페이스 + 유효 초대코드 + 백엔드 가동 SLA
- **라벨:** `type:infra`, `area:store`, `area:ios`, `priority:p0`
- **참조:** App Store 2.1(완성도)·App Privacy · `docs/legal/03-app-privacy-datamap.md`

#### MOMO-071 · iOS 빌드 업로드 → App Review → 배포
- **마일스톤:** M8 · **에픽:** EP-STORE · **플랫폼:** ios · **추정:** M
- **deps:** MOMO-070
- **수용기준:**
  - [ ] [manual] external TestFlight 첫 빌드 Beta App Review 통과(**게이트 PASS 확인 후**)
  - [ ] [manual] fastlane deliver(submit_for_review) → App Review 승인
  - [ ] [manual] 배포(1.0은 보통 즉시 전체 출시 — phased는 업데이트 한정)
- **라벨:** `type:infra`, `area:store`, `area:ios`, `gate:qa`, `priority:p0`
- **참조:** TestFlight 외부 첫 빌드 Beta App Review · phased release 1.0 비적용 `(추정)`

#### MOMO-072 · macOS 공증 DMG 공개 다운로드 + Sparkle 라이브
- **마일스톤:** M8 · **에픽:** EP-STORE · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-063, MOMO-032
- **수용기준:**
  - [ ] [manual] `release-macos.yml`(게이트 PASS 후) 가동 → 공증 .dmg를 GitHub Release/다운로드 페이지에 공개
  - [ ] [manual] 공개 다운로드 후 Gatekeeper 통과(사용자 머신 spctl)
  - [ ] [manual] Sparkle appcast 라이브 → 신버전 배포 시 자동업데이트 노출
- **라벨:** `type:infra`, `area:store`, `area:macos`, `priority:p0`
- **참조:** `research/08-distribution/01-macos-distribution-spec.md` · 공증=직접배포(App Store와 별개)

---

### EP-LEGAL — 법무 선결 (M2/M5) — *법률 자문 아님, 외부 변호사 1회 검토 필수*

#### MOMO-080 · 법무 L0/L1: 등록주체 + D-U-N-S + Apple 등록
- **마일스톤:** M2 · **에픽:** EP-LEGAL · **플랫폼:** legal · **추정:** S
- **deps:** (없음)
- **수용기준:**
  - [ ] [manual] 개인 vs 법인 결정 문서화 + (법인) D-U-N-S 발급 신청(무료, 약 7영업일, expedite 불가)
  - [ ] [manual] Apple Developer Program 조직 가입($99/년, 2FA Apple Account)
  - [ ] [manual] Codex는 절차/런북만 준비, 실제 발급/계약은 사람 위임 표시 — **법률 자문 아님**
- **라벨:** `type:docs`, `area:legal`, `priority:p1`
- **참조:** `docs/legal/00-prelaunch-admin-legal-checklist.md` L0/L1 · `docs/legal/01-entity-apple-runbook.md`

#### MOMO-081 · 법무 L3/L5: 개인정보처리방침 + App Privacy + LLM 고지
- **마일스톤:** M2 · **에픽:** EP-LEGAL · **플랫폼:** legal · **추정:** M
- **deps:** MOMO-080
- **수용기준:**
  - [ ] [manual] 개인정보처리방침 URL 작성(미수집도 필수) + 한국 개인정보보호법/GDPR 고려
  - [ ] [manual] App Privacy 라벨 초안(제3자/hermes LLM 전송 정직 신고)
  - [ ] [manual] 에이전트 LLM 제3자 전송: 온보딩 동의 + 승인 인박스 고지 — **외부 변호사 1회 검토(법률 자문 아님)**
- **라벨:** `type:docs`, `area:legal`, `area:store`, `priority:p1`
- **참조:** `docs/legal/00-prelaunch-admin-legal-checklist.md` L3/L5/L8 · `docs/legal/03-app-privacy-datamap.md`

#### MOMO-082 · 법무 L7/EULA: NOTICE 귀속 + UGC 무관용 EULA
- **마일스톤:** M5 · **에픽:** EP-LEGAL · **플랫폼:** legal · **추정:** S
- **deps:** MOMO-081
- **수용기준:**
  - [ ] [file] Apache 2.0 NOTICE 귀속을 앱 화면에 표기
  - [ ] [manual] UGC(채팅) EULA에 objectionable content 무관용 명시(1.2)
  - [ ] [manual] 한국 부가통신 신고 면제 여부 확인(자본금 1억원 이하, 시행령 30조) — 법인화 시 재확인, **법률 자문 아님**
- **라벨:** `type:docs`, `area:legal`, `area:store`, `priority:p1`
- **참조:** `docs/legal/00-prelaunch-admin-legal-checklist.md` L4/L6/L7 · `NOTICE` · `legal/THIRD_PARTY_NOTICES.md`

---

### EP-PRIMITIVES — v1 신규 프리미티브 P1~P6 (후속, M8 이후)

> 전부 **스토어 출시(MOMO-071/072) 후 후속**. v0 데모엔 불필요. `schema_v0.sql` 정본은 신규 마이그레이션으로만 확장. 일부 항목은 현 단일 모노토닉 seq 가정과 충돌 가능 → `(추정)` 표기.

#### MOMO-090 · P1 branch_id 좌표축 (분기 타임라인, 가장 큰 신규)
- **마일스톤:** M8 · **에픽:** EP-PRIMITIVES · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-071, MOMO-072
- **수용기준:**
  - [ ] [sql] message에 `branch_id` 컬럼 + 분기당 channel_seq 별도 카운터(또는 경량 서브채널)
  - [ ] [sql] branch→main 정본 병합 시 seq 재매핑
  - [ ] [spec] 갈래별 reserve/reconcile 원장 격리 + 폐기 갈래 자동 환불 `(추정 — 현 seq는 채널당 단일 모노토닉)`
- **라벨:** `type:spec`, `area:schema`, `priority:p2`, `status:runtime-unverified`
- **참조:** 경험 P1(`research/07-deepdive/05-agent-native-experiences.md`)

#### MOMO-091 · P2 reversibility_tier + 보상 레지스트리 (되돌리기 동료)
- **마일스톤:** M8 · **에픽:** EP-PRIMITIVES · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-071, MOMO-072
- **수용기준:**
  - [ ] [sql] tool_call props에 `reversibility` green/amber/red
  - [ ] [sql] 보상 핸들러 매핑 테이블(compensation registry)
  - [ ] [spec] `audit_log`를 역연산 소스로 재사용(인라인 UNDO 경로)
- **라벨:** `type:spec`, `area:schema`, `priority:p2`, `status:runtime-unverified`
- **참조:** 경험 P2(05)

#### MOMO-092 · P3 belief 메시지 타입 + 교정 원장 (길들이기)
- **마일스톤:** M8 · **에픽:** EP-PRIMITIVES · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-071, MOMO-072
- **수용기준:**
  - [ ] [sql] `message_type`에 `belief` 추가 또는 diff 재사용
  - [ ] [sql] belief 원장(member 속성 + 교정 이력) + co-sign/dispute는 reaction 재사용
- **라벨:** `type:spec`, `area:schema`, `priority:p2`, `status:runtime-unverified`
- **참조:** 경험 P3(05)

#### MOMO-093 · P4 autonomy_level + 승급/강등 사건 (수습→정직원)
- **마일스톤:** M8 · **에픽:** EP-PRIMITIVES · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-071, MOMO-072
- **수용기준:**
  - [ ] [sql] agent 테이블에 `autonomy_level`
  - [ ] [sql] 승급/강등 `audit_log` 사건 + 게이트 정책 바인딩(scope별 점진 소멸/자동 강등)
- **라벨:** `type:spec`, `area:schema`, `priority:p2`, `status:runtime-unverified`
- **참조:** 경험 P4(05)

#### MOMO-094 · P5 TIE-BREAK 결정표 + decision_ledger (공개 토론)
- **마일스톤:** M8 · **에픽:** EP-PRIMITIVES · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-071, MOMO-072
- **수용기준:**
  - [ ] [sql] approval 확장(2지선다→다지선다 캐스팅보트)
  - [ ] [sql] 불변 `decision_ledger` 테이블 + minority report 첨부/recall
- **라벨:** `type:spec`, `area:schema`, `priority:p2`, `status:runtime-unverified`
- **참조:** 경험 P5(05)

#### MOMO-095 · P6 scheduled trigger (스탠드업/야간조/노크)
- **마일스톤:** M8 · **에픽:** EP-PRIMITIVES · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-071, MOMO-072
- **수용기준:**
  - [ ] [sql] cron/트리거 테이블(outbox agent_job kind 확장으로 흡수 가능)
  - [ ] [spec] 예약/모니터링 트리거 디스패치 + 예산 가진 주도적 노크 경로
- **라벨:** `type:spec`, `area:schema`, `priority:p2`, `status:runtime-unverified`
- **참조:** 경험 P6(05)

---

## 5. GitHub 이슈 변환 가이드 (Codex)

### 5.1 매핑 규칙
- **GitHub 이슈 제목** = `MOMO-NNN · <제목>` (예: `MOMO-001 · docker 런타임 e2e: migrate 멱등 + /health + seq 갭리스`).
- **마일스톤** = §1 표의 마일스톤 ID/이름. 기존 `scripts/github/milestones.tsv` 와 매핑은 `ROADMAP.md §6`.
- **라벨** = 각 티켓 `라벨` 필드 그대로(`scripts/github/labels.tsv` 택소노미). Codex 자율 실행 적합 티켓엔 `agent:codex-ok` 추가 권장(`[manual]`/`legal` 제외).
- **본문(body)** = `## Goal`(목표 1~2줄) + `## Context`(참조 링크) + `## Acceptance`(수용기준 체크박스 그대로) + `## Depends on:`(deps를 이슈 번호/제목으로) + `## Out of scope`(선택).
- **의존** = `deps` 필드를 본문 `Depends on:` 에 기재. GitHub Projects의 의존 그래프(§3) 그대로.

### 5.2 다음 티켓 선택법
1. `deps`가 전부 done(또는 baseline M0)인 가장 낮은 의존 깊이를 고른다.
2. `legal`/`[manual]` 티켓은 Codex가 파일/문서/런북만 준비하고 실제 발급·계약·심사는 사람에게 위임 표시.
3. 각 티켓 종료 시 검증 명령 결과를 `STATUS.md`에 기록. 미검증은 정직 표기(`status:runtime-unverified`).

### 5.3 공통 검증 명령
```bash
# Swift (현재 가능)
make build && make test

# 런타임(docker 환경 필요)
cp infra/.env.example .env && make up && make migrate

# fastlane 구문/레인
bundle install && bundle exec fastlane lanes

# 워크플로우 lint
actionlint .github/workflows/*.yml

# Xcode app (MOMO-030/040 후)
xcodebuild -list -project clients/macOS/MomoMac.xcodeproj
xcodebuild -list -project clients/iOS/MomoiOS.xcodeproj
```

### 5.4 불변식 재확인 (🔒)
- **MOMO-063(게이트 PASS) closed 전** → MOMO-070/071/072 착수 금지 + `release-*.yml` 트리거 금지.
- **`schema_v0.sql` 이동·수정 금지** → 확장은 `server/Migrations/00N_*.sql` 신규 + RLS DO-block ARRAY 등록.
- **법무 항목은 법률 자문이 아님** → EULA/개인정보처리방침/약관은 외부 변호사 1회 검토.

---

> 정본 참조: `ROADMAP.md`(상위 정본) · `STATUS.md`(현재 상태) · `BUILD_TICKETS.md`(빌드 백로그) · `schema_v0.sql`(스키마) · `docs/cicd/*`(CI/CD·게이트) · `docs/legal/*`·`legal/*`(법무) · `research/07-deepdive/04·05`(스펙·경험) · `research/08-distribution/*`(배포).
