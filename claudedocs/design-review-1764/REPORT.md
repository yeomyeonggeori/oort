# Design Review — clients/web (feat/1755-d3-more-menu, a28a2de9 + 7c45bb7d)

PR #1764 · 티켓 #1755 (UX-D3, 메시지 ⋯ 메뉴 보강) · 독립 fresh-context 리뷰 (이 파일이 정본)
베이스: `origin/track/uxui` (4c913f77) · 워크트리: `momo-worktrees/d3-more-menu`
표면: **웹 하나** — `clients/desktop`은 `frontendDist: ../../web/dist`이므로 같은 표면이다
(`docs/design-system/README.md` §1 주1, `clients/desktop/src-tauri/tauri.conf.json:10`).

Screenshots (`claudedocs/design-review-1764/shots/`):
`b11-message-action-menu-{light,dark}.png` · `b11-message-context-menu-{light,dark}.png` ·
`mobile-b11-action-sheet-{light,dark}.png` · `probe-1764-menu-bottomrow.png` ·
`probe-1764-pasted-link-landing.png` · `probe-1764-after-reload.png` ·
`probe-1764-anon-paste.png` · `probe-1764-anon-after-login.png`

---

## 0. 증거

### 기계 프리플라이트 (원문 그대로)

```
== design pre-flight (web), SKILL momo-design-taste-web §10 ==
   scanned: clients/web/src, clients/web/index.html
   excluded: src/design/tokens.css, src/design/tokens.contrast.test.ts
   emdash·progress_word·latin_particle: AST (문자열 리터럴·JSX 텍스트만, *.test.ts(x)·*.d.ts 제외) — #1141·#1511

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
OK    progress_word: 0
OK    latin_particle: 0

OK    web: 12/12 categories clean.

== design pre-flight (core), 이슈 #1141 ==
   scanned: packages/momo-core/src (문자열 리터럴 노드만, *.test.ts 제외)
   excluded: 주석·독스트링(AST가 보지 않는다), *.test.ts, design-preflight-allow 줄

OK    emdash: 0
OK    progress_word: 0
OK    latin_particle: 0
OK    raw_color: 0
OK    hype: 0

RESULT: PASS, 5/5 categories clean.

RESULT: PASS, web 12/12 + core 5/5 categories clean.
  Still manual (SKILL §10 checklist): light AND dark reviewed, four states
  present, keyboard path exists, long Korean strings do not overflow.
```

**폰(`clients/mobile`)에는 기계 프리플라이트가 없다.** 이 배치가 폰을 건드리지 않았으므로
이번 리뷰의 판정 대상도 아니다 — 다만 아래 M-4는 그 표면에 대한 것이고, 그 축을 재는 기계가
없다는 사실을 여기 적는다(빈 칸은 초록으로 읽히므로).

### 캡처 레인

`cd clients/web && npm run build && npm run capture:design` → **rc=0**, 두 스킴 전부.
새로 나온 D3 단정:

```
  메뉴 light: 항목 14개, ↓로 menu-react-👍 → menu-react-✅
  메뉴 light: ⋯·우클릭 클립보드 항목 누름
  메뉴 dark:  항목 14개, ↓로 menu-react-👍 → menu-react-✅
  메뉴 dark:  ⋯·우클릭 클립보드 항목 누름
  시트 light: 메시지 복사 · 링크 복사 클립보드 일치
  시트 dark:  메시지 복사 · 링크 복사 클립보드 일치
  탭 스톱 hover dark: 10행에 행 컨트롤 22개, 탭 스톱 10개 (행당 정확히 1)
```

### 단위 스위트

```
 ✓ src/features/inbox/anchor.test.ts (25) · src/design/designSystem.test.ts (18)
 ✓ src/design/iconSystem.test.ts (5) · MessageActions.test.ts (10) · MessageHoverToolbar.test.tsx (13)
 Test Files 5 passed · Tests 71 passed
```

### 손으로 짠 런타임 프로브 (§5.3 16위 「화면이 거짓을 말함」이 요구하는 그것)

