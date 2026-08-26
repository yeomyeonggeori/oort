# Design Review R2 — clients/web + clients/mobile (feat/1755-d3-more-menu, 51f37af4)

PR #1764 · 티켓 #1755 (UX-D3) · R1 지적에 대한 **표적 재검증** (R1 정본: `REPORT.md`)
범위: `git diff 7c45bb7d..51f37af4` — 4e1ab597 · 05138ac6 · 35b03080 · 51f37af4
표면: **웹**(정본 `docs/design-system/README.md` + `momo-design-taste-web`) **+ 폰**
(`clients/mobile`이 이번에 열렸다 — 방언 스킬이 없고, 정본은 `tokens.ts`와 라우터 §2의 테스트들)

Screenshots: `claudedocs/design-review-1764/shots-r2/`

---

## 0. 증거

### 기계 프리플라이트 (웹, 원문 그대로)

```
OK    emdash: 0        OK    raw_color: 0      OK    inline_style: 0
OK    arbitrary_tw: 0  OK    ai_gradient: 0    OK    toast: 0
OK    naked_focus: 0   OK    external_font: 0  OK    hype: 0
OK    pure_bw: 0       OK    progress_word: 0  OK    latin_particle: 0
OK    web: 12/12 categories clean.

== design pre-flight (core), 이슈 #1141 ==
OK    emdash: 0  OK  progress_word: 0  OK  latin_particle: 0  OK  raw_color: 0  OK  hype: 0
RESULT: PASS, 5/5 categories clean.

RESULT: PASS, web 12/12 + core 5/5 categories clean.
```

**폰(`clients/mobile`)에는 기계 프리플라이트가 없다.** 이번 배치가 폰 소스 한 파일과 폰
테스트 두 파일을 건드렸으므로 이 문장은 빈 칸이 아니라 사실로 적어야 한다 — 폰 쪽 검사는
`npm test`(jest) 안에 섞여 있고, 그중 이 배치가 건드린 것이 아래 R2-M1이다.

### 캡처 레인 — `npm run build && npm run capture:design` rc=0, 두 스킴

```
  탭 스톱 hover light: 10행에 행 컨트롤 22개, 탭 스톱 10개 (행당 정확히 1)
  메뉴 light: 항목 14개, ↓로 menu-react-👍 → menu-react-✅
  메뉴 light: ⋯·우클릭 클립보드 항목 누름
  착지 ⋯ 링크 light: msg=capture-17 top=474 vh=800
  탭 스톱 hover dark: 10행에 행 컨트롤 22개, 탭 스톱 10개 (행당 정확히 1)
  메뉴 dark: 항목 14개 · ⋯·우클릭 클립보드 항목 누름
  착지 ⋯ 링크 dark: msg=capture-17 top=474 vh=800
  시트 light/dark: 메시지 복사 · 링크 복사 클립보드 일치
```

### 단위 스위트

```
 ✓ anchor.test.ts (29) · designSystem.test.ts (18) · iconSystem.test.ts (5)
 ✓ MessageActions.test.ts (10) · MessageHoverToolbar.test.tsx (13)     → 75 passed
 ✓ momo-core copyLabels.test.ts (3)                                    → 3 passed
```

### 손으로 짠 런타임 프로브 4벌 (레포 무흔적)

캡처 하네스의 목·로그인 헬퍼를 그대로 쓰고 `main()`만 갈아 끼운 일회용 모듈.

