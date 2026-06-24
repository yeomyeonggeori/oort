# AGENTS.md — momo (Codex 자율작업 운영 계약)

> 이 파일은 코딩 에이전트(특히 **OpenAI Codex**)가 momo 리포에서 자율 실행할 때 따르는 **단일 운영 계약**이다.
> Codex는 세션 시작 시 git root → 현재 디렉터리까지 `AGENTS.md`를 root→leaf 순으로 머지한다(leaf override). 이 파일이 root 계약이다.
> **핵심 내용은 `CODEX.md`와 동일**(CODEX.md = 사람·도구가 직접 읽는 풀 가이드). 둘이 어긋나면 이 `AGENTS.md`가 우선.
> 사람용 장문 배경은 `STATUS.md`/`ROADMAP.md`/`BUILD_TICKETS.md`/`research/07-deepdive/04·05`에. 여기엔 **에이전트가 추론으로 못 얻는 것만** 적는다.
>
> **실행 주체:** 계획(마일스톤/티켓)은 릴리스 PM, **실제 구현은 Codex가 goal(=GitHub Issue)로 자율 실행**.
> **현재 위치:** Phase 0 = 5개 Swift 패키지 `swift build` green. **런타임 미검증**(이 환경에 docker/psql/hermes 없음).
> **표기:** `(검증됨)`=교차확인 · `(추정)`=설계/일정 판단 · `runtime-unverified (no docker/psql)`=docker 없이는 못 닫음. **법무 텍스트는 법률 자문 아님.**

## 0. 제품 1줄
momo = AI 에이전트가 사람과 **동등한 1급 멤버**(`member.kind='agent'`)로 참여하는 자체구축 슬랙형 메신저. macOS 우선 + iOS, 공유 Swift 코어(`MomoCore`). 백엔드 **Hummingbird 2 + Centrifugo v6 + PostgreSQL 18**. 에이전트 게이트웨이 = 김인턴/hermes(OpenAI 호환 `/v1/chat/completions` + SSE). 전 의존성 permissive(Apache/MIT) 타깃.

**핵심 쓰기경로(절대 깨지 말 것):** `REST send → (channel_seq bump + message INSERT + outbox INSERT) 단일 tx → OutboxRelay가 Centrifugo /api/publish`. 클라는 절대 Centrifugo로 직접 publish 안 함. Postgres=SoT, Centrifugo=전송계층. 순서 SoT=`message.seq`.

## 1. 작업을 받는 법 (goal = 이슈)
- **하나의 GitHub Issue = 하나의 goal.** 이슈 본문이 작업 프롬프트. `## Goal / ## Context / ## Acceptance / ## Out of scope`가 있으면 그것이 계약.
- 다음에 집을 티켓 선택법은 §6. 임의로 스코프를 늘리지 말 것 — 이슈에 없는 것은 새 이슈로 제안.
- 1 이슈 = 1 PR. 여러 이슈를 한 PR에 섞지 않는다.

## 2. 리포 맵 (디렉터리 → 책임)
```
schema_v0.sql            정본 스키마(PostgreSQL 18, uuidv7() PK, RLS FORCE) — 읽기 전용, 이동/수정 금지
STATUS.md                현재 빌드/검증 상태 — 작업 후 갱신
ROADMAP.md               M0→M8 릴리스 backbone(정본) — 마일스톤/의존/게이트/비용
BUILD_TICKETS.md         Phase 0 + v0 데모 의존순 빌드 백로그 + 수용기준 등급
CODEX.md                 Codex 자율실행 풀 가이드(이 파일과 동일 핵심)
NOTICE                   Apache 2.0 귀속 — 앱 화면 표기 대상
clients/Core/            MomoCore: 공유 모델 + ChatBackend/AgentTransport 프로토콜(외부의존 0)
clients/macOS/           MomoMac: SwiftUI 뷰(D/B/C 경험) + smoke 실행 ※라이브러리(아직 .app 아님, M4에서 Xcode화)
clients/iOS/             (없음) M5에서 MomoiOS.xcodeproj 생성
server/                  MomoServer(Hummingbird 2) — Routes/(seq+outbox tx) · Auth · Realtime · DB · Migrations/00N_*.sql
relay/OutboxRelay/       SKIP LOCKED 폴링 → Centrifugo publish (BYPASSRLS)
workers/AgentWorker/     agent_job 클레임 → hermes OpenAI-compat SSE → message PATCH (BYPASSRLS) · LoopGuards · CostAccounting
adapters/hermes/         momo_adapter.py(BasePlatformAdapter) + plugin.yaml (py3)
infra/                   docker-compose(PG18+Centrifugo v6) · centrifugo.json · .env.example (infra/prod/*는 M1 신규)
scripts/                 migrate.sh · github/(bootstrap.sh · milestones/labels/issues.tsv)
docs/                    RUN.md · GITHUB_OPS.md · cicd/00~09 · legal/00~03
legal/                   privacy-policy · agent-disclosure · THIRD_PARTY_NOTICES (법률 자문 아님)
.github/                 ISSUE_TEMPLATE/ · workflows/{ci-build,release-ios,release-macos}.yml
fastlane/                Fastfile · Appfile · Matchfile (Gemfile은 루트)
research/07-deepdive/    04=L4 정본 스펙 · 05=에이전트 네이티브 경험
research/08-distribution/ 01=macOS 배포 스펙 · 02=배포 티켓
```
**BYPASSRLS:** OutboxRelay·AgentWorker만(전 테넌트 폴링). **쓰기 경로엔 BYPASSRLS 금지**. 그 외 모든 경로는 `SET LOCAL app.workspace_id` + RLS FORCE.

