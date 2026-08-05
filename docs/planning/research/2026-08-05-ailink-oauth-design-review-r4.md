# Design Review R4 (수리 검증 패스) — 설정 > AI 연결

PR #1056 / `origin/feat/U3-ailink-oauth` @ **4c67b4a2**
베이스라인: `docs/planning/research/2026-08-05-ailink-oauth-design-review.md` (@ e7a6b310, Blocker 0 · High 5 · Medium 5 · Nit 5)
루브릭: `.claude/skills/momo-design-taste/references/review-rubric.md` + 웹 치환 `momo-design-taste-web` §11

**결과: Blocker 0 · High 1(신규) · Medium 1(신규) · Nit 3(신규)**
**High 5건 판정: 5/5 해소.** 단 H1·H3 수리가 각각 신규 결함을 하나씩 만들었다.

---

## 평가 근거 (무엇으로 평가했는가)

전면 재리뷰가 아니라 수리 검증이다. 코드 정독 + **직접 촬영한 실측 캡처 13장 + 계측값 30항목**.

- 브랜치 실물: `/private/tmp/u3-review-r3-wt` 임시 워크트리(4c67b4a2, `git status` clean)에서 모든 file:line을 **실재 확인**했다. 인용한 26개 좌표를 `sed -n`으로 한 줄씩 재출력해 대조했다.
- 런타임 증거: 4c67b4a2로 빌드된 `~/projects/momo-tracks/momo-worktrees/U3-ailink-oauth/clients/web/dist`(빌드 시각 02:57:18, src 체크아웃 02:57:14, 워크트리 clean)를 `vite preview`로 띄우고 `gate-ailink.mjs`와 동일한 라우트 스텁 방식으로 촬영했다. 워크트리 추적 파일은 건드리지 않았다.
- 토큰명은 `clients/web/src/design/tokens.css` **실측만** 사용했다: `--warn`(light `#8a5c00` / dark `#d4a72c`, :104), `--ink-muted`(light `#6a655f` / dark `#9b98a3`, :39), `--line`(:34), `--line-strong`(:35), `--surface-raised`(:29), `--accent`(:42), `--ok`(:103), `--danger`(:79).
- 증거 경로: `/private/tmp/u3-shots-r4/` (+ `measurements.txt`)
  - `R4-A` 붙여넣기 성공 직후(1280 light) · `R4-B1`,`R4-B2` 파싱 실패 경로
  - `R4-C` 저장된 링크 편집 중(시제 줄) · `R4-D` 커스텀 테넌트 주소 유실 · `R4-E`,`R4-E2` 키 링크 주소 공란화 + 필드 오류
  - `R4-F-light`,`R4-F-dark` 만료 토큰 + 실시간 429 동시 카드(앰버 인구조사)
  - `R4-G` 390px 미리보기 · `R4-I` 320px · `R4-J-light`,`R4-J-dark` 저장 카드와 미리보기 동시 노출 · `R4-K` 긴 한국어+영문 라벨 390px

## 기계 검사 원문 (@4c67b4a2)

```
$ bash scripts/design_preflight_web.sh
== design pre-flight (web), SKILL momo-design-taste-web §10 ==
   scanned: clients/web/src, clients/web/index.html
   excluded: src/design/tokens.css, src/design/tokens.contrast.test.ts

OK    emdash: 0          OK    raw_color: 0       OK    inline_style: 0
OK    arbitrary_tw: 0    OK    ai_gradient: 0     OK    toast: 0
OK    naked_focus: 0     OK    external_font: 0   OK    hype: 0
OK    pure_bw: 0

RESULT: PASS, 10/10 categories clean.

$ npx tsc -p tsconfig.app.json --noEmit                                  → EXIT 0
$ npx eslint AiLinkSection.tsx oauthGrant.ts SettingsFields.tsx AiLinkChain.tsx → EXIT 0
$ npx vitest run oauthGrant.test.ts tokens.contrast.test.ts              → 60 passed (2 files)
   (oauthGrant 33 tests: validateBaseUrl 표 4건 신규 / tokens.contrast 27 tests)
$ node gates/gate-ailink.mjs                                             → GATE PASS
   "no pasted credential reaches the DOM at any point in the form session;
    the card states its tense; amber is reserved for live state;
    the address follows the method."
```

