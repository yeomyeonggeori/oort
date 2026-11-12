import {
  typingVisualSegments,
  typingLabel,
} from '@momo/core/features/chat/typing';
import {cleanup, fireEvent, render, screen} from './fixtures/darkWorld';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import {color, SAFE_GUTTER, space} from '../src/design/tokens';
import {RESPONDING_DOTS_WIDTH} from '../src/features/agents/RespondingDots';
import {
  shareTypingNameWidths,
  TypingBar,
  typingNameRoom,
} from '../src/features/conversation/TypingBar';

// =============================================================================
// 「작성 중」 안정화 — design-review H-3·M-4·M-5·M-6·N-4.
//
// ## 이 파일의 중심은 「움직이지 않는다」다
//
// 이 줄은 **남이 결정하는 박자로** 나타나고 사라진다 — 팀원이 치기 시작할 때마다,
// 멈추고 6초 뒤마다. 그 아래에 있는 것은 키보드가 올라온 폰에서 **엄지 밑의 전송
// 버튼**이다. 첫 판은 자리를 안 잡았고("빈 여백이 상시로 앉는다"), 그래서 남의
// 키보드가 내 버튼을 움직였다.
//
// 웹이 같은 판정을 이미 내렸고 **그 근거가 하필 폰이었다** — 웹 리뷰가 폰을 들어
// 설득한 결정을 정작 폰이 반대로 구현했던 것이다.
//
// ## 이 파일이 `typingBar.test.tsx` 를 승계한다
//
// 그 파일은 M2 의 계약을 지키고 있었고 그중 하나를 **H-3 이 뒤집었다** —
// 「신호가 없으면 자리도 차지하지 않는다」. 뒤집힌 단정을 남겨 두면 두 파일이
// 서로 반대를 주장하게 되므로, 살아 있는 것(문장을 짓지 않는다 · 한 줄이다 ·
// 소스에 문구가 안 박힌다)을 여기로 옮기고 그 파일은 지웠다. 뒤집힌 **이유**는
// 테스트가 아니라 `TypingBar.tsx` 머리말과 커밋이 든다 — 테스트는 지금 참인
// 것을 말하는 자리이지 역사를 적는 자리가 아니다.
// =============================================================================

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../src/features/conversation/TypingBar.tsx'),
  'utf8',
);
const SCREEN = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/ConversationScreen.tsx'),
  'utf8',
);

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

/**
 * 비어 있는 줄은 **접근성 트리에서 숨겨져 있다**(자리는 예약하되 빈 원소를 로터에
 * 세우지 않는다). RNTL 의 기본 쿼리는 숨겨진 원소를 건너뛰므로, **레이아웃**을
 * 묻는 단정은 그 사실을 알고 물어야 한다 — 숨김 자체는 아래 단정이 따로 잰다.
 */
function line() {
  return screen.getByTestId('composer-typing', {includeHiddenElements: true});
}

afterEach(cleanup);

describe('H-3 — 자리를 예약한다', () => {
  it('아무도 안 쳐도 줄은 자리를 지킨다', () => {
    // 첫 판은 여기서 `null` 을 돌려줬고, 그래서 이 줄이 나타나고 사라질 때마다
    // 아래의 컴포저 전체가 위아래로 뛰었다.
    render(<TypingBar segments={[]} />);
    expect(line()).toBeTruthy();
    // 칸은 고정 높이다(#5645: `minHeight` 였던 앞 판은 큰 글자에서 글이 칸을 밀었다).
    expect(flatten(line().props.style).height).toBeGreaterThan(0);
  });

  it('예약 높이는 1줄이다 — 두 줄을 예약하면 정말로 빈 띠가 생긴다', () => {
    render(<TypingBar segments={[]} />);
    // 줄 상자 한 줄(가장 큰 글자에서도 16 × 상한 1.6 = 25.6). 두 줄치(32+)를 예약하지 않는다.
    expect(flatten(line().props.style).height).toBeLessThan(32);
  });

  it('있을 때와 없을 때의 높이가 같다 — 그것이 「안 움직인다」의 뜻이다', () => {
    const {rerender} = render(<TypingBar segments={[]} />);
    const emptyStyle = flatten(line().props.style);
    rerender(<TypingBar segments={typingVisualSegments(['김민수'])} />);
    const fullStyle = flatten(line().props.style);
    expect(fullStyle.height).toBe(emptyStyle.height);
    expect(fullStyle.lineHeight).toBe(emptyStyle.lineHeight);
  });

  it('비어 있을 때는 보조기술에도 비어 있다', () => {
    // 자리는 예약하되 빈 원소를 로터에 세워 두지는 않는다.
    render(<TypingBar segments={[]} />);
    expect(line().props.accessibilityElementsHidden).toBe(true);
    expect(line().props.accessibilityLabel).toBeUndefined();
    // 그리고 기본 쿼리로는 **찾히지 않는다** — 그것이 「트리에 없다」의 실측이다.
    expect(screen.queryByTestId('composer-typing')).toBeNull();
  });
});

