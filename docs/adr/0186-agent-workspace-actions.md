# ADR-0186: 에이전트 워크스페이스 행동 — 제안·승인·실행(propose / approve / execute)과 선언형 카드 카탈로그

- Status: **Proposed** (2026-09-22 기안 Fable. 성재 방향 결재 2026-09-22 4건은 §9에 기록: ①첫 실물=ITO 전 초대 1종 ②승인 정책=위험 등급별 ③ADR-0004 증보 4 Accept D2(a) ④UX-R3a 팔레트 축소 해제. **Accepted 전에는 AX-3a/3b(서버)·AX-4(카드) 머지 금지**(ADR-0100). AX-2 레지스트리·팔레트는 클라이언트 내부 구조라 이 ADR 없이 진행 가능)
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
- 확인은 ADR-0182 결정 트리: 결과를 다시 찾을 일이 있으면 ③ 지속 카드(action_result), 컨트롤이 보이면 ①, 명령 표면이면 ②. 토스트 0.
- 디자인 게이트 불변: 카드 컴포넌트는 토큰만 소비하고 `design_preflight_web` · design-review B0·H0를 지난다.

### D6. 클라이언트 명령의 에이전트 경유(테마 등)
외양은 이 기기 localStorage다(ADR-0174 D3). 서버는 못 바꾸므로 에이전트는 `oort_message_post`에 **명령 참조 props**(`momo.command_suggest.v1 {commandId, args}`, 부록 D)를 실어 보내고, 클라이언트가 그 메시지를 `settings_preview` 카드(현재 값 → 제안 값 미리보기 + 「적용」)로 그린다. 「적용」은 레지스트리 `run`을 호출한다. 서버 실행·승인 행·감사 행이 없다(risk none). 다른 기기에서는 카드가 「이 기기에서 적용」으로 보인다. 서버 동기화 외양은 ADR-0174가 이미 후속으로 미뤘다.

### D7. 스키마·RLS·쓰기 경로
- **DDL 무접촉.** `approval.action_type`(text)·`payload`(jsonb)·`agent_run.output`(jsonb)·자격 스코프(text[])로 충분하다. 새 테이블·칼럼·마이그레이션 없음.
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
    "next": {"label": "설정 › 초대에서 보기", "href": "/settings?section=invites"}
  }
}
```
`status` ∈ `executed | rejected | expired | role_required`. 코드·URL 필드는 없다.

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

### E. `GET /v1/workspaces/{ws}/actions`
```json
{"actions": [{"id": "invite.create", "title": "팀원 초대 링크 만들기", "summary": "…", "risk": "approval", "requiredRole": "admin", "argsSchema": {"type": "object", "properties": {"role": {"enum": ["member", "admin"]}, "maxUses": {"type": "integer", "minimum": 1, "maximum": 100}, "expiresInDays": {"type": "integer", "minimum": 1, "maximum": 30}}}, "executable": true, "unavailableReason": null}]}
```

## 9. 결재 기록
- 2026-09-22 성재(방향, ADR 기안 전): ①AX 첫 실물 = **ITO 전에 초대 1종까지** ②승인 정책 = **위험 등급별** ③ADR-0004 증보 4 = **Accept, D2(a) 이행 복사** ④UX-R3a 팔레트 = **축소 범위 연기 해제**. 「나머지는 설계 구체화, 준비가 온전하면 착수」.
- Accept 결재: (대기)
