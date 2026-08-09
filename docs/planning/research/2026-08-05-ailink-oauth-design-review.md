# Design Review — 설정 > AI 연결 (OAuth 등록 + 연결 상태 카드)

PR #1056 / feat/U3-ailink-oauth @ e7a6b310
루브릭: `.claude/skills/momo-design-taste/references/review-rubric.md`
기준 스킬: `momo-design-taste` + 웹 번역판 `momo-design-taste-web`(웹 표면이므로 §11 웹 치환 적용)

**결과: Blocker 0 · High 5 · Medium 5 · Nitpick 5**

## 평가 근거 (무엇으로 평가했는가)

코드 정독 **+ 실제 렌더 스크린샷 24장**. 커밋된 캡처가 없어 `gate-ailink.mjs`의 playwright 라우트 스텁을 재사용해 직접 촬영했다(`npm ci` → `npm run build` → vite preview + chromium, viewport 1280/900/390, colorScheme light/dark, reducedMotion reduce).

- 모든 file:line은 `origin/feat/U3-ailink-oauth`를 `/private/tmp/u3-review-wt` 임시 워크트리에 체크아웃해 **실물 확인**했다. 리뷰 후 워크트리 제거, main 체크아웃 무수정(`git status` clean 확인).
- 토큰명은 `clients/web/src/design/tokens.css` 실측 이름만 사용했다(`--accent`, `--warn`, `--ok`, `--danger`, `--ink`, `--ink-muted`, `--line`, `--line-strong`, `--surface-raised`).
- 스크린샷 경로: `/private/tmp/u3-shots/`
  - `A1~A8` 라이트 폼 흐름(빈 상태 → 키 폼 → OAuth 폼 → 붙여넣기 미리보기 → 라벨 오류 → 반쯤 입력 → 저장 후 카드 → 재편집)
  - `B1~B2` 다크
  - `C1~C3` 만료 토큰(라이트/다크) · 무토큰+무라벨
  - `D1~D2` 키 링크 카드 · "자격증명 없음" 상태
  - `E1~E3`, `G1` 390px 폰
  - `F1` 긴 한국어+영문 혼합 라벨
  - `H1~H4` 방식 전환 상태 충돌 · 오류 위치 대조
  - `I1` 카드 vs 연결 순서 1차 행 어휘 충돌
  - `J1` 귀속 고지 vs 실시간 진단
  - `K1~K2` 두 비밀 상자 대조 (마스킹 vs 평문)
  - `L1~L2` 900px

## 기계 검사 원문

```
$ bash scripts/design_preflight_web.sh
== design pre-flight (web), SKILL momo-design-taste-web §10 ==
   scanned: clients/web/src, clients/web/index.html
   excluded: src/design/tokens.css, src/design/tokens.contrast.test.ts

OK    emdash: 0
OK    raw_color: 0
OK    inline_style: 0
OK    arbitrary_tw: 0
OK    ai_gradient: 0
OK    toast: 0
OK    naked_focus: 0
OK    external_font: 0
OK    hype: 0
OK    pure_bw: 0

RESULT: PASS, 10/10 categories clean.
EXIT=0

$ npx tsc -p tsconfig.app.json --noEmit          → 0
$ npx eslint src/features/settings/AiLinkSection.tsx src/features/settings/oauthGrant.ts → 0
$ npx vitest run oauthGrant.test.ts tokens.contrast.test.ts → 56 passed (2 files)
$ node gates/gate-ailink.mjs                     → GATE PASS
```

토큰 준수는 실측으로도 깨끗하다: 색은 전부 토큰 유틸리티, 간격은 {4,8,12,16,24,32} 안, 라디오·textarea 모두 네이티브 컨트롤, 토스트 없음, 다크 스킴 정상(B1/C2), 탭 순서 정상(주소 → auth.json → 계정 라벨 → 연결 저장 → 취소, 라디오 그룹은 네이티브 로빙 한 정거장).

---

## [Blocker] 0건

