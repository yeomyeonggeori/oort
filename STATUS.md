# momo — Phase 0 빌드 STATUS

> 생성: 2026-06-24 · 빌드 워크플로우 `momo-phase0-build`(T01~T10) + 로컬 `swift build` 재검증
> 검증 환경: Swift 6.2.3 (arm64-apple-macosx), Docker Desktop 29.4.3, PostgreSQL client 18.4(`/opt/homebrew/opt/libpq/bin/psql`). **hermes 부재** → 에이전트 e2e는 미검증.

## 0. Repo Bootstrap Hardening (2026-06-24)

- Centrifugo/server 계약을 `/v1/centrifugo/subscribe` + `ch:ws<workspaceUUID>.<channelUUID>` / `agent:ws<workspaceUUID>.<agentMemberUUID>`로 정렬하고, legacy GitHub bootstrap은 guard 처리.
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build` 및 `make test` 모두 5개 Swift 패키지 green. `adapters/hermes/momo_adapter.py` py_compile, JSON/shell syntax, GitHub bootstrap dry-run 통과.
- MOMO-001 이전에는 런타임 e2e가 미검증이었으나, 현재는 아래 Runtime Gate에서 compose/migrate/server health/seq gapless까지 검증됨. RLS, relay publish, hermes SSE는 후속 M1 goal에서 확인 필요.

## 0a. MOMO-001 Runtime Gate (2026-06-25)

- `make up` pass: PostgreSQL 18 + Centrifugo v6가 `.env.worktree`의 `COMPOSE_PROJECT_NAME=momo_momo_001`, `POSTGRES_PORT=15432`, `CENT_PORT=18001`로 기동하고 Docker health가 둘 다 green.
- `make migrate` pass: `001_init.sql` + `002_seed.sql` 적용 성공, 재실행 시 `적용 0, 스킵 2`로 멱등 통과. `scripts/migrate.sh`는 keg-only Homebrew `libpq`의 `psql`도 자동 감지한다.
- MomoServer runtime pass: `PORT=18080 swift run MomoServer` 후 `GET /health` 200. `POST /v1/.../messages`가 실제 DB에 `message` + `outbox`를 쓰고 `seq=1` 반환.
- seq gapless 검증: 같은 채널에 동시 10건 송신 결과 `seq=2...11`, DB 집계 `message_count=11`, `max_seq=11`, `missing_seq=NULL`, `outbox_count=11`, `version=1...11`.
- 남은 runtime-unverified: MOMO-002(outbox relay→Centrifugo publish 왕복), MOMO-003(RLS 교차 테넌트 격리), MOMO-004(AgentWorker↔hermes SSE + 비용 reserve/reconcile).

## 1. 패키지별 빌드 상태 (로컬 `swift build` 실측)

| 패키지 | 경로 | 빌드 | 비고 |
|---|---|---|---|
| **MomoCore** | `clients/Core` | ✅ **pass** | 공유 모델 + `ChatBackend`/`AgentTransport` 프로토콜. 외부 의존 0(순수 Foundation). |
| **MomoServer** | `server` | ✅ **pass** | Hummingbird 2 + PostgresNIO + JWTKit + AsyncHTTPClient. |
| **OutboxRelay** | `relay/OutboxRelay` | ✅ **pass** | SKIP LOCKED 폴링 → Centrifugo publish. |
| **AgentWorker** | `workers/AgentWorker` | ✅ **pass** | OpenAI 호환 `/v1/chat/completions` SSE + 루프가드 스텁. |
| **MomoMac** | `clients/macOS` | ✅ **pass** | SwiftUI 라이브러리(뷰+VM) + `MomoMacSmoke` 실행 스모크. |

> ⚠️ SourceKit(IDE) 진단이 `MomoCore`의 일부 파일에 "Cannot find type …"을 표시했으나, 이는 모듈 그래프 없이 파일 단위로 분석한 **stale 경고**다. 실제 `swift build`는 5개 패키지 모두 **clean(exit 0)**.

## 2. 비-Swift 산출물 (정적 + MOMO-001 런타임 점검)

| 산출물 | 점검 | 상태 |
|---|---|---|
| `adapters/hermes/momo_adapter.py` | `python3 -m py_compile` | ✅ OK |
| `infra/centrifugo.json` | JSON 파싱 + `history_meta_ttl > history_ttl`(4 ns) | ✅ OK |
| `infra/docker-compose.yml` | YAML 파싱(postgres:18 + centrifugo:v6 + healthcheck/volume) | ✅ OK |
| `server/Migrations/001_init.sql` | 괄호 290/290 균형, schema_v0.sql 정본 복사 | ✅ OK |
| `server/Migrations/002_seed.sql` | INSERT 구조 정상(괄호 불균형은 `--`주석 내 한글 괄호 → 무해) | ✅ OK |
| `scripts/migrate.sh` | `sh -n` | ✅ OK |

> **MOMO-001에서 검증됨:** PG18+Centrifugo compose health, SQL 001/002 적용 및 멱등 재실행, MomoServer `/health`, 메시지 송신의 `channel_seq` gapless 발급과 `message`/`outbox` 기록.
> **남은 runtime-unverified:** RLS 격리, outbox relay→Centrifugo publish 왕복, hermes SSE, 비용 회계, Centrifugo 구독/presence/recovery, APNs.

## 3. 생성 파일 트리 (핵심)

```
momo/
├─ schema_v0.sql                 # 정본 스키마(24 테이블, RLS FORCE)
├─ BUILD_TICKETS.md              # 의존순 빌드 백로그 (Phase0 + v1 P1~P6)
├─ Makefile / README.md / docs/RUN.md
├─ infra/  docker-compose.yml · centrifugo.json · .env.example
├─ server/ (MomoServer, Hummingbird 2)
│   ├─ Migrations/{001_init,002_seed}.sql
│   └─ Sources/MomoServer/{Main,App,Config,AppRequestContext}.swift
│       ├─ DB/Database.swift              # PostgresClient 풀
│       ├─ Auth/{JWT,AuthMiddleware}.swift
│       ├─ Realtime/CentrifugoClient.swift
│       └─ Routes/{Message,Auth,Centrifugo,DTOs}.swift   # 핵심 쓰기경로: seq+outbox tx
├─ relay/OutboxRelay/   (SKIP LOCKED → publish)
├─ workers/AgentWorker/ (HermesTransport SSE · LoopGuards · CostAccounting · WorkerService)
├─ clients/Core/        (MomoCore: 모델 + ChatBackend/AgentTransport)
├─ clients/macOS/       (MomoMac: ChannelList/MessageList/MessageBubble/AgentPartial/
│                         CostBreathingRing/ApprovalInbox + ChatViewModel/LiveChatBackend)
├─ adapters/hermes/     (momo_adapter.py: BasePlatformAdapter · plugin.yaml)
└─ scripts/migrate.sh
```

## 4. 컴파일 검증됨 vs 런타임 미검증

- ✅ **컴파일 검증됨**: 5개 Swift 패키지 전부 `swift build` 통과 → 타입·API 계약·시그니처 정합.
- ⛔ **남은 런타임 미검증**:
  - outbox→relay→Centrifugo publish 왕복.
  - RLS 테넌트 격리.
  - AgentWorker↔hermes 게이트웨이 SSE 실연결, reserve/reconcile 비용 회계.
  - Centrifugo 구독/presence/recovery, APNs.

## 5. 남은 작업

**M1 런타임 후속:**
1. ✅ MOMO-001: docker 환경에서 `make up` → `make migrate`(001→002) → `swift run`(server) 로 헬스체크 + 메시지 송신(seq 발급) 통합 테스트 완료.
2. MOMO-002: OutboxRelay 기동 + outbox→Centrifugo publish 왕복 e2e.
3. MOMO-003: RLS 테넌트 격리 런타임 검증.
4. MOMO-004: AgentWorker↔hermes 게이트웨이(또는 OpenAI 호환 목) 연결로 김인턴 멘션→응답 1회 + 비용 reserve/reconcile.

**v0 데모(D/B/C) UI 완성:**
4. `clients/macOS`를 SwiftPM 라이브러리 → **Xcode `.app` 번들**로(현재는 라이브러리+스모크 실행만 컴파일). Live Tool-Call 카드 / Cost Breathing 링 / Approval Inbox 실데이터 바인딩.

**v1 경험 — 신규 프리미티브(05 경험 문서):**
5. P1 `branch_id`(분기 타임라인, 최대 작업) · P2 reversibility_tier · P3 belief 타입 · P4 autonomy_level · P5 TIE-BREAK decision_ledger · P6 scheduled trigger.

## 5b. QA/릴리스 게이트 (스토어 제출 선행 — 문서/티켓 추가됨, 실행 미진행)

> 추가: 2026-06-24 · "사용 가능 완전 판명" 객관 통과기준 + 베타/크래시계측/e2e·접근성·성능 게이트를 문서·시드이슈로 정의. **측정/판정은 미진행(게이트 OPEN).**

- `docs/cicd/05-qa-release-gate.md` — 게이트 정본. G-A 크래시-free(세션≥99.5/유저≥99.0%) · G-B 핵심플로우 e2e 8/8 · G-C 접근성 치명0 · G-D 성능(런치 p90<2s, hang≈0) · G-E 베타 · G-F 피드백 P0/P1 잔여0 · G-G 릴리스준비 · PASS 기록양식.
- `docs/cicd/06-beta-testflight-plan.md` — TestFlight 내부(≤100)/외부(≤10,000, 첫빌드 Beta App Review) + macOS 공증 .dmg 비공개 베타 + ASC API 피드백 수집.
- `docs/cicd/07-crash-analytics-spec.md` — Sentry Cocoa(1순위, self-host) + MetricKit(보조, 0의존). Crashlytics는 선택지.
- `docs/cicd/08-e2e-accessibility-performance.md` — XCUITest + performAccessibilityAudit(Xcode15+) + XCTMetric.
- `docs/cicd/09-qa-codex-tickets.md` — Q0~Q7 의존순 실행 티켓.
- `docs/cicd/03-store-readiness-gate.md` — G-5 객관기준 + PASS 판정을 05로 링크.
- `scripts/github/issues.tsv` — M3에 QA 시드이슈 7건 추가(gate:qa). 라벨/마일스톤 정합 검증 통과.
- ⛔ 미진행(게이트 OPEN): Sentry/MetricKit 계측 코드, XCUITest/접근성/성능 테스트, qa-gate.yml, 베타 배포·실측·PASS 기록. 선결 = M0 런타임 + C1/C2 Xcode 프로젝트.

## 6. 다음 실행 명령

```bash
# 컴파일 검증(로컬, 지금 가능)
make build                  # 또는 각 패키지에서 swift build

# 런타임(MOMO-001 검증 완료; .env.worktree 또는 .env 사용)
cp infra/.env.example .env
make up                     # postgres:18 + centrifugo:v6
make migrate                # 001_init → 002_seed
(cd server && swift run)    # MomoServer
(cd relay/OutboxRelay && swift run)
(cd workers/AgentWorker && swift run)
```

> 라이선스: 전 의존성 permissive(Apache/MIT) 타깃. 외부 배포/상용 전 법무 검토 1회 필수(L4 §10).
