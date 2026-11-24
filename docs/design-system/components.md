# 부품 장부 — 어느 일에 어느 공용 부품을 쓰는가

> 2026-11-20 기준. 정본 규칙은 [README](README.md)(오르트 구름)이고, 폰 시트 가족의 규격은 [phone-sheets.md](phone-sheets.md)다. 이 문서는 새 규칙이나 값을 정하지 않는다. **어느 부품이 있고, 그 규격이 어느 문서 어느 절에 있는지(또는 없는지)** 를 한 장에서 보게 할 뿐이다. 부품의 규격을 새로 쓰는 일은 부품마다 따로 칸에서 한다.

## 규격 없음의 수

13가지 일 × 웹 · 폰 = 26칸을 센 값이다.

| 판정 | 칸 수 | 뜻 |
|---|---|---|
| **없음** | **3** | 그 일의 규격 절이 문서 어디에도 없다 — 웹 「고르개」 · 폰 「단추」 · 폰 「칩 · 배지」 |
| 부분 | 14 | 절은 있으나 치수 · 상태 표 없이 일부만 다룬다(규칙 한 문단, 한 화면의 사례, 표면 단위 규칙 등) |
| 있음 | 7 | 부품의 구성 · 치수 · 상태가 한 절에 있다 |
| 해당 없음 | 2 | 그 표면에는 그 부품이 필요 없다 |

규격 절이 생기거나 사라지면 이 표와 아래 표의 해당 칸을 같은 PR에서 고친다.

## 일 → 부품 → 규격 → 견본 → 시험

「웹」은 `clients/web/src`(데스크탑은 같은 번들), 「폰」은 `clients/mobile/src/design/`다. 견본 자리는 상태(rest · hover · focus · disabled 등)를 한 화면에서 볼 수 있는 곳이다.

| 일 | 웹 부품 | 폰 부품 | 규격(웹) | 규격(폰) | 상태 견본 | 지키는 시험 |
|---|---|---|---|---|---|---|
| 단추 | `Button` (`ui/button.tsx`) — 종류 4(+ 옛 이름 `outline`) · 크기 4 · 상태 6 | `PrimaryButton` · `OutlineButton` (`atoms.tsx`). 화면이 따로 만든 단추 10종은 공용이 아니다 | 있음 — 이 문서 「단추」 절(종류 · 크기 · 상태 · 언제 무엇) | 없음 | 웹 `Gallery.tsx`의 종류 × 상태 24칸 · 크기 줄 · 원형 아이콘 단추 / 폰 견본 자리 없음 | 웹 `buttonSpec.test.tsx` · `designSystem.test.ts` · `controlBorders.test.ts` · `pressLedger.test.ts` · `focusRing.test.ts` / 폰 `primaryButton.test.tsx` · `designSystem.test.ts`(스윕) |
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
| 머리 | 부품 없음 — 대화 머리(`channel-head` 유틸) · 창 띠(`AppTitlebar`). 대화 상자 머리 · 바닥 부품도 없음 | `SheetHeader` · `PageHeader` · `ScreenHeader` · `CloseCircle` · `BackCircle` · `ConfirmCheck` (`SheetChrome.tsx` · `atoms.tsx`) | 부분 — README §2.9(창 띠 · 대화 머리만) | 있음 — phone-sheets §3 | 웹 견본 자리 없음 / 폰 `measure/sheetKit.tsx`의 `headers` 장면 | 웹 `desktopShell.band.browser.test.ts`(`src/app/`) / 폰 `sheetKit.test.tsx` |

## 카드

에이전트 카드 · 제안 카드의 장부는 따로 칸에서 채운다.

## 단추 — 웹 규격 (DS-05, [#6074](https://github.com/yeomyeonggeori/oort/issues/6074))

부품은 `clients/web/src/design/ui/button.tsx`의 `Button` 하나다(데스크탑은 같은 번들). 2026-11-20 시안 장면 4의 추천안을 따른다. 아래 값은 **지금 모양을 그대로 적은 것**이고, 새로 정한 것은 「진행 중」 상태 하나다. 값은 Chromium(배율 2)에서 잰 계산 값이다. 종류 · 크기 표의 코드 이름은 `buttonSpec.test.tsx`가 `button.tsx`의 변형 표와 맞춰 본다. 이름이 한쪽에만 있으면 그 시험이 빨개진다.

### 종류

모든 종류가 알약 모서리에 글자 14 굵게(700)를 쓴다. 테두리 없이 **채움**으로 위계를 말한다(README §2.2 · §3).

| 종류 | 코드 이름 | 채움 · 글자 | 쓰는 자리 |
|---|---|---|---|
| 주 | `default` | 잉크 채움 `--primary` · `--on-primary` | 그 묶음의 1급 행동 하나 |
| 보조 | `secondary` | `--surface-muted` · `--ink` | 주 옆의 취소, 줄 안 행동 |
| 조용한 | `ghost` | 채움 없음 · `--ink` | 툴바, 「더 보기」 같은 가벼운 행동 |
| 위험 | `destructive` | `--danger-fill` · `--on-danger-fill` | 파괴를 확정하는 단추(지우기 · 나가기) |
| (옛 이름) | `outline` | `secondary`와 같다 | **새 코드에 쓰지 않는다. `secondary`를 쓴다.** 남은 쓰임을 걷는 일은 DS-13 |

### 크기

| 크기 | 코드 이름 | 높이 | 가로 여백 | 글자 |
|---|---|---|---|---|
| 작게 | `sm` | 28 (`h-control-sm`) | 12 | 12 굵게 (`text-meta`) |
| 기본 | `default` | 38 (`h-pill`) | 15 (`px-pill-inline`) | 14 굵게 (`text-label`) |
| 크게 | `lg` | 40 (`h-control-lg`) | 24 | 14 굵게 |
| 원형 | `icon` | 34 × 34 (`size-icon-button`) | 0 | 글리프 16 |