죽은 컨트롤 없음. 시스템 크롬 침범 없음. 1280/900/390 어느 폭에서도 기본 상태의 사용자 텍스트 잘림·겹침 없음. (ADR-0112 D6 상세 SLA 세 항목 모두 해당 없음.)

---

## [High] 5건

### H1. 한 폼 안에서 두 자격증명 상자가 정반대의 비밀 규율을 따른다 (질문 ② 비밀값 시각 규율)

- `clients/web/src/features/settings/AiLinkSection.tsx:469` — 키 칸은 `type="password"`. 실제로 점으로 가려진다(`K1-key-masked.png`).
- `clients/web/src/features/settings/AiLinkSection.tsx:494-504` — auth.json 칸은 평문 textarea. `refresh_token`/`access_token`/`id_token`이 전부 읽힌다(`K2-paste-cleartext.png`).

**더 오래 사는 비밀이 보이는 쪽에 있다.** 그리고 붙여넣은 뒤에도 계속 보인다: 조작자는 그 상자를 지나 `:520`의 "누구의 구독인가"를 채우고 `:550`의 저장을 눌러야 하므로, 화면 공유·어깨너머 노출 구간이 폼 세션 전체다. 폰에서는 `tokens.css:998-1003`이 폼 컨트롤을 16px로 올리므로 더 크게 읽힌다(`E2`).

이 구간은 **측정되지 않는다**: 게이트는 저장 이후의 DOM만 잰다(`clients/web/gates/gate-ailink.mjs:218-235`, 호출 `:375`, `:397`). 그리고 `:510-518`의 "읽은 내용" 미리보기가 이미 "옳은 파일을 붙여넣었나"에 답하므로, 파싱이 성공한 뒤 원문이 계속 읽혀야 할 이유가 남아 있지 않다. 패널 머리글 `:263`("자격증명은 … 저장한 뒤에는 등록 여부와 마지막 4자리만 보입니다")이 선언한 규율이 저장 전에는 적용되지 않는다.

→ 방식마다 다른 규율이 아니라 "화면 위의 자격증명"에 대한 한 개의 규칙이 필요하다.

### H2. 저장된 자격증명 상태와 편집 중인 등록 방식이 같은 라벨로 한 화면에 공존한다 (질문 ①)

`AiLinkSection.tsx:388`의 상태 카드는 `link.configured`만 보고 그리므로 `editing` 중에도 남는다.

`H1-saved-bearer-form-oauth-light.png`: 카드가 "**등록 방식 / 키**"(`:318`), "저장된 키 / ••••9f2c"(`:346-349`), 초록 "연결됨" 칩(`:87-89`)을 말하는 바로 아래에서, `:431-437`의 fieldset legend가 다시 "**등록 방식**"이고 그 값은 "ChatGPT 계정 (OAuth)"다. 한 화면에 같은 라벨이 두 번, 값은 다르고, 어느 쪽이 지금 유효한지 말하는 문장은 없다. 반대 방향도 같다(`H2-saved-oauth-form-key-light.png`: 카드는 OAuth·계정 라벨까지 말하는데 폼은 키 방식에 password 칸).

게다가 저장이 기존 자격증명을 **대체**한다는 사실이 어디에도 없고 버튼은 그냥 "연결 저장"(`:551`)이다.

→ 폼이 열려 있는 동안 카드는 과거를 말하고 있다. 그 시제가 화면에 보여야 한다.

### H3. 방식을 바꿔도 provider 주소는 따라오지 않는데, 힌트는 바뀐다

`AiLinkSection.tsx:215` — `if (chosen === "oauth" && !baseUrl.trim()) setBaseUrl(CHATGPT_OAUTH_BASE_URL);` 즉 **비어 있을 때만** 채운다.

그래서 저장된 키 링크에서 "연결 수정 → ChatGPT 계정(OAuth)"으로 바꾸면 주소는 `https://api.openai.com/v1`로 남고, 바로 아래 힌트(`:443-446`)는 "ChatGPT 구독 연결이 **실제로 닿는 주소**입니다. 다른 테넌트를 쓸 때만 바꾸세요."라고 말한다(`H1-saved-bearer-form-oauth-light.png`, `K2-paste-cleartext.png`).

