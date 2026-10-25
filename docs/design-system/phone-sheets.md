# 폰 표면 — 페이지 · 드로어 · 바텀시트와 공용 부품

> **가리킬 자리 하나.** 폰에서 새 표면을 만들거나 옮길 때 「시트인가, 페이지인가, 드로어인가」와
> 「머리와 안쪽을 무엇으로 짓는가」를 물으면 여는 문서다. 정본 규칙은 [오르트 구름](README.md), 이 문서는
> 폰 표면 하나만 다룬다(웹·데스크탑은 해당 없음).
>
> - 이슈: #4318 (owner 2026-10-24·25). 이후 화면 이슈 #4457(홈 아바타 → 설정 페이지)·#4458(나머지 시트 전부 이전)·#4319(다른 사람 프로필)가 이 부품을 쓴다.
> - 참고: Buzz 캡처(비공개) 두 장, Buzz 모바일 소스(Apache-2.0) `buzz_sheet_header.dart`·`buzz_titled_sheet_layout.dart`·`modal_presentation.dart`·`app_list_card.dart`·`app_list.dart`·`buzz_action_tile.dart`. **구조와 값만 읽어 RN 으로 다시 짰다**(코드는 가져오지 않았다, 새 의존성 없음).
> - 코드: `clients/mobile/src/design/` — `PageSheet.tsx`(그릇) · `SheetChrome.tsx`(머리) · `sheetParts.tsx`(안쪽) · `sheetModel.ts`(판정) · `tokens.ts` 의 `SHEET`(치수) · `icons/` 의 `SHEET_ICONS`.

## 1. 페이지 · 드로어 · 바텀시트 — 무엇을 어디에 쓰는가

| | 바텀시트 | 페이지 | 드로어 |
|---|---|---|---|
| 한 줄 | **지금 화면 맥락을 유지한 채 하는 짧은 일** | **되돌아올 위치가 필요한 일** | **지금 있는 곳을 바꾸는 이동 목록** |
| 들어가는 것 | 행동 6개 이하 · 입력 1~2칸 · 미리보기(프로필·메시지 행동·반응·길게 누르기) · 고르고 곧 닫히는 선택기 | 여러 묶음의 설정 · 긴 목록 · 상세(채널·DM 정보, 설정, 멤버 목록) | 워크스페이스·채널·DM 처럼 어디서든 오가는 탐색 목록 |
| 맥락 | 뒤의 화면이 스크림 아래에 그대로 남는다 | 화면 스택에 쌓인다. 닫으면 온 곳으로 돌아간다 | 뒤의 화면 위에 밀려 나왔다가 접힌다. 내용을 고치지 않는다 |
| 닫는 법 | 오른쪽 위 **원형 X** · 스크림 탭 · 끌어내리기 · VoiceOver 두 손가락 문지르기 | 머리 **왼쪽** 원형 X(또는 뒤로가기·가장자리 스와이프) | 바깥 탭 · 가장자리로 밀기 |
| 머리 | `SheetHeader`: [✓] 제목 [X] (✓ 는 편집 시트에만) | `PageHeader`: [X] 제목 | 없다(목록이 머리) |
| 부품 | `PageSheet` + `SheetHeader` + 안쪽 부품 | `PageHeader` + 안쪽 부품(큰 타일 줄 → 묶음 카드 → 위험 행) | 폰에는 **지금 없다**(아래) |

**드로어는 폰에 지금 없다.** 그 자리를 홈 탭(`SidebarScreen`, 채널·DM 목록)이 전체 화면으로 맡고 있다. 드로어를 두려면 둘을 먼저 풀어야 한다. 하나, 왼쪽 가장자리 24pt 는 이미 **뒤로가기 스와이프**(`nav/edgeSwipe.ts` `EDGE_WIDTH_PX`)가 쓴다 — 같은 가장자리에서 시작하는 두 제스처는 손가락을 두고 다툰다. 둘, 홈 탭과 드로어가 같은 목록을 두 곳에서 말하게 되므로 어느 쪽이 정본인지 정해야 한다. 둘 다 제품 방향이라 이 문서가 정하지 않는다(ADR 사항). 표의 드로어 열은 **생겼을 때 어디에 쓰는가**를 미리 적어 둔 것이다.

### 시트에서 페이지로 — 넘어가는 규칙

1. **시트가 자라서 페이지가 된다**: 행동이 7개 이상, 입력이 3칸 이상, 목록이 한 화면을 넘어 스크롤해야 하거나, 안에서 **더 들어가는 행**(셰브론)이 생기면 시트가 아니라 페이지다. 시트에 스크롤이 필요한 것은 큰 글씨의 안전망이지 설계가 아니다.
2. **넘어갈 때 시트를 먼저 내린다**: 시트의 「더 들어간다」 행은 시트를 닫고(슬라이드가 끝난 뒤) 페이지를 연다. Modal 위에 화면을 쌓지 않는다. 페이지의 X 는 시트가 아니라 **온 화면**으로 돌려보낸다.
3. **페이지에서 시트로**는 자유다: 페이지 안의 한 항목을 고치는 일(상태 설정·이름 고치기)은 시트가 맡는다. 편집 시트는 왼쪽 ✓ 를 갖고, 입력 전에는 회색이다.
4. **예외 — 선택기**: 새 DM 처럼 「사람을 고르면 끝나는」 일은 목록이 길어도 시트다(`large` 단). 고르면 곧 닫히고 되돌아올 위치가 필요 없기 때문이다.

