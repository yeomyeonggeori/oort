# CODEX.md — momo (Codex 자율실행 가이드)

> **이 파일 하나만 읽으면 Codex가 momo 리포에서 바로 착수할 수 있다.** (`AGENTS.md`와 핵심 내용 동일 — `AGENTS.md`는 Codex 런타임이 자동 머지하는 정식 진입점, 이 `CODEX.md`는 사람·도구가 직접 읽는 풀 가이드. 둘이 어긋나면 `AGENTS.md`가 우선.)
>
> **실행 주체:** 계획(마일스톤/티켓)은 릴리스 PM이 세우고, **실제 구현은 Codex가 goal(= GitHub Issue)로 자율 실행**한다.
> **현재 위치:** Phase 0 = 5개 Swift 패키지 `swift build` green. Docker Desktop/psql 기반 M1 런타임 검증을 진행 중이며, hermes 필요 경로는 실제 hermes 또는 mock OpenAI-compatible gateway가 필요하다.
> **사실 표기 규칙:** `(검증됨)` = 공식문서/리포 교차확인 · `(추정)` = 설계/일정 판단 · `runtime-unverified` = 해당 goal에서 아직 e2e를 못 닫은 것. **법무 관련 텍스트는 법률 자문이 아님.**

---

## 0. 제품 1줄

momo = AI 에이전트가 사람과 **동등한 1급 멤버**(`member.kind='agent'`)로 참여하는 자체구축 슬랙형 메신저. macOS 우선 + iOS, 공유 Swift 코어(`MomoCore`). 백엔드 **Hummingbird 2 + Centrifugo v6 + PostgreSQL 18**. 에이전트 게이트웨이 = 김인턴/hermes(OpenAI 호환 `/v1/chat/completions` + SSE). 전 의존성 **permissive(Apache/MIT)** 타깃.

**핵심 쓰기경로(절대 깨지 말 것):**
`REST send → (channel_seq bump + message INSERT + outbox INSERT) 단일 트랜잭션 → OutboxRelay가 Centrifugo /api/publish`.
클라는 **절대 Centrifugo로 직접 publish하지 않는다.** Postgres = Source of Truth, Centrifugo = 전송계층(DB 아님). 순서 SoT = `message.seq`.

---

## 0.1 표준 작업 루프

1. 모든 작업은 **Issue + Milestone + Project** 기준으로 시작한다. 필요하면 작업 전 이슈/마일스톤/프로젝트 상태를 정리한다.
2. 이슈를 claim한 뒤 가능하면 worktree에서 진행한다. `scripts/goal_claim.sh` 같은 운영 스크립트가 있으면 우선 사용하고, 없으면 수동 branch/worktree로 같은 계약을 지킨다.
3. 작업 전 `STATUS.md` → `ROADMAP.md` → `BUILD_TICKETS.md` → 이슈 본문 순으로 계획을 확인한다. 계획이 미흡하면 추가 리서치를 하고, 계획이 충분하면 현재 사실을 검증한다.
4. 구현은 이슈 범위에 맞춘다. 범위가 커지면 새 이슈로 제안한다.
5. 구현 후 해당 검증 등급의 테스트를 실행한다. GitHub Actions disabled/manual-only 기간에는 `scripts/local_gate.sh --profile ...`를 우선 사용하고, Swift 변경은 `make build`/`make test`를 하드 게이트로 본다.
6. 커밋하고 push한 뒤 PR을 연다. PR은 해당 이슈 하나만 닫는다.
7. PR 이후 코드리뷰 에이전트 또는 리뷰 스킬로 보안·코드 품질·회귀 위험을 점검하고, 발견 사항을 반영한다.
8. 리뷰 반영 후 최종 테스트를 다시 실행한다. 문제가 없고 현재 gate가 통과하면 merge한다.
9. GitHub Actions disabled/manual-only 기간에는 `scripts/local_gate.sh`가 출력한 local evidence를 primary merge gate로 쓰고, merge 후 workflow가 계속 `disabled_manually`인지 확인한다. Actions를 다시 주 gate로 켠 기간에만 main GitHub Actions green을 확인한다.
10. 최종 보고에는 이번 작업 결과, 검증, 로드맵 영향, 새로 알게 된 리스크/자료, 다음 goal 추천을 포함한다.