```
[P1] 서버 선택 저장값: {"stored":null,"origin":"http://127.0.0.1:5192"}
[P1] 메뉴: {top:480.5, bottom:787.5, h:307, vh:800, count:14,
           labels:["답글 달기","인용해서 답하기","메시지 복사하기","링크 복사하기",
                   "고정하기","고치기","지우기"]}
[P1] 전부 동사형? true
[P1] 복사된 URL: http://127.0.0.1:5192/#/c/…201?msg=capture-17&seq=1416
     | msg? true | seq? true | tauri? false

[P3] 로드된 행: capture-8(seq1407,top-652) … capture-17(seq1416,top473)
[P3] [앵커 없음]           화면에 있는 행: capture-12 … capture-17
[P3] [oldest-msg-only]  capture-8            → top -589, anyInView **false**, banner null
[P3] [oldest-msg-seq]   capture-8&seq=1407   → top -589, anyInView **false**, banner null
[P3] [newest]           capture-17&seq=1416  → top 474,  fullyInView true
[P3] [absent-msg-only]  capture-9999         → found false, banner **null**
[P3] [absent-msg-seq]   capture-9999&seq=2   → found false, banner **null**

[P4] 이동 전 capture-8:            top -652, anyInView false
[P4] 앱 안 이동 뒤 capture-8:      top  264, anyInView **true**
[P4] 앱 안 이동, 없는 id(msg만):   「찾던 메시지를 이 화면에서 찾지 못했습니다…」
[P4] 앱 안 이동, 없는 id(msg+seq): 「찾던 메시지는 이 대화의 더 위쪽에 있어 아직 불러오지…」
```

P3와 P4는 **같은 URL, 같은 대상**이다. 다른 것은 하나뿐 — P4는 이미 마운트된 셸에서
해시만 바꿨고(인박스·검색·인용이 하는 것), P3는 페이지를 새로 열었다(붙여넣은 링크를 받은
사람이 하는 것). 그 하나가 갈림을 만든다.

---

## 1. R1 지적별 판정

| R1 | 판정 | 근거 |
|---|---|---|
| **B-1** 데스크톱 origin | ✅ **닫힘** | `MessageRow.tsx:394-397`이 `origin: absoluteApiBase()`를 넘긴다. 축소 갈래 불요 판정도 **검증됨**(아래) |
| **H-1** 없는 주소창 | ✅ 닫힘 | 「같은 항목을 다시 눌러 보세요」 — 런타임 무관 (R2-N1 참고) |
| **H-2** seq 누락 | ✅ **닫힘, 그리고 이번엔 실물로 증명됨** | `searchHitPath` 재사용 + `anchorMissKind` 추출. P4가 두 문장이 실제로 갈리는 것을 찍었다 — R1에서는 못 만들던 프레임이다 |
| **M-1** 「복사됨」이 이름을 잃음 | ✅ 닫힘 | `r2-b11-message-context-menu-light.png`: 「메시지 복사됨」·「링크 복사됨」 |
| **M-2** 명사형·폰 분기 | ✅ 닫힘 | 코어 `copyLabels.ts` 단일 출처. 메뉴 8항목 전부 동사형(P1 실측), 폰 시트가 같은 상수를 import |
| **M-3** 레인이 사본을 들고 착지를 안 누름 | ⚠️ **반만 닫힘** | 사본(`messageShareUrlForCapture`)은 사라졌고 `context-copy`도 눌린다 ✅. 새로 넣은 착지 단정은 **구조적으로 실패할 수 없다**(R2-B1) |
| **M-4** 폰 링크 복사 부재 | ✅ 적립 문서화 | STATUS.md에 명시. 후속 티켓 허용 판정 유지 |
| **N-1** §2.8 번들 기록 | ✅ 닫힘 | STATUS.md에 gzip 725,020 B + 미사용 글리프 0회 |
| **N-2** `actionKeepsMenuOpen` 이름 | ✅ 닫힘 | 독스트링이 「세 표면인 척하지만 두 표면의 사실」이라고 스스로 적는다 |
| **N-3** `accessibleLabel` 비대칭 | ✅ 닫힘 | 두 항목 모두 가시 낱말 = 접근성 이름 |

### B-1 축소 갈래 불요 판정 — 검증함

`absoluteApiBase()`가 번들 origin으로 떨어지려면 `apiBase()`가 빈 문자열이어야 하고,
그것은 `chosen === null && API_BASE_DEFAULT === ""`일 때다. Tauri에서 그 조합은 도달 불가다:

- `ConnectPage.tsx:206-212` — `requiresServer`(=`IS_TAURI && API_BASE_DEFAULT === ""`)이면 빈
  서버 칸이 제출을 막고 「서버 주소를 입력하세요.」로 되돌린다. 즉 세션을 얻는 유일한 문이
  `setServerBase`를 반드시 지난다.
