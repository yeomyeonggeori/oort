# 워커 브리프 — UX-R2s 웰컴 킥오프 서버 절반: `RunTrigger::Welcome` (engine · **ADR-0181 Accept 후 개방**)

> 워커: grok 4.6 · base=origin/track/engine · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `schema_v0.sql` 무접촉(스키마 변경 없음 — `agent_run.idempotency_key`·workspace settings JSONB 재사용). MCP 금지. provider 자격 비유입(ADR-0004).
> 정본: **ADR-0181 D1~D6·D8** 구속(D7 연출은 클라 UX-R2b). 실사 좌표: `RunTrigger::{Mention,Work}`(`server-rust/crates/momo-agent/src/run.rs:139`), 멘션→run 같은 tx(`routes/agent_mentions.rs`), 가입 3경로 `POST /v1/join`(`routes/join.rs:99`, `createdMember` 분기)·`invites::redeem`(`routes/invites.rs:329`)·claim 완주(`routes/claim.rs`), 기본 채널 `#general` 시드(`routes/workspaces.rs:174`), workspace settings(`#1800`, `allowed_agent_models`·`role_labels` 선례), provider 부재 오류 `"provider not configured"`(`momo-provider/src/adapter.rs:129`), 원장 `usage_ledger`, A2A 게이트 `a2a.rs`.

## 구현 계약
1. **`RunTrigger::Welcome { member_id, agent_member_id, channel_id, kind: Opener|ProviderRequired|Closer }`** + idempotency_key `welcome:{ws}:{member}:{kind}:v1`(UNIQUE가 중복 게시를 막는다 — 별도 마커 테이블 금지).
2. **트리거**: 사람 멤버가 **새로 생성된** 트랜잭션(join `createdMember:true`·redeem 신규·claim 완주)에서 `agent_gateway` 잡 삽입. 재가입은 무트리거. 웰컴 에이전트 결정(D3): settings `welcome_agent_member_id` → 없으면 첫 활성 네이티브 에이전트 → 없으면 **잡 미삽입**(오류·시스템 라인 금지).
3. **워커**: Opener는 정상 run(프롬프트 = settings `welcome_prompt`, 기본값 = 정본 카피 상수 — 카피는 오케스트레이터 검토). provider 부재 시 실패 대신 **`ProviderRequired` 정적 경로**(모델 호출 0·원장 0·에이전트 명의 메시지 1건: "설정 › AI 연결에서 연결하고 돌아오면 시작해요")로 게시하고 Opener 키는 소비하지 않는다(연결 후 다음 진입에 Opener 1회).
4. **경계**: `a2a_depth=0`·사람 트리거 취급, G2 연속 자동응답 streak에 미계수(D6). Closer는 v1 **미구현**(enum 예약만, NOTES).
5. **settings 키 2**: `welcome_agent_member_id`(uuid|null, 활성 에이전트 검증)·`welcome_prompt`(≤2000자) — #1800 병합·검증 문법 승계, WorkspaceDto 프로젝션.
6. OpenAPI + web-legacy 타입 동기화. ENGINE_HANDOFF ready 행은 오케스트레이터.

## red proof (선행 커밋 — PG 컨포먼스)
① 같은 멤버 2회 가입 경로 → run 1개 ② provider 없음 → ProviderRequired 1·Opener 0, provider 연결 후 재진입 → Opener 1 ③ 재가입 무트리거 ④ 웰컴 에이전트 없음 → 잡 0·오류 0 ⑤ Opener run이 `usage_ledger`에 귀속 ⑥ streak 미계수(연속 자동응답 게이트 시험) ⑦ settings 검증(비활성 에이전트 id 400·2001자 400).

## 완료 절차
`cargo fmt`·clippy·`cargo test`·PG 컨포먼스·`scripts/verify_openapi_contract_rust.sh` 그린 실측 → 커밋(RED 선행) → `git push -u origin feat/uxr2s-welcome-kickoff` → `gh pr create --base track/engine` → 정지.

## 규율
오프너는 실제 에이전트 발화(D1) — 서버가 메시지를 직접 INSERT하는 경로는 ProviderRequired 정적 경로 하나뿐이며 그것도 에이전트 명의·감사행 동반. 막히면 우회 말고 보고 후 정지.
