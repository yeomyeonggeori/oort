# 클린 슬레이트 후보 목록 — 판정 기준 A~E 적용 (2026-09-07, Fable · momo-main)

> 실측 원문은 `2026-09-07-clean-slate-inventory.md`. 판정 기준(계획 §3): **A** 결정으로 은퇴된 표면=삭제 · **B** 60일± 미접촉+참조 0+게이트 미배선=삭제 · **C** 이중 정본=하나로 · **D** 비대=분해 티켓 · **E** 로테이션=압축. 「깨지는 것」 열이 비어 있지 않으면 재배선(LS-0)이 먼저다. 결정은 `docs/adr/0183-codebase-docs-lightening.md`.

## 1. 상위 20 (감량 크기 × 근거 확실성 순)

| # | 후보 | 기준 | 파일 / LOC | 근거 | 지우면 깨지는 것 | 처리 |
|---|---|---|---|---|---|---|
| 1 | `server/Sources`·`Tests`·`Fixtures`·`Package.swift` | A | 114 / 51.1k | ADR-0145 Accepted · 증보 2 · TRACKS 「은퇴 중」 · 병합 권위 참조 0 | local_gate `swift`+runtime 7 프로파일(`make swift-build`) · Swift e2e 컴포즈 `api` · `openapi_server_routes.py`·`verify_openapi_contract.sh` swift pass · `gate_oort_user_facing.sh` 스캔 · verifier 60본 | LS-0 → LS-1 |
| 2 | `workers/AgentWorker`·`NotifierWorker` | A | 38 / ≈10k | Rust `momo-agent-worker`·`momo-notifier` 이관 완료(감사 §2-7) | e2e 컴포즈 `worker`·`notifier` · `infra/prod/docker/momo.Dockerfile` | LS-1 |
| 3 | `workers/WorkHostDaemon`(momo-workd) + `adapters/codex-workbench` + `infra/workd` | A(결정 ②) | 31+6+5 / ≈12k | #1256 OPEN(성재 08-10 「마지막 Swift 소멸 경로」) · 출시 두 기둥 밖(#1927 SH-7 마지막) | `verify_work*`·`t3_*`·`workd*` 22본(전부 Swift 전용) · `workhost.Dockerfile` · `WORK_HOST_QUICKSTART.md` | **성재 결정** → LS-1 |
| 4 | `clients/web-legacy` | C | 45 / 26.8k(`schema.d.ts` 14.5k) | 서빙 0(#1641) · 생성 타입 소비자 0(momo-core `api.ts` 손수) | CI 레인 「OpenAPI ↔ web-legacy generated contract」 · local_gate `web` 프로파일 6단계 · `verify_web_generated_types/serving/login_smoke` · `infra/prod/Dockerfile.web`·`momo.Dockerfile` · `gate_oort_user_facing.sh` 타이틀 · dependabot PR 3 · `NOTICE`·`.dockerignore`·`.gitleaksignore` | LS-0 → LS-2 |
| 5 | Swift 전용 verifier 60본 | A/B | 60 / 23.3k | Swift e2e 컴포즈 의존 · 30일 실사용 0 · 그중 58본은 `bash -n`으로만 배선 | local_gate 정적 블록 `bash -n` 목록 · runtime 프로파일 | LS-0(정책 감사) |
| 6 | `clients/mobile-spike` | A | 70 / 19.6k | ADR-0137 「RN parity 통과 시 은퇴」 · #1292 CLOSED | `clients/mobile/__tests__/composerHangul.test.tsx`·`measure/harness.tsx`·`package.json` · Rust 시험 1본 문자열 | LS-2 |
| 7 | `research/` 루트 비인용분 | B/E | ≈90 / ≈12k | 6월 아이데이션 · ADR 인용 0 디렉터리 8(`_buildplan_wf.js`·01·02·05a·08·10·14·20) · 11-agent-runtime 53본 중 ADR 인용 4 | `BACKLOG.md`·`INDEX.md`가 07-deepdive L4 스펙 15곳 인용(둘 다 LS-3 대상) · `deny.toml`·`.gitleaksignore`·`adapters/prime/*` 주석 | LS-4 |
| 8 | handoffs 닫힌 이슈 87 + 무참조 109 | E | 196 / 8.2k | 이슈 close = 패킷 수명 종료(D6 규칙) | 없음(패킷을 링크하는 곳은 이슈 본문·JOURNAL — 히스토리 링크로 허용) | LS-4 |
| 9 | `infra/prod`(SQL 4본 제외) | A | 28 / ≈3.3k | Swift 시대 운영 스택(MOMO-005) · NCP 철수 · 현행 셀프호스트 = `infra/rust` | **`server-rust/Dockerfile:221-225`·`momo-migrate` 경로 12곳(SQL 4본 → `infra/rust/sql/` 이전)** · local_gate json/bash -n/AWS preflight · `check_compose_env_templates` 컴포즈 8본 · `test_publish_images_contract.py`·`test_make_deploy_bundle` · `verify_prod_*`·`verify_internal_*`(Swift 전용) | LS-0 → LS-1 |
| 10 | `infra/docker-compose.e2e.yml` + `infra/docker-compose.yml`(Swift 시대) | C | 2 / ≈0.8k | 현행 = `infra/rust` · #1022 OPEN | verifier 66본 · `Makefile up/down` · `verify_openapi_contract.sh` 1차 패스 · `verify_eve_profile` | LS-0 → LS-1(#1022 재정의) |
| 11 | `docs/RUN.md`(1,745) · `DEPLOY.md`(892) · `BACKLOG.md`(1,224) · `RELEASE_PLAYBOOK`(378) · `MACOS_ALPHA_UPDATE_CHANNEL`(159) · `LOCAL_SOLO_ALPHA_ROADMAP`(137) · `HANDOFF_2026-07`(56) · `AWS_INTERNAL_ALPHA`(274) · `runbooks/ncp-rust-deploy`(15 NCP) · `specs/04-context-packet-v0` | A/C | 10 / ≈5.1k | 은퇴 배너 4본 · Swift 전제(DEPLOY 77곳·BACKLOG 24곳·AWS 8곳) · #1610 in-progress | `check_docs_commands.py` GATED_DOCS(`docs/RUN.md`) · RUN.md 참조 28곳(AGENTS·STATUS·INDEX·ADR-0004…) → 링크 재작성 | LS-0(GATED_DOCS) → LS-3 |
| 12 | `docs/planning/research` 살아 있는 참조 0 | E | 35 / 6.1k | design-review r-노트 6 · sol 초안 5 · 감사·벤치 등 | 없음 | LS-4 |
| 13 | `claudedocs/` 추적 39 + 미추적 2,329(2.6G) | E | 39 / 6.2k | 세션 스크래치 · REPORT 정본은 PR | `.gitignore` 1줄 · STATUS가 REPORT 경로를 인용(히스토리 링크) | LS-4 |
| 14 | `docs/archive/` | E | 5 / 5.4k | attic(H1 BUILD_TICKETS·ROADMAP·STATUS-06/07) | `BUILD_TICKETS.md`·`README` 링크 2~3곳 · STATUS-06/07은 `docs/planning/archive/`로 이동 | LS-4 |
| 15 | `relay/PushRelay` + `services/MomoMetrics` | A(결정 ①) | 15 / ≈3.5k | #1255 OPEN · 폰 푸시 = G3 · NCP 철수 후 relay 배포 실체 없음 | `infra/rust/docker-compose.push.build.yml` · `PUSH_RELAY_RUNBOOK.md` · `cicd/12-push-relay-deploy-runbook.md` · `scripts/fixtures/ios-push-sample.apns` · `verify_push_*`·`test_push_relay_vocabulary_contract.py` | **성재 결정** → LS-1 |
| 16 | `docs/planning` 루트 참조 0 | E | 22 / 2.3k | 7~8월 진단·리서치(ADR에 흡수) | 없음 | LS-4 |
| 17 | `examples/`(cloudflare·eve) + `infra/eve` + compose `eve` 서비스 | B | 17+ / 4.9k | `verify_momo_channel_adapter.sh` 실행 배선 0·Swift 전용 · dependabot PR #673·#674 방치 | `verify_eve_profile --config-only`(정적 블록) · `dependabot.yml` | LS-0 → LS-3 |
| 18 | 실행 배선 0 스크립트 25본 + `scripts/spikes` 10본 | B | 35 / ≈5k | 인벤토리 §4 목록 · 단 SH 시험 3본(`test_oort_*`·`test_public_edge`)은 **삭제가 아니라 local_gate 편입**(#2124) | 없음(문서 언급만) | LS-0 |
| 19 | `services/LinkShort`·`CloudProviderKit`·`OutboundHTTPPolicy` | A | 15 / ≈1.5k | LinkShort = Caddy redir 1줄 대체(감사 §2-3) · 나머지 Swift 라이브러리 | e2e 컴포즈 `linkshort` · `verify_linkshort.sh` | LS-1 |
| 20 | `CODEX.md`·`.codex/`·`ISSUE_TEMPLATE/codex-goal.md`·`mock_codex_app_server.py`·`scripts/github/*.tsv` Codex 문면 | A/C | 6 / ≈0.3k | Codex 레인 은퇴(08-26) · P2 병합 완료 | GATED_DOCS(`CODEX.md`) · `github_bootstrap.sh` 라벨 시드 · `verify_external_agent_provider.sh`(mock) | LS-0 → LS-3 |

**합계(결정 ①② 권고안 채택 시)**: 파일 ≈850 · 코드 ≈150k LOC · 문서 ≈45k줄. 상세 §4.

## 2. 영역별 전체 목록

### 2.1 코드 트리
| 후보 | 기준 | 처리 | 비고 |
|---|---|---|---|
| Swift 4트리(위 1·2·3·15·19) | A | LS-1 | `server/Migrations` 86본은 **유지** |
| `.swift-version` · `Makefile swift-build/test` · `add_swift_commands` | A | LS-0/LS-1 | |
| `clients/web-legacy` · `clients/mobile-spike` | C/A | LS-2 | |
| `infra/prod`(SQL 이전 후) · `infra/docker-compose*.yml`(루트 2본) · `infra/eve` · `infra/workd` · `infra/e2e/web-placeholder`(web-legacy 서빙 스모크) | A/C | LS-1 | `infra/cubesandbox`·`infra/rust` 유지 |
| `adapters/codex-workbench` | A(②) | LS-1 | `adapters/prime`·`hermes` 유지 |
| `examples/` | B | LS-3 | |
| `scripts/`: Swift 전용 verifier 60 · 실행 배선 0 25(SH 시험 3 제외) · `spikes/` 10 · `transcription/` 8(무배선, 허들 ASR 실측 도구 — 실사) · `openapi_server_routes.py` · `verify_openapi_contract.sh`(swift pass) · `make_deploy_bundle.sh`(Swift 번들) · `aws_internal_alpha_preflight.sh` · `prod_env_preflight.sh` · `agent_host_local.sh` · `mock_codex_app_server.py` · `fixtures/ios-push-sample.apns` | A/B | LS-0 | 보호 경로 → 정책 감사 1회 |
| `scripts/verify_ncp_centrifugo_*`·`tests/test_ncp_centrifugo_boundary.sh` · `infra/rust/pgbackrest-s3*` | C(개명) | LS-0 | 삭제 아님 — 공개 엣지 게이트로 개명 |
| `.conductor/setup.sh` · `.sops.yaml.example` | B | LS-3 | 실사(worktree-bootstrap 스킬 산물 / MOMO-006) |

### 2.2 문서
| 후보 | 기준 | 처리 |
|---|---|---|
| 루트 은퇴·Swift 전제 10본(위 11) | A/C | LS-3 |
| 실사 후 흡수/삭제/유지: `SECRETS_BACKUP_RUNBOOK`(Swift 38곳) · `INTERNAL_ALPHA`·`INTERNAL_ALPHA_FEEDBACK` · `LOCAL_3_DAY_ALPHA_TEST_PACK`(ITO 팩 — 유지 후보) · `WORK_HOST_QUICKSTART`·`AGENT_HOSTING_QUICKSTART`·`BYOC_CLOUD_HOST`(결정 ②) · `QA_GATE`(M7 스토어 — G3) · `INBOUND_MCP`(MOMO-172 스켈레톤) · `IOS_TESTFLIGHT_RUNBOOK`(ADR-0123 Swift iOS → RN 런북으로 재작성 or 삭제) · `GITHUB_OPS`·`MULTI_SESSION_OPS`(Codex 문면 일반화) · `LOCAL_PR_GATE`(906줄, `local_gate --help`와 중복 — 축약) · `docs/cicd/04-codex-tickets`·`09-qa-codex-tickets` · `docs/external-agent-provider/*`(hermes gateway Swift) · `runbooks/turn-host-install`(17곳)·`aws-internal-alpha-deploy` | C | LS-3(워커가 표로 제시) |
| `INDEX.md` 재작성(D1 목록) · `README` 디렉터리 절 · `TRACKS.md` §1 「은퇴 중」 문면 삭제 · `AGENTS.md` Codex 문면 | C | LS-3 |
| handoffs 196 · planning 루트 22 · planning/research 35 · `research/` 비인용 ≈90 · `claudedocs` 39 · `docs/archive` 5 | E | LS-4 |
| `STATUS.md` 2026-08 절 → `docs/planning/archive/STATUS-2026-08.md` · `docs/archive/STATUS-2026-06/07` 이동 | E | LS-4 |
| ADR 80본 · `docs/api` · `docs/architecture` · `docs/design-system`·`DESIGN.md`·`ux-bible` · `docs/legal`·`legal/` · SELF_HOST 3짝(en+ko) | 유지 | — |

### 2.3 GitHub
| 후보 | 처리 |
|---|---|
| dependabot PR #1355·#1356·#1357(web-legacy) · #673·#674(examples) | LS-2/LS-3에서 close |
| `area:ios` 15 · `area:macos` 14 열린 이슈 | LS-5 planner 판정 |
| #1255·#1256·#1022·#1345·#1610 | ADR D8 재정의 |

## 3. D — 비대(분해 티켓, 삭제 아님)
`clients/web/scripts/capture-screens.mjs` 12,656 · `clients/web/gates/*.mjs` 46본 ≈35k · `scripts/local_gate.sh` 1,575(프로파일 메뉴 → 현행 5개) · `verify_openapi_contract_rust.sh` 4,170 · `server-rust dto.rs` 4,969 · `config.rs` 2,599 · `momo-core api.ts` 4,302 · `mobile MessageRow.tsx` 3,200 · `measure/surfaces.tsx` 2,837 · `hermes momo_adapter.py` 3,129 · `STATUS.md` 1,132(로테이션으로 해소).

## 4. 예상 감량 (실측 합)

| 묶음 | 파일 | LOC |
|---|---|---|
| Swift 4트리 전량(결정 ①② 권고) | 222 | 78,043 |
| `clients/web-legacy` · `mobile-spike` | 115 | 46,398 |
| Swift 전용 verifier 60 + 배선 0 22 + spikes 10 + Swift e2e 컴포즈·infra/prod(SQL 제외)·eve | ≈125 | ≈33,000 |
| 루트 은퇴 문서 10 + `docs/archive` 5 | 15 | ≈10,500 |
| handoffs 196 · planning 루트 22 · planning/research 35 · `research/` ≈90 · `claudedocs` 39 | ≈382 | ≈34,800 |
| Codex 잔재·`.swift-version`·기타 | ≈10 | ≈500 |
| **합** | **≈870 / 3,416 (25%)** | **≈203k / ≈875k (23%)** — 코드 ≈157k · 문서 ≈46k |

결정 ①이 「유지」면 −15파일/−3.5k, ②가 「유지」면 −42파일/−12k·verifier 22본 잔존.
