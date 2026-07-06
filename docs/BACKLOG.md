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
| **EP-DESIGN-SYSTEM** | MomoDS 디자인 시스템 · 디자인 리뷰 자동화 | M3 | 토큰 4층(Primitive/Semantic/Component/Density) + ugly mode + 컴포넌트 추출 + `momo-design-taste` skill/design-review 루프. 정본: `research/13-redesign/01` Track A + `02` §3. |
| **EP-MESSENGER-CORE** | 메신저 코어 UX (테이블스테이크스) | M3 | 마크다운/편집·삭제/멘션 자동완성/스레드/unread·알림/검색(Cmd+K)/리액션/음성 입력. 스키마는 이미 지원 — 라우트+UI 슬라이스. 정본: `research/13-redesign/01` Track B. |
| **EP-SEC-CORE** | 런타임 보안 하드닝 · BYOK | M1/M2 | subscribe proxy 인증, token revocation, rate limit, BYOK provider_config(봉투 암호화), audit redaction, retention. 정본: `research/13-redesign/01` Track C/F. |

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
 MOMO-010 ─┬─ MOMO-011 ── MOMO-014(proposed)        │            ├─ MOMO-044  │        │
 │         ├─ MOMO-012                              │            └─ MOMO-050 ─┘        │
 │         └─ MOMO-013                              │                                      │
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

- **MOMO-001** (런타임 e2e 루트) — 거의 모든 백엔드 티켓의 선행. (검증됨 — 후속은 M1 잔여)
- **MOMO-080** (법무 L0/L1) — deps 없음, 사람 위임 런북 준비.
- **재설계 2026-07 진입점(§4 재설계 섹션):** MOMO-316(게이트 Wave 1) → MOMO-300/301/302/303(P0 병렬 가능). 팔로업 보드는 `research/13-redesign/00-execution-tracker.md`.

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
  - [ ] [infra] SOPS+age secret lifecycle runbook + `.sops.yaml.example`/`secrets.env.example` skeleton(실제 secret 없음)
  - [ ] [infra] prod secret template은 `change-me`/`dev-insecure` 값을 쓰지 않고 `openssl rand` 생성 지침으로만 채움
  - [ ] [infra] pgBackRest 주간 full + 일간 diff + 연속 WAL/PITR config skeleton + 복원 리허설 절차
  - [ ] [runtime] 실제 staging/prod에서 pgBackRest stanza/check/full backup/PITR 복원 1회 검증(MOMO-005 이후, `runtime-unverified` until then)
- **라벨:** `type:infra`, `area:infra`, `status:runtime-unverified`
- **참조:** L4 §8.7 · `infra/.env.example` · `infra/prod/*` · `docs/SECRETS_BACKUP_RUNBOOK.md` · `docs/RUN.md`

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
  - [x] [sql] `server/Migrations/003_onboarding.sql` 신규(schema_v0.sql **미수정**): `invite_code{id uuidv7, workspace_id FK, code_hash, role, max_uses, used_count, expires_at, revoked_at, created_by}`
  - [x] [sql] 고엔트로피 랜덤 code helper + hash 저장 + 만료 + 사용횟수 한정 + revoke 컬럼
  - [x] [sql] RLS DO-block ARRAY에 `invite_code`/`invite_code_redemption` 등록(FORCE), `schema_v0.sql` 정본은 그대로 둠
  - [x] [runtime] `scripts/local_gate.sh --profile runtime-db` + `scripts/local_gate.sh --profile swift` PASS
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

#### MOMO-012 · macOS dev app onboarding/invite flow v0 UI
- **마일스톤:** M2/M3 bridge · **에픽:** EP-TENANCY/EP-UX-DBC · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-010
- **수용기준:**
  - [x] [swift] `MomoMacDevApp`에서 invite code 입력/상태 UI 확인 가능
  - [x] [swift] `LiveChatBackend` stub으로 성공/실패/workspace join 상태 전이 확인
  - [x] [swift] 기존 channel/message/approval/cost UI 유지
  - [x] [macos-ui] `scripts/local_gate.sh --profile macos-ui` PASS
  - [x] [swift] `scripts/local_gate.sh --profile swift` PASS
