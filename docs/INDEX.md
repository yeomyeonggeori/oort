# oort — 문서 지도 (INDEX)

> **전 문서 단일 색인.** 처음 들어온 사람·도구·워커 레인(`docs/planning/PIPELINE.md` §1)이 "무엇이 어디에 있고 무엇이 정본인가"를 한 눈에 잡는다.
> 경로는 모두 **리포 루트 기준 상대경로**. GitHub: `yeomyeonggeori/oort`.
> **정본 우선순위(충돌 시):** `AGENTS.md`(운영 계약) > `ROADMAP.md`(마일스톤) > 그 외. 스키마는 `schema_v0.sql`(이동·수정 금지)이 항상 정본.
> 표기: `(검증됨)`=1차 출처 교차확인 · `(추정)`=설계/일정 판단 · **법무 텍스트는 법률 자문 아님.**
> 목록 근거: ADR-0183 D1.

---

## 0. 지금 무엇으로 짓는가 (스택 한 눈)

| 층 | 정본 |
|---|---|
| 서버 | **`server-rust/`** Rust/Axum(ADR-0145) — `bins/{momo-server,momo-relay,momo-agent-worker,momo-notifier,momo-migrate}` + `crates/momo-*` |
| DDL | **`server/Migrations/*.sql`**(정본, Rust 이미지가 싣는다) + `schema_v0.sql`(무접촉) |
| 제품 표면 | **`clients/web`**(React/Vite) · `clients/desktop`(Tauri 2) · `clients/mobile`(RN) |
| 공유 코어 | **`packages/momo-core`**(TS, `@momo/core`) |
| 기동/배포 | [`docs/SELF_HOST.md`](SELF_HOST.md) · [`infra/rust/`](../infra/rust/)(셀프호스트 compose·Caddy·pgBackRest) · [`scripts/oort`](../scripts/oort) |
| 에이전트 접속 | Rust Agent Port/MCP(ADR-0162) · [`adapters/prime`](../adapters/prime/) · [`adapters/hermes`](../adapters/hermes/) |

공용 운영 계약은 [`AGENTS.md`](../AGENTS.md), 현행 빌드·검증 명령은 [개발 검증](runbooks/development-validation.md).

---

## 1. 루트 정본

| 파일 | 역할 |
|---|---|
| [`README.md`](../README.md) | 제품 1줄 + 불변식 + 셀프호스트 진입 |
| [`AGENTS.md`](../AGENTS.md) | 두 하네스의 공용 운영 계약·필수 검증·권한 경계 |
| [`CLAUDE.md`](../CLAUDE.md) | Claude Code의 공용 AGENTS import 진입점 |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) · [`CONTRIBUTING.ko.md`](../CONTRIBUTING.ko.md) | 기여 정본(DCO·라이선스 게이트) |
| [`SECURITY.md`](../SECURITY.md) | 취약점 신고. 한국어 [`docs/security/README.ko.md`](security/README.ko.md) |
| [`LICENSE`](../LICENSE) · [`NOTICE`](../NOTICE) | Apache-2.0 · 귀속 |
| [`CHANGELOG.md`](../CHANGELOG.md) | Keep a Changelog |
| [`ROADMAP.md`](../ROADMAP.md) | 릴리스 계획 — 상단 **축**이 현행 |
| [`STATUS.md`](../STATUS.md) | **항상 먼저.** 최상단 항목이 현재 |
| [`BUILD_TICKETS.md`](../BUILD_TICKETS.md) | 수용기준 등급 + 살아 있는 축의 티켓 계약 |
| [`schema_v0.sql`](../schema_v0.sql) | 정본 스키마 — 이동/수정 금지 |
| [`DESIGN.md`](../DESIGN.md) | 디자인 시스템 미러 |
| [`llms.txt`](../llms.txt) | 그록봇 진입 stub |
| [`Makefile`](../Makefile) | `build`/`test` = 현행 스택, `up`/`down`/`migrate` = compose |

---

## 2. 셀프호스팅

