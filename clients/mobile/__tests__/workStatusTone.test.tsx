import {SESSION_STATUS_CLASS} from '@momo/core/features/work/workSessionFormat';
import {
  workSessionStatus,
  type WorkSessionStatusKey,
} from '@momo/core/features/work/workSessionModel';
import {cleanup, render, screen} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
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
//
// ## 다리를 여섯 칸 전부로 넓혔다 (#1503)
//
// #1491 이 이 파일을 세울 때 다리는 **`workSessionStatus` 가 실제로 내는 다섯 키**
// 만 건넜다(#1500 이탈 2). `unavailable` 을 빼 둔 것은 게으름이 아니라 정직이었다 —
// 그 칸은 코어(muted)와 폰(accent)이 선재로 어긋나 있었고, 전 칸 다리를 그날 놓으면
// 아직 아무도 판정하지 않은 색을 테스트가 대신 정하게 된다.
//
// #1503 이 그 판정을 받았다: **역할 정본은 웹/코어 표**이고, 강조를 드는 상태는
// `orphaned` 하나다. 두 상태가 사람에게 요구하는 것이 다르기 때문이다 — 고아 세션은
// 이어받을 호스트를 고르는 일이 남아 있고(`workSessionResumeTargets`), 응답 없음은
// 레지스트리가 신호를 못 봤다는 관측이라 누를 것이 없다. 그래서 다리가 이제 표
// **전체**를 건너고, 코어에 새 잉크가 생기면(`text-danger` 같은) 폰에 짝이 없다는
// 사실이 여기서 먼저 빨개진다 — 화면이 새 역할을 즉흥으로 발명하기 전에.
//
// 그리고 다리는 컴포넌트 하나만 건너면 된다: `AgentDetailScreen` 이 자기 상태 표를
// 들고 있던 두 번째 자리였고(실행 중 = 초록), #1503 이 그 표를 지우고 같은
// `WorkStatusBadge` 를 지나게 했다. 마지막 절이 그 사실 자체를 잠근다.
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

describe('다리가 코어 표 여섯 칸 전부를 건넌다 (#1503)', () => {
  it('코어가 쓰는 잉크마다 폰의 짝이 있다 — 새 역할은 여기서 먼저 걸린다', () => {
    // 이 단정이 「코어에 없는 키/잉크가 필요하면 이탈 보고」를 기계로 만든 것이다.
    // 코어 표에 `text-danger` 가 생기는 날, 화면이 자기 붉은색을 즉흥으로 고르기
    // 전에 이 줄이 빨개진다.
    const unpaired = KEYS.filter(key => INK_ROLE[coreInk(key)] === undefined);
    expect(unpaired).toEqual([]);
  });

  it('여섯 칸이 두 스킴 모두에서 코어가 부른 역할대로 선다', () => {
    // #1491 의 다리는 다섯 칸이었다(`unavailable` 제외 — #1500 이탈 2). 그 칸의
    // 판정이 내려졌으므로 이제 표 **전체**가 건넌다.
    const tone = renderAllBadges();
    for (const key of KEYS) {
      const role = INK_ROLE[coreInk(key)];
      for (const [scheme, palette] of SCHEMES) {
        expect({key, scheme, ink: tone(key, scheme).text}).toEqual({
          key,
          scheme,
          ink: role(palette),
        });
      }
    }
  });

  it('호스트 응답 없음은 강조를 벗는다 — 알약까지', () => {
    // 글자만 내리면 accent 알약이 남는다(종료됨에서 배운 것). 그리고 이 칸이
    // 중립으로 내려간 뒤 폰에서 강조를 드는 상태는 코어와 같이 하나뿐이어야 한다.
    expect(coreInk('unavailable')).toBe('text-ink-muted');
    const tone = renderAllBadges();
    for (const [scheme, palette] of SCHEMES) {
      const {text, background, border} = tone('unavailable', scheme);
      expect({scheme, text, background, border}).toEqual({
        scheme,
        text: palette.textMuted,
        background: palette.surface,
        border: palette.border,
      });
      const accented = KEYS.filter(
        key => tone(key, scheme).text === palette.accentText,
      );
      expect({scheme, accented}).toEqual({scheme, accented: ['orphaned']});
    }
  });
});

describe('세션 상태를 칠하는 표는 폰에 하나뿐이다 (#1503)', () => {
  const AGENT_DETAIL = fs.readFileSync(
    path.join(__dirname, '../src/screens/AgentDetailScreen.tsx'),
    'utf8',
  );

  it('에이전트 상세의 세션 행이 같은 칩을 지난다', () => {
    // 값을 맞추는 것으로는 부족하다 — 두 표가 남아 있으면 코어가 다음에 움직이는
    // 날 다시 갈라진다. 이 화면이 색을 고르지 않는다는 것이 계약이다.
    expect(AGENT_DETAIL).toContain('<WorkStatusBadge');
  });

  it('그 화면이 상태 키로 색을 고르지 않는다', () => {
    // 지워진 것이 정확히 이것이다: `status.key === 'running' && styles.…Running`
    // (그리고 그 스타일의 색이 `color.ok` 였다).
    expect(AGENT_DETAIL).not.toMatch(/status\.key\s*===/);
  });
});
