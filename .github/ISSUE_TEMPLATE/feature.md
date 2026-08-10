---
name: "Feature (기능/경험 티켓)"
about: "신규 기능·경험·인프라 등 구현 단위. 이슈 본문이 곧 Codex의 작업 goal이 된다."
title: "[<area>] <한 줄 목표>"
labels: ["type:feature", "status:ready", "agent:codex-ok"]
---

> 이 이슈 본문이 Codex의 작업 프롬프트(goal)다. `@codex implement this issue`로 트리거하면 본문을 컨텍스트로 sandbox에서 클론→작업→PR을 연다.
> 규칙: 추론으로 못 얻는 것만 적는다(AGENTS.md §0). Acceptance에 **검증 등급**(`[rust]/[web]/[mobile]/[infra]/[sql]/[python]/[xcode]/[ci]/[runtime]/[manual]`)을 반드시 명시.
> 라벨은 `.github/labels.json` 택소노미를 사용하고, `area:*` / `size:*` / 필요시 `priority:*` / `gate:qa`를 추가한다.

## Goal
<!-- 한 문장. "무엇을 done 상태로 만드는가". 예: server-rust에 POST /v1/workspaces 라우트(워크스페이스+owner+초대코드 1개 자동 발급)를 추가하고 cargo test --workspace green. -->

## Context
<!-- 정본 근거(경로/링크). 추론으로 못 얻는 것만. -->
- Spine 티켓(ROADMAP): MOMO-NNN
- Milestone: M_
- Spec: research/07-deepdive/04-self-build-l4-spec.md §_ , research/07-deepdive/05-agent-native-experiences.md 경험 _
- Schema: schema_v0.sql / server/Migrations/NNN_*.sql (정본 수정 금지 — 신규 마이그레이션으로만 확장)
- 관련 백로그: BUILD_TICKETS.md / ROADMAP.md

## Acceptance (검증 등급 + 체크박스 — 전부 충족해야 닫음)
<!-- 등급 정의는 AGENTS.md §3. 서버 이슈는 `cargo test --workspace` + `clippy -D warnings` green,
     웹·폰·코어 이슈는 자기 트리 게이트 + `scripts/verify_merge_tree.sh` green이 하드 게이트. -->
- [ ] [rust]/[web]/[mobile] 해당 트리 게이트 green: <패키지>
- [ ] 선행 패키지 빌드 안 깨짐 (의존: BUILD_TICKETS.md STEPS)
- [ ] [sql] schema_v0.sql 컨벤션 정합(uuidv7 PK, workspace_id, RLS FORCE) — 확장은 신규 마이그레이션 + RLS DO-block ARRAY 등록
- [ ] runtime 미검증 부분 `runtime-unverified (no docker/psql)` 표기 + STATUS.md 갱신

## Depends on
<!-- 선행 이슈/티켓. 예: Depends on #12. 의존이 모두 닫혀야 picker(AGENTS.md §6)가 이 이슈를 고른다. -->

## Out of scope
<!-- 의도적으로 안 하는 것. 스코프 늘리지 말 것 — 필요하면 새 이슈로 제안. -->
