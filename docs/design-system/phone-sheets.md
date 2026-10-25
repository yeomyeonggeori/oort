# 폰 표면 — 페이지 · 드로어 · 바텀시트와 공용 부품

> **가리킬 자리 하나.** 폰에서 새 표면을 만들거나 옮길 때 「시트인가, 페이지인가, 드로어인가」와
> 「머리와 안쪽을 무엇으로 짓는가」를 물으면 여는 문서다. 정본 규칙은 [오르트 구름](README.md), 이 문서는
> 폰 표면 하나만 다룬다(웹·데스크탑은 해당 없음).
>
> - 이슈: #4318 (owner 2026-10-24·25). 이후 화면 이슈 #4457(홈 아바타 → 설정 페이지)·#4458(나머지 시트 전부 이전)·#4319(다른 사람 프로필)가 이 부품을 쓴다.
> - 참고: Buzz 캡처(비공개) 두 장, Buzz 모바일 소스(Apache-2.0) `buzz_sheet_header.dart`·`buzz_titled_sheet_layout.dart`·`modal_presentation.dart`·`app_list_card.dart`·`app_list.dart`·`buzz_action_tile.dart`. **구조와 값만 읽어 RN 으로 다시 짰다**(코드는 가져오지 않았다, 새 의존성 없음).
> - 코드: `clients/mobile/src/design/` — `PageSheet.tsx`(그릇) · `SheetChrome.tsx`(머리) · `sheetParts.tsx`(안쪽) · `sheetModel.ts`(판정) · `tokens.ts` 의 `SHEET`(치수) · `icons/` 의 `SHEET_ICONS`. 키보드 높이는 `src/lib/useKeyboardHeight.ts`.

## 1. 페이지 · 드로어 · 바텀시트 — 무엇을 어디에 쓰는가

