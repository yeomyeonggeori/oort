# oort 진행 현황

## 생성기 `--platform host-network` (#2340, 2026-09-10)

- Track engine. `feat/2340-platform-host-network` onto `origin/track/engine`. `platform_profiles` T1 행 `host-network`: 내부 URL 4키를 `127.0.0.1:<compose port>` 로 파생하고 `infra/rust/docker-compose.host-network.yml` (`network_mode: host`, 서비스당 1회·12) 을 렌더. `--compose` 가 스탬프를 보고 오버레이를 붙인다. 기존 railway/fly/aws-lightsail/gcp-vm 출력 바이트 불변.
- `docs/SELF_HOST_AGENT.md`(+ko) §3.3.0 대안 (b)/(c)를 `--platform host-network` 로 정정. 하네스 메모는 `scripts/dev/grokbot_cdp/README.md`. §3.3.14 우회 기록 유지.
- runtime-unverified: Grok Bot VM에서 bridge 차단 + 이 행으로 재설치 e2e (E2E-A 후속). 로컬은 `docker compose … config` 스모크.

## SH-12d-w no-active-agent hold (#2335, 2026-09-10)

- Track UXUI. `fix/2335-no-active-agent-hold` onto `origin/track/uxui`. `decideWelcomeMount`에 `no-active-agent`: 클라 디렉터리 활성 에이전트 0명이면 kickoff-hold를 즉시 풀고 UX-R2c `FirstAgentStage`로 진입(120s 백스톱 0회). ≥1명이면 hold→오프너 불변. 새 API 없음. 순서 `kickoff → first-agent → phone-link` 불변.
- 검증: RTL+가짜 타이머(0명 ≤2s FirstAgentStage·백스톱 0 · 1명 hold 회귀+오프너) · 사보타주 2건 RED 후 복구.
- runtime-unverified: 실셀프호스트 claim→0명 워크스페이스 왕복은 mock 범위.
## SH-12d-e 첫 에이전트 활성 전이 오너 킥오프 (#2334, 2026-09-10)

- Track engine. `feat/2334-kickoff-first-agent` onto `origin/track/engine`. ADR-0185 D-C (c2): `resolve_welcome_target_in_tx`가 처음 배달 가능한 Some이 되는 전이(네이티브 `POST …/agents` · hosted `detected→active`)에서 오프너 마커가 없는 오너 1인에게 웰컴 킥오프 enqueue. 사람 첫 합류 트리거(D2) 유지. 시스템 라인 없음.
- R2: hosted opener는 mentions와 같은 gateway 레일(run in-tx · inbox · `method=gateway`). 배달 불가면 마커를 쓰지 않음. `pg_advisory_xact_lock(hashtext(opener key))`. provider_required 완료는 opener 마커가 아님. native `#general` join은 오프너 speaker만, audit `channel_memberships_created`가 그 수를 반영.
- 멱등: `welcome:{ws}:{owner}:opener:v1`. 오너 탐지 = 가장 먼저 만들어진 active human owner.
- runtime-unverified: 실스택 셀프호스트 first-agent 왕복(웹 SH-12d-w). PG conformance는 로컬 throwaway PG.

## SH-12c 온보딩 S2 「팀원 초대」 (#2333)

