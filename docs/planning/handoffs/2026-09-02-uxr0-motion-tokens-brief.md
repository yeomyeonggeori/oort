# 워커 브리프 — UX-R0 ADR-0179 집행 1: 모션 토큰 사다리·눌림 단일점·강제 기제 (uxui · **ADR-0179 Accept 후 개방**)

> 워커: grok 4.6 · base=origin/track/uxui · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. 서버 무접촉. `scripts/design_preflight_web.sh` **신규 카테고리 1개 추가만**(정책 감사 대상 — 오케스트레이터가 감사), 다른 게이트 무수정. MCP 금지.
> 정본: **ADR-0179 D1·D2·D3(값만)·D4·D5·D6·D9·D10** — 이 티켓은 토큰·상수·눌림 단일점·강제 기제만. 표면 이관(모달·패널·도착·스켈레톤)은 UX-R1a~e.
> 실사: `clients/web/src/design/tokens.css`에 `--duration-sidebar: 200ms`(:271)·서랍 160ms(:951)·색 전이 150ms 손기입·`@keyframes` 11(온보딩 8 포함)·reduced-motion 블록 10. `button.tsx` variant에 `active:` 0. `designSystem.test.ts`가 그림자 2단 잠금. 참조(Apache-2.0, 구조만): buzz `desktop/src/shared/styles/globals/motion.css`·`motion.test.mjs`·`desktop/src/shared/ui/modalMotion.ts`.

## 구현 계약
1. **`src/design/motion.css`**(tokens.css가 import): `--motion-instant/fast/standard/arrival`(120/180/240/500ms) · `--motion-ease-standard/arrival` · `--motion-distance-arrival: 0.75rem` · `--motion-blur-arrival: 2px` · `--elevation-rest/float`(기존 shadow-sm/lg 값에 이름) · reduced-motion 블록(사다리 소비자 duration 0). 온보딩 키프레임은 무접촉(예외 문서화 주석).
2. **`src/design/motion.ts`**: `MODAL_OVERLAY_MOTION`·`MODAL_CONTENT_MOTION`(열림 200/닫힘 150 — D4 예외 2호, 이 파일 밖에 숫자 금지)·`POPOVER_MOTION`(standard/fast)·`PRESS_CLASS`(D5: `active:scale-[0.98]`은 arbitrary 금지 규율과 충돌 — `@utility press`로 tokens에 정의) 상수. **소비는 이 티켓에서 하지 않는다**(R1a~e).
3. **눌림 단일점**: `button.tsx` 전 variant에 `press` 유틸 + `--motion-instant` 전이. `IconButton` 동형이 있으면 함께, 없으면 NOTES.
4. **사다리 흡수**: tokens.css의 손기입 `200ms/160ms/150ms`를 사다리 변수로 치환(값 변경 아님 — 150→`instant`(120)·160→`fast`(180)·200→`standard`(240)로 **값이 바뀌므로** 각 자리의 결정 주석 갱신 + 기존 시험(`transitionColors.test`·`focusRing.test`·gate-shell 400ms 대기 상수)에 회귀 없음 실측).
5. **강제 기제**: ①`src/design/motion.test.ts` — 토큰 존재·값·reduced-motion 블록·모달 상수 단정 + tokens.css/motion.css에 사다리 밖 `\d+ms` 리터럴 0건(온보딩 키프레임 블록·`motion.ts` allowlist) ②`design_preflight_web.sh` 카테고리 `raw_motion`: `*.tsx`/`*.css` 신규 줄의 `\d+ms`·`duration-[0-9]+` hard-zero(allowlist 파일 2: 온보딩 CSS·motion.ts) ③디자인시스템 README §2.6 재작성(두 축의 정의·표) — 오케스트레이터가 검토.
6. **폰 무접촉**(D9 폰 파생은 M1a).

## red proof (선행 커밋)
- motion.css에서 토큰 하나 삭제 → motion.test 붉음 · tokens.css에 `175ms` 한 줄 추가 → preflight `raw_motion` 붉음 · button variant에서 `press` 제거 → 단정 붉음 · reduced-motion 블록 제거 → 붉음.

## 완료 절차
`clients/web` vitest·tsc·`scripts/design_preflight_web.sh`(신규 카테고리 자가 시험 포함)·`SHELL_GATE_PORT=8601 gate:shell`(전이 상수 회귀)·`CAPTURE_PORT=8603 capture:design`(버튼 눌림 프레임은 DS-3 전이라 rest만) 그린 실측 → 커밋 → `git push -u origin feat/uxr0-motion-tokens` → `gh pr create --base track/uxui` → 정지.

## 규율
숫자는 motion.css·motion.ts 두 파일에만. 온보딩 예외 확장 금지. 막히면 우회 말고 보고 후 정지.