- **라벨:** `type:feature`, `area:macos`, `area:tenancy`, `size:m`
- **참조:** ROADMAP §3.1/§3.2 · `clients/macOS/Sources/MomoMac/LiveChatBackend.swift`
- **후속 제안:** production server `/v1/join` 검증→member/membership→used_count→audit_log runtime e2e는 별도 이슈(`MOMO-014` 제안)로 분리.

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
  - [x] [spec] domain-wide delegation을 enterprise-only 옵션으로 문서화
  - [x] [spec] admin approval, service account boundary, scope inventory, user delegation, audit export, revoke/delete path 정의
  - [x] [spec] Context Packet / Memory Plane / Capability Cache projection과 invalidation 연결
  - [x] [spec] enterprise admin fixture 3종 추가
  - [ ] [manual] 실제 Google Workspace admin 승인/검증은 사람 위임 런북으로 분리
- **라벨:** `type:spec`, `area:adapter`, `area:tenancy`, `priority:p1`, `size:m`, `agent:codex-ok`
- **참조:** `research/11-agent-runtime/13-google-workspace-enterprise-admin-v0.md`

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

### 재설계 2026-07 — EP-DESIGN-SYSTEM / EP-MESSENGER-CORE / EP-SEC-CORE + 기존 에픽 확장 (M1~M3)

> **정본:** `research/13-redesign/01-agent-native-redesign-2026-07.md`(진단 P1~P7 + 6트랙) · `02-gate-optimization.md`(게이트/리뷰 루프) · `03-google-workspace-files-rag.md`(파일/RAG).
> **팔로업 보드:** `research/13-redesign/00-execution-tracker.md` — 재설계 티켓 종료 시 STATUS.md와 함께 갱신.
> **Phase 순서:** Phase 0(316·318, 317 병행) → Phase 1 P0(300~304) → Phase 2 P1(305~310, 320~321, 323) → Phase 3 P2(311~315, 319, 322). M0~M8 backbone과 M7 게이트 불변식은 불변.

#### Phase 0 — 게이트/도구 정비 (EP-OPS 확장, M1)

#### MOMO-316 · Local gate Wave 1: diff 기반 --auto 프로파일 + compose --wait + 멱등 1-run evidence
- **마일스톤:** M1 · **에픽:** EP-OPS · **플랫폼:** ci · **추정:** S
- **deps:** — (baseline)
- **수용기준:**
  - [x] [infra] `scripts/local_gate.sh --auto`가 `git diff --name-only origin/main...HEAD` 경로 매핑(docs→docs, clients→swift+macos-ui, server/Migrations→runtime-db, relay→runtime-relay, workers→runtime-agent, infra/prod→staging-smoke)으로 프로파일을 보수적으로 선택하고, 수동 지정이 항상 override — *리뷰 보정: `server/**`(비 Migrations)·`infra/**`(비 prod)는 relay/live/agent·로컬 compose 표면을 포함하므로 단독 프로파일로 좁히지 않고 `all`로 확대, 베이스 부재/merge-base 실패도 all로 확대(fail-open 금지)*
  - [x] [infra] 부팅 대기용 `wait_http` 폴링을 healthcheck 기반 `docker compose up -d --wait`로 교체(healthcheck 없는 서비스는 추가) — *carve-out(오너 승인): host-runtime의 Caddy edge `/health` 확인 1건은 edge 라우팅 검증 목적의 사후 확인이라 유지(사유 주석, api 준비는 --wait가 보장)*
  - [x] [runtime] 마이그레이션 멱등성 검증을 2회 컨테이너 실행 대신 단일 실행 내 apply→verify 2패스 + `compose logs migrate`의 `IDEMPOTENCY_OK` 마커 단정으로 대체(게이트가 `MIGRATE_IDEMPOTENCY_CHECK=1` 강제 + 마커 직접 grep), docs/runtime-db/host-runtime/local-alpha profile PASS 유지
