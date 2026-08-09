# Design Review — 폰 점프 앵커 합류 (#1196) + #1199 잔여 4
PR #1209 / `fix/anchor-res-1199` @ `b70a24c8`
워크트리 `/Users/kwakseongjae/projects/momo-tracks/momo-worktrees/anchor-res` (읽기 전용으로 다뤘다 —
게이트·jest 는 스크래치패드 사본에서 돌렸고, 워크트리에 쓴 것은 jest 캐시뿐이다)

범위: 커밋 `b70a24c8` 한 개. 브랜치가 이고 있는 #1195(`e97c62f4`) 는 선행 리뷰에서 PASS 판정이
났으므로 회귀 확인만 했다(웹 게이트 GATE PASS, 폰 패널 spread 0px 재실측).

증거 파일
- `clients/mobile/measure/captures/anchorres1199-{panel,jump-missed}-{light,dark}.png` (pt = px/3)
- 비교군 `clients/mobile/measure/captures/anchor1193-{panel,jump-missed}-{light,dark}.png`
- 스크래치패드 red proof 사본: `.../scratchpad/redproof` (폰) · `.../scratchpad/webproof` (웹 게이트)
- 프로브 파일 `.../scratchpad/redproof/clients/mobile/__tests__/probe1196.test.tsx`

---

## 방법 — 주장으로 판정하지 않는다

구현자의 주장 다섯 개를 **각각 따로** 재현했다.

1. `git archive b70a24c8 clients/mobile packages/momo-core` 를 스크래치패드에 풀고 `node_modules`
   심링크 → `git apply -R` 로 **src 만** 되돌린 뒤 새 테스트를 돌려 red 를 경험적으로 확인
2. 웹은 같은 방식으로 `clients/web` 사본(+`dist` 심링크)에서 게이트를 green 한 번, 이름 붙은 red 셋
3. 캡처는 좌표로 재측정(픽셀 → pt), 옛 캡처와 픽셀 diff 로 회귀 대역 확인
4. 게이트/테스트가 안 잡는 것은 내 프로브로 직접 물었다(고지 닫은 뒤의 두 번째 발, 인용·고정의 둘째 발)

---

## ① #1196 착지 — **실제로 착지한다** (해소)

### red proof 넷이 경험적으로 빨갛다

수리 전 소스(`b727ea4f`)에 새 테스트를 얹은 결과:

```
✕ RED PROOF — 결과를 누르면 그 메시지로 점프가 걸린다
    expect(jumpTargetOf()).not.toBeNull()  →  Received: null
✕ 못 찾으면 **찾던 메시지**를 못 찾았다고 말한다
    getByTestId('jump-missed')  →  없음 (옛 배너는 anchor-missed 였다)
✕ 시킨 대로 위로 올려 그 줄이 도착하면, 그때 데려간다
✕ RED PROOF — 「인용한 원본」이 아니라 「고정한 메시지」다
    expect(element).not.toHaveTextContent(/인용한 원본/)  →  들어 있었다
Tests: 4 failed
```

첫 줄이 진단을 그대로 확인해 준다: **`jumpTarget` 이 null 이었다.** 검색 진입은 고지만 하고
목록에 아무 명령도 내리지 않았다. 「위로 올려 더 불러오세요」가 따라도 아무 일이 없는 지시였다는
진단은 옳다.

### 「두 발」이 토큰 증가가 아니라 진짜 착지다

테스트는 토큰이 오르는 것만 단정한다 — 그것만으로는 「명령은 갔는데 아무 데도 안 갔다」와
구분되지 않는다. 그래서 내가 한 겹 더 물었다(프로브):

```
[probe] search: token 1 -> 2 | 고지 살아있나: false
✓ 두 번째 발 뒤에 고지가 스스로 물러난다 (onJumpLanded)
```

고지가 사라졌다는 것은 `Timeline` 이 목록에서 그 행을 **찾아서** `onJumpLanded` 를 불렀다는
뜻이다(`Timeline.tsx:1130` 의 index<0 갈래를 통과했다). 착지가 실제로 일어났다.

구조도 옳다. 발사 조건이 「앵커가 지금 목록에 있는가」의 **변화**이고 그 답까지 열쇠에 들어간다
(`${messageId}:${present}`), 그래서 같은 답에 두 번 쏘지 않는다. 목록이 줄어드는 경로가 없어
(`useTimeline` 에 트리밍 없음, 삭제는 묘비로 남는다) false↔true 진동도 없다. 방 오염 걱정도 없다:
`anchor` 는 `nav.conversation` 안에서 `channelId` 와 **같은 객체로** 여행하므로 다른 방의 앵커가
남을 수 없고, `back` 은 `conversation: null` 이라 화면이 언마운트되며 ref 가 함께 리셋된다.

---