캡처 레인이 누르지 않는 자리를 직접 눌렀다. 캡처 하네스의 목·로그인 헬퍼를 그대로 쓰되
`main()`만 갈아 끼운 일회용 모듈로 돌렸고, 레포에는 아무것도 남기지 않았다.

```
  [맨 아래 행] menu box {"top":480.5,"bottom":787.5,"h":307,"vh":800,"vw":1280}
  메뉴 항목: [react×6, react-more, reply, quote, copy, copy-link, pin, edit, delete]  (14)
  복사된 URL: http://127.0.0.1:5188/#/c/00000000-0000-7000-8000-000000000201?msg=capture-17
  붙여넣기 착지(새 탭): {"found":true,"inViewport":true,"top":474,"banner":null,
                        "hash":"#/c/00000000-0000-7000-8000-000000000201"}
  새로고침 뒤 주소: {"hash":"#/c/00000000-0000-7000-8000-000000000201"}
  비로그인 붙여넣기: {"hash":"#/c/...?msg=capture-17","login":true}
  로그인 뒤 착지:   {"found":true,"inViewport":true,"top":474,"banner":null}
```

읽는 법: **웹 브라우저에서는 이 링크가 실제로 착지한다.** 새 탭에서도, 로그아웃 상태로
붙여넣고 로그인한 뒤에도 착지한다(해시가 `ConnectPage`를 지나 보존된다). 착지 뒤 주소에서
`msg=`가 사라지는 것은 #1199 N-c가 이름 붙여 둔 기존 거래이고, 이 배치가 새로 만든 것이 아니다.
아래 B-1은 **브라우저가 아닌 런타임**에 대한 것이다.

---

## 1. 계약 대조 (이슈 #1755 · 패킷 순번 3)

| 계약 | 판정 | 근거 |
|---|---|---|
| 추가는 「링크 복사」 하나, 기존 딥링크 재사용 | ✅ | `messageShareUrl`이 `messageAnchorPath`를 부른다(anchor.ts:105) |
| 문구 정돈 「메시지 복사」 | ✅ (단 M-1) | messageActionModel.ts:81 |
| Mark unread · Remind · Report 적립 (**발명 검사**) | ✅ **구현 0** | 세 낱말의 유일한 출처는 messageActionModel.ts:44-45의 적립 주석. 라우트·API·컴포넌트 0건 |
| 3표면 동형 · `messageActionModel.ts` 단일 술어 | ✅ | `messageActionItemsForSurface`가 여전히 `_surface`를 쓰지 않는다. 세 표면 배선 전부 `copyState` 한 덩어리로 통일됐고 로컬 분기 0 |
| 인벤토리 14 / 12 / 0 · 권한 차등 보존 | ✅ | MessageActions.test.ts 「권한 차등…」 + 캡처 실측 「항목 14개」 |
| 기존 13항목 순서·기능 무파손 | ✅ | 순서 단정이 `copy` 앞/뒤를 따로 잠근다. 시트의 react-more는 여전히 자기 `<button>`이 `close()`하므로 새 술어가 닿지 않는다(N-2) |
| 호버 툴바 탭스톱 계약 | ✅ | 캡처 「행당 정확히 1」 |
| Edit/Delete 메뉴 전용 | ✅ | 툴바에 새 버튼 0개 |
| 아이콘 §2.8 정합 | ✅ (단 N-1) | `Link` 정적 named import · `size-4` · `aria-hidden="true"` · `currentColor`. **aria-hidden 잔량 늘지 않음** |

---

## 2. 판정

### [Blocker] B-1 — 데스크톱 셸에서 「링크 복사」가 아무도 열 수 없는 주소를 복사하고, 「링크 복사됨」이라고 답한다

`messageShareUrl(...)`은 주소를 `window.location.origin + pathname`으로 짓는다
(`anchor.ts:105-116`, 호출부 `MessageRow.tsx:394`). 브라우저에서는 그것이 정직한 답이다.
**Tauri 릴리스 셸에서는 아니다** — 그 창의 origin은 서버가 아니라 앱 번들이고, 이 레포는
그 사실을 두 자리에 이미 적어 두었다:

- `clients/web/src/app/App.tsx:31` — *"the Tauri release build loads the bundle from
  `tauri://localhost` with no server to rewrite deep paths"*
