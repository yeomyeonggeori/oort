import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  PanResponder,
  StyleSheet,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  edgeSwipeStep,
  followX,
  IDLE,
  settleMs,
  settles,
  type EdgeSwipeState,
} from './edgeSwipe';

// =============================================================================
// 셸 위로 push 된 화면을 좌측 엣지에서 밀어 닫는다.
//
// ## 화면이 손가락을 **따라** 움직인다 — 그것이 이 컴포넌트의 요점이다
//
// 임계를 넘겼을 때 화면을 툭 바꾸는 구현이 훨씬 짧고, 그것은 뒤로가기가 아니라
// 순간이동이다. 뒤로가기 제스처가 하는 일의 절반은 **되돌릴 수 있다는 것을 손가락에
// 계속 보여 주는 것**이다: 조금 밀면 조금 열리고, 거기서 멈추면 아직 아무 일도 일어나지
// 않았고, 놓으면 제자리로 돌아온다. 그 피드백이 없으면 사람은 이 제스처를 신뢰하지
// 않게 되고, 신뢰하지 않는 제스처는 없는 제스처다.
//
// 그래서 `onPanResponderMove` 는 손가락의 **page 좌표**를 그대로 위치로 쓴다
// (`followX`). PanResponder 의 `gestureState.dx` 를 쓰지 않는 이유는 사소하지 않다:
// `onResponderGrant` 가 `dx` 를 0 으로 되돌리므로, 화면을 가져간 시점에 손가락이
// 이미 가 있던 {@link ACTIVATE_PX} 만큼을 영영 잃는다. 화면이 손가락보다 12pt 뒤에서
// 따라오는 것은 「따라온다」가 아니라 「끌려온다」이고, 그 어긋남은 보인다.
//
// ## 왜 `react-navigation` 이 아닌가
//
// 이 배치의 범위 밖이다(패킷 명시). `nav/state.ts` 가 그 거래를 이미 적어 뒀다 —
// react-navigation 은 `react-native-screens` 와 `react-native-gesture-handler` 라는
// 네이티브 모듈 **둘**을 "탭 둘과 push 하나"를 위해 들여오고, 그것은 ADR-0137 D1 의
// 의존성 방침이 걸린 결정이라 네 번째 화면을 추가하는 사람의 몫이다. 이 제스처는
// 그 결정을 앞당길 이유가 되지 못한다: **새 의존성 0개로 끝났다.** `PanResponder` 와
// `Animated` 는 React Native 자신의 것이고, `ios/MomoMobile.xcodeproj` 는 열지도
// 않았다(그 파일에는 NSE 타깃이 있다).
//
// ## 어떻게 스크롤뷰를 이기는가 — capture 단계
//
// 판정은 `onMoveShouldSetPanResponderCapture` 에 있다. **capture 는 루트에서
// 타깃으로 내려가므로**, 사이에 있는 `FlatList` 의 스크롤뷰보다 이 래퍼가 **먼저**
// 질문을 받는다. bubble 단계(`onMoveShouldSetPanResponder`)에 두면 이미 responder 를
// 쥔 스크롤뷰에게 밀려 한 번도 불리지 않는다. `onShouldBlockNativeResponder` 가
// true 인 것이 나머지 절반이다 — 그것이 iOS 의 `UIScrollView` 에게 팬을 취소하라고
// 말한다.
//
// 다만 그 힘은 판정이 인색할 때만 안전하다. **터치가 내려앉는 순간에는 절대
// 가져가지 않는다**(`onStartShouldSetPanResponderCapture` 는 시작점만 적고 언제나
// false 를 준다). 거기서 true 를 주면 이 래퍼 아래의 모든 탭과 길게 누르기가 죽는다.
// 무엇을 가져가고 무엇을 두는지는 전부 `edgeSwipe.ts` 의 순수 함수에 있고,
// `__tests__/edgeSwipe.test.ts` 가 ①길게 누르기 ②세로 스크롤 ③컴포저의 실제 제스처
// 시퀀스를 재생해 **한 번도 가져가지 않는다**를 증명한다.
//
// ## 겹쳐 있으면 안쪽이 이긴다
//
// 스레드는 대화 **안에** 그려진다(`ConversationScreen` 의 지역 상태). 그래서 두
// 래퍼가 부모-자식으로 겹치고, capture 는 바깥이 먼저다 — 아무 조치가 없으면 스레드를
// 열어 둔 채 엣지를 밀었을 때 **대화가 통째로 닫힌다.** 사람이 요청한 것은 스레드를
// 닫는 것이었으므로 그것은 결함이다.
//
// 그래서 각 래퍼는 자기 자식들에게 컨텍스트를 하나 내려 주고, 그 안에서 새로 마운트된
// 래퍼는 부모에게 **자기가 있다는 것을 알린다**. 자식이 하나라도 있으면 부모는 무장을
// 풀고, capture 에서 false 를 돌려주므로 질문은 그대로 안쪽까지 내려간다. 전역 스택도
// 아니고 화면들이 서로를 알 필요도 없다 — 트리가 이미 알고 있는 것을 쓴다.
// =============================================================================