- **라벨:** `type:infra`, `area:ops`, `priority:p0`
- **참조:** `research/13-redesign/02` §2 Wave 1

#### MOMO-317 · Local gate Wave 2: BuildKit cache mount + worktree 공유 Swift 빌드 캐시
- **마일스톤:** M1 · **에픽:** EP-OPS · **플랫폼:** ci · **추정:** M
- **deps:** MOMO-316
- **수용기준:**
  - [ ] [infra] `infra/prod/docker/swift-service.Dockerfile`에 BuildKit `--mount=type=cache` + Package.resolved 레이어 분리, `host-runtime` 2회차 run 빌드 시간 단축 evidence
  - [ ] [infra] `.conductor/setup.sh`가 패키지별 공유 빌드 캐시(`--scratch-path`+flock)를 제공하고 브랜치 간 dirty state 누출이 없음을 검증
  - [ ] [runtime] `scripts/local_gate.sh --profile host-runtime` PASS(웜 캐시/콜드 캐시 각 1회)
- **라벨:** `type:infra`, `area:ops`, `priority:p1`
- **참조:** `research/13-redesign/02` §2 Wave 2

#### MOMO-318 · 디자인 pre-flight를 swift 프로파일에 연결 + snapshot testing 도입
- **마일스톤:** M1/M3 준비 · **에픽:** EP-DESIGN-SYSTEM · **플랫폼:** ci · **추정:** S
- **deps:** — (baseline)
- **수용기준:**
  - [ ] [infra] `.claude/skills/momo-design-taste/SKILL.md` §5의 mechanical pre-flight grep(raw Color/Font.custom/fixed size/em-dash)을 `local_gate --profile swift`에 위반=FAIL로 연결(토큰 정의 파일 제외 규칙 포함)
  - [ ] [swift] `swift-snapshot-testing`을 clients/macOS Tests에 추가하고 대표 surface 1개(MessageBubble)의 light/dark 스냅샷이 결정론적으로 통과
  - [ ] [infra] design-review 에이전트 리포트(Blocker 0)를 UI PR evidence 항목으로 `docs/LOCAL_PR_GATE.md`에 명문화
- **라벨:** `type:infra`, `area:macos`, `priority:p1`
- **참조:** `research/13-redesign/02` §3

#### MOMO-319 · Local gate Wave 3: runtime-db verifier 부분 병렬화 + 웜 볼륨 opt-in
- **마일스톤:** M1 · **에픽:** EP-OPS · **플랫폼:** ci · **추정:** M
- **deps:** MOMO-317
- **수용기준:**
  - [ ] [runtime] `runtime-db`의 독립 verifier 3개(rls/roster/channels) 병렬 실행 + 결과 동일성 evidence
  - [ ] [infra] `--reuse-volumes` opt-in(alpha/internal-alpha 게이트 제외, CI/fresh 기본 유지)
- **라벨:** `type:infra`, `area:ops`, `priority:p2`
- **참조:** `research/13-redesign/02` §2 Wave 3

#### Phase 1 — P0 코어 (M1/M3)

#### MOMO-300 · Realtime subscribe proxy 인증 + token revocation + rate limit
- **마일스톤:** M1 · **에픽:** EP-SEC-CORE · **플랫폼:** backend · **추정:** M
- **deps:** — (baseline)
- **수용기준:**
  - [ ] [runtime] Centrifugo subscribe proxy 요청을 공유 시크릿/HMAC으로 검증(현 CentrifugoRoutes TODO 해소), 미인증 요청 거부 evidence
  - [ ] [runtime] 모든 인증 경로가 `token.revoked_at`을 검사하고, logout 엔드포인트가 revoke를 기록(revoked token 접근 거부 evidence)
  - [ ] [runtime] per-member/per-IP rate limit 미들웨어(한도 초과 429 + audit_log 기록), 비용 브레이커와 독립 동작
  - [ ] [swift] 전 패키지 build/test green, `runtime-db` gate PASS
- **라벨:** `type:feat`, `area:server`, `priority:p0`
- **참조:** `research/13-redesign/01` Track F 1~3

