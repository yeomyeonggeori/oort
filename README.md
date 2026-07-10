# momo

> AI 에이전트가 사람과 **동등한 1급 멤버**로 참여하는 자체구축 슬랙형 메신저.
> macOS 우선 + iOS, 공유 Swift 코어(`ChatBackend` / `AgentTransport`).

momo는 봇/슬래시커맨드가 아니라, presence·lifecycle·상태머신을 가진 `member`(kind=`agent`)로
에이전트가 채널에 *산다*. 승인·감사·비용·델리게이션 같은 거버넌스 객체를 별도 dev 대시보드가
아니라 **사람과 에이전트가 함께 보는 채널 타임라인 위의 1급 메시지**로 만든다.

- 정본 스펙: [`research/07-deepdive/04-self-build-l4-spec.md`](research/07-deepdive/04-self-build-l4-spec.md)
- 정본 스키마: [`schema_v0.sql`](schema_v0.sql) (PostgreSQL 18, `uuidv7()` PK, member 추상화, `channel_seq` 행카운터)
- 경험 설계(데모 타깃): [`research/07-deepdive/05-agent-native-experiences.md`](research/07-deepdive/05-agent-native-experiences.md)
- 제품 포지셔닝: [`research/12-agentic-work-os/03-agent-host-positioning.md`](research/12-agentic-work-os/03-agent-host-positioning.md)
- 빌드 티켓: [`BUILD_TICKETS.md`](BUILD_TICKETS.md)

**협업 파이프라인 (역할별 진입점):**
- 기획 세션(Fable/GPT 5.6/사람) → [`docs/planning/README.md`](docs/planning/README.md) — ADR 기안·승인 → 빌드 계약 → 버전 고정 handoff → Issue → 병렬 구현(최대 5) → 코드리뷰·순차 머지 → 이탈 환류
- 압축/세션 전환 후 현재 상태 → [`docs/planning/CURRENT_STATE.md`](docs/planning/CURRENT_STATE.md) 또는 `scripts/planning_context.sh`
- 구현 세션(Codex worker) → [`AGENTS.md`](AGENTS.md) — goal(=GitHub Issue) 자율 실행 계약
- 결정 정본 [`docs/adr/`](docs/adr/) · 아키텍처 정본 [`docs/architecture/overview.md`](docs/architecture/overview.md) · UX 원칙 [`docs/ux-bible/README.md`](docs/ux-bible/README.md)

---

## 제품 포지셔닝

**momo turns team channels into agent execution ledgers.**

momo is a self-hosted Slack-like workspace for agentic work. The key difference is that the channel timeline is the execution ledger: agents are first-class members, tool calls and approvals are visible messages, costs are accountable, and workspace context stays governed by momo instead of disappearing into an external bot runtime.

Slack은 대화를 남기고, Paca는 작업판을 남기고, OpenHands는 코딩 에이전트 실행을 남긴다. momo는 팀 채널 자체를 사람이 승인하고 에이전트가 실행한 업무의 ledger로 만든다. 자세한 website/README/sales deck 재사용 copy는 [`Agent Host Positioning`](research/12-agentic-work-os/03-agent-host-positioning.md)에 둔다.

---

## 스택

| 컴포넌트 | 선택 |
|---|---|
| API 서버 | Swift 6.2 / **Hummingbird 2** / **PostgresNIO** / **JWTKit** / **AsyncHTTPClient** |
| Realtime fan-out | **Centrifugo v6** (transport only, DB 아님) |
| DB (SoT) | **PostgreSQL 18** (`uuidv7()` 네이티브) |
| Agent 게이트웨이 | 김인턴 hermes (OpenAI 호환 `/v1/chat/completions` + SSE) |
| 클라 Core | SwiftUI / Foundation (`ChatBackend` / `AgentTransport`) |

전 컴포넌트 permissive 라이선스(자체배포/상용 안전).

---

## 아키텍처 요약 (스펙 §1.1)

