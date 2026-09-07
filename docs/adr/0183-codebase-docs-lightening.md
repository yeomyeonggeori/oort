# ADR-0183: 클린 슬레이트 경량화 — 은퇴 표면 삭제·이중 정본 해소·문서 로테이션 (LS 시리즈)

- 상태: **Accepted** (2026-09-07 성재 결재 — 「ADR-0183 Accept, 결정 5건 전부 권고안대로 진행. 애매한 지점은 물어볼 것. 작업이 1차 최종 목표(셀프호스팅 + 그록봇 연동 지원)에 초점을 두는지 점검할 것」. 기안 같은 날 Fable · momo-main. 결재 기록·정오표는 하단 「결재 기록」 절)
- 발제: 실측 `docs/planning/research/2026-09-07-clean-slate-inventory.md`(인벤토리) · `2026-09-07-clean-slate-candidates.md`(후보·판정) · 계획 `claudedocs/resume-2026-09-07/PLAN-clean-slate-diagnosis.md`.
- 관련: ADR-0145(Rust 재작성 · 증보 1 삭제 게이트 · 증보 2 상시 빌드 제외) · ADR-0133(Tauri) · ADR-0137(RN) · ADR-0119(web v0) · ADR-0120(PushRelay 경계) · ADR-0153(CI 스택) · ADR-0179~0182(출시 두 기둥) · `docs/TRACKS.md` · `docs/planning/PIPELINE.md` · #1255 · #1256 · #1022 · #1610 · 2026-08-09 Swift 삭제 감사(`research/2026-08-09-swift-removal-audit.md`).

## 맥락 (실측 요약)

추적 파일 3,416 · 코드 ≈768k LOC · 문서 107k LOC. 살아 있는 제품(Rust 서버 + React/Tauri/RN 클라 + momo-core + infra/rust 셀프호스트)은 이 중 약 3/4다. 나머지 1/4은 **결정은 났는데 트리가 남은 것**이다:

1. **Swift 4트리** `server/Sources·Tests·Fixtures·Package.swift`·`workers`·`relay`·`services` — 222파일 78k LOC. ADR-0145가 재작성을 결정했고(2026-07-30) 증보 2가 상시 빌드에서 뺐다(08-06). 삭제만 남았는데 **증보 1의 삭제 게이트(「제품이 쓰기로 한 라우트」 parity 판정표)가 보류 11패밀리에 대한 판정 없이 40일째 멈춰 있다**(2026-08-09 감사). 그 사이 게이트는 계속 이 트리를 붙든다: `local_gate.sh` `swift` 프로파일 + runtime 프로파일 7종이 `make swift-build`를 부르고, verify 스크립트 125본 중 66본이 Swift e2e 컴포즈를 띄운다(Swift 전용 60본 23.3k LOC). 최근 30일 그 프로파일의 실사용은 0회다. 실 병합 권위(`verify_merge_tree` 8레인 + CI)에는 Swift가 0이다.
2. **이중 정본**: `clients/web-legacy`(26.8k, 서빙 0, 생성 타입 소비자 0)를 CI 계약 레인 1개와 local_gate `web` 프로파일이 아직 빌드한다. `clients/mobile-spike`(19.6k)는 ADR-0137의 「RN parity 통과 시 은퇴」 조건이 #1292로 충족됐다. `infra/prod`(Swift 시대 운영 스택)·`infra/docker-compose.yml`·`docker-compose.e2e.yml`(Swift e2e)이 현행 `infra/rust`와 나란히 있다. 루트 은퇴 문서(`RUN.md` 1,745줄 등 4본 배너 + `DEPLOY.md`·`BACKLOG.md` 배너 없는 Swift 전제) · `CODEX.md` 스텁 · `.codex/`.
3. **문서 로테이션 부재**: 핸드오프 302본 중 닫힌 이슈·무참조 196본(8.2k줄) · `research/` 루트 112본(6월 아이데이션, ADR 인용 0 디렉터리 8) · `docs/planning/research` 살아 있는 참조 0 = 35본 · planning 루트 참조 0 = 22본 · `claudedocs` 추적 39본 + 미추적 2,329파일 2.6G · `docs/archive`(attic 5본).

이 상태의 비용: 새 세션·워커가 두 스택을 동시에 읽고(TRACKS §1이 「은퇴 중」을 매번 설명), 게이트 메뉴 절반이 죽어 있으며, 문서 링크 그래프의 1/3이 끊겨 있다. 출시 두 기둥(ADR-0179~0182 · Buzz급 UXUI + 프롬프트 하나로 설치되는 셀프호스팅)에 기여하지 않는 자산이다.

