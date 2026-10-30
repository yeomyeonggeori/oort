import fs from 'fs';
import path from 'path';
import React from 'react';
import {Text, useColorScheme} from 'react-native';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';

import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Message, RosterMember} from '@momo/core/lib/api';

import {ThemeControl} from '../src/design/ThemeControl';
import {FixedScheme, ThemeProvider, useStyles} from '../src/design/theme';
import {darkPalette, lightPalette, paletteFrom, type Palette} from '../src/design/tokens';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {NON_SECRET_KEYS, __setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// U2 — 스킴이 **끝까지** 바뀌는가.
//
// 팔레트를 두 벌 만드는 것은 쉽고, 그것이 화면에 닿게 하는 것이 이 배치의 실제
// 일이었다(`design/theme.tsx` 머리 주석). 이 파일이 지는 것은 그 닿음이다:
//
//   1. 고른 것이 **저장**되고, 다음 실행이 그것으로 시작한다
//   2. 고른 것이 **memo 를 통과해** 행 하나하나까지 간다
//   3. 아무도 안 골랐으면 **라이트**(폰의 기본, #4526)이고, **시스템을 고른** 폰은 시스템을 따르며
//      시스템이 바뀌면 함께 바뀐다. 프로바이더 밖의 기본도 라이트다
//   4. `src/` 어디에도 정적 팔레트를 다시 들여오는 파일이 없다
//
// 2 번이 이 파일의 존재 이유다. 「프록시로 `styles` 를 감싸면 30 개 파일을 안
// 고쳐도 된다」는 후보가 정확히 여기서 죽는다: `MessageRow` 는 `React.memo` 로
// 감싸여 있고 props 가 그대로면 다시 그려지지 않으므로, 컨텍스트를 구독하지 않는
// 색은 스킴이 바뀌어도 옛 값으로 남는다. 화면 절반만 바뀌는 결함은 스크린샷
// 없이는 눈에 띄지 않고, 이 단정은 스크린샷 없이 그것을 잡는다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

const BODY = '배포 로그 확인했습니다';

const MESSAGE: Message = {
  id: 'msg-1',
  channelId: 'ch',
  seq: 10,
  hlcTs: 10,
  hlcCount: 0,
  authorMemberId: OTHER,
  type: 'text',
  body: BODY,
  state: 'sent',
  createdAtMs: BASE_MS,
};

function Row(): React.JSX.Element {
  return (
    <MessageRow
      message={MESSAGE}
      startsGroup
      directory={DIRECTORY}
      chips={[]}
      nowMs={BASE_MS}
      actions={{
        myMemberId: SELF,
        onToggleReaction: async () => {},
        onEdit: async () => {},
        onDelete: async () => {},
      }}
    />
  );
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

/** 화면에 실제로 그려진 본문 잉크. 토큰이 아니라 **렌더 트리**에서 읽는다. */
function renderedBodyInk(): unknown {
  return flatten(screen.getByText(BODY).props.style).color;
}

// 목의 두 손잡이 (`jest.setup.js`). 훅 자체에 달려 있으므로 타입에는 없다.
const systemScheme = useColorScheme as unknown as {
  __setSystemColorScheme: (scheme: 'light' | 'dark') => void;
  __reset: () => void;
};
const setSystemColorScheme = (scheme: 'light' | 'dark') =>
  systemScheme.__setSystemColorScheme(scheme);
const resetSystemColorScheme = () => systemScheme.__reset();

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => map.delete(key),
  };
}

let store = memoryStore();

beforeEach(() => {
  store = memoryStore();
  __setNonSecretStore(store);
});

afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
  act(() => resetSystemColorScheme());
});

