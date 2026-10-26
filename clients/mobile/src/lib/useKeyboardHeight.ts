import {useEffect, useState} from 'react';
import {Keyboard, type KeyboardEvent} from 'react-native';

/**
 * 소프트 키보드가 지금 가린 높이(pt) — 내려가 있으면 0 (#4318).
 *
 * 시트(`design/PageSheet`)가 입력을 가리지 않게 제 바닥을 키보드 위로 올리려고 읽는다. 물어보는 것은
 * 「키보드가 어디까지 올라와 있나」라는 도착점이고 이동의 과정이 아니다 — 컴포저(`useKeyboard` 의
 * `offset`, 네이티브 `KeyboardPane`)는 과정을 UI 스레드에서 따라가려고 애니메이션 값을 돌리지만,
 * 시트는 입력이 있는 **모달** 하나라서 한 번 늦게 그려도 결함이 아니다(`MessageEditorSheet` 가 같은
 * 이유로 `useKeyboard().height` 를 쓴다). 그래서 애니메이션 없이 숫자만 든다 — 이벤트마다
 * `Animated.timing` 을 하나씩 돌리는 `useKeyboard` 를 쓰지 않는 이유다.
 *
 * will 과 did 를 둘 다 듣는다(`useKeyboardShown` 과 같다): iOS 는 will 이 먼저 와서 시트가 키보드와
 * **같이** 서고, Android 에는 did 만 있다. 같은 값이면 React 가 렌더를 건너뛴다. 하드웨어 키보드가
 * 붙은 기기가 높이 0 을 보고하면 「없다」로 읽는다(올릴 것이 없다).
 *
 * 처음 값은 `Keyboard.metrics()` 다 — 키보드가 이미 올라와 있는 동안 시트가 서는 경우가 있다
 * (입력 중에 길게 눌러 시트를 연다).
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(() =>
    Keyboard.isVisible() ? Keyboard.metrics()?.height ?? 0 : 0,
  );
  useEffect(() => {
    const up = (event: KeyboardEvent) => setHeight(event.endCoordinates.height);
    const down = () => setHeight(0);
    const subscriptions = [
      Keyboard.addListener('keyboardWillShow', up),
      Keyboard.addListener('keyboardDidShow', up),
      Keyboard.addListener('keyboardWillHide', down),
      Keyboard.addListener('keyboardDidHide', down),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, []);
  return height;
}