- 복원 경로도 같은 결론에 닿는다 — `chosen`이 없으면 `restoreSession()`의 `/v1/auth/refresh`가
  `tauri://localhost`로 나가 실패하고, 화면은 연결 화면이 된다. 세션 없이는 `MessageRow`도 없다.

두 store가 갈릴 수 있는 자리(데스크톱 키체인 ↔ localStorage)까지 따라가도 결과는 같다.
**판정 유지: 액션 숨김 갈래는 불요.**

---

## 2. 새 판정

### [Blocker] R2-B1 — 복사한 링크를 **받은 사람**은 그 메시지로 가지 않는다. 그리고 이번에 넣은 레인은 간다고 말한다

측정값(P3):

| 연 방법 | 대상 | 결과 |
|---|---|---|
| 새 페이지로 `?msg=capture-8&seq=1407` | 로드된 가장 오래된 행 | top **-589** · `anyInView` **false** · 배너 없음 · 하이라이트 없음 |
| 새 페이지로 앵커 **없이** `#/c/{ch}` (대조군) | — | 화면에 capture-12~17 (채널이 바닥에 붙어 열린다) |
| 새 페이지로 `?msg=capture-9999` (없는 행) | — | 배너 **없음** (msg만도, `&seq=2`도) |
| 이미 열린 셸에서 해시만 `?msg=capture-8&seq=1407` | 같은 행 | top **264** · 화면 안 ✅ |

즉 **붙여넣은 주소로 새로 여는 경로에서는 점프가 아예 돌지 않는다.** 채널이 자기 바닥에
설 뿐이고, 못 찾았다는 말조차 없다. `r3-oldest-msg-seq.png`가 그 프레임이다 — 대상 행은
화면 어디에도 없고 컴포저가 바닥에 있다. `r3-no-anchor.png`(앵커 없는 대조군)와
**픽셀 단위로 같은 자리**다.

코드에서 그 갈림이 나는 자리는 `ChatShell.tsx`의 두 효과가 **같은 커밋에서 이 순서로** 도는
것이다: :474 가 `?msg=`/`?seq=`를 읽어 `urlAnchor`에 옮겨 담고 주소에서 지우면, :492
`useEffect(() => setUrlAnchor(null), [channelId])`가 **그 뒤에** 돌아 방금 담은 것을 비운다.
점프 효과(:562)는 `anchorReady = messages.length > 0`을 기다리는데, 첫 페이지가 아직
도착하지 않은 그 커밋에서는 false다 — 도착했을 때 앵커는 이미 null이다. 앱 안 이동은
`channelId`가 그대로이고 `messages`가 이미 차 있어 :492가 다시 돌지 않으므로 살아남는다.

**이 줄들은 이 PR의 diff가 아니다.** #1195/#1199의 기계이고, 그 파일 머리말이 스스로
「그 주소를 복사해 새 탭에 붙여넣으면 채널만 열렸다」를 **고쳤다고** 적는다
(`ChatShell.tsx:384-388`). 측정은 그 문장이 아직 참이 아니라고 답한다 — 문서와 화면이 다른
말을 할 때 이기는 쪽은 화면이다(정본 §2.2 머리말의 그 규율).

그럼에도 **Blocker인 이유는 이 PR이 그 경로를 제품의 약속으로 승격시키기 때문이다.**
이 배치 이전에 `?msg=` URL을 만드는 것은 앱 안 내비게이션뿐이었고 그쪽은 잘 돈다. 「링크
복사하기」는 정의상 **앱 밖으로 나가서 콜드로 열리는** 주소를 만든다. 그 단 하나의 쓰임이
지금 동작하지 않는다.