---

## 1. 리포 맵 + 책임

```
schema_v0.sql            정본 스키마(PostgreSQL 18, uuidv7() PK, RLS FORCE) — 읽기 전용. 이동/수정 금지.
STATUS.md                현재 빌드/검증 상태 — 작업 후 반드시 갱신.
ROADMAP.md               M0→M8 릴리스 backbone(정본). 마일스톤/의존/게이트/비용.
BUILD_TICKETS.md         Phase 0 + v0 데모 의존순 빌드 백로그 + 수용기준 등급 정의.
AGENTS.md                Codex 자동 머지 운영 계약(이 파일의 핵심과 동일).
CODEX.md                 (이 파일) Codex 자율실행 풀 가이드.
NOTICE                   Apache 2.0 귀속 — 앱 화면 표기 대상.

clients/Core/            MomoCore: 공유 모델 + ChatBackend/AgentTransport 프로토콜. 외부의존 0(순수 Foundation). 모델 단일 진실원천.
clients/macOS/           MomoMac: SwiftUI 뷰(D Live Tool-Call / B 비용 호흡 링 / C 승인 인박스) + MomoMacSmoke 실행. ※ 아직 SwiftPM 라이브러리 — .app 아님(M4에서 Xcode 프로젝트화).
clients/iOS/             (아직 없음) M5에서 MomoiOS.xcodeproj 생성.

server/                  MomoServer(Hummingbird 2). PostgresNIO + JWTKit + AsyncHTTPClient.
  Sources/MomoServer/    Main/App/Config/AppRequestContext · DB/Database.swift(PostgresClient 풀)
    Auth/                JWT.swift · AuthMiddleware.swift
    Realtime/            CentrifugoClient.swift
    Routes/              Message/Auth/Centrifugo/DTOs — 핵심 쓰기경로(seq+outbox tx)가 여기.
  Migrations/            001_init.sql(schema_v0 정본 복사) · 002_seed.sql(데모 시드). 신규는 003_*.sql 번호순.

relay/OutboxRelay/       outbox SKIP LOCKED 폴링 → Centrifugo publish. BYPASSRLS 역할.
workers/AgentWorker/     agent_job 클레임 → hermes OpenAI-compat SSE → message PATCH 스트리밍. LoopGuards · CostAccounting. BYPASSRLS 역할.
adapters/hermes/         momo_adapter.py(BasePlatformAdapter) + plugin.yaml. py3 only.

infra/                   docker-compose.yml(PG18 + Centrifugo v6 + healthcheck/volume) · centrifugo.json · .env.example. (※ infra/prod/* 는 M1에서 신규.)
scripts/                 migrate.sh · github/{bootstrap.sh, milestones.tsv, labels.tsv, issues.tsv}.
docs/                    RUN.md(기동 순서) · GITHUB_OPS.md · cicd/00~09 · legal/00~03.
legal/                   privacy-policy.md · agent-disclosure.md · THIRD_PARTY_NOTICES.md (법률 자문 아님).
.github/                 ISSUE_TEMPLATE/ · workflows/{ci-build,release-ios,release-macos}.yml.
fastlane/                Fastfile · Appfile · Matchfile. (Gemfile은 리포 루트.)
research/07-deepdive/    04=L4 정본 스펙 · 05=에이전트 네이티브 경험 설계.
research/08-distribution/ 01=macOS 배포 스펙 · 02=배포 티켓.
```

**역할별 BYPASSRLS:** OutboxRelay·AgentWorker만 전 테넌트 폴링을 위해 BYPASSRLS. **쓰기 경로엔 BYPASSRLS 금지**(읽기 추적 전용). 그 외 모든 경로는 `SET LOCAL app.workspace_id` + RLS FORCE.

---

## 2. 빌드 / 검증 명령 (copy-paste 그대로 실행)

