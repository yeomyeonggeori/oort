# Design Review (2차 — 수리 재검증) — ADE 「대화로」 앵커
PR #1195 / feat/anchor-1193 @ `e97c62f4` (1차 판정은 `d4a85dde` 기준)

범위: 1차에서 낸 B1·B2·H1·H2·M1~M5·N1~N4 의 해소 여부만. 신규 전면 리뷰 아님.
워크트리는 읽기 전용으로 다뤘다 — 쓴 것은 gitignore 된 `clients/web/artifacts/` 와 `dist/` 뿐이고,
둘 다 게이트가 스스로 만든다.

## 재검증 방법

1차와 같은 자세: 수리 주장을 읽되 **주장으로 판정하지 않는다.** 게이트가 이제 내 조건을 스스로
단정하므로, 게이트 밖에서 같은 것을 다시 쟀다.

- 새 커밋으로 재빌드 후 `node clients/web/gates/gate-ade.mjs` 재생성 캡처를 픽셀로 재측정
- 게이트 하네스를 스크래치패드로 복사해 **게이트보다 깊은 조건**으로 독립 프로브
  (`probe2.mjs` 300줄 방 · 2연타 · 앵커가 진짜로 없는 방, `probe3.mjs` aria/탭/유령 기하)
- 폰은 PR 에 든 재생성 캡처를 좌표로 재측정 (pt = px/3)
- 공유 경로 부수효과 확인: `gate:quote` · `gate:pin` · `gate:workstream`

증거 파일:
- `/Users/kwakseongjae/projects/momo-tracks/momo-worktrees/anchor-1193/clients/web/artifacts/ade/ade-drawer-{light,dark}.png`, `.../ade-drawer-narrow-{light,dark}.png`
- `/Users/kwakseongjae/projects/momo-tracks/momo-worktrees/anchor-1193/clients/mobile/measure/captures/anchor1193-panel-{light,dark}.png`
- `/Users/kwakseongjae/projects/momo-tracks/momo-worktrees/anchor-1193/clients/mobile/measure/captures/anchor1193-jump-missed-{light,dark}.png`
- `/private/tmp/claude-501/-Users-kwakseongjae-projects-momo/13b3122b-8e03-42e7-aa01-c687b3adafe2/scratchpad/v2-web-{light,dark}-rightcol.png` (3x 크롭)
- `.../scratchpad/v2-deep300.png`, `.../scratchpad/v2-truly-absent.png` (내 프로브 스크린샷)

---

## B1 — 가상 창 밖 착지 · 거짓 고지 **해소**

독립 프로브, **300줄 방**(게이트 픽스처 80줄보다 깊고, 1차가 무너진 45줄보다 훨씬 깊다):

```
[probe] deep300      press#1 seq=4102 rows=35 win=[4100,4134] hash="#/c/...201"      miss=none
[probe] deep300      press#2 seq=4102 rows=35 win=[4100,4134] hash="#/c/...201"      miss=none
[probe] truly-absent press#1 seq=null  rows=36 win=[4144,4179] hash="#/c/...201"
        miss="찾던 메시지를 이 화면에서 찾지 못했습니다. 위로 올려 이전 대화를 더 불러오세요."
```

읽는 법이 셋이다.

1. **착지가 실제로 일어났다.** 가상 창이 바닥([4144,4179] 근처)에서 `[4100,4134]` 로 **옮겨 갔고**
   표식이 seq 4102 에 섰다. 1차 실측표에서 45줄부터 `anchorInDom:false` 였던 그 자리다.
2. **거짓 고지가 사라졌다.** 같은 화면에 `chat-anchor-missed` 가 없다(`miss=none`).
3. **참인 고지는 남았다.** 앵커 메시지를 목록에서 아예 뺀 방에서는 창이 바닥에 머물고 문장이 그대로
   선다. 즉 「목록에 물어보고, 답이 없다일 때만 말한다」로 고친 것이지 **문장을 지워서 통과시킨 것이
   아니다.** 이 구분이 이번 수리의 핵심이고, 프로브의 두 번째 케이스가 그것만을 위해 있다.

구조도 옳다: `bringIntoView` 가 폰과 같은 계약(데이터 배열 조회 → 리스트에 스크롤 명령)이고,
손잡이가 없을 때는 `undefined === false` 가 거짓이라 **옛 워처 경로로 얌전히 되돌아간다** — 손잡이
부재를 「없다」로 오독하지 않는다. 극성이 맞다.