`default` · `lg`는 폭 600 미만에서 `tap-target`으로 44까지 자란다(README §2.7). `sm` · `icon`은 자라지 않는다. 손가락 자리가 필요하면 그 자리에서 `tap-target`을 단다. 글리프 · 돌림 표시는 모든 크기에서 16이고, 글자와의 사이는 8이다.

### 상태

| 상태 | 모양 | 부품에서 |
|---|---|---|
| 쉼 | 위 두 표 그대로 | — |
| 올림 | 주 · 위험은 흐림 90%(`hover:opacity-90`), 보조 · 조용한은 `--surface-hover` 채움. 포인터가 올라가는 기기에서만 | 변형의 `hover:*` |
| 눌림 | 98%로 줄어든다(`press`, `--motion-instant` 0.12s) | 바탕 줄의 `press` |
| 초점 | 키보드 초점에서만(`:focus-visible`) 2px 인셋 링. 링 색은 채움의 전경색이다(주 `focus-ring-on-primary`, 위험 `focus-ring-on-fill`, 보조 · 조용한은 신호색) | `focus-visible:focus-ring` |
| 잠김 | 흐림 50%, 포인터가 닿지 않고 초점에서 빠진다 | `disabled` |
| 진행 중 | 글자 앞에 돌림 표시(`Loader2` 16, `spinner-busy` — 동작 줄이기에서는 8단으로 끊어 돈다) + 부르는 쪽이 넘긴 낱말(「저장 중」). **흐려지지 않고**, 올림 · 눌림 시각이 서지 않으며, 누름이 전달되지 않는다(마우스 · Enter · Space · 폼의 암묵 제출 모두 0회, 위로도 퍼지지 않는다). `aria-busy="true"` · `aria-disabled="true"`가 서고, `disabled`가 아니라서 초점은 그 자리에 남는다 | `busy` (새로) |

**진행 중의 폭과 높이.** 높이는 바뀌지 않는다(잰 값: 기본 38 → 38, 작게 28 → 28, 크게 40 → 40, 원형 34 → 34). 폭은 내용을 따른다. 같은 낱말이면 쉼 폭에 24(돌림 표시 16 + 사이 8)가 더해지고, 낱말이 바뀌면 그 길이 차이도 더해진다(잰 값: 기본 크기 「저장」 54.2 → 「저장 중」 93.8). 원형은 글리프 자리를 돌림 표시가 대신해서 34 그대로다. 옆 단추가 밀리면 안 되는 자리라면 부르는 쪽이 `min-w-*`를 준다.

**낱말은 부르는 쪽 몫이다.** 부품은 글을 박지 않는다. `<Button busy={saving}>{saving ? t("common.state.saving") : t("common.action.save")}</Button>`처럼 쉼 · 진행 중 낱말을 사전 키로 넘긴다. 진행 낱말은 「명사 + 중」으로 쓴다. `busy`와 `disabled`를 같이 주면 잠김으로 보인다(흐림 50%). 진행 중을 보이려면 `disabled`를 빼고 `busy`만 준다. 화면마다 손으로 `Loader2` + `aria-busy`를 단 자리를 이 상태로 옮기는 일은 그 화면을 고치는 칸에서 한다.

### 언제 무엇

| 자리 | 종류 · 크기 |
|---|---|
| 폼 · 대화 상자의 1급 단추(로그인, 확인 창의 확정) | 주 · 기본. 옆의 취소는 보조 · 기본 |
| 줄 안 보조 단추(목록 줄의 「참여」 등) | 보조 · 작게 |
| 툴바 | 조용한 · 작게. 글자 없는 아이콘만이면 원형 `icon` + 조용한 |
| 파괴 확인(지우기 · 나가기를 확정) | 위험 · 기본. 옆의 취소는 보조 · 기본 |

### 단추로 그리지 않는 것

| 일 | 갈 부품 |
|---|---|
| 글자 링크(문장 안에서 다른 곳으로 가기) | 단추가 아니라 `<a>` 글자다. 알약을 씌우지 않는다 |
| 줄 전체 단추(줄 전체가 누르는 자리) | `ListRow`(`ui/list-row.tsx`), 사이드바는 `sidebar-row` 유틸 |
| 아이콘 단추(글자 없이 아이콘만) | 지금은 `Button size="icon"` + `aria-label`. 이름 붙은 아이콘 단추 부품은 DS-12 |

### 견본과 시험

- 견본: 웹 `#/design` 갤러리의 「Button 종류 × 상태」(종류 4 × 상태 6 = 24칸)와 「Button size」 줄.
- 시험: `buttonSpec.test.tsx`(문서 표 ↔ 변형 표, 진행 중의 누름 0 · `aria-busy`), `gallery.test.tsx`(24칸), `pressLedger.test.ts` · `motion.test.ts` · `focusRing.test.ts` · `controlBorders.test.ts`(바탕 줄의 눌림 · 초점 · 테두리).

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
| `PrimaryButton` · `OutlineButton` | `design/atoms.tsx` | 단추 |
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

## 폰 상태 값

눌림 · 잠김의 흐림은 화면마다 숫자로 적지 않고 `clients/mobile/src/design/tokens.ts`의 이름으로 쓴다. 이름을 둔 것은 값이 같던 자리를 옮긴 것이고, 다른 흐림 값(눌림 0.85 · 0.8 · 0.86 · 0.7 · 0.5, 잠김 0.6 · 0.5 · 0.4 · 0.7)은 아직 화면마다 따로다 — 한 값으로 맞추면 화면이 바뀌므로 부품 칸에서 한다.

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