## ② 고지 문장 합류 — 다섯 문장이 실제로 나란히 선다 (해소, 단 잔여 하나)

`anchorres1199-jump-missed-light.png` / `-dark.png` 실측(두 스킴 기하 동일):

| # | 주어·이유 | 제목 줄 | 실측 |
|---|---|---|---|
| 1 | quote · older | 인용한 원본은 이 대화의 더 위쪽에 있습니다 | 209.0pt |
| 2 | quote · unknown | 인용한 원본을 이 화면에서 찾지 못했습니다 | 205.7pt |
| 3 | session | 이 작업을 시작한 메시지를 이 화면에서 찾지 / 못했습니다 | 208.0 + **52.0**pt |
| 4 | pin · older | 고정한 메시지는 이 대화의 더 위쪽에 있습니다 | 219.7pt |
| 5 | search · older | 찾던 메시지는 이 대화의 더 위쪽에 있습니다 | 209.3pt |

- 다섯 문장 전부 다르다. 「인용」은 인용의 자리에만 있다.
- 검색 문장은 **옮겨 온 것이 맞다**: 지워진 인라인 상수와 글자 단위로 같다(제목·설명 둘 다, 두 갈래).
- `anchor-missed` 는 소스·테스트·하네스 어디에도 남아 있지 않다(`grep` 확인).
- 카드 리듬: 카드 높이 59.0pt(2줄은 71.3pt), 간격 38.7pt 로 다섯 장 동일. 잘림·겹침 없음.
- 옛 캡처와의 픽셀 diff 는 네 대역뿐이다 — 프레임 라벨(175-203) · 세션 제목 두 줄(920-994) ·
  새 블록 둘(1206-1390, 1499-1683). **1·2번 블록은 픽셀 동일**이다. 리듬 회귀 없음.

각 문장이 자기 상황에서 참인가 → **넷 중 하나만 끝까지 참이다.** 아래 [High] 참조.

---

## ③ N-a 경계 토큰 — 해소 (픽셀 + 산술 둘 다)

캡처에서 구분선 픽셀을 직접 읽었다(`y=560`, 앵커 칸 왼쪽 규정선):

```
anchor1193-panel-light : x=984..986  #dcd8d0   (border)
anchorres1199-panel-light: x=984..986  #84817d   (textFaint)
anchor1193-panel-dark  : x=984..986  #34323b   (border)
anchorres1199-panel-dark : x=984..986  #6f6e73   (textFaint)
```

카드 surface(`#fffefb` / `#201f24`) 위 대비를 다시 계산했다:

| | border(옛) | textFaint(새) |
|---|---|---|
| light | 1.409:1 | **3.844:1** |
| dark | 1.298:1 | **3.238:1** |

웹 `--line-strong: light-dark(#84817d, #6f6e73)`(`clients/web/src/design/tokens.css:35`) 과
**바이트로 같다.** 두 스킴 다 컨트롤 경계 기준선 3:1 을 넘는다. 선 굵기 3px = 1pt, 칸 폭
(x 987→카드 끝) 56.7pt 로 44pt 터치 타겟 유지.

폰 시임도 red 다:
```
✕ 컨트롤 경계가 3:1 을 넘는 토큰이다 — hairline 토큰이 아니라
    Expected: "#6f6e73"   Received: "#34323b"
```

## ④ N-b 한글 줄바꿈 — 해소 (9.7pt → 52.0pt, 주장과 정확히 일치)

```
anchor1193-jump-missed-light.png   세션 제목 둘째 줄  x=137-165   w=29px  (9.7pt)  = 「다」
anchorres1199-jump-missed-light.png 세션 제목 둘째 줄  x=136-291  w=156px (52.0pt) = 「못했습니다」
```

`lineBreakStrategyIOS="hangul-word"` 는 설치된 RN 이 실제로 받는 값이다
(`node_modules/react-native/Libraries/Text/TextProps.js:79` 에 `'hangul-word'` 가 열거돼 있다).
캡처가 시뮬레이터 렌더이므로 이것은 코드 확인이 아니라 **런타임 증거**다. 시임도 red(0 → 2 occurrences).

## ⑤ 리듬 회귀 없음 — 확인

- 폰 패널: 옛/새 캡처의 diff 컬럼이 **22개뿐**이고, 그중 984-986 은 구분선, 909-927 은 경과
  초 표시(15s→17s, 하네스 시계). 그 외 전 픽셀 동일.
- 경과 열 오른쪽 끝: 6행 전부 944px(314.67pt), spread **0px**. #1195 의 H1 수리 그대로 유지.
- 웹 게이트 재실행: `GATE PASS` (`[anchor] 상태·경과 오른쪽 끝 802px, 5행 공통`,
  `첫 누름: 착지 seq 4102 · 주소 정리됨`, `두 번째 누름: 착지 seq 4102`).