/** 안쪽 래퍼가 바깥 래퍼에게 자기 존재를 알리는 통로. */
interface Nesting {
  enter: () => void;
  leave: () => void;
}

const NestingContext = createContext<Nesting | null>(null);

/** 테스트가 화면의 위치를 읽는 이음매. `Timeline` 의 `metricsRef` 와 같은 성격. */
export type EdgeSwipeProgressRef = React.MutableRefObject<number | null>;

export function EdgeSwipeBack({
  onBack,
  children,
  style,
  enabled = true,
  progressRef,
  testID = 'edge-swipe-pane',
}: {
  /** 제스처가 끝까지 갔을 때 부르는 것. 화면을 실제로 닫는 쪽의 몫이다. */
  onBack: () => void;
  children: React.ReactNode;
  /** 이 화면이 셸 위에서 차지하던 자리. 움직이는 것은 이 뷰 자신이다. */
  style?: StyleProp<ViewStyle>;
  /**
   * 끌 수 있다. 지금은 겹침 판정이 자동이라 앱에서 넘길 일이 없지만, 제스처를
   * 꺼야 하는 화면(전체화면 캔버스 같은)이 생기면 여기다.
   */
  enabled?: boolean;
  progressRef?: EdgeSwipeProgressRef;
  testID?: string;
}): React.JSX.Element {
  const {width} = useWindowDimensions();
  const translateX = useRef(new Animated.Value(0)).current;

  // ---- 겹침: 자식이 있으면 물러난다 ------------------------------------------
  const parent = useContext(NestingContext);
  const [nestedCount, setNestedCount] = useState(0);
  useEffect(() => {
    if (!parent) return;
    parent.enter();
    return () => parent.leave();
  }, [parent]);
  const nesting = useMemo<Nesting>(
    () => ({
      enter: () => setNestedCount(count => count + 1),
      leave: () => setNestedCount(count => count - 1),
    }),
    [],
  );

  // ---- 핸들러가 읽는 최신 값 --------------------------------------------------
  // PanResponder 는 **한 번만** 만든다. 이 컴포넌트는 화면 전체를 감싸므로, 렌더마다
  // 핸들러 신원이 바뀌면 그 churn 이 가장 비싼 자리다 — `useLongPress` 가 같은 이유로
  // 같은 선택을 했다.
  const armedRef = useRef(true);
  armedRef.current = enabled && nestedCount === 0;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const widthRef = useRef(width);
  widthRef.current = width;

  const stateRef = useRef<EdgeSwipeState>(IDLE);
  /** 화면이 마지막으로 「가 있으라」고 들은 위치. 남은 거리를 재는 데 쓴다. */
  const atRef = useRef(0);
  /** 놓은 뒤 미끄러지는 중. 그 사이에 다시 잡히지 않는다. */
  const settlingRef = useRef(false);
  const mountedRef = useRef(true);
  const commitRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const write = useCallback(
    (value: number) => {
      atRef.current = value;
      translateX.setValue(value);
      if (progressRef) progressRef.current = value;
    },
    [translateX, progressRef],
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (commitRef.current !== undefined) clearTimeout(commitRef.current);
    },
    [],
  );

  // ===========================================================================
  // 놓은 뒤: 애니메이션은 **장식**이고, 네비게이션은 **사실**이다
  //
  // 둘을 분리해 둔다. 화면을 미끄러뜨리는 것은 `Animated`(네이티브 드라이버 —
  // transform 이므로 자격이 되고, 그 자격을 지키는 것이 이 앱의 오래된 규칙이다)이고,
  // `onBack` 을 부르는 것은 같은 길이의 타이머다.
  //
  // 애니메이션의 완료 콜백에 `onBack` 을 걸지 않는 이유: 네이티브 드라이버로 도는
  // 애니메이션의 완료는 **네이티브가 알려 줄 때** 오고, 그것이 오지 않는 환경(테스트가
  // 그렇다)에서는 화면이 영영 닫히지 않는다. 화면을 닫는 것은 이 제스처가 하기로 한
  // 유일한 약속이므로, 그 약속을 렌더러의 사정에 매달아 두지 않는다. 어긋나 봐야 한
  // 프레임이고, 그때 화면은 이미 화면 밖에 있다.
  // ===========================================================================
  const settle = useCallback(
    (outcome: 'back' | 'cancel') => {
      const screenWidth = widthRef.current;
      const to = outcome === 'back' ? screenWidth : 0;
      const duration = settleMs(Math.abs(to - atRef.current), screenWidth);
      settlingRef.current = true;
      atRef.current = to;
      if (progressRef) progressRef.current = to;
      Animated.timing(translateX, {
        toValue: to,
        duration,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
      if (outcome === 'cancel') {
        commitRef.current = setTimeout(() => {
          commitRef.current = undefined;
          settlingRef.current = false;
        }, duration);
        return;
      }
      commitRef.current = setTimeout(() => {
        commitRef.current = undefined;
        settlingRef.current = false;
        if (!mountedRef.current) return;
        onBackRef.current();
        // `onBack` 이 이 화면을 걷어내는 것이 세 호출부 모두의 동작이지만, 걷어내지
        // **않는** 상위 구현이 생기면 화면은 밖에 나간 채로 남는다. 다음 프레임에
        // 제자리로 돌려 두는 것이 그 경우의 유일한 방어이고, 걷어내는 경우에는
        // 이미 언마운트되어 아무 일도 하지 않는다.
        requestAnimationFrame(() => {
          if (mountedRef.current) write(0);
        });
      }, duration);
    },
    [translateX, progressRef, write],
  );

  const responder = useRef(
    PanResponder.create({
      // 시작점만 적는다. **언제나 false** — 여기서 가져가면 이 래퍼 아래의 탭과
      // 길게 누르기가 전부 죽는다.
      onStartShouldSetPanResponderCapture: event => {
        const {pageX, pageY, touches} = event.nativeEvent;
        const {state} = edgeSwipeStep(
          stateRef.current,
          {
            kind: 'down',
            touches: touches?.length ?? 1,
            point: {x: pageX, y: pageY},
          },
          {enabled: armedRef.current && !settlingRef.current},
        );
        stateRef.current = state;
        return false;
      },
      onMoveShouldSetPanResponderCapture: event => {
        const {pageX, pageY} = event.nativeEvent;
        const {state, claims} = edgeSwipeStep(
          stateRef.current,
          {kind: 'move', point: {x: pageX, y: pageY}},
          {enabled: armedRef.current && !settlingRef.current},
        );
        stateRef.current = state;
        return claims;
      },
      onPanResponderGrant: event => {
        // 가져온 순간 손가락은 이미 문턱만큼 가 있다. **거기서부터** 그린다 —
        // 0 에서 시작하면 첫 프레임에 화면이 손가락보다 뒤에 있다가 따라붙는 것이
        // 보이고, 그 한 번의 어긋남이 "따라온다"를 "끌려온다"로 바꾼다.
        const origin = stateRef.current.origin;
        if (origin === null) return;
        write(followX(event.nativeEvent.pageX - origin.x, widthRef.current));
      },
      onPanResponderMove: event => {
        const origin = stateRef.current.origin;
        if (origin === null) return;
        write(followX(event.nativeEvent.pageX - origin.x, widthRef.current));
      },
      // 잡았으면 놓지 않는다. 여기서 양보하면 밑의 스크롤뷰가 스와이프 도중에
      // 화면을 되가져간다.
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (event, gesture) => {
        const origin = stateRef.current.origin;
        stateRef.current = IDLE;
        if (origin === null) {
          settle('cancel');
          return;
        }
        settle(
          settles(
            {dx: event.nativeEvent.pageX - origin.x, vx: gesture.vx},
            widthRef.current,
          ),
        );
      },
      // 빼앗겼다(전화가 왔거나, OS 가 제스처를 취소했거나). 사람이 놓은 것이
      // 아니므로 아무 데도 가지 않는다.
      onPanResponderTerminate: () => {
        stateRef.current = IDLE;
        settle('cancel');
      },
      // iOS 의 UIScrollView 에게 팬을 취소하라고 말하는 것이 이 한 줄이다.
      onShouldBlockNativeResponder: () => true,
    }),
  ).current;

  return (
    <NestingContext.Provider value={nesting}>
      <Animated.View
        style={[
          style,
          styles.pane,
          {transform: [{translateX}]},
        ]}
        testID={testID}
        {...responder.panHandlers}>
        {children}
      </Animated.View>
    </NestingContext.Provider>
  );
}

const styles = StyleSheet.create({
  pane: {
    // 밀려나는 동안 이것이 **위에 얹힌 카드**로 읽히게 하는 그림자. 제자리(x=0)에서는
    // 화면 왼쪽 바깥에 떨어지므로 보이지 않고, 따라서 평소에는 아무것도 바꾸지 않는다.
    shadowColor: '#000',
    shadowOffset: {width: -3, height: 0},
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
});
