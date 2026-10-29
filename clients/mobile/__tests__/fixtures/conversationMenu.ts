import {fireEvent, screen, waitFor} from '@testing-library/react-native';

// =============================================================================
// 대화 머리 ⋮ 가 여는 시트를 **손가락이 가는 길 그대로** 지나는 시험 이음매 (#4319).
//
// ⋮ 는 옛날에 시스템 액션 시트(`ActionSheetIOS`)였고, 시험들은 그 호출을 붙잡아 「고정한 메시지」 항목을 고른 것으로 답했다(고정 목록의 문이
// 거기 있었다). 이제는 앱의 공용 행동 시트다 — 그 호출은 없다. 고정 목록 · 대화 점프 · 머리 구조를 재는 시험들이 같은 길을 한 곳에서 지난다:
// ⋮ 를 누르고 → 시트가 서고 → 「고정한 메시지」 행을 누르면 → **시트가 미끄러져 내린 뒤** 고정 목록이 선다(`closesSheet`).
//
// 슬라이드는 건너뛰지 않는다: 호출한 시험의 시계(실제 시계든 `installAppClock` 의 가짜 시계든)가 `waitFor` 의 폴링으로 `Animated` 를 흘려
// 보내므로, 이 이음매는 동작 줄이기 상태를 건드리지 않는다. 슬라이드 자체는 `describeCloseContract`·`sheetKeyboardAction.test.tsx` 가 잰다.
// =============================================================================

/** ⋮ 를 눌러 대화 메뉴 시트가 서기를 기다린다. */
export async function openConversationMenu(): Promise<void> {
  fireEvent.press(screen.getByTestId('conversation-menu'));
  await screen.findByTestId('conversation-menu-sheet', {}, {timeout: 8000});
}

/**
 * 고정 목록을 연다: ⋮ → 「고정한 메시지」 행. 행은 시트를 먼저 내리고 그 뒤에 고정 목록을 한 번 연다 —
 * 그 목록(`pin-list-pane`)이 설 때까지 기다린다.
 */
export async function openPinList(): Promise<void> {
  await openConversationMenu();
  fireEvent.press(screen.getByTestId('conversation-menu-pins'));
  await waitFor(() => expect(screen.getByTestId('pin-list-pane')).toBeTruthy(), {timeout: 8000});
}
