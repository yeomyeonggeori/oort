import {
  typingSegments,
  typingLabel,
} from '@momo/core/features/chat/typing';
import {cleanup, render, screen} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import {color} from '../src/design/tokens';
import {TypingBar} from '../src/features/conversation/TypingBar';

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
    expect(flatten(line().props.style).minHeight).toBeGreaterThan(0);
  });

  it('예약 높이는 1줄이다 — 두 줄을 예약하면 정말로 빈 띠가 생긴다', () => {
    render(<TypingBar segments={[]} />);
    // lineHeight 한 줄 + 아래 여백. 두 줄치(32+)를 예약하지 않는다.
    expect(flatten(line().props.style).minHeight).toBeLessThan(32);
  });

  it('있을 때와 없을 때의 높이가 같다 — 그것이 「안 움직인다」의 뜻이다', () => {
    const {rerender} = render(<TypingBar segments={[]} />);
    const emptyStyle = flatten(line().props.style);
    rerender(<TypingBar segments={typingSegments(['김민수'])} />);
    const fullStyle = flatten(line().props.style);
    expect(fullStyle.minHeight).toBe(emptyStyle.minHeight);
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

describe('M-4 — 이름에 눈에 보이는 축을 준다', () => {
  it('이름 조각만 다르게 칠한다', () => {
    render(<TypingBar segments={typingSegments(['김민수'])} />);
    // 이름은 자기 `Text` 를 갖고, 나머지는 부모의 잉크를 쓴다.
    const name = screen.getByText('김민수');
    expect(flatten(name.props.style).color).toBe(color.text);
  });

  it('문장을 짓지 않는다 — 조각을 잇지도 않는다', () => {
    // 「작성 중」이라는 낱말도, 「님이」라는 조사도 이 파일에 없다. 전부 코어가
    // 지은 조각으로 들어온다.
    const code = codeOnly(SRC);
    expect(code).not.toContain('작성 중');
    expect(code).not.toContain('님이');
    expect(code).not.toContain('작업');
    // 조각을 `join` 하지도 않는다 — 순서대로 그릴 뿐이다.
    expect(code).not.toMatch(/segments[\s\S]{0,40}\.join\(/);
  });

  it('한 줄이다 — 읽던 자리를 밀어내지 않는다', () => {
    render(<TypingBar segments={typingSegments(['김민수', '이하늘'])} />);
    expect(screen.getByTestId('composer-typing').props.numberOfLines).toBe(1);
  });

  it('집계 문구에는 이름 조각이 없다 — 강조할 이름이 애초에 없다', () => {
    render(
      <TypingBar segments={typingSegments(['김민수', '이하늘', '박도윤'])} />,
    );
    expect(screen.getByText(/3명이 작성 중/)).toBeTruthy();
  });
});

describe('M-6 — 이 줄이 AA 를 지난다', () => {
  it('textFaint 를 쓰지 않는다', () => {
    // 실측: textFaint on bg = 3.562:1 (본문 AA 4.5 미달) · textMuted = 6.358:1.
    // 토큰 전면 재조정은 U2 소관이고 여기서는 **용례만** 옮긴다.
    render(<TypingBar segments={typingSegments(['김민수'])} />);
    const style = flatten(screen.getByTestId('composer-typing').props.style);
    expect(style.color).toBe(color.textMuted);
    expect(style.color).not.toBe(color.textFaint);
  });
});

describe('N-4 — 무동작인 방어를 남겨 두지 않는다', () => {
  it('accessibilityLiveRegion 이 없다', () => {
    // 그 prop 은 **안드로이드 전용**이라 iOS 에서 아무 일도 하지 않는다. 즉 첫
    // 판의 주석은 이 플랫폼에서 참인 적이 없었다. 무동작인 채 주석만 남으면
    // 다음 사람이 그 방어가 서 있다고 믿는다.
    render(<TypingBar segments={typingSegments(['김민수'])} />);
    expect(
      screen.getByTestId('composer-typing').props.accessibilityLiveRegion,
    ).toBeUndefined();
    expect(codeOnly(SRC)).not.toContain('accessibilityLiveRegion');
  });

  it('보조기술 라벨은 여전히 말줄임표가 없다', () => {
    render(
      <TypingBar
        segments={typingSegments(['김민수'])}
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
    const activity = code.indexOf('<AgentActivityBar');
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
