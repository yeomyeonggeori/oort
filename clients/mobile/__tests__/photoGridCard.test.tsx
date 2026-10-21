import {MAX_ATTACHMENTS_PER_MESSAGE} from '@momo/core/features/attachments/model';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, AppState} from 'react-native';

import {FixedScheme} from '../src/design/theme';
import {lightPalette} from '../src/design/tokens';
import {PhotoGridCard, type PhotoGridCardProps} from '../src/features/attachments/PhotoGridCard';
import {PHOTO_COPY} from '../src/features/attachments/photoCardCopy';
import {PHOTO_CARD} from '../src/features/attachments/photoCardDesign';
import {
  PhotoResolveError,
  type PhotoAsset,
  type PhotoLibraryPorts,
  type PhotoPermission,
} from '../src/features/attachments/photoLibrary';
import type {PickedAttachmentFile} from '../src/features/attachments/picker';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 사진 카드 (#4181) — 권한 4상태의 렌더와 전이, 선택 토글·상한, 첨부(한 번의 호출),
// iCloud·실패, 페이지 로딩, 그리고 「카드가 닫혀 있으면 포트 호출 0」.
//
// 포트를 바꿔 끼우므로 expo 목이 필요 없다. 포트 호출 횟수가 곧 「선제 요청 없음」의 증거다.
// =============================================================================

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function makeAssets(count: number): PhotoAsset[] {
  return Array.from({length: count}, (_, index) => ({
    id: `a${index + 1}`,
    uri: `ph://a${index + 1}`,
    filename: `IMG_${index + 1}.JPG`,
    width: 4032,
    height: 3024,
    creationTimeMs: Date.UTC(2026, 9, 21, 3, 0, 0) - index * 60_000,
  }));
}

function fileFor(asset: PhotoAsset): PickedAttachmentFile {
  return {
    uri: `file:///cache/${asset.id}.jpg`,
    name: asset.filename,
    mime: 'image/jpeg',
    sizeBytes: 1000,
    sizeKnown: true,
  };
}

interface FakeLibrary {
  permission: PhotoPermission;
  /** 「허용」을 눌렀을 때 사람이 고르는 답. */
  answer: PhotoPermission;
  assets: PhotoAsset[];
  resolve: PhotoLibraryPorts['resolvePhoto'];
}

function makeLibrary(init: Partial<FakeLibrary> = {}) {
  const state: FakeLibrary = {
    permission: 'granted',
    answer: 'granted',
    assets: makeAssets(9),
    resolve: async asset => fileFor(asset),
    ...init,
  };
  const listeners = new Set<() => void>();
  const ports: jest.Mocked<PhotoLibraryPorts> = {
    getPermission: jest.fn(async () => state.permission),
    requestPermission: jest.fn(async () => {
      state.permission = state.answer;
      return state.permission;
    }),
    presentLimitedPicker: jest.fn(async () => undefined),
    listPhotos: jest.fn(async (after, first) => {
      let start = 0;
      if (after !== null) {
        const at = state.assets.findIndex(asset => asset.id === after);
        if (at < 0) throw new Error('cursor gone');
        start = at + 1;
      }
      const assets = state.assets.slice(start, start + first);
      return {
        assets,
        endCursor: assets.length > 0 ? assets[assets.length - 1].id : null,
        hasNextPage: start + assets.length < state.assets.length,
      };
    }),
    resolvePhoto: jest.fn((asset, hooks) => state.resolve(asset, hooks)),
    subscribe: jest.fn(listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    openSettings: jest.fn(),
  };
  return {
    state,
    ports,
    emitChange: () => listeners.forEach(listener => listener()),
    listenerCount: () => listeners.size,
  };
}

function callCounts(ports: jest.Mocked<PhotoLibraryPorts>): Record<string, number> {
  return {
    getPermission: ports.getPermission.mock.calls.length,
    requestPermission: ports.requestPermission.mock.calls.length,
    listPhotos: ports.listPhotos.mock.calls.length,
    resolvePhoto: ports.resolvePhoto.mock.calls.length,
    subscribe: ports.subscribe.mock.calls.length,
    presentLimitedPicker: ports.presentLimitedPicker.mock.calls.length,
  };
}

async function renderCard(
  ports: PhotoLibraryPorts,
  over: Partial<PhotoGridCardProps> = {},
  scheme: 'light' | 'dark' = 'light',
) {
  const props: PhotoGridCardProps = {
    ports,
    active: true,
    size: {width: 382, height: 372},
    room: MAX_ATTACHMENTS_PER_MESSAGE,
    onBack: jest.fn(),
    onAttach: jest.fn(),
    onDone: jest.fn(),
    onOpenSystemPicker: jest.fn(),
    ...over,
  };
  const tree = (next: PhotoGridCardProps) => (
    <FixedScheme scheme={scheme}>
      <PhotoGridCard {...next} />
    </FixedScheme>
  );
  const view = render(tree(props));
  // 열리는 효과가 던진 약속(권한 읽기)을 act 안에서 마저 처리한다 — 밖에서 끝나면 경고가 선다.
  await settle();
  return {
    ...view,
    props,
    update: (next: Partial<PhotoGridCardProps>) => view.rerender(tree({...props, ...next})),
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 그 요소가 설 때까지 기다렸다가 act 안에서 누른다(누름이 건 비동기 갱신이 act 밖으로 새지 않게). */
async function press(testID: string): Promise<void> {
  const element = await screen.findByTestId(testID);
  await act(async () => {
    fireEvent.press(element);
  });
}

describe('선제 요청 없음 — 카드가 닫혀 있으면 포트를 한 번도 부르지 않는다', () => {
  it('닫힌 카드는 권한 읽기·요청·목록·구독 어느 것도 부르지 않는다', async () => {
    const {ports} = makeLibrary({permission: 'undetermined'});
    await renderCard(ports, {active: false});
    await settle();
    expect(callCounts(ports)).toEqual({
      getPermission: 0,
      requestPermission: 0,
      listPhotos: 0,
      resolvePhoto: 0,
      subscribe: 0,
      presentLimitedPicker: 0,
    });
  });

  it('열리면 상태를 읽을 뿐 묻지는 않는다(프롬프트는 「허용」이 건다)', async () => {
    const {ports} = makeLibrary({permission: 'undetermined'});
    await renderCard(ports);
    await settle();
    expect(ports.getPermission).toHaveBeenCalledTimes(1);
    expect(ports.requestPermission).not.toHaveBeenCalled();
    expect(ports.listPhotos).not.toHaveBeenCalled();
  });

  it('열었다 닫으면 상태를 모두 비우고 다시 열면 새로 읽는다', async () => {
    const {ports} = makeLibrary();
    const view = await renderCard(ports);
    await settle();
    await press('photo-cell-a1');
    expect(screen.getByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.attach(1));
    view.update({active: false});
    await settle();
    expect(screen.queryByTestId('photo-grid')).toBeNull();
    view.update({active: true});
    await settle();
    expect(ports.getPermission).toHaveBeenCalledTimes(2);
    // 선택은 닫을 때 사라졌다.
    expect(await screen.findByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.allPhotos);
  });
});

describe('권한 4상태의 렌더와 전이', () => {
  it('미결정: 설명 + 「허용」 + 「전체 사진에서 고르기」, 그리드는 없다', async () => {
    const {ports} = makeLibrary({permission: 'undetermined'});
    const {props} = await renderCard(ports);
    expect(await screen.findByTestId('photo-pane-undetermined')).toBeTruthy();
    expect(screen.getByText(PHOTO_COPY.askTitle)).toBeTruthy();
    expect(screen.getByText(PHOTO_COPY.askDetail)).toBeTruthy();
    expect(screen.getByTestId('photo-allow')).toHaveTextContent(PHOTO_COPY.allow);
    expect(screen.queryByTestId('photo-grid')).toBeNull();
    // 전체 사진 알약은 그리드가 있을 때만 선다 — 설명 면에는 같은 길이 글자 버튼으로 있다.
    expect(screen.queryByTestId('photo-pill')).toBeNull();
    await press('photo-pick-from-all');
    expect(props.onOpenSystemPicker).toHaveBeenCalledTimes(1);
  });

  it('미결정 → 「허용」 → 프롬프트 한 번 → 전체 허용이면 그리드가 선다', async () => {
    const lib = makeLibrary({permission: 'undetermined', answer: 'granted'});
    await renderCard(lib.ports);
    await press('photo-allow');
    await settle();
    expect(lib.ports.requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('photo-grid')).toBeTruthy();
    expect(lib.ports.listPhotos).toHaveBeenCalledWith(null, PHOTO_CARD.pageSize);
    expect(screen.queryByTestId('photo-limited')).toBeNull();
  });

  it('미결정 → 「허용」 → 일부 허용이면 그리드와 「사진 더 고르기」가 선다', async () => {
    const lib = makeLibrary({permission: 'undetermined', answer: 'limited'});
    await renderCard(lib.ports);
    await press('photo-allow');
    expect(await screen.findByTestId('photo-limited')).toBeTruthy();
    expect(screen.getByTestId('photo-grid')).toBeTruthy();
    expect(screen.getByText(PHOTO_COPY.limitedNote)).toBeTruthy();
  });

  it('미결정 → 「허용」 → 거부하면 거부 면으로 바뀐다(「허용」은 사라진다)', async () => {
    const lib = makeLibrary({permission: 'undetermined', answer: 'denied'});
    await renderCard(lib.ports);
    await press('photo-allow');
    expect(await screen.findByTestId('photo-pane-denied')).toBeTruthy();
    expect(screen.queryByTestId('photo-allow')).toBeNull();
  });

  it('거부: 설명 + 「설정 열기」 + 「전체 사진에서 고르기」, 「허용」은 없고 요청은 0 이다', async () => {
    const lib = makeLibrary({permission: 'denied'});
    const {props} = await renderCard(lib.ports);
    expect(await screen.findByTestId('photo-pane-denied')).toBeTruthy();
    expect(screen.getByText(PHOTO_COPY.deniedTitle)).toBeTruthy();
    expect(screen.queryByTestId('photo-allow')).toBeNull();
    await press('photo-open-settings');
    expect(lib.ports.openSettings).toHaveBeenCalledTimes(1);
    await press('photo-pick-from-all');
    expect(props.onOpenSystemPicker).toHaveBeenCalledTimes(1);
    expect(lib.ports.requestPermission).not.toHaveBeenCalled();
    expect(lib.ports.listPhotos).not.toHaveBeenCalled();
  });

  it('거부 → 설정에서 돌아오면(앱이 다시 활성) 허용된 상태를 읽고 그리드가 선다', async () => {
    let onChange: ((state: string) => void) | null = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      type: string,
      listener: (state: string) => void,
    ) => {
      if (type === 'change') onChange = listener;
      return {remove: jest.fn()};
    }) as never);
    const lib = makeLibrary({permission: 'denied'});
    await renderCard(lib.ports);
    expect(await screen.findByTestId('photo-pane-denied')).toBeTruthy();
    // 사람이 설정에서 켜고 돌아왔다.
    lib.state.permission = 'granted';
    await act(async () => {
      onChange?.('active');
    });
    expect(await screen.findByTestId('photo-grid')).toBeTruthy();
    expect(lib.ports.requestPermission).not.toHaveBeenCalled();
  });

  it('일부 허용: 허용된 사진 + 「사진 더 고르기」가 시스템 창을 연다', async () => {
    const lib = makeLibrary({permission: 'limited'});
    await renderCard(lib.ports);
    expect(await screen.findByTestId('photo-grid')).toBeTruthy();
    await press('photo-limited-more');
    expect(lib.ports.presentLimitedPicker).toHaveBeenCalledTimes(1);
  });

  it('일부 허용에서 허용 사진이 바뀌면(보관함 변경 이벤트) 목록을 다시 읽는다', async () => {
    installAppClock();
    const lib = makeLibrary({permission: 'limited'});
    await renderCard(lib.ports);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lib.listenerCount()).toBe(1);
    const before = lib.ports.listPhotos.mock.calls.length;
    lib.state.assets = makeAssets(3);
    await act(async () => {
      lib.emitChange();
      lib.emitChange();
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
    // 연달아 온 두 이벤트는 한 번의 읽기로 묶인다.
    expect(lib.ports.listPhotos.mock.calls.length).toBe(before + 1);
    expect(screen.queryByTestId('photo-cell-a4')).toBeNull();
    expect(screen.getByTestId('photo-cell-a3')).toBeTruthy();
  });

  it('보관함이 비어 있으면 말한다(일부 허용이면 다음 행동까지)', async () => {
    const lib = makeLibrary({permission: 'limited', assets: []});
    await renderCard(lib.ports);
    expect(await screen.findByTestId('photo-empty')).toBeTruthy();
    expect(screen.getByText(PHOTO_COPY.emptyLimitedDetail)).toBeTruthy();
  });

  it('목록을 못 읽으면 다시 불러오기를 세운다', async () => {
    const lib = makeLibrary();
    lib.ports.listPhotos.mockRejectedValueOnce(new Error('boom'));
    await renderCard(lib.ports);
    expect(await screen.findByTestId('photo-load-failed')).toBeTruthy();
    await press('photo-retry');
    expect(await screen.findByTestId('photo-grid')).toBeTruthy();
  });
});

describe('고르기 — 토글·순번·상한', () => {
  it('탭은 선택 토글이고 순서가 순번이며 알약이 「N장 첨부」로 바뀐다', async () => {
    const lib = makeLibrary();
    await renderCard(lib.ports);
    expect(await screen.findByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.allPhotos);
    await press('photo-cell-a1');
    await press('photo-cell-a3');
    expect(screen.getByTestId('photo-order-a1')).toHaveTextContent('1');
    expect(screen.getByTestId('photo-order-a3')).toHaveTextContent('2');
    expect(screen.getByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.attach(2));
    // 첫 장을 빼면 뒤의 번호가 당겨진다.
    await press('photo-cell-a1');
    expect(screen.queryByTestId('photo-order-a1')).toBeNull();
    expect(screen.getByTestId('photo-order-a3')).toHaveTextContent('1');
    // 다 빼면 알약이 「전체 사진」으로 돌아온다.
    await press('photo-cell-a3');
    expect(screen.getByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.allPhotos);
  });

  it('선택이 없을 때 알약은 시스템 사진 창(기존 picker)을 연다', async () => {
    const lib = makeLibrary();
    const {props} = await renderCard(lib.ports);
    await press('photo-pill');
    expect(props.onOpenSystemPicker).toHaveBeenCalledTimes(1);
    expect(lib.ports.resolvePhoto).not.toHaveBeenCalled();
  });

  it('상한: 트레이에 18개가 있으면 둘째 사진까지만 고르고 셋째는 안내만 선다', async () => {
    const lib = makeLibrary();
    await renderCard(lib.ports, {room: 2});
    await screen.findByTestId('photo-grid');
    await press('photo-cell-a1');
    await press('photo-cell-a2');
    await press('photo-cell-a3');
    expect(screen.queryByTestId('photo-order-a3')).toBeNull();
    expect(screen.getByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.attach(2));
    expect(screen.getByTestId('photo-notice')).toHaveTextContent(PHOTO_COPY.capped(2));
    // 상한에서도 이미 고른 것을 빼고 다른 것을 고를 수 있다.
    await press('photo-cell-a1');
    await press('photo-cell-a3');
    expect(screen.getByTestId('photo-order-a3')).toHaveTextContent('2');
  });

  it('상한 안내는 낭독으로도 전해진다', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    const lib = makeLibrary();
    await renderCard(lib.ports, {room: 1});
    await screen.findByTestId('photo-grid');
    await press('photo-cell-a1');
    await press('photo-cell-a2');
    expect(announce).toHaveBeenCalledWith(PHOTO_COPY.capped(1));
  });

  it('트레이가 다른 길로 늘어 상한이 줄면 뒤쪽 선택부터 걷는다', async () => {
    const lib = makeLibrary();
    const view = await renderCard(lib.ports, {room: 5});
    await screen.findByTestId('photo-grid');
    for (const id of ['a1', 'a2', 'a3']) await press(`photo-cell-${id}`);
    view.update({room: 2});
    await settle();
    expect(screen.getByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.attach(2));
    expect(screen.queryByTestId('photo-order-a3')).toBeNull();
  });

  it('셀은 날짜와 선택 상태를 낭독한다', async () => {
    const lib = makeLibrary();
    await renderCard(lib.ports);
    const cell = await screen.findByTestId('photo-cell-a1');
    expect(cell.props.accessibilityLabel).toMatch(/^\d+월 \d+일 사진$/);
    expect(cell.props.accessibilityValue).toEqual({text: PHOTO_COPY.notSelected});
    await act(async () => {
      fireEvent.press(cell);
    });
    const again = screen.getByTestId('photo-cell-a1');
    expect(again.props.accessibilityValue).toEqual({text: PHOTO_COPY.selected(1)});
    expect(again.props.accessibilityState).toEqual({selected: true});
  });
});

describe('첨부 — 고른 순서대로, 한 번의 호출로', () => {
  it('둘을 고르고 알약을 누르면 두 장이 순서대로 파일이 되어 한 번의 onAttach 로 간다', async () => {
    const lib = makeLibrary();
    const {props} = await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    await press('photo-cell-a3');
    await press('photo-cell-a1');
    await press('photo-pill');
    await waitFor(() => expect(props.onDone).toHaveBeenCalledTimes(1));
    expect(lib.ports.resolvePhoto.mock.calls.map(call => call[0].id)).toEqual(['a3', 'a1']);
    // `addPickedFiles` 는 일부만 받으면 던진다 — 여러 번 나눠 부르지 않는다.
    expect(props.onAttach).toHaveBeenCalledTimes(1);
    expect((props.onAttach as jest.Mock).mock.calls[0][0].map((file: PickedAttachmentFile) => file.uri)).toEqual([
      'file:///cache/a3.jpg',
      'file:///cache/a1.jpg',
    ]);
  });

  it('iCloud 에서 내려받는 동안 그 사실을 말하고, 끝나면 걷는다', async () => {
    let release: (() => void) | null = null;
    const lib = makeLibrary({
      resolve: (asset, hooks) =>
        new Promise<PickedAttachmentFile>(resolve => {
          hooks.onDownloading();
          release = () => resolve(fileFor(asset));
        }),
    });
    const {props} = await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    await press('photo-cell-a1');
    await press('photo-pill');
    expect(await screen.findByText(PHOTO_COPY.downloading)).toBeTruthy();
    // 변환 중에는 알약이 눌리지 않는다(두 번 누르면 두 번 올라간다).
    expect(screen.getByTestId('photo-pill').props.accessibilityState).toMatchObject({busy: true});
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(props.onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(PHOTO_COPY.downloading)).toBeNull();
  });

  it('하나도 못 가져오면 닫지 않고 이유를 말한다(선택은 남는다)', async () => {
    const lib = makeLibrary({
      resolve: async () => {
        throw new PhotoResolveError('unavailable');
      },
    });
    const {props} = await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    await press('photo-cell-a1');
    await press('photo-pill');
    expect(await screen.findByText(PHOTO_COPY.resolveFailed)).toBeTruthy();
    expect(props.onAttach).not.toHaveBeenCalled();
    expect(props.onDone).not.toHaveBeenCalled();
    expect(screen.getByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.attach(1));
  });

  it('iCloud 실패는 연결을 확인하라고 말한다', async () => {
    const lib = makeLibrary({
      resolve: async () => {
        throw new PhotoResolveError('cloud');
      },
    });
    await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    await press('photo-cell-a1');
    await press('photo-pill');
    expect(await screen.findByText(PHOTO_COPY.cloudFailed)).toBeTruthy();
  });

  it('일부만 실패하면 된 것은 넘기고 실패한 것은 선택에 남긴다(카드는 닫지 않는다)', async () => {
    const lib = makeLibrary({
      resolve: async asset => {
        if (asset.id === 'a2') throw new PhotoResolveError('unavailable');
        return fileFor(asset);
      },
    });
    const {props} = await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    for (const id of ['a1', 'a2', 'a3']) await press(`photo-cell-${id}`);
    await press('photo-pill');
    expect(await screen.findByText(PHOTO_COPY.partialFailed(1))).toBeTruthy();
    expect(props.onAttach).toHaveBeenCalledTimes(1);
    expect((props.onAttach as jest.Mock).mock.calls[0][0]).toHaveLength(2);
    expect(props.onDone).not.toHaveBeenCalled();
    // 실패한 한 장만 선택에 남고, 순번은 1 이다.
    expect(screen.getByTestId('photo-order-a2')).toHaveTextContent('1');
    expect(screen.queryByTestId('photo-order-a1')).toBeNull();
    expect(screen.getByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.attach(1));
  });

  it('변환하는 동안 트레이가 다른 길로 차서 상한이 줄면 상한만큼만 넘기고 나머지는 선택에 남긴다', async () => {
    const releases: Array<() => void> = [];
    const lib = makeLibrary({
      resolve: asset =>
        new Promise<PickedAttachmentFile>(resolve => {
          releases.push(() => resolve(fileFor(asset)));
        }),
    });
    const view = await renderCard(lib.ports, {room: 3});
    await screen.findByTestId('photo-grid');
    for (const id of ['a1', 'a2', 'a3']) await press(`photo-cell-${id}`);
    await press('photo-pill');
    await settle();
    // 변환이 도는 사이 다른 길(예: 카메라)로 트레이가 두 개 늘었다 — 상한이 1 로 줄었다.
    view.update({room: 1});
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        releases[index]?.();
        await Promise.resolve();
      });
      await settle();
    }
    // `addPickedFiles` 는 일부라도 거절되면 던진다 — 상한을 넘겨 부르지 않는다.
    expect(view.props.onAttach).toHaveBeenCalledTimes(1);
    expect((view.props.onAttach as jest.Mock).mock.calls[0][0]).toHaveLength(1);
    expect(view.props.onDone).not.toHaveBeenCalled();
    expect(await screen.findByText(PHOTO_COPY.capped(1))).toBeTruthy();
  });

  it('호스트가 첨부를 거절해 던져도(불변식) 카드가 죽지 않고 선택을 남긴다', async () => {
    const lib = makeLibrary();
    const onAttach = jest.fn(() => {
      throw new Error('attachment picker invariant');
    });
    const view = await renderCard(lib.ports, {onAttach});
    await screen.findByTestId('photo-grid');
    await press('photo-cell-a1');
    await press('photo-pill');
    expect(await screen.findByText(PHOTO_COPY.resolveFailed)).toBeTruthy();
    expect(view.props.onDone).not.toHaveBeenCalled();
    expect(screen.getByTestId('photo-pill')).toHaveTextContent(PHOTO_COPY.attach(1));
  });

  it('변환 도중 카드가 닫히면 만든 파일을 넘기지 않는다(사람이 취소한 것이다)', async () => {
    let release: (() => void) | null = null;
    const lib = makeLibrary({
      resolve: asset =>
        new Promise<PickedAttachmentFile>(resolve => {
          release = () => resolve(fileFor(asset));
        }),
    });
    const view = await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    await press('photo-cell-a1');
    await press('photo-pill');
    await settle();
    view.update({active: false});
    await act(async () => {
      release?.();
    });
    await settle();
    expect(view.props.onAttach).not.toHaveBeenCalled();
    expect(view.props.onDone).not.toHaveBeenCalled();
  });
});

