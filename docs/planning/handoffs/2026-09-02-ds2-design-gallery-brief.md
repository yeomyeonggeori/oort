# 워커 브리프 — DS-2 `/design` 갤러리 라우트 — 컴포넌트×상태×스킴 한 화면 (uxui · ADR 불요)

> 워커: grok 4.6 · base=origin/track/uxui · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. 서버 무접촉. 게이트 스크립트 무수정(`capture-screens.mjs`에 **장면 추가만** 허용 — 기존 장면·픽스처 불변). MCP 금지.
> 근거: 편성 정본 §4 DS-2 · 디자인시스템 §5.3 "무검사 — 사람만이 잡는 것"(렌더 위계·hover/선택 사진) · 실사: 컴포넌트 155, 표준 프리미티브는 `clients/web/src/design/ui/`(button·card·context-menu·dialog·dropdown-menu·input·popover·select) + `features/common/States.tsx`(InlineBanner·SkeletonRows·EmptyInvite). Storybook 없음·도입 금지(buzz도 없음).

## 구현 계약
1. **라우트**: `#/design` — `import.meta.env.MODE === "design"`(capture 빌드) 또는 `VITE_DESIGN_GALLERY=1`에서만 등록(`App.tsx` 라우트 표, 프로덕션 번들에서 트리셰이킹되게 lazy import + 조건). 세션·서버 불요(정적).
2. **내용**: `src/design/ui/*` 전부 + States 3종 + `SidebarRow`·`MessageRow`(픽스처 1건)·`ReactionChips`·칩 그릇 4종(`--muted-soft/ok/warn/danger`)을 **행=컴포넌트, 열=상태(rest·hover·active·focus·disabled·busy)**로. hover/active/focus는 캡처가 실제 이벤트로 만들지만 갤러리 자체도 `data-preview="hover|active|focus"` 속성으로 **강제 미리보기**를 제공한다(CSS: `[data-preview=hover]`가 hover 규칙과 같은 선언을 공유 — 선택자 중복이 아니라 `@utility`/`:is()` 합성으로, 규칙 이중화 금지). 두 스킴은 `color-scheme` 토글 버튼 + 캡처는 emulate.
3. **텍스트 픽스처**: 한국어 긴 문장·영문·숫자·이모지 혼합, 80자 상한 경계(짧은 픽스처 금지 규율).
4. **캡처 장면**: `capture:design`에 `design-gallery`(두 스킴) 추가 → `clients/web/artifacts/design/design-gallery-{light,dark}.png`. design-review 에이전트 지시문(`.claude/agents/design-review.md`)은 무수정 — R1이 갤러리부터 보라는 규율은 DS-4에서 오케스트레이터가 반영.
5. **가드**: `src/design/gallery.test.tsx` — 갤러리가 `src/design/ui/` export 전부를 렌더하는지(신규 프리미티브 추가 시 갤러리 누락이 붉게), 프로덕션 모드 번들에 라우트 부재(빌드 산출물 grep).

## red proof (선행 커밋)
- `src/design/ui`에 더미 export 추가 → 갤러리 테스트 붉음 · `data-preview=hover`가 hover 선언과 다른 값이면 붉음(선언 공유 단정) · 프로덕션 빌드 산출물에 "design-gallery" 문자열 0건.

## 완료 절차
`clients/web` vitest·tsc·(루트) `scripts/design_preflight_web.sh`·`CAPTURE_PORT=8597 npm run capture:design`(갤러리 두 스킴 프레임 확인) 그린 실측 → 커밋 → `git push -u origin feat/ds2-design-gallery` → `gh pr create --base track/uxui` → 정지. 최종 출력에 PR URL·프레임 경로·게이트 결과.

## 규율
디자인 토큰만·raw 색/px 금지(preflight). 새 명명 유틸리티 추가 금지(갤러리는 기존 어휘의 진열장이다 — 없는 상태가 드러나면 **NOTES에 기록**하고 만들지 않는다: 그것이 DS-1의 입력이다).
