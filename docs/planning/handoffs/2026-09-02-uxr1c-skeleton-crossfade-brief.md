# 워커 브리프 — UX-R1c 스켈레톤 blur 크로스페이드 (uxui · ADR-0179 D3 · UX-R0 후)

> 워커: grok 4.6 · base=origin/track/uxui · ms 리터럴 금지 · MCP 금지.
> 정본: ADR-0179 D3("스켈레톤→콘텐츠 전이는 같은 blur 값으로 크로스페이드, 팝 금지")·D9. 현행 `SkeletonRows`(`src/features/common/States.tsx` — 높이 보존 중립 막대, shimmer 금지). 참조(Apache-2.0, 구조만): buzz `desktop/src/shared/styles/globals/skeleton.css`(`t-skel` 그리드 스택·`--skel-reveal-blur`·`is-resetting`).

## 구현 계약
1. `@utility skel`(tokens.css): 스켈레톤과 콘텐츠를 같은 grid cell에 겹치고 콘텐츠 도착 시 `filter: blur(var(--motion-blur-arrival))→0`·opacity 크로스페이드 `--motion-standard`·`--motion-ease-standard`. 재마운트(`is-resetting`)는 전이 0. reduced-motion: 즉시 교체.
2. `SkeletonRows` → 래퍼 `Skeleton`(children=콘텐츠, `ready` boolean)로 승격, 기존 호출부 전량 이관(grep `SkeletonRows`). 높이 보존 규율 유지(레이아웃 시프트 0).
3. 펄스 애니메이션은 콘텐츠 도착 시 정지(`animation-play-state`).

## red proof (선행 커밋)
- ready 전환 시 전이 1회·레이아웃 시프트 0(높이 단정) · 재마운트 전이 0 · reduced-motion 즉시 · 기존 SkeletonRows 소비자 시험 전량 그린.

## 완료 절차
vitest·tsc·lint 0·preflight·`CAPTURE_PORT=8629`(스켈레톤 상태·정착 상태 두 프레임, 두 스킴)·`SHELL_GATE_PORT=8631 SHELL_GATE_FOCUS_ONLY=1`·`verify_merge_tree.sh` → PR → track/uxui → 정지.