- `clients/web/src/lib/serverBase.ts:103-110` (`requiresServerUrl`) — *"inside the Tauri shell
  the page origin is the app bundle, not an API"*

따라서 데스크톱에서 이 버튼이 클립보드에 넣는 것은 `tauri://localhost/#/c/{ch}?msg={id}`다.
그 문자열은 받는 사람의 기기에서도, 복사한 사람의 브라우저에서도 열리지 않는다. 그런데 화면은
「링크 복사됨」이라는 성공 영수증을 낸다 — 실패가 성공의 낯으로 나가는 것이 정본 §5.3의
16위 항목(「화면이 거짓을 말함」, 기계가 아무것도 재지 않는 축)이 이름 붙인 그 결함이다.
데스크톱 DMG가 이 레포의 주 검수 빌드라는 점에서 사정거리도 좁지 않다.

이것이 감사의 **최다 메타 패턴**(「옳은 답이 바로 옆 파일에 이미 있었는데 안 썼다」, 25건/11리포트)인
이유는 답의 이름까지 이미 지어져 있기 때문이다 — `serverBase.ts:112-122`:

> **`absoluteApiBase()`** — *"The absolute origin to hand someone else (invite links, 'point
> your client here'). Same-origin resolves to the browser's own origin, which is the honest
> answer for a web deployment."*

「남에게 건네줄 절대 origin」이 이 액션이 필요로 하는 바로 그것이고, `HostedAgentWizard.tsx:276`이
이미 같은 목적으로 그것을 쓴다. 새 출처를 발명하는 것이 아니라 **이미 있는 그 자를 쓰는가**가
질문이다. 방향만 적는다: 건네줄 주소를 이 클라가 이미 아는 방식으로 얻거나, 건넬 수 있는
origin이 없는 런타임에서는 이 액션을 내주지 않는 것(정직한 축소) 중 하나여야 한다.

**증거의 성질을 밝힌다.** 이것은 코드·설정·레포 자신의 주석에서 나온 판정이고, 나는 Tauri
셸을 빌드해 눌러 보지는 않았다(브라우저 런타임은 위 프로브로 확인했고 거기서는 참이다).
판정을 뒤집을 수 있는 단 하나의 측정은 데스크톱 앱에서 「링크 복사」를 한 번 누르고 클립보드를
읽는 것이다. 구현자는 수리 전에 그 한 번을 찍어 보고에 붙이면 된다.

### [High] H-1 — 복사 실패 안내가 데스크톱에 없는 컨트롤을 가리킨다

`MessageRow.tsx:483` — 「링크를 복사하지 못했습니다. **주소창의** 채널 주소를 복사하세요.」

Tauri 창에는 주소창이 없다(표준 window chrome, 스킬 §8). 형제인 `onCopy`의 대체 문장
(`MessageRow.tsx:472`, 「텍스트를 선택해 복사하세요」)은 런타임과 무관하게 실행 가능한데,
새로 쓴 이 문장만 특정 브라우저 크롬을 전제한다. 정본 §4의 오류 규칙은 「무슨 일이 일어났고
**다음에 무엇을 할지**」인데, 그 다음이 그 표면에 없으면 그 문장은 지시가 아니라 막다른 길이다.
(B-1과 같은 뿌리에서 나온 서로 다른 두 줄이라 따로 센다.)

### [High] H-2 — 공유 링크가 `seq`를 버려서, 못 찾았을 때 화면이 이유를 말할 수 없다

`messageShareUrl`은 `messageAnchorPath`(=`?msg=` 한 열쇠)를 싣는다. 같은 파일 **15줄 위**의
`searchHitPath`(anchor.ts:73-79)는 두 열쇠를 함께 싣고, 그 독스트링이 왜인지를 적어 둔다:

> `msg`는 정확한 신원이라 찾는 데 쓰이고, `seq`는 **못 찾았을 때 이유를 말하는 데** 쓰인다.

소비하는 쪽이 실제로 그 갈림을 진다. `ChatShell.tsx`의 `missKind()`(:568-576 · :623-631)는
seq가 없으면 `"unknown"`을 돌려주고, 배너 문장이 거기서 갈린다(:949-952):