#### MOMO-301 · agent_run depth/round 스키마 + 루프가드 G1~G4 실쿼리
- **마일스톤:** M1 · **에픽:** EP-AGENT-RUNTIME · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-160
- **수용기준:**
  - [ ] [sql] 신규 마이그레이션으로 `agent_run`에 `depth`/`round_count`/`consecutive_auto_count` 추가(schema_v0.sql 불변, RLS DO-block 등록 확인) — L4 §3.4의 depth≤4/round≤4를 저장 가능하게
  - [ ] [runtime] LoopGuards G1(동시성)/G2(연속자동)/G3(스텝캡)/G4(depth)를 스텁에서 실제 Postgres 쿼리로 교체, 각 게이트 트립 시 audit_log evidence
  - [ ] [runtime] `runtime-agent` gate에 게이트 트립 시나리오 1개 이상 포함
- **라벨:** `type:feat`, `area:worker`, `area:schema`, `priority:p0`
- **참조:** `research/13-redesign/01` P5·Track C-7, 경험 A(05)

#### MOMO-302 · 컨텍스트 조립 v1: 단일 메시지 → 대화 히스토리/토큰 예산 윈도
- **마일스톤:** M1 · **에픽:** EP-AGENT-RUNTIME · **플랫폼:** backend · **추정:** M
- **deps:** — (baseline; MOMO-151 스펙 참조)
- **수용기준:**
  - [ ] [runtime] AgentWorker hermes 호출이 트리거 메시지 1개 대신 same-channel recent-N(스레드 우선) 메시지를 role 매핑해 전달, 토큰 예산 상한 내 슬라이딩 윈도
  - [ ] [runtime] Context Packet v0 `recent_messages` projection이 실제 히스토리를 담고 source attribution 유지
  - [ ] [runtime] `runtime-agent` gate에 "이전 메시지를 참조하는 응답" 시나리오 evidence
  - [ ] [swift] 세션 키 `(workspace, agent, channel)` 경계 준수(채널 간 컨텍스트 불혼합 테스트)
- **라벨:** `type:feat`, `area:worker`, `priority:p0`
- **참조:** `research/13-redesign/01` P3·Track C-1/2, openagents 세션 모델

#### MOMO-303 · MomoDS v0: 토큰 4층 + ugly mode + 컴포넌트 1차 추출
- **마일스톤:** M3 · **에픽:** EP-DESIGN-SYSTEM · **플랫폼:** macos · **추정:** L
- **deps:** — (baseline)
- **수용기준:**
  - [ ] [swift] `MomoCore` 또는 macOS 패키지에 토큰 레이어(Primitive/Semantic/Component/Density) — `.claude/skills/momo-design-taste/references/tokens.md` 계약과 일치, 기존 `MomoTheme` 5색을 semantic 층으로 흡수
  - [ ] [swift] 시맨틱 텍스트 롤(`.messageBody`/`.timestamp`/`.channelName`/`.agentPayloadMono`/`.costFigure`) 정의 + Dynamic Type 호환
  - [ ] [swift] ugly mode 디버그 스킴(비토큰 색 마젠타 강제)으로 기존 뷰의 하드코딩 전수 회수(pre-flight grep 0건)
  - [ ] [swift] 컴포넌트 추출 7종: Avatar/Badge/CardFrame/MessageHeader/StatusChip/IconButton/InlineBanner — 기존 surface 교체
  - [ ] [swift] Density 3단이 spacing/rowHeight 토큰을 스케일(설정 저장)
- **라벨:** `type:feat`, `area:macos`, `priority:p0`
- **참조:** `research/13-redesign/01` Track A, Slack Kit ugly mode, Discord density

