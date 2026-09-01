# oort 차별화 축 준비도 진단 — "경쟁 서사를 지금 데모로 증명할 수 있는가" (2026-09-01, read-only)

> 실사 대상: `~/projects/momo-tracks/engine`(track/engine @ `c43b1d31`) · `~/projects/momo-tracks/uxui`(track/uxui @ `a6693e3d`) · **`~/projects/reference/buzz`**(block/buzz, Apache-2.0) · `gh issue`.
> 데모 가능성 판정 기준은 직전 셀프호스트 감사와 정합: **`scripts/self_host_env.sh --compose`로 띄운 스택에서 보여줄 수 있는가.**
> 코드 실물이 정본. buzz 주장은 전부 파일:라인으로 재검증했다.

---

## §0. 먼저, 불편한 사실 하나

이 진단은 "buzz는 로컬 에이전트 IDE일 테니 우리는 멀티유저로 이긴다"는 전제로 시작할 수 없다. **그 전제는 코드가 부정한다.**

| | oort | buzz |
|---|---|---|
| 제품 한 줄 | *A self-hosted messenger where agents are members, not bots.* (`README.md:6`) | *A workspace where humans and agents build together, on a relay you own.* (`README.md:4`) |
| 서버 | Rust/Axum + PG18 + Centrifugo | Rust/Axum WS relay(`crates/buzz-relay/src/connection.rs:9`) + PG + Redis + S3 |
| 멀티테넌트 | `workspace_id` 스코프 | `community_id` 스코프 (`migrations/0001_initial_schema.sql:1-9`) |
| 에이전트 = 멤버 | `member.kind ENUM('human','agent')` (`schema_v0.sql:11,48`) | `users.agent_type` + `agent_owner_pubkey` 자기참조 FK, 사람과 **동일 `users`/`channel_members` 테이블** (`schema/schema.sql:167-192`) |
| 역할 enum | `membership_role` | `member_role AS ENUM('owner','admin','member','guest','bot')` (`schema/schema.sql:30`) |
| 허들(음성) | LiveKit SFU | 서버 오디오 WS 릴레이 + STT/TTS + **에이전트 음성 참여** (`desktop/src-tauri/src/huddle/`) |

**"에이전트가 멤버다"라는 명제 자체는 buzz도 스키마 레벨에서 이미 구현했다.** 마케팅이 아니라 코드다(다만 그들의 role enum 값 이름은 `'bot'`이다 — 서사와 스키마가 어긋난 자리이고, 우리가 짚을 수 있는 유일한 표현상의 틈이다).

⇒ **차별화 서사를 "우리만 에이전트를 멤버로 본다"에 걸면 실사에서 깨진다.** 실제로 코드가 지지하는 차별은 더 좁고 더 깊은 네 가지다: **DB가 강제하는 격리 · 대화 안에서 벌어지는 자발적 도구호출의 승인 · 에이전트별 돈의 원장 · 에이전트가 에이전트를 부를 때의 루프 안전장치.** 이 넷은 buzz 코드에 **없다**(§2에서 각각 grep 근거).

---

## §1. 축별 준비도 판정표

범례: **데모 가능(폐곡선)** = compose 스택에서 사람에게 처음부터 끝까지 보여줄 수 있다 / **절반** = 어느 한 절반이 빈다(어느 절반인지 명시) / **구상만** = ADR·티켓 단계

