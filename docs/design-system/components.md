# 부품 장부 — 어느 일에 어느 공용 부품을 쓰는가

> 2026-11-20 기준. 정본 규칙은 [README](README.md)(오르트 구름)이고, 폰 시트 가족의 규격은 [phone-sheets.md](phone-sheets.md)다. 이 문서는 새 규칙이나 값을 정하지 않는다. **어느 부품이 있고, 그 규격이 어느 문서 어느 절에 있는지(또는 없는지)** 를 한 장에서 보게 할 뿐이다. 부품의 규격을 새로 쓰는 일은 부품마다 따로 칸에서 한다.

## 규격 없음의 수

14가지 일 × 웹 · 폰 = 28칸을 센 값이다.

| 판정 | 칸 수 | 뜻 |
|---|---|---|
| **없음** | **2** | 그 일의 규격 절이 문서 어디에도 없다 — 웹 「고르개」 · 폰 「칩 · 배지」 |
| 부분 | 14 | 절은 있으나 치수 · 상태 표 없이 일부만 다룬다(규칙 한 문단, 한 화면의 사례, 표면 단위 규칙 등) |
| 있음 | 9 | 부품의 구성 · 치수 · 상태가 한 절에 있다 |
| 해당 없음 | 3 | 그 표면에는 그 부품이 필요 없다 |

규격 절이 생기거나 사라지면 이 표와 아래 표의 해당 칸을 같은 PR에서 고친다.

## 일 → 부품 → 규격 → 견본 → 시험

「웹」은 `clients/web/src`(데스크탑은 같은 번들), 「폰」은 `clients/mobile/src/design/`다. 견본 자리는 상태(rest · hover · focus · disabled 등)를 한 화면에서 볼 수 있는 곳이다.