describe('페이지 로딩 — 커서로 이어 받는다', () => {
  it('끝에 닿으면 마지막 자산 id 를 커서로 다음 쪽을 부르고, 중복 없이 이어 붙인다', async () => {
    const lib = makeLibrary({assets: makeAssets(100)});
    await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    expect(lib.ports.listPhotos).toHaveBeenLastCalledWith(null, PHOTO_CARD.pageSize);
    await act(async () => {
      fireEvent(screen.getByTestId('photo-grid'), 'endReached');
    });
    await waitFor(() => expect(lib.ports.listPhotos).toHaveBeenCalledTimes(2));
    expect(lib.ports.listPhotos).toHaveBeenLastCalledWith('a60', PHOTO_CARD.pageSize);
  });

  it('끝에 연달아 닿아도 같은 커서로 두 번 나가지 않는다', async () => {
    const lib = makeLibrary({assets: makeAssets(100)});
    await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    await act(async () => {
      fireEvent(screen.getByTestId('photo-grid'), 'endReached');
      fireEvent(screen.getByTestId('photo-grid'), 'endReached');
      fireEvent(screen.getByTestId('photo-grid'), 'endReached');
    });
    await waitFor(() => expect(lib.ports.listPhotos).toHaveBeenCalledTimes(2));
    expect(lib.ports.listPhotos.mock.calls.filter(call => call[0] === 'a60')).toHaveLength(1);
  });

  it('더 없으면 끝에 닿아도 부르지 않는다', async () => {
    const lib = makeLibrary({assets: makeAssets(9)});
    await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    await act(async () => {
      fireEvent(screen.getByTestId('photo-grid'), 'endReached');
    });
    expect(lib.ports.listPhotos).toHaveBeenCalledTimes(1);
  });

  it('커서가 가리키던 사진이 사라졌으면 첫 쪽부터 다시 읽는다', async () => {
    const lib = makeLibrary({assets: makeAssets(100)});
    await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    // 다음 쪽을 부르는 순간 커서 사진이 사라진 것처럼 만든다.
    lib.state.assets = makeAssets(100).filter(asset => asset.id !== 'a60');
    await act(async () => {
      fireEvent(screen.getByTestId('photo-grid'), 'endReached');
    });
    await waitFor(() => expect(lib.ports.listPhotos).toHaveBeenCalledTimes(3));
    expect(lib.ports.listPhotos).toHaveBeenNthCalledWith(2, 'a60', PHOTO_CARD.pageSize);
    expect(lib.ports.listPhotos).toHaveBeenNthCalledWith(3, null, PHOTO_CARD.pageSize);
  });
});