| | 문장 |
|---|---|
| `older` (seq 있음) | 「찾던 메시지는 이 대화의 **더 위쪽에 있어 아직 불러오지 않았습니다.** 위로 올려 이어서 불러오세요.」 |
| `unknown` (seq 없음) | 「찾던 메시지를 이 화면에서 찾지 못했습니다. 위로 올려 이전 대화를 더 불러오세요.」 |

공유 링크는 인박스 점프보다 **구조적으로 만료가 잦은 표면**이다 — 붙여넣은 링크는 며칠 뒤에
눌리고, 그때 그 메시지는 로드된 머리보다 위에 있다. `searchHitPath`가 두 열쇠를 든 이유가
정확히 그 성질이었고("검색은 정의상 머리에 없는 것을 찾는 표면"), 공유는 그보다 더하다.
`MessageRow`는 `message.seq`를 손에 들고 있으므로 값도 이미 있다.

증거의 성질: 코드와 두 문장 자체다. 런타임 재현은 못 만들었다 — 캡처 픽스처가 채널 전량을
한 페이지로 실어 주어 만료 경로 자체가 안 열린다(`probe-1764-msg-only-miss.png` /
`probe-1764-msg-seq-miss.png` 둘 다 배너 없음). **픽스처가 이 축을 잴 수 없다는 사실도 결과다.**

### [Medium] M-1 — 「복사됨」 영수증이 방금 붙인 「메시지」를 도로 잃는다

`b11-message-context-menu-light.png` · `-dark.png` — 두 영수증이 나란히 서 있다:

```
  복사됨
  링크 복사됨
```

이 배치가 「복사」를 「메시지 복사」로 고친 이유는 모델 주석이 스스로 적는다(messageActionModel.ts:42):
*"Visible copy is 「메시지 복사」 so it sits next to 「링크 복사」."* 그런데 눌린 뒤에는
`label: copied ? "복사됨" : "메시지 복사"`(:81)라 화면이 다시 무엇을 복사했는지 말하지 않는다.
**옳은 답은 바로 다음 줄에 이미 있다** — `accessibleLabel: copied ? "메시지 복사됨" : …`(:82).
스크린리더는 이름을 듣고 눈은 못 읽는 비대칭이고, 두 영수증이 세로로 붙어 있는 이 프레임이
그 차이가 실제로 읽히는 자리라는 증거다.

### [Medium] M-2 — 새 낱말 둘만 그 메뉴에서 명사형이고, 폰의 같은 액션과도 낱말이 다르다

`b11-message-action-menu-light.png`의 위에서 아래로:

```
  다른 반응 고르기 · 답글 달기 · 인용해서 답하기 · [메시지 복사] · [링크 복사] · 고정하기 · 고치기 · 지우기
```

여섯이 `-기` 동사형이고 둘만 명사구다. 스킬 §7은 verb-first를 요구하고, 같은 목록 안의
불일치는 정본 §5.3 10위(「한 클라 안의 내부 불일치」)다. 그리고 같은 액션의 폰 낱말은
`clients/mobile/src/features/conversation/MessageActionSheet.tsx:291` —
**`label="메시지 복사하기"`**. 즉 이 배치 뒤 웹과 폰이 같은 행에 다른 낱말을 쓴다
(패리티 분기 = 코퍼스 2위 패턴, 18건/8리포트, `mobile-b11-action-sheet-light.png`와
비교하면 나란히 읽힌다).

이 목록에서 갈리지 말라고 코어에 올라가 있는 낱말이 이미 둘이다 — `QUOTE_ACTION_LABEL`
(`packages/momo-core/.../quote.ts:65`)과 `pinActionLabel`(`pins.ts:176`). 복사 낱말만 두
클라의 로컬 리터럴로 남아 있고, 그래서 갈렸다. 어느 형태를 고르든 **한 자리에서 고르는 것**이
방향이다.

### [Medium] M-3 — 캡처 레인이 「그 URL이 실제로 착지하는가」는 누르지 않고, 기대값을 손으로 다시 적는다