describe('스킴 왕복 — 세 값이 화면 끝까지 간다', () => {
  it('라이트(기본) → 다크 → 라이트 → 시스템, 매번 행의 잉크가 따라간다', () => {
    // 시스템은 다크다 (`jest.setup.js` 가 이 스위트의 기본을 그렇게 둔다). 그런데 첫 렌더가
    // 라이트이므로 폰의 기본은 시스템이 아니다(#4526).
    render(
      <ThemeProvider>
        <ThemeControl />
        <Row />
      </ThemeProvider>,
    );
    expect(renderedBodyInk()).toBe(lightPalette.text);

    fireEvent.press(screen.getByTestId('theme-dark'));
    // **이 한 줄이 이 파일의 이유다.** 행은 `React.memo` 이고 props 는 하나도
    // 바뀌지 않았다. 색이 컨텍스트를 구독하지 않았다면 여기서 라이트가 남는다.
    expect(renderedBodyInk()).toBe(darkPalette.text);

    fireEvent.press(screen.getByTestId('theme-light'));
    expect(renderedBodyInk()).toBe(lightPalette.text);

    // 라이트에서 시스템으로 옮겼는데 색이 바뀐다 — 「시스템」 줄이 실제로 기기(다크)를 따른다.
    fireEvent.press(screen.getByTestId('theme-system'));
    expect(renderedBodyInk()).toBe(darkPalette.text);
  });

  it('라이트에서 컨트롤 자신도 라이트다 — 설정만 옛 색으로 남지 않는다', () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );
    // 기본이 라이트라서, 먼저 다크로 갔다가 돌아와야 「컨트롤이 다시 그려진다」가 시험된다.
    fireEvent.press(screen.getByTestId('theme-dark'));
    expect(flatten(screen.getByTestId('theme-scheme-card').props.style).backgroundColor).toBe(
      darkPalette.surface,
    );
    fireEvent.press(screen.getByTestId('theme-light'));
    // 카드의 바탕과 고른 줄의 글자가 둘 다 라이트 팔레트에서 온다 (#2702 에서
    // 세그먼트가 목록형 선택지로 바뀐 뒤의 두 신호).
    expect(flatten(screen.getByTestId('theme-scheme-card').props.style).backgroundColor).toBe(
      lightPalette.surface,
    );
    expect(flatten(screen.getByText('라이트').props.style).color).toBe(
      lightPalette.accentText,
    );
  });

  it('「시스템」 칸이 지금 무엇으로 풀리는지 보조기술에게 말한다', () => {
    // 웹 설정의 설명 줄과 같은 문장이다. 폰은 발치에 줄을 하나 더 쓰지 않으므로,
    // 그 정보를 힌트로 옮긴다 — 옮긴 것이지 버린 것이 아니다.
    act(() => setSystemColorScheme('light'));
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );
    const hint = () => screen.getByTestId('theme-system').props.accessibilityHint;
    expect(hint()).toContain('라이트');

    // **이 단정이 리뷰 H-1 이 잡은 것이다.** 첫 판은 힌트를 풀린 스킴(`scheme`)으로
    // 만들었고, 이 자리에 「다크를 고르면 힌트도 다크가 된다」를 단정으로 **봉인**
    // 하고 있었다. 그것은 참이 아니다 — 시스템은 여전히 라이트이고, 이 문장이
    // 있는 유일한 이유가 「고르지 않으면 무엇이 되는가」이므로 고른 값을 되돌려
    // 주는 힌트는 답이 아니라 메아리다.
    fireEvent.press(screen.getByTestId('theme-dark'));
    expect(hint()).toContain('라이트');
    expect(hint()).not.toContain('다크');

    // 그리고 **시스템이 실제로 바뀌면** 고정된 동안에도 힌트는 따라간다. 고정은
    // 화면의 색을 못 박는 것이지 기기의 사실을 못 박는 것이 아니고, 되돌릴지
    // 판단하는 사람에게 필요한 것이 그 사실이다.
    act(() => setSystemColorScheme('dark'));
    expect(hint()).toContain('다크');

    // 라벨이 곧 답인 두 칸은 힌트가 없다.
    expect(screen.getByTestId('theme-light').props.accessibilityHint).toBeUndefined();
  });

  it('고른 줄만 체크가 보이고, 글자색과 굵기도 함께 바뀐다 — 신호가 하나가 아니다 (#2702)', () => {
    // U2 의 세그먼트는 안 고른 칸의 **테두리**가 「여기가 버튼이다」의 전부라 그 값을
    // 3:1 위로 재야 했다(리뷰 M-1). #2702 의 선택지는 카드 안의 줄이라 누를 수 있다는
    // 것은 줄 자체가 말하고, 이 단정이 지는 것은 **어느 줄이 골라졌는가**가 체크
    // 하나에만 실려 있지 않다는 것이다 — 체크는 손가락이 덮는다.
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );
    const ink = (label: string) => flatten(screen.getByText(label).props.style);

    // 기본 = 라이트(#4526). 시스템은 다크(jest.setup)인데 라이트 줄이 서 있으므로 기본이
    // 시스템이 아니다. 체크는 그 줄에만 있고, 나머지 두 줄은 자리만 지킨다.
    expect(screen.getByTestId('theme-light-check')).toBeTruthy();
    expect(screen.queryByTestId('theme-system-check')).toBeNull();
    expect(ink('라이트').color).toBe(lightPalette.accentText);
    expect(ink('라이트').fontWeight).toBe('600');
    expect(ink('시스템').color).toBe(lightPalette.text);

    fireEvent.press(screen.getByTestId('theme-dark'));
    expect(screen.getByTestId('theme-dark-check')).toBeTruthy();
    expect(screen.queryByTestId('theme-light-check')).toBeNull();
    expect(ink('다크').color).toBe(darkPalette.accentText);
    expect(ink('라이트').color).toBe(darkPalette.text);
  });

  it('고른 칸만 selected 다 — 셋 중 하나', () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );
    const state = (id: string) =>
      screen.getByTestId(id).props.accessibilityState?.selected;
    // 처음에는 기본(라이트)이 서 있다. 눌러서 옮기면 그 칸만 따라온다.
    expect([state('theme-system'), state('theme-light'), state('theme-dark')]).toEqual(
      [false, true, false],
    );
    fireEvent.press(screen.getByTestId('theme-dark'));
    expect([state('theme-system'), state('theme-light'), state('theme-dark')]).toEqual(
      [false, false, true],
    );
  });
});