## 3. 빌드 / 검증 명령 (copy-paste, 그대로 실행)
> 로컬 툴체인: **Swift 6.2.x 있음**(`.swift-version`=6.2). **docker/psql/hermes 없음** → DB·Centrifugo·hermes 런타임은 이 환경에서 **검증 불가**.

```bash
make build          # SWIFT_PKGS 중 Package.swift 있는 것만 swift build (의존순: Core→server/relay/worker→macOS)
make test           # 동일 패키지 swift test
( cd clients/Core && swift build )           # MomoCore (공유 모델 + ChatBackend/AgentTransport)
( cd server && swift build )                 # MomoServer (Hummingbird 2)
( cd relay/OutboxRelay && swift build )      # OutboxRelay
( cd workers/AgentWorker && swift build )    # AgentWorker
( cd clients/macOS && swift build )          # MomoMac (lib + smoke)
python3 -m py_compile adapters/hermes/momo_adapter.py   # hermes 어댑터 문법 검증
# Xcode 앱(M4/M5 프로젝트 생성 후, 무서명 컴파일):
xcodebuild build -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
xcodebuild build-for-testing -scheme MomoiOS -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
# CI·fastlane 정적 검증:
actionlint .github/workflows/*.yml ; ruby -c fastlane/Fastfile
# 런타임(이 환경 밖, docker/psql 가용 시에만):
cp infra/.env.example .env && make up && make migrate && ( cd server && swift run )
```

**검증 등급(이슈마다 명시 — BUILD_TICKETS.md·ROADMAP §7 정의):**
- `[swift]` = `swift build` green(에러 0, 경고 허용). 미완성부는 `// TODO(#이슈)` + 컴파일 보장.
- `[infra]`/`[sql]` = 파일 존재 + `schema_v0.sql`(정본)·L4 스펙 정합. 적용은 `runtime-unverified (no docker/psql)`.
- `[python]` = `python3 -m py_compile` 통과.
- `[xcode]` = `xcodebuild`(무서명) 산출. `[ci]` = actionlint 통과 + (게이트 전) dry-run.
- `[runtime]` = docker/psql/hermes 가용 시에만. **이 환경에서 닫지 말고** `runtime-unverified` 표기 + RUN.md 절차.
- `[manual]` = 사람 1회(발급/계약/심사). Codex는 런북/파일만 준비하고 위임 표시.

