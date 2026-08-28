# 워커 브리프 — #1857 workspace role 변경의 에이전트 target 서버 거부 (engine)

> 워커: cursor-agent grok-4.6-high-fast · 병렬 1 · base=origin/track/engine
> 정지 조건: 머지·이슈 close 금지. 라이브 스택 비접촉(테스트는 conformance 하네스의 자체 DB).

## 근거 (PR #1855 design-review H-2 파생 → #1857)
- 하드 불변식: **에이전트=`member`**(ADR-0004). 그런데 `change_workspace_role_in_tx`(momo-settings/membership_lifecycle.rs)는 target의 member kind를 검사하지 않아, operator가 `PATCH /v1/workspaces/{ws}/members/{agent}/role`로 에이전트를 owner/admin/guest로 바꿀 수 있다.
- 웹 클라는 #1855에서 kind 게이트로 컨트롤을 숨겼지만, 계약의 권위는 서버다 — curl·외부 도구 경로는 여전히 열려 있음.

## 구현 계약
1. `change_workspace_role_in_tx`: target이 agent kind면 **명시 거부**. `load_target`(또는 그 쿼리)에 member.kind를 실어 판정하라. 거부는 `MembershipLifecycleError` 신규 variant(예: `AgentRoleImmutable`)로 — wire 문장은 기존 스타일의 영어 한 문장(예: "agent roles are fixed to member"), HTTP 매핑은 403(기존 `_ => forbidden` 관례에 맞춰 명시적으로).
2. **no-op도 거부**: requested가 member여도 에이전트 target이면 같은 403 — "변경 불가 표면"을 단일 응답으로 유지(성공/실패가 requested 값에 따라 갈리면 클라가 두 계약을 배운다).
3. **채널 role 경로(`change_channel_role_in_tx`)는 변경 금지, 관찰 보고만**: 에이전트 target의 채널 role 변경이 현재 가능한지·어디서 쓰이는지(테스트/시드/클라 호출부) 조사해 PR 본문에 보고하라. 거부 확장은 별도 결정(ADR 소관일 수 있음).
4. suspend/remove 등 다른 lifecycle 경로는 무접촉 — 에이전트 정지/제거는 정당한 운영 행위다.
5. 클라(momo-core) 문장 매핑 추가는 불요 — 웹은 컨트롤 자체를 숨기고(#1855 H-2), 403 일반 문장 폴백이 이미 있다.

## red proof (선행 커밋)
- 실 DB conformance(기존 `*_conformance_pg` 패턴): ①owner가 agent target PATCH(admin·owner·guest·member 각각) → 전부 403 + 신규 문장 ②human target 승격/강등 정상 경로 불변 ③last-owner·self-manage 기존 거부 회귀 그린.
- 신규 variant의 as_swift_message/HTTP 매핑 단위 검증.

## 완료 절차
cargo test(해당 크레이트+conformance) 자가 실행 → 커밋(#1857 참조) → push → PR(base=track/engine, 본문에 red proof + 채널 role 관찰 보고) → 정지. 마지막 출력에 PR URL과 변경 요약.
