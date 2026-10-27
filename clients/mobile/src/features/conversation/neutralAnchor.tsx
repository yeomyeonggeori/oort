import React, {forwardRef, isValidElement, useSyncExternalStore} from 'react';
import {ScrollView, StyleSheet, View, type ScrollViewProps} from 'react-native';

// =============================================================================
// ## 중립 앵커 — 먼 「최신으로」 동안 `maintainVisibleContentPosition` 을 **떼지 않고** 무력화한다 (#4689)
//
// 증상: 멀리 올라간 채 「최신 메시지로 이동」을 누르면 첫 홉은 +1~2ms 에 진짜 끝에 닿는데(보임 40ms),
// +65~125ms 에 `release` 가 prop 을 다시 붙이는 순간 목록이 **방금 간 만큼 되밀린다**(16 Pro·Debug·300행
// 방: 중간 −14,854pt · 맨 위 근처 −2,631pt). 옛 내용이 번쩍이고, `holdLanding` 틱이 다시 끌어내려
// 안정까지 200~415ms 가 걸린다.
//
// 원인 — `RCTScrollViewComponentView.mm`(RN 0.86) 의 `_prepareForMaintainVisibleScrollPosition` /
// `_adjustForMaintainVisibleContentPosition`:
//
//   1. 앵커는 **prop 이 붙어 있을 때만** 기록한다(트랜잭션마다 `contentView.subviews[minIdx…]` 중
//      `frame.y + h > contentOffset.y` 인 첫 뷰).
//   2. 보정은 `앵커.frame.y − 기록한 frame.y` 를 `contentOffset.y` 에 **clamp 없이** 더한다.
//   3. 먼 이동 동안 prop 을 떼면 앵커가 갱신되지 않는다. 그동안 앵커였던 셀은 창이 끝으로 내려가며
//      언마운트·재활용돼 frame.y 가 0 이 된다 → 다시 붙는 커밋에서 보정 = 0 − (기록한 y) = −y.
//
// 그래서 prop 을 떼는 한 이 되밀림은 네이티브에서만 막을 수 있다. 여기서는 **prop 을 떼지 않고**, 대신 앵커가
// 언제나 같은 자리에 있는 뷰가 되게 한다 — 보정의 분자 `새 y − 옛 y` 가 0 이면 아무것도 움직이지 않는다.
//
// 보초(sentinel)는 내용 컨테이너의 **헤더 바로 뒤**(= 네이티브 서브뷰 1번, `minIndexForVisible` 0 + 헤더 1)에
// 끼운 항상 마운트된 빈 View 하나다. 스캔의 첫 후보라서, 창에 걸리기만 하면 앵커로 뽑힌다.
//
//   - 중립(`neutral`): `top:-ANCHOR_TOP, bottom:0` → 내용 전체 높이. `y + h = 컨테이너 높이 > offset` 이라
//     언제나 「보이는 첫 뷰」다. y 는 −ANCHOR_TOP 으로 **한 번도 안 변한다** → 보정 0 = 네이티브 MVCP 무력.
//   - 평상(`rest`): `top:-ANCHOR_TOP, height:0` → `y + h = −ANCHOR_TOP` 이라 맨 위 오버스크롤(offset < 0)에서도
//     창에 걸리지 않는다. 앵커는 지금까지처럼 첫 보이는 셀이다.
//
// **y 를 바꾸지 않고 높이만 바꾸는 이유**: 앵커인 뷰의 y 가 한 트랜잭션에서 바뀌면 그 차이가 그대로 되밀림이 된다
// (평상 y=0 → 치움 y=−1000 은 −1000pt 보정). 둘 다 같은 y 에 두면 중립↔평상의 어느 방향도, prop 이 빠진
// 전송·진입의 커밋 사이에서도 보정이 생기지 않는다. 컨텐츠 크기는 스크롤뷰의 직계 자식(내용 컨테이너)의 frame 으로
// 정해지므로(`ScrollViewShadowNode::updateStateIfNeeded`) 컨테이너 안의 보초는 스크롤 범위를 바꾸지 않는다.
//
// 이 자리는 **iOS 네이티브 앵커 규칙**에 기댄다(이 앱은 iOS 전용이다). 전송·진입의 prop 토글(`chasingTail`)은
// 그대로다 — 이 보초는 `latest` 이면서 먼 이동에만 중립이 된다(`Timeline.convergeToEnd`).
// =============================================================================