> 로컬 툴체인: **Swift 6.2.x 있음**(`.swift-version` = 6.2). **Docker Desktop + psql 있음**, hermes 없음. PG18+Centrifugo 런타임은 검증 가능하고, hermes 필요 경로는 실제 hermes 또는 mock OpenAI-compatible gateway를 준비한다.

```bash
scripts/local_gate.sh --profile docs|swift|runtime-db|runtime-relay|runtime-agent|macos-ui|all
# Swift 패키지 (의존순: Core → server/relay/worker → macOS). 전부 green이 하드 게이트.
make build                                        # SWIFT_PKGS 중 Package.swift 있는 것만 swift build
make test                                         # 동일 패키지 swift test
# 개별 패키지(필요 시):
( cd clients/Core && swift build )                # MomoCore
( cd server && swift build )                      # MomoServer (Hummingbird 2)
( cd relay/OutboxRelay && swift build )           # OutboxRelay
( cd workers/AgentWorker && swift build )         # AgentWorker
( cd clients/macOS && swift build )               # MomoMac (lib + smoke)

# hermes 어댑터 문법 검증
python3 -m py_compile adapters/hermes/momo_adapter.py

# Xcode 앱(M4/M5에서 프로젝트 생성 후 — 무서명 컴파일 확인):
xcodebuild build -scheme MomoMac  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
xcodebuild build-for-testing -scheme MomoiOS -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO

# CI/워크플로우·fastlane 정적 검증(워크플로우는 현재 manual-only/disabled):
actionlint .github/workflows/*.yml                # YAML/액션 lint
ruby -c fastlane/Fastfile                         # Fastfile syntax

# 런타임(Docker Desktop/psql 가용):
cp infra/.env.example .env
make up                                           # postgres:18 + centrifugo:v6
make migrate                                      # 001_init → 002_seed (멱등)
( cd server && swift run )                         # MomoServer → GET /health
( cd relay/OutboxRelay && swift run )
( cd workers/AgentWorker && swift run )
```

**검증 등급(각 이슈/티켓에 명시 — BUILD_TICKETS.md·ROADMAP §7 정의 그대로):**
- `[swift]` = `swift build` green(에러 0, 경고 허용). 미완성부는 `// TODO(#이슈)` + 컴파일 보장.
- `[infra]` / `[sql]` = 파일 존재 + `schema_v0.sql`(정본)·L4 스펙과 정합. Docker/psql로 적용 가능한 범위는 runtime 검증한다.
- `[python]` = `python3 -m py_compile` 통과.
- `[xcode]` = `xcodebuild`(무서명) 산출.
- `[ci]` = 워크플로우 syntax/lint(actionlint) 통과 + (게이트 전) dry-run.
- `[runtime]` = Docker/psql로 가능한 검증은 수행한다. hermes 등 외부 의존이 필요하면 실제 의존성 또는 mock을 먼저 준비하고, 그래도 못 닫는 범위만 좁게 `runtime-unverified` 표기 + `docs/RUN.md`에 절차.
- `[manual]` = 사람 1회(발급/계약/심사). Codex는 런북/파일만 준비하고 위임 표시.

---

## 3. 컨벤션 (브랜치 / 커밋 / PR)

**브랜치 (GitHub org `Dawn-kim-official`, repo `momo`):**
- `feat/<issue#>-<slug>` · `fix/<issue#>-<slug>` · `chore/<issue#>-<slug>` · `docs/<issue#>-<slug>`.
- 티켓 id 형태가 `MOMO-NNN`이면 `feat/MOMO-NNN-<slug>`도 허용(SPINE 티켓 id 규약). **main 직접 push 금지**(브랜치 보호 가정).

**커밋:** Conventional Commits — 예) `feat(server): channel_seq 발급 트랜잭션 (#NN)`. 타입/스코프는 영문, 본문 한국어 OK.

**PR:** 1 PR = 1 이슈. 여러 이슈를 한 PR에 섞지 않는다. 머지 전 `swift build` green 필수. PR 본문은 아래 템플릿 그대로.

