# AX-3a — 워크스페이스 행동 레지스트리 + `oort_action_propose` (ADR-0186 D1·D2·D7)

- status: draft (착수 조건: **ADR-0186 Accepted**)
- issue / planning ID: #2508 · PLN-20260922-AX3A
- owner / reviewer: Fable(planner) / Grok 리뷰어 C(diff+context 사본, 사보타주 요구) + planner 재판정
- track / base commit: engine · `origin/track/engine` (발사 시 tip 기록)
- supersedes: 없음

## Goal
hosted 에이전트가 claim한 job 안에서 워크스페이스 행동을 **제안**할 수 있다. 제안은 기존 `approval` 행 + `approval_request` 카드가 되고 run은 `awaiting_approval`로 park된다. 실행·결정 분기는 AX-3b.

## 계약과 범위
- 정본: ADR-0186 D1·D2·D7·§5, 부록 A·E. 수용기준: 이슈 #2508.
- 허용 파일: `server-rust/crates/momo-agent/src/actions.rs`(신설)·`lib.rs`(export) · `server-rust/crates/momo-mcp/src/tools.rs`(스코프 상수·`ToolDescriptor` 1건) · `server-rust/bins/momo-server/src/routes/agent_port_tools.rs`(도구 실행·run 가드) · `routes/actions.rs`(신설, `GET /v1/workspaces/{ws}/actions`)·`lib.rs`(라우트 마운트) · `momo-auth/src/agent_scope.rs`(스코프 표) · `docs/api/openapi.yaml` · `packages/momo-core/src/features/hostedAgents/model.ts`(스코프 목록·라벨 1행) + 그 시험 · `docs/SELF_HOST_AGENT.md`(스코프 요청·「제안 뒤 turn 종료」 규칙 1절) · conformance 시험(`agent_port_tools_conformance_pg.rs` 확장 또는 신설).
- 지킬 계약: DDL 무접촉 · 모든 쓰기 `agent_tenant_tx` · 메시지는 `send_message_in_tx` · outbox 생산자 신설 0 · `has_scope` 교집합 규칙(토큰∩승인) · 에이전트는 어떤 시점에도 admin 스코프를 얻지 않는다.
- 범위 밖: 결정 분기·실행기·감사·`secretOnce`(AX-3b) · 내부 worker CATALOG(#2016) · 웹훅(AX-8).

## 구현에 필요한 맥락
- `actions.rs`: `WorkspaceAction {id:"invite.create", title, summary, risk: Risk::Approval, required_role: Role::Admin, args_schema: fn()->Value}` + `ACTIONS` + `DECLARED_NOT_EXECUTABLE = ["webhook.create","channel.create","member.role.set"]`. 인자 검증은 서버 스키마로(role enum·maxUses 1..100·expiresInDays 1..30 — 기존 `normalized_invite_role`·`validated_max_uses`·`validated_expires_at_ms` 재사용, 새 검증기 작성 금지).
- 도구: `oort_action_propose {handle, actionId, args, rationale(≤280)}`. `handle`은 `oort_jobs_claim` lease handle — `bound_handle`(`agent_port_tools.rs:664`)로 동일 검사. 스코프 `SCOPE_WORKSPACE_PROPOSE = "workspace:propose"`. `tools/list` 노출 규칙은 기존 `tool_view_for`.
- 제안 tx: `create_pending_approval_in_tx`(`momo-agent/src/approval.rs:180`)로 행 생성 — `action_type="workspace_action"`, `payload={"action":{"id","args","rationale"},"proposed_by":<agent member>,"resume_model":null}`(`approval_payload`는 tool_call용이라 **쓰지 않고** 별도 빌더) → `approval_request` 메시지(`approval_request_props`를 확장해 부록 A `action` 블록 추가; 기존 필드 유지) → `attach_request_message_in_tx` → run `awaiting_approval`(기존 park 전이 함수를 찾아 재사용, 없으면 `run.rs`에 추가).
- run 가드: `run_complete`(`agent_port_tools.rs:814`)·`job_release`가 run 상태 `awaiting_approval`이면 `ToolFailure` `approval_pending`(기존 5종 wire failure 중 conflict 계열에 매핑 — `a_domain_status_maps_onto_one_of_the_five_wire_failures` 시험 갱신).
- 만료: 기존 스윕(`overdue_approvals_in_tx`)이 `workspace_action`도 집는지 확인 — resume job을 가정하는 코드가 있으면 `action_type` 분기(만료는 AX-3b가 마무리하되 스윕이 panic/skip하지 않게 여기서 방어).
- `GET actions`: 사람 bearer·활성 멤버. 응답 부록 E. `executable=false` 항목은 `unavailableReason` 필수(#2016 계약과 같은 문장 규칙).
- 드리프트 시험 1개: `ACTIONS` ids == propose 스키마 enum == OpenAPI enum(`scripts/verify_openapi_contract_rust.sh` 샘플 추가, `verify_web_generated_types.sh`).
- 동의 라벨: `hostedAgents/model.ts` 스코프 배열에 `"workspace:propose"` + 라벨 「워크스페이스 변경을 제안할 수 있음(실행은 사람 승인)」. 기본 페어링 요청 목록에는 넣지 않는다.
- 함정: hosted run의 `channel_id`는 run 행에 있다(approval.channel_id NOT NULL) — DM 트리거 run도 채널 id를 가진다. 승인 결정자 조건(사람+채널 멤버)은 기존 그대로.

## 검증과 전달
- `cargo fmt --all --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace` · conformance(격리 PG) · OpenAPI·생성 타입 검증 · `packages/momo-core` test · docs 프로파일(문서 변경분).
- red proof: 이슈 #2508 4항목. 사보타주: 스코프 검사 한쪽 제거 → 시험 RED / run 가드 제거 → RED / enum에 id 하나 추가 → RED.
- 전달: PR(track/engine) + `scripts/goal_release.sh 2508 --review --pr <url>` + ENGINE_HANDOFF에 「AX-3a ready: 부록 A·E 좌표」 행.

## 체크포인트
(발사 시 기록)