| 일 | 웹 부품 | 폰 부품 | 규격(웹) | 규격(폰) | 상태 견본 | 지키는 시험 |
|---|---|---|---|---|---|---|
| 단추 | `Button` (`ui/button.tsx`) — 변형 5 · 크기 4 | `PrimaryButton` · `OutlineButton` · `QuietButton` · `DangerButton` (`atoms.tsx`) — 종류 4 · 크기 2. 화면이 따로 만든 단추 6종은 공용이 아니다(아래 「폰 단추」 절) | 부분 — README §2.2(106행) · §3 위계. 변형·크기·상태 표는 없음 | 있음 — 이 문서 「폰 단추」 절 | 웹 `Gallery.tsx`의 Button 상태 행 · 변형 4 · 원형 아이콘 단추 / 폰 `measure/buttons.tsx`(`BUTTONS` · `LIGHT-BUTTONS`) | 웹 `designSystem.test.ts` · `controlBorders.test.ts` · `pressLedger.test.ts` · `focusRing.test.ts` / 폰 `buttonFamily.test.tsx`(규격 표) · `primaryButton.test.tsx`(주 = 잉크) · `designSystem.test.ts`(스윕) · `designSystemResidue.test.ts`(손 `Pressable` 천장) |
| 입력 | `Input` (`ui/input.tsx`). 여러 줄 입력 · 체크박스 · 라디오는 부품 없음 | `InputPill` (`sheetParts.tsx`). `Field` · `TextArea` · `FieldLabel`은 `shell/sheetForm.tsx`에 임시 | 부분 — README §2.2(106 · 109행) · §2.4(입력 그릇 반경) | 부분 — phone-sheets §4 · §7(임시 표) | 웹 Gallery의 Input · Select 행(rest · focus · disabled) / 폰 `measure/sheetKit.tsx`의 `status` 장면 | 웹 `controlBorders.test.ts` · `fieldTextFloor.browser.test.ts` / 폰 `sheetForm.test.tsx` · `sheetKit.test.tsx`(입력 알약 외곽선) |
| 고르개 | `Select` · `ListboxSelect` · `SegmentedControl` · `Switch` · `Slider` (`ui/`), `FilterTabs` (`features/common`) | 전용 부품 없음. 라디오 행 `ChoiceRow` · 켜짐 줄은 `ListRow`의 `role="switch"` | 없음 — — | 부분 — phone-sheets §4(`ChoiceRow` · 행의 역할) | 웹 Gallery(Select · ListboxSelect · SegmentedControl · Switch · Slider. `FilterTabs`는 없음) / 폰 `measure/sheetKit.tsx` | 웹 `ListboxSelect.test.tsx` · `segmentedControl.test.tsx` · `switch.test.tsx` · `slider.test.tsx` / 폰 `sheetParts.test.tsx` |
| 대화 상자 · 시트 | `Dialog` (`ui/dialog.tsx`) · `ConfirmDialog` · `ConfirmStage` (`ui/confirm-dialog.tsx`) | `PageSheet` · `SheetScroll` · `ConfirmStep` (`PageSheet.tsx` · `sheetParts.tsx`) | 부분 — README §2.14 ⑤(확인 창) · §3.4(겹침 층). `Dialog` 크기·여백 규격은 없음 | 있음 — phone-sheets §1 ~ §3 · §6 | 웹 Gallery의 「떠 있는 표면」 · 확인 창 견본 / 폰 `measure/sheetKit.tsx` | 웹 `dialog.test.ts` · `dialogEntryDismiss.test.tsx` · `ConfirmDialog.test.tsx` · `escapeLayer.test.ts` · `overlayLayers.test.ts` / 폰 `sheetKit.test.tsx` · `sheetDrag.test.tsx` · `sheetInventory.test.ts` |
| 메뉴 | `DropdownMenu` · `ContextMenu` (하위 메뉴 포함) | 해당 없음 — 메뉴는 `PageSheet` 안 `ListRow`로 선다 | 있음 — README §6 「행 액션 표면」 · 「메뉴」 | 해당 없음 — phone-sheets §1(시트로 대신) | 웹 Gallery의 `ContextMenuSpecimen` · 떠 있는 표면 / 폰 `measure/sheetKit.tsx` | 웹 `submenu.test.tsx` · `context-menu.gesture.test.ts` / 폰 `conversationMenuSheet.test.tsx` |
| 툴팁 · 팝오버 | `Tooltip` · `Popover` (`ui/`) | 해당 없음 — 손가락에는 올려 두기가 없다 | 부분 — README §2.9(대화 머리 단추의 툴팁만) · §3.4(층). 일반 규격 없음 | 해당 없음 | 웹 Gallery(Tooltip 5곳 · PopoverContent 1곳) | 웹 `tooltip.test.ts` · `tooltipDelay.test.ts` · `tooltipFit.test.ts` · `popover.test.ts` · `iconButtonTitle.test.ts` |
| 목록 줄 | `ListRow` · `ListGroup` · `ListRowSkeleton` (`ui/list-row.tsx`). 사이드바 줄은 `tokens.css`의 `sidebar-row` 유틸 | `ListRow` · `ChoiceRow` · `RowIcon` · `RowEmoji` · `RowEndImage` · `RowStatusIcon` (`sheetParts.tsx`), `TapRow` (`atoms.tsx`) | 있음 — README §2.14 ① | 있음 — phone-sheets §4(`TapRow`만 절 없음) | 웹 Gallery의 ListGroup · ListRow · ListRowSkeleton / 폰 `measure/sheetKit.tsx` | 웹 `gallery.test.tsx` · `controlBorders.test.ts` · `designSystem.test.ts` / 폰 `sheetParts.test.tsx` |
| 묶음 | `Card` (`ui/card.tsx`) · `ListGroup` | `GroupCard` · `GroupCardItem` · `GroupLabel` · `SectionLabel` · `ActionTile` · `ActionTileRow` · `TileIcon` | 부분 — README §2.14 묶음 머리글 · §2.4(카드 반경 20). `Card` 안쪽 치수 절은 없음 | 있음 — phone-sheets §4 | 웹 Gallery의 Card / 폰 `measure/sheetKit.tsx` | 웹 `controlBorders.test.ts` · `designSystem.test.ts` / 폰 `sheetParts.test.tsx` |
| 칩 · 배지 | `CHIP_CLASS` (`features/common/chip.ts`) — 부품이 아니라 기하 한 줄. 톤은 화면마다 | 공용 부품 없음. `CountBadge`(`atoms.tsx`)는 정의만 있고 쓰는 곳이 없다 | 부분 — README §2.2 칩 그릇. 테두리 · 톤 분류는 §5.3이 「기계 없음」으로 적음 | 없음 | 웹 Gallery의 「칩 그릇」 · ReactionChips / 폰 견본 자리 없음 | 웹 `chipVessel.test.ts` / 폰 `paletteContrast.test.ts`(상태 채움 대비) · `fillTokens.test.ts` |
| 아바타 | `MemberAvatar` (`features/common`) · `AvatarStatus` (`features/presence`). 타임라인의 `Avatar`는 공용 폴더 밖 | `Avatar` — `design/`이 아니라 `features/conversation/Avatar.tsx`에 있다 | 있음 — README §2.14 ④(상태 점 모양: 사람 오프라인 = 회색으로 채운 원, 에이전트 꺼짐 = 속 빈 고리) | 부분 — README §2.14 ④의 폰 크기 표만 | 웹 Gallery에는 목록 줄 안 이니셜만 / 폰 견본 자리 없음 | 웹 `avatarStatus.browser.test.ts` · `avatarStatus.contrast.test.ts` · `avatarSurfaces.test.tsx` · `avatarTone.test.tsx` / 폰 `avatarRender.test.tsx` · `faceStatusDot5786.test.tsx` |
| 빈 · 로딩 · 오류 | `Skeleton` · `InlineBanner` · `EmptyInvite` (`States.tsx`), `LoadFailureBox` · `LoadFailureNote` · `LoadFailureLine`, `ConnectionBanner` | `EmptyState` · `LoadingState` · `ErrorState` · `NoticeBlock` · `FailureBanner` · `Sentence` (`atoms.tsx`) | 부분 — README §4(표면 단위 규칙). 부품 치수 절은 없음 | 부분 — README §4. 부품 치수 절은 없음 | 웹 Gallery의 States 행 / 폰 `measure/states.tsx`(실제 Timeline의 빈 · 오류 · 로딩) | 웹 `Skeleton.test.tsx` · `skel.test.ts` · `LoadFailureBox.test.tsx` · `ConnectionBanner.test.tsx` / 폰 `readFailureStates.test.tsx` |
| 로더 | `OortLoader` (`design/brand/OortLoader.tsx`). 작은 돌림 표시는 부품 없이 `Loader2`를 직접 돌림 | `OortLoader` (`design/brand/OortLoader.tsx`). 작은 돌림 표시는 `ActivityIndicator`를 직접 씀 | 부분 — README §2.6 오르트 로더 문단. 「언제 로더 · 언제 작은 표시」 규칙은 없음 | 부분 — 동 | 웹 · 폰 모두 견본 자리 없음 | 웹 `OortLoader.test.tsx` · `OortLoader.motion.test.tsx` / 폰 `oortLoader.test.tsx` |
| 키캡 | `Keycaps` (`app/ShortcutHelpDialog.tsx`, 상자 `block` · 글줄 `inline`) — 단축키 창 · ⌘K 팔레트 · 작성창 자동완성 · 설정 › 단축키가 같이 쓴다 | 해당 없음 — 폰에는 키보드 단축키가 없다 | 있음 — README §2.16(단축키 창) | 해당 없음 | 웹 견본 자리 없음(단축키 창 자체가 견본) | 웹 `ShortcutHelpDialog.test.tsx` · `ShortcutHelpDialog.rebind.test.tsx` · `scripts/capture-6081.mjs` |
| 머리 | 부품 없음 — 대화 머리(`channel-head` 유틸) · 창 띠(`AppTitlebar`). 대화 상자 머리 · 바닥 부품도 없음 | `SheetHeader` · `PageHeader` · `ScreenHeader` · `CloseCircle` · `BackCircle` · `ConfirmCheck` (`SheetChrome.tsx` · `atoms.tsx`) | 부분 — README §2.9(창 띠 · 대화 머리만) | 있음 — phone-sheets §3 | 웹 견본 자리 없음 / 폰 `measure/sheetKit.tsx`의 `headers` 장면 | 웹 `desktopShell.band.browser.test.ts`(`src/app/`) / 폰 `sheetKit.test.tsx` |