describe('저장 — 다음 실행이 고른 것으로 시작한다', () => {
  it('고르면 MMKV 에 momo 접두 키로 앉는다', () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );
    // 기본(라이트)과 같은 값을 골라도 기록한다 — 고른 폰이 되는 것이 이 한 줄이고, 기본이
    // 또 바뀌어도 그 폰의 선택은 그대로여야 한다(#4526).
    fireEvent.press(screen.getByTestId('theme-light'));
    expect(NON_SECRET_KEYS.appearance.startsWith('momo.')).toBe(true);
    // 외양 레코드(core `AppearanceV2`) — 스킴만 바뀌고 테마·신호는 기본 그대로다.
    expect(JSON.parse(store.map.get(NON_SECRET_KEYS.appearance) ?? '{}')).toEqual({
      v: 2,
      scheme: 'light',
      theme: 'dawnsky',
      signal: null,
      density: 'comfortable',
    });
    // 옛 키는 읽기 전용이다 — 새로 쓰지 않는다.
    expect(store.map.has(NON_SECRET_KEYS.themeChoice)).toBe(false);
  });

  it('새로 마운트하면 저장된 것으로 서 있다 (첫 렌더 기록은 theme.test.tsx 의 themeDefault 묶음이 잰다)', () => {
    store.map.set(NON_SECRET_KEYS.themeChoice, 'dark');
    // 시스템이 라이트라서 「다크」는 저장에서만 올 수 있다.
    act(() => setSystemColorScheme('light'));
    render(
      <ThemeProvider>
        <Row />
      </ThemeProvider>,
    );
    expect(renderedBodyInk()).toBe(darkPalette.text);
  });

  it.each([
    // [옛 키 값, 시스템] — 둘 다 다크로 시작해야 한다. 기본(라이트)과 같은 결과가 나오는 조합은
    // 이행을 못 가려서 뺐다: 옛 「시스템」은 **고른** 값이라 시스템이 다크면 다크가 남는다.
    ['dark', 'light'],
    ['system', 'dark'],
  ] as const)(
    '옛 스킴 키(momo.mobile.theme.v1)만 있어도 그 스킴으로 시작한다 — 이행: %s (시스템 %s)',
    (legacy, system) => {
      store.map.set(NON_SECRET_KEYS.themeChoice, legacy);
      act(() => setSystemColorScheme(system));
      render(
        <ThemeProvider>
          <Row />
        </ThemeProvider>,
      );
      expect(renderedBodyInk()).toBe(darkPalette.text);
    },
  );

  it('새 키가 있으면 옛 키보다 먼저 읽는다', () => {
    store.map.set(NON_SECRET_KEYS.themeChoice, 'light');
    store.map.set(
      NON_SECRET_KEYS.appearance,
      JSON.stringify({v: 2, scheme: 'dark', theme: 'dawnsky', signal: null, density: 'comfortable'}),
    );
    render(
      <ThemeProvider>
        <Row />
      </ThemeProvider>,
    );
    expect(renderedBodyInk()).toBe(darkPalette.text);
  });

  it('저장이 하나도 없으면 폰의 기본 — 라이트다. 시스템이 다크여도 (#4526)', () => {
    // 시스템은 다크다(jest.setup). 예전에는 여기서 다크가 나왔다(기본 = 시스템).
    render(
      <ThemeProvider>
        <ThemeControl />
        <Row />
      </ThemeProvider>,
    );
    expect(renderedBodyInk()).toBe(lightPalette.text);
    expect(screen.getByTestId('theme-light').props.accessibilityState?.selected).toBe(true);
    expect(screen.getByTestId('theme-system').props.accessibilityState?.selected).toBe(false);
  });

  it('모르는 옛 값이면 전과 같이 시스템을 따른다 — 사람이 남긴 흔적이 있으면 건드리지 않는다', () => {
    // 쓰레기 값은 「안 고름」(키 없음)이 아니다. 보수적으로 전과 같이 읽는다.
    store.map.set(NON_SECRET_KEYS.themeChoice, 'sepia');
    render(
      <ThemeProvider>
        <ThemeControl />
        <Row />
      </ThemeProvider>,
    );
    expect(renderedBodyInk()).toBe(darkPalette.text);
    expect(screen.getByTestId('theme-system').props.accessibilityState?.selected).toBe(
      true,
    );
  });
});