describe('겉모습', () => {
  it('뒤로 원은 메뉴로 돌아간다', async () => {
    const lib = makeLibrary();
    const {props} = await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    await press('photo-back');
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('뒤로 원은 보조 조작이라 주 조작(알약)과 채움이 다르다 — 보조는 면, 주는 잉크', async () => {
    const lib = makeLibrary();
    await renderCard(lib.ports);
    await screen.findByTestId('photo-grid');
    const fill = (testID: string) =>
      (Object.assign({}, ...([] as object[]).concat(screen.getByTestId(testID).props.style)) as {
        backgroundColor?: string;
      }).backgroundColor;
    expect(fill('photo-back')).toBe(lightPalette.surface);
    expect(fill('photo-pill')).toBe(lightPalette.primary);
    expect(fill('photo-back')).not.toBe(fill('photo-pill'));
  });

  it('권한 면에서도 뒤로 원이 선다(막다른 길이 없다)', async () => {
    const lib = makeLibrary({permission: 'denied'});
    const {props} = await renderCard(lib.ports);
    await screen.findByTestId('photo-pane-denied');
    await press('photo-back');
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('라이트·다크 모두 같은 구조로 선다', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const lib = makeLibrary();
      const view = await renderCard(lib.ports, {}, scheme);
      expect(await screen.findByTestId('photo-grid')).toBeTruthy();
      view.unmount();
    }
  });

  it('카드 크기는 호스트가 준 값 그대로다', async () => {
    const lib = makeLibrary();
    await renderCard(lib.ports, {size: {width: 300, height: 321}});
    const card = await screen.findByTestId('photo-card');
    const flat = Object.assign({}, ...([] as object[]).concat(card.props.style));
    expect(flat).toMatchObject({width: 300, height: 321});
  });
});

describe('문장 — 전부 해요체다', () => {
  const sentences = (): string[] => {
    const out: string[] = [];
    for (const value of Object.values(PHOTO_COPY)) {
      if (typeof value === 'string') out.push(value);
      else if (typeof value === 'function') {
        out.push(
          (value as (...args: number[]) => string)(2, 5),
          (value as (...args: Array<string | null>) => string)('10월 21일'),
        );
      }
    }
    return out;
  };

  it('합쇼체 어미(~습니다·~ㅂ니다)가 하나도 없다', () => {
    const offenders = sentences().filter(text => /(습니다|입니다|됩니다|합니다|십시오)[.!?]?\s*$/.test(text));
    expect(offenders).toEqual([]);
  });

  it('권한을 설명하는 문장은 사진이 기기 밖으로 나가지 않는다는 말을 한다', () => {
    expect(PHOTO_COPY.askDetail).toMatch(/기기 밖으로 나가지 않아요/);
  });
});