레인 보강 자체는 실하다 — 세 표면 전부에서 클립보드 항목을 실제로 누르고 내용을 읽는다.
두 군데가 계약보다 좁다:

1. **`messageShareUrlForCapture`(capture-screens.mjs:3411)가 제품의 `messageShareUrl`을
   읽지 않고 URL 모양을 다시 적는다.** 정본 §5.5①이 이름 붙인 실패 양식이다("사본을 두면
   사본이 거짓말한다" — `spacing.test.ts` 1차판이 정확히 그렇게 8/8 초록이었다). 오늘은
   두 판이 같지만, `ChatShell`이 `?msg=` 소비를 그만두는 날 캡처는 **초록인 채** 링크만 죽는다.
   이 기능이 약속하는 단 하나(붙여넣으면 그 줄로 간다)를 누르는 레인이 없다.
2. **우클릭 표면은 `context-copy-link`만 누르고 `context-copy`는 안 누른다**(:4435). 계약은
   3표면 동형이고, ⋯·시트는 둘 다 누른다.

그 구멍은 이번 리뷰가 손으로 메웠고(§0 프로브 — 새 탭 착지·새로고침·비로그인 붙여넣기 후
로그인 착지 전부 참), 그래서 **오늘은 참이되 지키는 기계가 없다**가 정확한 상태다.

### [Medium] M-4 — 폰에 「링크 복사」가 없다 (이 배치가 새로 연 패리티 갭)

웹 시트는 7행이 되고 폰 시트는 5행 그대로다(`mobile-b11-action-sheet-light.png` ↔
`clients/mobile/.../MessageActionSheet.tsx`). 폰에는 `window.location`이 아예 없으므로
「어느 origin을 건네는가」가 웹보다 먼저 결정돼야 하는데, 그 자리도 이미 있다 —
`packages/momo-core/src/runtime/host.ts:72`가 `absoluteApiBase()`를 호스트 인터페이스로
올려 두었다. B-1을 코어에서 푸는 선택은 이 갭도 함께 닫는다. 후속 티켓 허용.

### [Nitpick] N-1 — §2.8이 요구하는 번들 전·후 실측이 기록되지 않았다

정본 §2.8: *"아이콘을 늘린 PR은 전·후 gzip 번들을 실측해 이 전제가 실제 산출물에서도 맞는지
기록한다."* 이 배치는 글리프를 하나(`Link`) 늘렸고 STATUS.md 항목에는 그 수가 없다.

리뷰가 대신 쟀다 — **전제는 산출물에서도 참이다.** 빌드된 `dist/assets/index-*.js`에서
쓰지 않는 글리프(`aperture` · `accessibility` · `anchor` · `bluetooth`)는 **0회**, 쓰는
글리프(`link` · `copy`)는 각 9회다. 참고 총량: dist JS gzip 합계 726,861 B
(`index` 453,983 · `huddleRuntime` 138,486 · `terminalRuntime` 84,456 · `emojiCatalog` 49,007).
남은 일은 이 수를 STATUS.md에 적는 것뿐이다.

### [Nitpick] N-2 — `actionKeepsMenuOpen("react-more")`는 시트에서 참이 아니다

시트의 react-more는 `regular`에서 걸러진 뒤 자기 `<button>`이 항상 `close()`를 부른다
(`MessageActions.tsx:637-650`). 그래서 새 술어가 그 키를 시트에서 만나는 일이 없고, 오늘
동작은 이전과 같다 — 확인했다. 다만 이름은 세 표면 공통의 사실인 것처럼 말하는데 실제로는
포인터 메뉴 둘의 사실이다. 언젠가 `regular`의 필터가 바뀌면 이모지 피커가 열린 시트 **위에**
뜨고 Esc가 두 번 필요해진다. 술어 이름이나 주석이 그 한계를 지고 있으면 그 날이 안 온다.

### [Nitpick] N-3 — `copy-link`에는 `accessibleLabel`이 없다

형제 `copy`는 있다(:82). 오늘은 보이는 낱말이 그대로 접근성 이름이라 옳게 동작하고,
아이콘 이름을 접근성 이름으로 쓰지 않는다는 §2.8 규칙도 지킨다. 표의 두 칸이 비대칭이라
다음 사람이 규칙을 짐작하게 된다는 것만 적는다 — M-1을 고치면 이 칸도 함께 정리된다.

---

## 3. 루브릭 페이즈

| # | 페이즈 | 판정 | 비고 |
|---|---|---|---|
| 0 | Prep | PASS | build + `capture:design` rc=0, 두 스킴 · 1280/900/390 |
| 1 | Interaction | PASS + B-1 | ⋯·우클릭·시트 셋 다 실제로 눌렀고 클립보드를 읽었다. 키보드 ↓가 새 항목까지 간다. 붙여넣은 URL 착지도 확인(프로브). 브라우저 런타임 한정 |
| 2 | Viewport | PASS | 14항목 메뉴가 **맨 아래 행**에서도 뷰포트 안: top 480.5 / bottom 787.5 / vh 800 (여유 12.5px, `probe-1764-menu-bottomrow.png`). 900폭·390폰 프레임 가로 오버플로 0. 390×844 시트 7행 전부 화면 안 |
| 3 | Visual polish | PASS | 새 토큰·새 클래스 0. 아이콘 하나가 형제들과 같은 `size-4`·같은 획·`currentColor` |
| 4 | Accessibility | PASS + N-3 | 링 계약은 `DropdownMenuItem`/`SheetAction` 프리미티브 그대로. 아이콘 `aria-hidden`, 잔량 안 늘림. 새 색 0이라 대비 축 무변. 시트 새 행 44px 캡처 단정 통과 |
| 5 | Robustness | PASS | 묘비·실패 전송에서 항목 0(모델 테스트). 게스트(=`actions` 없음) 0. 긴 한·영 혼합 본문이 곧 대상 행의 픽스처(`ACTION_ROW_BODY`)이고 잘림 0 |
| 6 | Code health | PASS + M-3 | 매직 넘버 0, 프리미티브 재사용, 세 표면 배선이 한 술어로 수렴. 프리플라이트 원문 위에 붙였다. **폰은 기계 프리플라이트가 없다** |
| 7 | Copy | FAIL(H-1) | H-1 · M-1 · M-2 |

---

## 4. 잘 된 것 (되돌리지 말 것)

- **발명 0.** Mark unread·Remind·Report는 코드가 아니라 적립 주석으로만 존재하고, 그 주석이
  「왜 지금 못 하는가」(read-state PUT이 `GREATEST` 단조)까지 진다. 직전 사이클의 교훈이
  실제로 적용됐다.
- **표면 분기를 만들지 않았다.** `messageActionItemsForSurface`가 여전히 `_surface`를 쓰지
  않고, 세 표면이 `canCopy/copied/pinned` 세 prop을 각자 나르던 것을 `copyState` 한 덩어리로
  모아 오히려 갈라질 자리를 줄였다.
- **캡처 레인이 이번엔 실제로 누른다.** 「자를 심었다」가 「눌렀다」인지 확인했고, 세 표면 중
  둘은 메시지·링크 둘 다, 시트도 둘 다 누르고 클립보드 내용을 읽는다. 시트 행 수 단정도
  `3 → 4`로 함께 올라갔다(조용한 무사통과를 막는 그 자).
- **아이콘 §2.8 정합.** 신설분이 요구하는 정적 named import · 16px · `aria-hidden` ·
  `currentColor`를 전부 지켰고, 기계가 없는 `aria-hidden` 잔량 축을 늘리지 않았다.

---

## 5. 판정

```
Verdict: FAIL (blockers: 1)
```

Blocker 1 · High 2 · Medium 4 · Nitpick 3.
ADR-0133 웹 패리티 목표(Blocker 0, High 0) 미달 — 구현자에게 되돌아간다.

**되돌아갈 때 물어야 할 한 문장:** 이 버튼이 클립보드에 넣는 주소는 *누가 열 수 있는 주소인가.*
B-1·H-1·M-4가 전부 그 한 질문의 서로 다른 얼굴이고, 답의 이름은 이미
`serverBase.ts:117`에 지어져 있다.
