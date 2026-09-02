# 워커 브리프 — UX-R1e 눌림 상태 전수 + 3짝 캡처 레인 (uxui · ADR-0179 D5·D10 · UX-R0 후)

> 워커: grok 4.6 · base=origin/track/uxui · ms 리터럴 금지 · MCP 금지 · `clients/web/scripts/capture-screens.mjs` 장면 추가 허용, 게이트 스크립트 무수정(3짝 레인은 캡처 장면으로 구현).
> 정본: ADR-0179 D5(모든 상호작용 표면 `active:` — `press` 유틸 단일점, hover만 있고 active 없는 표면은 위반(신규 코드), 기존은 shrinking ledger)·D10 ④(rest/hover/active 3짝 캡처). UX-R0 실사: 채널 뷰 상호작용 52 중 press 6·hover-only 26(리뷰 REPORT-1985 도달 프로브). S0 온보딩 CTA는 raw `<button>`(N-4 적립).

## 구현 계약
1. **전수 이관**: `hover:`만 있는 상호작용 표면(행·칩·아이콘 버튼·메뉴 항목·사이드바 행·리액션 칩·S0 CTA)에 `press` 적용 또는 DS-1 프리미티브(있으면) 경유. 텍스트 링크·비활성 요소 제외. 이관 목록을 PR 본문에 표로.
2. **shrinking ledger 게이트**: `src/design/pressLedger.test.ts` — hover 있고 press 없는 tsx 자리를 세어 상한 고정(신규 증가 붉음, 감소만 허용) — 디자인시스템 `chipVessel.test` 동형.
3. **3짝 캡처 레인**: `capture:design`에 `press-triplet` 장면 — 대표 표면 6종(버튼 4변형·행·칩) rest/hover/active 프레임(두 스킴). hover는 Playwright hover, active는 mouse down 유지 후 촬영, `waitForAnimations` 규율.
4. 디자인시스템 README §2.6 "owed" 표기 중 ④ 3짝 캡처 해소로 갱신.

## red proof (선행 커밋)
- ledger 상한 초과 → 붉음 · press 적용 표면의 `transition-property`에 transform 포함·outline-color 제외(UX-R0 컴파일 단정 재사용) · 3짝 프레임 존재·바이트 비결정 0(2회 촬영 동일).

## 완료 절차
vitest·tsc·lint 0·preflight·`CAPTURE_PORT=8637`·`SHELL_GATE_PORT=8639 SHELL_GATE_FOCUS_ONLY=1`·`verify_merge_tree.sh` → PR → track/uxui → 정지.