## B2 — 2연타 무동작 **해소**

같은 프로브의 `press#2 seq=4102`. 그리고 원인이 실제로 제거됐다: 착지 뒤 주소가
`#/c/00000000-...-000000000201` 로 **비어 있다**(`?msg=` 없음). `?work=` 와 같은 규율이고,
파라미터를 상태+토큰으로 받아 「같은 곳을 두 번 가리켰다」가 두 번의 요청이 된다.

공유 경로 부수효과 확인: `gate:quote` PASS · `gate:pin` PASS · `gate:workstream` PASS.
(처음 workstream 이 실패한 것은 내가 전용 빌드 모드 `--mode workstream-gate` 없이 돌린 내 실수였다.
제대로 돌리면 통과한다 — 회귀 아님.)

## H1 — 칸 붕괴로 인한 지그재그 **해소** (캡처 좌표 재실측)

웹, `ade-drawer-light.png` / `ade-drawer-dark.png`, 각 행 상태·경과 띠의 **가장 오른쪽 잉크**
(구분선 x=818 은 제외하고 잰 값):

| 행 | 종류 | 1차 | 2차 |
|---|---|---|---|
| 관전 터미널 회귀 | session | 806 | **800** |
| Hermes | run | 861 | **800** |
| 릴리스 노트 초안 | session | 806 | **800** |
| 마이그레이션 042 검토 | session | 805 | **800** |
| 김인턴 | run | 862 | **800** |
| 스크롤 프로파일 | session | 805 | **800** |

spread 55px → **0px**, 두 스킴 동일. 구분선 x=818, 패널 끝 879 → 칸 61px.
390 narrow 도 같다(세션·턴 모두 잉크 끝 동일, 구분선 328/329).

폰, `anchor1193-panel-{light,dark}.png`, 경과 칸 오른쪽 끝:

```
light: 944 944 944 944 944 944 px  (= 314.67 pt)  spread 0 px
dark : 944 944 944 944 944 944 px  (= 314.67 pt)  spread 0 px
```

1차의 163px(54pt) 지그재그가 **0px**. 경과 문자열의 끝 글자가 행마다 다른데도(m/s) 0px 이라는 것은
유령 칸이 진짜 칸과 정확히 같은 폭이라는 뜻이다. 웹에서 그것을 직접 쟀다:

```
[a11y2] ghost: {"visibility":"hidden","ariaHidden":"true","ghostWidth":61.34375,"realWidth":61.34375,"focusable":-1}
```

3px 잔차의 원인 설명(`borderLeftWidth:0` 이 곧 1pt 였다 → `opacity:0`)도 맞다. 그 함정이 다시
들어오지 못하게 폰 테스트가 `flatStyle(ghost.props.style).opacity` 를 직접 읽는다.

시각적으로도 홀이 아니다: 유령은 투명이라 테두리도 함께 사라져 턴 카드는 예약된 여백만 갖는다
(`v2-web-light-rightcol.png` · `anchor1193-panel-light.png`).

## H2 — 컨트롤이 컨트롤로 안 읽히던 문제 **해소**

웹(`ade-drawer-{light,dark}.png` 실측):

| 축 | 1차 | 2차 |
|---|---|---|
| 글자 단 | `text-meta` 11~12px, 옆 힌트와 동급 | `text-body`, 글리프 높이 12~13px (힌트 「이어서 보기」는 여전히 11px) |
| 무게 | 기본 | `font-medium` |
| 경계 | `--line` 1.32:1(light) / 1.43:1(dark) | `--line-strong` **3.59:1 / 3.56:1** |
| 라벨 대비 | 5.11 / 6.04 | 5.34 / 6.36 |

3:1 은 컨트롤 경계의 기준선이고, 두 스킴 다 넘겼다. 크롭에서 보면 같은 행의
「이어서 보기」(힌트)와 「대화로」(버튼)가 이제 크기·무게·경계 셋으로 갈린다.
accent 로 갚지 않은 판단은 유지됐고 — 여섯 장 목록에 accent 낱말 넷은 accent 가 아니다 — 그 자리를
비색 축으로 메운 것이 옳다.