## 카드

에이전트 카드 · 제안 카드의 장부는 따로 칸에서 채운다.

## 웹 공용 부품 21개

`design/ui` 15파일과 `features/common` · `features/presence`의 6파일이다. 위 표의 어느 일에 드는지를 함께 적었다.

| # | 파일 | 일 |
|---|---|---|
| 1 | `design/ui/button.tsx` | 단추 |
| 2 | `design/ui/card.tsx` | 묶음 |
| 3 | `design/ui/confirm-dialog.tsx` | 대화 상자 · 시트 |
| 4 | `design/ui/context-menu.tsx` | 메뉴 |
| 5 | `design/ui/dialog.tsx` | 대화 상자 · 시트 |
| 6 | `design/ui/dropdown-menu.tsx` | 메뉴 |
| 7 | `design/ui/input.tsx` | 입력 |
| 8 | `design/ui/list-row.tsx` | 목록 줄 |
| 9 | `design/ui/listbox-select.tsx` | 고르개 |
| 10 | `design/ui/popover.tsx` | 툴팁 · 팝오버 |
| 11 | `design/ui/segmented-control.tsx` | 고르개 |
| 12 | `design/ui/select.tsx` | 고르개 |
| 13 | `design/ui/slider.tsx` | 고르개 |
| 14 | `design/ui/switch.tsx` | 고르개 |
| 15 | `design/ui/tooltip.tsx` | 툴팁 · 팝오버 |

