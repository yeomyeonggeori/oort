# ADR-0186: 에이전트 워크스페이스 행동 — 제안·승인·실행(propose / approve / execute)과 선언형 카드 카탈로그

- Status: **Accepted** (2026-09-22 성재 결재 — §7 확정점 4건 전부 권고안대로 승인 「승인할게 진행해줘」. 기안 같은 날 Fable. 결재 기록 §9. AX-3a #2508·AX-3b #2509·AX-4 #2510 착수 가능)
- Date: 2026-09-22
- Deciders: 성재
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

- Status: **Proposed** (2026-10-11 기안. 성재가 「ㄱㄱ」로 설계 착수를 승인했을 뿐 이 증보는 아직 Accepted가 아니다. ADR-0100에 따라 **Accepted 전에는 구현 PR을 머지하지 않는다.** 확정점은 V9.)
- 발제: 성재 2026-10-11 「에이전트 하나만 잘 초대하면 에이전트를 통해서 설정을 바꾸거나 테마를 바꾸거나, 팀원을 초대하거나 그런걸 가능하게 하는 AI native 메신저」, 「그록봇 하나만 초대하면 걔가 그룹을 꾸리고 이름을 바꾸거나 다른 그록봇을 만들어서 초대」
- 기안: Opus 5.5 worker(#3699)
- Consumes: ADR-0162(채널 승인 권한 주체 = 관리자의 confirm, 증보 2 DM 규칙) · ADR-0128(채널 생성·멤버 추가는 워크스페이스 owner/admin) · ADR-0131(에이전트 프로필 편집 = 소유자 또는 관리자) · ADR-0118(이름 변경 경계) · ADR-0101(에이전트=1급 멤버, 분기 금지) · ADR-0198(에이전트 vs 하네스) · ADR-0174(외양은 기기 localStorage)
- 이 증보는 D2(제안 → 승인 → 실행)·D3(위험 등급)·D4(1회 시크릿)·D7(새 테이블 0)을 **바꾸지 않는다.** D1의 레지스트리에 행동 넷을 더하고, 그 넷이 처음으로 부딪히는 문제(V2: 한 run은 한 번만 제안한다 / V3: 승인 채널이 사람의 경계다 / V4: 표시 이름이 신뢰 표면이다)에 답한다.

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
| `agent.rename` | `approval` | **`agent_editor`**(신규: 그 에이전트의 소유자 또는 워크스페이스 admin — `require_profile_editor_in_tx`와 같은 판정) | 제안한 **자기 자신**의 표시 이름만 | 새 이름 하나(대상 id 없음) |
| `hosted.channels.grant` | `approval` | `admin`(ADR-0162: 채널 승인 권한 주체는 관리자) | **제안한 에이전트의 connection**의 승인 채널에 채널 추가 + membership | 채널 이름들 |
| `workspace.settings.update` | — | — | **이번에도 열지 않는다.** `DECLARED_NOT_EXECUTABLE`로 옮기고 이유를 적는다(V7) | — |
| `member.role.set` | — | — | 계속 `DECLARED_NOT_EXECUTABLE`(#3699 범위 밖) | — |

공통 규칙(V1-a~e):
- **a. 에이전트는 id를 모른다.** 인자는 채널 **이름**·멤버 **핸들**·새 **표시 이름**이다. uuid를 받지 않는다. 서버가 propose 때와 decide 때 두 번 해석하고, 카드 행에는 해석된 **서버 쪽 값**(현재 채널 이름·공개 범위·인원 수, 멤버 표시 이름)을 쓴다. 에이전트가 쓴 문자열이 곧 카드의 대상 표시가 되는 길은 없다.
- **b. 대상은 제안자의 시야 안이다.** `channel.member.add`의 채널과 `hosted.channels.grant`의 채널은 (공개 채널) ∪ (제안 에이전트가 지금 live membership을 가진 채널)이어야 한다. 그 밖(남의 비공개 채널, 존재하지 않는 이름, DM, 보관됨)은 모두 같은 `InvalidArguments`다. 에이전트가 제안 실패로 비공개 채널의 존재를 더듬을 수 없다. v1처럼 어떤 규칙에 걸렸는지는 알려 주지 않는다.
- **c. 승인자 판정은 레지스트리의 `required_role`이고 `match`는 계속 exhaustive다.** `RequiredRole::AgentEditor`를 더하면 `execute_workspace_action`의 게이트 `match`가 컴파일 오류로 새 갈래를 요구한다. 판정에 쓰는 에이전트는 `approval.requested_by`(제안자)다. 카드 인자의 대상이 아니다.
- **d. 결정 때 재증명한다**(D2의 「저장값을 신뢰하지 않는다」 그대로). 이름·핸들·채널을 다시 해석하고 규칙(V1-b, V4, V3의 상한)을 다시 건다. 어긋나면 새 영수증 어휘를 만들지 않고 기존 `action_args_invalid`(409, 승인 소모 없음)로 답한다. 클라이언트의 `receiptStatuses`·카드 문구를 늘리지 않으려는 선택이고, 카드는 「제안 내용이 더 이상 맞지 않아요. 거절하고 다시 요청해 주세요」로 남는다.
- **e. 제안 폭주 상한.** 한 에이전트의 `pending` 상태 `workspace_action` 승인은 3개까지다. 넘으면 `Conflict`. run이 제안마다 park되므로 평상시에는 닿지 않는 상한이고, 재호출로 카드를 쌓는 오작동을 막는다.

### V2. 인자 스키마(와이어는 camelCase, 전부 `additionalProperties:false`)
- `channel.create`: `{name: string, kind?: "public"|"private", topic?: string, addProposer?: boolean, memberHandles?: string[]}`. `name` 필수. 이름·주제 규칙은 REST와 **같은 함수**(`normalize_channel_name`: 소문자·숫자·`-`·`_`, 1~80자 / `normalize_channel_topic`: ≤280자)로 맞춘다. `kind` 기본값은 **`private`**(에이전트가 공개 채널을 만들려면 `public`을 말해야 하고, 카드 행에 그대로 보인다). `addProposer` 기본값은 `true`(V3). `memberHandles` ≤10, 활성 멤버(사람·에이전트).
- `channel.member.add`: `{channel: string, memberHandles: string[1..10]}`. 둘 다 필수. 역할 인자는 없다(`member` 고정, `add_channel_member_in_tx`가 이미 `owner`를 거절).
- `agent.rename`: `{displayName: string}`. 필수. 제안자 자신만 바꾼다. 대상을 가리키는 인자가 **없다.**
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

### V4. `agent.rename` — 이름은 신뢰 표면이다
이름은 모든 메시지 옆·멘션 목록·서버 음성 안내 줄(`bins/momo-server/tests/agent_port_tools_conformance_pg.rs:1819-1825`: 「[보안 재인증](https://evil.example)」 이름으로 링크를 심으려는 시도)에 그려진다. 그리고 `@Display Name`이 멘션이 되므로 **다른 멤버의 이름을 가진 에이전트는 그 멤버의 멘션을 가로챈다.** 에이전트 제안 경로는 `normalized_join_display_name`(trim·1~100자)을 쓰지 않고 **더 엄격한 한 함수**를 거친다.

`validated_agent_proposed_display_name(raw, roster)`:
1. NFKC 정규화 → 앞뒤 공백 제거 → 내부 공백열은 한 칸으로.
2. 길이 1~32자(문자 수).
3. **허용목록**: 글자(`L*`)·숫자(`N*`)·결합 표지(`M*`)·공백·`-`·`_`·이모지(Extended_Pictographic, 최대 2개). 이 밖의 모든 문자는 거절한다. 따라서 `@ < > [ ] ( ) : / \ . # & ` ` 따옴표 등 멘션·마크다운·URL을 이루는 문자가 이름에 들어올 수 없다.
4. 제어·서식 문자(`Cc`·`Cf`: 영폭 공백, 방향 제어 포함)·줄바꿈·`Zl`/`Zp` 거절. (3)의 허용목록이 이미 포함하지만 단정을 따로 둔다.
5. **충돌 검사**: 골격(skeleton = NFKC → casefold → 공백·`-`·`_` 제거 → 흔한 키릴·그리스 유사 문자 매핑)이 **같은 워크스페이스의 다른 비삭제 멤버의 `display_name` 또는 `handle` 골격**과 같으면 거절한다(대소문자 구분으로 멘션이 되는 현재 규칙의 모든 우회를 닫는다). 자기 자신의 현재 이름과 같으면 오류가 아니라 no-op이다.
6. **예약어**: `oort`·`오르트`·`admin`·`administrator`·`system`·`시스템`·`관리자`·`운영자`·`보안`·`security`·`support`·`everyone`·`channel`·`here`·`all`·`모두`·`전체`(골격 비교, 목록은 코드 상수 + 시험).

카드: 「현재 이름 → 새 이름」 두 행. 행 값은 **평문**이다(링크·멘션을 자동으로 해석하지 않는다는 렌더 규칙을 부록 A에 못박는다). 승인자는 `agent_editor`: 그 에이전트의 소유자 또는 admin(구독·개인 에이전트의 소유자는 admin이 아니어도 자기 에이전트 이름을 승인할 수 있다). 

실행: 새 도메인 함수 `rename_agent_display_name_in_tx`(`momo-messaging/src/member_rename.rs`, 사람용 `rename_own_display_name_in_tx`의 쌍. `member` 행을 `FOR UPDATE`, `kind='agent'`, 같은 `member.renamed` 브로드캐스트를 co-member 채널마다 outbox로). 이 함수 하나를 **에이전트 제안 경로와 사람용 라우트가 같이 쓴다.** handle은 바꾸지 않는다(멘션 주소·connection 바인딩이라 별도 결정).

**사람용 라우트(신규)**: `PATCH /v1/workspaces/{ws}/agents/{agent}` body `{displayName}`. `require_human` + `require_profile_editor_in_tx`(소유자 또는 admin). 검증은 사람의 책임 아래 `normalized_join_display_name`(생성 경로와 같음)에 **충돌 검사(V4-5)만** 더한다. 에이전트 제안 쪽만 허용목록·예약어를 건다 — 사람이 정한 「김 인턴 (비서)」는 막지 않고, 카드를 읽는 사람이 속을 수 있는 입력만 좁힌다. 감사 `member.renamed`는 사람용 자기 변경과 같은 `momo.member.renamed.v1`이고 `kind:"agent"`를 더한다. 웹·데스크탑·폰 UI는 이 증보의 범위 밖(UXUI 후속 티켓).

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
| `agent.rename` | `member.renamed` | `{old, new, kind:"agent", via_agent, approval_id}` |
| `hosted.channels.grant` | `hosted_connection.channels_granted` | 위와 같음 |
`actor`는 승인자(`.by`), 제안자는 `.about`(기존 `action.approved`와 같은 모양). 기존 REST 두 경로(`channels.create`·`add_member`)는 audit이 없었다. **이 증보는 그 REST에 audit을 소급하지 않는다**(무관한 변경은 별도 이슈). 새 audit은 에이전트 경유 경로에서만 쓴다.

**제안한 에이전트에게 결과를 돌려주는가**: 돌려주되 **비밀이 아닌 것만, 기존 통로로** 돌려준다. 새 통로를 만들지 않는다.
- 비밀이 아닌 결과(생성된 채널의 id·이름, 추가된 멤버, 바뀐 이름)는 승인 때 이미 채널에 남는 에이전트 명의 `action_result` 메시지(부록 B)의 `ref`·`rows`에 있다. 에이전트는 다음 턴에 `oort_conversation_read`로 그것을 읽는다. 채널 생성 뒤 새 채널에 말하려면 `oort_message_post`의 `channelId`가 필요하므로 `ref.id`가 읽혀야 한다 — S1이 `oort_conversation_read`가 `action_result`의 `ref`를 에이전트에게 내보내는지 확인하고, 아니라면 결과 줄 본문에 채널 이름과 id를 평문으로 싣는다(비밀이 아니다).
- **초대 링크(D4의 1회 시크릿)는 돌려주지 않는다.** 에이전트에게 링크가 가면 (a) 채널 전체가 읽는 메시지가 되거나 (b) 에이전트의 외부 런타임·로그에 남는다. 「승인자에게만 1회 보인다」는 D4의 성질 자체가 이 행동의 보안 모양이다. 대신 결과 줄은 「링크는 승인한 분만 볼 수 있어요. 필요하면 승인한 분이 전달해요」로 사람에게 다음 행동을 알려 준다. 승인자가 링크를 에이전트와 공유하고 싶다면 사람이 자기 손으로 붙여 넣는다.
- 이 증보의 네 행동은 1회 시크릿이 **없다**(`secretOnce` 부재). 결정 응답의 `result`는 `{actionId, ref}`만 갖는다.

### V7. 범위 밖과 이유
- **테마·외양**: 기기 localStorage(ADR-0174)라 서버가 못 바꾼다. D6의 `command_suggest`·`settings_preview`(#2511 AX-5)로 간다.
- **다른 그록봇을 자동으로 만들어 초대**: 그록 쪽 API가 공개 문서에서 확인되지 않았고 약관 위험이 있다. 그리고 oort 쪽에서도 hosted 연결의 **confirm은 구조상 사람의 행동**이다(ADR-0162: 승인 없이 capability 0, 사람의 confirm + 별도 active proof + unpause). 이 증보가 에이전트에게 연결을 만들거나 confirm할 길을 주지 않는다. 사람이 새 에이전트를 연결하는 경로는 변하지 않는다.
- **`workspace.settings.update`**: 열지 않는다. 이유 셋 — (1) 게이트가 `require_admin`이 아니라 `require_workspace_operator`(owner/admin + `PLATFORM_ADMIN_EMAILS`)라 세 번째 `RequiredRole`과 별도 증명이 필요하다. (2) 허용 키 4개 중 `allowed_agent_models`(모델·비용 정책)와 `welcome_agent_member_id`(에이전트가 자기를 환영 에이전트로 지명)는 에이전트가 제안하면 안 되는 종류다. (3) 이슈가 (선택)으로 표시했고, 연 뒤에 얻는 가치가 `welcome_prompt`·`role_labels` 두 키뿐이다. 열게 되면 키 허용목록(`welcome_prompt`·`role_labels`만)을 레지스트리 인자 스키마에 박는 별도 증보가 필요하다. `DECLARED_NOT_EXECUTABLE`의 이유 문구: 「에이전트가 제안해도 되는 설정 키를 먼저 정해야 열립니다.」
- **`member.role.set`·`webhook.create`**: 이번 범위가 아니다(각각 declared 그대로, `webhook.create`는 ADR-0004 증보 4 / AX-8 #2514).
- **관리 에이전트 이름 변경·handle 변경**: V4는 자기 자신의 표시 이름만. 다른 에이전트를 가리키는 인자는 「에이전트가 에이전트를 관리한다」는 신뢰 모델을 새로 만들어야 해서 닫아 둔다.
- **「관리자 위임으로 무승인 허용」**: **이번에도 미룬다.** D3의 이유(스코프 원장·설정 표면 추가가 필요)가 그대로이고, 이 증보의 네 행동 중 둘(`hosted.channels.grant`, `agent.rename`)은 접근 범위와 신원을 바꾸므로 위임 대상이 **될 수 없는 등급**으로 못박는다 — 나중의 위임 ADR은 이 둘을 위임 가능 목록에서 제외하는 것을 전제로 쓴다.
- 사람용 rename UI, 카드 렌더러의 행 종류 추가(`ref.type` 확장 등) 화면 작업은 UXUI 후속이다.

### V8. 기각한 대안과 업계 비교
1. **에이전트에게 `channels:manage` 같은 스코프를 주고 직접 실행**: Slack(`channels:manage`)·Discord(`MANAGE_CHANNELS`) 봇 모델이다. 설치 때 한 번 동의하면 이후 호출마다 사람의 확인이 없다. oort는 에이전트 토큰 유출 = 워크스페이스 장악을 막으려고 D2에서 기각했고, 여기서도 같다. Slack Workflow Builder류의 「사람이 승인 단계를 누르는 흐름」에 가깝다. **행동마다 사람 승인 + 승인자 권한 실행**이 oort의 위치다.
2. **membership = 승인 채널**: `channel.member.add`가 에이전트를 넣으면 자동으로 읽고 쓰게 하는 단순한 모양. ADR-0162가 사람의 경계로 만든 `approved_channel_ids`를 이름 모를 admin 한 명의 멤버 추가가 조용히 넓히게 된다. 기각.
3. **세 장 카드로 쪼개기(만들기 → 나 넣기 → 승인 채널 올리기)**: 한 run은 한 번만 제안하므로 세 run이 필요하고 중간 상태가 사람에게 보인다. V3의 합성이 대신한다.
4. **에이전트가 uuid를 인자로**: 에이전트가 id를 알려면 roster·채널 목록 읽기가 필요한데 hosted 토큰에는 그런 스코프가 없다. 이름·핸들을 서버가 해석한다(V1-a).
5. **에이전트 rename에 기존 `normalized_join_display_name` 사용**: 링크 주입(1819)·멘션 가로채기를 막지 못한다. V4.
6. **초대 링크를 에이전트에게 돌려주기**: V6.

### V9. 성재 확정점(Accept 조건)
1. **V3 합성 행동**: `channel.create`가 에이전트 접근 범위(승인 채널)까지 함께 넓히는 것을 한 승인으로 묶는가, 기본값은 `addProposer: true`인가. (권고: 묶는다 + 기본 true + 카드의 별도 행. 대안: 기본 false로 에이전트가 말해야 켜짐.)
2. **V4 `agent.rename` 범위**: 자기 자신만 + 승인자는 소유자 또는 admin인가. (권고: 그렇다. 대안: 관리 에이전트 포함 — 신뢰 모델이 따로 필요.)
3. **V7 `workspace.settings.update`**: 이번에 열지 않는가. (권고: 열지 않는다. 대안: `welcome_prompt`·`role_labels`만 operator 게이트로.)
4. **V5 `hosted.channels.grant`**: 에이전트가 자기 승인 채널 확대를 단독으로 청할 수 있게 하는가. (권고: 허용하되 공개 ∪ 이미 멤버·자기 connection·50개 상한·admin 승인. 대안: `channel.create` 합성만 허용하고 단독 제안은 두지 않음.)
5. 위 1~4와 별개로 아래는 이 증보의 **기본안이며 이의가 없으면 확정**: 초대 링크는 에이전트에게 돌려주지 않는다(V6), 무승인 위임은 미룬다(V7), 사람용 `PATCH …/agents/{agent}` 라우트를 범위에 넣는다(V4).

### V10. 구현 슬라이스
| ID | 내용 | 선행 |
|---|---|---|
| S0 | 레지스트리 기반: `RequiredRole::AgentEditor`, `ActionArgs` 변형, `validated_action_args`를 순수 모양 검증 + 트랜잭션 안 해석(이름·핸들)으로 분리, 도구 `args` 스키마 구조(`oneOf`) 재작성, 드리프트 시험 재작성, 보류 승인 3개 상한, `GET actions`·OpenAPI 갱신, 동의 화면 문구 | **ADR Accepted** |
| S1 | `channel.create`(+합성 V3) + 감사 + 결과 줄 | S0 |
| S2 | `channel.member.add` | S0 |
| S3 | `agent.rename` + 사람용 `PATCH …/agents/{agent}` + 공유 도메인 함수 + 엄격 검증기 + 1819 방식 red 시험 | S0 |
| S4 | `hosted.channels.grant`(`momo-auth` 도메인 함수 + 행동) | S0 |
| S5 | 에이전트 지시문·문서: hosted 루틴이 새 행동과 「제안 뒤 turn 종료」를 배운다 | S1~S4 |
행동 하나당 손대는 곳은 다섯이다: `momo-agent/src/actions.rs`(`ACTIONS`·카드 행·`effect` 문장) · `routes/actions.rs`(`validated_action_args`) · `routes/approvals.rs`(`execute_workspace_action`) · `momo-mcp/src/tools.rs`(`WORKSPACE_ACTION_IDS`·`action_propose_schema`) · `docs/api/openapi.yaml`(`WorkspaceActionId`·스키마).

### V11. 수용 기준(구현 슬라이스가 인용할 red proof)
각 시험은 해당 분기를 지우면 실패해야 하고 그 RED를 PR 본문에 남긴다.
- `ACTIONS` id 집합 = 도구 `actionId` enum = OpenAPI enum, 그리고 행동별 `args` 스키마가 도구와 카탈로그에서 같다(시험이 행동마다 잰다).
- 인자에 uuid·알 수 없는 키가 있으면 `InvalidArguments`. 남의 비공개 채널·DM·존재하지 않는 채널·보관된 채널은 **같은** 오류(구분 불가)다.
- `channel.create`: 비-admin 결정자는 403 `role_required`이고 채널 0개·승인 pending. 승인 시 채널·승인자 owner membership·(`addProposer`이면) 에이전트 membership·`approved_channel_ids`가 **한 tx**이고, 중간 실패 시 전부 없다. `addProposer:false`면 에이전트 membership·승인 채널 0.
- `hosted.channels.grant`: 다른 에이전트의 connection은 건드리지 못한다(인자 표면에 없음을 시험). `confirmed_by`·`active_token_id`·`approved_scopes`·`approved_dm_channel_ids` 불변. 51번째 채널은 거절.
- `agent.rename`: 1819의 링크 이름·`@다른멤버`·`<@다른멤버>`·영폭 공백이 섞인 이름·다른 멤버 이름의 대소문자·전각 변형·예약어가 전부 `InvalidArguments`. 승인자가 소유자(비-admin)여도 승인된다. 제3자 비-admin은 403 `role_required`.
- 사람용 `PATCH …/agents/{agent}`: 소유자·admin만 성공, 제3자 403, 에이전트 bearer 403, 충돌 이름 409.
- 감사: 행동마다 `action.approved` + V6의 도메인 행. 어느 행에도 이름 외 비밀이 없다(1회 시크릿이 없는 행동들이지만 grep 시험은 유지).
- 결정 때 재증명: 제안 뒤 채널 이름이 선점되거나 에이전트가 방에서 빠지면 `action_args_invalid`, 승인 pending 유지.
