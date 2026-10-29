# ADR-0186: 에이전트 워크스페이스 행동 — 제안·승인·실행(propose / approve / execute)과 선언형 카드 카탈로그

- Status: **Accepted** (2026-09-22 성재 결재 — §7 확정점 4건 전부 권고안대로 승인 「승인할게 진행해줘」. 기안 같은 날 Fable. 결재 기록 §9. AX-3a #2508·AX-3b #2509·AX-4 #2510 착수 가능)
- Date: 2026-09-22
- Deciders: 성재
- 역방향: 2026-10-16 [ADR-0113](0113-connector-credential-plugin-boundary.md) 증보 2 E4가 `action_type='connector_tool'`(실행 없는 결정 전달 — Hermes 쓰기 2단계, ADR-0203 증보 K6, Proposed)을 더한다. D2의 같은 tx 실행은 workspace_action에 그대로다. 본문 결정은 바꾸지 않았다.
- 역방향: 2026-10-25 `host.session.open`·`host.install` 행동 어휘의 방향은 [ADR-0210](0210-host-ops-team-box-shell-curated-install.md)(#4347) D3·D5가 정한다. `host.session.open`은 D2의 결정 방식을 확장한다: 승인 결정 입력에 서명 필드가 있고 행동별 승인 대기 TTL(10분)이 레지스트리의 새 속성이다. 레지스트리 등록과 증보는 그 문서의 HO-15가 한다. 이 ADR의 기존 본문 결정은 바꾸지 않고 확장만 한다.
- 증보(Accepted, 2026-10-27 owner 결재): 2026-10-27 **v5 「먼저 제안과 메시지 고정」**(#4659) — 사람이 부르지 않은 에이전트의 제안(`oort_action_initiate`)과 `message.pin`·`message.unpin`을 정한다. §2의 run-less 승인 기각은 유지하되 그 이유 (c)의 전제를 푼다. owner가 2026-10-27 질문 일곱 개를 모두 권장안으로 결재했다(「권장대로 진행하면서」). 파일 끝 「증보 2026-10-27」 절.
- 증보(owner 결정 넷 Accepted, 세부 Proposed, 2026-10-29): 2026-10-29 **v6 「요청 고리」**(#4755) — 한 요청 한 묶음(카드 종결 패치, 옛 줄 1단계 유지)·요청 스레드 자리(#4646 흡수)·영어 원문 줄을 상태 코드로·「채널에도 한 줄」 규칙과 판단 칸(기본 꺼짐)을 정한다. D2의 결과 메시지와 부록 B를 읽는 법이 바뀐다. U-c의 C3(별도 승인함) 기각은 유지한다(인박스 「승인」 칸은 C3가 아니다). owner 2026-10-29 「나쁘지 않아 보이네. 전부 권장으로 일단 진행해봐.」(후보 페이지 결정 1~4). 파일 끝 「증보 2026-10-29」 절.
- 발제: 성재 2026-09-22 「에이전트한테 웹훅 발급해줘 같은 내부 기능을 요청해도 수행하고, OpenUI 같은 철학 기반으로 gen UI로 뭔가 보여주면 좋겠다(테마 바꿔줘·누구 초대해줘·훅 발급하고 연동해줘). 유즈케이스 기반으로 AI 활용도를 극대화」
- Consumes: ADR-0101(에이전트=1급 멤버) · ADR-0114(승인 게이트) · ADR-0162(Agent Port·hosted durable inbox) · ADR-0171(도어벨) · ADR-0174(외양=이 기기 localStorage) · ADR-0182(일시 확인 3형, 토스트 금지) · ADR-0004 증보 4(webhook 마스터키 분리 — `webhook.create` 실행기의 선행) · ADR-0159(디자인 시스템 네 상태)
- 시장 근거(2026-09-22 조사, `docs/planning/2026-09-22-plan-revision.md` §2): Meta Muse의 「백그라운드로 일하다 승인이 필요할 때 돌아온다 + 전체 감사 기록」, Slack Code의 Plan/Task **Block Kit 허용목록 카드**, OpenUI 「State of Generative UI」의 **선언형 카탈로그 기본·오픈엔드 HTML은 샌드박스 슬롯 한정** 권고
- 제품 문장: **에이전트에게 시키면 된다. 실행은 사람이 누른다.** 에이전트는 워크스페이스를 바꾸는 행동을 **제안**하고, 사람이 카드에서 승인하면 서버가 그 사람의 권한과 감사 아래 실행한다. 결과는 oort가 그리는 카드로 돌아온다.

## 1. 문제

### 1.1 지금 에이전트가 할 수 있는 것
Agent Port 도구는 7개다(`server-rust/crates/momo-mcp/src/tools.rs`): `oort_inbox_read`·`oort_conversation_read`·`oort_message_post`·`oort_jobs_claim`·`oort_job_renew`·`oort_job_release`·`oort_run_event`·`oort_run_complete`. 전부 **읽기·발화·run 수명** 도구다. hosted 스코프 어휘도 `agent:port:connect`·`agent:inbox:read`·`messages:read`·`messages:write`·`agent:jobs:read`·`agent:runs:callback` 여섯이다. 워크스페이스를 바꾸는 행동(초대·웹훅·채널·역할)은 사람 bearer의 REST에만 있다(`routes/invites.rs` `require_human`+`require_admin`, `routes/webhooks.rs`).

내부 worker 카탈로그(`momo-agent/src/tools.rs` `CATALOG`)는 work 세션 3종뿐이고, `DECLARED_NOT_EXECUTABLE`이 「왜 아직 도구가 아닌가」를 목록으로 갖고 있다. 즉 「@hermes 초대 링크 하나 만들어줘」는 오늘 **어느 경로로도** 실행되지 않는다. 에이전트는 「설정에서 하세요」라고 답할 수밖에 없고, 그 순간 oort는 ADR-0101이 거부한 「봇이 있는 채팅」이 된다.

### 1.2 이미 있는 것 — 새로 만들 필요가 없는 것
- **승인 폐곡선**(#979, `routes/approvals.rs`): `approval` 행(`run_id NOT NULL`, `action_type text`, `payload jsonb`) + `approval_request` 메시지 + 결정 라우트 2 + 멱등 원장 `approval_decision` + 만료 스윕. 결정자는 **사람이면서 채널 멤버**여야 하고, 에이전트는 자기 제안을 승인할 수 없다(kind 검사 한 줄로 끝난다). 거부는 run을 `cancelled`로 닫고 에이전트 명의의 `tool_result`를 남긴다. 만료는 `timed_out`.
- **run 수명**: `RunStatus::AwaitingApproval`이 존재한다. hosted 에이전트도 `oort_jobs_claim`으로 받은 lease handle에 `run_id`가 묶여 있다(`agent_port_tools.rs` `bound_handle`). 다만 `oort_run_complete`는 오늘 승인 대기를 검사하지 않는다(§3 D2).
- **관리 REST**: `POST /v1/workspaces/{ws}/invites`(역할·횟수·만료, **201에 raw code 1회**) · `POST …/webhooks`(**201에 1회 자격**, `Cache-Control: no-store`) · rotate/revoke/regenerate. 감사 행은 코드·해시·프리뷰를 싣지 않는다.
- **일시 확인 문법**(ADR-0182): ① in-place ② 팔레트 상태줄 ③ 지속 카드. 토스트는 게이트가 막는다.
- **카드 렌더러**: `packages/momo-core/src/features/timeline/agentCardModel.ts`가 `approval`·`tool`·`turn`·`login_handoff`·`completion_report`를 그린다. 카드는 서버 props를 **읽어** 그리며, 모르는 모양은 본문으로 떨어진다.
- **단축키 정본**(`clients/web/src/app/keyboardShortcuts.ts`)과 ⌘K QuickSwitcher(`app/QuickSwitcher.tsx`: 검색·이동·만들기·에이전트 설정 그룹). 명령 레지스트리는 아직 없다(UX-R3a 연기분).

### 1.3 경계
새 스코프 클래스(에이전트가 워크스페이스 변경을 **제안**하는 권한)와 새 실행 경로(사람의 결정이 에이전트의 제안을 서버에서 실행)는 공개 API·보안 경계 변경이다. ADR-0100에 따라 Accepted 뒤에만 머지한다. DDL은 무접촉이다(§3 D7).

## 2. 기각한 모양

- **에이전트에게 admin 스코프 부여(직접 실행)**: 에이전트 토큰 유출 = 워크스페이스 장악. Muse조차 「민감 행동 전 확인」을 문법으로 둔다. 기각.
- **자유 생성 UI(에이전트가 HTML/JSX를 내보냄)**: raw color·토큰 게이트·네 상태 규칙을 전부 우회한다. OpenUI 보고서도 프로덕션은 선언형이라고 말한다. 기각. 샌드박스 슬롯도 v1 밖.
- **run과 분리된 승인 레코드(run-less approval)**: `approval.run_id NOT NULL`을 풀어야 하고 만료 스윕·레일 표시가 갈라진다. hosted 제안은 항상 claim한 job의 run 안에서 일어나므로 필요 없다. 기각. **→ 증보 2026-10-27(v5, Accepted)**: 기각은 유지한다. 단 이유 마지막 문장의 전제(「항상 job의 run 안」)를 푼다. 사람이 부르지 않은 제안은 job이 없는 run(`awaiting_approval`로 태어남)에 묶는다(U-a).
- **클라이언트가 서버 없이 초대를 실행(에이전트 제안 → 브라우저가 REST 호출)**: 감사 행에 「에이전트가 제안했다」가 남지 않고, 폰·다른 기기에서 결정할 수 없다. 기각. 단, **서버 상태를 바꾸지 않는 클라이언트 명령**(테마·밀도)은 이 모양이 맞다(D3 risk none).

## 3. 결정

### D1. 명령 레지스트리 — 정의는 한 곳, 소비자는 셋
- **워크스페이스 행동은 Rust가 정본**이다. `server-rust/crates/momo-agent/src/actions.rs`에 `ACTIONS: &[WorkspaceAction]`(id·제목·요약·`risk`·`required_role`·인자 JSON Schema·실행기)와 `DECLARED_NOT_EXECUTABLE`(다음 배치 목록)을 둔다. 이 상수에서 **세 소비자가 파생**된다: ① `GET /v1/workspaces/{ws}/actions`(사람 bearer, 멤버) ② Agent Port `oort_action_propose`의 `action_id` enum ③ OpenAPI. 드리프트 가드: enum = ids 동일성 시험, OpenAPI rust 샘플러, 웹 생성 타입 검증.
- **클라이언트 명령(이동·생성·설정·외양)은 TS가 정본**이다. `packages/momo-core/src/features/commands/registry.ts`의 `Command {id, title, group, kind: "navigate"|"client", shortcutId?, run}`. `shortcutId`는 `keyboardShortcuts.ts`의 id를 가리키고, 시험이 양방향 존재를 강제한다(단축키 있는 명령은 레지스트리에 있고, 레지스트리의 shortcutId는 실존).
- 팔레트(⌘K)는 TS 레지스트리 + 서버 `actions` 카탈로그를 **런타임에 합쳐** 「명령」 그룹을 그린다. 「에이전트에게 지시」(옛 UX-R3c)는 별도 모드가 아니라 같은 카탈로그를 에이전트가 `oort_action_propose`로 부르는 것이다.
- v1 `ACTIONS` = `invite.create` 하나. `DECLARED_NOT_EXECUTABLE` = `webhook.create`(ADR-0004 증보 4 랜딩 뒤) · `channel.create` · `member.role.set`.

### D2. 제안 → 승인 → 실행 — 기존 폐곡선 재사용, run은 park
- 새 스코프 **`workspace:propose`**(momo-mcp `SCOPE_WORKSPACE_PROPOSE`). 기본 페어링은 요청하지 않는다. 에이전트가 요청하면 동의 화면(`packages/momo-core/src/features/hostedAgents/model.ts` 스코프 목록·라벨)에 「워크스페이스 변경을 **제안**할 수 있음(실행은 사람 승인)」으로 표시된다. 이 스코프는 어떤 REST도 열지 않는다.
- 새 Agent Port 도구 **`oort_action_propose { handle, actionId, args, rationale }`** (`handle` = `oort_jobs_claim`의 lease handle, `bound_handle` 검사 동일). 서버는 같은 tx에서 ①`args`를 레지스트리 스키마로 검증 ②`approval` 행 생성(`action_type='workspace_action'`, `payload = {action:{id,args,rationale}, proposed_by}`, `run_id` = handle의 run, `channel_id` = run 채널, `expires_at` = 기존 TTL) ③에이전트 명의 `approval_request` 메시지(부록 A props) ④run → `awaiting_approval`. 응답 `{approvalId, status:"pending", expiresAtMs, cardMessageId}`. **→ 증보 2026-10-27(v5, Accepted)**: 이 도구의 handle 필수는 그대로다. 사람이 부르지 않은 제안은 handle이 없는 새 도구 `oort_action_initiate`로 한다(U-a).
- **run 가드**: `awaiting_approval`인 run에 `oort_run_complete`·`oort_job_release`가 오면 도구 실패 `approval_pending`(409 계열). 에이전트는 「승인 기다리는 중」이라고 말하고 turn을 끝내면 된다. 사람의 run cancel(`agent_runs.rs`)은 기존대로 pending 승인을 함께 취소한다.
- **결정**은 기존 라우트 2개 그대로다(`POST …/approvals/{id}/decision`, `POST /v1/agent-runs/{run}/approval-decisions`). `action_type='workspace_action'` 분기만 신설한다:
  - 승인: 결정자가 해당 행동의 `required_role`을 만족하는지 검사(초대 = 기존 `require_admin`과 같은 판정). 아니면 403 `role_required` — 카드는 「관리자가 승인해야 합니다」로 남는다(승인은 소모되지 않음). 만족하면 **같은 tx에서 실행기**(초대 = `create_invite`)를 결정자 명의로 호출 → 감사: 기존 `invite.created`에 `via_agent`(제안자 member id)·`approval_id` 추가 + `action.approved` 1행 → 승인 카드 props 패치(decided) → 에이전트 명의 `tool_result` 메시지(부록 B `momo.action_result.v1`) → run `succeeded`(output `{actionId, ref}`), resume job **없음**.
  - 거부·만료: 기존 arm 그대로(`end_parked_run_in_tx` cancelled / timed_out + 에이전트 명의 tool_result). `workspace_action`은 resume job을 만들지 않으므로 만료 arm이 job을 가정하지 않는지 시험으로 못박는다.
- 실행은 **결정자 권한**으로 일어난다. 에이전트는 어떤 시점에도 admin이 아니다. 제안자·결정자·실행 결과가 감사 행 한 줄에 같이 남는다.

### D3. 위험 등급 — 레지스트리가 정하고 에이전트는 못 바꾼다(성재 결재 ②)
| risk | 뜻 | 예 | 경로 |
|---|---|---|---|
| `none` | 서버 상태를 바꾸지 않는다 | 이동·테마·밀도·폰트 | 클라이언트 명령. 에이전트 경유 시 카드의 「적용」을 사람이 누르면 **브라우저가** 실행(D6). 승인 행 없음 |
| `approval` | 워크스페이스를 바꾼다 | 초대·웹훅·채널 생성·역할 | D2. 항상 승인 카드 |

v1의 모든 워크스페이스 행동은 `approval`이다. 「관리자 위임으로 무승인 허용」은 별도 ADR(스코프 원장·설정 표면 추가)로 미룬다.

### D4. 1회 시크릿 규율 — 서버와 클라이언트 양쪽
- 서버: 초대 코드·웹훅 자격 같은 1회 값은 **결정 HTTP 응답에만**(부록 C `result.secretOnce`, `Cache-Control: no-store`·`Pragma: no-cache`) 싣는다. `approval.payload`·메시지 props·감사 행·로그·outbox 어디에도 넣지 않는다(기존 `routes/webhooks.rs` 규율 승계).
- 클라이언트: 결정 응답의 `secretOnce`는 **메모리에서만** 승인 카드 자리에 in-place로 그린다(ADR-0182 ①: 버튼 자리가 링크+복사로 바뀐다). 영속 카드(부록 B)는 id·역할·만료만 갖고 「링크는 승인한 사람에게 1회 표시됨 · 재발급」으로 기존 regenerate/rotate 라우트를 가리킨다. props에 값을 써서 새로고침을 견디게 만드는 구현은 위반이다.

### D5. 카드 카탈로그 — 선언형·허용목록·oort 컴포넌트가 그린다
- 에이전트 출력은 **서버가 붙인 props**로만 카드가 된다. 에이전트가 HTML·마크업·색을 내보내는 경로는 없다. 모르는 kind는 본문 폴백(네 상태 규칙 유지).
- v1 kinds: `approval`(기존 + 부록 A `action` 블록) · `action_result`(부록 B) · `link_once`(D4, 메모리 전용). 후속: `settings_preview`(D6, AX-5) · `form_request`(부족한 인자 1~3개 요청, v2) · `plan`/`task`(관전 도크와 결합, v2).
- **증보 2026-09-27(GC-5)**: `command_suggest`의 `command_id:"ai.connect"`는 연결 카드로 그린다. 보는 사람별 렌더 규칙은 파일 끝 증보 G4.
- 확인은 ADR-0182 결정 트리: 결과를 다시 찾을 일이 있으면 ③ 지속 카드(action_result), 컨트롤이 보이면 ①, 명령 표면이면 ②. 토스트 0.
- 디자인 게이트 불변: 카드 컴포넌트는 토큰만 소비하고 `design_preflight_web` · design-review B0·H0를 지난다.

### D6. 클라이언트 명령의 에이전트 경유(테마 등)
외양은 이 기기 localStorage다(ADR-0174 D3). 서버는 못 바꾸므로 에이전트는 **`oort_card_suggest`로**(증보 2026-09-27 G1이 경로를 고친다. 원문은 `oort_message_post`였으나 그 도구는 props `{}`만 쓴다) **명령 참조 props**(`momo.command_suggest.v1 {commandId, args}`, 부록 D)를 실어 보내고, 클라이언트가 그 메시지를 `settings_preview` 카드(현재 값 → 제안 값 미리보기 + 「적용」)로 그린다. 「적용」은 레지스트리 `run`을 호출한다. 서버 실행·승인 행·감사 행이 없다(risk none). 다른 기기에서는 카드가 「이 기기에서 적용」으로 보인다. 서버 동기화 외양은 ADR-0174가 이미 후속으로 미뤘다.

### D7. 스키마·RLS·쓰기 경로
- **새 테이블·컬럼·인덱스·outbox 생산자 0.** `approval.action_type`(text)·`payload`(jsonb)·`agent_run.output`(jsonb)·자격 스코프(text[])로 충분하다. hosted 스코프 어휘를 열거한 CHECK 3개(069 `hosted_agent_connection_scopes_ck` · 074 `token_hosted_binding_ck` · 074 `hosted_oauth_request_scope_ck`)만 087에서 재작성(정오표 2026-09-22, AX-3a 실측 — 원문 「DDL 무접촉」은 CHECK 열거를 보지 못한 오기). `schema_v0.sql` 무접촉.
- 모든 쓰기는 기존 `agent_tenant_tx` 안(`SET LOCAL app.workspace_id`). 메시지는 `send_message_in_tx`(channel_seq 증가 + outbox), 카드 패치는 `patch_message_props_in_tx`. 새 outbox 생산자·BYPASSRLS 없음.

### D8. 폰
승인 카드(U4-g)와 `action_result` 카드는 M1 폰 패리티에 흡수한다(AX-7). 폰에서 결정하면 `secretOnce`도 폰 메모리에만 있다(D4 동일).

## 4. 티켓 분해(AX)와 순서
정본 편성은 `docs/planning/2026-09-22-plan-revision.md` §4. 요약:

| ID | 내용 | 트랙 | 크기 | 선행 |
|---|---|---|---|---|
| AX-0 #2506 | 이 ADR + 계획 개정 + 브리프(문서 PR) | engine(docs) | S | — |
| AX-2 #2507 | TS 명령 레지스트리 + ⌘K 「명령」 그룹 + 키캡 힌트 + 단축키 드리프트 가드(UX-R3a 축소) | uxui | M | — (ADR 불요) |
| AX-3a #2508 | `actions.rs` 레지스트리 + `GET actions` + 스코프 + `oort_action_propose` + run 가드 + OpenAPI + 동의 라벨 | engine | M | **ADR Accepted** |
| AX-3b #2509 | 결정 분기 `workspace_action` + 초대 실행기 + 감사 + action_result 메시지 + 응답 `secretOnce` + 만료 arm 시험 | engine | M | AX-3a |
| AX-4 #2510 | 승인 카드 `action` 행 + `action_result` 카드 + `link_once` in-place + 팔레트에 서버 카탈로그 병합 | uxui | M | ADR Accepted(부록 계약으로 착수), 병합 검증은 AX-3b 뒤 |
| AX-6 #2512 | E2E: mock hermes `oort_action_propose(invite.create)` → 승인 → 링크 1회 → 재발급 → 폰 결정 경로 | planner | — | AX-3b·AX-4 |
| AX-1 #2016 | 도구 카탈로그 GET(내부 worker 경로, 독립) | engine | S | — |
| AX-5 #2511 | D6 `command_suggest` + `settings_preview` 카드(테마) | uxui | S | AX-2·AX-4 |
| AX-8 #2514 | `webhook.create` 실행기(ADR-0004 증보 4 #2066 뒤) | engine | S | AX-3b·#2066 |
| AX-7 #2513 | 폰 승인·결과 카드 패리티 | mobile | M | AX-4 |

## 5. 수용 기준(구현 티켓이 인용할 red proof)
- `oort_action_propose`는 `workspace:propose`가 토큰·승인 양쪽에 없으면 unknown-tool로 보인다(기존 `has_scope` 교집합 규칙).
- 제안 뒤 `oort_run_complete` → `approval_pending` 실패. 승인 뒤 run `succeeded`·거부 뒤 `cancelled`·만료 뒤 `timed_out`, 세 경로 모두 resume job 0건.
- 결정자가 admin이 아니면 403 `role_required`이고 approval은 여전히 `pending`이다.
- 승인 응답 본문에만 `secretOnce`가 있고 `approval.payload`·`message.props`·`audit`·서버 로그에 코드 문자열이 **0회** 나타난다(grep 시험).
- 감사: `action.approved`(제안자·결정자·approval_id) + `invite.created`(`via_agent`) 2행.
- `ACTIONS` id 집합 = `oort_action_propose` 스키마 enum = OpenAPI enum(시험 1개가 셋을 잰다).
- 카드: 모르는 kind는 본문 폴백, 토스트 0(preflight), design-review B0·H0.

## 6. 귀결
- (+) 「@hermes 초대 링크 만들어줘」가 실제로 닫힌다. 승인 축이 관전·대화 옆의 **행동** 축으로 확장되고, 폰 패리티의 근거가 하나 더 생긴다.
- (+) 새 테이블·새 outbox·새 권한 상승 없이 기존 폐곡선 위에 얹힌다.
- (−) hosted 에이전트 지시문(hermes·그록봇 루틴)이 `workspace:propose` 요청과 「제안 뒤 turn 종료」 규칙을 배워야 한다(AX-3a 문서 범위).
- (−) 승인 카드가 tool_call 승인과 행동 승인 두 얼굴을 갖는다. 부록 A `action` 블록 유무로 구분하고 렌더러가 한 컴포넌트를 유지한다.

## 7. 성재 확정점
1. D2 run park 모양(제안 뒤 `run_complete` 409) 승인 여부
2. D4 「1회 시크릿은 결정 응답에만」 승인 여부 — 편의를 위해 링크를 카드에 남기지 않는다
3. D6 테마 등 클라이언트 명령의 「적용」 버튼 경로 승인 여부
4. Accept 시점: AX-2는 지금, AX-3a는 Accept 뒤 착수

## 8. 부록 — 고정 계약(AX-3·AX-4가 같이 코딩하는 모양)

### A. `approval_request` props 확장(기존 필드 유지 + `action`)
```json
{
  "approval_id": "…", "run_id": "…", "channel_id": "…",
  "action_type": "workspace_action", "status": "pending", "expires_at_ms": 0,
  "title": "팀원 초대 링크 만들기",
  "summary": "hermes가 제안했습니다. 승인하면 관리자 권한으로 초대 링크를 만듭니다.",
  "action": {
    "id": "invite.create",
    "rows": [
      {"label": "역할", "value": "member"},
      {"label": "사용 횟수", "value": "1회"},
      {"label": "만료", "value": "7일"}
    ],
    "rationale": "새 팀원 온보딩 요청",
    "required_role": "admin"
  }
}
```

### B. `tool_result` props `momo.action_result.v1`(영속 카드)
```json
{
  "momo.action_result": {
    "v": 1,
    "action_id": "invite.create",
    "status": "executed",
    "approval_id": "…",
    "decided_by": "<member_id>",
    "ref": {"type": "invite", "id": "<invite_id>"},
    "rows": [{"label": "역할", "value": "member"}, {"label": "만료", "value": "2026-09-29"}],
    "secret_shown_once": true,
    "next": {"label": "설정 › 멤버와 초대에서 보기", "href": "/settings?section=members"}
  }
}
```
`status` ∈ `executed | rejected | expired | role_required`. 코드·URL 필드는 없다.

**정오표 2026-09-22 (AX-4 #2510 지적, AX-3b #2509에서 반영)**: 원문 샘플의 `next`는 `/settings?section=invites`·「설정 › 초대에서 보기」였는데 그런 섹션이 없다. 클라 정본은 `members`(「멤버와 초대」, `clients/web/src/features/settings/settingsNav.ts:53`)다. 서버가 보내는 값은 위 샘플대로 `href=/settings?section=members`·`label=「설정 › 멤버와 초대에서 보기」`이며, 정본 상수는 `momo_agent::actions::{ACTION_RESULT_NEXT_HREF, ACTION_RESULT_NEXT_LABEL}`이다.

**정오표 2026-09-22 (D2 403 봉투)**: AX-4는 403 `role_required`를 `ErrorResponse` 봉투의 `code` 필드로 요청했으나, 이 라우트의 403은 봉투가 아니라 **영수증**이다 — 스펙이 「Expected failures (403/404/409) return the SAME receipt schema (not the generic error envelope)」라고 못박고 있고(`docs/api/openapi.yaml` `decideApproval`), 두 클라이언트 모두 403을 영수증으로 파싱한다(`packages/momo-core/src/features/timeline/approvalDecision.ts:233`의 `receiptStatuses`에 403 포함 후 `receipt.status` 판독). 그래서 코드는 `ErrorResponse.code`가 아니라 **영수증 `status: "role_required"`**로 실린다. 부록 B가 이미 `role_required`를 *status* 어휘로 쓰고 있으므로 한 낱말이 두 표면에서 같다. `ErrorResponse`는 무변경.

### C. 결정 응답(`decision` 200) — 기존 receipt + `result`
```json
{
  "…기존 receipt 필드…": "…",
  "result": {
    "actionId": "invite.create",
    "ref": {"type": "invite", "id": "<invite_id>"},
    "secretOnce": {"kind": "invite_link", "value": "https://…/join?code=…", "expiresAtMs": 0}
  }
}
```
헤더 `Cache-Control: no-store`, `Pragma: no-cache`. `secretOnce`는 승인 성공에만 있다.

### D. `momo.command_suggest.v1`(D6, 클라이언트 명령 참조 — AX-5)
```json
{"momo.command_suggest": {"v": 1, "command_id": "appearance.accent", "args": {"accent": "dawn"}, "label": "액센트를 새벽으로"}}
```
클라이언트는 `command_id`가 레지스트리에 없거나 kind가 `client`가 아니면 본문 폴백한다.

**증보 2026-09-27(GC-5)**: 이 모양은 증보 G3로 대체된다. `for_member_id`가 더해지고, `label`은 모든 `command_id`에서 **서버가 파생**한다(에이전트 문자열이 아니다). `command_id`는 서버 허용목록(G2) 안이어야 한다. 위 `appearance.accent` 예는 AX-5가 그 명령을 허용목록에 올린 뒤에만 유효하다.

### E. `GET /v1/workspaces/{ws}/actions`
```json
{"actions": [{"id": "invite.create", "title": "팀원 초대 링크 만들기", "summary": "…", "risk": "approval", "requiredRole": "admin", "argsSchema": {"type": "object", "properties": {"role": {"enum": ["member", "admin"]}, "maxUses": {"type": "integer", "minimum": 1, "maximum": 100}, "expiresInDays": {"type": "integer", "minimum": 1, "maximum": 30}}}, "executable": true, "unavailableReason": null}]}
```

## 9. 결재 기록
- 2026-09-22 성재(방향, ADR 기안 전): ①AX 첫 실물 = **ITO 전에 초대 1종까지** ②승인 정책 = **위험 등급별** ③ADR-0004 증보 4 = **Accept, D2(a) 이행 복사** ④UX-R3a 팔레트 = **축소 범위 연기 해제**. 「나머지는 설계 구체화, 준비가 온전하면 착수」.
- 정오표 D7(087) — planner 수용, 성재 통보.
- 2026-09-22 성재 Accept: 확정점 ①run park+`run_complete` 409 ②1회 시크릿=결정 응답에만 ③테마 「적용」 버튼 ④AX-2 지금·AX-3a Accept 뒤 — 전부 승인. 같은 결재에서 W-A 발사 go(#2066 ∥ AX-2 #2507). 워커 레인은 이 배치에 한해 **Opus 5 서브에이전트**(성재 지시, PIPELINE 기본값 Grok 4.6의 예외).
- 2026-09-22 AX-3b(#2509) 랜딩분 기록: D2 결정 분기·D4 `secretOnce`·부록 B/C 구현. 부록 B `next` 정오표(§8 B)와 403 봉투 정오표(같은 절) 반영. 부록 C `secretOnce.value`의 공개 오리진은 `MOMO_PUBLIC_BASE_URL`(설정 시) → 요청 `Host`+`X-Forwarded-Proto`(ADR-0167 파생) 순서로 결정한다 — 브리프가 가리킨 「초대 redeem 라우트의 공개 사이트 주소 정본」은 실재하지 않았다(#1926 `OORT_SITE_ADDRESS`는 Caddy 템플릿 env이고 Rust는 읽지 않는다).

## 증보 2026-09-27 — 채팅 안 연결 카드: `oort_card_suggest`·`card_suggest`·허용 command_id·`for_member_id`·보는 사람별 렌더 (GC-5, #2946)

- Status: **Accepted** (2026-09-27 성재 결재)
- 결재 인용: #2939 설계 메모 §7 Q1~Q5, 성재 2026-09-27 「전부 권장대로」. 이 증보가 직접 기대는 것은 **Q3**(2단계 카드는 새 kind가 아니라 D6 `command_suggest` 재사용, `command_id:"ai.connect"`, props는 의도만, AX-5와 같은 서버 경로)와 **Q4**(제안 대상이 아닌 사람에게는 한 줄, 채널·DM·스레드 모두 허용, 운영자에게는 팀 연결 줄). 시안 https://claude.ai/artifact/UbuDdAWMtJMdxGZojCxwrz
- 기안: Opus 5.5 worker(#2946)
- 근거 자료: 설계 메모 `/Users/kwakseongjae/projects/momo/claudedocs/chat-genui-connect/brief.md` §1 F4·F9·F14, §4, §5, §9(gitignore, 로컬). ADR-0162(Agent Port tool→scope 닫힌 표), ADR-0193 D4(구독 에이전트 소유자 전용).
- 범위: 2단계(에이전트가 연결 카드를 **제안**) 서버·메시지 계약만. 1단계(슬래시·⌘K·「나에게만 보여요」 로컬 카드, GC-0~4)는 서버 계약 변경이 없어 이 ADR의 D1·D3 안이다.

### 무엇이 비어 있었나
- D6은 「에이전트가 `oort_message_post`에 명령 참조 props를 실어 보낸다」고 적었다. 코드의 `oort_message_post`는 메시지를 `props: {}`로만 쓴다(`routes/agent_port_tools.rs` `message_post`). 에이전트가 props 있는 메시지를 만드는 경로는 `oort_action_propose`(승인 카드) 하나이고, 그 props도 서버가 만든다. 그래서 D6·부록 D는 **문서 계약만 있고 서버 경로가 없다**(레지스트리 주석 한 곳 말고는 `command_suggest` 참조 0).
- 이 증보는 D6 결정(risk `none`, 사람이 자기 기기에서 적용, 승인 행·감사 행 없음)을 바꾸지 않는다. 그 결정의 **경로·필드·검증·렌더**를 채운다.

### G1. 제안 도구 — hosted `oort_card_suggest`, worker `card_suggest`
- **hosted(Agent Port)**: 새 도구 **`oort_card_suggest { handle, clientMsgId, commandId, args, body, rootId? }`**.
  - `handle` = `oort_jobs_claim`의 lease handle. `bound_handle` 검사는 `oort_action_propose`와 같다(워크스페이스·에이전트·연결·승인 채널). 게시 채널은 **handle의 `channel_id`**다. 인자로 채널을 받지 않는다.
  - `clientMsgId`는 필수. 같은 값의 재시도는 기존 send 멱등으로 같은 메시지를 돌려준다.
  - `body`는 에이전트의 텍스트 답이다(1~8,000자, `oort_message_post`와 같은 상한). 카드만 있는 빈 메시지는 없다.
  - `rootId`는 선택. 검증은 `message_post`의 `validate_thread_root_in_tx`와 같다. 채널·DM·스레드 어디서든 허용한다(Q4).
  - **받지 않는 인자**: `label`·`forMemberId`·`channelId`·`props`. 이 키들이 오면 `InvalidArguments`(unknown key 거절)다. 에이전트가 제목 문구·대상·자리를 정할 길을 인자 표면에서 없앤다.
- **server worker(agent-worker)**: worker `CATALOG`(`momo-agent/src/tools.rs`)에 **`card_suggest { commandId, args, body }`**를 더한다. 채널·스레드는 그 run의 트리거 메시지 자리, 멱등 키는 `(run_id, tool_call_id)`에서 결정적으로 만든다. 검증·props 조립·label 파생은 hosted와 **같은 함수**(`momo-agent`에 둔다)를 부른다.
  - worker 도구의 승인 기본값(`requires_approval`, ADR-0114 D5)은 이 도구에 한해 **요구하지 않음**이다. 서버 상태를 바꾸지 않고(D3 risk `none`) 사람이 누를 때만 그 사람의 기기·권한으로 동작하므로, 제안 자체를 승인 카드로 막으면 「승인해야 카드를 볼 수 있는 카드」가 된다. 이 예외는 `card_suggest` 이름 하나에 묶고 grants로 넓히지 않는다.
  - **ADR-0114 D5 예외, planner 결정 2026-09-27**(#2952 검수): 서버 상태를 바꾸지 않고, 에이전트의 일반 메시지 게시와 같은 위험 등급이라 수용.
  - **기본 프로필, planner 결정 2026-09-27**(GC-8 #2949): 이름 면제의 대가로 이 도구는 프로필 `enabled_tools`에 켜져 있을 때만 실행된다(#2959 M3). 새 에이전트는 켜진 채로 시작한다. `POST …/agents`가 `enabledTools`를 생략하면(프로필 객체가 없어도) 프로필 행을 `["card_suggest"]`로 쓴다. 명시 목록(`[]` 포함)은 그대로 저장되므로 운영자가 허브에서 끌 수 있다. 프로필 PUT의 생략은 `[]`이고 기본값을 다시 넣지 않는다. 읽을 때 기본값을 넣지 않고 쓸 때 행에 적는다. 허브가 보여 주는 목록이 실제로 실행되는 목록이어야 하기 때문이다. 이미 있는 에이전트에는 소급하지 않는다. worker는 이 도구가 켜져 있을 때만 「연결 요청이면 카드 제안」 system 턴(`CARD_SUGGEST_DIRECTIVE`)을 싣는다.
- 두 종류를 **같은 배치에서** 연다(GC-6). 한쪽만 열면 「어떤 에이전트는 카드를 주고 어떤 에이전트는 설정 경로만 말한다」가 된다.
- **쓰기 경로**: 기존 `agent_tenant_tx`(`SET LOCAL app.workspace_id`) 안에서 `send_message_in_tx`(channel_seq 증가 + message INSERT + outbox INSERT 단일 tx). 승인 행 0, run park 0(run 상태를 바꾸지 않는다), props 패치 0, **새 outbox 생산자 0**, 새 테이블·컬럼 0. D7은 그대로다.
- **에이전트는 실행하지 않는다.** 이 도구는 PTY·provider_link 라우트·설정 API 어느 것도 부르지 않는다. 로그인·키 저장·연결 확인은 사람이 카드를 누를 때 그 사람의 클라이언트가 기존 경로로 한다.

### G2. 허용 command_id — 서버 허용목록 + 레지스트리 `agentSuggestable` 드리프트 가드
- 서버 정본: `momo-agent`에 `SUGGESTABLE_COMMANDS: &[SuggestableCommand]`(id · args 스키마 · label 파생표)를 둔다. **v1 = `ai.connect` 하나.** 허용목록 밖 `commandId`는 `InvalidArguments`.
- `ai.connect`의 `args`:
  - `harness` ∈ `claude | codex | team_key`, `scope` ∈ `mine | team`. 둘 다 선택이고, 둘 다 없으면 카드 전체(두 절)를 연다.
  - `grok`은 v1 enum에 **없다**(ADR-0193 증보·AI 계정 Q7에서 Grok은 「준비 중」, planner 결정 2026-09-27). Grok 구독 줄이 열릴 때 이 ADR의 새 증보로 enum·label 파생표에 함께 추가한다. 그 전에 `harness:"grok"`은 `InvalidArguments`.
  - 짝 규칙: `team_key` ⇔ `team`, `claude | codex` ⇔ `mine`. 한쪽만 주면 서버가 짝을 채우고, 어긋나면 `InvalidArguments`.
  - 그 밖의 키(예: `apiKey`, `token`, `email`)는 전부 `InvalidArguments`. 값에 자유 문자열이 들어갈 칸이 없다.
- TS 쪽: `packages/momo-core/src/features/commands/registry.ts`의 `Command`에 선택 필드 **`agentSuggestable?: true`**를 새로 둔다(지금은 없다). `ai.connect`(kind `client`, GC-2)가 첫 항목이다. `agentSuggestable`은 kind `client` 명령에만 허용한다.
- **드리프트 가드**(D1 「세 소비자」 방식의 확장): momo-mcp는 momo-agent에 의존할 수 없으므로(`actions.rs` 머리 주석) 도구 스키마의 enum은 두 번 쓰인다. 시험이 넷을 한 번에 잰다.
  1. Rust `SUGGESTABLE_COMMANDS` id 집합 = `oort_card_suggest` 스키마 `commandId` enum = worker `card_suggest` 스키마 enum(Rust 시험, `the_action_ids_are_one_list_in_three_places`와 같은 자리·같은 모양).
  2. = `docs/api/openapi.yaml`의 새 enum `SuggestableCommandId`(기존 OpenAPI rust 샘플러).
  3. = TS 레지스트리의 `agentSuggestable: true` id 집합(코어 시험이 openapi.yaml의 enum을 읽어 비교). Rust는 TS를 읽지 못하므로 OpenAPI가 두 언어의 접점이다. 이 openapi.yaml 경유 방식은 planner가 수용했다(2026-09-27). 기존 D1 가드는 Rust 쪽 세 곳만 재므로 선례가 없고, **GC-6(#2947)에서 실제 구현 가능 여부를 확인**한다. 안 되면 GC-6 PR에 대안과 함께 적는다.
- 앞으로 `appearance.*`(AX-5 #2511)는 같은 길을 쓴다. 명령을 늘리는 것은 네 곳을 함께 고치는 일이고, 한 곳만 고치면 시험이 실패한다.

### G3. props — 의도만, 서버가 만든다
부록 D를 이 모양으로 대체한다.
```json
{"momo.command_suggest": {"v": 1, "command_id": "ai.connect",
  "args": {"harness": "claude", "scope": "mine"},
  "for_member_id": "<요청자 member_id>",
  "label": "Claude 구독 연결"}}
```
- 필드는 정확히 `v, command_id, args, for_member_id, label` 다섯이다. 서버가 조립하고 에이전트 입력을 그대로 복사하지 않는다(`args`도 G2 검증을 지난 정규화 값).
- **`for_member_id`는 서버가 run에서 채운다.** run의 `trigger_message_id`(`agent_run`) → 그 메시지의 작성자. 작성자가 `member.kind='human'`이 아니거나(에이전트끼리의 위임 등) 트리거 메시지가 없으면 도구 실패 `no_human_requester`, 메시지 0건. 에이전트는 이 값을 인자로 줄 수 없다(G1). 구독 에이전트(`owner_only`, ADR-0193 D4)는 소유자의 호출만 전달받으므로 대상은 늘 소유자다. 이 규칙과 충돌이 없다.
- **`label`은 서버가 `(command_id, args)`에서 파생**한다. 파생표는 `SUGGESTABLE_COMMANDS` 옆에 둔다. v1 `ai.connect`: `claude`→「Claude 구독 연결」, `codex`→「Codex 구독 연결」, `team_key`→「팀 API 키 연결」, 인자 없음→「AI 연결」. 상한 40자. 에이전트가 쓴 문자열이 카드 제목이 되는 길은 없다(피싱 문구 차단).
- **props에 없는 것(불변식)**: 연결 상태·결과·키 꼬리·마지막 확인 시각·이메일·표시 이름·기기 이름·프로필 경로. 카드는 보는 사람의 클라이언트가 **자기 설정 스토어**(설정 › AI 연결과 같은 훅·같은 판정 함수)에서 살아 있는 상태를 읽어 그린다. 그래서 「제자리 갱신」은 props 패치가 아니라 로컬 상태 변화이고, 서버 쓰기는 제안 메시지 1건뿐이다.
- 한 줄 문구의 이름(「곽성재에게 …」)은 클라이언트가 `for_member_id`를 멤버 목록에서 찾아 그린다. props에 이름을 싣지 않는다.

### G4. 보는 사람별 렌더 — 클라이언트 분기, 경계는 서버·기기
서버는 채널의 모든 멤버에게 **같은 props**를 보낸다. 분기는 클라이언트 렌더다.

| 보는 사람 | 보이는 것 |
|---|---|
| `for_member_id` 본인(데스크탑) | 조작 가능한 연결 카드. 1단계 로컬 카드와 **같은 컴포넌트**이고 머리만 「{에이전트}가 제안했어요」. 내 계정 절 + 팀 연결 절(운영자면 조작, 아니면 「허용되지 않음」 한 줄 + 「운영자에게 부탁하기」 — 아래 정정 2026-09-27) |
| 본인(웹 탭) | 같은 카드. 내 계정 절은 「구독 계정은 데스크탑 앱에서만 연결하고 볼 수 있어요」 한 줄 |
| 본인(폰) | 읽기 + (운영자면) 팀 연결 확인만. 구독 로그인·키 입력은 폰에서 받지 않는다(Q5). 비운영자의 팀 줄은 데스크탑과 같은 규칙으로 「허용되지 않음」 한 줄이다(읽기 전용 줄 아님, 아래 정정) |
| 운영자(본인 아님) | 한 줄 「{for_member}에게 AI 연결을 제안했어요」 + 「팀 연결 보기」(팀 키 줄만 펼침, 조작 가능). 남의 구독 상태는 보이지 않는다 |
| 그 밖의 멤버 | 한 줄 「{for_member}에게 AI 연결을 제안했어요」. 입력·버튼 0 |

- 운영자 = 서버의 `require_instance_operator`(owner/admin + `PLATFORM_ADMIN_EMAILS`)를 지나는 사람이다. 클라이언트는 이 판정을 기존 provider_link 응답(403이면 비운영자, 코어 `isOperatorDenied`)으로 안다. 카드 전용 판정을 새로 두지 않는다.
- **경계는 숨긴 버튼이 아니다.** 구독 로그인은 본인 기기의 PTY(#2816 모달), 팀 키 쓰기·확인은 운영자 라우트(비운영자 403)다. 다른 사람이 DOM을 고쳐 버튼을 살려도 할 수 있는 일이 없고, props에 비밀이 없으니 누가 받아도 새는 것이 없다.
- 채널·DM·스레드 모두 허용한다(Q4). 채널 전체가 한 줄을 본다는 것은 「누가 연결을 요청했다」를 드러내는데, 이는 사람이 채널에서 에이전트에게 말한 사실 이상이 아니다. 완전히 숨기면 채널의 대화 맥락이 끊겨서 택하지 않았다.
- 알림: 제안 메시지는 그 에이전트의 일반 답과 **같은 알림 규칙**을 따른다. 카드 때문에 따로 푸시하지 않는다.
- 제안은 승인 카드가 아니다(D3 `approval` 아님). 사람이 자기 화면에서 여는 도구 창이다. approval 행·결정 라우트·만료 스윕과 무관하다.
- 모르는 `command_id`, kind가 `client`가 아닌 명령, `for_member_id`를 멤버 목록에서 찾지 못한 경우는 본문 폴백(부록 D 규칙 유지).

**정정 2026-09-27(planner 결정, GC-8 #2949)**: 비운영자 대상의 팀 연결 절
- 원문 「읽기 전용 줄 + 「운영자에게 부탁하기」」를 고친다. 읽기 전용 줄에 그릴 값이 없다. 팀 키 줄의 원천인 provider_link GET이 비운영자에게 403이다(`require_instance_operator`). 알약·키 꼬리를 그리려면 비운영자에게 팀 연결 상태를 여는 새 읽기 경로가 필요한데, 그것은 이 증보의 범위(서버 쓰기 0·새 권한 0) 밖이다. 근거: PR #2977 「시안과의 차이」 ①.
- 그래서 비운영자 대상의 팀 절은 **「허용되지 않음」 한 줄**(구현 문구 「팀 키는 운영자만 바꾸고 확인할 수 있어요.」)과 **「운영자에게 부탁하기」**로 그린다.
  - 「운영자에게 부탁하기」는 **빈 컴포저에 운영자 멘션만 채우고 보내지 않는다.** 보내는 것은 사람이다. 쓰던 글이 있으면 덮지 않는다. 스레드 안의 제안이면 그 스레드 컴포저를 채운다.
- 폰 행도 같은 규칙이다. 비운영자 대상에게 팀 줄은 「허용되지 않음」 한 줄이고, 조작 요소가 없다. 폰의 「운영자에게 부탁하기」는 v1(#2977)에 없다. 폰은 Q5대로 읽기+확인만 하므로 폰에 부탁 버튼을 더하는 것은 이 정정의 요구가 아니라 후속 선택이다.
- **알려진 한계**: 「운영자에게 부탁하기」는 멘션할 운영자를 **워크스페이스 역할(owner·admin)만** 보고 찾는다. 서버의 운영자 판정은 `PLATFORM_ADMIN_EMAILS`도 포함하지만(위 「운영자」 정의) 클라이언트는 그 목록을 모른다. 그래서 역할이 member인 플랫폼 운영자는 멘션 후보에서 빠진다. 그 목록을 클라이언트에 내보내는 것은 운영자 이메일 노출이라 택하지 않았다.

### G5. 스코프·동의 화면 — `messages:write`로 충분, 문구 변경 없음
- **판단: 새 스코프를 두지 않는다.** `oort_card_suggest`는 `messages:write`(+ handle을 얻기 위한 `agent:jobs:read`)를 요구한다. ADR-0162의 닫힌 tool→scope 표에 한 줄을 더하는 것이고, 규칙은 같다: `tools/list`는 연결·멤버십·스코프 교집합만 광고하고, `messages:write`가 토큰·승인 어느 쪽에든 없으면 list와 call 모두 fail-closed(unknown-tool).
- 이유: 이 도구가 하는 일은 「승인한 채널에 이 에이전트 이름으로 메시지를 쓴다」이다. 카드는 서버 권한을 하나도 더 주지 않는다(G1 「에이전트는 실행하지 않는다」). 스코프를 새로 두면 hosted 스코프 어휘를 열거한 CHECK 3개(D7 정오표: 069·074·074)를 다시 쓰는 migration과 동의 화면 줄이 생기는데, 얻는 경계가 없다.
- **동의 화면 문구는 바꾸지 않는다.** 코어 `hostedAgents/approval.ts`의 `messages:write` 줄 「메시지 쓰기 — 승인한 채널에 이 에이전트 이름으로 메시지를 씁니다. 사람이 쓴 것과 같은 자리에 남습니다.」가 제안 메시지를 그대로 설명한다. 카드를 따로 적으면 없는 권한이 있는 것처럼 읽힌다.
- 선을 그어 둔다: 앞으로 **서버 상태를 바꾸거나 무언가를 실행하는** 카드가 생기면 그것은 이 도구가 아니라 D2(`workspace:propose` + 승인)로 간다. `oort_card_suggest`의 허용목록에 risk `approval` 명령을 올리는 것은 이 증보 위반이다.

### G6. 수용 기준(GC-6·GC-7이 인용할 red proof)
각 시험은 해당 분기를 지우면 실패해야 하고, 그 RED를 PR 본문에 남긴다.
- `messages:write`가 토큰 또는 승인에 없으면 `oort_card_suggest`는 list·call 모두 unknown-tool.
- 인자에 `forMemberId`·`label`·`channelId`·`props` 중 하나라도 있으면 `InvalidArguments`, 메시지 0건.
- `args`에 허용 밖 키(`apiKey`)가 있으면 `InvalidArguments`. 짝이 어긋난 `{harness:"team_key", scope:"mine"}`도 거절.
- 허용목록 밖 `commandId`(예: `invite.create`, `appearance.accent` — AX-5 전)는 `InvalidArguments`.
- 성공 시 props의 `for_member_id` = 트리거 메시지 작성자. 트리거 작성자가 에이전트면 `no_human_requester`, 메시지 0건.
- 성공 시 props 키 집합이 정확히 다섯이고 `label`이 파생표 값과 같다(에이전트가 `body`에 쓴 문장과 무관).
- 게시는 channel_seq 증가 + message + outbox가 한 tx에 있고, 같은 `clientMsgId` 재시도는 메시지 1건, 다른 워크스페이스 GUC면 0행. `approval` 행 0, `agent_run.status` 불변.
- 드리프트 가드(G2)의 네 집합 중 하나에만 id를 더하면 시험 실패.
- 클라이언트: 비대상·비운영자의 카드 DOM에 input·button 0(렌더 시험). 대상과 설정 행에 같은 모의 입력을 주면 알약 문자열이 같다(1단계 GC-0 교차 시험 재사용).
- 도구 구현이 PTY·provider_link·설정 라우트를 부르지 않는다(구조 시험).

### G7. 귀결
- (+) 「내 클로드 구독 연결해 줘」가 대화 안에서 닫힌다. 설정과 같은 부품·같은 판정이라 두 곳이 다른 상태를 말하지 않는다.
- (+) 새 스코프·새 테이블·새 outbox 생산자 없이 기존 send tx 위에 얹힌다. AX-5 테마 카드도 이 길을 쓴다.
- (−) hosted 에이전트 지시문과 worker 시스템 프롬프트가 「연결 요청이면 카드 제안」을 배워야 한다(GC-8).
- (−) 제안 메시지는 채널에 남으므로 오래된 제안도 **지금 상태**로 그려진다(이미 연결했으면 「준비됨」). 제안 당시 상태를 보존하지 않는 것은 의도다.

## 증보 2026-10-11 — 관리 액션 v2: `channel.create`·`channel.member.add`·`agent.rename`·`hosted.channels.grant` (#3699)

- Status: **Accepted** (2026-10-11 성재 결재 — V9 결재 기록. 기안 같은 날 Opus 5.5 worker. 2번 `agent.rename`의 신뢰 모델 세부 기본값은 「owner 위임: 오케스트레이터가 보수적으로 확정」. 구현은 슬라이스(V10)별 PR로 착수 가능)
- 발제: 성재 2026-10-11 「에이전트 하나만 잘 초대하면 에이전트를 통해서 설정을 바꾸거나 테마를 바꾸거나, 팀원을 초대하거나 그런걸 가능하게 하는 AI native 메신저」, 「그록봇 하나만 초대하면 걔가 그룹을 꾸리고 이름을 바꾸거나 다른 그록봇을 만들어서 초대」
- 기안: Opus 5.5 worker(#3699)
- Consumes: ADR-0162(채널 승인 권한 주체 = 관리자의 confirm, 증보 2 DM 규칙) · ADR-0128(채널 생성·멤버 추가는 워크스페이스 owner/admin) · ADR-0131(에이전트 프로필 편집 = 소유자 또는 관리자) · ADR-0118(이름 변경 경계) · ADR-0101(에이전트=1급 멤버, 분기 금지) · ADR-0198(에이전트 vs 하네스) · ADR-0174(외양은 기기 localStorage)
- 이 증보는 D2(제안 → 승인 → 실행)·D3(위험 등급)·D4(1회 시크릿)·D7(새 테이블 0)을 **바꾸지 않는다.** D1의 레지스트리에 행동 다섯을 더하고, 그 다섯이 처음으로 부딪히는 문제(V2: 한 run은 한 번만 제안한다 / V3: 승인 채널이 사람의 경계다 / V4: 표시 이름이 신뢰 표면이다)에 답한다.

### V0. 코드로 확인한 사실(2026-10-11, main `8fba66541`)
- 그록봇(hosted) 도구 중 워크스페이스를 바꾸는 길은 `oort_action_propose` 하나이고 `ACTIONS`는 `invite.create` 하나다(`momo-agent/src/actions.rs`). `DECLARED_NOT_EXECUTABLE` = `webhook.create`·`channel.create`·`member.role.set`.
- **채널 생성·멤버 추가 REST는 있다.** `routes/channels.rs` `create`(`create_channel_detailed_in_tx`)·`add_member`(`add_channel_member_in_tx`), 둘 다 owner/admin. 승인자 명의로 부를 수 있는 도메인 함수가 이미 있다. 다만 두 함수 모두 **audit 행도 outbox도 쓰지 않는다**(`channels.rs`에서 audit은 `notification_pref.updated` 하나뿐).
- **에이전트 표시 이름을 바꾸는 라우트는 없다.** `PATCH …/members/me`(`self_profile::rename_self`)는 `require_human`으로 에이전트를 거절하고(`AGENTS_USE_THE_PROFILE_PATH`), 프로필 경로 `PUT …/agents/{agent}/profile`의 `AgentProfileInput`에는 `display_name`이 없다. `POST …/agents`가 이름을 받는 유일한 길이다. 이름 검증 `normalized_join_display_name`은 trim + 1~100자뿐이다.
- 표시 이름은 **멘션 대상**이다. `@Display Name`·`<@Display Name>`은 대소문자 구분으로 멘션이 되고(`momo-messaging/src/read_state.rs:679`), `member`의 유일성은 `handle`에만 있다(`member_handle_uniq`). 이름에는 유일 제약이 없다.
- `hosted_agent_connection.approved_channel_ids`는 **confirm(static)·consent(OAuth)에서만 쓰인다**(`momo-auth/src/hosted_connection.rs`·`hosted_oauth.rs`의 한 CTE. 같은 CTE가 에이전트의 `membership`을 넣고 `kind<>'dm'`·미보관만 받는다). confirm 뒤에 이 배열을 넓히는 라우트는 없다. 「이 connection이 덮는 방」의 유일한 정의는 SQL 함수 `hosted_connection_channel_ids`(091)이고, inbox·gateway claim·Agent Port identity가 전부 이것을 쓴다. 에이전트는 `approved_channel_ids`에 있고 **동시에** `membership`이 살아 있어야 그 방을 읽고 쓴다(`hosted_inbox.rs`의 `visible`).
- `oort_message_post`는 `channelId`를 인자로 받는다. 승인 채널이 아니면 실패한다. 그래서 에이전트가 만든 채널에서 말하려면 membership과 승인 채널 둘 다 필요하다.
- 한 hosted run은 **제안을 한 번만** 한다. 제안이 run을 park하고 승인되면 run은 `succeeded`다(D2). 한 run에서 「채널 만들기 → 나 넣기 → 사람 넣기」를 이어서 제안할 수 없다.
- 승인 결과는 지금 에이전트 명의 `action_result` 메시지(부록 B)로 채널에 남고, 1회 값은 결정 HTTP 응답에만 있다(D4).

### V1. 결정 요약
| 행동 | 위험 | 승인자(`requiredRole`) | 실행 | 대상을 정하는 것 |
|---|---|---|---|---|
| `channel.create` | `approval` | `admin`(기존) | 승인자 명의로 채널 생성(승인자 = `created_by`·채널 owner). `addProposer`이면 제안 에이전트를 넣고 승인 채널에 올린다(V3) | 이름·공개 범위·주제·(선택) 멤버 핸들 |
| `channel.member.add` | `approval` | `admin` | 승인자 명의로 membership 추가(역할은 `member` 고정) | 제안 에이전트가 **볼 수 있는** 채널 + 멤버 핸들 |
| `agent.rename` | `approval` | **`agent_editor`**(신규: **대상** 에이전트의 소유자 또는 워크스페이스 admin — `require_profile_editor_in_tx`와 같은 판정) | 대상 에이전트의 표시 이름. 대상은 제안자 자신 또는 **같은 소유자의 다른 에이전트**(V4-M) | 새 이름 + (선택) 대상 핸들 |
| `hosted.channels.grant` | `approval` | `admin`(ADR-0162: 채널 승인 권한 주체는 관리자) | **제안한 에이전트의 connection**의 승인 채널에 채널 추가 + membership | 채널 이름들 |
| `workspace.settings.update` | `approval` | **`workspace_operator`**(신규: `require_workspace_operator`와 같은 판정 — owner/admin, 플랫폼 운영 스코프 포함) | 승인자 명의로 설정 bag의 **`welcome_prompt`·`role_labels` 두 키만** 병합 저장 | 두 키의 새 값(V7) |
| `member.role.set` | — | — | 계속 `DECLARED_NOT_EXECUTABLE`(#3699 범위 밖) | — |

공통 규칙(V1-a~e):
- **a. 에이전트는 id를 모른다.** 인자는 채널 **이름**·멤버 **핸들**·새 **표시 이름**이다. uuid를 받지 않는다. 서버가 propose 때와 decide 때 두 번 해석하고, 카드 행에는 해석된 **서버 쪽 값**(현재 채널 이름·공개 범위·인원 수, 멤버 표시 이름)을 쓴다. 에이전트가 쓴 문자열이 곧 카드의 대상 표시가 되는 길은 없다.
- **b. 대상은 제안자의 시야 안이다.** `channel.member.add`의 채널과 `hosted.channels.grant`의 채널은 (공개 채널) ∪ (제안 에이전트가 지금 live membership을 가진 채널)이어야 한다. 그 밖(남의 비공개 채널, 존재하지 않는 이름, DM, 보관됨)은 모두 같은 `InvalidArguments`다. 에이전트가 제안 실패로 비공개 채널의 존재를 더듬을 수 없다. v1처럼 어떤 규칙에 걸렸는지는 알려 주지 않는다.
- **c. 승인자 판정은 레지스트리의 `required_role`이고 `match`는 계속 exhaustive다.** `RequiredRole::AgentEditor`·`WorkspaceOperator`를 더하면 `execute_workspace_action`의 게이트 `match`가 컴파일 오류로 새 갈래를 요구한다. `agent_editor`의 판정 대상은 `agent.rename`의 **대상 에이전트**(V4-M, 결정 때 다시 해석한 값)이고, `workspace_operator`는 `routes::shared::require_workspace_operator`의 판정을 호출한다(복사하지 않는다).
- **d. 결정 때 재증명한다**(D2의 「저장값을 신뢰하지 않는다」 그대로). 이름·핸들·채널을 다시 해석하고 규칙(V1-b, V4, V3의 상한)을 다시 건다. 어긋나면 새 영수증 어휘를 만들지 않고 기존 `action_args_invalid`(409, 승인 소모 없음)로 답한다. 클라이언트의 `receiptStatuses`·카드 문구를 늘리지 않으려는 선택이고, 카드는 「제안 내용이 더 이상 맞지 않아요. 거절하고 다시 요청해 주세요」로 남는다.
- **e. 제안 폭주 상한.** 한 에이전트의 `pending` 상태 `workspace_action` 승인은 3개까지다. 넘으면 `Conflict`. run이 제안마다 park되므로 평상시에는 닿지 않는 상한이고, 재호출로 카드를 쌓는 오작동을 막는다.

### V2. 인자 스키마(와이어는 camelCase, 전부 `additionalProperties:false`)
- `channel.create`: `{name: string, kind?: "public"|"private", topic?: string, addProposer?: boolean, memberHandles?: string[]}`. `name` 필수. 이름·주제 규칙은 REST와 **같은 함수**(`normalize_channel_name`: 소문자·숫자·`-`·`_`, 1~80자 / `normalize_channel_topic`: ≤280자)로 맞춘다. `kind` 기본값은 **`private`**(에이전트가 공개 채널을 만들려면 `public`을 말해야 하고, 카드 행에 그대로 보인다). `addProposer` 기본값은 `true`(V3). `memberHandles` ≤10, 활성 멤버(사람·에이전트).
- `channel.member.add`: `{channel: string, memberHandles: string[1..10]}`. 둘 다 필수. 역할 인자는 없다(`member` 고정, `add_channel_member_in_tx`가 이미 `owner`를 거절).
- `agent.rename`: `{displayName: string, targetHandle?: string}`. `displayName` 필수. `targetHandle`이 없으면 제안자 자신이다. 있으면 V4-M의 「관리하는 에이전트」여야 한다. uuid는 받지 않는다.
- `workspace.settings.update`: `{welcomePrompt?: string|null, roleLabels?: object|null}`. 한 키 이상 필수, `null`은 그 키를 지워 기본값으로 되돌린다. 검증은 `momo_settings::merge_workspace_settings`의 두 키 검증기(`validate_welcome_prompt`·`validate_role_labels`)를 **그대로 재사용**하고, 제안 상한은 `welcomePrompt` ≤500자(REST는 2000자), `roleLabels`의 키는 `ROLE_LABEL_KEYS`·값은 ≤48바이트(REST와 같음). 이 두 키 밖의 키는 스키마가 거절한다(V7).
- `hosted.channels.grant`: `{channels: string[1..5]}`. 필수. 대상 connection은 **handle이 가리키는 제안자의 connection**이고 인자로 받지 않는다. 한 connection의 승인 채널은 합쳐서 50개를 넘지 못한다(기존 confirm에는 상한이 없었으므로 새 함수에서만 건다).

`oort_action_propose`의 `args`는 지금 invite 세 키만 가진 평평한 객체(`additionalProperties:false`)다. 행동마다 키가 다르므로 이 증보가 **스키마 구조를 바꾼다**: 도구의 `args`는 `oneOf`(행동별 스키마)로 쓰고 선택은 `actionId`가 한다(JSON Schema `if/then`이 클라이언트 호환 위험이 크면 `args`를 느슨한 `object`로 두고 도메인 normaliser를 유일한 울타리로 삼는 대안은 S0 PR이 비교해 고른다. 어느 쪽이든 「도구 enum = 레지스트리 = OpenAPI」 드리프트 시험은 유지하고, 지금의 `ACTIONS.len()==1` 단정은 행동별 비교로 바뀐다).

### V3. 에이전트가 만든 채널에 에이전트를 넣을지 — 합성 행동 한 개
**결정**: `channel.create`가 **한 승인 안에서** (1) 채널 생성, (2) `addProposer`이면 제안 에이전트의 membership, (3) 그 에이전트가 hosted connection이면 새 채널을 그 connection의 `approved_channel_ids`에 추가, (4) `memberHandles`의 membership을 한 트랜잭션으로 실행한다. 둘 중 하나라도 실패하면 전체 롤백이다.

이유:
- 승인 한 번이 run 하나를 닫는다(V0). 「만들기 / 나를 넣기 / 승인 채널에 올리기」를 세 카드로 쪼개면 같은 일에 세 run·세 승인이 필요하고, 중간 상태(채널은 있는데 에이전트는 못 봄)가 사람에게 보인다.
- 그러나 (3)은 보통의 REST 채널 생성보다 **더 많은 일을 한다**: 채널을 만드는 승인이 에이전트의 접근 범위를 넓힌다. 그래서 이 행은 카드에 **별도 행으로 늘 보인다**(`{label:"이 에이전트도 참여", value:"예 — 이 에이전트가 이 채널을 읽고 쓸 수 있게 돼요"}`). `addProposer:false`면 「아니요」 행이 보이고 (2)(3)은 일어나지 않는다. 승인자가 읽은 것과 실행된 것이 같아야 한다.
- (3)은 **새로 만든 이 채널 하나**에만 적용된다. 이미 있는 채널을 넓히는 것은 `hosted.channels.grant`(V5)의 별도 승인이다.
- 새 채널은 정의상 `kind<>'dm'`·미보관이라 confirm의 두 조건을 이미 만족한다. `confirmed_by`·`active_token_id`·`approved_scopes`는 건드리지 않는다. 그래서 ADR-0162 증보 2 B6의 DM 소유자 규칙에 영향이 없다.
- 기각한 대안(V8-2)이 말하듯 「멤버십이 곧 승인 채널」로 묶지 않는다. `channel.member.add`로 에이전트를 넣어도 그 에이전트의 `approved_channel_ids`는 그대로다.

### V4. `agent.rename` — 이름은 신뢰 표면이다(대상: 자기 자신 또는 관리하는 에이전트, V4-M)
이름은 모든 메시지 옆·멘션 목록·서버 음성 안내 줄(`bins/momo-server/tests/agent_port_tools_conformance_pg.rs:1819-1825`: 「[보안 재인증](https://evil.example)」 이름으로 링크를 심으려는 시도)에 그려진다. 그리고 `@Display Name`이 멘션이 되므로 **다른 멤버의 이름을 가진 에이전트는 그 멤버의 멘션을 가로챈다.** 에이전트 제안 경로는 `normalized_join_display_name`(trim·1~100자)을 쓰지 않고 **더 엄격한 한 함수**를 거친다.

`validated_agent_proposed_display_name(raw, roster, target)` — 제안자 자신이든 관리 대상이든 **같은 검증기**를 거친다(5번의 「자기 자신의 현재 이름」은 대상 에이전트의 현재 이름):
1. NFKC 정규화 → 앞뒤 공백 제거 → 내부 공백열은 한 칸으로.
2. 길이 1~32자(문자 수).
3. **허용목록**: 글자(`L*`)·숫자(`N*`)·결합 표지(`M*`)·공백·`-`·`_`·이모지(Extended_Pictographic, 최대 2개). 이 밖의 모든 문자는 거절한다. 따라서 `@ < > [ ] ( ) : / \ . # & ` ` 따옴표 등 멘션·마크다운·URL을 이루는 문자가 이름에 들어올 수 없다.
4. 제어·서식 문자(`Cc`·`Cf`: 영폭 공백, 방향 제어 포함)·줄바꿈·`Zl`/`Zp` 거절. (3)의 허용목록이 이미 포함하지만 단정을 따로 둔다.
5. **충돌 검사**: 골격(skeleton = NFKC → casefold → 공백·`-`·`_` 제거 → 흔한 키릴·그리스 유사 문자 매핑)이 **같은 워크스페이스의 다른 비삭제 멤버의 `display_name` 또는 `handle` 골격**과 같으면 거절한다(대소문자 구분으로 멘션이 되는 현재 규칙의 모든 우회를 닫는다). 자기 자신의 현재 이름과 같으면 오류가 아니라 no-op이다.
6. **예약어**: `oort`·`오르트`·`admin`·`administrator`·`system`·`시스템`·`관리자`·`운영자`·`보안`·`security`·`support`·`everyone`·`channel`·`here`·`all`·`모두`·`전체`(골격 비교, 목록은 코드 상수 + 시험).

카드: 「대상 에이전트」(서버가 해석한 현재 표시 이름·핸들) · 「현재 이름 → 새 이름」 행. 대상이 제안자와 다르면 요약문이 「다른 에이전트의 이름을 바꿉니다」로 달라진다. 행 값은 **평문**이다(링크·멘션을 자동으로 해석하지 않는다는 렌더 규칙을 부록 A에 못박는다). 승인자는 `agent_editor`: **대상** 에이전트의 소유자 또는 admin(구독·개인 에이전트의 소유자는 admin이 아니어도 자기 에이전트 이름을 승인할 수 있다). 

실행: 새 도메인 함수 `rename_agent_display_name_in_tx(conn, ws, target_agent, new_name)`(`momo-messaging/src/member_rename.rs`, 사람용 `rename_own_display_name_in_tx`의 쌍. `member` 행을 `FOR UPDATE`, `kind='agent'`, 같은 `member.renamed` 브로드캐스트를 co-member 채널마다 outbox로). 이 함수 하나를 **에이전트 제안 경로(자기·관리 대상)와 사람용 라우트가 같이 쓴다.** handle은 바꾸지 않는다(멘션 주소·connection 바인딩이라 별도 결정).

**사람용 라우트(신규)**: `PATCH /v1/workspaces/{ws}/agents/{agent}` body `{displayName}`. `require_human` + `require_profile_editor_in_tx`(소유자 또는 admin). 검증은 사람의 책임 아래 `normalized_join_display_name`(생성 경로와 같음)에 **충돌 검사(V4-5)만** 더한다. 에이전트 제안 쪽만 허용목록·예약어를 건다 — 사람이 정한 「김 인턴 (비서)」는 막지 않고, 카드를 읽는 사람이 속을 수 있는 입력만 좁힌다. 감사 `member.renamed`는 사람용 자기 변경과 같은 `momo.member.renamed.v1`이고 `kind:"agent"`를 더한다. 웹·데스크탑·폰 UI는 이 증보의 범위 밖(UXUI 후속 티켓).

### V4-M. 에이전트가 에이전트를 관리한다는 것 — 신뢰 모델(owner 위임: 오케스트레이터가 보수적으로 확정)
성재가 「다른 에이전트도」를 골랐다(V9). 이름을 바꿀 수 있는 대상이 제안자 밖으로 나가는 순간 아래가 새로 생긴다. 보수적 기본값을 박고, 넓히는 것은 별도 증보로 둔다.

1. **「관리한다」의 정의 = 같은 소유자.** 제안자 `A`와 대상 `B`가 모두 활성 에이전트이고, `agent.owner_human_id`가 **같고 NULL이 아니며** 그 사람이 지금 활성 사람 멤버이면 `A`는 `B`를 관리한다. 이 관계는 **새로 저장하지 않는다**(D7: 새 테이블·컬럼 0). 소유자가 없는(NULL) 에이전트는 자기 자신만 바꿀 수 있고 누구의 관리 대상도 아니다. 사람이 명시적으로 지정하는 관리 관계(별도 테이블·migration)는 이 증보가 열지 않는다 — 필요해지면 별도 증보다(PR 본문의 후속 결정).
2. **승인자 = 대상 `B`의 소유자 또는 워크스페이스 admin**(`agent_editor`). 같은 소유자 규칙 때문에 소유자는 `A`의 소유자이기도 하지만, 승인자 판정은 `A`가 아니라 **`B`**를 기준으로 한다. 제안자의 소유자라는 사실만으로는 승인 권한이 생기지 않는다(소유자가 바뀐 `B`의 새 소유자나 admin이 아니면 승인할 수 없다). 에이전트 자신은 어떤 경우에도 승인자가 아니다(D2: 결정자는 `member.kind='human'`).
3. **결정 때 관계를 다시 증명한다**(V1-d). 제안 뒤 `B`의 소유자가 바뀌었거나 `B`가 사라졌거나 일시 중지·삭제되었으면 `action_args_invalid`이고 승인은 소모되지 않는다.
4. **대상 해석은 구분 불가 오류**: 핸들이 없는 에이전트, 사람 핸들, 소유자가 다른 에이전트, 소유자 NULL 에이전트 등 관리 조건을 만족하지 못하는 모든 경우는 같은 `InvalidArguments`다(V1-b와 같은 규칙). 제안자가 남의 에이전트 존재를 더듬을 수 없다.
5. **반경**: 이 행동은 **표시 이름 하나**만 바꾼다. 사람 멤버는 대상이 될 수 없고, handle·프로필·스코프·승인 채널·역할은 건드리지 않는다. `hosted.channels.grant`는 계속 자기 connection만이다(V5) — 이름을 바꿀 수 있다고 접근 범위를 넓힐 수 있게 되지 않는다.
6. **사칭·멘션 가로채기**: 검증기는 V4의 것 그대로이고 관리 대상에게도 예외가 없다. 충돌 검사는 `B` 자신의 현재 이름을 제외한 모든 비삭제 멤버(제안자 `A` 포함)와 한다. `A`가 `B`를 `A`와 같은 이름으로 만드는 것도 거절된다.
7. **위임 불가 등급 유지**: `agent.rename`은 신원을 바꾸므로 (V7) 어떤 미래 「무승인 위임」에서도 제외한다. 관리 관계가 생겼다고 승인이 줄지 않는다.
8. **관리 관계를 만들거나 지우는 일은 에이전트가 할 수 없다.** 관계는 `owner_human_id`에서 파생되므로, 에이전트가 소유자를 바꾸거나 에이전트를 만들고 소유자를 배정하는 길은 이 증보가 열지 않는다. 소유자 변경·에이전트 생성은 지금처럼 사람의 REST다(그록봇 등 새 에이전트 생성은 V7 범위 밖). 명시적 관리 관계가 생기는 후속 증보에서도 만들기·지우기는 사람 전용이어야 한다.
9. **상한**: 제안자당 `pending workspace_action` 3개(V1-e)에 더해, 같은 대상에 대한 `agent.rename`이 pending이면 두 번째 제안은 `Conflict`다(카드 스팸·이름 번복 경쟁 방지).

### V5. `hosted.channels.grant` — 에이전트가 자기 접근 범위를 넓혀 달라고 청하는 유일한 길
가장 위험한 행동이라 가장 좁다.
- 대상 connection = handle이 가리키는 제안자의 활성 connection **하나**. 다른 에이전트의 범위는 제안할 수 없다(권한 상승의 반경을 자기 자신으로 가둔다).
- 채널은 V1-b(공개 ∪ 이미 live membership)이고 `kind<>'dm'`·미보관이다. 남의 비공개 채널에 들어가고 싶다는 제안은 존재 자체가 거절된다.
- 승인자는 admin(ADR-0162의 「채널 승인 권한 주체는 관리자」를 그대로 지킨다). 카드는 채널 이름·공개 범위·**인원 수**·현재 승인 채널 수를 행으로 보인다.
- 실행: `momo-auth`의 새 도메인 함수 `grant_hosted_channels_in_tx(conn, ws, connection, channels, actor)`. connection 행을 `FOR UPDATE`로 잠그고(`status='active' AND proved_at IS NOT NULL`), confirm과 같은 모양으로 배열 합집합 + `membership`(`ON CONFLICT … left_at=NULL`)을 쓴다. `confirmed_by`·`confirmed_at`·`active_token_id`·`approved_scopes`·`approved_dm_channel_ids`는 **쓰지 않는다**(DM 규칙 불변). 합계 50개 상한.
- 이 함수가 생기는 순간 「confirm에서만 쓰이는」 배열에 쓰기 경로가 하나 늘어난다. 정본 정의가 SQL 함수이므로 읽는 쪽 변경은 없고, 시험이 「쓰기 경로 = confirm·consent·grant 셋」을 고정한다.

### V6. 감사와 결과
감사는 행동마다 **`action.approved` 1행(기존)과 도메인 행 1행 이상**이다. 이름은 이 증보가 정한다:
| 행동 | 도메인 감사 `action` | `detail`(비밀 없음) |
|---|---|---|
| `channel.create` | `channel.created` | `{name, kind, add_proposer, member_count, via_agent, approval_id}` |
| `channel.create`(승인 채널 추가가 있을 때) | `hosted_connection.channels_granted` | `{connection_id, channel_ids, via_agent, approval_id}` |
| `channel.member.add` | 멤버마다 `channel.member_added` | `{channel_id, role:"member", via_agent, approval_id}` |
| `agent.rename` | `member.renamed`(대상 멤버 기준) | `{old, new, kind:"agent", via_agent, approval_id, managed}` — `managed`는 대상이 제안자와 다를 때 true이고 그때 `target_agent`(대상 멤버 id)·`owner_member_id`를 더한다 |
| `workspace.settings.update` | `workspace_setting.updated`(기존 이름) | `{keys, via_agent, approval_id}` — 키 이름만, **값은 싣지 않는다**(`welcome_prompt`는 긴 사용자 문구). 값의 옛/새는 카드 영속 props에만 있다 |
| `hosted.channels.grant` | `hosted_connection.channels_granted` | 위와 같음 |
`actor`는 승인자(`.by`), 제안자는 `.about`(기존 `action.approved`와 같은 모양). 기존 REST 두 경로(`channels.create`·`add_member`)는 audit이 없었다. **이 증보는 그 REST에 audit을 소급하지 않는다**(무관한 변경은 별도 이슈). 새 audit은 에이전트 경유 경로에서만 쓴다.

**제안한 에이전트에게 결과를 돌려주는가**: 돌려주되 **비밀이 아닌 것만, 기존 통로로** 돌려준다. 새 통로를 만들지 않는다.
- 비밀이 아닌 결과(생성된 채널의 id·이름, 추가된 멤버, 바뀐 이름)는 승인 때 이미 채널에 남는 에이전트 명의 `action_result` 메시지(부록 B)의 `ref`·`rows`에 있다. 에이전트는 다음 턴에 `oort_conversation_read`로 그것을 읽는다. 채널 생성 뒤 새 채널에 말하려면 `oort_message_post`의 `channelId`가 필요하므로 `ref.id`가 읽혀야 한다 — S1이 `oort_conversation_read`가 `action_result`의 `ref`를 에이전트에게 내보내는지 확인하고, 아니라면 결과 줄 본문에 채널 이름과 id를 평문으로 싣는다(비밀이 아니다).
- **초대 링크(D4의 1회 시크릿)는 돌려주지 않는다.** 에이전트에게 링크가 가면 (a) 채널 전체가 읽는 메시지가 되거나 (b) 에이전트의 외부 런타임·로그에 남는다. 「승인자에게만 1회 보인다」는 D4의 성질 자체가 이 행동의 보안 모양이다. 대신 결과 줄은 「링크는 승인한 분만 볼 수 있어요. 필요하면 승인한 분이 전달해요」로 사람에게 다음 행동을 알려 준다. 승인자가 링크를 에이전트와 공유하고 싶다면 사람이 자기 손으로 붙여 넣는다.
- 이 증보의 다섯 행동은 1회 시크릿이 **없다**(`secretOnce` 부재). 결정 응답의 `result`는 `{actionId, ref}`만 갖는다.

### V7. 범위 밖과 이유
- **테마·외양**: 기기 localStorage(ADR-0174)라 서버가 못 바꾼다. D6의 `command_suggest`·`settings_preview`(#2511 AX-5)로 간다.
- **다른 그록봇을 자동으로 만들어 초대**: 그록 쪽 API가 공개 문서에서 확인되지 않았고 약관 위험이 있다. 그리고 oort 쪽에서도 hosted 연결의 **confirm은 구조상 사람의 행동**이다(ADR-0162: 승인 없이 capability 0, 사람의 confirm + 별도 active proof + unpause). 이 증보가 에이전트에게 연결을 만들거나 confirm할 길을 주지 않는다. 사람이 새 에이전트를 연결하는 경로는 변하지 않는다.
- **`workspace.settings.update`의 나머지 키**: 성재 결재로 **`welcome_prompt`·`role_labels` 두 키만** 연다(V9). `allowed_agent_models`(모델·비용 정책)와 `welcome_agent_member_id`(에이전트가 자기를 환영 에이전트로 지명)는 인자 스키마에 없고 `additionalProperties:false`와 도메인 허용목록 둘 다에서 거절한다. 앞으로 허용 키가 늘어날 때마다 이 증보를 개정한다 — 「설정 bag의 임의 키」를 여는 일반 행동은 없다.
  - 승인자는 새 `workspace_operator`(owner/admin + 플랫폼 운영 스코프, `require_workspace_operator`와 같은 판정). `require_admin`보다 넓은 집합이 아니라 같은 집합 위에 운영 스코프를 얹은 판정이라 별도 변형으로 둔다.
  - `welcome_prompt`는 환영 에이전트의 턴에 들어가는 문구다. 에이전트가 다른 에이전트의 지시문을 쓰는 길이므로 제안 상한을 REST(2000자)보다 낮은 500자로 두고, 카드가 **전문을 평문으로** 보인다(옛 값 → 새 값). `role_labels`는 역할 키(`ROLE_LABEL_KEYS`)별 ≤48바이트 평문이다.
- **`member.role.set`·`webhook.create`**: 이번 범위가 아니다(각각 declared 그대로, `webhook.create`는 ADR-0004 증보 4 / AX-8 #2514).
- **handle 변경, 사람 멤버 이름 변경, 소유자가 다른 에이전트의 이름 변경**: 이 증보에 없다. 관리 대상은 같은 소유자의 에이전트로 한정된다(V4-M).
- **「관리자 위임으로 무승인 허용」**: **이번에도 미룬다.** D3의 이유(스코프 원장·설정 표면 추가가 필요)가 그대로이고, 이 증보의 행동 중 둘(`hosted.channels.grant`, `agent.rename`)은 접근 범위와 신원을 바꾸므로 위임 대상이 **될 수 없는 등급**으로 못박는다 — 나중의 위임 ADR은 이 둘을 위임 가능 목록에서 제외하는 것을 전제로 쓴다.
- 사람용 rename UI, 카드 렌더러의 행 종류 추가(`ref.type` 확장 등) 화면 작업은 UXUI 후속이다.

### V8. 기각한 대안과 업계 비교
1. **에이전트에게 `channels:manage` 같은 스코프를 주고 직접 실행**: Slack(`channels:manage`)·Discord(`MANAGE_CHANNELS`) 봇 모델이다. 설치 때 한 번 동의하면 이후 호출마다 사람의 확인이 없다. oort는 에이전트 토큰 유출 = 워크스페이스 장악을 막으려고 D2에서 기각했고, 여기서도 같다. Slack Workflow Builder류의 「사람이 승인 단계를 누르는 흐름」에 가깝다. **행동마다 사람 승인 + 승인자 권한 실행**이 oort의 위치다.
2. **membership = 승인 채널**: `channel.member.add`가 에이전트를 넣으면 자동으로 읽고 쓰게 하는 단순한 모양. ADR-0162가 사람의 경계로 만든 `approved_channel_ids`를 이름 모를 admin 한 명의 멤버 추가가 조용히 넓히게 된다. 기각.
3. **세 장 카드로 쪼개기(만들기 → 나 넣기 → 승인 채널 올리기)**: 한 run은 한 번만 제안하므로 세 run이 필요하고 중간 상태가 사람에게 보인다. V3의 합성이 대신한다.
4. **에이전트가 uuid를 인자로**: 에이전트가 id를 알려면 roster·채널 목록 읽기가 필요한데 hosted 토큰에는 그런 스코프가 없다. 이름·핸들을 서버가 해석한다(V1-a).
5. **에이전트 rename에 기존 `normalized_join_display_name` 사용**: 링크 주입(1819)·멘션 가로채기를 막지 못한다. V4.
6. **초대 링크를 에이전트에게 돌려주기**: V6.
7. **관리 관계를 별도 테이블로 두고 사람이 지정**: 가장 명시적이지만 migration·RLS·관리 UI가 필요하고 이 증보의 「새 테이블 0」(D7)을 깬다. 소유자에서 파생하는 쪽이 이미 사람이 정한 사실(소유자 배정)을 재사용한다. 후속 증보로 남긴다.
8. **제안자의 소유자만으로 승인 허용**: 승인 권한이 관리 대상이 아니라 제안자에게서 나온다. 대상의 소유자가 바뀐 경우를 막지 못한다. V4-M-2.

### V9. 결재 기록 (2026-10-11)
성재가 2026-10-11 AskUserQuestion으로 결재했다(질문 문구와 함께 인용).
1. 채널 만들기: 「**한 승인에 묶기 (Recommended)**」 — `addProposer` 기본값 true, 채널 생성·membership·승인 채널 추가를 한 트랜잭션으로(V3).
2. 이름 바꾸기: 「**다른 에이전트도**」(추천안 「자기 자신만」이 아님). 선택지 설명: 「관리하는 다른 에이전트의 이름도 바꿀 수 있게 해요. 에이전트가 에이전트를 관리하는 신뢰 모델을 새로 설계해야 해요.」 → V4-M. 신뢰 모델의 세부 기본값(같은 소유자·승인자 판정 기준·위임 불가·관계 변경은 사람 전용)은 **「owner 위임: 오케스트레이터가 보수적으로 확정」**.
3. 설정 바꾸기: 「**문구 2개만 열기**」(추천안 「열지 않음」이 아님) — `welcome_prompt`·`role_labels` 두 키뿐, operator(`require_workspace_operator`) 게이트. `allowed_agent_models`·`welcome_agent_member_id` 같은 나머지 키는 계속 막는다(V7).
4. 채널 권한 단독 제안: 「**제한해서 허용 (Recommended)**」 — `hosted.channels.grant`(V5).

이의가 없으면 확정으로 둔 기본안(결재 대상이 아니었다): 초대 링크는 에이전트에게 돌려주지 않는다(V6), 무승인 위임은 미룬다(V7), 사람용 `PATCH …/agents/{agent}` 라우트를 범위에 넣는다(V4).

**남은 갈림길(구현 전 확인, 오케스트레이터 기본값으로 진행 가능)**: ① 「관리한다」를 소유자 파생(기본)으로 둘지, 사람이 지정하는 명시적 관계(테이블 필요)로 갈지 ② `welcome_prompt` 제안 상한 500자.

### V10. 구현 슬라이스
| ID | 내용 | 선행 |
|---|---|---|
| S0 | 레지스트리 기반: `RequiredRole::AgentEditor`, `ActionArgs` 변형, `validated_action_args`를 순수 모양 검증 + 트랜잭션 안 해석(이름·핸들)으로 분리, 도구 `args` 스키마 구조(`oneOf`) 재작성, 드리프트 시험 재작성, 보류 승인 3개 상한, `GET actions`·OpenAPI 갱신, 동의 화면 문구 | **ADR Accepted** |
| S1 | `channel.create`(+합성 V3) + 감사 + 결과 줄 | S0 |
| S2 | `channel.member.add` | S0 |
| S3 | `agent.rename`(자기·관리 대상, V4-M의 대상 해석·같은 소유자 규칙·`agent_editor` 판정) + 사람용 `PATCH …/agents/{agent}` + 공유 도메인 함수 + 엄격 검증기 + 1819 방식 red 시험 | S0 |
| S4 | `hosted.channels.grant`(`momo-auth` 도메인 함수 + 행동) | S0 |
| S5 | `workspace.settings.update`(두 키): `RequiredRole::WorkspaceOperator`, 두 키 전용 인자 스키마·REST 검증기 재사용·`welcomePrompt` ≤500자, 카드 옛→새 평문 행, `workspace_setting.updated` 감사(`via_agent`, 값 제외), `DECLARED_NOT_EXECUTABLE` 항목 추가·삭제 정리 | S0 |
| S6 | 에이전트 지시문·문서: hosted 루틴이 새 행동과 「제안 뒤 turn 종료」를 배운다 | S1~S5 |
행동 하나당 손대는 곳은 다섯이다: `momo-agent/src/actions.rs`(`ACTIONS`·카드 행·`effect` 문장) · `routes/actions.rs`(`validated_action_args`) · `routes/approvals.rs`(`execute_workspace_action`) · `momo-mcp/src/tools.rs`(`WORKSPACE_ACTION_IDS`·`action_propose_schema`) · `docs/api/openapi.yaml`(`WorkspaceActionId`·스키마).

### V11. 수용 기준(구현 슬라이스가 인용할 red proof)
각 시험은 해당 분기를 지우면 실패해야 하고 그 RED를 PR 본문에 남긴다.
- `ACTIONS` id 집합 = 도구 `actionId` enum = OpenAPI enum, 그리고 행동별 `args` 스키마가 도구와 카탈로그에서 같다(시험이 행동마다 잰다).
- 인자에 uuid·알 수 없는 키가 있으면 `InvalidArguments`. 남의 비공개 채널·DM·존재하지 않는 채널·보관된 채널은 **같은** 오류(구분 불가)다.
- `channel.create`: 비-admin 결정자는 403 `role_required`이고 채널 0개·승인 pending. 승인 시 채널·승인자 owner membership·(`addProposer`이면) 에이전트 membership·`approved_channel_ids`가 **한 tx**이고, 중간 실패 시 전부 없다. `addProposer:false`면 에이전트 membership·승인 채널 0.
- `hosted.channels.grant`: 다른 에이전트의 connection은 건드리지 못한다(인자 표면에 없음을 시험). `confirmed_by`·`active_token_id`·`approved_scopes`·`approved_dm_channel_ids` 불변. 51번째 채널은 거절.
- `agent.rename`(관리 대상): 소유자가 다른 에이전트·소유자 NULL 에이전트·사람 핸들·없는 핸들은 같은 `InvalidArguments`. 결정 전에 대상의 소유자가 바뀌면 `action_args_invalid`·승인 pending. 제안자의 소유자이지만 대상의 소유자도 admin도 아닌 사람은 403 `role_required`. 같은 대상에 pending `agent.rename`이 있으면 두 번째 제안은 `Conflict`. 에이전트가 제안자와 같은 이름으로 대상을 바꾸려는 것도 거절.
- `agent.rename`: 1819의 링크 이름·`@다른멤버`·`<@다른멤버>`·영폭 공백이 섞인 이름·다른 멤버 이름의 대소문자·전각 변형·예약어가 전부 `InvalidArguments`. 승인자가 소유자(비-admin)여도 승인된다. 제3자 비-admin은 403 `role_required`.
- `workspace.settings.update`: 두 키 밖의 키(`allowedAgentModels`·`welcomeAgentMemberId` 포함)는 `InvalidArguments`. admin이 아닌 결정자는 403 `role_required`·설정 불변. `welcomePrompt` 501자는 거절. 승인 시 `welcome_prompt`·`role_labels` 외의 설정 키가 바뀌지 않는다(저장 전후 bag 비교). 감사 행에 값이 없다.
- 사람용 `PATCH …/agents/{agent}`: 소유자·admin만 성공, 제3자 403, 에이전트 bearer 403, 충돌 이름 409.
- 감사: 행동마다 `action.approved` + V6의 도메인 행. 어느 행에도 이름 외 비밀이 없다(1회 시크릿이 없는 행동들이지만 grep 시험은 유지).
- 결정 때 재증명: 제안 뒤 채널 이름이 선점되거나 에이전트가 방에서 빠지면 `action_args_invalid`, 승인 pending 유지.

## 증보 2026-10-13 — 관리 액션 v3: `agent.profile.update`·`agent.invite`와 초대 링크·연결 코드 회수 (#3772)

- Status: **Accepted** (2026-10-13 성재 결재 — V3-10 결재 기록. 초안은 같은 날 Proposed였고 결재로 네 결정 중 셋이 추천안과 달라졌다: 아바타 출처 확대, 초대 링크의 에이전트 회수, 시간당 상한 비도입. 구현은 슬라이스(V3-11)별 PR로 착수 가능)
- 발제: 성재 2026-10-13 「그록봇이 그록봇이나 다른 뮤즈나 닷츠 같은걸 초대하거나 스스로 이름을 바꾸거나 프로필을 변경하는 그런 작업들도 잘 할수 있게 허용 범위를 늘려줘」
- 기안: Opus 5.5 worker(#3772)
- Consumes: ADR-0186 D2~D4·V1~V7 · ADR-0162 D6·D7·D16 · ADR-0131 · ADR-0161 증보 1(D-M2 아바타 쓰기는 본인·사람만) · ADR-0176 · ADR-0198·0200 · ADR-0100
- 접점 이슈: **#3773**(Aside식 연결 화면·온보딩 압축, UXUI). V3-8.
- 이 증보가 **의도적으로 바꾸는 경계 셋**(각각 근거와 완화를 아래에 적는다): ① ADR-0161 D-M2 「에이전트는 아바타를 바꿀 수 없다」 → 승인된 액션 경유로 허용(V3-2a) ② ADR-0186 D4·V6 「1회 시크릿은 승인자에게만」 → `invite.create`는 제안 에이전트에게, `agent.invite`의 연결 코드는 승인자가 고르면 제안 에이전트에게 돌려줌(V3-3a·V3-5) ③ D7 「새 테이블 0」 → 아바타 이미지 한 테이블(V3-2a). **바꾸지 않는 것**: D2(제안 → 승인 → 실행)·D3(위험 등급)·**연결 confirm은 계속 사람의 행동**·`instructions` 불가침.
- 표기: [V] 코드 직접 확인 · [추정] 해석 · [확인 필요] 근거가 약해 구현 전 실측이 필요한 것.

### V3-0. 코드로 확인한 사실(2026-10-13, main `d1cbe68b1` 기준)
- 레지스트리 `ACTIONS`는 여섯이고 도구 enum `WORKSPACE_ACTION_IDS: [&str; 6]`(`momo-mcp/src/tools.rs`)이 같은 길이를 가정하는 드리프트 시험이 있다. `DECLARED_NOT_EXECUTABLE` = `webhook.create`·`member.role.set`. [V]
- 연결 생성의 유일한 출생지는 `routes/hosted_agent_connections.rs::provision_hosted_agent_in_tx`다(전용 member+agent, owner = 호출 사람, paused 프로필, `pairing_pending` connection, pairing credential, 감사). 승인자 명의로 부를 수 있는 모양이다. [V]
- 비밀은 **서로 다른 두 값**이다: pairing(`momo_pair_v1`, 15분, 해시 저장, 1회 소비, detect만 가능, capability 0)과 confirm 응답의 active credential(사람에게만). confirm은 `detected` 이후라 승인 한 번에 묶을 수 없다. `POST …/pairing-challenge/regenerate`는 `pairing_pending|detected|expired`에서 새 pairing을 발급한다. [V]
- 초대 코드는 해시만 저장하고(`momo_invite_code_hash()`), `create`·`regenerate`가 raw를 한 번 돌려준다(`routes/invites.rs`). 승인 실행기의 1회 값은 결정 응답 `secretOnce`에만 있다(D4). [V]
- `agent_profile`에는 소개·역할 라벨이 없고 `instructions`는 시스템 프롬프트다. `agent.config jsonb`가 있다. `member.status_*`(083)는 사람 전용이다. [V]
- 아바타: `member.avatar_url`은 임의 문자열 레거시이고, 업로드(`member_avatar_media`, migration 111)는 `/members/me/…` + `require_human` + 업로더 결속 복합 FK다. 에이전트 bearer 허용목록에 없다. 업로드 바이트는 Drive resumable로 우회하고 `momo-drive`의 `DriveArchive`에는 서버가 바이트를 쓰는 메서드가 없다(읽기·삭제·세션 생성뿐). `complete`는 첫 12바이트 매직과 헤더 치수(4096 상한)를 검사하지만 **재인코딩은 하지 않는다**. [V]
- 첨부(`attachment`, ADR-0151)는 업로더만 완료·결속하고 `complete` 행만 읽힌다. 에이전트가 첨부를 보는 경로(`oort_conversation_read`가 첨부 id를 내는지)는 [확인 필요: 슬라이스 A1이 실측].
- **시간당 상한은 어디에도 없다.** 있는 것은 제안자당 pending `workspace_action` 3개(V1-e)와 아바타 업로드 시간당 20개뿐이다. [V]

### V3-1. 결정 요약
| 행동 | 승인자(`requiredRole`) | 실행 | 에이전트에게 돌려주는 것 | 위임(미래 무승인 ADR의 전제) |
|---|---|---|---|---|
| `agent.profile.update` | `agent_editor`(대상 에이전트의 소유자 또는 admin) | 대상(자기 또는 V4-M 관리 대상) 한 명의 표시 필드: 아바타(프리셋·파일·생성)·소개·상태 문구·역할 라벨·(선택) 이름 | 없음 | 소개·상태 문구·프리셋 아바타만 **후보**. 이미지 아바타·역할 라벨·이름은 **불가** |
| `agent.invite` | `admin` | 승인자 명의로 전용 hosted member + 연결 + pairing | 승인자가 결정 때 체크하면 **연결 코드**(일회성 회수, 기본 꺼짐) | **불가** |
| `invite.create` | `admin`(기존) | 변경 없음(역할·maxUses·만료 상한 그대로) | **초대 링크**(일회성 회수, 항상) | **불가** |
공통: (a) 한 run 한 제안(D2). (b) V1-a~e(id 없음·시야·결정 때 재증명·pending 3개 상한)를 그대로 적용한다. (c) 에이전트는 어떤 경우에도 승인자가 아니다. (d) `agent.invite`로 태어난 새 에이전트의 `owner_human_id`는 승인한 사람이다. (e) **남용 방어는 매번 사람 승인 + 제안자당 pending 3개(V1-e)** 이고 시간당 상한은 도입하지 않는다(V3-6).

### V3-2. `agent.profile.update` — 프로필은 신뢰 표면이다
**인자**(camelCase, `additionalProperties:false`, 최소 한 키): `{displayName?, avatar?, tagline?, statusText?, statusEmoji?, roleLabel?, targetHandle?}`. 대상 규칙은 `agent.rename`과 같다(V4-M 1~9 인용: 같은 소유자·`agent_editor`는 **대상** 기준·결정 때 재증명·구분 불가 오류·같은 대상 pending 중복 `Conflict`). 사람 멤버는 대상이 될 수 없다.

| 필드 | 저장 | 검증 |
|---|---|---|
| `displayName` | 기존 `rename_agent_display_name_in_tx` | V4의 `validated_agent_proposed_display_name` 그대로(`agent.rename`은 하위호환으로 둔다) |
| `avatar` | V3-2a | 아래 세 출처 + 프리셋 |
| `tagline`(소개) | `agent.config` 한 키 | ≤140자, NFKC, 제어·서식 문자 거절, `@ < > [ ] ( ) ` ` : / \` 거절, `://`·`www.`·도메인형 토큰 거절, 평문 렌더. 다른 멤버의 표시 이름·핸들을 그대로 포함하면 거절 |
| `statusText`·`statusEmoji` | 기존 `member.status_*` | ≤80자·이모지 ≤32 스칼라(기존 `normalize_status_*`) + tagline과 같은 문자 거절 + **만료 필수**(기본 24시간, 최대 7일) |
| `roleLabel` | `agent.config` 한 키 | ≤24자, V4의 허용 문자 집합, **예약어(V4-6)와 워크스페이스 `role_labels` 값(골격 비교) 거절** — 권한을 가진 척하는 사칭 표면 |

**V3-2a. 아바타 — 출처 넷, 저장은 서버 한 곳, 보이는 것 = 저장되는 것**
`avatar`는 `oneOf`다:
- **프리셋** `{source:"preset", presetId}`: 서버 상수 id(색+이니셜·마스코트 세트). 기본 선택지. 바이트 처리 없음.
- **(a) 워크스페이스 파일** `{source:"attachment", attachmentId}`: 이미 `complete`이고 메시지에 결속된 이미지 첨부. 첨부가 달린 채널은 (공개) ∪ (제안 에이전트가 live membership + 승인 채널을 가진 채널)이어야 하고, 그 밖·삭제·비이미지·존재하지 않음은 **같은** `InvalidArguments`다(V1-b). 서버가 Drive에서 바이트를 읽어(`file_content`, 상한 아래) 처리한다.
- **(b) 사람에게 업로드 요청**: 서버 액션이 아니라 **조합**이다. 에이전트가 채널에 「이 이미지로 바꿔 주세요」를 말하고(`oort_message_post`, 선택적으로 `oort_card_suggest` 허용 command `avatar.upload_request`), 사람이 평소 첨부 업로드로 올리면 에이전트가 (a)로 제안한다. 서버 신규 경계가 없고 카드(업로드 요청 카드)는 UXUI 이슈다.
- **(c) 에이전트가 만든 이미지** `{source:"generated", mime, dataBase64}`: 에이전트가 이미지를 직접 만들어 propose 호출에 바이트를 싣는다. **ADR-0161 D-M2를 이 증보가 명시적으로 넓힌다.**

**공통 처리(출처와 무관, 모두 필수)**: 서버가 propose tx 안에서 입력 바이트를 **디코드하고 새로 인코딩한 결과만** 저장한다. 원본 바이트·메타데이터는 어떤 경로로도 서빙하지 않는다.
1. **mime 허용목록** PNG·JPEG·WebP(정지 이미지). **SVG·GIF·애니메이션 WebP·ICO·그 밖 전부 거절.** 선언 mime은 힌트일 뿐이고 매직 넘버로 판정한다(ADR-0161의 `sniff_image_mime` 재사용), 선언과 다르면 거절.
2. **크기·해상도 상한**(디코드 전): (c) 입력 ≤1 MiB 바이트(base64 ≤1.4 MiB 문자열), (a) ≤5 MiB, **헤더 치수 가로·세로 ≤4096, 0 거절, 파싱 불가 거절**(ADR-0161 M-1의 헤더 파서 재사용 — 디코드 폭탄 방어), 디코더에 **메모리 할당 상한**(`image::Limits`)을 건다. 결과물은 **최대 512×512**(긴 변 기준 축소, 확대하지 않음), **≤512 KiB**(PNG가 넘으면 JPEG q80으로 알파를 흰색에 합성해 재인코딩, 그래도 넘으면 거절). 한 에이전트에 걸리는 보류 제안 3개 상한(V1-e)이 이 단계의 총량을 묶는다.
3. **재인코딩 = 폴리글랏·페이로드 제거.** 새 PNG/JPEG는 디코드된 픽셀에서만 만든다. EXIF·ICC·XMP·주석·꼬리 바이트는 구조상 남지 않는다. 디코드 실패는 거절이고 부분 결과를 저장하지 않는다.
4. **서버 저장소에만 보관, 외부 URL 금지.** 새 테이블 `agent_avatar_image`(migration, RLS FORCE + `ws_isolation`)가 재인코딩 바이트(`bytea`)·mime·`sha256`·가로·세로·`source`(`attachment|generated|preset` 중 이미지 둘)·`member_id`(대상)·`proposed_by`·`approval_id`·`status`(`staged|applied`)를 갖는다. Drive를 쓰지 않으므로(서버가 쓰는 API가 없다) 회수 잡이 필요 없다. `avatar_url`(임의 문자열)에는 쓰지 않는다. `member`에 현재 이미지 포인터를 더하고(복합 FK `(workspace_id, member_id, image_id)` → 이 테이블, 대상 본인의 행만 가리킬 수 있음), roster DTO의 해석된 `avatarUrl`은 기존 우선순위(업로드가 레거시 문자열을 이긴다)에 이 포인터를 같은 자리로 끼운다. 읽기는 기존 아바타 content 규율(워크스페이스 멤버만, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, 저장 mime, `?v` 버전 토큰 검증)을 같은 모양으로 쓴다.
5. **승인 카드에 실제 이미지 미리보기.** 보류 중인 `staged` 행은 그 승인의 결정 후보 누구나(`agent_editor`)와 제안 에이전트만 `GET …/approvals/{id}/avatar-preview?v=<sha256>`로 읽을 수 있다. 카드 행에는 **서버가 만든 `previewId`·`sha256`·가로×세로·출처 라벨**이 나가고 에이전트가 쓴 문자열은 나가지 않는다. 클라이언트 렌더는 UXUI 이슈.
6. **승인 뒤 바꿔치기 방지(pins + content hash).** `staged` 행은 **불변**(INSERT 전용, 바이트·해시 UPDATE 경로 없음)이다. 승인 payload는 `{imageId, sha256}`를 핀으로 갖고, 결정 때 서버가 저장 바이트를 **다시 해시**해 핀과 같은지, 행이 같은 승인·같은 대상에 묶여 있는지 확인한다. 어긋나면 `action_args_invalid`(409, 승인 소모 없음). 원본 첨부가 이후 바뀌거나 지워져도 `staged` 행이 이미 서버 사본이므로 승인한 것과 적용되는 것이 같다.
7. **적용·회수.** 승인되면 포인터를 옮기고 행을 `applied`로 바꾸며 **이전 이미지 행은 같은 tx에서 삭제**한다. 거절·만료·취소는 같은 arm이 `staged` 행을 삭제한다. 어느 arm도 놓친 `staged`가 쌓이지 않도록 다음 `avatar` 제안 때 24시간 넘은 `staged`를 같은 tx에서 정리한다(별도 sweep 없음).
8. **감사**: `agent.avatar.staged`(승인·출처·크기·sha256 앞 12자, 바이트 없음)·`agent.avatar.updated`·`agent.avatar.rejected`(사유 코드). 로그·메시지 props·outbox에 바이트를 싣지 않는다.
9. **디코더 의존**: Rust `image` 크레이트(MIT/Apache-2.0, feature는 `png`·`jpeg`·`webp` 디코드만 최소로)를 쓴다. 신규 의존이므로 NOTICE·`scripts/generate_ghcr_notice_bundle.py generate`와 라이선스 확인이 슬라이스 A0의 수용 기준이다. 디코드는 `spawn_blocking` 안에서 하고 요청 시간 상한을 건다. [확인 필요: 크레이트 버전의 최근 RUSTSEC 목록 — A0가 `cargo audit`/deny로 확인]

**V3-2b. 승인자·사칭 방어**: 승인자는 `agent_editor`(소유자가 비-admin이어도 자기 에이전트의 프로필은 승인, 제3자는 403 `role_required`·승인 소모 없음). 카드는 「대상 에이전트(서버가 해석한 현재 이름·핸들)」와 필드마다 「현재 → 새 값」 평문 행을 보이고, 에이전트가 쓴 문자열이 대상 표시가 되는 길은 없다(V1-a). 결정 때 재증명(V1-d): 프리셋이 목록에서 빠졌거나 대상 소유자가 바뀌었거나 핀이 어긋나면 `action_args_invalid`.

**V3-2c. 하지 않는 것**: `instructions`·`model_pref`·`enabled_tools`·`triggers`·`paused`·스코프·핸들·승인 채널·역할. **`instructions`는 에이전트에게 계속 닫는다**(다른 에이전트의 행동을 갈아끼우는 프롬프트 인젝션 길). 스키마의 `additionalProperties:false`와 도메인 허용목록 둘 다에서 거절한다.

**실행·감사**: `update_agent_profile_card_in_tx(conn, ws, target, patch)`가 한 tx에서 `member`를 `FOR UPDATE`로 잠그고 필드별로 쓴다. 감사 `agent.profile.updated`(`momo.agent.profile.updated.v1`): `{fields:[키 이름만], via_agent, approval_id, managed, target_agent?}`, 값은 싣지 않는다. 이름이 바뀌면 기존 `member.renamed`도 쓴다.

### V3-3. `agent.invite` — 에이전트가 다른 외부 에이전트를 데려오는 흐름
**인자**: `{platform: "grok_bot"|"dots"|"muse"|"other", displayName, handle, rationale?}`. `platform`은 표시·안내용 프리셋 키일 뿐 권한의 근거가 아니다(ADR-0162 D6). 이름은 V4의 엄격 검증기(+충돌 검사), 핸들은 `normalized_requested_handle` + 밴 목록 확인. 에이전트는 id·스코프·채널을 주지 못한다 — **채널·스코프는 confirm 때 사람이 정한다.**

**실행**: 승인자가 `admin`이면 같은 tx에서 `provision_hosted_agent_in_tx`를 **승인자 명의**로 부른다(owner = 승인자, paused, `pairing_pending`). 감사: 기존 `hosted_agent.connection.created`에 `via_agent`·`approval_id`·`platform` 추가 + `action.approved`.

**V3-3a. 연결 코드(pairing 값)는 승인 때 고른다(성재 결재 2)**
- 승인 카드에 「에이전트에게 연결 코드 넘기기」 체크가 있고 **기본은 꺼짐**이다. 결정 요청은 `deliverSecretToAgent?: bool`을 받고, 이 필드는 레지스트리에서 `agent.invite`·`invite.create`만 쓸 수 있다(다른 행동에서는 `InvalidArguments`). 카드 행에 선택 결과(「에이전트가 받아요」/「승인한 분만 봐요」)가 **늘 보인다**(승인자가 읽은 것 = 실행된 것).
- **꺼짐(기본)**: pairing 값은 결정 응답의 `secretOnce`에만(D4, `no-store`).
- **켜짐**: 결정 응답에 값을 싣지 않는다. 대신 승인 payload에 회수 허가(`secretClaim:{allowed:true, deadline}`)만 기록하고, 제안 에이전트가 **일회성 회수 호출**(V3-4)로 받는다.
- **위험과 완화**: (1) 값이 에이전트 런타임·로그·벤더 서버에 남을 수 있다 → pairing은 capability 0·15분·1회 소비라 유출의 상한이 낮고, 값은 **회수 시점에 새로 발급**되므로 서버 어디에도 평문이 저장되지 않는다. (2) 침해된 에이전트가 자기 통제 런타임을 새 연결로 붙인다 → 접근은 **confirm(사람)** 뒤에만 열리고, confirm 화면은 감지된 연결의 이름·dedicated member·채널·스코프를 사람이 확인한다. (3) 채널 노출 → 회수는 도구 응답으로만 가고 메시지·카드 props에는 없다. (4) `owner_only`(구독) 연결에는 허용하지 않는다.
- **confirm은 유지한다.** 시간순으로 confirm은 `detected` 이후이고, 승인 때 채널·스코프를 미리 허락해 detect 때 자동 confirm하는 안은 pairing 값을 가진 누구든 즉시 접근을 얻게 되므로 열지 않는다. 한 번 탭으로 줄이는 것은 #3773(UXUI)의 미리 채운 confirm 화면이다.
- 새 에이전트가 active가 된 뒤: owner는 승인자다. 승인자가 제안자의 소유자와 같은 사람이면 V4-M에 따라 제안자가 새 에이전트의 이름·프로필을 (별도 승인으로) 제안할 수 있다. 관계는 저장하지 않는다(D7).
- **남용 방어**: 매번 사람 승인 + 제안자당 pending 3개(V1-e). 새 상한은 두지 않는다(V3-6).

**V3-3b. 플랫폼별 차이 — 표시용 프리셋이고 연결 프로토콜은 하나다.** 연결 모델은 플랫폼과 무관하다: hosted member 하나 = connection 하나 = 벤더 쪽 루틴/커넥터 하나(ADR-0162 D6). `platform`이 바꾸는 것은 카드의 다음 행동 안내 문구뿐이다.
| 플랫폼 | 알려진 연동 방식 | 상태 |
|---|---|---|
| Grok Bot (SpaceXAI) | 벤더 VM의 **루틴**(webhook 트리거)과 **MCP 커넥터**로 Agent Port를 붙인다(ADR-0162 D8, `docs/SELF_HOST_AGENT.md` §3.3.16~17). | [V] 문서·절차. 라이브 왕복은 `runtime-unverified`(#3542) |
| dots (OpenAI) | ChatGPT 계정의 플러그인/커스텀 MCP 앱이라는 **제3자 문서**가 있다. 레포 문서는 「dots-specific claims를 하지 않는다」고 명시한다. | [확인 필요] 공식 문서·실계정 |
| Muse (Meta) | Muse Connectors와 custom connector(MCP/API)가 있다는 **언론·제3자 가이드**. 공식 개발자 포털 유무는 출처가 엇갈린다. | [확인 필요] 공식 문서·실계정 |
공통 위험(ADR-0162 D16): 소유자 **본인 계정·본인 VM**에서만. oort는 벤더 API를 부르거나 계정을 만들거나 토큰을 풀링하지 않는다. 「에이전트가 같은 플랫폼에 새 봇을 만든다」는 벤더 쪽에서 에이전트가 하는 일이고 약관 허용 여부는 oort가 보증하지 않는다. 이 증보는 oort 쪽 「연결 생성 승인」만 열고 벤더 쪽 자동화를 주장하지 않는다. [확인 필요: 각 벤더 약관]

### V3-4. 일회성 회수 호출 — `oort_action_claim_secret`(새 Agent Port 도구)
`agent.invite`(체크 켠 경우)와 `invite.create`의 비밀을 제안 에이전트가 받는 유일한 길이다. 새 스코프는 만들지 않고 `workspace:propose`를 쓴다(도구 카탈로그 11 → 12, 드리프트 시험 갱신).
- **입력** `{handle, approvalId}`(`handle` = lease handle, `bound_handle` 검사 동일). **출력** `{actionId, kind:"pairing"|"invite", value, expiresAtMs}` 또는 실패 코드.
- **회수 시 발급(mint-on-claim)**: 서버는 비밀을 저장하지 않는다. 회수 순간에 도메인 함수가 새 값을 만든다 — `agent.invite`는 `regenerate_pairing_in_tx`(해시 교체, 새 15분 TTL), `invite.create`는 초대 `regenerate`와 같은 도메인 함수로 코드를 교체하고 **저장된 `maxUses`·만료·역할을 그대로 유지**한다(새 상한을 만들지 않는다). 이전에 있던 값(결정 응답에 나갔을 수 있는 것)은 이 교체로 무효가 된다. 따라서 D4의 「approval payload·메시지 props·감사·로그·outbox에 비밀 0」이 그대로 지켜진다.
- **회수 조건**(한 tx, 승인 행 `FOR UPDATE`): (1) 호출 credential의 에이전트 = 그 승인의 **제안자**(`requested_by`)이고 같은 connection·lease handle. 다른 에이전트의 회수는 **같은** `not_found`다. (2) 승인 상태 `approved`이고 행동이 `agent.invite`(체크 켠 경우)·`invite.create`다. (3) `secretClaim.claimedAt`이 비어 있다 → 회수와 함께 설정(**1회**, 두 번째는 `already_claimed`). (4) **회수 기한 30분**(승인 시각 기준, 지나면 `claim_expired`이고 값은 영영 나가지 않는다. 승인자는 기존 regenerate 경로로 직접 새 값을 받을 수 있다). (5) 대상 connection/초대가 아직 유효하다(승인자가 취소했으면 거절).
- 응답은 `Cache-Control: no-store` 성격으로 도구 결과에만 실리고 에이전트 명의 메시지로 게시되지 않는다. 감사: `agent.secret.claimed`(제안자·`approval_id`·kind, **값 없음**). 실패 시도도 사유 코드만 감사한다.
- 에이전트가 값을 받은 뒤 어디에 쓰는지는 oort 밖이다. 도구 설명문에 「채널에 붙이지 말고 해당 플랫폼에서만 쓴다」를 명시한다(S1).

### V3-5. `invite.create` — 초대 링크를 제안 에이전트에게 돌려준다(성재 결재 3, D4·V6 개정)
- **바뀌는 것**: V6의 「초대 링크는 돌려주지 않는다」와 D4의 「1회 시크릿은 승인자에게만」을 `invite.create`에 한해 뒤집는다. 승인 결정 응답은 링크를 승인자에게 싣지 **않고**(`secretOnce` 부재), 카드는 「에이전트가 이 링크를 받아 전달해요」를 명시한다. 승인자는 언제든 기존 초대 목록·`regenerate`로 새 링크를 받을 수 있다.
- **근거**: 성재의 의도는 「그록봇이 사람을 초대하러 다니게」다. 링크가 승인자 손을 거쳐야 하면 에이전트의 자율은 「링크를 만들어 달라고 조르는 것」에 그친다. 승인(역할·사용 횟수·만료를 카드에서 사람이 읽고 누름)이 위험 결정이고 링크 전달은 그 결정의 실행이다.
- **위험**: 링크는 가입 자격이다 — 에이전트 런타임·로그·채널에 남으면 누구나 쓴다. **완화**: (1) 상한은 기존 그대로다 — `role`은 `member|admin`(`INVITE_PROPOSABLE_ROLES`)이고 **`admin` 초대는 카드에 빨간 행으로 늘 보이며** `maxUses ≤ 100`·`expiresInDays ≤ 30`, 카드가 이 값을 평문으로 보인다. (2) 회수는 1회·30분 기한·제안자 한정·mint-on-claim(V3-4)이라 서버가 평문을 들고 있지 않다. (3) 에이전트 도구 설명문이 「링크는 요청한 사람에게만 전달하고 채널에 게시하지 않는다」를 명시한다(S1) — 이것은 강제가 아니라 안내임을 정직하게 적는다. (4) 감사 `agent.secret.claimed` + 기존 `invite.created`(`via_agent`·`approval_id`)로 사후 추적한다. (5) 위험이 클수록 카드에서 사람이 `admin`·`maxUses`를 줄여 승인할 수는 없으므로(카드는 에이전트 제안 그대로 승인/거절) 에이전트가 과하게 요청하면 거절하고 다시 요청하게 한다.
- 승인자 명의 DM 전달 UX(이전 초안의 대안)는 불필요해졌으므로 열지 않는다.

### V3-6. 승인 등급·위임·감사·남용 방어(성재 결재 4: 시간당 상한 없음)
| 행동 | 승인자 | 위임 가능성(전제일 뿐) | 도메인 감사(값 없음) |
|---|---|---|---|
| `agent.profile.update` | `agent_editor` | 소개·상태 문구·프리셋만 후보. 이미지 아바타·역할 라벨·이름은 불가(V4-M-7 인용) | `agent.profile.updated`(+`member.renamed`, `agent.avatar.*`) |
| `agent.invite` | `admin` | 불가 | `hosted_agent.connection.created`(+`via_agent`·`platform`), 회수 시 `agent.secret.claimed` |
| `invite.create` | `admin` | 불가 | 기존 `invite.created` + `agent.secret.claimed` |
무승인 위임 자체는 이번에도 열지 않는다(V7).

**시간당 상한을 두지 않는 이유**(성재 인용: 온보딩·공채 이후 인사 시즌에는 많이도 가능한데 상한이 필요한가): 연결과 초대는 **매번 사람 승인**을 거치고, v2의 **제안자당 pending 승인 3개 상한**(V1-e)이 승인 전 폭주를, 사람의 거절·만료(TTL)가 그 뒤를 막는다. 이 두 가지가 폭주 방어의 전부이고 이 증보는 다른 상한(시간당·일일·미완료 연결 수)을 **새로 만들지 않는다.** 이미지 처리의 크기·해상도 상한(V3-2a)은 남용 속도 제한이 아니라 파서 안전의 일부다. **관측만 남긴다**: 위 감사 행이 `created_at`으로 시간당 집계 가능하고, 서버에 메트릭 레지스트리가 있으면 `workspace_action_proposed_total{action}`·`workspace_action_decided_total{action,outcome}`·`agent_secret_claimed_total{kind}` 세 카운터를 P0가 더한다(없으면 감사 쿼리만으로 둔다 — 새 메트릭 인프라는 만들지 않는다). [확인 필요: 기존 메트릭 레지스트리 유무]

### V3-7. 범위 밖과 이유
- 에이전트가 **연결을 confirm**하거나 active credential을 받는 길(confirm은 사람).
- 원격 이미지 URL, 아바타 GIF·SVG·애니메이션, `instructions` 등 V3-2c 목록, 사람 멤버의 프로필 변경.
- 벤더 API를 oort가 호출해 봇·루틴을 만드는 일(ADR-0162 D16).
- 무승인 위임, `member.role.set`·`webhook.create`.
- 승인 카드의 이미지 미리보기 렌더, 「에이전트에게 연결 코드 넘기기」 체크 UI, 업로드 요청 카드, 프리셋 선택기, 연결 안내: UXUI 이슈(#3773 포함).

### V3-8. #3773과의 접점
- **한 목록, 두 입구.** #3773의 플랫폼 목록(Grok Bot·dots·Muse)과 `agent.invite`의 `platform` 키는 같은 프리셋 키를 쓴다. 키 정본은 #3773(UXUI)이 정하고 이 증보는 `grok_bot`·`dots`·`muse`·`other`를 잠정 값으로 둔다.
- **같은 서버 계약.** 사람이 연결 화면에서 만드는 길과 에이전트가 제안하는 길은 `provision_hosted_agent_in_tx`에서 합쳐진다. #3773의 압축은 confirm 이후이거나 미리 채운 confirm이므로 충돌하지 않는다. 연결 코드는 #3773의 「복사할 연결 프롬프트」 컴포넌트로 같은 자리에 그린다(ADR-0182 ①).
- #3773이 서버 변경을 요구하면 engine 이슈·ADR을 분리한다.

### V3-9. 보안 검수가 특히 볼 곳
이미지 업로드 경계(파서 취약점·폴리글랏·크기 폭탄·EXIF·애니메이션·치수 위조·선언 mime 불일치, 서빙 헤더) · 시크릿 회수(1회성 경쟁 조건, 타 에이전트 회수 불가, 기한, mint-on-claim이 이전 값을 무효화하는지, 로그·감사에 값이 없는지) · 결정 때 재증명(핀·소유자 변경) · 승인 카드에 나가는 문자열이 서버 해석값인지.

### V3-10. 결재 기록 (2026-10-13)
성재가 2026-10-13 AskUserQuestion으로 결재했다(원문 인용). 네 항목 중 1·3·4번이 초안의 추천안과 달랐다.
1. 아바타: 「기존에 업로드된 파일이나 에이전트가 사용자한테 업로드 요청해서 바꾸거나 뭐 이미지 생성이 가능한 놈이면 본인이 생성해와서 쓰거나 할 수 있게 해봐 재밌겠네 자율성을 많이 줘봐」 → 출처 셋(워크스페이스 파일·사람에게 업로드 요청·에이전트 생성 바이트)과 프리셋 기본(V3-2a). 초안의 「프리셋만」과 다름. 완화책(서버 재인코딩·크기·해상도 상한·서버 저장소·카드 미리보기·핀+해시·감사)은 요청에 따라 설계했고, `instructions`는 계속 닫는다.
2. pairing 값: 「승인할 때 선택」 → 승인 카드의 「에이전트에게 연결 코드 넘기기」 체크(기본 꺼짐), 켜면 일회성 회수 호출(V3-3a·V3-4). 초안의 I2를 이번 범위에 포함. confirm은 계속 사람.
3. 초대 링크: 「그록봇에게 돌려주기」 → 승인된 초대 링크를 제안 에이전트에게 일회성 회수로 돌려줌, 기존 상한(maxUses·만료) 유지, 카드에 「에이전트가 이 링크를 받아 전달해요」(V3-5). D4·V6 개정. 초안(승인자 DM)과 다름.
4. 남용 상한: 「굳이 제한을 둬야할까 온보딩이나 공채 이후 등의 인사 시즌에는 많이도 가능한데 제한을 둬야할 필요가 있나 싶어」 → 시간당 상한을 도입하지 않고 매번 사람 승인 + 제안자당 pending 3개로 방어, 관측만 남김(V3-6). 초안의 상한 숫자와 다름.

### V3-11. 구현 슬라이스(한 슬라이스 = 한 이슈 = 한 브랜치·PR, base `track/engine`, 앞 슬라이스 위에 쌓는다)
| ID | 내용 | 선행 |
|---|---|---|
| P0 | **레지스트리 기반**: `ACTIONS` 8개(`agent.profile.update`·`agent.invite` 등록), `WORKSPACE_ACTION_IDS` 6→8·드리프트 시험·OpenAPI enum·`GET actions`, 행동별 args `oneOf` 스키마, 결정 요청의 `deliverSecretToAgent`, 관측 카운터(레지스트리가 있을 때), 동의 화면 문구 | **이 ADR Accepted** |
| P1 | `agent.profile.update` 서버(아바타 제외): 이름·소개·상태·역할 라벨 검증기, 결정 때 재증명, 감사, 사람용 `PUT` 경로가 같은 검증 | P0 |
| A0 | 아바타 기반: `image` 의존·NOTICE, 이미지 처리 모듈(스니프·헤더 치수·디코드 한도·재인코딩·출력 상한), migration(`agent_avatar_image`+포인터+RLS), 서빙 라우트 | P0 |
| A1 | 아바타 출처: 프리셋 + (a) 첨부 선택(+첨부 가시성 실측) + (c) 생성 바이트 + `staged` 핀·해시·승인 카드 미리보기 라우트·적용·회수 arm·감사. (b)는 지시문·`card_suggest` command 허용만 | P1·A0 |
| I1 | `agent.invite` 서버: 승인 실행기에서 `provision_hosted_agent_in_tx`, `secretOnce`(체크 꺼짐), 감사 | P0 |
| I2 | `oort_action_claim_secret` 도구 + `agent.invite`(체크 켜짐) 회수 + `invite.create` 회수(결정 응답에서 `secretOnce` 제거) + mint-on-claim + 감사 + 도구 카탈로그 12 | I1 |
| S1 | 에이전트 지시문·문서(`SELF_HOST_AGENT.md`, hosted 루틴, 도구 설명문): 새 행동·「제안 뒤 turn 종료」·링크·코드 취급 안내·(b) 업로드 요청 문구 | A1·I2 |
| UX | UXUI 이슈(코드 아님): 승인 카드 이미지 미리보기, 연결 코드 넘기기 체크, 업로드 요청 카드, 프리셋 선택기 | — |
| X1 | 플랫폼별 실측(그록봇 #3542 연장, dots·Muse 공식 문서·실계정) | I1 |

### V3-12. 수용 기준(구현 슬라이스가 인용할 red proof, 각 시험은 해당 분기를 지우면 실패해야 한다)
- `ACTIONS` id 집합 = 도구 enum = OpenAPI enum(8개), 행동별 args 스키마 동일. 도구 카탈로그 12개와 `oort_action_claim_secret` 드리프트.
- `agent.profile.update`: `instructions`·`enabledTools`·`paused`·`handle`·URL 키는 `InvalidArguments`. tagline의 마크다운 링크·`@멤버`·`<@멤버>`·`https://`·`www.`·영폭 공백 거절. `roleLabel` 예약어·`role_labels` 값 거절. `statusText` 만료 필수·81자 거절. 소유자가 다른·NULL·사람·없는 대상은 **같은** `InvalidArguments`. 소유자(비-admin) 승인 가능, 제3자 403. 승인 뒤 저장 전후 비교에서 다른 필드 불변. 감사에 값 없음.
- 아바타 이미지: SVG·GIF·애니메이션 WebP·매직 불일치·치수 4096 초과·0·헤더 파싱 불가·1 MiB 초과(c)·5 MiB 초과(a)·디코드 실패는 모두 거절되고 `staged` 행이 **0개**. **폴리글랏**(PNG 뒤에 스크립트/ZIP 꼬리, JPEG 주석에 HTML)을 넣으면 저장·서빙되는 바이트에 그 꼬리가 **없다**(재인코딩 결과 바이트 비교). EXIF GPS가 든 JPEG를 넣으면 결과에 EXIF가 없다. 결과 ≤512×512·≤512 KiB. 서빙 응답 헤더 `nosniff`·CSP sandbox·저장 mime. 선언 mime이 달라도 매직이 판정한다.
- 핀: `staged` 행의 바이트가 바뀐 상태(시험이 SQL로 변조)에서 결정하면 `action_args_invalid`·승인 pending·포인터 불변. 다른 승인·다른 대상의 `staged`를 가리키면 거절. 첨부가 이후 삭제돼도 승인된 이미지는 `staged` 사본으로 적용. 적용 시 이전 이미지 행 삭제, 거절·만료 시 `staged` 삭제.
- 첨부 (a): 남의 비공개 채널 첨부·DM·없는 id·비이미지·`complete` 아님은 같은 오류.
- `agent.invite`: 비-admin 결정자 403 `role_required`·연결 0·승인 pending. 승인 시 member·agent·paused 프로필·`pairing_pending` connection이 한 tx(중간 실패 시 전부 없음), owner = 승인자. 체크 꺼짐이면 pairing이 결정 응답에만 있고 payload·props·감사·outbox·로그에 **0건**(grep 시험). 체크 켜짐이면 결정 응답에 값이 **없다**. `detected` 이전에 어떤 도구로도 읽기·쓰기·claim 불가. 에이전트가 confirm·regenerate를 부를 수 없다.
- 회수(`oort_action_claim_secret`): 첫 호출만 값을 주고 둘째는 `already_claimed`(동시 두 호출 중 정확히 하나만 성공). **다른 에이전트의 credential로는 같은 `not_found`**. 30분 기한 뒤 `claim_expired`. 체크 꺼짐 승인·거절/만료 승인·`agent.invite`/`invite.create` 외 행동은 거절. 회수가 이전 값을 무효화(이전 초대 코드로 redeem 실패, 이전 pairing으로 handshake 실패). 회수한 초대 코드의 `maxUses`·만료·역할이 승인 카드의 값과 같다. 감사에 값이 없다. 값이 어디에도(DB 덤프·로그) 평문으로 남지 않는다.
- `invite.create`: 결정 응답에 `secretOnce`가 없고 카드 문구가 「에이전트가 받아 전달해요」. 기존 상한(역할·≤100·≤30일) 위반은 그대로 `InvalidArguments`.
- 시간당 상한이 **없음**을 시험이 못박는다: 연속 제안·승인 N회(보류 3개 이하로 반복)가 상한 없이 통과, 4번째 pending만 `Conflict`.
- 미검증 표시: 벤더(그록봇·dots·Muse)와의 실제 왕복은 시험 범위 밖이며 `runtime-unverified`(X1이 닫는다).

### V3-13. 구현 중 확인된 사실과 ADR 문구 정정 (2026-10-14, #3786·#3787 구현·보안 검수)
Accepted 본문의 수치·모양 중 구현에서 측정으로 바뀐 것만 적는다. 결정의 방향(승인·핀·재인코딩·서버 저장·URL 금지)은 그대로다.
1. **생성 이미지의 크기: 1 MiB → 44 000바이트.** Agent Port는 요청 본문을 **인증 전에** 64 KiB(`momo_mcp::MAX_BODY_BYTES`)까지만 읽고 JSON 문자열 하나를 8 KiB(`MAX_STRING_BYTES`)로 제한한다. 한 번의 호출에 이미지를 실으려면 둘 다 건드려야 해서, 본문 한도는 **그대로** 두고 `dataBase64`라는 **키 이름에 한해** 문자열 한도를 58 700바이트로 올렸다(`MAX_BULK_BASE64_BYTES`, 다른 키는 8 KiB 그대로). 디코드한 이미지는 44 000바이트까지 — 256×256 PNG나 512×512 JPEG가 들어가고, 1 MiB 렌더는 에이전트가 줄여서 보내야 한다. 더 큰 이미지는 출처 (a)의 워크스페이스 파일(≤5 MiB)로 온다. `mime` 인자는 없다(매직 넘버가 종류를 정한다).
2. **입력 변 상한: 4096 → 2048.** 보안 검수가 4096² 입력에서 RSS 160–310 MB를 측정했다(zune-jpeg는 `max_alloc`에 듣지 않고, 회전이 전체 프레임을 복사). 입력을 2048로 줄이고 회전을 **축소 뒤**로 옮겨 최악 109 MB(iCCP 폭탄), 정상 입력은 34–67 MB가 됐다. 대가: 4032×3024 폰 사진은 거절된다(정책 결정은 별도).
3. **디코더 할당 한도 24 MiB.** 이 한도는 프레임이 아니라 디코더의 스크래치(iCCP/zTXt 팽창)만 묶는다는 것을 측정했다.
4. **동시성 상한 2.** 디코드는 작은 파일에서도 수십 MiB를 쓰고 `spawn_blocking`은 타임아웃으로 취소되지 않으므로, 프로세스 전체에서 동시에 두 개까지만 허가하고 허가를 블로킹 작업 안으로 옮겨 디코드가 **끝나야** 풀린다(`AVATAR_DECODE_PERMITS`).
5. **`agent_avatar_image` 열 추가.** `approval_id`(write-once, UNIQUE): 이미지를 먼저 `staged`로 만들어 카드가 미리보기를 쓰고, 승인이 만들어진 뒤 **한 번** 묶는다. 결정은 이 열이 **그 승인**인 이미지만 받는다(`staged_image_matches_pin_in_tx`·`apply_avatar_image_in_tx`가 SQL에서 요구). 워크스페이스 일치는 `(workspace_id, member_id|proposed_by) → member(workspace_id, id)` 복합 FK(`member`의 003 UNIQUE)가, 주인이 에이전트라는 사실과 `staged`·미결속 INSERT는 트리거가 맡는다. `member`에는 `member_avatar_exclusive_ck`(`avatar_media_id`와 `avatar_image_id` 동시 금지)를 더했다.
6. **에이전트가 파일을 고르려면 id를 알아야 한다(출처 a).** `oort_conversation_read`가 메시지마다 `imageAttachments`(완료된 PNG/JPEG/WebP의 `id`·`name`·`mime`·`sizeBytes`; Drive 파일 id는 없음)를 돌려준다 — 에이전트가 이미 읽을 수 있는 채널에 한해, 삭제된 메시지는 제외. 에이전트가 쓸 수 있는 첨부는 (공개 ∪ 자신이 멤버인) ∩ 연결의 승인 채널의 완료·메시지 결속 이미지뿐이고, 그 밖은 존재 여부를 말하지 않는 같은 `InvalidArguments`다.
7. **미리보기 경로**: `GET /v1/workspaces/{ws}/approvals/{approval}/avatar-preview?v={sha256}`. 읽을 수 있는 사람은 그 카드를 **결정할 수 있는 사람**(대상 에이전트의 소유자 또는 admin)뿐이고 나머지는 모두 같은 404다. 카드의 `action.preview`는 서버가 만든 값(`imageId`·`sha256`·`mime`·치수·크기·출처)만 가진다.
8. **거절·만료 정리**: 거절·만료 arm이 그 승인의 `staged` 행을 지우고, 사람이 run을 취소한 경우처럼 그 arm을 거치지 않는 것은 다음 아바타 제안이 24시간 지난 `staged`를 같은 트랜잭션에서 청소한다.
9. **저장된 인자 형태**: 승인 payload의 `args.avatar`는 항상 `{source:"preset"…}`·`null`·`{source:"staged", imageId, sha256, origin}` 중 하나다. 에이전트가 보낸 바이트·첨부 id는 저장되지 않고, 결정 때 인자를 다시 읽는 파서는 에이전트용 두 형태(`generated`·`attachment`)를 **거절**하고 `staged`는 서버가 저장한 형태에서만 받는다(`ArgsOrigin`).
10. **관측**: 저장소에 메트릭 레지스트리가 없어 새 카운터는 만들지 않았다. 감사 행(`agent.avatar.updated`: 출처·mime·치수·크기·sha256 앞 12자, 바이트 없음)을 시간 단위로 집계하면 된다.
11. **`agent.invite`의 구현 모양 (#3788)**: ① 레지스트리 `secret_delivery`는 회수 호출(I2)이 생기기 전까지 `None`이다 — 플래그를 켜도 받을 길이 없는 코드가 되지 않도록 P0의 `deliver_secret_not_supported`가 거절하고, I2가 `OptIn`으로 바꾼다. ② 감사는 기존 `hosted_agent.connection.created`를 바꾸지 않고 별도 행 `agent.invited`(`via_agent`·`approval_id`·`platform`·`connection_id`, 값 없음)를 더한다. ③ 핸들은 표시 이름과 같은 엄격 규칙(예약어)·명단 충돌·멘션 겹침·삭제된 멤버의 핸들까지 제안 시점에 검사한다(보안 검수 M1/M2/L1). ④ 결정 응답을 잃으면 코드는 복구할 수 없고 소유자가 기존 재발급 경로로 새로 받는다(D4).
12. **`oort_action_claim_secret`의 구현 모양 (#3789)**: ① 도구 오류 어휘에 두 코드를 더했다 — `already_claimed`(-32006)와 `claim_expired`(-32007)는 **제안자에게만** 닿는다. 제안자 아님·미승인·허가 없음·거절·대상 소멸·없는 승인은 모두 같은 `unavailable`(-32004)이다. ② `handle`은 `bound_handle`로만 증명하고(연결·에이전트 바인딩) 임대 생존은 요구하지 않는다 — 승인 뒤 run은 이미 끝나 임대가 없기 때문이다. ③ 허가는 `payload.secretClaim`에 `{allowed, deadlineMs, kind, refId, decidedBy, origin}`로만 기록한다(값 없음); 초대 링크의 절대 origin은 승인 요청의 것을 저장해 회수 때 같은 링크를 만든다. ④ 초대 `regenerate_invite`는 만료를 7일로 되돌리므로, 회수는 원래 `expires_at`을 그대로 되돌려 쓰고 `created_by`는 승인자다. ⑤ 승인 때 만든 값(pairing·초대 코드)은 아무에게도 보이지 않은 채 버려지고, 회수 시점의 새 값만 나간다. ⑥ 레지스트리: `invite.create`=`Always`, `agent.invite`=`OptIn`; 결과 줄과 제안 카드 행(「초대 링크: 에이전트가 이 링크를 받아 전달해요」, 「연결 코드: 승인할 때 고르세요」→선택 결과)이 선택을 늘 보여 준다. ⑦ 초대 링크의 origin은 운영자가 설정한 공개 주소가 있으면 그것이 우선하고, 없을 때만 승인 요청의 origin을 쓴다(회수한 링크는 사람이 보지 않고 에이전트를 거치므로). 설정이 없는 배포에서 `Host`를 믿는 한계는 기존 초대 링크와 같고, 설정을 권장한다. ⑧ 회수 시 승인자(`decidedBy`)가 여전히 관리자인지 다시 증명한다.

## 증보 2026-10-25 — 사람 프로필 사진 행동: `member.avatar.set` (v4, #4385)

- Status: **Accepted** (2026-10-25, planner 위임 결정 — 성재의 위임 「결정 부탁드릴 것은 너가 권장으로」와 owner 10-25 요청 「모바일에서도 grok을 통해서 내 프로필을 바꿀 수도 있는거지 ?」를 인용. 독립 보안 검수 PASS(Blocker 0·High 0, V4-12) 뒤에 Proposed에서 올렸다. 결정 기록 V4-10)
- 발제: 성재 2026-10-25 「모바일에서도 grok을 통해서 내 프로필을 바꿀 수도 있는거지 ?」 → 사실은 「안 된다」였고(레지스트리에 사람 프로필 사진을 바꾸는 행동이 없다), 요청은 「대화에 사진을 첨부하고 그록봇에게 〈이걸로 내 프로필 사진 바꿔줘〉」다.
- 기안: Sonnet 5.5 worker(#4385)
- Consumes: ADR-0186 D2~D4·V1~V7·V3-2a·V3-13 · ADR-0161 D-M2~D-M4(사람 아바타 `members/me/avatar`, 증보 1) · ADR-0204 D7(승인 푸시 대상·앱에서 열기) · ADR-0162 D6(Agent Port 승인 채널) · ADR-0100
- 접점 이슈: #3791(승인 카드 렌더, UXUI — `action.preview`·`ref.type: member` 표시), #3787(에이전트 아바타 A1 — 같은 이미지 처리 파이프라인)
- 이 증보가 **의도적으로 바꾸는 경계 셋**: ① ADR-0161 D-M2 「에이전트는 인간 아바타를 바꿀 수 없다」 → **승인된 액션 경유로만, 본인에게만** 허용(V4-2). 직접 경로(`members/me/avatar`)의 `require_human`과 에이전트 bearer 비허용은 그대로다. ② ADR-0186 D3의 역할 어휘에 `requesting_member`를 더한다(V4-3): 지금까지 어떤 역할도 「그 행동이 바꾸는 사람 본인」을 뜻하지 않았다. ③ 131의 `agent_avatar_image`가 **주인으로 사람을 받는다**(V4-6, migration 148). 새 테이블은 없다. **바꾸지 않는 것**: D2(제안 → 승인 → 실행)·이미지 처리(V3-2a의 1~3, 6~8: 재인코딩·핀·불변)·`instructions` 불가침·직접 업로드 경로.
- 표기: [V] 코드 직접 확인 · [추정] 해석 · [확인 필요] 근거가 약해 실측이 필요한 것.

### V4-0. 코드로 확인한 사실(2026-10-25, track/engine `d037effa2` 기준)
- 사람 아바타의 유일한 쓰기 길은 `POST/DELETE …/members/me/avatar…`다. 업로드는 Drive 세션을 열고 클라이언트가 Drive에 PUT한 뒤 `complete`가 크기·mime·매직 넘버·헤더 치수(≤4096)를 검증한다. 저장은 `member_avatar_media`(Drive 파일 id)이고 `member.avatar_media_id`가 포인터다. [V]
- Drive에는 서버가 바이트를 쓰는 API가 없다(131 머리말). 그리고 **교체·삭제·실패·방치된 아바타의 Drive 객체는 회수 잡이 지운다**(`avatar_reclaim`). [V]
- `/members/{m}/avatar/content`와 로스터의 `avatarUrl`은 이미 `avatar_image_id`(131)를 모든 멤버에 대해 먼저 읽고(`read_current_avatar_image_in_tx`, `COALESCE(avatar_media_id, avatar_image_id)`) 없으면 Drive 업로드를 읽는다. 사람 멤버가 `avatar_image_id`를 가져도 서빙·로스터 쪽은 고칠 곳이 없다. [V]
- 131의 INSERT 트리거는 이미지의 **주인(`member_id`)이 에이전트**여야 한다고 강제했다. `member_avatar_exclusive_ck`는 한 멤버가 업로드 아바타와 이미지 아바타를 동시에 갖지 못하게 한다. [V]
- `settle_member_avatar_upload_in_tx`는 `avatar_media_id`만 쓰고, `clear_own_member_avatar_in_tx`는 `avatar_media_id`만 지운다. 사람이 이미지 아바타를 갖게 되면 앞의 것은 CHECK 위반(500), 뒤의 것은 「내 사진 지우기」가 이미지를 못 지우는 결함이 된다. [V — 시험으로 재현·수리]
- 에이전트 런의 「누가 불렀나」는 `agent_run.trigger_message_id`의 작성자다. 사람이 에이전트를 멘션한 REST 전송이 그 메시지다. [V]
- `find_visible_image_attachment_in_tx`(에이전트 자기 프로필용)는 DM을 제외하고 에이전트의 승인 채널 집합을 경계로 쓴다. 사람이 자기 에이전트와 말하는 곳은 DM일 수 있고, 경계가 되어야 하는 것은 승인 채널 집합이 아니라 **그 대화**다. [V]
- hosted 연결이 덮는 방(`hosted_connection_channel_ids`, ADR-0162 증보 2 B1~B6)에는 **소유자 ↔ 에이전트 1:1 DM이 자동으로** 들어가고(연결을 confirm한 사람이 소유자일 때), 소유자가 연 DM도 들어간다. 그래서 `oort_action_propose`의 핸들이 DM 채널을 가리킬 수 있고, 이 행동은 DM에서 끝까지 동작한다(시험 `…works_in_a_dm_with_the_agent_and_stays_inside_it`). 소유자가 열지 않은 DM에는 애초에 런이 서지 않는다(기존 규칙, 이 증보가 넓히지 않는다). [V]
- 승인 결정 경로의 역할 판정은 `decider_gate`/`GatePlan`(exhaustive match) 한 곳이고, 푸시 대상(ADR-0204 D7)이 같은 함수를 읽는다. 새 역할은 두 곳이 컴파일러에 의해 같이 정해진다. [V]

### V4-1. 결정 요약
| # | 결정 | 근거 |
|---|---|---|
| 1 | 행동 `member.avatar.set`, 인자는 **`{attachmentId}` 하나**. 대상·URL·바이트·프리셋 키는 스키마에 없다(`additionalProperties:false`) | 「내 얼굴은 내가 고른다」가 검증기가 아니라 스키마의 성질이 되게 |
| 2 | **대상 = 요청자 본인**. 서버가 런의 트리거 메시지 작성자(활성 사람)에서 도출한다. 에이전트가 쓴 문자열은 대상이 되지 못한다 | V1-a(이름이 대상이 되는 길 없음)의 사람판 |
| 3 | **소스 = 그 사람이 같은 대화에 올린 첨부만.** 작성자 = 요청자, 채널 = 런의 채널(DM 포함), 완료·삭제 안 됨·PNG/JPEG/WebP·≤5 MiB. 다른 사람의 첨부·다른 대화의 첨부는 존재하지 않는 id와 **같은** `InvalidArguments` | V3-2a(a)의 경계를 「에이전트가 읽을 수 있는 곳」에서 「그 대화·그 사람」으로 좁힘 |
| 4 | **승인자 = 사진 주인 본인뿐.** 워크스페이스 관리자도, 에이전트의 소유자도, 같은 방의 다른 사람도 승인·미리보기를 못 한다 | 관리자가 남의 얼굴을 정하는 길은 만들지 않는다 |
| 5 | 이미지 검사·재인코딩·sha256 핀·`staged → applied`·불변은 **V3-2a의 파이프라인을 그대로** 쓴다(입력 한 변 ≤**4096**·총 ≤16 MP[V4-10 2로 2048에서 올림], ≤5 MiB, PNG/JPEG/WebP 정지 이미지, 결과 ≤512²·≤512 KiB) | 새 디코더 경계를 만들지 않는다 |
| 6 | 저장·서빙은 131의 `agent_avatar_image`·`member.avatar_image_id`·기존 content 프록시. **기존 `members/me/avatar` 경로와는 포인터 단계에서 공존**한다(V4-6) | Drive에 서버가 쓸 길이 없고, Drive 파일을 별칭하면 회수 잡이 첨부를 지운다(V4-8) |
| 7 | 카드는 항상 **앱에서 열어 결정**한다(잠금 화면 승인 없음). 미리보기는 `avatar-preview`를 재사용하되 읽는 사람이 본인 하나 | 사진은 배너로 판단할 수 없다(2026-10-17 결정의 연장) |
| 8 | 한 사람에게 대기 카드는 하나(같은 행동·같은 대상 중복 `Conflict`), 에이전트당 대기 3개 상한은 그대로. **추가: 한 사람이 대상인 제안은 시간당 10회**(V4-10 5) | V1-e·V4-M-9 재사용 |
| 9 | Agent Port 전용(`Proposers::Any`, 팀 AI 목록에는 없다). 팀 AI는 런이 없어 「부른 사람」이 없다 | 대상 도출의 전제 |

### V4-2. 행동 계약
- **제안**: `oort_action_propose {handle, actionId:"member.avatar.set", args:{attachmentId}}`. `attachmentId`는 `oort_conversation_read`의 `imageAttachments[].id`다(V3-13 6). 핸들·임대·승인 채널·스코프 판정은 다른 행동과 같다.
- **도출(트랜잭션 안, 두 번)**: 제안 때와 결정 때 모두 `requester_of_run_in_tx`가 `(런, 제안 에이전트)`로 트리거 작성자를 읽는다. 작성자가 활성 사람이 아니면(에이전트·탈퇴·삭제·트리거 없음) 거절한다. 다른 에이전트의 런은 이 에이전트의 제안에 쓰이지 못한다.
- **소스 검사**: `find_requester_attachment_in_tx` — 작성자 = 요청자 AND 채널 = 런의 채널 AND 완료 AND 허용 mime AND 크기 상한 AND 메시지가 삭제되지 않음 AND 채널이 보관되지 않음. 이 검사는 Drive 읽기 **앞**에서 한 번, 카드를 쓰는 트랜잭션에서 한 번 더 한다.
- **검사·재인코딩**: V3-2a 공통 처리 1~3(매직 넘버, 헤더 치수, 디코더 할당 한도, 동시 디코드 2, 10초 상한, 재인코딩). 원본·메타데이터는 어느 경로로도 저장·서빙하지 않는다.
- **저장**: `agent_avatar_image`에 `staged`로 INSERT — `member_id`=요청자, `proposed_by`=제안 에이전트, `source='attachment'`. 승인이 만들어진 뒤 `approval_id`를 한 번 묶는다. 저장 인자는 `{avatar:{source:"staged", imageId, sha256, origin:"attachment"}}`이고 첨부 id·Drive 파일 id·바이트는 어디에도 남지 않는다. 핀은 `{target: <요청자>, avatar:{imageId, sha256}}`다.
- **카드**: 행 「대상」(서버가 읽은 표시 이름·핸들), 「프로필 사진」(현재 → 새 이미지), 「사진 출처」(내가 이 대화에 보낸 첨부). `action.preview`는 서버가 만든 값(`imageId`·`sha256`·`mime`·치수·크기·`origin`)뿐이다.
- **결정**: 판정 순서는 다른 행동과 같다 — 역할이 주체에 대해 판정되므로 인자를 다시 증명한 **뒤**에 한다. 결정자 ≠ 핀의 사람이면 403 `role_required`(승인 소모 없음). 오래돼 어긋난 카드(핀·해시)는 본인에게만 409 `action_args_invalid`로 말하고 나머지에게는 `role_required`다(대상 존재 여부를 말하지 않는다). 승인되면 한 트랜잭션에서 핀을 다시 확인하고(DB가 바이트를 재해시) `apply_human_avatar_image_in_tx`가 멤버 행을 잠근 채 이미지를 `applied`로, 포인터를 옮기고 `avatar_media_id`를 비우고 **이전 이미지 행을 지운다**.
- **거절·만료**: 기존 arm이 `staged` 행을 지운다(`args.avatar.source == "staged"`를 읽는 공용 arm이라 새 코드 없음). 얼굴은 그대로다.
- **감사**(값·바이트 없음, sha256은 앞 12자까지): `member.avatar.staged`(제안·카드 작성 시), `member.avatar.set`(적용, 행위자=본인, 주체=본인, `via_agent`·`approval_id`·출처·mime·치수·크기), `member.avatar.refused`(카드가 만들어지기 전에 거절된 제안, `reason` 코드).
- **결과 `ref`**: `{type:"member", id:<본인>}`(OpenAPI `WorkspaceActionRef.type`에 `member` 추가).

**거절 사유 표**(에이전트가 보는 것은 항상 맨 오른쪽 한 가지고, 사유는 감사 `reason`에만 남는다)
| 사유 | 감사 `reason` | 에이전트가 보는 것 |
|---|---|---|
| 런이 없거나 트리거가 사람이 아님·탈퇴·삭제 | `no_requester` | `InvalidArguments` |
| 첨부가 없음·남의 것·다른 대화·삭제된 메시지·미완료·비이미지·5 MiB 초과(DB 크기) | `attachment_not_available` | `InvalidArguments` |
| Drive에서 읽지 못함 | `drive_unavailable` | `InvalidArguments` |
| 실제 바이트가 5 MiB 초과 | `too_large` | `InvalidArguments` |
| 매직 넘버가 PNG·JPEG·WebP가 아님(GIF·SVG 포함) | `unsupported_type` | `InvalidArguments` |
| 움직이는 WebP | `animated` | `InvalidArguments` |
| 헤더 치수를 읽지 못함 / 한 변 > 4096·총 > 16 MP 또는 0 | `dimensions_unreadable` / `dimensions_out_of_range` | `InvalidArguments` |
| iPhone HEIC/HEIF(`ftyp` 브랜드 heic·heix·hevc·hevx·heim·heis·mif1·msf1·heif) | `heic_unsupported` | `InvalidArguments`(안내는 도구 스키마·런북이 한다) |
| 사람당 시간당 10회 초과 | `rate_limited` | `InvalidArguments`(Drive 읽기·디코드 전) |
| 디코드 실패·결과가 512 KiB 초과·타임아웃·디코더 대기 | `decode_failed`·`output_too_large`·`timeout`·`busy` | `InvalidArguments` |
| 알 수 없는 키(`memberId`·`targetHandle`·`url`·`dataBase64`…) | — (스키마·파서) | `InvalidArguments` |
| 같은 사람에게 대기 카드가 이미 있음 / 에이전트의 대기 3개 | — | `Conflict`(409) |
| 결정자가 사진 주인이 아님 | — | (결정 응답) 403 `role_required`, 승인 소모 없음 |
| 핀·해시가 어긋남 | — | (결정 응답) 409 `action_args_invalid`, 승인 소모 없음 |

### V4-3. 역할 `requesting_member`
`RequiredRole::RequestingMember`(와이어 `requesting_member`, 한국어 「사진 주인 본인」)는 「그 행동이 바꾸는 사람이 결정자」다. `gate_plan`의 exhaustive match가 `GatePlan::RequestingMember`를 정하고, 결정 경로(`execute_workspace_action`)는 해석된 `GateSubject::Member(person)`을 `input.member_id`와 비교하며, 푸시 대상(`CardAudience::allows`)은 같은 핀(`pinned_target_member`)의 사람 하나에게만 깨어난다. 어느 쪽도 관리자 분기를 갖지 않는다.

### V4-4. 입력 크기: 폰 사진이 거절된다 — 결정됨: (B) 4096·16 MP (V4-10 2, 아래 「결정 반영」 참고)
- 직접 업로드(ADR-0161 D-M3)는 **4096×4096·GIF 허용**이고, 에이전트 경로의 이미지 파이프라인은 **한 변 ≤2048·PNG/JPEG/WebP 정지 이미지**다(V3-13 2: 4096²에서 RSS 160~310 MB, 디코드 2건 동시). 4032×3024 폰 사진은 이 행동에서 **거절된다**. 시험이 이 사실을 못박는다(`…refuses_every_picture…`의 「a phone-size picture」).
- 이 행동의 대표 시나리오가 「폰에서 찍은 사진을 첨부」라는 점이 문제다. [확인 필요] 폰 첨부 업로드가 길이를 줄이는지(iOS 선택기의 「실제 크기」 옵션, HEIC→JPEG 변환 여부)는 이 증보가 실측하지 않았다 — UXUI/폰 쪽 확인이 필요하다. HEIC가 그대로 올라오면 mime 허용 목록(PNG/JPEG/WebP) 밖이라 이 행동도, 직접 업로드도 못 쓴다.
- 선택지: (A) **지금 상한 유지** — 에이전트 지시문이 「크면 줄여 다시 보내 달라고」 안내한다(구현됨). (B) 이 행동에만 **입력 상한을 4096으로 올리고** 동시 디코드를 1로 낮추거나, 큰 입력을 **축소 먼저** 디코드하는 경로(JPEG DCT 스케일 디코드)를 따로 만든다 — 메모리 실측(RSS)이 선행 조건이다. (C) 폰 클라이언트가 첨부를 올리기 전에 긴 변 2048로 줄인다(서버 변경 없음, UXUI 이슈).
- 초안의 구현은 (A)였다. **결정은 (B)**(V4-10 2). 위 문단은 초안 당시의 사실이고, 현행은 아래 「결정 반영」이다.
- **결정 반영(2026-10-25, #4385 2단계)**: `AGENT_AVATAR_IN_MAX_DIM` 2048 → **4096**, 새 `AGENT_AVATAR_IN_MAX_PIXELS` = **16 000 000**(헤더 치수의 곱, 디코더가 할당하기 전에 거절 — 4032×3024는 통과, 4096×4096은 거절). 축소는 디코드 뒤·회전은 축소 뒤라는 V3-13 2의 순서와 동시 디코드 2·10초 타임아웃은 그대로다. **RSS 실측**(macOS, 단일 디코드, debug 빌드 시험 바이너리 전체): JPEG 4032×3024 78 MB(EXIF 회전 포함 78 MB)·JPEG 4000² 98 MB·PNG 4000² RGBA 108 MB·WebP 4032×3024 99 MB·WebP 4000² 130 MB, 그리고 최악 형식으로 16비트 RGBA PNG 4000² **174 MB**·프로그레시브 JPEG 4000² 145 MB(4032×3024 114 MB) — 동시 2건이면 최악 약 350 MB(측정한 형식 기준; 서버 메모리 예산에 이 값을 넣는다). 원문 측정 기록은 작업 스크래치패드 `4385/rss/result.txt`. (V3-13 2의 160–310 MB는 4096² **회전을 축소 전에** 하던 때의 값이다.) debug 빌드의 디코드 시간은 4.7 s(JPEG 12 MP)~9.3 s(WebP 16 MP)로 10초 타임아웃에 근접한다 — release에서는 훨씬 빠르지만 타임아웃을 줄이지 않는다. **HEIC**(iPhone 기본 형식)는 거절한다: 첨부 목록(`imageAttachments`)에 올라오지 않고, 바이트가 HEIC로 판정되면 사유 코드 `heic_unsupported`(오류 문구 「HEIC/HEIF photos are not supported: 사진을 JPEG로 보내 주세요」)로 거절한다. 에이전트는 도구 스키마·런북 지시문에서 「사진을 JPEG로 보내 주세요」라고 안내하도록 배운다(V4-5).

### V4-5. 에이전트 지시문(제안 방법)
에이전트가 실제로 읽는 곳은 둘이다 — `oort_action_propose`의 도구 스키마 분기 `description`(`momo-mcp`)과 `docs/SELF_HOST_AGENT.md` 3.3.16b의 표 행·항목. 서버가 따로 주입하는 프롬프트는 없으므로 이 둘이 정본이고 같은 내용을 말한다: 누군가 사진을 보내며 「이걸로 내 프로필 사진 바꿔줘」라고 하면 `member.avatar.set`으로 제안한다. `attachmentId`는 `oort_conversation_read`의 `imageAttachments[].id`이고 **그 사람이 이 대화에 보낸 사진 하나**다. 대상은 말을 건 본인뿐이고 다른 사람의 사진·다른 대화의 사진은 쓸 수 없다. 그 사람이 카드에서 직접 보고 승인해야 바뀐다. 한 변 4096px(또는 16 MP)을 넘는 사진·GIF·움직이는 이미지·iPhone HEIC 사진은 거절되니(HEIC는 `imageAttachments`에 보이지도 않는다) 그땐 「사진을 JPEG로 보내 주세요」라고 부탁한다. 한 사람이 시간당 10회를 넘기면 같은 `InvalidArguments`로 거절된다. 제안 뒤에는 턴을 끝낸다(3.3.16b의 규칙 그대로).

### V4-6. 저장: 131 테이블을 사람에게 열고, 사람 쪽 두 경로를 고친다 (migration 148)
- 새 테이블은 없다. 148은 `agent_avatar_image_guard_insert` 하나를 바꾼다: **제안자(`proposed_by`)가 에이전트**이고 **주인(`member_id`)이 살아 있는 멤버**이면 된다(131: 주인이 에이전트). 사람이 이 테이블에 자기 행을 직접 넣는 길은 여전히 없다(제안자 = 에이전트). 불변 트리거·`approval_id` write-once·복합 FK(자기 몫 이미지만 가리킴)·`member_avatar_exclusive_ck`·RLS FORCE는 그대로다. 테이블 이름 변경은 범위 밖이다.
- `apply_human_avatar_image_in_tx`는 `apply_avatar_image_in_tx`와 **단어 하나**(`kind`)만 다르다. 에이전트 프로필 카드가 사람에게 이미지를 적용할 수 없고, 사람 카드가 에이전트에게 적용할 수 없다(시험).
- **공존(이 증보의 실제 「재사용」)**: 사람이 직접 올린 사진(`settle_member_avatar_upload_in_tx`)은 같은 UPDATE에서 `avatar_image_id`를 비우고 교체된 이미지 행을 지운다. 「내 사진 지우기」(`clear_own_member_avatar_in_tx`)는 업로드 포인터와 이미지 포인터를 함께 지우고 이미지 행을 지운다. 둘 다 이 증보 없이는 사람이 이미지 아바타를 가질 수 없어 생기지 않던 결함이다. 사람이 방금 고른 쪽이 늘 이긴다.
- 서빙: 변경 없음(V4-0).

### V4-7. 범위 밖과 이유
- **프리셋·`generated`(에이전트가 만든 이미지)·URL**: 사람의 얼굴은 그 사람이 보낸 사진이어야 한다. 에이전트가 그려 주는 사람 사진은 다른 결정이다.
- **다른 사람의 프로필을 바꾸는 행동**(관리자 대행 포함): 이 증보는 「본인만」이다.
- **표시 이름·소개·상태**(사람 프로필 텍스트): 별 증보. 사람 프로필의 신뢰 표면은 에이전트의 것과 다른 규칙이 필요하다.
- **카드 UI·「프로필 사진 지우기」 에이전트 행동·워크스페이스 아바타**: UXUI/별 이슈. 클라이언트에 닿는 서버 계약 두 가지를 함께 기록한다 — 역할 `requesting_member`(`momo-core`의 `approvals/actionRole.ts` 합성 역할 표에 없으면 카드가 「requesting_member만 승인할 수 있어요」라는 원문 토큰으로 읽힌다; 권고 문구 「사진 주인 본인」)와 결과 `ref.type: member`. 둘 다 #3791 계열 UXUI/코어 작업이다.
- **팀 AI 경로**: V4-1 9.
- **벤더(그록봇·dots·Muse)와의 실제 왕복**: 시험 범위 밖이며 `runtime-unverified`다.

### V4-8. 기각한 대안
| 대안 | 기각 이유 |
|---|---|
| 첨부의 Drive 파일 id를 `member_avatar_media` 행에 **별칭**으로 걸어 `members/me/avatar` 경로를 그대로 쓴다 | 서버가 Drive에 쓸 길이 없어 가장 싸 보이지만, 같은 Drive 객체를 첨부와 아바타 두 행이 가리키게 된다. 아바타 회수 잡(`avatar_reclaim`)은 교체·삭제된 아바타의 Drive 객체를 **지운다** — 사람이 사진을 한 번 더 바꾸면 **메시지 첨부의 원본이 사라진다**. 재인코딩도 없어 EXIF(위치)·폴리글랏이 그대로 서빙된다 |
| 관리자(또는 에이전트 소유자)도 승인할 수 있다 | 관리자가 남의 얼굴을 정하는 길이 된다. 「본인만」이 이 행동의 핵심이다 |
| `targetHandle`로 대상을 받는다 | 대상이 에이전트의 문자열이 되어 V1-a를 깬다. 런에서 도출하면 인자가 없다 |
| 첨부 대신 URL·base64를 받는다 | 외부 URL 금지(131), 사람 얼굴에 에이전트 생성물을 올리는 것은 V4-7 |
| 에이전트의 승인 채널 집합을 경계로 쓴다(V3-2a (a) 그대로) | DM을 제외해 「그록봇과 DM으로 말하며 사진을 보낸다」가 안 된다. 사람과 에이전트가 대화한 곳이 경계다 |
| `RequiredRole::AgentEditor`를 재사용한다 | 대상이 에이전트가 아니고 사람이며, 관리자 우회가 들어 있다 |

### V4-9. 보안 검수가 특히 볼 곳
1. 결정 게이트: `person != input.member_id`(approvals.rs, 주체 판정 직후)와 실행기의 백스톱(`execute_member_avatar_set`), 미리보기의 `target != viewer`, 푸시 대상. 넷 중 하나가 빠져도 시험 하나가 빨개져야 한다(사보타주 표).
2. 도출: `requester_of_run_in_tx` — 트리거 작성자가 사람인가, 런이 이 에이전트의 것인가. 이 도출이 에이전트가 고른 값에 의존하는 길이 있는가.
3. 소스 질의: 작성자·채널 두 조건과 DM(경계가 승인 채널 집합이 아님)의 의미.
4. 두 사람 경로의 공존 수리(148과 `settle`·`clear`)가 직접 업로드의 기존 계약(자기만·20회/시간·Drive 검증)을 건드리지 않는가.
5. 감사 3종이 값·바이트 없이 사유 코드만 남기는가.
6. 같은 사람에게 에이전트가 반복 제안해 카드를 쌓는 남용: 한 사람 한 카드·에이전트 대기 3개·디코드 동시 2·10초·**사람당 시간당 10회**(V4-10 5; 거절·스테이징 모두 센다, 한도 거절 자체는 세지 않아 창이 빠진다). 한도 검사는 Drive 읽기·디코드 **앞**이다.
7. 입력 한도 4096·16 MP(V4-10 2)의 메모리 실측(V4-4 결정 반영)과 동시 2의 곱, HEIC 판정이 디코더 앞에서 끝나는가.

### V4-10. 결재 기록 (planner 위임 결정, 2026-10-25)
성재가 「결정 부탁드릴 것은 너가 권장으로」라고 위임한 범위에서 planner가 아래와 같이 정했다. 다섯 건의 원문 질문은 초안(Proposed)에 있던 그대로다.
1. **Accepted 조건**: 독립 보안 검수가 Blocker 0·High 0으로 통과하면 이 증보를 Accepted로 한다(검수 판정은 PR 본문). Status의 「성재 Accepted 결재」는 위 위임과 owner 10-25 요청 「모바일에서도 grok을 통해서 내 프로필을 바꿀 수도 있는거지 ?」로 갈음한다.
2. **입력 한도 = (B)**: 서버가 한 변 4096·총 16 MP까지 받고 저장 크기로 줄인다. 폰 사진(4032×3024)이 그대로 된다. HEIC는 거절하되 오류 문구와 에이전트 지시문에 「사진을 JPEG로 보내 주세요」(V4-4 결정 반영).
3. **`agent_avatar_image`를 사람에게 여는 방식(148)**: 수용. 별도 테이블은 두지 않는다.
4. **소유자 아닌 사람이 부른 경우**: 허용(대상 = 요청자 본인이라 안전).
5. **시간당 상한 = 사람당 10회**(V4-9 6). 초과는 `InvalidArguments`·감사 사유 `rate_limited`.
6. **migration 번호**: 초안은 147이었으나 형제 #4381(PR #4395)이 `147_mem_api_execute_lockdown.sql`을 먼저 쓰므로 이 증보의 migration은 **148**이다(planner 결정 6).
7. **승인 카드 UI는 #4394로 분리**(범위 밖): `actionRole.ts` 합성 역할 표의 `requesting_member`·`ref.type: member`·`avatar-preview` 렌더.

### V4-11. 구현 슬라이스와 수용 기준(red proof)
한 슬라이스(#4385, base `track/engine`): migration 148 · 레지스트리·역할·결정기·푸시 · 소스·도출 질의 · 제안 준비·스테이징·감사 · 미리보기 판정 · 사람 경로 공존 수리 · OpenAPI·런북·도구 스키마. 각 시험은 해당 분기를 지우면 실패해야 한다(PR 본문의 사보타주 표가 정본이다).
- 레지스트리: 역할 `requesting_member`, 스키마의 유일한 키 `attachmentId`, 항상 앱에서 열기, `ACTIONS`·도구 enum·OpenAPI 9개 일치.
- 제안: 남의 첨부·다른 대화 첨부·GIF·4096 초과·16 MP 초과·HEIC·비이미지·미완료·미결속·없는 id는 **같은 응답**이고 `staged` 행 0개. 4032×3024 JPEG는 200이고 저장은 512×384. 한 사람이 시간당 10회를 넘기면 거절(9회에서는 통과, 다른 사람의 기록은 세지 않음, 한 시간이 지난 기록은 세지 않음). 대상·URL·바이트 키는 `InvalidArguments`. 관리자가 멘션해 만든 런으로는 요청자의 파일을 쓰지 못한다. 대조군으로 같은 설정에서 요청자의 파일은 200.
- 카드: 핀의 대상 = 요청자, 저장 인자에 첨부 id·Drive id 없음, 스테이징 행의 주인 = 요청자·제안자 = 에이전트.
- 미리보기·결정·푸시: 요청자만 200, 관리자·에이전트 소유자·다른 방 멤버는 404/403 `role_required`·승인 pending·포인터 불변. 바이트를 바꾼 뒤 결정하면 409 `action_args_invalid`.
- 적용: 포인터·`applied`·서빙 바이트 = 서버가 쓴 것, 감사 행위자=주체=본인·값 없음. 거절·만료는 `staged` 삭제·얼굴 불변. 한 사람 한 카드(409).
- 공존: 에이전트가 정해 준 이미지가 있는 사람이 직접 올리면 성공하고 이미지 행이 사라진다. 「내 사진 지우기」는 이미지도 지운다. 에이전트용 apply가 사람에게, 사람용 apply가 에이전트에게 적용되지 않는다. 사람이 이 테이블에 직접 INSERT하면 거절.
- 도출: 에이전트가 쓴 트리거·다른 에이전트의 런·탈퇴한 사람은 요청자가 없다. DM의 요청자 파일은 찾고 다른 대화·남의 파일·삭제된 메시지·크기 초과는 못 찾는다.
- DM: 소유자의 1:1 DM에서 런이 서고 같은 대화의 파일만 쓰이며 본인만 승인한다(E2E). 다른 대화의 본인 파일은 거절.
- 미검증 표시: 벤더(그록봇·dots·Muse)와의 실제 왕복, 폰·웹 승인 카드 표시(UXUI), 폰 첨부의 실제 크기·형식(HEIC 변환 여부; V4-4)은 `runtime-unverified`다.

### V4-12. 독립 보안 검수 기록 (2026-10-25, #4385 2단계, 새 Sonnet 검수자 1회)
판정 **PASS (Blocker 0, High 0)**. 결정 게이트 4곳·대상 도출·소스 질의는 닫혀 있고 남의 얼굴을 바꾸는 길을 찾지 못했다. 검수가 남긴 것과 처리:
- M1(Medium) 대기 카드·에이전트 대기 3개로 `Conflict`가 나는 제안은 Drive 읽기·디코드가 끝난 뒤라 시간당 10회에 세지지 않는다 → **수용**. 에이전트는 유효한 런 핸들이 있어야 하고 디코드는 동시 2·10초·5 MiB로 묶여 있다(같은 성질이 `agent.profile.update`의 아바타 경로에도 이미 있다). 사전 점검으로 옮기는 것은 후속.
- M2(Medium) 거절 시험의 대조군이 새 시간당 한도에 걸릴 수 있다 → **수리**(시험이 대조군 앞에서 거절 기록을 2시간 전으로 민다). 한도 시험은 경계(10건이면 거절·9건이면 통과)와 다른 사람의 기록·한 시간 지난 기록을 센다.
- M3(Medium) 메모리 실측에 최악 형식이 없다 → **측정해 V4-4에 추가**(16비트 RGBA PNG 174 MB, 프로그레시브 JPEG 145 MB).
- L1~L5: 한도 검사의 락 없음(동시에 오면 10을 조금 넘길 수 있다 — 허용), 사람 한도는 에이전트별이 아니라 사람별이라 한 에이전트가 다른 에이전트의 몫을 쓸 수 있다(의도), 감사 홍수는 인증된 에이전트에 한한다, 사진 주인이 아닌 방 멤버도 카드를 **거절**은 할 수 있다(모든 승인 카드의 기존 규칙, 얼굴은 바뀌지 않는다), 148은 131의 「주인=에이전트」 DB 가드를 코드 가드(resolver 주체·`prepared.for_member` 일치·`kind` 분기)로 옮겼다(시험 있음), V4-2 표 갱신. 모두 수용 또는 문서화.

## 증보 2026-10-27 — 먼저 제안과 메시지 고정: `oort_action_initiate`·`message.pin`·`message.unpin` (v5, #4659)

- Status: **Accepted** (2026-10-27, owner 결재 — planner가 U-m 질문 일곱 개를 권장안과 함께 물어 「권장대로 진행하면서」. 일곱 개 모두 권장안이다). 독립 보안 검수 기록(U-l)은 붙었다(r1: Blocker 0 · High 3 수정, 확인 1회에서 H1·H2 닫힘, H3 잔여는 검수자 수정안대로 반영했고 재확인은 하지 않았다). 결재로 ADR-0100 머지 조건이 충족됐다. 다만 N3(먼저 제안 서버)는 U-g 선행 조건(개발자·CLI 토큰의 결정 차단, #4660)이 충족된 뒤에만 머지한다.
- 발제: owner 2026-10-27 요청의 요지. planner(터미널의 Claude Code)가 oort 에이전트로 연결돼 있을 때(#4616), 누가 시키지 않아도 「비공개 채널 `qa`를 만들까요?」 승인 카드를 올린다. owner는 승인 탭만 누른다. 승인되면 에이전트가 안내문을 올리고 **고정**한다(#4290). 지금은 둘 다 막혀 있다. 제안은 job의 handle이 있어야 하고(§1.2·D2), 메시지 고정은 에이전트가 할 수 있는 행동에 없다.
- 기안: Sonnet 5.5 엔진 워커 (#4659). 근거는 이슈 #4659·#4616·#4290·#4617 본문, planner 리서치(2026-10-27, 비공개)의 「oort 현재 상태」 8·9번 요지, 그리고 아래 U-0의 코드 실측이다.
- Consumes: 이 ADR의 §2·D1~D4·V1·V3·V3-6·V4-1·V4-10 · ADR-0162 D3·D4·증보 2(B2·B6-1)·증보 5(G2) · ADR-0199 · ADR-0200 D1·증보 4 · ADR-0214 · ADR-0100
- 표기: [V] 코드·문서 직접 확인(track/engine `16ad74731`, 읽기만 했고 실행하지 않았다 — `runtime-unverified`) · [추정] 이 증보가 정한 값 · [확인 필요] 구현 전 실측
- 이 증보가 **의도적으로 바꾸는 것** 다섯:
  1. §2의 「run과 분리된 승인 레코드」 기각은 그대로다(안 A1). 기각 이유 (c) 「hosted 제안은 항상 claim한 job의 run 안에서 일어난다」의 **전제만** 푼다. 승인은 항상 run 안에서 일어나지만, 그 run이 job에서만 태어나지는 않는다(U-a).
  2. `oort_action_propose`는 handle 필수 그대로다. 사람이 부르지 않은 제안은 handle 없는 새 도구 `oort_action_initiate`로 한다. ADR-0162 D3의 닫힌 tool→scope 표에 한 줄을 더하고, hosted 승인 가능 scope 집합에 항목 하나를 더한다(U-b).
  3. V3-6 「제안 시간당 상한 없음」은 사람이 시킨 제안에 그대로 유효하다. 아무도 부르지 않은 제안에는 상한을 둔다(U-d).
  4. 모든 `workspace_action`의 결과(승인·거절·만료)가 hosted 연결이 있는 제안자의 인박스에 `agent_run` 참조로 간다. 사람이 시킨 제안에도 적용된다(U-f).
  5. 에이전트가 메시지를 고정·해제하는 행동 둘을 레지스트리에 더한다(U-e). 에이전트 bearer가 고정 REST를 직접 부르는 길은 계속 닫혀 있다.
- **바꾸지 않는 것**: D2(제안 → 승인 → 실행, 실행은 승인자의 권한) · D3 위험 등급(모든 변경은 `approval`) · D4(1회 시크릿) · 한 run 한 제안 · V1-a~e · `instructions` 불가침 · 무승인 위임 미룸(V7) · hosted 연결의 confirm은 사람의 행동 · `approval.run_id NOT NULL` · `schema_v0.sql`.

### U-0. 코드로 확인한 사실 (2026-10-27)

1. **제안 도구는 handle이 필수다.** `oort_action_propose`의 입력 `required`는 `["handle","actionId","args"]`다(`server-rust/crates/momo-mcp/src/tools.rs:808`). 서버는 handle을 `bound_handle`(`bins/momo-server/src/routes/agent_port_tools.rs:1484-1503`: 워크스페이스·에이전트·연결·승인 채널)과 job lease 잠금(`:1976-1991`)으로 증명한다. handle은 `oort_jobs_claim`·`oort_job_start`가 내준 job의 것뿐이다. 그래서 사람이 부르지 않은 run에서는 제안할 수 없다.
2. **막힌 것은 제안 하나뿐이다.** `oort_message_post`는 승인 채널과 멤버십 두 조건만 보고 handle 없이 쓰며 `{messageId, seq}`를 돌려준다(`agent_port_tools.rs:948-`). `oort_conversation_read`는 메시지 `id`를 낸다(`:841`).
3. **승인은 run에 묶인다.** `approval.run_id`는 `NOT NULL`이다(`server/Migrations/001_init.sql:310`). 결정자는 `approval.channel_id`의 활성 멤버여야 한다(`routes/approvals.rs:766`). 만료는 notifier 스윕이 run을 `timed_out`으로 끝낸다(`bins/momo-notifier/src/approval_sweep.rs`, 결정 쪽은 `approvals.rs:3656` `expire_run`).
4. **서버가 run을 직접 낳아 승인에 묶는 선례가 있다.** 인플레이스 채널 승인(ADR-0162 증보 5 G2)은 run을 `awaiting_approval`로 태어나게 하고(`crates/momo-agent/src/run.rs:417` `create_held_agent_run_in_tx`) job을 쓰지 않는다. 동시 실행 상한은 이 run을 세지 않는다(`run.rs:935-957`, `input.hold='channel_grant'`).
5. **동시 실행 상한을 읽는 곳**은 work 요청 생성(`routes/agent_runs.rs:400-412`, `live > max`이면 409)과 관리형 worker다. 승인 대기 run 하나가 그 에이전트의 work 요청을 막는 문제는 notifier 스윕 머리말이 이미 적었다(`approval_sweep.rs` 앞머리). hosted 멘션은 상한으로 막히지 않는다.
6. **승인 결과는 제안 에이전트의 인박스에 가지 않는다.** 결과 줄은 raw 경로 `send_message_in_tx`로 쓰여 인박스에 투영되지 않는다. 투영하는 곳은 제품 send spine·`oort_message_post`·게이트웨이 완료뿐이다(`crates/momo-messaging/src/message.rs:921-934` 주석). 투영돼도 작성자는 건너뛴다(`hosted_inbox.rs:423`). 결과 줄의 작성자는 제안한 에이전트다(`approvals.rs:2099-2128`). 사람이 run을 취소할 때만 `agent_run` 참조가 간다(`agent_runs.rs:1364`). 즉 지금 모든 `workspace_action`의 결과는 에이전트가 깨어나 대화를 다시 읽어야만 보이고, 깨울 신호가 없다.
7. **사람의 고정 경로가 있다.** `PUT/DELETE /v1/workspaces/{ws}/messages/{id}/pin`(`bins/momo-server/src/lib.rs:729`) → `momo_messaging::set_pin_in_tx`(`crates/momo-messaging/src/interaction.rs:1555`). 채널 활성 멤버면 누구나 하고, 한 채널 100개(`CHANNEL_PIN_LIMIT` `:84`)이며, 삭제된 메시지는 고정할 수 없다. 방송 `message.pinned`·`message.unpinned`와 감사 `message.pinned`·`message.unpinned`가 같은 트랜잭션에 나간다(`routes/messages.rs:926` `record_interaction_audit`). 에이전트 bearer 표에 이 경로는 없다(`crates/momo-auth/src/agent_scope.rs:373-390` 시험). 에이전트가 고정하는 행동은 `ACTIONS`에도 없다(`crates/momo-agent/src/actions.rs:1054-1202`).
8. **소유자 1:1 DM은 연결이 자동으로 덮는다.** 단 에이전트에게 소유자가 있고 그 연결을 confirm한 사람이 소유자일 때만이다(ADR-0162 증보 2 B2·B6-1). DM 열기는 멱등이다(`crates/momo-messaging/src/dm.rs:154` `open_direct_message_in_tx`, 쌍 유일 인덱스). 사람이 닫은 DM도 워터마크보다 큰 seq의 메시지가 오면 다시 보인다(`crates/momo-messaging/src/dm_closure.rs` 머리말).
9. **사람을 run에서 도출하는 함수는 트리거 메시지가 있는 run만 사람을 낸다**(`crates/momo-messaging/src/agent_avatar.rs:772` `requester_of_run_in_tx`, 메시지 JOIN). 트리거 메시지가 없는 run에서는 `member.avatar.set`과 `oort_card_suggest`가 거절된다.
10. **대기 3개 상한**은 `server_in_place` 출처만 빼고 센다(`crates/momo-agent/src/approval.rs:225-249`). 인플레이스 문서는 「다른 모든 workspace_action은 에이전트가 제안했고 origin이 없다」고 적는다(`in_place_grant.rs:37-39`). 이 문장은 이 증보로 바뀐다.
11. **제안 속도 제한은 일부러 없다.** V3-6 결재 4. 이유는 「매번 사람 승인」이었다.
12. **hosted scope 어휘는 `text[]` 열 외에 CHECK 3개가 열거한다**(069·074·074). `workspace:propose`를 더한 087이 셋을 다시 썼다. 동의 화면 문구는 코어 `hostedAgents/approval.ts`·`model.ts`에 있다.
13. **워크스페이스 설정 bag에는 불리언 키 선례가 있다**(`team_ai_fast_path`, `crates/momo-settings/src/workspace_settings.rs:126`). 에이전트의 `workspace.settings.update`가 바꿀 수 있는 키는 `welcome_prompt`·`role_labels` 둘뿐이다(V7).
14. **잠금 화면 승인은 앱에서 열어야 하는 카드에 닫혀 있다.** `opens_in_app`(`actions.rs:390`)이 읽는 payload 경로는 푸시 투영에 실린 것뿐이고, `origin`은 이미 실린다(`crates/momo-agent/src/decider.rs` 머리말).

### U-1. 결정 요약

| 결정 | 정한 것 | 권장 | 결재 |
|---|---|---|---|
| U-a 그릇 | 한 호출이 run(`awaiting_approval`)·승인·카드를 낳는 새 도구 | A3 한 호출 | owner (Q1) — §2 기각을 다시 여는 일이라서 |
| U-b 누가·무엇을 | 연결 scope + 닫힌 4종 + 워크스페이스 끄개 | P1 scope, K1 설정 키 | owner (Q2·Q3·Q4) |
| U-c 카드 자리 | 소유자와의 1:1 DM, 항상 앱에서 연다 | C1 | planner 위임 기본값 |
| U-d 남용 방지 | 대기·속도·중복·수명·재증명·감사 | 시간당 6·하루 20 | owner (Q5: 숫자만) |
| U-e 메시지 고정 | `message.pin`·`message.unpin`, 승인 필요, 승인자 명의로 같은 함수 | E1 승인 필요 | owner (Q6) |
| U-f 결과 알림 | 승인·거절 때 인박스 `agent_run` 참조 + 같은 id 재호출(만료는 재호출이 파생) | F2 | planner 위임 기본값 |

### U-a. 시키지 않은 제안의 그릇 (이슈 D-a)

§2는 「run과 분리된 승인 레코드」를 기각하며 이유 셋을 댔다. (a) `approval.run_id NOT NULL`을 풀어야 한다. (b) 만료 스윕·레일 표시가 갈라진다. (c) hosted 제안은 항상 claim한 job의 run 안에서 일어나므로 필요 없다. 이 증보는 (c)의 전제가 깨졌다고 본다. 아무도 부르지 않은 제안에는 job이 없다. 대안이 세 이유에 어떻게 답하는지 본다.

| 안 | 모양 | 세 이유에 대한 답 | 비용 |
|---|---|---|---|
| A1 run 없는 승인 | `approval.run_id`를 nullable로 | (a) 정면으로 푼다. (b) 갈라진다 | DDL 변경에 더해 `LockedApproval`·`OverdueApproval`·run 경유 결정 라우트·인박스 투영·푸시 대상·run 원장 트리거(128)·TS `runId` 모델이 모두 None을 배워야 한다. 동시 실행 상한·park 가드·`oort_run_complete` 가드가 승인 쪽에서 사라진다 |
| A2 두 단계 | `oort_run_open`이 handle을 주고, 그 handle로 기존 `oort_action_propose` | (a)(b) 지킨다. (c)는 job을 흉내 낸다 | 봉인된 handle이 `job_id`·`lease_id`에 묶여(`momo-mcp/src/handle.rs:43`) job 없는 handle을 만들려면 태어날 때 lease가 잡힌 outbox job이 필요하고, 그 job이 인박스에 비치지 않게 막아야 한다. 제안 없이 떠난 run은 `running`으로 남아 lease 스윕(+2시간, ADR-0200 D1-4)까지 동시 실행 상한을 먹는다. 호출이 둘이고 상태가 둘이다 |
| **A3 한 호출 (권장)** | 새 도구 `oort_action_initiate`가 run을 `awaiting_approval`로 태어나게 하고 승인·카드를 한 트랜잭션에 쓴다 | (a)(b) 그대로 지킨다. (c)는 「승인은 항상 run 안에서 일어난다」로 고친다 | 새 도구 1·새 trigger 1·새 scope 1(U-b)·hold 값 1. job·handle·outbox는 없다. 선례가 있다(U-0 4) |
| A4 handle 선택화 | `oort_action_propose`가 handle 대신 `channelId`를 받는다 | A3와 같다 | 도구는 늘지 않지만 `required`가 흔들려 기존 계약 시험과 모델의 사용 규칙이 바뀐다. 더 나쁜 점은 이미 `workspace:propose`를 승인한 연결이 새 scope 없이 먼저 제안하게 된다는 것이다. 사람이 동의 화면에서 읽은 「요청받았을 때의 제안」을 조용히 넓힌다 |
| A5 클라이언트 실행 | 에이전트는 카드만 남기고, 사람이 누르면 클라이언트가 REST를 부른다 | §2가 이미 기각했다 | 「에이전트가 제안했다」 감사가 없고 폰·다른 기기에서 결정할 수 없다 |

**권장: A3.** 이유는 셋이다. 첫째, `approval.run_id NOT NULL`·만료 스윕·레일·원장·결정 라우트·`oort_run_complete` 가드를 하나도 건드리지 않는다. DDL은 U-b의 scope 어휘 CHECK 재작성 한 건뿐이다. 둘째, 선례가 있어 새 상태가 없다. 셋째, 새 능력에 새 이름(도구·scope)이 붙어서 기존 연결이 조용히 넓어지지 않는다.

**A3 계약**
- 입력은 `{clientRequestId, actionId, args, rationale?}`다(`additionalProperties:false`). `clientRequestId`는 uuid 필수다. handle·채널·수신자·카드 자리를 받는 키는 없다.
- 한 트랜잭션(`momo_db::with_tenant_tx`)에서 차례로 한다. ① 에이전트 `member` 행 잠금(대기·속도 계산을 직렬화한다. 기존 `lock_agent_and_count_pending_workspace_actions_in_tx`와 같은 잠금) ② 문 조건(U-b-4) ③ 인자 검증·해석(기존 `validated_action_args`·`resolve_action_in_tx`. 이름·핸들·채널을 서버가 해석한다, V1-a/b) ④ 대기·속도·중복 검사(U-d) ⑤ 위 조건이 **모두 통과한 뒤에만** 소유자 1:1 DM을 멱등으로 연다(U-c) ⑥ run을 `awaiting_approval`로 태어나게 한다(`create_held_agent_run_in_tx`, 새 trigger) ⑦ 승인 INSERT(`payload.origin="agent_initiated"`) ⑧ 카드(`send_message_in_tx`) ⑨ 감사. 하나라도 실패하면 전부 없다.
- run은 `trigger_message_id`가 NULL이고 `input = {"hold":"agent_initiated"}`다. `agent_run.input`에는 에이전트가 쓴 문자열이 없다. 새 trigger `RunTrigger::AgentInitiated { agent_member_id, client_request_id }`의 멱등 키는 `agent_initiated:<AGENT>:<ID>`다(`agent_run_idem_uniq`가 DB에서 중복을 막는다). job·outbox `gateway` 행·인박스 `agent_job` 참조는 0이다.
- **수명은 서버가 소유한다.** 에이전트에게는 이 run을 닫거나 갱신할 handle이 없다. 승인 → `succeed_parked_run_in_tx`, 거절 → `cancelled`, 만료 → `timed_out{approval_expired}`, 사람의 run 취소 → 기존 경로다. 만료 줄은 답할 트리거 메시지가 없어 조용하다(`approval_sweep.rs`의 기존 규칙).
- **동시 실행 상한에서 뺀다.** `live_run_count_in_tx`의 hold 술어를 `IN ('channel_grant','agent_initiated')`로 넓힌다. 빼지 않으면 먼저 제안 카드 하나가 소유자의 응답을 기다리는 동안 그 에이전트의 work 요청이 409가 된다(U-0 5).
- 응답은 `{approvalId, status:"pending", expiresAtMs, cardMessageId}`다. 같은 `clientRequestId`로 다시 부르면 지금 상태를 돌려준다(U-f). 같은 id에 다른 `actionId`·`args`면 `Conflict`다. 비교는 승인 payload의 정규화 인자와 pins로 한다(run `input`은 상수라 비교할 수 없다. 충돌을 409로 답하는 모양만 work 요청의 `client_run_id` 규칙을 따른다, `agent_runs.rs:381-389`).
- 도구 설명문(모델이 읽는 곳)에는 네 가지를 못박는다. 아무도 부탁하지 않은 일에만 쓴다. 소유자가 DM 카드에서 결정한다. 거절된 제안을 같은 모양으로 다시 올리지 않는다. 카드를 올린 뒤 턴을 끝내고 결과는 같은 `clientRequestId`로 확인한다. 키워드는 골든 시험으로 잠근다(`agent_conversation_rules.rs` 방식).

**시험 의무 (ADR-0214: 아래는 해당 분기를 지우면 빨개져야 한다)**
- `approval.run_id`는 마이그레이션 뒤에도 `NOT NULL`이다(스키마 시험).
- 한 호출은 run 1·approval 1·카드 1이고 job·outbox `gateway`·인박스 `agent_job` 참조는 0이다. 카드 쓰기를 실패시키면 run·approval·새 DM이 0이다(트랜잭션 경계를 지우면 실패).
- 에이전트의 어떤 도구도 이 run을 닫거나 바꾸지 못한다. 다른 run의 handle로도 닿지 않는다.
- 만료 스윕이 이 run을 `timed_out{approval_expired}`로 끝내고, 어떤 스톨 스윕(`run_stall_sweep`)도 건드리지 않는다. 트리거 메시지가 없어도 스윕이 정상 종결한다.
- **대기 중 `agent_initiated` run이 있어도 work 요청이 상한에 막히지 않는다**(hold 술어를 되돌리면 실패).
- 같은 `clientRequestId` 재호출은 run 1·approval 1이다.
- 이 run에서 `member.avatar.set`·`oort_card_suggest`는 거절된다(트리거 메시지 없음).
- 회귀: `oort_action_propose`의 `required`는 `handle`을 그대로 포함한다.

### U-b. 누가, 무엇까지 (이슈 D-b)

**U-b-1. 허가를 어디에 적나**

| 안 | 모양 | 장점 | 비용 |
|---|---|---|---|
| **P1 연결 scope (권장)** | 새 scope `workspace:initiate`. 관리자가 연결을 confirm(또는 OAuth consent)할 때 한 번 승인한다. 기본 요청에는 넣지 않는다 | ADR-0162 D3·D4의 방식 그대로다. `tools/list`가 토큰∩승인 교집합만 보이므로 허가 없는 연결에는 도구가 목록에도 호출에도 없다(unknown tool). 기존 연결은 승인 범위가 그대로라 조용한 승격이 없다. 「이 연결이 무엇을 할 수 있나」를 승인 화면 한 곳에서 읽는다 | hosted scope CHECK 3개(069·074·074) 재작성 migration 1건(087 방식), Rust 상수 `HOSTED_AGENT_SCOPES`(`momo-auth/src/hosted_connection.rs:32`, 7개에서 8개로)와 OpenAPI `HostedAgentScope`·`momo-mcp` scope 시험·동의 화면 줄(`hostedAgents/model.ts`·`approval.ts`), ADR-0162 D3 닫힌 표 한 줄. 바꾸려면 재연결이다 |
| P2 에이전트 열 | `agent.initiative_enabled boolean NOT NULL DEFAULT false`(134 `thread_reply_wake` 선례). 기존 `workspace:propose`로 도구가 보이고 호출 때 열을 증명한다. 소유자·admin이 프로필 PUT 선택 필드로 켜고 끈다 | CHECK 무접촉. 아무 때나 켜고 끌 수 있다. 재연결이 필요 없다 | 능력이 자격증명에 적히지 않아 승인 화면에서 읽을 수 없다. `workspace:propose`를 가진 연결의 도구 목록에는 꺼져 있어도 늘 보여 모델이 시도한다. 재연결 때 값을 되돌리는 규칙이 따로 필요하다 |
| P3 워크스페이스 스위치만 | 에이전트별 구분 없음 | 가장 단순하다 | 한 에이전트를 열면 모두 열린다. 기각 |

**권장: P1.** 이유는 이 문이 Agent Port에서 처음 생기는 「시키지 않아도 사람을 부르는」 능력이라는 점이다. Agent Port의 능력은 지금까지 전부 사람이 승인한 scope로 자격증명에 적혀 왔다(`workspace:propose`·`messages:write` 등). 이번만 열에 적으면 「이 연결이 할 수 있는 일」이 두 곳으로 갈린다. P1의 비용(CHECK migration, 재연결)은 087이 한 번 치른 모양 그대로이고, planner 연결(#4616)을 이 기능이 나온 뒤에 하면 재연결 마찰도 없다. 먼저 했다면 한 번 다시 연결한다. 순간 끄기는 U-b-3의 끄개와 에이전트 정지가 맡는다.

**U-b-2. 먼저 제안이 닫힌 목록 (정의는 한 곳)**

레지스트리 `WorkspaceAction`에 필드 `initiative: bool`을 둔다(D1: 정의는 한 곳). `oort_action_initiate`의 `actionId` enum과 OpenAPI enum은 거기서 파생되고, 드리프트 시험이 셋을 잰다(`the_action_ids_are_one_list_in_three_places`와 같은 자리).

| 행동 | 먼저 제안 | 이유 |
|---|---|---|
| `channel.create` | 허용. **`kind`는 `private`만** | 공개 채널은 워크스페이스 전체에 보이는 면이라 사람이 시킬 때만. `addProposer`(기본 true)는 허용한다(V3). 이 행이 에이전트의 읽기 범위를 새 채널 하나만큼 넓히므로 카드의 「이 에이전트도 참여」 행을 늘 보인다(Q4) |
| `channel.member.add` | 허용 | 에이전트가 볼 수 있는 채널에 한하고 역할은 `member` 고정(V1·V2). 카드가 서버가 해석한 이름을 보인다 |
| `message.pin` | 허용 | U-e |
| `message.unpin` | 허용 | U-e |
| `hosted.channels.grant` | **제외** | 이미 있는 채널로 에이전트가 자기 읽기 범위를 넓히는 유일한 길이다(V5가 가장 좁게 둔 이유). 시키지 않았는데 청하는 것은 권한 상승의 정석이다 |
| `agent.rename`·`agent.profile.update` | 제외 | 신원·사칭 표면이고 다른 에이전트가 대상이 될 수 있다(V4·V4-M) |
| `agent.invite` | 제외 | 새 에이전트를 데려오고 연결 코드가 따른다 |
| `invite.create` | 제외 | 가입 자격(1회 시크릿)이다 |
| `workspace.settings.update` | 제외 | 환영 문구는 다른 에이전트의 지시문이다(V7) |
| `member.avatar.set` | 제외 | 사람의 얼굴이고 요청자가 필요하다. 트리거 메시지가 없는 run에서는 구조적으로 불가능하다(U-0 9) |
| `member.role.set`·`webhook.create` | 해당 없음 | 실행기가 없다 |
| 팀 AI 전용 4종 | 해당 없음 | 에이전트 포트에서 제외(기존) |

1회 시크릿을 만들거나(`secret_delivery`가 `None`이 아닌 행동) 에이전트·지시문·읽기 범위를 건드리는 행동은 `initiative`가 켜지지 않는다. 시험이 이 불변식을 레지스트리 전수로 잰다.

**U-b-3. 관리자 끄개 (이슈 D-d의 kill switch)**

| 안 | 모양 | 판정 |
|---|---|---|
| **K1 설정 키 (권장)** | 워크스페이스 설정 bag의 불리언 키 `agent_initiative`(없으면 켜짐). admin이 기존 설정 REST로 바꾼다. `ALLOWED_SETTINGS_KEYS`와 `validate_settings_value`에 한 줄 | 즉시 효력, DDL 없음, 선례(`team_ai_fast_path`)가 있다. **에이전트의 `workspace.settings.update`는 이 키를 바꾸지 못한다**(허용 키는 두 개뿐) |
| K2 운영자 환경변수 | 인스턴스 전체 | 재시작이 필요하고 워크스페이스 admin이 만질 수 없다 |
| K3 에이전트 정지만 | 기존 `agent_profile.paused` | 있는 장치지만 그 에이전트의 모든 도구가 같이 멎는다. 보조 수단으로 남는다 |

끄면 새 `oort_action_initiate`는 모두 같은 `Unavailable`이고(감사 reason `switch_off`), 이미 올라온 카드는 결정 때 재증명에서 걸려 실행되지 않는다(U-d 「재증명」 행). 거절은 언제나 가능하다.

**U-b-4. 먼저 제안이 열리는 조건 (모두 만족해야 한다. 1~6이 아니면 에이전트에게는 같은 `Unavailable`, 7이 아니면 `Conflict`)**
1. 연결이 active·증명됐고 `workspace:initiate`가 토큰과 승인 양쪽에 있다(도구 가시성이 걸러 주지만 호출 안에서 다시 증명한다. ADR-0162 증보 4 J2 방식).
2. 에이전트가 활성이고 정지 상태가 아니다.
3. 워크스페이스 끄개가 켜져 있다.
4. 에이전트에게 활성 사람 소유자가 있고 그 연결을 confirm한 사람이 소유자다. 소유자 DM이 이 연결에 덮이는 조건(증보 2 B6-1)과 같은 술어를 쓴다.
5. 소유자가 **지금** 이 행동의 역할 게이트를 통과한다(`Admin`이면 소유자가 워크스페이스 admin). 죽은 카드를 올리지 않기 위한 사전 거절이다. 보안 경계는 결정 때의 게이트다.
6. 행동별 조건. 카드에 나오는 채널은 소유자가 이미 볼 수 있어야 한다(공개 채널이거나 소유자가 live 멤버). 카드가 소유자에게 비공개 채널의 이름이나 내용을 처음 알려 주면 안 된다. `message.pin`·`message.unpin`은 더 좁게, 소유자가 대상 메시지 채널의 live 멤버여야 한다(승인자 명의로 실행하므로, U-e).
7. 대기·속도·중복 한도 안이다(U-d).

에이전트가 소유자의 역할이나 연결 구성을 더듬을 수 없게(V1-b) 1~6은 한 가지로 답한다. 7은 에이전트 자신의 몫이라 숨길 것이 없어 `Conflict`로 답한다. 운영자는 감사 reason으로 구분한다(U-d).

### U-c. 카드가 서는 곳 (이슈 D-c)

| 안 | 모양 | 장점 | 비용 |
|---|---|---|---|
| **C1 소유자 1:1 DM (권장)** | 서버가 정한다. 에이전트는 채널을 지정하지 않는다 | 소유자만 본다. 비공개 채널 이름·구성원이 새지 않고 공개 채널에 소음이 없다. 결정자 = DM의 유일한 사람 = 소유자라서 결정 라우트의 멤버십 게이트(`approvals.rs:766`)와 맞는다. 증보 2 B2로 DM이 연결에 자동으로 덮여 에이전트가 결과 줄을 읽을 수 있다 | 소유자가 결정할 수 없는 행동은 죽은 카드가 되므로 사전 거절한다(U-b-4 5). 닫아 둔 DM도 새 카드의 seq가 워터마크를 넘어서 다시 보인다(기존 DM 규칙). 이 문은 U-d의 한도와 끄개가 묶는다 |
| C2 에이전트가 속한 채널 | 에이전트가 채널을 지정한다 | 그 채널의 admin 여럿이 결정할 수 있다 | 채널 전체에 소음과 내용 노출이다. 소음 자리를 에이전트가 고른다. 결정자는 그 채널 멤버여야 해서 admin이 없는 채널은 죽은 카드다 |
| C3 별도 승인함 | 새 표면 | — | 새 채널 종류·화면·푸시가 필요하고 `approval.channel_id NOT NULL`·멤버십 게이트와 부딪힌다. 대기 승인은 이미 인박스 응답에 합쳐진다(ADR-0199 D2·D6 `approvalsPending`) |

**권장: C1.** 규칙은 다음과 같다.
- **DM은 서버가 열고, 모든 조건이 통과한 뒤에만 연다.** `with_tenant_tx`는 처리된 거절에서도 커밋하므로(`agent_port_tools.rs:2199` 주석), 순서가 곧 보안이다. 거절된 호출이 DM을 남기면 안 된다. 대안은 「소유자가 먼저 연 DM에만 올린다」(C1-b)다. 더 보수적이지만 터미널의 에이전트가 처음 제안하는 날 소유자가 DM을 한 번도 열지 않았다면 첫 제안이 이유 없이 `Unavailable`이 되고, 에이전트는 그 이유를 알 길이 없다(V1-b). 그래서 서버가 소유자와 에이전트 쌍의 DM 하나를 멱등으로 연다(쌍 유일 인덱스). 결과를 숨기지 않는다. 허가가 있는 에이전트는 이 DM에 기존 `oort_message_post` 규칙으로 쓸 수 있게 된다. 새 쓰기 권한은 아니다. 같은 에이전트가 승인 채널에는 이미 승인 없이 쓴다.
- **카드에는 출처가 보인다.** `payload.origin="agent_initiated"`를 props `origin`으로도 싣는다. 클라이언트는 「먼저 제안」 표시를 그린다. 제안자는 카드 작성자(에이전트)로 이미 보이며 props에 이름을 굽지 않는다(인플레이스 카드와 같은 이유, 이름 변경 뒤 낡는다). 요약문은 서버가 정한다.
- **사유는 에이전트가 쓴 글이다.** 시킨 사람이 없어 에이전트의 문장이 유일한 설득 수단이라 사칭 표면이다. 먼저 제안의 `rationale`은 ≤140자이고 `agent.profile.update` tagline 규칙(제어·서식 문자, `@ < > [ ] ( ) : /` 거절, V3-2)을 재사용한다. 카드는 평문으로 「에이전트가 쓴 글」이라는 꼬리표와 함께 보인다. 서버가 해석한 행(rows)이 진실의 원천이다.
- **항상 앱에서 연다.** `opens_in_app`이 `payload.origin == "agent_initiated"`에 true를 낸다(이미 투영된 키 `origin`만 읽는다). 시킨 일이 아니라서 잠금 화면의 승인 버튼으로 결정하지 않는다.

**시험 의무**: 에이전트가 채널·수신자를 지정하는 키는 스키마에 없다(알 수 없는 키 → `InvalidArguments`). 카드는 소유자 DM에만 서고 DM 밖 누구도 결정·미리보기를 못 한다(비멤버 admin은 거절된다. 현행은 403이고, 인플레이스 카드처럼 404로 숨기는 분기(`approvals.rs:771-780`)는 구현 슬라이스의 후속 선택이다). 거절된 호출은 새 DM을 남기지 않는다(DM 열기를 앞으로 옮기면 실패). 링크·멘션·마크다운이 든 `rationale`은 거절된다. `opens_in_app`이 `agent_initiated`와 `message.pin|unpin`에 true다(푸시 투영 시험의 표와 같은 자리).

### U-d. 남용 방지 (이슈 D-d)

V3-6은 owner가 제안 속도 제한을 기각한 기록이다(인사 시즌에는 많이 필요할 수 있다는 이유). 그 근거는 연결·초대가 매번 사람 승인이고 승인 전 폭주는 대기 3개가 막는다는 것이었다. 먼저 제안은 두 가지가 다르다. 사람이 부른 적이 없어 요청의 맥락이 없고, 거절·만료 뒤 같은 에이전트가 새 run으로 다시 올릴 수 있어서 대기 상한이 시간 축으로는 아무것도 막지 못한다. 그래서 **먼저 제안에만** 상한을 둔다. 사람이 시킨 제안(handle 경로)은 V3-6 그대로 상한이 없다.

| 층 | 규칙 | 값·이유 |
|---|---|---|
| 문 | U-b-4의 일곱 조건. 끄개·정지·연결 해제로 즉시 닫힌다 | — |
| 대기 | 에이전트당 대기 승인은 기존 합계 3개(`MAX_PENDING_WORKSPACE_ACTIONS`)에 먼저 제안도 **센다**(`server_in_place`만 빼는 기존 술어를 유지한다). 그 안에서 먼저 제안 대기는 2개까지다 | 먼저 제안이 사람이 시킨 제안을 밀어내지 않게 한다 |
| 속도 | 에이전트당 시간당 6·하루 20 [추정]. `agent_run`에서 `agent_initiated:<에이전트>:` 키의 행 수를 DB에서 센다(재시작·복제본에 안전). 한도 거절 자체는 세지 않는다(V4-10 5 방식). 환경변수로 봉인한다(`MOMO_AGENT_INITIATIVE_PER_HOUR`·`_PER_DAY`) | 숫자는 owner 질문 5 |
| 중복 | 같은 (에이전트, 행동, 서버가 해석한 정규화 인자)가 대기 중이면 `Conflict`다. 거절된 뒤 24시간도 `Conflict`다. 만료 뒤에는 다시 올릴 수 있다. 사람이 시킨 제안(handle 경로)에는 이 쿨다운이 없다 | 거절은 사람의 「그만」이다. 비교는 jsonb 동등이고 에이전트가 쓴 문자열이 아니라 `pins`까지 포함한 해석값으로 한다 |
| 수명 | 먼저 제안 카드의 TTL은 24시간이다 [추정] (`MOMO_AGENT_INITIATIVE_TTL_HOURS`) | 기본 1시간(`approval.rs:76`)은 승인 대기 run이 동시 실행 상한을 쥐는 비용 때문이었다(`approval.rs` 머리말). 먼저 제안 run은 상한에서 빠져(U-a) 그 비용이 없다. 소유자가 자리에 없을 때 올라온 카드가 곧바로 사라지지 않게 한다. 오래된 카드의 위험은 결정 때 재증명이 막는다 |
| 재증명 | 승인 때 기존 V1-d에 더해 ① 끄개가 켜져 있다 ② 제안 에이전트가 활성·미정지이고 연결이 active·증명됐으며 `workspace:initiate`가 승인 범위에 있다 ③ 결정자가 에이전트의 **현재** 소유자다 ④ 행동이 아직 `initiative` 목록에 있다. 하나라도 어긋나면 기존 `action_args_invalid`(409, 승인 소모 없음)다. **거절은 항상 가능하다** | 새 영수증 어휘를 만들지 않는다(V1-d) |
| 끄기 | 끄개 · 에이전트 정지 · 연결 해제. 끄개를 꺼도 대기 카드를 일괄 취소하지는 않는다. 재증명이 실행을 막고 TTL이 정리한다 | 일괄 취소는 쓰기 경로를 하나 더 만든다 |

**감사(닫힌 어휘, 본문 없음)**
- `agent.initiative.opened`: 행위자 에이전트, 대상 소유자. detail은 `{schema:"momo.agent.initiative.v1", action_id, approval_id, run_id, dm_created}`뿐이다.
- `agent.initiative.refused`: detail은 `{schema, action_id(닫힌 목록 또는 "other"), reason}`다. `reason ∈ {switch_off, no_owner, owner_cannot_decide, target_unavailable, rate_limited, pending_full, duplicate, cooldown, invalid_arguments}`. 같은 (에이전트, reason)당 시간당 1행으로 합친다(홍수 방지). `agent_port.call`(ADR-0200 증보 4)은 도구 이름과 결과 코드만 담고 자격당 시간당 240행에서 멈추므로 합친 행의 대체물이 아니다. 합쳐서 가려지는 횟수는 후속에서 다음 창의 첫 행에 싣는 방안을 본다.
- 결정은 기존 `action.approved`·도메인 행·`approval.rejected`·`approval.expired`에 `origin:"agent_initiated"` 키를 더한다.
- 어느 행에도 인자 값·`rationale`·메시지 본문·채널 이름이 없다(V6 기조: 키 이름과 id만).

**시험 의무**: 시간당·하루 한도의 경계(N번째 통과, N+1번째 거절)와 한도 거절이 창을 늘리지 않는다는 것을 시간 주입으로 잰다. 먼저 제안 대기가 2개여도 사람이 시킨 제안은 선다(합계 3 중 1을 남기는 분기를 지우면 실패). 같은 제안 대기·거절 24시간·만료 뒤 허용을 각각 잰다. 재증명 네 항목이 각각 `action_args_invalid`와 승인 pending 유지를 낸다. 끄개를 끈 뒤 올라온 카드를 승인하면 실행이 0이다(재증명을 지우면 채널이 생겨 실패). 감사 어느 행에도 인자·사유·이름이 없다(grep 시험).

### U-e. 메시지 고정 행동 (이슈 D-e)

사람의 고정 경로가 이미 있다(U-0 7). 필요한 서버 작업은 새 도메인 함수가 아니라 **같은 함수를 승인자 명의로 부르는 실행기**다. 모자란 것은 ① 레지스트리의 행동 둘 ② 에이전트 쪽 대상 해석 ③ 감사 writer(`record_interaction_audit`, 지금은 `routes/messages.rs`의 비공개 함수)를 실행기에서 부를 수 있게 여는 일이다.

**어휘와 인자**

| id | args | 위험 | 승인자 | 실행 |
|---|---|---|---|---|
| `message.pin` | `{messageId}` | `approval` | `admin` | `set_pin_in_tx(…, 승인자, Pinned)` |
| `message.unpin` | `{messageId}` | `approval` | `admin` | `set_pin_in_tx(…, 승인자, Unpinned)` |

- `messageId`는 `oort_conversation_read`나 `oort_message_post`가 내는 메시지 id다(U-0 2). 채널·작성자·본문은 서버가 id로 읽는다. 에이전트가 쓴 문자열이 카드의 대상 표시가 되는 길은 없다(V1-a). 인자는 이것 하나이고 채널·URL·본문 키는 스키마에 없다.
- **대상 조건**: 아래가 하나라도 아니면 모두 같은 `InvalidArguments`다(V1-b: 존재를 더듬을 수 없다). 메시지가 있고 삭제되지 않았다 · 채널이 연결의 승인 채널(덮이는 DM 포함)이고 에이전트가 live 멤버다 · 채널이 보관되지 않았다 · 메시지 종류가 `text`다(승인 카드·결과 줄·시스템 줄은 상태가 바뀌므로 고정 대상이 아니다) · `message.unpin`은 지금 고정돼 있다.
- **카드를 보는 사람이 이미 볼 수 있는 것만 싣는다.** 카드 행에는 메시지 발췌·쓴 사람·채널 이름이 들어가고 카드는 영속 props다. handle 경로에서는 카드가 run의 채널에 서므로 대상 메시지가 **그 run의 채널 안**에 있어야 한다(다른 승인 채널의 메시지면 같은 `InvalidArguments`). 먼저 제안에서는 카드가 소유자 DM이므로 소유자가 대상 채널의 live 멤버여야 한다(U-b-4 6. 결정 때 다시 증명한다). 그렇지 않으면 승인자가 대상 채널의 비멤버라서 고정이 막히기 전에 카드가 이미 다른 채널의 내용을 사람들에게 흘린다.
- **핀(재증명 키)**: `pins = {message, channel, bodySha256}`. 키 이름을 `target`으로 하지 않는 것은 `pins.target`을 멤버 id로 읽는 곳이 있어서다(`decider.rs`의 `pinned_target_agent`, `approval.rs`의 `lock_target_and_find_pending_action_in_tx`). 결정 때 서버가 메시지를 다시 읽어 본문 해시·채널·삭제 여부가 같은지 확인하고, 어긋나면 `action_args_invalid`(승인 소모 없음)다. 승인자가 읽은 것과 고정되는 것이 같아야 한다. 본문이 없는 메시지(첨부만)는 첨부 id 목록을 해시에 넣는다.
- **카드 행**(서버가 읽은 값): 채널(이름·공개 범위), 쓴 사람, 쓴 시각, 내용 앞 120자(평문), 지금 고정 수/100. `message.unpin`은 고정한 사람·시각을 보인다. 항상 앱에서 연다(`opens_in_app`에 추가. 메시지는 배너로 판단할 수 없다. V4-1 7과 같은 이유).

**사람 경로와 같은 함수를 쓰나: 쓴다.**
- 실행은 승인자의 멤버 id로 `set_pin_in_tx`를 부른다. 그래서 사람이 손으로 하는 고정과 가드가 같다. 승인자가 대상 채널의 활성 멤버여야 하고, 삭제된 메시지는 고정되지 않으며, 한 채널 100개 한도(채널 advisory lock과 062 트리거)와 방송 `message.pinned`·`message.unpinned`가 같다. `pinned_by`는 승인자이고, 에이전트가 제안했다는 사실은 감사에 남는다.
- 승인자가 대상 채널의 멤버가 아니거나 100개를 넘으면 실행기는 쓰기 0으로 기존 `action_args_invalid`(409, 승인 소모 없음)로 답한다. 이미 고정돼 있으면 사람 경로처럼 no-op 성공이다.
- 에이전트 bearer가 고정 REST를 직접 부르는 길은 열지 않는다. 이 증보는 `agent_scope.rs` 표를 건드리지 않는다.

**승인이 필요한가**

| 안 | 모양 | 판정 |
|---|---|---|
| **E1 승인 필요 (권장)** | D3 그대로. 고정·해제 모두 승인 카드 | 고정은 채널 머리의 신뢰 표면이다(고정이 보증처럼 읽힌다). 승인이 없으면 에이전트가 사람의 글(프롬프트 주입으로 심은 글 포함)을 끌어올리거나 100개 한도를 채워 사람의 고정을 막을 수 있다. 무승인 위임은 아직 ADR이 없다(V7) |
| E2 자기 글만 무승인 | 에이전트가 쓴 메시지의 고정만 승인 없이 | owner 시나리오(안내문 고정)에서 탭 하나를 아낀다. 그러나 「에이전트가 쓴 글인가」라는 판정 하나로 고정 면이 열리고 한도 채우기는 그대로 가능하다. 위임 ADR이 생길 때의 첫 후보로 둔다 |
| E3 전부 무승인 | — | 기각. D3와 V7에 반한다 |

반대 논거도 적어 둔다. 고정은 되돌리기 쉽다(채널 멤버 누구나 풀 수 있다). 사람도 이미 손으로 한다. 그래서 위험이 가장 낮은 승인 행동이고, 무승인 위임이 생기면 첫 후보다. 승인 한 번의 비용은 owner 시나리오에서 탭 하나다(채널 만들기 한 번, 고정 한 번).

**승인자 역할: `admin` (v1).** 대안은 「대상 채널의 멤버면 누구나」(사람이 손으로 하는 권한과 같다)다. 이 역할은 새 `RequiredRole`과 `GatePlan` 갈래, 푸시 대상 판정, TS `actionRole.ts` 표를 함께 늘려야 하고(V4-3 전례), `execute_workspace_action`이 역할 없는 workspace action을 프로토콜 오류로 다루는 현재 불변식(`approvals.rs:1457-1461`)과도 부딪힌다. 기존 `Admin`을 재사용하면 게이트 코드가 0이다. 넓히는 일은 필요가 보일 때 별도 증보로 한다.

**감사**: 사람 경로와 같은 도메인 행 `message.pinned`·`message.unpinned`(같은 writer)와 `action.approved`가 쓰인다. 도메인 행 detail에 `via_agent`·`approval_id`와 먼저 제안일 때의 `origin`을 더한다. 메시지 내용은 싣지 않는다(id와 채널 id만).

**시험 의무**: 비-admin 결정자는 403 `role_required`이고 고정 0이다. 승인자가 대상 채널의 멤버가 아니면 `action_args_invalid`·고정 0·승인 pending이다. 승인 전에 메시지가 수정되거나 삭제되면 `action_args_invalid`다(해시 핀을 지우면 실패). 수정이 없으면 고정되고 방송 `message.pinned` 1건, 감사 2행(`action.approved` + `message.pinned`)이다. 에이전트가 볼 수 없는 채널·덮이지 않는 DM·없는 id·삭제된 메시지·`text`가 아닌 메시지는 같은 `InvalidArguments`다. **교차 채널 카드는 0이다**: handle 경로에서 run 채널 밖의 메시지는 같은 `InvalidArguments`이고 카드가 서지 않는다(채널 조건을 지우면 다른 채널의 내용이 카드에 실려 실패). 먼저 제안에서 소유자가 멤버가 아닌 채널은 `Unavailable`이고 run·승인·새 DM이 0이다. 101번째 고정은 `action_args_invalid`(승인 소모 없음)이고 이미 고정된 메시지는 no-op 성공이다. 에이전트 bearer가 `PUT …/pin`을 직접 부르면 계속 거절된다(기존 시험 유지). 드리프트: `ACTIONS` id 집합 = 도구 enum = OpenAPI enum(11개).

### U-f. 실행 뒤 알림 (이슈 D-f)

**빈칸은 먼저 제안만의 것이 아니다.** 결과 줄(승인·거절·만료)은 인박스에 투영되지 않고(U-0 6) 깨울 신호도 없다. 지금 모든 `workspace_action`의 결과는 에이전트가 스스로 깨어나 대화를 다시 읽어야만 보인다. V6의 「다음 턴에 `oort_conversation_read`로 읽는다」는 깨울 신호가 있어야 성립하는 문장이었다. 사람이 run을 취소할 때만 `agent_run` 참조가 간다(`agent_runs.rs:1364`).

| 안 | 모양 | 판정 |
|---|---|---|
| F1 결과 줄만 (현행) | 변경 없음 | 깨움이 없고, 소유자 DM이 연결에 덮이지 않으면 읽을 수도 없다 |
| **F2 인박스 참조 + 같은 id 재호출 (권장)** | 사람이 승인·거절할 때 제안 에이전트의 활성 hosted 연결에 `agent_run` 인박스 참조를 같은 트랜잭션에 쓴다. 만료는 쓰지 않는다. `oort_action_initiate`를 같은 `clientRequestId`로 다시 부르면 지금 상태를 돌려준다. 결과 줄은 그대로다 | 새 도구·새 이벤트 종류가 없다. 도어벨이 인박스 증가에 울리므로(ADR-0171) 루틴이 깨어난다. 사람이 시킨 제안도 같은 혜택을 받는다. 루틴은 `agent_run`을 「이 run의 상태가 바뀜」로 읽는다(`docs/SELF_HOST_AGENT.md`는 kind와 channelId만 준다고 적는다). 문서 한 줄을 더한다 |
| F3 읽기 도구 `oort_action_status` | 새 도구 | 의미가 또렷하다. 그러나 도구가 15개가 되고 닫힌 표에 한 줄과 새 읽기 면이 생긴다. F2의 재호출이 같은 답을 주므로 얻는 것이 적다 |

**권장: F2.** 세부는 다음과 같다.
- **쓰는 곳은 결정 라우트의 승인·거절 arm 둘과 이미 있는 사람 취소다.** 셋 다 `momo_app` 역할의 요청 트랜잭션이다. 제안자의 활성 hosted 연결이 있고 run의 채널이 그 연결에 덮일 때만 쓴다(`append_run_reference_in_tx`의 기존 권한 술어). 아니면 조용히 0건이다. 관리형 에이전트는 회귀가 0이다.
- **만료는 쓰지 않는다.** 만료를 정하는 notifier 스윕은 `momo_notifier` 역할로 도는데, 인박스 참조의 권한 술어는 `token`·`agent_profile`·`workspace_membership`을 JOIN해 `FOR SHARE`로 잠그고(`hosted_inbox.rs:527-559`) 인박스 두 표에 INSERT/UPDATE한다(`:564-648`). 운영 역할 파일은 notifier에 `hosted_agent_connection`의 열 8개 읽기만 주고, `token`은 BYPASSRLS 역할이 자격증명을 읽지 않도록 일부러 뺐으며, 인박스 표 grant는 없다(`infra/rust/sql/bootstrap_runtime_roles.sql:655-690`). grant를 여는 것은 AGENTS.md의 BYPASSRLS 예외 원칙에 어긋난다. 운영 역할 grant로 시험하지 않으면 초록이어도 운영에서는 `permission denied`가 되고, 스윕이 워크스페이스당 한 트랜잭션이라 그 워크스페이스의 만료 전부가 롤백되어 run이 `awaiting_approval`에 박힌다(`approval_sweep.rs:7-16`, `:124-155`). 또 만료는 사람이 아무 말도 하지 않은 일이다. 깨우면 에이전트가 사람 없이 새 제안을 올리는 24시간 주기 반복이 생길 수 있다(U-d는 만료 뒤 재제안을 허용한다).
- **만료는 재호출이 파생해서 말한다.** `status='pending'`이고 `expires_at`이 지났으면 스윕 전이라도 재호출 응답은 `expired`다. 에이전트는 깨우는 신호 없이도 자기 `clientRequestId`로 언제든 확인할 수 있다.
- 재호출 응답은 `{approvalId, status, expiresAtMs?, decidedAtMs?, ref?}`다. `status ∈ {pending, approved, rejected, expired, cancelled}`이다. `ref`는 `approved`일 때만 `{type, id}`다(채널 id·메시지 id 같은 비밀 아닌 값, `agent_run.output.ref`). 비밀 값은 어떤 경우에도 없다(먼저 제안 목록에는 1회 시크릿 행동이 없다). 응답은 호출한 에이전트 자신의 제안만 말한다(키가 에이전트별이다).
- 결과 줄 본문에 채널 id가 평문으로 들어가는 현행(`channel_create_result_body`)은 유지한다.
- 이 참조의 원인은 사람의 결정이라 에이전트 자기 발화가 자기 인박스와 도어벨을 도는 순환(ADR-0171 Q-LOOP)이 아니다. 결과를 받을 때마다 새 제안을 올리는 루틴이 있어도 U-d 한도가 묶는다.
- owner 시나리오의 흐름: planner가 `channel.create`(비공개 `qa`)를 먼저 제안한다 → owner가 DM 카드를 탭한다 → 인박스에 `agent_run`이 와서 깨운다 → 재호출이 `approved`와 `ref`(새 채널 id)를 준다 → 새 채널이 연결의 승인 채널에 이미 올라 있으므로(V3) `oort_message_post`로 안내문을 올린다 → 돌려받은 `messageId`로 `message.pin`을 먼저 제안한다 → 같은 방식으로 결과를 확인한다.

**시험 의무**: 승인·거절·사람 취소 각 한 번에 제안 에이전트 인박스에 `agent_run` 참조가 정확히 1건이다(재생해도 1건). 다른 에이전트 인박스는 0건이다. hosted 연결이 없는 제안자는 0건이다(관리형 회귀 0). **만료는 0건이다.** 스윕이 인박스 표를 쓰게 바꾸면 운영 역할 grant로 도는 시험이 실패해야 한다(이 슬라이스의 시험은 운영 역할 스위트로 돈다). `status='pending'`이고 `expires_at`이 지난 제안은 스윕 전에도 재호출이 `expired`로 답한다(파생을 지우면 실패). 재호출은 다섯 상태를 정확히 말하고 `approved`에서만 `ref`가 있다. 같은 id에 다른 내용이면 `Conflict`다.

### U-g. 사람 CLI 토큰과의 경계 (#4617)

사람 개발자 토큰(CLI·Claude Code·Codex가 쓰는 것)은 **사람의 권한 그대로** 일한다. 메시지 고정은 `PUT …/messages/{id}/pin`을 그 사람으로 부르면 되므로(U-0 7) 제안도 승인도 필요 없다. 이 증보의 문(`oort_action_initiate`)은 Agent Port의 에이전트 신원 전용이고, 사람 토큰으로는 열리지 않는다(Agent Port는 에이전트 bearer만 받는다). 사람 토큰의 범위·CLI 명령 규칙·로그인은 ADR-0216(#4617)이 정한다. 이 증보는 그 문서를 건드리지 않는다.

**이 경계에는 조건이 하나 붙는다.** 결정 라우트는 `PrincipalKind::Human` 자격이면 누구든 받는다(`approvals.rs:504-513`). 같은 터미널에 에이전트 신원(Agent Port)과 사람 개발자 토큰이 함께 있으면(planner가 그 예다), 주입된 에이전트가 자기 제안을 같은 프로세스의 사람 토큰으로 승인할 수 있다. 그러면 DM 카드·앱에서 열기·생체 확인이 모두 무의미해지고 「에이전트는 사람 승인 없이 바꾸지 못한다」가 거짓이 된다. 반대로 카드 글(에이전트가 쓴 것)이 소유자의 CLI 에이전트에 주입돼 승인을 유도할 수도 있다. 그래서 다음을 건다.
- **N3 머지의 선행 조건**: 개발자·CLI 토큰으로는 승인 결정을 하지 못한다. 승인은 사람이 앱(웹·데스크탑·폰)에서 하는 일이다. 판정은 두 결정 라우트(`decide_by_approval`, `decide_by_run`)가 함께 지나는 `decide()`(`approvals.rs:480`)에 둔다. 개발자·CLI 자격 종류를 principal에 실어 두고, 에이전트가 요청한 승인(최소한 `workspace_action` 전부)의 결정을 403으로 막는다. 잠금 화면 자격의 `credential_via`(`approvals.rs:802-813`)를 흉내 내서 표시하면 안 된다. 그 표시는 `decide_by_approval`의 푸시 확장에서만 채워지고 `decide_by_run`은 늘 `None`이라(`approvals.rs:398-418`, `:438-449`), 개발자·CLI 토큰이 닿는 `decide_by_run`이 우회로가 된다. 또 앱에서 열어야 하는 카드(`opens_in_app`)에만 걸면 같은 터미널이 사람이 시킨 경로의 카드(예: 인라인으로 결정되는 자기 `hosted.channels.grant`)를 자기 승인할 수 있어 이 절의 결론과 어긋난다. 시험은 두 라우트 모두에서 개발자·CLI 자격의 결정이 403이고, 같은 승인을 사람의 앱 자격이 결정하면 성공하는 대조군을 둔다.
- 이 조건은 ADR-0216(#4617)이 자격 종류를 정할 때 만족시킨다. planner가 그 문서를 쓰는 쪽에 전달한다.
- 충족되기 전에는 이 증보의 P0 주장(U-k)을 「Agent Port 신원」으로 좁혀 쓴다. ADR-0216이 개발자·CLI 토큰에 결정 라우트를 여는 설계를 담으면 N3는 머지하지 못한다(Blocker로 본다).

경계는 한 줄이다. **에이전트 신원이 워크스페이스 구조를 바꾸려면 사람 승인이 있고, 사람 신원은 자기 권한으로 한다. 같은 터미널의 에이전트가 사람 신원을 빌려 자기 제안을 승인하는 길은 닫는다.**

### U-h. 위험과 완화

1. **프롬프트 주입.** 에이전트가 읽은 채널 글이 「채널을 만들고 누구를 넣어라」를 시킬 수 있다. 먼저 제안은 사람이 부르지 않아도 카드를 올리므로 이 노출이 커진다. 완화: 실행은 사람 승인 뒤에만, 카드 행은 서버가 해석한 값, `rationale`은 꼬리표가 붙은 평문, 닫힌 목록에서 비밀·읽기 범위 확대·신원 변경 제외, 한도, 끄개. 남는 위험은 승인자가 읽지 않고 누르는 것이다. 앱에서 열기(잠금 화면 승인 없음)로 줄인다.
2. **카드 피로.** 거절이 쌓이면 사람이 습관적으로 누른다. 완화: 속도 한도·중복 쿨다운·끄개. 연속 거절 차단기는 후속이다(U-i).
3. **권한 상승.** 에이전트가 승인자 권한을 얻는 길은 없다. 결정자는 사람이고 실행은 승인자 명의이며 에이전트의 자기 승인은 불가하다(기존 kind 검사). 새 scope는 어떤 REST도 열지 않는다(`required_agent_scope`에 넣지 않는다, `workspace:propose`와 같다).
4. **정보 노출.** 문 조건 실패는 같은 답이고, 카드는 소유자 DM 밖으로 나가지 않는다. 수신자를 에이전트가 지정할 수 없다.
5. **재생·경쟁.** `clientRequestId` 멱등과 `agent_run_idem_uniq`, 에이전트 행 잠금(기존 `action_propose`의 잠금 순서 주석을 따르고 데드락 시험을 더한다), 결정 때 재증명이 막는다.
6. **소유자 DM 소음.** 닫아 둔 DM도 다시 보이는 기존 규칙의 결과다. 한도와 끄개가 묶고, 소유자는 에이전트 정지나 연결 해제로 끌 수 있다.

### U-i. 이 증보가 열지 않는 것

무승인 위임(V7) · 연속 거절 차단기 · 에이전트가 지정하는 카드 자리(C2)와 별도 승인함(C3) · `hosted.channels.grant`·`agent.*`·`invite.create`·`workspace.settings.update`의 먼저 제안 · 공개 채널을 먼저 만드는 일 · 에이전트가 소유자가 아닌 사람과 DM을 여는 일 · 팀 AI(oort 도우미)의 먼저 제안(팀 AI는 사람이 부른 run 안에서 일한다) · 사람 토큰 규칙(ADR-0216) · 카드·설정 화면 구현(UXUI 후속) · `docs/security/claims.yaml` 편집(정책 파일이라 구현 이슈가 owner audit과 함께 한다).

### U-j. 구현 슬라이스

한 슬라이스 = 한 이슈 = 한 브랜치·PR, base `track/engine`이다. 이슈는 owner 결재 뒤 planner가 만든다. 초안은 PR 본문에 있다.

| ID | 내용 | 선행 | 크기 |
|---|---|---|---|
| N1 | 결과 알림(U-f): 결정 라우트의 승인·거절 arm에서 제안자 `agent_run` 인박스 참조(만료는 쓰지 않는다), `SELF_HOST_AGENT.md` 문구. 시험은 운영 역할 grant로 | 이 ADR Accepted | S |
| N2 | `message.pin`·`message.unpin`(U-e): 레지스트리·대상 해석·실행기·핀 해시·감사 writer 공개·`opens_in_app`·OpenAPI·드리프트·도구 설명 | 이 ADR Accepted | M |
| N3 | 먼저 제안 서버(U-a~U-d): scope CHECK migration, `workspace:initiate`, `oort_action_initiate`, 레지스트리 `initiative`, `RunTrigger::AgentInitiated`, hold 술어, DM 열기, 한도·중복, 끄개 키, 재증명, 재호출 상태, 감사 | N1, 이 ADR Accepted (N2는 순서 권장) | L (두 PR 권장: 문+생성 / 한도·감사·끄개·재증명) |
| N4 (UXUI) | 카드 「먼저 제안」 표시·에이전트 글 꼬리표, 고정 카드 행, `actionRole.ts`·동의 화면 문구, 설정 끄개 토글. 계약 변경: 카드 props `origin`, 새 scope 문구 | N3 계약 | M |
| N5 (ops) | planner 운영 절차: `oort_action_initiate`로 QA 채널 세팅(#4616의 증거 이슈에 기록) | N3, N4 | S |

N2는 사람이 시킨 제안(handle 경로)에서도 열리므로 N3와 독립이다. 그 경로에서는 run 채널 안의 메시지만 대상이다(U-e). N1도 사람이 시킨 제안의 빈칸을 고친다.

### U-k. 수용 기준과 ADR-0214 연결

각 결정 절의 「시험 의무」가 수용 기준이다. 각 시험은 해당 분기를 지우면 실패해야 하고, 그 RED를 구현 PR 본문 사보타주 표에 남긴다. 아래 다섯은 특히 **독립 보안 검수가 사보타주할 대상**으로 넘긴다.
1. 대기 중 `agent_initiated` run이 있어도 work 요청이 상한에 막히지 않는다(hold 술어).
2. 소유자 없음·비소유자 confirm 연결·소유자의 역할 미충족·대상 채널 비멤버·정지는 같은 `Unavailable`이고 run·approval·새 DM이 0이다(조건 하나를 지우면 해당 사례가 카드를 만든다).
3. `addProposer:true`인 먼저 제안 카드는 「이 에이전트도 참여」 행이 늘 있고, 승인으로 늘어나는 `approved_channel_ids`는 새로 만든 그 채널 하나뿐이다.
4. 끄개가 꺼진 뒤 올라온 카드는 승인해도 실행 0이고 승인 pending이 유지된다. 거절은 된다.
5. 승인·거절 뒤 제안 에이전트 인박스에 `agent_run` 참조가 정확히 1건이고, 만료 뒤에는 0건이다(스윕은 인박스를 쓰지 못한다. 운영 역할 grant로 시험한다).

**주장 후보(ADR-0214 D1~D4).** 구현 이슈가 `docs/security/claims.yaml`에 아래 문장을 시험과 함께 더한다. 시험이 붙기 전에는 SECURITY.md 등 공개 문서에 쓰지 않는다. P0는 저장소 안 음성 대조(사보타주 증거)를 갖춘다.
- (P0) 에이전트는 사람의 승인 없이 먼저 제안으로 워크스페이스를 바꿀 수 없다. 한 호출이 만드는 것은 run·승인·카드·(필요하면) 소유자 DM뿐이다. 범위는 Agent Port 신원이다. U-g의 선행 조건이 충족되기 전에는 사람 토큰까지 넓혀 쓰지 않는다.
- (P0) 연결 scope와 워크스페이스 끄개가 없으면 먼저 제안은 열리지 않는다. scope가 없으면 도구가 목록에도 호출에도 없다.
- (P1) 사람이 거절한 제안은 24시간 안에 같은 모양으로 다시 올라오지 않는다.
- (P1) 에이전트는 사람이 카드에서 읽고 승인한 메시지만 고정하거나 푼다.

### U-l. 독립 보안 검수 기록 (2026-10-27, r1, 새 검수자 1회)

판정: **Blocker 0 · High 3 · Medium 9 · Low 8.** 설계대로 구현해도 승인 없이 상태가 바뀌거나 권한이 오르는 길은 찾지 못했다. 확인한 불변식: `approval.run_id NOT NULL`과 hold된 run의 선례, 스톨 스윕이 이 run을 끝내지 못함(`end_stalled_run_in_tx`는 `queued/running`만), 결정자는 활성 사람이면서 채널 멤버이고 에이전트의 자기 승인은 불가, 소유자 DM의 결정자는 구조상 소유자 한 명, 실행은 저장 인자를 다시 해석해 pins와 비교하고 승인자 권한으로만 일어남, `/pin`은 에이전트 scope 표 밖. 처리는 다음과 같다.

| 지적 | 처리 |
|---|---|
| H1 U-f의 notifier 스윕 쓰기는 운영 역할로 실행 불가(`token`·인박스 grant 없음, 시험은 개발 역할에서만 초록) | **수정.** 만료는 인박스 참조를 쓰지 않고 재호출이 만료를 파생해서 말한다. N1은 승인·거절 arm만, 시험은 운영 역할 grant로(U-f, U-j, U-k 5). 같은 수정이 M6(만료가 사람 없이 도어벨을 울려 재제안 루프를 만듦)도 없앤다 |
| H2 handle 경로의 `message.pin`·`message.unpin` 카드가 다른 채널의 메시지 내용을 run 채널 전원에게 노출 | **수정.** handle 경로는 대상 메시지가 run 채널 안일 때만, 먼저 제안은 소유자가 대상 채널 멤버일 때만. 교차 채널 카드 0 시험(U-e, U-b-4 6) |
| H3 사람 개발자 토큰이 결정 라우트를 부르면 「사람 승인」이 같은 터미널 에이전트의 자기 승인 | **수정.** N3 머지의 선행 조건과 P0 주장 범위 한정(U-g, U-k). 확인에서 잔여 둘이 나왔다. `credential_via` 방식은 `decide_by_run`이 우회로가 되고, `opens_in_app` 카드만 막으면 handle 경로 카드를 자기 승인할 수 있다. 검수자의 한 줄 수정안(`decide()`에서 개발자·CLI 자격이 에이전트가 요청한 승인 전체를 결정하지 못하게)을 그대로 반영했다. ADR-0216 쪽이 만족시킬 항목으로 planner가 전달한다 |
| 코드 인용 오류 8건 | **문구 정정**(U-0 2·6, U-a 계약, U-b-1·U-b-4, U-c 시험, U-d 감사) |
| Medium 9 · Low 8 | **이 증보에서 설계를 바꾸지 않았다.** 목록과 이유는 PR 본문 「후속」에 있다. 문장이 사실과 달랐던 곳(M2·M3·M5·M8의 인용 부분)만 문구를 바로잡았다 |

수정 확인(r1-c): High 세 곳의 수정 부분만 검수자가 1회 확인했다. H1·H2는 닫혔고 H3은 잔여 둘(위)이 나와 한 줄 수정안을 반영했다. 새 Blocker·High는 없다. 재검수 라운드는 없다. 확인에서 나온 Low 둘(재호출의 DB 시계와 결정 라우트의 앱 시계 경계 차이, 승인 arm 안에서 인박스 참조를 결과 줄보다 먼저 써야 하는 락 순서)은 PR 본문의 구현 이슈 초안 N1에 적었다.

### U-m. 결재 대기 (owner 질문, 권장 표시)

owner가 고를 것은 아래 여섯이다. 권장대로면 이 증보는 그대로 Accepted로 간다. 다르게 고르면 해당 절을 고쳐 다시 올린다. 질문 문장은 PR 본문에 쉬운 말로 적었다.

| # | 절 | 질문 | 권장 | 다른 선택지 |
|---|---|---|---|---|
| Q1 | U-a | 시키지 않은 제안을 어디에 담나 | A3: 한 호출로 짧은 작업 하나를 서버가 열어 승인에 묶는다 | A1 작업 없는 승인(구조 변경이 큼) · A2 두 단계 |
| Q2 | U-b-1 | 「먼저 제안」 허가를 어디에 적나 | P1: 연결할 때 관리자가 한 번 허락한다(권한 한 줄 추가, 바꾸려면 재연결) | P2 에이전트 허브의 스위치(아무 때나 켜고 끈다, 권한 줄에는 안 적힌다) |
| Q3 | U-b-2 | 먼저 제안이 할 수 있는 일 | 4가지: 비공개 채널 만들기 · 멤버 추가 · 메시지 고정 · 고정 풀기 | 채널 만들기만 · 공개 채널 만들기와 에이전트 이름·프로필 변경까지 |
| Q4 | U-b-2 | 채널을 만들 때 에이전트 자신도 그 채널에 들어가게 하나 | 들어간다. 카드에 「이 에이전트도 참여」가 늘 보인다 | 먼저 제안에서는 못 들어간다(들어가려면 사람이 따로 시킨다) |
| Q5 | U-d | 먼저 제안 횟수 제한 | 시간당 6번 · 하루 20번 | 시간당 20 · 하루 100 · 제한 없음(V3-6처럼 승인만) |
| Q6 | U-e | 메시지 고정·풀기도 승인 카드를 거치나 | 거친다 | 에이전트가 쓴 글만 승인 없이 · 모두 승인 없이 |

planner 위임 기본값(결재 질문이 아님, 이탈 시 보고): 카드 자리는 소유자 1:1 DM(C1), 카드 수명 24시간, 대기 먼저 제안 2개, 결과 알림은 승인·거절 때 인박스 참조 + 같은 id 재호출(F2, 만료는 재호출이 파생), 고정 승인자는 기존 `admin`.

### U-n. 구현 중 확인된 사실과 문구 정정 (2026-10-29, #4704 PR A·B)

결정은 바뀌지 않았다. 코드로 N3를 짓다가 문장이 사실과 달랐거나 비어 있던 곳을 적는다(V3-13과 같은 방식).

| 절 | 문장 | 정정·확정 |
|---|---|---|
| U-a ① | 「에이전트 `member` 행 잠금(…`lock_agent_and_count_pending_workspace_actions_in_tx`와 같은 잠금)」 | **에이전트별 advisory 락이 첫 락이다**(`momo_agent::initiative::lock_agent_initiative_in_tx`, 키는 `initiative_lock_key`). `member` 행의 `FOR NO KEY UPDATE`는 모든 메시지 쓰기·결정의 wake·신원 증명이 쥐는 `FOR SHARE`와 충돌해서 같은 에이전트의 동시 호출이 구조적으로 교착했다(PR A 보안 검수 M1). 사람이 시킨 제안(`oort_action_propose`)도 **같은 락을 첫 문장으로** 잡는다(PR B): 합계 대기 3개는 두 생산자가 나눠 쓰는 자리라서, 한쪽이 센 뒤 쓰기 전에 다른 쪽이 끼어들면 넷이 된다. 락이 첫째일 때만 이 문이 쥔 락 말고는 아무것도 기다리지 않는다 |
| U-d 속도 | 「`agent_run`에서 `agent_initiated:<에이전트>:` 키의 행 수를 센다」 | `agent_member_id` + 접두 `agent_initiated:`(`run::AGENT_INITIATED_KEY_PREFIX`)로 센다 — 두 값은 한 생산자가 같은 입력으로 쓰므로 같은 행 집합이다. 부분 인덱스 `agent_run_initiative_rate_idx`(migration 155)가 받치고, 조회 문장은 같은 술어를 리터럴로 적는다(L5). 환경변수는 `MOMO_AGENT_INITIATIVE_PER_HOUR`(기본 6, 1..=60)·`_PER_DAY`(20, 1..=240)·`_TTL_HOURS`(24, 1..=168)이고 범위 밖은 가장 가까운 끝값으로, 숫자가 아니면 기본값으로 쓰며 부팅 때 한 번 경고한다(L6) |
| U-d 중복 | 「같은 (에이전트, 행동, 서버가 해석한 정규화 인자)」 | 키는 `payload.initiative.key`에 서버가 해석 뒤에 쓴다(`pins` 밖: 결정이 `pins`를 지금의 해석과 비교한다). `channel.create`는 이름을 소문자로 하고 `-`·`_`를 빼고 끝 숫자를 떼어 줄인다(`qa`·`QA`·`qa2`·`qa-2`가 한 키, `qa-team`은 다른 키, 숫자뿐인 이름은 그대로). 나머지는 id다(`channel.member.add`는 채널 id + 사람 id 집합, 핀은 메시지 id). 쿨다운은 **거절(`rejected`)만** 시작한다: 만료는 아무도 「그만」이라 하지 않은 것이고, `cancelled`는 사람의 run 취소뿐 아니라 시스템 정리에서도 나오므로 사람의 말로 읽지 않는다 |
| U-d 재증명 | 「제안 에이전트가 활성…연결이 active·증명됐으며…결정자가 현재 소유자」 | 카드가 선 **그 연결**을 `payload.initiative.connection_id`에 적고(`card_bookkeeping`/`card_connection_id` 한 쌍), 결정 때 그 연결이 **여전히 그 에이전트의 `active`·증명된 연결이고 현재 자격증명이 revoke되지 않았는지**를 본다(`momo_auth::hosted_connection_stands_in_tx` — 정의는 한 곳). 자격증명의 **만료는 보지 않는다**: OAuth 연결의 `active_token_id`는 30분짜리 access token이라 하루 기다린 카드에서는 늘 만료돼 있고(루틴), revoke(운영자의 긴급 폐기·refresh 재사용 탐지)는 의도된 일이라 카드를 끝낸다(PR B 보안 검수 H1·2회차 Medium-1). 끊었다 다시 만든 연결은 다른 id라 옛 카드는 살아나지 않는다. 증명된 연결 id는 그대로 **해석기(핀의 "덮임")와 `channel.create` 실행기(잠금·`approved_channel_ids` 추가·`channels_granted` 감사)로 넘어간다** — 한 군데만 고치면 같은 읽기를 쓰는 뒷 단계가 만료된 토큰을 「연결 없음」으로 읽어 핀은 409, `channel.create`는 에이전트만 방에 앉히고 덮임·감사를 건너뛰는 반쪽 실행이 된다(2회차 High-1). 이 연결이 증명과 쓰기 사이에 끝나면(경주) 쓰기 전에 거절한다 — 먼저 제안 카드는 반쪽으로 실행되지 않는다. scope·에이전트(활성·미정지)는 `initiative_scope_and_agent_stand_in_tx`, 연결 확인자 == 소유자(L2)와 결정자 == 현재 소유자는 문의 조건 4와 같은 술어(`initiative_facts_in_tx`)로 읽고, 끄개는 문과 같은 읽기(`switch_is_on`)다. 연결 표지가 없는 카드는 닫힌 쪽(`action_args_invalid`)이다. 결정자 비교는 DM이 두 사람뿐이라 실제 경로에서는 겹치는 띠지만, 방에 소유자가 아닌 admin이 있게 되면(미래 경로·데이터 보정) 그 사람의 탭이 소유자 눈으로 그려진 카드를 실행하지 못하게 하는 유일한 지점이다 — 시험이 세 번째 admin으로 잰다. 사람이 시킨 카드는 이 경로를 타지 않고 지금처럼 살아 있는 연결을 신선한 자격증명으로 찾는다(후속 참고) |
| U-d 감사(결정 쪽) | 「어느 행에도 인자 값·rationale·메시지 본문·채널 이름이 없다」 | 이 문장은 **새 행(`opened`·`refused`)과 결정 쪽 `approval.*` 행**에 적용한다. 일반 결정 이벤트(`decision_event_payload`)는 저장된 payload 전체를 싣는데 먼저 제안 카드에서 그것은 에이전트의 글(`rationale`·고른 이름)이라, 감사용 사본에서는 `payload`를 빼고 `origin`만 더한다(`decision_audit_detail`; PR B 보안 검수 M2). **도메인 행**(`channel.created` 등)은 V6가 정한 모양 그대로다 — 사람이 승인해 이미 세상에 존재하게 된 사실(만들어진 채널의 이름)을 적는 기존 행이고, 먼저 제안이라고 형태가 바뀌지 않는다(`origin`만 더한다) |
| U-d 감사 | 「합쳐서 가려지는 횟수는 후속에서 다음 창의 첫 행에 싣는 방안을 본다」 | 구현했다. (워크스페이스, 에이전트, reason)마다 한 시간 창을 `agent_initiative_refusal`(migration 155)이 쥐고, 첫 거절만 행을 쓰며 나머지는 `suppressed`를 올리고, 창이 지난 뒤 첫 거절의 행이 그 수를 `detail.suppressed`로 싣고 0에서 다시 시작한다(항상 키가 있고 없으면 0). 이미 쓴 감사 행은 고치지 않는다. 행이 없는 거절: 문 1·2의 실패(이 자격증명은 먼저 제안 자격이 아니다), 트랜잭션 전에 스키마가 거르는 인자, 같은 id의 재호출(읽기이고 아무것도 쓰지 않는다) — 아홉 이유 밖이고 열 번째를 만들지 않았다 |
| U-k 5 | 「정지는 같은 `Unavailable`」 | 정지·연결 해제된 에이전트는 도구 목록이 비어(`resolve_hosted_tool_identity_in_tx`가 `paused=false`를 요구) **어느 도구든 「알 수 없는 도구」**(400, -32602)로 답한다. `Unavailable`은 목록과 호출 사이에 정지가 끼어든 경우의 몫이다 |
| U-c 시험 의무 | 「비멤버 admin은 거절된다(현행은 403)」 | 결정 라우트는 소유자 DM 밖의 누구에게든 **없는 승인과 같은 404**로 답한다(인플레이스 카드와 같은 분기, 두 표지 중 하나면 먼저 제안 카드). 미리보기(`avatar-preview`)는 먼저 제안이 사진을 올리지 않으므로 처음부터 모두에게 404다 |
| U-f 알림 | 「승인·거절 때 제안 에이전트 인박스에 `agent_run` 참조가 정확히 1건」 | 인박스 참조의 권한 술어(`append_reference_in_tx`)는 자격증명이 **신선**할 것을 요구한다(인박스는 그 자격증명으로 읽는 것이라서). 자격증명이 만료된 연결에서는 승인·거절이 성립하되 참조가 쓰이지 않는다(관리형·연결 없는 제안자와 같은 「조용히 0건」). 에이전트는 같은 `clientRequestId`로 다시 물어 `approved`·`ref`를 받는다 — U-f가 처음부터 재호출을 정본으로 둔 이유다. 갱신 뒤 알림을 받게 하려면 별도 결정이 필요하다(후속) |

## 증보 2026-10-29 — 요청 고리: 한 요청 한 묶음·요청 스레드 자리·채널에도 한 줄과 판단 칸·상태 코드 (v6, #4755)

- Status: **Accepted(owner 결정 넷)** — owner 2026-10-29 「나쁘지 않아 보이네. 전부 권장으로 일단 진행해봐.」(후보 페이지의 결정 1~4). **Proposed(결정 넷에서 따라 나오지 않는 세부)** — 아래 `[Proposed]` 표시. planner 결정이고 가역이며, 질문은 이 증보를 올리는 PR 본문에 모았다. ADR-0100에 따라 공개 API(카드 props·결정 응답·run 진행·승인 읽기의 가산 필드)를 바꾸는 구현 PR은 이 증보의 해당 절이 Accepted일 때만 머지할 수 있다. Proposed 절은 planner가 Accepted로 올린 뒤에 구현한다.
- 발제: owner 2026-10-29 요청의 요지(비공개 캡처 기준). 승인·제안·기록 화면이 딱딱하고 과하다. 채널에 카드가 계속 나열되는 구조보다 요청 메시지의 스레드가 낫지 않은지, 사고 중임을 보여 주면 좋을지, 판단을 모델이 정하면 어떤지. 후보 세 개(A 제자리 묶음 · B 요청 스레드 · C 작업 패널 + 인박스)를 owner가 비교해 B를 골랐다.
- 기안: Sonnet 5.5 설계 워커(#4755 1단계). 구현은 이 증보 밖이다.
- Consumes: 이 ADR의 D2 · D5 · 부록 A/B/C · V6 · 증보 v5의 U-c · U-f · ADR-0148 증보(#4622) · ADR-0200 D5 · 증보 4 · 증보 5 · ADR-0204 D7 · D8 · 증보 1 D8-a · 증보 2 D6 · ADR-0199 · ADR-0182 ③ · ADR-0132 · ADR-0100. 짝: ADR-0204 증보 6(푸시 문장·바로 승인 기준), `docs/design-system/agent-request-loop.md`(화면·낱말·재는 것).
- 표기: [V] 코드·문서 직접 확인(track/engine `3dae6e581`, 읽기만 했고 실행하지 않았다 — `runtime-unverified`) · [Proposed] 결정 밖 세부 · [확인 필요] 구현 전 실측.
- 이 증보가 **의도적으로 바꾸는 것** 다섯:
  1. D2의 「승인·거부·만료 뒤 에이전트 명의 `tool_result`」와 부록 B의 영속 `action_result` 카드. 끝 상태의 정본이 승인 카드 자신이 된다(R-b). 옛 줄은 1단계에 남긴다.
  2. 카드·도구 줄·결과·최종 답의 자리. 채널 최상위 트리거는 요청 메시지의 스레드다(ADR-0148 증보와 ADR-0200 증보 5의 「어긋남」을 닫고 #4646을 흡수한다, R-c).
  3. 영어 원문 줄을 상태 코드 + 한국어로(R-d).
  4. 「채널에도 한 줄」 규칙과 판단 칸(R-e).
  5. 카드 props · 결정 응답 · run 진행 · 승인 읽기의 가산 필드(R-f).
- **바꾸지 않는 것**: D2의 결정 입력과 같은 tx 실행 · D3 위험 등급 · D4 1회 시크릿 · 결정 라우트 2개 · 한 run 한 제안 · U-c의 C1(먼저 제안 카드는 소유자 1:1 DM) · **U-c의 C3(별도 승인함) 기각** · ADR-0204 D7의 받는 사람 · `approval.channel_id NOT NULL` · `schema_v0.sql`.

### R-0. 코드로 확인한 사실 (2026-10-29, track/engine `3dae6e581`)

1. 승인 카드(`approval_request`)는 결정 때 props가 제자리 패치된다(`patch_message_props_in_tx`·`patch_and_prune_message_props_in_tx`, `routes/approvals.rs`의 `decided_props_patch` 부근). 패치 함수는 방송을 내지 않고, 카드를 알리는 것은 `approval.decided` 봉투 한 번이다(`momo-messaging/src/message.rs` 두 함수의 문서).
2. **만료와 취소는 카드를 패치하지 않는다.** 만료를 정하는 곳은 둘이다: notifier 스윕 `settle_expired_in_tx`(`bins/momo-notifier/src/approval_sweep.rs`)와 마감 뒤 클릭 `settle_expired`(`approvals.rs`). 둘 다 승인 상태 갱신 · run 종료(`timed_out`, 코드 `approval_expired`) · 종료 프레임 · 영어 줄 · 감사 · 방송을 쓰지만 카드 props는 `pending`으로 남는다(#3982).
3. 결과 메시지를 쓰는 곳은 셋이고 멱등 키가 다르다: 실행됨 = `result_client_msg_id(approval.id)`, 거부·만료 = `approval.id`. 같은 키를 나눠 쓰면 `(channel, author, client_msg_id)` 가드가 한 줄을 조용히 버린다(`momo-agent/src/actions.rs`의 `result_client_msg_id` 문서).
4. 거부 줄: 본문 영어 `"Tool call rejected by human approval."`(인플레이스 승인은 한국어 상수), `tool_result`, 작성자 = 제안한 에이전트, `root_id: None`, props `approval_id`·`run_id`·`status:"rejected"`·`decided_by`·`decided_at_ms`·`reason`. run은 `cancelled`(코드 `approval_rejected`)로 끝난다. **`answers_message_id`가 없어서 푸시가 조용하다**(ADR-0204 증보 1 D8).
5. 만료 줄: 본문 영어 `"Tool call expired without a human approval."`(인플레이스는 한국어 상수), `is_error` 도구 결과, props `status:"expired"`·`decided_at_ms`와, 트리거가 있으면 `answers_message_id`. 푸시가 묻는 사람을 찾는다(ADR-0204 D8).
6. 행동 승인의 성공은 `momo.action_result.v1` 영속 카드를 `tool_result`로 쓴다. 부록 B가 정한 `status ∈ executed | rejected | expired | role_required` 가운데 서버가 쓰는 것은 `executed`뿐이다. 인플레이스 채널 승인은 결과 줄을 쓰지 않는다(카드 패치가 「승인됨」을 말한다).
7. 카드 `body`는 행동 승인이 `"승인 요청: {title}"`(`workspace_action_request_body`), 도구 승인이 영어 `"Approval required: {tool}"`이다. 푸시 본문과 카드를 모르는 옛 클라이언트의 폴백이 이 `body`를 그대로 읽는다.
8. 행동 제안 카드(`oort_action_propose`, `agent_port_tools.rs`)와 결과 · 거부 · 만료 줄(`approval_sweep.rs` 포함)은 `root_id: None`이다. 인플레이스 채널 승인 카드와 호출 불가 안내 줄만 서버가 「말한 자리」(`root_id: send.root_id`, `agent_mentions.rs`)를 따른다. 최종 답만 `trigger_root_id`를 따른다(ADR-0148 증보). ADR-0200 증보 5의 「답 자리 현황」 표가 이 갈림을 「어긋남」으로 적었다.
9. 조사 노트가 가리킨 「한 카드 밑에 줄 둘을 피하려는」 주석(`actions.rs` 2206-2213)은 이 트리에서 **찾지 못했다**. 이 증보는 그 이유를 근거로 쓰지 않고, 확인된 두 이유만 다룬다: ADR-0182 ③(다시 찾을 결과는 지속 카드)과 위 3번의 멱등 키 분리. [확인 필요: 없음 확인]
10. `momo_notifier`는 `message`에 SELECT·INSERT·UPDATE grant가 있다(`infra/rust/sql/bootstrap_runtime_roles.sql` 472).

### R-a. 결정 넷이 이 ADR에 닿는 곳

| 결정 (owner 2026-10-29) | 이 증보의 처리 | 상태 |
|---|---|---|
| 1 자리 = B 요청 스레드, DM 제자리, #4646 흡수 | R-c | Accepted |
| 2 생각 글: 진행 메모 40자만, 흐르는 글은 저장 안 함 | **새 결정이 아니다.** #4655 Q2와 같고 ADR-0200 D5의 한계 문장(`textDelta`는 저장하지 않는다)과 같다. ADR-0200에는 한 줄 참조만 더했다. 40자는 R-f에서 서버 검증을 건드리지 않고 화면이 줄인다 | Accepted(재확인) |
| 3 푸시 바로 승인은 위험이 낮은 것만 | ADR-0204 증보 6 | Accepted(원칙) · Proposed(행별 판정) |
| 4 판단 칸: 기본 규칙, 모델은 켰을 때만 이진 하나 | R-e | Accepted(원칙) · Proposed(세부) |

바닥 규칙(한 요청 = 한 묶음, 문장이 머리, 실패는 우리말, 상태는 아이콘 + 낱말, 원장 번호·원본 데이터는 「자세히」와 기록에만)은 owner가 세 후보 공통으로 승인했다. 이를 서버·클라이언트 어느 쪽이 지키는지는 결정 밖이라 R-b가 정한다(Proposed).

### R-b. 한 요청 한 묶음 — 서버가 쓰고, 옛 줄은 1단계에 남기고 클라이언트가 접는다 [Proposed]

**닻.** 묶음의 닻은 제안 때 서는 승인 카드(`approval_request`) 한 장이다. 새 메시지 종류나 새 컴포넌트는 없다.

| 안 | 모양 | 판정 |
|---|---|---|
| **H 서버 쓰기가 정본 + 옛 줄 1단계 유지 + 클라이언트 접기 (권장)** | 모든 종결에서 같은 카드 props에 `status`·`code`·결과를 패치한다. 옛 줄(실행됨 카드·거부 줄·만료 줄)은 `bundle_of`를 달고 한국어 중립 `body`로 남긴다. 클라이언트는 카드가 같은 목록에 있고 종결 상태면 줄을 그리지 않는다 | 롤링 배포가 양방향 호환이다. 푸시 · 에이전트 읽기 · 모델 도구 결과를 건드리지 않는다 |
| C 클라이언트 접기만 | 서버는 그대로, 클라이언트가 `approval_id`로 메시지를 묶어 합성한다 | 만료·취소 뒤 카드 `status`가 `pending`으로 남는 #3982를 못 고친다. 웹·폰·옛 클라이언트마다 합성 규칙이 갈린다(패리티 분기) |
| S 서버가 옛 줄을 지운다 | 카드 패치만 쓰고 줄을 안 쓴다 | 만료 줄의 `answers_message_id`가 요청자 푸시를 만든다. 줄을 없애려면 푸시 생산자가 하나 늘어서 ADR-0204 증보 1 D8-a(「그 밖의 생산자는 Accepted ADR 없이 더하지 않는다」)에 걸린다. 에이전트가 대화를 읽을 때 결과가 안 읽힐 수 있다 [확인 필요]. 도구 승인에서는 줄이 모델의 도구 결과일 수 있다 [확인 필요] |

**H의 규칙.**

1. **한 곳에서 종결을 쓴다.** 승인·거부·만료(스윕과 마감 뒤 클릭)·취소(사람이 run을 멈춰 대기 승인을 함께 취소하는 곳) 모두 같은 트랜잭션에서 하나의 함수로 카드 props를 패치한다(이름은 구현이 정한다). 종결이 카드를 안 패치하는 길이 다시 생기지 않도록 시험이 모든 종결 경로를 센다(R-j). #3982를 이 안에 흡수한다.
2. **패치 내용.** `status`(기존 키: `approved`·`rejected`·`expired`·`cancelled`) · `code`(run 종료 코드 `approval_rejected`·`approval_expired` 등) · `decided_by`·`decided_at_ms`(기존) · `result`(부록 B `momo.action_result.v1` 객체와 같은 모양, 그리고 한 줄 `line`). `result.status`는 `executed | rejected | expired | cancelled | role_required`로 넓힌다. `rejected`·`expired`는 이제 서버가 쓴다. shallow `||` 병합이라 `result`는 통째로 바뀐다. 기존 `last_attempt` 정리 관례는 그대로다.
3. **방송은 늘리지 않는다.** 만료 스윕은 이미 `decision_broadcast_payload(…"expired"…)` 봉투를 내고 클라이언트는 봉투로 카드를 제자리 갱신한다. 새로 고침 뒤에도 같은 모양이 되게 하는 것이 이 패치의 일이다.
4. **옛 줄은 `bundle_of`를 단다.** `action_type`이 `workspace_action`인 승인의 실행됨 카드 · 거부 줄 · 만료 줄에 `props.bundle_of = <approval_id>`를 더한다. 본문(`body`)은 영어 대신 한국어 중립문이다(R-d). **도구 승인의 `tool_result`는 이 단계에서 `bundle_of`를 달지 않고 숨기지도 않는다**(모델의 도구 결과일 수 있다).
5. **클라이언트 접기.** `bundle_of`가 있고 같은 `approval_id`의 승인 카드가 **같은 root 목록에 마운트돼 있고 종결 상태**면 줄을 그리지 않는다. 카드가 윈도 밖이거나 종결 상태가 아니면 한 줄로 그린다(정보를 잃지 않는다). `bundle_of`를 모르는 클라이언트는 줄을 그대로 그린다(현행).
6. **`is_error`.** 행동 승인의 거부·만료 줄은 도구 실패가 아니다. 새 줄은 `is_error:false`로 쓰고 상태는 `status`로 말한다. 옛 클라이언트가 이 줄을 「도구 실행 · 실패」로 그리던 것이 사라진다 [Proposed]. 도구 승인 줄은 그대로다.
7. **2단계(옛 줄 제거)는 이 증보가 열지 않는다.** 푸시를 줄 대신 승인 종결 이벤트에서 만들려면 `push_candidate` 생산자가 하나 늘어서 ADR-0204 증보 1 D8-a의 별도 Accepted ADR이 먼저다. 이 증보에서는 Proposed로 남기고 R-k의 질문으로 올린다.

**범위.** 1단계는 **행동 승인(`workspace_action`)**이다. 도구 승인(`tool_call`)은 영어 줄의 한국어화와 칩 갱신(#3982)까지만 하고, 카드 합치기와 줄 숨김은 2단계다. owner 캡처의 영어 줄은 도구 승인 만료 줄이었으므로, 1단계 뒤에도 도구 승인은 영어가 한국어로 바뀔 뿐 줄 자체는 남는다는 기대를 PR 본문에 적는다.

**D2와 부록 B의 읽는 법이 바뀌는 곳.**

| 원문 | v6 이후 |
|---|---|
| D2 승인: 「에이전트 명의 `tool_result` 메시지(부록 B)」 | 카드 `result`가 정본. `tool_result`는 1단계에 운반체로 남는다 |
| D2 거부·만료: 「기존 arm 그대로 + 에이전트 명의 `tool_result`」 | arm은 그대로이고 카드 패치가 더해진다. 줄은 운반체다 |
| D5 `action_result` kind 「영속 카드」 | 상태 어휘가 넓어진다. 클라이언트는 `bundle_of`가 있는 줄을 카드의 마지막 상태로 접는다 |
| 부록 B `status` 어휘 (`executed` / `rejected` / `expired` / `role_required`) | `cancelled`를 더하고 서버가 모두 쓴다 |

### R-c. 자리 B — 카드·결과의 자리를 한 곳이 정한다 (#4646 흡수) [Accepted: 결정 1]

| 트리거가 놓인 자리 | 카드 · 도구 줄 · 결과 · 최종 답의 `root_id` | `reply_to_id` |
|---|---|---|
| 채널 최상위(DM 아님) | **트리거 메시지 자신** | 트리거 |
| DM | 없음(본류) | 트리거 |
| 스레드 안(그 root가 같은 채널의 살아 있는 최상위) | 그 root | 트리거 |
| 스레드 안인데 root가 삭제됨 | 없음 | 트리거 |
| 트리거 없는 run(작업 run) | 없음 | 없음 |
| 먼저 제안(U-c) | 없음(소유자 1:1 DM의 본류) | 없음 |

1. **한 곳이 정한다.** `GatewayRunSnapshot::trigger_root_id`를 `{스레드 root | 트리거 자신 | 본류}`를 말하는 값으로 넓히고(채널 종류를 같은 잠근 문장에서 읽는다), 다음 쓰기가 모두 그 값을 읽는다: 최종 답 네 경로(REST 콜백 · `oort_run_complete` · 관리형 워커의 커밋과 스트림 열기 · 팀 AI), 승인 카드 생산자(외부 Agent Port의 행동 제안 · 관리형 도구 승인 카드와 tool_call 카드 · 팀 AI 도우미 카드), 결과 · 거부 · 만료 · 정지 줄. 카드가 서고 나면 이후 운반체 줄은 **카드 행의 `root_id`**를 그대로 따른다(트리거가 지워져도 한 묶음이 한 스레드에 남는다).
2. 롤업과 `thread.updated`를 지키는 쓰기(`send_thread_notice_in_tx`)를 쓴다(ADR-0148 증보). `root_id`만 넣고 롤업을 건너뛰지 않는다.
3. **인용.** `reply_to_id`는 그대로 쓴다(푸시 판정이 읽는다). 스레드 root 자신을 가리키는 인용 블록은 중복이라 클라이언트가 그리지 않는다 [Proposed].
4. 같은 이슈가 확인할 것: 푸시 · 안 읽음 · hosted 인박스가 스레드 답글을 세는 방식, 스레드 깨우기 W1(「첫 답글을 에이전트가 쓴 스레드」 판정으로 사람의 평문 답글이 그 에이전트를 깨운다)이 의도된 동작인지 시험으로 정한다(#4646의 확인 항목).
5. **출시 순서.** 서버가 먼저 뒤집히면 카드가 「답글 1개」 뒤로 숨는다. 서버 자리 B는 **스레드 요약 줄의 승인 필요 칩과 결정 버튼이 웹·폰에 착륙한 뒤에 켠다**(구현 순서 R-k가 반영한다) [Proposed].
6. 시험은 네 경로 × 세 자리(DM · 채널 최상위 · 스레드 안)의 표를 실제 PG 행으로 구동한다. `agent_answer_place_pg.rs`의 채널 최상위 시험을 먼저 붉게 만든다.

### R-d. 영어 원문 줄 → 상태 코드 + 한국어 [Proposed]

1. **정본은 코드다.** 사람 화면용 필드(`body`·`props` 문장)에 영어를 쓰지 않는다. `props.status`와 `props.code`가 정본이고, 한국어 문장은 클라이언트가 코어의 사전에서 읽는다.
2. 푸시 본문과 카드를 모르는 옛 클라이언트와 에이전트가 읽는 `body`는 기기가 코드를 읽을 수 없는 자리라서 서버가 **한국어 중립문**을 쓴다. 결정한 사람의 이름은 쓰는 시점의 표시 이름을 문장에 넣어도 된다(그 줄은 시점 스냅샷이고 카드는 `decided_by`로 현재 이름을 읽는다).

| 영어 원문 | 코드 | 한국어 `body` |
|---|---|---|
| `Tool call expired without a human approval.` | `expired` · `approval_expired` | 승인을 기다리다 만료됐어요 |
| `Tool call rejected by human approval.` | `rejected` · `approval_rejected` | 이도현 님이 거부했어요(결정한 사람을 모르면 「거부됐어요」) |
| `Approval required: {tool}` | — | 도구 「{이름}」을 실행해도 될까요? |
| `Approval expired before a human decision.` | — | 감사 사유라서 화면에 나오지 않는다. 그대로 |

3. 코드→문장 표는 서버와 코어가 **같은 골든 데이터 한 파일**을 읽는 시험으로 잠근다(소스 글자를 단정하지 않고 데이터를 읽는다).
4. **낱말은 한 곳이 정한다.** 클라이언트 코어의 `runPhaseLabel`이 종료 코드 `approval_expired`에서 「만료」, `approval_rejected`에서 「거부」를 정하고 칩 · 카드 · 인박스 행이 그것을 읽는다. 지금 같은 run(`timed_out` + `approval_expired`)은 칩이 「만료」인데 예외 줄 머리말이 「시간 초과」(`runException`이 `runPhaseLabel`을 읽고 `END_REASON_TEXT` 「승인이 만료됐어요」를 붙인다)라서 한 행에 두 낱말이 선다. 그래서 **승인으로 끝난 run에는 예외 줄을 세우지 않는다**(칩이 말하고 묶음 카드가 설명한다, 디자인 시스템 §1·§7). #4705가 영어 스윕 줄을 클라이언트에서 임시로 번역한 `EXPIRED_LINE_TITLE` · `EXPIRED_LINE_NOTE` · `EXPIRED_ROW_COPY`는 이 문장 · 낱말로 대체된다(`EXPIRED_CARD_COPY`는 결정하려던 사람에게 컨트롤 자리에서 말하는 안내라 그대로다).
5. 말 사전(승인의 반대 낱말 「거부」 등)은 `docs/design-system/agent-request-loop.md` 7절이 정한다. 반대 낱말은 ADR-0204 증보 2 D6(Accepted)을 따른다.

### R-e. 「채널에도 한 줄」과 판단 칸

**규칙 [Accepted: 결정 4의 규칙부].** 요청이 채널(최상위)에서 왔고 결과가 채널에 보이는 변화면 채널 본류에 에이전트 명의로 한 줄이 더 선다. 아니면 스레드에만 있다.

1. 행동 레지스트리에 속성 `announce: bool`을 더한다(`initiative`와 같은 방식). 첫 기본값 [Proposed]: `true` = `channel.create` · `channel.member.add` · `message.pin` · `message.unpin` · `agent.rename`, `false` = 그 밖 모두(1회 값을 내는 `invite.create`·`agent.invite`, `member.avatar.set`, `agent.profile.update`, `hosted.channels.grant`, `workspace.*`, `plugin.install`). DM · 스레드 안 요청 · 먼저 제안은 해당 없다.
2. **한 줄의 모양.** 본류(`root_id` 없음), 에이전트 명의, `reply_to_id` = 요청 메시지, `props.bundle_of` = `approval_id`와 `props.announce:true`, 본문은 결과 한 줄(카드 `result.line`과 같은 문장). 멱등 키는 R-0.3의 두 키와 겹치지 않는 결정적 키다.
3. 이 줄은 **푸시를 만들지 않는다.** 요청한 사람은 이미 결과를 받는다(ADR-0204 증보 6). 푸시 판정은 `announce:true`를 조용한 줄로 취급한다.

**판단 칸 [Accepted: 결정 4의 원칙 / Proposed: 세부].**

- 질문 하나, 선택지 둘: 「이 결과를 채널에도 한 줄 알릴까?」 — 스레드에만 / 채널에도 한 줄. 기본은 규칙이고 **기본은 꺼짐**이다. 모델은 켰을 때만 이 둘 중 하나를 고르고, 실패하거나 늦으면 규칙으로 간다. **승인 · 보안 · 권한 · 결정 라우팅 · 푸시 받는 사람 · 카드 내용은 절대 정하지 않는다.**
- 구조로 막는다. 판정 함수는 `(규칙 기본값, 모델 답) → Announce`(두 값 enum)만 돌려주고, 승인 결정 · 행동 실행 · 푸시 판정의 함수가 그 모델 호출에 의존하지 않는다. 시험은 모델 호출이 그 경로들에서 도달 불가함을 구조로 보이고 사보타주한다.
- **#2883의 결정 칸을 쓴다.** 별도 키 슬롯 · 꺼짐/관찰/켜짐 · 외부 전송 동의 문장 · 「지금 재기」는 그쪽이 정한다. 이 질문은 그 칸의 두 번째 질문 종류다. 판단 칸의 켜기는 #2883과 그 판정기 ADR이 Accepted된 뒤에만 한다.
- 모델 입력은 행동 id와 서버가 만든 결과 요약 행뿐이다. 요청 메시지 본문과 대화 이력은 보내지 않는다. 에이전트는 이 판정을 부르지도 결과를 보지도 못한다. 제한 시간은 800ms로 시작한다. 켠 첫 단계는 관찰(판정은 하되 적용 없이 기록만)이다.
- 이 판정은 보안 판정이 아니라 **표시 판정**이라서, 1차 판정기 제안서의 「단조 강화만」은 「표시만, 두 방향 모두 허용」으로 바뀐다. 규칙이 「채널에도」인데 모델이 「스레드에만」이어도, 반대여도 스레드의 결과는 같다.
- 묶음 감사 행에 한 키 `announce_source ∈ {rule, model, fallback}`를 더한다.

### R-f. 가산 계약 (공개 API, ADR-0100) [Proposed]

| 값 | 어디 | 비고 |
|---|---|---|
| `props.status` · `props.code` · `props.result{status,rows,ref,next,line}` | 승인 카드 | 종결 패치. `result`는 부록 B 객체 + `line` |
| `props.intent` · `action.rows[].before` / `.after` | 승인 카드(제안 때) | 머리 문장의 「하려는 일」 한 구절(행동마다 서버가 만든다: 이름은 작성자에서 읽고 문장에 굽지 않는다, 증보 v5 U-c와 `proposal_summary`의 문서)과 값 칩의 이전 → 이후 구조. 구조가 없는 옛 카드는 한 줄 값(`value`)으로 그린다 |
| `props.decision_mode` (`inline`/`open`) | 승인 카드 · 승인 목록 | `opens_in_app()` 한 함수의 결과(ADR-0204 증보 6) |
| `props.bundle_of` · `props.announce` | 운반체 줄 · 채널에도 줄 | 클라이언트 접기 · 푸시 조용 |
| `receipt.line` | 결정 응답(영수증) | 잠금 화면 결과 알림 문장. 구버전 폴백 있음 |
| `AgentRunProgress.bundle{approvalId,status,decisionMode,canDecide,line}` | run 진행 읽기 | 채널의 상태 칩과 스레드 요약 줄. `canDecide`는 보는 사람 기준 |
| 승인 목록: 모든 상태 · 결정자 · 결정 시각 · 결과 요약 · 자리(채널 · root · DM 여부) · 쪽매김 | 승인 읽기 | 인박스 「승인」 칸. 채널 멤버십으로 서버가 거른다(ADR-0199 D4의 조회 시 가시성 재판정, D5의 수신자 격리와 같은 규칙) |
| `announce`(행동 속성) | 레지스트리 | R-e |

- 새 테이블 · 새 컬럼 · 새 outbox 생산자 · BYPASSRLS가 없다. 모든 쓰기는 기존 `agent_tenant_tx` / `momo_app` 트랜잭션 안이고, 만료 스윕은 기존대로 `momo_notifier`의 워크스페이스별 tenant tx 안이다.
- **notifier의 카드 패치.** `momo_notifier`는 `message`에 UPDATE grant가 있다(R-0.10). 남은 확인은 `UPDATE message SET props = …`가 그 역할의 RLS 정책을 통과하는지다. U-f가 인박스 표 grant 때문에 만료를 뺐던 것과 같은 종류의 위험이라서, 이 시험은 앱 역할이 아니라 **운영 역할 스위트**로 돈다 [확인 필요]. 통과하지 못하면 스윕은 카드를 패치하지 않고 `message.edited` 없이 줄만 쓰는 현행으로 남고, #3982는 그 역할 정책 수리와 함께 푼다.
- 진행 메모 40자: 서버 `stage` 검증(80자)은 이 증보가 바꾸지 않는다. 화면이 40자를 넘는 메모를 한 줄에서 줄이고 전문은 펼침에서 보인다. 상한을 40으로 줄일지는 #4655 증보가 `activities[].label ≤40`과 한 번에 정한다.

### R-g. 인박스 「승인」 칸은 U-c의 C3가 아니다

U-c의 C3(별도 승인함)는 새 채널 종류 · 새 화면 · 푸시가 필요하고 `approval.channel_id NOT NULL`과 멤버십 게이트에 부딪혀서 기각됐다. 이 증보의 「승인」 칸은 **새 채널 종류도, 새 화면 종류도, `approval.channel_id` 변경도 없다.** 지금 인박스 안의 「처리할 일」(웹) · 「결정 대기」(폰)와 숨은 「활동」(웹 `/activity`, 폰 8번째 칩)의 **승인 행을 한 칸으로 합치는 재배치**다. 대기 승인이 이미 인박스 응답에 합쳐진다는 사실(ADR-0199 D2·D6 `approvalsPending`)은 그대로고 읽기 확장은 R-f에 있다. 그러므로 C3의 기각은 유지된다.

### R-h. 기각한 대안

- **순수 클라이언트 접기(C)**와 **서버가 옛 줄을 지움(S)**: R-b. 둘 다 1단계에서는 기각하고 S는 2단계로 남긴다.
- **후보 A 제자리 묶음 · 후보 C 작업 패널**: owner가 B를 골랐다. C를 고르면 C3를 다시 열어야 했다.
- **에이전트가 카드 자리를 정함(C2)**: U-c에서 기각, 유지.
- **모델이 승인 · 권한 · 보안을 판단**: 결정 4가 금지한다.

### R-i. 위험과 완화

1. **패치 경쟁.** 스윕 · 마감 뒤 클릭 · 사람 취소 · 늦은 승인이 한 승인을 두고 겹칠 수 있다. 모두 승인 행의 `FOR UPDATE`(`lock_approval_in_tx`)와 `mark_*`의 「pending일 때만」 가드를 지나고, 카드 패치는 그 가드를 통과한 쪽만 한다. 시험은 스윕과 클릭의 경주를 구동한다.
2. **롤링 배포.** 옛 클라이언트 + 새 서버: `bundle_of`·`result`를 무시하고 줄을 그린다(현행 모양, 영어만 한국어로 바뀐다). 새 클라이언트 + 옛 서버: `bundle_of`가 없어 줄을 그린다. 양방향 호환이다.
3. **스레드 안 카드의 가시성.** 카드가 스레드에만 있어 아무도 스레드를 안 열면 안 보인다. 결정할 사람에게는 상태 칩 · 푸시 · 인박스 「승인」 칸이 있다. 옛 클라이언트가 `root_id`가 있는 카드로의 푸시 착지를 처리하는지는 [확인 필요]이고, 그래서 서버 자리 B는 UI 뒤에 켠다(R-c 5).
4. **판단 칸의 외부 전송.** 켜지 않으면 호출 0이다. 켜는 것은 #2883 쪽 동의와 ADR이 Accepted된 뒤다.

### R-j. 시험 의무(구현 슬라이스가 인용할 red proof)

호출자가 보는 결과(응답 · DB 행 · 화면)만 단정하고, 불변식은 실제 PG 행으로 본다. 각 시험은 해당 분기를 지우면 실패해야 하고 RED를 PR 본문 사보타주 표에 남긴다.

1. 승인 · 거부 · 만료(스윕) · 만료(마감 뒤 클릭) · 취소 **다섯 경로 모두** 카드 `props.status`와 `result`가 종결 상태로 패치되고 방송이 한 번이다(#3982).
2. 카드 · 도구 줄 · 결과 · 최종 답이 네 경로에서 R-c 표와 같은 `root_id`를 갖는다(네 경로 × 세 자리).
3. 행동 승인의 새 줄은 `body`와 `props`에 영어가 0건이고 `bundle_of`·`status`·`code`가 있다. 도구 승인 줄에는 `bundle_of`가 없다.
4. 스윕과 클릭이 경주해도 카드 패치와 줄이 한 번씩이다. 멱등 키들이 서로 겹치지 않는다.
5. `announce` 기본값 표대로 본류 한 줄이 생기고, 그 줄은 푸시를 만들지 않는다(요청자 푸시는 한 번).
6. 판정 함수가 승인 · 실행 · 푸시 경로에서 도달 불가하다(구조 시험 + 사보타주). 꺼짐이면 호출 0. 실패 · 시간 초과면 규칙.
7. 운영 역할 grant로 notifier 스윕의 카드 패치가 통과한다(R-f의 [확인 필요]).

### R-k. 구현 슬라이스와 결재 대기

구현 슬라이스는 #4755의 체크리스트 코멘트에 있다(한 슬라이스 = 한 이슈 = 한 브랜치·PR). 서버 쪽은 #3982(카드 종결 패치·영어 줄 → 상태 코드, R-b·R-d) · #4646(자리 B, R-c) · #4763(읽기 확장, R-f) · #4764(푸시 문장·`decision_mode`, ADR-0204 증보 6) · #4766(「채널에도 한 줄」 규칙, R-e) · #4767(판단 칸, #2883 선행)이다. UXUI 쪽은 #4760(코어 묶음 모델) · #4761(웹·데스크탑) · #4762(폰) · #4765(인박스 「승인」 칸)다. **서버 자리 B는 웹·폰 UI(#4761·#4762)가 착륙한 뒤에 켠다**(R-c 5).

owner 결정 넷은 Accepted다. 아래는 **결정 밖이라 planner가 정하는(가역) 질문**이고 권장을 앞에 둔다. 이 증보를 올리는 PR 본문에 같은 표가 있다.

| # | 질문 | 권장 |
|---|---|---|
| 1 | 한 묶음을 서버 쓰기 정본 + 옛 줄 1단계 유지 + 클라이언트 접기(H)로 할까요 | H |
| 2 | 옛 줄 제거(2단계)를 위해 푸시 생산자 하나를 늘릴까요(ADR-0204 증보 1 D8-a가 별도 ADR을 요구) | 지금은 열지 않음 |
| 3 | 요청한 사람이 결정한 사람과 다를 때 거부 · 끝도 푸시할까요(ADR-0204 증보 6) | 해요 |
| 4 | 행동 승인의 거부 · 만료 줄을 `is_error:false`로 쓸까요 | 그래요 |
| 5 | 서버 자리 B를 UI 착륙 뒤에 켤까요 | 그래요 |
| 6 | `announce` 기본값 표 | R-e 1 |
| 7 | 도구 승인(`tool_call`)의 카드 합치기와 줄 숨김을 2단계로 미룰까요 | 미뤄요 |
