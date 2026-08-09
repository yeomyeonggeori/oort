### Design Review — PR #1215 `fix/dsfix-1210` @ fe64e03a (base track/engine)

리뷰 기준: 웹 = `momo-design-taste-web`(정본은 프로젝트 `.claude/skills/momo-design-taste-web/SKILL.md` — 패킷의 `~/.claude/...` 경로에는 파일이 없어 프로젝트 사본으로 판정) · 폰 = `momo-design-taste` 원칙부의 RN 번역 · 루브릭 = `.claude/skills/momo-design-taste/references/review-rubric.md`(웹 치환 2건 적용).

Screenshots:
- 폰 다크 전/후: `~/projects/momo-tracks/momo-worktrees/dsfix-1210/clients/mobile/measure/captures/dsfix1210-destructive-confirm-before-dark.png` / `dsfix1210-destructive-confirm-dark.png`
- 폰 라이트 전/후: 같은 디렉터리 `...-before-light.png` / `...-light.png` (축척 pt=px/3, 1206px=402pt)
- 웹: `~/projects/momo-tracks/momo-worktrees/dsfix-1210/clients/web/artifacts/dsfix1210/dsfix1210-controls-light.png` / `-dark.png`

---

## 검증 우선순위 5항목 — 재서술이 아니라 반증 시도의 결과

### 1. D1 웹 `Button secondary` 경계 — 성립. 수치 전수 독립 재계산으로 일치.

- 자체 스크립트(WCAG 상대휘도, `scratchpad/contrast.mjs`)로 전 수치 재계산:
  `--line` on `--surface` **1.32/1.43** · `--line-strong` **3.59/3.56** · `--surface-raised` 채움 **1.07/1.10** · `--accent` **5.34/8.94** · `--danger-fill` **7.02/6.42**. 구현자 주장과 소수 둘째 자리까지 전부 일치. 채움 위계는 D1이 건드리지 않았고(경계 토큰만 교체) 위계의 자(채도)는 무채색 `--line-strong`이 끼어들지 않는다 — 주장대로.
- `line-strong` on `surface-raised`(버튼 자기 채움 위)도 **3.84/3.24** — 버튼이 어느 면 위에 서든 3:1 유지. `tokens.contrast.test.ts` 27개 전부 초록 실행 확인.
- **`controlBorders.test.ts`가 역할표를 닫는가**: `design/ui/`의 `.tsx`는 정확히 6개(button/input/select/card/dialog/dropdown-menu)로 ROLE 표와 일치(디렉터리 실측). 첫 단정이 집합 동치를 강제하므로 새 프리미티브는 판정 없이 초록 불가 — **닫힘 주장 성립**. input/select는 이미 `border-line-strong`(input.tsx:22, select.tsx:37) — "없음" 단정과 "있음" 단정이 양방향으로 서 있다. 3개 테스트 실행 초록.
- 시각 증거: 웹 캡처 두 스킴에서 secondary/outline 경계가 명확, `was: --line` 행은 경계가 사실상 소실 — 수리 전 상태의 재현이 정직하다.

### 2. D2 폰 파괴 채움 — 성립. 수치 일치 + 캡처에서 위계가 눈으로 선다.