describe('시스템 추종', () => {
  it('시스템을 고른 폰은 시스템이 바뀌면 화면이 따라간다 — 앱을 다시 열지 않아도', () => {
    // 기본이 라이트가 됐으므로 시스템을 따르려면 **고른** 폰이어야 한다.
    store.map.set(
      NON_SECRET_KEYS.appearance,
      JSON.stringify({v: 2, scheme: 'system', theme: 'dawnsky', signal: null, density: 'comfortable'}),
    );
    render(
      <ThemeProvider>
        <Row />
      </ThemeProvider>,
    );
    expect(renderedBodyInk()).toBe(darkPalette.text);
    act(() => setSystemColorScheme('light'));
    expect(renderedBodyInk()).toBe(lightPalette.text);
  });

  it('사람이 고른 뒤에는 시스템이 바뀌어도 흔들리지 않는다', () => {
    render(
      <ThemeProvider>
        <ThemeControl />
        <Row />
      </ThemeProvider>,
    );
    fireEvent.press(screen.getByTestId('theme-dark'));
    act(() => setSystemColorScheme('light'));
    expect(renderedBodyInk()).toBe(darkPalette.text);
  });

  it('프로바이더가 없으면 폰의 기본 — 라이트다. 시스템이 다크여도 (#4526)', () => {
    // 시스템은 다크다(jest.setup). 예전에는 여기서 시스템을 따라 다크가 나왔다. 시스템이
    // 라이트일 때 라이트를 단정하면 「시스템 추종」과 「라이트 고정」을 가르지 못하므로, 가를 수
    // 있는 쪽(다크 기기)에서 잰다.
    render(<Row />);
    expect(renderedBodyInk()).toBe(lightPalette.text);
  });

  it('FixedScheme 은 시스템도 저장도 무시한다 — 사진이 인자만 따른다', () => {
    store.map.set(NON_SECRET_KEYS.themeChoice, 'dark');
    act(() => setSystemColorScheme('dark'));
    render(
      <FixedScheme scheme="light">
        <Row />
      </FixedScheme>,
    );
    expect(renderedBodyInk()).toBe(lightPalette.text);
  });
});

