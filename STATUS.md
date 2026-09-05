# oort 진행 현황

## UX-R2a 온보딩 S3 프로필 스텝 (#2001, 2026-09-05)

- Track UXUI. S3 = 표시 이름 only. Personal avatar upload route does not exist (workspace avatar is operator-only). No disabled avatar control on S3.
- `onboardingFlow` steps `landing|gateway|account|profile`. `progressLabel`: gateway `2/4` · account `3/4` · profile `4/4`. `transitionFor("account","profile",false)` = line-slide forward; reduced-motion = none.
- Join with `createdMember: true` holds the session, paints S3, calls `onLoggedIn` on skip / save / fail-forward. Sign-in and `createdMember: false` skip S3. `joinWithInvite` returns `JoinResponse` (`createdMember` boolean; non-boolean = `WireShapeError`). Shared ceiling `DISPLAY_NAME_MAX_CHARS = 80`, sentence `"표시 이름은 80자까지 쓸 수 있습니다."`
- Join `applyLogin` persists before S3 `onLoggedIn`. Hold: `holdSessionRestore` so App does not enter `restoring` and unmount ConnectPage. Measured: first capture waitFor(`onboarding-profile`) 30000ms timeout; after hold, S3 paints (card center profile light/dark).
- Seam `clients/web/src/features/welcome/freshSignup.ts` (bytes from `claudedocs/resume-2026-09-04/seam-freshSignup.ts`). `markFreshSignup` before `onLoggedIn` on the three S3 exits and on `ClaimPage`.
- Test counts: `onboardingFlow.test.ts` 8 → 9. `ConnectPage.test.tsx` 11 → 21. `model.test.ts` 47 → 48. `joinApi.test.ts` 3 (new). Web suite 2688 passed (226 files). Core 1979 passed (99 files).
- Counter strings that asserted `2/3`/`3/3` (product+tests): 6 across `onboardingFlow.ts` (2), `onboardingFlow.test.ts` (2 expects), `ConnectPage.test.tsx` (2). After: `2/4`/`3/4`/`4/4` in those files plus capture `4/4` and S3 chrome comment. Gates/e2e did not assert `2/3`.
- Capture `CAPTURE_PORT=8641`: run 1 wrote S3 four desktop PNGs then aborted on nonempty intro-scroll (`#2057` N-4). Run 2 aborted waiting for `design-gallery` 30000ms (before S3). Run 3 full exit 0. Desktop S3 sha256 run1 = run3:

| file | sha256 |
|---|---|
| onboarding-profile-light.png | `b68eb776877a20cf699bed26115de5863a7b05fe1e307716f297a83c3a8ff59c` |
| onboarding-profile-error-light.png | `7c846bdc96334259ec3294a9c5aceaa6854e1b0d30e29e07b96bafd1f6d25188` |
| onboarding-profile-dark.png | `1ed21b70c31f09e28b8db7a4825a41342fae08b3fafbb7287bfcd467cce4fc77` |
| onboarding-profile-error-dark.png | `a15e1847bfa1f88800edc82d7b47284c834dcd93df48a318deee85d5d31c0750` |

- Preflight web 14/14 + core 5/5. Lint 0 errors (14 pre-existing warnings). `SHELL_GATE_PORT=8643 SHELL_GATE_FOCUS_ONLY=1` GATE PASS. smoke/connect e2e not run (`MOMO_EMAIL` unset).
- Join lanes that learned S3: `capture-screens.mjs` `shootOnboardingProfile`; `advanceOnboarding.mjs` `skipProfileIfPresent` + `ONBOARDING_SURFACE`. Sign-in gates unchanged.
- runtime-unverified: live smoke/connect. design-review is not this worker.

## UX-R1b 드로어·스레드 패널·⌘K enter/exit (#1997, 2026-09-04)

- ADR-0179 D1·D4·D8·D9. `motion@12.23.24` MIT 직접 의존 1개(전이 `framer-motion` MIT). CSS 키프레임 + `AnimatePresence`/`usePresence`/`useReducedMotion` — `motion.div` animate/exit 스타일 없음(inline_style hard-zero). allowlist 3파일: `QuickSwitcher.tsx` · `ThreadPanel.tsx` · `Sidebar.tsx`. preflight `motion_lib_scope` 14번째 분류.
- 실측. Playwright 레인(`skipIf` Chromium)은 제품 컴포넌트(`Sidebar` 390 드로어·스크림, `ThreadPanel`, `QuickSwitcher`)의 밀리초. 브라우저 없는 반쪽은 컴파일 CSS(`.sidebar-drawer` `--motion-fast`) **그리고** jsdom 제품 마운트(스레드 interrupt, 스크림 persist, 팔레트 focus/keystroke class, 세 표면 reduced-motion detach). 숫자는 computed `animationDuration`/`transitionDuration` + 닫힘 closed-frames. 두 스킴 동일.

| 표면 | 방향 | light | dark | reduced-motion |
|---|---|---|---|---|
| 390 드로어 패널 | enter/exit 대칭 `--motion-fast` | 180ms | 180ms | 0 |
| 390 스크림 | enter `--motion-fast` / exit 재생(closed frames>0, dwell≥140, 이후 detach). `backdrop-filter: blur(5px)` (D6, 이 PR에서 스크림에 붙음) | 180ms | 180ms | 0 · R10 in-page detach 3.4–3.7ms (n=3, ±1 ms run-to-run; bound <50) · scrimExitPath=reduce |
| 스레드 패널 | open `motion-slide-in-end` `--motion-standard` | 240ms | 240ms | 0 |
| 스레드 패널 | close `motion-slide-out-end` `--motion-fast` (AnimatePresence 유지) | ≥140ms dwell | ≥140ms dwell | 즉시 detach |
| ⌘K 오버레이/콘텐츠 | open `MODAL_*` 200ms · Escape exit dwell≥140 (bound; R10 n=3 light 157.1–163.7 / dark 158.2–163.3, ±7 ms run-to-run) · AnimatePresence. 행 필터 재렌더 모션 0 | 200 / 150 | 200 / 150 | 0 · R10 n=3 in-page palette=1.5–8.3ms exitPath=reduce |
| 데스크톱 사이드바 접기 | `--duration-sidebar` = `--motion-standard` | 240ms | (light와 같은 CSS) | 0 (`transition: none`) |

- 390 드로어 **패널**은 DOM에 남는다(스크롤 보존, UX-R0). AnimatePresence는 스크림에만 (`SidebarDrawerScrimLayer`). 데스크톱 접힘은 타이틀바 토글 계약 유지(`sidebarPane.test.ts`).
- 스레드 패널 presence는 부모 `root`가 민다. `onClose()`는 사용자 의도에서 즉시. 로컬 `leaving` 없음. 닫힘 중 같은/다른 앵커 클릭은 안정 `key="thread-panel"` 슬롯을 재사용해 exit을 끊는다.
- R1d `playEntrance`/`onEntranceConsumed` ThreadPanel 이음 유지(`arrivalWiring.test.ts` · `Timeline.burst.test.tsx`).
- R11: merge `4d9ade23` (`origin/track/uxui` into this branch). 105/105 single-sided files byte-identical; dual-sided hunks accounted. R1e `scrim-press` landed on the Presence scrim.
- R12: `motion-fast-enter` fill is `backwards` (not `both`). A finished fill-`both` fade kept `opacity: 1` at the animation origin and outranked `.scrim-press:active { opacity: .92 }`. Measured after enter (CDP `:active`): product ≈ 0.92; restore `both` on the fixture → 1 (RED). Capture `assertEnterMotionPressAfterFill` waits for enter to finish then forces `:active` on `motion-*-enter` interactives (390 drawer requires the scrim). Thread panel / ⌘K overlay+content have no `:active` opacity on the enter node — finished fill does not hide a press step there.
- red proof (수리 떼면 실제로 붉음):
  - 닫힘 중 20/60/100ms 에 같은/다른 `thread-anchor` 클릭 → 패널이 요청한 root 로 열린다. `leaving`+지연 `onClose` 를 되돌리면 같은 스윕이 안 연다.
  - `prefers-reduced-motion: reduce` 에서 팔레트/스크림 in-page detach <50ms. MutationObserver 를 Escape 전에 팔레트 루트에 달고 `performance.now()` 로 제거 시각을 찍는다. Playwright `waitFor(detached)` 지연은 `observeLag` 로 따로 찍고, 경로는 `data-exit-path`(duration 으로 추론하지 않음) — 팔레트와 스크림 둘 다. R10 full-suite ×3 verbatim (discard 없음):
    ```
    panelMotion: reduced-motion detach scrimInPage=3.4ms scrimExitPath=reduce paletteInPage=8.0ms exitPath=reduce observeLag=19.0ms · dwell light=157.1ms dark=161.8ms
    panelMotion: reduced-motion detach scrimInPage=3.7ms scrimExitPath=reduce paletteInPage=1.5ms exitPath=reduce observeLag=3.2ms · dwell light=163.7ms dark=163.3ms
    panelMotion: reduced-motion detach scrimInPage=3.7ms scrimExitPath=reduce paletteInPage=8.3ms exitPath=reduce observeLag=17.2ms · dwell light=162.4ms dark=158.2ms
    ```
    range (n=3): scrimInPage=3.4–3.7ms (±1 ms run-to-run) paletteInPage=1.5–8.3ms · dwell light=157.1–163.7ms dark=158.2–163.3ms (±7 ms run-to-run). Guard bounds are <50 ms detach and ≥140 ms dwell, not the sample range. jsdom: computed duration 150ms 여도 `useReducedMotion` 분기가 20ms 안에 뗀다 — 분기를 지우면 팔레트는 남고 Chromium 은 `exitPath=timeout` 으로 붉다. Portal `forceMount` 는 분기를 닿게 하는 게 아니다(훅이 ref 읽기 전에 결정). DialogContent 가 상속하므로, 없으면 Radix Presence 가 콘텐츠를 지워 jsdom 「20ms 에 아직 마운트」 가드가 공허해진다. forceMount 는 가드를 우리 effect 의 것으로 유지한다. duration 0 (훅 false) 은 `setTimeout(0)` — R6 `duration<=0 return` 은 hang. CSS exit 은 forceMount 없이 이미 돈다. 스크림 분기 삭제는 jsdom 빨강 + Chromium `scrimExitPath` 가 reduce 가 아니어서 빨강.
  - 스크림을 닫아도 노드가 `data-state=closed` 로 남았다가 exit 뒤 detach (jsdom, 제품 `Sidebar` 마운트). `{asDrawer && drawerOpen ? <SidebarDrawerScrimLayer open={true}/> : null}` 로 바꾸면 닫힘 즉시 null — Chromium 없이 붉다. AppShell `className=["']sidebar-scrim["']` 정규식은 증거가 아니라서 지웠다.
  - 연 팔레트에 행 ≥5 (하네스 `abc-*` 5채널) · 키 3타+Backspace 뒤 행 > 0 · `[cmdk-item]` `animationstart` 0 (open-container=1, type-items=0, rows=6). `PALETTE_ITEM_MOTION`/`motion-item-fade` 를 행에 되돌리면 open 에서 item animationstart **11**. jsdom 은 행 class 에 `motion-item-fade` 가 있으면 붉다.
  - 팔레트 닫힘 후 `activeElement` 는 opener (`open-palette`). owner 는 `restoreRef` effect (`open === false` 에서 `target.focus()`). 그 effect 를 빼면 Escape·항목 선택 모두 `BODY` (jsdom 2/2, Playwright `focus=BODY`). `restoreDialogOpenerFocus` 는 이 경로의 owner 가 아니다.
  - `MOTION_LIB_ALLOW_RE` 를 `src/` 로 넓힌 사본 → `--selftest` 실패. 네 번째 파일 import → 스캔 빨강. 스크립트 목록과 코드 import 가 갈리면 vitest 빨강.
  - 스크림 enter 가 끝난 뒤 CDP `:active` opacity ≈ 0.92. `motion-fast-enter` fill 을 `both` 로 되돌리면 같은 측정이 1 (R12 RED). 캡처에서 `assertEnterMotionPressAfterFill` 을 빼면 원장 핀이 붉다.
