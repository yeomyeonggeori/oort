# ADR-0186: 에이전트 워크스페이스 행동 — 제안·승인·실행(propose / approve / execute)과 선언형 카드 카탈로그

- Status: **Accepted** (2026-09-22 성재 결재 — §7 확정점 4건 전부 권고안대로 승인 「승인할게 진행해줘」. 기안 같은 날 Fable. 결재 기록 §9. AX-3a #2508·AX-3b #2509·AX-4 #2510 착수 가능)
- Date: 2026-09-22
- Deciders: 성재
- 역방향: 2026-10-16 [ADR-0113](0113-connector-credential-plugin-boundary.md) 증보 2 E4가 `action_type='connector_tool'`(실행 없는 결정 전달 — Hermes 쓰기 2단계, ADR-0203 증보 K6, Proposed)을 더한다. D2의 같은 tx 실행은 workspace_action에 그대로다. 본문 결정은 바꾸지 않았다.
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
- **run과 분리된 승인 레코드(run-less approval)**: `approval.run_id NOT NULL`을 풀어야 하고 만료 스윕·레일 표시가 갈라진다. hosted 제안은 항상 claim한 job의 run 안에서 일어나므로 필요 없다. 기각.
- **클라이언트가 서버 없이 초대를 실행(에이전트 제안 → 브라우저가 REST 호출)**: 감사 행에 「에이전트가 제안했다」가 남지 않고, 폰·다른 기기에서 결정할 수 없다. 기각. 단, **서버 상태를 바꾸지 않는 클라이언트 명령**(테마·밀도)은 이 모양이 맞다(D3 risk none).

## 3. 결정

### D1. 명령 레지스트리 — 정의는 한 곳, 소비자는 셋
- **워크스페이스 행동은 Rust가 정본**이다. `server-rust/crates/momo-agent/src/actions.rs`에 `ACTIONS: &[WorkspaceAction]`(id·제목·요약·`risk`·`required_role`·인자 JSON Schema·실행기)와 `DECLARED_NOT_EXECUTABLE`(다음 배치 목록)을 둔다. 이 상수에서 **세 소비자가 파생**된다: ① `GET /v1/workspaces/{ws}/actions`(사람 bearer, 멤버) ② Agent Port `oort_action_propose`의 `action_id` enum ③ OpenAPI. 드리프트 가드: enum = ids 동일성 시험, OpenAPI rust 샘플러, 웹 생성 타입 검증.
- **클라이언트 명령(이동·생성·설정·외양)은 TS가 정본**이다. `packages/momo-core/src/features/commands/registry.ts`의 `Command {id, title, group, kind: "navigate"|"client", shortcutId?, run}`. `shortcutId`는 `keyboardShortcuts.ts`의 id를 가리키고, 시험이 양방향 존재를 강제한다(단축키 있는 명령은 레지스트리에 있고, 레지스트리의 shortcutId는 실존).
- 팔레트(⌘K)는 TS 레지스트리 + 서버 `actions` 카탈로그를 **런타임에 합쳐** 「명령」 그룹을 그린다. 「에이전트에게 지시」(옛 UX-R3c)는 별도 모드가 아니라 같은 카탈로그를 에이전트가 `oort_action_propose`로 부르는 것이다.
- v1 `ACTIONS` = `invite.create` 하나. `DECLARED_NOT_EXECUTABLE` = `webhook.create`(ADR-0004 증보 4 랜딩 뒤) · `channel.create` · `member.role.set`.

### D2. 제안 → 승인 → 실행 — 기존 폐곡선 재사용, run은 park
- 새 스코프 **`workspace:propose`**(momo-mcp `SCOPE_WORKSPACE_PROPOSE`). 기본 페어링은 요청하지 않는다. 에이전트가 요청하면 동의 화면(`packages/momo-core/src/features/hostedAgents/model.ts` 스코프 목록·라벨)에 「워크스페이스 변경을 **제안**할 수 있음(실행은 사람 승인)」으로 표시된다. 이 스코프는 어떤 REST도 열지 않는다.
- 새 Agent Port 도구 **`oort_action_propose { handle, actionId, args, rationale }`** (`handle` = `oort_jobs_claim`의 lease handle, `bound_handle` 검사 동일). 서버는 같은 tx에서 ①`args`를 레지스트리 스키마로 검증 ②`approval` 행 생성(`action_type='workspace_action'`, `payload = {action:{id,args,rationale}, proposed_by}`, `run_id` = handle의 run, `channel_id` = run 채널, `expires_at` = 기존 TTL) ③에이전트 명의 `approval_request` 메시지(부록 A props) ④run → `awaiting_approval`. 응답 `{approvalId, status:"pending", expiresAtMs, cardMessageId}`.
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

- Status: **Proposed** (2026-10-25. 머지 조건 = 성재의 Accepted 결재, ADR-0100. V4-10의 결재 요청 다섯 건에 답이 필요하고, 구현은 이 증보와 함께 올라간 슬라이스 하나다)
- 발제: 성재 2026-10-25 「모바일에서도 grok을 통해서 내 프로필을 바꿀 수도 있는거지 ?」 → 사실은 「안 된다」였고(레지스트리에 사람 프로필 사진을 바꾸는 행동이 없다), 요청은 「대화에 사진을 첨부하고 그록봇에게 〈이걸로 내 프로필 사진 바꿔줘〉」다.
- 기안: Sonnet 5.5 worker(#4385)
- Consumes: ADR-0186 D2~D4·V1~V7·V3-2a·V3-13 · ADR-0161 D-M2~D-M4(사람 아바타 `members/me/avatar`, 증보 1) · ADR-0204 D7(승인 푸시 대상·앱에서 열기) · ADR-0162 D6(Agent Port 승인 채널) · ADR-0100
- 접점 이슈: #3791(승인 카드 렌더, UXUI — `action.preview`·`ref.type: member` 표시), #3787(에이전트 아바타 A1 — 같은 이미지 처리 파이프라인)
- 이 증보가 **의도적으로 바꾸는 경계 셋**: ① ADR-0161 D-M2 「에이전트는 인간 아바타를 바꿀 수 없다」 → **승인된 액션 경유로만, 본인에게만** 허용(V4-2). 직접 경로(`members/me/avatar`)의 `require_human`과 에이전트 bearer 비허용은 그대로다. ② ADR-0186 D3의 역할 어휘에 `requesting_member`를 더한다(V4-3): 지금까지 어떤 역할도 「그 행동이 바꾸는 사람 본인」을 뜻하지 않았다. ③ 131의 `agent_avatar_image`가 **주인으로 사람을 받는다**(V4-6, migration 147). 새 테이블은 없다. **바꾸지 않는 것**: D2(제안 → 승인 → 실행)·이미지 처리(V3-2a의 1~3, 6~8: 재인코딩·핀·불변)·`instructions` 불가침·직접 업로드 경로.
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
| 5 | 이미지 검사·재인코딩·sha256 핀·`staged → applied`·불변은 **V3-2a의 파이프라인을 그대로** 쓴다(입력 한 변 ≤2048, ≤5 MiB, PNG/JPEG/WebP 정지 이미지, 결과 ≤512²·≤512 KiB) | 새 디코더 경계를 만들지 않는다 |
| 6 | 저장·서빙은 131의 `agent_avatar_image`·`member.avatar_image_id`·기존 content 프록시. **기존 `members/me/avatar` 경로와는 포인터 단계에서 공존**한다(V4-6) | Drive에 서버가 쓸 길이 없고, Drive 파일을 별칭하면 회수 잡이 첨부를 지운다(V4-8) |
| 7 | 카드는 항상 **앱에서 열어 결정**한다(잠금 화면 승인 없음). 미리보기는 `avatar-preview`를 재사용하되 읽는 사람이 본인 하나 | 사진은 배너로 판단할 수 없다(2026-10-17 결정의 연장) |
| 8 | 한 사람에게 대기 카드는 하나(같은 행동·같은 대상 중복 `Conflict`), 에이전트당 대기 3개 상한은 그대로 | V1-e·V4-M-9 재사용 |
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
| 헤더 치수를 읽지 못함 / 한 변 > 2048 또는 0 | `dimensions_unreadable` / `dimensions_out_of_range` | `InvalidArguments` |
| 디코드 실패·결과가 512 KiB 초과·타임아웃·디코더 대기 | `decode_failed`·`output_too_large`·`timeout`·`busy` | `InvalidArguments` |
| 알 수 없는 키(`memberId`·`targetHandle`·`url`·`dataBase64`…) | — (스키마·파서) | `InvalidArguments` |
| 같은 사람에게 대기 카드가 이미 있음 / 에이전트의 대기 3개 | — | `Conflict`(409) |
| 결정자가 사진 주인이 아님 | — | (결정 응답) 403 `role_required`, 승인 소모 없음 |
| 핀·해시가 어긋남 | — | (결정 응답) 409 `action_args_invalid`, 승인 소모 없음 |

### V4-3. 역할 `requesting_member`
`RequiredRole::RequestingMember`(와이어 `requesting_member`, 한국어 「사진 주인 본인」)는 「그 행동이 바꾸는 사람이 결정자」다. `gate_plan`의 exhaustive match가 `GatePlan::RequestingMember`를 정하고, 결정 경로(`execute_workspace_action`)는 해석된 `GateSubject::Member(person)`을 `input.member_id`와 비교하며, 푸시 대상(`CardAudience::allows`)은 같은 핀(`pinned_target_member`)의 사람 하나에게만 깨어난다. 어느 쪽도 관리자 분기를 갖지 않는다.

### V4-4. 입력 크기: 폰 사진이 거절된다 — 성재 결정 필요 ⚠
- 직접 업로드(ADR-0161 D-M3)는 **4096×4096·GIF 허용**이고, 에이전트 경로의 이미지 파이프라인은 **한 변 ≤2048·PNG/JPEG/WebP 정지 이미지**다(V3-13 2: 4096²에서 RSS 160~310 MB, 디코드 2건 동시). 4032×3024 폰 사진은 이 행동에서 **거절된다**. 시험이 이 사실을 못박는다(`…refuses_every_picture…`의 「a phone-size picture」).
- 이 행동의 대표 시나리오가 「폰에서 찍은 사진을 첨부」라는 점이 문제다. [확인 필요] 폰 첨부 업로드가 길이를 줄이는지(iOS 선택기의 「실제 크기」 옵션, HEIC→JPEG 변환 여부)는 이 증보가 실측하지 않았다 — UXUI/폰 쪽 확인이 필요하다. HEIC가 그대로 올라오면 mime 허용 목록(PNG/JPEG/WebP) 밖이라 이 행동도, 직접 업로드도 못 쓴다.
- 선택지: (A) **지금 상한 유지** — 에이전트 지시문이 「크면 줄여 다시 보내 달라고」 안내한다(구현됨). (B) 이 행동에만 **입력 상한을 4096으로 올리고** 동시 디코드를 1로 낮추거나, 큰 입력을 **축소 먼저** 디코드하는 경로(JPEG DCT 스케일 디코드)를 따로 만든다 — 메모리 실측(RSS)이 선행 조건이다. (C) 폰 클라이언트가 첨부를 올리기 전에 긴 변 2048로 줄인다(서버 변경 없음, UXUI 이슈).
- 이 증보의 구현은 (A)다. 어느 쪽으로 가든 서버 상수 하나(`AGENT_AVATAR_IN_MAX_DIM`)와 이 표의 문구가 바뀐다.

### V4-5. 에이전트 지시문(제안 방법)
에이전트가 실제로 읽는 곳은 둘이다 — `oort_action_propose`의 도구 스키마 분기 `description`(`momo-mcp`)과 `docs/SELF_HOST_AGENT.md` 3.3.16b의 표 행·항목. 서버가 따로 주입하는 프롬프트는 없으므로 이 둘이 정본이고 같은 내용을 말한다: 누군가 사진을 보내며 「이걸로 내 프로필 사진 바꿔줘」라고 하면 `member.avatar.set`으로 제안한다. `attachmentId`는 `oort_conversation_read`의 `imageAttachments[].id`이고 **그 사람이 이 대화에 보낸 사진 하나**다. 대상은 말을 건 본인뿐이고 다른 사람의 사진·다른 대화의 사진은 쓸 수 없다. 그 사람이 카드에서 직접 보고 승인해야 바뀐다. 한 변 2048px을 넘는 사진·GIF·움직이는 이미지는 거절되니 그땐 사진을 줄여 다시 보내 달라고 부탁한다. 제안 뒤에는 턴을 끝낸다(3.3.16b의 규칙 그대로).

### V4-6. 저장: 131 테이블을 사람에게 열고, 사람 쪽 두 경로를 고친다 (migration 147)
- 새 테이블은 없다. 147은 `agent_avatar_image_guard_insert` 하나를 바꾼다: **제안자(`proposed_by`)가 에이전트**이고 **주인(`member_id`)이 살아 있는 멤버**이면 된다(131: 주인이 에이전트). 사람이 이 테이블에 자기 행을 직접 넣는 길은 여전히 없다(제안자 = 에이전트). 불변 트리거·`approval_id` write-once·복합 FK(자기 몫 이미지만 가리킴)·`member_avatar_exclusive_ck`·RLS FORCE는 그대로다. 테이블 이름 변경은 범위 밖이다.
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
4. 두 사람 경로의 공존 수리(147과 `settle`·`clear`)가 직접 업로드의 기존 계약(자기만·20회/시간·Drive 검증)을 건드리지 않는가.
5. 감사 3종이 값·바이트 없이 사유 코드만 남기는가.
6. 같은 사람에게 에이전트가 반복 제안해 카드를 쌓는 남용: 한 사람 한 카드·에이전트 대기 3개·디코드 동시 2·10초. **시간당 상한은 두지 않았다**(V3-6 결재 4와 같은 이유; 다르게 하려면 성재 결정).

### V4-10. 결재 요청 (성재)
1. **이 증보의 Accepted 여부**(사람 프로필 사진을 승인된 액션으로 에이전트가 제안한다, 본인만 승인).
2. **V4-4**: 폰 사진 입력 한 변 상한 — (A) 2048 유지+「줄여 보내 달라」 안내(구현) / (B) 서버에서 4096·축소 디코드 / (C) 폰이 올리기 전에 줄임.
3. **V4-6**: `agent_avatar_image` 이름·「주인=에이전트」 가정을 사람에게 여는 것(147)에 동의하는지, 아니면 사람 이미지는 별도 테이블로 가를지.
4. 에이전트가 **자기 소유자 아닌 사람**의 요청에도 이 카드를 제안할 수 있다(그 사람이 에이전트를 불렀다면) — 의도가 맞는지(구현: 맞다; 본인이 부른 에이전트이면 누구든).
5. 시간당 제안 상한 비도입 유지 여부(V4-9 6).

### V4-11. 구현 슬라이스와 수용 기준(red proof)
한 슬라이스(#4385, base `track/engine`): migration 147 · 레지스트리·역할·결정기·푸시 · 소스·도출 질의 · 제안 준비·스테이징·감사 · 미리보기 판정 · 사람 경로 공존 수리 · OpenAPI·런북·도구 스키마. 각 시험은 해당 분기를 지우면 실패해야 한다(PR 본문의 사보타주 표가 정본이다).
- 레지스트리: 역할 `requesting_member`, 스키마의 유일한 키 `attachmentId`, 항상 앱에서 열기, `ACTIONS`·도구 enum·OpenAPI 9개 일치.
- 제안: 남의 첨부·다른 대화 첨부·GIF·폰 크기·비이미지·미완료·미결속·없는 id는 **같은 응답**이고 `staged` 행 0개. 대상·URL·바이트 키는 `InvalidArguments`. 관리자가 멘션해 만든 런으로는 요청자의 파일을 쓰지 못한다. 대조군으로 같은 설정에서 요청자의 파일은 200.
- 카드: 핀의 대상 = 요청자, 저장 인자에 첨부 id·Drive id 없음, 스테이징 행의 주인 = 요청자·제안자 = 에이전트.
- 미리보기·결정·푸시: 요청자만 200, 관리자·에이전트 소유자·다른 방 멤버는 404/403 `role_required`·승인 pending·포인터 불변. 바이트를 바꾼 뒤 결정하면 409 `action_args_invalid`.
- 적용: 포인터·`applied`·서빙 바이트 = 서버가 쓴 것, 감사 행위자=주체=본인·값 없음. 거절·만료는 `staged` 삭제·얼굴 불변. 한 사람 한 카드(409).
- 공존: 에이전트가 정해 준 이미지가 있는 사람이 직접 올리면 성공하고 이미지 행이 사라진다. 「내 사진 지우기」는 이미지도 지운다. 에이전트용 apply가 사람에게, 사람용 apply가 에이전트에게 적용되지 않는다. 사람이 이 테이블에 직접 INSERT하면 거절.
- 도출: 에이전트가 쓴 트리거·다른 에이전트의 런·탈퇴한 사람은 요청자가 없다. DM의 요청자 파일은 찾고 다른 대화·남의 파일·삭제된 메시지·크기 초과는 못 찾는다.
- DM: 소유자의 1:1 DM에서 런이 서고 같은 대화의 파일만 쓰이며 본인만 승인한다(E2E). 다른 대화의 본인 파일은 거절.
- 미검증 표시: 벤더(그록봇·dots·Muse)와의 실제 왕복, 폰·웹 승인 카드 표시(UXUI), 폰 첨부의 실제 크기·형식(V4-4)은 `runtime-unverified`다.