`oauthGrant.ts:85-92`가 그 주소를 "이 grant가 실제로 닿을 수 있는 유일한 endpoint"라고 측정해 적어 둔 것과 정면으로 어긋난다. 검증은 형식(`https?://`, `oauthGrant.ts:226`)만 보므로 저장은 통과하고, 실패는 첫 턴에 워커에서 난다. 힌트가 화면의 값에 대해 거짓을 말하는 것이 이 결함을 보이지 않게 만든다.

### H4. 한 카드 안에서 `--warn`이 네 가지 다른 의미로 쓰인다 (질문 ③ 톤 · ④ 귀속 고지의 시각 처리)

`J1-notice-vs-diagnostics.png` 한 장에 앰버가 넷:

1. 분류 칩 "개인 계정 · 내부용" — `AiLinkSection.tsx:399`, `tone="warn"`
2. 만료된 액세스 토큰 행 — `:338`, `<span className="text-warn">`
3. 상시 귀속 고지(서버 정본 문장) — `:408`, `text-meta text-warn`
4. 지금 벌어진 429 진단 — `:416`, `text-meta text-warn`

3과 4는 **크기·색·자리·구분자가 완전히 동일**하다. 손댈 것이 있는 줄과 영원히 그대로일 줄이 구별되지 않는다. 그 결과 2도 값을 잃는다: 건강한 카드(`A7-card-oauth-light.png`)가 이미 앰버 2개(칩+고지)라, 만료가 켜져도(`C1`/`C2`) 앰버가 3개로 늘 뿐 새로 생긴 것이 눈에 띄지 않는다.

`:330-333`의 주석은 "색은 문장을 보강할 뿐 대체하지 않으며 --warn은 한 번 더 볼 만한 한 상태에만 쓴다. 정상을 초록으로 칠하는 것은 장식이다"라고 규칙을 선언하는데, 화면은 그 규칙을 지키지 않는다.

**질문 ④에 대한 답: 귀속 고지는 인용도 본문도 아닌 '경고'로 그려져 있다.** 서버 정본이라는 사실도, 상시 사실이라는 것도 시각적으로 말하지 않고, 바로 아래 진단 목록과 구분되지 않는다.

### H5. 같은 오류 문장이 등록 방식에 따라 다른 자리에 뜬다 (질문 ③)

"주소는 http:// 또는 https:// 로 시작해야 합니다."가

- 키 방식: 폼 맨 아래(모드 라디오 3개 아래, 주소 칸에서 약 355px 떨어진 곳) — `H3-key-url-error-light.png`, `AiLinkSection.tsx:221-231`(setFormError) → `:538-542`(렌더)
- OAuth 방식: 주소 칸 바로 아래 — `H4-oauth-url-error-light.png`, `:448`(`error={fieldError.baseUrl}`) + `oauthGrant.ts:224-234`

라디오 하나 바꾸면 같은 문장이 이사한다. 접근성도 갈린다: 필드 단위 경로는 `SettingsFields.tsx:112-119`가 `aria-invalid`/`aria-describedby`를 묶어 주지만, 키 방식의 formError는 어떤 칸이 잘못됐는지 표시하지 않는다.

(키 경로의 formError는 이 PR 이전부터 그랬다. 다만 필드 단위 오류를 들여온 것이 이 PR이고, 같은 폼의 이웃을 그대로 둔 것도 이 PR이다.)

---

## [Medium] 5건

### M1. 한국어 문장을 `break-all` 값 칸에 넣었다

`SettingsFields.tsx:195`의 `dd`는 `min-w-0 break-all` — 슬러그·토큰·수치를 위한 규칙이다. 이 PR은 그 칸에 문장을 넣었다: `AiLinkSection.tsx:324`("라벨 없음. 연결 수정에서 적어 두세요"), `oauthGrant.ts:352`("없음. 다음 턴에 서버가 발급합니다"), `:360`("…에 만료됨. 다음 턴에 서버가 갱신합니다").