폰: 「대화로」 글리프 높이 11pt vs 바로 옆 경과 8.3pt, 잉크 대비 5.72:1(light) / 5.78:1(dark),
칸 폭 56.33pt(≥ 44pt). `font.label`(13) + 600 은 이 앱의 텍스트 액션 단(`atoms.retryLabel`,
`ConversationScreen.headerActionLabel`)과 같다.

## M2 · M3 · M4 · N1 · N2 · N3 **해소**

- **M2** — 앵커가 `{channelId, messageId}` 로 바뀌었고 효과가 `uuidEq(pendingAnchor.channelId,
  channelId)` 로 **다른 방에서는 절대 쏘지 않는다.** 30초 TTL 까지 붙어 목적지 방이 끝내 안 열리면
  조용히 사라진다. 내가 지적한 「몇 분 뒤 엉뚱한 방에서 터지는 거짓 문장」 경로가 둘 다 막혔다.
- **M3** — `measure/surfaces.tsx` 의 `jump-missed` 가 세 번째 `NoticeBlock`(세션 주어)을 세우고,
  `anchor1193-jump-missed-{light,dark}.png` 두 장이 세 문장을 나란히 찍었다. 주어가 갈렸다는 주장이
  이제 사진에 있다.
- **M4** — 게이트 픽스처 5줄 → 80줄(앵커가 가상 창 밖), 착지 seq 단정 + `chat-anchor-missed`
  카운트 0 단정 + 주소 비움 단정 + **두 번 누른다.** 이 단정들이 비어 있지 않다는 것은 내가
  경험적으로 안다: **직전 빌드는 이 조건 전부에서 실패했다**(1차 실측표와 2연타 프로브).
- **N1** — 세션 주어가 `reason` 을 보지 않는다. 도달 불가였던 「더 위쪽에 있습니다」가 사라졌고,
  테스트가 `headline` 에 「위쪽」이 없음을 지킨다.
- **N2** — `quote-jump-missed` → `jump-missed`.
- **N3** — 픽스처 id 가 모두 hex(`…1ada`, 생성분 `(0xe00000000000+i).toString(16)`).

## 접근성 재측정 (회귀 없음)

```
- list:
  - listitem:
    - button "관전 터미널 회귀 대기 10m 01s 이 기기에서만 · 엔진 · 호스트 연결 끊김 인수"
    - button "관전 터미널 회귀, 이 작업을 시작한 메시지가 있는 대화로 이동": 대화로
  - listitem:
    - button "김인턴 실행 중 0s release-2026-08 · 작업 중"        <- 턴 카드: 정거장 하나뿐
[a11y2] tab: ade-card -> ade-card-anchor -> ade-card -> ade-card-anchor -> ade-card -> ade-card-anchor -> ade-card -> ade-card
```

유령은 aria 트리에도 탭 순서에도 없다(`visibility:hidden` + `aria-hidden` + `tabIndex -1`).
「자리는 예약하되 컨트롤은 만들지 않는다」가 실제로 그렇게 됐다. 접근 이름이 보이는 글자를 여전히
품는다(WCAG 2.5.3) — 이제 목적지까지 말한다. 폰도 같은 구조이되 시뮬레이터 VoiceOver 실행 증거는
없어 코드 확인이다.

## 안 고친 M1 · N4 — 근거 검토

**N4(동사 우선) — 타당하다, 동의.**
SKILL-web §7 의 규칙은 무조건이 아니라 조건부다: "never bare 확인/Submit **where a verb fits**".
그리고 H1 수리가 그 조건을 실제로 바꿨다 — 칸은 이제 **모든 행이 내는 세금**이라 라벨 한 글자는
동사가 서지 않는 턴 카드에서도 폭을 먹는다. 390 narrow 캡처에서 가장 빡빡한 메타 줄
(「기기를 꺼도 계속됩니다 · release-2026-08 · 실행 중」)의 잉크 끝은 x=280, 구분선 328 → 48px,
오른쪽 여백 16px 을 빼면 실제 여유 **32px**. `text-body` 한글 한 글자는 약 14px 이므로 4글자 라벨은
남은 여유의 44% 를 먹는다. 픽스처가 짧은 편이라는 것까지 감안하면 이것은 수사가 아니라 제약이다.
접근 이름이 동사와 정확한 목적지를 든다는 점도 규격상 옳은 배치다(2.5.3 은 「포함」을 요구하지
「동일」을 요구하지 않는다).