```
        ┌──────────────────────────────────────────────────────────┐
        │  Swift Clients (shared core: ChatBackend / AgentTransport) │
        │     macOS app          iOS app                            │
        └───────┬───────────────────────┬──────────────────────────┘
   WS subscribe │ (connection JWT)       │ REST: send/login (Bearer)
                ▼                         ▼
          ┌───────────┐            ┌────────────────────────────────┐
          │ Centrifugo │◀─publish──│ Hummingbird 2 API (stateless)   │
          │   v6       │  (relay)  │ REST + JWT발급 + Centrifugo      │
          │ transport  │           │ publish + subscribe proxy +      │
          │   only     │──events──▶│ agent orchestrator               │
          └───────────┘            └───────┬────────────────────────┘
                ▲                           │ tx: INSERT message
                │ POST /api/publish         │   + bump channel_seq
                │ (version=seq,             │   + INSERT outbox
                │  idempotency_key)         ▼
          ┌─────┴───────┐          ┌──────────────────────────────┐
          │ Outbox Relay │◀─claim──│ PostgreSQL 18  SOURCE OF TRUTH│
          │ SKIP LOCKED  │ (FOR    │ msg / seq / hlc / outbox /    │
          │ BYPASSRLS    │  UPDATE │ ledger / budget               │
          └─────┬───────┘  SKIP    └──────────────────────────────┘
                │ agent_job → dispatch     ▲ tx: write msg + cost ledger
                ▼                           │
          ┌──────────────────────┐         │
          │ Agent Workers (N)     │─────────┘
          │ turn serialize /      │
          │ loop guard /          │   OpenAI-compat call + SSE
          │ cost breaker          │──────────────▶ hermes gateway
          └──────────────────────┘                (tool_calls, deltas)
```

**핵심 불변식 (day-1 강제):**
1. **Postgres = SoT, Centrifugo = 전송계층(DB 아님).**
2. **쓰기 경로 단일화:** 클라는 절대 Centrifugo로 직접 publish하지 않는다.
   모든 상태변경 = `REST → PG commit → outbox → relay publish`.
3. **순서 SoT = `message.seq`** (Centrifugo offset 아님). 클라는 seq로 정렬·갭검출·복구.
4. **에이전트 = 사람과 동일 `member`** (kind=`agent`). 동일 REST/채널/멱등.
5. **commit↔publish 사이 크래시 무손실:** transactional outbox로 보장.

**v0 핵심 쓰기경로:** `REST send → (channel_seq bump + message insert + outbox insert) 단일 tx → relay publish`.

---

## 디렉터리 구조 (스펙 §9.3)

```
momo/
├─ server/                 # Hummingbird 2 API (SwiftPM, MomoServer)
│  ├─ Sources/App/{Routes,Auth,Realtime,Agents,Outbox,Cost,Push,DB}/
│  ├─ Migrations/NNN_*.sql
│  └─ Package.swift
├─ relay/OutboxRelay/      # SKIP LOCKED relay (BYPASSRLS)
├─ workers/AgentWorker/    # 잡 소비 + hermes 어댑터
├─ clients/
│  ├─ Core/                # ChatBackend / AgentTransport (shared)
│  └─ macOS/               # MomoMac SwiftUI
├─ infra/                  # docker-compose.yml, centrifugo.json
├─ adapters/hermes/        # 김인턴 플러그인 (MomoAdapter)
├─ scripts/                # migrate.sh 등
└─ schema_v0.sql           # 정본 스키마 (PostgreSQL 18)
```

---

## 빌드 안내

### 사전 요구

- **Swift 6.2** (`.swift-version` = `6.2`). 로컬 검증: `swift --version`.
- **PostgreSQL 18** + **Centrifugo v6** — 런타임 전용. v0 개발은 `docker compose`로 기동(`infra/`).

> **툴체인 현실:** 이 리포는 Swift 패키지를 `swift build`로 컴파일 검증하고,
> Docker Desktop + PostgreSQL 18 client가 있으면 DB/실시간 런타임까지 검증한다.
> hermes SSE 경로는 실제 hermes 또는 OpenAI-compatible mock이 필요하다.
> 로컬 기동 절차(환경변수 · `make up` → migrate → 서버/relay/worker → macOS)는
> [`docs/RUN.md`](docs/RUN.md) 참고.

### 자주 쓰는 명령 (Makefile)

| 타깃 | 설명 |
|---|---|
| `make build` | 모든 Swift 패키지 빌드 (Core / server / relay / worker / macOS) |
| `make migrate` | `scripts/migrate.sh`로 `server/Migrations/*.sql` 번호순 적용 (psql 필요) |
| `make up` | `infra/docker-compose.yml`로 PostgreSQL 18 + Centrifugo v6 기동 |
| `make down` | 인프라 중지 |
| `make test` | 모든 Swift 패키지 테스트 |

### 빠른 시작

```sh
cp infra/.env.example .env      # 환경변수 채우기 (T02에서 생성)
make up                         # PG18 + Centrifugo v6 기동
make migrate                    # 스키마 + 데모 시드 적용
make build                      # Swift 패키지 빌드
```

---

## v0 데모 타깃

**D Live Tool-Call** · **B 비용 호흡** · **C 승인 인박스** — 추가 프리미티브 0으로
스펙 §9.2 위에서 성립. 상세는 [`BUILD_TICKETS.md`](BUILD_TICKETS.md) 및 경험 설계 문서 §3 참고.