## 결정

### D1. 남기는 정본(「핵심」) 목록 — 이 목록 밖은 기본값이 삭제다
| 층 | 정본 |
|---|---|
| 서버 | `server-rust/**`(Rust/Axum 6 bins + crates) · **`server/Migrations/**`(DDL 정본, 이동 금지)** · `schema_v0.sql`(무접촉) |
| 배포 | `infra/rust/**`(셀프호스트 컴포즈·Caddy·pgBackRest) + `infra/rust/sql/`(신설 — infra/prod의 부트스트랩 SQL 4본 이전) · `infra/cubesandbox`(Rust momo-t3 substrate) · `scripts/oort`·`scripts/lib`·`scripts/self_host_*` · `publish-images.yml`·`legal/`·`deny.toml` |
| 클라 | `clients/web` · `clients/desktop`(Tauri) · `clients/mobile`(RN) · `packages/momo-core` |
| 에이전트 접속 | Rust Agent Port/MCP(ADR-0162) · `adapters/prime`(ADR-0158) · `adapters/hermes`(ADR-0004) |
| 게이트 | `pr-ci.yml`(cargo·TS·gitleaks·정책·alignment) · `verify_merge_tree.sh` 8레인 · `local_gate.sh`(`docs` + **`web`→`clients/web` 재조준** + Rust runtime 프로파일) · `clients/web/gates` · `scripts/verify_*_rust.sh`·`scripts/tests` 중 Rust/정적 게이트 |
| 문서 | 루트 `README·AGENTS·CLAUDE·CONTRIBUTING(+ko)·SECURITY·LICENSE·NOTICE·CHANGELOG·ROADMAP·STATUS·BUILD_TICKETS` · `docs/TRACKS·INDEX·RELEASING·NEXT_CHANNEL·SELF_HOST*(en 정본+ko)·SELF_HOST_AGENT(+ko)·GITHUB_OPS·MULTI_SESSION_OPS·LOCAL_PR_GATE`(뒤 셋은 Codex 문면 일반화·축약) · `PUSH_RELAY_RUNBOOK`(D4-①에 따름) · `docs/adr`(전량 — 결정 기록은 삭제하지 않는다) · `docs/architecture` · `docs/design-system`·`docs/ux-bible`·`DESIGN.md`(design-md 미러) · `docs/api` · `docs/cicd` · `docs/runbooks`(현행분) · `docs/legal` · `docs/planning/{README,PIPELINE,CURRENT_STATE,JOURNAL,DEVIATION_LOG,ENGINE_HANDOFF}` + 열린 이슈의 handoffs + ADR이 인용하는 research |

### D2. 판정 기준 5종을 그대로 채택한다(계획 §3) — A 결정 은퇴 표면=삭제 · B 접촉 없음+참조 0+게이트 미배선=삭제 · C 이중 정본=하나로 · D 비대=분해 티켓(삭제 아님) · E 로테이션=압축. 「attic」 디렉터리 금지: 지우거나 남긴다(git 히스토리가 보존). 각 삭제 PR = **삭제 + 실행 배선 참조 grep 0 + 게이트 초록**. 문서 본문의 역사적 언급(「Swift 시절에는…」)은 허용하되 **경로 링크는 살아 있거나 `<sha>:<path>` 고정 링크**여야 한다.

