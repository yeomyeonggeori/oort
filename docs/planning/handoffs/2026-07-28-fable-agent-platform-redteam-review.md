# HANDOFF: Agent-platform 계획 독립 레드팀 → Fable 검수

> Status: `superseded` — **planner review packet이며 worker 구현 계약이 아니다**
> Planning ID: `PLN-20260728-01` · Planner/Red team: GPT 5.6 (`momo-main`) · Reviewer: Fable · Integrator: `momo-main`
> 발급: 2026-07-28 · 기준 커밋: `747c9b120762dd60c46d357acb9312f19f81959b`
> Supersedes: `docs/planning/handoffs/2026-07-28-fable-agent-platform-review.md`
> GitHub binding: 미발급 · 판정: **조건부 반려**
> Superseded by: `docs/planning/handoffs/2026-07-28-fable-resource-optimized-canonicalization.md`

이 패킷은 첫 감사 패킷의 실행 권고를 대체한다. 경쟁사·현재 구현 사실은 원 감사 문서에서 재사용하되, builder DAG는 독립 레드팀 검수를 기준으로 다시 줄인다.

## 1. 읽을 순서

1. `AGENTS.md`
2. `docs/TRACKS.md`
3. `docs/planning/README.md`
4. `docs/planning/CURRENT_STATE.md`
5. `docs/planning/research/2026-07-28-tauri-rn-agent-platform-gap-audit.md`
6. `docs/planning/research/2026-07-28-agent-platform-independent-red-team-review.md`
7. ADR-0101, 0113, 0131, 0133, 0137, 0139
8. GitHub #837, #857~#861, #865와 보안 finding 중복 Issue

## 2. 고정 판정

- Tauri/RN 방향, Postgres/RLS/audit, 기존 `agent_run`, current xterm.js+PTY, CSS-first는 유지한다.
- 원 패킷의 신규 6 decision/spike + 10 implementation catalog는 그대로 발급하지 않는다.
- 신뢰 경계는 레인별로 분류한다.
  1. plugin run-scoped delegated subject: plugin read dogfood blocker
  2. terminal owner-only default + retention: #857 공유 관전 blocker
  3. WorkHost signature v2 + replay 방지: remote/Windows 확대 전 P1 hardening
  4. personal credential approval authority/payload visibility: OAuth/write 전 High blocker
- 첫 vertical slice는 plugin v1 read-only 1개와 owner-only schedule 1개다.
- 단, repo-local external tool 실행 경로가 하나로 검증되지 않았으므로 provider 1개의 host-owned connect+secret-free probe와 한 runtime bridge를 먼저 고정한다.
- plugin v2, skill store/recorder, generic trigger, MCP Apps, motion dependency/skill, PTY replacement, community publishing은 evidence gate 뒤로 미룬다.

## 3. Fable이 할 일

1. 네 finding의 코드 사실, severity, 영향 레인을 독립 재검증한다.
2. GitHub에서 기존 Issue와 dedupe한다. 이 세션은 local `gh` 인증이 유효하지 않아 원격 dedupe를 완료하지 못했다.
3. #857 main sync가 terminal privacy fix보다 먼저 노출되지 않도록 merge gate를 제안한다.
4. schedule v0가 아래 기존 객체만 쓰는지 검수한다.
   - `agent.owner_human_id`
   - `agent_profile.triggers.schedule`
   - `agent_run.idempotency_key`
   - 기존 job/outbox/approval/cost/audit
5. schedule run에 sponsor/profile version/config digest/scheduled-for/destination/plugin+tool digest가 immutable snapshot으로 남고 TOCTOU를 막는지 검수한다.
6. Hermes/ACP/direct adapter 중 실제 runtime 경로 하나와 host-owned secret-free readiness probe를 고른다.
7. 성재에게 `approve / narrow / defer / reject` 결정표를 올린다.

## 4. 금지

- track/*→main merge
- ROADMAP/BUILD_TICKETS/STATUS 선편집
- canonical MOMO 번호나 GitHub Issue 선발급
- 새 automation/skill/plugin release table을 사실상 확정
- OAuth token을 server custody로 옮기는 가정
- `frame-src 'none'`을 MCP Apps를 위해 먼저 완화
- Herdr/Ghostty/Reanimated/Motion dependency 추가

## 5. 성재에게 올릴 최소 결정안

```text
A. 보안 finding 4건의 레인별 severity와 순서(plugin/terminal은 현재 blocker, WorkHost/OAuth는 해당 확장 전 blocker)를 승인할지
B. #857 sync와 terminal privacy를 같은 main gate로 묶을지
C. schedule v0를 owner-only + read-only + one schedule + private destination + missed/overlap skip으로 승인할지
D. plugin v2/skill recorder/MCP Apps/terminal spike/motion을 evidence gate 뒤로 defer할지
E. first-party read-only dogfood의 runtime bridge, app, owner DM/private channel을 무엇으로 할지
```

## 6. Fable 인수 프롬프트

```text
당신은 momo의 Fable planner/reviewer다. 구현하지 말고 독립 검수만 수행한다.

먼저 AGENTS.md, docs/TRACKS.md, docs/planning/README.md,
docs/planning/CURRENT_STATE.md를 읽는다. 이어서 아래 두 문서를 순서대로 읽는다.

1) docs/planning/research/2026-07-28-tauri-rn-agent-platform-gap-audit.md
2) docs/planning/research/2026-07-28-agent-platform-independent-red-team-review.md

두 번째 문서는 첫 문서의 실행 권고를 supersede한다. 경쟁사/현재 구현 사실은 첫 문서에서
재사용하되 builder DAG는 그대로 발급하지 않는다.

반드시 재검증할 네 finding과 레인별 severity:
- PluginRoutes.policyMemberID의 caller-chosen delegatedMemberId와 Drive grant 사용
- WorkHost request v1 signature의 body/query/nonce 미포함과 5분 replay
- ApprovalDecisionRoutes의 same-channel-any-human 정책이 personal credential action에 미치는 영향
- work_session observation=open 기본값과 ~/.momo/workd-output raw byte retention

GitHub에서 기존 Issue와 중복을 찾고, #857 main sync를 terminal privacy gate와 어떻게
묶을지 제안한다. schedule v0는 새 execution SoT를 만들지 말고 agent.owner_human_id,
agent_profile.triggers.schedule, agent_run.idempotency_key를 재사용하는 owner-only/read-only
vertical slice로 검수한다. run에는 sponsor/profile version/config digest/scheduled-for/destination/
plugin+tool digest를 immutable snapshot하고 queue-execute TOCTOU를 red-test한다.

현재 repo-local deterministic resume executor는 외부 provider를 실행하지 않고 ACP도
mcpServers=[]이므로, Gate 2 전에 Hermes/ACP/direct adapter 중 한 runtime 경로만 고른다.
provider 1개의 host-owned connect와 secret-free readiness probe만 허용한다.

최종 산출물은:
1) 사실 교정,
2) 네 finding의 severity·영향 레인·중복 Issue,
3) keep/narrow/defer/reject 표,
4) 성재가 답할 A~E 결정표,
5) 승인 뒤에만 발급할 최소 goal 순서다.

ROADMAP/BUILD_TICKETS/STATUS/GitHub Issue를 먼저 바꾸지 말고, track/*→main merge도 하지 마라.
```