describe('한 벌짜리 색이 다시 새어 들어오지 못한다', () => {
  const SRC_DIR = path.resolve(__dirname, '../src');

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it('src/ 어디에도 정적 `color` 를 import 하는 파일이 없다', () => {
    // `tokens.ts` 의 `color` 는 **다크 스킴의 낱값**이다. 화면 코드가 그것을 다시
    // 들여오는 순간 그 화면 하나만 스킴을 안 따라가고, 그 결함은 라이트로 바꿔
    // 보기 전에는 보이지 않는다. 그래서 규칙은 취향이 아니라 기계다.
    //
    // 스타일시트 본문에 보이는 `color.bg` 는 이 규칙 밖이다 — 그것은 팩토리의
    // **인자**이고, 인자를 통해 들어온 팔레트는 이미 고른 스킴의 것이다.
    const offenders = walk(SRC_DIR).filter(file => {
      if (file.endsWith(path.join('design', 'tokens.ts'))) return false;
      if (file.endsWith(path.join('design', 'theme.tsx'))) return false;
      const source = fs.readFileSync(file, 'utf8');
      return /import\s*\{[^}]*\bcolor\b[^}]*\}\s*from\s*'[^']*tokens'/.test(source);
    });
    expect(offenders.map(f => path.relative(SRC_DIR, f))).toEqual([]);
  });

  it('색을 쓰는 파일은 전부 팔레트를 인자로 받는다', () => {
    // 즉시 부르는 `StyleSheet.create` 는 import 시점에 굳는다. 그런 상수가
    // `src/` 에 하나라도 남아 있고 그 안에 색이 있으면, 그 화면은 영영 한 벌이다.
    const offenders = walk(SRC_DIR).filter(file => {
      const source = fs.readFileSync(file, 'utf8');
      return /const\s+styles\s*=\s*StyleSheet\.create\(/.test(source);
    });
    expect(offenders.map(f => path.relative(SRC_DIR, f))).toEqual([]);
  });
});

describe('구독은 앱 전체에 하나다', () => {
  it('색을 읽는 컴포넌트가 20 개여도 Appearance 구독은 프로바이더의 것 하나뿐', () => {
    // 색을 읽는 자리마다 `useColorScheme()` 을 불렀다면 여기서 21 이 나온다. RN 의
    // `EventEmitter` 는 제거가 O(n) 이라 그 숫자가 가상화 목록의 스크롤 프레임
    // 안에 앉는다 — 성능처럼 생겼지만 프레임을 떨어뜨리면 정확성 문제다.
    const listeners = (global as unknown as {
      __momoColorScheme: {listeners: Set<unknown>};
    }).__momoColorScheme.listeners;
    const before = listeners.size;
    function Probe(): React.JSX.Element {
      const styles = useStyles(build);
      return <Text style={styles.ink}>재료</Text>;
    }
    const build = (color: Palette) => ({ink: {color: color.text}});
    render(
      <ThemeProvider>
        {Array.from({length: 20}, (_, i) => (
          <Probe key={i} />
        ))}
      </ThemeProvider>,
    );
    expect(listeners.size - before).toBe(1);
  });
});

describe('useStyles 는 (팩토리 × 스킴) 당 한 벌만 만든다', () => {
  it('행이 200 개여도 스타일시트는 한 벌이다', () => {
    // 캐시가 컴포넌트에 붙어 있었다면(`useMemo`) 행마다 한 벌씩 생긴다. 캐시가
    // 팩토리에 붙어 있다는 사실을 **호출 횟수**로 잰다.
    let built = 0;
    const build = (color: Palette) => {
      built += 1;
      return {ink: {color: color.text}};
    };
    function Probe(): React.JSX.Element {
      const styles = useStyles(build);
      return <Text style={styles.ink}>재료</Text>;
    }
    render(
      <ThemeProvider>
        {Array.from({length: 20}, (_, i) => (
          <Probe key={i} />
        ))}
      </ThemeProvider>,
    );
    expect(built).toBe(1);
  });
});


it('AP-6: 카탈로그 선택·완료·되돌리기가 실제 memo MessageRow까지 다시 칠해요', () => {
  render(<ThemeProvider><ThemeControl /><Row /></ThemeProvider>);
  const before = renderedBodyInk();
  fireEvent.press(screen.getByTestId('appearance-theme-picker'));
  fireEvent.press(screen.getByTestId('theme-picker-filter-dark'));
  fireEvent.press(screen.getByTestId('appearance-theme-catalog:nord'));
  fireEvent.press(screen.getByTestId('theme-picker-done'));
  expect(renderedBodyInk()).toBe(paletteFrom('catalog:nord', 'dark').text);
  expect(renderedBodyInk()).not.toBe(before);
  fireEvent.press(screen.getByTestId('appearance-theme-picker'));
  fireEvent.press(screen.getByTestId('appearance-theme-graphite'));
  fireEvent.press(screen.getByTestId('theme-picker-undo'));
  fireEvent.press(screen.getByTestId('theme-picker-done'));
  expect(renderedBodyInk()).toBe(paletteFrom('catalog:nord', 'dark').text);
});