/** 호스트 `Text`의 글(안쪽 `Text`까지 이어 붙인 것). */
function textOf(node: {props: {children?: unknown}}): string {
  const walk = (child: unknown): string =>
    typeof child === 'string' || typeof child === 'number'
      ? String(child)
      : Array.isArray(child)
        ? child.map(walk).join('')
        : child && typeof child === 'object' && 'props' in child
          ? walk((child as {props: {children?: unknown}}).props.children)
          : '';
  return walk(node.props.children);
}

describe('M-4 — 이름에 눈에 보이는 축을 준다', () => {
  it('이름 조각만 다르게 칠한다', () => {
    render(<TypingBar segments={typingVisualSegments(['김민수'])} />);
    // 이름은 자기 `Text` 를 갖고, 나머지는 부모의 잉크를 쓴다.
    const name = screen.getByText('김민수');
    expect(flatten(name.props.style).color).toBe(color.text);
  });

  it('문장을 짓지 않는다 — 화면 조각을 잇지도 않는다', () => {
    // 「작성 중」이라는 낱말도, 「님이」라는 조사도 이 파일에 없다. 전부 코어가
    // 지은 조각으로 들어온다.
    const code = codeOnly(SRC);
    expect(code).not.toContain('작성 중');
    expect(code).not.toContain('님이');
    expect(code).not.toContain('작업');
    // #4797: 화면은 이름 + 점 + 서술어로 나뉜다. 낭독 라벨의 fallback join은
    // 허용하되, 보이는 조각은 여전히 합치지 않아 이름 강조·한 줄 배치를 보존한다.
    const visibleStart = code.indexOf('{!empty ? (');
    expect(visibleStart).toBeGreaterThan(-1);
    const visible = code.slice(visibleStart);
    expect(visible).not.toMatch(/\.join\(/);
  });

  it('한 줄이다 — 읽던 자리를 밀어내지 않는다', () => {
    render(<TypingBar segments={typingVisualSegments(['김민수', '이하늘'])} />);
    // #4797: 바깥은 점을 함께 담는 View, 한 줄 제한은 이름 칸 Text가 진다.
    expect(flatten(line().props.style).flexDirection).toBe('row');
    expect(flatten(screen.getByText(' 작성 중').props.style).flexShrink).toBe(0);
  });

  it('둘이면 이름마다 자기 한 줄 칸에서 줄어든다 — 첫 이름이 길어도 둘째 사람이 남는다 (#5582 R2-M1)', () => {
    render(<TypingBar segments={typingVisualSegments(['김민수 프로덕트디자인 리드 겸 서비스기획 총괄', '이하늘'])} />);
    // 앞 판은 「A, B」가 한 줄 제한 Text 하나라 넘치면 뒤 이름부터 잘렸다. 이제 이름 칸이 둘이고, 각자 한 줄 제한·줄어듦이다.
    const cells = screen.getAllByTestId('composer-typing-name');
    // 두 이름은 서로의 안에 있지 않다(한쪽이 줄어도 다른 쪽을 끌고 가지 않는다). 쉼표는 첫 이름 칸 안이라 함께 잘린다.
    expect(cells.map(cell => textOf(cell))).toEqual(['김민수 프로덕트디자인 리드 겸 서비스기획 총괄,', '이하늘']);
    for (const cell of cells) {
      expect(cell.props.numberOfLines).toBe(1);
      expect(flatten(cell.props.style).flexShrink).toBe(1);
    }
    expect(screen.queryByText('김민수 프로덕트디자인 리드 겸 서비스기획 총괄, 이하늘')).toBeNull();
    // 칸 안에서도 이름만 사람 잉크로 굵다.
    expect(flatten(screen.getByText('김민수 프로덕트디자인 리드 겸 서비스기획 총괄').props.style).fontWeight).toBe('700');
    expect(flatten(screen.getByText(',').props.style ?? {}).fontWeight).toBeUndefined();
  });

  it('세 명부터 첫 이름 외 N명으로 접고, 낭독은 전체 인원수를 말한다', () => {
    // #4797 owner 요청: 화면은 첫 이름 + 외 N명, 기존 낭독 집계 문장은 유지한다.
    render(
      <TypingBar
        segments={typingVisualSegments(['김민수', '이하늘', '박도윤'])}
        label={typingLabel(['김민수', '이하늘', '박도윤'])}
      />,
    );
    // 이름 칸 「김민수」 + 줄지 않는 칸 「 외 2명」(#5582: 이름만 줄어든다).
    expect(screen.getByText('김민수')).toBeTruthy();
    expect(flatten(screen.getByText(' 외 2명').props.style).flexShrink).toBe(0);
    expect(flatten(screen.getByText('김민수').props.style).color).toBe(color.text);
    expect(screen.queryByText('이하늘')).toBeNull();
    expect(screen.queryByText('박도윤')).toBeNull();
    expect(line().props.accessibilityLabel).toBe('3명이 작성 중');
  });
});

describe('점 색 — 사람의 줄은 에이전트 색을 쓰지 않는다 (#5645, #5582 검수 M3)', () => {
  it('「작성 중」 줄의 점은 글자와 같은 흐린 잉크다', () => {
    // 폰은 「작업 중」(에이전트)과 「작성 중」(사람)이 컴포저 위에 붙어 선다. 앞 판은 두 줄의 점이 같은 에이전트 색이었다.
    render(<TypingBar segments={typingVisualSegments(['김민수'])} />);
    const dots = screen.getAllByTestId(/^responding-dot-/, {includeHiddenElements: true});
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(flatten(dot.props.style).backgroundColor).toBe(color.textMuted);
      expect(flatten(dot.props.style).backgroundColor).not.toBe(color.agent);
    }
    // 꼬리 글과 같은 잉크다.
    expect(flatten(screen.getByText(' 작성 중').props.style).color).toBe(color.textMuted);
  });
});