- 폰 전체 스위트(워크트리): **63 suites / 1074 tests 전부 green.**

## red proof 건전성 — 아홉 개 전부 실제로 빨갛다

폰 6: #1196 넷(위) + N-a 하나 + N-b 하나.
웹 3(N-d), 문서에 적힌 실패 문장과 **글자까지 일치**한다:

```
ZIGZAG  → the list zigzagged: 상태·경과 열이 오른쪽 끝을 2 개 갖는다
          (session=802 ×4 · run:김인턴=863)      ← H1 이전의 형상 그대로
DEEP    → the anchor landed on the wrong line: … 표식이 선 줄은 seq null 다
          (원장이 뜻한 줄은 4102) … 이 방은 80줄이고 앵커는 가상 창 밖이다
ADDRESS → the anchor landed on the wrong line: 첫 누름 뒤에도 주소가 앵커를 들고 있다
          (…?msg=0199aaaa-…-1ada) — 다음 누름은 같은 주소라 아무 일도 일어나지 않는다
```

셋 다 **드라이버/CSS 만** 바꾼다(제품 소스 무변경). DEEP 이 `Element.prototype.scrollTo` 를 겨누는
것도 옳다 — 웹 `bringIntoView` 는 virtuoso `scrollToIndex`(→ 스크롤러의 `scrollTo`)로 내려간다
(`clients/web/src/features/timeline/Timeline.tsx:360`).

## 기계적 사전점검 (RN 환산, 변경 파일 대상)

```
$ grep -n "#[0-9a-fA-F]\{6\}" ConversationScreen.tsx atoms.tsx AdeControlPanel.tsx jumpNotice.ts
   (주석 제외 0건)
$ grep -n "fontSize: [0-9]" ConversationScreen.tsx atoms.tsx AdeControlPanel.tsx
   atoms.tsx:442  backGlyph: {fontSize: 30, ...}      ← 이 커밋이 건드리지 않은 기존 줄
$ grep -n "'[^']*—[^']*'" (네 파일, 사용자 문자열)
   0건
```

간격값 전부 스케일 안(`space.md`=12 · `SAFE_GUTTER` · `radius.md`), 새 raw 색/폰트 없음.

---

# 판정 목록

### [Blocker] 없음

### [High] 같은 상자·같은 지시가 넷 중 하나에서만 지켜진다 — 나머지 셋은 따르고 나면 **거짓말이 된다**

증거(프로브, 같은 픽스처·같은 동작·주어만 다름):

```
[probe] search: token 1 -> 2 | 고지 살아있나: false     ← 데려간다, 고지는 물러난다
[probe] pin   : token 1 -> 1 | 고지 살아있나: true      ← 아무 일도 없다, 고지는 남는다
```

고정 목록에서 점프 → 「고정한 메시지는 이 대화의 더 위쪽에 있습니다 / **아직 불러오지
않았습니다.** 위로 올려 이어서 불러오세요」 → 사람이 시킨 대로 위로 올린다 → **그 줄이 화면에
도착한다** → 상자는 그대로 서서 여전히 「아직 불러오지 않았습니다」라고 말한다. 그 문장은 그
순간부터 거짓이고, 사람은 자기가 지시를 완수했다는 사실조차 화면에서 못 읽는다. 인용도 같은
경로다(`onJumpToQuoted`/`onJumpToPinned` 둘 다 1회성 `setJumpTarget`, 재무장 없음).

이것이 이 PR 의 문제인 이유: 커밋이 네 주어를 **한 상자·한 문장**으로 합치면서, 그 문장이 약속하는
결말은 넷 중 하나에만 붙였다. 합치기 전에는 검색 배너와 점프 배너가 따로 서 있어 「이 문장이 무엇을
약속하는가」가 표면마다 갈릴 수 있었지만, 지금은 같은 상자가 같은 말을 하고 결말만 다르다.
이 화면이 스스로 세운 규율(「모르면 모른다고 말한다」·「그 화면에서 거짓인 문장을 없앤다」)이
겨누는 것이 정확히 이 종류의 문장이다.

기계는 이미 일반적이다 — 발사 조건이 「목적지가 지금 목록에 있는가의 변화」이지 「검색인가」가
아니다. 방향만 적는다: 넷째 호출자에만 달아 둔 그 감시를 **점프 자체의 성질**로 올리거나,
최소한 목적지가 도착한 순간 고지를 거두는 것. (범위 밖이라는 판단이면 후속 티켓 + 코드에 그 사실을
남기는 쪽도 받아들일 수 있다 — 지금은 어디에도 안 적혀 있다.)

### [Medium] 「닫기」가 대기 중인 착지를 취소하지 않는다 — 닫아도 나중에 끌려간다

