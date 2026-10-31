import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';

import {ThemeControl} from '../src/design/ThemeControl';
import {BACKGROUND_FALLBACK_COPY} from '@momo/core/design/mobileBackground';
import {IMPORT_FAILURE_COPY, type PhotoPorts} from '../src/design/background/photo';
import {
  __resetBackgroundStoreForTests,
  __setDiskPort,
  forgetBackgroundOnSignOut,
  getBackground,
  resetBackground,
  setBackground,
} from '../src/design/background/store';
import {ThemeProvider} from '../src/design/theme';
import {paletteFrom} from '../src/design/tokens';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {DARK_CHOSEN_RECORD} from './fixtures/darkWorld';

// =============================================================================
// ADR-0189 증보 2 — 「배경」 묶음과 저장소 (#3907).
// =============================================================================

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
const a11y = AccessibilityInfo as unknown as {
  isReduceTransparencyEnabled: jest.Mock;
  isDarkerSystemColorsEnabled?: jest.Mock;
  addEventListener: jest.Mock;
};

const disk = {
  removed: [] as string[],
  cleared: 0,
  present: new Set<string>(),
};

beforeEach(() => {
  mmkvStore.clear();
  // 다크 팔레트의 색을 단정하는 시험이다. 폰의 기본이 라이트가 된 뒤(#4526)에는 다크를 고른 폰으로 세운다.
  mmkvStore.set(NON_SECRET_KEYS.appearance, DARK_CHOSEN_RECORD);
  __resetBackgroundStoreForTests();
  disk.removed = [];
  disk.cleared = 0;
  disk.present = new Set();
  __setDiskPort({
    uri: name => `file:///document/oort-background/${name}`,
    exists: name => disk.present.has(name),
    remove: name => {
      disk.removed.push(name);
      disk.present.delete(name);
    },
    clearAll: () => {
      disk.cleared += 1;
      disk.present.clear();
    },
  });
  a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(false));
  a11y.isDarkerSystemColorsEnabled = jest.fn(() => Promise.resolve(false));
  a11y.addEventListener.mockImplementation(() => ({remove: () => {}}));
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function photoPorts(options: {
  pick: Parameters<PhotoPorts['pick']> extends [] ? Awaited<ReturnType<PhotoPorts['pick']>> : never;
  bytes?: number;
  now?: number;
}): PhotoPorts {
  return {
    pick: async () => options.pick,
    shrink: async (_uri, {width, height}) => ({uri: 'file:///cache/s.jpg', width, height}),
    sizeOf: () => options.bytes ?? 400_000,
    keep: (_uri, name) => {
      disk.present.add(name);
    },
    discard: () => {},
    now: () => options.now ?? 1_760_600_000_001,
  };
}

const PICKED = {kind: 'picked', uri: 'file:///photos/1.jpg', width: 1200, height: 900} as const;

function mount(ports?: PhotoPorts) {
  // 접근성 설정을 묻는 프로미스가 해소되는 상태 갱신은 시험 밖에서 일어난다 — 소음이다.
  return render(
    <ThemeProvider>
      <ThemeControl photoPorts={ports} />
    </ThemeProvider>,
  );
}

const selected = (id: string) =>
  screen.getByTestId(id).props.accessibilityState?.selected as boolean;

describe('고르기', () => {
  it('처음에는 기본이 골라져 있고 「기본으로」 버튼이 없다', () => {
    mount();
    expect(selected('appearance-background-none')).toBe(true);
    expect(screen.queryByTestId('appearance-background-reset')).toBeNull();
  });

  it('단색을 고르면 저장되고 그 칸만 selected 다', () => {
    mount();
    fireEvent.press(screen.getByTestId('appearance-background-solid-sage'));
    expect(getBackground()).toEqual({kind: 'solid', id: 'sage'});
    expect(JSON.parse(mmkvStore.get(NON_SECRET_KEYS.background) ?? '{}')).toEqual({
      v: 1,
      kind: 'solid',
      id: 'sage',
    });
    expect(selected('appearance-background-solid-sage')).toBe(true);
    expect(selected('appearance-background-solid-rose')).toBe(false);
    expect(selected('appearance-background-none')).toBe(false);
  });

  it('기본 제공을 고르면 단색 선택은 풀린다 — 한 번에 하나', () => {
    mount();
    fireEvent.press(screen.getByTestId('appearance-background-solid-sage'));
    fireEvent.press(screen.getByTestId('appearance-background-preset-noeul'));
    expect(getBackground()).toEqual({kind: 'preset', id: 'noeul'});
    expect(selected('appearance-background-preset-noeul')).toBe(true);
    expect(selected('appearance-background-solid-sage')).toBe(false);
  });

  it('「기본으로」가 선택을 지운다', () => {
    mount();
    fireEvent.press(screen.getByTestId('appearance-background-preset-bam'));
    fireEvent.press(screen.getByTestId('appearance-background-reset'));
    expect(getBackground()).toEqual({kind: 'none'});
    expect(mmkvStore.has(NON_SECRET_KEYS.background)).toBe(false);
    expect(selected('appearance-background-none')).toBe(true);
    expect(screen.queryByTestId('appearance-background-reset')).toBeNull();
  });

  it('다음 실행이 저장된 선택으로 시작한다', () => {
    mmkvStore.set(
      NON_SECRET_KEYS.background,
      JSON.stringify({v: 1, kind: 'preset', id: 'sup'}),
    );
    mount();
    expect(selected('appearance-background-preset-sup')).toBe(true);
  });

  it('사진이 어떻게 보이는지 미리 말한다 — 흐려진다는 사실. 고르기 전에는 「고르면」이다', () => {
    mount();
    expect(screen.getByTestId('appearance-background-scrim-note')).toHaveTextContent(
      /고르면.*사진이 조금 흐리게 보여요/,
    );
    fireEvent.press(screen.getByTestId('appearance-background-solid-sage'));
    expect(screen.getByTestId('appearance-background-scrim-note')).toHaveTextContent(
      /깔려요. 그래서 사진이 조금 흐리게 보여요/,
    );
  });

  it('기본 제공을 고르면 그 타일에 ✓ 가 선다 — 단색과 같은 색 외 표지', () => {
    mount();
    expect(screen.queryByTestId('appearance-background-preset-bam-check')).toBeNull();
    fireEvent.press(screen.getByTestId('appearance-background-preset-bam'));
    expect(screen.getByTestId('appearance-background-preset-bam-check')).toBeTruthy();
  });

  it('프라이버시 문구는 서버를 주어로 좁힌다 — 「이 기기에만」이라고 말하지 않는다 (iCloud 백업 가능)', () => {
    mount();
    const row = screen.getByTestId('appearance-background-photo');
    expect(row).toHaveTextContent(/oort 서버로는 올라가지 않아요/);
    expect(row).not.toHaveTextContent(/이 기기에만/);
  });

  it('단색의 경계는 3:1 컨트롤 선이다 — 어두운 단색이 카드에서 사라지지 않는다', () => {
    mount();
    const border = StyleSheet.flatten(
      screen.getByTestId('appearance-background-solid-ink').props.style,
    ).borderColor;
    expect(border).toBe(paletteFrom('dawnsky', 'dark').textFaint);
  });
});

describe('내 사진', () => {
  it('골라서 줄이고 보관하면 사진 선택이 된다 — 썸네일과 체크가 보인다', async () => {
    mount(photoPorts({pick: PICKED}));
    fireEvent.press(screen.getByTestId('appearance-background-photo'));
    await waitFor(() => expect(getBackground().kind).toBe('photo'));
    expect(getBackground()).toEqual({
      kind: 'photo',
      file: 'bg-1760600000001.jpg',
      width: 1200,
      height: 900,
    });
    expect(disk.present.has('bg-1760600000001.jpg')).toBe(true);
    expect(selected('appearance-background-photo')).toBe(true);
    expect(
      screen.getByTestId('appearance-background-photo-thumb', {includeHiddenElements: true}),
    ).toBeTruthy();
  });

  it('취소는 조용하다 — 선택도 알림도 그대로', async () => {
    mount(photoPorts({pick: {kind: 'cancelled'}}));
    fireEvent.press(screen.getByTestId('appearance-background-photo'));
    await act(async () => {});
    expect(getBackground()).toEqual({kind: 'none'});
    expect(screen.queryByTestId('appearance-background-notice')).toBeNull();
  });

  it('실패 문구는 오류 톤이고 보조기술에 읽어 준다', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    mount(photoPorts({pick: {kind: 'denied'}}));
    fireEvent.press(screen.getByTestId('appearance-background-photo'));
    await waitFor(() => expect(screen.getByTestId('appearance-background-notice')).toBeTruthy());
    const notice = screen.getByTestId('appearance-background-notice');
    expect(StyleSheet.flatten(notice.props.style).color).toBe(
      paletteFrom('dawnsky', 'dark').dangerText,
    );
    expect(notice.props.accessibilityLiveRegion).toBe('polite');
    expect(announce).toHaveBeenCalledWith(IMPORT_FAILURE_COPY.denied);
  });

  it.each([
    ['denied', {kind: 'denied'} as const],
    ['unreadable', {kind: 'error'} as const],
  ])('%s 이면 이유를 한 줄로 말하고 선택을 바꾸지 않는다', async (reason, pick) => {
    mount(photoPorts({pick}));
    fireEvent.press(screen.getByTestId('appearance-background-solid-sky'));
    fireEvent.press(screen.getByTestId('appearance-background-photo'));
    await waitFor(() =>
      expect(screen.getByTestId('appearance-background-notice')).toHaveTextContent(
        IMPORT_FAILURE_COPY[reason as 'denied' | 'unreadable'] as string,
      ),
    );
    expect(getBackground()).toEqual({kind: 'solid', id: 'sky'});
  });

  it('너무 크면 too-large 를 말하고 아무것도 보관하지 않는다', async () => {
    mount(photoPorts({pick: PICKED, bytes: 9_000_000}));
    fireEvent.press(screen.getByTestId('appearance-background-photo'));
    await waitFor(() =>
      expect(screen.getByTestId('appearance-background-notice')).toHaveTextContent(
        IMPORT_FAILURE_COPY['too-large'] as string,
      ),
    );
    expect(disk.present.size).toBe(0);
  });

  it('다른 사진으로 바꾸면 이전 파일을 지운다 — 파일이 쌓이지 않는다', async () => {
    const view = mount(photoPorts({pick: PICKED, now: 1_760_600_000_001}));
    fireEvent.press(screen.getByTestId('appearance-background-photo'));
    await waitFor(() => expect(getBackground().kind).toBe('photo'));
    view.rerender(
      <ThemeProvider>
        <ThemeControl photoPorts={photoPorts({pick: PICKED, now: 1_760_600_000_002})} />
      </ThemeProvider>,
    );
    fireEvent.press(screen.getByTestId('appearance-background-photo'));
    await waitFor(() =>
      expect(getBackground()).toMatchObject({file: 'bg-1760600000002.jpg'}),
    );
    expect(disk.removed).toEqual(['bg-1760600000001.jpg']);
  });

  it('사진에서 단색으로 바꿔도 사진 파일을 지운다', async () => {
    mount(photoPorts({pick: PICKED}));
    fireEvent.press(screen.getByTestId('appearance-background-photo'));
    await waitFor(() => expect(getBackground().kind).toBe('photo'));
    fireEvent.press(screen.getByTestId('appearance-background-solid-ink'));
    expect(disk.removed).toEqual(['bg-1760600000001.jpg']);
  });

  it('「기본으로」도 사진 파일을 지운다', async () => {
    mount(photoPorts({pick: PICKED}));
    fireEvent.press(screen.getByTestId('appearance-background-photo'));
    await waitFor(() => expect(getBackground().kind).toBe('photo'));
    fireEvent.press(screen.getByTestId('appearance-background-reset'));
    expect(disk.removed).toEqual(['bg-1760600000001.jpg']);
  });
});

