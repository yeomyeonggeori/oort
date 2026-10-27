# 폰 표면 — 페이지 · 드로어 · 바텀시트와 공용 부품

> **가리킬 자리 하나.** 폰에서 새 표면을 만들거나 옮길 때 「시트인가, 페이지인가, 드로어인가」와
> 「머리와 안쪽을 무엇으로 짓는가」를 물으면 여는 문서다. 정본 규칙은 [오르트 구름](README.md), 이 문서는
> 폰 표면 하나만 다룬다(웹·데스크탑은 해당 없음).
>
> - 이슈: #4318 (owner 2026-10-24·25). 이후 화면 이슈 #4457(홈 아바타 → 설정 페이지)·#4458(나머지 시트 전부 이전 — 이 문서 §5 가 그 결과다)·#4319(다른 사람 프로필)가 이 부품을 쓴다.
> - 참고: Buzz 캡처(비공개) 두 장, Buzz 모바일 소스(Apache-2.0) `buzz_sheet_header.dart`·`buzz_titled_sheet_layout.dart`·`modal_presentation.dart`·`app_list_card.dart`·`app_list.dart`·`buzz_action_tile.dart`. **구조와 값만 읽어 RN 으로 다시 짰다**(코드는 가져오지 않았다, 새 의존성 없음).
> - 코드: `clients/mobile/src/design/` — `PageSheet.tsx`(그릇) · `SheetChrome.tsx`(머리) · `sheetParts.tsx`(안쪽) · `sheetModel.ts`(판정) · `tokens.ts` 의 `SHEET`(치수) · `icons/` 의 `SHEET_ICONS`. 키보드 높이는 `src/lib/useKeyboardHeight.ts`.

## 1. 페이지 · 드로어 · 바텀시트 — 무엇을 어디에 쓰는가

