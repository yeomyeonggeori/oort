import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import {Animated, StyleSheet} from 'react-native';

import {EASE_OUT, LANDED_TINT_FADE_MS} from '../../design/motion';
import {useStyles} from '../../design/theme';
import type {Palette} from '../../design/tokens';
import {landedFace, ROW_FACE} from './rowFace';

// =============================================================================
// 착지 틴트가 물러나는 한 번의 전환 (#3921).
//
// 행은 **서 있는 동안**(`landed`) 틴트를 자기 그릇의 배경으로 입는다(`styles.rowLanded`).
// 이 파일은 그 `landed` 가 참에서 거짓으로 바뀐 **그 순간**에만 일을 한다 — 그릇이
// 배경을 벗는 같은 커밋에 같은 색의 덮개를 얹고, 그 덮개를 투명으로 녹인다. 덮개는 같은
// 면을 같은 색·불투명도 1 로 덮고 시작하므로 벗는 순간 같은 색이 이어서 선다. (시험이 단정하는
// 것: 덮개가 `landed` 가 뒤집히는 한 커밋에 서고(`Profiler` 로 덮개 쪽 커밋 수를 센다 — 그릇의
// 배경은 같은 prop 이 한 렌더에서 두 곳에 닿는 구조가 같은 커밋에 벗긴다), 갈아입은 직후 색·면·
// 불투명도가 서 있던 그릇과 같고, 덮개의 가장 가까운 호스트 부모가 그릇이며 내용보다 앞에 선다 —
// `landedHighlight.test.tsx`. 화면 픽셀로는 재지 않았다: 시험은 React 트리까지만 본다.)
//
// ## 왜 그릇의 배경을 움직이지 않는가
//
// 그릇을 `Animated.View` 로 바꿔 배경색을 보간하면 간단해 보인다. 네이티브 드라이버도
// `backgroundColor` 를 움직일 수 있다(RN 0.86 `NativeAnimatedAllowlist` 의
// `SUPPORTED_COLOR_STYLES`) — 그래서 이유는 성능이 아니라 두 가지다. (1) 행의 그릇은 목록의
// 모든 행이 지고 있는 `View` 이고, 타입을 바꾸면 한 행의 하위 트리(아바타·카드·컨트롤)가
// 통째로 다시 만들어진다. (2) 선 동안의 틴트가 평범한 `backgroundColor` 라는 사실에
// 시험(`conversationHygiene`)과 캡처 하네스가 기대고 있다. 덮개는 불투명도만 움직이므로
// 둘 다 건드리지 않는다.
//
// ## 「동작 줄이기」
//
// 머무는 시간(`LANDED_HOLD_MS`, 약 1.5초)은 그대로이고 **전환만** 즉시다 — 설정이 막는 것은
// 움직임이지 사람이 틴트를 볼 시간이 아니다. 머문 뒤 0.24초(`LANDED_TINT_FADE_MS`)에 걸쳐 녹고,
// 동작 줄이기면 덮개 없이 바로 걷힌다. 설정은 목록(`Timeline`)이 이미 들고 있는 ref 를
// 컨텍스트로 받는다. 행마다 `useReduceMotionRef` 를 부르면 마운트된 행 수만큼
// `AccessibilityInfo.isReduceMotionEnabled()` 네이티브 호출이 목록이 뜨는 순간에 몰린다.
// 컨텍스트가 없는 표면(검색 미리보기·측정 하네스)은 움직임을 줄이지 않은 것으로 읽는다 —
// 거기서는 `landed` 가 서지 않으므로 이 전환 자체가 일어나지 않는다.
// =============================================================================

/**
 * 목록이 든 「동작 줄이기」 ref. 읽는 순간의 값이 정본이라 상태가 아니라 ref 이고,
 * 한 마운트 동안 동일성이 변하지 않는다(`useReduceMotionRef`).
 */
export const ReduceMotionRefContext =
  createContext<MutableRefObject<boolean> | null>(null);

/**
 * 모든 행이 하나씩 지는 얇은 구독자다. 일하지 않는 동안에는 `null` 을 그린다 — 상태 둘과
 * 직전 값 하나가 행당 비용의 전부이고, `Animated.Value` 는 물러나는 순간에만 만든다.
 */
export function LandedTintFade({
  landed,
}: {
  landed: boolean;
}): React.JSX.Element | null {
  // 「이전 prop 과 비교해 상태를 고친다」(React 문서의 파생 상태 형태). 효과로 미루면 그릇이
  // 배경을 벗은 커밋이 덮개 없이 한 번 그려진다 — 한 프레임짜리 깜빡임이다.
  const [wasLanded, setWasLanded] = useState(landed);
  const [leaving, setLeaving] = useState(false);
  if (landed !== wasLanded) {
    setWasLanded(landed);
    // 거짓에서 참으로 돌아오면(같은 행으로 다시 점프) 녹던 덮개는 거둔다 — 그릇이 다시
    // 배경을 입으니 덮개가 남아 있으면 틴트가 두 겹이 된다.
    setLeaving(wasLanded && !landed);
  }
  if (!leaving) return null;
  return <Leaving onDone={() => setLeaving(false)} />;
}

function Leaving({onDone}: {onDone: () => void}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const reduceMotionRef = useContext(ReduceMotionRefContext);
  // 마운트 순간의 값으로 한 번 정한다. 이 컴포넌트는 물러나는 한 번마다 새로 서므로
  // 「움직이는 도중에 설정이 바뀐다」는 길이 없다.
  const [instant] = useState(() => reduceMotionRef?.current === true);
  const [opacity] = useState(() => new Animated.Value(1));
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  // 레이아웃 효과로 두어 `leaving` 되돌림과 애니메이션 시작을 그리기 전에 건다. 즉시 거두는
  // 길(`instant`)은 아래에서 덮개를 아예 그리지 않으므로(`return null`) 효과의 종류가 화면에
  // 주는 차이는 없다 — 첫 프레임이 불투명도 1 인 것도 어느 효과든 같다.
  useLayoutEffect(() => {
    if (instant) {
      doneRef.current();
      return undefined;
    }
    const run = Animated.timing(opacity, {
      toValue: 0,
      duration: LANDED_TINT_FADE_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    // `finished` 가 거짓이면 중간에 멈춘 것이다(언마운트) — 그때는 부를 곳이 없다.
    run.start(({finished}) => {
      if (finished) doneRef.current();
    });
    return () => run.stop();
  }, [instant, opacity]);

  if (instant) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.tint, {opacity}]}
      testID="message-row-landed-fade"
    />
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 그릇 전체를 덮는다 — 그릇의 `backgroundColor` 가 덮던 면과 같은 면이다
    // (`MessageRow` `rowLanded` 주석: 안쪽에 걸면 좌우 여백이 안 물든다). 그릇의 첫 자식이라
    // 행의 내용 뒤에 그려진다.
    tint: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: ROW_FACE.radius,
      // 서 있는 면(`styles.rowLanded`)과 같은 색 — 테두리는 없다(owner 2026-10-31, #4949).
      backgroundColor: landedFace(color),
    },
  });