```
Closes #<issue>

## 한 일
- (변경 요약 bullet)

## 검증 (등급: [swift]/[infra]/[sql]/[python]/[xcode]/[ci]/[runtime]/[manual])
- [ ] `swift build` green: <패키지>
- [ ] 선행 패키지 빌드 안 깨짐
- [ ] schema_v0.sql 정합 (DDL/모델 컬럼·타입 일치)
- [ ] runtime 미검증 부분 표기

## STATUS 영향
- (STATUS.md에 반영한 줄)

## 남은 것 / 후속 이슈 제안
- (스코프 밖이라 새 이슈로 뺀 것)
```

**절대 하지 말 것:**
- 시크릿 커밋(`.env`, `.env.worktree`), `schema_v0.sql` 수정/이동, `.build/`·`*.resolved`·`DerivedData/`·`.swiftpm/` 커밋(`.gitignore` 참조).
- 무관한 리팩터 끼워넣기, 의존성 메이저 임의 변경, 다른 패키지 깨기.
- **게이트(M7) PASS 기록 전 `release-*.yml` 트리거**(§7 참조).

**Swift 네이밍/구조:** 타입 `PascalCase`, 함수/프로퍼티/let `camelCase`, enum case `camelCase`. 모델은 `MomoCore`에만 두고 다른 패키지가 import. 프로토콜 `ChatBackend`/`AgentTransport`가 클라↔서버 계약(L4 §5.3/§6.1). SwiftPM 의존은 최신 안정 태그로 resolve, `*.resolved` 비커밋. 서버 쓰기경로는 단일 트랜잭션, async/await(블로킹 금지).

---

## 4. Definition of Done (모든 이슈 공통 — 못 채우면 닫지 마라)

1. **해당 등급 검증 통과**(§2). Swift 이슈는 `swift build` green이 **하드 게이트**.
2. **선행 티켓을 깨지 않음**: 다른 패키지의 `swift build`가 여전히 green. 의존 그래프는 `BUILD_TICKETS.md` STEPS 표 + `ROADMAP.md` §2가 1차 진실.
3. **정본 정합**: DDL/모델은 `schema_v0.sql`과 컬럼·타입 일치(`member.kind`, `channel_seq` 행카운터, `uuidv7()` PK, `hlc_ts`/`hlc_count`, `client_msg_id` 멱등 등). 정본은 **이동/수정 금지** — 스키마 확장은 `server/Migrations/00N_*.sql` 신규 파일 + RLS DO-block ARRAY에 신규 테이블 등록.
4. **runtime 미검증은 정직 표기**: 파일/주석/STATUS에 `runtime-unverified`. 검증 못 한 걸 "검증됨"이라 쓰지 마라.
5. **STATUS.md 갱신**: 무엇을 추가/변경했고 무엇이 여전히 미검증인지 1~3줄.
6. **PR 본문**이 §3 템플릿.
7. **미완성 스텁**은 `// TODO(#이슈번호): 설명` 형태로만(컴파일은 항상 보장).
8. **게이트/배포 불변식 준수**: 사용성 검수 게이트(M7) PASS 기록 없이 스토어/공증 배포(M8)·external TestFlight 진행 금지(§7).

---

## 5. 다음 티켓 선택법 (자율 picker)

사람이 이슈를 지정하지 않았다면 아래 순서로 고른다. 진실 원천: **`ROADMAP.md`(마일스톤 순서·의존) → `BUILD_TICKETS.md`(빌드 STEPS) → SPINE 티켓 deps**.