// ---- 두 이름이 넘칠 때 (#5645, #5582 검수 M1) ------------------------------------------------
//
// 앞 판은 이름 칸마다 `flexShrink: 1` 이라 Yoga 가 넘친 폭을 글 폭에 비례해 나눴다 — 390 폭에서 긴(309) + 짧은(31)이면
// 짧은 이름이 28 로 줄어 세 글자 이름이 「이…」가 됐다(Yoga 계산). 이 판은 줄 폭과 조각마다의 제 폭을 재고(거울), 웹과 같은
// 규칙(남는 폭을 똑같이 나누되 글 폭에서 멈춤)으로 이름 칸에 명시 폭을 준다. 제스트에는 Yoga 가 없어서 여기서는 화면이 받는
// 잰 값(onLayout)을 직접 주고, 그 값으로 화면이 이름 칸에 **실제로 준 폭**을 숫자로 잰다. 같은 구조를 Yoga 로 그린 대조는
// 인계 노트의 Yoga 표다(앞 판 28.0/31 재현 → 이 판 31.0/31).

const SHORT_NAME = '오민재';
const LONG_NAME = '한지후 플랫폼엔지니어링 리드 겸 인프라 운영 총괄';
const LONG_NAME_B = '윤서아 프로덕트디자인 리드 겸 서비스기획 총괄';
/** 잰 폭(pt, 12pt 굵은 한글 ≈ 10.3pt/자 근사 — dr5582 Yoga 계산과 같은 수). */
const W = {long: 309, longB: 280, short: 31, comma: 3, space: 3.4, tail: 40} as const;