## 2. 그릇 — `PageSheet`

- **높이 세 단** (`height`): `fit`(기본 아님, 내용 높이 · 화면의 85% 위로는 안에서 스크롤) · `medium`(화면의 9/16 고정, Buzz 값) · `large`(기본, 위 58 에서 바닥까지 — 지금까지의 모양).
- **닫는 길 셋은 언제나 있다**: 머리의 원형 X · 스크림 탭 · 끌어내리기(손잡이 띠). VoiceOver 는 두 손가락 문지르기(`onAccessibilityEscape`). 하나만 있는 시트를 만들지 않는다.
- **끌어 닫기 문턱**: 120pt 를 **넘기거나** 속도 1.1pt/ms 를 **넘기면** 닫고, 모자라면 제자리로 돌아온다(`sheetModel.shouldDismissSheet`).
- **동작 줄이기**: 켜져 있으면 미끄러지지 않고 바로 서고 바로 사라진다(사다리 D9). 앱 뿌리가 저장소를 붙들고 있어야 시트가 서기 전에 답을 안다(`useRetainReduceMotion`).
- **안전 영역·키보드**: 몸은 `SheetScroll` — 홈 인디케이터 아래까지 여백, 입력에서 탭이 키보드를 접지 않음. **입력이 있는 `fit`·`medium` 시트의 키보드 올림은 아직 없다**(미결, 아래). 입력 시트는 지금 `large` 다.
- 스크림 이름·testID 는 prop(`scrimLabel`·`scrimTestID`)이라 옛 시트의 「대화 액션 닫기」·`channel-sheet-backdrop` 을 그대로 이어받는다.

## 3. 머리 — 원형 X

모든 닫기는 **글자 없는 원형 X** 다(옛 글자 「닫기」·「닫기」 줄은 없다). 보조기술 이름 `closeLabel` 은 **필수**이고 「… 닫기」 문장이다 — 기본값 「닫기」 는 어느 시트를 닫는지 말하지 못한다.

- 눈에 보이는 원 **40**, 눌림 영역 **44**(`slopTo` 가 채운다), 글리프 **22**, 머리 줄 높이 `TOUCH_TARGET + space.sm`. 값은 `tokens.ts` `SHEET` 한 곳이다.
- **떠 보이는 근거는 토큰이다**(`sheetModel.circleLook`): 라이트는 `surface` 채움이 `sheet` 바탕 위에 서고 `elevationRest` 그림자가 띄운다. 다크는 그림자가 어두운 바닥 위에서 보이지 않고, 게다가 다크의 `surface` 는 `sheet` 와 새벽하늘 1.076 · 흑연 1.035 로 라이트의 1.109 · 1.083 보다 덜 갈린다. 그래서 다크는 한 단 위 `surfaceMuted`(1.234 · 1.119)와 가장자리 한 줄(`glassLine`)로 선다. **시험이 모든 테마에서 「다크의 원이 라이트의 원보다 바탕에서 덜 구분되지 않는다」를 잰다**(`sheetKit.test.tsx`).
- ✓ 는 `confirm={{label, onPress, disabled}}`. 입력 전·바뀐 것이 없으면 `disabled`(회색 `textFaint`, `accessibilityState.disabled`).

```tsx
<PageSheet height="fit" onClose={onClose} accessibilityLabel="메시지 액션"
  scrimLabel="메시지 액션 닫기" scrimTestID="sheet-backdrop" testID="message-action-sheet">
  <SheetHeader title="메시지 액션" closeLabel="메시지 액션 닫기" closeTestID="sheet-close" />
  <SheetScroll testID="sheet-scroll">
    <GroupCard label="빠른 반응">…</GroupCard>
    <GroupCard>
      <ListRow title="답글 달기" onPress={…} />
      <ListRow title="복사하기" onPress={…} />
    </GroupCard>
    <GroupCard><ListRow title="지우기" tone="danger" onPress={…} /></GroupCard>
  </SheetScroll>
</PageSheet>

// 페이지: 그릇이 없으니 onClose 가 필수다.
<PageHeader title="설정" closeLabel="설정 닫기" onClose={goBack} />
```

## 4. 안쪽 부품 — 모두 `design/sheetParts.tsx`

바탕(시트 `sheet`, 페이지 `bg`) 위에 카드·입력·원이 **`surface`** 로 선다(Buzz `utilitySurfaceThemeData` 가 두 면을 맞바꾸는 것과 같은 구조). 색은 `Palette` 역할만 읽는다.