| | 바텀시트 | 페이지 | 드로어 |
|---|---|---|---|
| 한 줄 | **지금 화면 맥락을 유지한 채 하는 짧은 일** | **되돌아올 위치가 필요한 일** | **지금 있는 곳을 바꾸는 이동 목록** |
| 들어가는 것 | 행동 6개 이하 · 입력 1~2칸 · 미리보기(프로필·메시지 행동·반응·길게 누르기) · 고르고 곧 닫히는 선택기 | 여러 묶음의 설정 · 긴 목록 · 상세(채널·DM 정보, 설정, 멤버 목록) | 워크스페이스·채널·DM 처럼 어디서든 오가는 탐색 목록 |
| 맥락 | 뒤의 화면이 스크림 아래에 그대로 남는다 | 화면 스택에 쌓인다. 닫으면 온 곳으로 돌아간다 | 뒤의 화면 위에 밀려 나왔다가 접힌다. 내용을 고치지 않는다 |
| 닫는 법 | 오른쪽 위 **원형 X** · 스크림 탭 · 끌어내리기 · VoiceOver 두 손가락 문지르기 | 머리 **왼쪽** 원형 X(스택의 첫 장·모달 페이지) 또는 ‹ 뒤로(그 위의 안쪽 장) · 가장자리 스와이프 | 바깥 탭 · 가장자리로 밀기 |
| 머리 | `SheetHeader`: [✓] 제목 [X] (✓ 는 편집 시트에만) | `PageHeader`: [X 또는 ‹] 제목 | 없다(목록이 머리) |
| 부품 | `PageSheet` + `SheetHeader` + 안쪽 부품 | `PageHeader` + 안쪽 부품(큰 타일 줄 → 묶음 카드 → 위험 행) | 폰에는 **지금 없다** |
| **지금 폰 사용처** | 메시지 행동 · 대화 행 행동 · 새 DM · 지시 기기 연결(#4318), 새 채널 · AI · 메시지 고치기 · 닫은 대화 · 기억 목록 · 새 버전 안내 · 내 맥에 보내기 · 작업 맡기기 · 작업 기록 · 작업 상세(#4458), 상태 설정(#4457), 다른 사람 프로필(#4319) | `src/screens/*` 의 스택 화면(홈·대화·받은함·검색·에이전트·앱·연결·팀 보드·작업), 설정(`SettingsPage` — #4457 에서 이전) | 없음 — 홈 탭(`SidebarScreen`)이 채널·DM 목록을 전체 화면으로 맡는다 |
| **후보** | 지금 화면을 두고 하는 짧은 일은 모두 | 정보·설정·멤버 목록처럼 되돌아올 곳이 있는 것 | 워크스페이스 전환 · 채널/DM 목록(웹 사이드바의 폰 짝). **이 PR 은 구현하지 않는다** — 폰에 두려면 먼저 두 가지를 풀어야 한다(ADR 사항): 왼쪽 가장자리 24pt 는 이미 뒤로가기 스와이프(`nav/edgeSwipe.ts`)가 쓰고, 홈 탭과 같은 목록을 두 곳에서 말하게 된다 |

### 시트에서 페이지로 — 넘어가는 규칙

1. **시트가 자라서 페이지가 된다**: 행동이 7개 이상, 입력이 3칸 이상, 목록이 한 화면을 넘어 스크롤해야 하거나, 안에서 **더 들어가는 행**(셰브론)이 생기면 시트가 아니라 페이지다. 시트에 스크롤이 필요한 것은 작은 화면·큰 글씨의 안전망이지 설계가 아니다(SE 에서는 메시지 행동 시트의 「지우기」 카드가 기본 크기에서도 85% 상한 아래로 접힌다 — 안에서 스크롤하고 X 는 머리에 고정이다).
2. **넘어갈 때 시트를 먼저 내린다**: 시트의 「더 들어간다」 행은 시트를 닫고(슬라이드가 끝난 뒤) 페이지를 연다. Modal 위에 화면을 쌓지 않는다. 페이지의 X 는 시트가 아니라 **온 화면**으로 돌려보낸다.
3. **페이지에서 시트로**는 자유다: 페이지 안의 한 항목을 고치는 일(상태 설정·이름 고치기)은 시트가 맡는다. 편집 시트는 왼쪽 ✓ 를 갖고, 입력 전에는 회색이다.
4. **예외 — 선택기**: 새 DM 처럼 「사람을 고르면 끝나는」 일은 목록이 길어도 시트다(`large` 단). 고르면 곧 닫히고 되돌아올 위치가 필요 없기 때문이다.

### 페이지 층의 움직임 — 올라오는 모달 페이지, 밀려 들어오는 안쪽 장 (#4457)

페이지(셸의 층, `nav/EdgeSwipeBack`)가 움직임 없이 서는 것은 앱의 기본이다. **설정 페이지가 그 규칙에 예외를 처음 둔다**(planner 결정). 옵트인이라 `enter` 를 안 준 층은 한 줄도 달라지지 않는다.

| | 들어옴 | 나감 | 닫는 단추 |
|---|---|---|---|
| **첫 장 = 모달 페이지** (`enter="rise"`) | 아래에서 올라온다 · 200ms(사다리 `modal-open`) | 아래로 내려간다 · 150ms(`modal-close`) | 머리 왼쪽 **X** |
| **안쪽 장 = 스택 push** (`enter="push"`) | 오른쪽에서 밀려 들어온다 · 240ms(`standard`) | 오른쪽으로 물러난다 · 180ms(`fast`) | 머리 왼쪽 **‹ 뒤로** |

- **나감은 들어온 길의 반대다.** 들어올 때는 미끄러지고 나갈 때는 사라지면 한 쌍으로 읽히지 않는다. X·‹·VoiceOver escape 는 `useLayerClose()` 로 같은 길을 지난다. 가장자리 밀기는 이것과 별개로 손가락을 따라 오른쪽으로 나가고(`MAX_SETTLE_MS`), 나가는 동안에는 다시 잡히지 않는다(두 번째 `onBack` 방지).
- 값은 `design/motion.ts` 의 `LAYER_RISE_MS`·`LAYER_SINK_MS`·`LAYER_PUSH_MS`·`LAYER_POP_MS` — 전부 모션 사다리 안의 칸이고 사라짐이 나타남보다 짧다. 곡선은 `EASE_OUT`. **동작 줄이기**면 움직임이 0 이다(처음부터 자리에 서고, 누르면 바로 걷힌다 — 사다리 D9).
- 층을 걷는 `onBack` 은 애니메이션 완료 콜백이 아니라 같은 길이의 **타이머**가 한 번 부른다(네이티브 구동 애니메이션은 시험 환경에서 끝나지 않고, 「닫는다」는 약속을 렌더러에 매달지 않는다).
- 이 페이지 위의 「상태 설정」 시트는 Modal 하나뿐이다 — 페이지가 Modal 이 아니라 층이기 때문이다(§1 규칙 2).

## 2. 그릇 — `PageSheet`

- **높이 세 단** (`height`): `fit`(기본 아님, 내용 높이 · 화면의 85% 위로는 안에서 스크롤) · `medium`(화면의 9/16 고정, Buzz 값) · `large`(기본, 위 58 에서 바닥까지 — 지금까지의 모양).
- **닫는 길 셋은 언제나 있다**: 머리의 원형 X · 스크림 탭 · 끌어내리기(손잡이 띠). VoiceOver 는 두 손가락 문지르기(`onAccessibilityEscape`). 하나만 있는 시트를 만들지 않는다.
- **끌어 닫기 문턱**: 120pt 를 **넘기거나** 속도 1.1pt/ms 를 **넘기면** 닫고, 모자라면 제자리로 돌아온다(`sheetModel.shouldDismissSheet`).
- **동작 줄이기**: 켜져 있으면 미끄러지지 않고 바로 서고 바로 사라진다(사다리 D9). 앱 뿌리가 저장소를 붙들고 있어야 시트가 서기 전에 답을 안다(`useRetainReduceMotion`).
- **안전 영역·키보드**: 몸은 `SheetScroll` — 머리 아래 숨 쉴 틈(`SHEET.bodyTop` 12 → 원 아래 끝에서 첫 내용까지 18), 홈 인디케이터 아래까지 여백, 입력에서 탭이 키보드를 접지 않음.
  - **내용 맞춤·중간 단은 키보드가 올라오면 시트의 바닥이 키보드 윗면에 앉는다**(`sheetModel.sheetFrame` 의 `bottom`) — 시트 안의 입력은 키보드에 가리지 않는다. 시트가 위로 자라 머리의 X 가 시계 뒤로 가지 않게 높이를 「키보드 위 ~ 큰 단의 위 끝」 안으로 줄인다(시뮬레이터 실측: SE 는 키보드 260pt 에서 9/16 = 375 의 중간 단이 349 로, 16 Pro 는 336pt 에서 491 이 472 로 줄어든다). 이때 `SheetScroll` 은 홈 인디케이터 여백을 걷고 끝 카드 아래 숨 쉴 틈 16 만 남긴다(키보드가 이미 덮는다 — 32 가 남으면 내용이 다 보이는 시트가 9pt 헛스크롤한다). 키보드 윗변은 모서리가 둥글어서 시트 바닥(= 키보드 윗면) 바깥 좌우로 스크림이 쐐기 모양으로 비치므로, 시트는 키보드 뒤로 `sheet` 색을 `SHEET.keyboardCorner`(28 > 실측 쐐기 24)만큼 더 깐다. 입력이 있는 짧은 시트의 표준 모양은 **중간 단 + `InputPill`** 이다(전시 표면 `sheetkit-status`).
  - **큰 단은 올리지 않는다.** 큰 단의 몸은 스크롤이고 입력이 있는 큰 단은 제 키보드 처리(`automaticallyAdjustKeyboardInsets` — 작업 맡기기·맥에 보내기)를 이미 갖는다. 시트 바닥까지 올리면 RN 이 알림 순간의 위치로 잡은 인셋이 시트가 올라간 뒤에도 남아 같은 키보드를 두 번 피한다. 입력이 있는 큰 단 시트를 옮길 때(#4458)는 몸 스크롤에 `automaticallyAdjustKeyboardInsets` 를 주거나(`SheetScroll` 은 `ScrollView` props 를 그대로 받는다) 목록을 위에 두고 `keyboardDismissMode="on-drag"` 를 쓴다(새 DM).
  - 시트는 키보드 **이벤트에서 한 번에 선다 — 곡선을 따라 미끄러지지 않는다**(`MessageEditorSheet` 와 같은 이유로 입력 모달 하나에서는 결함이 아니다. 컴포저는 별도 네이티브 `KeyboardPane`). 시트 안의 입력이 부른 키보드는 닫을 때 같이 내린다. 시트가 서기 **전에** 올라와 있던 키보드는 시트의 것이 아니라 건드리지 않고(처음부터 그 위에 선다), 한 번 내려간 뒤에 올라오는 것부터 시트의 것이다. 다만 **iOS 는 Modal 을 띄울 때 키보드를 접는다** — 입력창 대역이 키보드를 든 채 메시지 행동 시트를 열어도 시트가 서면 키보드가 없다(캡처 `sheetkit-message-keyboard`). 그래서 이 구분은 드문 경우를 위한 안전망이다.
- **행동은 시트가 내려간 뒤에 불린다**: 고르면 곧 닫히는 행동을 부모의 `setOpen(false)` 에 바로 맡기면 시트가 언마운트되며 스냅으로 사라진다. 그래서 행동 누름도 X·스크림·끌기와 **같은 닫는 길**로 보낸다 — 슬라이드가 끝난 뒤 `onClose` → 행동이 **한 번**(동작 줄이기면 바로). `ListRow`·`ActionTile` 은 `closesSheet`, 그 밖의 누를 것은 `usePageSheetAction()` 으로 쓴다(아래 §3). 이미 닫는 중이면 행동은 불리지 않는다.
  - **보내지 않는 행동**: 시트가 **진행·영수증·실패를 스스로 보이는** 면의 행동(대화 행 시트의 읽음·알림·복사, 지우기 확인의 왕복). 그 면은 행동이 끝날 때까지 떠 있어야 한다 — 코어 `channelActionKeepsMenuOpen` 이 같은 이유로 그 항목들을 「열어 둔다」고 정한다.
  - **알려진 한계**: 부모가 서버 답을 받은 뒤 시트를 걷는 닫힘(대화 행 시트의 성공·복사 영수증 타이머, 메시지 삭제 성공)은 지금도 부모의 언마운트라 스냅이다. 고치려면 부모가 「닫는 중」 신호를 시트에 보내야 한다(PR 「발견」).
- 스크림 이름·testID 는 prop(`scrimLabel`·`scrimTestID`)이라 옛 시트의 「대화 액션 닫기」·`channel-sheet-backdrop` 을 그대로 이어받는다.

## 3. 머리 — 원형 X

모든 닫기는 **글자 없는 원형 X** 다(옛 글자 「닫기」·「닫기」 줄은 없다). 보조기술 이름 `closeLabel` 은 **필수**이고 「… 닫기」 문장이다 — 기본값 「닫기」 는 어느 시트를 닫는지 말하지 못한다.

- 눈에 보이는 원 **40**, 눌림 영역 **44**(`slopTo` 가 채운다), 글리프 **22**, 머리 줄 높이 `TOUCH_TARGET + space.sm`. 값은 `tokens.ts` `SHEET` 한 곳이다.
- **떠 보이는 근거는 토큰이다**(`sheetModel.circleLook`): 라이트는 `surface` 채움이 `sheet` 바탕 위에 서고 `elevationRest` 그림자가 띄운다. 다크는 그림자가 어두운 바닥 위에서 보이지 않고, 게다가 다크의 `surface` 는 `sheet` 와 새벽하늘 1.076 · 흑연 1.035 로 라이트의 1.109 · 1.083 보다 덜 갈린다. 그래서 다크는 한 단 위 `surfaceMuted`(1.234 · 1.119)와 가장자리 한 줄(`glassLine`)로 선다. **시험이 모든 테마에서 「다크의 원이 라이트의 원보다 바탕에서 덜 구분되지 않는다」를 잰다**(`sheetKit.test.tsx`).
- ✓ 는 `confirm={{label, onPress, disabled, busy}}`. 입력 전·바뀐 것이 없으면 `disabled`(회색 `textFaint`, `accessibilityState.disabled`) — 새 채널(이름 규칙)과 메시지 고치기(바뀐 것)가 그렇다. **내 맥에 보내기·작업 맡기기는 base 동작 그대로 글이 비어도 ✓ 가 켜져 있고 눌러서 검증이 막는다**(이 PR 은 로직을 안 바꿨다 — §7 공백). **왕복 중(보내는 중·저장 중)이면 `busy`** — ✓ 자리에 스피너가 서고 눌리지 않으며 `accessibilityState.busy` 와 이름의 진행 낱말(「보내는 중」)이 말한다. 회색은 「지금은 보낼 수 없음」이라 진행과 눈으로 구별되지 않기 때문이다(#4458).
- **페이지 머리의 왼쪽 원은 둘 중 하나다**(#4457): **X** 는 「이 페이지 전체를 닫는다」(스택의 첫 장·모달 페이지), **‹ 뒤로** 는 「한 겹만 벗기고 온 곳으로 돌아간다」(그 위에 쌓인 안쪽 장). iOS 관례와 같다 — X 는 나가는 문, ‹ 는 온 곳으로 한 걸음. 같은 원 상자(크기·채움·그림자)에 글리프만 다르다(‹ 는 대화 머리의 22pt 선 셰브론 `CONV_ICONS.left` — 새 에셋 없음, 뒤집어 그리지 않아 선명하다). 보조기술 이름은 「닫기」가 아니라 **돌아갈 곳**이다(`back.label`, 「설정으로 돌아가기」). `PageHeader` 는 `closeLabel`·`onClose` 와 `back` 중 하나만 받는다(타입이 막는다 — 한 머리에 나가는 문이 둘이면 어느 것이 어디로 가는지 모른다).

```tsx
// 행동 목록 시트 — 고르면 곧 닫히는 행동은 closesSheet.
<PageSheet height="fit" onClose={onClose} accessibilityLabel="메시지 액션"
  scrimLabel="메시지 액션 닫기" scrimTestID="sheet-backdrop" testID="message-action-sheet">
  <SheetHeader title="메시지 액션" closeLabel="메시지 액션 닫기" closeTestID="sheet-close" />
  <SheetScroll testID="sheet-scroll">
    <GroupCard>
      <ListRow title="답글 달기" onPress={onReply} closesSheet />
      <ListRow title="복사하기" onPress={onCopy} closesSheet />
    </GroupCard>
    {/* 시트 안에서 확인 단계로 가는 행은 닫지 않는다 */}
    <GroupCard><ListRow title="지우기" tone="danger" onPress={askDelete} /></GroupCard>
  </SheetScroll>
</PageSheet>

// 편집 시트 — 중간 단 + 입력 알약 + 왼쪽 ✓. 키보드는 그릇이 알아서 피한다.
<PageSheet height="medium" onClose={onClose} accessibilityLabel="상태 설정">
  <SheetHeader title="상태 설정" closeLabel="상태 설정 닫기"
    confirm={{label: '상태 저장', onPress: save, disabled: text.trim() === ''}} />
  <SheetScroll><InputPill accessibilityLabel="상태 한 줄" icon={…} value={text} onChangeText={setText} /></SheetScroll>
</PageSheet>

// 커스텀 누를 것: 슬라이드가 끝난 뒤 한 번.
const afterClose = usePageSheetAction();
<Pressable onPress={() => afterClose(() => onToggleReaction(emoji))} />

// 페이지: 그릇이 없으니 onClose 가 필수다.
<PageHeader title="설정" closeLabel="설정 닫기" onClose={goBack} />
// 그 위의 안쪽 장: X 가 아니라 ‹ — 한 겹만 벗긴다.
<PageHeader title="테마" back={{label: '설정으로 돌아가기', onPress: goBack}} />
```

## 4. 안쪽 부품 — 모두 `design/sheetParts.tsx`

바탕(시트 `sheet`, 페이지 `bg`) 위에 카드·입력·원이 **`surface`** 로 선다(Buzz `utilitySurfaceThemeData` 가 두 면을 맞바꾸는 것과 같은 구조). 색은 `Palette` 역할만 읽는다.

| 부품 | 무엇 | 메모 |
|---|---|---|
| `GroupLabel` | 섹션 라벨 — 카드 위 회색 작은 글씨 | `textMuted`(AA). `textFaint` 는 글자로는 4.5 를 못 지난다 |
| `GroupCard` | 둥근 묶음 카드(`ds2Radius.card`) | 자식 사이에 들여 쓴 구분선(n−1개). `inset="icon"` 이면 아이콘 칸을 비켜 글자 열에서, 숫자면 그 폭의 앞 요소(아바타)를 비켜서 시작. 다크는 `border` 한 줄이 가장자리를 가른다. **가로 여백(`SAFE_GUTTER` 16)은 주지 않는다 — 호스트가 진다**(`SheetScroll` 이 준다. 날 `ScrollView`·`FlatList` 는 제 콘텐츠 스타일에서 준다). 호스트가 안 주면 카드가 화면 가장자리까지 번진다(지시 기기 시트가 그랬다: 옛 `GroupSection` 은 스스로 졌다). 바깥 상자의 `style` 로 카드가 스스로 질 수 있다 |
| `GroupCardItem` | 가상화 목록(`FlatList`)의 한 줄을 같은 카드로 | 첫 줄 위·끝 줄 아래 모서리, 줄 사이 같은 구분선 |
| `ListRow` | 행: 앞 아이콘·이모지(`RowIcon`·`RowEmoji`) · 이름 · 보조 줄(`detail`, 문장이라 어절 단위로 줄바꿈) · 오른쪽 값(`value`, 두 줄까지 — 한 줄이면 「지금대로 · 10월 27일 16:11까지」가 말줄임으로 잘린다) · `accessory` = `chevron`(더 들어간다)·`expand`(여기서 고른다)·`copy`·`toggle` | `expanded`(제자리 펼침 행이 보조기술에 말하는 상태 — 펼치면 ⌄ 가 ⌃ 로 뒤집힌다. 주지 않으면 상태에 넣지 않는다). `tone="danger"` 는 파괴 행. **눌리는 행의 기본 보조기술 이름은 제목·보조 줄·값을 쉼표로 이은 것**(「상태, 회의 중」)이고 `accessibilityLabel` 을 주면 그것이 이긴다. 토글 꺼짐 트랙은 `textFaint`(카드 위 비텍스트 3:1). `closesSheet` = 시트를 내린 뒤 `onPress` 한 번(§2). 토글 행은 행 전체가 `switch` 하나, 안쪽 `Switch` 는 보조기술에서 숨는다(`closesSheet` 를 줘도 닫지 않는다). 켜짐 트랙은 `ok`. 꺼짐 트랙의 `textFaint` 는 이 부품이 처음이었다 — 설정 페이지의 `SwitchRow`(와 그것을 쓰는 `MemoryPauseSection`)는 #4457 이 같은 값으로 맞췄고(시험이 ListRow 토글과 같음을 잰다), 레포에서 `border` 가 남은 곳은 `NotificationPrimer` 하나다 — 옮기는 날 같이 맞춘다(앱에 꺼짐 색이 둘). 앞 이모지(`RowEmoji`)는 **데이터**(고른 상태·반응)에만 쓰고 글자 배율을 따라가지 않는다(22pt 칸, `ROW_GLYPH_MAX_SCALE`) |
| `ChoiceRow` | 라디오 행: 앞 표지(견본·강조색 점·썸네일 — 고르는 값의 모습) · 이름 · 보조 줄 · 오른쪽 ✓ | **고른 줄은 강조색 글자·굵게·✓ 세 신호가 함께 선다** — ✓ 하나만 바뀌면 손가락이 덮는 동안 신호가 없다(앱의 라디오 관례, #2702). 보조기술에는 `radio` + `selected`, 부모가 `radiogroup`. 큰 앞 칸(견본·썸네일)은 `leadingWidth` + `leadingAlign="center"` 이고 카드의 `inset`(숫자)이 같은 폭이어야 구분선이 글자 열에서 시작한다. 표지가 있는 카드끼리(테마·강조색)는 같은 앞 칸 폭을 쓴다(아래 예외). ✓ 는 고른 줄에만 그려지고 자리는 늘 지킨다. **#4457 이 올렸다**(테마 장이 `design/` 에 있어 feature 쪽 얇은 부품을 쓸 수 없었다) |
| `InputPill` | 입력 알약: 앞 아이콘 + 한 줄 입력 | 외곽선은 `textFaint`(3:1) — ADR-0189 D6 이 입력 그릇에만 남긴 선. Buzz 의 가는 선이 아니라 우리 규칙을 따른다 |
| `ActionTile`·`ActionTileRow` | 큰 행동 타일(위 아이콘·아래 이름), 같은 폭으로 나란히 | 다른 사람 프로필 시트(#4319)의 「메시지·복사」, 정보 페이지의 「즐겨찾기·알림 끄기」 자리. `closesSheet` 는 `ListRow` 와 같다(다른 화면으로 가는 「메시지」 타일) |
| `SheetScroll` | 시트 몸의 스크롤 | 위 여백 `SHEET.bodyTop`(12), 바닥 여백 = max(안전 영역, 16) + 16. 키보드가 올라와 있으면 안전 영역을 걷어 16 만 남는다. **내용이 시트를 넘치면 처음 선 직후 스크롤 막대를 한 번 보인다**(접힌 행이 있다는 단서가 접힘선의 우연에만 달리지 않게. 넘치지 않으면 부르지 않는다). 막대 색은 **앱의 모양**을 따른다(UIKit 은 시스템 모양으로 정해서, 앱 테마와 시스템이 엇갈리면 시트 바탕과 대비 1.07 로 안 보인다 — 사진 카드와 같은 처방) |
| `ConfirmStep` | 시트 안의 확인 단계: 카드(머리말·설명·실패 한 줄) + 「취소」·위험 단추 | 되돌릴 수 없는 일(지우기·나가기) 앞의 한 번 더. 실패는 확인 단계 **안에서** 말하고 새로 서면 보조기술이 읽어 준다(iOS 는 `alert` 역할만으로는 나타날 때 낭독하지 않는다). 왕복 중에는 위험 단추가 잠기고 `pendingLabel`·`busy` 가 진행을 말한다. 머리말·설명·실패는 모두 `Sentence`(어절 단위 줄바꿈). **문구에 「닫는 괄호 + 조사」(「…」가)를 쓰지 않는다** — `hangul-word` 는 괄호 뒤 조사를 못 붙잡아 SE 폭에서 줄 머리에 조사가 떨어진다(「…」 표시가 처럼 사이에 어절을 둔다. 시험이 렌더된 문장을 훑는다) |

낡은 `atoms.tsx` 의 `GroupSection`·`GroupRow`(반경 8·테두리 카드)는 **설정 페이지에서는 더 쓰이지 않는다** — #4457 이 본 페이지와 안쪽 장 다섯(테마·지시 기기·프로필 사진·알림 기한·방해 금지 기한)을 모두 새 가족으로 옮겼고, 시험이 「옛 카드의 지문(반경 8 + 가는 테두리 + surface 채움)이 어느 장에도 없다」를 전수로 잰다. 다른 화면은 #4458·#4319 가 옮기는 날 지운다. 새 화면은 위 가족만 쓴다.

#4318 이 「올릴 것」으로 남긴 여덟 가운데 **화면 쪽 얇은 부품(`features/profile/settingsRows.tsx`)에 남은 것**은 아래와 같다 — 공용 `ListRow`·`InputPill`·`GroupCard`·`PageHeader`·`SheetScroll` 에 같은 자리가 나면 그 부품이 지워진다. `ChoiceRow`(라디오)만 이 PR 이 올렸다.

| 얇은 부품 | `design/` 에 없는 것 |
|---|---|
| `SwitchRow` | 서버 값을 모르는 동안 스위치를 그리지 않고 스피너·빈 자리로 두는 `ListRow accessory="toggle"` 상태 + 접근성으로만 잠기는 상태 |
| `ActionRow` | 오른쪽 끝의 진행 스피너(`trailing`)·`tone="accent"`. (`expanded` 상태와 ⌄ 표지는 `ListRow` 에도 생겼고 같은 글리프·뒤집힘이다 — 셰브론 ›은 「더 들어간다」, ⌄ 는 「여기서 고른다」) |
| `SettingsNote`·`SettingsSection` | `GroupCard` 의 카드 밑 문장(`footnote`)과 `accessibilityRole="radiogroup"` 통과 |
| `StatusSheet` 의 `StatusInputPill` | `InputPill` 의 앞 자리(`leading`) 슬롯(이모지 칸 + 글 칸) |
| `SettingsPage` 의 `ScrollView` | `SheetScroll` 의 `ref` 전달(`scrollToEnd`) |
| `SettingsPage` 의 로그아웃 확인 블록 | `ConfirmStep` 의 **카드 안 배치**와 **채움 변형**(위험 단추 = `dangerFill`, 취소 = 3:1 `textFaint` 윤곽). 지금은 머리말·설명·단추의 반경·글자·줄 높이가 `ConfirmStep` 과 같고 시험이 같음을 잰다 — **일부러 다른 것은 위험 단추의 채움과 취소의 윤곽 둘뿐**이다(되돌릴 수 없는 유일한 행동이라 위계가 채움 > 윤곽) |

### `ListRow` 의 오른쪽 노드·역할·펼침 (#4458 2단계)

1단계가 부품에 자리가 없어 접거나 잃었던 세 가지를 `ListRow` 가 갖는다. `__tests__/sheetKit.test.tsx` 의 「행 — 오른쪽 임의 노드·역할·펼침 상태」가 그려진 순서·상태로 잰다.

| 슬롯 | 뜻 | 규칙 |
|---|---|---|
| `trailing` | 값(`value`) 뒤·셰브론 앞에 서는 임의 노드 — 칩·배지 같은 **표식** | **기본 보조기술 이름(제목·보조 줄·값)에 들어가지 않는다.** 표식의 글자를 읽혀야 하면 호출자가 `accessibilityLabel` 에 잇는다(AI 시트의 「개인」·「내 맥 켜짐」). 표식은 색만으로 말하지 않는다 — 글자가 상태를 말한다. 눌리지 않는 행에도 선다. 글자뿐이면 `value` 를 쓴다. **큰 글씨에서는 호스트가 내린다**: 오른쪽 노드가 폭을 먹으면 이름 칸이 한 글자 폭으로 접히므로(AX5·SE) 호스트(AI 시트)가 `STACK_PILL_SCALE` 부터 노드를 빼고 그 글자를 보조 줄 아래로 옮긴다 |
| `accessibilityRole` | 눌리는 행의 역할(기본 `button`) | 이 앱 **밖**(브라우저)으로 나가는 행은 `link` 다 — 세션 상세의 PR 행. 토글 행은 늘 `switch` 이고 이 값을 듣지 않는다 |
| `expanded` | 제자리 펼침 행(`accessory="expand"`)이 보조기술에 말하는 상태 | 주지 않으면 상태에 넣지 않고(`false`=접힘과 다르다), 펼치면 ⌄ 가 ⌃ 로 뒤집힌다. 작업 맡기기의 「저장소·브랜치」 행. 구현 문장은 #4457 이 설정 페이지에서 올리는 것과 같다 |

`ConfirmStep` 의 두 단추 라벨(「취소」·위험 단추)은 `Sentence`(어절 단위 줄바꿈)·가운데 정렬이고 단추 상자가 가로 여백 `space.sm` 을 준다 — AX5 에서 「채널 나 / 가기」로 어절 가운데서 끊기고 글자가 테두리에 붙던 것(design-review #4318 r6-M2)을 이 이슈가 닫았다. 확인 단추의 **모양**(반경 8 `radius.md` 의 외곽선 사각형이 카드 반경 20 가족 밖, r3 M2·r4 M4)은 디자인 결정이라 아직 정하지 않았다(§7).

### 행 앞 아이콘 — 규칙과 재고

- **한 표면(시트·페이지) 안의 카드는 모두 앞 칸(아이콘·이모지)을 갖거나 모두 갖지 않는다.** 카드 안에서만 지키면 카드 사이로 글자 열이 점프한다(대화 행 시트의 복사 카드만 아이콘을 줬을 때, 전시 페이지의 앞 칸 있는 카드 아래에 앞 칸 없는 카드가 섰을 때 글자 시작이 38pt 어긋났다 — design-review #4318 r1·r3). 한 카드 안에서도 앞 칸이 있는 줄과 없는 줄을 섞지 않고, 아이콘 줄과 이모지 줄도 섞지 않는다. 갖는 카드는 `GroupCard inset="icon"` 으로 구분선이 글자 열에서 시작한다. 라디오 줄의 값 미리보기 표지는 이 규칙의 밖이다(바로 아래).
- **예외 — 라디오 줄의 값 미리보기 표지.** `ChoiceRow` 의 `leading` 이 테마 견본·강조색 점·사진 썸네일처럼 **고르는 값의 모습**을 미리 보이면, 그것은 앞 칸이 아니라 값의 내용이라(웹의 같은 선택지도 견본이다) 위 규칙의 밖이다. **표지가 모든 줄에 있는 카드는 한 열을 공유한다**: 줄마다 같은 폭의 표지 칸을 갖고 카드의 `inset` 이 그 폭이라 구분선이 글자 열에서 시작한다(테마·강조색은 견본 폭 44). 표지 없는 카드(화면 모드)와는 글자 시작이 달라도 된다. 표지가 값에 따라 있을 때만 서는 줄은 이 열 규칙에도 못 든다: 배경 카드의 「내 사진」은 사진을 고른 뒤에만 36pt 썸네일이 서서 같은 카드의 「기본」 줄(표지 없음)과 글자 시작이 다르다 — 이 줄만 예외로 두고, 옛 `GroupRow` 도 같은 모양이었다. **라디오가 아닌 줄에는 이 예외가 없다** — 예외에 들지 않는 것은 위 규칙(전부 또는 전무)을 그대로 따른다. 상태 점은 색이 이미 머리의 알약에서 말해져 설정 「내 상태」에 서지 않고(중복), 빠른 상태의 이모지는 **값 자체**(저장될 글자)라 상태 시트에서 이름 앞 글자로 둔다 — 앞 칸에 세우면 이웃 카드(「만료」)와 글자 시작이 38pt(앞 칸 22 + 오른쪽 8 + 행 gap 8) 어긋난다.
- **설정 페이지의 문법은 앞 칸이 없는 쪽이다**(Buzz 설정 페이지: 행마다 이름 + 오른쪽 한 요소). 앞 칸이 있다면 **이모지는 데이터**(고른 상태·반응)에만, **기능**(이동·연결)은 22pt 선 글리프다 — 기능 이모지는 쓰지 않는다. (`RowEmoji` 는 반응·상태를 목록 앞 칸에 세우는 표면을 위한 부품이다 — #4457 뒤로 앱 코드에는 소비처가 없고 전시 표면과 시험이 쓴다.) 두 문법의 견본이 전시 표면 `sheetkit-page`(앞 칸 없음)와 `sheetkit-page-lead`(모든 카드가 앞 칸)다.
- **그래서 이전한 두 행동 시트(메시지·대화 행)에는 앞 아이콘이 없다.** 우리 아이콘 세트(`design/icons/`)에 맞는 글리프가 **복사**(`SHEET_ICONS.copy`) 하나뿐이고, 새 아이콘 자산은 이 PR 이 만들지 않는다. 복사 셋에만 주면 시트가 두 문법으로 읽히고(동사 「복사하기」 옆에 같은 글리프가 되풀이돼 길잡이 정보도 0 이다), 웹 행 메뉴도 앞 아이콘이 없다.
- **없어서 못 주는 글리프**(후속 아이콘 이슈 — 번호는 planner 가 매긴다, Lucide ISC 에 있다): 답글(`reply`) · 인용(`quote`) · 고정(`pin`) · 고치기(`pencil`) · 지우기(`trash-2`) · 알림(`bell-off`) · 읽음(`mail-open`) · 나가기(`log-out`). 여덟이 **한 번에** 구워지면 두 시트의 모든 카드가 앞 아이콘을 갖는다.
- 아이콘 칸은 22 고정이다 — **22pt 로 구운 글리프만** 쓴다(18pt 로 구운 `user`·`bot` 은 22 칸에서 확대돼 흐려진다). 복사처럼 값을 가져가는 행은 앞이 아니라 오른쪽 자리(`accessory="copy"`)다.

## 5. 기존 폰 시트·페이지 분류표

코드 사실(2026-10-26, `origin/track/uxui` + #4458)과 규칙상의 자리를 나란히 둔다. **판정 보류**였던 것은 #4458 이 안쪽 입력·목록 수를 세어 확정했고(아래 「센 값」), 규칙상 페이지인데 시트로 둔 곳은 **이 이슈가 머리·부품만 옮겼기 때문**이다 — 페이지로 바꾸는 일은 화면 스택·가장자리 스와이프(`nav/edgeSwipe.ts`)를 건드리는 별도 이슈다.

| 표면 | 코드 | 지금의 그릇 | 센 값 | 규칙상 | 상태 |
|---|---|---|---|---|---|
| 메시지 행동 | `MessageActionSheet` | `PageSheet` fit | 반응 + 행동 6 이하, 파괴 행은 따로 선 카드. 고르면 곧 닫히는 행동은 `closesSheet` | 시트 | #4318 |
| 대화 행 행동 | `ChannelActionSheet` | `PageSheet` fit | 코어 표가 준 짧은 행동 묶음 + 나가기 확인. 시트가 진행·영수증·실패를 보이므로 `closesSheet` 를 쓰지 않는다 | 시트 | #4318 |
| 새 DM | `NewMessageSheet` | `PageSheet` large | 입력 1칸 + 사람 고르기 | 시트(선택기 예외) | #4318 |
| 지시 기기 | `DeviceKeyLinkSheet` | `PageSheet` large | QR 연결 직후 한 번 뜨는 상태 안내와 확인. `DeviceKeyPanel`(새 `GroupCard`)은 **두 호스트**를 가진다 — 이 시트와 설정 페이지의 안쪽 장. 패널이 카드의 가로 여백을 스스로 진다 | 시트 | #4318 |
| 새 채널 | `NewChannelSheet` | `PageSheet` **medium** | 입력 1 + 라디오 1묶음(2행). ✓ = 채널 만들기 | 시트 | #4458 |
| AI | `AiSheet` | `PageSheet` **fit** | 행 ≤ 5, 모두 「다른 곳으로 가는 문」 — 누르면 시트가 먼저 내려간 뒤 이동(`usePageSheetAction`). 「개인」 표식·「내 맥 켜짐/꺼짐」 칩은 행의 오른쪽 노드(`ListRow trailing`)이고 글자는 행의 이름에도 든다. **큰 글씨(`STACK_PILL_SCALE` 1.5 부터)에서는 오른쪽 노드를 그리지 않고** 그 글자를 보조 줄 아래 제 줄로 내린다 — 칩이 폭을 먹어 이름 칸이 한 글자 폭으로 접히던 것(AX5·SE) | 시트(문 모음) | #4458 |
| 메시지 고치기 | `MessageEditorSheet` | `PageSheet` **medium** | 입력 1(여러 줄). ✓ = 저장, X = 고치기 취소 | 시트 | #4458 (자체 `Modal` → 공용) |
| 닫은 대화 | `DmClosedSheet` | `PageSheet` **fit** | 목록(스크롤) · 대화 하나 = 행 하나(행 전체가 「다시 열기」·「열기」) | 시트(선택기) | #4458 (자체 `Modal` → 공용) |
| 새 버전 안내 | `AppUpdateSheet`(`AppUpdateBanner.tsx`) | `PageSheet` **fit** | 행 1(스토어로 가기) + 안내 한 문단 | 시트 | #4458 (자체 `Modal` → 공용). 배너 자체에는 닫기가 없다 |
| 기억 목록 | `MemoryDigestSheet` | `PageSheet` **fit** | 요약 목록(스크롤) · 근거 알약은 그 메시지로 가는 길 | 페이지 후보 — 시트로 둠 | #4458 (자체 `Modal` → 공용) |
| 내 맥에 보내기 | `AskMacSheet` | `PageSheet` large | 글 입력 1(여러 줄) + 라디오 묶음 최대 5(방식 2·맥 n·도구 n·폴더 n·채널 n, 행 8~20+, 늘 스크롤) | **페이지** — 시트로 둠 | #4458 (머리·부품만) |
| 작업 맡기기 | `DelegateWorkSheet` | `PageSheet` large | 단계 2 · 입력 2(펼치면 4) · 라디오 2묶음. **✓ 는 마지막 확정(B 단계 「맡기기」)에만** — A 단계의 「다음」은 시트 아래의 기본 단추(`PrimaryButton`)다 | **페이지**(입력 4) — 시트로 둠 | #4458 (머리·부품만) |
| run 기록 | `RunLedgerSheet` | `PageSheet` large | 읽기 전용 긴 목록 | **페이지** — 시트로 둠 | #4458 (머리·부품만) |
| 세션 상세 | `TeamBoardDetailSheet` | `PageSheet` large | 읽기 전용 상세(구획 6) · 이동 행 2. X 의 이름은 「작업 상세 닫기」(코어 `drawerClose` 는 웹 공용인 맨 「닫기」) | 페이지(상세) — 시트로 둠 | #4458 (머리·부품만) |
| 내 설정 | `SettingsPage`(셸의 층 `nav.settings`) | 스택 층(페이지) | 상태·알림·기억·보기(테마)·연결·계정 **여러 묶음 설정**. 안쪽 장 5종(테마·지시 기기·프로필 사진·알림 기한·방해 금지 기한)은 그 위에 한 겹 더 | **페이지** | **#4457 에서 이전** |
| 상태 설정 | `StatusSheet` | `PageSheet` fit | 이모지+글 입력 알약 · 기간(펼침 행) · 빠른 상태. 설정 페이지 위의 편집 시트(왼쪽 ✓ — 바뀐 것이 있을 때만 눌린다) | 시트 | **#4457 에서 이전** |
| 다른 사람 프로필 | `MemberProfileSheet` | 자체 `Modal` | 프로필 미리보기 + 큰 행동 타일 | 시트 | #4319 |
| QR 스캐너 | `QrScannerSheet` | 전체 화면 `Modal` | 카메라 전체 화면 + `ScreenHeader` 뒤로 | 바텀시트가 아니다 — 페이지 머리 문법은 #4457 의 `PageHeader` 몫 | 변경 없음 |
| 첨부 메뉴·+ 메뉴 | `AttachMenu`·`PlusMenu` | 앵커 팝오버 | 작은 메뉴 | **시트가 아니다**(메뉴) | 규칙 밖 |
| 사진 보기 | `AttachmentViewer` | 전체 화면 `Modal` | 몰입 뷰어. 닫기는 사진 위 크롬이고 **같은 X 글리프**(원 없음)다 | 규칙 밖(시트가 아니다) | #4458 (글리프만) |
| 화면 | `src/screens/*` (홈·대화·받은함·검색·에이전트·앱·연결·팀 보드·작업) | 스택 화면 | 되돌아올 위치가 있는 목록·상세 | **페이지** | — |

**시트가 아닌 닫기(배너·카드·뷰어)** 는 원형을 쓰지 않고 **같은 X 글리프만** 맞춘다(`SHEET_ICONS.close`): `NoticeBlock` 의 닫기 · 「안 읽은 동안」 요약 카드 · AI 연결 카드 · 사진 뷰어. 글자 「닫기」 단추는 시트에 0건이다 — 면제는 이유가 있는 셋(프로필 시트 #4457 · 다른 사람 프로필 #4319 · 행 안의 오류 「닫기」 — 형제 이슈가 만지는 `MessageRow.tsx`)뿐이고 `__tests__/sheetInventory4458.test.ts` 가 소스를 훑어 지킨다.

## 6. 무엇이 재고, 무엇이 안 재는가

- **재는 것**
  - `__tests__/sheetKit.test.tsx`: 끌어 닫기 문턱(거리·속도·경계) · 높이 세 단의 상자 · X 의 이름·누름·동작 줄이기(켬: 즉시 / 끔: 화면 높이만큼 미끄러진 뒤) · 스크림 · escape · 응답자 이벤트로 재생한 끌기 · ✓ 의 비활성 · 모든 테마에서 X 가 떠 보이는 관계 · 카드 구분선 수와 들여쓰기 · 행의 값·토글·위험·비활성 · 입력 알약의 외곽선.
  - `__tests__/sheetKeyboardAction.test.tsx`: 두 기기(16 Pro·SE)의 내용 맞춤·중간 단에서 **시트 바닥 = 키보드 윗면, 시트 위 끝 ≥ 큰 단의 위 끝**, 큰 단은 올리지 않음, 키보드가 없으면 옛 단별 식(상수)과 같음 · 키보드 이벤트 배선(올라옴·내려감·did 쌍) · 몸 스크롤의 안전 영역 여백 · 시트 안 입력이 부른 키보드만 닫을 때 같이 내림(서기 전의 키보드는 건드리지 않음, 한 번 내려간 뒤에는 시트의 것) · `usePageSheetAction` 의 순서(onClose → 행동)·한 번·동작 줄이기·시트 밖 · 닫는 길의 정체성이 부모 리렌더·키보드에 안 바뀜 · 닫는 중에는 손잡이를 잡지 않음 · 누름 이벤트를 인자로 받는 X·스크림 · `closesSheet`(행·타일·토글) · 메시지 시트의 여섯 행동(슬라이드 뒤 / 동작 줄이기 즉시)과 지우기 둘(보내지 않음) · 대화 행 시트(보내지 않음, 앞 아이콘 없음) · `ListRow` 기본 이름·보조 줄 문장·토글 트랙 3:1(모든 테마) · `SheetScroll` 위 여백 · `ConfirmStep`(머리말·설명·실패의 `hangul-word`, 실패가 새로 설 때만 낭독) · 지시 기기 패널의 카드 가로 여백과 **호스트가 여백을 더하지 않음**(이중 인셋) · 미리보기·확인의 머리말·설명 `hangul-word` 와 **렌더된 확인 문장에 「닫는 괄호 + 조사」가 없음**(메시지 시트 두 상태, 대화 행 시트의 코어 실패 문장 전부) · 키보드 위 시트의 모서리 바탕(큰 단은 없음) · `SheetScroll` 의 키보드 위 바닥 여백 16·넘칠 때만 막대 한 번 · `RowEmoji` 의 배율 상한.
  - `__tests__/shellChrome.test.tsx`: 새 DM 의 사람 아바타 바닥이 `muted`(카드 위에서 원이 선다) · 빈 상태 문장의 `hangul-word`.
  - **시트마다 같은 계약**(#4458): `__tests__/fixtures/sheetContract.tsx` 의 `describeCloseContract` 가 시트별 시험 파일에서 머리 X(이름 「… 닫기」·공용 글리프·글자 「닫기」 없음) · X 즉시/슬라이드 뒤 · 스크림 이름·testID · escape · 끌어내리기를 같은 코드로 잰다. `__tests__/sheetInventory4458.test.ts` 는 소스를 훑어 「글자 닫기 단추 0」·「모든 `*Sheet.tsx` 는 `PageSheet`+`SheetHeader`」·「`<Modal` 은 그릇과 시트가 아닌 넷뿐」·「옛 묶음(`GroupSection`·`GroupRow`)은 정의와 `ThemeControl` 의 로컬 함수 말고 없음」을 계속 센다.
  - **2단계(#4458)**: `sheetPartsSlots4458.test.tsx` 「행 — 오른쪽 임의 노드·역할·펼침 상태」(값→표식→셰브론의 **그려진 순서**(기본 글씨; `STACK_PILL_SCALE` 부터는 값이 이름 칸으로 내려와도 표식은 그대로 셰브론 앞) · `trailing` 이 기본 이름에 안 들어감 · 역할 기본/link/switch · `expanded` 미지정/false/true 와 ⌄ 의 뒤집힘)와 「확정 ✓ 의 진행 표시」(`busy` 면 ✓ 글리프 대신 스피너 · 눌려도 아무 일 없음 · 상태 busy·disabled · `SheetHeader` 가 `confirm.busy` 를 전함) · `askMac`·`delegateWork`·`shellChrome`(새 채널)·`messageEditorSheet` 의 진행 중 시험(스피너 · 이름 「보내는 중」 · 다시 눌러도 요청은 한 번) · `sheetKeyboardAction.test.tsx` 「ConfirmStep」(두 단추 라벨의 `hangul-word`·가운데 정렬·단추의 가로 여백) · `aiSheet.test.tsx`(칩·「개인」 표식이 행 안에 그려짐 · 켜짐/꺼짐 칩의 채움 · 행 이름에 칩 글자) · `delegateWork.test.tsx`(A 머리에 ✓ 없음·바닥 단추 「다음」, B 머리 ✓ + X, 펼침 행 상태) · `teamBoard.test.tsx`(PR 행 `link`) · `runLedgerSheet.test.tsx`(한계·보관 문장이 「기록」 라벨 아래·목록 위 — **그려진 순서**, 요약·기록 줄·문장의 어절 줄바꿈) · `shellChrome`(새 채널 규칙·오류 줄)·`delegateWork`(거절 배너 문장)의 어절 줄바꿈 · **design-review r2 반영**: `shellChrome`(새 채널의 라벨·입력·규칙 줄이 **한 묶음**이고 안쪽 간격이 `space.sm` — 형제 시트의 입력 묶음과 같은 문법) · `runLedgerSheet`(빈 기록 머리말·설명)·`delegateWork`(칸 오류 문장·저장소 규칙 줄)·`askMac`(글 검사 오류·채널/폴더 힌트·Face ID 안내 줄)의 어절 줄바꿈.
  - #4457: `sheetKit.test.tsx` 의 「‹ 뒤로 변형」(왼쪽 칸·22pt ‹ 글리프·X 와 같은 원 상자·X 없음) · `layerMotion4457.test.tsx`(층의 들어옴·나감: 사다리 값·시작 위치·시킨 설정과 `start` 호출·동작 줄이기 0·타이머 확정·이중 닫기·언마운트·나가는 중 가장자리 차단) · `settingsPage.test.tsx`(셸 안 배선 — 첫 장은 올라오고 X 는 내려간다·안쪽 장은 밀려 들어오고 ‹·escape 는 물러난다, 안쪽 장 전수 「옛 카드 0」) · `settingsRows.test.tsx`(`ActionRow`·`ChoiceRow` 의 세 신호·앞 칸·`ListRow` 와 같은 상자·꺼짐 트랙) · `appearancePicker.test.tsx`(카드 구분선이 앞 칸을 비킴) · `settingsHarnessPersona4457.test.ts`(설정 표면에 가상 인물만) · design-review r1 반영: `settingsPage.test.tsx`(설정 페이지에 앞 칸이 없고 구분선이 한 열 · 두 얼굴의 크기·링 · 로그아웃 확인이 `ConfirmStep` 과 같은 문법 · 줄 높이 리터럴 없음) · `profileStatus.test.tsx`(기간 행 이름 = 코어 만료 낱말·「지우기」는 파괴 행 하나 · 두 카드 앞 칸 없음 · 이모지 칸 44×44 · 펼침 상태와 ⌄ 뒤집힘 · 긴 값 두 줄) · `sheetKit.test.tsx`(`ListRow` 의 `expanded`) · `settingsRows.test.tsx`(`ActionRow` 의 ⌄) · `appearancePicker.test.tsx`(테마·강조색이 같은 앞 칸 폭) · `avatarPage.test.tsx`(파괴 행이 따로 선 카드).
  - 새 파일의 격자 밖 간격·반경·글자 크기는 `designSystem.test.ts` 스윕이 0 으로 둔다.
- **재지 않는 것**: 실기기의 끌기 감촉 · 실제 VoiceOver 낭독 · **키보드가 올라올 때 시트가 도는 곡선의 느낌**(이벤트에서 한 번에 선다) · 스크롤 막대가 **눈에 보이는지**(호출만 잰다) · **렌더된 폭·여백·줄바꿈**(카드가 화면 가장자리까지 번지는지, 아바타 원이 카드에 녹는지, 한국어 어절이 갈리는지 — Jest 는 레이아웃 엔진이 없어 스타일 값과 시트 상자의 산수, 문구의 글자 조합만 잰다. 그 픽셀 증거는 캡처이고(`clients/mobile/measure/captures/4318/`, 전시 표면 `sheetkit-*`) design-review 가 사람의 눈으로 본다). 처음 한 번의 design-review 는 이 축에서 High 셋을 잡았다.
- **전시 표면**(`clients/mobile/measure/sheetKit.tsx`, 가상 인물만): `-momoMeasure SHEETKIT-<이름>`(다크) · `LIGHT-SHEETKIT-<이름>`(라이트). `page`(앞 칸 없는 쪽) · `page-lead`(앞 칸 있는 쪽) · `headers` · `status`·`status-ready`(중간 단 + 입력 + 키보드) · `message`·`message-delete`·`message-live`·`message-keyboard` · `channel`·`channel-leave`·`channel-dm` · `newdm`·`newdm-empty` · `devicekey-pending|approved|unregistered` · `profile-device`.
- **미결(제품 결정)**: 드로어를 폰에 둘지(§1 후보 행). 행 앞 아이콘 여덟(§4)은 후속 아이콘 이슈다. 값 행(`ListRow.value`)은 기본 글씨에서 오른쪽 두 줄까지·50% 폭 상한이고(한 줄이면 「지금대로 · 10월 27일 16:11까지」가 잘린다), **큰 글씨(`STACK_PILL_SCALE` 1.5 부터)에서는 값이 제목 아래로 내려온다**(#4457 의 AX5 캡처가 「지우지 않음」의 「지우…」 말줄임과 제목 상자 키가 어긋나는 것을 잡았다 — iOS 접근성 레이아웃과 같은 쌓기다).

## 7. 임시로 둔 것 — 부품이 모자라 #4458 이 `design/` 밖에 둔 것 (#4318 후속)

1단계는 `design/` 의 부품 파일(`sheetParts`·`SheetChrome`·`PageSheet`·`sheetModel`)을 만지지 않았다(#4457 이 같은 시기에 고쳤다). 2단계(#4318 착륙 뒤 planner 허가, 보안 검수 M1 수리 지시)가 `sheetParts.tsx` 의 **`ListRow`(`trailing`·`accessibilityRole`·`expanded`)와 `ConfirmStep`(두 단추 라벨)**, `SheetChrome.tsx` 의 **`ConfirmCheck`(`busy`)만** 고쳤고 나머지 부품은 그대로다. 아직 모자란 것은 `src/shell/sheetForm.tsx` 에 같은 모양으로 두고, 정식 부품이 올라오면 한 줄 import 치환으로 지운다.

| 임시 부품 | 모자란 것 | 정식 자리 |
|---|---|---|
| `SheetNotice` | 사실 한 문단 카드(옛 `NoticeBlock` 은 가로 여백 16 을 스스로 들어 시트 몸의 거터와 겹친다) | 공용 부품 후보 |
| `Field` | `InputPill` 은 ref·invalid 를 못 받는다(검증이 막은 칸으로 초점을 옮기고 외곽선을 실패색으로) | `InputPill` 에 ref·invalid |
| `TextArea` | 여러 줄 입력 — 알약은 여러 줄에서 모서리가 글자를 먹는다 | 공용 부품 후보 |
| `FieldLabel` | 라벨 + 오른쪽 한 마디(「조금 남았어요」) | `GroupLabel` 에 보조 문자열 |

라디오 행 `ChoiceRow` 도 처음엔 여기 임시본이 있었다. #4457 이 같은 이름·같은 props 의 정식 부품을 `sheetParts.tsx` 에 올려서 이 PR 이 세 시트(새 채널·내 맥에 보내기·작업 맡기기)를 그것으로 갈아 끼우고 임시본을 지웠다. 앞 표지(`leading`)를 쓰지 않는 호출에서는 두 구현의 행 구조(이름 칸 + 오른쪽 ✓ 칸)와 스타일 값이 같다.

그 밖의 공백: `ConfirmStep` 의 확인 단추 **모양**(반경 8 `radius.md` 외곽선 사각형이 카드 반경 20 가족 밖 — r3 M2·r4 M4)은 디자인 결정이라 정하지 않았다(옮긴 시트 중 `ConfirmStep` 사용처는 0이고, 쓰는 곳은 메시지·대화 행 두 시트다) · `atoms.tsx` 의 `GroupSection`·`GroupRow` 는 #4457 이 설정 영역을 옮기면서 **프로덕션 사용처가 없어졌다**. 그래도 지우지 않았다 — `aiSheet`·`askMac`·`delegateWork`·`settingsPage` 시험이 「옛 카드가 없다」를 재려고 컴포넌트 타입(과 지문 대조군)으로 import 하기 때문이다. 지우려면 그 시험들을 지문 상수로 바꿔야 하므로 후속 정리다(`sheetInventory4458.test.ts` 가 그동안 옛 묶음이 정의와 `ThemeControl` 의 같은 이름 로컬 함수 말고 어디에도 되돌아오지 않음을 지킨다) · ✓ 의 「지금 보낼 수 있음」 신호가 시트마다 다르다(§3) — 내 맥에 보내기·작업 맡기기는 빈 글에서도 켜짐(검증이 누를 때 막는다), 통일은 로직을 건드리는 별도 결정이다 · **규칙상 페이지인 시트 다섯**(내 맥에 보내기·작업 맡기기·작업 기록·작업 상세·기억 목록)은 시트로 둔 채 머리·부품만 옮겼고 페이지 전환은 #4611 이다.
