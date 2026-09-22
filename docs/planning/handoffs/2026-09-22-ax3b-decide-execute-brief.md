# AX-3b — 결정 분기 `workspace_action`: 초대 실행기·감사·`action_result`·`secretOnce` (ADR-0186 D2·D4)

- status: draft (선행: AX-3a 랜딩)
- issue / planning ID: #2509 · PLN-20260922-AX3B
- owner / reviewer: Fable(planner) / Grok 리뷰어 C + planner 재판정 (시크릿 0회 grep은 planner가 직접 재실행)
- track / base commit: engine · AX-3a 랜딩 뒤 `origin/track/engine`
- supersedes: 없음

## Goal
사람이 승인 카드를 누르면 서버가 **결정자 권한**으로 초대를 만들고, 결과 카드와 감사 행을 남기며, 1회 링크는 결정 응답에만 준다.

## 계약과 범위
- 정본: ADR-0186 D2·D4·D7·§5, 부록 B·C. 수용기준: 이슈 #2509.
- 허용 파일: `server-rust/bins/momo-server/src/routes/approvals.rs`(분기) · `momo-agent/src/actions.rs`(실행기 trait/구현)·`approval.rs`(props 빌더) · `routes/invites.rs`의 `create_invite` 호출 재사용(라우트 변경 0) · `momo-db/src/audit.rs`(스키마 상수 추가만) · `docs/api/openapi.yaml`(decision 응답 `result`) · conformance 시험 · `docs/planning/ENGINE_HANDOFF.md` ready 행.
- 지킬 계약: 결정 tx 하나(`agent_tenant_tx`, approval `FOR UPDATE`, 거부는 첫 쓰기 전) · 감사는 코드·해시·프리뷰 비유입(`invites.rs` 규율) · `secretOnce`는 응답 본문에만 + `no_store` 헤더(`routes/webhooks.rs`의 `no_store` 재사용) · 멱등 재전송은 같은 receipt이되 `secretOnce` **재노출 없음**(원장 `receipt`에 저장하지 않으므로 자연히 없음 — 시험으로 못박음) · DDL 무접촉.
- 범위 밖: 웹훅 실행기(AX-8), UI(AX-4).

## 구현에 필요한 맥락
- 결정 라우트 2개(`approvals.rs`: `decide_by_approval`·`decide_by_run`)는 공통 함수로 모인다 — `action_type == "workspace_action"`이면 tool_call 경로(`resume_job_payload`·`requeue_run_from_approval_in_tx`) 대신 아래 순서:
  1. `required_role` 검사: `active_workspace_role`로 결정자 역할 조회, `is_admin()` 아니면 403 `role_required`. **approval은 pending 유지**, 원장 행 기록 없음, 카드 props에 `last_attempt: "role_required"` 패치(AX-4가 「관리자가 승인해야 합니다」로 그림).
  2. 실행기: `create_invite(conn, ws, role, max_uses, expires_at_ms, decided_by)` — 인자는 `approval.payload.action.args`에서 다시 검증(AX-3a 검증기 재호출; 저장값을 신뢰하지 않는다).
  3. 감사: `invite.created`(기존 스키마 + `via_agent`·`approval_id`) + `action.approved`(`momo.action.approved.v1 {action_id, approval_id, proposed_by, decided_by, ref}`).
  4. `mark_approval_decided_in_tx` + `record_decision_in_tx`(receipt에 ref만, 코드 없음) + 카드 props `decided_props_patch` 확장.
  5. 에이전트 명의 `tool_result` 메시지 — 본문 「초대 링크를 만들었습니다(member · 1회 · 7일)」, props 부록 B(`secret_shown_once: true`, 코드·URL 필드 없음). `send_message_in_tx`.
  6. run `succeeded`(`end_parked_run_in_tx` 계열 재사용, output `{actionId, ref}`), resume job **0**.
  7. 응답: 기존 receipt + `result{actionId, ref, secretOnce{kind:"invite_link", value:<join URL>, expiresAtMs}}` + `no_store`. join URL 조립은 초대 redeem 라우트가 쓰는 공개 사이트 주소 정본(#1926 파라미터)에서.
- 거부: 기존 `reject_run`(`approvals.rs:570~`) 그대로 + 카드 props에 `action` 유지. 만료 arm: `workspace_action`은 job이 없으므로 `resume_job_payload` 호출이 없어야 한다 — 시험이 만료 후 outbox 행 0을 잰다.
- 로그 캡처 시험: `tracing` subscriber를 시험에 붙여 결정 처리 중 로그 라인에 코드 문자열이 0회임을 grep.

## 검증과 전달
- Rust 3종 + conformance(격리 PG) + OpenAPI 샘플러(decision 응답) + 생성 타입 검증.
- red proof: 이슈 #2509 6항목. 사보타주: `no_store` 제거 → RED / props에 code 추가 → 스키마 시험 RED / role 검사 제거 → RED.
- 전달: PR(track/engine) + `scripts/goal_release.sh 2509 --review --pr <url>` + ENGINE_HANDOFF ready(부록 A~C·E 실좌표·샘플 응답).

## 체크포인트
(발사 시 기록)