#### MOMO-304 · 마크다운/코드블록 렌더 + 편집/삭제 UX + @멘션 자동완성
- **마일스톤:** M3 · **에픽:** EP-MESSENGER-CORE · **플랫폼:** macos+backend · **추정:** M
- **deps:** MOMO-303(토큰 레이어 슬라이스)
- **수용기준:**
  - [ ] [swift] message body를 AttributedString 기반 마크다운으로 렌더(굵게/기울임/링크/인라인코드/코드블록 monospace), 에이전트 응답 마크다운이 올바르게 표시
  - [ ] [runtime] 편집/삭제 REST 라우트 노출 + macOS 컨텍스트 메뉴(편집/삭제) + edited 배지 + soft-delete placeholder, realtime `messageEdited/Deleted` 반영
  - [ ] [swift] 컴포저 `@` 입력 시 roster 기반 자동완성 팝업(사람+에이전트, 키보드 탐색), 기존 insertMention 대체
  - [ ] [runtime] `macos-ui` gate에 마크다운/편집/멘션 fixture evidence
- **라벨:** `type:feat`, `area:macos`, `area:server`, `priority:p0`
- **참조:** `research/13-redesign/01` Track B 1·7·8

#### Phase 2 — P1 확장 (M2/M3)

#### MOMO-305 · 스레드 UI(에이전트 세션 경계 겸용) + unread 마커 + 로컬 알림
- **마일스톤:** M3 · **에픽:** EP-MESSENGER-CORE · **플랫폼:** macos+backend · **추정:** L
- **deps:** MOMO-303, MOMO-304
- **수용기준:**
  - [ ] [runtime] thread 조회 라우트(`root_id` 기반) + 답글 작성이 `root_id/reply_to_id`를 설정, right-sidebar(inspector) 스레드 패널
  - [ ] [swift] 타임라인에 reply-to 표시 + 스레드 열기, 스레드가 에이전트 서브세션 경계로 동작(MOMO-302 연계)
  - [ ] [runtime] `read_state` 기반 채널 unread 배지 + jump-to-first-unread
  - [ ] [swift] UNUserNotificationCenter 로컬 알림(멘션/DM/승인 요청) + 알림 클릭 시 해당 채널 이동
- **라벨:** `type:feat`, `area:macos`, `area:server`, `priority:p1`
- **참조:** `research/13-redesign/01` Track B 2·3

#### MOMO-306 · 검색 라우트 + Cmd+K 커맨드 팔레트 + 리액션
- **마일스톤:** M3 · **에픽:** EP-MESSENGER-CORE · **플랫폼:** macos+backend · **추정:** M
- **deps:** MOMO-303
- **수용기준:**
  - [ ] [runtime] 메시지 검색 REST(pg_trgm+FTS, workspace/channel 필터, RLS 경계) + 한국어 결과 evidence
  - [ ] [swift] Cmd+K 팔레트: 채널 점프 + 메시지 검색 결과 + 결과 클릭 시 해당 seq로 스크롤
  - [ ] [runtime] 리액션 add/remove 라우트 + 이모지 피커 + 메시지 하단 리액션 표시(뷰모델의 reaction 이벤트 무시 해제)
  - [ ] [swift] 단축키 체계 1차(Cmd+K/Cmd+N/↑최근 메시지 편집)
- **라벨:** `type:feat`, `area:macos`, `area:server`, `priority:p1`
- **참조:** `research/13-redesign/01` Track B 4·5·9

#### MOMO-307 · Context Broker 서버 서비스 (Context Packet v0 실조립)
- **마일스톤:** M2 · **에픽:** EP-CONTEXT · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-302, MOMO-120
- **수용기준:**
  - [ ] [runtime] mention→agent_job 경로에서 Context Packet을 스텁이 아닌 실제로 조립: recent_messages(MOMO-302), 권한 스냅샷, source refs, tool_grants(하드코딩 mock 제거), budget, redaction policy
  - [ ] [runtime] fixture(`research/11-agent-runtime/fixtures/context-packet-v0/`)와 shape 정합 테스트
  - [ ] [runtime] Broker 결정(포함/제외/redaction)이 audit 가능하게 기록
- **라벨:** `type:feat`, `area:server`, `priority:p1`
- **참조:** `research/10-local-ai-protocol-trust/01`, `research/13-redesign/01` P3·Track C-2