/** 화면이 받는 잰 값 하나를 준다(onLayout). */
function giveLayout(testID: string, width: number): void {
  fireEvent(screen.getByTestId(testID, {includeHiddenElements: true}), 'layout', {
    nativeEvent: {layout: {x: 0, y: 0, width, height: 16}},
  });
}

/** 줄을 폭 `lineWidth` 에 세우고, 거울의 조각(앞부분 칸 순서대로 + 꼬리)마다 제 폭을 준다. */
function layLine(lineWidth: number, cellWidths: readonly number[], tailWidth: number = W.tail): void {
  giveLayout('composer-typing', lineWidth);
  cellWidths.forEach((width, index) => giveLayout(`composer-typing-measure-${index}`, width));
  giveLayout('composer-typing-measure-tail', tailWidth);
}

/** 보이는 이름 칸들이 받은 명시 폭(없으면 undefined — 앞 판처럼 제 폭으로 선다). */
function nameCellWidths(): unknown[] {
  return screen.getAllByTestId('composer-typing-name').map(cell => flatten(cell.props.style).width);
}

/** 이 줄의 실제 스타일에서 읽은 「이름 아닌 것」의 폭 — 셈이 구조와 갈라지면 여기서 드러난다. */
function roomFromRenderedLine(lineWidth: number, textWidths: readonly number[]): number {
  const style = flatten(line().props.style);
  const dots = screen.getAllByTestId(/^responding-dot-/, {includeHiddenElements: true});
  const dotRow = flatten(screen.getByTestId('responding-dots', {includeHiddenElements: true}).props.style);
  const dotsWidth =
    dots.reduce((sum, dot) => sum + Number(flatten(dot.props.style).width), 0) +
    (dots.length - 1) * Number(dotRow.gap);
  return (
    lineWidth -
    2 * Number(style.paddingHorizontal) -
    2 * Number(style.columnGap) -
    dotsWidth -
    W.tail -
    textWidths.reduce((sum, width) => sum + width, 0)
  );
}