| # | 파일 | 부품 | 일 |
|---|---|---|---|
| 16 | `features/common/States.tsx` | `Skeleton` · `InlineBanner` · `EmptyInvite` | 빈 · 로딩 · 오류 |
| 17 | `features/common/LoadFailureBox.tsx` | `LoadFailureBox` · `LoadFailureNote` · `LoadFailureLine` | 빈 · 로딩 · 오류 |
| 18 | `features/common/ConnectionBanner.tsx` | `ConnectionBanner` | 빈 · 로딩 · 오류 |
| 19 | `features/common/FilterTabs.tsx` | `FilterTabs` | 고르개 |
| 20 | `features/common/MemberAvatar.tsx` | `MemberAvatar` | 아바타 |
| 21 | `features/presence/AvatarStatus.tsx` | `AvatarStatus` | 아바타 |

이 밖에 `features/common/chip.ts`(`CHIP_CLASS`, 칩 기하 한 줄 — 부품이 아니라 상수)와 `design/brand/OortLoader.tsx`(로더)가 있다. 공용 부품이 **없는** 일은 여러 줄 입력 · 체크박스 · 라디오 · 이름 붙은 아이콘 단추 · 칩/배지 부품 · 탭 · 작은 돌림 표시 · 대화 상자 머리/바닥 · 섹션 머리다.

## 폰 `design/` 부품 전수

| 부품 | 파일 | 일 |
|---|---|---|
| `PageSheet` | `design/PageSheet.tsx` | 대화 상자 · 시트 |
| `SheetScroll` | `design/sheetParts.tsx` | 대화 상자 · 시트 |
| `ConfirmStep` | `design/sheetParts.tsx` | 대화 상자 · 시트 |
| `SheetHeader` · `PageHeader` · `CloseCircle` · `BackCircle` · `ConfirmCheck` | `design/SheetChrome.tsx` | 머리 |
| `ScreenHeader` | `design/atoms.tsx` | 머리 |
| `ListRow` · `ChoiceRow` · `RowIcon` · `RowEmoji` · `RowEndImage` · `RowStatusIcon` | `design/sheetParts.tsx` | 목록 줄 |
| `TapRow` | `design/atoms.tsx` | 목록 줄 |
| `GroupCard` · `GroupCardItem` · `GroupLabel` · `ActionTile` · `ActionTileRow` · `TileIcon` | `design/sheetParts.tsx` | 묶음 |
| `SectionLabel` | `design/atoms.tsx` | 묶음 |
| `InputPill` | `design/sheetParts.tsx` | 입력 |
| `PrimaryButton` · `OutlineButton` · `QuietButton` · `DangerButton` | `design/atoms.tsx` | 단추 |
| `CountBadge` | `design/atoms.tsx` | 칩 · 배지 (쓰는 곳 없음) |
| `EmptyState` · `LoadingState` · `ErrorState` · `NoticeBlock` · `FailureBanner` · `Sentence` | `design/atoms.tsx` | 빈 · 로딩 · 오류 |
| `OortLoader` | `design/brand/OortLoader.tsx` | 로더 |
| `Screen` | `design/atoms.tsx` | 아래 「하는 일 표에 들지 않는 것」 |
| `GlassSurface` | `design/glass.tsx` | 아래 「하는 일 표에 들지 않는 것」 |
| `usePullRefresh` · `withPullScroll` (+ `PULL_*` 치수) | `design/refresh.tsx · pullRefresh.ts` | 아래 「하는 일 표에 들지 않는 것」 |
| `ThemeControl` · `ThemePickerPage` · `ThemePickerModal` · `ThemePreview` | `design/ThemeControl.tsx · ThemePickerPage.tsx` | 아래 「하는 일 표에 들지 않는 것」 |
| `AppBackground` | `design/background/AppBackground.tsx` | 아래 「하는 일 표에 들지 않는 것」 |
| `GroupSection` · `GroupRow` | `design/atoms.tsx` | 옛 부품 — 쓰는 곳 없음(`ThemeControl`은 제 안에 같은 이름을 따로 정의) |