| 문서 | 역할 |
|---|---|
| [`docs/SELF_HOST.md`](SELF_HOST.md) · [`SELF_HOST.ko.md`](SELF_HOST.ko.md) | **첫 기동 정본**(clone → env → 로그인). 공개 오리진·`CENT_PROXY_SECRET` 회전도 여기 |
| [`docs/SELF_HOST_FIRST_DAY.md`](SELF_HOST_FIRST_DAY.md) · [`SELF_HOST_FIRST_DAY.ko.md`](SELF_HOST_FIRST_DAY.ko.md) | 오퍼레이터 첫 하루(초대·합류·AI 연결·첫 멘션) |
| [`docs/SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) · [`SELF_HOST_AGENT.ko.md`](SELF_HOST_AGENT.ko.md) | 그록봇 3계층 플레이북 |
| [`docs/RELEASING.md`](RELEASING.md) | 서버/이미지 `v0.x` 발행 |
| [`docs/NEXT_CHANNEL.md`](NEXT_CHANNEL.md) | Tauri next 자동 업데이트 채널 |
| [`infra/rust/README.md`](../infra/rust/README.md) | 이미지+compose 심화 |
| [`docs/runbooks/pgbackrest-pitr.md`](runbooks/pgbackrest-pitr.md) | pgBackRest PITR 폐곡선 |
| [`docs/runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md) | 셀프호스터 `pg_dump` 백업·복원 |
| [`docs/runbooks/local-resource-reclaim.md`](runbooks/local-resource-reclaim.md) | 로컬 리소스 회수 |
| [`docs/runbooks/cubesandbox-host-install.md`](runbooks/cubesandbox-host-install.md) | CubeSandbox 호스트 설치 |
| [`docs/runbooks/t3-unsettled-usage-repair.md`](runbooks/t3-unsettled-usage-repair.md) | T3 unsettled usage 수리 |
| [`docs/runbooks/internal-alpha-onboarding.md`](runbooks/internal-alpha-onboarding.md) | 내부 알파 온보딩 런북 |
| [`docs/onboarding-deeplink.md`](onboarding-deeplink.md) | `oort://join` 딥링크 |

---

## 3. 에이전트 연동