1. **마일스톤 우선순위 순(M0 → M8)**: 가장 낮은 번호의 **열린/미완** 마일스톤부터. 현재 활성 = **M1**(M0 Foundation은 달성됨).
2. 그 마일스톤 안에서 **`deps`(blocked-by)가 전부 done**인 티켓만(의존 충족). 의존 미충족이면 건너뛰고 다음.
3. 그 중 **의존 깊이가 가장 얕은** 것 → 동률이면 **`priority:p0 > p1 > p2`** → 그다음 티켓 id/이슈 번호 오름차순.
4. `legal`/`manual` 티켓은 Codex가 **파일/런북만** 준비하고 실제 발급·계약·심사는 사람에게 위임(런북에 명시).
5. `[runtime]` 전용 티켓은 Docker/psql로 가능한 검증을 우선 수행하고, hermes 등 외부 의존은 설치 또는 mock 준비를 먼저 검토한다.
6. 고른 이슈를 자신에게 할당하고 `status:in-progress`로 바꾼 뒤 시작한다. 가능하면 worktree를 사용한다. 막히면(의존 미충족/정보 부족) 임의 추측 금지, 이슈에 블로커 코멘트 남기고 다음 티켓으로.

**마일스톤 한눈 backbone(정본 = ROADMAP.md):**

| M | 이름 | 핵심 | 게이트 |
|---|---|---|---|
| M0 | Foundation | 5 Swift 패키지 컴파일 + 정본 스키마/인프라/마이그레이션 정합 | **달성됨** |
| M1 | Backend 런타임 + staging 배포 | docker e2e(seq/outbox/relay/RLS/SSE/비용) + Caddy TLS/SOPS/pgBackRest/모니터링 | G-0 런타임 e2e |
| M2 | 멀티팀 온보딩 | `003_onboarding.sql`(invite_code + platform_admin) + 자가가입 + 관리자 추적 | 3+팀 격리 e2e |
| M3 | 데스크탑 v0 UX | D Live Tool-Call · B 비용 호흡 링 · C 승인 인박스 실데이터 바인딩 | staging 실접속 동작 |
| M4 | 데스크탑 패키징 | MomoMac.xcodeproj + Developer ID 서명 + notarytool 공증 + DMG + Sparkle 2 | spctl/Gatekeeper |
| M5 | iOS 앱 | MomoiOS.xcodeproj(iOS 26 SDK) + Push/APNs + 계정삭제 + UGC 4종 + PrivacyInfo | 실기기 시나리오 |
| M6 | CI/CD | fastlane(match/pilot/deliver/notarytool) + ASC API Key + Actions. 현재는 비용 방지를 위해 disabled/manual-only, release 잡은 게이트 전 dry-run만 | local gate + actionlint green |
| **M7** | **QA·사용성 검수 게이트 🔒** | G-0~G-G 전부 PASS + 증거 | **스토어 제출 차단 불변식** |
| M8 | 스토어 제출 | iOS App Store 업로드/심사/배포 + macOS 공증 DMG 공개 + Sparkle 라이브 | M7 PASS 후에만 |

> **임계 경로:** 모바일 `M0→M1→M2→M5→M7→M8`, 데스크탑 `M0→M1→M3→M4→M7→M8`. M3 이후 M4(🖥)·M5(📱)·M6(CI/CD)는 공유 코어 위에서 병렬.
> **후속(스토어 출시 후):** v1 프리미티브 P1 `branch_id` · P2 `reversibility_tier` · P3 belief · P4 `autonomy_level` · P5 `decision_ledger` · P6 scheduled trigger (EP-PRIMITIVES, v0 데모엔 불필요).

---

## 6. 설계 맥락 요약 + 읽을 곳

momo는 5개 설계축 + 3개 보강(outbox / 비용회계 / APNs)을 단일 정합 설계로 통합한 L4 스펙 위에 서 있다. 착수 전 **goal(이슈)과 관련된 곳만** 골라 읽는다.

**불변식(day-1 강제 — 코드로 절대 깨지 말 것):**
1. Postgres = SoT, Centrifugo = 전송계층(DB 아님).
2. 쓰기 경로 단일화: 클라는 Centrifugo로 직접 publish 금지. 모든 상태변경 = REST → PG commit → outbox → relay publish.
3. 순서 SoT = `message.seq`(Centrifugo offset 아님). 클라는 seq로 정렬·갭검출·복구.
4. 에이전트 = 사람과 동일 `member`(`kind='agent'`). 동일 REST/채널/멱등.
5. commit↔publish 사이 크래시 무손실 = transactional outbox.
6. seq 발급 = `channel_seq` 행카운터 `UPDATE...RETURNING`(시퀀스 금지 — 롤백 갭). `client_msg_id` 멱등 `ON CONFLICT`.
7. 멀티테넌시: `workspace → channel → membership(member)` 3계층, 모든 테넌트 행에 `workspace_id`, RLS FORCE, 트랜잭션마다 `SET LOCAL app.workspace_id`.