- `Timeline.burst.test.tsx` (`expected 1 to be 3`) 는 선행 flake (#2050 N-7). isolation 20× head 0/20 · base 0/20. full suite 20× head **1/20** · base **2/20**. 이 PR 이 비율을 올리지 않아 버스트 테스트는 안 만졌다.
- 캡처 `CAPTURE_PORT=8625` R12 **exit 0** (intro nonempty light/dark 포함). `enter-press drawer` light/dark `:active opacity=0.92 fill=backwards`. R10/R11 은 intro abort 를 기록했고, 이 런은 완료됐다. 선행 flake 는 남을 수 있다.
- `SHELL_GATE_PORT=8627 SHELL_GATE_FOCUS_ONLY=1` GATE PASS(타이틀바 토글·390 Escape는 스크림 exit 후 detach). 폰 무접촉. design-review는 이 워커가 하지 않음.
- R7: `duration<=0 return` 삭제. duration 0 은 다시 `setTimeout(0)` (스레드/스크림과 같은 폴백). Content `forceMount` 삭제 — Portal 만 로드베어링. 훅 분기 삭제 시 jsdom 빨강(Portal 유지), Portal 도 빼면 초록. 제품: 연 팔레트에서 reduce 토글·userCSS `animation:none` 3회 닫힘 `[0,0,0]` (hunk 있으면 `[1,1,1]` + `data-scroll-locked=1` + 휠 delta 0).
- R6: 팔레트 `useReducedMotion` 분기는 Portal `forceMount` 가 닫힘 동안 노드를 붙든다. R6 의 `duration<=0 return` 은 제품 hang 이라 R7 이 되돌림. CSS exit 은 그대로 (dwell≥140, reduced 0s).
- R8: click-behind 가드는 `data-state=closed` 를 한 페이지 턴에서 기다린 뒤 30/60/90ms 를 샘플하고, 노드가 떨어지면 pe 단정을 멈춘다(120ms 는 150ms exit 안에서 detached `''` 를 읽음). `!` 를 뺀 스크래치 → 두 파일 모두 `t+30ms overlay pointer-events: expected 'auto' to be 'none'`. full-suite 10× 두 파일 0 flake (overlayMotion 10/10 · panelMotion 10/10).
- R9: `<10ms` discard 와 `!node`/`forceMount` 레이스 문장을 지움. 짧은 측정은 데이터다. 팔레트 detach 는 in-page MutationObserver. 경로는 `data-exit-path`. 레인은 측정되는 즉시 찍는다.
- R10: `forceMount` 주석 세 곳을 실측으로 고침 — 분기를 닿게 하는 게 아니라 DialogContent 상속으로 jsdom 가드가 Radix 제거에 안 먹히게 한다. 스크림에도 `data-exit-path`(Chromium `scrimExitPath=reduce`). click-behind `if (!sample.connected) break` 삭제(루프가 30/60/90 을 샘플). `console.info` 는 expect 앞. dwell 범위는 n=3 + ±7 ms run-to-run.
- R5: 닫힌 모달 오버레이/콘텐츠는 `data-[state=closed]:pointer-events-none!` (컴파일 규칙 `pointer-events: none !important`). Radix 인라인 `auto`를 클래스가 이긴다. `DialogOpenContext`·인라인 `style.pointerEvents`·eslint-disable·preflight-allow 없음. 가드: 컴파일 CSS `!important` + Playwright Escape 뒤 30/60/90ms 클릭(팔레트·채널 만들기·로그아웃 확인·섹션 삭제). `!` 를 빼면 컴파일 단정 빨강이고 제품 클릭이 다시 삼켜진다. dist CSS 해시로는 `!` 를 증언하지 못함 — 같은 리터럴이 `overlayMotion.test.ts` 에 있어 Tailwind 가 시험 텍스트를 스캔한다 (README §2.3 `pt-[13px]` 함정). 가드는 상수를 컴파일한다.
- NOTES (R10): N-1 캡처는 게이트 줄 — PASS 라고 쓰지 않음 (선행 nonempty intro). N-2 `Timeline.burst` flake 선행 #2050. N-3 `SidebarRowContextMenu.test.tsx` flake 선행 (#2050/#2057 형태), 이 PR 무접촉. N-4 `!important` 미집계 #2074, 스크립트 이 PR 밖. N-5 `previews/previews` 는 캡처 레인이 만들지 않음. N-8 팔레트 리스트가 `채널` 헤딩에서 잘리고 스크롤됨 — 선행, base-identical. M-2 UnreadPill 이 스크림/팔레트 위에 그려지고 클릭을 가로챔 — 선행·base-identical, **#2075** 소유, 이 라운드에서 안 고침.
- R4 기록(정정): 인라인 `pointerEvents` + overlay-only `forceMount` 제거는 기구가 무거웠고 Portal 상속으로 overlay `forceMount` 제거는 no-op 였다. 동작은 R5 가 그대로 두고 기구만 바꿨다.
- N-2 `Timeline.burst` flake 2/5 at load 7.88 는 선행 (#2050 N-7). 이 PR 이 파일을 안 만진다.
- N-3 팔레트 리스트가 `채널` 그룹 헤딩에서 잘리고 행이 안 비치는 기하은 base 와 byte-identical. 선행.
- N-4 프로필 메뉴 → 로그아웃 확인 직후 첫 Escape 가 나가는 DropdownMenu 에 먹히는 경우 있음 (head 1/4 · base 2/4). R1a-era 선행 (#2049 M-4 영토).

## UX-R1e 눌림 상태 전수 + shrinking ledger + 3짝 캡처 (#2000, 2026-09-05)

- ADR-0179 D5 스윕 단위는 **컨트롤**(태그/role)이지, 그걸 감싼 행이 아니고, 「이미 `hover:` 가 있던 요소」도 아니다. `press` 는 활성화 대상 자신만 진다. 비상호작용 `div`/`li`/`span`/`section`(interactive role 없음)에 `press` 를 두면 원장이 붉다.
- 전폭은 폭이다: 렌더 폭 ≥ 480px 이거나 콘텐츠 열의 50% 이상인 상호작용 행/카드는 fill-only (`hover:bg-surface-hover active:bg-surface-pressed` / `press-instant-fill`, `.press` 스케일 없음). 소스 휴리스틱(목록 행·`w-full`·`<summary>`·부모 `li` 의 Link/앵커 행 — FeedRow 는 클래스가 아니라 레이아웃으로 열을 채운다)과 캡처 레인의 `getBoundingClientRect` 프로브가 **찍는 장면마다** 같이 센다(inbox · activity · channel · thread · drafts · search · settings · agent hub · connect). 본문 메시지/대기 행·설정 토글 행·카드 `<summary>`·메뉴 행·리마인더 행·인박스 FeedRow 가 그 자리.
- 라이트 `#efe2c8` (L 0.769136 < hover 0.770416). vs hover 대비 1.0016 · dE 0.0257 · Δhue 0.00°. vs `--accent-soft` 대비 **1.0528 · dE 0.0210** · Δhue 9.83°. ink 12.512 · ink-muted **4.5013** (AA+0.0013) · line-strong **3.024** (3:1+0.024). ink-muted ≥ 4.55 **그리고** line-strong ≥ 3.05 를 같이 넘는 해는 라이트 띠에 없다(hover 자신 muted 4.508 · line 3.029). 그릇 여덟 쌍 1.101–1.118 / dE 0.038–0.048. 다크 `#262335` (L 0.0187, 칩 그릇 띠 .0192~.0320 **밖**) · vs hover 1.007 · dE 0.0204 · ink-muted 5.395. 그릇 1.142–1.148 / 0.043–0.075. R3 라이트 `#eee2cc` 는 accent-soft 와 대비 1.0526 · **dE 0.0185** 로 §2.2 「대비는 넘는데 눈에는 같은 회색」이며 자가가 그 값을 넣으면 붉다. R2 `#ece3cc`/`#2d2c34` 는 라이트가 hover 보다 밝고 다크가 띠 안.
- 반경 있는 설정 `<details>` 는 `overflow-hidden` 으로 summary hover 채움을 자른다. 캡처 프로브는 AABB 꼭짓점이 아니라 **둥근 경로 안·호 밖**(각 모서리에서 축으로 2px + 짧은 대각)을 재고, 그 픽셀이 페이지 배경이어야 한다. `overflow-hidden` 을 빼면 light tl+2 = fill `231,227,219`(페이지 `247,246,243`), dark tl+2 = fill `38,37,44`(페이지 `23,22,26`).
- 선택 행은 hover 에서 선택 채움(`bg-accent-soft`)을 유지하고 press 에서 `active:bg-surface-pressed` 를 낸다. 전폭 행은 채움만(`.press` 스케일 없음). 콤팩트 칩·탭은 공유 base 에 `press` 를 두고 선택 팔에 눌림 채움을 더한다. 가드는 파일/컴포넌트 이름이 아니라 태그/role·전폭 정의·분기 전수다. 선택 팔에서 press/채움을 빼면 붉다.
- 설정 토글 행은 `<label>` 이 행 전체이고 릴리스 어디서나 토글된다. `checked` 는 선택 채움을 hover 에 유지하고 `active:bg-surface-pressed` 만 낸다(unchecked 만 `hover:bg-surface-hover`). 캡처: 체크박스 부모가 LABEL, 행 오른쪽 8px 히트가 LABEL, deadRight ≤ 2px. `settings-row-checked` 3짝이 그 분기를 찍는다.
- 텍스트 링크(정본 §2.6: `<a>`/`<button>`/`Link`/`NavLink` 의 렌더가 **글자뿐** — 밑줄 또는 `hover:text-`, **채움과 상자(어떤 `border*` ·배경 상자) 없음**. 패딩·`rounded-*`·터치 타깃만으로는 상자가 아니다. `hover:text-X` 의 X 가 rest `text-*` 와 같으면 호버가 아니다)는 `press` 를 안 든다. 밑줄만 있는 자리는 잔량. 상자 있는 밑줄 컨트롤은 `press` 를 유지.
- Ledger 전수 인구는 **태그/role** 이다. `hover:`/`press` 마커 게이팅 없음. 파일 이름 탈출 없음. N0=**476** · N1=**11**(텍스트 링크 잔량) · interactive-without-press **0** · 천장 **11**. 「has press」는 이름 있는 어휘만(`.press` · `active:bg-surface-pressed`, 또는 `:active` 가 `--surface-pressed`/`--motion-instant` 를 쓰는 `@utility` — 지금 `press-instant-fill` · `scrim-press` · `plugin-marketplace-row`). 이름 있는 눌림은 칠한다. `press-instant-fill` 만으로 전이만 선언하고 채움이 없으면 붉다. 천장보다 많으면 `hover-only control added at <file:line>`, 적으면 `lower the ceiling to N`.
- 3짝 표면 핀은 `PRESS_TRIPLET_GALLERY`/`INSITU` 와 갤러리 `data-testid` 의 **양쪽 집합 동등**. in-situ 는 message/pending/settings/settings-row-checked/drafts 다섯. 하나를 빼거나 더하면 붉다(부분문자열 핀이 아님).
- 이관 표면 compiled CSS: `transition-property` 에 transform 포함, outline-color 제외. 스케일은 `.press` 의 `scale(0.98)`. `duration-*`/`scale-*` 리터럴 0. 메뉴 행은 `press-instant-fill`(스케일 없음, `:active` 가 `--surface-pressed` 를 칠한다). 초안 행은 채움만(`hover:bg-surface-hover active:bg-surface-pressed`, `.press` 없음). cmdk 행은 선택 채움이 hover 이고 `data-[selected=true]:active:bg-surface-pressed` 가 선택 위를 이긴다(채움만, 변형 없음).
- 캡처: 갤러리 6 + in-situ 5 × rest/hover/active × 두 스킴, 390 은 라이트·다크 둘 다 in-situ+사이드바 행. hover≠active 는 픽셀 수가 아니라 픽셀당 OKLab dE ≥ 0.01. 레인은 **시작에만** `press-triplet*` 를 지운다. 3짝 카탈로그가 쓰인 뒤 다른 장면이 중단되면 세트를 남기고 카탈로그에 `# abort-after-triplet` 을 적는다. 중단 사유가 intro/scroll/timeout 이면 NOTES 에 선재 intro-scroll 플레이크(#2057 N-4)를 적는다. `capture:design` 이 그 플레이크로 exit 1 이어도 abort-keep 은 동작한다(N5-3 기록). `settings-notifications-{light,dark}.png` 는 가드된 장면만 쓴다(스윕은 그 이름을 건너뛴다). 같은 경로를 두 번 쓰면 레인이 붉다. 찍기 전 포인터를 뷰포트 밖으로 보내고 unchecked 「방해 금지」 행의 rest 픽셀이 `--surface` 와 같다.
- NOTES: 전폭 행의 `:active { transform }` 은 `none` 이다. R5 가 잰 AgentCard/ArtifactCard/UnfurlCards 638px 행의 12.76px 폭 손실은 `.press` scale(0.98) 이었다. 라이트 `--surface-pressed` 여백은 띠 바닥(16.7M 스윕, 구조) — 값을 바꾸지 않는다. N4-4 기록만. 칩 그릇 잔량 34(관전 터미널 토글 눌림 채움이 33→34). 천장 숫자는 잔량 표와 같고, 이미 잔량이던 컨트롤에 눌림 채움이 생기면 같이 오른다.
- R6 가 **닫혔다고 적었으나 닫히지 않은** R5 문장: M5-4 설정 「방해 금지」 rest 샷이 hover 채움이다(가드는 통과하고 스윕이 같은 파일을 덮어썼다) · M5-5 플러그인 상세 링크에 hover 가 없다(`hover:text-ink` 를 `text-ink` rest 위에 얹어 픽셀이 안 바뀌었다). R7 이 둘을 닫는다.
- R6 가 실제로 고친 R5 거짓 문장: 전폭이 `w-full`/클래스 토큰이다(제품 네 카드는 닫혔으나 FeedRow 1040px 는 R7) · `expandClass` 가 최상위 `return` 만 센다 · `disabled:cursor-not-allowed` 가 산 컨트롤을 인구에서 뺀다 · 이름 없는 `@utility :active` 가 눌림이다 · README 칩 잔량 33.
- R7 이 고친 R6 거짓 문장: 알림 PNG 한 파일에 작성자가 둘이다 · `hover:text-ink` 가 rest 와 같아도 호버다 · 전폭 프로브가 타임라인 세 장면뿐이다 · `press-instant-fill` 이 이름만으로 눌림이다 · 갤러리 17이름과 `@utility` 눌림 집합이 달라도 된다 · 칩 천장은 내려가기만 한다.
- R5 가 고친 R4 거짓 문장: 전수 인구가 hover-keyed 448 이다 · 선택 팔에 press 가 없어도 원장이 0 이다 · cmdk `hover:`/`active:` 가 선택된 행에 칠해진다 · 초안 행은 채움만이라 스케일 이동이 없다 · 캡처 중단이 완료된 3짝을 지운다 · 텍스트 링크 정본이 `<a>`/`<button>` 뿐이다 · `border-2` 가 글자 링크다.
- runtime-unverified 아님. 폰 무접촉. design-review는 이 워커가 하지 않음.

## UX-R1c 스켈레톤 blur 크로스페이드 (#1998, 2026-09-03)

- `Skeleton` 래퍼: 막대와 콘텐츠를 같은 grid cell에 겹치고, `ready` 시 `--motion-blur-arrival` + opacity를 `--motion-standard`로 크로스페이드. 호스트 높이는 `ready=false`일 때 막대 높이를 저장하고, 뒤집히는 `useLayoutEffect`에서 그 값으로 잠근 뒤 콘텐츠 높이로 같은 사다리·같은 창을 탄다(줄어듦·늘어남 같은 기구). 가드는 뒤집기 전 프레임부터 샘플한다. 막대는 정지(펄스 없음). 그 창이 끝나면 `is-settled`가 이미 콘텐츠 높이인 레이어에서 막대를 뺀다. `is-resetting`은 제자리 `ready` true→false(전이 0)이지 재마운트가 아니다. 프레임당 |Δh| 상한 12px는 줄어듦과 +14 늘어남에서 실측되고, +224(12채널)는 같은 240ms ease-out에서 첫 프레임 ~30px — 사다리이지 점프가 아니다(점프로 되돌리면 224).
- 호출부 57곳 식별자 이관. 같은 슬롯에서 `ready`가 뒤집히는 면은 9곳(Sidebar×2, ChatShell, Inbox, Drafts, Activity, Search, ThreadPanel, Reminders). 나머지 48곳은 `<Skeleton ready={false} />` self-closing — 예전 팝(DS-2 갤러리 표본·라우트 fallback 포함). 타임라인은 Virtuoso `height:100%` 스크롤러와 고정 높이 막대 블록이 충돌하므로 제외(주석 `Timeline.tsx`).
- runtime-unverified 아님. 캡처: Inbox+Sidebar, 모션 켜고 `skeleton-{light,dark}` + `skeleton-settled-{light,dark}` + 라이트 390(`skeleton-390-light` / `skeleton-settled-390-light`). Inbox 스켈레톤 프레임은 `**/approvals*` 홀드 + `[data-testid="inbox-route"] [data-ready="false"]`가 보증한다.
- `clients/web/measure/**`는 `npm run lint`·`typecheck` 대상(`tsconfig.measure.json`). Vite 진입은 `src/main.tsx`라 dist에 하네스가 없다. design pre-flight의 `measure/` 커버리지는 #2049 N-2.
- 폰 무접촉. design-review는 이 워커가 하지 않음.

## UX-R1d 메시지 도착 모션 `motion-enter-conversation` (#1999, 2026-09-03)

- ADR-0179 D3: 실시간 도착(타 사용자 `message.new`) 행만 `enter-conversation` 1회. REST 백필·리플레이 게이트·초기 로드·가상화 재마운트·자기 메시지·edited 는 0. `takeArrivalPlay` 단일점(momo-core). `animationName` 일치로 클래스 제거.
- reduced-motion: 재생 0 (ingest 가드 + 사다리 duration 0). UnreadDivider/Pill 무접촉.
- R2: 부분 복구(`recovered=false` + `hasRecoveredPublications=true`) 는 리플레이로 읽는다 (`subscribeHuddle` 과 같이 구독 컨텍스트 전부). 스레드 패널도 같은 live 행을 재생. `settlesPending` 팔 삭제(런타임 불가 픽스처). 키프레임 `to` 끝점·iteration-count 1·`both` 단정.
- R3: grant→class 이음은 실제 `MessageRow` 렌더(`data-entrance-play`·행 자신의 클래스). ChatShell consume 바인딩 2곳. 키프레임은 캐스케이드 승자(마지막 블록).
- R4: 같은 틱 라이브 버스트 3건은 **가상화 `Timeline` + 실물 react-virtuoso** 경로에서 3/3 재생(jsdom 마운트 행 + Chromium `motion-enter-conversation` 시작 횟수). grant 는 행 마운트(consume)까지 유지하고, leftover 상한은 스크롤-업일 때만 쓸어 낸다(페인트 틱 상한은 virtuoso 의 늦은 커밋을 앞질렀다). ChatShell 이음은 JSX AST(주석에 남은 문자열은 세지 않음). `subscribeChannel` 포워딩은 credential-free 유닛(`realtime.channelRecovery.test.ts`); Centrifugo 전송 실측은 계속 `gate:resume`.
- NOTES: DS-2 `MOTION_VOCABULARY` 는 `motion.css` `@utility` 를 손기입하고 `enter-conversation`(및 UX-R1a `scrim-blur`)이 빠진다. 이 브랜치 스코프 밖 — 오케스트레이터가 따로 티켓. R5(`useLayoutEffect`→`useEffect` 소비) 는 동작 보존 리팩터이지 결함 아님: 같은 커밋에서 자식 effect 가 부모보다 먼저 돌고, 부하 속성은 「grant 를 읽는 렌더보다 먼저 상한을 돌리지 말 것」이며 그건 P1 이 이미 핀한다.
- 캡처는 `waitForAnimations` 정착 프레임(REST 픽스처라 도착 모션 0이 맞다). `gate:seq`·`gate:resume` 은 `MOMO_EMAIL`/`MOMO_PASSWORD` 미설정 + `127.0.0.1:28000` 미기동으로 exit 2 — **runtime-unverified**, 소유 #1999. `gate:resume` 은 실제 Centrifugo 복구를 도는 유일한 레인이라 전송 실측은 여기 남는다. 클라 증명은 `useTimeline.arrival.test.tsx` + `MessageRow.entrance.test.tsx` + `Timeline.burst.test.tsx` + `realtime.channelRecovery.test.ts`.
- red proof: live=1 스텁 0에서 붉음 · 소비 생략 시 재마운트 0이 1로 붉음 · animationName 불일치 시 클래스 잔류 · 키프레임 끝점/1회/`both` 불일치 시 motion.test 붉음 · 부분 복구를 live 로 읽으면 하네스가 붉음 · `playEntrance` 무시·클래스 자식 이전·두 번째 consume 탈락은 행 렌더가 붉음 · 페인트 틱 상한은 가상화 `Timeline` 버스트가 1/3 로 붉음 · ChatShell 바인딩을 주석으로 남기면 JSX AST 가 붉음 · `subscribeChannel` 이 `hasRecoveredPublications` 를 버리면 channelRecovery 가 붉음.

## UX-R1a 모달·팝오버·드롭다운·컨텍스트메뉴 enter/exit (#1996, 2026-09-03)

- ADR-0179 D4 비대칭: dialog overlay+content는 `MODAL_*_MOTION`(열림 200 / 닫힘 150), popover·dropdown-menu·context-menu는 `POPOVER_MOTION`(240/180). 스크림 `scrim-blur` 5px. Radix Presence는 Content가 닫힘 동안 마운트돼 있을 때만 exit을 기다린다(forceMount 없음). `{open && <DialogContent/>}`는 Presence보다 먼저 언마운트해 닫힘 애니메이션이 안 돈다 — 제품 다섯 곳(채널 만들기·로그아웃 확인·섹션 이름/삭제·채널 나가기)은 ShortcutHelpDialog처럼 유지. Escape는 닫힘을 시작한 그 키만 삼킨다.
- native `<select>`는 OS picker라 data-state 모션 불가(계획 이탈). reduced-motion duration 0. 캡처 overlay 장면은 `waitForAnimations`.
- red proof: `{open && <DialogContent/>}` at any of the five product sites → closed-state dwell < 140ms. POPOVER_MOTION 사용만 지우고 주석만 남김 → 컴파일 CSS 단정 빨강. `PLAYWRIGHT_BROWSERS_PATH=/nonexistent` 에서도 컴파일 단정은 돈다.

## DS-2 `/design` 갤러리 라우트 (#1956, 2026-09-03)

- `#/design` 은 `MODE=design` 또는 `VITE_DESIGN_GALLERY=1` 에서만 lazy. production dist `design-gallery` 0, 강제 미리보기 `:is(:hover,[preview])` 규칙 0 (`gallery-preview.css` 에서 속성·시그니처 파생), `data-gallery-export` 0. 강제 미리보기는 `gallery-preview.css` 의 `[data-gallery-root] :is()` 뿐(전역 hover 변이 무접촉, `@media (hover: hover)` 유지). 미리보기 속성은 `data-gallery-preview`(첨부 `data-preview` 와 이름 충돌 없음).
- ui PascalCase export 전수 실면적 렌더. 오버레이는 `modal={false}` 로 문서를 잠그지 않고 **칸(`data-gallery-stage`) 안에** 붙는다. 무대 높이는 표본 자신(pane 가로 토큰을 세로로 빌리지 않음). 네 판 `onOpenAutoFocus={preventAutoFocus}`(로드 후 첫 Tab 이 위 컨트롤, 스크롤 ~0). Dialog 스크림은 판 둘레에 보이는 대역(가림 없는 가시 면적). 캡처는 첫 Tab·휠 스크롤 가시 면적(≥0.9)·네 변 잘림·스크림 비가림을 잰다.
- NOTES(DS-1 입력): Card/Input/Select hover·active·busy 없음. SidebarRow disabled·busy 없음(unread≠busy). Button busy는 aria-busy만. DialogPortal·PopoverPortal은 목적지 칸. press는 Button 전용. 스크림은 갤러리 대역.

## M0w 기기 연결 웹/데스크톱 — 설정 「폰 연결」 QR 카드 (#1989, 2026-09-03)

- 설정 › 기기: 「QR 만들기」 → POST `/v1/auth/device-link` → 순수 SVG QR(코어 byte mode ECC M, 의존 추가 없음) · 120초 카운트다운 · 만료 「다시 만들기」 · `sas`가 있을 때만 4자리+confirm-sas. `consumed`+미확인 SAS는 확인 대기(연결됨이 아님). 확인 후 제자리 「연결됨」(ADR-0182, 토스트 없음).
- ADR-0180 D7 「온보딩 S5」는 번호 스텝이 아니라 **로그인 후 first-run 카드**(App이 소유, 세션 게이트가 선점하지 못함). UX-R2a가 번호 시퀀스에 접을 수 있다. 진행 표시 없음.
- NOTES: 기기 목록/해제는 `GET /v1/auth/devices` + `DELETE /v1/auth/devices/{id}`가 없다(#2029). 현재 카드의 연결됨은 세션 안 폴 `status`/`device`(+live 기록)로만 살아남고, 지속 목록은 #2029.
- runtime-unverified: 실기기 카메라 스캔(M0m).
- red proof: 독립 디코더 왕복(v1/v7/v8) · RS/포맷 골든 · App 트리 first-run · SAS 미확인≠연결됨 · 채움 액센트 ≤1 · 모듈 피치 바닥 · aria-describedby · 만료 문장 · 리마운트 · 재발급 폴 1개 · 캡처 전수 시크릿 스윕.
- R3: QR well `content-box`(피치 v7/v8 = 4.000 CSS px) · pending은 살아 있는 코드+스캔, SAS confirm은 awaitingConfirm만 · 바우처는 만료·consumed·로그아웃에 지움 · 시크릿 게이트는 심은 프레임에서 실패 · 기기명에 조사 없음 · first-run은 S1/S2와 같은 `onboarding-step-chrome`+`max-w-sm`.
## UX-R4a Agent Hub enabledTools 편집 UI (#1957, 2026-09-02)

- Agent Hub 프로필 도구 칩을 카탈로그 행(이름·설명·실행 가능/실행 불가·승인 필요) + 비낙관 저장으로 대체. PUT 은 저장된 프로필 필드만 싣는다. 성공은 ADR-0182 in-place `도구 변경 저장`→`도구 변경 저장됨` 1.6s (`useInlineConfirm`, CopyButton 동일 시계). 실패는 InlineBanner, 403은 읽기 전용.
- 카탈로그는 GET `/v1/workspaces/{ws}/agent-tool-catalog` 에서 읽는다. OpenAPI·momo-server 에 이 라우트가 없어 404/405/501·본문 불명은 표시 전용으로 접는다. `tools.rs` CATALOG 는 클라에 복사하지 않음.
- runtime-unverified: 라이브 카탈로그 GET(라우트 부재). 클라 시험은 목 카탈로그.
- 잔량: 폰 `COPY_RECEIPT_MS = 1_500` (`clients/mobile/src/features/conversation/copy.ts`) vs 웹 1 600. 이 티켓은 폰 무접촉. 소유: 폰 패리티 후속.

## M0m 기기 연결 폰 절반 — ConnectScreen 「QR로 연결」 (#1990, 2026-09-02)

- `oort://link` 파서(join 동형: 순서 무관·`momo://` 흡수·미지 파라미터 무시·잘못된 server 거부) + `POST /v1/auth/device-link/redeem` + `pendingSas` SAS 대기(서버 `sas` 또는 토큰 SHA-256 파생 4자리). 세션은 활성화 후 키체인만.
- 카메라 권한 거부 → 문장 안내 + 「주소로 연결」 폴백. 만료 401 / 재사용 409 / 형식 오류 세 문장, 재시도 「QR 다시 찍기」.
- R2: SAS에 「QR 다시 찍기」·「주소로 연결」 탈출, TTL 120s 만료 문장, 오프라인/unreachable 상태, 권한은 모달 전에 결정.
- R3: SAS 「QR 다시 찍기」는 스캐너를 연다. 거부 「주소로 연결」은 인앱 포커스(Settings는 「설정에서 허용」만). unreachable은 TTL까지 백오프 폴. AppDelegate가 warm `oort://`를 RCTLinkingManager로 전달. `expo-device` `modelName`. runtime-unverified: 실기기 카메라·권한 프롬프트.

## UX-R2s 웰컴 킥오프 서버 절반 — RunTrigger::Welcome (#1960, 2026-09-02)

- `RunTrigger::Welcome { kind: Opener|ProviderRequired|Closer }` + 멱등 키 `welcome:{ws}:{member}:{kind}:v1`. 가입 `createdMember:true`·owner claim 완주가 같은 tx에서 `agent_job`을 넣는다. 재가입·invite redeem(기존 멤버)은 무트리거.
- 워커: provider 미구성이면 모델/원장 0, 에이전트 명의 정적 카피 1건(`ProviderRequired`) — opener 키는 소비하지 않음. opener는 정상 run + `usage_ledger`. G2 streak는 `welcome:%` run 제외.
- settings `welcome_agent_member_id`(활성 에이전트)·`welcome_prompt`(≤2000자). WorkspaceDto 프로젝션. `schema_v0.sql` 무접촉. Closer는 enum 예약(v1 미구현).
- runtime-unverified: 라이브 join→Centrifugo 첫 발화 왕복(클라 UX-R2b).

## UX-R0 모션 토큰 사다리·눌림 단일점·강제 기제 (#1958, 2026-09-02)

- ADR-0179 D1·D2·D3(값)·D4·D5·D6·D9·D10. `motion.css` 사다리(120/180/240/500) + easing + arrival 값 + `--elevation-rest/float`. `motion.ts` 모달 200/150 상수(소비는 UX-R1). `button` 전 variant `press`. tokens.css 손기입 200/160/150/120ms 를 사다리로 흡수(값 200→240, 160→180, 150→120). 드로어는 D1대로 `standard`(240).
- R2: Button 전이 목록 소유자는 `press` 하나(`transition-colors` 제거, `@layer utilities` 에서 override 뒤). 모달/팝오버 상수는 `motion-enter/exit` 키프레임 유틸(tw-animate-css 없음). `@theme --default-transition-*` 를 사다리에 묶음.
- 강제: `motion.test.ts` + preflight `raw_motion`(온보딩 블록·motion.ts allowlist). 폰 무접촉(M1a). `motion/react` 미도입(D8는 첫 소비자 티켓). 표면 이관은 UX-R1a~e.
- 잔량(고치지 않음): hover-without-active preflight는 DS-4. 캡처 `waitForAnimations` 전수는 DS-3. S0 CTA `press` 는 UX-R1e.
- H-1 runtime probe: CI에서는 skip — DS-3 3짝 캡처 레인이 런타임 모션 측정을 인수.
- runtime-unverified 아님. 캡처는 rest 프레임만(눌림 3짝은 DS-3).

## SH-3a `scripts/oort doctor` (#1955, 2026-09-02)

- 셀프호스트 설치 판정 1개: `scripts/oort doctor [--env] [--json] [--strict]`. 필수 키는 `self_host_env.sh` 생성 heredoc에서 파생. 소문자 `true` 게이트(doorbell/hosted-delivery)·언퍼얼 `1`·`PLATFORM_ADMIN_EMAILS`·provider master key·drive backend·WS URL·role 비번↔DATABASE_URL. 시크릿은 이름·길이 class·형식만.
- 스택 미기동이면 compose/`/healthz`/agent-port/outbox/migrate 는 skip+안내(설치 전 preflight). exit 0/1/2, `--strict` 는 major→2.
- runtime-unverified 아님(픽스처 하네스). 로컬 `oortv013` 스택 실측은 PR 본문.

## M0s 기기 연결 서버 절반 — 1회용 QR 링크 토큰 (#1959, 2026-09-02)

- `POST /v1/auth/device-link` 발급 · `POST …/redeem` 소비 · `GET …/{id}` 폴링 · `POST …/{id}/confirm-sas`. 마이그레이션 086 `device_link_token` + `token.device_label`/`pending_sas`. `schema_v0.sql` 무접촉.
- D4 SAS: `RealtimeAdvert::SameOrigin`(`MOMO_CENTRIFUGO_WS_URL=same-origin`, `--public-origin` 이 쓰는 값) + 비-루프백/비-LAN Host 일 때만 4자리. 새 env 없음.
- red proof ①만료 401 ②재소비 409 ③에이전트 403 ④발급자 로그아웃 401 ⑤공개 오리진 SAS 홀드 ⑥루프백 즉시 ⑦원문 로그 0 ⑧RLS. runtime-unverified: 실기기 QR/카메라(M0w/M0m).

## SH-1 릴리스 매니페스트 `releases/latest.json` (#1954, 2026-09-02)

- 커밋된 `releases/latest.json`(v0.1.4 list digest, GHCR 아키별 이미지 매니페스트 digest 실측) + `scripts/release_manifest.sh` / `scripts/check_release_manifest.sh`. SELF_HOST·AGENT·README는 매니페스트를 읽고 산문 digest 0.
- red proof: digest 한 글자·`@sha256:` 잔여·CHANGELOG version 불일치. 생성기 재실행 바이트 동일. `scripts/local_gate.sh` 편입은 이 티켓에서 하지 않음(오케스트레이터).
- runtime-unverified 아님(GHCR inspect·attestation verify PASS, 생성기 멱등).

## BT-6 클라 절반 mark-unread (#1934, 2026-09-02)

- momo-core `effectiveUnreadStartSeq` 단일점 (ADR-0178 D3). 배지·UnreadDivider·UnreadPill·⌥↑↓ 가 이 함수만 소비. 서버 `unread_count` 는 접지 않음.
- 메시지 ⋯ 「여기부터 안 읽음」: PUT `mark_unread_before_seq`, `read_intent` 생략. 낙관 반영, 400/403 롤백+행 배너.
- 채널 명시 열람·사이드바 「읽음 처리」는 `read_intent: "explicit_open"`. 도착 중 플러시·인박스 멘션 광고는 생략(background). 서버 `marked_unread_before_seq: null` 이 로컬 마크를 지움.
- 서버 절반은 track/engine PR #1961. runtime-unverified: 라이브 PUT/GET 왕복(이 레인은 모킹).
- runtime-unverified / 폰 소비 공백: `clients/mobile/src/features/sidebar/rows.ts:179` 와 `clients/mobile/src/screens/ConversationScreen.tsx:388` 이 서버 `unreadCount` 원문을 읽어, 데스크톱 마크가 폰에서는 다 읽음으로 보인다. 이 PR 에서 폰 소비는 구현하지 않음.
- red proof: 마크 3/커서 10 공유 픽스처 · explicit_open vs 도착 플러시 · null 수렴 · 400 롤백. D3 합성 AST 게이트(별칭·헬퍼 포함).
- R3: 방문 중 나중 마크는 구분선·필을 옮기고 열람 `null` 은 지우지 않음. 타임라인 polite live 영역은 하나.
- 안읽음 필 재방문 무장은 이 PR 이전부터 있는 비결정 결함이며 이 PR 이 바꾸지 않는다 (#1966).
- R5: 마크 PUT 400 이면 방문 경계를 낙관 이전으로 되돌린다. 롤백 `null` 은 열람 광고가 아니다.

## BZ-5a 외양 1차: 토큰 바인딩 + 컬러 모드 + 액센트 시안 (#1868, 2026-08-30)

- `clients/web/src/design/themes/` 바인딩 층. 컴포넌트는 `--accent`만 소비하고, 루트 `data-accent`가 라이트·다크 쌍을 재정의. 기본=새벽(호박, 목록 첫 값). 후보 시안: 성운, 홍염, 혜성, 감람. 성재 확정 전 머지 금지.
- 컬러 모드 System/Light/Dark는 기존 ChoiceRadios를 `momo.web.appearance.v1` JSON으로 이관(옛 `momo.web.theme.v1` 읽기 전용 이관). 액센트 스와치 44·radio·focus-visible.
- 대비 전수: `catalog.contrast.test.ts`가 `tokens.contrast.test.ts` 액센트 가족 축을 파생(채움 순서 1.15·danger dE·전경 7종·muted-soft 그릇·ok/warn/danger 거리·후보 간 dE). 테마 추가=테스트 추가. red proof 상주. S0·`.brand-lockup`은 Dawn 고정(D4).
- D5: `design_preflight_web.sh`가 `tokens.css`·`tokens.contrast.test.ts`·`themes/*` 경로 끝만 면제(합성 입력 자가시험). 캡처는 `--accent`/`--accent-soft` 정착 + 유한 애니메이션 idle 대기.
- #1922 R3: 혜성 다크를 라이트 자주 가족으로 복귀(`#8b005a`/`#ff4bcc`, 표류 8.5°). 옛 민트 `#6de89b`는 스킴 간 표류 red proof(상한 20°, 근거=새벽 19.8°). 시안 크롬 복원.
- 서버 무접촉. runtime-unverified 아님. 시안: `accent-<id>-{light,dark}.png`.
> **랜딩 증거 원장(newest-first).** 항목=랜딩 단위, 원문 불변.
> **로테이션(2026-09-01 재편):** 이 파일은 당월+직전월 항목만 담는다. 월초 플러시 때 `momo-main`이 그 이전 달 항목을 `docs/archive/STATUS-YYYY-MM.md`로 원문 그대로 이동한다. 과거 추적은 `docs/archive/README.md` 색인.

## BF-B2 클라 절반 커스텀 상태 UI (#1889, 2026-08-30)

- ProfileCard 「상태 설정」 다이얼로그: 기존 이모지 피커 + 자유 텍스트 ≤80자 + 만료(지우지 않음/30분/1시간/오늘까지/시각 고르기) + 프리셋 칩 5종 + 지우기. PUT은 `status` 필수, 커스텀 3키 omit=유지·null=지우기.
- design-review #1920 R2 수리: 프로필 메뉴를 pane-sm에 고정(80자 머리가 390을 밀던 M-1 회귀)·글만 있는 상태에 말풍선 표식·폰 캡처가 시트로 RemindDialog를 염·오프라인/시각 고르기 장면. R1 배너·만기 타이머·시드·auto 침묵·a11y·44는 유지.
- 서버 절반은 track/engine(#1907, A-42). runtime-unverified: 라이브 PUT/roster/presence 브로드캐스트. 선행 P-1(390 서랍 z)·P-2(#1919) 손대지 않음.
- red proof: 80자 픽스처에서 메뉴 right≤390·✓ 가시. web vitest · core vitest · tsc · design_preflight_web · `CAPTURE_PORT=8517` capture:design · `SHELL_GATE_PORT=8519 SHELL_GATE_FOCUS_ONLY=1` gate:shell.

## BF-B1 클라 절반 메시지 리마인더 UI (#1888, 2026-08-30)

- 메시지 ⋯/우클릭/시트에 「나중에 알림」(프리셋 5종 + 날짜·시간 커스텀 + 메모 ≤200자, 로컬 TZ). 인박스에 「나중에」 탭 도킹(A5 행 문법: 미리보기·채널·상대 만기·완료·스누즈). 원문 클릭은 기존 `?msg=` 점프.
- 만기는 read-state와 같은 30s react-query 리듬(쿼리 분리, 에러 격리). outbox 없음. 첫 진입 워터마크(`momo.web.reminders.watermark.v1`)는 과거 만기를 알림 없이 목록 배지. A4 종류 토글에 「나중에 알림」 가산.
- design-review #1918 수리: ⋯ 키보드 도달·390 본문 교차 0(`w-overflow-bowl` 한 값)·숨김 창 폴링+가시성 복귀 페치·누적 만기 상한 3·만기 칩 그릇(행 워시 아님)·완료/미루기 tap-target·실패 시 다이얼로그 유지+동사별 오류·완료 확인·채널 UUID 금지·목록 파서 fail-closed.
- 서버 절반은 track/engine(#1905). 이 레인은 REST 소비층+모킹 red proof. 실서버 conformance는 main 승격 시. runtime-unverified: 라이브 CRUD.
- red proof: 프리셋 경계(월요 00:30은 오늘 9시가 아님)·CRUD 왕복 모킹·워터마크 알림 0·폴링 만기 알림 경로·행→메시지 점프. web vitest · tsc · design_preflight_web · `CAPTURE_PORT=8507` capture:design · `SHELL_GATE_PORT=8509 SHELL_GATE_FOCUS_ONLY=1` gate:shell.

## BF-A8 채널 빈 상태 인트로 블록 (#1904, 2026-08-30)

- 새 채널 첫 진입을 EmptyInvite 분기에서 빼, 타임라인 virtuoso **leading row**로 채널 아이콘+이름+시작 카피+액션 카드(첫 메시지 쓰기, 권한 있으면 멤버 추가하기)를 그린다. 메시지 도착 시 같은 목록 안에서 인트로가 히스토리 맨 위에 남고, 같은 DOM 노드를 유지하며 scrollTop은 불변. 바닥 정렬 목록이라 뷰포트 top은 새 행만큼 올라가는 것이 정상 동작(높이 0·scrollTop 0·동일 노드는 참). 액션과 「첫 메시지」 계열 문장은 empty일 때만. 비어 있지 않은 인트로는 이름·토픽·시작점만 말한다.
- 토픽이 있으면 인용, 없으면 empty일 때 emptyChannelCopy 일반 카피·히스토리가 있으면 「이 채널의 시작입니다」. 생성 시각/생성자는 채널 모델에 없어 그리지 않는다. DM은 Avatar+이름(+@handle)+DM 계약 문장, 에이전트는 `--agent`. 초대 카드 없음. 스레드 패널 비대상. 초대 카드는 `canCreateChannelNow`(로스터 미착이면 침묵, 정착 후 오너/관리자).
- 서버 무접촉. runtime-unverified 아님. red proof: web vitest 1904 · tsc · design_preflight_web 12/12 · `CAPTURE_PORT=8497` capture:design · `SHELL_GATE_PORT=8499 SHELL_GATE_FOCUS_ONLY=1` gate:shell.

## BF-A6 링크 프리뷰 Rich/Compact 선택 (#1903, 2026-08-30)

- 설정 > 링크 미리보기를 접기 boolean에서 `rich | compact | off` 3값 라디오로. 저장 `momo.web.link-preview.v1`. 기존 `momo.web.link-previews-folded.v1`: `"true"`(카드 숨김)→`off`, `"false"`/unknown(compact 카드)→`compact`, 미저장→`rich`(미토글 기존 사용자 포함 의도적 기본 상향, 오케스트레이터 승인·성재 최종 확인 예정).
- 타임라인 unfurl: 사진 카드는 OG 1.91:1(`aspect-og`) 히어로+`max-h-unfurl-hero` 상한. `imageUrl`이 있으면 첫 페인트부터 프레임 예약, fetch/디코드 실패만 compact 강등. 제거 X는 불투명 `bg-surface-raised` 칩. off는 미렌더. 카드 전체 단일 링크. 설정 변경은 스토어 구독으로 즉시 반영(스레드 패널 포함).
- 서버 무접촉. runtime-unverified 아님. design-review #1913 수리: 제거 X 불투명 칩, rich 첫 페인트 프레임 예약, OG 1.91:1+`unfurl-hero` 상한, rich 메타 대칭 패딩, 미저장→rich 기록 정정, OG 픽스처 단색 런북 카드.
- red proof: web vitest 1878 · tsc · design_preflight_web 12/12 · `CAPTURE_PORT=8487` capture:design · `SHELL_GATE_PORT=8489 SHELL_GATE_FOCUS_ONLY=1` gate:shell.

## BF-A7 컴포저 서식 최소셋 (#1902, 2026-08-30)

- 채널·스레드 textarea에서 텍스트를 고르면 선택 위(공간 없으면 아래)에 부유 트레이(굵게/기울임/인라인 코드/링크). TipTap 없음. 접사는 momo-core markdown이 읽는 `** * \` []()` 만. 이미 감싸져 있으면 토글로 해제. 링크는 `[선택](링크주소)` 뒤 자리표시 선택.
- design-review 수리 (#1909): Esc dismiss가 keyup sync에 안 되살아남, 한국어 기울임 거부(코어 renderable과 같은 자), 공백·줄 경계는 코어 closingIndex/줄 단위 파서와 같게, 트레이는 탭 한 정거장+방향키 로빙+aria-pressed, 선택은 좌표를 따라감, hover:none/pointer:coarse에서는 안 그림, 미치환 링크는 힌트만(전송은 그대로).
- ⌘B/⌘I는 트레이 없이도 동작. 트레이 mousedown은 포커스를 빼앗지 않고, Tab으로 도달, Esc로 닫힘. @멘션 트리거 중에는 숨김. 전송·채널 전환·선택 해제 시 소멸. draftStore는 기존 replaceValue 경로.
- 뷰포트 클램프는 buzz 문법(Apache-2.0). 좌표는 CSS 변수(인라인 style= 없음). 모션 없음(reduced-motion 즉시).
- red proof: web vitest 1853 · tsc · design_preflight_web · `CAPTURE_PORT=8477` capture:design · `SHELL_GATE_PORT=8479 SHELL_GATE_FOCUS_ONLY=1` gate:shell.

## BF-A5 크로스채널 초안 패널 (#1901, 2026-08-30)

- 사이드바 인박스 옆에 「초안」. 이 워크스페이스에 살아 있는 초안이 0이면 숨긴다. `/drafts` 목록은 draftStore를 읽기만 하고 채널명·1줄 미리보기·상대시간을 최근 수정순으로 그린다. 행 클릭은 `/c/{id}`로 가며 기존 컴포저 복원을 재사용한다.
- 삭제는 확인 없음(로컬 초안), hover/⋯ 메뉴 안에만. 삭제·이탈 채널의 고아는 목록·항법에서 숨기고 출처 불명으로 두지 않는다. 저장소 자동 삭제는 하지 않는다(로딩 중 빈 목록이 살아 있는 초안을 지우는 길을 막기 위해). 고아는 TTL·정원·해당 채널 `readDraft`가 정리. 스레드 컴포저 본문은 이 저장소에 없어 목록에 못 올린다(스키마 무변경).
- 빈 상태: 「아직 초안이 없습니다. / 쓰다 만 글은 자동으로 저장됩니다.」
- design-review 수리: M1 ⋯ raised 그릇+hover:text-ink, M2 행 링크 이름=보이는 텍스트(힌트는 describedby), M3 삭제 후 이웃 행/빈·헤딩 포커스, L1 단일 toolbar 제거, L4 `DRAFTS_CHANGED_EVENT`.

## BF-A4 알림 설정 세분화 (#1887, 2026-08-30)

- 설정 > 알림 규칙에 이 기기 알림 그룹: 권한 3분기(granted 켜짐 / default 「알림 켜기」·요청 중 / denied macOS 시스템 설정 안내) + 미지원(웹뷰·브라우저 탭). 발화는 기존대로 데스크톱 셸만. 앱 포커스 복귀 시 OS 권한 재조회.
- 종류별 토글은 조사된 실존 2종만(멘션, 승인 요청). `momo.web.notifications.v1` 로컬 저장. 꺼진 종류는 `notifyThisDevice` → `kind-disabled` 로 미발화. unsupported면 종류 그룹 잠금+공유 사유. DM·스레드·일반 채널 자리는 만들지 않음. 알림음 범위 밖.
- 카피: 방해 금지·멘션 예외는 서버에 하나, 종류별 끔은 이 기기(섹션 머리에만). default 안내는 「앞에 없을 때」. DND PUT 회귀 유지.
- design-review 수리: H-1 켜기 버튼 행 안 고유폭, H-2 denied OS 카피+재조회, H-3 grant 포커스→켜짐 status, M-1 레일 런타임 발화 테스트, M-2 unsupported 잠금, M-3 켜짐 `--ok-soft` 그릇, M-4/L-1 카피.
- red proof: web vitest 1806 · tsc · design_preflight_web · `CAPTURE_PORT=8177` capture:design (settings-notifications light/dark) · `SHELL_GATE_PORT=8179 SHELL_GATE_FOCUS_ONLY=1` gate:shell.

## BF-A3 허들 마이크 디바이스 선택 + 게인 (#1886, 2026-08-30)

- 허들 라이브 컨트롤에 마이크 선택 메뉴. `useAudioInputDevices`가 `enumerateDevices`+`devicechange`로 audioinput을 갱신하고, 권한 전(빈 레이블)·거부·0개를 문장으로 가른다. 선택 deviceId는 `momo.web.huddle.mic.v1`에 기억되고 다음 참가 시 그 장치로 시작(부재 시 기본 폴백).
- 트랙 교체는 livekit-client `setMicrophoneEnabled({ deviceId })` + `LocalAudioTrack.setDeviceId`. 입력 음량(0~100%)은 공식 게인 API가 없어 WebAudio GainNode를 `setProcessor`로 삽입.
- design-review 수리: B-2 `MicGainProcessor`가 init에서 AudioContext를 캐시해 livekit restart(audioContext 미전달)에서도 그래프를 재구축. B-1 390 joined는 음소거+캐럿 스플릿·Live/캐럿 wide-only. H-1 setDeviceId boolean 확인 후에만 persist. H-2 게인 항목 ←/→. H-3 `100%` nowrap+4ch. M-1 메뉴 `max-w-menu-available`. L-1 `gainPercent`/`gain01` 경계 명명.
- red proof: livekit 실쉐이프 restart(audioContext 없음), setDeviceId false 정합, 게인 키보드 렌더 테스트, `gate:huddle` 390 그룹 내 컨트롤 상호 겹침 0.

## BF-A2 상단 안읽음 점프 필 (#1885, 2026-08-29)

- 읽음 구분선이 뷰포트 **위쪽 밖**일 때만 타임라인 상단 중앙에 「새 메시지 N개 보기」+위 화살표 부유 필. 클릭/Enter → 구분선으로 스크롤(reduced-motion이면 auto) 후 첫 안읽음 행 정거장에 포커스. 구분선 진입(또는 필 실행) 시 epoch 래치로 소멸, 채널 전환 시 리셋. 하단 jump-latest와 동시 표시 가능.
- N은 연 순간의 동결 `unreadCount`(구분선과 같음). 라이브 꼬리는 하단 필만 센다. 같은 `UnreadPill` 부품. hover:none에서 44px, `shadow-lg`.
- H-1 오발 수리: 래치 무장은 IO 실측 「in」과 상단 필 실행만. range 폴백 「in」(오버스캔 마운트)은 표시 판정에만 쓰고 무장하지 않는다. 상단 접근명 「위쪽의 새 메시지 N개 보기」. web vitest 1761 · tsc · design_preflight_web · `CAPTURE_PORT=7777` capture:design (chat jump-unread 140×44) · `SHELL_GATE_PORT=7779 SHELL_GATE_FOCUS_ONLY=1` gate:shell · `FOLD_GATE_PORT=7781` gate:fold.

## BF-A1 리액션 칩 이름 툴팁 (#1884, 2026-08-29)

- `ReactionMap`이 이미 들고 있던 memberIds를 칩 툴팁/접근명으로 접는다. 서버 0. 코어 `formatReactionNames`: 나 포함 시 「나(내 반응 취소)」 맨 앞, 3명까지 이름, 초과·명부 미해석은 「외 N명」(실명 불명 표기 없음). 모호한 표시명은 `memberNameParts` 핸들.
- 웹 칩은 기존 native `title` 관례(Radix Tooltip 의존 없음). aria-label은 카운트+이름 요약(+미반응 시 「나도 반응하기」). 로빙/토글 무변경.
- red proof: core timeline 546 · web vitest 1714 · tsc · design_preflight_web · `CAPTURE_PORT=7477` capture:design (행당 탭 스톱 1) · `SHELL_GATE_PORT=7479 SHELL_GATE_FOCUS_ONLY=1` gate:shell.

## BZ-6a-p1 온보딩 폴리시 (#1882, 2026-08-29)

- S0 히어로 락업: OortMark 1.5×(144, 12vw 상한 192) + 워드마크 `oort`(`--font-onboarding-wordmark` 마크 1/3, clamp 48–64) + 소개 카피 1줄(`--spacing-onboarding-copy` 360, pane-sm 차용 아님). 궤도 드로잉→워드마크→카피 순차 페이드(reduced-motion 즉시). 산포 중앙 배제 원 반지름 32.
- design-review 수리 (#1883): H-1 워드마크가 text-title(16)로 카피와 같은 단이던 것, M-1 카피 measure가 pane-sm(192)이라 1728에서도 2줄이던 것.
- S1/S2 스텝 크롬: 뒤로(ArrowLeft+레이블, Button ghost, 44px)와 `n/3` 카운터를 상단 한 줄로. Tauri는 AppTitlebar와 같은 트래픽라이트 인셋+드래그(버튼 제외). 밑줄 링크 폐기.
- red proof: web vitest 1711 · tsc · design_preflight_web · `CAPTURE_PORT=7377` capture:design (S0 lockup hits 0; 1280 워드마크 51.2px/마크 154, 390 48/144; 카피 265×22 1줄) · `SHELL_GATE_PORT=7379 SHELL_GATE_FOCUS_ONLY=1` gate:shell.

## BZ-4 설정 전면 페이지 + Profile (#1867, 2026-08-29)

- `/settings` 진입 시 앱 사이드바·타이틀바를 설정 전용 레이아웃으로 대체한다. 좌측 섹션 사이드바(개인/워크스페이스/연결, 기존 섹션 명칭과 **그룹 내** 상대 순서 유지) + 「앱으로 돌아가기」. 기존 섹션 컴포넌트는 재사용.
- Profile 섹션(개인 그룹 최상단): 아바타 현행 표시, 표시 이름 `changeMyDisplayName` PATCH 1회, 빈 이름 400은 한국어 다음 행동("표시 이름을 비울 수 없습니다…")으로 매핑하고 와이어 영어는 화면에 두지 않음. 성공 시 roster invalidate + 세션 멤버 교체(낙관 갱신 없음). 핸들은 읽기 전용.
- design-review 수리 (#1880): 이미 `/settings`면 ⌘, no-op(히스토리 겹쌓임 없음, H-1), 전면 전환 포커스 진입/복귀(M-4), 폰 목록 캡 `--spacing-settings-nav` 308 + 선택 항목 scrollIntoView(M-1).
- red proof: web vitest·tsc·design_preflight·capture:design·`SHELL_GATE_FOCUS_ONLY` gate:shell. 통합 테스트는 PATCH 모킹(track/uxui에 #1873 서버 표면 미포함).

## BZ-3 라이트 보더·컴포저 포커스 (#1866, 2026-08-29)

- 라이트 `--line`을 `#dcd8d0` → `#e4e0d8`로 한 단계 옅게. `--line-strong`은 라이트 `--surface-hover` 위 3.03:1이라 RGB +1이 2.99로 3:1이 깨져 그대로(다크 무접촉).
- 컴포저 그릇은 `focus-within:focus-ring`을 떼고 `focus-visible-within:focus-ring`(Tab 모달리티 + 자식 `:focus-visible`). 마우스 클릭에서 보더 색·링 불변, Tab 진입에서만 기존 인셋 링. Input/Select/outline은 프리미티브 `focus-visible:focus-ring` 유지.
- 관전 터미널 그릇도 같은 변형(1순위). xterm helper textarea는 클릭에도 `:focus-visible`이라 `:focus-within`이면 드래그 선택 순간 인셋 링이 서고 stdin 죽은 표면을 입력처럼 읽힌다. Tab 진입·이탈·복사는 `terminalOwnsKey` 그대로. 정본을 컴포저로 좁히지 않았다.
- 정본 동기: design-system §2.2 · taste `tokens.md` · 폰 `lightPalette.border` 짝.

## 채널 헤더 1줄 + 우측 라운드 컨트롤 (#1865, 2026-08-29)

- 채널 헤더에서 토픽 상시 노출을 제거하고 1줄 제목만 남긴다. 토픽은 ⋮ 메뉴 「주제 보기」가 기존 읽기 다이얼로그를 연다(갱신 라우트 없음, 편집 항목 없음).
- 우측은 기존 기능만 라운드 사각 그룹으로 재배치: `[터미널] [고정] [👥 N] [허들] [⋮]`. 👥 N은 기존 멤버 목록 트리거. 허들 유휴는 아이콘 버튼, Live 배지·참가자는 유지.
- design-review 수리: 390 라이브에서 그룹이 줄어 서랍/해시와 겹치지 않음(B-1), Live 칩은 ok-soft 채움+점(H-2, M-1), 허들 버튼은 outline icon 프리미티브(H-1), 다이얼로그 닫힘은 layout에서 트리거로 복귀(H-3). `gate:huddle`에 390×라이브 축.
- red proof: web vitest·tsc·design_preflight·capture:design·`SHELL_GATE_FOCUS_ONLY` gate:shell·gate:channel-header×12·gate:huddle.

## BZ-6a 온보딩 스텝 셸 + S0 오르트 랜딩 (#1869, 2026-08-29)

- ConnectPage를 S0 랜딩(단일 룩 딥스페이스 + OortMark 궤도 드로잉 + 산포 필드 + 2택) / S1 서버·초대 / S2 계정으로 감쌌다. 로그인·join·서버 검증·`momo.web.server.v1` 의미론은 기존 재사용. 저장 서버 또는 `/join?code=` 프리필이면 S0 생략.
- capture/e2e/게이트 레인이 S0를 첫 페인트로 통과한다: `advanceToAccount`가 S0→S1→S2를 걷고, `capture:design`은 S0 프레임을 찍는다. 산포 글리프는 위치 중심(`translate(-50%,-50%)`)이고, 랜딩은 PWA 배너 아래 App 슬롯을 `height: 100%`로 채워 뷰포트 바닥에 2택이 앉는다.
- design-review 수리 (#1871): S1/S2 카드 `mx-auto`(H-1), 초대 코드 4xx는 S1 배너+코드 포커스(H-2), 스텝 전환 포커스(M-1), CTA 배제 산포(M-2), 뒤로·최근칩 44(M-3), 궤도 pathLength(L-1), 딥링크 mask-reveal 억제(L-2), S2 카피. red proof: vitest 포커스/404 복귀, capture 카드 중앙·inviteHits 0, shell focus lane.

## 프로필 메뉴 로그아웃 (#1858, 2026-08-28)

- 사이드바 `ProfileCard` 드롭다운 맨 아래(설정 뒤)에 「로그아웃」을 추가. `useSession().logout` 직접 호출, 확인 다이얼로그 없음, destructive 색 없음. 설정 > 계정 `data-testid="logout"` 은 유지.
- red proof: 메뉴 열면 `profile-logout`이 설정 뒤, 선택·Arrow/Enter 시 logout 1회. 상태 3종·워크스페이스 추가·설정 회귀.

## 허들 TURN setConfiguration 경로 커버 (#1847, 2026-08-28)

- #1825 세션 스코프 셰임이 생성자 config만 리라이트해 livekit-client의 빈 ctor → `setConfiguration(JoinResponse ICE)` 주입을 놓침. `RTCPeerConnection.prototype.setConfiguration`을 같은 host-게이트로 인터셉트. 생성자 경로·복원 시점(세션 종료)·Cloud/직결 무발동 유지. 새 플래그 없음.
- red proof: 빈 ctor + setConfiguration `turns:<host>:443` → `getConfiguration()` 8443. 복원 후 무변환. Cloud/host 불일치 무발동. 실브라우저 왕복은 오케스트레이터 이월(`runtime-unverified`).
## mark-unread 신호 서버 절반 (#1934 / BT-6, ADR-0178, 2026-09-02)

- `read_state.marked_unread_before_seq` nullable bigint (085). `schema_v0.sql` 무접촉. `last_read_seq` GREATEST 불변(D1). 서버는 마크를 `unread_count`에 접지 않음(D3 합성은 momo-core 단일점).
- `PUT …/read-state` 본문 가산: `mark_unread_before_seq`(채널 실존 seq, 미래·비존재 400) + `read_intent` enum `[explicit_open, background]` (optional, default=background, D6). explicit_open만 같은 tx에서 마크 삭제. 구식/백그라운드 광고는 마크 불변.
- GET/list·realtime payload에 `marked_unread_before_seq` 항상 존재(미표시는 `null`). red proof: `mark_unread_conformance_pg` + `d2_b12_2b`. 클라 절반은 별 PR.

## 커스텀 멤버 상태 REST (#1889 / BF-B2 서버 절반, 2026-08-30)

- `member`에 nullable 3필드(083): `status_emoji`(≤32 스칼라)·`status_text`(trim ≤80)·`status_expires_at`. `schema_v0.sql` 무접촉. RLS는 기존 `member` ws_isolation 승계.
- 같은 `PUT/GET /v1/workspaces/{ws}/presence` 바디 확장(형제 엔드포인트 없음 — 경로에 memberId가 없고 브로드캐스트가 이미 `type: presence` `ch:` 레일). omit=유지, JSON null=지우기. 만료는 읽기에서 무시(지연 삭제, 잡 없음). 사람만. 무감사(기존 프레즌스 PUT 관례).
- red proof: `custom_status_conformance_pg`. 클라 절반은 A-42(프리셋 칩: 회의 중/이동 중/병가/휴가/재택).

## 메시지 리마인더 REST (#1888 / BF-B1 서버 절반, 2026-08-30)

- `message_reminder`(082): id/workspace/member/channel/message/due_at/note≤500/completed_at. RLS FORCE 소유자 스코프(`app.workspace_id` + `app.member_id`). pending due 인덱스. `schema_v0.sql` 무접촉. **outbox 팬아웃 없음**(ADR-0175 v1=클라 폴링).
- 사람 본인 CRUD: `POST/GET/PATCH/DELETE /v1/workspaces/{ws}/reminders`. 과거 due 400, 타인 404, 비멤버 채널 403, 에이전트 403. 감사 `reminder.created/updated/completed/deleted`.
- red proof: `reminder_conformance_pg`. 클라 절반은 A-41.

## 자기 표시 이름 변경 REST (#1873 / BZ-4e, 2026-08-29)

- `PATCH /v1/workspaces/{ws}/members/me` `{displayName}` — 사람 본인만. 정규화는 join의 `normalized_join_display_name`(400 `displayName is required`). 에이전트 자격은 allow-list 밖 403 + `require_human`. 핸들·역할·아바타 무접촉.
- 단일 쓰기경로: tenant tx에서 `member.display_name`+`updated_at` UPDATE, audit `member.renamed`, 프레즌스 동형 `member.renamed` outbox를 본인 `ch:` 채널에만. 응답은 login/join `Member` 봉투.
- red proof: `self_rename_conformance_pg` 본인 200+roster·정규화 400·에이전트 403·타 WS/비멤버 403·감사·outbox. `schema_v0.sql` 비접촉.

## 에이전트 workspace role 변경 서버 거부 (#1857, 2026-08-28)

- `change_workspace_role_in_tx`가 target `member.kind=agent`면 requested 값과 무관하게 403 `agent roles are fixed to member`. no-op(`member`)도 같은 문장. 사람 승격/강등·last-owner·self-manage 불변.
- 채널 role(`change_channel_role_in_tx`)·suspend/remove는 비접촉. 클라 문장 매핑 없음(#1855가 컨트롤을 숨김).
- red proof: `membership_lifecycle_conformance_pg` 에이전트 4역할 거부 + 사람 왕복, 단위 테스트는 variant 문장/HTTP 403.

## 로컬 허들 node_ip 노브 (#1856a / #1856, 2026-08-28)

- huddle LiveKit entrypoint가 `MOMO_LIVEKIT_NODE_IP`가 있으면 `--node-ip`를 붙인다. 비면 자동 감지(기존 배치 무영향).
- 셀프호스트 생성 env만 `127.0.0.1` 기본. 기존 env 소급 주입 없음. VM TURN relay 페어는 #1856에 남음.

## generic 자격 메시지 읽기 REST (#1820 / ADR-0173, 2026-08-28)

- `required_agent_scope`가 `GET …/channels/{ch}/messages`와 `GET …/messages/{root}/replies`를 `messages:read`에 매핑. 기본 스코프 집합·GRANTABLE·hosted 가드·핸들러 감사는 비접촉.
- hosted 자격은 `AgentBearerClass` 선격리로 전 상태(active/grace/cleanup_pending) GET 403. 채널 경계는 사람 경로와 같은 `is_channel_member`(left_at).
- red proof: 매핑 전 정상 GET 403 → 매핑 후 generic+`messages:read` 200. 사람 GET·페이지네이션 회귀 유지.

## 허들 TURN 광고 포트 리라이트 (#1825, 2026-08-28)

- Funnel 셀프호스트에서 LiveKit v1.13.3 `external_tls`가 광고하는 `turns:<시그널호스트>:443`만 8443으로 바꾼다. username/credential/transport 불변. Cloud(`*.turn.livekit.cloud`)·stun·직결 candidate는 host/scheme 불일치로 미발동.
- 주입은 livekit-client `rtcConfig.iceServers`가 JoinResponse credential을 덮어써서 불가 → connect 구간의 스코프된 `RTCPeerConnection` 셰임. 실브라우저 2대 왕복은 오케스트레이터 이월(`runtime-unverified`).

## 멤버 라이프사이클 10경로 Rust 이식 (#1768, 2026-08-27)

- Swift `MemberLifecycleRoutes`의 경로·페이로드·에러 문장·권한 판정을 보존해 Rust로 이식. 마이그레이션 신설 없음 · `schema_v0.sql` 비접촉 · 026 원장 재사용.
- 위계는 `workspace_authorization.rs`의 `can_change_role_of`/`can_grant_role`/`can_suspend`/`can_remove`/`can_ban`. 판정은 도메인 층·같은 테넌트 트랜잭션에서 행위자·대상 role을 동시에 조회한다. 채널 role은 라벨(ADR-0128 D1).
- 마지막 owner 강등·정지·추방은 409. 자기 자신 대상은 403 `members cannot manage themselves`. 정지는 토큰 revoke + 로그인 403 `member is suspended`. 밴은 join/redeem 403.
- red proof: `membership_lifecycle_conformance_pg` 행위자×경로 매트릭스 + last-owner + suspend 로그인 + 밴 재가입 + RLS + audit. 실시간은 outbox/relay만(직접 publish 없음).

## ACP 이벤트 릴레이 이식 (#1785, 2026-08-27)

- host-signed `PATCH …/work-sessions/{session}` `{event}`를 Swift `recordACPEvent` 그대로 서빙한다. 무서명 400 문장(`ACP event ingestion requires work host signature`)은 유지. 정상 서명은 세션 스레드에 `work_session_event` system message + `message.new`/`agent.*` outbox를 한 트랜잭션에 남긴다.
- 투영·소비면은 이미 `@momo/core` `parseWorkSessionEvent` / `eventFromFrame`이 읽는다. 서버는 수신·원장 반영까지. 표면 신축 없음.
- red proof: 이식 전 정상 서명 이벤트 400 → 이식 후 무서명 400 · 타 호스트 403 · 정상 200 + 스레드 재조회 + `event_id` 멱등.

## role_labels 서버 수용 + 멤버 가독 프로젝션 (#1770 engine, 2026-08-27)

- `PATCH /v1/workspaces/{ws}/settings` 가 `role_labels` 를 수용한다. 키 ⊂ `{owner,admin,member,guest}`, 값은 비어 있지 않은 문자열(48 UTF-8 바이트 상한). `null` 은 키 삭제(클라 기본 라벨). 객체는 top-level 병합이라 통째 교체.
- `GET /v1/workspaces/{ws}` WorkspaceDto 에 `roleLabels` 파생 필드(없으면 `{}`). settings bag 통노출은 그대로 금지. 권한 사다리·RLS·role wire·`schema_v0.sql` 비접촉.
- PG 컨포먼스 `workspace_settings_conformance_pg` 가 예약→수용 전환, 멤버 identity 왕복, 형태 위반 400, null 복원, 공존 병합, member/guest 403 을 잰다. uxui 절반(설정 UI·클라 오버라이드)은 별 브리프.

## workspace.settings 읽기·쓰기 REST (#1800, 2026-08-27)

- `GET|PATCH /v1/workspaces/{ws}/settings` — operator(owner/admin) 전용. 기존 `GET /v1/workspaces/{ws}` 는 비접촉(전 멤버 표면, bag 통째 노출 금지).
- PATCH는 최상위 키 RFC 7396 동형 병합. allowlist는 `allowed_agent_models`(문자열 배열, 원소 32·64B 상한)와 `role_labels`(#1770).
- 요청 본문 8KiB 초과는 413, 그 외 형태/미지 키는 400. audit `workspace_setting.updated`.
- PG 컨포먼스 `workspace_settings_conformance_pg` 가 권한·RLS·병합·상한·identity 비노출을 잰다.

## 패스워드 초기화 경로 (#1767, 2026-08-27)

- `owner_claim`을 `credential_claim` + `kind`(`owner_bootstrap` | `password_reset`)로 일반화(081). token_hash 32B · TTL 24h · 단일 사용 · definer lookup 관례는 078 승계. `schema_v0.sql` 비접촉.
- 운영자 발급: `POST …/members/{id}/password-reset` (owner/admin). 재발급은 이전 미소비 reset 을 `consumed_at`으로 무효화. 원문은 201 1회. 메일 없음 — out-of-band 전달.
- ADR-0128 D2 위계(#1798 수리): `issue_password_reset_in_tx`가 같은 테넌트 트랜잭션에서 행위자·대상 role을 조회한다. owner는 타인(다른 owner 포함)만, admin은 member/guest만. 자기 자신은 403 — 본인 변경은 `PATCH …/members/me/password`.
- 본인 변경: `PATCH …/members/me/password` — 현재 비번 재확인 · 멤버/IP 레이트리밋. 세션 회전: 해당 멤버의 모든 `kind=session` 토큰을 만료하고 새 쌍을 발급(agent bearer 비접촉).
- `POST /v1/claim`이 두 kind를 소비. owner_bootstrap 회귀는 기존 경로 그대로.
- 웹 ClaimPage kind 문구 분기는 후속 UXUI. 발급 응답 `claimPath=/claim/<token>`.

## 역할 표시명 커스텀 UI (#1770 uxui, 2026-08-27)

- GET `/v1/workspaces/{ws}` 의 `roleLabels`를 identity 쿼리에 실어 `roleLabel()`·`inviteRoles()`가 오버라이드 우선, 없으면 기존 한국어 기본 라벨을 쓴다. 에이전트 행은 계속 null. 권한 wire 값은 비접촉.
- 설정 > 워크스페이스에 4역할 표시명 편집. 빈 칸 저장=해당 키 생략(기본 복원), 저장 payload는 4키 전량 재구성. 48바이트·공백만은 클라 선검증. owner/admin만 편집, member/guest는 읽기 전용(403 의존 없음).
- 이름만 바뀌고 권한은 그대로임을 설정 화면이 고지. capture `settings-workspace`가 새 블록을 기다린다.
- R2: 저장 403은 `save.isError && isOperatorDenied` 파생. 멤버 뷰는 KeyValueRows `prose` + capture `settings-workspace-member`.

## 초대 revoke/regenerate/redeem REST 이식 (#1769, 2026-08-27)

- Swift `InviteRoutes` 3경로를 Rust로 포팅: `POST …/revoke`(동일 핸들러 `DELETE …/invites/{id}`), `POST …/regenerate`, `POST …/redeem`. 운영자 상태 조회는 `GET …/invites/{id}`(usedCount + redemption 행).
- 기존 `003_onboarding.sql` 재사용. revoke는 잔여 사용이 있는 미취소 코드만 새로 찍고, 소진된 코드는 409. regenerate는 구 코드를 즉시 `regenerated`로 무효화. 권한은 `is_admin()` 단일 권위.
- 새 마이그레이션 없음. `runtime-unverified` 아님 — PG 컨포먼스가 거부/정상 경로를 실측.

## 셀프호스트 첫 기동 갭 2건 (#1747, 2026-08-26)

- `MOMO_HOSTED_DELIVERY_ENABLED`를 api·webhook-sender compose env에 옵트인 배선(`:-`). 도어벨만 켜고 이 선행 게이트가 빠지면 멘션이 hosted inbox로 안 가 조용히 실패한다. 미사용 스택에는 필수가 아니다.
- ADR-0169 local 보관소 첫 기동: `local.override.yml` `drive-init`이 신선 볼륨을 uid 10001로 chown. 쓰기 실패 fail-fast는 유지.

## 로컬 첨부 capability URL same-origin 파생 (#1788, 2026-08-26)

- `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=same-origin`이면 업로드 URL을 ADR-0167과 같은 `Host`+`X-Forwarded-Proto`(Caddy 정규화)에서 파생한다. 절대 URL은 verbatim. `MOMO_DRIVE_ARCHIVE_BACKEND` 선택 축은 무영향.
- 생성기 기본값을 `same-origin`으로 옮김. `--public-origin`은 절대 URL 고정(기존 verbatim 경로).

## claim 모드 env 유지보수 경로 (#1790, 2026-08-26)

- `MOMO_BOOTSTRAP_CLAIM=1` 이고 비밀번호 키가 없으면 `--public-origin` 유지보수가 비밀번호 검증을 건너뛰고 `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL`·`CENTRIFUGO_ALLOWED_ORIGINS`를 갱신한다. `--compose`는 ADR-0166대로 비밀번호 키를 계속 요구한다.
- 비밀번호가 있는 env의 12–128자 dotenv-safe 검증은 그대로다. `docs/SELF_HOST_AGENT.md` §1.4↔§2.3 문면 정합.

## 소유자 관전 차단 토글 (#1778, 2026-08-26)

- 인간 세션 소유자의 `PATCH …/work-sessions/{session}` `{observation: open|owner_only}`를 Swift `updateObservation` 문장 그대로 서빙한다. 비소유자 403, 호스트 서명 403(인간 경로 — #1777 팔 비접촉). `owner_only`는 같은 트랜잭션에서 observer capability를 회수한다.
- ADR-0004 증보 3 D3 원문 정합: 비관측의 주어는 에이전트, 인간 observer는 기존 `open|owner_only` 모델 그대로. 웹 와이어 `{ observation }` 유지(신규 필드명 없음).
- 감사 행 `work.session.observation` / `momo.work.session.observation.v1`. 하네스 `verify_workd_rust.sh`가 실 세션에서 차단→attach 403→재개방→attach 200을 잰다.

## host-signed 세션 변이 이식 (#1777, 2026-08-26)

- Rust가 데몬이 이미 보내던 host-signed create(`controlId` ↔ dispatched spawn)·idle/running·`bindRemotePTY`를 Swift 문장 그대로 서빙한다. 인간 경로의 무서명 pty/controlId 400은 유지. ACP 이벤트는 #1785에서 닫힘. observation은 #1778에서 인간-소유자 경로로 닫힘.
- 데몬 부팅용으로 `GET …/work-tool-profiles`(enabled 투영, CRUD 없음)를 같이 열었다. 없으면 `momo-workd`가 heartbeat 직후 `transport_failed`로 죽어 create에 도달하지 못한다.
- 세션 생산 레시피: `scripts/verify_workd_rust.sh` + `docs/runbooks/workd-rust-session.md` (맥 로컬 workd ↔ Rust 리그). `remote_attach_available` false→true가 도크 생산자를 연다.

## LiveKit env 게이트 오탐 수리 (#1781, 2026-08-26)

- 판정(실측): 오탐. huddle profile 없이 `docker compose --env-file rust-smoke.env.example -f docker-compose.rust.yml config`는 LiveKit 키 공백·삭제 모두 rc=0. 렌더된 서비스에 livekit 없음. 맨몸 `config` 실패 목록에도 `MOMO_LIVEKIT_*` 0건.
- 원인: `check_compose_env_templates.sh`가 entrypoint의 `$${VAR:?}`(compose 이스케이프 → 컨테이너 셸 `:?`)를 compose 보간 `${VAR:?}`로 오인. 템플릿 `KEY=` 빈 값 규칙은 진짜 `${VAR:?}`에는 유지.
- 검증: 수리 전 정적 RED 8 rendering(이슈가 적은 4 + local-edge/backup 4) → 수리 후 compose-env GREEN + regression 12/12. huddle 없는 `up -d`(LiveKit 키 삭제, `-p momo-1781-judge`) api healthy · `/healthz` ok · livekit 컨테이너 0. `--profile huddle` + 키 없음이면 컨테이너가 `set MOMO_LIVEKIT_API_KEY`로 fail-fast.

## #850-잔여 허들 active 응답 드리프트 (2026-08-26)

- `fetchActiveHuddle`이 openapi 생략형(`{}`)과 구형 `huddle: null`을 모두 유휴로 읽는다. 픽스처를 실서버 모양으로 잠금. 리그 실기동은 `runtime-unverified`.

## TC-1 채널 하단 터미널 도크 (#1758, 2026-08-26)

- 조사: 작업 세션 원장(`GET …/work-sessions`)·이벤트 스레드·observer-grade 호스트 터미널 소켓은 실존. 웹은 `mode: "observer"`만 요청하고 stdin/resize/kill 인코더가 없다. 우측 WorkPanel은 목록·인수·화면 관전/조작·원장. 헤더 SquareTerminal은 이 티켓 전까지 그 패널을 열었다. 즉시 입력 왕복 터미널은 웹에 없다. 새 세션 POST도 웹 클라에 없다.
- 헤더 터미널 → 하단 도크(탭·관전 터미널·높이 토글·닫기). 관찰 전용, 입력창 없음, + 없음. WorkPanel은 세션 카드/`?work=`/`/work`가 연다(공존·XOR). 원격 조작은 TC-2 적립.
- 4상태(빈/로딩/오류/연결 끊김)·Esc·탭 ←/→·확대·닫기 포커스 복귀. 도크는 컴포저 형제(덮지 않음). ObserverTerminal `variant="dock"` 재사용.
- #1766 design-review 수리: 도크 높이를 `terminal-dock` / `terminal-dock-lg`(뷰포트 상한 + flex 양보)로 두고 타임라인에 `timeline-strip` 바닥을 줌. 어느 지원 크기에서도 컴포저(입력+보내기)는 뷰포트 안. 자는 720·800·844에서 `컴포저 ⊂ 뷰포트` + 타임라인 띠를 잰다.
- #1766 R3: 접힘은 크롬 상수(200)가 아니라 터미널 상자 실높이 < `terminal-floor`(56) 실측. 폭 무관. 확대 disabled·컴포저 불변식·양보 순서는 R2 그대로.
- 검증: 웹 tsc · vitest · 디자인 프리플라이트 · `capture:design`(실클릭) · 게이트 7종. 자체 design-review 안 함.

## UX-D4 사이드바 개편 (#1756, 2026-08-26)

- 하단 프로필 카드: 아바타+이름+유효 상태 배지가 트리거. 카드에 ADR-0160 선언 상태(auto/away/dnd = 온라인/자리 비움/방해 금지) 라디오, 레일과 같은 `워크스페이스 추가`, 설정. 서브메뉴 없음(#1383).
- 상태 PUT은 `PUT /v1/workspaces/{ws}/presence` 단일 쓰기경로(서버 `routes/presence.rs` · `momo-messaging/presence.rs`). Offline은 유효값이지 선언값이 아니라 픽커에 없음.
- 탐색 패널 접기를 채널 패널 상단 아이콘 토글로 이동. 접힘 복원·레일 열기는 기존 셸 상태. 접힘 전환은 즉시 폭 변경(가로 스크롤 장식 없음).
- 채널/DM 섹션: 상시 + 제거, hover·`:focus-visible`·터치에만 액션 마운트(opacity 트릭 금지). chevron 접기는 상시 탭 스톱. 채널 행 호버 ⋯는 사이드바에 실존 액션이 없어 적립(뮤트/나가기는 채널 헤더 메뉴).
- 캡처가 카드 열기·상태 PUT·섹션 접기·패널 접기를 실제로 누른다. 폰 서랍에서 카드 Esc 는 메뉴를 닫고 서랍은 남긴다(`escapeLayer` 가 `role="menu"` 를 다이얼로그와 같이 면제). 자체 design-review 안 함.

## UX-D3 메시지 ⋯ 더보기 메뉴 보강 (#1755, 2026-08-26)

- 선행 판정: 메시지 복사 실존(원문 클립보드). 링크 복사 실존(`#/c/{ch}?msg=&seq=` → ChatShell 착지). 읽지 않음 표시는 PUT read-state가 `GREATEST` 단조라 커서 후진 불가. Remind me later·Report는 표면 없음.
- 실존 항목만 추가: ⋯/우클릭/시트 동형. 「복사」→코어 `copyMessageActionLabel`(「메시지 복사하기」), 「링크 복사하기」를 copy 뒤에. 기존 13/11/0 차등은 14/12/0(저자만 고치기/지우기, 묘비 0). lucide `Copy`·`Link`.
- 공유 링크 origin은 `absoluteApiBase()`(남에게 건넬 절대 origin). 웹 배포는 자기 origin과 동일. Tauri는 연결 시 서버 base가 필수(`requiresServerUrl`)이거나 빌드에 `API_BASE_DEFAULT`가 구워져 있으므로, MessageRow가 그려지는 순간 `absoluteApiBase()`가 건넬 수 없는 런타임은 코드상 존재하지 않음 — 액션 숨김 갈래 없음.
- 적립: 읽지 않음 표시(서버 커서 후진 API), Remind me later, Report message. **폰 「링크 복사」는 미구현**(표면 정본 절차 별도 — origin은 코어 `host.absoluteApiBase`가 이미 있음).
- 캡처 3표면: `b11-message-action-menu` · `b11-message-context-menu` · `mobile-b11-action-sheet`. 클립보드 항목은 실제로 눌러 내용을 읽고, 복사된 URL을 새 페이지에서 열어 착지한다. URL 모양 사본(`messageShareUrlForCapture`)은 없음.
- #1764 R2: 콜드 붙여넣기 착지 — `urlAnchor`가 소속 `channelId`를 함께 든다. 채널 효과는 방이 바뀌었을 때만 소거한다(#1195가 읽기는 시작했으나 같은 커밋에서 자기 채널 앵커를 지워 새 탭 붙여넣기가 채널만 열리던 자리). 캡처 착지 자는 초기 뷰포트 밖 행+하이라이트와 없는 msg의 older/unknown 배너를 잰다. 바닥 행은 점프 없이도 보여 자로 쓰지 않는다.
- §2.8 아이콘 1개(`Link`) 추가. design-mode dist JS gzip 합계 725,020 B (index 452,999 · huddleRuntime 137,855 · terminalRuntime 83,921 · emojiCatalog 48,577). 미사용 글리프 `aperture`·`bluetooth`는 dist JS에서 0회.
- 검증: 웹 `tsc -b` · Vitest · 디자인 프리플라이트 web 12/12 + core 5/5 · `capture:design`. 자체 design-review 안 함(오케스트레이터). 데스크톱 실기 클립보드 실측은 성재 QA.

## UX-D1 웹 Lucide 아이콘 체계 고정 (#1754, 2026-08-25)

- base `0e202e5e` 실측에서 `lucide-react@0.454.0`(ISC)은 이미 package/lock에 고정돼 있었고, 58개 파일·76개 글리프·정적 배치 165곳이 Lucide를 사용했다. 기능 표면 raw `<svg>`는 0건이었다. 따라서 신규 교체는 0건이며 의존성 바이트도 바꾸지 않았다.
- 로컬 SVG 존치는 oort 브랜드 3파일(`OortMark.tsx`·`oort-mark.svg`·`favicon.svg`)뿐이다. 각 파일에 ADR-0172 예외 사유를 붙이고 `iconSystem.test.ts`가 raw SVG 전수·정적 named import·ISC lock을 fail-closed한다. 디자인 시스템 §2.8에 16/20px·기본 획 2·`currentColor`·접근성·예외 목록·tree-shaking 실측 규칙을 정본화했다.
- 검증: 웹 `tsc -b` · Vitest 1,535/1,535 · 디자인 프리플라이트 web 12/12 + core 5/5 · npm license 533 packages PASS(`lucide-react` ISC prod). 프로덕션 메인 JS gzip은 전/후 455.88 kB, 전체 JS 청크 합계는 전/후 729.44 kB로 동일했다. `runtime-unverified(capture:design·독립 design-review)`: 계약에 따라 오케스트레이터가 대행한다.

## UX-D2 스레드 표면 수리 (#1753, 2026-08-25)

- 스레드 루트/답글 구분선을 32px 여백으로 바꾸고, 답글이 없을 때만 점선 빈 상태 상자가 영역을 말하게 했다.
- 호버 툴바의 상단 충돌 기준을 Virtuoso 전용 선택자에서 가장 가까운 세로 overflow 경계로 일반화했다. 스레드 자체 스크롤러 표식과 루트 hover 캡처 자(패널 안쪽·글자 교차 0)를 추가했다.
- ⌘K 입력 자체의 보더·포커스링을 없애고 머리 그릇의 구분선·`focus-within` 링으로 옮겼다. 웹 tsc · Vitest 1,530/1,530 · 디자인 프리플라이트 web 12/12+core 5/5 green. `runtime-unverified(capture:design·독립 design-review)`: 계약에 따라 오케스트레이터가 대행한다.

## 웹 컴포저 buzz형 2행 그릇 (#1749, 2026-08-25)

- #1751 design-review 수리: `@` 버튼은 줄 시작·공백 뒤에는 `@`, 비공백 뒤에는 ` @`를 넣고 선택은 끝으로 접어 보존한다. 문장 끝·한글/영문·문장부호·연타 red proof가 기존 `mentionQueryAt`을 그대로 열며, 클릭은 ADR-0149 작성 중 신호를 내보내지 않는다.
- textarea의 UA outline까지 명시적으로 끄고 `focus-within` 그릇만 포커스 표시를 맡긴다. 버튼 아닌 그릇 면적은 입력 캐럿을 돌려주며, 스레드는 sending이면 그릇 전체를 흐리고 빈 초안이면 전송 버튼만 50%로 낮춘다. ↵ 힌트·작성 중 교대 슬롯은 액션 행 가운데로 옮겨 별도 26px 예약 띠와 레이아웃 시프트를 함께 없앴다.
- 캡처 자는 입력 outline 부재를 `outlineStyle=none`으로 재며, typing 게이트는 0높이 빈 슬롯의 부착·무텍스트·flex 폭을 확인한 뒤 `[fit]`·`[cut]`·`[a11y]`·`[slot]`까지 진행한다. `runtime-unverified(capture:design·gate-typing)`: 이 샌드박스에서는 실행하지 않고 오케스트레이터가 대행한다. 폰 TypingBar 동형 후속은 #1752다.

## 메시지 호버 퀵액션 툴바 (#1743, 2026-08-25)

- 행 hover/focus-within 에만 우상단 툴바를 마운트한다: 빈도 슬롯 3(시드 👍✅🙏, UX-EB `frequencyStore` 공유) · React · 답글 · ⋯. 비호버 행은 DOM 0(opacity 트릭 금지). 툴바 항목은 행 로빙 그룹에 편입. 터치는 비렌더, 시트 불변.
- #1750 design-review 수리: frequency 랭킹 안정 캐시(B-1) · 행 rest 정거장+키보드 `:focus-visible`만 ⋯ 핸드오프(B-2/B-4/H-1) · 상단 straddle, 스크롤러 상단이면 하단 미러(B-3/H-4) · 슬롯은 마운트가 유지되는 동안 고정(H-2, 포커스가 마운트를 유지할 수 있다) · `border-line-strong`(H-3) · `right-4`(M-3).
- B11 주석·스킬 §6·디자인 시스템 §6을 조건부 렌더+toolbar+겹침 금지 계약으로 개정. 적립(미구현): 메시지 포커스+단일 키 R/E/T, 슬롯 커스터마이즈.
- 검증: 웹 `tsc -b` · vitest · `capture:design` · `design_preflight_web.sh`. `runtime-unverified`(실서버 리액션 왕복은 기존 경로).

## 이모지 피커 고도화 (#1742, 2026-08-24)

- 자작 피커: emojibase compact(en)+iamcal 빌드타임 추출(same-origin, 외부 fetch 0). 검색·카테고리 탭·빈도 store(frequency, recency 금지, UX-HT 공유)·스킨톤 persist·프리뷰 푸터. 포인터=anchored popover, 터치(`hover: none`)=바텀시트. #1688 32종·중앙 Dialog 주석 supersede, 무라이브러리 유지.
- #1746 design-review 수리: 검색 hover가 키보드 커서를 가로채지 않음, 활성 `bg-accent-soft`, 그리드 96칸 상한+콜론은 탭 유지, 스킨 Esc는 Radix `onEscapeKeyDown`, 반응 피커 앵커=실제 트리거, 터치 시트 검색 autofocus 없음.
- 검증: 웹 tsc/lint/unit · design_preflight · capture:design(피커 열림). `runtime-unverified`(실서버 반응 왕복은 기존 경로, 이번 티켓 비스코프).

## Agent Hub 커넥션 도어벨 등록 UI (#1735, ADR-0171, 2026-08-24)

- 연결 탭에 도어벨 섹션: URL+sender key 등록(write-only·마스킹), 해제 확인, last-fired 상대시각·lastStatus. 빈/로딩/성공/실패 + 게이트 닫힘(빈 404)을 등록 실패와 구분. 시험 발화 버튼은 WD-1 엔드포인트 부재로 적립.
- 검증: `@momo/core` 1,706 tests · web 1,446 tests · tsc/lint · `design_preflight_web.sh` 12/12+core 5/5 · `capture:design` exit 0 (hosted-doorbell-{empty,loading,registered,error,gate-off}-{light,dark}.png). `runtime-unverified`(실서버 PUT/DELETE 왕복).

## 언퍼얼 클라이언트 후속 고정 (#1720 항목 1·3·4 + U-8 Nit, 2026-08-24)

- rowFocus의 구성원 0/有 정규화·focused 보존과 MutationObserver 재정규화, 행 안/밖 focusout 복원을 jsdom 12개 유닛으로 고정했다.
- 언퍼얼 data URL 캐시는 48개와 32 MiB 병행 LRU 예산을 쓰며, 캡처 픽스처는 1200×630 실제 OG 비율·자연 크기 단언으로 교체했다. 폰 TypingBar의 웹 헤딩 인용도 현행화했다.
- 웹 1,429 tests·폰 1,301 tests·양쪽 tsc/lint와 전체 `capture:design`(light/dark·desktop/mobile, exit 0)이 green이다. #1720의 서버 읽기 fan-out 배치(2항)는 비스코프로 남아 이슈를 열어 둔다.
## HD-1 Rust 허들 서버 복원 (#1757, ADR-0122, 2026-08-25)

- Swift 정본의 start/join/leave/active 4 REST를 Rust/Axum으로 이식했다. `momo-messaging` 한 tenant tx가 기존 016/046 테이블의 lifecycle·audit·broadcast outbox를 함께 쓰며 단일 활성·재입장 이력·RLS FORCE를 보존한다. `schema_v0.sql`·마이그레이션 변경은 없다.
- LiveKit HS256 video grant는 600초이며 세 env가 완비되지 않으면 네 route가 503 `허들 미구성`으로 닫힌다. `infra/rust`에는 pinned `livekit:v1.13.3` huddle profile·healthcheck·UDP 50000~50100 제한을 배선했고, 두 허들 verifier는 Rust 경로로 현행화했다. 기존 OpenAPI와 web-legacy 생성 타입의 4-route wire는 그대로 유효하다.
- 로컬 `cargo fmt --all --check`·workspace all-target clippy `-D warnings`·비-PG `cargo test --workspace` 1,198/1,198 PASS. PG18 conformance(503·grant·concurrent single-active·re-entry·outbox/audit·RLS)와 실제 LiveKit `/rtc/validate`는 작성했지만 이 worker sandbox에서는 `runtime-unverified`; momo-main 오케스트레이터 실행 대기다. UXUI 후속은 `ENGINE_HANDOFF.md` A-33 `ready`.

## 그록봇 도어벨 플레이북 (#1736, ADR-0171, 2026-08-24)

- `docs/SELF_HOST_AGENT.md` §4: webhook 루틴 생성 문안(실측 문안 승계), WD-1 REST 등록·마스킹·해제 curl, 프로덕션/15분 스윕 지시문(ADR-0132 발화 규약), usage·베타·Q-STRUCT 고지. UI 등록은 #1735 후속.
- 검증: `scripts/check_docs_commands.py` 493 facts · `scripts/tests/test_docs_commands_gate.sh` 26 cases. `runtime-unverified`(그록봇 루틴 E2E·멘션→도어벨→응답) — 성재 자연어 릴레이.

## hosted 커넥션 도어벨 서버 (#1734, ADR-0171, 2026-08-24)

- 마이그레이션 080 `hosted_agent_doorbell`(AEAD 봉인 시크릿·RLS FORCE). `schema_v0.sql` 불변. **outbox 생산자 트리거 0.**
- tenant REST `PUT/DELETE …/hosted-agent-connections/{id}/doorbell`. 시크릿은 마스킹만. URL은 OutboundHTTPPolicy(https·사설망 거부). 등록/해제 audit 각 1행. disconnect/reconcile 같은 tx에서 소거.
- `momo-webhook-sender` 가 hosted inbox append 파생을 폴링해 커넥션당 leading-edge + 60s trailing 코얼레싱. 상수 페이로드 `{"kind":"oort.doorbell.v1"}` + `Authorization: Bearer`. 타임아웃 10s, retry ≤2.
- 게이트 `MOMO_DOORBELL_ENABLED` 소문자 `true`만 개방, 기본 off. off면 라우트 빈 404 + drain 무동작.
- 검증: `cargo fmt --all --check` · clippy `-D warnings` · `momo-webhook` 28/28 · `momo-webhook-sender --lib` 8/8 · `momo-server --lib` doorbell gate 1/1. ignored PG `doorbell_admin_conformance_pg` 4/4 · `doorbell_dispatch_conformance_pg` 4/4 (`DATABASE_URL` 이 워크트리 `make up` PG:23202). openapi 동기화 + web-legacy 생성 타입. migration-numbers 80. `check_docs_commands.py` 493.

## 첨부 실측 크기 (#1716, 2026-08-24)

- complete가 아카이브 실수신 바이트를 `attachment.size_bytes` 정본으로 기록·응답한다. 선언 `size: 0`은 미지(create 201 유지, PUT mismatch 철회, 대조 생략). 100MB 상한은 실측 강제(선언 축소 우회 413 red proof). 클라 변경 0.
- 선행 실측: 고치기 전 stub/local은 create `size: 0`을 받고 nonempty PUT을 session mismatch(400)로 죽여 complete에 도달하지 않았다. Google은 `X-Upload-Content-Length: 0`이라 세션이 0바이트로 캡됐을 것. 스키마 불변(기존 `size_bytes`).
- 검증: `cargo fmt --all --check` · clippy `-D warnings` · `cargo test --workspace` green. `momo-drive` 30/30(0-선언 실측·선언 축소 상한 red proof). `momo-server --lib` 287/287. `attachment_conformance_pg` ignored 12/12(0-선언 실측·local 실측·상한 413·알려진 선언 mismatch 409, 이 워크트리 `make up` PG:21852). openapi yaml parse · `check_docs_commands.py` 493 · migration-numbers 79.

## 링크 언퍼얼 서버 표면 (#1698, ADR-0170, 2026-08-23) — 1/2

- 마이그레이션 079 `message_unfurl` 계열(job·cache·tombstone·workspace on/off) + RLS FORCE. `schema_v0.sql` 불변. 워커는 `momo-webhook-sender` 프로세스의 옵트인 드레인(`MOMO_UNFURL_ENABLED` 기본 0). URL≤3 추출(코드블록·이메일 제외) → OG/Twitter 파싱 → upsert → `message.unfurl` broadcast. `message.seq` 불변.
- egress = 기존 OutboundHTTPPolicy(사설망/링크로컬/루프백, redirect≤3 매홉 재검사, HTML 512KB·이미지 5MB). 이미지 프록시 라우트. 워크스페이스 설정 REST + 메시지 단위 제거 REST(tombstone, 재생성 안 함). 클라 변경 0.
- P9: 서버는 링크 대상만 읽는다 — SELF_HOST 1절 + crate 주석. 발신자 구분 없음.
- 검증: `cargo test --workspace` green · `momo-unfurl` 단위 16/16(SSRF red proof 사설망 3계열+redirect 상한) · PG ignored 7/7 (`DATABASE_URL` 이 워크트리 `make up` PG:27682 — 메시지→레코드→outbox, off fetch 0, TTL 캐시, mock HTTP, 제거 REST). `cargo fmt --all --check` · clippy `-D warnings` (momo-unfurl/momo-server/momo-webhook-sender). docs: migration-numbers 79 · check_docs_commands 493 · compose-env 11. Docker 이미지 빌드(openapi-rust gate)는 성공; 그 게이트의 login 표본은 claim fixture 실패로 이 티켓과 무관하게 빨개졌다.

## 셀프호스트 로컬 파일 보관소 (#1696, ADR-0169, 2026-08-23)

- `momo-drive`에 `LocalDriveArchive`(`MOMO_DRIVE_ARCHIVE_BACKEND=local` + `MOMO_DRIVE_LOCAL_DIR`). DriveArchive 계약·100MB 상한·in-process PUT(`/__momo_stub/drive/uploads/{token}`)·DriveError 표 재사용. 저장 키는 불투명 id만(파일명은 메타). `../`·절대경로·심링크 이탈 거부. deployed env 허용. 디렉터리 미존재=생성, 쓰기불가=부팅 거부.
- 생성기 기본값 local+`oort-drive` 볼륨. `local.override.yml` 마운트, `Caddyfile.local`이 `/__momo_stub/*`를 api로 프록시. 기존 env는 키 없을 때만 가산. google/stub 비접촉. schema 비접촉. 클라 변경 0.
- 문서: SELF_HOST.md 보관소 절, SELF_HOST_AGENT.md 동기, pg_dump 런북 동반 백업 1줄.
- 검증: crate 단위 25/25(이탈 3계열·왕복·413) · `momo-server --lib` 287/287 · attachment_conformance_pg ignored 8/8(local 왕복 + 미구성 503, 이 워크트리 `make up` PG:22602) · `test_self_host_env_modes.sh` PASS · `check_docs_commands.py` 493 facts. google.rs/stub.rs 비접촉.

## 웹 링크 언퍼얼 렌더·온오프 표면 (#1718, 2026-08-24)

- 공유 코어에 언퍼얼 4상태와 REST↔실시간 병합 규칙을 두고, 웹 타임라인에 서버 프록시 이미지만 쓰는 카드와 발신자 전용 제거 확인(재생성 없음)을 연결했다. failed·blocked·empty와 서버 off는 자리표시자 없이 조용한 부재다.
- 개인 설정의 「링크 미리보기 접기」는 이 기기의 렌더만 지속화하고, 워크스페이스 설정은 오너/관리자가 서버 fetch를 켜고 끄는 별도 표면으로 분리했다. 폰 렌더 후속은 `docs/planning/ENGINE_HANDOFF.md` A-30으로 넘겼다.
- 코어·웹 전체 스위트, tsc, lint, build, 디자인 프리플라이트는 green. `runtime-unverified(real server/outbox round-trip and browser visual)`: #1717 실서버 왕복은 오케스트레이터 몫이고, 로컬 캡처 레인은 카드 앵커의 탭 예산 이탈에서 실측 red였고(리뷰 Blocker-1), 로빙 합류 수리 후 완주 green이 이 문장의 근거다.

## 폰 첨부 트레이 M-2 후속 폴리시 (#1703, 2026-08-23)

- 첨부 행은 모든 상태에서 진행 트랙 높이를 예약하고 첫 native 측정 전에는 값 없는 막대로 표시한다. 발치 경고색은 웹과 같은 `sendBlockReason`을 따르며, 크기 미독 파일은 `0 B`를 말하지 않는다.
- 로그아웃·계정 identity 변경·토큰 만료 provider 해제는 모든 첨부 드래프트와 native PUT을 비우고 세션 세대를 올려 구 bearer로 시작한 늦은 업로드 응답을 폐기한다. picker의 도달 불가 `rejected`는 일부 무음 수락 대신 단정 실패하며, grabber·트레이 상한은 전용 명명 측정을 쓴다.
- 모바일·공유 코어 전체 테스트와 tsc는 green이다. `runtime-unverified(iOS simulator visual interaction)`: 실기·시뮬레이터 검증은 패킷의 명시 비스코프이며, 폰에는 독립 디자인 프리플라이트 실행 단위가 없다.

## U-8 웹 컴포저 하단 메타 1행 통합 (#1699, 2026-08-23)

- 넓은 화면의 전송 키 힌트와 상시 예약 타이핑 라인이 하나의 26px 행을 공유한다. 기본에는 힌트, 사람이 작성 중이면 같은 자리에 타이핑 문장이 서며, 힌트가 없거나 폰인 기본판은 기존 빈 글자 상자가 높이를 예약한다. AgentActivityBar 인접성과 비-live 낭독 계약은 유지했다.
- 상태 전이·폰 예약판·정본 토큰 계산(18px line-height + 8px padding = 26px)을 신규 Vitest로 고정했고 웹 전체 1,412 tests·tsc·lint·디자인 프리플라이트가 PASS했다. `runtime-unverified(browser typing gate/screenshots)`: Chromium Mach-port와 Chrome remote-debugging 허용 대기 때문에 브라우저 evidence는 오케스트레이터 범위다.

## 셀프호스트 실시간 WS URL same-origin 파생 (#1678, 2026-08-23)

- `MOMO_CENTRIFUGO_WS_URL=same-origin` 센티널: 로그인/join/claim이 요청 `Host`+`X-Forwarded-Proto`에서 `wss://<공개호스트>/connection/websocket`을 파생한다(ADR-0167). 절대 ws/wss는 부팅 시 verbatim(ADR-0110 프로덕션 분리 도메인 불변).
- 생성기 기본값을 `same-origin`으로 교체. `--public-origin https://host`가 `CENTRIFUGO_ALLOWED_ORIGINS`에 브라우저 Origin과 RN `wss://` Origin을 멱등 추가. 기존 localhost/tauri 기본값 완화 없음.
- 플레이북: `SELF_HOST_AGENT.md` §2.3·`SELF_HOST.md` 터널 절. 로그인 응답 `realtimeWebSocketUrl == wss://<공개호스트>/connection/websocket`이 검증 문장. `runtime-unverified(터널 e2e 브라우저 왕복)` — 오케스트레이터 몫.

## 폰 사진·파일 picker 전송 (#1700, 2026-08-23)

- 모바일 Composer의 2행 첨부 시트가 `expo-image-picker`·`expo-document-picker`로 사진/파일 한 건을 고르고, 코어 첨부 상태기계·실패 문장을 재사용한 인라인 트레이에서 capability PUT→완료 확인→기존 메시지 `attachmentIds` 발송까지 잇는다. 일반 대화와 스레드가 같은 경로를 쓴다.
- PHPicker 사진 선택만 지원하고 카메라 촬영·사진 보관함 쓰기는 지원하지 않아 `NSCameraUsageDescription`·`NSPhotoLibraryAddUsageDescription`를 추가하지 않았다. CocoaPods autolinking은 `ExpoImagePicker`·`ExpoDocumentPicker`를 lockfile에 고정했고 pbxproj·entitlement·서명은 비접촉이다.
- `runtime-unverified(iOS simulator picker interaction)`: 시뮬레이터 실행 검증은 오케스트레이터 범위다. 폰에는 독립 디자인 프리플라이트 실행 단위가 없고 관련 기계 검사는 mobile Jest 스위트 안에서 돈다.

## OmD v2 Core v2 mirror + book (#1689, 2026-08-23)

- project-local Claude Code 채널에 OmD v2 전체 bundle(22 skills · 19 agents · 440 references)을 설치하고 `omd doctor` ready를 닫았다. 스코프 판정(#1693)으로 bundle·`.omd/` 생성물은 레포에 버전관리하지 않고(`.gitignore`) mirror 문서(`DESIGN.md`·`docs/design-system/OMD.md`)만 랜딩했다. 기존 `momo-design-taste*`·`design-review`는 프로젝트 전용 정본/리뷰 경로로 보존하고 OmD 범용 reviewer는 보조로만 성문화했다.
- 오르트 구름 정본 `docs/design-system/README.md`를 루트 `DESIGN.md` Portable Core v2로 사상했다. `.omd/system`은 `source-design-md`·`non-authoritative` migration candidate이며 원문 10 segment `dropped=0`, source reconstruction·projection round-trip true다. `tokens.css`·폰 `tokens.ts` 변경은 0.
- `omd book`이 59 tokens · 5 components · 20/20 contrast pairs · 9 decisions를 읽고 `http://localhost:6060`에서 기동했다. `runtime-unverified(browser visual inspection)`: 작업 계약에 따라 브라우저 게이트는 오케스트레이터가 수행한다.

## 웹 단축키 도움말 (#1687, 2026-08-23)

- 사이드바 도움말 버튼과 전역 `?`가 카테고리별 단축키 Dialog를 열며, 검색·인박스·안 읽은 채널·기본 동작·메시지 행 등록처가 표시 목록과 같은 타입드 정의를 소비해 드리프트를 막는다.
- input·textarea·contenteditable 입력 중에는 발동하지 않고, 프로그램형 opener를 Dialog에 넘겨 Esc 뒤 포커스를 돌려준다. `runtime-unverified(browser interaction gate)`: 브라우저 게이트는 오케스트레이터 실행 범위다.
## C-1 메시지 멘션 하이라이트 (#1685, 2026-08-23)

- 코어 markdown `Inline`에 원문 바이트와 case-folded handle을 보존하는 mention 노드를 추가하고, 기존 라우팅과 공유하는 경계/handle 문법으로 코드·이메일·미완성 `@`를 평문에 남겼다. safeHref와 기존 노드 의미론은 불변이다.
- 웹·폰 타임라인은 활성 directory 멤버만 accent로 그리고 내 멘션에는 accent-soft/accentSurface를 더한다. 코어·웹·폰 전체 스위트와 양 palette 단정, 웹 디자인 preflight는 green. `runtime-unverified(browser/device visual gate)`: 오케스트레이터 실행 범위로 위임했다.

## iOS 첨부 렌더·다운로드 + 멤버 프로필 (#1681, 2026-08-23)

- 모바일 타임라인이 `Message.attachments` 전부를 3상태 고정 프레임/안전한 SVG 파일 카드로 렌더하고, 기존 ExpoFileSystem으로 인가 프록시를 캐시에 스트리밍한 뒤 iOS 공유시트를 연다. 실패·재시도·진행률과 인용 원본 첨부 수 표식을 포함해 조용한 유실을 회귀 단정했다.
- 아바타·작성자명에서 사람/에이전트 프로필 시트를 열어 이름·핸들·kind·4개 멤버십 상태·DM 가능 여부를 보여 주며, 에이전트는 기존 상세 표면으로 잇는다. 설정·관리 표면과 사진 picker는 추가하지 않았다.
## U-1 웹 메시지 표면 완결 (#1679, 2026-08-23)

- 기존 `MessageActions` 인벤토리를 ⋯·우클릭·길게 누르기가 함께 쓰고, 세 경로의 메시지 복사는 렌더 결과가 아닌 원문 Markdown을 `복사됨` 자리 피드백으로 건넨다. 선택 영역 우클릭은 브라우저 기본 메뉴에 양보한다.
- 사람·에이전트 공용 멤버 프로필을 메시지 아바타(행 로빙 그룹)·디렉터리 행·DM 헤더에 연결했다. 상태/역할/관리자·DM 진입과 에이전트 라우팅 보조 액션, empty/loading/error/offline 및 Esc 포커스 복귀를 한 다이얼로그가 맡는다.
- 타입·단위·빌드는 green. `runtime-unverified(browser interaction gate)`: 이 샌드박스가 Chromium Mach port 등록을 거절해 작성한 세 표면/선택/Esc 실브라우저 게이트를 시작하지 못했다.

## claim 부트스트랩 ttl_seconds 모호성 (#1673, 2026-08-23)

- `infra/prod/bootstrap_owner_claim_if_absent.sql` SELECT INTO를 테이블 별칭 `i`로 한정. PL/pgSQL 변수 `ttl_seconds`와 컬럼 동명으로 `MOMO_BOOTSTRAP_CLAIM=1` migrate가 스키마 78/78 뒤 Exited 1이던 P1.
- `scripts/verify_owner_claim.sh`에 실 `momo-migrate` + `MOMO_BOOTSTRAP_CLAIM=1` 경로 단정 추가(claim-pending owner + `owner_claim` 행). 형제 `bootstrap_owner_if_absent.sql`·`set_initial_owner.sql`은 컬럼/변수 이름이 달라 확인함 무해. ADR-0166 계약·claim 라우트/웹 폼·078 마이그레이션 비접촉.

## 그록봇 셀프호스트 플레이북 (#1652, 2026-08-23)

- 루트 `llms.txt`(진입 stub) + `docs/SELF_HOST_AGENT.md`(3계층: digest 코어 설치 → quick tunnel → 핸드오프). 본인 그록봇 계정/VM 전용. claim 회신은 migrate `MOMO_CLAIM_PATH`. pgdata는 `/workspace` bind. 실기동 E2E는 범위 밖.
- 현행 §2-B app digest(`0fbddd36…`)는 #1651보다 앞선 발행일 수 있다. 플레이북은 `MOMO_CLAIM_PATH` 부재 시 비밀번호 우회 없이 정지한다. Q-LEGAL(성재)이 정본 main 머지 전 판단 권장.

## 셀프호스트 첫 owner claim-token 부트스트랩 (#1651, 2026-08-22)

- ADR-0166: `momo-migrate` opt-in `MOMO_BOOTSTRAP_CLAIM=1`이 시드 owner를 claim-pending으로 두고 1회용 `/claim/<token>`을 stdout에만 출력한다. `POST /v1/claim`이 비밀번호 설정과 토큰 소비를 한 트랜잭션에서 처리한다. 기존 `MOMO_INITIAL_OWNER_PASSWORD` 경로 불변.
- 봉인: TTL 24h, 라우트 `POST /v1/claim` + 웹 `/claim/<token>`, per-IP 30/60s (join과 별도 버킷), 표현=`owner_claim`(hash/`expires_at`/`consumed_at`) + `password_hash` 공란. 미소비 로그인은 `momo_password_verify` 자연 거부.
- 검증: `scripts/verify_owner_claim.sh` (migrate-time `MOMO_BOOTSTRAP_CLAIM=1` → claim-pending owner+`owner_claim` 행, 그다음 발급→로그인 401→claim→로그인 200→재사용 409→TTL 410→DB 해시만→로그 원문 부재). 웹 폼은 로그인 표면 인접 4-상태.

## 셀프호스트 pg_dump 리커버리 (#1654, 2026-08-22)

- 오퍼레이터 `scripts/self_host_pg_dump.sh` / `scripts/self_host_pg_restore.sh`: compose postgres에 `pg_dump -Fc` → `/workspace/oort-backups`(또는 `--output-dir`) → 다운로드 안내. 구현은 `scripts/lib/pg_dump_custom.sh` 하나이고 리허설 게이트가 같은 함수를 쓴다.
- 셀프호스터 복원 정본 `docs/runbooks/selfhost-pg-dump-restore.md` — 그록 이탈·구독 해지·B7 트라이얼 잠김·다른 VPS/로컬 이사. PITR 런북과 경계를 나눈다. T-2 `SELF_HOST_AGENT.md` §3.2·§4가 결속. 앱 UI export는 후속.
- AC: 고유 compose 프로젝트 2벌에 member/message 시드 → dump → 신규 postgres restore → 잔존 단정(`scripts/verify_self_host_pg_dump_restore.sh`). 시크릿 stdout 비유입.

## GHCR publish-images multi-arch 계약 (#1643, 2026-08-22)

- `publish-images.yml`을 native `linux/amd64`(`ubuntu-24.04`) + native `linux/arm64`(`ubuntu-24.04-arm`) 잡 분리 후 `buildx imagetools create`로 manifest list를 묶는 구조로 확장. QEMU 없음. `workflow_dispatch`·`release` Environment·main-only 승인 경계는 각 잡에 유지. attestation은 아키별 digest와 list digest 둘 다(운영자 pin=list). `sha-<gitsha>`는 list에만 붙는다.
- 계약 테스트가 arm64 잡·manifest 합성·기존 단언(수동 전용·권한·풀 SHA·digest 검증·QEMU 금지·`latest` 금지)을 고정. **실발행 dispatch는 이 goal 밖** — 현행 v0.1.0 digest는 amd64 단일, arm64/list 실측 0.

## 루트 계약 문서 web-legacy 서빙 거짓 일소 (#1641, 2026-08-22)

- T-E #1610 README 이분(라이브=`clients/web`, `server-rust/Dockerfile:147,157,173,231` web-assets / #1228 · web-legacy=Swift prod `Dockerfile.web`·e2e `web-init`·`--profile web` 소비)을 AGENTS.md §0/§2·CODEX.md·docs/INDEX.md·clients/web/README.md·local_gate.sh auto 분류 주석·docs/LOCAL_PR_GATE.md web 설명에 전수 반영. 서빙 배선 코드 무변경.

## 발행 실측 라벨 현행화 + 운영 문서 GATED_DOCS 편입 (#1642, 2026-08-22)

- v0.1.0 첫 발행 실측(원장 #1332 코멘트 2026-08-21 · 발행·익명 pull·attestation PASS · 패키지 public · amd64 단일)을 LOCAL_3_DAY H2·INTERNAL_ALPHA·infra/rust README §3-1·ncp-rust-deploy first-dispatch 문면에 반영. **H2 amd64 부팅 실측은 잔여**(Apple Silicon native pull 불가만 실측).
- `check_docs_commands.py` GATED_DOCS에 `docs/RELEASING.md`·`docs/NEXT_CHANNEL.md`·`CONTRIBUTING.md` 편입. 게이트 407→439 fact / 12→15 문서. 하네스 26/26.

## PR CI 노드 레인 붕대 제거 (#1635, 2026-08-22)

- web 레인 `env TZ: Asia/Seoul` 제거. TZ 정본은 `clients/web/vite.config.ts` `test.env` (#1267). CI 중복 pin은 UTC 호스트의 로컬 빨강을 가린다.
- mobile 레인 `inboxApproval.test.tsx` 파일명 제외+65/66 하드 게이트 제거. 전 스위트(inboxApproval 포함) 실검증 (#1268). 가드레일이 두 붕대 재도입을 RED로 고정.

## 데스크탑 dmg 공개 릴리스 준비 (T-3 / #1653, 2026-08-23)

- bundle target `["app", "dmg"]`. next 채널 `.app` 경로(`bundle/macos/oort.app`)와 momo-alpha 업로드(`.app.tar.gz`+zip)는 불변. `publish_next_build.sh` 가 dmg 를 같은 빌드에서 서명하고 dry-run 에서 `codesign --verify --strict` 까지 잰다. 실공증·`gh release upload` 는 오케스트레이터.
- **택일 (a):** 기존 `v0.1.0` Release 자산 `oort-macos-aarch64.dmg`. 안정 URL `https://github.com/yeomyeonggeori/oort/releases/latest/download/oort-macos-aarch64.dmg`. 별도 desktop 태그는 latest 가 서버 digest 를 가린다. `--public --version 0.1.0` 만 공개 번호를 쓰고, 커밋된 `tauri.conf.json` 은 `0.1.0-next.1`.
- `runtime-unverified(실공증·v0.1.0 자산 업로드)` — 워커 범위는 dry-run.

## 온보딩 첫 왕복 게이트 (T-6 / #1656, 2026-08-22)

- 그록봇(호스티드 에이전트) 초대 완료 직후 채널에 「첫 멘션을 보내보세요」 표면. 왕복 판정은 에이전트 author 메시지 도착=완료. 네 상태(빈/로딩/오류/오프라인)와 에이전트 뱃지 필수. 미도착은 타임아웃 오류로 표면화(무음 실패 없음). 응답 시간 상한은 게이트가 아니다. 위저드 단계 기계는 그대로, 테스트 멘션 링크에 `firstMention` 힌트만 가산.
- bench: `scripts/bench_onboarding.sh aggregate`가 M5 first-reply p50/p95를 집계하고, `run` 요약에도 같은 절을 붙인다. M1~M4 로직 불변. `runtime-unverified(실기 그록봇 첫 멘션 e2e)`.
- 검수 수리(#1660): 오프라인은 셸 ConnectionBanner만 발화하고 이 표면은 컨트롤 잠금. failed pending은 왕복으로 세지 않음. 시계는 최신 멘션. 완료/닫기는 채널 키 localStorage. 오류 문면은 displayName. 대기는 워킹 시그널 문장.

## 그록봇 감지·원클릭 초대 (T-5 / #1655, 2026-08-22)

- 데스크탑(Tauri)만 수동적 시그니처로 Grok Bot을 본다: `/Applications/Grok Bot.app`, 번들 id `com.anysphere.sand`, 프로세스 이름 `Grok Bot`. CDP 포트 접속/스캔은 없다(Q-CDP). 브라우저 탭·미설치는 초대 UI 침묵. 원클릭은 기존 페어링 위저드(#1360) identity 프리필 + create/regenerate 한 번이며 단계 기계는 그대로다. 그록 pairing 문면은 말로 전하는 것이 기본, 직접 붙여 넣기는 다른 방법. 원클릭 autoAdvance는 위저드 열림 시점 online일 때만 소비하고 유예되면 무장 해제. 재페어링은 기존 regenerate API 소비. `runtime-unverified(실기 Grok Bot.app 설치 머신 e2e)`.

## 커뮤니티 루트 문서 (#1630, 2026-08-21)

- Contributor Covenant v2.1 `CODE_OF_CONDUCT.md`(연락처=`SECURITY.md` GitHub private advisory — 새 메일 없음). `.github/CODEOWNERS` `* @kwakseongjae`. `CHANGELOG.md` Keep a Changelog 시드 — [v0.1.0](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.0) 항목은 notes 초안 요약(발명 0). `CONTRIBUTING.md` 영문 정본 + `CONTRIBUTING.ko.md` 한국어 원문. README Being wired up 「Public CI, releases…」 한 줄을 Works today로 옮김(G1 티켓 후보 4 흡수). GOVERNANCE.md 비신설.

## PR CI gitleaks 레인 (#1629, 2026-08-21)

- pr-ci에 상시 gitleaks 잡: PR 범위(`base.sha..head.sha`)만 스캔. 전 히스토리는 로컬 `scripts/check_secrets.sh` 몫. `.gitleaksignore` 재사용. 바이너리 8.30.1 + linux_x64 sha256 pin, 미설치/체크섬/탐지 실패는 RED. `pull_request` 유지(토큰·org license secret 불요). 가드레일 테스트가 경로 필터·전 히스토리·unpinned·`pull_request_target` 변이를 RED로 고정.

## 첫 v0.1.0 릴리스 준비 문서 (#1628, 2026-08-21)

- `docs/RELEASING.md` 신설: 승격→발행(dispatch·owner 승인)→digest 수거→태그(빌드 커밋 `main=45a154d2`)→Release(digest 표)→SELF_HOST 문면. 데스크탑 next 채널은 `NEXT_CHANNEL.md` §8과 경계. 태그/Release 원격 쓰기는 오케스트레이터.
- `docs/SELF_HOST.md` §2-B: placeholder를 첫 발행 app digest 예시로 교체, 「최신 digest는 GitHub Releases」. 구 `:88` `runtime-unverified`를 실측 완료로 갱신(원장 #1332 코멘트 2026-08-21 · attestation PASS · Apple Silicon native pull 불가). amd64 단일 유지.
- notes 초안: `docs/planning/research/2026-08-21-v0-1-0-release-notes.md`(README 정직성 톤·digest 표·`gh attestation verify`·amd64 고지). 발명 0(패킷 §G1만 인용).

## 셀프호스트 compose 교차-체크아웃 충돌 fail-closed (#1613, 2026-08-21)

- **택일 (a) 프로젝트 스코프 볼륨.** 고정 전역 `name: oort-pgdata` + 무조건 선점은 채택하지 않는다 — 프로젝트명을 분리해도 같은 datadir 이중 기동이 그 갈래다. compose 기본은 기존대로 `${DB_VOLUME_NAME:-${COMPOSE_PROJECT_NAME:-momo-rust}-pgdata}` 이고, 셀프호스트 생성기는 기본 `COMPOSE_PROJECT_NAME=oort` → `DB_VOLUME_NAME=oort-pgdata` 를 유지해 기존 볼륨을 무언 대체하지 않는다. Swift `momo-pgdata` 비채택 주석은 보존.
- **기동 전 가드:** `--compose up/down` 등이 산 컨테이너의 `com.docker.compose.project.working_dir` 을 이 체크아웃과 대조한다. 같은 프로젝트 또는 같은 pgdata 볼륨을 다른 디렉터리가 쓰고 있으면 명시 중단. 같은 체크아웃 재개(#1361 대표 케이스)는 무경고.
- **마이그레이션:** 생성 시 기존 `oort-pgdata` 가 있으면 채택(기본 이름) 또는 분리(다른 프로젝트명)를 명시 안내. 볼륨 삭제·복사 없음. `down -v` 의미 불변.
- **게이트:** `scripts/tests/test_self_host_env_modes.sh`(충돌 2시나리오 RED 단언 + 채택/분리 안내) · 실 docker 증명은 `scripts/tests/test_self_host_stack_collision_docker.sh`(임시 `oort1613t*` 프로젝트/볼륨만, 이 머신 `oort-pgdata`·`momo-tracks/engine` 비접촉).

## GHCR 재배포 고지 bundle + drift/release gate (#1332, 2026-08-21)

- `server-rust/Cargo.lock` + `clients/web/package-lock.json`에서 이름/버전/SPDX·저작권·LICENSE/COPYING·upstream NOTICE를 결정적으로 생성한다. 정본 `legal/generated/GHCR_THIRD_PARTY_NOTICES.txt`(실측 292 cargo + 411 npm, unique blob 343). `legal/THIRD_PARTY_NOTICES.md`는 현행/역사 인덱스. 누락 SPDX·라이선스 파일은 fail-closed. 생성기는 레포 자체 스크립트(`scripts/generate_ghcr_notice_bundle.py`) — cargo-about 등 외부 도구를 새 핀으로 들이지 않았다.
- 앱·postgres 두 GHCR 이미지에 고지 4종(LICENSE·NOTICE·인덱스·생성 bundle)을 동봉하고 빌드에서 `sha256sum -c`와 dpkg `/usr/share/doc/*/copyright` 존재를 검증한다. 앱 이미지는 `/opt/momo/web/legal/`에도 같은 바이트를 두어 web-assets 경로에서 읽힌다. Debian 인벤토리의 GPL/LGPL는 copyleft이며 permissive로 오분류하면 RED.
- `NOTICE`에서 미구현 "Open Source Licenses" 화면 주장과 permissive-only 단정을 지웠다. 자동화는 재현 가능한 인벤토리이지 법적 충분성 선언이 아니다.
- stale bundle은 `scripts/check_ghcr_notice_bundle.sh`가 lockfile 해시로 RED. `local_gate --profile license`와 PR CI alignment가 강제한다. 정책 allow/deny(#1225)와 고지 생성(#1332)은 게이트를 나누어 두었다.
- #35 소비: `docs/planning/ENGINE_HANDOFF.md` A-27 ready.
- 앱 이미지 실빌드(`docker build -f server-rust/Dockerfile -t oort-1332-notice-app-test .`) 완주. 이미지 안 `sha256sum -c` 4종 OK, `/opt/momo/web/legal/`에 LICENSE·NOTICE·인덱스·생성 bundle. `server-rust/Dockerfile.dockerignore`가 `legal` 전체를 배제해 COPY가 not found 되던 구멍은 초안만 배제하도록 고쳤다(회귀: COPY 경로가 per-Dockerfile ignore에 걸리면 RED). dpkg copyright 인벤토리: `legal/generated/DEBIAN_COPYRIGHT_INVENTORY.momo-rust.txt`. postgres 실빌드 증거는 `DEBIAN_COPYRIGHT_INVENTORY.oort-postgres.txt`.

## Rust PG18 pgBackRest/WAL/PITR 폐곡선 · signed migration gate (#1330, 2026-08-12)

- 기존 PG18 단일 named volume·`archive_mode=off` 경로와 logical `pg_dump` smoke를 production backup 증거로 보지 않는다. pinned PostgreSQL 18+pgBackRest image와 encrypted POSIX/S3-compatible overlay가 exact wrapper archive command·60초 timeout·secret-file-only 경계를 고정하고, app/database 두 image는 각각 SBOM·max provenance·returned-digest SLSA attestation 뒤에만 release summary를 낸다.
- 로컬 closed loop는 marker A → online full backup → backup 이후 target UTC → marker B+강제 WAL archive → source와 다른 새 volume의 time-target restore → A=1/B=0·같은 system identifier·promote·archive off를 실측한다. active/used/nonempty restore target, repo/cipher/archive drift와 labeled resource leak은 evidence 생성 전에 RED다.
- `momo-migrate`는 production/staging SQL 전에 strict `momo-pitr-evidence/v1` HMAC, 15분 freshness, caller nonce·commit, source/restore/repo, 두 image digest, candidate migration bytes, live system identifier, backup/LSN/WAL/A-B/cleanup을 재검증하고, live migration 이력이 candidate set을 벗어난 schema downgrade도 거절한다. runner의 daemon-wide fixed-name lock container가 첫 lineage 검사부터 최종 healthy rollout까지 모든 signed migrate를 직렬화해 newer-schema/older-image 교차 배포를 막는다. 첫 install의 empty-bootstrap만 실제 빈 DB에서 별도 허용하고 local quickstart는 명시적 development warning posture다. 실제 NCP attach/S3 object-store/첫 GHCR database image publish·pull·attestation, scheduled full/differential host timer·실패 알림, #1332 귀속·사람 법무는 attended 후속 전까지 각각 `runtime-unverified(public host/schedule/legal)`다.
- 리뷰 후속(2026-08-20): 기존 stanza는 `info` status가 `ok`/`no valid backups`일 때만 `stanza-create` skip(`missing stanza path`는 1회차 CREATE). backup overlay migrate 정책 3키는 리터럴 production lock. evidence 시각은 source PG `clock_timestamp` 단일원. EXIT trap probe DROP은 fail-closed helper를 우회한다. 같은 repo 볼륨 2연속 ensure는 CREATE→SKIP으로 실측. 전체 `verify_pgbackrest_pitr_e2e.sh`(rust migrate 이미지 빌드)는 미실행이라 `runtime-unverified(full isolated e2e)`다.

## next 채널 위생 — 로컬 release 롤백 가드 + 재발행 체크리스트 (#1281, 2026-08-20)

- **택일:** 로컬 `cargo tauri build`(릴리스)가 항상 `0.1.0-next.1` 이라 매니페스트(`next.10`)보다 낮아 기동 즉시 롤백하던 구멍은 **가드 확장**으로 막았다. `MOMO_CHANNEL_BUILD=1` 이 있는 산출물만 업데이터 네트워크를 탄다. 그 플래그는 `scripts/publish_next_build.sh` 만 켠다. `tauri.conf.json` 버전을 마지막 발행값으로 올리는 주입은 `next.N+1` 에서 같은 구멍이 다시 열리고, 발행 스크립트가 `--config` 로 버전을 넣는 이유(커밋마다 버전 파일을 안 건드림)와 싸운다.
- 채널 소스(`publish_next_build.sh` · `tauri.conf.json` · `docs/NEXT_CHANNEL.md` · `release-desktop.yml`)의 구 org URL 은 0. `NEXT_CHANNEL.md` §0 은 T-C 사문화·T-E 배너와 맞춰 "채널 하나"로 고쳤다(T-E 티켓 후보 4 흡수). 성재 복붙 재발행은 §8.
- **정직 라벨:** 실발행·서명·공증은 성재 손(시크릿 3종). `yeomyeonggeori/momo-alpha` 원격 비접촉. 레포 전체 `Dawn-kim-official` 문자열은 이력·픽스처·동결 번들 ID(`com.dawnkim.momo`)·의도적 `momo-signing` 404 주석에 남는다 — 라이브 채널 경로가 아니다.

## 셀프호스트 생성 env 데스크탑 CORS 기본값 (#1607, 2026-08-20)

- **택일:** `scripts/self_host_env.sh` 가 만드는 `infra/rust/local.secrets.env` 는 `MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost` 를 기본 포함한다. 같은 2종을 `CENTRIFUGO_ALLOWED_ORIGINS`(공백 구분)에도 넣는다 — REST 만 열면 로그인은 되고 실시간이 403이다. `docker-compose.rust.yml` 의 빈 기본값과 `caddy.override.yml` 운영 경로는 이 파일을 읽지 않아 운영 형상에 파급이 없다. 기존 env 는 CORS 키가 없을 때만 한 줄을 추가하고, 빈 값·커스텀 값·Centrifugo 목록은 덮어쓰지 않는다.
- **정직 라벨 `runtime-unverified(release-bundle login + realtime round-trip)`.** 이 워크트리는 headless 라 릴리스 앱 GUI 로그인·compose 스택 Origin 실측을 닫지 못했다. 닫힌 것은 생성기 배선 + `scripts/tests/test_self_host_env_modes.sh`. 실기동 증거는 이슈 #1607 오케스트레이터 절차서 → ITO-1 이관.

## gate: docs-코드 드리프트 — 운영 문서의 실행 명령을 트리에 대고 해소 (#1525, 2026-08-18)

- **#1472는 명령 하나를 고쳤고, 이건 그 문장이 다시 틀려지는 것을 막는다.** `AGENTS.md` §3은 스스로 "copy-paste, 그대로 실행"이라 적어 놓고 몇 주 동안 `cargo fmt --check --manifest-path server-rust/Cargo.toml`을 실었다 — 두 매니페스트 다 virtual workspace라 그 형태는 "Failed to find targets"로 끝나고 **아무것도 검사하지 않는다**. 워커 3기(#1454·#1442·#1467)가 그 초록을 믿었고 그 아래 rustfmt 드리프트를 각자 다시 발견했다. #1472가 실행형을 게이트에 넣었고, 이 goal은 **문서형**을 넣는다.
- **범위는 명령을 그대로 실행하는 문서 4종.** `AGENTS.md`·`CODEX.md`(전자가 스스로 "핵심 내용 동일"이라 선언한 쌍둥이 — 한쪽만 게이트하면 드리프트가 게이트 없는 쪽으로 돌아온다)·`docs/RUN.md`·`docs/runbooks/*.md`(글롭이라 새 런북은 만들어지는 순간 커버된다). 판정하는 명령 클래스는 7가지: 실행체 존재·실행권한·구문(`bash -n`/`py_compile`) · `make` 타깃 · `local_gate.sh --profile` 이름(목록은 local_gate.sh 자기 파서에서 읽는다 — 재기술하면 그것부터 드리프트한다) · npm 스크립트 · 우리 스크립트에 넘기는 long flag · compose `-f`/`--env-file`·`--package-path`/`--manifest-path` 경로 · `cargo fmt --check`의 `--all`(#1472 규칙 자체).
- **명령을 실행하지는 않는다 — 실행할 수 없어서다.** 이 문서들의 명령은 워크트리를 만들고 브랜치를 push하고 Docker 스택을 올리고 GitHub 상태를 바꾼다. 그래서 "돌려 보기"는 선택지가 아니고, 대신 **해소**한다. 결과적으로 못 잡는 것은 정직하게 적었다: 해소는 되는데 엉뚱한 일을 하는 명령은 여전히 안 보인다.
- **기존 위반 17건 발견, 전부 같은 PR에서 정리.** 14건은 `docs/RUN.md`에 남은 **W-S1(#1215) 삭제 잔여**였다 — `scripts/macos_dev_run.sh` 9곳(스크립트는 그때 삭제됐다), `--profile macos-ui` 1곳(레인이 macOS 트리와 함께 사라졌다), `--package-path clients/macOS` 3곳(트리 삭제됨). W-S1 커밋 제목은 "Swift 클라 3트리 참조 0 만들기"였고, RUN.md §6은 그 0에 들지 않았다. 3건은 `docs/runbooks/ncp-rust-deploy.md` — `npm run gate:csp-deploy` 2곳이 루트에서 호출돼 "Missing script"가 되고(`--prefix clients/web` 누락), 1곳은 **폐지된 절차**를 실행 가능한 형태로 적고 있었다.
- **red proof 26 케이스.** #1472 명령 원형 재주입 · 삭제된 실행체 · `bash -n` 실패 · 실행권한 없음 · 없는 make 타깃 · 없는 게이트 프로파일 · 없는 npm 스크립트 · 잘못된 prefix · 모르는 long flag · 없는 compose 파일 · 삭제된 `--package-path` · 새 런북 자동 커버 · 표에 든 문서 소멸. 그리고 **오탐이 쉬운 자리에서 초록**임을 함께 증명한다 — `<issue-number>` 같은 placeholder, 글롭, 산문 속 파일 참조, ```` ```text ```` 블록의 예시 출력, 서브커맨드 뒤의 플래그(디스패처가 `"$@"`를 남에게 넘기므로 그 플래그는 그 스크립트 것이 아니다). 오탐 절반이 없으면 이 게이트는 결함을 놓쳐서가 아니라 짜증나서 꺼진다.
- **탈출구는 이유를 요구한다.** `<!-- docs-cmd-ignore: 이유 -->`는 딱 그 줄만 면제하고, **이유가 비면 마커가 아니다**(#1250 `NON_COMPOSE_ENV_TEMPLATES` 선례). RUN.md §6이 "삭제됐다"고 말하려고 삭제된 명령의 이름을 부르는 자리에서 3번 쓰였다.
- **게이트:** `scripts/local_gate.sh --profile docs` green(신규 2단계 포함 — 가드 0.21s, 회귀 하네스 1.1s 실측). `check_docs_commands.py` = 392 fact 판정 / 위반 0. 하네스 26/26. `test_local_gate_drift_guard.sh`·`test_local_gate_hardening.sh` 무회귀.
- **정직 라벨 — 게이트 밖에 같은 병이 더 있다(실측).** 사라진 `--profile macos-ui`는 게이트 대상 밖 문서 10곳에 **42회** 더 살아 있다(`BUILD_TICKETS.md` 27 · `docs/INTERNAL_ALPHA.md` 3 · `docs/LOCAL_SOLO_ALPHA_ROADMAP.md` 3 · `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md` 2 · `ROADMAP.md` 2 · `docs/{BACKLOG,GITHUB_OPS,INTERNAL_ALPHA_FEEDBACK,MACOS_ALPHA_UPDATE_CHANNEL}.md`·`docs/adr/0003` 각 1). **고치지 않았다** — 그 문서들 대부분은 은퇴한 M3~M7 전제 위의 계획·티켓 기록이고, 표를 거기까지 넓히는 것은 문서 자체가 아직 유효한지부터 판정하는 일이라 이 goal의 out-of-scope("문서 내용 개편")에 정면으로 닿는다. 후속 goal 후보로 남긴다: **①표 확장 대상 판정(어느 문서가 아직 실행되는 문서인가) ②`BUILD_TICKETS.md`/`ROADMAP.md`의 은퇴 전제 명령 일괄 정리.**

## toolchain: Rust 고정/선언 지점 전수 조사 + MSRV 정합 (#1442, 2026-08-17)

- **외부 실측이 지목한 "고정 1.83"은 우리 레포에 없었다.** 커서 클라우드 에이전트 보고(리서치 2026-08-16 §5)의 "pinned 1.83"은 레포 핀이 아니라 **커서 환경의 기본 툴체인**이었다 — 기준 커밋 `track/engine@54f5d2dc`에 `rust-toolchain*` 파일은 **0개**다(`find` 실측). 실재하는 결함은 고정이 아니라 **거짓 선언**이었다.
- **선언 MSRV 두 개가 다 거짓이었고, 실측으로 갈음했다.** `server-rust` = `1.80` → **`1.88.0`**(8 마이너 과소), `clients/desktop/src-tauri` = `1.77.2` → **`1.89.0`**(12 마이너 과소, tauri 2 스캐폴드 초기값이 그대로 남아 있었다). 근거는 선언 스캔이 아니라 **양쪽 브래킷 실행**이다: `cargo +1.87.0 check`(server) 거절 / `+1.88.0 --all-targets` green, `cargo +1.88.0 check`(desktop) 거절 / `+1.89.0` green. 이 값은 게이트가 아니라 **cargo가 강제**한다 — 낮은 툴체인은 컴파일 이전 resolve 단계에서 거절된다.
- **edition은 여전히 2021이고 마이그레이션하지 않았다(스코프 밖).** 그래프 안의 edition2024 크레이트 15개(server)·16개(desktop, macOS 필터)는 전부 **서드파티**이며 rustc ≥1.85를 요구하지만 그것이 바닥이 아니다 — 실제 바닥은 `time 0.3.54` 계열(1.88.0)과 `notify-rust 4.18.0`(1.89.0)이다.
- **`rust-toolchain.toml`은 신설하지 않았다.** 핀은 이 goal이 건드리지 말라고 지시받은 세 운영 표면(Docker 빌드 이미지·self-hosted macOS 러너·CI 툴체인 조달)을 동시에 바꾸고, 여기서 실측된 결함(거짓 `rust-version`)을 고치지도 않는다. 핀의 가장 강한 독립 논거인 **rustfmt 스큐는 이미 #1377이 들고 있다** — 근거와 함께 거기서 결정되어야 한다.
- **부동 베이스 이미지는 보고만 한다(운영 결정, 성재 큐).** `server-rust/Dockerfile:51`의 `ARG RUST_IMAGE=rust:1-slim-bookworm`은 pull 시점 최신 1.x라 **고정이 아니다**. 오늘은 MSRV를 항상 만족하지만 재현 가능한 빌드는 아니며, 고정 전환은 이 goal에서 하지 않았다.
- **정직 라벨 — MSRV는 어느 게이트도 재지 않는다.** pr-ci rust 레인은 러너 사전설치 **stable**로 돌므로 초록은 "러너 stable ≥ 선언값"만 뜻한다. 선언이 다시 틀려져도 CI는 침묵한다 — MSRV 검증 잡은 후속 제안이다.
- **게이트:** `cargo test --workspace --locked` 1063 passed/0 failed/288 ignored · desktop `clippy -D warnings` clean · **server-rust `clippy -D warnings` green**(경고 0). MSRV 정직 상향이 켠 MSRV 게이트 린트는 1건이 아니라 **6건**이었고(clippy가 첫 크레이트에서 멈춰 있었다 — `manual_is_multiple_of` 1 + `unnecessary_map_or` 3 + `nonminimal_bool` 2, 그중 4곳이 보안 술어), 소스 비접촉 계약(#1454 비행 중)으로 1차 정지·이탈 보고 → 진리표 동치 증명과 함께 이슈 #1442 코멘트로 성재 결재 큐 이관 → **결재 집행(2026-08-17, 전권 위임)으로 6건 전부 적용**(git apply 바이트 정합·`afda586a`). 패치 1~4는 통과 단위 테스트가 직접 실행 커버, 5·6(토큰 리프레시 게이트·본문 검증)은 PG 통합 테스트로 별도 실증. `cargo fmt --all --check`는 기준 커밋에서 이미 RED이며 **#1377/#1472** 소관이다.

## T3 라이브 세션 control 개방 — 엔진 축 (창 원장·비관측 게이트·owner 예외) (#1424, 2026-08-16)

- **075가 남긴 실행 지점을 집행했다.** 075 말미 주석은 "경계가 열리는 날 이 절을 지우는 것이 그 결정의 실행 지점"이라 적어 두었고, ADR-0004 증보 3이 2026-08-15 Accepted 됐다. 마이그 076이 `terminal_attach_display_observer_ck`를 지웠고, 나머지 두 층(`AttachKind::permits_mode`·라우트 403)이 같은 커밋에서 함께 움직였다 — 075가 약속한 "셋이 함께 움직이고 어느 것도 놓칠 수 없다"가 실제로 그렇게 됐다.
- **잠금이 사라진 자리에 원장이 들어왔다.** CHECK만 지우면 "살아 있는 VM에 키보드를 내주면서 그 VM을 모는 에이전트가 무엇을 하고 있는지에 대해서는 아무 의견이 없는 빌드"가 되고, 그 의견이 증보 3의 전부다. 그래서 controller 발급은 한 트랜잭션에서 세 가지를 한다: ①**owner 한정**(PTY controller의 `c.owner_member_id = ws.member_id` 술어 재사용 — 새 권한 모델을 만들지 않았다) ②**`display_control_window` 행 개설**(076, RLS FORCE, 세션당 열린 창 1개를 partial unique index로 강제) ③**그 창이 서 있는 동안 에이전트의 그 세션 접근 거부**. capability만 있고 창이 없는 상태는 트랜잭션 경계상 존재할 수 없다.
- **비관측은 선언이 아니라 거부이고, 게이트가 하나뿐이라 완결적이다.** 탐사 결과 에이전트가 work session에 닿는 서버 경로는 **하나**다 — `POST …/work-controls`(agent bearer 전용, `read`=화면 읽기·`input`=키보드·`kill`, 그리고 `session_id`를 든 유일한 지점). attach 두 라우트는 모두 `require_human`이고 MCP agent-port 8개 도구에는 세션 표면이 없으므로, 에이전트는 관전 capability 자체를 받을 수 없다. 그 한 곳을 막으면 관측 경로 전체가 막힌다. 두 층으로 걸었다: **거부**(`work_controls::create` 409, **모든 쓰기보다 위** — 거부된 시도는 `work_control` 행도 audit도 남기지 않아 "에이전트가 보지 않았다"가 원장에 대한 진술이 된다)와 **보류**(창 직전 dispatch된 제어를 `pending_controls_for_host_in_tx`가 withhold — 실패시키지 않으므로 창이 닫히면 다음 poll에서 그대로 전달된다, 증보 3 D4의 재개).
- **mutation 증명 2건을 실제로 돌렸다.** 증보 3 Consequences가 요구한 수용기준이다. `live3_2`는 **완전히 자격 있는** 에이전트(live run·승인된 lineage·running 세션·미회수 host)가 창 전 201 → 창 중 409로 바뀌는 것을 보고, 그 사이에 바뀐 것은 창 하나뿐이다 — 거부만 보는 단언은 "전부 거부하는 라우트"에도 통과하지만 이건 통과하지 못한다. 실제로 ①`create`의 창 검사 삭제 → `read`가 201로 통과하며 RED ②`pending_controls`의 `NOT EXISTS` 절 삭제 → withhold 단언이 RED. 둘 다 복구 후 8/8 GREEN.
- **lease는 capability 만료가 아니다 — 이것이 이 배치에서 가장 조용한 함정이었다.** capability의 `expires_at`은 **dial** 창(60초)이고 `stream:true` 재검증은 만료 절만 건너뛰므로 살아 있는 스트림은 설계상 이미 만료된 행 위에서 돈다. 창을 그 타임스탬프에 맸다면 사람이 비밀번호를 입력하는 도중 60초에 에이전트의 화면 접근이 재개된다 — 증보 3 D3이 막으려는 바로 그 실패다. 그래서 창은 자체 `lease_expires_at`을 갖고 **그 재검증이 갱신**한다: producer가 스트림이 살아 있다고 말하는 동안 창이 열려 있고, 말을 멈추면 lapse한다. 실패 방향도 안전한 쪽이다(producer가 죽으면 창은 스스로 닫히고, 계속 말하면 에이전트는 계속 밖에 있다). 90초 = 재검증 3회분이며 `const` 블록이 컴파일 시점에 두 관계를 붙든다.
- **창은 세 경로로 닫히고 셋 다 멱등이다.** 반환(owner `DELETE …/display-control`, `returned`) · lease 만료(`expired`) · 세션 종료(`session_ended`). 반환 재시도는 4xx가 아니라 200 + `closed:false`다. lapse는 **감지 지점에서 이벤트를 낸다** — 아무도 수행하지 않는 닫힘이라 다른 저자가 없다. 그리고 lapse를 `returned`로 라벨링하지 않는다: 원장이 경계 이벤트의 SoT이고 거기 틀린 이유가 적히면 무슨 일이 있었는지에 대한 틀린 이야기가 된다.
- **`input_enabled`가 등급이 아니라 창을 따라간다 — 이것이 반환을 실재하게 한다.** controller **이고** 창이 서 있을 때만 true다. 등급만 읽었다면 "돌려주기"는 표의 행 하나와 여전히 동작하는 키보드였을 것이다. 같은 bearer가 반환 후 재검증에서 `false`를 받는 것을 conformance가 고정한다.
- **`owner_only` = 「소유자만 본다」로 확정, 예외는 display로 좁혔다.** LIVE-1이 미결로 명시해 둔 항목이고 성재가 이 파도에서 결재했다. 발급과 검증 조인 양쪽에 넣었다(발급만 고치면 owner의 화면이 다음 30초 재검증에서 꺼진다). `kind = 'display'`로 좁힌 이유는 PTY에는 같은 문제가 없기 때문 — 거기선 owner가 controller로 자기 세션에 붙는다. control이 에이전트를 정지시키는 지금 이 예외는 더 중요하다: 보기만 하려는 owner가 자기 에이전트를 세우지 않아도 되는 유일한 경로다.
- **VM은 움직이지 않는다(D6).** `work_session.status` 무변경, ADR-0140 상태기계 무변경, running-time 과금 계속. conformance가 창 중 `status = running`을 못 박는다. 멈추는 것은 런 층의 도달 범위뿐이다. 자격증명 비유입(D2)은 **담을 칸이 없어서** 성립한다 — 076에 키 입력을 넣을 컬럼이 없고 경계 이벤트 payload는 `session_id`·`state`·`started_at` 3키뿐(런타임 확인).
- **정직 라벨 `runtime-unverified(input delivery)` → LIVE-5c(#1565)에서 화면 절반도 측정됐다.** 서버 절반(발급·창·게이트·`input_enabled`·3경로 닫힘)은 실제 PG18 + 실제 Axum router로 증명돼 있었고, 화면 절반이 비어 있었다. 이제 producer가 **work-host Ed25519 서명**을 붙여 실서버 `validate`를 호출하고, `input_enabled: true`를 읽어 `momo.input.v1`을 **자기가 열고**, 선언된 프레임을 파싱해 XTEST로 주입한다 — 증거는 보낸 프레임이 아니라 **타이핑된 명령이 실제로 실행돼 남긴 파일**이다. **revoke 절반도 측정됐다** — 서버에서 창을 닫고 실제로 지켜봤다: 채널이 닫히고, **피어 연결과 시그널링은 살아 있으며**(반환은 자격 취소가 아니다), 그 뒤에 친 명령은 **실행되지 않는다**. 이 측정은 **시그널링 소켓에 버려지는 프레임을 흘리는 동안** 수행했다 — 재검증이 루프 하단에 있으면 그 프레임들이 재검증을 굶겨 반환된 컨트롤러의 키보드가 살아남기 때문이다(red proof: 하단 배치 시 창이 닫힌 뒤 75초가 지나도 채널이 열려 있었다). observer는 여전히 `input_enabled: false` + `m=application` 없는 offer. 게이트는 `scripts/display_input_e2e.py`. **그 마지막 미측정도 #1587에서 해소됐다** — SSH 위임으로 momo-cube-host에 로컬 momo-server 스택(루프백 28080, 프로덕션 비접촉)을 세우고 nginx `/v1/` 헤어핀을 임시로 열어, 실 CubeSandbox microVM(`momo-display5`) producer가 host-signed validate로 controller 승인을 받고 **relay↔relay**로 뷰어의 키를 **microVM 내부 xterm**에 주입했다(정적 TURN 없이 **서버 발급 단명 자격**만 — ephemeral 경로도 momo-turn에서 종단 성립). 증거는 파일이 아니라 **화면**이다: relay로 받은 H264를 디코드한 프레임에 `LIVE5C-MICROVM-OK`가 microVM 자신의 `root@tpl-0956:/#` 프롬프트에서 출력됐다. `unverified.inputDeliveryInMicroVM` → `runtimeVerified.inputDeliveredInMicroVM`(template.spec.json specVersion 5). 돌려 보고서야 드러난 producer 결함 1건도 수리했다 — `set_state(READY)`가 비동기라 직후의 `create-data-channel`이 레이스로 채널을 조용히 떨궈 승인된 controller가 view-only로 강등되던 것(READY 도달을 기다리도록 수정, momo-display:v5). 게이트는 `scripts/display_input_e2e.py --remote-proof` + `scripts/display_microvm_seed.py`, 절차는 `docs/runbooks/cubesandbox-host-install.md §8-E`.
- **`unverified.credentialCeiling`은 측정 결과 기각됐다.** "TTL을 넘기면 relay를 잃고 화면이 이유 없이 까매진다"는 추론이었는데, coturn은 REST username 만료를 **ALLOCATE에서만** 보고 기존 allocation의 REFRESH에선 다시 보지 않는다. TTL 60초로 200초를 붙잡아도 타이핑 비트 10/10이 전달됐다(relay-only). 그래서 **remint 구현(ICE 재협상)은 만들지 않는다** — TTL은 "새 allocation을 만들 수 있는 창"이지 실행 중 스트림의 수명이 아니다. 이 기각의 표면 반영은 #1574가 집행했다(택일 (b), 성재 전권 위임): turn.rs 주석·turn-host-install.md §6·display-template README·소크 하네스 docstring·conformance 주석의 "TTL=세션 천장" 계열 서술을 실측(PR #1570) 인용으로 전수 정정하고, 잔여 케이스 — **세션 중 재-ALLOCATE(ICE restart)는 그 시점 유효 자격이 필요**하므로 ICE restart를 실제로 쓰는 날 그 지점에 remint 훅(restart 시 발급, 주기 교체 아님) — 를 코드 주석과 런북에 기록했다.
- **게이트:** `scripts/verify_display_attach.sh` 4 phase PASS(conformance 8건 — LIVE-1 4 + LIVE-3 4, 두 피어 시그널링 왕복 + red proof, 템플릿↔서버 상수 교차판독, PTY/T3/work-control/daemon-ack 무회귀). 워크스페이스 clippy `-D warnings` clean · `cargo test --workspace` 전부 ok · `check_migration_numbers.sh` 76 PASS(대비 테스트 `discovers_contiguous_migrations_001_to_076`) · 웹 `typecheck` clean · 웹 998 테스트 + `@momo/core` 1425 테스트 PASS · 웹 lint 0 error(경고 7건은 기존 baseline과 동일). 로컬 docs gate는 #1376에 따라 실행하지 않았다.
- 근거는 **ADR-0004 증보 3(Accepted 2026-08-15)** · ADR-0165(+증보 1). 직접 조작 UI·로그인 핸드오프 UX는 **LIVE-4** 소관이고 이 goal은 서버 계약·원장·게이트까지다.

## T3 관전 라이브 화면 — 서버·기질 축 (WebRTC display attach) (#1409, 2026-08-15)

- **두 kind, 기계는 하나다.** 세션이 사람에게 내주는 것이 이제 둘(PTY·화면)이고, 이 층에서 둘은 같은 행위다 — 남의 endpoint에 대한 60초 bearer를 발급하고, 그것이 아직 유효한지 답한다. 그래서 `AttachKind`는 **모듈이 아니라 파라미터**다: 마이그 075가 `terminal_attach_capability.kind`(`pty|display`, DEFAULT `pty`)를 더했고 발급·검증·sweep·관전자 계수·RLS·revoke 조인이 각각 하나뿐이다. 병렬 display 기계를 만들었다면 "host를 회수했으니 관전이 끊긴다"의 정의가 둘이 되고, 그중 하나가 낡는 날 그 문장은 절반만 참이 된다.
- **view-only는 세 층이 각자 말한다 — 그리고 층마다 다른 것을 막는다.** ①스키마: `terminal_attach_display_observer_ck`가 controller display 행 자체를 **표현 불가**로 만든다(conformance가 superuser INSERT로 실패를 요구한다 — 라우트를 다시 써도 경계가 남는다는 증거). ②서버: `mode=controller`는 400이 아니라 **403**이다(어휘에 있고 철자도 맞은, 아무에게도 없는 등급) + `AttachKind::permits_mode`가 검증 경로에서 한 번 더 거른다. ③producer: SDP offer에 `m=application`이 **없다**. 없는 채널로는 키 입력이 오지 않으므로 클라이언트가 자기 플래그를 속여도 view-only가 살아남는다(ADR-0165 D4). 셋 중 ③만 이 레포가 실행할 수 없고, 그래서 그것만 정직 라벨이 붙는다.
- **바인딩 게시 경로를 Rust에 처음 열었다.** `POST …/work-sessions/{s}/display-binding`(work-host 서명)이 이 서버가 서명 host로부터 받는 **첫 work-session write**다. 의도적으로 좁다: 두 칸, 한 세션, 그리고 경로가 host가 아니라 session을 지시하므로 **서명자 핀은 핸들러가 원장을 읽어 건다**(= 세션의 `host_id`와 같아야 한다 — `…/work-controls/{c}/ack`가 세운 선례). 이 핀이 없으면 워크스페이스의 어떤 등록 host든 남의 세션 화면을 자기 스트림으로 갈아끼울 수 있고, 그건 그 세션의 모든 미래 관전자를 리다이렉트하는 것이다. human bearer는 이 경로에서도 403이고, create/PATCH의 같은 이름 필드도 **이름을 불러 400**이다(조용한 무시가 아니라 — ADR-0134 D1).
- **fail-closed는 광고 한 칸으로 서고, BYOC는 그 결과로 빠진다.** `work_host.capabilities.display_attach`가 참일 때만 발급·검증·게시가 성립한다. BYOC를 provider 이름으로 검사하지 않은 것이 요점이다 — momo가 BYOC 박스의 이미지를 굽지 않으므로 거기서는 아무것도 광고되지 않고, 정책 코드는 vendor 신원을 여전히 알지 못한다(불변식 #7 / `provider::registry` 규칙). 그리고 광고는 **매 검증마다 다시 읽는 조인 절**이라, 운영자가 그 플래그 없이 host를 재등록하면 이미 열려 있는 화면들이 한 revalidation 주기 안에 끊긴다(런타임으로 확인).
- **투영 세 곳의 드리프트를 구조로 막았다.** `remote_display_available`을 세 projection에 각각 손으로 적는 대신 술어 쌍을 **한 정의**(`WS_ATTACH_AVAILABILITY`)로 올리고 detail/RETURNING/reattach/list가 그걸 조립한다 — 하나를 빠뜨리는 것이 표현 불가다. 그 위에 드리프트 테스트가 조립된 네 문장 각각에서 두 컬럼이 **정확히 한 번씩** 나오는지 본다(네 번째 reader를 손으로 쓰는 경우를 위한 절반). DTO에서 두 boolean은 독립이고 테스트가 서로 반대값으로 고정한다: 화면만 있고 터미널이 없는 세션이 정상이며, 둘을 접은 클라이언트는 그런 세션에 「이어서 쓰기」를 권한다. `ReattachVerdict`는 일부러 넓히지 않았다 — 화면은 보는 것이지 이어서 하는 것이 아니다.
- **관전자 수는 하나로 뒀다.** `active_observer_capability_count_in_tx`와 세 projection의 count 서브쿼리는 kind를 구분하지 않고, display 발급도 같은 count-only `work.session.observer` 봉투를 낸다(payload 키는 여전히 `observer_count`·`session_id` 둘뿐 — 런타임 확인). 화면을 보는 사람도 보고 있는 사람이고, 숫자를 둘로 쪼개는 것은 이 goal이 만들지 말라고 지시받은 새 관측 모델이었을 것이다.
- **정직 라벨 `runtime-unverified(cubesandbox webrtc producer)`.** microVM 템플릿을 빌드·기동해본 적이 없다. 그래서 계약을 두 층에서 증명했다: PG18 + 실제 Axum router에서 conformance 4건(게시 권한·observer 한정·fail-closed·이미 열린 스트림의 회수), 그리고 **두 로컬 피어의 실제 WebSocket 왕복**(`scripts/display_signaling_probe.py` — subprotocol/validate/view_only/no_input 4단계, `--prove-red`로 datachannel을 여는 producer가 잡히는 것까지). 그 red proof를 만드는 과정에서 probe 자신의 결함 1건을 잡았다(handshake reader가 파이프라인된 첫 프레임을 삼켜 통과가 타이밍에 좌우됐다 — 버퍼드 `Peer`로 수리).
- **producer 선택은 ADR-0165 D1의 1순위에서 벗어났고, 근거는 성능이 아니라 D4다.** 템플릿은 Selkies-GStreamer가 아니라 **GStreamer `webrtcbin`**을 선언한다: Selkies는 *조작 가능한* 데스크톱을 파는 물건이고 입력 datachannel이 그 제품 자체라, 거기서 view-only는 "우리가 거부하기로 한 것을 제공하려고 만들어진 컴포넌트의 설정값"이 된다 — 설정은 나중에 누가 되돌려도 아무도 모른다. `webrtcbin`은 입력 경로를 쓰지 않으면 없다. 구조적 논거이고 **실측이 아니며**, 되돌리는 것은 `template.spec.json` 한 필드 + unit 파일이다(server-rust 어디에도 producer 이름이 없다).
- **미실측 미결 1건을 이탈로 보고한다 — 브라우저가 sandbox에 닿을 수 있는가.** ADR-0165 D2는 브라우저↔microVM 직결을 요구하는데, ①CubeSandbox 어댑터의 `create_body`에는 포트 노출 표현이 아예 없고(templateID·timeout·lifecycle·metadata·envVars뿐) ②ADR-0157 증보 1이 실측한 Cubelet eBPF `deny_out`은 이 VM들이 닫힌 채로 출하된다고 말한다. 즉 workd가 게시할 `display_endpoint`가 오늘 무엇으로 resolve되는지 정의되어 있지 않다. 이것은 **provisioning 질문이지 capability plane 질문이 아니라** 이 goal의 서버 축은 어느 쪽이든 완결이지만(host가 고른 endpoint를 그대로 내준다), LIVE-2는 이 답 없이는 아무것도 렌더할 수 없다. 세 가지 모양(전용 호스트 리버스 프록시 / oort 운영 TURN = D3 증보 / per-sandbox 공개 포트)을 적어 두고 **고르지 않았다**.
- **`owner_only` 세션의 소유자도 자기 화면을 못 본다 — 발명하지 않고 보고한다.** display에 controller 등급이 없으므로, PTY 축에서 소유자가 controller로 들어가던 문이 이쪽에는 없다. `owner_only`가 "소유자만 본다"인지 "아무도 안 본다"인지는 권한 결정이고, 소유자 예외를 여기서 만드는 것이야말로 금지된 새 권한 모델이었을 것이다. fail-closed 방향(거절)으로 구현하고 conformance에 그 403을 못으로 박았다 — LIVE-2가 부딪히기 전에 결정이 필요하다.
- **게이트:** 신규 `scripts/verify_display_attach.sh`(4 phase — 소유권 계약 `--verify-cleanup-contract` 자체 자가검증 포함, 라벨·trap·3상태 부재 증명, Docker 잔존 0) PASS. 무회귀 재실행 전부 PASS: `verify_terminal_attach.sh`·`verify_observer_attach.sh`(Swift e2e 스택 — 075가 현행 서버와 호환임을 함께 증명)·`verify_agent_port.sh`(2 phase, deploy 이미지 재빌드 포함)·`reattach_smoke_pg`·`t3_smoke_pg`·`work_control_spawn_conformance_pg`·`daemon_ack_resume_conformance_pg`. 워크스페이스 clippy `-D warnings`·`cargo test --workspace` 101 스위트 전부 ok·소유 파일 fmt·`check_migration_numbers.sh` 75 PASS(대비 테스트 `discovers_contiguous_migrations_001_to_075`). 로컬 docs gate는 #1376에 따라 실행하지 않았다 — 문서 정확성은 PR CI 관문이다.
- 근거는 **ADR-0165(Proposed — 전송 방향은 성재 결재 완료, 문서 Accept가 머지 관문)**. 웹 렌더(WebRTC 소비·관전 UI·design-review)는 LIVE-2, control과 로그인 핸드오프는 ADR-0004 증보 3 Accept 뒤의 LIVE-3/4다. `scripts/openapi_sampled_on_rust.txt`에는 **줄을 더하지 않았다** — 그 목록의 주장은 "Rust에서 실측됐다"이고, display 3경로를 배포 이미지 컴포즈에서 왕복시키지 않았기 때문이다.

## Bring your hosted agent 페어링 마법사 (web/Tauri) (#1360, 2026-08-15)

- **다섯 단계가 서버 상태에서 도출된다.** `/agents` 헤더의 「호스티드 에이전트 연결」 하나가 진입점이고, 그 다이얼로그는 자기 진행도를 세지 않는다 — `hostedWizardStep(connection, pairingRevealed)`가 `pairing_pending|detected|active|expired|cleanup_pending|disconnected` 하나에서 화면을 고른다. 이 흐름의 절반이 **다른 프로세스가 일으키는 사건**이기 때문이다(감지는 상대 에이전트의 다이얼인, 활성은 그 에이전트의 자격증명 증명). 로컬 카운터를 두면 새로고침·재접속·다른 탭이 각자 다른 진행도로 같은 커넥션을 설명한다. 지역 상태는 서버가 알 수 없는 하나뿐이다: **지금 비밀값이 화면에 떠 있는가.**
- **`detected`는 화면 둘이다(승인이 상태를 바꾸지 않는다).** HAP-E3의 `confirm`은 `status='detected'`를 유지한 채 `active_token_id`만 채운다. 그래서 승인 전(4단계)과 증명 대기(5단계)를 `activeCredentialId`의 유무로 가른다. 상태 이름만 보고 화면을 고르면 승인 직후 화면이 4단계로 되돌아가고 사람은 방금 한 승인을 한 번 더 하려 든다. `hostedStatusDetail`도 같은 이유로 그 상태에 두 문장을 갖는다.
- **비밀값 둘, 규율 하나.** 연결 값(pairing)과 active 자격증명은 서로 다른 비밀이고(ADR-0162 D6) 둘 다 컴포넌트 상태에서만 산다. 쿼리 캐시·localStorage·sessionStorage·IndexedDB·URL·로그 어디에도 가지 않고, 넷 중 무엇이 일어나도 메모리 사본이 버려진다 — ①「저장했습니다」 ②다이얼로그 언마운트 ③만료·재발급 ④**서버 상태가 그 값을 소비했다고 말할 때**(감지된 뒤의 연결 값은 죽은 문자열이라 화면에 남기면 아직 쓸 수 있는 값처럼 보인다). 값이 떠 있는 동안 Esc와 바깥 클릭은 다이얼로그가 막고, 나가는 길은 이름으로 하나다.
- **웹훅 R2가 힙에서 찾아낸 리테이너 경로를 그대로 막았다.** `Window → DOMTimer → [closure] → Query.options.queryFn → 렌더 스코프 → 비밀값`. 그래서 목록·단건·워크스페이스 쿼리 옵션이 전부 **모듈 스코프**(`hostedCredentialScope.ts`)에서 나오고, 원문을 나르는 mutation 셋(create·regenerate·confirm)이 한 키를 공유하며 `gcTime: 0` + 언마운트 purge 아래 있다. 스위트가 캐시의 **모양**을 재고(비공허성 대조 포함), 소스 스캔이 마법사에 인라인 `queryFn`·저장소 호출·`console.*`·`disconnect` 경로가 0인 것을 못으로 박는다. 힙 도달 가능성 자체를 재는 게이트는 웹훅에만 있고 이 표면에는 아직 없다.
- **승인은 사람의 보안 결정이고, 화면은 그것을 읽을 수 있게 적는다.** 권한 여섯 줄이 각자 결과 문장을 상시 노출하고(hover 뒤가 아니다), 고른 것 전체의 결과가 저장 버튼 바로 위에 한 문단으로 선다 — 허락한 것과 **닫히는 것**을 함께 말한다(#1366의 claim SQL이 승인 밖 채널 작업을 lease하지 않는다는 사실이 그 두 번째 문장이다). 자격 없는 줄(1:1 대화·보관 채널)은 숨기지 않고 사유와 함께 서고, 전송 본문에는 실리지 않는다(fail-closed). `agent:port:connect`는 잠긴 채 켜져 있고 왜 잠겼는지 그 줄이 말한다.
- **아직 실측되지 않은 것을 실측된 것처럼 말하지 않는다.** Grok preset은 `verified: false`이고 "Grok이 이 인증 헤더를 실제로 보내는지는 아직 확인되지 않았습니다"를 preset 옆에 붙인다(#1344의 404가 auth challenge보다 먼저 끝났다 — ADR-0162 D8). OAuth는 목록에서 지우지 않고 **비활성 + 사유**로 세우며, 우리가 모르는 날짜를 약속하지 않고 실패 뒤 static bearer로 내려가는 경로가 없다. 테스트 멘션은 `status === 'active'`이고 승인 채널이 있을 때만 열리며, 여는 것은 채널이지 UI가 지어내는 성공이 아니다.
- **네 상태와 복구.** 빈(다이얼인 대기·승인할 채널 없음)·로딩(목록/단건 스켈레톤 + `role="status"`)·오류(인라인 배너 + 다시 시도, 서버 영어를 잇지 않고 STATUS로만 분기)·오프라인(값 발급과 승인을 닫는 배너)이 전부 있다. 다시 열면 진행 중인 연결 목록이 먼저 서므로 새로고침·재접속이 자리를 잃지 않고, 만료는 자기 단계 번호를 갖지 않고 가로막은 2단계 번호를 쓴다. 표면 판정(`hostedAgentPairing`)이 진입점을 정적으로 세우고, 표가 틀린 서버에서는 `serverSaysAbsent`가 404를 장애가 아니라 미제공으로 접는다.
- **캡처 레인이 결함 둘을 잡았다.** `scripts/capture-screens.mjs`에 상태별 9장 × 2스킴 레인을 더했다(identity·pairing·detecting·approval·awaiting-proof·active·expired·error·loading). ①목록 조회가 실패하면 화면이 1단계로 떨어져 **읽지 못한 목록이 "연결 없음"처럼** 보였다 — 이미 연결이 있는 사람에게 새로 만들라고 권하는 판이고 오류 배너가 설 자리도 없었다. ②활성 화면의 멘션 문장이 조사를 손으로 적어 `@kim-intern 을`이 나갔다 — 핸들은 라틴 문자로 끝나는 것이 기본이라 그 자리는 코어의 조사 판정이 정해야 한다.
- **게이트:** core 1261 tests / web 909 tests / 폰 1144 tests GREEN, core+web typecheck·lint GREEN, purity 136 files 0 escapes, `design_preflight_web.sh` web 10/10 + core 3/3, `verify_merge_tree.sh --install`(base `track/engine`) 8레인 전부 green. 신규 테스트는 core 88 + web 13이고 RED PROOF 19개를 이름으로 명시했다. 실행 중 만난 폰 스위트 RED 1건은 `clients/mobile/__tests__/inboxApproval.test.tsx`의 선재 flake로 확인했다(base 리버트 상태에서도 재현, 재실행 시 green). 해제 흐름(UX2 / #1362)과 힙 스냅샷 게이트, Tauri smoke는 이 goal 범위 밖으로 남긴다.
## MCP OAuth 2.1 authorization-server mode — bearer downgrade 없이 (#1368, 2026-08-15)

- **기본값은 "존재하지 않음"이다.** `MOMO_AGENT_PORT_OAUTH_ENABLED`가 정확히 소문자 `true`이고 issuer·consent URL·client allowlist가 모두 유효할 때만 표면이 생긴다. 그 전에는 RFC 9728 protected-resource metadata도 RFC 8414 authorization-server metadata도 없고 `/v1/oauth/{authorize,token,revoke}`가 **404 + 빈 본문**이며(503이 아니다 — 꺼진 authorization server는 바쁜 게 아니라 없는 것이다), OAuth envelope을 Agent Port에 제시해도 다른 미인식 문자열과 같은 `invalid_token` challenge를 받는다. 그래서 flag 자체가 probe 대상이 되지 않는다. route는 조건 없이 mount하므로 router 모양이 운영자 설정을 누설하지도 않는다.
- **no-downgrade가 이 goal의 척추이고, 증명은 byte 비교다.** flag만 다른 두 서버를 동시에 띄우고 static bearer 사다리 네 단(자격증명 없음 → connect scope 없는 live bearer → 미인식 envelope → 실제 hosted static bearer의 `tools/list`)을 양쪽에 보내 status·`WWW-Authenticate`·`Cache-Control`·**응답 본문 바이트**가 모두 같음을 단언한다. 여기에 더해 두 challenge 문자열(`Bearer scope="agent:port:connect"`, `Bearer error="insufficient_scope", scope="agent:port:connect"`)을 frozen literal로 고정해, 양쪽을 함께 바꾼 변경도 통과하지 못하게 했다.
- **credential 4종은 서로 승격되지 않는다 — 산술적으로.** 저장 digest가 envelope **전체**를 덮으므로 같은 secret bytes를 다른 prefix로 다시 라벨링하면 어떤 row와도 일치하지 않는다. static→oauth, oauth→static, refresh→access, oauth→pairing 네 방향을 전부 401로 확인했고, 같은 시점에 진짜 access credential은 200이다. 그리고 credential class와 connection의 `auth_mode` 일치는 **migration 074의 trigger**가 강제한다 — `oauth` connection에 `hosted_active`를, `static_bearer` connection에 OAuth class를 INSERT하면 DB가 거절한다. "OAuth 실패 뒤 static bearer로 자동 강등"이 관례가 아니라 스키마상 표현 불가능해진 지점이다.
- **issuer·resource는 설정에서만 온다.** `Host`·`X-Forwarded-Host`·`X-Forwarded-Proto`·`Forwarded`를 모두 스푸핑한 요청에도 metadata가 운영자 값을 그대로 답한다. 광고하는 것은 구현한 것뿐이다: `authorization_code`+`refresh_token`, `code`, `S256`, `none` client auth, revocation endpoint, RFC 9207 `iss`. `registration_endpoint`·Client ID Metadata Document·`client_secret`·introspection·`plain`은 문서 어디에도 없다 — **DCR과 URL-form CIMD는 구현하지도 fetch하지도 않는다**(그 SSRF 표면은 별도 ADR과 threat model이 먼저다).
- **unauthenticated endpoint는 ledger를 키우지 않는다.** `GET /v1/oauth/authorize`는 row를 0건 쓴다. 등록 client·byte-exact redirect·canonical resource·S256·scope 상한을 검증한 뒤 server가 서명한 단기 envelope(nonce 포함)만 consent 화면에 넘기고, 그 URL에는 verifier·token·code·secret이 없다. **검사 순서가 open-redirect 방어다**: client_id와 redirect_uri가 allowlist를 통과하기 전의 실패는 브라우저를 어디로도 보내지 않는 400이고, 통과한 뒤에야 실패가 등록된 URI로의 error redirect가 된다.
- **동의는 로그인한 owner/admin의 것이고, terminal decision은 nonce당 정확히 하나다.** 일반 member·agent bearer·cross-workspace는 non-enumerable하게 닫히고 거절은 row를 남기지 않는다. duplicate approve·늦은 deny는 409로 inert하며, 승인 직후 connection은 `detected`이고 전용 agent는 **여전히 `paused=true`**다 — 동의는 활성화가 아니다. 거부는 connection을 `pairing_pending` 그대로 두고 자격증명을 0건 만든 뒤 표준 `error=access_denied`&`state`&`iss` redirect를 돌려준다.
- **scope 상한은 static confirm과 같은 validator다.** `work:control`·`realtime:subscribe`·`provider:quota:write`는 물론, 상한 안이지만 이번 요청이 **요구하지 않은** scope도 code 발급 전에 거절되고 각각 bounded denial audit 1행을 남긴다(secret·digest 없음 — audit 전수 스캔으로 확인). 필수 `agent:port:connect` 누락도 거절이다.
- **교환은 한 transaction이고, 공격 매트릭스는 전부 code-only 본문으로 닫힌다.** 성공 시 code 1회 소비 + access/refresh 발급 + `active` 전이 + 전용 agent unpause가 함께 커밋된다(`expires_in` 1800, `Cache-Control: no-store`, 저장은 digest뿐). 거절 10종 — 잘못된 verifier, 빈 verifier, challenge를 verifier로 제시, 다른 등록 redirect, 미등록 redirect, 잘못된 resource, resource 누락, 미등록 client, 타 workspace code, 미지원 grant — 은 모두 `{"error": ...}` 한 키짜리 본문이고, 그 뒤에도 정직한 교환은 여전히 성공한다(= 매트릭스가 code를 소모하지 않았다는 증거). 만료 code는 `invalid_grant`이고 connection은 `detected`에 머문다.
- **회전·재사용·폐기.** refresh는 access와 refresh를 함께 갈아끼우고(partial unique index가 옛 쌍 revoke를 선택이 아니라 필수로 만든다), 직전 access는 즉시 401이 된다. 회전으로 버려진 refresh를 다시 제시하면 침해 신호로 취급해 **거절과 같은 transaction에서** 그 connection의 live OAuth credential 전부를 revoke하고 audit 1행을 남긴다 — code replay도 동일하다. RFC 7009 revocation은 모르는 token·다른 모양의 token·진짜 token 모두 200이라 존재 oracle이 아니며, 한쪽을 폐기하면 나머지 반쪽도 함께 죽는다.
- **발급된 OAuth credential은 canonical resource에서만 principal이다.** message POST, gateway pending/renew/complete, realtime-token REST 다섯 경로에 직접 제시하면 401/403이고 message row 수는 변하지 않는다. 같은 credential이 Agent Port에서는 승인된 `messages:read`에 대응하는 `oort_conversation_read`만 보고 `oort_message_post`는 보지 못한다.
- migration 074(`hosted_oauth_authorization_request` + FORCE RLS + 두 OAuth credential class + class↔auth_mode trigger + 회전 강제 partial unique index) 신설, `schema_v0.sql` 무변경. 전용 Docker-only PG18 verifier `scripts/verify_agent_port_oauth.sh`(19 시나리오)가 위 전부를 실제 Axum router로 PASS했고, `verify_agent_port_tools.sh`(E5)·`verify_hosted_disconnect.sh`(E6)·`verify_hosted_agent_inbox.sh`(E4)·`verify_agent_credentials_rust.sh`(E1) 재실행 무회귀 PASS, Docker 잔존 0.
- 근거는 **ADR-0162 증보 1(Proposed — 성재 최종 승인 대기)**. flag를 여는 것은 그 승인과 #1369 consent UX 랜딩, runtime proof 폐곡선 뒤의 별도 운영 결정이다. web consent 화면과 wizard 복귀는 #1369 소유로 남긴다.

## Hosted agent 원자적 disconnect · cleanup-confirmed terminal (#1367, 2026-08-14)

- **disconnect 시작 = 한 tenant transaction.** `POST .../hosted-agent-connections/{id}/disconnect`가 이 커넥션의 live bearer revoke, `cleanup_pending` 전이, 전용 agent pause, 열린 gateway job 억제(`status='done'` + `last_error='hosted connection disconnected'` + lease 컬럼 회수), 종류별 artifact manifest seed, audit 1행을 함께 커밋한다. 하나라도 실패하면 전부 롤백한다 — verifier는 `agent_profile` 행을 지워 pause를 실패시키고 500 뒤 커넥션이 `active`·자격증명이 live·manifest 0행·audit 0행으로 남는 것을 확인한다. 재시도는 같은 답(`startedNow:false`)이고 아무것도 쓰지 않는다(audit 증폭 없음).
- **잠금 순서와 revoke 범위.** 새 transaction도 HAP-E4 계약(`connection → token → member → membership → profile`)을 그대로 지킨다. 8개 tool·gateway 동사·inbox는 이미 `resolve_hosted_tool_identity_in_tx`에서 커넥션을 `FOR SHARE`로 잡으므로 disconnect의 `FOR UPDATE`는 진행 중인 호출을 기다렸다가 직렬화된다. revoke는 `hosted_connection_id` 한정이라 같은 agent의 형제 커넥션 토큰을 회수하지 않는다 — #1374가 추적하는 prove-path AB-BA와 정합한 방향이며, 그 함수(`invalidate_hosted_lifecycle_in_tx`)는 이 goal에서 건드리지 않았다.
- **artifact manifest는 jsonb가 아니라 행이다(마이그레이션 072).** `bot`·`routine`·`plugin`·`connector`·`local_plugin_files`·`secret` 각각 seed 행 하나 + 호출자가 이름 붙인 항목마다 한 행이며, expected action·current status·disposition·source·actor·acknowledged-at·evidence를 기록한다. `resolved`는 `disposition`만으로 계산되는 generated column이라 결정 없이 결론만 쓸 수 없다. #1344 실측 3건이 그대로 스키마다: connector 해제가 `local_plugin_files`를 자동 충족하지 않고(다른 행, 한 행이 다른 행을 쓰는 경로 없음), inactive routine은 `current_status`일 뿐이라 resolved가 되지 않으며, `bot`만 `preserved`가 합법 terminal이다(bot 삭제는 chat history까지 지운다 — oort는 대신 지우지 않는다).
- **server-verified와 manual을 구분한다.** `source='server_verified'`는 이 서버가 직접 revoke하고 되읽을 수 있는 단 하나, seed된 `secret` 행에만 허용된다(CHECK로 강제). 나머지는 전부 `manual`이며 actor + 1~2000바이트 evidence를 요구한다. acknowledge 라우트는 request body에서 `source`를 읽지 않으므로 client가 자기 주장을 server-verified로 승격할 수 없고, disposition 없는 호출은 관찰만 기록한다(= inactive routine의 자리).
- **terminal은 정확히 한 번.** `disconnected` 전이는 required artifact가 전부 resolved이고 로컬 절반(이 커넥션 live credential 0 + agent paused)이 서버 판독으로 확인될 때만 일어나며, 재생은 200 `disconnectedNow:false`에 audit 0행 추가다. 마이그레이션 072의 트리거는 같은 계약을 **네 절**로 다시 단언한다 — ①`OLD.status='cleanup_pending'`(terminal의 선행 상태는 하나), ②manifest **비어 있지 않음**, ③required artifact 미해결 0건, ④live credential 0 + agent paused. ②가 필요한 이유는 ③이 **빈 manifest에서 공허하게 참**이기 때문이다: disconnect start를 건너뛴 repair script(revoke+pause+직접 UPDATE)는 artifact 행이 0건이라 ③을 그대로 통과했다. Rust `complete_hosted_disconnect_in_tx`에도 같은 두 관문을 미러링해 DB와 한 계약을 말하고, verifier는 네 절 각각을 **거절 메시지까지** 단언한다(어느 절이 막았는지). INSERT-with-terminal-status 우회·terminal 이탈(disconnected→detected) 가드·`acknowledged_by` FK 쐐기·retry-seed 병합은 #1386 소유로 남긴다.
- **만료·운영자 emergency revoke 화해.** 커넥션이 스스로 가리키는 `active_token_id`가 죽어 있으면 첫 domain guard가 capability 수행 전에 같은 fail-closed tx로 token 무효화·pause·`cleanup_pending`·job 억제·audit을 맞춘다. 두 진입점 모두 덮었다 — bearer resolution이 revoked/expired로 조기 거절하는 경로와, member 정지/membership 상실로 proof가 실패하는 경로. 발동 조건은 **제시된 자격증명이 커넥션의 현재 active token일 때뿐**이라, 오래전 폐기된 토큰으로 살아 있는 커넥션을 끌어내릴 수 없다. hosted member의 generic credential issue/rotate/revoke는 여전히 409 `hosted_connection_managed`다.
- **즉시 효력·재접속·혼합 워크스페이스.** disconnect 커밋 뒤 8개 tool 전부·gateway renew/release/complete(방금 발급된 lease handle 포함)·inbox cursor·foundation request가 모두 닫힌다. 재접속은 새 pairing/자격증명/connection namespace를 요구하고 옛 bearer(401)·옛 sealed lease handle(403 `-32003`)·옛 cursor(409 `-32004`)는 계속 실패한다. 같은 워크스페이스의 형제 hosted agent와 managed agent는 영향 없음을 런타임으로 확인했다. message/chat/audit/inbox 이력은 전부 보존되고 cascade delete는 없다.
- **생산 게이트 개방(E5 이관분 종결).** `MOMO_HOSTED_DELIVERY_ENABLED` 수용의 `#[cfg(debug_assertions)]` 제한을 제거했다. 이제 release 빌드도 이 변수를 읽지만 **기본값은 여전히 closed**이고 정확히 소문자 `true` 한 철자만 연다(`True`/`TRUE`/`1`/`yes`/`on`은 닫힘 — 오타가 전달 경로를 열 수 없다). 직접 `AgentPortConfig` 구성이 환경변수를 이기는 override는 그대로라 verifier/fixture는 machine-wide 변수 없이 선택기를 연다. 프로덕션 활성화는 이 disconnect 수명주기를 근거로 한 **운영자의 명시적 결정**이 됐다.
- 전용 Docker-only PG18 verifier `scripts/verify_hosted_disconnect.sh`(8 시나리오)가 위 전부를 실제 Axum router로 확인하고, `verify_agent_port_tools.sh`(E5)·`verify_hosted_agent_inbox.sh`(E4)·`verify_agent_port.sh`(E2/E3)를 최종 트리에서 재실행해 무회귀를 확인했다. E5/E4 fixture 중 `disconnected`를 직접 조작하던 두 곳은 이제 로컬 절반(revoke+pause)을 실제로 수행한 뒤 전이한다 — 072 트리거가 조작된 terminal을 거절하기 때문이며, 그 자체가 불변식의 증거다.

## Hosted agent MCP tool surface · per-agent hosted delivery (#1366, 2026-08-14)

- Agent Port에 8개 thin-binding tool(`oort_inbox_read`·`oort_conversation_read`·`oort_message_post`·`oort_jobs_claim`·`oort_job_renew`·`oort_job_release`·`oort_run_event`·`oort_run_complete`)을 열었다. `tools/list`와 `tools/call`은 하나의 `ToolView`(connection 승인 scope × 현재 token scope × server capability 교집합)를 공유해 광고된 목록과 호출 가능 목록이 구조적으로 어긋나질 수 없다. `agent:port:connect`는 어느 tool의 `required_scope`에도 없으므로 connect-only credential은 빈 카탈로그를 보고 아무것도 호출하지 못한다. 보이지 않는 tool과 존재하지 않는 tool은 byte 동일한 응답이라 catalog 열거가 불가능하다.
- gateway completion이 쓰는 답변도 hosted inbox에 투영된다. 그 답변은 product send spine이 아니라 raw `send_message_in_tx`로 쓰이므로 fan-out을 상속하지 않고, 호출을 넣지 않으면 한 채널을 공유하는 hosted agent가 다른 agent의 답변을 durable inbox에서 **영원히 못 본다**. 같은 transaction 안에서 fan-out하며 author는 제외된다(자기 답변을 되읽지 않는다). terminal replay 분기는 새 message를 쓰지 않으므로 append도 필요 없다(그리고 append 자체가 멱등이다).
- 모든 tool은 기존 domain을 그대로 호출한다. `oort_message_post`는 REST send와 **같은** `send_message_with_mentions_in_tx`(channel_seq·client_msg_id 멱등성·message INSERT + outbox INSERT)를 쓰고, job/lease는 기존 gateway lease 동사와 동일하며(claim만 hosted 분기를 가진 단일 문), run event/complete는 REST handler에서 추출한 `record_gateway_event_in_tx`/`complete_gateway_run_in_tx`를 양쪽 문이 공유한다. MCP 쪽에는 message/outbox 직접 INSERT도, Centrifugo 직접 publish도 없다. client가 보는 것은 AEAD로 봉인된 `leaseHandle`뿐이고 job id·lease owner·run id·inbox 순번·raw cursor는 나가지 않는다. 실패는 5개 고정 응답이라 "없음/보이지 않음/금지" 구분이 새지 않는다.
- **인간의 exact-channel 승인이 job 경로까지 관통한다.** hosted connection은 HAP-E3 confirm에서 *지정된 채널 집합*으로만 승인되며, 채널 멤버십은 그 승인이 아니다. selector는 승인 밖 채널의 mention에 job을 만들지 않고 `hosted_channel_unapproved`로 skip하며, **권위는 claim SQL**이다 — hosted claim은 job payload의 channel_id가 connection의 현재 `approved_channel_ids`에 있어야만 후보로 삼으므로 승인 밖 job은 lease되지 않고 `pending`으로 남는다(프롬프트·최근 메시지가 나가지 않는다). 승인을 뒤늦게 좁혀도 다음 claim이 멈추고, 이미 쥔 lease도 멈춘다: `leaseHandle` 봉투에 channel_id를 봉인해 renew/release/event/complete가 매 호출 현재 승인 집합을 재확인한다. claim 술어만 제거해도 적대 테스트가 RED가 된다(mutation 확인).
- **광고한 스키마가 곧 집행되는 스키마다 — 필드 단위로.** `tools/call` 인자는 카탈로그가 게시한 input schema로 `momo-mcp`에서 검증되며, 지금 집행되는 키워드는 정확히 다음이다: `additionalProperties:false`(오타 `rootID`가 조용히 unthreaded 게시되던 결함), `required`, 선언된 nullability, `minimum`/`maximum`, `minLength`/`maxLength`, `format:uuid`, `enum`, 중첩 object. 세 가지를 명시한다.
  - **nullability 계약**: 8개 도구의 **모든 optional 속성은 `["<type>","null"]`로 선언**되고 required 속성은 선언되지 않는다. adapter의 reader가 optional 필드의 `null`을 "없음"으로 균일하게 취급하기 때문이며, required 필드의 `null`은 키 부재와 똑같이 거절된다. 이 대응은 `the_nullability_contract_holds_for_every_tool`이 기계적으로 검사하므로 한쪽에만 필드를 추가할 수 없다.
  - **길이는 문자가 아니라 UTF-8 바이트**다(도메인 상한이 바이트이므로). validator가 바이트로 세고, 각 필드 description이 그 단위를 명시하며, adapter reader 상한도 게시된 숫자와 동일하게 맞췄다(`detail` 2048·`textDelta` 8192 등). 이모지 2,001자(8,004바이트)는 8,000 상한에서 두 층이 같은 경계로 거절한다.
  - **토큰 수 상한 선언**: 4개 토큰 필드가 `minimum:0`+`maximum:2147483647`을 선언해 ledger의 i32 컬럼 좁힘과 스키마가 정확히 일치한다. 음수·초과는 스키마와 기록 경계(`bounded_token_count`) 양쪽에서 거절되어 workspace 사용량 총계를 깎거나 넘칠 수 없다(landed `usage_ledger`의 CHECK 추가는 #1375 hygiene 후보로 남긴다).
  모든 위반은 adapter의 invalid-arguments와 **byte 동일**한 하나의 응답이라 새 열거 oracle이 생기지 않는다.
- per-agent selector는 전역 provider mode와 무관하게 agent 자신의 active hosted connection을 보고 hosted gateway로 라우팅하며, active가 아닌 hosted agent는 **managed로 fallback하지 않고** `hosted_connection_unavailable`로 skip된다(job도 run도 0건). 생산 feature gate는 **release 빌드에서 구조적으로 도달 불가**다: `MOMO_HOSTED_DELIVERY_ENABLED` 수용이 `#[cfg(debug_assertions)]` 아래에만 컴파일되므로 release 바이너리는 환경변수와 무관하게 항상 `false`이고(설정돼 있으면 무시했다고 warn), 테스트·verifier는 debug 빌드이며 `AgentPortConfig`를 직접 구성한다. `cfg` 제거는 HAP-E6(#1367) 소유다.
- **M1 폐곡선(DB 강제 선택)**: migration 071이 (a) `outbox`에 kind 포함 unique index + `hosted_agent_inbox_event.source_outbox_kind` generated column으로 outbox FK에 `kind`를 결속하고, (b) `agent_job` 참조가 이 agent의 `gateway` job이며 `payload.run_id`가 참조된 run과 일치함을 BEFORE INSERT trigger로 강제한다. trigger를 쓴 이유는 job의 run 신원이 `outbox.payload` jsonb에 있어 FK로 표현하려면 hot table을 rewrite하는 stored generated column이 필요하고, 그것은 non-uuid run_id를 가진 legacy row에서 즉시 실패하기 때문이다. producer는 둘 다 원본 transaction 안에서 append한다(send tx / job·run mutation tx) — tombstone 참조 문제도 이 배치로 닫힌다.
- **cursor secret 회전 계약**: cursor 봉투에 key-id를 넣지 **않는다**. 넣으면 opaque token에 rotation-epoch oracle이 생기고 dual-secret 수용 창이 필요해진다. 대신 계약은 "cursor secret은 connection era에 결속된다 — 회전은 계약상 disconnect와 같고 hosted connection은 재-pairing해야 한다"다. 열리지 않는 cursor는 조용히 처음부터 재전송하는 것이 아니라 fail-closed 거절로 끝나며(runtime verifier가 이를 고정), 운영자-facing 강제 재-pairing 구현은 #1367 소유다.
- 측정된 결함 1건을 함께 닫았다: gateway lease 술어가 `payload->>'...'`를 원문 비교해 왔는데 이 서버의 mention producer는 uuid를 대문자로, work/resume producer는 소문자로 쓴다. 그래서 **mention job은 gateway 경로로 claim·renew·release·settle이 아예 불가능**했다. `lower()` 양변 적용은 `retire_pending_agent_jobs_for_run_in_tx`가 이미 같은 이유로 문서화한 최소 수정이며, MCP 분기가 아니라 **관리형 REST gateway 표면에서** red proof를 세웠다(`a_managed_mention_job_survives_the_whole_rest_gateway_round_trip` — `lower()` 어느 쪽을 되돌려도 claim이 빈 목록이 된다).
- **배포 창 체크리스트(운영 단계, 코드 아님)**: 이 수정이 발효되면 그동안 대문자 payload 때문에 claim되지 못하고 `pending`으로 쌓여 있던 mention job이 처음으로 관리형 gateway에 노출된다. 배포 전 `SELECT count(*) FROM outbox WHERE kind='agent_job' AND method='gateway' AND status='pending' AND available_at <= now()`로 잔여 backlog를 세고, 규모가 크면 gateway consumer가 한꺼번에 집어삼키지 않도록 배포 창을 잡거나 오래된 행을 먼저 은퇴시킨다. 이건 배포 절차이지 이 goal의 코드 변경이 아니다.
- 전용 Docker-only PG18 verifier `scripts/verify_agent_port_tools.sh`가 producer/kind 폐곡선(kind 혼동·job↔run 불일치·cross-channel·타 agent job·깨진 shape 전부 DB 거절), token audience/actor/connection 축, lifecycle별 catalog(terminal은 401), 단일 write path + 중복 전송 시 outbox 1행, lease race, 멱등 terminal 규칙과 usage 1행, mixed managed+hosted, inactive-hosted no-fallback을 PASS했고 #1365 verifier도 무회귀 PASS다. Docker 잔존은 0이다. OAuth·disconnect cleanup·UI는 #1367/#1360/#1362 소유로 남긴다.

## Hosted agent durable inbox foundation (#1365, 2026-08-14)

- migration 070에 active hosted connection별 row counter와 append-only source-reference ledger를 추가했다. message body·credential은 복제하지 않고 원본 `(workspace,message,channel,message_seq)`를 FK로 결속하며, connection history 삭제는 RESTRICT, 두 테이블은 FORCE RLS다. `inbox_seq`는 connection-local `UPDATE ... RETURNING`으로 발급되고 source retry는 unique reference로 멱등이다.
- Rust domain은 exact active token/connection/actor/audience, non-default `agent:inbox:read`, active member/workspace membership, unpaused profile, approved+current channel membership을 같은 tenant transaction에서 잠근다. AES-256-GCM cursor는 version/workspace/agent/connection/position에 결속되고 malformed·wrong binding·inactive authority를 동일 unavailable로 닫는다. visibility가 회수된 ledger row도 scan watermark는 전진해, 보유 중인 cursor로는 복원 후 과거 content가 재생되지 않는다(cursor 없이 처음부터 재조회하는 것은 재인가된 정상 열람이며 이 보증의 대상이 아니다).
- 전용 Docker-only verifier의 fresh pinned PG18에서 two-channel seq collision, concurrent retry, rollback, RLS/FORCE, append-only, scope/profile/channel revocation, disconnect history 보존과 reconnect cursor namespace가 PASS했다. MCP tool 노출 및 실제 message/job/run producer wiring은 #1366 범위라 아직 열지 않았다.

## Hosted agent dedicated pairing·activation lifecycle (#1364, 2026-08-13)

- `static_bearer` 전용 hosted connection이 dedicated paused agent identity와 일회성 pairing challenge를 원자 생성하고, protocol-valid foundation request의 `pairing_pending → detected`, human confirm의 exact channel/closed scope 승인과 별도 active credential 발급, 첫 valid proof의 `active` 전환+unpause를 tenant transaction으로 닫는다. Hosted bearer는 exact `/v1/mcp/agent-port` 외 REST에서 거절되고 generic credential mutation은 409+bounded audit이며, E5/E6 전 mention/run/A2A/gateway/worker delivery·claim은 이중 차단된다. PostgreSQL 18 001→069/RLS FORCE, Rust fmt·clippy·workspace test, generated OpenAPI와 Rust image lifecycle이 green이고 실제 concurrent confirm/proof 및 regenerate↔detect/confirm race, cross-workspace non-enumeration, injected activation-audit failure의 zero-partial rollback까지 실측했다. OAuth/provider delivery/inbox/data tools/UI는 후속이라 열지 않았다.

## Hosted Agent Port dual-era foundation (#1363, 2026-08-13)

- Rust에 sessionless `POST /v1/mcp/agent-port`를 추가해 modern `2026-07-28` discovery/empty tools와 exact legacy `2025-11-25` initialize/initialized/ping/empty tools를 분리했다. 첫 wave는 `agent:port:connect` static agent bearer만 허용하며 product tool·message/job/inbox 쓰기·OAuth metadata는 열지 않는다.
- 실제 PostgreSQL 18 + `momo_app` NOBYPASSRLS router에서 active agent/workspace membership/scope를 매 요청 재검증하고, stable token/member UUID의 원자 limiter가 허용한 경우에만 `last_used_at`+used audit을 같은 tenant transaction으로 커밋한다. 반복·동시 429, 중간 revoke/membership 제거, human/inactive/cross-workspace, no product writes, deploy-image route를 전용 verifier에 고정했다. 공식 Grok private preset의 static bearer 소비와 실제 tool call은 후속 live E2E까지 `runtime-unverified`다.

## HAP-E1 generic agent bearer lifecycle Rust 이식 (#1358, 2026-08-12)

- Accepted ADR-0162의 generic bearer 경계를 Rust/Axum에 이식했다. owner/admin human만 agent credential을 발급·목록·회전·폐기할 수 있고, 발급값은 응답 한 번에만 `no-store`/`no-cache`로 노출된다. DB·목록·audit에는 digest와 비밀이 아닌 메타데이터만 남으며 ordinary member, agent bearer, 교차 workspace와 foreign agent/credential 조합은 fail-closed한다.
- scope는 닫힌 grantable 집합으로 정규화·중복 제거하고 unknown/empty를 거절한다. `provider:quota:write`는 instance operator만 추가할 수 있고, `agent:port:connect`·`agent:inbox:read`·`messages:read`는 발급 가능하지만 기본 scope에는 들어가지 않는다. expiry는 미래만 허용하고 expired/revoked bearer는 401, scope 부족은 403+감사로 남는다. 회전은 agent row lock과 한 tenant transaction으로 직렬화해 기존 만료를 연장하지 않으며 하나의 long-lived successor만 허용하고, revoke replay는 200이되 감사 행을 중복하지 않는다.
- hosted dedicated agent mutation은 #1364가 연결할 typed `HostedConnectionManaged` seam에서 409로 닫힌다. Rust workspace test·clippy·생성 타입 정합, 전용 PG18 HTTP conformance, Rust 이미지 actual-route OpenAPI 60/60(57 operation)이 green이다. Docker-only runtime verifier는 128-bit invocation 라벨·exact name·불변 ID를 tri-state inspect/list로 재검증하고 정상 경로에서도 삭제와 부재를 증명한 뒤에만 PASS한다(signal·rm-lie·list-error·탈취 fixture 포함). PG18 suite는 momo_app NOBYPASSRLS, token/audit FORCE RLS, wrong-GUC 불가시와 audit 실패 시 issue/revoke zero-partial rollback까지 단정한다. DDL과 `schema_v0.sql`은 변경하지 않았다.

## Grok Bot trial-first 실측 완료 — private MCP transport·Routine·cleanup (#1344, 2026-08-12)

- 성재가 공식 앱 설치와 ADR-0162 기술 방향을 승인한 뒤 Cursor 배포본 `Grok Bot 0.16.0`(`com.anysphere.sand`, arm64)을 설치했다. DMG SHA-256과 `hdiutil` checksum을 확인했고, app strict code-sign verification과 Gatekeeper `accepted`/`Notarized Developer ID`(Anysphere Incorporated `DCNK4UB866`)가 통과했다. team account는 `trialEligible=true`였지만 강제 `NO_STORAGE` 정책에 막혔고, personal account는 별도 trial entitlement/start 문구나 결제·구독 UI 없이 Bot 1개와 기본 채팅까지 동작했다. 구매·유료 전환은 0건이다.
- 공식 MIT `Create Plugin`을 설치해 비공개·미게시 로컬 plugin `oort-integration-trial`의 `plugin.json`과 `mcp.json`만으로 공개 `https://app.oor7.com/v1/mcp/agent-port`를 등록했다. Grok/Cursor loader는 legacy-era `POST initialize`와 fallback `GET`을 보냈고 둘 다 Caddy를 거쳐 HTTP/2 404 empty response로 끝나 UI가 `HTTP`·URL·`Tools 0`·`Failed to load`를 표시했다. 이는 custom MCP transport 도달을 검증하지만 Rust route 부재 전 단계의 auth challenge/mode·pairing·tool call은 검증하지 않는다. 공식 `Create Plugin` helper는 측정 뒤 uninstall했다.
- Active off·monthly trigger인 test routine은 저장됐고 수동 Test run이 약 1분 뒤 `OORT_ROUTINE_TRIAL_OK`로 `Succeeded`했다. Delete는 확인창 없이 즉시 목록에서 routine을 제거했다. connector Uninstall은 앱 connector 목록에서 제거했지만 로컬 plugin directory/files는 남겼고, 관측 뒤 test source만 recoverable Trash로 옮겼다. Bot Delete는 agent/chat history를 고지해 최종 삭제를 취소하고 Bot을 보존했다. 공식 Bot→owned-routine cascade는 문서로 확인했지만 live 미실측이고 connector/local-source cascade는 미문서·미실측이다. #1344의 **측정 goal은 완료**했으며 real pairing/auth/tool call/full E2E는 HAP-E2/E3 및 후속 Grok E2E의 `runtime-unverified`로 이관한다. account·Bot 표시명, 로컬 경로, screenshot, credential은 기록하지 않았다. 상세 redacted evidence는 `docs/planning/2026-08-12-grok-bot-trial-spike-report.md`에 있다.

## Bring your hosted agent · Grok pairing 기획 정합 (#1343, 2026-08-12)

- `ROADMAP.md`에 기존 v0 관전·승인·대화 임계경로를 대체하지 않는 병렬 런칭 보조축을 추가하고, 제품 문장을 **“Bring your hosted agent”**로 고정했다. Grok Bot은 코어 종속성이 아니라 첫 setup preset·실증 대상으로 두며, 공식 개인 one-time trial부터 확인하고 trial 미노출 시 구매하지 않는다.
- #1343 당시 ADR-0162는 `Proposed` 상태에서 bot-initiated pairing(`pairing_pending → detected → active`), pairing challenge와 active credential 분리, **one Bot=one connection=one dedicated agent member=one routine**, 별도 active proof와 같은 activation 경계의 member unpause, 기존 gateway/message spine의 MCP thin binding, channel-local `message.seq`와 별도 durable inbox cursor, revoke 후 routine·connector cleanup을 결정 후보로 정리했다. 이후 성재 승인으로 Accepted됐으며 ADR-0163 관리형 카탈로그와 #1345 ACP/self-hosted host 감사는 별도 deferred 축이다.
- #1343 자체는 문서·계획 정합만 수행해 제품/API/schema/runtime 동작을 바꾸지 않았다. 당시 `runtime-unverified`였던 Grok trial-first 측정 결과는 위 #1344 최신 섹션이 대체한다. 공개 credential/API/schema 구현은 #1358~#1369, M1, Project #44, native `blockedBy`, `BUILD_TICKETS.md`, ready handoff에 결속했으며 #1344 Accepted ADR landing 뒤 #1358/#1363부터 시작한다. #1363은 modern MCP 2026-07-28과 exact 2025-11-25 legacy adapter를 명시적으로 분리하고 첫 wave는 static bearer만 제공한다. OAuth AS·동의 UI는 #1368/#1369가 모두 닫힐 때까지 비활성이다.

## Rust/NCP Centrifugo internal-only edge · secret rotation evidence (#1329, 2026-08-12)

- `infra/rust/Caddyfile`이 일반 `/v1/*` 프록시보다 먼저 `/v1/centrifugo/*`를 explicit 403으로 끝내므로 no-header/wrong/current secret 어느 요청도 공개 엣지에서 API 인증 표면에 닿지 않는다. compose-private API의 기존 constant-time 경계(no/old 401, current + malformed body 400)는 바꾸지 않았고 schema/API/DB/제품 동작 변경은 없다.
- 정적 contract와 mutation/redaction fixture가 deny 누락·순서 역전·API/Centrifugo secret source drift·회전/rollback 문서 누락·과거 공개 401/401/400·hash 불일치·current 401·원문 evidence 유출을 fail-closed로 고정한다. H1 재리뷰 뒤 운영 verifier의 공개 origin은 canonical `infra/rust/Caddyfile` 단일 site에서만 파생하며, attacker/오타/포트/userinfo/path/query/fragment/punycode 불일치는 secret read·Docker exec·network 전에 거절한다. curl은 redirect를 따르지 않고 3xx를 RED로 본다. test-only loopback은 env-file `MOMO_ENV=test` + exact loopback allowlist + synthetic fixture secret을 모두 요구한다.
- `docs/runbooks/ncp-rust-deploy.md`에 같은 창의 api+centrifugo recreate, old-env 검증, rollback을 고정했다. 이 goal은 운영 secret·NCP 배포를 변경하지 않으므로 실제 `app.oor7.com` reload/403/hash equality/회전 증거는 승인된 배포 창 전까지 `runtime-unverified(public host)`다.

## Shell layout gate exact-source · 인셋 포커스 계약 (#1314, 2026-08-12)

- `gate:shell` 실행 파일 자체가 매번 현재 checkout의 build를 spawn·await하고, build 실패 또는 산출물 부재는 기존 `dist`가 있어도 preview 전에 fail-closed한다. 수리 전에는 source를 `-2px`로 복구한 뒤에도 앞서 `+2px`로 만든 산출물을 그대로 읽어 전체 gate가 거짓 PASS하는 것을 실측했고, package entrypoint 배선·stale 산출물 + 실패 build·실제 child-process exit 23 fixture가 재발을 RED로 고정한다.
- 포커스 단정은 값을 복사하지 않고 `tokens.css`의 `@utility focus-ring`을 읽어 `outline-offset == -outline-width`인 인셋 관계를 강제한다. `+2px` fixture는 RED, 실제 `2px/-2px`는 1280/900/760 전 구간과 기존 keyboard/layout 단정에서 PASS했다. 제품 CSS와 시각 디자인은 바꾸지 않았고 이 goal의 별도 `runtime-unverified`는 없다.

## GHCR 발행·셀프호스팅을 현행 Rust 스택으로 일치 (#1266, 2026-08-12)

- 수동 `publish-images` 경로가 은퇴 중인 Swift/QEMU arm64 이미지 대신 라이브와 같은 `server-rust/Dockerfile` 단일 이미지를 native `linux/amd64`로 짓는다. `MOMO_BUILD_SHA=github.sha`를 SPA·OCI revision에 동시에 각인하고 digest 보고·max provenance·SBOM·Apache-2.0 메타데이터를 유지한다. 모든 action은 full commit SHA로 pin됐고, `main` ref 검사와 GitHub `release` Environment owner 승인 경계를 통과한 pushed digest에 `actions/attest` SLSA provenance를 OCI referrer로 발급한다. `sha-<gitsha>`는 이동 가능한 commit locator이며 digest만 불변이다. arm64 공개 artifact는 아직 지원하지 않는다.
- `scripts/self_host_env.sh`는 `local-build`와 `published-digest`를 env에 기록하는 배타적 모드로 나뉘었다. 발행 모드는 `ghcr.io/yeomyeonggeori/oort@sha256:<64hex>`만 받고 build 오버레이·`--build`를 빼며, mutable tag·잘못된 digest·기존 env의 mode/digest 교체를 쓰기 전에 거절한다. 외부 env-file 값의 LF/CR을 공용 scalar guard로 차단하고 owner email/password는 dotenv-safe literal만 받으며 기존 파일도 재검증한다. 중복 키는 거절하고 포트는 ASCII 10진수 1..65535로 정규화한 뒤에만 산술·연결에 사용한다. 모든 실제 env key·canonical Compose interpolation·Compose control env를 실행 시 process env에서 제거하는 `--compose` launcher가 정본 file set만 호출하고, config-source 교체 argv도 거절한다. 실제 `docker compose config`에서 secret·DB URL·WS URL·3개 port·project/image ambient 충돌이 모두 파일 값으로 수렴하고 앱 소비자 7개가 exact digest임을 확인하며 시크릿은 stdout/오류에 출력하지 않는다.
- 구조·행동 계약은 main-ref guard, full-SHA action, registry push↔attestation subject name+digest+OCI referrer, deploy-lib의 exact repository+SLSA v1 검증, env newline/dotenv-metachar/duplicate/process override·Compose argv 우회와 산술 주입 RED fixture를 고정한다. 로컬 `buildx --platform linux/amd64 --load`는 실제 이미지를 완성했고, inspect에서 amd64·`momo` 사용자·entrypoint·build SHA/Apache label, 컨테이너 안에서 바이너리 6종+엔트리포인트·LICENSE/NOTICE·SPA SHA stamp, 잘못된 role의 exit 2, 이미지 env의 시크릿 키 0개를 확인했다. `release` Environment는 attended readback으로 required reviewer `kwakseongjae`(id `87296259`)·`prevent_self_review=false`·custom branch policy `main` 하나를 확인했다(무 dispatch). 첫 GHCR publish·실 digest 핀·익명 pull·실 attestation 검증은 owner/M7 후속이라 `runtime-unverified`다. 이미지에 `NOTICE`는 동봉되지만 공개 재배포 전 의존성 귀속 완전성과 사람 법무 검토는 별도 게이트이며 이 티켓이 완결을 주장하지 않는다(법률 자문 아님).

## GitHub branch protection live payload 호환 (#1318, 2026-08-12)

- 첫 attended bootstrap에서 GitHub가 `required_status_checks.contexts=[]`와 app-pinned `checks`를 함께 받은 요청을 서로 다른 OpenAPI `oneOf` 형상에 동시에 맞는 HTTP 422로 거절했다. 보호 PUT은 이제 `strict: true`와 `checks`만 내보내며, 기존 legacy `contexts`는 의미를 버리지 않고 `{context, app_id: -1}` check로 정규화한다.
- 오프라인 transport가 혼합 형상을 live 422처럼 거절하고, 혼합 필드를 되살린 mutation이 첫 PUT에서 RED·성공 write 0인지와 stronger policy를 포함한 exact checks-only payload를 함께 고정한다. 원격 attended apply/readback은 이 수정의 track/engine→main 랜딩 뒤 새 bootstrap provenance로 재시도하므로 아직 `runtime-unverified`다.

## Canonical track 정렬 가드레일 (#1297, 2026-08-12)

- `main`은 두 `track/*`의 조상이어야 하고 track-ahead는 정상이라는 topology를 `scripts/check_track_alignment.sh`로 기계화했다. remote/local behind·divergence, canonical upstream 오배선, ref 누락, non-fast-forward candidate는 이름을 대고 실패하며, 격리 fixture가 각 RED와 ahead PASS를 고정한다.
- local gate·pre-push·merge-tree가 같은 checker를 소비하고, `track-alignment` workflow가 세 canonical branch push + 매일 + 수동 실행에서 remote drift를 감시한다. `pr-ci`는 이제 `main`·`track/engine`·`track/uxui` 모두에서 돌며, branch protection은 `PR CI gate`와 #1302의 `Policy integrity gate` 두 context를 요구한다.
- #1295 재발 방지로 OpenAPI 또는 `clients/web-legacy` 생성 계약이 바뀌면 전용 CI lane이 legacy lockfile을 검사한 뒤 permissive license와 generated-type 정합을 함께 검증한다. GitHub 보호는 `scripts/github_track_guardrails.sh`가 정상 track-ahead에서도 동작하는 기본 read-only check와 bootstrap-only `--apply`로 PR-only·conversation resolution·GitHub Actions app-ID 고정 context·force/delete 금지와 Actions 기본 read·PR 승인 금지를 관리한다. 다만 app-ID만으로 후보 workflow 자기변조를 막을 수 없으므로 trusted policy-integrity gate #1302가 main에 랜딩하기 전에는 보호를 적용하지 않는다. 실제 apply는 #1297·#1302 main 랜딩, 세 트랙 동일 SHA 정렬, 두 context 생성 후 통합자 몫이다.

## Trusted policy integrity (#1302, 2026-08-12)

- public/Free 환경에서 Enterprise ruleset을 가정하지 않고, base-only `pull_request_target` evaluator가 후보 checkout·실행·의존성 설치 없이 API metadata만 검증해 exact PR head/run attempt에 `Policy integrity gate`를 게시한다(ADR-0153 D5). 같은 Actions App/name status는 충분하지 않으므로 통합 직전 **현재 PR의 exact canonical base branch/HEAD에서 wrapper bytes가 그 base와 일치하는 checkout**으로 `scripts/verify_policy_integrity_from_base.sh --repo yeomyeonggeori/oort --pr <PR>`를 실행한다. wrapper는 PR API exact base object의 verifier를 추출하며 worktree/candidate verifier bytes는 무시하고 실행하지 않는다. 그런 다음 head/base·current default-main workflow authority·workflow ID/path·event·attempt·base run-name·check-suite app·evaluator job·live policy evidence와 최종 재읽기를 묶는다.
- 정책 변경은 지정 policy owner `kwakseongjae`/GitHub user id `87296259` author, 같은 지정 owner의 exact `Policy-Integrity-Audit: <40sha>` comment, 그 뒤 같은 owner가 적용한 현재 `policy-change-approved` label을 모두 요구하고 head/comment/label transition 변경 후 재승인한다. workflow가 아직 base에 없는 **#1302의 track/engine→main 최초 랜딩 체인**과 기존 verifier의 live status-user/App identity 결함을 고치는 **#1307의 track/engine→main 수리 체인**만 reviewed bootstrap 예외이며, #1307 main 랜딩·갱신 wrapper 재검증 뒤부터는 예외가 없다. 그때 target별 docs-only unmerged bootstrap PR을 `--policy-pr main=N,track/engine=N,track/uxui=N` verify → apply → check로 처리한다. workflow_dispatch seeding은 쓰지 않는다. 첫 live PR에서 status bot, run/suite/job App, bare workflow path와 PR-head 내부 SHA 형상을 관측했으며, 아직 관측하지 않은 대체 API 형상은 의미를 추정하지 않고 내부 SHA 일치로 fail-closed한다.

## Policy status live provenance (#1307, 2026-08-12)

- 첫 live `pull_request_target`에서 commit status creator는 GitHub Actions App id가 아니라 `github-actions[bot]`/user id `41898282`/`Bot`으로, check-suite는 별도 App id `15368`/slug `github-actions`로 실측됐다. verifier와 RED fixture가 status bot identity와 run/suite/job App identity를 분리해 각각 exact 결속하며 provenance JSON도 두 축을 따로 기록한다.
- PR #1306에서 #1307 구현을 사용한 read-only 진단은 live status→run attempt→suite→job 결속과 provenance JSON을 끝까지 확인했다. 다만 이것은 후보 구현 진단이지 merge 권위가 아니며, 기존 exact-base verifier 자체의 live-shape 결함을 고치는 #1307 track/engine→main 랜딩 체인만 독립 리뷰·두 required context·local gate를 근거로 한 reviewed bootstrap 예외다. main 랜딩 뒤 갱신된 exact-base wrapper로 새 #1306 head를 재검증하는 것이 이 예외의 폐쇄 조건이며 결과는 PR #1306 evidence에 기록한다. 남은 `runtime-unverified`는 원격 branch-protection apply/readback과 아직 관측하지 않은 대체 run-head 형상이다.

## Secret gate RED proof 결정화 (#1296, 2026-08-12)

- 확률적으로 entropy 임계값을 못 넘던 random-hex fixture를 완성 literal 없이 런타임 조립되는 gitleaks 내장 AWS 형상으로 교체했다. 실제 history scan·비노출·fingerprint baseline·nonmatching baseline·missing-scanner fail-closed 계약은 그대로다.

## OpenAPI 생성 타입 재동기화 — web-legacy 게이트 복구 (#1295, 2026-08-12)

- lockfile에 고정된 `openapi-typescript 7.13.0`으로 `docs/api/openapi.yaml`을 다시 생성해 `clients/web-legacy/src/api/schema.d.ts`를 byte-identical하게 맞췄다. 빠졌던 notification-rules 경로·DTO와 human `presenceStatus`, 그 사이 추가된 run binding/refine 계약도 정본에서 그대로 복구됐다.
- `verify_web_generated_types.sh` green과 임시 dummy path의 이름 있는 `types-stale` red proof·생성물 bytes 복원을 확인했다. 정적 생성물 동기화라 별도 runtime 미검증 범위는 없다.

## React Native 작업 콘솔 — T1/T2/T3 위치·읽기 전용 상세 (#1292, 2026-08-11)

- 모바일 하단 탭에 워크스페이스 범위 `작업` 목록을 추가했다. 최근 최대 200개를 진행 우선으로 보여 주고 `전체`/`진행`(`running|idle`)을 가르며, 호스트·채널·담당자·도구·시작/종료 시각과 공유 `workExecutionLocation`의 정확한 `T1 · 데스크톱 앱` / `T2 · 셀프호스트` / `T3 · 클라우드` / `실행 위치 확인 필요` 표식을 함께 쓴다. 기존 AgentDetail의 눈에 보이는 실행 위치도 같은 정본 mapper로 통일했다.
- 폰 전용 상세는 durable typed lifecycle·tool·ACP 요약과 발원 대화 이동만 제공한다. raw PTY·명령 입력/출력·cwd/env·controller/owner 제어·observer attach·새 native/WebView 의존성은 추가하지 않았고, 숨은 작업 탭은 polling/realtime을 유지하지 않는다.
- 검증: review 보정 뒤 mobile typecheck·lint(오류 0)·전체 Jest 1,144/1,144와 core typecheck·lint·전체 Vitest 1,173/1,173, lane/measure shell syntax·Maestro YAML parse, `verify_merge_tree.sh --base origin/track/uxui --head HEAD --install`의 웹·폰·코어 8레인이 green이다. 좁은 4탭은 Dynamic Type 줄바꿈, 필터는 3:1 경계, 상세↔대화↔목록은 VoiceOver 초점 복귀, 긴 상세는 rotor heading을 보장하며 light/dark·긴 한국어·접근성 글자 캡처가 measure lane에 포함됐다. 현재 booted Simulator가 없어 캡처·Maestro 실주행은 `runtime-unverified`다.

## Work Console v1 — 전용 작업 관제와 T1/T2/T3 위치 표식 (#1289, 2026-08-11)

- 웹과 같은 번들을 쓰는 Tauri 데스크톱에 `/work` 전용 master-detail 진입점을 추가했다. 워크스페이스 작업 세션을 상태·담당자·채널·도구·명시 시각과 함께 보고, `?session=` 주소로 같은 기존 세션 상세에 다시 들어가며 목록을 접어 상세·터미널을 전체 route 폭으로 볼 수 있다.
- 실행 위치는 서버 정본 `work_host.type`만으로 `T1 · 데스크톱 앱`·`T2 · 셀프호스트`·`T3 · 클라우드`를 판정하며 상태와 별도 icon+text로 표시한다. Project/repo/worktree/cwd는 현 계약에 없으므로 추론하지 않는다.
- 터미널은 기존 host-direct observer를 그대로 재사용한 **읽기 전용** 표면이다. 실제 Tauri↔Rust workd 관전 폐곡선, controller 입력 PTY, Project 계층과 GUI preview는 후속 계약·goal이며 `runtime-unverified`다.

## 데스크톱 셸 집중 모드 — 56px 레일 유지 + 184px 탐색 패널 접기 (#1291, 2026-08-11)

- **웹/Tauri 공용 AppShell에 비지속 접기를 추가했다.** 텍스트+아이콘 `탐색 패널 접기`와 레일의 `열기`가 왕복하고, 채널/프로필 패널만 빠져 채팅과 같은 주 표면이 정확히 184px 넓어진다. 이미 열린 WorkPanel의 subtree와 wide 상태는 왕복 중 유지된다. `/work`도 #1290 합류 뒤 같은 두 번째 shell track을 그대로 받으며 별도 레이아웃 분기는 없다.
- **포커스와 모바일 경계를 닫았다.** 숨은 패널의 모든 포커스 대상은 탭/AX 트리에서 빠지고 포커스는 살아 있는 토글로 이동한다. 데스크톱 토글을 쥔 채 `<600px`로 가면 현재 route의 모바일 opener가 이어받되, route에 이미 가시 포커스가 있으면 빼앗지 않는다. 서랍·스크림·Escape는 독립이며 새 AppShell 마운트에는 접힘 상태가 남지 않는다.
- **검증.** typecheck · build · web 891 tests · lint 0 errors(기존 warning 7) · design pre-flight 10/10+3/3 · #1291 집중 shell gate 1280/900/760 + 390px, light/dark 전부 PASS. 양 스킴 캡처 직접 검수 Blocker 0; 전체 `gate:shell`의 기존 플러그인 포커스 링 offset 단정 3건은 이 변경과 무관한 baseline RED로 별도 관측했다.

## ADR-0158 서버 축 — `runId` 서비스 개시 · refine 공지 · 어댑터 스트림 (#1130 W-N, 2026-08-08)

- **`POST …/messages`의 `runId` 거절이 풀렸다(D5).** 검증 3종은 전송 트랜잭션 **안**에서 fail-closed다(`momo_agent::authorize_run_binding_in_tx`): run 실재 · 같은 워크스페이스 · 요청 주체가 그 run의 에이전트(`agent_run.agent_member_id == principal.member_id`). 안 보이는 run은 **404**(RLS가 타 테넌트 행을 감추므로 더 구체적인 답은 존재 확인이 된다), 보이지만 남의 것이면 **403**. 통과하면 `message.run_id` 컬럼과 `props.run_id` 사본을 **함께** 쓴다 — 전자는 서버측 닫기가 미완성 답을 찾는 키, 후자는 히스토리 페이지가 `runEnded`를 정하는 키라, 하나만 쓰면 두 독자 중 하나가 못 본다.
- **취소가 어댑터가 연 스트림을 닫는다(ADR-0155 완전체).** 종전엔 REST로 연 메시지에 `run_id`가 없어 `open_stream_message_for_run_in_tx`가 아무것도 못 찾았고, 닫는 PATCH는 정확히 prime/hermes 경로에서만 조용히 무동작이었다. 신규 conformance가 in-process 스위트의 **여섯 단정을 같은 순서로** 재현한다(동결된 본문 · `outcome: cancelled` · `streaming: false` · `state='sent'`·`editedAt` NULL · 메시지 1행·seq 불변 · 두 번째 닫기는 no-op).
- **자기수정 공지가 채널 사건이 됐다(D1~D4).** `type: "system"` + 서버 소유 `props["momo.harnessRefine"]`(refinementId·trigger·scope·edits·summary·rollbackId). 멱등 키는 **파생**이다 — `client_msg_id`가 uuid 컬럼(동결층)이라 `RefinementResult.id` 문자열을 `uuidv5(momo.harnessRefi, id)`로 해싱한다(`tool_result` 키와 같은 전례). 다른 값을 보내면 400이 **기대값을 이름 대고** 거절한다. RPC 유래와 파일 관찰 유래가 같은 키로 모여 한 줄이 된다.
- **유출 금지가 기계적이다.** `harnessRefine`과 그 `edits[]`가 `deny_unknown_fields`라, 하네스 본문(`before`/`after`)을 실은 공지는 **422로 거절**된다 — 조용히 잘려 발신자가 배달됐다고 믿는 경로가 없다. `scope`는 `workspace` 외 전부 400(어댑터는 워크스페이스별 HOME이라 하네스의 `global`을 그대로 옮기면 거짓말이다). `momo.harnessRefine`은 서버 소유 키 목록에 올라 클라이언트 props로는 절대 안 들어간다.
- **어댑터가 자기 자격증명으로 슬라이스를 쓴다(증보 1 D7 — 성재 승인).** W-N이 적발한 공백: `required_agent_scope` 표가 메시지 라우트를 `POST` **하나만** 매핑해 agent bearer의 `PATCH …/messages/{id}`가 403이었다. Swift 원본에도 없었고 #1152/#1173 conformance는 **사람 로그인**으로 증명해서 아무도 이 질문을 안 했다 — 스파이크가 턴당 17 메시지였던 실제 이유가 이것이다(POST만 열려 있었다). D7이 PATCH 행을 추가했다. **새 스코프는 안 만들었다** — 여는 write와 잇는 write는 같은 행위이고(#1152: 한 턴 = 자라는 한 메시지), 스코프를 가르면 어댑터가 한 문장 쓰는 데 두 개가 필요하고 이미 발급된 `messages:write` 토큰을 전부 재발급해야 한다.
- **범위를 좁히는 것은 스코프가 아니라 저자 검사다 — 그리고 그건 이미 있었다.** `stream_message_body_in_tx`·`edit_message_in_tx` 둘 다 비저자를 `NotAuthorForEdit`로 **다른 무엇을 보기 전에** 거절하고, 비교 대상 actor는 요청 본문이 주장할 수 없는 자격증명의 멤버다. 그래서 검사는 **추가하지 않고 실측으로 확인만** 했다 — 같은 `messages:write`를 든 두 번째 에이전트의 PATCH가 403이고 본문이 그대로다. 에이전트가 지키는 규칙이 사람이 지키는 규칙과 **같은 하나**이지 병렬 사본이 아니다. `DELETE`는 같은 경로에서 계속 닫혀 있다(메서드로 매칭 — 잇는 것과 무르는 것은 다른 행위이고 스트리밍에 후자는 필요 없다).
- **red proof 5종 전부 실주행 반전 확인.** ① 소유권 체크 제거 → 남의 run에 대한 POST가 403 대신 **201**. ② 검증 블록 제거 → 타 워크스페이스 run이 404 대신 **201**로 테넌트 타임라인에 들어간다(`message.run_id` FK는 워크스페이스 쌍이 없는 전역 FK이고, uuid를 컬럼에 넣는 것은 그 행을 읽는 게 아니라 RLS가 안 잡는다 — 스위트가 검증 없는 경로를 **실제로 실행해** 커밋을 단정한다). ③ 파생 키 검증 제거 → 한 refinement의 재시도가 **두 줄**이 된다. ④ D7 스코프 행 제거 → 슬라이스가 **403 회귀**. ⑤ 저자 검사 제거 → 남의 답 안에 다른 에이전트의 문장이 **200으로 들어간다**.
- **검증.** `cargo fmt --check` green · `cargo clippy --workspace --all-targets -D warnings` 0 · `cargo test --workspace` 실패 0 · `run_binding_refine_conformance_pg` 3/3(실 PG18+`momo_app` NOBYPASSRLS) · 인접 실DB 스위트 무회귀(`stream_edit` 9 · `stream_message` 6 · `mention_routing` 13 · `agent_run_cancel` 4 · `run_terminal_backfill` 6 · `http_smoke` 3 · `client_rewire` 4 · `gateway_mode` 2) · `verify_openapi_contract_rust.sh` **PASS 55/55** · `verify_merge_tree.sh` **7레인 green**.

## 게이트 위생 — 14단계가 게이트 경유에서만 빨갛던 이유는 **드리프트한 사본** (#1185, 2026-08-08)

- **증상은 환경 차이였지만 원인은 코드였다.** `local_gate.sh`는 모든 단계를 `bash -lc`(로그인 셸)로 돌린다. 이 기계의 로그인 PATH는 `/usr/bin`을 `/opt/homebrew/bin`보다 앞에 두므로 `ruby`가 **2.6.10**으로 잡히고, psych 3은 `YAML.load_file(..., aliases: true)`의 `aliases:` 키워드를 모른다(`unknown keyword: aliases (ArgumentError)`). 같은 명령을 직접 실주행하면 ruby 4.0.6이 잡혀 초록이었다 — #1181·#1184의 14단계 초록이 전부 직접 실주행이었던 이유.
- **정작 죽은 자리는 2차 패스였다.** 1차 패스(`verify_openapi_contract.sh`)에는 `aliases:` 없이 재시도하는 psych 3 갈래가 **이미 있었다**. #1042가 만든 2차 패스(`verify_openapi_contract_rust.sh`)는 그 변환을 "1차 패스와 같은 변환"이라 주석 달고 **복사**했는데 재시도만 빠져 있었고, 그래서 곧장 python 갈래로 떨어졌다. 그 python은 `PYTHON_BIN`(≥3.10 기준으로 고른 python3.13)이고 PyYAML이 없다. Swift 패스가 기본 off인 지금 2차 패스는 **유일한 기본 패스**이므로 14단계 전체가 죽었다.
- **수리: 사본을 지웠다.** `scripts/openapi_spec_to_json.sh` 신설 — 소스 전용 라이브러리 한 벌을 두 패스가 같이 부른다. 인터프리터의 **자격을 실측**해서 갈래를 고르고(psych 4+면 `aliases: true`, psych 3-면 무키워드 — `RUBY_VERSION` 숫자 비교는 psych 백포트에 거짓말한다), **어느 갈래로 뛰었는지 언제나 한 줄 출력한다**(`spec->json reader: ruby 2.6.10 (psych 3-, …)`). 조용한 강등 금지(#1089·#1181 전례).
- **실패도 정직해졌다.** 종전 ruby 갈래는 `2>/dev/null`로 이유를 삼키고 "need ruby or python yaml"이라는 일반문으로 죽었다. 이제 갈래별로 실격 사유를 이름 댄다: `ruby : ruby 2.6.10 has no aliases: keyword…` / `python: python3.13 has no PyYAML (import yaml failed)`.
- **로그인 셸 PATH 고정은 기각했다.** 게이트가 PATH를 다시 쓰는 것은 레포 밖 기계 전역을 건드리는 수리이고, 고쳐도 "이 기계에서 어떤 ruby가 먼저 잡히는가"에 초록이 계속 매달린다. `OPENSSL_BIN`(LibreSSL은 Ed25519를 못 한다)·`PYTHON_BIN`(MOMO-458, Xcode 3.9 회피) 선택이 이미 **자격 실측** 규율이고, 이번 수리는 그 규율을 ruby로 넓힌 것이다. 기각 사유는 새 파일 헤더에 남겼다.
- **두 ruby 갈래는 오늘의 스펙에서 동등하다.** ruby 4.0.6 `aliases: true`와 ruby 2.6.10 무키워드의 JSON이 **263332 바이트 동일**. `docs/api/openapi.yaml`에는 현재 앵커/별칭이 0개라 `aliases: true`는 미래 대비이고, psych 4에서 키워드를 뺀 채 별칭이 등장하면 Psych가 예외를 던지므로 **조용히 틀린 JSON이 나오는 경로는 없다**.
- **red proof를 영구화했다.** `scripts/tests/test_local_gate_hardening.sh`에 `aliases:`만 거부하는 가짜 ruby를 PATH 앞에 세우는 픽스처를 추가했다 — 변환 성공 + **갈래 고지 문자열**을 함께 단정하므로 조용한 강등이 초록으로 통과하지 못한다. 두 번째 픽스처는 리더가 하나도 없을 때 갈래별 이유를 대고 죽는지를 단정한다. 실측: psych 3 갈래를 제거하면 이 테스트가 빨개지고 로그인 셸 변환이 다시 `no qualified YAML reader`로 죽는다.
- **`local_gate.sh` shell syntax 목록에 3개를 넣었다** — 신설 라이브러리와, 그동안 빠져 있던 `verify_openapi_contract_rust.sh`까지.

## 게이트 위생 — Swift 패스 강등·병합 트리 게이트·선재 FAIL 규명 (#1089/#1099/#1108/#1057, 2026-08-06)

- **1차(스펙 ↔ Swift) 패스를 기본 off 로 강등했다(ADR-0145 증보 2-②).** `OPENAPI_GATE_SWIFT_PASS=1` 로만 켜진다. 강등 자체보다 중요한 것은 **대가를 이름 붙인 것**이다: 1차가 꺼지면 `openapi_sampled_on_rust.txt` 밖의 연산은 "스펙에 있으나 어느 패스도 보지 않는" 상태가 되므로, 게이트가 그 목록을 매 실행 경고로 **전부** 출력한다(실측 **125/128**, 매니페스트가 덮는 것은 3). 커버리지가 조용히 사라지는 상태를 만들지 않는다 — 목록은 매니페스트가 자랄수록 줄고, 0이 되는 날 1차 패스는 되살릴 이유가 사라진다(#1042 잠식 완료).
- **불변으로 둔 것.** `known-unsampled`의 의미는 그대로 **1차 패스만의 부채 장부**이고, 1차가 꺼진 실행에서는 아예 참조되지 않는다(그 패스가 안 도니 그 패스의 부채도 성립하지 않는다). 두 패스를 동시에 끄는 조합은 **거부**한다 — 아무도 샘플하지 않는 초록은 게이트가 아니다.
- **`scripts/verify_merge_tree.sh` 신설(#1108).** 재는 것이 브랜치가 아니라 **병합 결과**다: `git merge-tree --write-tree` → 임시 커밋 → 임시 워크트리 → 거기서 웹·폰·코어 3종 typecheck + 스위트. 브랜치 HEAD는 한 번도 체크아웃되지 않는다(그것이 이미 초록인 판이므로). 기본은 이 체크아웃의 `node_modules`를 심볼릭 링크로 빌려 써 **20초**에 끝나고, 병합 결과의 락파일이 다르면 자동으로 `npm ci` 모드로 전환한다(코어는 npm workspace라 락파일·node_modules가 레포 루트에 있다 — 그걸 틀리면 빌려 쓰기 경로가 죽은 코드가 된다).
- **선재 FAIL 4건은 원인이 하나였다(#1089).** `gate:shell`(=`gate:shell-layout`, 같은 스크립트다)·`gate:my-sessions`·`gate:huddle` 셋 다 로그인 직후 **토큰 회전 스텁 부재**로 죽고 있었다. 실측 로그: 로그인 200 → `POST /v1/auth/refresh` → 포괄 스텁의 `{channels:[]...}` → 코어 `refreshResponseFromWire` throw → `markAuthExpired()` → 앱이 스스로 로그아웃 → `channel-list`/`open-work-panel`/`nav[워크스페이스 탐색]` 30초 타임아웃. 형제 게이트 12개는 전부 이 스텁을 갖고 있었고 이 셋만 빠져 있었다. 세 줄로 셋 다 초록.
- **`gate:scroll`은 자격증명 요구 자체가 근거 없었다(#1089).** `?stress=N`은 행을 클라이언트에서 만들고 네트워크를 타지 않는다 — 라이브 서버가 필요했던 것은 로그인 왕복 하나였고 그건 스텁으로 대체된다. 자체 preview + 스텁 세션으로 재배선하고 `npm run gate:scroll`을 등록했다(실측 1000행·최대 DOM 36행·120.3fps·33ms 초과 프레임 0). 가상화가 무너진 판에서 "빠르다"고 통과하던 구멍도 함께 막았다(행 수 단정 추가). 라이브 측정은 `SCROLL_GATE_BASE`+자격증명을 **함께** 줄 때만.
- **`capture:design`이 118프레임 중 95에서 죽던 이유(#1099): 길게 누르기의 손 떼는 동작이 자기가 연 시트를 닫고 있었다.** 실측 이벤트 로그가 `touchEnd` 직후 `mousedown/click target=sheet-react-👍`를 보여 준다 — Chrome은 취소되지 않은 터치의 touchEnd 뒤에 호환용 마우스 이벤트를 **놓았던 좌표에** 합성하고, 화면 아래에 붙는 시트가 그 좌표를 덮는다. 실제 Chrome은 700ms 홀드를 GestureLongPress로 인식해 그 탭을 소비하지만 `Input.dispatchTouchEvent`로 낸 터치는 그 인식기를 거치지 않는다 — 즉 **원시 터치 디스패치의 산물**이다. `touchCancel`로 바꿔 모델링을 맞췄고(앱 쪽에서도 `pointercancel`로 눌림 상태가 깨끗이 풀린다), 첫 열기가 우연히 살아남던 자리의 **조용한 초록**(시트가 닫혀 행 0개인데 44px 단정이 무사통과)도 함께 막았다.
- **설정 표면 6개가 캡처 레인에 들어왔다(#1057).** 계정·알림 규칙·워크스페이스·앱·사용량·멤버와 초대. 라우트가 없어 프리뷰 서버로 새면 404 → 에러 경계였으므로 "안 찍힌" 것이 아니라 "찍으면 빨간 판"이었다 — 픽스처(사용량·구독 잔여량은 모델 테스트가 계약으로 붙잡는 그 JSON)를 붙이고, **에러 경계가 그려진 판은 캡처가 아니라 실패**가 되게 단정을 넣었다. 전체 실행 **130 프레임 완주**(baseline은 95에서 중단).
- **같은 자폭 로그아웃이 캡처 하네스 셋에 더 있었다.** `capture:usage`·`capture:standalone`·`capture:honesty`도 `/v1/auth/refresh` 스텁이 없었다. 셋 다 고쳤고 red proof도 세웠다(스텁을 빼면 `capture:usage`가 `channel-list`에서 다시 죽는다). 앞의 둘은 초록으로 완주. **`capture:honesty`는 로그인을 통과한 뒤 진짜 단정에서 멈춘다** — 아래 관측 2.
- **검증.** 웹 750 tests(40 files)·typecheck 0·eslint error 0(warning 11, base 동일) · `cargo test --workspace` **740 passed / 0 failed / 145 ignored**(러스트 무변경) · `bash -n` green, shellcheck 신규 경고 0(잔존 SC1007 2건은 base와 같은 `CDPATH=` 관용구) · openapi 게이트 강등 경로 **PASS**(경고 125/128 → 2차 패스 3/3 샘플 일치) · `verify_merge_tree.sh` 자기 브랜치 대상 **6/6 green**(20초).
- **웹 게이트 전판 실행표 (2026-08-06, 이 브랜치).** 자체 완결 게이트 **17/17 green**: `gate:shell` · `gate:scroll`(신규 등록) · `gate:wire` · `gate:csp` · `gate:boot` · `gate:huddle` · `gate:my-sessions` · `gate:agent-hub` · `gate:workstream` · `gate:approvals` · `gate:work-panel` · `gate:ailink` · `gate:quote` · `gate:typing` · `gate:borders` · `gate:fold` · `gate:composer`. **skip 3**: `gate:inject`·`gate:seq`·`gate:resume` — 라이브 momowebqa와 `MOMO_EMAIL`/`MOMO_PASSWORD`가 필요해 워커 세션에서 실행 불가(자격증명 취급 금지). `gate:scroll`은 그 셋과 같은 이유로 묶여 있었는데, 요구가 근거 없음이 드러나 이번에 스텁으로 풀렸다 — 남은 셋은 실서버 왕복 자체가 대상이라 같은 방식으로 풀리지 않는다. 캡처 하네스: `capture:design` 130프레임 완주 · `capture:usage` green · `capture:standalone` 6샷 green · `capture:honesty` **RED(관측 2 — 제품 단정)**.
- **red proof 4종.** ①#1108: 코어 API를 재편한 브랜치와 그 API를 새로 소비하는 폰 브랜치를 각각 초록으로 만든 뒤 병합 → **폰만 RED, `TS2353`**(U4-6 B1과 같은 오류 코드·같은 자리). ②openapi: `OPENAPI_GATE_SWIFT_PASS=1`이면 다시 1차 패스 경로로 들어간다(스테이지 2 도달을 BASE_URL 모드의 이름 있는 실패로 확인). ③`SWIFT_PASS=0 + RUST_PASS=0`은 거부되고 exit 1. ④`capture:usage` 회전 스텁 제거 시 `channel-list` 타임아웃 재현.
- **관측 1 (반경 밖 · 차단 요인).** `server-rust/Dockerfile`이 **origin/track/engine에서 빌드되지 않는다.** 의존성 레이어의 하드코딩된 매니페스트 COPY 목록에 `crates/momo-drive/Cargo.toml`(#1111 신설)이 빠져 `cargo build`가 `failed to load manifest for workspace member .../bins/momo-server`로 죽는다. 강등 뒤 2차(Rust) 패스가 **유일한 기본 패스**이므로 이건 openapi 게이트 전체를 막는다. `server-rust/`는 이 워커의 반경 밖이라 손대지 않았고, 검증은 같은 base commit으로 오늘 만들어진 `momo-rust:laneA-724b772d` 이미지를 `MOMO_RUST_IMAGE`로 재사용해 수행했다(레인 워커가 이미 같은 벽을 넘은 것으로 보인다). **머지 전에 이 한 줄이 닫혀야 한다.**
- **관측 2 (별건 티켓 필요).** `capture:honesty`가 회전 스텁 수리 뒤 로그인을 통과하고 나서 `죽은 결정 대기 탭이 아직 서 있다`로 멈춘다 — 승인 표면이 없다고 답하는 서버에서 인박스의 `결정 대기` 탭이 접히지 않는다는 **제품 단정**이다(W-AP1이 `approvals.provided`를 뒤집은 뒤 이 분기가 갱신되지 않은 것으로 보인다). 의미 없는 빨강(로그인 타임아웃)이 의미 있는 빨강으로 바뀐 것이므로 되돌리지 않았다.
- **관측 3 (후속).** `capture:design`의 설정 > 앱은 **빈 카탈로그**로 찍는다. 출하 시드 매니페스트를 한 줄 얹으면 그 프레임 자체는 나오는데 **그 다음 섹션 전환이 무너진다**(다음 섹션에서 `settings-route`가 30초 안에 안 돌아오고, 클릭으로 넘기는 판에서는 `사용량` nav 버튼 클릭이 같은 자리에서 죽는다). `앱` 패널의 `wide` 마켓플레이스 레이아웃 쪽으로 보이며 카탈로그가 비면 재현되지 않는다. 카탈로그가 있는 판은 `gate:shell`이 두 매니페스트로 이미 측정하므로, 이 하네스에 넣는 것은 위 전환 결함을 규명한 뒤의 일이다.