- 독립 재계산: 옛 채움 `dangerBorder`(#623635) 카드 위 다크 **1.64:1**(bg 위 1.80) · 라이트 **1.89**(bg 1.76). 옛 라벨(onAccent #17161a on #623635) **1.80:1**. 새 `dangerFill` 카드 위 다크 **5.83** · bg **6.42** · 라이트 **7.52/7.02**. 라벨 `onDangerFill` **6.42/7.52** (AA). 전부 주장과 일치.
- 채도 순서: OKLab C 재계산 — accent 0.1336/0.1360 > dangerFill 0.1130/0.1133 (비 1.18/1.20 ≥ 1.15) · hue 차 danger↔dangerFill 5.5°/8.9° < 15°. "보이되 주 액션을 이기지 않는다"의 산술 전부 성립.
- 캡처 실측: **다크 before**는 거부/중단이 진흙색으로 카드에 묻힘(감사의 "5배 조용" 그대로), **after**는 코랄 채움 + 어두운 라벨로 명확, 승인(호박)이 여전히 더 밝고 채도 높음 — 위계 성립. **라이트 before**는 흰 라벨이 연분홍 위에 얹혀 판독 한계(1.89:1 재현), after는 와인색 + 종이색 라벨. 라이트에서 거부의 휘도 대비(7.52)가 승인(≈5.5)보다 높지만, 이 팔레트의 위계 자는 채도이고 그 순서는 지켜진다 — 웹이 같은 두 항으로 이미 출하 중인 관계라 폰만의 일탈이 아니다.
- 값 동기화: `paletteContrast.test.ts` PAIRS에 `dangerFill`/`onDangerFill` 추가로 웹 정본과 바이트 대조 + "가드가 자기 구멍을 문서화하던" 제외 주석 철거 확인. 렌더 층은 `destructiveConfirmRender.test.tsx`가 `StyleSheet.flatten`으로 실제 버튼에 닿는 값을 두 스킴에서 단정. 폰 스위트 3파일 109 테스트 초록 실행.
- 터치 타깃: 두 컴포넌트 모두 `minHeight: TOUCH_TARGET`(44pt) 유지, 간격은 space 스케일 — 신규 매직 넘버 없음.

### 3. D3 포커스 링 — **직접 재현 성공.** 주장 그대로 성립.

- 재현 방법: 워크트리의 tailwind v4.3.3으로 (A) 재정의 없는 코어(before), (B) `tokens.css`(after) 두 CSS를 컴파일, 하우스 패턴 버튼을 넣은 페이지를 워크트리의 Playwright 1.61.1 Chromium에서 `focus({focusVisible:true})` 직후(전이 t=0) `getComputedStyle` 판독:
  - **BEFORE**: 첫 프레임 outline-color = `rgb(36,33,28)` = `--ink` → 400ms 뒤 `rgb(165,76,8)` = `--accent`. transition-property에 `outline-color` 포함.
  - **AFTER**: 첫 프레임부터 `rgb(165,76,8)` = 정착색. transition-property에서 `outline-color` 부재.
- 컴파일 산출물에서 캐스케이드도 확인: 코어 규칙(194행, outline-color 포함) 뒤에 `@layer utilities` 재정의(244행)가 문서 순서상 마지막 — 테스트가 "마지막 선언"을 읽는 설계와 부합.
- 정정된 감사 수치 검증: 클래스 목록 실측 **25곳/21~22파일**에 `transition-colors`+`focus-visible:outline` 동거, 그중 `design/ui/`는 정확히 **3곳** — "프리미티브 3개 수리는 불성립, 유틸리티 층 수리가 옳다"는 정정이 실측으로 성립. `outline-color`를 의도적으로 전이시키는 컴포넌트는 0(8개 grep 히트 전부 테스트 파일 자신).
- upstream 감시 단정("코어는 여전히 outline-color를 전이시킨다")이 있어 재정의의 수명도 기계가 진다.

### 4. merge-tree 7→8레인 (web lint) — red proof #6 직접 재현. 추가 가치 증명됨.

- 임시 프로브 파일(조건부 `useState`, 검증 후 삭제·워크트리 클린 확인)로 3중 실측: **tsc exit 0 · design_preflight exit 0 · eslint 1 error(react-hooks/rules-of-hooks) exit 1**. 이 레인만 붉다 — 주장 그대로.
- base 실측: `eslint .` = **0 errors · 12 warnings**(react-refresh 11 + exhaustive-deps 1), `npm run lint`는 max-warnings 없이 error만 게이트 — "첫날부터 우회되는 레인" 회피 논리와 실측 일치.
- 배선: 레인은 웹 node_modules가 이미 링크되는 merge-tree 워크트리에서 돈다(`verify_merge_tree.sh:138-173`) — 새 실행 단위 없이 기존 보장 위에 얹힘. 레인 수 3+3+1+1=8 확인.

### 5. `initialArmed` 하네스 전용 — 새지 않음. 3중 방벽 확인.

- ① `fillTokens.test.ts`가 `src/` 전수에서 `\binitialArmed\b` 0을 단정(소유자 2파일 제외) + 소유자가 이름을 실제로 갖는지 역단정 — 이름 소실로 인한 공허한 초록도 닫힘. 실행 초록.
- ② `src/` 호출자 실측: InboxScreen.tsx:317 · MessageRow.tsx:735 · ConversationScreen.tsx:896 전부 명시 prop, 스프레드 없음.
- ③ 하네스 자체가 `measure/root.ts:40 if (!__DEV__) return null` — 릴리스 빌드에서 measure 경로 자체가 죽어 있으므로, 설령 grep을 피해도 제품 도달 불가.
- 가드 우회 우려(armedAtMs=0 → CONFIRM_GUARD_MS 통과)는 실코드로 확인 — 그래서 prop이 하네스 밖에 나가면 안 되는 이유가 실재하고, 그 규칙을 주석이 아니라 테스트가 진다.

---

## 루브릭 위상 1–7

- **P1 상호작용**: 웹은 클래스 토큰 교체만(히트 영역·핸들러 불변). 폰은 색·라벨 스타일 분기만 — armed 분기별 라벨 스타일 대응 정확(ApprovalDecision.tsx:329-340), busy/tooFast/error 경로 불변, 44pt 타깃 유지. 죽은 컨트롤 없음 (Detail SLA 통과).
- **P2 뷰포트/창**: 레이아웃 변경 없음. 폰 캡처에서 한국어 문장 줄바꿈 정상, 잘림 없음. 하네스가 SAFE_GUTTER 인셋을 재현해 실배송 폭으로 촬영 — 정직한 캡처.
- **P3 시각 폴리시**: 토큰만 사용(신규 raw 값 0 — 신규 hex 2건은 전부 `tokens.ts` 팔레트 정의 자리, 웹 정본 항 복제이며 바이트 대조 테스트가 짐). 한 표면 한 액센트 유지. AI-tell 없음.
- **P4 접근성**: accessibilityRole/Label/State/announce 전부 유지·정합. 라벨 대비 AA 두 스킴(6.42/7.52). 포커스 링 첫 프레임 정착 — 키보드 1급 문법(P11) 관점의 실질 개선.
- **P5 강건성**: 기존 상태기계 불변. 이 PR이 새 상태를 만들지 않음.
- **P6 코드 건강**: 프리플라이트 웹 10/10 + 코어 3/3 PASS(원출력 위 §마감 참조). 스페이싱/radius 전부 스케일 토큰. 테스트가 "없음"과 "있음"을 쌍으로 단정하는 패턴 일관.
- **P7 카피**: 사용자 노출 신규 문자열 없음(라벨 재사용). 동사-선행 유지. 신규 em-dash는 dev 하네스 Frame 라벨 1건뿐(아래 Nit).

프리플라이트 원출력 (worktree에서 실행):
```
OK emdash/raw_color/inline_style/arbitrary_tw/ai_gradient/toast/naked_focus/external_font/hype/pure_bw: 0
RESULT: PASS, web 10/10 + core 3/3 categories clean.
```

---

## 판정

[Blocker] 없음.

[High] 없음.

[Medium]
- M1. D1이 프리미티브 층에서 세운 규칙("컨트롤 경계는 `--line-strong`")을 어기는 잔존 자리가 feature 층에 최소 2곳 실측됨: `clients/web/src/features/directory/MemberRow.tsx:108`(「라우팅」 버튼, `border border-line` — 경계 1.32/1.43:1) · `clients/web/src/features/timeline/ReactionChips.tsx:83`(반응 추가 버튼, `border border-line bg-surface-raised` — 경계도 채움도 3:1 미달). 텍스트/아이콘이 컨트롤을 식별해 WCAG 1.4.11 직접 위반까지는 다툼의 여지가 있으나, tokens.css:33-34의 하우스 규칙으로는 D1과 같은 결함 계급이다. 이 PR의 닫힘 주장은 `design/ui/`로 정직하게 한정돼 있고(테스트 머리말이 스스로 그렇게 적음) 두 자리 모두 이 PR이 만지지 않은 기존 코드이므로 Blocker/High가 아니다 — feature 층 경계 스윕을 후속 티켓으로.

[Nitpick]
- N1. `controlBorders.test.ts`의 `BARE_BORDER_LINE` 정규식은 변-지정 색 유틸(`border-t-line` 류)을 보지 못한다. 지금 `design/ui/`에 해당 사용 0이라 실해 없음 — 표가 커질 때 기억할 구멍.
- N2. tokens.css 재정의 주석의 "링 없는 6곳" 산술에 JSX 주석 1건(AiLinkSection.tsx:658)이 섞여 있다(실 클래스 사용은 5곳, 총 31 카운트는 grep상 재현됨). 프로즈 정확도 문제일 뿐 동작 무관.
- N3. 신규 하네스 라벨 `"확정 단계 — 승인 · 거부 · 중단 (#1210 D2)"`의 em-dash는 `__DEV__` 전용 measure 하네스의 기존 관례(동일 파일 20+ 라벨)와 일치하고 제품 카피가 아니다. 다만 폰 쪽에는 이 경계를 기계로 긋는 카피 게이트 자체가 없다 — 웹 AST 스캐너의 폰 이식 때 함께 볼 것.

**Verdict: PASS** (Blocker 0 · High 0 · Medium 1 · Nitpick 3)

비고: 패킷이 지시한 대로 Xcode Cloud `MomoiOS | Default` 빨강은 판정에 미반영. 워크트리는 리뷰 후 클린 상태로 보존(`git status` 0건).