describe('저장소', () => {
  it('사진 파일이 사라졌으면 읽을 때 없음으로 되돌리고 저장도 지운다', () => {
    mmkvStore.set(
      NON_SECRET_KEYS.background,
      JSON.stringify({v: 1, kind: 'photo', file: 'bg-5.jpg', width: 10, height: 10}),
    );
    __resetBackgroundStoreForTests();
    __setDiskPort({uri: n => n, exists: () => false, remove: () => {}, clearAll: () => {}});
    expect(getBackground()).toEqual({kind: 'none'});
    expect(mmkvStore.has(NON_SECRET_KEYS.background)).toBe(false);
  });

  it('로그아웃 정리: 디렉터리를 비우고 사진 선택만 없음으로 — 단색은 남긴다', () => {
    disk.present.add('bg-1.jpg');
    setBackground({kind: 'photo', file: 'bg-1.jpg', width: 10, height: 10});
    forgetBackgroundOnSignOut();
    expect(disk.cleared).toBe(1);
    expect(disk.present.size).toBe(0);
    expect(getBackground()).toEqual({kind: 'none'});

    setBackground({kind: 'solid', id: 'plum'});
    forgetBackgroundOnSignOut();
    expect(getBackground()).toEqual({kind: 'solid', id: 'plum'});
  });

  it('구독자는 변경을 받는다 — 로그아웃이 React 밖에서 불러도 화면이 따라간다', () => {
    mount();
    fireEvent.press(screen.getByTestId('appearance-background-solid-clay'));
    expect(selected('appearance-background-solid-clay')).toBe(true);
    act(() => resetBackground());
    expect(selected('appearance-background-none')).toBe(true);
  });
});

