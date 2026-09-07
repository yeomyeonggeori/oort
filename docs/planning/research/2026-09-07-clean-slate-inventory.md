# 클린 슬레이트 인벤토리 — 코드베이스·문서 실측 (2026-09-07, Fable · momo-main)

> 기준: `main` `f399e417`(2026-09-07, 도는 것 없음). 명령은 `claudedocs/resume-2026-09-07/PLAN-clean-slate-diagnosis.md` §2 그대로(read-only). 수치는 전부 `git ls-files`·`wc -l`·`git grep`·`git log -1` 실측이며 추정치는 「≈」로 표기했다.
> 짝 문서: 후보 판정 `2026-09-07-clean-slate-candidates.md` · 결정 `docs/adr/0183-codebase-docs-lightening.md`(Proposed).

## 0. 한 줄 요약

- 추적 파일 **3,416** · 코드 LOC(rs/ts/tsx/swift/py/sh/mjs/js) **≈768k** · 문서(md) **107k**(804 파일).
- 살아 있는 제품은 **Rust 서버(server-rust) + React 웹(clients/web) + Tauri 셸 + RN 폰 + momo-core + infra/rust(셀프호스트)** 다. 그 옆에 **은퇴 결정이 난 채 남아 있는 트리**가 세 덩어리 있다: ①Swift 4트리(server/Sources·workers·relay·services, **78k LOC·222 파일**) ②`clients/web-legacy`(26.8k)·`clients/mobile-spike`(19.6k) ③Swift 시대 운영 스택 `infra/prod`(3.6k)+Swift e2e 컴포즈.
- 게이트는 이 은퇴 트리를 아직 붙들고 있다: `local_gate.sh`의 `swift` 프로파일 + runtime 프로파일 7종이 `make swift-build`를 부르고, **verify 스크립트 125본 중 66본이 Swift e2e 스택**(그중 60본은 Swift 전용, 23.3k LOC)을 띄운다. CI에는 Swift 레인이 없고 `web-legacy` 계약 레인 1개가 남아 있다.
- 문서는 **핸드오프 302본(닫힌 이슈·무참조 196)** · `research/` 루트 112본(6월 아이데이션, ADR 인용 0인 디렉터리 8) · `docs/planning/research` 110본(살아 있는 참조 0 = 35) · 루트 은퇴 배너 문서 4본(RUN 1,745줄 등) · `claudedocs` 추적 39본(+미추적 2,329 파일 2.6G).

## 1. 최상위 형상 (추적 파일 수)

| 최상위 | 파일 | 2차 상위 |
|---|---|---|
| clients | 1,250 | web 681 · mobile 384 · mobile-spike 70 · desktop 70 · web-legacy 45 |
| docs | 663 | planning 487(handoffs 302 · research 110 · 루트 69 · archive 4 · proposals 2) · adr 80 · cicd 14 · runbooks 11 · architecture 11 · 루트 md 34 |
| server-rust | 348 | bins 170(momo-server 122) · crates 172 |
| scripts | 265 | verify_* 125 · tests/ 39 · check_* 12 · 기타 89(spikes 10 · transcription 8 · github 4 · lib 4) |
| packages | 215 | momo-core 215 |
| server | 202 | Sources 92(Swift) · **Migrations 86(정본 DDL)** · Tests 17 · Fixtures 4 · Package.swift |
| research | 112 | 11-agent-runtime 53 · 17-work-host-fabric 14 · 16 7 · 19 6 · 15 6 · 07 5 · 13 4 · 12 4 · 10 3 · 20 2 · 08 2 · 18 1 · 14 1 · 루트 4 |
| infra | 82 | prod 32 · rust 25 · cubesandbox 8 · workd 5 · e2e 4 · eve · compose 2본 |
| workers | 70 | WorkHostDaemon 31 · AgentWorker 27 · NotifierWorker 11 (전부 Swift) |
| adapters | 41 | prime 23 · hermes 12 · codex-workbench 6 |
| claudedocs | 39 | design-review-17xx REPORT 24 · e2e/spike 리포트 |
| services | 24 | CloudProviderKit 9 · LinkShort 7 · MomoMetrics 5 · OutboundHTTPPolicy 3 (Swift) |
| legal | 20 | generated 17 |
| relay | 18 | PushRelay 10 · OutboxRelay 8 (Swift) |
| examples | 17 | eve-momo-channel 9 · cloudflare-agent-momo 8 |
| .github | 15 | workflows 5 · ISSUE_TEMPLATE 6 |
| 루트 단일 | 30 | md 13(2,803줄) · `CODEX.md`(4줄 스텁) · `.swift-version`(6.2) · `.codex/` · `.conductor/` · `.sops.yaml.example` · `deny.toml` · `llms.txt` · `DESIGN.md`(435) |

