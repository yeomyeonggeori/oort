# 워커 브리프 — BZ-3(#1866) 라이트모드 보더·포커스 디테일 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui
> 정지 조건: 머지·이슈 close 금지. MCP 금지.
> 참조: `~/projects/reference/buzz`(Apache-2.0) 라이트모드 — 버튼·입력·컴포저 보더가 옅고, 컴포저 포커스 시 보더 색 불변(성재 스크린샷 2종: 컴포저·사이드바).

## 근거 (성재 검수 2026-08-29, #1866)
- 라이트모드에서 버튼·입력·채팅창 보더가 과하게 진하고, 포커스 시 보더 색 변화가 시끄럽다. buzz는 보더가 미묘하고 컴포저 포커스에서 보더가 변하지 않는다.

## 구현 계약
1. **토큰 명도 완화(라이트 스킴만)**: `tokens.css`의 라이트 `--line`(헤어라인·구분선)을 한 단계 옅게, `--line-strong`(컨트롤 경계)은 **비텍스트 대비 3:1(WCAG 1.4.11) 유지 한도 안에서만** 완화. `tokens.contrast.test.ts` 등 기존 대비 테스트 그린 필수 — 3:1이 깨지는 수준의 완화는 금지(그 경우 --line만 완화하고 사유 명기). 다크 스킴 무접촉.
2. **컴포저 포커스 보더 불변**: Composer(및 동일 패턴의 텍스트 입력 컨테이너)가 포커스 시 보더 색을 바꾸는 규칙 제거 — 마우스 포커스에선 시각 변화 없음(buzz 동형). **키보드 접근성은 유지**: `:focus-visible`에서만 기존 focus-ring 표시(naked_focus 게이트 계약 준수 — 전 인터랙티브 요소 focus-visible 처리 불변). `:focus`와 `:focus-visible`을 가르는 것이 이 티켓의 정답 형태다.
3. 적용 범위: Composer·일반 Input/Select·outline 버튼의 라이트 보더 표현. 개별 컴포넌트 하드코딩 금지 — 토큰과 프리미티브(design/ui) 층에서만 수정.
4. **정본 동기**: docs/design-system/README.md의 팔레트/보더 서술(§2.2 계열)과 taste 스킬 레퍼런스(tokens.md)에 변경 반영 — "닫힌 자리" 결함 예방(#1870 M1 선례).

## red proof (선행 커밋)
- 라이트 스킴 보더 색 변경이 토큰 값 변경만으로 전파(컴포넌트 diff 최소).
- 컴포저: 마우스 클릭 포커스 시 보더 색 불변 실측 + Tab 진입 시 focus-visible 링 표시 실측(두 스킴).
- 대비 테스트·preflight(naked_focus 0 포함) 그린.
- capture:design 라이트 프레임에서 보더 변화 시각 확인 가능(전/후 비교는 PR 본문 스크린샷).

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=6577 capture:design·SHELL_GATE_PORT=6579 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1866) → git push -u origin feat/1866-bz3-light-borders → gh pr create --base track/uxui (본문에 전/후 스크린샷+red proof) → 정지. design-review는 오케스트레이터 몫.