변경 파일의 간격 클래스 실측: `gap-1 gap-2 gap-3 p-4 pl-3 px-3 py-2` = {4,8,12,16} 전부 스케일 내. 임의값(`[13px]` 류) 0. 사용자 문자열 em-dash 0(적중은 전부 코드 주석: `AiLinkSection.tsx:155`,`:244`,`:707`).

---

## High 5건 판정표

| # | 베이스라인 지적 | 판정 | 실측 근거 |
|---|---|---|---|
| **H1** | 한 폼에서 두 자격증명이 정반대 비밀 규율 (auth.json 평문 상시 노출) | **해소** (신규 Medium 1) | 붙여넣기 상자와 읽기 결과가 한 컨트롤의 두 상태(`AiLinkSection.tsx:567-590`). 파싱 성공 시 `readPaste`가 원문 제거(`:162-172`). 측정: 파싱 직후 textarea 개수 **0**, DOM 전체에 refresh_token **false** / access_token **false**. 게이트가 저장 이후 1지점 → 4지점(파싱 직후·재붙여넣기 왕복·제출 직전·저장 후)으로 확대되어 PASS. 실패 경로는 원문 유지(측정 B1/B3) + 필드 오류. |
| **H2** | 저장된 자격증명 상태와 편집 중 방식이 같은 라벨로 공존 | **해소** | 3점 모두 화면에서 확인. 시제 줄 `:448-455` "지금 저장되어 있는 연결입니다. 아래 폼을 저장하면 이 연결을 대체합니다."(editing일 때만), legend `:509` "바꿀 등록 방식", 버튼 `:649-652` "연결 교체 저장". 게이트가 3건 다 단정. `R4-C` |
| **H3** | 방식을 바꿔도 주소는 안 따라오는데 힌트는 바뀜(힌트가 거짓말) | **해소** (신규 **High** 1) | `switchMethod:250-251`이 주소를 양방향으로 이동시켜, 지적된 "api.openai.com/v1 밑에 ChatGPT 힌트" 조합은 재현되지 않는다(측정 D3/E2). 그러나 아래 [High-N1] 참조. |
| **H4** | 한 카드에서 `--warn`이 네 가지 의미 | **해소** | 최악 카드(만료 토큰 + 실시간 429)의 앰버 인구조사 = **정확히 2개**, 둘 다 살아 있는 상태: 만료 행(`:386`), 진단 목록(`:492`). 분류 칩은 muted(`:466`), 귀속 고지는 muted 인용 블록(`:482`). light/dark 동일. 게이트가 고지의 `text-warn`을 단정으로 금지. `R4-F-light`, `R4-F-dark` |
| **H5** | 같은 오류 문장이 방식에 따라 다른 자리에 뜸 | **해소** | `validateBaseUrl`(`oauthGrant.ts:229-241`)이 유일 규칙, `submitKey:259-273`이 주소·키 오류를 전부 fieldError로 보낸다. 키 경로 실측: 오류가 주소 칸 바로 아래, `aria-invalid=true`, `aria-describedby="provider-base-url-hint provider-base-url-error"` — 이전에 없던 접근성 결합까지 붙었다(M5도 같은 변경으로 해소). `R4-E2` |

### Medium/Nit 후속 (베이스라인 10건)

해소: **M1**(카드 한정 `prose` 플래그 `SettingsFields.tsx:199-220`, 계정·액세스 토큰 행 break-keep 실측) · **M2**(마지막 저장 numeric 제거 `:407`, font-mono 없음 실측) · **M3**(muted가 화면 도달, `rgb(106,101,95)` 실측) · **M4**(`AiLinkChain.tsx:110` "자격증명 있음/없음") · **M5** · **N2** · **N3** · **N5**.
잔존(범위 밖): **N1** `maskedBearer`는 momo-core `model.ts`. **N4**는 무효화(유효한 붙여넣기를 편집할 수 없게 됨).

---

## 신규 발견

### [High-N1] 등록 방식 라디오를 왕복하면 저장된 provider 주소가 조용히 바뀌어 저장된다

`AiLinkSection.tsx:250-251`은 주소를 **자격증명이 아니라 라디오의 함수**로 만들었고, 조작자가 갖고 있던 값의 기억이 없다.

와이어까지 측정했다. 커스텀 테넌트에 붙은 OAuth 링크를 열고, **주소 칸은 건드리지 않고** 키 라디오를 눌러 반대 방식을 훑어본 뒤 다시 OAuth로 돌아온 경우:

