// 온보딩 2.0 공통 틀의 폰 짝 (#2807 OB2-1): KomettoGuide · OnboardingDots · 바닥.
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';
import {
  KOMETTO_EXPRESSIONS,
  ONBOARDING_DOT_ROLES,
  onboardingDots,
  type KomettoExpression,
} from '@momo/core/features/onboarding/guide';

import {FixedScheme, type ColorScheme} from '../src/design/theme';
import {DS2_ROLE_MAP, lightPalette, darkPalette} from '../src/design/tokens';
import {KOMETTO_EXPRESSION_ASSETS} from '../src/features/onboarding/komettoExpressions';
import {
  KomettoGuide,
  ONBOARDING,
  OnboardingCanvas,
  OnboardingDots,
} from '../src/features/onboarding/KomettoGuide';

function wrap(node: React.ReactElement, scheme: ColorScheme = 'light') {
  return <FixedScheme scheme={scheme}>{node}</FixedScheme>;
}

async function settle() {
  // useReduceMotion 의 첫 답(Promise)을 흘려보낸다.
  await act(async () => {
    await Promise.resolve();
  });
}

// 얼굴은 VoiceOver에서 숨긴 장식이라 기본 질의가 못 본다.
const HIDDEN = {includeHiddenElements: true} as const;

let reduce = false;
beforeEach(() => {
  reduce = false;
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() => Promise.resolve(reduce));
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function guide(expression: KomettoExpression, line = '데스크탑의 QR을 찍어 연결해요.') {
  return wrap(<KomettoGuide expression={expression} line={line} />);
}

describe('KomettoGuide (폰)', () => {
  it('draws a 72 head, a decorative face, and one spoken sentence', async () => {
    render(
      wrap(
        <KomettoGuide
          expression="idle"
          line="데스크탑의 QR을 찍어 연결해요."
          detail="데스크탑 설정 › 기기 › 폰 연결에 있어요."
          header
        />,
      ),
    );
    await settle();
    const face = screen.getByTestId('kometto-face', HIDDEN);
    const faceStyle = StyleSheet.flatten(face.props.style);
    expect([faceStyle.width, faceStyle.height]).toEqual([72, 72]);
    expect(face.props.accessibilityElementsHidden).toBe(true);
    expect(face.props.importantForAccessibility).toBe('no-hide-descendants');
    const bubble = screen.getByTestId('kometto-guide-bubble');
    expect(bubble.props.accessibilityRole).toBe('header');
    expect(bubble.props.accessibilityLabel).toBe(
      '데스크탑의 QR을 찍어 연결해요. 데스크탑 설정 › 기기 › 폰 연결에 있어요.',
    );
    // 첫 그림은 알리지 않는다(읽는 순서대로 한 번 읽힌다).
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
  });

  it('uses the mockup bubble: surface, 18/18/18/6, 12·16, 16/600', async () => {
    render(guide('idle'));
    await settle();
    const bubble = StyleSheet.flatten(screen.getByTestId('kometto-guide-bubble').props.style);
    expect(bubble.backgroundColor).toBe(lightPalette.surface);
    expect([
      bubble.borderTopLeftRadius,
      bubble.borderTopRightRadius,
      bubble.borderBottomRightRadius,
      bubble.borderBottomLeftRadius,
    ]).toEqual([18, 18, 18, 6]);
    expect([bubble.paddingVertical, bubble.paddingHorizontal]).toEqual([12, 16]);
    const line = StyleSheet.flatten(screen.getByTestId('kometto-guide-line').props.style);
    expect([line.fontSize, line.fontWeight]).toEqual([16, '600']);
  });

  it('draws the phone hero at 200', async () => {
    render(wrap(<KomettoGuide expression="happy" line="반가워요." size="hero" />));
    await settle();
    const face = StyleSheet.flatten(screen.getByTestId('kometto-face', HIDDEN).props.style);
    expect(face.width).toBe(ONBOARDING.hero);
    expect(ONBOARDING.hero).toBe(200);
  });

  it('refuses an expression without a sentence', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(guide('thinking', ''))).toThrow(/needs a line/);
    expect(() => render(guide('thinking', '   '))).toThrow(/needs a line/);
    spy.mockRestore();
  });

  it('crossfades in place on a change and announces the new sentence once', async () => {
    const view = render(guide('thinking', '이 서버를 확인하고 있어요.'));
    await settle();
    expect(screen.queryByTestId('kometto-face-leaving', HIDDEN)).toBeNull();
    view.rerender(guide('happy', '연결됐어요.'));
    expect(screen.getByTestId('kometto-face-leaving', HIDDEN)).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('연결됐어요.');
  });

  it('has no leaving layer and no wag under 동작 줄이기', async () => {
    reduce = true;
    const view = render(guide('thinking', '이 서버를 확인하고 있어요.'));
    await settle();
    view.rerender(guide('happy', '연결됐어요.'));
    expect(screen.queryByTestId('kometto-face-leaving', HIDDEN)).toBeNull();
    const face = StyleSheet.flatten(screen.getByTestId('kometto-face', HIDDEN).props.style);
    expect(face.transform).toBeUndefined();
  });

  it('wags on the change into happy, not on a happy first paint', async () => {
    const view = render(guide('happy', '반가워요.'));
    await settle();
    expect(StyleSheet.flatten(screen.getByTestId('kometto-face', HIDDEN).props.style).transform).toBeUndefined();
    view.rerender(guide('thinking', '확인하고 있어요.'));
    view.rerender(guide('happy', '찾았어요.'));
    expect(StyleSheet.flatten(screen.getByTestId('kometto-face', HIDDEN).props.style).transform).toBeDefined();
  });
});