**M1(폰에서 두 컨트롤이 같은 방으로 간다) — 축소 동의, 잔여는 남는다.**
낭독 사용자는 이제 정확히 구분된다. 남는 것은 **눈으로 보는 폰 사용자**가 카드 본체와 「대화로」를
글자만으로 구분하지 못한다는 것인데, 잘못 눌렀을 때의 대가가 **같은 방의 다른 스크롤 위치**이지
잘못된 목적지도 파괴적 동작도 아니고, 한 번 써 보면 배워진다. 이 비용이면 폭을 사는 것이 맞다고
본다 — 밀지 않는다. 다만 기록해 둔다: H1 수리로 **영구 예약된 칸**이 생겼으므로, 나중에 글자 폭을
늘리지 않고도 구분을 실을 자리(작은 글리프 하나)는 이미 확보돼 있다. 후속 티켓 재료이지 이번
머지의 조건이 아니다.

## 새로 남는 잔여 (전부 Nitpick, 머지 차단 아님)

**N-a — 같은 컨트롤의 경계를 두 클라이언트가 다르게 그린다.**
웹은 `--line-strong`(3.56~3.59:1)로 옮겼는데 폰은 `borderLeftColor: color.border` 그대로다.
실측 1.41:1(light) / 1.30:1(dark). 그런데 폰 팔레트는 그 값을 **이미 갖고 있다**:
`textFaint` 가 `#84817d`/`#6f6e73` 로 웹 `--line-strong` 과 바이트로 같고, `tokens.ts` 머리말이
`textFaint ← --line-strong` 이라고 스스로 적어 두었다. 새 토큰 없이 참조 한 줄이면 두 클라이언트가
같은 말을 한다. (폰은 터치·큰 라벨·눌림 피드백이 있어 부담이 작다 — 그래서 Nitpick 이다.)

**N-b — 세션 고지 제목이 한 음절만 남기고 줄바꿈된다.**
`anchor1193-jump-missed-light.png`: 「이 작업을 시작한 메시지를 이 화면에서 찾지 못했습니 / 다」.
402pt 에서 「닫기」와 나눠 쓰는 폭이라 두 줄은 불가피하지만, 끊기는 자리가 마지막 한 글자다.

**N-c — 주소 계약이 뒤집혔고, 그 대가가 기록돼 있지 않다.**
한 커밋 전 게이트는 hash 에 `msg=` 가 **없으면** 던졌다("새로고침하면 사라지는 착지다"). 지금은
**있으면** 던진다. `?work=` 와 같은 규율이고 B2 를 푸는 것이 정확히 이것이라 동의하지만, 붙여넣은
딥링크가 새로고침을 못 견디게 된 것은 사실이다. 그 문장이 어디에도 남아 있지 않다.

**N-d — 새 단정 두 종류(`the list zigzagged`, 깊이/2연타 착지)에는 이름 붙은 red proof 가 없다.**
이 파일의 다른 검사 열한 개는 전부 갖고 있다. 이번에는 내가 직전 빌드로 경험적 red 를 확인했으므로
비어 있지 않다는 것은 안다 — 규율만 안 맞는다.

---

## 판정

| 항목 | 상태 |
|---|---|
| B1 가상 창 밖 착지 · 거짓 고지 | 해소 (300줄 방 실착지, 참인 고지는 보존) |
| B2 2연타 무동작 | 해소 (2연타 착지, 주소 비움) |
| H1 상태·경과 열 지그재그 | 해소 (웹 spread 55px→0px, 폰 163px→0px) |
| H2 컨트롤 타이포·경계 | 해소 (웹 3.59/3.56:1 경계 + text-body, 폰 13pt/600) |
| M2 스테일 앵커 | 해소 (방 한정 + 30초 TTL) |
| M3 하네스 드리프트 | 해소 (표면 추가 + 사진 2장) |
| M4 게이트 얕은 픽스처 | 해소 (80줄 · 고지 0 단정 · 2연타) |
| N1 · N2 · N3 | 해소 |
| M1 · N4 미수리 | 근거 타당, 동의 (잔여는 후속) |
| 신규 | N-a · N-b · N-c · N-d (Nitpick) |

Blocker 0 · High 0 · Medium 0 · Nitpick 4

**Verdict: PASS**