- Track UXUI. `feat/2333-onboarding-s2-invite` onto `origin/track/uxui`. claim 성공 뒤 S2 「팀원 초대」 1장(카운터 2/2). skip 「나중에」 상시, 재진입 「설정 › 멤버와 초대에서 언제든」. 발급은 기존 `POST /v1/workspaces/{ws}/invites`(TTL 24h·1회). S1(#2332) 미랜딩 — 스테이지 표는 2칸, 마운트는 invite만.
- R2: claim hold는 await 앞(ConnectPage 동형). first-run 마커는 S2 전에 기록하고 `oort.onboarding.v1` pending으로 리로드 재진입. 카드 `max-w-sm` · 제목/리드 형제 클래스 · 오류는 「설정 › 멤버와 초대에서 다시」. runtime-unverified: 실서버 claim→S2 왕복은 mock·RTL 범위.
## SH-12b-e workspace rename + self handle (#2331, 2026-09-09)

- Track engine. `feat/2331-workspace-rename-handle` onto `origin/track/engine`. E1 `PATCH /v1/workspaces/{ws}` `{name, updatedAtMs}` (owner/admin, slug immutable, stale 409, audit `workspace.renamed`). E2 `PATCH …/members/me` `handle` (join normalize, `member_handle_uniq` 409 `handle is already in use`, audit `member.handle_changed`, past `@oldhandle` bodies untouched). OpenAPI + `@momo/core` `renameWorkspace` / `changeMyHandle`. No migration.
- 검증: `workspace_rename_conformance_pg` · `self_rename_conformance_pg` (각 상태코드 단정 + 메시지 본문 diff-0) · `scripts/verify_openapi_contract_rust.sh` · 사보타주 3건 RED 후 복구.
- runtime-unverified: 없음 (로컬 PG 15432 컨벤션).

## SH-11e day-2 계약 v2 T2 (#2325, 2026-09-09)

- Track engine. `feat/2325-day2-v2` onto `origin/track/engine`. T2: backup/restore는 `MIGRATE_DATABASE_URL`만, doctor `stack.*`는 SQL-over-URL + 공개 `/healthz`(`schema.{applied,head}` 추가), upgrade는 플랫폼 digest 교체 명령을 인쇄한다. T1 경로 바이트 불변(기존 day2 10·doctor 15 케이스 GREEN 유지, 신규 +6/+3).
- R2: T2 origin picker가 tauri/loopback을 건너뛴다(Railway `http://tauri.localhost`를 `/healthz`로 쓰지 않음). 스탬프 없는 env의 `--tier t2`는 수용, 충돌 스탬프는 거절. 검증: day2 23 · doctor 21 · check id 32==T1.
- 검증: `scripts/tests/test_oort_day2.sh` 23 · `test_oort_doctor.sh` 21 · check id 32==T1 · dump >0바이트 · TOC T1=T2. 이미지 `/opt/momo/scripts/oort`. 호스트 `pg_dump` 18.4 vs 픽스처 PG18.
- runtime-unverified: Railway one-off 실측은 SH-11a(planner). `/healthz` 필드 이름은 성재 리뷰.

## UX-R2c·SH-6a-w design-review 잔여 (#2256, 2026-09-09)

- Track UXUI. `feat/uxr2c-followup` onto `origin/track/uxui`. UX-R2c R7 M-8/N-13/N-14 + SH-6a-w R7-N4.
- 첫 에이전트 보상 이름·핸들은 `features/hostedAgents/TruncatingName` 을 재사용한다 (`scrollWidth > clientWidth` 일 때만 `title`). 길이 16 휴리스틱·`FIRST_AGENT_GENERIC_HINT` 삭제. `parseDisconnectStart` 는 서버 `cleanup_pending` 을 그대로 돌리고, 웹 해제 시작 렌더 시험은 GET 을 멈추어 파서 결과를 그린다.
- runtime-unverified: 실서버 hosted create/detect/disconnect 왕복은 mock·캡처 범위. `capture:design` 은 `verify_merge_tree.sh`·`local_gate.sh`·CI 에 없음 — 별건.
## E2E-B 문서 정정 + 신규 env hosted delivery 기본값 (#2263, 2026-09-09)

- Track engine. `docs/2263-e2e-b-corrections` onto `origin/track/engine`. SELF_HOST(+ko) D1/D3/D4/D6/D9, SELF_HOST_AGENT(+ko) §3.3.17.2, OpenAPI `CreateAgentRequest.baseUrl`(ADR-0004 증보) + `POST …/channels/{channelId}/members`. 생성기 신규 env만 `MOMO_HOSTED_DELIVERY_ENABLED=true`(기존 env 무접촉, Railway 41키 유지).
- 검증: `scripts/tests/test_self_host_env_modes.sh`(신규 true · 기존 무백필 · 사보타주 RED) · `scripts/verify_openapi_contract_rust.sh --verify-cleanup-contract` · `scripts/local_gate.sh --profile docs`.
- runtime-unverified: 실스택에서 신규 env 기본값으로 Agent Port `tools/list` 비지 않음은 E2E-B 런 뒤 문서화 범위(측정은 research/2026-09-09-e2e-b-selfhost-run.md). D4 후속은 #2231.

## doctor/status `stack.outbox` 판정 (#2264, 2026-09-09)

- Track engine. `fix/doctor-outbox-verdict` onto `origin/track/engine`. Isolated compose `oort2264d` (did not touch `oortv013`): first `docker compose exec postgres psql` while health=`starting` is rc=2 / empty stdout (`socket ... No such file or directory`); empty `GROUP BY` is also empty stdout rc=0; measured TSV `push_candidate|pending|4` + `agent_job|pending|1` classified **fail** with 「값 미나열」.
- Fix in `scripts/lib/oort_doctor.sh`: unconfigured `push_candidate` pending is **info** (count); configured still **fail**. `agent_job` pending age (`lease_acquired_at` else `created_at`) `<5m` info / `≥5m` major, values listed (`kind|status|count max_age=`). Empty successful query is pass. Exec failure skip names 「postgres 컨테이너가 아직 준비되지 않음(재시도)」 or migrate-대기. `scripts/tests/test_oort_doctor_outbox.sh` 3 fixtures + unconfigured-branch sabotage RED.
- runtime-unverified: full local-build bring-up of doctor-then-status on a product stack (reproduced the two oracles on postgres-only `oort2264d`).
## #2260 day-2 `oort upgrade --local-build` rebuilds (engine, 2026-09-09)

- Track engine. `fix/oort-upgrade-local-build` onto `origin/track/engine`. Local-build (`--local-build` or env `MOMO_SELF_HOST_MODE=local-build`) skips `compose pull`, runs `compose build` then `up -d --wait`, waits for `IDEMPOTENCY_OK`, then doctor PASS. Digest `--to`/`--manifest` still pulls. Failure prints checkout-or-`restore` (not the failed `upgrade --local-build`). Red proof: `scripts/tests/test_oort_upgrade_localbuild.sh`. Isolated live upgrade transcript is in the PR. `oort-e2eb`/`oortv013` untouched. `stack.outbox` fail-row wording is #2264.

## UX-R2c 온보딩 「첫 에이전트 연결」 퍼널 (#2216, 2026-09-09)

- Track UXUI. `feat/uxr2c-first-agent-funnel` onto `origin/track/uxui`. 로그인 뒤 first-run = 킥오프(ADR-0181) → 첫 에이전트 카드 4종 → 폰 연결(M0w). 카드는 `HOSTED_PRESETS` + `ChoiceList`, 발급은 `HostedAgentWizard(entry="settings")`, 1회용은 `OneTimeSecretCard`, 감지는 hosted `get` 지수 백오프(2s→30s, 상한 5분). 「나중에」 상시. ConnectPage 4/4 무접촉.
- R7 (R6 FAIL B0·H1·M1·N4). 보상 열 `min-w-0`/`truncate`/`title`(길이 N) 는 렌더 DOM 가드 — 가짜 geometry 삭제. Claude/Codex 설명은 서로 다른 한 줄(금지: 아래/이 순서로/다음 단계/두 화면). legend 「무엇을 붙이나요」. `done-handoff` 는 실제 hover toolbar 셀렉터. 빈 detail 은 원소 존재 먼저.
- R6 (R5 FAIL B1·H1·M1·N5). 캡처 detected 가드는 `vi.stubEnv("MODE")` 행동 시험(production 전 포즈 null, design 은 `done` 만). 보상 행은 `min-w-0`/`w-full` + 이름 `truncate`/`title`. MCP 문장은 Claude/Codex `detail` 만, OpenAI 는 설정 › AI 연결. `done-handoff` 는 포인터를 치운 뒤 찍는다. 죽은 `formatRecheckStill` 삭제. 잠금 opacity 는 class/`aria-disabled`(jsdom) + 캡처 computed.
- R5 (R4 FAIL B0·H3·M5·N3). 카드 줄은 이름(+미확인 주)만 — generic 단계는 그룹 힌트 한 번. 「다시 확인」은 detecting 폴링을 재개(2s→30s, 상한 리셋). `done` 샷은 보상 화면을 먼저 찍고 채널은 `done-handoff`. 한 ChoiceList·네 옵션. aria 잠금은 컨트롤만 `opacity-50`, 이름은 `text-ink-muted`. 잠긴 「계속」은 `aria-disabled:active:transform-none`. 빈 detail 은 묶지 않음. 캡처 픽스처는 `HOSTED_AUTH_MODE`/`HOSTED_AGENT_PORT_AUDIENCE`.
- R4 (R3 FAIL B1·H1·M6·N3). 「계속」 잠금은 `aria-disabled`+`opacity-50`+`pointer-events-none` 렌더 가드. 핸드오프는 화면과 같은 `hintedAgentMemberId` 로 초안을 심는다. 카드 두 줄은 프리셋 단계가 다르다. MCP 힌트는 세 장만, OpenAI 는 자기 그룹. aria 잠금은 사유를 흐리지 않는다. 멘션 재진입은 tap-target. 다시 확인 결과는 리드를 반복하지 않는다.
- R3 (R2 FAIL B2·H5·M7·N4). 발급·감지 뒤 roster invalidate + `agentMemberId` 만으로 멘션. `ChoiceList` 기본은 native `fieldset disabled`, 퍼널만 `lockMode="aria"` + 보이는 반쪽. 「다시 확인」은 즉시 poll + live region. cap 리드≠본문. 로딩 막대 호스트 폭. 「연결됨」은 렌더 가드. generic 문장은 그룹 hint 한 번. 멘션 설정 경로 한 번. provider `configured` 도 자동 통과. 실제 위저드 create 응답이 dd 한 칸.
- R2 (R1 FAIL B2·H5·M7·N4). 화살표는 선택만, 커밋은 Enter/Space·「계속」. `detected`/`active` 멘션 스텝은 이름·채널(또는 승인 대기)+채널 핸드오프. 단계별 리드. 오프라인은 `aria-disabled`. OpenAI는 `deferred`. 자동 통과는 `detected|active`. 1회용 가드는 발급 비밀. 캡처 8포즈.
- runtime-unverified: 실서버 hosted create/detect 왕복은 이 티켓의 mock·캡처 범위. planner design-review는 PR 이후 fresh context.

## SH-6a-w 설정 › 연결 › 에이전트 자격 (#2204, 2026-09-08, R7)

- Track UXUI. `feat/sh6a-w-agent-credentials` onto `origin/track/uxui`. 설정 내비 「에이전트 자격」+ ⌘K. 목록은 기존 hosted list를 소비하고, 발급/재발급은 `HostedAgentWizard`(`entry=settings`), 해제·도어벨은 `HostedConnectionSection`. 행 키는 연결 `id`. AI 연결 loopback 거부는 자리의 InlineBanner. Worker does not claim design-review PASS.
- R7 (R6 FAIL B1·H1·M3·N2). ≥1024 액션 셀 `contents`: 버튼 셋은 track 3 밴드(`bg-surface` `flex-nowrap` `px-2`, 행 우측에 붙음), 잠긴 사유는 `col-span-full` 둘째 격자 행(띠 밖). 선택 채움은 행 원소 `bg-accent-soft`(열 간격이 못 끊음), 컨트롤은 `--surface` 위(R2-H1 ≥3:1 유지). 행 `ps-3`(바→글자 ≥12). `tokens.css` 주석만 실측(209.09 / ~31px 여유, 바 유틸은 색 분리)으로 고침 — 값 240·2px 유지. 스윕 12폭 × 6픽스처(OFFLINE 포함) × 2스킴, `finishSweep` 행동 게이트(합성 실패 행이 throw), 리사이즈 후 배치를 한 번 읽고 숫자와 함께 단정. N2(`parseDisconnectStart` status 재기록)는 이 diff 밖. `AgentHubRoute.tsx` 무접촉.
- runtime-unverified: 실서버 hosted create/disconnect 왕복은 이 티켓의 mock·캡처 범위. planner design-review는 PR 이후 fresh context.

## SH-6a-w 설정 › 연결 › 에이전트 자격 (#2204, 2026-09-08, R6)

- Track UXUI. `feat/sh6a-w-agent-credentials` onto `origin/track/uxui`. 설정 내비 「에이전트 자격」+ ⌘K. 목록은 기존 hosted list를 소비하고, 발급/재발급은 `HostedAgentWizard`(`entry=settings`), 해제·도어벨은 `HostedConnectionSection`. 행 키는 연결 `id`. AI 연결 loopback 거부는 자리의 InlineBanner. Worker does not claim design-review PASS.
- R6 (R5 FAIL B2·H1·M1·N3; R2-H1 회귀 복구). 레이아웃은 셸이 주는 폭으로만 고른다: `lg`≥1024 3열 `credentials-row-grid`(이름 `minmax(0,1fr)` · 사실 auto · `--spacing-action-band`), 미만은 이름+칩+상대시각 한 줄 다음에 액션 띠. 사실 칸은 모든 폭에서 한 줄(`dt`는 `sr-only`). 선택 채움은 이름/사실만 `--accent-soft`, 액션 띠는 `bg-surface`, 연속은 `credentials-row-current`(2px `--accent`) 가 행 전체(스택이면 두 띠). `tokens.css` 신규는 `--spacing-action-band` 한 줄 + 그 토큰을 소비하는 named utility. 스윕은 규칙 실패 시 throw. `AgentHubRoute.tsx` 무접촉.
- runtime-unverified: 실서버 hosted create/disconnect 왕복은 이 티켓의 mock·캡처 범위. planner design-review는 PR 이후 fresh context.

## SH-6a-w 설정 › 연결 › 에이전트 자격 (#2204, 2026-09-08, R5)

- Track UXUI. `feat/sh6a-w-agent-credentials` onto `origin/track/uxui`. 설정 내비 「에이전트 자격」+ ⌘K. 목록은 기존 hosted list를 소비하고, 발급/재발급은 `HostedAgentWizard`(`entry=settings`), 해제·도어벨은 `HostedConnectionSection`. 행 키는 연결 `id`. AI 연결 loopback 거부는 자리의 InlineBanner. Worker does not claim design-review PASS.
- R5 (R4 FAIL B1·H1·M1·N4; R2 열둘·R3 닫힌 항목 유지). 행 레이아웃을 flex 잔여폭에서 **3트랙 그리드**로 교체: ≥720 `grid-cols-[minmax(9rem,1fr)_auto_11.5rem]`, <720 한 컨테이너 세로 스택. 시각은 모든 폭에서 상대 시각(`n일 전`, `title`+`<time datetime>`). 선택 `--accent-soft` 가 이름·사실·액션 띠를 한 원소로 덮고, 스택 띠 경계는 `mx-3 border-line/50`. `disconnected` 행 「기록 보기」. 도어벨 목적지 명사 「도어벨 설정」(행 버튼 = 장부 제목). `HostedConnectionSection` 렌더 가드: `cleanup_pending` 에 완료 헤드라인 없음. `AgentHubRoute.tsx` 무접촉.
- runtime-unverified: 실서버 hosted create/disconnect 왕복은 이 티켓의 mock·캡처 범위. planner design-review는 PR 이후 fresh context.

## SH-6a-w 설정 › 연결 › 에이전트 자격 (#2204, 2026-09-08, R4)

- Track UXUI. `feat/sh6a-w-agent-credentials` onto `origin/track/uxui`. 설정 내비 「에이전트 자격」+ ⌘K. 목록은 기존 hosted list를 소비하고, 발급/재발급은 `HostedAgentWizard`(`entry=settings`), 해제·도어벨은 `HostedConnectionSection`. 행 키는 연결 `id`(만료+활성 공존 시 장부가 그 행을 연다). AI 연결 loopback 거부는 자리의 InlineBanner. Worker does not claim design-review PASS.
- R4 (R3 FAIL B1·H1·M2·N5; R2 열둘 CLOSED 유지). 390 행은 이름 `min-w-0 flex-1` + 시각 `hidden sm:block` + 잠금 사유 `basis-full` 줄바꿈. 터미널 행은 도어벨을 거두고 착지는 heading 으로 내린다. `HostedConnectionSection` TerminalPanel 완료 분기는 `disconnected` 만. 행 본문 hover 채움 삭제. 허브 region 은 `aria-label={`${agentLabel} 호스티드 연결`}`, 설정은 labelledby. 버튼 「도어벨 설정」. `AgentHubRoute.tsx` 무접촉.
- runtime-unverified: 실서버 hosted create/disconnect 왕복은 이 티켓의 mock·캡처 범위. planner design-review는 PR 이후 fresh context.

## SH-9 hermes 합류 런북 Rust 현행화 (#2231, 2026-09-08)

- Track engine. `feat/sh9-hermes-runbook-rust`. `docs/external-agent-provider/*` 재작성(삭제 아님): Swift 런타임 이름 → compose `api`/`relay`/`agent-worker`, 포트는 `MOMO_WEB_PORT` 파생, 죽은 `verify_external_agent_provider.sh` 5곳 → `scripts/local_gate.sh --profile external-agent-provider` + `scripts/verify_local_hermes_credentialed_smoke.sh`, Command Center → 설정 › AI 연결. `docs/SELF_HOST.md`(+ko) §5 로컬 provider를 hermes 실측 절차로 확장. 인용 게이트 `scripts/tests/test_external_agent_provider_docs.sh`.
- 검증: 새 시험 PASS(인용 7, Swift 이름 0, 28180/28100 0) · 사보타주 RED(`scripts/verify_external_agent_provider.sh`) · `scripts/local_gate.sh --profile docs`. E2E `COMPOSE_PROJECT_NAME=oort-sh9`, mock `scripts/mock_hermes.py --host 0.0.0.0:19765` (`hermes serve`는 JSON-RPC라 `/v1/chat/completions` 대체), welcome `#general` seq=3 body `김인턴 mock reply: MOMO-004 SSE path verified.`. 회수 후 컨테이너 0. 플러그인 `MOMO_HERMES_PLUGIN_INSTALL_MODE=copy scripts/momo hermes-gateway-install-plugin` PASS(`plugin.yaml`+`PLUGIN.yaml`). `verify_hermes_gateway_adapter.sh`는 삭제된 Swift 서버를 띄워 미실행(allow-list 밖).
- runtime-unverified: 실 hermes OpenAI 호환 SSE(이 호스트의 `hermes`는 `serve` JSON-RPC). 자격 스모크 `verify_local_hermes_credentialed_smoke.sh` 기본 경로는 `NEEDS_USER_CREDENTIAL`(시크릿 없음).

## SH-8 그록봇 합류 절 검수 + 로컬 CDP 하네스 (#2230, 2026-09-08)

- Track engine. `feat/sh8-grokbot-join-harness`. `docs/SELF_HOST_AGENT.md`(+ko) §3.3.16 5단계 라우트 대조표(생성→pairing handshake→confirm→active 재핸드셰이크→regenerate)를 Rust 핸들러와 1:1로 맞춤. 어긋난 문장만 수정: foundation 요청만 `detected→active` 증명, pairing/`detected`의 `tools/call`은 HTTP 401 빈 본문, `active`에서 regenerate는 409. §3.3.19 Do not에 사용자·공개 표면 vs `scripts/dev/grokbot_cdp/README` 한 줄. 하네스 신규(`read`/`write`/`clear`.py). 제품 카피·`presets.test.ts` 무접촉.
- 검증: `scripts/local_gate.sh --profile docs`. Agent Port 루틴 원문 vs 실측은 pairing bearer로 `oort_inbox_read` bytes를 실서버에 재현(문서 수정 근거). Grok Bot CDP 포트 9333이 닫혀 있으면 스크립트는 `SKIPPED: Grok Bot app not running (port 9333 closed)` + exit 0.

## SH-6a-e 로컬 provider opt-in (#2215, 2026-09-08)

- Track engine. `feat/sh6a-e-local-provider`. `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK` 은 `MOMO_ENV=staging`에서도 운영자 opt-in으로 유효. `AGENT_PROVIDER_LOCAL_HOSTS` 정확 일치(기본 `host.docker.internal`). 생성기 `--allow-local-provider`, compose api·agent-worker 전달 + `extra_hosts`, doctor `env.local_provider`. ADR-0004 증보 1절.
- 검증: `cargo test -p momo-settings` 79 passed · `scripts/tests/test_local_provider_optin.sh` · `scripts/tests/test_railway_template.sh` (키 집합 41) · docs/web 프로파일 PASS (`5587dadd`).
- E2E (`COMPOSE_PROJECT_NAME=oort-sh6ae`, mock-hermes `127.0.0.1:18765`, `MOCK_HERMES_TOOL_CALLS=0`): `PUT /v1/provider/link` HTTP 200 `baseUrl=http://host.docker.internal:18765/v1`; `POST /v1/provider/link/test` HTTP 200 `ok=false reason=probe_not_run`; welcome `#general` seq=1 body `김인턴 mock reply: MOMO-004 SSE path verified.`. Flag off api recreate: same PUT HTTP 400 `non-loopback baseUrl must use https://`; `http://127.0.0.1:18765/v1` HTTP 400 `loopback baseUrl requires local mode and AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`. Railway 무접촉.
## #1265 웹훅 인바운드 공개 ingress (#1265, 2026-09-08)

- Track engine. `feat/1265-webhook-inbound`. ADR-0115 D1/D2/D3/D4: `POST /v1/webhooks/{ws}/{installation}` (HMAC) · `POST /hooks/{token}` (Slack 호환 URL-시크릿). 메시지는 `send_message_in_tx`만 — 직접 `INSERT INTO message` 0. 폐기/미지 토큰·설치는 두 경로 동일 404 문장, HMAC 실패는 401, 본문 262144(413), 설치별 429.
- R2: 공개 엣지 세 Caddyfile(`infra/rust/Caddyfile` · `Caddyfile.local` · `infra/railway/Caddyfile.railway`)에 `handle /hooks/* { reverse_proxy <same as /v1/*> }` — centrifugo 403 뒤, SPA catch-all 앞. CSP는 마지막 handle만.
- 검증: `webhook_inbound_conformance_pg` · `scripts/verify_webhook_rust.sh` 인바운드 + `WEBHOOK_RUST_PROVE_RED_INGRESS_ORDER` 사보타주 · `scripts/tests/test_webhook_inbound_contract.sh` (`/hooks/*` 블록 1개·업스트림 일치·순서; 삭제 사보타주 RED) · `scripts/verify_public_edge_centrifugo_contract.sh` · `scripts/tests/test_railway_template.sh`.

## SH-5a Railway 템플릿 (#2205, 2026-09-08)

- Track engine. `feat/sh5a-railway-template`. `infra/railway/` 카탈로그(같은 GHCR 이미지 command 분기 4 + Caddy 공개 엣지 + Centrifugo env + Postgres 플러그인, LiveKit 제외). `scripts/self_host_env.sh --railway`가 생성기 heredoc+`oort_public_edge_env_keys` 키 집합을 Railway 변수로 stdout. `Caddyfile.railway`는 공개 Caddyfile의 내부 HTTP 분기(`http://{$OORT_SITE_ADDRESS}` + `http_port {$PORT}`, `auto_https off`+`:8080` 금지).
- 검증: `scripts/tests/test_railway_template.sh` (키 집합 diff 0 · JWT_HMAC 사보타주 RED · `caddy adapt` · 403 순서 · 게이트 픽스처 PASS/RED) · `scripts/local_gate.sh --profile docs`.
- runtime-unverified: `RAILWAY_TOKEN` 없음 — 실배포 `railway up` / 원격 `public.healthz`·`public.websocket`은 planner 수행.

## LS-3 은퇴 문서 (#2182, 2026-09-07)

- Track engine. `feat/ls3-retired-docs`. 루트 은퇴 문서·G3 런북(`05`/`06`)·Codex 스텁·NCP 런북 `git rm`. `CENT_PROXY_SECRET` 회전 절은 `docs/SELF_HOST.md`(+ko)로 원문 이식, public-edge 계약 `RUNBOOK=` 재지정. INDEX/README는 ADR-0183 D1 목록. `.conductor/`는 local_gate/goal_claim이 소비하므로 유지.
- runtime-unverified: 공개 호스트 회전 증거는 attended `verify_public_edge_centrifugo_boundary.sh`가 닫기 전까지 `runtime-unverified(public host)`.

## LS-1 Swift 은퇴 (#2165, 2026-09-07)

- Track engine. `feat/ls1-swift-retire`. Swift `server/Sources`·`workers`·`relay`·`services`·`infra/prod`·Swift e2e compose·examples·codex-workbench 삭제. `server/Migrations`·`server/Fixtures` 유지. PushRelay Swift 본체 삭제, **계약·overlay 유지**. Rust 본체는 #1255(`momo-push-relay`, 같은 멀티커맨드 이미지 `command: ["push-relay"]`).
- runtime-unverified: 실기기 APNs 수신(TestFlight)은 planner 범위. `scripts/verify_push_relay.sh`는 stub 전용(Apple 미접속). workd 미이식 경로는 D4-② 폐기(출시 후 Rust 사이드카 ADR).

## SH-10 momo-push-relay Rust (#1255, 2026-09-07)

- Track engine. `feat/sh10-push-relay-rust`. ADR-0120 와이어 계약(id-only `momo.push.dispatch.v2`, raw-body Ed25519, receipt `apns_status`/`apns_reason`/`apns_id`, 서명 실패 **401**)을 `server-rust/bins/momo-push-relay`로 이식. stub은 `MOMO_APNS_ALLOW_STUB=1` 없이 exit 78. 자기등록 REST는 범위 밖(v0 = 정적 `MOMO_RELAY_SERVERS`).
- 검증: `cargo test -p momo-push-relay`, `scripts/verify_push_relay.sh`, stub compose E2E. 실 APNs 미호출.

## LS-2 클라 이중 정본 해소 (#2166, 2026-09-07)

- Track UXUI. `feat/ls2-client-dual-canon` onto `origin/track/uxui`. `git rm` `clients/web-legacy`(45) + `clients/mobile-spike`(70): `git ls-files clients` 1250→1135. Work 표면 `workstreams`·`workConsole`·`work`·`ade`는 기존 `SURFACES`/`isSurfaceProvided`로 셀프호스트 기본 `provided:false`(라우트·컴포넌트 유지). 진입점 시험: hidden=0, restored=5.
- 캡처 스위트 `nav-work-console`·`settings-work-host-*` 장면은 work 진입점이 숨겨져 스킵. `scripts/**`·`infra/**`의 `web-legacy` 잔존 문자열은 이 티켓 무접촉(NOTES).

## LS-4 문서 로테이션 (#2143, 2026-09-07)

- Track engine. ADR-0183 D6 + R2 live-cite restore: handoffs 304→76, planning-root 70→51, planning/research 112→78, `research/` 112→36 (26 ADR-cited md + 7 live-canon restores + 3 hermes fixtures). `claudedocs/` 39→0, `docs/archive/` 5→0. STATUS 2026-08 절 761줄을 `docs/planning/archive/STATUS-2026-08.md`로 이동. D6 수명 규칙은 살아 있는 정본·코드 인용을 포함한다.

## ST-1 Timeline burst 결정성 + 바닥 동시 상한 3 + capture intro 정착 (#2050, 2026-09-07, R6)

- Track UXUI. `feat/st1-timeline-burst-capture` onto `origin/track/uxui` `2a4b03f3`. Worker does not claim design-review PASS. Guard-only; **no product behaviour change**. Product-file edits are the `TIME_GATED_CONTROLS` export (same module as the guard) and a comment at `Timeline.tsx` `atBottomBeforeBatchRef`.
- H-1. Registry names the gated interactive control: `timeGatedTestId(prefix)` → `${prefix}-commit` (the armed button, not the `-confirm` container). Real-lane RED in the fixed-clock `approvals-confirm` scene, scratch `page.keyboard.press("Enter")` on focused armed `-commit` and `page.locator('[data-testid=inbox-approval-commit]').click()` both abort `CAPTURE ABORT: scene "approvals-confirm" is clock:fixed; time-gated control [inbox-approval-commit] cannot open CONFIRM_GUARD_MS under a frozen Date`. Unit test drives the same resolver against rendered `ApprovalActions` (`captureClock.actions.test.tsx`); no hard-coded `evaluate` stub.
- M-1. Usage-site set equality is keyed on the element's actual test id (AST of handlers that read `*_GUARD_MS`), not a `-confirm` suffix. S7f: unregistered `FOO_GUARD_MS` gating `foo-commit` → red (`+ foo-commit`); registered `timeGatedTestId("foo")` → 8/8 green; ghost registry entry → red (`- foo-commit`).
- N-1. `sceneDispatchMouseEvent` reads the target's test id from the element it dispatches on (no hand-written argument).
- N-2. `beginCaptureScene` at scene start (before any interaction); `wrapPageShotGuard` no longer sets the scene. `clockForScene()` reads the same name.
- N-3. Comment at `atBottomBeforeBatchRef`: seeded `true`; 0–16 ms mount window; scrolled-up reader can get 1 play at mount (≤ D3's 3). No behaviour change.
- N-4. Ten pre-existing `toContain` greps in the other `arrivalWiring.test.ts` `it`s left untouched (out of scope).
- 부하 1×30 (both burst files, `--pool=threads --maxWorkers=1 --minWorkers=1`). **fail/30 = 0**, 11 tests/run.
- Capture ×2 (`CAPTURE_PORT=8641`, 528 PNG, exit 0×2). intro/chat/welcome-backstop sha identical to R5 (`d1e1e410ee97…` / `7f16f519e1f0…` / `2f1ed5c1bc0c…` / `4d9e902466c4…` / `0c384e43c759…` / `f7f6e6fdec62…`). **499/528** identical, **29** differing ⊆ #2128 + R4/R5 host-nondeterminism class.
- 게이트. web test **236 files / 2807 passed**. typecheck. lint 0 errors / 16 warnings. preflight web 14/14 + core 5/5. `SHELL_GATE_PORT=8643 SHELL_GATE_FOCUS_ONLY=1` GATE PASS. `scripts/verify_merge_tree.sh --base origin/track/uxui --head HEAD` PASS (base `2a4b03f3`).
- 폰·`packages/momo-core` 무접촉. UX-R1d/UX-R2b green. runtime-unverified 아님.

## ST-1 Timeline burst 결정성 + 바닥 동시 상한 3 + capture intro 정착 (#2050, 2026-09-06, R5)

- Track UXUI. `feat/st1-timeline-burst-capture` onto `origin/track/uxui` `2a4b03f3`. Worker does not claim design-review PASS.
- **제품 경로 재생 단정은 로컬 게이트·design-review의 Chromium 레인에서만; CI 유닛 레인은 grant 단정까지.** `PLAYWRIGHT_BROWSERS_PATH=/nonexistent` → **51 skipped** / 2754 passed (R4 was 47; +4 burst-size Chromium cases).
- H-1. jsdom 「consumed 장부」는 grant-set / 재전달 0 only — post-flush play count 없음. S15b (leftover sweep on every `messages` change) jsdom **5/5 green**. Cap 3→2 still reds Chromium `expected 3, got 2 before animationend` (10/20/30/50).
- H-2. `captureClock.test.ts` usage-site **set equality** vs `TIME_GATED_CONTROLS`. Unregistered `FOO_GUARD_MS` + `foo-confirm` → `expected [approval-confirm, foo-confirm, handoff-confirm, inbox-approval-confirm] to equal [approval-confirm, handoff-confirm, inbox-approval-confirm]`. Register → green.
- M-1 (only product-behaviour change). Exact sites: `Timeline.tsx` leftover sweep + `followOutput` read **pre-batch** at-bottom (`atBottomBeforeBatchRef` / `pendingBottomBatchRef`); `conversationEntrance.ts` consumes the grant on the first painted frame (unmount cancels, so virtuoso flash-mount does not spend it). 성재 2026-09-04: bottom same-tick → **3 play** regardless of batch size. Scroll-up still leftover 0 / jump 1 from the same pre-batch state. jsdom 50: pre-batch does **not** add a deterministic post-flush grant measurement (`issued=3` inside `act` only).
- Burst-size Chromium plays (R4 → R5): **10/20/30 = 3/3/3 (unchanged); 50 = 1 → 3**.
- M-2. Burst file headers + this STATUS line: product-path play assertions run only in the Chromium lane.
- N-1. `keyboard.press("Enter"|" ")` / `mouse.down()`/`up()` / synthetic `MouseEvent` go through sceneClick-family. Self-test raw uses = 0. RED: raw `page.keyboard.press("Enter")` focused `inbox-approval-confirm` in scene `approvals-confirm` → `CAPTURE ABORT: scene "approvals-confirm" is clock:fixed; time-gated control [inbox-approval-confirm] cannot open CONFIRM_GUARD_MS`.
- N-2. `wrapPageShotGuard` calls `setActiveCaptureScene(sceneNameFromShotPath(path))` before every shot. Unit test uses `approvals-confirm`.
- N-3. `arrivalWiring.test.ts` REST-meta `it` keeps only `identifierCallCount(..., "capArrivalSetKeeping") === 3`.
- N-4. `eslint-disable-next-line react-refresh/only-export-components` on `TIME_GATED_CONTROLS` — lint **0 errors, 16 warnings**.
- 부하 3×30 (both burst files, `--pool=threads --maxWorkers=1 --minWorkers=1`, concurrent full `vitest run`; `/tmp/r5-sab-2114/burst90`). **fail/90 = 0**, 11 tests/run (jsdom 5 + Chromium 6).
- Capture ×3 (`CAPTURE_PORT=8641`, 528 PNG, exit 0×3). intro/chat **3-identical**, sha R2/R3/R4와 동일 (`d1e1e410ee97…` / `7f16f519e1f0…` / `2f1ed5c1bc0c…` / `4d9e902466c4…`). **495/528** identical, **33** differing (21 on #2128 issue list; 12 extras same host-nondeterminism class as R4 — no exemption widened).
- 게이트. web test **235 files / 2805 passed**. typecheck. lint 0 errors / 16 warnings. preflight web 14/14 + core 5/5. `SHELL_GATE_PORT=8643 SHELL_GATE_FOCUS_ONLY=1` GATE PASS. `scripts/verify_merge_tree.sh --base origin/track/uxui --head HEAD` PASS (base `2a4b03f3`).
- 폰·`packages/momo-core` 무접촉. UX-R1d/UX-R2b green. runtime-unverified 아님.

## ST-1 Timeline burst 결정성 + 바닥 동시 상한 3 + capture intro 정착 (#2050, 2026-09-06, R4)

- Track UXUI. `feat/st1-timeline-burst-capture` onto `origin/track/uxui` `2a4b03f3`. Worker does not claim design-review PASS. Guard quality only; product behaviour unchanged.
- Coverage split. **jsdom = grants** (issued inside the same `act` as `onMessage`, before leftover sweep). **Chromium = plays / computed styles / jump** (`animationstart` ×3, `animation-name: none`, `jump-latest` leftover=1 then start=1).
- 부하 3×30 (`--pool=threads --maxWorkers=1 --minWorkers=1`, 동시에 full `vitest run` 12회; `/tmp/r4-burst-2114-h1b`). **fail/90, 반올림 없음:**

| case | fail/90 | source |
|---|---|---|
| jsdom 같은 틱 라이브 3건 grant 3 | **0/90** | 90 exit 0 |
| jsdom 10건 grant 3 · 나머지 클래스 정착 | **0/90** | 90 exit 0 |
| jsdom 50건 grant 3 · mounted-settled class | **0/90** | 90 exit 0 |
| jsdom 대소문자 접힘 | **0/90** | 90 exit 0 |
| jsdom consumed 재전달 0 | **0/90** | 90 exit 0 |
| Chromium `motion-enter-conversation` 3회 시작 | **0/90** | 90 exit 0 |
| Chromium 스크롤업 50→점프 1 | **0/90** | 90 exit 0 |

- First loaded 90 (pre-10/50 split) left jsdom 10-case plays at **1/90** (`burst-a-9.log`: `expected 1 to be 3` at `plays.length`) — same leftover sweep as R3's 3-case. Grant snapshot inside `act` moved that flake off jsdom. Isolation 90 before the split was already 0/90 on the 3-grant case.
- H-1. 「같은 틱 라이브 3건」은 grant 3 (`isPlayEntrance`), not DOM plays. RED (skip `playOnMountRef.current.add`): `expected +0 to be 3` at `Timeline.burst.test.tsx:516`.
- M-1. jsdom settled = class absence only (`animationName` always `""`). Computed `animation-name` / no `motion-enter-conversation` is Chromium. RED jsdom (give older row the class): `expected false to be true` at `isClassSettled`. RED Chromium (settled map returns the animation name): `expected true to be false` at `name.includes(ENTER_CONVERSATION_ANIMATION_NAME)`.
- M-2. Channel B live 4 includes A's opener id. Opener `isPlayEntrance` false in B; B's three extras survive. RED (delete `pinnedEntranceRef.current = null`): `expected true to be false` at opener in B.
- M-3. `arrivalWiring.test.ts` keeps `identifierCallCount(..., "capArrivalSetKeeping") === 3`. `if (liveNew)` grep gone. One-line reformat of the live-new cap call: 7/7 green.
- M-4. Product `TIME_GATED_CONTROLS` next to `CONFIRM_GUARD_MS`. Usage-site AST over `*_GUARD_MS` + `testIdPrefix` on `<ApprovalActions>`. Every capture click via `sceneClick`; wrap also intercepts `page.locator(...).click()`. Converted: all 159 `.click(` in `capture-screens.mjs` (self-test: 0 remaining). Real lane RED (`page.locator("[data-testid=inbox-approval-confirm]").click()` after wrap in a fixed scene): `CAPTURE ABORT: wiping press-triplet outputs and catalog. cause: browser.newPage: CAPTURE ABORT: scene "default" is clock:fixed; time-gated control [inbox-approval-confirm] cannot open CONFIRM_GUARD_MS under a frozen Date`.
- Nits. N-1 jump dead-pill: `jump-latest click produced 0 motion-enter-conversation starts within 60 frames`. N-2 leftover: `leftover grants at jump gate: expected 1, got N`. N-3 `idleTimelineMock satisfies UseTimelineResult`. N-5: this host's 3-run residual is listed by name below; no 「전부 2/3 동일」 class claim.
- Capture ×3 (`CAPTURE_PORT=8641`, `CAPTURE_PROFILE=all`, 528 PNG, exit 0×3). intro nonempty light/dark · chat light/dark **3-identical**, sha R2/R3와 동일 (`d1e1e410ee97…` / `7f16f519e1f0…` / `2f1ed5c1bc0c…` / `4d9e902466c4…`). 이 호스트 3런: **495/528** identical, **33** differing. vs `r2-base-vs-head-nondeterminism.txt` HEAD-39: 8 names not on that list (`agent-turns-offline-dark` · `b11-reaction-picker-light` · `composer-attachment-pending-light` · `mobile-long-token-dark` · `mobile-terminal-dock-light` · `u4-composer-emoji-light` · `u4-thread-composer-parity-dark` · `unfurl-remove-confirm-light`; each distinct=2 this sample). 3 of those were already in R3 extras and UNSTABLE ON BASE. #2128 잔량, 면제 확대 없음.
- 게이트. web test **235 files / 2800 passed**. typecheck. lint 0 errors (17 warnings: 16 선행 + `TIME_GATED_CONTROLS` react-refresh). preflight web 14/14 + core 5/5. `SHELL_GATE_PORT=8643 SHELL_GATE_FOCUS_ONLY=1` GATE PASS. `scripts/verify_merge_tree.sh --base origin/track/uxui --head HEAD` PASS (base `2a4b03f3`).
- 폰·`packages/momo-core` 무접촉. runtime-unverified 아님.

## ST-1 Timeline burst 결정성 + 바닥 동시 상한 3 + capture intro 정착 (#2050, 2026-09-06, R3)

- Track UXUI. `feat/st1-timeline-burst-capture` onto `origin/track/uxui`. Worker does not claim design-review PASS.
- B-1. jsdom 스크롤업→점프를 Chromium 레인으로 옮김 (`Timeline.burst.chromium.test.ts` + `timelineBurst.harness.tsx`, `detectChromium` + `it.skipIf`). 「3회 시작」 대기는 `animationstart` ×3 프로미스(천장=`animationend` before 3). 점프는 leftover grant=1 뒤 제품 `jump-latest` click, 같은 이벤트 천장. jsdom 은 같은 틱 3/3 · 10→3/7 · 50→3+mounted-settled+unmounted 만. 하네스는 첫 페인트 이후 `scrollTop` 을 쓰지 않음.
- 부하 3×30 (`--pool=threads --maxWorkers=1 --minWorkers=1`, 동시에 full `vitest run`; `/tmp/r3-burst-2114/burst-{a,b,c}-{1..30}.log`). **fail/90, 반올림 없음:**

| case | fail/90 | source |
|---|---|---|
| jsdom 같은 틱 3/3 | **1/90** | `burst-c-1.log`: `expected 3 playing rows, got 1 mounted=3` |
| jsdom 10→재생 3 · 정착 7 | **0/90** | 90 exit 0 |
| jsdom 50→재생 3 · mounted-settled (printed 27) · unmounted (printed 20) | **0/90** | 90 exit 0 |
| jsdom 대소문자 접힘 | **0/90** | 90 exit 0 |
| jsdom consumed 재전달 0 | **0/90** | 90 exit 0 |
| Chromium `motion-enter-conversation` 3회 시작 | **0/90** | 90 exit 0 (R2 는 1/90) |
| Chromium 스크롤업 50→점프 1 | **0/90** | 90 exit 0 (R2 는 5/90, `jump-latest missing`) |

- H-1. 핀 후 라이브 배치 4건: opener grant 생존·1회 재생, 핀 해제 후 CH2 누수 0 (`useTimeline.arrival.test.tsx` · `WelcomeKickoff.product.test.tsx`). RED (`capArrivalSetKeeping` ignore `keep`): `expected false to be true` at opener `isPlayEntrance` / `enter-conversation` class.
- M-2. `arrivalWiring.test.ts` 의 indent-exact `capArrivalSetKeeping` grep 삭제. `if (liveNew)` 코드는 유지. 스코핑은 REST 경로에서 행동적으로 무해(REST 배치는 grant 0, eviction 0) — R2 RED 는 공백만 깨는 가드였다.
- M-3. 10/50 정착 행은 `enter-conversation` 클래스 없음 + `animation-name` 이 `motion-enter-conversation` 이 아님(`none`). `mounted−3` / `50−mounted` 항등식 단정 삭제, `console.info` 숫자만.
- M-4. 장면 레지스트리 `clock: "fixed" | "flowing"` (기본 fixed). `welcome-backstop` 만 flowing. `wrapPageTimeGateClicks` 가 `inbox-approval-confirm` 클릭을 막음. RED: 고정 시계 장면 `chat` 에서 confirm click → `CAPTURE ABORT: scene "chat" is clock:fixed; time-gated control [inbox-approval-confirm] cannot open CONFIRM_GUARD_MS`.
- Nits. N-1 `INTRO_SETTLE_FRAME_CEILING` 삭제. N-2 `tickIntroSettle` 공유. N-3 `idleTimelineMock`.
- Capture ×3 (`CAPTURE_PORT=8641`, 528 PNG, exit 0×3). intro nonempty light/dark · chat light/dark **3-identical**, sha R2와 동일 (`d1e1e410ee97…` / `7f16f519e1f0…` / `2f1ed5c1bc0c…` / `4d9e902466c4…`). 이 호스트 3런: 488/528 identical, 40 differing. vs R2 HEAD-39 extras listed in the R3 PR body — #2128 잔량, 면제 확대 없음. 37 pre-existing 장면은 #2128, 이 PR 무접촉.
- 게이트. web test **235 files / 2797 passed**. typecheck. lint 0 errors (16 warnings: 15 선행 + burst harness `only-export-components`, welcome harness 와 동일). preflight web 14/14 + core 5/5. `SHELL_GATE_PORT=8643 SHELL_GATE_FOCUS_ONLY=1` GATE PASS. `scripts/verify_merge_tree.sh --base origin/track/uxui --head HEAD` PASS (base `2a4b03f3`).
- 폰·`packages/momo-core` 무접촉. runtime-unverified 아님.

## ST-1 Timeline burst 결정성 + 바닥 동시 상한 3 + capture intro 정착 (#2050 · #2057 N-4, 2026-09-06, R2)

- Track UXUI. `feat/st1-timeline-burst-capture` onto `origin/track/uxui`. ADR-0179 D3 정오표: 바닥 같은 틱 재생 상한 **3**. Stagger 없음. 스크롤업 leftover 는 1. 캡은 live `message.new` 배치에만 적용(REST head/load-more/backfill/own-send/edit 무접촉). 웰컴 opener grant 는 eviction 면제 (`pinArrivalGrant` + `holdEntranceId`).
- 결정성. 같은 틱 3건은 virtuoso 마운트 + 제품 바닥 신호(`jump-latest` 없음) 뒤 재생 3. 부하 30× (`--pool=threads --maxWorkers=1 --minWorkers=1`, 동시에 full `vitest run`): 같은 틱 3/3 **0/30** · 스크롤업 50→점프 1 **0/30**. (R1 부하 1/30 은 `leaveBottom` 이 stubbed head index 를 요구한 자리.)
- 상한. 가상화 `Timeline` 하네스: 10 같은 틱 → 재생 **3** · 정착 **7** · unmounted **0** (10 전부 마운트). 50 → 재생 **3** · mounted-settled **27** · unmounted **20** (mounted **30**). 47 정착은 산수이지 측정이 아님. RED: `mountedSettled === 47` → `expected 27 to be 47`.
- M-1. 스크롤업 백로그 50 → 재생 **0**. 바닥 점프 → **1**. `jumpToLatest` 의 64px remaining 휴리스틱 삭제. 제품 신호는 `jump-latest` 필. jsdom 은 `scrollToIndex(LAST)` 뒤 `atBottom=true` 를 안 올려 필이 남을 수 있음 — 단정은 leftover 재생 1.
- Nits. N-2 재생 수는 리터럴 `3` (제품 상수를 자기 자신과 대조하지 않음). N-1 `MAX_CONSUMED_ARRIVAL_IDS` 는 belt; `alreadyHeld` 가 재재생 문. N-4 `waitForAnimations(login)` 삭제는 회귀 아님. N-5 재재생 값 없음. N-6 대소문자 접힘.
- Capture 시계. `FIXTURE_NOW = Date.UTC(2024, 5, 15, 3, 0, 0)` (12:00 KST). 픽스처 `Date.now()` 전부 이 상수. 페이지 시계는 `addInitScript` Date override (`pinPageWallClock`) — Playwright `page.clock.setFixedTime` 은 `performance`/rAF 까지 건드려 `assertWideRowsFillOnly` CDP `forcePseudoState` 가 stale nodeId 로 2/3 중단. Welcome-backstop 만 `page.clock.install` + `fastForward(120s)`.
- Capture intro 정착. predicate = item-list 가 `hidden` 아님 ∧ intro rect ∧ `scrollTop` 이 `SETTLE_STABLE_FRAMES=3` 연속. 천장 60 (base 복구, 180 아님). **predicate first held at frame 3** (need 3, ceiling 60) — nonempty intro light/dark. 루프는 조건이 서는 즉시 종료. 주석 grep 가드 삭제; S8 는 vis/scrollTop 를 키에서 빼면 움직이는 장면이 거짓 정착, 실제 키는 안 선다.
- Capture ×3 (`CAPTURE_PORT=8641`, 528 PNG, 전부 exit 0). 전 장면 3-동일은 **아님**: **462/528** byte-identical, **66** 잔량 (면제 확대 없음). intro nonempty light/dark **3-동일** (`d1e1e410…` / `7f16f519…`). chat-light **3-동일**. chat-dark 는 2/3 동일(run3 만 다름) — R1 의 「호버 툴바가 intro sha 를 움직인다」는 거짓 원인(실측은 렌더된 벽시계). 잔량 사이트: `accent-*` 10장 (`waitUntilTokenPaint` 150ms 전이), `terminal-dock-loading-*` (로딩 애니), `b8-*` / `sidebar-section-hover-*` / composer·메뉴 hover 크롬. 호버 툴바 park 는 #1743 단정으로 남고 intro sha 원인으로 쓰지 않음.
- 게이트. web test 233 files / 2790 passed. typecheck. lint 0 errors (15 warnings 선행). preflight web 14/14 + core 5/5. `SHELL_GATE_PORT=8643 SHELL_GATE_FOCUS_ONLY=1` GATE PASS. design-review는 이 워커가 하지 않음.
- 폰·`packages/momo-core` 무접촉. runtime-unverified 아님.
## SH-3b `scripts/oort` day-2 (#2103, 2026-09-06, R3)

- R3: `docs/SELF_HOST.md` When-stuck upgrade row plus `scripts/oort` / `oort_day2.sh` usage strings dropped the `<ref@sha256:…>` placeholder. Scanners count that token even as a placeholder (`scripts/check_release_manifest.sh` greps `docs/SELF_HOST*.md` + `README.md`; `test_publish_images_contract.py` greps `docs/SELF_HOST.md` only). AGENT docs had 0 hits. Code that *validates* a digest (`oort_extract_digest` / die regex) is unchanged.

## SH-3b `scripts/oort` day-2 (#2103, 2026-09-06, R2)

- Dispatcher verbs: `status` · `logs` · `upgrade` · `backup`/`restore` · `member invite` / `member credential`. Reuses `oort_doctor_*` (no copied functions), `scripts/self_host_pg_dump.sh` / `self_host_pg_restore.sh` (no new pg_dump/pg_restore call site), `releases/latest.json` `digest_list` (`^sha256:[0-9a-f]{64}$`, list≠arch). Never `docker volume rm` / `down -v`; failure prints a rollback command and does not run it. Secrets masked by generator secret-shaped keys + Bearer + `postgres://` passwords.
- R2 landing (three planner blockers):
  - `stack.outbox`: `push_candidate` pending is **non-failing** when no push relay is configured (compose has no `push-relay`/`notifier`; overlay keys `PUSH_RELAY_URL` / `MOMO_PUSH_RELAY_IMAGE` / `MOMO_APNS_KEY_HOST_PATH` unset — `infra/rust/docker-compose.push.yml` / `push-relay.env.example`). Same rows **fail** when a relay is configured. Other kinds unchanged.
  - `oort restore` runs the stack's `runtime-roles` one-shot (`MOMO_RUNTIME_ROLE_PROVISION=1`) before `scripts/self_host_pg_restore.sh` if `momo_app`/`momo_relay`/`momo_worker` are absent. No hand-written GRANT SQL. No second pg_restore call site.
  - `scripts/tests/test_oort_doctor.sh` expects live `status` (doctor reuse + `image.state`), not the SH-3a stub. `[oort-doctor-test] PASS: 15 case(s)`.
- Red proofs `scripts/tests/test_oort_day2.sh` **10/10** (was 9/9): previous 9 plus restore into a roles-less dest runs `runtime-roles` before `pg_restore`.
- R2 round-trip (published-image, this worktree under `$HOME`, `COMPOSE_PROJECT_NAME=oort-sh3b`, did not touch `oort-pgdata`). `digest_list`=`sha256:7426d282b67270ff3d52c4cbf1f5136ea038ae104a2c9dbb971ef71f8694d37f`. Volume still held **N=5**.
  - `scripts/oort upgrade --to <same list digest> --yes --no-backup`: `oort upgrade: doctor summary {"pass":29,"fail":0,"skip":2,"verdict":"PASS"}` **exit 0**. `stack.outbox` pass `push_candidate pending=5 non-failing (no push relay configured…)`. `count_after_upgrade=5`.
  - Backup 610878 bytes, sha256 `fba68f6ab2328d73c97411075357b474f2d256133f78199e968751d0b6fbf947`.
  - Restore into fresh postgres-only `oort-sh3br2` (roles_before=0): `oort restore: runtime roles absent (0/3); running compose service runtime-roles` then `[migrate] runtime roles provisioned` then `[self-host-restore] restore finished`. **RESTORE_EXIT=0**. `count_after_restore=5`, `roles_after=3`.
  - Dest app services up: `scripts/oort doctor --json` `summary={"pass":29,"fail":0,"skip":2,"verdict":"PASS"}` exit 0. Both projects `compose down` **without `-v`**.
- Volumes left for planner reclaim (not `volume rm`'d): `oort-sh3b-pgdata` · `oort-sh3b-drive` · `oort-sh3b_web-static` · `oort-sh3br-pgdata` (R1) · `oort-sh3br2-pgdata` · `oort-sh3br2-drive` · `oort-sh3br2_web-static` · `oort-pgdata` (untouched).
- Docs: `docs/SELF_HOST.md` When stuck restore row; `docs/SELF_HOST_AGENT.md` / `.ko.md` §4 restore + §막히면 `stack.outbox`. `python3 scripts/check_docs_commands.py` PASS 522 facts / 18 docs.
- 계획 이탈: 없음 (R1 blockers closed). runtime-unverified: member invite/credential live e2e. `scripts/local_gate.sh` does not yet list `scripts/oort` / `test_oort_day2.sh` (policy file — planner files that).

## SH-4b README paste block + SELF_HOST·FIRST_DAY 영문 정본 (#2105, 2026-09-06)

- README §Self-host 맨 위 「Paste this into your agent」 펜스 1개, **4줄**(상한 10). 정본 raw URL `docs/SELF_HOST_AGENT.md` + §0 계약 + `scripts/oort doctor` PASS일 때만 완료. 하네스 이름 grep 0. 바로 아래 1줄: 사람이 직접 하려면 → `docs/SELF_HOST.md`. 플레이북 명령은 복제하지 않음. SH-2 링크는 `[Open on a public origin](docs/SELF_HOST.md#open-on-a-public-origin)`.
- `docs/SELF_HOST.md` · `docs/SELF_HOST_FIRST_DAY.md` 영문 정본. 한국어 거울 `SELF_HOST.ko.md` · `SELF_HOST_FIRST_DAY.ko.md`. 절 번호 집합 동일: SELF_HOST 21/21, FIRST_DAY 22/22 (검증 상태 날짜·버전은 옮김, 재측정 없음 — SH-5a).
- 상호 링크 대조(README ↔ SELF_HOST ↔ SELF_HOST_AGENT ↔ FIRST_DAY ↔ llms.txt, 상대경로 해소 + 앵커 존재): **134 checked, broken 0**. `llms.txt` raw URL 불변이라 무수정.
- `grep -rn '@sha256:' README.md docs/SELF_HOST*.md llms.txt` = 0. `scripts/check_release_manifest.sh` glob `docs/SELF_HOST*.md` 가 새 `.ko.md` 4본 포함: `[release-manifest] ok: v0.1.4 matches CHANGELOG 0.1.4; prose @sha256: literals = 0`. `python3 scripts/check_docs_commands.py`: `[docs-cmd] PASS: 515 fact(s) decided across 3810 candidate command(s) in 18 document(s)`. GATED_DOCS 테이블은 여전히 `SELF_HOST_AGENT.md`만 (SELF_HOST/FIRST_DAY·`.ko.md` 미등재 — `scripts/**` 무수정, NOTES).
- 코드·SELF_HOST_AGENT* 무접촉. runtime-unverified: 영문 SELF_HOST/FIRST_DAY 사람 클릭 경로 재측정(SH-5a).

## SH-4a 에이전트 셀프호스트 영문 정본 (#2104, 2026-09-06)

- `docs/SELF_HOST_AGENT.md` 영문 하네스 불가지론 정본. 구 972줄 한국어·그록봇 VM 전용 플레이북은 공통 코어(§0–§2) + §3.3 Grok Bot VM 분기로 이동. 사라진 절 0 (대조표: `docs/planning/research/2026-09-06-sh4a-agent-install-run.md`).
- 한국어판 `docs/SELF_HOST_AGENT.ko.md` — 같은 절 번호 44개 일치. `llms.txt` 는 본인 기계/계정·시크릿 금지·자동화 금지 (하네스 전용 문장 제거). 정본 raw URL 유지.
- SH-2 공개 엣지 키(`OORT_SITE_ADDRESS` · `OORT_CSP_CONNECT_SRC`, `--public-origin` 파생)는 이 브랜치에 랜딩돼 있어 VPS 분기에 수록. Railway/Fly/AWS/GCP 는 SH-5 템플릿 전까지 §3.2 포인터.
- 실측 (영문 §3.1만). 스크래치 `$HOME/oort-sh4a-install`, `COMPOSE_PROJECT_NAME=oort-sh4a`, published digest from `releases/latest.json`. `scripts/oort doctor --json` `summary={"pass":28,"fail":0,"skip":3,"verdict":"PASS"}` exit 0. GET `/` 200, `POST /v1/auth/login` 200 (`accessToken` 존재, 원문 폐기). 사람 개입 0. GUI 브라우저는 MCP 금지라 REST 로그인으로 대체. 위상 6. 성공 up+doctor 약 17s (이미지 캐시). `/tmp` Docker Desktop 마운트 실패와 leftover pgdata는 문서에 반영 후 재측정.
- `scripts/check_release_manifest.sh` 초록. `@sha256:` / `app.oor7.com` 0. CDP는 §3.3만. glob `docs/SELF_HOST*.md` 는 `.ko.md` 를 포함 (게이트 미수정).
- SH-3b `oort status/logs/upgrade/backup` 미랜딩 — §4는 산문 유지. runtime-unverified: Grok Bot Funnel 1h soak, Railway/Fly E2E (SH-5).

## SH-2 공개 엣지 파라미터화 (#1926, 2026-09-06, R3)


- R1 템플릿·compose `:?`·생성기 파생(LiveKit 포함)·와일드카드 거절·로컬 엣지 deny·문서는 유지. R2 는 게이트 두 본이 이 브랜치에서 빨개지던 자리만 고친다. R3 는 `infra/rust/overlays.env.example` 에 `oort_public_edge_env_keys` (`OORT_SITE_ADDRESS` · `OORT_CSP_CONNECT_SRC`) 자리표시를 채워 docs 게이트 step 12 를 닫는다.
- `scripts/verify_ncp_centrifugo_boundary.sh` 의 `derive_caddy_origin` 이 `{$OORT_SITE_ADDRESS}` 를 `--site-address` 또는 env 의 `OORT_SITE_ADDRESS` 로 풀어 사이트 1개로 센다. 픽스처 호스트 `edge.example.test` (은퇴 호스트 0). deny 앞·hash·redaction·untrusted trust marker 는 그대로.
- `scripts/tests/test_self_host_env_modes.sh` 는 `--public-origin` 유지보수 계약을 키 단위로 잰다: `CENTRIFUGO_ALLOWED_ORIGINS` 1줄에 오리진 1회, `OORT_CSP_CONNECT_SRC` 1줄에 `https://host`+`wss://host`, `OORT_SITE_ADDRESS` 1줄, `*` 0. `--public-origin` 없으면 두 키 0행.
- `scripts/tests/test_public_edge.sh` 의 기동 거부는 compose `:?` (stderr `set OORT_SITE_ADDRESS`). `caddy adapt`/`validate` 미설정 실패는 부수 효과(`encode` 가 전역 옵션). `infra/rust/Caddyfile` 머리 주석도 같다.
- 실측. R1 RED: `canonical_caddy_site_count expected=1 actual=0` / `untrusted origin did not fail by trust marker label=attacker`; `https-count=2` `wss-count=2` `modes_exit=1`. GREEN: `test_ncp_centrifugo_boundary_exit=0` `modes_exit=0` `test_public_edge_exit=0` `verify_ncp_centrifugo_contract_exit=0` `verify_web_serving_exit=0`. 스크래치: 템플릿에 `evil.example.test {` 추가 → `canonical_caddy_site_count expected=1 actual=2`. `OORT_CSP_CONNECT_SRC` write 삭제 → `csp_line_count=0` `csp_scratch_exit=1`. `scripts/local_gate.sh --profile docs` 는 `add_static_commands` 에 두 게이트가 들어 있다. 이 프로파일은 docker 스택이 아니라 compose config·정적 검사다. R2 `local_gate_docs_exit=1` 은 step 12/99 `check_compose_env_templates.sh` — `overlays.env.example` 에 R1 의 두 키가 없었다. R3 RED (pre-fix, 이미 측정): `required variable OORT_CSP_CONNECT_SRC is missing a value` / `required variable OORT_SITE_ADDRESS is missing a value`. GREEN: `[compose-env] PASS: 11 rendering(s)` `local_gate_docs_exit=0` (`LOCAL_GATE_ALLOW_DIRTY=1`, 99/99). `test_public_edge.sh` 는 example 파일을 읽지 않아 재실행하지 않음.
- runtime-unverified: 실호스트 ACME.

## UX-R2b 웰컴 킥오프 클라 스테이지 (#2002, 2026-09-05 R3)

- ADR-0181 D7. Leading row of `#general` (`channel.kind === "public" && channel.name === "general"`). Unique-kind slice of `CLOUD_BODIES` (3 marks, size/rotate/tone per body) + "팀이 준비하고 있어요". Decision is undefined until timeline backlog **and** directory/roster have `status === "success"`; unresolved author → do not show. First agent-authored message or `agent.partial` exits the stage (`--motion-standard`, fill `both`); that row plays `enter-conversation` once. Backstop `WELCOME_BACKSTOP_MS = 120_000` runs the same persist as opener exit (`clearFreshSignup` + shown-marker). Backstop card is one sentence: 「아직 준비하고 있어요. 진행 상황은 {label}에서 볼 수 있어요.」 with one in-sentence link whose text is exactly `AGENTS_NAV.label` (「에이전트」) and `href` is `AGENTS_NAV.to`. While the stage is mounted **or** the mount decision is still pending (fresh marker + roster/backlog not settled) the empty-state 「첫 메시지 쓰기」 CTA is not rendered; after a do-not-show decision it returns. Settings › 워크스페이스: operator-only `welcome_agent_member_id` / `welcome_prompt` (#1800 pattern); prompt has no `maxLength` (2000+ shows `WELCOME_PROMPT_LIMIT_SENTENCE` once and disables save); save error is the `role_labels` `<p class="text-meta text-danger" role="alert">` shape.
- R3 onto `origin/track/uxui` `0a87e8c5` (UX-R2a #2088). Merge `bd5fd1d3`: tip `freshSignup.ts` (planner seam v2 `SLOT`; `cmp` vs `claudedocs/resume-2026-09-04/seam-freshSignup.ts` clean; file never edited on this round) + unioned STATUS top blocks. gitleaks range `origin/track/uxui..HEAD`: historical fingerprints `b97d2240…:freshSignup.ts:generic-api-key:13` and `2874c2e8…:freshSignup.test.ts:generic-api-key:10` baselined in `.gitleaksignore` after the #2001 section; test binding renamed `FRESH_SIGNUP_SLOT`. Re-run: `9:03PM INF no leaks found`.
- 실측. Product-path Chromium (real `Timeline` + `useTimeline` + `useWelcomeKickoff`). N=5 in one test (source `npx --prefix clients/web vitest run --root clients/web src/features/welcome/WelcomeKickoff.chromium.test.ts`): `deltaMs min=15.2 median=16.2 max=16.6 N=5 samples=16.4,15.2,16.2,16.6,15.9`. Same file one-sample: `exitEndedMs=434.0` `arrivalStartMs=450.6` `deltaMs=16.6` `arrivalDuringExit=false`. H1 fill-both: `maxAfterEnd=0.0000`. Reduced-motion pose: compiled `.welcome-kickoff-body` `transform: translateY(0) rotate(var(--onboarding-body-rotate, 0deg))` equals the rise `to` keyframe; Chromium `atan2` of the matrix matches each `CLOUD_BODIES` rotate (±0.6°). Mark size is computed `width`/`height` (AABB of a rotated 22px square is not 22). Compiled `.welcome-kickoff-mark` contains `var(--motion-instant)` / `var(--motion-arrival)` / `var(--motion-ease-arrival)` and no `\d+ms`. Every compiled selector mentioning `data-onboarding-body` or `data-stagger-index` begins with `.onboarding-cloud-body` / `.welcome-kickoff-body` / `.welcome-kickoff-mark`. PATCH body `{ welcome_agent_member_id: "00000000-0000-7000-8000-000000000201", welcome_prompt: "직접 편집한 프롬프트" }` (no `role_labels` key). Press-ledger CEILING 12 (M1 text-link residue at `WelcomeKickoffStage.tsx`).
- Capture `CAPTURE_PORT=8645`. PNG counts: 5 light + 5 dark = 10. Two consecutive full `capture:design` runs both exit 0 (`/tmp/uxr2b-r3-cap1`, `/tmp/uxr2b-r3-cap2`; an overlapping first retry aborted at press-triplet `design-gallery` 30s while `gate:shell` was still on 8647 — not a welcome scene). All 10 sha256 MATCH. Settings-welcome: `scrollIntoView({block:"start"})` then in-viewport assert (both edges); revert scroll → `settings-welcome light inViewport:false top:884 bottom:1162 vh:800 vw:1280` (same geometry R2 photographed). Block fitted; full-page screenshot. 「자리가 멎지 않았다」 retry is only on welcome stage wait. Arrived wait is product `enter-conversation` then one `waitForAnimations`. Backstop: `page.clock.resume()` + `waitForAnimations` + mouse off viewport.

| file | sha256 (cap1 = cap2) |
|---|---|
| welcome-stage-light.png | `e1e34065b3b857187e24a8ee5c4c02a5e93f2c715bd81d40e7fe931f6c95ec03` |
| welcome-stage-dark.png | `3106f17d98e0442141325be74ab5073b53df549a82c3ba2e212a92b4807d3450` |
| welcome-stage-reduce-light.png | `323d19eb60ee75ce6143d533a3d7478858b953ccc2cd96f5d0e978b1a2a257ca` |
| welcome-stage-reduce-dark.png | `4622195548ba6560afe64fae2e9a556e445dfc69d9162cb63f8ff7436f82d4a8` |
| welcome-arrived-light.png | `a228307c252868d9f10c7af74095935e5dede341951e7dde62121853014811c2` |
| welcome-arrived-dark.png | `dae57c2aa45ba3263fcd684847a4cecd2dab4374237e481c6bf98e5cab0ad1f9` |
| welcome-backstop-light.png | `0c384e43c7592b82987f6a676d4eab4d042878abed403f98a786bae396eae7df` |
| welcome-backstop-dark.png | `f7f6e6fdec625da4da22488b5179294562e078e37f4816cf3c83f60aa8b01d31` |
| settings-welcome-light.png | `e2ed09c57b4809e82605dae5221a5e2d59cc9b7a6bec9300167998593bfbad3c` |
| settings-welcome-dark.png | `0bb56410f2867102abde2bb0e36af1ab536136f27204b506a77762588cb00114` |

- `SHELL_GATE_PORT=8647 SHELL_GATE_FOCUS_ONLY=1` GATE PASS (`GATE PASS: the shell held at every window size.`). `PLAYWRIGHT_BROWSERS_PATH=/nonexistent` welcome vitest 62 passed, 6 skipped, 0 failed. preflight web 14/14 + core 5/5. lint 0 errors (15 warnings: 14 pre-existing + harness `only-export-components`). Web suite 232 files / 2777 passed. Core 99 files / 1980 passed. `scripts/verify_merge_tree.sh --base origin/track/uxui --head HEAD` PASS (base `0a87e8c5`). design-review는 이 워커가 하지 않음.
- 폰 무접촉. runtime-unverified 아님.

## UX-R2a 온보딩 S3 프로필 스텝 (#2001, 2026-09-05, R2)

- Track UXUI. S3 = 표시 이름 only. Personal avatar upload route does not exist (workspace avatar is operator-only). No disabled avatar control on S3.
- `onboardingFlow` steps `landing|gateway|account|profile`. `progressLabel`: gateway `2/4` · account `3/4` · profile `4/4`. `transitionFor("account","profile",false)` = line-slide forward; reduced-motion = none.
- Join with `createdMember: true` holds the session, paints S3, calls `onLoggedIn` on skip / save / fail-forward. Sign-in and `createdMember: false` skip S3. `joinWithInvite` returns `JoinResponse` (`createdMember` boolean; non-boolean = `WireShapeError`). That hardness is contract-correct: openapi marks `createdMember` required. Shared rule `DISPLAY_NAME_MAX_CHARS = 100` mirrors `normalized_join_display_name` (`server-rust/crates/momo-settings/src/join.rs:167`): trim · non-empty · ≤ 100. Empty/whitespace sentence `"표시 이름을 비울 수 없습니다. 한 글자 이상 적으세요."` · over 100 `"표시 이름은 100자까지 쓸 수 있습니다."` ProfileSection and S3 consume the same function. Empty never PATCHes (primary disabled; wire mock `changeMyDisplayName` not called).
- Join `applyLogin` persists before S3 `onLoggedIn`. Hold: `holdSessionRestore` so App does not enter `restoring` and unmount ConnectPage. Measured: first capture waitFor(`onboarding-profile`) 30000ms timeout; after hold, S3 paints. S3 render is `step === "profile" && pendingJoin` so `finishProfile` has no `!pendingJoin` early return. Unmount cleanup calls `releaseSessionRestore()`. A leaked hold is inert for the rest of this page lifetime: `signIn` claims `attempted.current` first (design-review #2088 R1 sabotage S5: deleting the S3 release left 38/38 green). Release still runs on skip · save · 계속 · unmount (each `toHaveBeenCalledTimes(1)`, `sessionRestoreHeld()` false).
- Seam `clients/web/src/features/welcome/freshSignup.ts` (bytes from `claudedocs/resume-2026-09-04/seam-freshSignup.ts`, file untouched in R2). `markFreshSignup` runs at join success (`createdMember: true`), before S3 shows. `ClaimPage` unchanged. sessionStorage survives a same-tab reload.
- S3 coverage is `ConnectPage.test.tsx` (mocked `@momo/core/lib/api`, PATCH bodies asserted) plus capture scenes. No e2e lane submits a join today (`advanceToAccount` defaults `path: "server"`; a join needs a live invite). `skipProfileIfPresent` deleted (zero callers). A join e2e lane is a gap (NOTES). Sign-in gates unchanged.
- Test counts: `onboardingFlow.test.ts` 8 → 9. `ConnectPage.test.tsx` 11 → 34. `model.test.ts` 47 → 49. `joinApi.test.ts` 3 (new). Web suite **2701** passed (226 files). Core **1980** passed (99 files).
- Capture `CAPTURE_PORT=8641`: run 1 full **exit 0**. Runs 2 and 3 wrote the S3 scenes then aborted on nonempty intro-scroll (`#2057` N-4, two honest attempts). S3 sha256 run 1 = run 2 = run 3. Scenes: `onboarding-profile` (rest), `onboarding-profile-field-error` (101-char sentence), `onboarding-profile-banner` (fail-forward: banner + 다시 시도 + 계속), both schemes, desktop + 390.

| file | sha256 |
|---|---|
| onboarding-profile-light.png | `68d6d54e5d1656d11e382155e81e506482fa9f65d3dde714c187085d4c3e997e` |
| onboarding-profile-field-error-light.png | `325a1e6b72f77e4bfd58d5cd423bd4d8a847b6395d036179d217ac86d1735f11` |
| onboarding-profile-banner-light.png | `3c14ab0aa72b29dc8f47c9857ddd85d1baf94ad9f8814055525f3e6800d8191f` |
| onboarding-profile-dark.png | `3bec98744e0a3d36da78752ab1742e953b53cf38c31987a5383ab926be00aa91` |
| onboarding-profile-field-error-dark.png | `5e70234066563847eca6928ec1eb384906668800ecf56ae3588e449f8c9cb681` |
| onboarding-profile-banner-dark.png | `c4dbc2377bbd8170f036ae13db21a30bc9d145e0db1080b9714602919e396060` |
| mobile-onboarding-profile-light.png | `c1010df78d9991244954f2ab03c03cbb51c91d561faae3b04b2828477c073680` |
| mobile-onboarding-profile-field-error-light.png | `cb4841bcfb8b1ee17f175db67ec976ceabe99931db192d2c013b5f50279c5f04` |
| mobile-onboarding-profile-banner-light.png | `e17f9124898558a15fcecffb5ac13b0e226dc661a4ffc1e7af9d3db0e30fe777` |
| mobile-onboarding-profile-dark.png | `35589db5bddcd4f21ef9481ae06475d7df875147dde53ab5a42c5a41a28eb5ad` |
| mobile-onboarding-profile-field-error-dark.png | `12e3e775851459f36a1be2273ee647548e5643fdee0456dce9771768d4657668` |
| mobile-onboarding-profile-banner-dark.png | `877305970029a9ddd07165725d77e040aa3e3fc7b3b45e04ef191c2389ec582e` |

- Preflight web 14/14 + core 5/5. Lint 0 errors (14 pre-existing warnings). `SHELL_GATE_PORT=8643 SHELL_GATE_FOCUS_ONLY=1` GATE PASS. `npm --prefix clients/mobile run typecheck` green. `scripts/verify_merge_tree.sh --base origin/track/uxui --head HEAD` PASS. smoke/connect e2e not run (`MOMO_EMAIL` unset).
- runtime-unverified: live smoke/connect; join e2e lane. design-review is not this worker.

## UX-R1b 드로어·스레드 패널·⌘K enter/exit (#1997, 2026-09-04)

- ADR-0179 D1·D4·D8·D9. `motion@12.23.24` MIT 직접 의존 1개(전이 `framer-motion` MIT). CSS 키프레임 + `AnimatePresence`/`usePresence`/`useReducedMotion` — `motion.div` animate/exit 스타일 없음(inline_style hard-zero). allowlist 3파일: `QuickSwitcher.tsx` · `ThreadPanel.tsx` · `Sidebar.tsx`. preflight `motion_lib_scope` 14번째 분류.
- 실측. Playwright 레인(`skipIf` Chromium)은 제품 컴포넌트(`Sidebar` 390 드로어·스크림, `ThreadPanel`, `QuickSwitcher`)의 밀리초. 브라우저 없는 반쪽은 컴파일 CSS(`.sidebar-drawer` `--motion-fast`) **그리고** jsdom 제품 마운트(스레드 interrupt, 스크림 persist, 팔레트 focus/keystroke class, 세 표면 reduced-motion detach). 숫자는 computed `animationDuration`/`transitionDuration` + 닫힘 closed-frames. 두 스킴 동일.

| 표면 | 방향 | light | dark | reduced-motion |
|---|---|---|---|---|
| 390 드로어 패널 | enter/exit 대칭 `--motion-fast` | 180ms | 180ms | 0 |
| 390 스크림 | enter `--motion-fast` / exit 재생(closed frames>0, dwell≥140, 이후 detach). `backdrop-filter: blur(5px)` (D6, 이 PR에서 스크림에 붙음) | 180ms | 180ms | 0 · R10 in-page detach 3.4–3.7ms (n=3, ±1 ms run-to-run; bound <50) · scrimExitPath=reduce |
| 스레드 패널 | open `motion-slide-in-end` `--motion-standard` | 240ms | 240ms | 0 |
| 스레드 패널 | close `motion-slide-out-end` `--motion-fast` (AnimatePresence 유지) | ≥140ms dwell | ≥140ms dwell | 즉시 detach |
| ⌘K 오버레이/콘텐츠 | open `MODAL_*` 200ms · Escape exit dwell≥140 (bound; R10 n=3 light 157.1–163.7 / dark 158.2–163.3, ±7 ms run-to-run) · AnimatePresence. 행 필터 재렌더 모션 0 | 200 / 150 | 200 / 150 | 0 · R10 n=3 in-page palette=1.5–8.3ms exitPath=reduce |
| 데스크톱 사이드바 접기 | `--duration-sidebar` = `--motion-standard` | 240ms | (light와 같은 CSS) | 0 (`transition: none`) |

- 390 드로어 **패널**은 DOM에 남는다(스크롤 보존, UX-R0). AnimatePresence는 스크림에만 (`SidebarDrawerScrimLayer`). 데스크톱 접힘은 타이틀바 토글 계약 유지(`sidebarPane.test.ts`).
- 스레드 패널 presence는 부모 `root`가 민다. `onClose()`는 사용자 의도에서 즉시. 로컬 `leaving` 없음. 닫힘 중 같은/다른 앵커 클릭은 안정 `key="thread-panel"` 슬롯을 재사용해 exit을 끊는다.
- R1d `playEntrance`/`onEntranceConsumed` ThreadPanel 이음 유지(`arrivalWiring.test.ts` · `Timeline.burst.test.tsx`).
- R11: merge `4d9ade23` (`origin/track/uxui` into this branch). 105/105 single-sided files byte-identical; dual-sided hunks accounted. R1e `scrim-press` landed on the Presence scrim.
- R12: `motion-fast-enter` fill is `backwards` (not `both`). A finished fill-`both` fade kept `opacity: 1` at the animation origin and outranked `.scrim-press:active { opacity: .92 }`. Measured after enter (CDP `:active`): product ≈ 0.92; restore `both` on the fixture → 1 (RED). Capture `assertEnterMotionPressAfterFill` waits for enter to finish then forces `:active` on `motion-*-enter` interactives (390 drawer requires the scrim). Thread panel / ⌘K overlay+content have no `:active` opacity on the enter node — finished fill does not hide a press step there.
- red proof (수리 떼면 실제로 붉음):
  - 닫힘 중 20/60/100ms 에 같은/다른 `thread-anchor` 클릭 → 패널이 요청한 root 로 열린다. `leaving`+지연 `onClose` 를 되돌리면 같은 스윕이 안 연다.
  - `prefers-reduced-motion: reduce` 에서 팔레트/스크림 in-page detach <50ms. MutationObserver 를 Escape 전에 팔레트 루트에 달고 `performance.now()` 로 제거 시각을 찍는다. Playwright `waitFor(detached)` 지연은 `observeLag` 로 따로 찍고, 경로는 `data-exit-path`(duration 으로 추론하지 않음) — 팔레트와 스크림 둘 다. R10 full-suite ×3 verbatim (discard 없음):
    ```
    panelMotion: reduced-motion detach scrimInPage=3.4ms scrimExitPath=reduce paletteInPage=8.0ms exitPath=reduce observeLag=19.0ms · dwell light=157.1ms dark=161.8ms
    panelMotion: reduced-motion detach scrimInPage=3.7ms scrimExitPath=reduce paletteInPage=1.5ms exitPath=reduce observeLag=3.2ms · dwell light=163.7ms dark=163.3ms
    panelMotion: reduced-motion detach scrimInPage=3.7ms scrimExitPath=reduce paletteInPage=8.3ms exitPath=reduce observeLag=17.2ms · dwell light=162.4ms dark=158.2ms
    ```
    range (n=3): scrimInPage=3.4–3.7ms (±1 ms run-to-run) paletteInPage=1.5–8.3ms · dwell light=157.1–163.7ms dark=158.2–163.3ms (±7 ms run-to-run). Guard bounds are <50 ms detach and ≥140 ms dwell, not the sample range. jsdom: computed duration 150ms 여도 `useReducedMotion` 분기가 20ms 안에 뗀다 — 분기를 지우면 팔레트는 남고 Chromium 은 `exitPath=timeout` 으로 붉다. Portal `forceMount` 는 분기를 닿게 하는 게 아니다(훅이 ref 읽기 전에 결정). DialogContent 가 상속하므로, 없으면 Radix Presence 가 콘텐츠를 지워 jsdom 「20ms 에 아직 마운트」 가드가 공허해진다. forceMount 는 가드를 우리 effect 의 것으로 유지한다. duration 0 (훅 false) 은 `setTimeout(0)` — R6 `duration<=0 return` 은 hang. CSS exit 은 forceMount 없이 이미 돈다. 스크림 분기 삭제는 jsdom 빨강 + Chromium `scrimExitPath` 가 reduce 가 아니어서 빨강.
  - 스크림을 닫아도 노드가 `data-state=closed` 로 남았다가 exit 뒤 detach (jsdom, 제품 `Sidebar` 마운트). `{asDrawer && drawerOpen ? <SidebarDrawerScrimLayer open={true}/> : null}` 로 바꾸면 닫힘 즉시 null — Chromium 없이 붉다. AppShell `className=["']sidebar-scrim["']` 정규식은 증거가 아니라서 지웠다.
  - 연 팔레트에 행 ≥5 (하네스 `abc-*` 5채널) · 키 3타+Backspace 뒤 행 > 0 · `[cmdk-item]` `animationstart` 0 (open-container=1, type-items=0, rows=6). `PALETTE_ITEM_MOTION`/`motion-item-fade` 를 행에 되돌리면 open 에서 item animationstart **11**. jsdom 은 행 class 에 `motion-item-fade` 가 있으면 붉다.
  - 팔레트 닫힘 후 `activeElement` 는 opener (`open-palette`). owner 는 `restoreRef` effect (`open === false` 에서 `target.focus()`). 그 effect 를 빼면 Escape·항목 선택 모두 `BODY` (jsdom 2/2, Playwright `focus=BODY`). `restoreDialogOpenerFocus` 는 이 경로의 owner 가 아니다.
  - `MOTION_LIB_ALLOW_RE` 를 `src/` 로 넓힌 사본 → `--selftest` 실패. 네 번째 파일 import → 스캔 빨강. 스크립트 목록과 코드 import 가 갈리면 vitest 빨강.
  - 스크림 enter 가 끝난 뒤 CDP `:active` opacity ≈ 0.92. `motion-fast-enter` fill 을 `both` 로 되돌리면 같은 측정이 1 (R12 RED). 캡처에서 `assertEnterMotionPressAfterFill` 을 빼면 원장 핀이 붉다.
- `Timeline.burst.test.tsx` (`expected 1 to be 3`) 는 선행 flake (#2050 N-7). isolation 20× head 0/20 · base 0/20. full suite 20× head **1/20** · base **2/20**. 이 PR 이 비율을 올리지 않아 버스트 테스트는 안 만졌다.
- 캡처 `CAPTURE_PORT=8625` R12 **exit 0** (intro nonempty light/dark 포함). `enter-press drawer` light/dark `:active opacity=0.92 fill=backwards`. R10/R11 은 intro abort 를 기록했고, 이 런은 완료됐다. 선행 flake 는 남을 수 있다.
- `SHELL_GATE_PORT=8627 SHELL_GATE_FOCUS_ONLY=1` GATE PASS(타이틀바 토글·390 Escape는 스크림 exit 후 detach). 폰 무접촉. design-review는 이 워커가 하지 않음.
- R7: `duration<=0 return` 삭제. duration 0 은 다시 `setTimeout(0)` (스레드/스크림과 같은 폴백). Content `forceMount` 삭제 — Portal 만 로드베어링. 훅 분기 삭제 시 jsdom 빨강(Portal 유지), Portal 도 빼면 초록. 제품: 연 팔레트에서 reduce 토글·userCSS `animation:none` 3회 닫힘 `[0,0,0]` (hunk 있으면 `[1,1,1]` + `data-scroll-locked=1` + 휠 delta 0).
- R6: 팔레트 `useReducedMotion` 분기는 Portal `forceMount` 가 닫힘 동안 노드를 붙든다. R6 의 `duration<=0 return` 은 제품 hang 이라 R7 이 되돌림. CSS exit 은 그대로 (dwell≥140, reduced 0s).
- R8: click-behind 가드는 `data-state=closed` 를 한 페이지 턴에서 기다린 뒤 30/60/90ms 를 샘플하고, 노드가 떨어지면 pe 단정을 멈춘다(120ms 는 150ms exit 안에서 detached `''` 를 읽음). `!` 를 뺀 스크래치 → 두 파일 모두 `t+30ms overlay pointer-events: expected 'auto' to be 'none'`. full-suite 10× 두 파일 0 flake (overlayMotion 10/10 · panelMotion 10/10).
- R9: `<10ms` discard 와 `!node`/`forceMount` 레이스 문장을 지움. 짧은 측정은 데이터다. 팔레트 detach 는 in-page MutationObserver. 경로는 `data-exit-path`. 레인은 측정되는 즉시 찍는다.
- R10: `forceMount` 주석 세 곳을 실측으로 고침 — 분기를 닿게 하는 게 아니라 DialogContent 상속으로 jsdom 가드가 Radix 제거에 안 먹히게 한다. 스크림에도 `data-exit-path`(Chromium `scrimExitPath=reduce`). click-behind `if (!sample.connected) break` 삭제(루프가 30/60/90 을 샘플). `console.info` 는 expect 앞. dwell 범위는 n=3 + ±7 ms run-to-run.
- R5: 닫힌 모달 오버레이/콘텐츠는 `data-[state=closed]:pointer-events-none!` (컴파일 규칙 `pointer-events: none !important`). Radix 인라인 `auto`를 클래스가 이긴다. `DialogOpenContext`·인라인 `style.pointerEvents`·eslint-disable·preflight-allow 없음. 가드: 컴파일 CSS `!important` + Playwright Escape 뒤 30/60/90ms 클릭(팔레트·채널 만들기·로그아웃 확인·섹션 삭제). `!` 를 빼면 컴파일 단정 빨강이고 제품 클릭이 다시 삼켜진다. dist CSS 해시로는 `!` 를 증언하지 못함 — 같은 리터럴이 `overlayMotion.test.ts` 에 있어 Tailwind 가 시험 텍스트를 스캔한다 (README §2.3 `pt-[13px]` 함정). 가드는 상수를 컴파일한다.
- NOTES (R10): N-1 캡처는 게이트 줄 — PASS 라고 쓰지 않음 (선행 nonempty intro). N-2 `Timeline.burst` flake 선행 #2050. N-3 `SidebarRowContextMenu.test.tsx` flake 선행 (#2050/#2057 형태), 이 PR 무접촉. N-4 `!important` 미집계 #2074, 스크립트 이 PR 밖. N-5 `previews/previews` 는 캡처 레인이 만들지 않음. N-8 팔레트 리스트가 `채널` 헤딩에서 잘리고 스크롤됨 — 선행, base-identical. M-2 UnreadPill 이 스크림/팔레트 위에 그려지고 클릭을 가로챔 — 선행·base-identical, **#2075** 소유, 이 라운드에서 안 고침.
- R4 기록(정정): 인라인 `pointerEvents` + overlay-only `forceMount` 제거는 기구가 무거웠고 Portal 상속으로 overlay `forceMount` 제거는 no-op 였다. 동작은 R5 가 그대로 두고 기구만 바꿨다.
- N-2 `Timeline.burst` flake 2/5 at load 7.88 는 선행 (#2050 N-7). 이 PR 이 파일을 안 만진다.
- N-3 팔레트 리스트가 `채널` 그룹 헤딩에서 잘리고 행이 안 비치는 기하은 base 와 byte-identical. 선행.
- N-4 프로필 메뉴 → 로그아웃 확인 직후 첫 Escape 가 나가는 DropdownMenu 에 먹히는 경우 있음 (head 1/4 · base 2/4). R1a-era 선행 (#2049 M-4 영토).

## UX-R1e 눌림 상태 전수 + shrinking ledger + 3짝 캡처 (#2000, 2026-09-05)

- ADR-0179 D5 스윕 단위는 **컨트롤**(태그/role)이지, 그걸 감싼 행이 아니고, 「이미 `hover:` 가 있던 요소」도 아니다. `press` 는 활성화 대상 자신만 진다. 비상호작용 `div`/`li`/`span`/`section`(interactive role 없음)에 `press` 를 두면 원장이 붉다.
- 전폭은 폭이다: 렌더 폭 ≥ 480px 이거나 콘텐츠 열의 50% 이상인 상호작용 행/카드는 fill-only (`hover:bg-surface-hover active:bg-surface-pressed` / `press-instant-fill`, `.press` 스케일 없음). 소스 휴리스틱(목록 행·`w-full`·`<summary>`·부모 `li` 의 Link/앵커 행 — FeedRow 는 클래스가 아니라 레이아웃으로 열을 채운다)과 캡처 레인의 `getBoundingClientRect` 프로브가 **찍는 장면마다** 같이 센다(inbox · activity · channel · thread · drafts · search · settings · agent hub · connect). 본문 메시지/대기 행·설정 토글 행·카드 `<summary>`·메뉴 행·리마인더 행·인박스 FeedRow 가 그 자리.
- 라이트 `#efe2c8` (L 0.769136 < hover 0.770416). vs hover 대비 1.0016 · dE 0.0257 · Δhue 0.00°. vs `--accent-soft` 대비 **1.0528 · dE 0.0210** · Δhue 9.83°. ink 12.512 · ink-muted **4.5013** (AA+0.0013) · line-strong **3.024** (3:1+0.024). ink-muted ≥ 4.55 **그리고** line-strong ≥ 3.05 를 같이 넘는 해는 라이트 띠에 없다(hover 자신 muted 4.508 · line 3.029). 그릇 여덟 쌍 1.101–1.118 / dE 0.038–0.048. 다크 `#262335` (L 0.0187, 칩 그릇 띠 .0192~.0320 **밖**) · vs hover 1.007 · dE 0.0204 · ink-muted 5.395. 그릇 1.142–1.148 / 0.043–0.075. R3 라이트 `#eee2cc` 는 accent-soft 와 대비 1.0526 · **dE 0.0185** 로 §2.2 「대비는 넘는데 눈에는 같은 회색」이며 자가가 그 값을 넣으면 붉다. R2 `#ece3cc`/`#2d2c34` 는 라이트가 hover 보다 밝고 다크가 띠 안.
- 반경 있는 설정 `<details>` 는 `overflow-hidden` 으로 summary hover 채움을 자른다. 캡처 프로브는 AABB 꼭짓점이 아니라 **둥근 경로 안·호 밖**(각 모서리에서 축으로 2px + 짧은 대각)을 재고, 그 픽셀이 페이지 배경이어야 한다. `overflow-hidden` 을 빼면 light tl+2 = fill `231,227,219`(페이지 `247,246,243`), dark tl+2 = fill `38,37,44`(페이지 `23,22,26`).
- 선택 행은 hover 에서 선택 채움(`bg-accent-soft`)을 유지하고 press 에서 `active:bg-surface-pressed` 를 낸다. 전폭 행은 채움만(`.press` 스케일 없음). 콤팩트 칩·탭은 공유 base 에 `press` 를 두고 선택 팔에 눌림 채움을 더한다. 가드는 파일/컴포넌트 이름이 아니라 태그/role·전폭 정의·분기 전수다. 선택 팔에서 press/채움을 빼면 붉다.
- 설정 토글 행은 `<label>` 이 행 전체이고 릴리스 어디서나 토글된다. `checked` 는 선택 채움을 hover 에 유지하고 `active:bg-surface-pressed` 만 낸다(unchecked 만 `hover:bg-surface-hover`). 캡처: 체크박스 부모가 LABEL, 행 오른쪽 8px 히트가 LABEL, deadRight ≤ 2px. `settings-row-checked` 3짝이 그 분기를 찍는다.
- 텍스트 링크(정본 §2.6: `<a>`/`<button>`/`Link`/`NavLink` 의 렌더가 **글자뿐** — 밑줄 또는 `hover:text-`, **채움과 상자(어떤 `border*` ·배경 상자) 없음**. 패딩·`rounded-*`·터치 타깃만으로는 상자가 아니다. `hover:text-X` 의 X 가 rest `text-*` 와 같으면 호버가 아니다)는 `press` 를 안 든다. 밑줄만 있는 자리는 잔량. 상자 있는 밑줄 컨트롤은 `press` 를 유지.
- Ledger 전수 인구는 **태그/role** 이다. `hover:`/`press` 마커 게이팅 없음. 파일 이름 탈출 없음. N0=**476** · N1=**11**(텍스트 링크 잔량) · interactive-without-press **0** · 천장 **11**. 「has press」는 이름 있는 어휘만(`.press` · `active:bg-surface-pressed`, 또는 `:active` 가 `--surface-pressed`/`--motion-instant` 를 쓰는 `@utility` — 지금 `press-instant-fill` · `scrim-press` · `plugin-marketplace-row`). 이름 있는 눌림은 칠한다. `press-instant-fill` 만으로 전이만 선언하고 채움이 없으면 붉다. 천장보다 많으면 `hover-only control added at <file:line>`, 적으면 `lower the ceiling to N`.
- 3짝 표면 핀은 `PRESS_TRIPLET_GALLERY`/`INSITU` 와 갤러리 `data-testid` 의 **양쪽 집합 동등**. in-situ 는 message/pending/settings/settings-row-checked/drafts 다섯. 하나를 빼거나 더하면 붉다(부분문자열 핀이 아님).
- 이관 표면 compiled CSS: `transition-property` 에 transform 포함, outline-color 제외. 스케일은 `.press` 의 `scale(0.98)`. `duration-*`/`scale-*` 리터럴 0. 메뉴 행은 `press-instant-fill`(스케일 없음, `:active` 가 `--surface-pressed` 를 칠한다). 초안 행은 채움만(`hover:bg-surface-hover active:bg-surface-pressed`, `.press` 없음). cmdk 행은 선택 채움이 hover 이고 `data-[selected=true]:active:bg-surface-pressed` 가 선택 위를 이긴다(채움만, 변형 없음).
- 캡처: 갤러리 6 + in-situ 5 × rest/hover/active × 두 스킴, 390 은 라이트·다크 둘 다 in-situ+사이드바 행. hover≠active 는 픽셀 수가 아니라 픽셀당 OKLab dE ≥ 0.01. 레인은 **시작에만** `press-triplet*` 를 지운다. 3짝 카탈로그가 쓰인 뒤 다른 장면이 중단되면 세트를 남기고 카탈로그에 `# abort-after-triplet` 을 적는다. 중단 사유가 intro/scroll/timeout 이면 NOTES 에 선재 intro-scroll 플레이크(#2057 N-4)를 적는다. `capture:design` 이 그 플레이크로 exit 1 이어도 abort-keep 은 동작한다(N5-3 기록). `settings-notifications-{light,dark}.png` 는 가드된 장면만 쓴다(스윕은 그 이름을 건너뛴다). 같은 경로를 두 번 쓰면 레인이 붉다. 찍기 전 포인터를 뷰포트 밖으로 보내고 unchecked 「방해 금지」 행의 rest 픽셀이 `--surface` 와 같다.
- NOTES: 전폭 행의 `:active { transform }` 은 `none` 이다. R5 가 잰 AgentCard/ArtifactCard/UnfurlCards 638px 행의 12.76px 폭 손실은 `.press` scale(0.98) 이었다. 라이트 `--surface-pressed` 여백은 띠 바닥(16.7M 스윕, 구조) — 값을 바꾸지 않는다. N4-4 기록만. 칩 그릇 잔량 34(관전 터미널 토글 눌림 채움이 33→34). 천장 숫자는 잔량 표와 같고, 이미 잔량이던 컨트롤에 눌림 채움이 생기면 같이 오른다.
- R6 가 **닫혔다고 적었으나 닫히지 않은** R5 문장: M5-4 설정 「방해 금지」 rest 샷이 hover 채움이다(가드는 통과하고 스윕이 같은 파일을 덮어썼다) · M5-5 플러그인 상세 링크에 hover 가 없다(`hover:text-ink` 를 `text-ink` rest 위에 얹어 픽셀이 안 바뀌었다). R7 이 둘을 닫는다.
- R6 가 실제로 고친 R5 거짓 문장: 전폭이 `w-full`/클래스 토큰이다(제품 네 카드는 닫혔으나 FeedRow 1040px 는 R7) · `expandClass` 가 최상위 `return` 만 센다 · `disabled:cursor-not-allowed` 가 산 컨트롤을 인구에서 뺀다 · 이름 없는 `@utility :active` 가 눌림이다 · README 칩 잔량 33.
- R7 이 고친 R6 거짓 문장: 알림 PNG 한 파일에 작성자가 둘이다 · `hover:text-ink` 가 rest 와 같아도 호버다 · 전폭 프로브가 타임라인 세 장면뿐이다 · `press-instant-fill` 이 이름만으로 눌림이다 · 갤러리 17이름과 `@utility` 눌림 집합이 달라도 된다 · 칩 천장은 내려가기만 한다.
- R5 가 고친 R4 거짓 문장: 전수 인구가 hover-keyed 448 이다 · 선택 팔에 press 가 없어도 원장이 0 이다 · cmdk `hover:`/`active:` 가 선택된 행에 칠해진다 · 초안 행은 채움만이라 스케일 이동이 없다 · 캡처 중단이 완료된 3짝을 지운다 · 텍스트 링크 정본이 `<a>`/`<button>` 뿐이다 · `border-2` 가 글자 링크다.
- runtime-unverified 아님. 폰 무접촉. design-review는 이 워커가 하지 않음.

## UX-R1c 스켈레톤 blur 크로스페이드 (#1998, 2026-09-03)

- `Skeleton` 래퍼: 막대와 콘텐츠를 같은 grid cell에 겹치고, `ready` 시 `--motion-blur-arrival` + opacity를 `--motion-standard`로 크로스페이드. 호스트 높이는 `ready=false`일 때 막대 높이를 저장하고, 뒤집히는 `useLayoutEffect`에서 그 값으로 잠근 뒤 콘텐츠 높이로 같은 사다리·같은 창을 탄다(줄어듦·늘어남 같은 기구). 가드는 뒤집기 전 프레임부터 샘플한다. 막대는 정지(펄스 없음). 그 창이 끝나면 `is-settled`가 이미 콘텐츠 높이인 레이어에서 막대를 뺀다. `is-resetting`은 제자리 `ready` true→false(전이 0)이지 재마운트가 아니다. 프레임당 |Δh| 상한 12px는 줄어듦과 +14 늘어남에서 실측되고, +224(12채널)는 같은 240ms ease-out에서 첫 프레임 ~30px — 사다리이지 점프가 아니다(점프로 되돌리면 224).
- 호출부 57곳 식별자 이관. 같은 슬롯에서 `ready`가 뒤집히는 면은 9곳(Sidebar×2, ChatShell, Inbox, Drafts, Activity, Search, ThreadPanel, Reminders). 나머지 48곳은 `<Skeleton ready={false} />` self-closing — 예전 팝(DS-2 갤러리 표본·라우트 fallback 포함). 타임라인은 Virtuoso `height:100%` 스크롤러와 고정 높이 막대 블록이 충돌하므로 제외(주석 `Timeline.tsx`).
- runtime-unverified 아님. 캡처: Inbox+Sidebar, 모션 켜고 `skeleton-{light,dark}` + `skeleton-settled-{light,dark}` + 라이트 390(`skeleton-390-light` / `skeleton-settled-390-light`). Inbox 스켈레톤 프레임은 `**/approvals*` 홀드 + `[data-testid="inbox-route"] [data-ready="false"]`가 보증한다.
- `clients/web/measure/**`는 `npm run lint`·`typecheck` 대상(`tsconfig.measure.json`). Vite 진입은 `src/main.tsx`라 dist에 하네스가 없다. design pre-flight의 `measure/` 커버리지는 #2049 N-2.
- 폰 무접촉. design-review는 이 워커가 하지 않음.

## UX-R1d 메시지 도착 모션 `motion-enter-conversation` (#1999, 2026-09-03)

- ADR-0179 D3: 실시간 도착(타 사용자 `message.new`) 행만 `enter-conversation` 1회. REST 백필·리플레이 게이트·초기 로드·가상화 재마운트·자기 메시지·edited 는 0. `takeArrivalPlay` 단일점(momo-core). `animationName` 일치로 클래스 제거.
- reduced-motion: 재생 0 (ingest 가드 + 사다리 duration 0). UnreadDivider/Pill 무접촉.
- R2: 부분 복구(`recovered=false` + `hasRecoveredPublications=true`) 는 리플레이로 읽는다 (`subscribeHuddle` 과 같이 구독 컨텍스트 전부). 스레드 패널도 같은 live 행을 재생. `settlesPending` 팔 삭제(런타임 불가 픽스처). 키프레임 `to` 끝점·iteration-count 1·`both` 단정.
- R3: grant→class 이음은 실제 `MessageRow` 렌더(`data-entrance-play`·행 자신의 클래스). ChatShell consume 바인딩 2곳. 키프레임은 캐스케이드 승자(마지막 블록).
- R4: 같은 틱 라이브 버스트 3건은 **가상화 `Timeline` + 실물 react-virtuoso** 경로에서 3/3 재생(jsdom 마운트 행 + Chromium `motion-enter-conversation` 시작 횟수). grant 는 행 마운트(consume)까지 유지하고, leftover 상한은 스크롤-업일 때만 쓸어 낸다(페인트 틱 상한은 virtuoso 의 늦은 커밋을 앞질렀다). ChatShell 이음은 JSX AST(주석에 남은 문자열은 세지 않음). `subscribeChannel` 포워딩은 credential-free 유닛(`realtime.channelRecovery.test.ts`); Centrifugo 전송 실측은 계속 `gate:resume`.
- NOTES: DS-2 `MOTION_VOCABULARY` 는 `motion.css` `@utility` 를 손기입하고 `enter-conversation`(및 UX-R1a `scrim-blur`)이 빠진다. 이 브랜치 스코프 밖 — 오케스트레이터가 따로 티켓. R5(`useLayoutEffect`→`useEffect` 소비) 는 동작 보존 리팩터이지 결함 아님: 같은 커밋에서 자식 effect 가 부모보다 먼저 돌고, 부하 속성은 「grant 를 읽는 렌더보다 먼저 상한을 돌리지 말 것」이며 그건 P1 이 이미 핀한다.
- 캡처는 `waitForAnimations` 정착 프레임(REST 픽스처라 도착 모션 0이 맞다). `gate:seq`·`gate:resume` 은 `MOMO_EMAIL`/`MOMO_PASSWORD` 미설정 + `127.0.0.1:28000` 미기동으로 exit 2 — **runtime-unverified**, 소유 #1999. `gate:resume` 은 실제 Centrifugo 복구를 도는 유일한 레인이라 전송 실측은 여기 남는다. 클라 증명은 `useTimeline.arrival.test.tsx` + `MessageRow.entrance.test.tsx` + `Timeline.burst.test.tsx` + `realtime.channelRecovery.test.ts`.
- red proof: live=1 스텁 0에서 붉음 · 소비 생략 시 재마운트 0이 1로 붉음 · animationName 불일치 시 클래스 잔류 · 키프레임 끝점/1회/`both` 불일치 시 motion.test 붉음 · 부분 복구를 live 로 읽으면 하네스가 붉음 · `playEntrance` 무시·클래스 자식 이전·두 번째 consume 탈락은 행 렌더가 붉음 · 페인트 틱 상한은 가상화 `Timeline` 버스트가 1/3 로 붉음 · ChatShell 바인딩을 주석으로 남기면 JSX AST 가 붉음 · `subscribeChannel` 이 `hasRecoveredPublications` 를 버리면 channelRecovery 가 붉음.

## UX-R1a 모달·팝오버·드롭다운·컨텍스트메뉴 enter/exit (#1996, 2026-09-03)

- ADR-0179 D4 비대칭: dialog overlay+content는 `MODAL_*_MOTION`(열림 200 / 닫힘 150), popover·dropdown-menu·context-menu는 `POPOVER_MOTION`(240/180). 스크림 `scrim-blur` 5px. Radix Presence는 Content가 닫힘 동안 마운트돼 있을 때만 exit을 기다린다(forceMount 없음). `{open && <DialogContent/>}`는 Presence보다 먼저 언마운트해 닫힘 애니메이션이 안 돈다 — 제품 다섯 곳(채널 만들기·로그아웃 확인·섹션 이름/삭제·채널 나가기)은 ShortcutHelpDialog처럼 유지. Escape는 닫힘을 시작한 그 키만 삼킨다.
- native `<select>`는 OS picker라 data-state 모션 불가(계획 이탈). reduced-motion duration 0. 캡처 overlay 장면은 `waitForAnimations`.
- red proof: `{open && <DialogContent/>}` at any of the five product sites → closed-state dwell < 140ms. POPOVER_MOTION 사용만 지우고 주석만 남김 → 컴파일 CSS 단정 빨강. `PLAYWRIGHT_BROWSERS_PATH=/nonexistent` 에서도 컴파일 단정은 돈다.

## DS-2 `/design` 갤러리 라우트 (#1956, 2026-09-03)

- `#/design` 은 `MODE=design` 또는 `VITE_DESIGN_GALLERY=1` 에서만 lazy. production dist `design-gallery` 0, 강제 미리보기 `:is(:hover,[preview])` 규칙 0 (`gallery-preview.css` 에서 속성·시그니처 파생), `data-gallery-export` 0. 강제 미리보기는 `gallery-preview.css` 의 `[data-gallery-root] :is()` 뿐(전역 hover 변이 무접촉, `@media (hover: hover)` 유지). 미리보기 속성은 `data-gallery-preview`(첨부 `data-preview` 와 이름 충돌 없음).
- ui PascalCase export 전수 실면적 렌더. 오버레이는 `modal={false}` 로 문서를 잠그지 않고 **칸(`data-gallery-stage`) 안에** 붙는다. 무대 높이는 표본 자신(pane 가로 토큰을 세로로 빌리지 않음). 네 판 `onOpenAutoFocus={preventAutoFocus}`(로드 후 첫 Tab 이 위 컨트롤, 스크롤 ~0). Dialog 스크림은 판 둘레에 보이는 대역(가림 없는 가시 면적). 캡처는 첫 Tab·휠 스크롤 가시 면적(≥0.9)·네 변 잘림·스크림 비가림을 잰다.
- NOTES(DS-1 입력): Card/Input/Select hover·active·busy 없음. SidebarRow disabled·busy 없음(unread≠busy). Button busy는 aria-busy만. DialogPortal·PopoverPortal은 목적지 칸. press는 Button 전용. 스크림은 갤러리 대역.

## M0w 기기 연결 웹/데스크톱 — 설정 「폰 연결」 QR 카드 (#1989, 2026-09-03)

- 설정 › 기기: 「QR 만들기」 → POST `/v1/auth/device-link` → 순수 SVG QR(코어 byte mode ECC M, 의존 추가 없음) · 120초 카운트다운 · 만료 「다시 만들기」 · `sas`가 있을 때만 4자리+confirm-sas. `consumed`+미확인 SAS는 확인 대기(연결됨이 아님). 확인 후 제자리 「연결됨」(ADR-0182, 토스트 없음).
- ADR-0180 D7 「온보딩 S5」는 번호 스텝이 아니라 **로그인 후 first-run 카드**(App이 소유, 세션 게이트가 선점하지 못함). UX-R2a가 번호 시퀀스에 접을 수 있다. 진행 표시 없음.
- NOTES: 기기 목록/해제는 `GET /v1/auth/devices` + `DELETE /v1/auth/devices/{id}`가 없다(#2029). 현재 카드의 연결됨은 세션 안 폴 `status`/`device`(+live 기록)로만 살아남고, 지속 목록은 #2029.
- runtime-unverified: 실기기 카메라 스캔(M0m).
- red proof: 독립 디코더 왕복(v1/v7/v8) · RS/포맷 골든 · App 트리 first-run · SAS 미확인≠연결됨 · 채움 액센트 ≤1 · 모듈 피치 바닥 · aria-describedby · 만료 문장 · 리마운트 · 재발급 폴 1개 · 캡처 전수 시크릿 스윕.
- R3: QR well `content-box`(피치 v7/v8 = 4.000 CSS px) · pending은 살아 있는 코드+스캔, SAS confirm은 awaitingConfirm만 · 바우처는 만료·consumed·로그아웃에 지움 · 시크릿 게이트는 심은 프레임에서 실패 · 기기명에 조사 없음 · first-run은 S1/S2와 같은 `onboarding-step-chrome`+`max-w-sm`.
## UX-R4a Agent Hub enabledTools 편집 UI (#1957, 2026-09-02)

- Agent Hub 프로필 도구 칩을 카탈로그 행(이름·설명·실행 가능/실행 불가·승인 필요) + 비낙관 저장으로 대체. PUT 은 저장된 프로필 필드만 싣는다. 성공은 ADR-0182 in-place `도구 변경 저장`→`도구 변경 저장됨` 1.6s (`useInlineConfirm`, CopyButton 동일 시계). 실패는 InlineBanner, 403은 읽기 전용.
- 카탈로그는 GET `/v1/workspaces/{ws}/agent-tool-catalog` 에서 읽는다. OpenAPI·momo-server 에 이 라우트가 없어 404/405/501·본문 불명은 표시 전용으로 접는다. `tools.rs` CATALOG 는 클라에 복사하지 않음.
- runtime-unverified: 라이브 카탈로그 GET(라우트 부재). 클라 시험은 목 카탈로그.
- 잔량: 폰 `COPY_RECEIPT_MS = 1_500` (`clients/mobile/src/features/conversation/copy.ts`) vs 웹 1 600. 이 티켓은 폰 무접촉. 소유: 폰 패리티 후속.

## M0m 기기 연결 폰 절반 — ConnectScreen 「QR로 연결」 (#1990, 2026-09-02)

- `oort://link` 파서(join 동형: 순서 무관·`momo://` 흡수·미지 파라미터 무시·잘못된 server 거부) + `POST /v1/auth/device-link/redeem` + `pendingSas` SAS 대기(서버 `sas` 또는 토큰 SHA-256 파생 4자리). 세션은 활성화 후 키체인만.
- 카메라 권한 거부 → 문장 안내 + 「주소로 연결」 폴백. 만료 401 / 재사용 409 / 형식 오류 세 문장, 재시도 「QR 다시 찍기」.
- R2: SAS에 「QR 다시 찍기」·「주소로 연결」 탈출, TTL 120s 만료 문장, 오프라인/unreachable 상태, 권한은 모달 전에 결정.
- R3: SAS 「QR 다시 찍기」는 스캐너를 연다. 거부 「주소로 연결」은 인앱 포커스(Settings는 「설정에서 허용」만). unreachable은 TTL까지 백오프 폴. AppDelegate가 warm `oort://`를 RCTLinkingManager로 전달. `expo-device` `modelName`. runtime-unverified: 실기기 카메라·권한 프롬프트.

## UX-R2s 웰컴 킥오프 서버 절반 — RunTrigger::Welcome (#1960, 2026-09-02)

- `RunTrigger::Welcome { kind: Opener|ProviderRequired|Closer }` + 멱등 키 `welcome:{ws}:{member}:{kind}:v1`. 가입 `createdMember:true`·owner claim 완주가 같은 tx에서 `agent_job`을 넣는다. 재가입·invite redeem(기존 멤버)은 무트리거.
- 워커: provider 미구성이면 모델/원장 0, 에이전트 명의 정적 카피 1건(`ProviderRequired`) — opener 키는 소비하지 않음. opener는 정상 run + `usage_ledger`. G2 streak는 `welcome:%` run 제외.
- settings `welcome_agent_member_id`(활성 에이전트)·`welcome_prompt`(≤2000자). WorkspaceDto 프로젝션. `schema_v0.sql` 무접촉. Closer는 enum 예약(v1 미구현).
- runtime-unverified: 라이브 join→Centrifugo 첫 발화 왕복(클라 UX-R2b).

## UX-R0 모션 토큰 사다리·눌림 단일점·강제 기제 (#1958, 2026-09-02)

- ADR-0179 D1·D2·D3(값)·D4·D5·D6·D9·D10. `motion.css` 사다리(120/180/240/500) + easing + arrival 값 + `--elevation-rest/float`. `motion.ts` 모달 200/150 상수(소비는 UX-R1). `button` 전 variant `press`. tokens.css 손기입 200/160/150/120ms 를 사다리로 흡수(값 200→240, 160→180, 150→120). 드로어는 D1대로 `standard`(240).
- R2: Button 전이 목록 소유자는 `press` 하나(`transition-colors` 제거, `@layer utilities` 에서 override 뒤). 모달/팝오버 상수는 `motion-enter/exit` 키프레임 유틸(tw-animate-css 없음). `@theme --default-transition-*` 를 사다리에 묶음.
- 강제: `motion.test.ts` + preflight `raw_motion`(온보딩 블록·motion.ts allowlist). 폰 무접촉(M1a). `motion/react` 미도입(D8는 첫 소비자 티켓). 표면 이관은 UX-R1a~e.
- 잔량(고치지 않음): hover-without-active preflight는 DS-4. 캡처 `waitForAnimations` 전수는 DS-3. S0 CTA `press` 는 UX-R1e.
- H-1 runtime probe: CI에서는 skip — DS-3 3짝 캡처 레인이 런타임 모션 측정을 인수.
- runtime-unverified 아님. 캡처는 rest 프레임만(눌림 3짝은 DS-3).

## SH-3a `scripts/oort doctor` (#1955, 2026-09-02)

- 셀프호스트 설치 판정 1개: `scripts/oort doctor [--env] [--json] [--strict]`. 필수 키는 `self_host_env.sh` 생성 heredoc에서 파생. 소문자 `true` 게이트(doorbell/hosted-delivery)·언퍼얼 `1`·`PLATFORM_ADMIN_EMAILS`·provider master key·drive backend·WS URL·role 비번↔DATABASE_URL. 시크릿은 이름·길이 class·형식만.
- 스택 미기동이면 compose/`/healthz`/agent-port/outbox/migrate 는 skip+안내(설치 전 preflight). exit 0/1/2, `--strict` 는 major→2.
- runtime-unverified 아님(픽스처 하네스). 로컬 `oortv013` 스택 실측은 PR 본문.

## M0s 기기 연결 서버 절반 — 1회용 QR 링크 토큰 (#1959, 2026-09-02)

- `POST /v1/auth/device-link` 발급 · `POST …/redeem` 소비 · `GET …/{id}` 폴링 · `POST …/{id}/confirm-sas`. 마이그레이션 086 `device_link_token` + `token.device_label`/`pending_sas`. `schema_v0.sql` 무접촉.
- D4 SAS: `RealtimeAdvert::SameOrigin`(`MOMO_CENTRIFUGO_WS_URL=same-origin`, `--public-origin` 이 쓰는 값) + 비-루프백/비-LAN Host 일 때만 4자리. 새 env 없음.
- red proof ①만료 401 ②재소비 409 ③에이전트 403 ④발급자 로그아웃 401 ⑤공개 오리진 SAS 홀드 ⑥루프백 즉시 ⑦원문 로그 0 ⑧RLS. runtime-unverified: 실기기 QR/카메라(M0w/M0m).

## SH-1 릴리스 매니페스트 `releases/latest.json` (#1954, 2026-09-02)

- 커밋된 `releases/latest.json`(v0.1.4 list digest, GHCR 아키별 이미지 매니페스트 digest 실측) + `scripts/release_manifest.sh` / `scripts/check_release_manifest.sh`. SELF_HOST·AGENT·README는 매니페스트를 읽고 산문 digest 0.
- red proof: digest 한 글자·`@sha256:` 잔여·CHANGELOG version 불일치. 생성기 재실행 바이트 동일. `scripts/local_gate.sh` 편입은 이 티켓에서 하지 않음(오케스트레이터).
- runtime-unverified 아님(GHCR inspect·attestation verify PASS, 생성기 멱등).

## BT-6 클라 절반 mark-unread (#1934, 2026-09-02)

- momo-core `effectiveUnreadStartSeq` 단일점 (ADR-0178 D3). 배지·UnreadDivider·UnreadPill·⌥↑↓ 가 이 함수만 소비. 서버 `unread_count` 는 접지 않음.
- 메시지 ⋯ 「여기부터 안 읽음」: PUT `mark_unread_before_seq`, `read_intent` 생략. 낙관 반영, 400/403 롤백+행 배너.
- 채널 명시 열람·사이드바 「읽음 처리」는 `read_intent: "explicit_open"`. 도착 중 플러시·인박스 멘션 광고는 생략(background). 서버 `marked_unread_before_seq: null` 이 로컬 마크를 지움.
- 서버 절반은 track/engine PR #1961. runtime-unverified: 라이브 PUT/GET 왕복(이 레인은 모킹).
- runtime-unverified / 폰 소비 공백: `clients/mobile/src/features/sidebar/rows.ts:179` 와 `clients/mobile/src/screens/ConversationScreen.tsx:388` 이 서버 `unreadCount` 원문을 읽어, 데스크톱 마크가 폰에서는 다 읽음으로 보인다. 이 PR 에서 폰 소비는 구현하지 않음.
- red proof: 마크 3/커서 10 공유 픽스처 · explicit_open vs 도착 플러시 · null 수렴 · 400 롤백. D3 합성 AST 게이트(별칭·헬퍼 포함).
- R3: 방문 중 나중 마크는 구분선·필을 옮기고 열람 `null` 은 지우지 않음. 타임라인 polite live 영역은 하나.
- 안읽음 필 재방문 무장은 이 PR 이전부터 있는 비결정 결함이며 이 PR 이 바꾸지 않는다 (#1966).
- R5: 마크 PUT 400 이면 방문 경계를 낙관 이전으로 되돌린다. 롤백 `null` 은 열람 광고가 아니다.

## mark-unread 신호 서버 절반 (#1934 / BT-6, ADR-0178, 2026-09-02)

- `read_state.marked_unread_before_seq` nullable bigint (085). `schema_v0.sql` 무접촉. `last_read_seq` GREATEST 불변(D1). 서버는 마크를 `unread_count`에 접지 않음(D3 합성은 momo-core 단일점).
- `PUT …/read-state` 본문 가산: `mark_unread_before_seq`(채널 실존 seq, 미래·비존재 400) + `read_intent` enum `[explicit_open, background]` (optional, default=background, D6). explicit_open만 같은 tx에서 마크 삭제. 구식/백그라운드 광고는 마크 불변.
- GET/list·realtime payload에 `marked_unread_before_seq` 항상 존재(미표시는 `null`). red proof: `mark_unread_conformance_pg` + `d2_b12_2b`. 클라 절반은 별 PR.