#### MOMO-308 · Inbound MCP 실구현 (JSON-RPC) + scope 발급
- **마일스톤:** M2 · **에픽:** EP-AGENT-PROTOCOL · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-172
- **수용기준:**
  - [ ] [runtime] MCP 표준 JSON-RPC 전송으로 교체(HTTP-shape 스텁 제거), 4개 도구(search_messages/fetch_thread/post_message/create_tool_call) 실동작 — post/create는 정본 쓰기경로(단일 tx) 재사용
  - [ ] [runtime] `mcp.*` scope 발급 플로우(admin install/token provisioning) + RLS/멤버십 preflight 유지
  - [ ] [runtime] 외부 MCP 클라이언트(예: Claude Code) 접속 smoke evidence(로컬)
- **라벨:** `type:feat`, `area:server`, `priority:p1`
- **참조:** `research/11-agent-runtime/09`, `research/13-redesign/01` Track C-3

#### MOMO-309 · BYOK: workspace provider_config + 봉투 암호화 + Settings UI
- **마일스톤:** M2 · **에픽:** EP-SEC-CORE · **플랫폼:** backend+macos · **추정:** M
- **deps:** MOMO-227
- **수용기준:**
  - [ ] [sql] 신규 마이그레이션 `provider_config`(workspace 단위, agent 단위 override): base_url/model/암호화 key(age/KMS 봉투, 평문 컬럼 금지), RLS 등록
  - [ ] [runtime] AgentWorker가 글로벌 env 대신 workspace provider_config를 resolve(env는 fallback), key 회전 audit_log
  - [ ] [swift] macOS Settings > AI Providers surface(키 마스킹, 검증 버튼), ADR-0004 경계 유지(Codex OAuth 토큰 비보관)
  - [ ] [runtime] `/v1/agent-runtime/status`가 workspace별 provider mode를 redacted 반영
- **라벨:** `type:feat`, `area:server`, `area:macos`, `priority:p1`
- **참조:** `research/13-redesign/01` Track C-6, ADR-0004

#### MOMO-310 · RAG 파이프라인: pgvector + 임베딩 워커 + RRF 하이브리드 + Memory Plane v0 구현
- **마일스톤:** M2 · **에픽:** EP-CONTEXT · **플랫폼:** backend · **추정:** L
- **deps:** MOMO-302, MOMO-121
- **수용기준:**
  - [ ] [sql] pgvector ≥0.8.4 확장 + `halfvec` HNSW 인덱스 마이그레이션(workspace/channel 필터 컬럼 포함, RLS 등록)
  - [ ] [runtime] 임베딩 워커(서버측 단일 모델) — 메시지/문서 청크 인덱싱, 삭제 tombstone 반영
  - [ ] [runtime] RRF 하이브리드 검색 함수(vector+FTS+pg_trgm) + 한국어 쿼리 evidence, Context Broker(MOMO-307)가 retrieval 소비
  - [ ] [runtime] Memory Plane v0 구현: typed memory 쓰기/조회 + retrieval-time 권한 체크(fixture 정합)
- **라벨:** `type:feat`, `area:server`, `area:schema`, `priority:p1`
- **참조:** `research/11-agent-runtime/05`, `research/13-redesign/01` Track D

#### MOMO-320 · AttachmentStore + Google Drive workspace archive 모드 + resumable 업로드
- **마일스톤:** M2/M3 · **에픽:** EP-GWORKSPACE · **플랫폼:** backend+macos · **추정:** L
- **deps:** MOMO-122, MOMO-323
- **수용기준:**
  - [ ] [swift] `AttachmentStore` 프로토콜(backend: drive | local-volume, v0=drive) + `file` 테이블 확장(drive_file_id/head_revision_id/web_view_link)
  - [ ] [runtime] workspace archive 모드: 공유 드라이브 프로비저닝 + SA `shared_drive_member`(Content Manager) — DWD 아님, MOMO-123 boundary 확장
  - [ ] [runtime] 서버가 resumable 세션 발급 → 클라 직접 청크 PUT(파일 바이트 서버 비경유), 업로더 grant 우선/SA fallback
  - [ ] [swift] macOS 첨부 UI: 파일 선택/드래그&드롭 업로드 + webViewLink 프리뷰 카드 + thumbnailLink 서버 프록시(비저장)
  - [ ] [runtime] 비공개 채널 첨부는 공유 드라이브 제외(개인 Drive `drive.file`) 경계 검증