## 4. Definition of Done (모든 이슈 공통 — 못 채우면 닫지 마라)
1. **해당 등급 검증 통과**(§3). Swift 이슈는 `swift build` green이 **하드 게이트**.
2. **선행 티켓을 깨지 않음**: 다른 패키지의 `swift build`가 여전히 green. 의존 그래프는 BUILD_TICKETS.md STEPS + ROADMAP §2.
3. **정본 정합**: DDL/모델은 `schema_v0.sql`과 컬럼·타입 일치(`member.kind`, `channel_seq`, `uuidv7()` PK, `hlc_ts`/`hlc_count`, `client_msg_id` 멱등). 정본 **이동/수정 금지** — 확장은 `server/Migrations/00N_*.sql` 신규 + RLS DO-block ARRAY에 신규 테이블 등록.
4. **runtime 미검증은 정직 표기**: 파일/주석/STATUS에 `runtime-unverified (no docker/psql)`. 검증 못 한 걸 "검증됨"이라 쓰지 마라.
5. **STATUS.md 갱신**: 무엇을 추가/변경, 무엇이 여전히 미검증인지 1~3줄.
6. **PR 본문**이 §5 형식.
7. 미완성 스텁은 `// TODO(#이슈번호): 설명` 형태로만(컴파일 항상 보장).
8. **게이트/배포 불변식 준수**: 사용성 검수 게이트(M7) PASS 기록 없이 스토어/공증 배포(M8)·external TestFlight 진행 금지(§7).

## 5. 컨벤션 (브랜치 / 커밋 / PR)
- **브랜치(org `Dawn-kim-official`/repo `momo`):** `feat/<issue#>-<slug>` · `fix/…` · `chore/…` · `docs/…`. SPINE 티켓 id면 `feat/MOMO-NNN-<slug>`도 허용. **main 직접 push 금지**(브랜치 보호 가정).
- **커밋:** Conventional Commits — `feat(server): channel_seq 발급 트랜잭션 (#NN)`. 타입/스코프는 영문, 본문 한국어 OK.
- **PR:** 1 PR = 1 이슈. 머지 전 `swift build` green 필수. PR 본문 템플릿:
```
Closes #<issue>

## 한 일
- (변경 요약 bullet)

## 검증 (등급: [swift]/[infra]/[sql]/[python]/[xcode]/[ci]/[runtime]/[manual])
- [ ] `swift build` green: <패키지>
- [ ] 선행 패키지 빌드 안 깨짐
- [ ] schema_v0.sql 정합
- [ ] runtime 미검증 부분 표기 (no docker/psql)

## STATUS 영향
- (STATUS.md에 반영한 줄)

## 남은 것 / 후속 이슈 제안
- (스코프 밖이라 새 이슈로 뺀 것)
```
- **절대 하지 말 것:** 시크릿 커밋(`.env`), `schema_v0.sql` 수정/이동, `.build/`·`*.resolved`·`DerivedData/`·`.swiftpm/` 커밋, 무관한 리팩터, 의존성 메이저 임의 변경, 다른 패키지 깨기, **게이트(M7) PASS 기록 전 `release-*.yml` 트리거**(§7).
- **Swift:** 타입 `PascalCase`, 함수/프로퍼티/let `camelCase`, enum case `camelCase`. 모델은 `MomoCore`에만 두고 import. SwiftPM 의존은 최신 안정 태그, `*.resolved` 비커밋. 서버 쓰기경로 단일 tx, async/await(블로킹 금지).

## 6. 다음 티켓 선택법 (자율 picker)
진실 원천: **ROADMAP.md(마일스톤 순서·의존) → BUILD_TICKETS.md(STEPS) → 티켓 deps**.
1. **마일스톤 순(M0→M8)**: 가장 낮은 번호의 열린/미완 마일스톤부터. 현재 활성 = **M1**(M0 달성됨).
2. 그 안에서 **`deps`(blocked-by)가 전부 done**인 티켓만(의존 충족). 미충족이면 건너뛴다.
3. **의존 깊이 얕은 것** → 동률이면 **`priority:p0>p1>p2`** → 그다음 티켓 id/이슈번호 오름차순.
4. `legal`/`manual` 티켓은 파일/런북만 준비, 발급·계약·심사는 사람 위임(런북 명시).
5. `[runtime]` 전용은 docker/psql 없으면 파일 정합까지만 + `runtime-unverified`.
6. 고른 이슈 자신에게 할당 → `status:in-progress` → 시작. 막히면 추측 금지, 블로커 코멘트 남기고 다음 티켓.

