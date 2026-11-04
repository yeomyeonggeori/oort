import {PixelRatio, StyleSheet, type StyleProp, type TextStyle} from 'react-native';

/** 렌더 트리 노드의 모양 - `screen.getByTestId` 가 돌려주는 인스턴스가 이 모양이다(타입 선언을 따로 끌어오지 않는다). */
export interface Walkable {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<Walkable | string>;
}

/**
 * 한글이 든 글자 중 **어절 우선 줄바꿈(`lineBreakStrategyIOS="hangul-word"`)이 빠진 것**을 센다 (#4982).
 *
 * iOS 기본 줄바꿈은 한글을 글자 단위로 끊는다. 「낱말 가운데서 끊지 않는다」는 규칙은 글자 하나하나가 이 속성을 들어야
 * 지켜지고, 그래서 시험은 이름 허용 목록이 아니라 **렌더 트리의 모든 글자 노드**를 센다 - 나중에 누가 `<Text>` 를 하나 더 두면
 * 그 화면의 시험이 빨개진다.
 *
 * 세는 규칙:
 *  - 대상은 호스트 `Text` 중 **가장 바깥**의 것이다. 안쪽에 겹친 `Text` 는 바깥 글자 상자의 문단 설정을 따른다.
 *  - 글자는 자손의 문자열을 이어 붙인 것이다. 한글이 없으면(숫자·✓·URL) 줄바꿈 규칙이 뜻이 없어 세지 않는다.
 *  - `checked` 는 센 글자 노드 수다. 이것이 0 이면 훑은 곳에 글자가 없었다는 뜻이라 **빈 훑기**(실패할 수 없는 가드)다.
 *    호출하는 쪽은 `checked` 의 하한도 함께 단정한다.
 */
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

function textOf(node: Walkable | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(child => textOf(child)).join('');
}

export interface HangulWordSweep {
  /** 한글이 든 가장 바깥 글자 노드의 수. */
  checked: number;
  /** 속성이 빠진 글자(앞 40자). */
  missing: string[];
}

export function sweepHangulWord(root: Walkable): HangulWordSweep {
  const sweep: HangulWordSweep = {checked: 0, missing: []};
  const visit = (node: Walkable, insideText: boolean) => {
    const isText = node.type === 'Text';
    if (isText && !insideText) {
      const content = textOf(node);
      if (HANGUL.test(content)) {
        sweep.checked += 1;
        if (node.props.lineBreakStrategyIOS !== 'hangul-word') {
          sweep.missing.push(content.slice(0, 40));
        }
      }
    }
    for (const child of node.children) {
      if (typeof child !== 'string') visit(child, insideText || isText);
    }
  };
  visit(root, false);
  return sweep;
}

// -----------------------------------------------------------------------------------------------------------------
// 줄 높이 여유 (#5288, #4894) — 영어 문장·말풍선까지 같은 훑기로 센다
// -----------------------------------------------------------------------------------------------------------------

export interface LineHeadroomSweep {
  /** 줄 높이를 **숫자로** 가진 가장 바깥 글자 노드의 수. 0 이면 훑은 곳에 대상이 없었다는 뜻이라 빈 훑기(실패할 수 없는 가드)다. */
  checked: number;
  /** 줄 높이가 화소 격자의 정수배라 깎임에 맨몸인 글자(앞 40자 + 줄 높이). */
  exposed: string[];
}

/**
 * 줄 높이가 **화소 격자의 정수배**인 글자 노드를 센다(= 여유가 빠진 글자).
 *
 * 여러 줄로 접힌 글이 첫 줄만 그려지고 잘리는 결함은 글 상자 높이가 float 반올림으로 줄 수의 요구보다 1e-4pt 낮게 내려오는 것이다
 * (`src/design/lineHeadroom.ts` 머리말의 실측). 줄 높이가 정수(23·18…)인 글은 N 줄의 높이가 늘 화소의 정수배라 매번 그 길에 든다.
 * 고친 부품(`Sentence`·`NoticeBlock`·말풍선 글)은 줄 높이를 0.01pt 낮춰 정수배에서 벗어난다. 이 훑기는 그 사실을 **영어든 한국어든**
 * 렌더 트리의 모든 글자 노드에서 센다 — 한글 유무(`sweepHangulWord`)와 상관없다.
 *
 * 앱의 판정 함수를 부르지 않고 자기 계산을 쓴다(앱의 판정이 틀려도 같이 틀리지 않게). `scale` 은 기기 화소 배율(jest 는 2).
 * 호출하는 쪽은 `checked` 의 하한도 함께 단정한다.
 */
export function sweepLineHeadroom(root: Walkable, scale: number = PixelRatio.get()): LineHeadroomSweep {
  const sweep: LineHeadroomSweep = {checked: 0, exposed: []};
  const visit = (node: Walkable, insideText: boolean) => {
    const isText = node.type === 'Text';
    if (isText && !insideText) {
      const lineHeight = StyleSheet.flatten(node.props.style as StyleProp<TextStyle>)?.lineHeight;
      if (typeof lineHeight === 'number') {
        sweep.checked += 1;
        const px = lineHeight * scale;
        if (Math.abs(px - Math.round(px)) < 1e-6) sweep.exposed.push(`${textOf(node).slice(0, 40)} (${lineHeight})`);
      }
    }
    for (const child of node.children) {
      if (typeof child !== 'string') visit(child, insideText || isText);
    }
  };
  visit(root, false);
  return sweep;
}