```
saved address (card)         : https://codex.acme-internal.test/backend-api/codex
form address on open         : https://codex.acme-internal.test/backend-api/codex
form address after round-trip: https://chatgpt.com/backend-api/codex
PUT body  → baseUrl          : https://chatgpt.com/backend-api/codex
```

`R4-D`에 이 화면이 그대로 있다: 카드는 `codex.acme-internal.test/backend-api/codex`가 저장된 연결이라고 말하고, 300px 아래 폼의 주소 칸은 `https://chatgpt.com/backend-api/codex`이며, 버튼은 "연결 교체 저장"이다. 누르면 조작자가 한 글자도 고치지 않은 엔드포인트가 교체된다. 바로 위 힌트가 "다른 테넌트를 쓸 때만 바꾸세요"라고 초대하는 그 설정이 지워지는 자리다.

키 링크 쪽은 반대로 **공란**이 된다(`R4-E`): `https://api.openai.com/v1` → OAuth → 키로 돌아오면 `:251`이 값을 지우고 복원하지 않아 칸이 `""`가 되고, 제출하면 "provider 주소를 입력하세요."(측정 E4)가 뜬다. 카드는 여전히 `api.openai.com/v1`을 저장된 주소로 표시하고 있다.

이 경로가 안 보이는 이유: 새 게이트 단정(`gate-ailink.mjs` H3 블록)은 **저장된 주소가 곧 기본값인 OAuth 링크**로만 왕복을 돌린다. 그 경우에만 왕복이 무해하다.

→ H3의 원래 결함(화면이 거짓말)은 사라졌지만, 그 대가로 화면이 참말을 하면서 조작자의 값을 버린다. 방식이 주소를 제안하는 것과 방식이 주소를 소유하는 것은 다르다. 두 방식이 각자 마지막으로 들고 있던 주소를 기억할 방법이 필요하다.

### [Medium-N2] 붙여넣기 성공 순간 포커스가 `<body>`로 떨어지고, 무슨 일이 일어났는지 아무도 알리지 않는다

H1 수리의 핵심 동작은 "이해되는 순간 입력 칸이 사라지는 것"이다. 측정:

```
A4 focus right after successful paste : body (BODY)
J-light preview role/aria-live        : null / 없음
```

- 시각 사용자에게는 읽기 결과 상자가 답을 준다. Chromium은 제거된 요소 자리에서 순차 포커스를 이어 주므로 Tab이 「다시 붙여넣기」(A5) → 「누구의 구독인가」(A6)로 정상 진행한다. 즉 **"패널 top으로 튕긴다"는 일은 Chromium에서는 일어나지 않는다.**
- 문제는 스크린리더 경로다. `aria-describedby`로 힌트·오류가 묶여 있던 컨트롤이 파괴되는데 대체물(`:567-590`)에 live region이 없어서, 원문이 지워졌다는 사실도 무엇이 읽혔다는 사실도 발화되지 않는다. 포커스가 body이므로 포커스 링도 없다.
- 이 파일 자신이 정반대 규칙을 두 번 적어 두었다: `SettingsFields.tsx:285-291`(ChoiceRadios.busy)과 `:445-453`(SaveButton) 모두 "포커스된 요소를 죽이면 focus가 <body>로 떨어진다"를 이유로 `disabled` 대신 `aria-disabled`를 쓴다. 새 스왑만 그 규칙 밖에 있다.
- **확인 필요**: 측정은 Chromium 한정이다. 제품 셸은 Tauri 2(macOS WKWebView)이고 WebKit의 순차 포커스 시작점 동작과 VoiceOver 발화는 측정하지 않았다.

### [Nit-N3] `grantPreviewRows`의 한국어 문장이 `break-all` 칸에 있다 (M1의 미도달분)

M1 수리는 상태 카드에만 닿았다. 이 PR이 새로 만든 미리보기(`oauthGrant.ts:285-302`)는 `prose` 플래그 없이 `KeyValueRows`에 들어가므로 "없음. 다음 턴에 서버가 발급합니다"가 `word-break: break-all` 칸에 선다(측정 G1). **다만 390px·320px 모두 한 줄에 들어가 실제 음절 절단은 관측되지 않았다**(`R4-G`, `R4-I`). 지금은 잠복 상태이고 문장이 길어지면 M1이 그대로 재발한다.

### [Nit-N4] 인용 블록이 이 코드베이스에 두 번째 사례가 없는 일회성 장식이다