그리고 R1의 M-3을 닫으려고 넣은 `assertShareUrlLands`(capture-screens.mjs:3437-3471)는
**`actionRow` = 마지막 메시지**를 대상으로 잰다. 채널은 언제나 자기 바닥에 붙어 열리므로
그 행은 점프가 있든 없든 화면에 있다. 레인 로그 「착지 ⋯ 링크 light: msg=capture-17
top=474」의 474는 대조군(앵커 없음)의 473과 **1px 차이**다. 요컨대 이 단정은 착지를 재는
것이 아니라 **채널이 열렸다는 것을 재고 있고**, 그러면서 초록으로 「착지」라고 적는다.
이것이 감사 2위 패턴(「기계가 잡았어야 했는데 안 잡았다」)의 가장 날카로운 형태다.

방향만 적는다: 착지 단정의 대상은 **채널이 저절로 보여 주지 않는 행**이어야 한다(로드된
머리 쪽 행이면 충분하다 — 대조군과 좌표가 갈리는 것이 그 단정의 존재 이유다). 그 자를
먼저 세우면 위의 효과 순서 결함이 그 자리에서 빨갛게 나온다.

### [High] R2-H1 — B-1을 막으려고 넣은 자들이 B-1을 잡을 수 없다

두 자가 모두 참인 채로 통과한다 — **고치기 전 코드로도 똑같이 통과한다.**

1. **캡처 레인.** `readCopiedShareUrl`(:3410-3427)이 「이 서버 origin인가」와 「`tauri://`가
   아닌가」를 묻는다. 그런데 하네스의 `signIn`은 서버 칸을 채우지 않으므로
   `commitServer()`가 `setServerBase(null)` 갈래로 가고, 그러면 `apiBase()`는 ""가 되어
   `absoluteApiBase()`가 **정확히 `window.location.origin`을 돌려준다.** 실측(P1):
   `서버 선택 저장값 {"stored":null}`. 두 값이 같은 harness에서 「origin이 맞는가」를 물으면
   답은 언제나 예다. `tauri://` 가드는 브라우저 페이지가 결코 그 origin을 가질 수 없으므로
   **발화 불가능한 단정**이다.
2. **단위 테스트** 「Tauri 번들 origin은 건네지 않는다」(anchor.test.ts:63-74). `page` 변수를
   만들어 놓고 `page.pathname`만 쓰고 `origin`은 손으로 좋은 값을 넘긴다. 좋은 origin을
   넘기면 좋은 URL이 나온다는 동어반복이고, 수리 전 서명(`location.origin` 사용)으로도
   같은 값을 낸다.

수리 자체는 실하다(소스에서 확인함). 없는 것은 **그 수리가 되돌아가는 것을 막는 자**다.
정본 §5.5가 이름 붙인 두 실패 양식 중 「사본이 거짓말한다」의 사촌이다: 재는 두 값이
harness에서 같으면 그 단정은 무엇도 재지 않는다. 방향은 **두 값이 갈리는 조건을 harness가
만들어 주는 것**이거나(선택한 서버가 페이지 origin과 다른 경우), 호출부 배선 자체를 재는
것이다.

### [Medium] R2-M1 — 폰의 낱말 대조 테스트가 이제 낱말을 보지 않는다

`clients/mobile/__tests__/conversationVisual.test.tsx:590-596`, 제목은
「시트와 코드 상자가 **한 화면에서 같은 낱말을 쓴다**」이고 몸통은 이렇게 바뀌었다:

```diff
-    expect(sheet).toContain('메시지 복사하기');
+    expect(sheet).toContain('COPY_MESSAGE_ACTION_LABEL');
     expect(codeOnly(SRC('MessageBody.tsx'))).toContain('복사하기');
```

한쪽은 **식별자**를, 다른 쪽은 여전히 **낱말**을 본다. 그래서 코어 상수가 「메시지 담기」로
바뀌는 날 시트는 「메시지 담기」, 코드 상자는 「복사하기」가 되어 두 문이 한 화면에서
갈라지는데, 이 테스트는 두 줄 다 초록이다. 이 배치가 **그 테스트가 재던 바로 그것을
못 재게 만들었다.**

