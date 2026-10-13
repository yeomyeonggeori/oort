# 타이포 체계 재정의 제안 (Proposed, #3774)

> **상태: Accepted (2026-10-13, owner 성재).** 결정 4건이 아래와 같이 정해졌고, 단계 2(적용)는 PR #3776 위에 쌓인 PR들로 진행한다. 정본 절은 [README §2.5](README.md#25-타이포)이며 값은 이 문서 §3이 정본이다. 본문 기준이 14에서 **15**로 바뀌어 §3.1은 추천안(14)이 아니라 결정안으로 다시 맞췄다.
> 전후 비교 캡처: [`typography-preview/`](typography-preview/) (2026-10-13, 실제 앱 컴포넌트, Chromium 1440 라이트·다크. 왼쪽 `track/uxui` 기준, 오른쪽 #3774 토큰 적용. 인박스 픽스처의 항목 수는 캡처마다 시각 기준이 달라 다를 수 있다. 폰 RN 화면은 이 폴더에 없고 폰 PR이 jest로 증명한다). 재생성은 `scripts/capture-screens.mjs`(`CAPTURE_PROFILE=shell CAPTURE_WIDTH=1440`), `capture-inbox-mailbox.mjs`, `capture-settings-profile.mjs`, `capture-onboarding-o3.mjs`를 기준선과 변경 브랜치에서 각각 돌려 나란히 붙인다.

## 결정 기록 (2026-10-13, owner 성재, AskUserQuestion)

| # | 결정 | 결과 | 원문·비고 |
|---|---|---|---|
| 1 | 웹 본문 기준 크기 | **15로 올린다** (추천은 14였다) | 「15로 올리기」. body·body-strong 15, 나머지 역할은 위계가 맞도록 다시 맞춘다. 줄 높이는 22(1.47, Slack 15/1.467과 같은 비율)로 둔다 |
| 2 | 한글 서체 | **시스템 서체 기본 + 사용자 글꼴 연동** | 「vscode나 다른곳처럼 기본 중심으로 가되 커스텀 폰트도 사용자가 설치 및 연동할 수 있는 형태 나쁘지 않을 듯.」 기본 스택에 ja fallback과 `:lang()` 규칙을 더하고, 설정 › 외양에 「글꼴」 항목(본문·코드 두 칸, 이 기기 저장, 번들·새 의존 없음)을 둔다. **폰은 제외**: RN 폰트는 빌드 때 링크되고 런타임 열거·등록은 네이티브 모듈 없이는 안 되며, 폰은 Dynamic Type으로 글자 크기 요구를 이미 다룬다 |
| 3 | 폰 Dynamic Type | **본문은 제한 없음, 크롬 1.6 상한** | 상한 상수는 `design/atoms.tsx` 한 곳으로 모은다 |
| 4 | 굵기 800 폐지 | **폐지**(묻지 않았고 추천안 적용) | 400 / 500 / 600 / 700만 쓴다. S0 워드마크 한 곳은 유지(스케일 밖 예외) |

## 0. 한 장 요약

- 웹 스케일은 5단(11/12/14/16/20)인데, **토큰 밖에서 같은 역할이 표면마다 다른 크기**로 쓰인다(13.5·12.5·15·17·18·13). 이 값들은 시안에서 그대로 옮겨 온 것이라 사다리에 이름이 없다.
- 위계가 크기보다 **굵기 800/700과 큰 글자**로 만들어져 있다. 반면 본문 계층(사이드바 항목, 설정 행, 메타)은 같은 14/12에 weight만 다르다. 「크고 플레인」은 이 두 쪽이 겹친 결과다.
- 폰은 **두 개의 스케일**(`font`, `ds2Type`)이 병존하고, 웹과 값·이름이 모두 다르다. themes-2.0 §5는 웹 본문을 15라고 적었지만 토큰은 14다(문서와 코드의 불일치).
- 언어 대응은 `lang="ko"` 고정, ja fallback 없음, 한·영 행간·자간 분리 규칙 없음이다.

## 1. 현황 감사

### 1.1 토큰과 사용 분포 (웹, 2026-10-13 worktree 기준 `clients/web/src`)

| 역할 토큰 | px / 줄 높이 | tsx 사용 횟수 | 비고 |
|---|---|---|---|
| `text-meta` | 12 / 18 | 991 | **전체의 64%.** 메타·보조·설명이 모두 12 |
| `text-body` | 14 / 22 | 399 | 메시지 본문, 사이드바 항목, 컨트롤 |
| `text-timestamp` | 11 / 16 | 120 | 시각, 배지, 카운터 |
| `text-title` | 16 / 24 | 49 | 표면 제목 |
| `text-display` | 20 / 28 | 14 | 표면당 하나 |

굵기: `font-semibold` 171 · `font-medium` 114 · `font-bold` 37 · `font-normal` 16. CSS 안의 `font-weight` 리터럴은 700 ×7, 600 ×6, **800 ×4**, 500 ×3. `text-[..px]` 임의값은 tsx에 0건(프리플라이트가 막는다). `leading-*` 4건, `tracking-*` 1건, `uppercase` 1건, `break-keep` 486 / `break-words` 58 / `break-all` 30, `data-numeric` 174, `font-mono` 109.

### 1.2 토큰 밖 하드코딩 (`clients/web/src/design/tokens.css`)

| 값 | 위치 | 같은 역할의 다른 표면 |
|---|---|---|
| 18 / 800 / -0.03em | `sidebar-ws-name` | 워크스페이스 이름. 제품에서 **가장 크고 가장 굵은** 글자 중 하나 |
| 17 / 800 / -0.02em | `channel-head-title` (600px 이상) | 같은 롤이 모바일 폭에서는 14/600이라 폭에 따라 3pt·200 weight가 뛴다 |
| 15 / 700, 15 / 800 | `ai-connect-title`, `ai-connect-mark` | 카드 제목. `text-title` 16과 1 차이 |
| 13.5 | `sidebar-search`, `channel-head-topic`, `sidebar-now-name` | 보조 문장. `text-meta` 12와 `text-body` 14 사이의 이름 없는 값 |
| 13 | `ai-connect-detail`, `ai-connect-note` | 위와 같은 역할인데 0.5 작다 |
| 12.5 | `ai-connect-term` (코드) | 코드 크기가 따로 정해져 있지 않다 |
| 12.5 (`0.78125rem`) | `sidebar-section-label`, `sidebar-now-state` | 섹션 머리 weight 700 |
| 11.5 (`0.71875rem`) | `sidebar-kbd` | `text-timestamp` 11과 0.5 차이 |
| 40 / 800 / -0.045em | `onboarding-welcome-wordmark` | 환영 화면 워드마크. 스케일 밖 의도된 예외(S0) |

letter-spacing 리터럴이 6종(-0.045 / -0.03 / -0.02 / -0.01 / -0.005 / +0.02em)이고 어느 것도 이름이 없다. 한글 본문에도 -0.005em가 걸린다(`sidebar-row`).

### 1.3 폰 (`clients/mobile/src`)

| 항목 | 값 |
|---|---|
| `font` 스케일 | display 32 · title 26 · heading 18 · body 16 · label 13 · meta 12 |
| `ds2Type` 스케일(2.0 시안) | largeTitle 30 · title 24 · headline 17 · body 16 · callout 15 · subhead 13.5 · caption 12 · badge 10.5 |
| 사용 횟수(토큰 경유) | `font.meta` 166 · `font.label` 145 · `font.body` 65 · `ds2Type.caption` 12 · `font.heading` 9 · `font.title` 8 · 기타 20여 |
| 리터럴 | `fontSize` 30·24·11·10 각 1, 별도 모듈(`PHONE_OB`, `NOTIF`, `CONV`, `SAS`, `WELCOME`)이 각자 크기를 가짐 |
| 줄 높이 | `line` {head 15, meta 17, label 18, body 22} + 리터럴 17/18 ×17, 20 ×5, 22 ×4, 19 ×4, 34 ×3 등 |
| 굵기 | 600 ×140 · 700 ×50 · 800 ×5 · 400 ×4 · 500 ×3 |
| 동적 글자 크기 | `fontScale` 읽는 곳 46, `maxFontSizeMultiplier` 28곳(`BAR_CONTROL_MAX_SCALE` 등 상수), `allowFontScaling` 1곳. **상한이 컴포넌트마다 흩어져** 있고 정책 문서가 없다 |
| 서체 | `fontFamily` 지정은 코드의 `Menlo` 7곳뿐, 나머지는 시스템(SF + Apple SD Gothic Neo) |
| 숫자 | `fontVariant: ['tabular-nums']` 12곳 |

### 1.4 폰트 스택

| 용도 | 웹·데스크탑 현재 | 폰 현재 |
|---|---|---|
| sans | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif` | 시스템 기본 |
| mono | `ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace` | `Menlo` (iOS) / `monospace` |
| 한글 | 위 스택의 뒤쪽 fallback. 영문 글리프가 먼저 잡히면 한글은 문자별 fallback | 시스템 |
| 일본어 | **없음** (`ja` fallback 미지정, `<html lang="ko">` 고정) | 시스템 |
| 숫자 | `data-numeric`로 `tabular-nums`(웹 174곳), 폰 12곳 | 일부 |
| 외부 폰트 | 금지(CSP + 오프라인, 프리플라이트 `external_font`) | 번들 폰트 없음 |

### 1.5 주요 문제 5개

1. **같은 역할, 다른 크기.** 보조 문장이 13.5/13/12.5/12, 카드 제목이 15/16/17/18로 흩어져 있다. 이름 없는 값이 이름 있는 값보다 많은 화면이 있다.
2. **위계가 굵기 800과 큰 글자에 몰려 있다.** 워크스페이스 이름 18/800, 채널 제목 17/800이 첫 시선을 가져가고, 같은 화면의 본문 계층은 14/12 weight만 다르다. 시스템 서체의 굵기 단계는 플랫폼마다 다르므로(Malgun Gothic은 Regular/Bold 두 단계 [추정]) 800과 700의 차이는 mac 밖에서 사라질 수 있다.
3. **메타 12가 너무 많이 쓰인다(991).** 설명, 부제, 에러, 시각 옆 메타가 전부 한 크기라 계층이 없다. 11(timestamp)과 12(meta)는 1pt 차이라 눈에 띄지 않는다.
4. **웹과 폰 스케일이 따로 자란다.** 폰은 두 스케일이 병존하고, themes-2.0 §5(웹 본문 15)와 토큰(14)이 어긋난다. 폰 본문 16의 근거(「iOS 입력창 줌 방지」)는 Safari/WebView 규칙이고 RN `TextInput`에는 해당하지 않는다. 웹이 모바일 폭에서 쓰는 `--field-text-floor` 16과 구분해서 적어야 한다.
5. **언어 대응 규칙이 없다.** `lang="ko"` 고정, 일본어 fallback 없음, 한글·영문의 행간/자간 분리 없음, `break-all` 30곳(식별자·URL 용도인지 미감사), 폰 Dynamic Type 상한 정책 없음.

## 2. 레퍼런스 실측

수치는 앱이 실제로 배포한 CSS와 오픈소스 스타일시트를 2026-10-13에 내려받아 읽은 것이다. 읽지 못한 칸은 「확인불가」, 상속으로 짐작한 칸은 [추정]이다. iOS pt와 CSS px는 같은 값으로 읽는다. 표기는 `크기 / 줄 높이 / 굵기`.

| 앱 | 본문 | 작성자 | 시각·메타 | 입력창 | 코드 | 출처 |
|---|---|---|---|---|---|---|
| Slack (웹) | 15 / 1.467 / 400 | 15[추정] / 700 | 12 | 15 | 블록 12 / 1.15rem | `a.slack-edge.com/bv1-13/application.8a95be3d57960324.min.css` 외 2개 (`.c-timestamp`, `--_composer-font-size`, `.p-rich_text_block`) |
| Discord (웹) | 16 / 22 / 400 | 16[추정] / 600 | 12 / 1.333 / 500 [추정] | 16 / 22 | 블록 14 / 18, 인라인 85% | `discord.com/app`이 로드하는 CSS (`.markup`, `.textArea`, `.username`) |
| Telegram Web K | 16 / 1.3125 / 400 | 확인불가 / 500 | 12 (본문-4) | 확인불가 | 확인불가 | `morethanwords/tweb` `src/scss/base.scss`, `partials/_chatBubble.scss` |
| Telegram Desktop | 확인불가(`fsize`) | semibold | 13 (`msgDateFont`) | 확인불가 | 확인불가 | `telegramdesktop/tdesktop` `ui/chat/chat.style`, `dialogs/dialogs.style` |
| Linear (웹) | 에디터 15 / 1.7, 설명 13 / 1.5 | 확인불가 | 11~12 | 확인불가 | Berkeley Mono | `static.linear.app/client/assets/style-7I74HSNq.css`, `linear.app/now/how-we-redesigned-the-linear-ui` |
| Element (Compound) | body-md 15 / 1.5 [추정] | 확인불가 | body-xs 11, body-sm 13 | 확인불가 | 확인불가 | `element-hq/compound-design-tokens` `compound-design-tokens.css` |
| iOS (Apple HIG) | Body 17 / 22 (Large) | Headline 17 / 22 Semibold | Footnote 13 / 18, Caption1 12 / 16 | 확인불가 | 확인불가 | `developer.apple.com/design/human-interface-guidelines/typography` (데이터 JSON) |
| Aside (데스크탑) | 확인불가 | 확인불가 | 확인불가 | 확인불가 | 확인불가 | 캡처 `aside-channels.png`(3370px 원본)를 눈으로 읽은 [추정]: 설정 사이드바 항목 13~14, 섹션 머리 12, 페이지 제목 22~24 |
| Raycast, 카카오톡, iMessage, Slack iOS, Discord 모바일, Telegram iOS | 확인불가 | | | | | 공개 수치 없음. iMessage가 Body 17을 그대로 쓰는지는 근거 없음 |

굵기·행간·자간에서 읽은 것:

- **본문 행간은 Latin 기준 1.31~1.5**다(Telegram 1.3125, Discord 1.375, Slack 1.467, Element 1.5). oort 웹 본문은 14/22 = 1.57로 이미 느슨한 쪽이다. 1.5~1.65는 긴 글(문서) 쪽 관행이고 메신저 본문의 근거가 아니다.
- **굵기는 400/500/600이 중심**이고 800을 쓰는 곳은 읽은 범위에서 없다. Telegram은 이름이 500, Discord는 이름이 600, Slack은 이름이 700, Linear는 가변 서체로 기본이 **450**이다.
- **자간은 음수**다. SF Pro 15pt -0.016em, 17pt -0.026em(Apple 표). Element 15px -0.0088em, 17px -0.0128em, 제목 20~32px -0.017~-0.022em. 한글 헤딩의 -0.01~-0.02em은 이 범위 안이다(한글 글리프를 따로 잰 근거는 아니다).
- **대문자 섹션 머리**는 Discord만 확인했다(12 / 600 / 대문자 / +0.025em). Slack·Linear 사이드바는 정적 CSS에서 읽지 못했다.
- **로케일별 서체 분리**는 Slack이 쓴다. ko는 `NotoSansKR`, ja는 `NotoSansJP`로 `--font-family-default`를 교체한다. Discord는 한국어 스택에 `Apple SD Gothic Neo`, `맑은 고딕`을 명시한다.
- **본문 크기 비교의 결론**: 읽은 메신저의 본문은 15~16이고 oort 웹 본문 14가 가장 작다. 메타 12는 Slack·Discord·Telegram과 같다. 따라서 「본문이 너무 크다」는 근거가 없고, 「크고 플레인」은 **제목·워크스페이스 이름 18/800, 17/800**과 **사이드바 14**에서 온다.
- 한계: 작성자·시각 크기는 상속이라 `getComputedStyle` 실측이 아니다. 로그인한 앱 DOM으로 재측정하면 [추정] 칸이 닫힌다(후속).

## 3. 제안 스케일

### 3.1 역할 토큰 (웹·데스크탑, rem 기준 px) — 본문 15 결정안

값은 `clients/web/src/design/tokens.css` `@theme`와 같다. `designSystem.test.ts`가 롤마다 줄 높이가 있고, 줄 높이가 글자보다 크고, **크기가 서로 달라야** 한다고 잰다.

| 역할 (Tailwind) | 크기 / 줄 높이 | 굵기 | 자간 | 쓰는 자리 | 이전 값 |
|---|---|---|---|---|---|
| `display` (`text-display`) | 22 / 30 | 700 | -0.02em | 표면당 하나. 설정·온보딩 제목 | 20 / 28 |
| `title` (`text-title`) | 17 / 24 | 600 | -0.01em | 패널·다이얼로그 제목 | 16 / 24 |
| `heading` (`text-heading`, 새로 생김) | 16 / 22 | 600 (워크스페이스 이름·채널 머리 700) | -0.01em | 카드·섹션 제목, 워크스페이스 이름, 채널 머리 | 15 / 700, 17 / 800, 18 / 800 |
| `body` (`text-body`) | 15 / 22 | 400 | 0 | 메시지, 설명 문장 | 14 / 22 |
| `body-strong` (`text-body font-semibold`) | 15 / 22 | 600 | 0 | 작성자 이름, 행 제목. 별도 크기 토큰 없음(크기 유일성 시험 때문) | 14 / 600 |
| `label` (`text-label`, 새로 생김) | 14 / 20 | 500 (안 읽음 600) | 0 | 사이드바 항목, 메뉴, 검색 칸, 버튼·입력·선택 컨트롤 | 14 / 22 (body), 13.5 |
| `code` (`text-code`, 새로 생김) | 13 / 20 | 400 | 0 | 코드 블록, 인라인 코드, `font-mono` | 12.5 / 12 |
| `meta` (`text-meta`) | 12 / 18 | 400 | 0 | 보조 문장, 부제, 에러, 스레드 요약. 색은 `ink-muted` | 12 / 18 (그대로) |
| `caption` (`text-timestamp`) | 11 / 16 | 500 | +0.02em | 시각, 배지 수, 단축키. 이름은 `timestamp`로 남긴다(이름 바꾸기는 열린 PR과 충돌하므로 후속) | 11 / 16 |
| 숫자 | 둘러싼 역할을 따른다 | | | `data-numeric`(tabular-nums). 역할이 아니라 속성 | 그대로 |

- **크기 8개(11·12·13·14·15·16·17·22)로 닫힌다.** 13.5·12.5·11.5·10.5·18·40(워드마크 예외)은 역할로 접혔고, CSS 안의 `font-size` 리터럴은 `designSystem.test.ts`가 막는다(§3.5).
- 본문이 15가 되면서 **컨트롤은 14(`label`)에 남겼다.** 버튼·입력·메뉴 항목이 같이 커지지 않으므로 컨트롤의 외형은 그대로이고, 본문(메시지·설명)만 한 단계 커진다. 사이드바 항목도 14/500이라 본문(15/400)과 같은 줄에서 구분된다.
- `heading`이 `body`와 같은 15가 되지 않도록 16으로 잡았다. 크기 차이가 1이라 위계는 굵기(600~700)가 만든다. `title`(17)·`display`(22)가 그 위 단이다.
- **굵기는 400 / 500 / 600 / 700만 쓴다.** 800은 폐지한다. 한 컴포넌트에 두 굵기까지.
- 채널 머리(17/800 → 16/700)와 워크스페이스 이름(18/800 → 16/700)이 내려가고 본문이 올라간다. 본문과 이름의 크기 차이가 줄어 위계는 굵기와 색이 맡는다.
- 줄 높이 22(1.47)는 한글 본문에 충분하다(메신저 실측 1.31~1.5, §2). 컴포저의 `1lh`, 34px 행 같은 22 기반 배치가 그대로 맞는다.

### 3.2 위계를 크기가 아니라 굵기와 색으로 만든다

「크기를 줄이는 기준」:

1. **한 표면에 크기 단계는 세 개까지**(예: 타임라인은 15 / 12 / 11, 설정은 22 / 16 / 15 / 12). 단계가 늘면 먼저 굵기나 `ink-muted`로 풀 수 있는지 본다.
2. **제목은 본문보다 한 단계(1~2px)만 크게** 하고 굵기(600~700)로 구분한다. 본문 15에 대해 17 이상은 표면당 하나다.
3. **같은 역할은 폭이 바뀌어도 같은 크기**다. 채널 제목이 폭에 따라 14/600 ↔ 17/800로 뛰지 않는다(지금은 `heading`으로 통일).
4. **메타는 크기를 줄이기 전에 색을 먼저 낮춘다.** 11과 12는 구분이 안 되므로 `caption`은 크기보다 굵기 500과 자간 +0.02em으로 구분한다.
5. 정보 계층은 `ink`(이름·제목) > `ink-muted`(메타) 두 단계 색 대비로 만든다. 대비 수치는 `tokens.contrast.test.ts`가 잰다(건드리지 않는다).

### 3.3 폰 (pt, Dynamic Type 기준)

폰은 `font`와 `ds2Type` 두 스케일을 **하나의 역할 표**로 합친다. 값은 웹과 짝짓지 않는다(§2.5의 기존 원칙 유지: 줄 높이는 절대 pt, 웹은 무단위 비율).

| 역할 | pt / 줄 | 굵기 | 자간 | 지금 | iOS 대응(HIG, Large) |
|---|---|---|---|---|---|
| `display` | 30 / 36 | 700 | -0.02em | `ds2Type.largeTitle` 30 / 800 | Large Title 34/41 |
| `title` | 22 / 28 | 700 | -0.02em | `ds2Type.title` 24, `font.title` 26 | Title2 22/28 |
| `heading` | 17 / 22 | 600 | 0 | `ds2Type.headline` 17, `font.heading` 18 | Headline 17/22 |
| `body` | 16 / 23 | 400 | 0 | `font.body` 16 / `line.body` 22 | Body 17/22 (한 단계 작게) |
| `body-strong` | 16 / 23 | 600 | 0 | 같은 크기 600 | |
| `label` | 13 / 18 | 500~600 | 0 | `font.label` 13, `ds2Type.subhead` 13.5 | Footnote 13/18 |
| `meta` | 12 / 16 | 400 | 0 | `font.meta` 12 / `line.meta` 17 | Caption1 12/16 |
| `caption` | 11 / 14 | 500 | +0.02em | 리터럴 11·10, `ds2Type.badge` 10.5 | Caption2 11/13 |
| `code` | 12 / 17 | 400 | 0 | `Menlo` 12 / 17 | |

- 본문 줄 높이 22 → **23**: 이미 `ds2Type.body` 16/23(themes-2.0 §5)이 있고 `line.body` 22와 갈라져 있다. 둘을 23으로 합친다(1.44, 레퍼런스 1.31~1.5 안). 행마다 한 줄당 1pt 커진다(미리보기가 이 값이다).
- 폰 본문 16의 근거 문장(「iOS 입력창이 줌을 멈추는 크기」)은 **Safari/WebView 규칙**이다. RN `TextInput`에는 적용되지 않으므로 README의 문장을 정정한다. 16을 유지하는 이유는 iOS Body 17보다 한 단계 작은 메신저 밀도와 카카오톡·Telegram 계열의 본문 크기에 맞추기 위해서다(카카오톡 값은 확인불가).
- 굵기: `800`(5곳)은 700으로, 리터럴 `fontWeight`는 `600 / 700`만 쓴다.
- **Dynamic Type 정책**(결정 3): 크롬(탭바·헤더·버튼)은 `maxFontSizeMultiplier` 1.6(현행 `BAR_CONTROL_MAX_SCALE`)로 상한을 두고, 메시지 본문·입력 텍스트는 상한을 두지 않는다(Apple 표에서 AX1 = 1.65배, AX5 = 3.12배). 상수는 `design/atoms.tsx`의 한 곳에서만 읽는다(지금은 `HEAD_MAX_SCALE`·`SAS_MAX_SCALE` 등이 개별로 있다). 줄 높이는 `fontScale`을 곱해 따라가게 한다(`Composer.tsx`가 이미 그렇게 한다).

### 3.4 한글·영문·일본어 대응

**서체 스택 (결정 2 추천안 A: 시스템 서체 유지, ja 보강)**

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
  "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;      /* 기본(ko) */
:root:lang(ja) { --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
  "Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", "Meiryo", sans-serif; }
:root:lang(en) { --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
  "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif; }
--font-mono: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas,
  "D2Coding", monospace;                                                   /* 한글 고정폭은 D2Coding이 설치된 경우만 */
```

- `<html lang>`는 사용자 로케일을 따라간다(지금 `ko` 고정). 로케일 인프라(`i18n`)는 아직 없으므로 적용 단계에서는 스택과 `:lang()` 규칙까지만 넣고, 로케일 전환은 별도 이슈다.
- 폰은 시스템 서체가 한·영·일을 모두 맡는다(SF + Apple SD Gothic Neo + Hiragino). 번들 서체를 넣지 않는다.

**행간·자간 분리 규칙**

| 대상 | 행간 | 자간 | 근거 |
|---|---|---|---|
| 한글 본문(15) | 22px(1.47) | 0 | 한글은 라틴보다 획이 조밀해 1.5 이상이 필요. 메신저 실측은 1.31~1.5라 더 줄일 필요는 없음 |
| 한글·일본어 헤딩 | 위 표의 줄 높이 | -0.01~-0.02em | Apple·Element의 음수 자간 범위. 본문에는 걸지 않는다(현행 `sidebar-row -0.005em`을 0으로) |
| 영문 대문자 라벨 | | +0.04em 이상, **한 표면에 한 곳** | Discord 12/600/+0.025em을 참고. 한글에는 대문자가 없으므로 `caption` 기본값 +0.02em만 적용 |
| 숫자 | | | `tabular-nums` 항상, 열을 이루면 우측 정렬 |
| 일본어 본문 | 한글과 같음 | 0 | `text-spacing-trim`은 실험 단계라 의존하지 않는다 |

**줄바꿈 정책**

- 기본은 `word-break: keep-all` + `overflow-wrap: anywhere`(한글 어절 단위로 끊고, 긴 식별자는 넘치지 않게). 이미 486곳이 `break-keep`이다.
- `break-all`(30곳)은 URL·해시·식별자 같은 **공백 없는 토큰**에만 허용한다(적용 단계에서 30곳 전수 감사).
- 일본어는 `keep-all`이 어절 정보가 없어 한 줄이 넘칠 수 있다. `:lang(ja)`에서는 `word-break: normal; line-break: strict`를 쓴다.
- 입력창은 모바일 웹에서 16px 바닥(`--field-text-floor`)을 유지한다(Safari 줌 방지, 웹 한정).

### 3.5 적용 계획과 진행 (단계 2)

1. 토큰: `tokens.css`의 `--text-*`에 `heading`·`label`·`code`·`body-strong`을 넣고 `timestamp`를 `caption`으로 이름을 바꾼다. 하드코딩된 13.5·12.5·11.5·17·18·15를 역할 이름으로 교체한다. `designSystem.test.ts`의 「롤마다 줄 높이·크기 중복 금지」 시험을 새 표로 갱신한다.
2. 폰: `font`와 `ds2Type`을 하나로 합치고 `line`을 역할에 붙인다. `maxFontSizeMultiplier` 상수를 한 곳으로 모은다.
3. 표면별 적용(타임라인, 사이드바, 인박스, 설정, 온보딩, 폰 대화) → 표면마다 실제 캡처 전후와 design-review.
4. 프리플라이트: 서체 스택·`:lang()`을 검사하는 규칙을 하나 더한다. 현재 `external_font`는 `@font-face`·`cdn.`을 막고 `tokens.css`는 예외라서 번들 서체는 `tokens.css` 안에서만 선언할 수 있다.
5. **새 서체 의존이 없다**(추천안). 번들하는 경우(결정 2의 B)는 아래 §4.

## 4. 폰트 번들 검토 (결정 2의 B안 비용)

| 후보 | 라이선스 | 비고 |
|---|---|---|
| Pretendard (가변 45~920) | SIL OFL 1.1 (LICENSE 전문 동봉, 예약 이름 「Pretendard」, Inter·Source Han Sans·M PLUS 1 고지 포함) | woff2 용량 확인불가. 가변 전체는 MB 단위 [추정], 동적 서브셋 조각 방식이 있음 |
| Noto Sans KR | OFL 1.1 | 가변 TTF 10.4MB(직접 확인). unicode-range 분할 필수 |
| SUIT, Spoqa Han Sans, IBM Plex Sans KR | OFL 1.1 | |
| Apple SD Gothic Neo | Apple 독점 | 번들 불가. 시스템 참조만 |

B안을 택하면 (1) `NOTICE`에 서체 이름·저작권·OFL 전문 위치를 넣고 (2) 번들 서체는 같은 출처(`font-src`는 `default-src 'self'`를 따라 허용)에서 내려주며 (3) 스킬 §1의 「시스템 서체 스택만」 규칙과 §3 「외부 폰트 금지」를 고쳐야 한다. 이는 스택 변경이라 **Accepted ADR**이 머지 조건이다(AGENTS.md, ADR-0100). README §6 「도입하지 않기로 한 것」(ADR-0159 D5)은 서체를 다루지 않아 번복 대상은 아니다.