**하는 일 표에 들지 않는 것.** `Screen`(화면 틀) · `GlassSurface`(유리 재료) · 당겨서 새로고침 · 테마 고르기(`ThemeControl` · `ThemePickerPage`) · `AppBackground`(배경)는 위 13가지 일 어디에도 속하지 않는 폰 고유 부품이다. 이 부품들을 묶은 부품 규격 절은 없다(규격이 있다면 코드 주석이나 해당 기능 문서에 흩어져 있다).

`design/` 밖에 임시로 둔 공용(`shell/sheetForm.tsx`의 `Field` · `TextArea` · `FieldLabel` · `SheetNotice`)은 phone-sheets §7 표가 정식 자리를 적는다. 폰 `Avatar`는 `features/conversation/Avatar.tsx`에 있고 `design/`이 아니다.

## 폰 단추

> #6075 (2026-11-25). 모양은 2026-11-20 시안 장면 4의 추천안(알약)이다. 부품은 `clients/mobile/src/design/atoms.tsx`, 치수 이름은 `clients/mobile/src/design/tokens.ts`의 `BUTTON`, 견본은 `clients/mobile/measure/buttons.tsx`, 규격 표의 주인 시험은 `clients/mobile/__tests__/buttonFamily.test.tsx`다.

웹과 같은 네 종류 · 같은 낱말 · 같은 채움 규칙이다(부품은 두 표면이 공유하지 않는다 — ADR-0159). 네 종류는 몸이 하나라 props도 하나다: `label` · `onPress` · `busy` · `busyLabel` · `disabled` · `size` · `icon` · `accessory` · `flush` · `accessibilityLabel` · `accessibilityHint` · `testID`. 앞의 둘(`PrimaryButton` · `OutlineButton`)은 이름과 호출 모양을 그대로 두었다.

| 종류 | 부품 | 채움 | 글자색 | 언제 |
|---|---|---|---|---|
| 주 | `PrimaryButton` | 잉크 `primary` | `onPrimary` | 화면의 주 행동 하나. 신호색(`accent`) · 커스텀 강조색은 칠하지 않는다(ADR-0189 D3) |
| 보조 | `OutlineButton` | 시트 위 알약 문법 `circleLook` — 라이트 `surface` + 쉼 그림자, 다크 `surfaceMuted` + 가장자리 한 줄 | `text` | 주 행동 곁의 다른 길(「취소」 · 「다시 불러오기」 · 「거부」) |
| 조용한 | `QuietButton` | 없음 | `text` | 막대 끝의 「뒤로」 · 「취소」 · 언어 칩. 막대 끝에서는 `flush` |
| 위험 | `DangerButton` | `dangerFill` | `onDangerFill` | 되돌리기 어려운 행동의 확인(「멈추기」 · 「거부 보내기」) |

| 치수 | 기본 | 작게 | 이름 |
|---|---|---|---|
| 높이 | 44 | 38 — 누르는 자리는 위아래 슬롭(`slopTo(38)` = 3)으로 44 | `BUTTON.height` · `BUTTON.smallHeight` |
| 옆 여백 | 20(시안 제안 값 — 이 절에서 확정) | 16 | `BUTTON.padX` · `BUTTON.smallPadX` |
| 모서리 | 알약 | 알약 | `radius.pill` |
| 낱말 | `font.body` 16 · 600 · 줄 `line.body` | `font.label` 13 · 600 · 줄 `line.label` | 시안의 작게 14는 역할 표에 없어 가장 가까운 역할(13)로 둔다 |
| 표시기 · 아이콘과 낱말 사이 | 8 | 8 | `BUTTON.gap` |
| 두 줄로 접힐 때 위아래 | 8 | 8 | `BUTTON.padY` — 한 줄이면 높이는 `minHeight`가 정한다 |
| 큰 글자 상한 | `BUTTON_MAX_SCALE` = 바 컨트롤과 같은 1.6 | 같음 | 단추는 크롬이다(`atoms.tsx` 머리의 상한 정책). 곁의 설명 문장은 상한이 없다 |