/** 보초가 있는 y(−). 맨 위 오버스크롤(offset 이 음수)에서도 `y + 0 > offset` 이 거짓이도록 충분히 멀리. */
const ANCHOR_TOP = 1000;

/** `VirtualizedList` 가 `ListHeaderComponent` 셀에 다는 키 — 보초는 그 바로 뒤에 낀다. */
const HEADER_CELL_KEY = '$header';

export const NEUTRAL_ANCHOR_TEST_ID = 'timeline-anchor';

export type AnchorPhase = 'rest' | 'neutral';

export interface NeutralAnchorStore {
  get(): AnchorPhase;
  set(next: AnchorPhase): void;
  subscribe(listener: () => void): () => void;
}

/**
 * 보초의 상태 하나. React state 가 아니라 작은 저장소인 이유: 보초만 다시 그려지게 하려는 것이다 — 상태로
 * 올리면 중립을 켜고 끌 때마다 `Timeline` 과 `FlatList` 전체가 다시 그려지고, 그 비용이 먼 이동 한가운데에 얹힌다.
 */
export function createNeutralAnchorStore(): NeutralAnchorStore {
  let phase: AnchorPhase = 'rest';
  const listeners = new Set<() => void>();
  return {
    get: () => phase,
    set(next) {
      if (next === phase) return;
      phase = next;
      listeners.forEach(listener => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const styles = StyleSheet.create({
  rest: {position: 'absolute', top: -ANCHOR_TOP, left: 0, right: 0, height: 0},
  neutral: {position: 'absolute', top: -ANCHOR_TOP, left: 0, right: 0, bottom: 0},
});

function NeutralAnchor({store}: {store: NeutralAnchorStore}): React.JSX.Element {
  const phase = useSyncExternalStore(store.subscribe, store.get, store.get);
  return (
    <View
      // 네이티브 뷰로 남는다 — 납작해지면 서브뷰 목록에 없어 앵커가 될 수 없다.
      collapsable={false}
      // 터치·접근성: 빈 투명 뷰일 뿐이다. 손도 VoiceOver 도 받지 않는다.
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles[phase]}
      testID={NEUTRAL_ANCHOR_TEST_ID}
    />
  );
}

export interface AnchoredScrollViewProps extends ScrollViewProps {
  anchorStore: NeutralAnchorStore;
}

/**
 * `FlatList` 의 `renderScrollComponent` 가 쓰는 스크롤뷰 — 받은 props·ref 를 그대로 `ScrollView` 에 넘기고,
 * 자식(`VirtualizedList` 의 셀 배열) 의 **헤더 바로 뒤**에 보초 하나만 끼운다.
 */
export const AnchoredScrollView = forwardRef<ScrollView, AnchoredScrollViewProps>(
  ({anchorStore, children, ...scrollProps}, ref) => {
    const cells = Array.isArray(children) ? children : [children];
    const first: unknown = cells[0];
    const at = isValidElement(first) && first.key === HEADER_CELL_KEY ? 1 : 0;
    return (
      <ScrollView {...scrollProps} ref={ref}>
        {[
          ...cells.slice(0, at),
          <NeutralAnchor key="$anchor" store={anchorStore} />,
          ...cells.slice(at),
        ]}
      </ScrollView>
    );
  },
);
AnchoredScrollView.displayName = 'AnchoredScrollView';
