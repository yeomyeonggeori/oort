import {SESSION_STATUS_CLASS} from '@momo/core/features/work/workSessionFormat';
import {
  workSessionStatus,
  type WorkSessionStatusKey,
} from '@momo/core/features/work/workSessionModel';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import {FixedScheme, type ColorScheme} from '../src/design/theme';
import {darkPalette, lightPalette, type Palette} from '../src/design/tokens';
import {WorkStatusBadge} from '../src/features/work/WorkSessionParts';

// =============================================================================
// 폰의 수명주기 칩이 웹과 같은 답을 낸다 (#1491).
//
// 두 클라는 색 표를 공유하지 않는다 — 웹은 CSS 유틸리티(`SESSION_STATUS_CLASS`),
// 폰은 `StyleSheet` 다. 공유하는 것은 **역할**이고, 그래서 이 파일이 비교하는 것도
// 값이 아니라 역할이다: 코어 표가 종료됨에서 초록을 거둔 뒤 폰이 그대로 초록을
// 들고 있으면, 같은 원장의 같은 상태가 기기에 따라 다른 낱말을 쓰게 된다.
//
// 초록을 거둔 근거는 코어 독스트링에 있다: 「멈췄다」는 그 행에서 가장 정보가 없는
// 사실이고, 정보가 있는 초록(게이트 통과)은 검증 칩이 진다(#1441). 그 근거가 폰에도
// 그대로 적용되므로 폰도 같은 날 같은 자리를 내렸다.
//
// 잣대를 코어 문자열에서 **끌어오는** 이유: 다음 사람이 웹 표를 되돌리면 이 파일이
// 함께 빨개져야 한다. 폰에 기대값을 따로 적어 두면 두 표가 갈라진 날 둘 다 초록이다.
// =============================================================================

/** 웹의 잉크 유틸리티 -> 폰 팔레트의 같은 역할. 값이 아니라 역할의 대응이다. */
const INK_ROLE: Readonly<Record<string, (color: Palette) => string>> = {
  'text-ink-muted': color => color.textMuted,
  'text-warn': color => color.warn,
  'text-accent': color => color.accentText,
  'text-ok': color => color.ok,
};

const KEYS: readonly WorkSessionStatusKey[] = [
  'running',
  'idle',
  'unavailable',
  'orphaned',
  'done',
  'unknown',
];

const SCHEMES: readonly [ColorScheme, Palette][] = [
  ['light', lightPalette],
  ['dark', darkPalette],
];

function coreInk(key: WorkSessionStatusKey): string {
  const ink = SESSION_STATUS_CLASS[key]
    .split(/\s+/)
    .find(cls => cls.startsWith('text-'));
  if (ink === undefined) {
    throw new Error(`${key} 에 잉크 유틸리티가 없다: ${SESSION_STATUS_CLASS[key]}`);
  }
  return ink;
}

interface Tone {
  text: string;
  background: string;
  border: string;
}

/**
 * 두 스킴 × 여섯 상태를 **한 번에** 그린다. 렌더를 테스트당 하나로 두는 것이 이
 * 하네스의 규율이고(다른 스위트도 그렇다), 스킴이 컨텍스트라서 두 판을 나란히
 * 세우는 것으로 충분하다.
 */
function renderAllBadges(): (key: WorkSessionStatusKey, scheme: ColorScheme) => Tone {
  render(
    <>
      {SCHEMES.map(([scheme]) => (
        <FixedScheme key={scheme} scheme={scheme}>
          {KEYS.map(key => (
            <WorkStatusBadge
              key={key}
              status={{key, label: `${scheme}-${key}`}}
              testID={`status-${scheme}-${key}`}
            />
          ))}
        </FixedScheme>
      ))}
    </>,
  );
  return (key, scheme) => {
    const text = StyleSheet.flatten(
      screen.getByText(`${scheme}-${key}`).props.style,
    );
    const box = StyleSheet.flatten(
      screen.getByTestId(`status-${scheme}-${key}`).props.style,
    );
    return {
      text: String(text.color),
      background: String(box.backgroundColor),
      border: String(box.borderColor),
    };
  };
}

afterEach(cleanup);

describe('종료된 세션은 폰에서도 초록을 벗는다 (#1491)', () => {
  it('코어가 종료됨을 muted 라 부르고, 폰의 칩이 두 스킴 모두 그 역할대로 선다', () => {
    expect(coreInk('done')).toBe('text-ink-muted');
    const tone = renderAllBadges();
    for (const [scheme, palette] of SCHEMES) {
      expect({scheme, ink: tone('done', scheme).text}).toEqual({
        scheme,
        ink: palette.textMuted,
      });
      // 위 단정은 두 상수가 우연히 같은 값이면 조용하다. 이쪽이 그 우연을 막는다.
      expect({scheme, ink: tone('done', scheme).text}).not.toEqual({
        scheme,
        ink: palette.ok,
      });
    }
  });

  it('칩 배경도 ok 계열을 떠났다 — 글자만 내리면 초록 알약이 남는다', () => {
    const tone = renderAllBadges();
    for (const [scheme, palette] of SCHEMES) {
      const {background, border} = tone('done', scheme);
      expect({scheme, background, border}).not.toEqual({
        scheme,
        background: palette.okSurface,
        border: palette.okBorder,
      });
      expect({scheme, background, border}).toEqual({
        scheme,
        background: palette.surface,
        border: palette.border,
      });
    }
  });
});

describe('색을 버는 상태는 폰에서도 둘뿐이다', () => {
  it('실행 중과 호스트 연결 끊김만 중립을 벗어난다', () => {
    // 「전부 muted 로 만들면 통과한다」를 막는 대조. 이 칩이 하는 일은 색을 아끼는
    // 것이지 없애는 것이 아니다.
    const tone = renderAllBadges();
    for (const [scheme, palette] of SCHEMES) {
      expect({scheme, running: tone('running', scheme).text}).toEqual({
        scheme,
        running: palette.warn,
      });
      expect({scheme, orphaned: tone('orphaned', scheme).text}).toEqual({
        scheme,
        orphaned: palette.accentText,
      });
    }
  });

  it('끝난 방식이 색을 가르지 않는다 — idle·done·unknown 이 한 색이다', () => {
    // 코어 표의 같은 단정(`sessionStatusClass.test.ts`)이 폰에서도 참인지.
    expect(coreInk('done')).toBe(coreInk('idle'));
    expect(coreInk('unknown')).toBe(coreInk('idle'));
    const tone = renderAllBadges();
    for (const [scheme] of SCHEMES) {
      const neutral = tone('idle', scheme).text;
      for (const key of ['done', 'unknown'] as const) {
        expect({key, scheme, ink: tone(key, scheme).text}).toEqual({
          key,
          scheme,
          ink: neutral,
        });
      }
    }
  });

  it('원장이 실제로 내는 상태 전부가 칩을 세우고 역할이 대응한다', () => {
    // 타입이 아니라 모델이 내는 키로 도는지. 새 상태가 생기면 여기서 먼저 걸린다.
    const tone = renderAllBadges();
    for (const status of ['running', 'idle', 'orphaned', 'ended', 'wat']) {
      const {key} = workSessionStatus({status, exitCode: undefined});
      const role = INK_ROLE[coreInk(key)];
      expect({key, role: typeof role}).toEqual({key, role: 'function'});
      expect({key, ink: tone(key, 'light').text}).toEqual({
        key,
        ink: role(lightPalette),
      });
    }
  });
});