describe('OnboardingDots (폰)', () => {
  it('draws nothing on the first screen', () => {
    render(wrap(<OnboardingDots dots={onboardingDots('claim', 'welcome')} />));
    expect(screen.queryByTestId('onboarding-dots')).toBeNull();
  });

  it.each([
    ['light', lightPalette],
    ['dark', darkPalette],
  ] as const)('bar signal, done ink-muted, rest line-strong, hidden sentence (%s)', (scheme, palette) => {
    render(wrap(<OnboardingDots dots={onboardingDots('claim', 'workspace-profile')} />, scheme));
    const row = screen.getByTestId('onboarding-dots');
    expect(row.props.accessibilityLabel).toBe('4단계 중 2단계');
    const current = StyleSheet.flatten(screen.getByTestId('onboarding-dot-current').props.style);
    expect([current.width, current.height, current.backgroundColor]).toEqual([26, 6, palette.accent]);
    const done = StyleSheet.flatten(screen.getByTestId('onboarding-dot-done').props.style);
    expect([done.width, done.backgroundColor]).toEqual([6, palette.textMuted]);
    const todo = screen.getAllByTestId('onboarding-dot-todo');
    expect(todo).toHaveLength(2);
    expect(StyleSheet.flatten(todo[0].props.style).backgroundColor).toBe(palette.textFaint);
    // 세 색이 core 표(ONBOARDING_DOT_ROLES)의 역할과 같다: accent=signal, textMuted=ink-muted, textFaint=line-strong.
    expect(DS2_ROLE_MAP.accent).toBe(ONBOARDING_DOT_ROLES.current);
    expect(DS2_ROLE_MAP.textMuted).toBe(ONBOARDING_DOT_ROLES.done);
    expect(DS2_ROLE_MAP.textFaint).toBe(ONBOARDING_DOT_ROLES.todo);
  });
});

describe('바닥과 매핑 (폰)', () => {
  it('paints the dawn-sky canvas at 180° with the phone stop 46%', () => {
    render(wrap(<OnboardingCanvas />));
    const style = StyleSheet.flatten(screen.getByTestId('onboarding-canvas').props.style);
    expect(style.experimental_backgroundImage).toBe(
      `linear-gradient(180deg, ${lightPalette.canvasTop} 0%, ${lightPalette.bg} 46%, ${lightPalette.canvasBottom} 100%)`,
    );
    expect(style.backgroundColor).toBe(lightPalette.bg);
  });

  it('maps every expression id to a picture in one place', () => {
    expect(Object.keys(KOMETTO_EXPRESSION_ASSETS).sort()).toEqual([...KOMETTO_EXPRESSIONS].sort());
  });
});