### D3. ADR-0145 증보 1의 삭제 게이트를 **「출시 범위 판정」으로 대체한다**
증보 1은 「보류 패밀리 전부에 판정이 내려졌을 때」 삭제를 허용했다. 이 ADR은 그 판정을 한 번에 내린다: **출시 두 기둥(G1·G2)이 쓰는 라우트 패밀리만 「이식 대상」이고, 그 밖의 Swift-only 패밀리는 전부 「폐기」**다. Rust에 이미 선 것(webhooks #1222 · Agent Port/MCP ADR-0162 · huddles ADR-0165 · attachments ADR-0151 · cancel #989 · work-controls/auto-approvals)은 그대로, Swift에만 남은 것(plugins 레지스트리 v0 · memories/policy/consent · context-packets v0 · bans · event-subscriptions 잔여 · usage/quota 스냅샷 · workstream continuity …)은 **출시 뒤 필요가 증명될 때 Rust로 새로 설계**한다(Swift 원문은 git 히스토리 `f399e417` 이전에서 읽는다). 이 판정표는 이 ADR의 부록 A이며 LS-1 워커의 첫 과업이 실측(Rust 라우트 vs Swift-only 83경로 재대조)으로 부록을 채우는 것이다.

### D4. Swift 4트리를 삭제한다 — 단, 두 컴포넌트는 성재 결정 뒤에
- 즉시 삭제: `server/Sources·Tests·Fixtures·Package.swift` · `workers/AgentWorker`·`workers/NotifierWorker` · `relay/OutboxRelay` · `services/CloudProviderKit`·`OutboundHTTPPolicy` · `.swift-version` · Swift e2e 컴포즈 서비스(api/relay/worker/notifier) · `infra/prod/docker/*.Dockerfile`·compose·`install/upgrade/momo-ops/deploy-lib.sh` · `scripts/fixtures/ios-push-sample.apns`.
- **결정 포인트 ①(PushRelay)** — `relay/PushRelay`+`services/MomoMetrics`: 권고 = **지금 삭제**하고 #1255(Rust 이식)를 M1 폰 파도(G3) 전제로 재편성. 근거: 출시 정의(G2)에 폰이 없고(편성 정본 §6), 저널·런북에 살아 있는 relay 배포 기록이 없으며(NCP 철수 뒤 실체는 결재 기록 참조), ADR-0120의 경계 설계와 Rust `momo-notifier` 클라이언트 절반은 살아 있다. 대안 = 유지 후 #1255 완료 시 삭제(Swift 툴체인·`docker-compose.push.build.yml` 유지 비용 지속).
- **결정 포인트 ②(work host)** — `workers/WorkHostDaemon`(momo-workd) + `adapters/codex-workbench` + `infra/workd` + `verify_work*/t3_*/workd*` 검증기: 권고 = **삭제**하고 #1256·#1927을 「출시 후 Rust 사이드카」 ADR 1건으로 병합. Rust 측(`momo-t3` crate · `work_sessions.rs` · `infra/cubesandbox` · 웹 `work`·`workConsole`·`workstreams`·`ade` 표면)은 **유지**(데몬 부재 = 「work host 미연결」 상태로 동작, 이미 그 상태). 대안 = Swift workd 유지(T3 실기동 데모 가능, 단 Swift 툴체인·29 .swift·엔진 어댑터 4종 유지).
- `services/LinkShort`: Caddy `redir` 1줄로 대체 후 삭제(LS-1 안에서).

### D5. 이중 정본 해소
- `clients/web-legacy` 삭제 · CI 「OpenAPI ↔ web-legacy generated contract」 레인 제거(스펙 파스·`openapi_shape_check`·`verify_openapi_contract_rust`가 대체 — 생성 타입 소비자 0) · local_gate `web` 프로파일을 `clients/web`(lint/typecheck/test/build)로 재조준 · dependabot 항목·PR #1355~1357 close · `NOTICE`·`.dockerignore`·`.gitleaksignore`·`gate_oort_user_facing.sh` 정리.
- `clients/mobile-spike` 삭제(참조 4곳 정리).
- `infra/docker-compose.yml`(Swift 시대 로컬 스택)·`docker-compose.e2e.yml`(Swift e2e) → **`infra/rust` 단일 정본**. #1022(레인 서버 Rust e2e 교체)는 「Swift e2e를 지우고 Rust e2e 오버레이 1본을 세운다」로 재정의. `Makefile` `up/down`은 `infra/rust`를 가리킨다.
- `CODEX.md`·`.codex/`·`ISSUE_TEMPLATE/codex-goal.md`(→`goal.md` 일반화)·`mock_codex_app_server.py` 정리, `check_docs_commands.py` GATED_DOCS에서 `CODEX.md`·`docs/RUN.md` 제거.
- NCP 이름의 게이트(`verify_ncp_centrifugo_*`·`test_ncp_centrifugo_boundary`)는 SH-2 이후 공개 엣지 게이트이므로 **개명**(`verify_public_edge_centrifugo_*`)하고 `docs/runbooks/ncp-rust-deploy.md`·`infra/rust/pgbackrest-s3*`의 NCP 문면은 일반 S3로.

### D6. 문서 로테이션 규칙(상설)
- **핸드오프 패킷은 이슈가 열려 있는 동안만 `docs/planning/handoffs/`에 산다.** 이슈 close 시 다음 플러시에서 삭제(git 히스토리 = 아카이브). 닫힌 이슈·무참조 196본을 LS-4에서 일괄 삭제.
- 리서치(`docs/planning/research`·`research/`)는 **Accepted ADR·architecture·design-system이 인용하는 것만** 남긴다. 인용되지 않는 리서치는 결정에 흡수된 것이므로 삭제. `research/` 루트는 ADR·architecture·design-system 인용 파일만 **제자리에** 남기고 나머지를 삭제한다(정오표 2026-09-07: 이동·합류는 80본 ADR의 링크 churn을 만들므로 하지 않는다).
- `STATUS.md`·`JOURNAL.md`·`CURRENT_STATE.md`는 **월 단위 1파일**로 `docs/planning/archive/`에 로테이션(기존 규칙 확장 — STATUS도 포함). `docs/archive/`(H1 attic)는 삭제, 그 안의 `STATUS-2026-06/07`은 `docs/planning/archive/`로.
- `claudedocs/`는 세션 스크래치다: **전량 `.gitignore`**, 추적 39본 삭제(검수 REPORT는 PR 본문·코멘트가 정본).
- 루트 은퇴 문서(`docs/RUN.md`·`RELEASE_PLAYBOOK.md`·`MACOS_ALPHA_UPDATE_CHANNEL.md`·`LOCAL_SOLO_ALPHA_ROADMAP.md`·`HANDOFF_2026-07.md`·`DEPLOY.md`·`BACKLOG.md`·`AWS_INTERNAL_ALPHA.md`·`docs/specs/04-context-packet-v0.md`·`runbooks/ncp-rust-deploy.md`)는 삭제하고 `INDEX.md`를 D1 목록으로 재작성. `SECRETS_BACKUP_RUNBOOK`(Swift 전제 38곳)·`INTERNAL_ALPHA*`·`LOCAL_3_DAY_ALPHA_TEST_PACK`·`WORK_HOST_QUICKSTART`·`AGENT_HOSTING_QUICKSTART`·`BYOC_CLOUD_HOST`·`QA_GATE`·`INBOUND_MCP`·`IOS_TESTFLIGHT_RUNBOOK`·`docs/cicd/04·09-*codex-tickets`·`docs/external-agent-provider/*`·`runbooks/turn-host-install`·`aws-internal-alpha-deploy`는 LS-3 워커가 Swift 전제 문장 수로 실측해 「SELF_HOST로 흡수 / 삭제 / 유지」를 PR에 표로 제시한다(#1610 흡수).

### D7. 비대 파일은 이 ADR의 범위 밖 — 티켓만 발행(D)
`capture-screens.mjs` 12.6k · `clients/web/gates` 46본 ≈35k(공통 하네스 lib) · `local_gate.sh` 1.6k(프로파일 메뉴 → 현행 5개로 축소는 LS-0에 포함) · `dto.rs` 5k · `api.ts` 4.3k · `MessageRow.tsx` 3.2k · `momo_adapter.py` 3.1k · `verify_openapi_contract_rust.sh` 4.2k. 출시 파도 편성 시 D 시리즈로.

### D8. 이슈 위생
`area:ios`·`area:macos` 라벨의 열린 이슈 29건은 planner가 한 건씩 「RN/웹으로 이관(라벨 교체) / 은퇴 close」 판정 — 워커 아님(LS-5). Swift 계열 열린 이슈 재정의: #1255·#1256(D4) · #1022(D5) · #1345(T3 결정 뒤) · #1610(LS-3 흡수 close).

### D9. 불변
하드 룰 6개 · `schema_v0.sql` 무접촉 · `server/Migrations` 이동 금지 · 보호 경로(`scripts/**`·`.github/**`·AGENTS/TRACKS) 변경은 정책 감사 · 트랙 파이프라인(track → 승격 → sync 짝) · 시크릿 비유입. 삭제 PR도 워커는 merge/close 금지.

## 기각 대안

- **증보 1 판정표를 패밀리별로 마저 채운 뒤 삭제**: 40일간 진행 0. 판정 주체(성재)가 「clean slate」로 방향을 정했으므로 패밀리 단위 판정은 출시 범위 한 줄로 대체한다.
- **`attic/` 또는 `legacy/`로 이동**: 트리를 옮겨도 게이트·문서 링크·워커의 읽기 비용은 그대로다. git 히스토리가 원문을 보존한다.
- **Swift를 Rust 이식 완료(#1255·#1256)까지 유지**: 이식 자체가 출시 범위 밖(폰 푸시 = G3, work host = 출시 후). 유지 비용(툴체인·컴포즈·verifier 60본·TRACKS 설명)을 출시까지 계속 지불하게 된다. → D4 결정 포인트로 성재에게.
- **문서는 전부 남긴다(「언젠가 참고」)**: 참조 0 문서는 이미 아무도 읽지 않는다는 실측이다. ADR이 인용하는 것만 남기면 결정 근거 추적은 유지된다.

## 영향·게이트

- **LS-0(정책 감사 1회)**가 선행: `local_gate.sh`(swift 프로파일·`add_swift_commands`·web 프로파일 재조준·정적 블록의 infra/prod·NCP 개명·bash -n 목록·GATED_DOCS) · `pr-ci.yml` 레인 제거 · `dependabot.yml` · `Makefile` · `server-rust/Dockerfile`+`momo-migrate` SQL 경로(`infra/rust/sql/`) · Swift 전용 verifier 60본 + 실행 배선 0 스크립트 25본 + `spikes/` 삭제 · `gate_oort_user_facing.sh` 스캔 루트 · `check_compose_env_templates.sh` 컴포즈 목록. 이 PR이 초록이면 이후 삭제 PR은 보호 경로를 만지지 않는다.
- CI 레인 수 5 → 4(`web-legacy` 계약 레인 제거). `verify_merge_tree` 8레인 불변.
- 예상 감량(후보 문서 §4 합계): **파일 ≈850(25%) · LOC ≈200k(23%) · 문서 ≈45k줄(40%)**. Swift LOC 78k → 0(결정 포인트 ①②가 「유지」면 각 2.7k·22k 잔존).

## 이행 — LS 시리즈 (파도 단위, 병렬 2, 각 PR = 삭제 + grep 0 + 게이트 초록)

| 티켓 | 트랙 | 내용 | 크기 | 선행 |
|---|---|---|---|---|
| **LS-0 게이트 재배선** | engine(정책 감사) | 위 「영향·게이트」 전항 + SH 시험 3본(`test_oort_*`·`test_public_edge`) local_gate 편입(#2124) | L | ADR Accept |
| **LS-1 Swift 은퇴** | engine | D4 즉시 삭제분 + 결정 ①② 결과 + LinkShort→Caddy redir + `infra/prod`(SQL 이전 후) + Swift e2e 컴포즈 + `openapi_server_routes.py`·`verify_openapi_contract.sh` swift pass 제거 + TRACKS §1 「은퇴 중」 문면 삭제 + 부록 A 실측 | L | LS-0 |
| **LS-2 클라 이중 정본** | uxui | `clients/web-legacy`·`clients/mobile-spike` 삭제 + 참조 4+25곳 정리 + dependabot PR 5건 close | M | LS-0 |
| **LS-3 은퇴 문서** | engine(docs) | D6 루트 은퇴 문서 삭제·흡수 표 + `INDEX.md`·`README` 디렉터리 절 재작성 + `CODEX.md`·`.codex`·템플릿 일반화 + NCP 문면 | M | LS-0 |
| **LS-4 로테이션** | engine(docs) | handoffs 196 · planning 루트 22 · planning/research 35 · `research/` 비인용 ≈90 · `claudedocs` 39+gitignore · `docs/archive` 해체 · STATUS 2026-08 로테이션 · D6 규칙을 `docs/planning/README.md` §2에 성문 | M | ADR Accept(LS-0과 독립) |
| **LS-5 이슈 위생** | planner | D8 | S | LS-1 |
| LS-6 D 티켓 발행 | planner | D7 목록을 이슈로 | S | — |

순서: LS-0 → (LS-1 ∥ LS-2) → (LS-3 ∥ LS-4) → LS-5·6. LS-4는 LS-0과 독립이라 첫 파도에 LS-0 ∥ LS-4로 시작해도 된다. 각 랜딩 뒤 승격 + sync 짝. 완료 조건: `git grep -lE 'server/Sources|workers/|relay/|services/|web-legacy|mobile-spike|infra/prod|swift'`가 ADR·JOURNAL·archive 밖에서 0.

## 성재 결정 포인트 (Accept 시 함께)

1. **D4-①** PushRelay 지금 삭제(권고) vs #1255 완료까지 유지.
2. **D4-②** WorkHostDaemon·T3 데몬 삭제(권고, Rust 측 유지) vs Swift workd 유지.
3. **D6** `research/` 루트 = ADR 인용분만 보존(권고) vs 전량 보존.
4. **D6** `claudedocs/` 전량 gitignore(권고).
5. LS-0 정책 감사를 planner(Fable) 자율 집행에 포함할지(권고: 기존 위임 범위 — 랜딩 단위 승격 — 안에서 집행, 감사문은 PR에 첨부).

## 부록 A — Swift-only 라우트 패밀리 판정표 (LS-1이 실측으로 채움)

실측(삭제 직전, 2026-09-07): Swift `/v1` unique **169**, Rust `/v1` unique **183**. 위치 기준 대조. D4-② 채택: workd 미이식 경로는 **폐기**(출시 후 Rust 사이드카 ADR).

| 패밀리 | Swift-only 경로 수 | Rust 존재 | 이 ADR 판정 | 근거 |
|---|---|---|---|---|
| memories | 9 | 없음 | **폐기** | D3 · 출시 두 기둥 밖 |
| memory-policy | 2 | 없음 | **폐기** | D3 |
| memory-external-provider-consent | 2 | 없음 | **폐기** | D3 |
| plugins 레지스트리 v0 | 6 | 없음 | **폐기** | D3 |
| workstreams | 3 | 없음 | **폐기** | D3 |
| platform (invites/members/workspaces) | 3 | 없음 | **폐기** | D3 |
| work-pool | 2 | 없음 | **폐기** | D3 |
| context-packets v0 | 1 | 없음 | **폐기** | D3 |
| audit | 1 | 없음 | **폐기** | D3 |
| huddles 잔여 (recordings, recording-consent) | 2 | huddles 본선은 있음 | **폐기** | D3 · 본선은 ADR-0165 이식 완료 |
| mcp 잔여 (`/v1/mcp`, tools, drive, tools/call) | 4 | Agent Port MCP는 별도 | **폐기** | D3 · 본선 Agent Port/MCP는 ADR-0162 |
| work-tool-profiles CRUD | 3 | GET만 | **폐기** | D3 |
| agents from-card | 2 | agents 본선 있음 | **폐기** | D3 |
| cost-snapshots | 1 | 없음 | **폐기** | D3 |
| native webhook receive `POST /v1/webhooks/:ws/:installation` | 1 | webhooks 본선 있음 | **폐기** | D3 · 본선 #1222 |
| provider quota-snapshots POST | 1 | GET 등 본선 있음 | **폐기** | D3 |
| workspaces PATCH | 1 | GET/POST 있음 | **폐기** | D3 |
| work-hosts 미이식 5 (`live-sessions`, `reconcile`, cloud pause/resume/destroy) | 5 | work-hosts 11경로 이식 | **폐기** | D4-② · `work_host_auth.rs` still-unported two(live-sessions+reconcile) + cloud 3 |
| work-controls · work-auto-approvals · webhooks · Agent Port/MCP · attachments · cancel · huddles(ADR-0165) | — | 섬 | 이식 완료 | 실측 both/rust_only |

## 결재 기록 (2026-09-07)

- **Accept** + 결정 포인트 5건 전부 권고안 채택: ①PushRelay·MomoMetrics 지금 삭제(#1255는 M1 폰 파도 전제로 재편성) ②WorkHostDaemon·codex-workbench·infra/workd 삭제, Rust `momo-t3`·work 라우트·웹 work 표면 유지(#1256·#1927 → 출시 후 「Rust 사이드카」 ADR 1건) ③`research/` 루트 = ADR·architecture·design-system 인용분만 제자리 보존 ④`claudedocs/` 전량 gitignore ⑤LS-0 정책 감사는 planner(Fable) 상시 위임 범위 안에서 집행(감사문 PR 첨부).
- **초점 지시**: 모든 LS 작업은 1차 최종 목표(셀프호스팅 + 그록봇 연동 지원)에 기여하는지 점검한다 — 점검표는 `docs/planning/2026-09-07-lightening-program.md` §1. Agent Port·hosted agent 검증기·`scripts/oort`·`infra/rust`·`SELF_HOST*` 문서는 LS 전 파도에서 **무접촉**.
- 이행 티켓: **LS-0 #2142** · **LS-4 #2143**(첫 파도, 병렬 2). LS-1·2·3은 LS-0 랜딩 뒤 패킷과 함께 발급.
- 전제 확인 요청(미확인): D4-①의 「relay 배포 실체 없음」은 저널·런북 기록 부재로 추정한 것이다. 살아 있는 Dawn relay가 있다면 삭제 전 정지·기록이 선행돼야 한다.