390px 실측에서 낱말 중간이 끊긴다: "202/6년", "갱/신합니다"(`G1-card-phone-expired-longlabel.png`). 같은 파일 `SectionShell:33-38`이 한국어 산문에 `break-keep`을 쓰기로 이미 정해 둔 것(MOMO-676 M-5)과 어긋난다.

### M2. 같은 함수가 만든 두 시각이 한 카드에서 다른 서체로 선다

둘 다 `oauthGrant.ts:368-370`의 `formatMoment`인데, "마지막 저장"은 `numeric: true`라 `font-mono` + tabular-nums(`AiLinkSection.tsx:352-357`), "액세스 토큰"은 비례 폰트(`:334-343`). `A7`/`J1`에서 "2026.  7.  26.  오전  2:20:00"만 자간이 벌어져 튄다. ko-KR 날짜 문자열에 tabular-nums는 얻는 것 없이 리듬만 깬다.

### M3. `accessTokenStatus`의 톤 셋 중 muted가 화면에 도달하지 않는다

`oauthGrant.ts:350-352`는 `tone: "muted"`를 돌려주지만 `AiLinkSection.tsx:338`은 `"warn"`만 분기한다. 그래서 "없음. 다음 턴에 서버가 발급합니다"가 실제 값과 똑같은 `--ink` 무게로 선다(`C3-card-notoken-nolabel-light.png`). ok를 잉크로 두는 것은 `:332-333`에 근거가 적혀 있지만 muted는 그냥 버려진다. 계산해 놓고 버리는 톤이 있으면 다음 사람은 그것이 반영된다고 믿는다.

### M4. 같은 패널이 같은 링크를 두 어휘로 부른다 (질문 ⑥)

이 PR이 카드 칩을 "키 없음" → "자격증명 없음"으로 고쳤지만(`AiLinkSection.tsx:94`), 같은 패널 200px 아래의 연결 순서 1차 행은 `AiLinkChain.tsx:106-108`에서 여전히 "키 있음"/"키 없음"이다.

`I1-card-and-chainhead-light.png`: OAuth 링크에 초록 "키 있음" 칩이 뜨고, 그 행의 문장 "이 항목은 위의 provider 연결에서 바꿉니다"가 같은 대상임을 못박는다. 카드가 방금 "이건 키가 아니라 ChatGPT 계정(OAuth)"이라고 말한 것을 아래 줄이 뒤집는다.

한 패널의 부재 어휘가 셋이 되었다: 칩 "자격증명 없음"(`:94`) / 행 "저장된 키 없음"(momo-core `model.ts:265`) / OAuth 행 "없음. 다음 턴에 서버가 발급합니다"(`oauthGrant.ts:352`).

### M5. auth.json 힌트가 컨트롤에 묶여 있지 않다

`SettingsFields.tsx:120-131` — hint `<p>`는 id도 없고 `aria-describedby`에도 들어가지 않는다(오류만 묶인다). 컴포넌트의 기존 성질이지만, "무엇을 붙여넣어야 하는가"(`~/.codex/auth.json` 내용을 그대로)가 과업 전부인 이 칸에서 처음 문제가 된다.

---

## [Nitpick] 5건