describe('접근성 설정이 켜져 있을 때', () => {
  it('고른 배경이 꺼져 있는 이유를 사실대로 말한다', async () => {
    a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(true));
    setBackground({kind: 'solid', id: 'rose'});
    mount();
    await waitFor(() =>
      expect(screen.getByTestId('appearance-background-fallback')).toHaveTextContent(
        BACKGROUND_FALLBACK_COPY['reduce-transparency'],
      ),
    );
    // 선택은 지우지 않는다 — 설정이 꺼지면 돌아온다.
    expect(getBackground()).toEqual({kind: 'solid', id: 'rose'});
    // 꺼져 있는 동안 「사진이 흐리게 보여요」는 거짓이라 말하지 않는다(리뷰 M3).
    expect(screen.queryByTestId('appearance-background-scrim-note')).toBeNull();
  });

  it('대비 높이기의 이유는 다른 문장이다', async () => {
    a11y.isDarkerSystemColorsEnabled = jest.fn(() => Promise.resolve(true));
    setBackground({kind: 'solid', id: 'rose'});
    mount();
    await waitFor(() =>
      expect(screen.getByTestId('appearance-background-fallback')).toHaveTextContent(
        BACKGROUND_FALLBACK_COPY['increase-contrast'],
      ),
    );
  });
});