증거(프로브):
```
[probe] token after dismiss+loadOlder: 1 -> 2      ← 닫은 뒤에도 둘째 발이 나간다
```

이 커밋이 검색 고지에 **처음으로 닫기를 달았고**, 그 근거를 「이제는 상태가 아니라 영수증이다」로
적었다. 그런데 영수증을 닫아도 뒤에 걸린 의도는 살아 있다: 사람이 상자를 물리고 자기 이유로 옛
대화를 읽으러 올라가면, 그 줄이 도착하는 순간 화면이 읽던 자리에서 그를 **끌어간다**. 취소 수단이
없고 만료도 없다 — 대화 화면이 살아 있는 내내 유효하다.

같은 화면이 세션 앵커에는 정확히 이 이유로 30초 TTL 을 달아 두었다(선행 리뷰 M2:
「몇 분 뒤 우연히 그 방에 들어갔을 때 튀어나오는 점프는 사람이 방금 한 행동의 결과가 아니다」).
검색 앵커는 그 규율 밖에 있다. 지시를 따라 올라가는 흔한 경우에는 이 동작이 사람이 원한 것과
같아서 대개 이롭다 — 그래서 Blocker 가 아니라 Medium 이다. 갈리는 것은 **닫은 뒤**다.

### [Nitpick] 다섯

- **N1 — 카드 안에서 유일하게 강한 선.** `anchorres1199-panel-light.png`: 앵커 칸 규정선은
  3.84:1 인데 카드 자신의 테두리는 1.41:1 이라, 라이트에서 카드가 「두 장이 붙은 것」으로도 읽힌다.
  컨트롤 경계 3:1 은 지켜야 하는 값이니 이 선을 낮추라는 뜻은 아니다 — 균형을 어디서 잡을지가
  남아 있다는 기록이다.
- **N2 — 한 사실을 세 번 말한다.** `older` 갈래: 「더 위쪽에 있습니다」 + 「아직 불러오지
  않았습니다」 + 「위로 올려 이어서 불러오세요」. 그리고 같은 손동작을 두 갈래가 다르게 부른다
  (「위로 올려 **이어서** 불러오세요」 vs 「위로 올려 **이전 대화를 더** 불러오세요」).
  한 상자가 같은 세션에서 둘 다 보여 줄 수 있다.
- **N3 — `hangul-word` 는 `NoticeBlock` 에만 있다.** 의도된 경계라고 주석이 밝혀 두었지만,
  이 앱의 다른 긴 한글(메시지 본문·시트 설명)은 여전히 글자 단위로 끊긴다. 경계선을 기록해 둔다.
- **N4 — 큰 글씨(Dynamic Type) 변주 캡처가 없다.** 기본 크기에서 이미 세션 제목이 두 줄이고
  제목은 「닫기」와 폭을 나눠 쓴다. AX 크기에서 이 줄이 어떻게 서는지는 **본 적이 없어 판정하지
  않는다** — 하네스에 큰 글씨 표면이 없다는 사실만 남긴다.
- **N5 — 검색·고정의 `unknown` 갈래는 거의 도달 불가이고, 도달하면 지시가 무용하다.** 둘 다 seq 를
  항상 아므로 `unknown` 은 「seq ≥ oldest 인데 목록에 없다」= 하드 삭제뿐이고, 그때 「위로 올려
  이전 대화를 더 불러오세요」는 도움이 되지 않는다. (하네스 프레임 라벨의 em-dash 는 배송 문자열이
  아니라 측정 라벨이므로 세지 않는다.)

---

## 요약

| 항목 | 판정 |
|---|---|
| ① #1196 검색 진입 착지 | 해소 — red proof 4 경험적 red, 「두 발」이 토큰이 아니라 실제 착지임을 프로브로 확인 |
| ② 고지 합류·주어 4종 | 해소 — 다섯 문장이 한 장에, 문구는 옮겨 온 그대로, `anchor-missed` 소멸. 단 결말은 하나만 지켜진다 [High] |
| ③ N-a 경계 토큰 | 해소 — 픽셀 `#84817d`/`#6f6e73`, 3.844:1 / 3.238:1, 웹 `--line-strong` 과 바이트 동일 |
| ④ N-b 한글 줄바꿈 | 해소 — 9.7pt → 52.0pt, RN 이 실제로 받는 프롭 |
| ⑤ 리듬 회귀 | 없음 — 패널 diff 22컬럼(선+시계), 경과 열 spread 0px, 폰 1074 tests green, 웹 GATE PASS |
| red proof 6+ | 건전 — 폰 6 + 웹 3, 아홉 개 전부 실제로 빨갛고 실패 문장이 문서와 일치 |

Blocker 0 · High 1 · Medium 1 · Nitpick 5

**Verdict: PASS** (Blocker 0 · High 1 ≤ 2 → 사람 리뷰로 넘어갈 수 있다)