- **N1** `저장된 키 / 저장된 키 없음` — 값이 자기 키를 되풀이하고, `numeric: true`(`AiLinkSection.tsx:348`)라 한글이 mono로 벌어진다(`D2-card-nocred-light.png`). `maskedBearer`는 `packages/momo-core/src/features/settings/model.ts:264-267`으로 이 PR 밖.
- **N2** `AiLinkSection.tsx:523` "나중에 **이 판**에서 이 문장이 그대로 보입니다" — "이 판"은 제품 전체 사용자 문구 중 이 한 줄에만 있는 낱말이고(grep 확인), 실제로 나중에 보이는 것은 문장이 아니라 카드의 "계정" 값 한 줄이다.
- **N3** OAuth를 고르면 모드 라디오가 사라지는데(`A3-form-oauth-empty-light.png`) 왜 사라지는지·무엇으로 고정되는지 말하지 않는다(`oauthGrant.ts:96-100`이 external-hermes로 고정). 저장 뒤 카드에는 "모드 / 외부 provider"가 나타난다.
- **N4** 유효한 붙여넣기를 편집해 깨뜨리면 "읽은 내용" 상자가 말없이 사라진다(`A4` → `A6`). 의도된 침묵(`:142-146`)이지만, 사라지는 상자는 사라지는 이유를 말하지 않는다.
- **N5** `AiLinkSection.tsx:492-493` 주석은 "Input과 같은 토큰 클래스를 쓰되 높이만 다르다"고 하지만 패딩도 다르다(textarea `py-2` vs `design/ui/input.tsx` `py-1`), `transition-colors`/`tap-target`도 빠졌다. 화면 영향 없음, 주석만 사실과 다름.

---

## 잘한 것 (되돌리지 말 것)

- "ChatGPT로 로그인" 버튼 대신 붙여넣기 상자를 고른 판단(`:62-66`) — 존재하지 않는 흐름을 약속하지 않는다.
- 값이 아니라 **존재**만 말하는 파싱 미리보기(`oauthGrant.ts:269-286`) — "카드에 raw JSON 덤프 금지" 규칙을 정면으로 지킨 typed KV 행.
- 방식 전환 시 두 비밀을 모두 비우는 처리(`AiLinkSection.tsx:210-214`).
- `startEditing`이 링크가 실제로 쓰는 방식으로 폼을 여는 것(`:186-188`).
- 필드 이름으로 거절하는 한국어 오류 9종(`oauthGrant.ts:126/134/143/153/163/171/224/231/243`) — 무엇이 잘못됐고 다음에 무엇을 할지 말하고, 사과하지 않는다.
- 칩 "키 없음" → "자격증명 없음" 개명(`:94`) 자체는 옳은 방향.
- 네이티브 라디오/textarea, 빈 상태 = 한 줄 + 한 액션(`:372-386`), 파괴 액션 2단 확인(`:574-583`).

---

## Phase 커버리지

| Phase | 상태 | 근거 |
|---|---|---|
| 0 Prep | ✅ | 브랜치 빌드 + 24장 캡처(light/dark, 1280/900/390) |
| 1 Interaction | ✅ | 폼 전 흐름, 방식 전환 양방향, 오류 경로 2종, 탭 순서 실측 |
| 2 Viewport(웹 치환) | ✅ | 1280 / 900(`L1`,`L2`) / 390(`E1~E3`,`G1`) — 잘림·겹침 없음 |
| 3 Visual polish | ✅ | H4, M1, M2 |
| 4 Accessibility(웹 치환) | ✅ | 키보드 완주·포커스 링 확인, `tokens.contrast.test.ts` 27 tests pass, H5·M5가 발견 |
| 5 Robustness | ✅ | 빈·만료·무토큰·무라벨·긴 한국어+영문 라벨·다크·서버 구버전 필드 누락 |
| 6 Code health | ✅ | preflight 10/10, tsc/eslint/vitest/gate 전부 통과, M3·N5 |
| 7 Copy | ✅ | em-dash 0, hype 0, 동사 우선 준수. M4·N2 |

---

## Verdict

**PASS(blockers: 0)**

다만 High 5건으로 루브릭 임계(Blocker 0 **및 High ≤ 2**, 웹 스킬 §11의 게이트 목표는 High 0)를 넘으므로 이 보고서와 함께 구현자에게 되돌아간다.

최소 조건으로 **H1·H2·H4**는 이 PR에서 답이 필요하다고 본다: 비밀 규율·상태 충돌·경고 톤 과부하는 나중에 고치면 화면이 이미 그 습관을 굳힌 뒤가 된다. H3·H5는 판단이 갈릴 수 있으나 근거는 위 스크린샷에 있다.