## 2. LOC

### 2.1 언어별 (추적 파일)

| 확장자 | 파일 | LOC |
|---|---|---|
| rs | 331 | 216,051 (tests 132,514 / src 81,777 — 시험이 61%) |
| ts | 663 | 164,349 |
| tsx | 366 | 140,897 |
| sh | 236 | 88,851 |
| swift | 224 | 78,757 |
| mjs | 68 | 52,155 |
| py | 65 | 25,581 |
| md | 804 | 107,230 |
| json | 100 | 68,171 |
| yaml/yml | 41 | 18,953 (openapi.yaml 13,040 포함) |
| sql | 95 | 10,423 |

### 2.2 영역별 코드 LOC (rs/ts/tsx/swift/py/sh/mjs/js)

| 영역 | 파일 | 코드 LOC | 상태 |
|---|---|---|---|
| server-rust | 348 | 214,368 | **현행** |
| clients/web | 681 | 197,447 (src 593 파일 / gates 46 파일 ≈35k / scripts 15 — `capture-screens.mjs` 12,656) | **현행** |
| scripts | 265 | 96,157 (verify_* 53,863 · tests 12,649 · 기타 29,203) | 현행+은퇴 혼재 |
| clients/mobile | 384 | 71,299 | **현행**(RN) |
| packages/momo-core | 215 | 66,637 (test 27,121) | **현행** |
| server (Swift) | 202 | 50,862 | 은퇴 결정(ADR-0145) — Migrations 86본만 정본 |
| workers (Swift) | 70 | 22,153 | 은퇴 결정 · workd만 미이식 컴포넌트(#1256) |
| clients/web-legacy | 45 | 21,495 (`schema.d.ts` 14,543) | ADR-0119 v0, 서빙 안 함 |
| adapters | 41 | 14,976 (hermes `momo_adapter.py` 3,129) | prime·hermes 현행 / codex-workbench = workd 엔진 |
| clients/mobile-spike | 70 | 2,745 (총 19,600줄 — lock·json 포함) | ADR-0137 킷, RN parity 후 은퇴 문법 |
| relay (Swift) | 18 | 2,466 | PushRelay = 마지막 라이브 Swift(#1255) · OutboxRelay 이관 완료 |
| infra | 82 | 2,373 | prod(Swift 시대) / rust(현행) |
| services (Swift) | 24 | 2,060 | LinkShort·MomoMetrics·CloudProviderKit·OutboundHTTPPolicy |
| clients/desktop | 70 | 1,760 | **현행**(Tauri) |
| examples | 17 | 637 (총 4,862 — lock 포함) | 무배선 |

### 2.3 문서 LOC

| 영역 | 파일 | LOC |
|---|---|---|
| docs/planning | 487 | 48,025 (handoffs 13,022 · research 22,213 · 루트 69본 8,165) |
| docs/api | 4 | 13,737 (openapi.yaml 13,040 — 정본) |
| docs/adr | 80 | 5,739 |
| docs/brand | 2 | (png 2본) |
| docs/archive | 5 | 5,351 |
| docs/runbooks | 11 | 2,508 |
| docs/cicd | 14 | 2,207 |
| docs/architecture | 11 | 1,422 |
| docs/ 루트 md | 34 | ≈17k (RUN 1,745 · SELF_HOST_AGENT 1,435 · BACKLOG 1,224 · LOCAL_PR_GATE 906 · DEPLOY 892 · SELF_HOST 648) |
| research/ (루트) | 112 | 17,354 |
| claudedocs (추적) | 39 | 6,197 |
| 루트 md 13본 | 13 | 2,803 (STATUS 1,132) |

## 3. 접촉일

- 2차 경로 기준 **60일+(≤2026-07-09) 미접촉은 10건뿐**(`.gitkeep` 4 · `research/` 루트 4 · `scripts/verify_platform_admin.sh` · `.conductor/setup.sh`). 레포 전체가 7~9월에 계속 만져져 「미접촉」만으로는 후보가 안 나온다.
- 대신 **40~58일 미접촉(2026-07-11~07-27) 군집 = `scripts/verify_*` 60여 본**(agent_context_bootstrap·hermes_bridge·thread_reply·rls·roster·plugin_*·memory_*·work_*·t3_* …) — Swift e2e 스택 시대의 검증기. §4의 「Swift 전용 66본」과 대부분 겹친다.
- 문서: handoffs 마지막 접촉 2026-07 64본 · 08 210본 · 09 28본. `docs/planning/research`는 08 103본.

## 4. 스크립트 배선 그래프 (`scripts/` 247 실행 파일)

| 측정 | 값 |
|---|---|
| 게이트·CI·Makefile이 이름으로 부르는 것 | 185 (`local_gate.sh`·`.github/workflows/*`·`Makefile`) |
| 실행 배선 0 (scripts·.github·Makefile·infra·package.json·server-rust·adapters·web gates 어디서도 안 부름) | **25** — `reclaim_worktrees.sh` · `worktree_janitor.sh` · `agent_host_local.sh` · `spikes/herdr_*.py` 2 · `transcription/transcription_common.py` · `tests/test_bench_onboarding_aggregate.sh` · `tests/test_release_manifest.sh` · `tests/test_oort_day2.sh`·`test_oort_doctor.sh`·`test_public_edge.sh`(SH 시험 3본 — local_gate 미편입, #2124) · `verify_notification_rules.sh` · `verify_webhook_rust.sh` · `verify_onboarding_greeting.sh` · `verify_workd_reconcile.sh` · `verify_workspace_create.sh` · `verify_workspace_rest_create.sh` · `verify_provider_cascade.sh` · `verify_quota_snapshot.sh` · `verify_t3_interval_precision.sh` · `verify_usage_summary.sh` · `verify_momo_channel_adapter.sh` · `verify_run_routing.sh` · `verify_cors_allowlist.sh` · `verify_push_kit_inheritance.sh` |
| `local_gate.sh`가 **`bash -n`(문법 검사)로만** 붙드는 것 | 58 — 실행은 어디서도 안 함 |
| verify_* 125본 중 **Swift e2e 스택**(`docker-compose.e2e.yml`/`swift:6.2`/`server/Sources`/`make swift`)에 의존 | **66** (Rust와 겹침 6 → **Swift 전용 60, 23,279 LOC**) |
| verify_* 중 Rust 스택(`infra/rust`/`server-rust`/`cargo`) | 21 |
| 둘 다 아님(정적 검사·문서·깃 위생) | 44 |

Swift 전용 60본: `verify_agent_card_onboarding` `agent_create` `agent_interaction_safety` `agent_profile` `agent_run_cancel` `agent_run_history` `attachment_upload` `context_packet` `drive_mcp` `event_subscription` `internal_hosting_smoke` `lifecycle_completion` `membership_lifecycle` `memory_grant` `memory_plane` `memory_search` `message_interaction` `metrics_observability` `momo_channel_adapter` `multibinary_image` `notification_mute` `notification_rules` `observer_attach` `pgvector_contract` `plugin_grant_roundtrip` `plugin_registry` `prod_install_upgrade` `provider_cascade` `provider_link` `push_notifier` `push_registration` `quota_snapshot` `run_routing` `signed_webhook_ingress` `t3_convergence` `t3_interval_precision` `t3_lifecycle_concurrency` `t3_provider_continuity` `t3_provisioner` `terminal_attach` `thread_projection` `thread_reply` `tier_fallback` `usage_summary` `web_generated_types` `web_login_smoke` `web_serving` `work_agent_e2e` `work_control` `work_host` `work_pool` `work_session_idle` `work_session` `work_tool_profile` `workd_reconcile` `workd` `workhost_engines` `workspace_rest_create` `workspace_search` `workstream_continuity`.

Swift 툴체인(`swift build|run|test`)을 직접 부르는 스크립트는 **0** — 전부 `make swift-build`/컴포즈 경유. `openapi_server_routes.py`는 `server/Sources/MomoServer/Routes`에서 라우트를 뽑는 Swift 전용 파서(ADR-0145 증보 2가 「swift pass 강등」한 자리).

## 5. 문서 참조 그래프 (`docs/*.md` 663 + 기타)

| 측정 | 값 |
|---|---|
| 파일명으로 아무도 링크하지 않는 docs md | **251** — handoffs 201 · planning/research 18 · archive 2 · ADR 28(ADR은 결정 기록이라 삭제 대상 아님) · 기타 |
| handoffs 302본 → 이슈 매핑(머리 15줄의 `#NNNN`) | **닫힌 이슈만 참조 87 · 열린 이슈 참조 106 · 이슈 번호 없음 109**(7월 36 · 8월 60 · 9월 13). 닫힘+무참조 = **196본 8,249줄** |
| docs/planning 루트 69본 | 살아 있는 정본(handoffs·archive·research·JOURNAL·STATUS·claudedocs 제외)에서 참조 0 = **22본 2,304줄**, 그중 ADR 인용도 0 = 22본 전부(7~8월 진단·리서치·계획 — 예: `2026-07-26-rn-adoption-plan` 류는 ADR에 흡수됨) |
| docs/planning/research 110본 22,213줄 | 살아 있는 참조 0 = **35본 6,081줄** · ADR/architecture/design-system이 인용 = 35본 |
| research/ 루트 112본 17,354줄 | ADR 인용 디렉터리: 11(4)·15(4)·13(2)·16(2)·17(2)·19(2)·12(1)·18(1). **ADR 0·살아 있는 참조 ≤3**: `_buildplan_wf.js`·01·02·05a·08·10·14·20(≈1,500줄). `07-deepdive`(2,259줄)는 BACKLOG/INDEX가 15곳 인용(L4 스펙) |
| docs/ 루트 34본 | 머리에 **[은퇴] 배너**: `RUN.md`(1,745줄, 28곳 참조) · `RELEASE_PLAYBOOK.md`(378) · `MACOS_ALPHA_UPDATE_CHANNEL.md`(159) · `LOCAL_SOLO_ALPHA_ROADMAP.md`(137). 배너 없이 Swift 스택 전제: `DEPLOY.md`(892, MomoServer+OutboxRelay+AgentWorker 배포) · `BACKLOG.md`(1,224, Codex spine 백로그) · `HANDOFF_2026-07.md`(56) · `AWS_INTERNAL_ALPHA.md`(274) |
| claudedocs | 추적 39본 6,197줄(design-review REPORT 24 · e2e 리포트) + **미추적 2,329 파일 2.6G**(`.gitignore`는 png만 제외) |
| docs/archive | 5본 5,351줄(H1 BUILD_TICKETS·ROADMAP·STATUS-06/07) — 「attic」 |
| docs/planning/archive | JOURNAL-2026-07·08 · CURRENT_STATE-snapshots(월 로테이션 규칙의 산물) |

## 6. 은퇴 결정 흔적 (삭제 근거)

| 표면 | 결정 | 현 상태 |
|---|---|---|
| macOS SwiftUI·iOS 킷 클라 | ADR-0133 Accepted(2026-07-25) → W-S1 #1215 삭제 완료 | 트리 없음. 흔적: `docs/MACOS_ALPHA_UPDATE_CHANNEL.md`·`RELEASE_PLAYBOOK.md`·라벨 `area:ios` 15·`area:macos` 14 열린 이슈 |
| Swift 서버·워커·릴레이·서비스 | ADR-0145 Accepted(2026-07-30 Rust 재작성) · **증보 2**(2026-08-06, 상시 빌드·테스트 제외) · **증보 1**(2026-08-04, 삭제 게이트 = 「제품이 쓰기로 한 라우트」 parity 판정표 — 2026-08-09 감사: 보류 11패밀리 판정 없음 → 삭제 조건 미충족) · 성재 2026-08-10: 이식 티켓 순차 **#1255 PushRelay · #1256 WorkHostDaemon** = 마지막 Swift 소멸 경로 | 둘 다 OPEN. `Makefile` `swift-build/test` 「[은퇴 중]」 · TRACKS §1 「은퇴 중」 · `docs/RUN.md` 은퇴 배너 |
| `clients/mobile-spike` | ADR-0137: RN v0 parity 통과 시 킷 은퇴 → #1292 RN Work Console parity CLOSED | 참조: mobile 테스트 2본·package.json·Rust 시험 1본(문자열) |
| `clients/web-legacy` | ADR-0133/MOMO-596: v0 → legacy, 「parity 게이트 후 서빙 전환」 → Rust 이미지는 `clients/web` 번들(#1641 거짓 일소) | 서빙 0. CI 계약 레인 + local_gate `web` 프로파일이 아직 이걸 빌드 |
| NCP 운영 | 2026-08-26 NCP 완전 철수(#1802) · `docs/runbooks/ncp-rust-deploy.md` [은퇴] | `verify_ncp_centrifugo_*`·`test_ncp_centrifugo_boundary`는 SH-2가 공개 엣지 게이트로 재사용(이름만 NCP) |
| Codex 레인 | PIPELINE 2026-08-26 「Codex CLI 공식 은퇴」 · P2 `CODEX.md`→`AGENTS.md` 병합(2026-09-02) | `CODEX.md` 4줄 스텁(GATED_DOCS 호환) · `.codex/environments` · `ISSUE_TEMPLATE/codex-goal.md` · `mock_codex_app_server.py` · `adapters/codex-workbench`(workd 엔진) |
| E2B(ADR-0142)·`clients/Core` | 은퇴 완료 | 잔재 없음(문서 언급만) |

## 7. CI·게이트가 붙드는 것 (지우면 깨질 자리)

### 7.1 `.github/workflows` 5본
`pr-ci.yml` 레인: 경로 선택 → canonical track alignment → gitleaks → **cargo test + cargo-deny** → **TS typecheck/test(momo-core·web·mobile) + npm 라이선스** → **`OpenAPI ↔ web-legacy generated contract`**(`npm ci --prefix clients/web-legacy` + `verify_web_generated_types.sh`) → PR CI gate. Swift 레인 **없음**(경로 필터가 Swift 4트리를 「docs-only」로 취급). `policy-integrity.yml` · `publish-images.yml`(Rust 이미지+legal 번들) · `release-desktop.yml` · `track-alignment.yml`. `dependabot.yml`: web-legacy·examples 항목(열린 PR #1355~1357·#673·#674).

### 7.2 `scripts/local_gate.sh`(1,575줄)
- 프로파일: `docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|m3-…|web|all…`. **`swift` 프로파일 + runtime 계열 7곳이 `add_swift_commands`(`make swift-build/test`)** 를 부른다.
- `web` 프로파일 = **`clients/web-legacy`** install/lint/test/typecheck/build + `verify_web_generated_types` + `verify_web_serving`/`verify_web_login_smoke`(Swift e2e 컴포즈). `--auto`는 `clients/web/*` 변경을 `all`로 넓힌다(「web 프로파일이 아직 legacy를 겨눈다」 주석).
- 정적 블록이 참조: `infra/prod/centrifugo.prod.json`(json) · `infra/prod/docker/internal-smoke-migrate.sh`(bash -n) · AWS internal alpha preflight(`infra/prod/aws-internal-alpha.env.example`) · `check_compose_env_templates.sh`(문서화된 컴포즈 8본) · `verify_ncp_centrifugo_contract`·`test_ncp_centrifugo_boundary` · `verify_eve_profile --config-only` · `verify_pgvector_contract` · `test_make_deploy_bundle`(`make_deploy_bundle.sh`) · `test_publish_images_contract.py` · `check_docs_commands.py` GATED_DOCS(`AGENTS.md`·**`CODEX.md`**·**`docs/RUN.md`**·RELEASING·NEXT_CHANNEL·CONTRIBUTING·SELF_HOST_AGENT + runbooks/*) · adapters/prime·hermes 문법 · Swift 전용 verifier 58본 `bash -n`.
- `gate_oort_user_facing.sh`는 Swift 5트리 + `clients/web-legacy/index.html` 타이틀을 스캔한다.
- 최근 30일 실사용 프로파일(JOURNAL·claudedocs·STATUS 언급): `web` 3 · `docs` 2 · `macos-ui` 2 · `license` 1 · `huddle` 1. **runtime-*·swift 프로파일 언급 0.**

### 7.3 실 병합 권위
`verify_merge_tree.sh`(8레인: cargo·TS·lint·폰·게이트 스위트) + CI 3레인. **Swift 0, web-legacy 1(CI 계약 레인).** 2026-08-09 감사 판정과 동일: 「병합 권위에는 Swift가 0이지만 local_gate 메뉴와 verifier는 여전히 빌드한다 — 죽은 참조가 아니라 살아 있는데 안 돌리는 참조」.

### 7.4 Makefile
`build/test` = Rust+TS(현행) · `swift-build/test` 「[은퇴 중]」 · `migrate`(server/Migrations) · `up/down`(`infra/docker-compose.yml` — Swift 시대 로컬 스택: postgres·centrifugo·livekit·transcription-redis·livekit-egress·eve) · `local-alpha*`.

## 8. 라이브 의존 실측 (통삭제 금지 — 부분 삭제·이전 필요)

| 자산 | 누가 쓰나 | 처리 |
|---|---|---|
| `server/Migrations/**` 86본 | 정본 DDL(`check_migration_numbers`·`momo-migrate`·`make migrate`) | **절대 유지** — `server/`는 Sources·Tests·Fixtures·Package.swift만 삭제 |
| `infra/prod/*.sql` 4본(`bootstrap_runtime_roles`·`set_initial_owner`·`bootstrap_owner_if_absent`·`bootstrap_owner_claim_if_absent`) | `server-rust/Dockerfile:221-225` COPY · `momo-migrate/src/main.rs` 경로 상수 12곳 | `infra/rust/sql/`로 이전 후 나머지 infra/prod 삭제 |
| `relay/PushRelay` + `services/MomoMetrics`(경로 의존) | `infra/rust/docker-compose.push.build.yml`(빌드) · `docs/PUSH_RELAY_RUNBOOK.md` · Rust `momo-notifier`는 클라이언트 절반만 보유(APNs 송신 서버 없음) | #1255(OPEN). 배포 실체: NCP 철수 후 Dawn 운영 relay 없음(확인 요) |
| `workers/WorkHostDaemon`(momo-workd) | T3/CubeSandbox 실기동 종착 데몬(#1256 OPEN) · `adapters/codex-workbench` 엔진 · `infra/workd` · `verify_work*`/`t3_*`/`workd*` 검증기 | 성재 결정 포인트(ADR-0183 D4) |
| `services/LinkShort` | e2e 컴포즈 `linkshort` 서비스 · `infra/rust` 주석 | Caddy `redir` 1줄/Rust 라우트 1개로 대체 후 삭제(2026-08-09 감사 판정) |
| `docs/api/openapi.yaml` | `verify_openapi_contract_rust.sh`·`openapi_shape_check.py`·정적 파스 게이트 | 정본 유지. **생성 타입 소비자는 web-legacy뿐**(momo-core는 손수 쓴 `api.ts`) |
| `infra/docker-compose.e2e.yml` | Swift e2e(api/relay/worker/notifier `swift:6.2`) — verifier 66본·`verify_openapi_contract.sh` swift pass(강등) | #1022(레인 서버를 Rust e2e로) OPEN |
| `infra/cubesandbox` | Rust `momo-t3` provider·conformance | T3 결정과 함께 |
| `legal/`·`deny.toml` | `publish-images.yml` GHCR 고지 번들·라이선스 게이트 | 유지 |

## 9. 비대 파일 상위 (D 후보 — 삭제 아님)

| 줄 | 파일 |
|---|---|
| 14,543 | `clients/web-legacy/src/api/schema.d.ts`(생성물 — 삭제 대상) |
| 12,656 | `clients/web/scripts/capture-screens.mjs` |
| 4,969 | `server-rust/bins/momo-server/src/dto.rs` |
| 4,967 | `server-rust/bins/momo-server/tests/display_attach_conformance_pg.rs` |
| 4,733 | `server/Tests/MomoServerTests/MomoServerTests.swift`(삭제 대상) |
| 4,302 | `packages/momo-core/src/lib/api.ts` |
| 4,170 | `scripts/verify_openapi_contract_rust.sh` |
| 3,281 | `server-rust/bins/momo-agent-worker/src/lib.rs` |
| 3,200 | `clients/mobile/src/features/conversation/MessageRow.tsx` |
| 3,129 | `adapters/hermes/momo_adapter.py` |
| 2,837 | `clients/mobile/measure/surfaces.tsx` |
| 2,630 / 2,627 / 2,599 | `routes/messages.rs` / `momo-messaging/src/message.rs` / `momo-server/src/config.rs` |
| 2,465 | `clients/web/src/design/pressLedger.test.ts` |
| 2,037~1,192 | `clients/web/gates/gate-*.mjs` 13본(각 1.2~2k) |
| 1,575 | `scripts/local_gate.sh` |
| 1,745 / 1,224 / 1,132 / 906 / 892 | `docs/RUN.md` / `docs/BACKLOG.md` / `STATUS.md` / `docs/LOCAL_PR_GATE.md` / `docs/DEPLOY.md` |

## 10. 디스크(비-git, 참고)

`clients/desktop/src-tauri/target` 3.4G · `clients/mobile/node_modules` 507M · `clients/web/node_modules` 313M · `claudedocs/` 2.6G(미추적). 레포 경량화와 별개로 `momo-docker-reclaim`/worktree 회수 규율의 대상.

## 11. 열린 GitHub 상태 (2026-09-07)

열린 이슈 215(`status:ready` 87 · `blocked` 36 · `area:ios` 15 · `area:macos` 14) · 열린 PR 14(dependabot 13 + Cursor 환경 노트 1). Swift 은퇴 계열: #1255 PushRelay 이식 · #1256 workd 이식 · #1022 레인 Rust e2e 교체 · #1345 ACP 체인 재랜딩 감사 · #1610 stale 문서 스윕(in-progress).