---

## 정식 릴리스 로드맵

> **목표:** macOS 데스크탑 **Developer ID 공증 다운로드**(notarytool/DMG/Sparkle) + iOS **App Store 정식 출시**(업로드/심사/배포) 전 과정.
> **불변식 🔒:** 스토어/공증 배포(M8, external TestFlight 포함)는 **사용성 검수 게이트(M7)가 PASS** 된 후에만 진행한다. 게이트 PASS + [`docs/cicd/03-store-readiness-gate.md`](docs/cicd/03-store-readiness-gate.md) 상단 PASS 블록 기록 전에는 `release-*.yml`을 트리거하지 않는다.
> **실행 주체:** 계획은 릴리스 PM, 실제 구현은 **Codex가 goal(=GitHub Issue)로 자율 실행**.

### 마일스톤 backbone (M0 → M8)

| M | 이름 | 트랙 | 종료 기준(요약) |
|---|---|---|---|
| **M0** | Foundation | ⚙️ | **✅ 완료** — 5개 Swift 패키지 `swift build` green + 정본 스키마/인프라/마이그레이션 정합 (Phase 0 baseline) |
| **M1** | Backend 런타임 + 배포(staging) | ⚙️ | G-0 런타임 e2e PASS + staging URL 헬스 green/TLS |
| **M2** | 멀티팀 온보딩 | ⚙️ | 3개+ 팀(10인=1팀) 격리 + 고유 초대코드 자가가입 e2e + 플랫폼 관리자 전역 조회 |
| **M3** | 데스크탑 v0 UX (D/B/C 실데이터) | 🖥 | D/B/C 3경험이 staging 실데이터로 동작 |
| **M4** | 데스크탑 패키징 | 🖥 | 공증 `.dmg` 타 맥 Gatekeeper 통과 + Sparkle 업데이트 1회 |
| **M5** | iOS 앱 | 📱 | 실기기 로그인→채널→메시지→에이전트 응답 + 멀티팀 자가가입 |
| **M6** | CI/CD | ⚙️ | CI green + release 워크플로우 dry-run(게이트 전 미트리거) |
| **M7** | QA · 사용성 검수 게이트 🔒 | ⚙️ | **G-0~G-G 전부 PASS + 증거 + 03 PASS 블록 기록** (스토어 제출 차단 게이트) |
| **M8** | 스토어 제출 (App Store + Developer ID) | 🖥📱 | App Store 승인·배포 + 공증 DMG 공개 + Sparkle 라이브 (M7 PASS 후에만) |

> **현재 위치 = M0 완료, M1 일부 완료.** MOMO-001(server health/seq gapless)과 MOMO-002(outbox relay→Centrifugo publish/history)는 Docker Desktop 기준 검증됨. 다음 닫을 차례 = **M1의 RLS/hermes/staging 잔여**. 임계 경로: 모바일 `M0→M1→M2→M5→M7→M8`, 데스크탑 `M0→M1→M3→M4→M7→M8`. 후속(출시 후): v1 프리미티브 P1~P6.

### 릴리스 문서 지도

| 문서 | 역할 |
|---|---|
| [`ROADMAP.md`](ROADMAP.md) | **마일스톤 backbone 정본** — M0~M8 의존/게이트/비용 |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | **티켓 정본**(MOMO-NNN, 41티켓/14에픽) — GitHub 이슈로 그대로 변환 |
| [`docs/RELEASE_PLAYBOOK.md`](docs/RELEASE_PLAYBOOK.md) | 데스크탑 공증 + iOS App Store + CI/CD **실행 마스터 체크리스트** + 비용/기간/gotcha |
| [`docs/QA_GATE.md`](docs/QA_GATE.md) | M7 검수 게이트 **단일 진입점**(G-0~G-G + 베타 + GO 판정) |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | 백엔드 멀티팀 운영 배포(staging→prod, Caddy/SOPS/pgBackRest) |
| [`STATUS.md`](STATUS.md) | 현재 빌드/검증 상태(작업 후 갱신) |
| [`CODEX.md`](CODEX.md) / [`AGENTS.md`](AGENTS.md) | Codex 자율실행 가이드 / 운영 계약(AGENTS가 우선) |
| [`scripts/github_bootstrap.sh`](scripts/github_bootstrap.sh) | 라벨·마일스톤·시드 이슈 일괄 부트스트랩(BACKLOG 정합, 멱등) |
| [`docs/INDEX.md`](docs/INDEX.md) | **전 문서 지도**(이 표 포함 전체 색인) |

> 전체 문서 색인(스펙·법무·CI/CD·research 포함)은 [`docs/INDEX.md`](docs/INDEX.md).
