# 워커 브리프 — UX-R1a 모달·팝오버·드롭다운·컨텍스트메뉴 enter/exit (uxui · ADR-0179 D4 · UX-R0 랜딩 후)

> 워커: grok 4.6 · base=origin/track/uxui · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. ms 리터럴 금지(`raw_motion`) — 숫자는 `src/design/motion.css`·`motion.ts`에만. 서버 무접촉. MCP 금지.
> 정본: ADR-0179 D4(비대칭: 열림 standard/닫힘 fast, 모달만 200/150 예외 — `motion.ts` 상수)·D8(하이브리드: 이 티켓은 CSS/data-state만, `motion/react` 도입 금지)·D9. UX-R0가 세운 어휘: `motion.css`의 키프레임·`motion-enter/exit`(또는 data-state 변형) 유틸, `MODAL_OVERLAY_MOTION`·`MODAL_CONTENT_MOTION`·`POPOVER_MOTION` 상수(컴파일 단정 있음).

## 구현 계약
1. `src/design/ui/dialog.tsx`(오버레이+콘텐츠)·`popover.tsx`·`dropdown-menu.tsx`·`context-menu.tsx`·`select.tsx`에 상수 소비 — Radix `data-state=open|closed`로 enter/exit. 닫힘 애니메이션이 언마운트 전에 재생되도록 Radix `forceMount`/`Presence` 문법 확인(Radix가 exit을 기다리는지 실사, 아니면 기록).
2. **비대칭 실측**: 열림 `standard`(240)·닫힘 `fast`(180), 모달만 200/150. 스크림은 `--elevation-float` + backdrop-blur 5px(D6).
3. reduced-motion: 즉시(전이 0) — `motion-reduce:animate-none` 상수에 이미 있음, 실측으로 확인.
4. 포커스 링 불변(첫 프레임==정착), 열림 중 포인터 이벤트 차단 없음(팝오버 즉시 조작 가능), `escapeLayer` 스택 무회귀.

## red proof (선행 커밋)
- 각 표면 열림/닫힘의 `animationName`·duration 실측 단정(jsdom 불가면 Playwright 프로브를 gate로: 열림 ≈240/닫힘 ≈180, 모달 200/150) · reduced-motion에서 0 · Esc 연타 시 레이어 순서 유지(기존 escapeLayer 시험 전량 그린).

## 완료 절차
vitest·tsc·lint 0·preflight(raw_motion)·`CAPTURE_PORT=8621 capture:design`(열림 정착 프레임만 — `waitForAnimations` 규율: 애니메이션 중 프레임 금지)·`SHELL_GATE_PORT=8623 SHELL_GATE_FOCUS_ONLY=1 gate:shell`·`verify_merge_tree.sh` → 커밋 → `git push -u origin feat/uxr1a-modal-motion` → PR → track/uxui → 정지.