describe('두 이름이 넘치면 짧은 이름은 온전히 남고 긴 이름만 준다 (#5645, 웹 typing-names 와 같은 규칙)', () => {
  it('나누는 규칙: 똑같이 나누되 자기 글 폭에서 멈추고, 멈춘 몫은 남은 이름이 받는다', () => {
    // (소수 폭은 빼는 순서에 따라 끝자리가 갈려서 10 자리까지 본다. 짧은 이름의 31 은 정확히 같아야 한다.)
    const near = (value: number) => expect.closeTo(value, 10);
    expect(shareTypingNameWidths([309, 31], 286.6)).toEqual([near(255.6), 31]);
    expect(shareTypingNameWidths([31, 309], 286.6)).toEqual([31, near(255.6)]);
    expect(shareTypingNameWidths([309, 280], 286.6)).toEqual([near(143.3), near(143.3)]);
    // 둘 다 조금씩 넘치면 반씩이다(짧은 쪽도 반보다 길면 준다 — 웹과 같다).
    expect(shareTypingNameWidths([150, 160], 286.6)).toEqual([near(143.3), near(143.3)]);
    // 다 들어가면 아무 칸도 줄이지 않는다.
    expect(shareTypingNameWidths([120, 120], 286.6)).toBeNull();
    // 자리가 아예 없으면 0 이다(음수 폭을 주지 않는다).
    expect(shareTypingNameWidths([309, 31], -5)).toEqual([0, 0]);
  });

  it('셈에 쓰는 「이름 아닌 것」의 폭이 줄의 실제 스타일과 같다 — 여백 · 칸 사이 · 점', () => {
    render(<TypingBar segments={typingVisualSegments([LONG_NAME, SHORT_NAME])} />);
    expect(typingNameRoom(390, W.tail, [W.space])).toBe(roomFromRenderedLine(390, [W.space]));
    expect(RESPONDING_DOTS_WIDTH).toBe(3 * 4 + 2 * space.xs);
    expect(flatten(line().props.style).paddingHorizontal).toBe(SAFE_GUTTER);
  });

  it.each([
    [390, '긴+짧', [LONG_NAME, SHORT_NAME], [W.long + W.comma, W.space, W.short], 1],
    [320, '긴+짧', [LONG_NAME, SHORT_NAME], [W.long + W.comma, W.space, W.short], 1],
    [375, '짧+긴', [SHORT_NAME, LONG_NAME], [W.short + W.comma, W.space, W.long], 0],
  ] as const)('폭 %i, %s: 짧은 이름 칸은 제 폭 그대로이고 긴 이름이 남은 몫을 다 받는다', (lineWidth, _order, names, cellWidths, shortAt) => {
    render(<TypingBar segments={typingVisualSegments([...names])} />);
    // 재기 전(첫 프레임)에는 명시 폭이 없다 — 앞 판과 같은 배치다.
    expect(nameCellWidths()).toEqual([undefined, undefined]);
    layLine(lineWidth, cellWidths);
    const widths = nameCellWidths() as number[];
    const room = roomFromRenderedLine(lineWidth, [W.space]);
    const shortNatural = cellWidths[shortAt === 0 ? 0 : 2];
    const longAt = shortAt === 0 ? 1 : 0;
    // 짧은 이름은 온전하다(앞 판 Yoga: 31 중 27~28).
    expect(widths[shortAt]).toBe(shortNatural);
    // 긴 이름이 나머지를 다 받는다 — 두 칸 합이 이름 몫과 같다(꼬리 「작성 중」은 안 잘린다).
    expect(widths[longAt]).toBeCloseTo(room - shortNatural, 10);
    expect(widths[0] + widths[1]).toBeCloseTo(room, 10);
  });

  it('긴+긴: 반씩 나눈다 — 둘째 사람도 줄에 남는다', () => {
    render(<TypingBar segments={typingVisualSegments([LONG_NAME, LONG_NAME_B])} />);
    layLine(390, [W.long + W.comma, W.space, W.longB]);
    const widths = nameCellWidths() as number[];
    const room = roomFromRenderedLine(390, [W.space]);
    expect(widths[0]).toBeCloseTo(room / 2, 10);
    expect(widths[1]).toBeCloseTo(room / 2, 10);
  });

  it('다 들어가면 명시 폭이 없다 — 이름이 제 폭으로 선다', () => {
    render(<TypingBar segments={typingVisualSegments([SHORT_NAME, '정하린'])} />);
    layLine(390, [W.short + W.comma, W.space, W.short]);
    expect(nameCellWidths()).toEqual([undefined, undefined]);
  });

  it('한 이름(「A」·「A 외 N명」)은 재지 않는다 — 줄어드는 칸이 하나라 앞 판 그대로가 같은 답이다', () => {
    const {rerender} = render(<TypingBar segments={typingVisualSegments([LONG_NAME])} />);
    expect(screen.queryByTestId('composer-typing-measure', {includeHiddenElements: true})).toBeNull();
    rerender(<TypingBar segments={typingVisualSegments([LONG_NAME, SHORT_NAME, '정하린'])} />);
    expect(screen.queryByTestId('composer-typing-measure', {includeHiddenElements: true})).toBeNull();
  });

  it('재는 거울은 흐름 밖이고 보이지도 · 읽히지도 · 눌리지도 않는다', () => {
    render(<TypingBar segments={typingVisualSegments([LONG_NAME, SHORT_NAME])} />);
    const mirror = screen.getByTestId('composer-typing-measure', {includeHiddenElements: true});
    const style = flatten(mirror.props.style);
    expect(style.position).toBe('absolute');
    expect(style.opacity).toBe(0);
    expect(mirror.props.accessibilityElementsHidden).toBe(true);
    expect(mirror.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(mirror.props.pointerEvents).toBe('none');
    // 기본 쿼리(보조기술이 보는 트리)에는 이름이 한 번만 있다.
    expect(screen.getAllByText(SHORT_NAME)).toHaveLength(1);
  });

  it('거울의 조각은 하나도 줄지 않는다 — 칸 높이에 묶인 그릇에서 이름 조각이 높이 0 으로 눌려 재이지 않게', () => {
    // 그릇은 칸(16~25.6) 높이에 묶이고 조각 넷(이름 둘 · 빈칸 · 꼬리)이 세로로 쌓인다. 이름 칸 옷(`flexShrink: 1`)을 그대로
    // 입으면 Yoga 가 이름 조각을 높이 0 으로 누른다(yoga-mirror5645 계산) — 그때 잰 폭이 0 이면 나누기가 조용히 꺼진다.
    render(<TypingBar segments={typingVisualSegments([LONG_NAME, SHORT_NAME])} />);
    const pieces = [0, 1, 2, 'tail'].map(at =>
      screen.getByTestId(`composer-typing-measure-${at}`, {includeHiddenElements: true}),
    );
    for (const piece of pieces) expect(flatten(piece.props.style).flexShrink).toBe(0);
    // 보이는 이름 칸은 그대로 줄 수 있다(재기 전 앞 판 배치의 줄임).
    for (const cell of screen.getAllByTestId('composer-typing-name')) {
      expect(flatten(cell.props.style).flexShrink).toBe(1);
    }
  });

  it('이름이 바뀌면 바뀐 조각만 다시 잰다 — 남은 조각의 잰 값은 그대로 쓴다', () => {
    const {rerender} = render(<TypingBar segments={typingVisualSegments([LONG_NAME, SHORT_NAME])} />);
    layLine(390, [W.long + W.comma, W.space, W.short]);
    // 둘째 사람이 바뀐다. 첫 칸 「긴 이름,」·빈칸·꼬리는 같은 글이라 onLayout 이 다시 오지 않는다(Fabric 은 바뀐 틀만 알린다).
    rerender(<TypingBar segments={typingVisualSegments([LONG_NAME, '정하린'])} />);
    expect(nameCellWidths()).toEqual([undefined, undefined]);
    giveLayout('composer-typing-measure-2', 30);
    const widths = nameCellWidths() as number[];
    expect(widths[1]).toBe(30);
    expect(widths[0]).toBeCloseTo(roomFromRenderedLine(390, [W.space]) - 30, 10);
  });
});

describe('거울은 보이는 칸과 같은 옷으로 그린다 — 굵기·크기 상한이 다르면 잰 폭이 좁아져 이름이 잘린다 (#5719)', () => {
  /** 칸 안의 글 조각(이름 조각 · 쉼표 조각)들이 입은 옷. 칸 자신의 `flexShrink` · `width` 는 거울과 보이는 칸이 일부러 다르다. */
  function dressOf(cell: {props: Record<string, unknown>; findAll: (match: (node: any) => boolean) => any[]}) {
    const inner = cell.findAll(node => node.type === 'Text' && node !== cell);
    return {
      cap: cell.props.maxFontSizeMultiplier,
      lines: cell.props.numberOfLines,
      pieces: inner.map(node => flatten(node.props.style)),
    };
  }

  it('이름 칸마다 거울 조각의 안쪽 조각 옷 · 글자 상한 · 줄 수가 보이는 칸과 같고, 이름은 굵다', () => {
    render(<TypingBar segments={typingVisualSegments([LONG_NAME, SHORT_NAME])} />);
    const visible = screen.getAllByTestId('composer-typing-name');
    expect(visible).toHaveLength(2);
    // 이름 칸의 자리는 앞부분 칸 순서(이름 · 빈칸 · 이름)에서 0 과 2 다.
    [0, 2].forEach((at, order) => {
      const mirror = screen.getByTestId(`composer-typing-measure-${at}`, {includeHiddenElements: true});
      const seen = dressOf(visible[order]);
      const mirrored = dressOf(mirror);
      expect(mirrored).toEqual(seen);
      // 같다는 것이 빈 것끼리 같다가 아니다: 이름 조각이 실제로 있고 굵다(굵은 한글이 더 넓어서 폭이 달라진다).
      expect(seen.pieces.some(piece => piece.fontWeight === '700')).toBe(true);
      expect(mirrored.pieces.some(piece => piece.fontWeight === '700')).toBe(true);
      expect(mirrored.cap).toBe(1.6);
      expect(mirrored.lines).toBe(1);
    });
  });
});

describe('잰 폭 기억은 쌓이지 않는다 — 지금 줄에 없는 조각은 잊는다 (#5719)', () => {
  it('둘째 사람이 바뀌어 새로 잰 뒤 옛 사람으로 돌아오면 옛 잰 값을 쓰지 않고 다시 잰다', () => {
    const {rerender} = render(<TypingBar segments={typingVisualSegments([LONG_NAME, SHORT_NAME])} />);
    layLine(390, [W.long + W.comma, W.space, W.short]);
    // 먼저 짧은 이름의 잰 값이 실제로 쓰이고 있다(기억이 비어서 통과하지 않는다).
    expect((nameCellWidths() as number[])[1]).toBe(W.short);
    rerender(<TypingBar segments={typingVisualSegments([LONG_NAME, '정하린'])} />);
    giveLayout('composer-typing-measure-2', 30);
    expect((nameCellWidths() as number[])[1]).toBe(30);
    // 옛 사람으로 돌아온다. 그 사이 새로 잰 조각만 남기고 옛 조각은 잊었으니, 다시 잴 때까지 명시 폭이 없다.
    rerender(<TypingBar segments={typingVisualSegments([LONG_NAME, SHORT_NAME])} />);
    expect(nameCellWidths()).toEqual([undefined, undefined]);
  });
});

describe('M-6 — 이 줄이 AA 를 지난다', () => {
  it('textFaint 를 쓰지 않는다', () => {
    // 실측: textFaint on bg = 3.562:1 (본문 AA 4.5 미달) · textMuted = 6.358:1.
    // 토큰 전면 재조정은 U2 소관이고 여기서는 **용례만** 옮긴다.
    render(<TypingBar segments={typingVisualSegments(['김민수'])} />);
    // #4797: View에는 글자색이 없다. 실제 서술어 Text의 잉크를 잰다.
    const style = flatten(screen.getByText(' 작성 중').props.style);
    expect(style.color).toBe(color.textMuted);
    expect(style.color).not.toBe(color.textFaint);
  });
});

describe('N-4 — 무동작인 방어를 남겨 두지 않는다', () => {
  it('accessibilityLiveRegion 이 없다', () => {
    // 그 prop 은 **안드로이드 전용**이라 iOS 에서 아무 일도 하지 않는다. 즉 첫
    // 판의 주석은 이 플랫폼에서 참인 적이 없었다. 무동작인 채 주석만 남으면
    // 다음 사람이 그 방어가 서 있다고 믿는다.
    render(<TypingBar segments={typingVisualSegments(['김민수'])} />);
    expect(
      screen.getByTestId('composer-typing').props.accessibilityLiveRegion,
    ).toBeUndefined();
    expect(codeOnly(SRC)).not.toContain('accessibilityLiveRegion');
  });

  it('보조기술 라벨은 여전히 말줄임표가 없다', () => {
    render(
      <TypingBar
        segments={typingVisualSegments(['김민수'])}
        label={typingLabel(['김민수'])}
      />,
    );
    const label: string =
      screen.getByTestId('composer-typing').props.accessibilityLabel;
    expect(label).not.toContain('…');
  });
});

describe('M-5 — 같은 질문에 답하는 두 줄이 붙어 있다', () => {
  it('작성 중이 작업 중 바로 아래다', () => {
    // 그 사이에 중단 영수증과 롱프레스 힌트가 끼면, 나란히 두는 것만으로 얻으려던
    // 대조(작성 중 ↔ 작업 중)가 끊긴다.
    const code = codeOnly(SCREEN);
    const activity = code.indexOf('<ConversationActivityRail');
    const typing = code.indexOf('<TypingBar');
    const receipt = code.indexOf('stopOutcome ? (');
    const hint = code.indexOf('<LongPressHint');
    expect(activity).toBeGreaterThan(-1);
    expect(typing).toBeGreaterThan(activity);
    // 그리고 그 둘 사이에 아무것도 없다.
    expect(receipt).toBeGreaterThan(typing);
    expect(hint).toBeGreaterThan(typing);
  });
});