**마일스톤 backbone(정본=ROADMAP.md):** M0 Foundation(**달성**) → M1 백엔드 런타임+staging(G-0 런타임 e2e) → M2 멀티팀 온보딩(`003_onboarding.sql` invite_code+platform_admin, 자가가입, 관리자 추적) → M3 데스크탑 v0 UX(D/B/C 실데이터) → M4 데스크탑 패키징(Xcode/Developer ID/notarytool/DMG/Sparkle) → M5 iOS(iOS 26 SDK/Push/계정삭제/UGC 4종/PrivacyInfo) → M6 CI/CD(fastlane/ASC Key, release 잡 dry-run) → **M7 QA·검수 게이트 🔒**(G-0~G-G PASS) → M8 스토어 제출(M7 PASS 후에만). 임계경로: 모바일 M0→M1→M2→M5→M7→M8, 데스크탑 M0→M1→M3→M4→M7→M8. M3 이후 M4/M5/M6 병렬. 후속(출시 후): v1 프리미티브 P1 branch_id·P2 reversibility_tier·P3 belief·P4 autonomy_level·P5 decision_ledger·P6 scheduled trigger.

## 7. 설계 맥락 + 런타임 미검증 + 게이트 + 라이선스
**불변식(day-1 강제):** ①Postgres=SoT, Centrifugo=전송계층 ②쓰기경로 단일화(클라 직접 publish 금지) ③순서 SoT=`message.seq` ④에이전트=`member`(kind='agent'), 동일 REST/멱등 ⑤commit↔publish 무손실=transactional outbox ⑥seq=`channel_seq` 행카운터 `UPDATE...RETURNING`(시퀀스 금지), `client_msg_id` 멱등 ⑦멀티테넌시 `workspace→channel→membership`, 모든 행 `workspace_id`, RLS FORCE, tx마다 `SET LOCAL app.workspace_id`.

**읽을 곳:** `STATUS.md`(항상 먼저) · `ROADMAP.md`(마일스톤/게이트/비용) · `schema_v0.sql`(정본 DDL) · `research/07-deepdive/04`(L4 스펙) · `…/05`(D/B/C 경험) · `BUILD_TICKETS.md`(빌드 STEPS) · `docs/cicd/05-qa-release-gate.md`(게이트 객관기준 정본) · `docs/cicd/03-store-readiness-gate.md`(PASS 블록 기록 위치) · `docs/cicd/00~04`(Apple CI/CD·setup·시크릿·티켓) · `docs/RUN.md`(기동) · `legal/*`·`docs/legal/*`(법무).

**런타임 미검증(docker/psql/hermes 없음):** 서버↔PG18 연결, `channel_seq` 동시성, outbox→relay→publish 왕복, RLS 격리, 마이그레이션 멱등, AgentWorker↔hermes SSE, reserve/reconcile, Centrifugo presence/recovery, APNs — **전부 이 환경에서 검증 불가.** 파일 정합 + 컴파일까지가 최대치. **"검증됨"으로 닫지 말고** `runtime-unverified (no docker/psql)` 표기 + `docs/RUN.md`에 절차. 실제 e2e는 docker(PG18+Centrifugo v6+hermes) = M1 G-0에서.

**🔒 게이트 불변식:** 스토어/공증 배포(M8)·external TestFlight는 **사용성 검수 게이트(M7) PASS 후에만**. 조건: `docs/cicd/05-qa-release-gate.md` G-0~G-G 전부 PASS + 증거 → `docs/cicd/03-store-readiness-gate.md` 상단 PASS 블록(날짜+커밋해시+빌드#+증거) 기록 → STATUS.md 게이트 OPEN→PASS. **기록 없는 release = 규칙 위반.** PASS 전 `release-*.yml` 미트리거(태그 자제 또는 environment protection). `ci-build.yml`의 xcode-apps/release 잡은 C1/C2(M4/M5 Xcode 프로젝트) 전까지 비활성.

**permissive 라이선스:** 전 의존성 permissive(Apache-2.0/MIT/PostgreSQL License) 유지 — Hummingbird 2·Centrifugo v6·PostgreSQL 18·SwiftCentrifuge(MIT)·APNSwift. **비-permissive(GPL/AGPL/상용 제약) 의존 추가 금지.** 새 의존 추가 시 라이선스 확인 + `legal/THIRD_PARTY_NOTICES.md`/`NOTICE` 귀속 반영. 외부 배포/상용 전 법무 검토 1회 필수 — 법무·스토어 정책 텍스트는 **법률 자문이 아님**(사실은 Apple/GitHub 1차 출처, 추정은 `(추정)`).

## 8. 안전 / 한계
- 이 환경엔 docker/psql/hermes 없음 → 런타임 통합을 "검증됨"으로 닫지 마라.
- 막히면(의존 미충족·정보 부족) 임의 추측 금지 — 이슈에 블로커 코멘트 + 다음 티켓.