| 부품 | 무엇 | 메모 |
|---|---|---|
| `GroupLabel` | 섹션 라벨 — 카드 위 회색 작은 글씨 | `textMuted`(AA). `textFaint` 는 글자로는 4.5 를 못 지난다 |
| `GroupCard` | 둥근 묶음 카드(`ds2Radius.card`) | 자식 사이에 들여 쓴 구분선(n−1개). `inset="icon"` 이면 아이콘 칸을 비켜 글자 열에서, 숫자면 그 폭의 앞 요소(아바타)를 비켜서 시작. 다크는 `border` 한 줄이 가장자리를 가른다 |
| `GroupCardItem` | 가상화 목록(`FlatList`)의 한 줄을 같은 카드로 | 첫 줄 위·끝 줄 아래 모서리, 줄 사이 같은 구분선 |
| `ListRow` | 행: 앞 아이콘·이모지(`RowIcon`·`RowEmoji`) · 이름 · 보조 줄(`detail`) · 오른쪽 값(`value`) · `accessory` = `chevron`(더 들어간다)·`expand`(여기서 고른다)·`copy`·`toggle` | `tone="danger"` 는 파괴 행. 토글 행은 행 전체가 `switch` 하나, 안쪽 `Switch` 는 보조기술에서 숨는다. 스위치 색은 레포 관용구(`border`/`ok`) |
| `InputPill` | 입력 알약: 앞 아이콘 + 한 줄 입력 | 외곽선은 `textFaint`(3:1) — ADR-0189 D6 이 입력 그릇에만 남긴 선. Buzz 의 가는 선이 아니라 우리 규칙을 따른다 |
| `ActionTile`·`ActionTileRow` | 큰 행동 타일(위 아이콘·아래 이름), 같은 폭으로 나란히 | 프로필 시트의 「메시지·복사」, 정보 페이지의 「즐겨찾기·알림 끄기」 자리 |
| `SheetScroll` | 시트 몸의 스크롤 | 바닥 여백 = max(안전 영역, 16) + 16 |

낡은 `atoms.tsx` 의 `GroupSection`·`GroupRow`(반경 8·테두리 카드)는 프로필 시트가 아직 쓴다. 새 화면은 위 가족만 쓴다.

## 5. 기존 폰 시트·페이지 분류표

코드 사실(2026-10-25, `origin/track/uxui`)과 규칙상의 자리를 나란히 둔다. **판정 보류**는 안쪽 입력·목록 수를 #4458 이 옮기며 세어 확정한다 — 여기서 추측하지 않는다.

| 표면 | 코드 | 지금의 그릇 | 내용(근거) | 규칙상 | 상태 |
|---|---|---|---|---|---|
| 메시지 행동 | `MessageActionSheet` | `PageSheet` fit | 반응 + 행동 6 이하, 파괴 행은 따로 선 카드 | 시트 | **이 PR에서 이전** |
| 대화 행 행동 | `ChannelActionSheet` | `PageSheet` fit | 코어 표가 준 짧은 행동 묶음 + 나가기 확인 | 시트 | **이 PR에서 이전** |
| 새 DM | `NewMessageSheet` | `PageSheet` large | 입력 1칸 + 사람 고르기 | 시트(선택기 예외) | **이 PR에서 이전** |
| 지시 기기 | `DeviceKeyLinkSheet` | `PageSheet` large | QR 연결 직후 한 번 뜨는 상태 안내와 확인 | 시트 | **이 PR에서 이전** |
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

- **재는 것** (`__tests__/sheetKit.test.tsx`): 끌어 닫기 문턱(거리·속도·경계) · 높이 세 단의 상자 · X 의 이름·누름·동작 줄이기(켬: 즉시 / 끔: 화면 높이만큼 미끄러진 뒤) · 스크림 · escape · 응답자 이벤트로 재생한 끌기 · ✓ 의 비활성 · 모든 테마에서 X 가 떠 보이는 관계 · 카드 구분선 수와 들여쓰기 · 행의 값·토글·위험·비활성 · 입력 알약의 외곽선. 새 파일의 격자 밖 간격·반경·글자 크기는 `designSystem.test.ts` 스윕이 0 으로 둔다.
- **재지 않는 것**: 실기기의 끌기 감촉 · 실제 VoiceOver 낭독 · 키보드가 올라온 `fit`·`medium` 시트 · 캡처(16 Pro·SE, 라이트·다크)와 design-review 는 PR 2단계의 몫이다.
- **미결**: ① 입력이 있는 `fit`·`medium` 시트의 키보드 올림(지금 입력 시트는 전부 `large`). ② 행 앞 아이콘 세트(메시지 행동의 답글·인용·복사·고정·고치기·지우기에 아이콘을 줄지). ③ 드로어를 폰에 둘지(위 §1, 제품 결정).
