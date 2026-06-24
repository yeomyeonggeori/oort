---
name: "Chore (빌드/툴링/문서/잡일)"
about: "기능 외 작업: 빌드·CI·툴링·문서·리팩터·운영. 이슈 본문이 곧 작업 goal이 된다."
title: "[chore] <한 줄 목표>"
labels: ["type:chore", "status:ready", "agent:codex-ok"]
---

> 기능 변경이 아닌 유지보수/툴링/문서/운영 작업. 무관한 리팩터를 끼워넣지 말 것(AGENTS.md §5: 한 이슈 = 한 goal = 한 PR).
> 문서 위주면 `type:docs`로, CI면 `area:ci`로 라벨을 보정한다. Acceptance에 검증 등급(`[ci]=syntax/lint, [infra]=파일 존재+정합, [manual]=사람 1회` 등)을 명시.

## Goal
<!-- 한 문장. 예: .github/workflows/ci-build.yml 의 xcode-apps 잡 주석 해제 + actionlint 통과. -->

## Context
<!-- 근거 경로/링크. 예: docs/cicd/04-codex-tickets.md CI2 티켓, ROADMAP MOMO-050. -->
- Milestone: M_
- Spine 티켓(ROADMAP): MOMO-NNN
- 관련 문서: docs/ , ROADMAP.md / BUILD_TICKETS.md

## Acceptance (검증 등급 + 체크박스)
- [ ] [ci]/[infra]/[manual] <검증 명령 또는 산출 파일>
- [ ] 기존 빌드/워크플로우 안 깨짐 (`make build` green 유지)
- [ ] (release 관련이면) 🔒 게이트(M7) PASS 전 `release-*.yml` 미트리거 불변식 준수
- [ ] STATUS.md / 관련 docs 갱신

## Depends on
<!-- 선행 이슈/티켓. 예: Depends on #NN -->

## Out of scope
<!-- 스코프 밖. 필요하면 새 이슈로. -->
