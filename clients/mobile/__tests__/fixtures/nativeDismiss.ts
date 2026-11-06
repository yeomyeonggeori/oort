import {act, screen, waitFor} from '@testing-library/react-native';

// =============================================================================
// iOS 가 하는 일을 시험 안에서 대신한다 (#5417).
//
// 시트가 미끄러져 내려간 뒤 그릇(`PageSheet`)은 Modal 을 **마운트된 채** 내린다(`visible=false`). 그러면 iOS 가 「다 내렸다」는 신호(`Modal` 의
// `onDismiss`)를 보내고, 다른 Modal 을 띄우는 행동(「고치기」 -> 편집 시트, `usePageSheetHandoff`)은 그 신호 뒤에야 불린다. Jest 의 `Modal` 모형은 신호를
// 스스로 보내지 않고, `visible=false` 면 **통째로 사라진다**(`@react-native/jest-preset` 의 `mocks/Modal.js`) - 그래서 시험은 Modal 이 내려가기 **전에** iOS 가 부를
// 핸들러(`onDismiss`)를 잡아 두었다가, Modal 이 사라진 것(= 그릇이 내렸다)을 확인한 뒤에 그 핸들러를 부른다. 내려가기 전에 부르면 신호가 아니라 거짓 알림이다.
// =============================================================================

/** iOS 가 Modal 이 다 내려갔을 때 부를 핸들러를 잡는다. Modal 이 아직 서 있을 때(`visible`) 불러야 한다. */
export function captureNativeDismiss(modalTestID: string): () => void {
  const handler = screen.getByTestId(modalTestID, {includeHiddenElements: true}).props.onDismiss as () => void;
  return () => {
    act(() => {
      handler();
    });
  };
}

/** Jest 의 Modal 은 `visible=false` 면 트리에서 사라진다 - 그릇이 Modal 을 내렸는가. */
export const isModalDown = (modalTestID: string): boolean =>
  screen.queryByTestId(modalTestID, {includeHiddenElements: true}) === null;

/** `modalTestID` Modal 을 내리는 슬라이드가 끝나 그릇이 Modal 을 내릴 때까지 기다렸다가 iOS 의 「다 내렸다」 신호를 보낸다. */
export async function finishNativeDismiss(modalTestID: string): Promise<void> {
  const signal = captureNativeDismiss(modalTestID);
  await waitFor(() => expect(isModalDown(modalTestID)).toBe(true), {timeout: 8000});
  signal();
}