| # | 축 | 판정 | 실물 근거 | 빈 절반 |
|---|---|---|---|---|
| 1 | 에이전트=1급 멤버 | **데모 가능(폐곡선)** | `schema_v0.sql:45-90`(member/human/agent 1:1 자식테이블) · `roster.rs:66,82,137-141`(kind·agent_model·사람/에이전트 분리 집계) · `DirectoryRoute.tsx:17-19,258` · `MemberRow.tsx:58-70` · `MemberProfileDialog.tsx:233,251`(「에이전트」 라벨 + 「관리」 소유 인간) · `agent_mentions.rs`(멘션→run, 같은 tx) · S4 실측 PASS | 없음 |
| 2 | Agent Hub / hosted connections | **절반** (관리 lifecycle ○ / OAuth·실벤더 ✗) | 서버 7라우트(`lib.rs` hosted-agent-connections 계열) · `hosted_agent_connections.rs`(pairing→confirm→active→disconnect→cleanup 상태기계) · `HostedConnectionSection.tsx`(단계별 UI) · Agent Port 3도구(`agent_port_tools.rs:9-11`) | OAuth 경로는 `MOMO_AGENT_PORT_OAUTH_*` flag off이고 **compose에 아예 미배선** → static bearer만. 실벤더 없이는 루프백 부트스트랩 필요(E2E 리포트가 그렇게 했다) |
| 3 | 도어벨 서버리스 | **데모 가능(단 벤더 종속)** | `routes/hosted_agent_doorbell.rs` · `crates/momo-webhook/src/doorbell.rs:18`(상수 body) · `bins/momo-webhook-sender/src/doorbell.rs:166-181,314`(≤2회 지수백오프) · `DoorbellSection.tsx` · E2E 서버 절반 GREEN | 마지막 고리가 **제3자 엔드포인트 가용성**(실측 RED=cursor 500). 기본 off(2게이트). ADR AC의 「벨 테스트」 버튼 부재 |
| 4 | 터미널 / 작업 표면 | **절반** (서버·클라 ○ / **compose 데모 ✗**) | `work_sessions.rs:469-527,1300-1400`(#1777) · `terminal_attach.rs`(issue/validate) · `TerminalDock.tsx`·`ObserverTerminal.tsx`·`WorkConsoleRoute.tsx` | **PTY 생산자가 compose에 없다** — `docker-compose.rust.yml:26`이 workd를 명시 배제, workd는 Swift(`workers/WorkHostDaemon`)라 Rust 이미지 6바이너리에 없음, `momo-workhost` 이미지 발행 CI 0. `verify_workd_rust.sh:6-9`가 "maintainer Mac"이라 자백 |
| 5 | 승인 / 제어 UX | **절반** (승인 폐곡선 ○ / 촉발·실행 ✗) | `routes/approvals.rs`(3라우트·5결과·에이전트 자기승인 불가) · `crates/momo-agent/src/tools.rs:165-190`(CATALOG 3종 + `DECLARED_NOT_EXECUTABLE`) · `requires_approval` **G6 fail-closed** · `inbox/approvalsPanel.ts`(4상태+unavailable 분리) · **폰 잠금화면 승인**(`clients/mobile/.../ApprovalDecision.tsx:35` Face ID 요구, `ios/NotificationService/`) | ①실행 가능 도구 3종이 **전부 work-session 계열** → 승인 후 실행은 축 4의 blocker에 걸린다 ②`enabledTools`가 Agent Hub에서 **표시 전용**(`AgentHubRoute.tsx:1094-1101`, `useAgentProfile.ts:163` read-through) → GUI만으로는 도구를 켤 수 없다 ③#1399 티어·#1381 pause는 **구상만**(둘 다 OPEN, ADR 선행) |
| 6 | 외부 도구 이중(ADR-0173) | **데모 가능(폐곡선)** | `crates/momo-auth/src/agent_scope.rs:38,66,74-140`(POST=write, GET messages·replies=read, PATCH=write, 나머지 닫힘) · ADR-0173 Accepted · **S4 실측 매트릭스 5/5 PASS**(201/200/200/404/403) | 없음 |
| 7 | ACP 체인 + A2A | **ACP=절반 · A2A=데모 가능** | ACP: `work_sessions.rs:931-990`(#1785 수신, 60s 240건·64KB·금칙키) → `realtime.ts:418`·`useWorkSessions.ts:636` `onAcpEvent` → `AgentWorkPanel`·`WorkSessionDetail` **투영까지 폐곡선** / A2A: `crates/momo-agent/src/a2a.rs:22-40`(G1 동시성·G2 연속자동응답·G3 스텝·a2a_depth·체인 예산 5게이트), 워커 배선 `bins/momo-agent-worker/src/lib.rs:91` | ACP는 work host가 있어야 이벤트가 발생 → 축 4 blocker 상속. #1345는 blocked(감사 티켓) |
| 8 | 기타 agent-native 경계 | **혼재** | ○ `agent_run`(`schema_v0.sql:267-297` depth·step_cap·멱등키) · ○ **usage_ledger**(`:456-472` run/agent/channel별 토큰·마이크로USD) + `/usage/summary`(전 멤버 열람, `usage.rs:15-20`) + `UsageSection.tsx` · ○ 게이트웨이(`agent_gateway.rs`, jobs/lease/renew·release) · ○ 경계 실물: presence 사람 전용(`presence.rs:42-44` "에이전트의 생존은 agent_run이다"), reminders `require_human`, 에이전트 역할 고정(#1857) | ✗ **budget 회로차단기 미배선** — `budget`/`budget_window` 스키마와 `budget_state()` 라벨 함수는 있으나 **`budget_window`에 INSERT/UPDATE하는 코드가 0건**, 차단 게이트 없음 ✗ **delegation token 미구현** — `token_kind='delegation'`+`subject_member_id` 스키마만, Rust 참조 0건 |

---

## §2. 구조적 차별 vs buzz가 흉내 낼 수 있는 것

### 2-1. buzz 실사 요약 (모든 항목 파일:라인 재검증)

| 항목 | buzz 실물 | oort 대비 |
|---|---|---|
| 서버·멀티테넌트 | ✅ Axum WS relay + PG(마이그 40파일 3,025줄) + Redis + S3 | **동급** |
| 에이전트=멤버 | ✅ 동일 `users`/`channel_members`, `member_role`에 `'bot'`, 멘션·프레즌스 pubkey 범용 | **동급**(서사 표현만 우리가 정합) |
| **RLS** | ❌ **0건** — `grep "ROW LEVEL SECURITY\|CREATE POLICY" schema/ migrations/` = 0. `docs/multi-tenant-conformance.md`는 RLS를 **요구사항으로 적어놓고 스키마엔 없다**(문서≠실물). 격리는 애플리케이션 `community_id` WHERE절 규율 | **oort 우위** — `schema_v0.sql:392-397,558-563`이 `FORCE ROW LEVEL SECURITY` + `ws_isolation` 정책을 루프로 전 테이블에 건다 |
| 터미널 | 로컬 PTY만 (`desktop/src-tauri/src/terminal_runtime.rs:410-448` `native_pty_system().openpty`), 전송=Tauri IPC. **타인 세션 관전 개념 없음** | **oort 설계 우위, 데모는 열세**(우리는 못 보여준다) |
| 워크플로 | ✅ 서버 실행 엔진 1,969줄, 4트리거(message/reaction/cron/webhook) | **buzz 우위** — oort에 대응물 없음 |
| **승인** | 스키마·REST 실물(`workflow_approvals`, approver_spec·expires_at). **데스크탑 승인 버튼 없음** — `WorkflowApprovalCard.tsx:26-28` 그대로: *"Approval actions are not yet available in Desktop."* README도 🚧 "infra exists, glue still drying" | **oort 우위(현재)** — 웹 인박스 + 폰 잠금화면 결정이 실물 |
| 승인의 **대상** | **워크플로 스텝** — 미리 YAML로 정의한 흐름 안에서만 | **oort 우위(구조)** — 대화 중 에이전트가 **자발적으로 호출한 도구**를 잡는다(`agent_run`+`approval`+CATALOG+G6). buzz엔 `agent_run` 테이블도, 대화 내 도구호출 승인도 없다 |
| **비용 원장** | ❌ **0건** — `cost_micro_usd`·`prompt_tokens`·`usage_ledger`·`budget` grep 0. 스키마 48테이블에 과금/토큰 테이블 없음 | **oort 우위** — 에이전트·채널·run별 원장 + 5그레인 예산 스키마 |
| **A2A 루프 가드** | ❌ 미발견 — 에이전트→에이전트 위임의 depth/연속응답/체인예산 캡 없음 | **oort 우위** — `a2a.rs` 5게이트 |
| ACP/MCP 외부 연동 | ✅ `crates/buzz-acp` **45,863줄**(Goose·Codex·Claude Code 하네스) + `buzz-dev-mcp` + `buzz-cli` | **buzz 우위** |
| 프로젝트/git 호스팅 | ✅ `features/projects` **37,267줄** + git 이벤트(NIP-34) + 이슈/PR + "브랜치가 방이 된다" | **buzz 우위** — oort에 대응물 없음 |
| mesh-compute(P2P 추론) | ✅ ~4,400줄, iroh QUIC 직결, 동의 패널 | **buzz 우위** — oort에 대응물 없음 |
| 푸시 | 스키마 7테이블(push_gateway_*) 실물, README는 💭 pending | 서로 미완 |

### 2-2. 그래서 무엇이 **구조**이고 무엇이 **앱으로 흉내 가능한가**

**앱/봇 레이어로 흉내 가능한 것 (= 차별화 서사로 쓰면 안 되는 것)**
- "에이전트가 채널에 있고 멘션하면 답한다" — buzz가 이미 한다. 어떤 메신저도 봇 계정으로 흉내 낼 수 있다.
- "에이전트 명부·프레즌스·DM" — 표시 규칙일 뿐이다.
- "외부 도구를 토큰으로 붙인다" — buzz `api_tokens`(scopes·channel_ids)로 동급.
- "허들에 에이전트가 참여한다" — buzz는 STT/TTS까지 붙였다.

**스키마·불변식이라서 앱으로는 못 따라오는 것 (= 진짜 차별)**

1. **DB가 격리를 강제한다.** oort는 `FORCE ROW LEVEL SECURITY`를 전 테넌트 테이블에 걸고 `momo_app` 롤이 `NOBYPASSRLS`다(`docker-compose.rust.yml` api 주석). buzz는 같은 격리를 **애플리케이션 코드 규율**로 지킨다(RLS 0건). 사용자 가치로의 번역: *"우리 워크스페이스 데이터가 새는 경로는 애플리케이션 버그 하나가 아니라 데이터베이스 정책까지 뚫려야 한다."* 셀프호스트 구매자에게 이 문장은 검증 가능하다(`psql`로 정책을 직접 본다).

2. **승인의 주어가 다르다.** buzz의 승인은 *미리 그린 워크플로의 한 스텝*이다. oort의 승인은 *에이전트가 대화 도중 스스로 하겠다고 나선 되돌릴 수 없는 행동*이다. 그 차이를 만드는 것이 `agent_run`(멱등키·step_cap·depth) + `approval`(요청자=에이전트, 결정자=`kind='human'`이라 자기승인이 **구조적으로** 불가) + `CATALOG`(실행 가능한 것의 명시 목록) + `requires_approval`의 **G6 fail-closed**(메타데이터가 없거나·중복이거나·모르는 값이면 전부 "승인 필요"). 사용자 가치: *"에이전트가 무엇을 할 수 있는지가 목록으로 있고, 목록 밖은 이름으로 거절되며, 애매하면 사람에게 묻는다."*

3. **돈이 대화와 같은 원장에 있다.** `usage_ledger(run_id, agent_member_id, channel_id, model, tokens…, cost_micro_usd)`. buzz에는 이 축이 **통째로 없다**. 사용자 가치: *"어느 에이전트가 어느 채널에서 얼마 썼는지를 관리자 대시보드가 아니라 워크스페이스 구성원 누구나 본다"*(`usage.rs:15-20` — 일부러 admin 게이트를 걸지 않았다).

4. **에이전트가 에이전트를 부를 때의 안전장치.** `a2a.rs`의 G1(동시 run 세마포어)·G2(사람 발화 이후 연속 자동응답 streak)·G3(스텝 캡)·`a2a_depth`(홉 깊이)·체인 예산(한 root trigger의 위임 트리 전체 지출 상한). buzz에 대응물 미발견. 사용자 가치: *"에이전트 둘이 서로를 부르며 밤새 돈을 태우는 사고가 구조적으로 막힌다."*

5. **(설계상만) 팀이 에이전트의 터미널을 관전한다.** buzz의 터미널은 로컬 PTY이고 관전 개념이 없다 — 이건 진짜 빈틈이다. **그러나 우리는 지금 이것을 compose에서 보여줄 수 없다**(§1 축4). 서사에 넣으면 데모에서 증명 실패한다.

**한 문장 포지셔닝(코드가 지지하는 범위 안에서)**
> "사람과 에이전트가 같은 방에 있다"는 이제 우리만의 것이 아니다. 우리 것은 **그 방에서 에이전트가 무엇을 할 수 있고(도구 목록), 무엇을 하려면 사람에게 물어야 하고(fail-closed 승인), 그게 얼마였고(원장), 서로를 부르다 어디서 멈추는가(A2A 게이트)를 데이터베이스가 강제한다**는 것이다.

---

## §3. 차별화 서사를 완성하기 위해 부족한 조각 — 우선순위

| 순위 | 조각 | 규모 | 왜 이 순서인가 | 의존 |
|---|---|---|---|---|
| **1** | **`enabledTools` 편집 UI** — Agent Hub 도구 토글 | **S** | 지금 §2-2의 2번(승인)을 GUI로 촉발할 방법이 없다. 서버 `PUT …/agents/{a}/profile`는 이미 받는다(`agents.rs:30`). **차별화 서사 전체에서 가장 값싼 한 칸** | 없음 |
| **2** | **승인 없이도 끝나는 executable tool 1종** — work host를 요구하지 않는 도구(예: `agent.pause` 승격, 또는 read-only 도구) | **M** | 지금 CATALOG 3종이 전부 work-session 계열이라 **승인 데모의 "승인 후 실행"이 축4 blocker에 인질로 잡혀 있다**. `DECLARED_NOT_EXECUTABLE`에 이미 후보가 목록으로 있다(`tools.rs:187`) | 도구별 executor+검증기+승인 기본값 결정(티켓 1개) |
| **3** | **셀프호스트 work host** — workd를 compose에 넣거나(Rust 이식/사이드카 편입) 최소한 `momo-workhost` 이미지 발행 레인 | **L** | 축4·축7(ACP)·축5의 "승인 후 실행"이 **한 blocker에 함께 묶여 있다**. 이걸 풀면 세 축이 동시에 데모 가능해진다. buzz가 못 하는 유일한 큰 축(관전)이기도 하다 | 방향 결정(Swift 이식 vs 사이드카) — ADR 가능성 |
| **4** | **budget 회로차단기 배선** — `budget_window` writer + 초과 시 run 차단 | **M** | §2-2의 3번(돈)이 지금 "보여주기"까지만이고 "막기"가 없다. 스키마·라벨 함수·UI가 전부 있어 **writer 하나가 빠진 형태** | 없음(스키마 존재) |
| **5** | **A2A 데모 가시화** — 위임 체인이 화면에서 체인으로 보이기(부모/자식 run, 막힌 게이트 이름) | **M** | §2-2의 4번은 코드로는 가장 강한 차별인데 **화면에 서사가 없다**. `agent_run.parent_run_id`와 `A2aRouting.blocked`(감사행 + 시스템 라인)가 이미 데이터를 낸다 | 없음 |
| 6 | #1399 per-message 실행 티어 · #1381 pause 정책 | L | 둘 다 ADR 선행 blocked. buzz에도 없는 축이라 **선점 가치는 있으나 지금 서사에 필수는 아니다** | ADR 기안 |
| 7 | 「벨 테스트」 버튼(#1735 잔여) | S | 도어벨 축을 형식적으로 닫는다 | 서버 test-fire 라우트 1개 |
| 8 | hosted OAuth flag를 셀프호스트 compose에 배선 | S | 지금 `MOMO_AGENT_PORT_OAUTH_*`가 compose에 아예 없어 축2의 절반이 자물쇠 뒤에 있다 | 운영 결정(ADR-0162 증보1이 별도 결정으로 남겨둠) |

> **순위 1·2를 먼저 두는 이유**: 3번(work host)은 크고, 그 전까지 승인 축은 데모 불가로 남는다. 1+2는 합쳐서 소~중 규모로 **승인 축을 work host와 분리해 독립 데모 가능**하게 만든다. 이것이 지금 가장 레버리지가 큰 개입이다.

---

## §4. 지금 실물로 보여줄 수 있는 데모 시나리오

### 시나리오 A — "에이전트는 멤버이고, 돈이 보인다" (**전 구간 실증됨, 권장 주력**)

전제: `scripts/self_host_env.sh --published-image <v0.1.3 digest>` → `--compose up -d --wait`. 외부 요구사항은 **OpenAI 호환 엔드포인트 키 하나뿐**. work host·LiveKit·푸시 전부 불요.

| # | 보여주는 것 | 근거 |
|---|---|---|
| 1 | 로그인 → 워크스페이스 → 웹 GUI 초대 → 둘째 사용자 합류 | `SELF_HOST_FIRST_DAY.md`, S4 실측 |
| 2 | 설정 › AI 연결에 키 주입(`PLATFORM_ADMIN_EMAILS`가 생성 env에 자동) | `self_host_env.sh`, `provider_link.rs` |
| 3 | Agent Hub에서 에이전트 생성(핸들·모델·지시문) → **채널 배치** | `CreateAgentDialog.tsx`, `AgentChannelsSection.tsx` |
| 4 | **명부를 연다** — 에이전트가 사람과 같은 행 모양으로, 「에이전트」 섹션에, 「관리: 곽성재 님」 소유 귀속과 함께. DM도 열린다. **역할 드롭다운은 사람에게만 있다**(에이전트 역할은 서버가 403으로 고정, #1857) | `DirectoryRoute.tsx:258`, `MemberRow.tsx:58-70`, `MemberProfileDialog.tsx:233,251` |
| 5 | 채널에서 `@에이전트` 멘션 → 사이드바에 **「작업 중」 레일**이 살아나고 답변이 슬라이스로 자란다(한 턴 = 자라는 메시지 하나) | `agent_mentions.rs`, `AgentWorkingRail.tsx`, `AgentTurnBadge.tsx`, ADR-0158 D7 PATCH |
| 6 | **설정 › 사용량** — 방금 그 턴이 에이전트별·모델별·기간별로 마이크로USD까지. **관리자가 아니어도 보인다** | `usage.rs:15-20`, `UsageSection.tsx` |
| 7 | 외부 도구 이중: 그 에이전트의 **자격을 발급**하고 Claude Code/curl이 그 자격으로 **쓰고 읽는다**(POST 201 · GET 200 · 나머지 닫힘) | `agent_scope.rs:74-140`, **S4 실측 매트릭스 5/5** |
| 8 | 결정타 한 줄: `psql`로 `\d+ member` → `FORCE ROW LEVEL SECURITY`와 `ws_isolation` 정책을 직접 보여준다 | `schema_v0.sql:392-397` |

**이 시나리오의 강점**: 전 단계가 발행 이미지에서 성재 개입 0으로 완주된 이력이 있다(`claudedocs/comprehensive-test-20260828/S4-local-selfhost.md`). 6·7·8번은 buzz 코드에 대응물이 **없다**(비용 원장 0건, RLS 0건).

### 시나리오 B — "사람이 에이전트를 막는다" (**부분 — 거부 경로까지만 안전하게 약속**)

전제: 시나리오 A + `PUT …/agents/{a}/profile`로 `enabledTools`에 `work.session.spawn`을 REST로 켠다(**GUI 없음 — §3 순위 1이 여기를 고친다**).

| # | 보여주는 것 | 상태 |
|---|---|---|
| 1 | 에이전트에게 "작업 세션 하나 띄워줘"라고 말한다 → 도구 호출 | ○ |
| 2 | 채널에 **승인 요청 카드**가 뜨고 인박스 승인함에 행이 선다. 4상태 + `unavailable`을 `error`와 다른 칸으로 구분한다 | ○ `approvalsPanel.ts` |
| 3 | **에이전트는 자기 요청을 승인할 수 없다** — 결정 자격이 `kind='human'`이라 규칙이 아니라 구조다 | ○ `approvals.rs:12-22` |
| 4 | 사람이 **거부**한다 → run 정리 + 감사행 + 영수증. 지각 클릭은 승인을 *만료로 확정*시킨다 | **코드상 폐곡선이나 미실측** — work host 없이 도는 것을 아직 직접 재현하지 않았다 |
| 5 | 사람이 **승인**한다 → 실제 실행 | ✗ **work host 필요(축4 blocker)** — 데모에서 약속하지 말 것 |
| 6 | 폰 잠금화면에서 Face ID로 승인/거부 | ✗ 데모 불가 — 폰 빌드 + APNs + 푸시 relay가 기본 셀프호스트 스택에 없다(직전 감사) |

**권고**: B는 **2·3·4번까지만** 보여주고 "승인 후 실제 실행은 실행 호스트를 붙였을 때"라고 정직하게 말한다. 4번은 데모 전에 한 번 실측해 둘 것.

### 넣지 말 것

- **관전 터미널** — 서사상 가장 탐나고 buzz가 못 하는 유일한 큰 축이지만, compose 스택에 PTY 생산자가 없다. 데모에서 열면 그 자리에서 깨진다.
- **"우리만 에이전트를 멤버로 본다"** — buzz `schema/schema.sql:167-192`가 반례다. 대신 **역할 고정·소유 귀속·프레즌스 분리**라는 *경계의 정교함*으로 말할 것.
- **박스 밖 허들** — 직전 감사의 결손 1~4.

---

## §5. 이 진단이 뒤집은 가정 (명시)

1. **buzz는 로컬 에이전트 IDE가 아니다.** 멀티테넌트 클라이언트-서버 메신저이고, 제품 한 줄이 우리와 거의 같다.
2. **"에이전트=멤버"는 더 이상 단독 차별점이 아니다.** buzz도 동일 테이블·동일 role enum으로 구현했다.
3. **그 대신 buzz에 진짜로 없는 것은 넷이다** — RLS(0건) · 대화 내 자발적 도구호출 승인(`agent_run` 자체가 없음) · 비용/예산 원장(0건) · A2A 루프 가드(미발견). 이 넷이 코드가 지지하는 차별화의 전부이자 핵심이다.
4. **buzz가 우리보다 앞선 축도 셋이다** — 워크플로 엔진, 프로젝트/git 호스팅(37K줄), mesh-compute(P2P 추론). ACP 하네스(45.8K줄)도 우리보다 두껍다. "따라잡을 목록"이 아니라 **"우리가 싸우지 않을 자리"로 의식적으로 두는 편**이 낫다.
5. **buzz의 승인 UX는 지금 비어 있다**(`WorkflowApprovalCard.tsx:26-28`, README 🚧). 우리 승인 축의 §3 순위 1·2를 빨리 채우면 **그들이 아직 못 보여주는 화면을 우리가 먼저 보여준다** — 이것이 지금 가장 시간에 민감한 기회다.