귀속 고지(`AiLinkSection.tsx:482`)의 `border-l-2 border-line pl-3`은 `clients/web/src` 전체에서 유일한 `border-l-*` 사용이다(grep 확인 — 나머지 테두리는 전부 1px `border`/`border-b`/`border-r`). 계산값도 `dt` 라벨과 같다: light 12px/`rgb(106,101,95)`, dark 12px/`rgb(155,152,163)`. 즉 서버 정본 정책 문장과 필드 라벨을 가르는 것이 2px 괘선과 12px 들여쓰기뿐이다. 톤 판단 자체는 옳다(앰버 과부하를 풀었고, 카드는 칩·「계정」 행으로 귀속을 두 번 더 말한다). 사례가 하나뿐인 규칙이라는 점만 기록한다.

### [Nit-N5] 「다시 붙여넣기」는 읽은 grant를 확인 없이 버리고 빈 상자를 돌려준다

`:581-584`가 `setGrant(null)`만 하므로 오조작 시 파일에서 다시 복사해야 한다(게이트는 빈 상자 복귀를 의도로 단정한다). 파괴 범위가 로컬 파일 재복사에 그쳐 Nit로 둔다.

---

## 수리가 되돌리지 말아야 할 것

- 실패 경로에서 원문을 남기는 판단(`:162-172` 주석): 고쳐야 할 사람에게 문서를 보여 주는 것이 맞고, 오류는 제출 시점까지 기다려 매 타건 빨간 글씨를 만들지 않는다(`R4-B2`).
- 게이트를 "저장 후 1지점"에서 "폼 세션 전체 4지점"으로 옮긴 것. H1이 측정되지 않던 창을 정확히 덮었다.
- H4를 색 교체가 아니라 **의미 분리**로 푼 것: 분류=muted 칩, 정책=인용, 살아 있는 상태=앰버. dark에서도 무너지지 않는다.
- H5 수리가 접근성 결합(`aria-invalid`/`aria-describedby`)을 키 경로까지 끌고 온 것.

---

## Phase 커버리지

| Phase | 상태 | 근거 |
|---|---|---|
| 0 Prep | ✅ | 4c67b4a2 빌드 + 신규 캡처 13장(light/dark, 1280/390/320) + 계측 30항목 |
| 1 Interaction | ✅ | 붙여넣기 성공·실패, 방식 왕복 양방향(D/E), 오류 경로 2종, Tab 순서·activeElement 실측 |
| 2 Viewport(웹 치환) | ✅ | 1280 / 390 / 320 — 잘림·겹침 없음, 긴 한국어+영문 라벨 `R4-K` |
| 3 Visual polish | ✅ | 앰버 인구조사, 계산된 색·크기 대조, 토큰명 tokens.css 실측, 간격 전수 |
| 4 Accessibility(웹 치환) | ✅ | aria-invalid/describedby 실측, 스왑 후 포커스·live region 실측(→ Medium-N2), contrast 27 tests pass |
| 5 Robustness | ✅ | 만료·무토큰·무라벨·커스텀 테넌트·키 링크·다크·긴 라벨 |
| 6 Code health | ✅ | preflight 10/10, tsc 0, eslint 0, vitest 60 pass, gate PASS |
| 7 Copy | ✅ | 문자열 em-dash 0, hype 0, 신규 문구 동사 우선. N2/N3 수리 확인 |

---

## Verdict

**PASS (blockers: 0, High: 1)**

루브릭 임계(Blocker 0 **및** High ≤ 2)를 통과한다. 베이스라인 High 5건은 전부 화면과 와이어에서 해소가 확인됐고, 수리가 만든 신규 결함은 High 1 + Medium 1이다.

- **[High-N1]은 이 PR에서 답이 필요하다**고 본다: 조작자가 건드리지 않은 엔드포인트가 교체 저장되는 경로이고, 새 게이트가 그 경로를 돌지 않아 다음 회귀도 잡히지 않는다.
- [Medium-N2]는 이 PR에서 고치면 가장 싸지만(스왑 결과에 live region + 포커스 이관), 후속 티켓도 수용 가능하다. 다만 Tauri/WKWebView 실측이 없다는 점은 남는다.
- Nit 3건은 기록만.

웹 스킬 §11의 게이트 목표는 High 0이므로, 그 기준을 쓰면 [High-N1] 하나가 남는다.
