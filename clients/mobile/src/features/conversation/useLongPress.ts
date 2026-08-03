import {
  IDLE,
  LONG_PRESS_MS,
  pressStep,
  type PressState,
} from '@momo/core/features/timeline/longPressModel';
import {useCallback, useEffect, useRef} from 'react';
import type {GestureResponderEvent} from 'react-native';

// =============================================================================
// 길게 누르기 — 시트를 여는 제스처.
//
// 규칙은 이 파일의 것이 아니다. `@momo/core/features/timeline/longPressModel`의
// `pressStep`이 정본이고 여기는 그것을 React Native의 터치 이벤트에 붙이는
// 배선일 뿐이다. 웹 배치(B11)가 이 규칙을 훅 안에 두었다가 2라운드에서 꺼낸
// 이유가 그대로 여기에도 적용된다: 타이머와 이벤트에 붙어 있는 규칙은 테스트로
// 재생할 수 없고, 재생할 수 없는 방어는 죽어도 아무도 모른다. 실제로 죽어
// 있었다 — `origin`을 채운 직후 `clear()`가 그것을 지워서 10px 게이트가 **한
// 번도 돌지 않았다**.
//
// ## 두 겹으로 짠다, 그리고 그것이 이 파일의 요점이다
//
// 이 배선은 방어를 **두 겹**으로 둔다. 아래쪽이 무너져도 위쪽이 남는 구조이고,
// 그 순서가 중요하다.
//
//   1겹(플랫폼). 타이머는 `Pressable`의 `delayLongPress`가 돌린다. React
//      Native의 `Pressability`는 스크롤이 시작돼 ScrollView가 responder를
//      가져가면 제스처를 **취소**한다 — 이것은 오래된, 확실히 살아 있는 경로다.
//      즉 우리 코드가 한 줄도 돌지 않아도 "스크롤 중에 시트가 열린다"는 최악은
//      일어나지 않는다.
//
//   2겹(이 제품의 규칙). 그 위에 `pressStep`의 10px 게이트를 얹는다. RN의
//      press rect 는 20~30pt 로 훨씬 헐거워서, 그 사이를 천천히 끄는 손가락은
//      1겹을 통과한다. `onLongPress`가 울렸을 때 **아직 무장 상태인지**를 묻고,
//      아니면 거부한다. 이 거부가 이 파일이 존재하는 이유다.
//
// 두 겹으로 짜는 것은 정직함의 문제이기도 하다. 아래 `onTouchMove`가 iOS에서
// 스크롤 도중에도 배달된다는 것은 이 배치가 **시뮬레이터에서 증명할 수 없는**
// 사실이다(스파이크 #837: 시뮬레이터는 스크립트로 터치할 수 없고 RN 요소는
// 접근성 트리에 없다). 그래서 그 배달에 모든 것을 걸지 않는다 — 배달되면 규칙이
// 조여지고, 배달되지 않으면 RN의 기본 동작으로 **떨어질 뿐 깨지지는 않는다**.
// 젠킨스가 아니라 설계로 답한 것이고, 무엇이 증명됐고 무엇이 아닌지는 PR에 그대로
// 적는다.
//
// ## 거리는 page 좌표로 잰다 — location 좌표는 이 방어를 정확히 무력화한다
//
// `nativeEvent`는 `locationX/Y`(대상 뷰 기준)와 `pageX/Y`(화면 기준)를 함께
// 준다. 여기서 page를 쓰는 것은 취향이 아니다.
//
// 손가락이 리스트를 끌면 내용이 손가락을 **따라** 움직인다. 그래서 행을 기준으로
// 재면 손가락과 행이 같이 이동해 `locationY`는 거의 변하지 않는다 — 스크롤하는
// 내내 "움직이지 않았다"가 되고, 게이트는 있으나 마나 해진다. 화면을 기준으로
// 재면 손가락이 움직인 만큼 그대로 나온다. 웹의 게이트는 코드가 안 돌아서
// 죽었지만, 이 좌표를 잘못 고르면 코드가 돌면서도 죽는다.
// =============================================================================