- **라벨:** `type:feat`, `area:server`, `area:macos`, `priority:p1`
- **참조:** `research/13-redesign/03` §2~3

#### MOMO-321 · Drive changes.list 폴러 + 추출/청크 인덱싱 → pgvector
- **마일스톤:** M2/M3 · **에픽:** EP-GWORKSPACE · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-320, MOMO-310
- **수용기준:**
  - [ ] [runtime] workspace당 changes.list 폴러(SA credential, driveId 필터, start_page_token cursor — MOMO-122 sync_state 재사용), 1~5분 주기
  - [ ] [runtime] files.export(>10MB는 exportLinks 우회)/files.get 추출 → 청크 → MOMO-310 파이프라인 인덱싱, 벡터 행에 permission snapshot version
  - [ ] [runtime] 삭제/권한상실 tombstone → 벡터 삭제 + Memory Plane revalidation 큐 evidence
  - [ ] [runtime] Drive API `fullText contains` 한국어 실측 결과 기록(recall 폴백 채택/기각 판정)
- **라벨:** `type:feat`, `area:server`, `priority:p1`
- **참조:** `research/13-redesign/03` §4.1

#### MOMO-323 · GWS 스펙 정정 3건 + Internal consent 셋업 런북
- **마일스톤:** M2 · **에픽:** EP-GWORKSPACE · **플랫폼:** shared · **추정:** S
- **deps:** — (문서만)
- **수용기준:**
  - [ ] [infra] MOMO-122 스펙 정정: `drive.metadata.readonly`=restricted-class 명기 + Internal consent 전제
  - [ ] [infra] "no full Drive mirrors" 규칙에 momo 관리 공유 드라이브 한정 revocable 파생 인덱스 허용 명시
  - [ ] [infra] MOMO-123 `service_account_boundary`에 `boundary_kind: shared_drive_member` 추가
  - [ ] [infra] `docs/`에 배포 조직용 GCP 프로젝트/Internal consent/SA 생성 런북(`[manual]` 단계 표기)
- **라벨:** `type:spec`, `area:docs`, `priority:p1`
- **참조:** `research/13-redesign/03` §5

#### Phase 3 — P2 마감 (M3+)

#### MOMO-311 · FoundationModels 컨텍스트 압축(클라우드 호출 전) + 스레드 제목/알림 트리아지
- **마일스톤:** M3 · **에픽:** EP-AGENT-PROTOCOL · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-131, MOMO-305
- **수용기준:**
  - [ ] [swift] LocalContextCopilot 확장: 클라우드 LLM 호출 전 로컬 히스토리 요약 압축(TN3193 transcript-compaction 패턴, 4k/한국어 예산 준수), 미지원 OS deterministic fallback green
  - [ ] [swift] 스레드 제목 `@Generable` 원샷 생성 + 알림 urgency 분류 enum
  - [ ] [swift] 온디바이스/서버 라우팅 결정이 UI에 표시(기존 route badge 확장)
- **라벨:** `type:feat`, `area:macos`, `priority:p2`
- **참조:** `research/13-redesign/01` Track D, `research/10-local-ai-protocol-trust/01`

#### MOMO-312 · 음성 입력: SpeechTranscriber push-to-talk + 한국어 자체 평가
- **마일스톤:** M3 · **에픽:** EP-MESSENGER-CORE · **플랫폼:** macos · **추정:** M
- **deps:** MOMO-303
- **수용기준:**
  - [ ] [swift] SpeechAnalyzer+SpeechTranscriber(`ko_KR`) hold-to-record: volatile 라이브 캡션 → finalized 텍스트 컴포저 삽입(자동 전송 아님), 마이크 권한/AssetInventory 처리
  - [ ] [swift] 구 macOS SFSpeechRecognizer fallback + 미지원 시 버튼 숨김
  - [ ] [manual] 팀 음성 샘플 한국어 WER 자체 평가 1회 기록(채택 판정)
