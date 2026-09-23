import {useEffect, useState} from 'react';
import {Keyboard, type KeyboardEvent} from 'react-native';

/**
 * 소프트 키보드가 지금 화면에 있는가 (#1892 R1 M-4). 올라오고 내려가는 순간에만
 * 바뀐다.
 *
 * `useKeyboard` 가 아니라 이것인 이유: 그 훅은 높이를 숫자로 들고 애니메이션 값을
 * 돌리며, 이벤트마다 부른 쪽을 다시 그린다. 여기서 알고 싶은 것은 「올라와 있나」
 * 한 가지이고, 그 답을 읽는 것은 **떠 있는 필 하나**다. 그래서 이 훅은 그 필의
 * 자리만 다시 그리게, 필이 서 있을 때만 구독하게 쓴다(`enabled`). 대화 화면이나
 * 목록에서 부르면 키보드가 움직이는 바로 그 순간에 목록을 다시 그리게 되는데, 그
 * 순간의 JS 스레드를 비우는 것이 RN-P2·P3 가 산 것이다.
 *
 * 처음 값은 `Keyboard.isVisible()` 이다 — 키보드가 이미 올라와 있는 동안 필이
 * 새로 서는 경우가 있다(입력 중에 새 메시지가 구분선을 위로 밀어낸다).
 *
 * 높이가 0 인 보고는 「없다」로 읽는다. 하드웨어 키보드가 붙은 iPad 가 그렇게
 * 보고하는 경우가 있고, 판이 들리지 않으면 가릴 것도 없다.
 *
 * `enabled` 는 부른 쪽이 사는 동안 바뀌지 않는다고 본다(필의 자리마다 고정이다).
 */
export function useKeyboardShown(enabled: boolean): boolean {
  const [shown, setShown] = useState(() => enabled && Keyboard.isVisible());
  useEffect(() => {
    if (!enabled) return undefined;
    const up = (event: KeyboardEvent) =>
      setShown(event.endCoordinates.height > 0);
    const down = () => setShown(false);
    // will 과 did 를 둘 다 듣는다. iOS 는 will 이 먼저 와서 판이 들리기 **전에**
    // 필을 거둘 수 있고, Android 에는 did 만 있다. 같은 값이면 React 가 렌더를
    // 건너뛴다.
    const subscriptions = [
      Keyboard.addListener('keyboardWillShow', up),
      Keyboard.addListener('keyboardDidShow', up),
      Keyboard.addListener('keyboardWillHide', down),
      Keyboard.addListener('keyboardDidHide', down),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [enabled]);
  return enabled && shown;
}
