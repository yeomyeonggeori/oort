---
name: "Bug (재현 가능한 결함)"
about: "재현 가능한 결함. Codex가 fix 브랜치로 처리 가능. 이슈 본문이 곧 작업 goal이 된다."
title: "[bug] <증상 한 줄>"
labels: ["type:bug", "status:ready"]
---

> 재현 절차와 기대/실제가 명확하면 Codex가 `fix/<issue#>-<slug>` 브랜치로 자율 수정→PR을 연다.
> Acceptance에 검증 등급(`[swift]/[runtime]/...`, AGENTS.md §2)을 명시한다. 라벨에 `area:*`를 추가한다.

## 증상
<!-- 무엇이 잘못됐나 (1~2줄) -->

## 재현 절차
1.
2.
3.

## 기대 vs 실제
- 기대:
- 실제:

## 환경
- 패키지/영역(area:*):
- 런타임 결함 여부: <!-- docker/psql/hermes 필요? 필요하면 이 환경에서 닫지 말고 runtime-unverified -->
- 로그/스택트레이스(있으면):

## Acceptance (검증 등급 + 체크박스)
- [ ] [swift] `swift build` green: <영향 패키지>
- [ ] 회귀 방지(가능하면 테스트 추가)
- [ ] 선행/인접 패키지 빌드 안 깨짐
- [ ] runtime 결함이면 재현·수정을 `runtime-unverified` 여부와 함께 STATUS.md에 표기

## Depends on
<!-- 선행 이슈가 있으면. 예: Depends on #NN -->