**읽을 곳(우선순위):**
- `STATUS.md` — **항상 먼저.** 지금 무엇이 컴파일/런타임 검증됐는지.
- `ROADMAP.md` — 마일스톤/의존/게이트/비용(정본 backbone).
- `schema_v0.sql` — 정본 DDL(24 테이블, RLS FORCE). DDL/모델 작업 전 필수.
- `research/07-deepdive/04-self-build-l4-spec.md` — L4 정본 스펙(아키텍처·스키마·쓰기경로·outbox·비용회계·APNs).
- `research/07-deepdive/05-agent-native-experiences.md` — D/B/C 등 에이전트 네이티브 경험 설계(macOS UX 작업 시).
- `BUILD_TICKETS.md` — Phase 0 + v0 데모 빌드 STEPS·수용기준 등급.
- `docs/cicd/05-qa-release-gate.md` — **게이트(M7) 객관 통과기준 정본**(G-0~G-G).
- `docs/cicd/03-store-readiness-gate.md` — 게이트 PASS 블록 기록 위치.
- `docs/cicd/00~04` — Apple CI/CD 파이프라인·setup 런북·시크릿 인벤토리·Codex 티켓.
- `docs/RUN.md` — 기동/마이그레이션/롤백 절차. `legal/*`·`docs/legal/*` — 법무 선결(법률 자문 아님).

---

## 7. 런타임 미검증 · 게이트 · 라이선스 규칙

**런타임 미검증:**
- Docker/psql로 가능한 PG18+Centrifugo 검증은 각 M1 goal에서 실제 수행한다.
- hermes, APNs, Apple 배포 등 외부 의존이 남으면 실제 의존성 또는 mock 준비를 먼저 검토하고, 그래도 못 닫는 범위만 좁게 `runtime-unverified` 표기 + `docs/RUN.md`에 절차를 남긴다.

**🔒 게이트 불변식(스토어/공증 배포 차단):**
- 스토어/공증 배포(M8) 및 **external TestFlight**는 **사용성 검수 게이트(M7)가 PASS 된 후에만** 진행한다.
- 통과 조건: `docs/cicd/05-qa-release-gate.md`의 **G-0~G-G 전부 PASS + 증거 첨부** → `docs/cicd/03-store-readiness-gate.md` 상단에 **PASS 블록(날짜 + 커밋 해시 + 빌드# + 증거 링크)** 기록 → `STATUS.md` 게이트 상태 OPEN→PASS 갱신.
- **기록 없는 release = 규칙 위반.** 게이트 PASS 전에는 `release-ios.yml`/`release-macos.yml`을 트리거하지 않는다. 현재 GitHub Actions는 비용 방지를 위해 disabled/manual-only이며, owner approval 전에는 재활성/수동 실행하지 않는다.

**permissive 라이선스 규칙:**
- 전 의존성을 **permissive(Apache-2.0 / MIT / PostgreSQL License)** 로 유지. 확정 스택: Hummingbird 2(Apache-2.0), Centrifugo v6(Apache-2.0), PostgreSQL 18(PostgreSQL License), SwiftCentrifuge(MIT), APNSwift(Apache-2.0). **비-permissive(GPL/AGPL/상용 제약) 의존 추가 금지.**
- 새 의존 추가 시 라이선스 확인 + `legal/THIRD_PARTY_NOTICES.md`(및 `NOTICE`)에 귀속 반영.
- 외부 배포/상용 전 법무 검토 1회 필수. 법무·스토어 정책 텍스트는 **법률 자문이 아님** — 사실은 1차 출처(Apple/GitHub 공식 문서)로 표기, 추정은 `(추정)`.