| 상태 | 모양 | 값 |
|---|---|---|
| 쉼 | 제 채움 + 제 글자색 | — |
| 눌림 | 채움을 갈아 끼우지 않고 흐림만 | `PRESSED_OPACITY` 0.6 |
| 잠김 | 같은 채움을 흐리게(`disabled`이고 진행 중이 아닐 때). 눌러도 모양이 안 변한다 | `DISABLED_OPACITY` 0.55 |
| 진행 중 | 채움 그대로 + 표시기 + 낱말(`busyLabel`, 맨몸 「저장 중」 — 표시기가 돌므로 말줄임을 붙이지 않는다). 흐리지 않는다. `disabled`를 같이 줘도 진행이 이긴다 | — |

- **막대 끝(`flush`)**: 조용한 단추가 막대의 여백 선에 낱말을 맞춘다 — 옆 여백을 걷고 `justifyContent`를 그쪽 끝으로, 상자는 `TOUCH_TARGET` 아래로 좁아지지 않는다. 채움이 없어 걷은 여백은 보이지 않는다.
- **잠김의 거래**: 앞 판의 주 단추는 잠기면 옅은 칸 + `textMuted` 글자로 서서 낱말 대비 4.5:1을 지켰다(#5100 · #5170 L1). 이 절은 시안의 「같은 채움을 흐리게」를 따른다. 바탕에 합성한 낱말 대비는 주 · 보조 · 조용한 3.7~3.8, 위험 2.5다(테마 3 × 모드 2, 바닥 · 시트 · 면 위 최저값). 잠긴 컨트롤은 WCAG 1.4.3의 예외다.
- **보조 채움**: 시안은 `surfaceMuted`를 적었지만 폰 라이트 흑연 · 노을에서 그 값은 바닥 · 시트와 1.000:1이라 보조가 조용한 단추처럼 섰다. 그래서 시트 위 알약 문법(`circleLook`, phone-sheets §4)을 쓴다. `buttonFamily.test.tsx`가 바닥 · 시트 위 채움 대비 1.05 이상을 잰다.

**화면이 따로 만든 단추 6종**(공용 아님, 다음 옮기기 칸 DS-14의 몫): `GlassButton` · `PillButton` · `TabButton` · `PlusButton` · `CodeCopyButton` · `ProfileAvatarButton`. 옮긴 것(#6075): `OnboardingButton` · `OnboardingGhostButton`(온보딩) · `SecondaryButton`(AI 연결 · 작업, 두 파일) · `DangerButton`(작업)과 작업 멈추기의 손 단추 셋.

## 폰 상태 값

눌림 · 잠김의 흐림은 화면마다 숫자로 적지 않고(단추 네 종류는 위 절의 값을 부품이 진다) `clients/mobile/src/design/tokens.ts`의 이름으로 쓴다. 이름을 둔 것은 값이 같던 자리를 옮긴 것이고, 다른 흐림 값(눌림 0.85 · 0.8 · 0.86 · 0.7 · 0.5, 잠김 0.6 · 0.5 · 0.4 · 0.7)은 아직 화면마다 따로다 — 한 값으로 맞추면 화면이 바뀌므로 부품 칸에서 한다.

| 상태 | 이름 | 값 | 남은 숫자 | 지키는 시험 |
|---|---|---|---|---|
| 눌림 흐림 · 잠김 흐림 | `PRESSED_OPACITY` · `DISABLED_OPACITY` | 0.6 · 0.55 (`sheetParts`의 `rowDisabled`와 같은 값) | 폴더별 천장 — `designSystemResidue.test.ts`의 `OPACITY_CEILING` | 폰 `designSystemResidue.test.ts`(이름의 값 · `rowDisabled` 묶음 · 흐림 숫자 천장) |

## 다시 세는 법

수는 바뀐다. 아래로 다시 센다(주석을 벗기지 않은 값이라 조사 보고의 값과 몇 퍼센트 다를 수 있다).

```sh
ls clients/web/src/design/ui | rg '\.tsx$' | rg -v 'test|Kit'              # 웹 design/ui 부품 파일 15
cd clients/web/src && rg -o --no-filename -g '*.tsx' -g '!*.test.*' '<Button\b' features app | wc -l    # 공용 단추 쓰임
cd clients/web/src && rg -o --no-filename -g '*.tsx' -g '!*.test.*' '<button\b' features app | wc -l    # 손으로 쓴 단추
cd clients/mobile/src && rg -o --no-filename -g '*.tsx' -g '!*.test.*' -g '!design/**' '<Pressable\b' . | wc -l   # 폰 손으로 쓴 누를 것
```