| | 바텀시트 | 페이지 | 드로어 |
|---|---|---|---|
| 한 줄 | **지금 화면 맥락을 유지한 채 하는 짧은 일** | **되돌아올 위치가 필요한 일** | **지금 있는 곳을 바꾸는 이동 목록** |
| 들어가는 것 | 행동 6개 이하 · 입력 1~2칸 · 미리보기(프로필·메시지 행동·반응·길게 누르기) · 고르고 곧 닫히는 선택기 | 여러 묶음의 설정 · 긴 목록 · 상세(채널·DM 정보, 설정, 멤버 목록) | 워크스페이스·채널·DM 처럼 어디서든 오가는 탐색 목록 |
| 맥락 | 뒤의 화면이 스크림 아래에 그대로 남는다 | 화면 스택에 쌓인다. 닫으면 온 곳으로 돌아간다 | 뒤의 화면 위에 밀려 나왔다가 접힌다. 내용을 고치지 않는다 |
| 닫는 법 | 오른쪽 위 **원형 X** · 스크림 탭 · 끌어내리기 · VoiceOver 두 손가락 문지르기 | 머리 **왼쪽** 원형 X(또는 뒤로가기·가장자리 스와이프) | 바깥 탭 · 가장자리로 밀기 |
| 머리 | `SheetHeader`: [✓] 제목 [X] (✓ 는 편집 시트에만) | `PageHeader`: [X] 제목 | 없다(목록이 머리) |
| 부품 | `PageSheet` + `SheetHeader` + 안쪽 부품 | `PageHeader` + 안쪽 부품(큰 타일 줄 → 묶음 카드 → 위험 행) | 폰에는 **지금 없다** |
| **지금 폰 사용처** | 메시지 행동 · 대화 행 행동 · 새 DM · 지시 기기 연결(이 PR에서 이전), 새 채널·AI·고치기 등(#4458), 다른 사람 프로필(#4319) | `src/screens/*` 의 스택 화면(홈·대화·받은함·검색·에이전트·앱·연결·팀 보드·작업), 설정(#4457) | 없음 — 홈 탭(`SidebarScreen`)이 채널·DM 목록을 전체 화면으로 맡는다 |
| **후보** | 지금 화면을 두고 하는 짧은 일은 모두 | 정보·설정·멤버 목록처럼 되돌아올 곳이 있는 것 | 워크스페이스 전환 · 채널/DM 목록(웹 사이드바의 폰 짝). **이 PR 은 구현하지 않는다** — 폰에 두려면 먼저 두 가지를 풀어야 한다(ADR 사항): 왼쪽 가장자리 24pt 는 이미 뒤로가기 스와이프(`nav/edgeSwipe.ts`)가 쓰고, 홈 탭과 같은 목록을 두 곳에서 말하게 된다 |

### 시트에서 페이지로 — 넘어가는 규칙

1. **시트가 자라서 페이지가 된다**: 행동이 7개 이상, 입력이 3칸 이상, 목록이 한 화면을 넘어 스크롤해야 하거나, 안에서 **더 들어가는 행**(셰브론)이 생기면 시트가 아니라 페이지다. 시트에 스크롤이 필요한 것은 작은 화면·큰 글씨의 안전망이지 설계가 아니다(SE 에서는 메시지 행동 시트의 「지우기」 카드가 기본 크기에서도 85% 상한 아래로 접힌다 — 안에서 스크롤하고 X 는 머리에 고정이다).
2. **넘어갈 때 시트를 먼저 내린다**: 시트의 「더 들어간다」 행은 시트를 닫고(슬라이드가 끝난 뒤) 페이지를 연다. Modal 위에 화면을 쌓지 않는다. 페이지의 X 는 시트가 아니라 **온 화면**으로 돌려보낸다.
3. **페이지에서 시트로**는 자유다: 페이지 안의 한 항목을 고치는 일(상태 설정·이름 고치기)은 시트가 맡는다. 편집 시트는 왼쪽 ✓ 를 갖고, 입력 전에는 회색이다.
4. **예외 — 선택기**: 새 DM 처럼 「사람을 고르면 끝나는」 일은 목록이 길어도 시트다(`large` 단). 고르면 곧 닫히고 되돌아올 위치가 필요 없기 때문이다.

## 2. 그릇 — `PageSheet`

- **높이 세 단** (`height`): `fit`(기본 아님, 내용 높이 · 화면의 85% 위로는 안에서 스크롤) · `medium`(화면의 9/16 고정, Buzz 값) · `large`(기본, 위 58 에서 바닥까지 — 지금까지의 모양).
- **닫는 길 셋은 언제나 있다**: 머리의 원형 X · 스크림 탭 · 끌어내리기(손잡이 띠). VoiceOver 는 두 손가락 문지르기(`onAccessibilityEscape`). 하나만 있는 시트를 만들지 않는다.
- **끌어 닫기 문턱**: 120pt 를 **넘기거나** 속도 1.1pt/ms 를 **넘기면** 닫고, 모자라면 제자리로 돌아온다(`sheetModel.shouldDismissSheet`).
- **동작 줄이기**: 켜져 있으면 미끄러지지 않고 바로 서고 바로 사라진다(사다리 D9). 앱 뿌리가 저장소를 붙들고 있어야 시트가 서기 전에 답을 안다(`useRetainReduceMotion`).
- **안전 영역·키보드**: 몸은 `SheetScroll` — 머리 아래 숨 쉴 틈(`SHEET.bodyTop` 12 → 원 아래 끝에서 첫 내용까지 18), 홈 인디케이터 아래까지 여백, 입력에서 탭이 키보드를 접지 않음.
  - **내용 맞춤·중간 단은 키보드가 올라오면 시트의 바닥이 키보드 윗면에 앉는다**(`sheetModel.sheetFrame` 의 `bottom`) — 시트 안의 입력은 키보드에 가리지 않는다. 시트가 위로 자라 머리의 X 가 시계 뒤로 가지 않게 높이를 「키보드 위 ~ 큰 단의 위 끝」 안으로 줄인다(시뮬레이터 실측: SE 는 키보드 260pt 에서 9/16 = 375 의 중간 단이 349 로, 16 Pro 는 336pt 에서 491 이 472 로 줄어든다). 이때 `SheetScroll` 은 홈 인디케이터 여백을 걷는다(키보드가 이미 덮는다). 입력이 있는 짧은 시트의 표준 모양은 **중간 단 + `InputPill`** 이다(전시 표면 `sheetkit-status`).
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
- ✓ 는 `confirm={{label, onPress, disabled}}`. 입력 전·바뀐 것이 없으면 `disabled`(회색 `textFaint`, `accessibilityState.disabled`).

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
```

## 4. 안쪽 부품 — 모두 `design/sheetParts.tsx`

바탕(시트 `sheet`, 페이지 `bg`) 위에 카드·입력·원이 **`surface`** 로 선다(Buzz `utilitySurfaceThemeData` 가 두 면을 맞바꾸는 것과 같은 구조). 색은 `Palette` 역할만 읽는다.

| 부품 | 무엇 | 메모 |
|---|---|---|
| `GroupLabel` | 섹션 라벨 — 카드 위 회색 작은 글씨 | `textMuted`(AA). `textFaint` 는 글자로는 4.5 를 못 지난다 |
| `GroupCard` | 둥근 묶음 카드(`ds2Radius.card`) | 자식 사이에 들여 쓴 구분선(n−1개). `inset="icon"` 이면 아이콘 칸을 비켜 글자 열에서, 숫자면 그 폭의 앞 요소(아바타)를 비켜서 시작. 다크는 `border` 한 줄이 가장자리를 가른다. **가로 여백(`SAFE_GUTTER` 16)은 주지 않는다 — 호스트가 진다**(`SheetScroll` 이 준다. 날 `ScrollView`·`FlatList` 는 제 콘텐츠 스타일에서 준다). 호스트가 안 주면 카드가 화면 가장자리까지 번진다(지시 기기 시트가 그랬다: 옛 `GroupSection` 은 스스로 졌다). 바깥 상자의 `style` 로 카드가 스스로 질 수 있다 |
| `GroupCardItem` | 가상화 목록(`FlatList`)의 한 줄을 같은 카드로 | 첫 줄 위·끝 줄 아래 모서리, 줄 사이 같은 구분선 |
| `ListRow` | 행: 앞 아이콘·이모지(`RowIcon`·`RowEmoji`) · 이름 · 보조 줄(`detail`, 문장이라 어절 단위로 줄바꿈) · 오른쪽 값(`value`) · `accessory` = `chevron`(더 들어간다)·`expand`(여기서 고른다)·`copy`·`toggle` | `tone="danger"` 는 파괴 행. **눌리는 행의 기본 보조기술 이름은 제목·보조 줄·값을 쉼표로 이은 것**(「상태, 회의 중」)이고 `accessibilityLabel` 을 주면 그것이 이긴다. 토글 꺼짐 트랙은 `textFaint`(카드 위 비텍스트 3:1). `closesSheet` = 시트를 내린 뒤 `onPress` 한 번(§2). 토글 행은 행 전체가 `switch` 하나, 안쪽 `Switch` 는 보조기술에서 숨는다(`closesSheet` 를 줘도 닫지 않는다). 스위치 색은 레포 관용구(`border`/`ok`) |
| `InputPill` | 입력 알약: 앞 아이콘 + 한 줄 입력 | 외곽선은 `textFaint`(3:1) — ADR-0189 D6 이 입력 그릇에만 남긴 선. Buzz 의 가는 선이 아니라 우리 규칙을 따른다 |
| `ActionTile`·`ActionTileRow` | 큰 행동 타일(위 아이콘·아래 이름), 같은 폭으로 나란히 | 프로필 시트의 「메시지·복사」, 정보 페이지의 「즐겨찾기·알림 끄기」 자리. `closesSheet` 는 `ListRow` 와 같다(다른 화면으로 가는 「메시지」 타일) |
| `SheetScroll` | 시트 몸의 스크롤 | 위 여백 `SHEET.bodyTop`(12), 바닥 여백 = max(안전 영역, 16) + 16(키보드가 올라와 있으면 안전 영역을 걷는다) |
| `ConfirmStep` | 시트 안의 확인 단계: 카드(머리말·설명·실패 한 줄) + 「취소」·위험 단추 | 되돌릴 수 없는 일(지우기·나가기) 앞의 한 번 더. 실패는 확인 단계 **안에서** 말한다. 왕복 중에는 위험 단추가 잠기고 `pendingLabel`·`busy` 가 진행을 말한다. 설명은 `Sentence` |

낡은 `atoms.tsx` 의 `GroupSection`·`GroupRow`(반경 8·테두리 카드)는 프로필 시트가 아직 쓴다. 새 화면은 위 가족만 쓴다.

### 행 앞 아이콘 — 규칙과 재고

- **한 시트 안의 카드는 모두 앞 아이콘을 갖거나 모두 갖지 않는다.** 카드 안에서만 지키면 시트 안 카드 사이로 글자 열이 점프한다(대화 행 시트의 복사 카드만 아이콘을 줬을 때 글자 시작이 38pt 어긋났다 — design-review #4318). 한 카드 안에서도 앞 칸이 있는 줄과 없는 줄을 섞지 않고, 아이콘 줄과 이모지 줄도 섞지 않는다. 갖는 카드는 `GroupCard inset="icon"` 으로 구분선이 글자 열에서 시작한다.
- **그래서 이전한 두 행동 시트(메시지·대화 행)에는 앞 아이콘이 없다.** 우리 아이콘 세트(`design/icons/`)에 맞는 글리프가 **복사**(`SHEET_ICONS.copy`) 하나뿐이고, 새 아이콘 자산은 이 PR 이 만들지 않는다. 복사 셋에만 주면 시트가 두 문법으로 읽히고(동사 「복사하기」 옆에 같은 글리프가 되풀이돼 길잡이 정보도 0 이다), 웹 행 메뉴도 앞 아이콘이 없다.
- **없어서 못 주는 글리프**(후속 아이콘 이슈 — 번호는 planner 가 매긴다, Lucide ISC 에 있다): 답글(`reply`) · 인용(`quote`) · 고정(`pin`) · 고치기(`pencil`) · 지우기(`trash-2`) · 알림(`bell-off`) · 읽음(`mail-open`) · 나가기(`log-out`). 여덟이 **한 번에** 구워지면 두 시트의 모든 카드가 앞 아이콘을 갖는다.
- 아이콘 칸은 22 고정이다 — **22pt 로 구운 글리프만** 쓴다(18pt 로 구운 `user`·`bot` 은 22 칸에서 확대돼 흐려진다). 복사처럼 값을 가져가는 행은 앞이 아니라 오른쪽 자리(`accessory="copy"`)다.

## 5. 기존 폰 시트·페이지 분류표

코드 사실(2026-10-25, `origin/track/uxui`)과 규칙상의 자리를 나란히 둔다. **판정 보류**는 안쪽 입력·목록 수를 #4458 이 옮기며 세어 확정한다 — 여기서 추측하지 않는다.

| 표면 | 코드 | 지금의 그릇 | 내용(근거) | 규칙상 | 상태 |
|---|---|---|---|---|---|
| 메시지 행동 | `MessageActionSheet` | `PageSheet` fit | 반응 + 행동 6 이하, 파괴 행은 따로 선 카드. 고르면 곧 닫히는 행동은 `closesSheet` | 시트 | **이 PR에서 이전** |
| 대화 행 행동 | `ChannelActionSheet` | `PageSheet` fit | 코어 표가 준 짧은 행동 묶음 + 나가기 확인. 시트가 진행·영수증·실패를 보이므로 `closesSheet` 를 쓰지 않는다 | 시트 | **이 PR에서 이전** |
| 새 DM | `NewMessageSheet` | `PageSheet` large | 입력 1칸 + 사람 고르기 | 시트(선택기 예외) | **이 PR에서 이전** |
| 지시 기기 | `DeviceKeyLinkSheet` | `PageSheet` large | QR 연결 직후 한 번 뜨는 상태 안내와 확인. `DeviceKeyPanel`(새 `GroupCard`)은 **두 호스트**를 가진다 — 이 시트와 프로필 시트의 안쪽 장. 패널이 카드의 가로 여백을 스스로 진다 | 시트 | **이 PR에서 이전** |
| 새 채널 | `NewChannelSheet` | `PageSheet` large | 이름 입력 + 공개/비공개 | 시트 | #4458 |
| AI | `AiSheet` | `PageSheet` large | + 메뉴의 AI 행 모음 | 시트 | #4458 |
| 내 맥에 보내기 | `AskMacSheet` | `PageSheet` large | 물어보기·작업 요청 한 화면 | 판정 보류 | #4458 |
| 작업 맡기기 | `DelegateWorkSheet` | `PageSheet` large | 단계 둘 | 판정 보류 | #4458 |
| 내 프로필·설정 | `ProfileSheet` | `PageSheet` large | 테마·알림·연결·계정 등 **여러 묶음 설정** | **페이지**(설정 페이지) | #4457 |
| 다른 사람 프로필 | `MemberProfileSheet` | 자체 `Modal` | 프로필 미리보기 + 큰 행동 타일 | 시트 | #4319 |
| run 기록 | `RunLedgerSheet` | `PageSheet` large | 읽기 전용 긴 기록 | 판정 보류(긴 목록이면 페이지) | #4458 |
| 세션 상세 | `TeamBoardDetailSheet` | `PageSheet` large | 큐레이션된 읽기 전용 상세(웹 드로어의 폰 짝) | 판정 보류 | #4458 |
| 닫은 대화 | `DmClosedSheet` | 자체 `Modal` | 다시 열기·열기 목록 | 시트 | #4458 |
| 메시지 고치기 | `MessageEditorSheet` | 자체 `Modal` | 입력 1칸 | 시트(✓ 확정이 서는 자리) | #4458 |
| 기억 목록 | `MemoryDigestSheet` | 자체 `Modal` | 요약 목록 | 판정 보류 | #4458 |
| 새 버전 | `AppUpdateBanner` 의 시트 | 자체 `Modal` | 업데이트 안내 | 시트 | #4458 |
| QR 스캐너 | `QrScannerSheet` | 자체 `Modal` | 카메라 | 판정 보류(전용 화면일 수 있다) | #4458 |
| 첨부 메뉴·+ 메뉴 | `AttachMenu`·`PlusMenu` | 앵커 팝오버 | 작은 메뉴 | **시트가 아니다**(메뉴) | 규칙 밖 |
| 사진 보기 | `AttachmentViewer` | 전체 화면 `Modal` | 몰입 뷰어 | 규칙 밖 | 규칙 밖 |
| 화면 | `src/screens/*` (홈·대화·받은함·검색·에이전트·앱·연결·팀 보드·작업) | 스택 화면 | 되돌아올 위치가 있는 목록·상세 | **페이지** | — |

## 6. 무엇이 재고, 무엇이 안 재는가

- **재는 것**
  - `__tests__/sheetKit.test.tsx`: 끌어 닫기 문턱(거리·속도·경계) · 높이 세 단의 상자 · X 의 이름·누름·동작 줄이기(켬: 즉시 / 끔: 화면 높이만큼 미끄러진 뒤) · 스크림 · escape · 응답자 이벤트로 재생한 끌기 · ✓ 의 비활성 · 모든 테마에서 X 가 떠 보이는 관계 · 카드 구분선 수와 들여쓰기 · 행의 값·토글·위험·비활성 · 입력 알약의 외곽선.
  - `__tests__/sheetKeyboardAction.test.tsx`: 두 기기(16 Pro·SE)의 내용 맞춤·중간 단에서 **시트 바닥 = 키보드 윗면, 시트 위 끝 ≥ 큰 단의 위 끝**, 큰 단은 올리지 않음, 키보드가 없으면 옛 단별 식(상수)과 같음 · 키보드 이벤트 배선(올라옴·내려감·did 쌍) · 몸 스크롤의 안전 영역 여백 · 시트 안 입력이 부른 키보드만 닫을 때 같이 내림(서기 전의 키보드는 건드리지 않음, 한 번 내려간 뒤에는 시트의 것) · `usePageSheetAction` 의 순서(onClose → 행동)·한 번·동작 줄이기·시트 밖 · 닫는 길의 정체성이 부모 리렌더·키보드에 안 바뀜 · 닫는 중에는 손잡이를 잡지 않음 · 누름 이벤트를 인자로 받는 X·스크림 · `closesSheet`(행·타일·토글) · 메시지 시트의 여섯 행동(슬라이드 뒤 / 동작 줄이기 즉시)과 지우기 둘(보내지 않음) · 대화 행 시트(보내지 않음, 앞 아이콘 없음) · `ListRow` 기본 이름·보조 줄 문장·토글 트랙 3:1(모든 테마) · `SheetScroll` 위 여백 · `ConfirmStep` · 지시 기기 패널의 카드 가로 여백 · 미리보기·확인 설명의 어절 줄바꿈.
  - `__tests__/shellChrome.test.tsx`: 새 DM 의 사람 아바타 바닥이 `muted`(카드 위에서 원이 선다).
  - 새 파일의 격자 밖 간격·반경·글자 크기는 `designSystem.test.ts` 스윕이 0 으로 둔다.
- **재지 않는 것**: 실기기의 끌기 감촉 · 실제 VoiceOver 낭독 · **키보드가 올라올 때 시트가 도는 곡선의 느낌**(이벤트에서 한 번에 선다) · **렌더된 폭·여백·줄바꿈**(카드가 화면 가장자리까지 번지는지, 아바타 원이 카드에 녹는지, 한국어 어절이 갈리는지 — Jest 는 레이아웃 엔진이 없어 스타일 값과 시트 상자의 산수만 잰다. 그 픽셀 증거는 캡처이고(`clients/mobile/measure/captures/4318/`, 전시 표면 `sheetkit-*`) design-review 가 사람의 눈으로 본다). 처음 한 번의 design-review 는 이 축에서 High 셋을 잡았다.
- **미결(제품 결정)**: 드로어를 폰에 둘지(§1 후보 행). 행 앞 아이콘 여덟(§4)은 후속 아이콘 이슈다. 값 행(`ListRow.value`)은 한 줄·50% 폭 상한이라 큰 글씨에서 말줄임될 수 있다 — 값 행이 느는 #4457 이 AX 캡처를 찍는다.