| 문서 | 역할 |
|---|---|
| [`docs/SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) | 그록봇 셀프호스트 플레이북 |
| [`docs/external-agent-provider/README.md`](external-agent-provider/README.md) | 외부 에이전트 런타임 smoke 계약 |
| [`docs/PUSH_RELAY_RUNBOOK.md`](PUSH_RELAY_RUNBOOK.md) | PushRelay 계약(env·서명·id-only). Rust 이식 중(#1255) |
| [`docs/INBOUND_MCP.md`](INBOUND_MCP.md) | Inbound MCP v0 skeleton |
| [`docs/GWS_INTERNAL_CONSENT_RUNBOOK.md`](GWS_INTERNAL_CONSENT_RUNBOOK.md) | GWS Internal OAuth consent 런북 |

---

## 4. 기획

| 문서 | 역할 |
|---|---|
| [`docs/planning/README.md`](planning/README.md) | 기획 레이어 운영 정본 |
| [`docs/planning/PIPELINE.md`](planning/PIPELINE.md) | 레인·모델·도구·병렬 상한·워크트리 경로의 유일 정본 |
| [`docs/TRACKS.md`](TRACKS.md) | UXUI/엔진 트랙 파이프라인 |
| [`docs/adr/`](adr/) | 결정 정본(전량 보존). 색인은 디렉터리 |
| [`docs/planning/2026-09-07-first-goal-two-cases.md`](planning/2026-09-07-first-goal-two-cases.md) | 1차 목표 두 케이스 |
| [`docs/planning/CURRENT_STATE.md`](planning/CURRENT_STATE.md) | 활성 planning owner·다음 체크포인트 |
| [`docs/planning/JOURNAL.md`](planning/JOURNAL.md) | 기획 세션 저널 |
| [`docs/planning/DEVIATION_LOG.md`](planning/DEVIATION_LOG.md) | 계획 이탈 로그 |
| [`docs/planning/ENGINE_HANDOFF.md`](planning/ENGINE_HANDOFF.md) | 엔진→UXUI 큐 |
| [`docs/planning/HANDOFF_TEMPLATE.md`](planning/HANDOFF_TEMPLATE.md) | 핸드오프 패킷 템플릿 |
| [`docs/architecture/overview.md`](architecture/overview.md) | 아키텍처 정본 |
| [`docs/ux-bible/README.md`](ux-bible/README.md) | UX 원칙 P1~P15 |
| [`docs/design-system/README.md`](design-system/README.md) | 디자인 시스템 「오르트 구름」 |

---

## 5. 게이트

| 문서 | 역할 |
|---|---|
| [`docs/LOCAL_PR_GATE.md`](LOCAL_PR_GATE.md) | 로컬 PR 게이트 축약. 프로파일 정본은 `scripts/local_gate.sh --help` |
| [`docs/GITHUB_OPS.md`](GITHUB_OPS.md) | GitHub 운영 구조(마일스톤·라벨·워커 goal) |
| [`docs/MULTI_SESSION_OPS.md`](MULTI_SESSION_OPS.md) | 다중 세션/워크트리 운영 |
| [`docs/cicd/00-apple-cicd-pipeline.md`](cicd/00-apple-cicd-pipeline.md) | Apple CI/CD 파이프라인 설계 |
| [`docs/cicd/01-setup-runbook.md`](cicd/01-setup-runbook.md) | 1회 셋업 런북 |
| [`docs/cicd/02-secrets-inventory.md`](cicd/02-secrets-inventory.md) | 비밀값 인벤토리 |
| [`docs/cicd/03-store-readiness-gate.md`](cicd/03-store-readiness-gate.md) | 게이트 체크리스트 + **PASS 블록 정본 기록처**. G3 수치/베타 문서는 LS-3에서 삭제(G3 진입 때 RN 기준으로 재작성) |
| [`docs/cicd/07-crash-analytics-spec.md`](cicd/07-crash-analytics-spec.md) | 크래시 계측 스펙 |
| [`docs/cicd/08-e2e-accessibility-performance.md`](cicd/08-e2e-accessibility-performance.md) | e2e·접근성·성능 |
| [`docs/cicd/11-ios-push-device-check.md`](cicd/11-ios-push-device-check.md) | iOS 푸시 실기기 확인 |
| [`docs/cicd/12-push-relay-deploy-runbook.md`](cicd/12-push-relay-deploy-runbook.md) | PushRelay 배포·검증(ADR-0120 P-3) |
| [`docs/cicd/13-selfhosted-runner-macos.md`](cicd/13-selfhosted-runner-macos.md) | 셀프호스티드 macOS 러너 |

---

## 6. 내부 테스트

정본 팩: [`docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`](LOCAL_3_DAY_ALPHA_TEST_PACK.md) (`LAUNCH_READY` / `BLOCKED` / `NEEDS_MORE_INTERNAL`).

인테이크 3줄: 내부 테스터가 막히면 GitHub 이슈로 남긴다(`type:feedback` · `area:alpha` · `status:needs-triage`). 시크릿·초대 원문·자격증명은 붙이지 않는다. `status:ready`는 Goal/Context/Acceptance가 있는 워커 골로 바꾼 뒤에만.

---

## 7. 불변식

1. **Postgres = SoT, Centrifugo = 전송계층.** 클라는 Centrifugo로 직접 publish 금지.
2. **순서 SoT = `message.seq`**. 에이전트 = 사람과 동일 `member`(kind='agent').
3. **멀티테넌시:** `workspace→channel→membership`, 모든 행 `workspace_id`, RLS FORCE.
4. **`schema_v0.sql` 이동·수정 금지.**
5. **🔒 게이트:** 스토어/공증 배포(M8)·external TestFlight는 검수 게이트(M7) PASS + `docs/cicd/03` PASS 블록 기록 후에만.
6. **런타임 미검증 정직 표기.**
7. **permissive 라이선스 유지.** 법무 텍스트는 **법률 자문 아님**.
