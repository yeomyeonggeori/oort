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
| `for_member_id` 본인(데스크탑) | 조작 가능한 연결 카드. 1단계 로컬 카드와 **같은 컴포넌트**이고 머리만 「{에이전트}가 제안했어요」. 내 계정 절 + 팀 연결 절(운영자면 조작, 아니면 읽기 전용 + 「운영자에게 부탁하기」) |
| 본인(웹 탭) | 같은 카드. 내 계정 절은 「구독 계정은 데스크탑 앱에서만 연결하고 볼 수 있어요」 한 줄 |
| 본인(폰) | 읽기 + (운영자면) 팀 연결 확인만. 구독 로그인·키 입력은 폰에서 받지 않는다(Q5) |
| 운영자(본인 아님) | 한 줄 「{for_member}에게 AI 연결을 제안했어요」 + 「팀 연결 보기」(팀 키 줄만 펼침, 조작 가능). 남의 구독 상태는 보이지 않는다 |
| 그 밖의 멤버 | 한 줄 「{for_member}에게 AI 연결을 제안했어요」. 입력·버튼 0 |

- 운영자 = 서버의 `require_instance_operator`(owner/admin + `PLATFORM_ADMIN_EMAILS`)를 지나는 사람이다. 클라이언트는 이 판정을 기존 provider_link 응답(403이면 비운영자, 코어 `isOperatorDenied`)으로 안다. 카드 전용 판정을 새로 두지 않는다.
- **경계는 숨긴 버튼이 아니다.** 구독 로그인은 본인 기기의 PTY(#2816 모달), 팀 키 쓰기·확인은 운영자 라우트(비운영자 403)다. 다른 사람이 DOM을 고쳐 버튼을 살려도 할 수 있는 일이 없고, props에 비밀이 없으니 누가 받아도 새는 것이 없다.
- 채널·DM·스레드 모두 허용한다(Q4). 채널 전체가 한 줄을 본다는 것은 「누가 연결을 요청했다」를 드러내는데, 이는 사람이 채널에서 에이전트에게 말한 사실 이상이 아니다. 완전히 숨기면 채널의 대화 맥락이 끊겨서 택하지 않았다.
- 알림: 제안 메시지는 그 에이전트의 일반 답과 **같은 알림 규칙**을 따른다. 카드 때문에 따로 푸시하지 않는다.
- 제안은 승인 카드가 아니다(D3 `approval` 아님). 사람이 자기 화면에서 여는 도구 창이다. approval 행·결정 라우트·만료 스윕과 무관하다.
- 모르는 `command_id`, kind가 `client`가 아닌 명령, `for_member_id`를 멤버 목록에서 찾지 못한 경우는 본문 폴백(부록 D 규칙 유지).

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
