---
name: "Codex goal (작업 티켓)"
about: "Codex가 goal로 받아 자율 실행하는 단위 티켓. 본문이 곧 작업 프롬프트가 된다."
title: "[<area>] <한 줄 목표>"
labels: ["status:ready"]
---

> 이 이슈 본문이 Codex의 작업 프롬프트(goal)가 된다. `@codex implement this issue`로 트리거하면 본문을 컨텍스트로 cloud task를 띄워 PR을 연다.
> 작성 규칙: 추론으로 못 얻는 것만 적는다. 검증 등급(`[rust]/[web]/[mobile]/[infra]/[sql]/[python]/[runtime]`)을 Acceptance에 반드시 명시.

## Goal
<!-- 한 문장. "무엇을 done 상태로 만드는가". 예: server-rust에 channel_seq 발급 트랜잭션 라우트를 추가하고 cargo test --workspace green. -->

## Context
<!-- 정본 근거 링크/경로. 예: L4 §3.1 (research/07-deepdive/04-self-build-l4-spec.md), schema_v0.sql 의 channel_seq / message 테이블. BUILD_TICKETS.md 티켓 id. -->
- Spec:
- Schema:
- 관련 티켓(BUILD_TICKETS.md id):

## Acceptance (검증 등급 + 체크박스)
<!-- AGENTS.md §3의 등급으로. 닫으려면 전부 충족. -->
- [ ] [rust]/[web]/[mobile] 해당 트리 게이트 green: <패키지>
- [ ] 선행 패키지 빌드 안 깨짐
- [ ] schema_v0.sql 정합
- [ ] runtime 미검증 부분 `runtime-unverified (no docker/psql)` 표기 + STATUS.md 갱신

## Depends on
<!-- 선행 이슈/티켓. 예: Depends on #12, #15. 의존은 닫혀야 picker가 이 이슈를 고른다. -->

## Out of scope
<!-- 의도적으로 안 하는 것. 스코프 늘리지 말 것 — 필요하면 새 이슈 제안. -->