export interface LongPressTouchHandlers {
  onTouchStart: (event: GestureResponderEvent) => void;
  onTouchMove: (event: GestureResponderEvent) => void;
  onTouchEnd: (event: GestureResponderEvent) => void;
  onTouchCancel: (event: GestureResponderEvent) => void;
}

export interface LongPress {
  /** 행을 감싸는 View 에 그대로 펼친다. */
  handlers: LongPressTouchHandlers;
  /** `Pressable` 의 `onLongPress` 에 그대로 연결한다. */
  onLongPress: () => void;
  /** `Pressable` 의 `delayLongPress`. 코어의 상수를 그대로 쓴다. */
  delayLongPress: number;
  /**
   * 방금 이 제스처가 시트를 열었는가.
   *
   * 행 안의 칩은 자기 `onPress`를 갖는데, 길게 눌러 시트를 연 손가락을 떼면
   * 그 탭이 뒤따라 울려 반응이 함께 토글된다. 칩은 누르기 전에 이 값을 보고
   * 스스로 물러난다(`consumeTap`).
   */
  consumeTap: () => boolean;
}

export function useLongPress({
  enabled,
  onFire,
}: {
  /** 이 행에 열 것이 있는가. 없으면 무장 자체를 하지 않는다(코어 규칙). */
  enabled: boolean;
  onFire: () => void;
}): LongPress {
  const stateRef = useRef<PressState>(IDLE);
  const firedRef = useRef(false);
  // 최신 값을 ref 로 들고 있는다. 핸들러 신원이 렌더마다 바뀌면 `View` 의
  // 터치 prop 이 매번 교체되는데, 이 컴포넌트는 타임라인의 모든 행이므로
  // 그 churn 이 가장 비싼 자리다.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onFireRef = useRef(onFire);
  onFireRef.current = onFire;

  const step = useCallback(
    (input: Parameters<typeof pressStep>[1]) => {
      const {state} = pressStep(stateRef.current, input, {
        enabled: enabledRef.current,
      });
      stateRef.current = state;
    },
    [],
  );

  const handlers = useRef<LongPressTouchHandlers>({
    onTouchStart: event => {
      firedRef.current = false;
      step({
        kind: 'down',
        // iOS 의 터치 핸들러에는 마우스가 도착하지 않는다 — 코어 규칙 1(마우스
        // 배제)은 이 플랫폼에서 구조적으로 참이다. 그래도 상수로 적어 두는 것은,
        // 규칙이 여기서 통과했다는 사실이 코드에 남아야 나중에 이 자리에 다른
        // 입력원(트랙패드·Apple Pencil)이 생겼을 때 판정할 곳이 분명해지기
        // 때문이다.
        pointerType: 'touch',
        point: {x: event.nativeEvent.pageX, y: event.nativeEvent.pageY},
      });
    },
    onTouchMove: event => {
      step({
        kind: 'move',
        point: {x: event.nativeEvent.pageX, y: event.nativeEvent.pageY},
      });
    },
    onTouchEnd: () => step({kind: 'end'}),
    onTouchCancel: () => step({kind: 'end'}),
  }).current;

  const onLongPress = useCallback(() => {
    // 2겹. 타이머는 플랫폼이 울렸지만, 그 사이에 손가락이 10px 넘게 움직였다면
    // `pressStep` 이 이미 무장을 풀어 두었다 — 그러면 이것은 고르는 손가락이
    // 아니라 읽는 손가락이므로 아무 일도 일어나지 않는다.
    if (stateRef.current.origin === null) return;
    step({kind: 'fire'});
    firedRef.current = true;
    onFireRef.current();
  }, [step]);

  const consumeTap = useCallback(() => {
    if (!firedRef.current) return false;
    firedRef.current = false;
    return true;
  }, []);

  useEffect(
    () => () => {
      stateRef.current = IDLE;
    },
    [],
  );

  return {handlers, onLongPress, delayLongPress: LONG_PRESS_MS, consumeTap};
}