폰에 기계 프리플라이트가 없다는 사실이 이 항목의 무게다(라우터 §2 · 정본 §5.4) — 이 축을
지키던 것이 이 한 줄이었다. 「공유 상수를 쓰는가」를 재는 것 자체는 좋은 보강이므로,
잃은 반쪽(두 표면이 같은 낱말을 내는가)을 어디서 되찾을지가 질문이다.

### [Nitpick] R2-N1 — 「같은 항목을 다시 눌러 보세요」는 결정적 실패에 출구가 없다

일시적 실패(문서 비포커스)·권한 거절에는 맞는 다음 단계다. 클립보드 API가 아예 없는
런타임에서는 몇 번을 눌러도 같고, 형제인 `onCopy`(`MessageRow.tsx:472`)는 그 경우에도 통하는
길을 준다(「텍스트를 선택해 복사하세요」). R1의 지적(없는 컨트롤을 가리킴)은 닫혔으므로
머지를 막지 않는다.

### [Nitpick] R2-N2 — `assertShareUrlLands`의 화면 안 판정이 위쪽만 본다

`r.top >= 0 && r.top < window.innerHeight`(:3455) — 아래쪽 경계를 안 보므로 행이 화면 맨
아래에 1px만 걸쳐도 통과한다. R2-B1을 고치고 나면 이 느슨함만 남는다.

---

## 3. 회귀 (R1에서 지켜야 한다고 적은 것)

| 축 | 판정 | 근거 |
|---|---|---|
| 인벤토리 14 / 12 / 0 | ✅ | P1 `count: 14` · MessageActions.test 「권한 차등…」(12) · 묘비 `[]` |
| 기존 13항목 순서 | ✅ | `copy` 앞뒤를 따로 잠그는 단정 통과. `copy-link`는 여전히 `copy`+1 |
| 3표면 동형 | ✅ | `messageActionItemsForSurface`가 여전히 `_surface` 미사용. 이제 **세 표면 모두** 메시지 복사·링크 복사를 실제로 누른다(⋯·우클릭·시트) |
| 호버 툴바 탭스톱 | ✅ | 캡처 light·dark 「행당 정확히 1」 |
| 메뉴 뷰포트 (맨 아래 행) | ✅ | 낱말이 길어졌는데도 top 480.5 / bottom 787.5 / vh 800 — R1과 **같은 상자**(높이는 항목 수가 정하고 낱말 길이는 폭만 건드린다) |
| 발명 0 | ✅ | mark unread·remind·report 구현 여전히 0건 |
| 아이콘 §2.8 | ✅ | 글리프 수 불변, `aria-hidden` 잔량 불변 |
| 다크/라이트 | ✅ | 두 스킴 전 프레임 재촬영 |
| 폰 표면 | ✅ 무회귀 | 시트 낱말은 상수화 전후가 같은 문자열(「메시지 복사하기」). 화면 변화 0 |

---

## 4. 판정

```
Verdict: FAIL (blockers: 1)
```

Blocker 1 · High 1 · Medium 1 · Nitpick 2.
R1의 Blocker 1 · High 2 · Medium 4 · Nitpick 3 중 **아홉이 닫혔다** — 수리 자체의 질은 높다.
특히 H-2는 R1이 만들지 못했던 실물 증거까지 나왔고(P4의 두 문장), M-2는 코어 상수 승격이라
두 클라가 다시 갈릴 자리를 없앴다.

남는 것은 성질이 하나다: **이 기능이 약속하는 단 하나의 동작 — 붙여넣으면 그 줄로 간다 —
이 콜드 로드에서 일어나지 않고, 그것을 재라고 넣은 레인이 초록을 낸다.**
결함 줄 자체는 이 diff 밖(`ChatShell.tsx:474/492`)이라 수리 범위를 성재/오케스트레이터가
따로 정할 수 있다. 다만 **착지한다고 말하는 단정을 그대로 랜딩시키는 것**은 범위 문제가
아니다 — 그 초록이 다음 사람에게 「이미 재고 있다」고 말한다.

**회송 시 물을 한 문장:** 이 착지 단정이 **대조군과 좌표가 다른가.**
지금은 1px 다르다(474 vs 473).
