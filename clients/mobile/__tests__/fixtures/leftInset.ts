import {StyleSheet} from 'react-native';

/**
 * 이 요소가 화면 왼쪽 끝에서 **얼마나 들어와** 시작하는가(pt) - 선언된 가로 여백의 합 (#4912 2차, 디자인 검수 H2).
 *
 * JS 렌더러에는 레이아웃이 없어서 x 좌표를 직접 잴 수 없다. 대신 요소와 그 조상들이 선언한 왼쪽 여백을 더한다:
 * 요소 자신은 바깥 여백(margin)만 센다(제 padding 은 안쪽 내용을 미는 값이다), 조상은 margin 과 padding 을 다
 * 센다. 스크롤은 `contentContainerStyle` 도 센다 - 안쪽 내용이 서는 그릇이기 때문이다.
 *
 * 이 합이 **정확히 한 겹의 가터**여야 한다. 한 겹이 비면 줄이 화면 가장자리에 붙고(0), 부품과 호스트가 둘 다 지면
 * 이중 인셋이 된다(32). 「그릇 하나가 가터를 졌다」만 보는 단정은 둘째 겹을 못 보므로 조상 전체의 합으로 잰다.
 *
 * 호스트 요소(`type` 이 문자열)만 센다. 합성 요소(`View`·`Text`·`Pressable` 래퍼)는 같은 `style` 을 그 아래 호스트에
 * 그대로 내려서, 둘 다 세면 한 겹이 두 겹으로 보인다.
 *
 * 재지 못하는 것: 정렬(`alignItems`)·`gap`·형제의 폭·절대 위치. 이 측정기는 **선언된 가로 여백**만 안다.
 */
interface Walkable {
  type: unknown;
  parent: Walkable | null;
  props: {style?: unknown; contentContainerStyle?: unknown};
}
type Flat = Record<string, unknown>;

const flat = (style: unknown): Flat => (StyleSheet.flatten(style as never) ?? {}) as Flat;

/** 한 면이 안쪽으로 미는 왼쪽 거리. 더 구체적인 선언이 이긴다: `Left` > `Start` > `Horizontal` > 전체. */
function left(style: Flat, side: 'margin' | 'padding'): number {
  const value =
    style[`${side}Left`] ?? style[`${side}Start`] ?? style[`${side}Horizontal`] ?? style[side];
  return typeof value === 'number' ? value : 0;
}

const both = (style: unknown): number => {
  const f = flat(style);
  return left(f, 'margin') + left(f, 'padding');
};

export function leftEdge(instance: unknown): number {
  const self = instance as Walkable;
  let x = left(flat(self.props.style), 'margin');
  for (let node = self.parent; node; node = node.parent) {
    if (typeof node.type !== 'string') {
      continue;
    }
    x += both(node.props.style) + both(node.props.contentContainerStyle);
  }
  return x;
}