- **라벨:** `type:feat`, `area:macos`, `priority:p2`
- **참조:** `research/13-redesign/01` Track E

#### MOMO-313 · A2A Agent Card + agents/announce 초대 플로우
- **마일스톤:** M3 · **에픽:** EP-AGENT-PROTOCOL · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-308
- **수용기준:**
  - [ ] [runtime] `/.well-known/agent.json` Agent Card 서빙(momo 자체 + 등록 에이전트) + `agents/announce` 등록 → member(kind=agent) 생성 → 채널 멤버십 플로우
  - [ ] [runtime] 외부 에이전트 초대 e2e smoke(mock A2A 에이전트), 기존 승인/비용/audit 경계 그대로 적용
  - [ ] [infra] `agent.partial`/`agent.status` envelope 필드를 AG-UI 어휘와 정렬(스펙 문서 + 호환 매핑표)
- **라벨:** `type:feat`, `area:server`, `priority:p2`
- **참조:** `research/13-redesign/01` Track C-4/5, openagents 단일 포트 레이아웃

#### MOMO-314 · reversibility_tier props + 승인 상태 라이프사이클 렌더 (MOMO-091 v0 선행 슬라이스)
- **마일스톤:** M3 · **에픽:** EP-AGENT-PROTOCOL · **플랫폼:** backend+macos · **추정:** M
- **deps:** MOMO-160, MOMO-303
- **수용기준:**
  - [ ] [sql] tool_call props에 `reversibility_tier`(green/amber/red) — 보상 레지스트리 본체는 MOMO-091 유지, 이 티켓은 표시/게이팅 필드만
  - [ ] [swift] 승인 카드가 상태 라이프사이클(Reviewing/Approved/Denied/Aborted/Timed-out) 칩 + reversibility 배지 렌더(Codex 문법), 인박스 필터(risk/tier)
  - [ ] [runtime] 채널 단위 에이전트 정책 2축(sandbox: read-only/workspace-write × approval: untrusted/on-request/never) 저장+게이트 연결
- **라벨:** `type:feat`, `area:macos`, `area:schema`, `priority:p2`
- **참조:** `research/13-redesign/01` Track C-7, 경험 H(05), MOMO-091

#### MOMO-315 · audit redaction 규약 + 보존 TTL + 계정 삭제 캐스케이드
- **마일스톤:** M2 · **에픽:** EP-SEC-CORE · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-300
- **수용기준:**
  - [ ] [runtime] audit_log `detail` 쓰기 경로에 시크릿 패턴 스크럽 강제(공용 redaction 헬퍼) + 회귀 테스트
  - [ ] [sql] per-workspace 보존 TTL 설정 + 백그라운드 purge 잡(신규 마이그레이션)
  - [ ] [runtime] 계정 삭제 엔드포인트: member soft-delete + 개인정보 캐스케이드(iOS 5.1.1(v) 선행 정합)
- **라벨:** `type:feat`, `area:server`, `priority:p2`
- **참조:** `research/13-redesign/01` Track F 5~6

#### MOMO-322 · 김인턴 위키 v0: 위키 문서 규약 + propose-write 승인 플로우 + 인용 강제
- **마일스톤:** M3 · **에픽:** EP-GWORKSPACE · **플랫폼:** backend · **추정:** M
- **deps:** MOMO-321
- **수용기준:**
  - [ ] [infra] 위키 문서 규약(공유 드라이브 내 Google Docs, 인덱스 페이지 + 상호링크) 스펙
  - [ ] [runtime] 에이전트 위키 편집 = approval-gated `propose` write가 채널 타임라인 카드로 노출(기존 승인 경로 재사용)
  - [ ] [runtime] 위키 응답의 모든 주장에 `source_id → webViewLink` 인용 강제, 위키 문서도 pgvector 인덱싱 확인
- **라벨:** `type:feat`, `area:server`, `priority:p2`
- **참조:** `research/13-redesign/03` §4.2

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
