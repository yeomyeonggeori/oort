import {MAX_ATTACHMENTS_PER_MESSAGE} from '@momo/core/features/attachments/model';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Animated, Dimensions, type View} from 'react-native';

import {FixedScheme} from '../src/design/theme';
import {lightPalette} from '../src/design/tokens';
import {
  ATTACH_MENU,
  AttachMenu,
  attachMenuFrame,
  type AttachMenuPhotos,
  type Rect,
} from '../src/features/attachments/AttachMenu';
import {PHOTO_CARD, photoCardSize} from '../src/features/attachments/photoCardDesign';
import type {
  PhotoAsset,
  PhotoLibraryPorts,
  PhotoPermission,
} from '../src/features/attachments/photoLibrary';
import type {PickedAttachmentFile} from '../src/features/attachments/picker';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 첨부 메뉴 → 사진 카드 변신 (#4181) — 메뉴의 「사진」 행이 시스템 picker 대신 카드로 변신하고,
// 뒤로는 메뉴로 접히고, 카드 안의 「전체 사진」은 옛 길(`onPickPhoto`)로 가고, 메뉴만 열어서는
// 사진 권한 API 가 한 번도 불리지 않는다. 메뉴 자체의 시험은 `attachMenu.test.tsx` 가 진다.
// =============================================================================

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const BUZZ_WINDOW = {width: 402, height: 874};
const BUZZ_ANCHOR: Rect = {x: 50, y: 801.5, width: 35, height: 35};

function fakeAnchor() {
  return {
    current: {
      props: {accessibilityLabel: '파일 첨부'},
      measureInWindow: (done: (x: number, y: number, w: number, h: number) => void) =>
        done(BUZZ_ANCHOR.x, BUZZ_ANCHOR.y, BUZZ_ANCHOR.width, BUZZ_ANCHOR.height),
    } as unknown as View,
  };
}

function assets(count: number): PhotoAsset[] {
  return Array.from({length: count}, (_, index) => ({
    id: `m${index + 1}`,
    uri: `ph://m${index + 1}`,
    filename: `IMG_${index + 1}.JPG`,
    width: 100,
    height: 100,
    creationTimeMs: 1_760_000_000_000 - index * 1000,
  }));
}

function fakePorts(permission: PhotoPermission = 'undetermined') {
  const state = {permission};
  const list = assets(9);
  const ports: jest.Mocked<PhotoLibraryPorts> = {
    getPermission: jest.fn(async () => state.permission),
    requestPermission: jest.fn(async () => {
      state.permission = 'granted';
      return state.permission;
    }),
    presentLimitedPicker: jest.fn(async () => undefined),
    listPhotos: jest.fn(async (_after: string | null, _first: number) => ({
      assets: list,
      endCursor: null,
      hasNextPage: false,
    })),
    resolvePhoto: jest.fn(async (asset: PhotoAsset, _hooks: {onDownloading: () => void}) => ({
      uri: `file:///cache/${asset.id}.jpg`,
      name: asset.filename,
      mime: 'image/jpeg',
      sizeBytes: 10,
      sizeKnown: true,
    })),
    subscribe: jest.fn((_onChange: () => void) => () => undefined),
    openSettings: jest.fn(),
  };
  return ports;
}

interface Handlers {
  onClose: jest.Mock;
  onPickCamera: jest.Mock;
  onPickPhoto: jest.Mock;
  onPickFile: jest.Mock;
  onDismissed: jest.Mock;
  onAttach: jest.Mock;
}

function setup(permission: PhotoPermission = 'undetermined', room = MAX_ATTACHMENTS_PER_MESSAGE) {
  const ports = fakePorts(permission);
  const h: Handlers = {
    onClose: jest.fn(),
    onPickCamera: jest.fn(),
    onPickPhoto: jest.fn(),
    onPickFile: jest.fn(),
    onDismissed: jest.fn(),
    onAttach: jest.fn(),
  };
  const anchorRef = fakeAnchor();
  const tree = (visible: boolean, withPhotos = true) => {
    const photos: AttachMenuPhotos | undefined = withPhotos
      ? {ports, room, onAttach: h.onAttach as (files: PickedAttachmentFile[]) => void}
      : undefined;
    return (
      <FixedScheme scheme="light">
        <AttachMenu
          visible={visible}
          anchorRef={anchorRef}
          onClose={h.onClose}
          onPickCamera={h.onPickCamera}
          onPickPhoto={h.onPickPhoto}
          onPickFile={h.onPickFile}
          onDismissed={h.onDismissed}
          photos={photos}
        />
      </FixedScheme>
    );
  };
  const view = render(tree(true));
  return {
    ports,
    ...h,
    rerender: (visible: boolean, withPhotos = true) => view.rerender(tree(visible, withPhotos)),
  };
}

async function open() {
  installAppClock();
  jest.spyOn(Dimensions, 'get').mockReturnValue({...BUZZ_WINDOW, scale: 3, fontScale: 1});
  const harness = setup();
  await act(async () => {
    jest.advanceTimersByTime(ATTACH_MENU.anchorWaitMs + 50);
    await Promise.resolve();
  });
  // 연타 방어(`touchGuardMs`)가 지난 뒤의 누름이 되도록.
  await act(async () => {
    jest.advanceTimersByTime(ATTACH_MENU.touchGuardMs + 20);
  });
  return harness;
}

async function pressPhotoRow() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('attachment-pick-photo'));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settleMorph() {
  await act(async () => {
    jest.advanceTimersByTime(1500);
    await Promise.resolve();
  });
}

describe('변신 — 「사진」 행이 메뉴를 카드로 바꾼다', () => {
  it('메뉴만 열려 있는 동안에는 사진 권한 API 가 한 번도 불리지 않는다', async () => {
    const h = await open();
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
    expect(screen.queryByTestId('attach-photo-host')).toBeNull();
    expect(h.ports.getPermission).not.toHaveBeenCalled();
    expect(h.ports.requestPermission).not.toHaveBeenCalled();
    expect(h.ports.listPhotos).not.toHaveBeenCalled();
  });

  it('「사진」을 누르면 시스템 picker 대신 변신하고, 상태만 읽는다(요청은 「허용」)', async () => {
    const h = await open();
    await pressPhotoRow();
    expect(h.onPickPhoto).not.toHaveBeenCalled();
    expect(screen.getByTestId('attach-photo-host')).toBeTruthy();
    // 변신 중에는 진짜 메뉴 카드가 자리만 지킨다(같은 자리에 틀이 선다).
    expect(screen.queryByTestId('attach-menu')).toBeNull();
    expect(h.ports.getPermission).toHaveBeenCalledTimes(1);
    expect(h.ports.requestPermission).not.toHaveBeenCalled();
    await settleMorph();
    expect(await screen.findByTestId('photo-pane-undetermined')).toBeTruthy();
    expect(h.ports.requestPermission).not.toHaveBeenCalled();
  });

  it('카드는 메뉴와 바닥·왼쪽이 같은 자리에서 자란다', async () => {
    await open();
    await pressPhotoRow();
    await settleMorph();
    const host = screen.getByTestId('attach-photo-host');
    const style = Object.assign({}, ...([] as object[]).concat(host.props.style)) as Record<string, number>;
    const menu = attachMenuFrame(BUZZ_ANCHOR, BUZZ_WINDOW, {top: 0, left: 0, right: 0});
    const size = photoCardSize(BUZZ_WINDOW);
    expect(style.left).toBe(menu.left);
    expect(style.left + style.width).toBeLessThanOrEqual(BUZZ_WINDOW.width - PHOTO_CARD.inset);
    // 바닥이 같다 — 메뉴의 아래 끝이 카드의 아래 끝이다.
    expect(style.top + style.height).toBeCloseTo(menu.top + menu.height, 5);
    expect(style.width).toBe(size.width);
  });

  it('뒤로는 메뉴로 접히고, 메뉴가 다시 눌린다', async () => {
    const h = await open();
    await pressPhotoRow();
    await settleMorph();
    await act(async () => {
      fireEvent.press(await screen.findByTestId('photo-back'));
      await Promise.resolve();
    });
    await settleMorph();
    expect(screen.queryByTestId('attach-photo-host')).toBeNull();
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('attachment-pick-file'));
    });
    expect(h.onPickFile).toHaveBeenCalledTimes(1);
  });

  it('접히는 동안에는 메뉴 행이 눌리지 않는다(두 번 누르면 카드가 다시 열린다)', async () => {
    const h = await open();
    await pressPhotoRow();
    await settleMorph();
    await act(async () => {
      fireEvent.press(await screen.findByTestId('photo-back'));
    });
    // 접는 중: 틀의 메뉴 층은 보이지만 눌리지 않는다.
    const menuLayer = screen.getByTestId('photo-morph-menu', {includeHiddenElements: true});
    const inner = menuLayer.children[0] as unknown as {props: {pointerEvents?: string}};
    expect(inner.props.pointerEvents).toBe('none');
    await settleMorph();
    expect(h.onPickFile).not.toHaveBeenCalled();
  });

  it('다시 열면 메뉴에서 시작한다(변신 상태가 남아 있지 않다)', async () => {
    const h = await open();
    await pressPhotoRow();
    await settleMorph();
    h.rerender(false);
    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    h.rerender(true);
    await act(async () => {
      jest.advanceTimersByTime(ATTACH_MENU.anchorWaitMs + ATTACH_MENU.touchGuardMs + 100);
      await Promise.resolve();
    });
    expect(screen.queryByTestId('attach-photo-host')).toBeNull();
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
  });
});

describe('합성 — 실제 메뉴(#4180)와의 접점', () => {
  it('+ 원 자리의 닫기 표면은 카드로 변신하는 동안 서지 않는다(그 자리에 카드의 뒤로 원이 있다)', async () => {
    const h = await open();
    // 닫기 표면은 보조기술에서 숨는다 — 숨은 요소까지 물어야 서 있음을 읽는다.
    const hidden = {includeHiddenElements: true} as const;
    expect(screen.getByTestId('attach-menu-anchor-close', hidden)).toBeTruthy();
    await pressPhotoRow();
    await settleMorph();
    expect(screen.queryByTestId('attach-menu-anchor-close', hidden)).toBeNull();
    await act(async () => {
      fireEvent.press(await screen.findByTestId('photo-back'));
    });
    await settleMorph();
    // 메뉴로 돌아오면 다시 선다.
    expect(screen.getByTestId('attach-menu-anchor-close', hidden)).toBeTruthy();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('변신 틀은 몸통 색으로 카드 면(surface)을 받는다 — 중간 프레임에서 뒤 대화가 비치지 않는다', async () => {
    await open();
    await pressPhotoRow();
    const body = screen.getByTestId('photo-morph-body', {includeHiddenElements: true});
    const style = Object.assign({}, ...([] as object[]).concat(body.props.style)) as Record<string, unknown>;
    expect(style.backgroundColor).toBe(lightPalette.surface);
  });

  it('메뉴 모서리(34, 연속 곡선)에서 시작해 같은 값의 카드로 끝난다', async () => {
    await open();
    await pressPhotoRow();
    const frame = screen.getByTestId('photo-morph');
    const style = Object.assign({}, ...([] as object[]).concat(frame.props.style)) as Record<string, unknown>;
    expect(style.borderCurve).toBe('continuous');
    expect(ATTACH_MENU.radius).toBe(PHOTO_CARD.radius);
  });
});

describe('카드 안의 길', () => {
  it('「전체 사진에서 고르기」는 옛 길(onPickPhoto)로 간다', async () => {
    const h = await open();
    await pressPhotoRow();
    await settleMorph();
    await act(async () => {
      fireEvent.press(await screen.findByTestId('photo-pick-from-all'));
    });
    expect(h.onPickPhoto).toHaveBeenCalledTimes(1);
  });

  it('고르고 첨부하면 한 번의 onAttach 로 넘기고 메뉴를 닫는다', async () => {
    const h = await open();
    await pressPhotoRow();
    await settleMorph();
    await act(async () => {
      fireEvent.press(await screen.findByTestId('photo-allow'));
      await Promise.resolve();
      await Promise.resolve();
    });
    for (const id of ['m1', 'm2']) {
      await act(async () => {
        fireEvent.press(await screen.findByTestId(`photo-cell-${id}`));
      });
    }
    await act(async () => {
      fireEvent.press(screen.getByTestId('photo-pill'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.onAttach).toHaveBeenCalledTimes(1);
    expect(h.onAttach.mock.calls[0][0]).toHaveLength(2);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('카드가 선 채로 메뉴가 닫히면 카드는 서서히 걷힌다', async () => {
    const h = await open();
    await pressPhotoRow();
    await settleMorph();
    const timing = jest.spyOn(Animated, 'timing');
    h.rerender(false);
    const fades = timing.mock.calls.filter(
      call => (call[1] as {toValue: number}).toValue === 0,
    );
    expect(fades.length).toBeGreaterThanOrEqual(1);
  });

  it('카드가 없는 메뉴(photos 없음)는 「사진」이 옛 길 그대로다', async () => {
    installAppClock();
    jest.spyOn(Dimensions, 'get').mockReturnValue({...BUZZ_WINDOW, scale: 3, fontScale: 1});
    const h = setup();
    h.rerender(true, false);
    await act(async () => {
      jest.advanceTimersByTime(ATTACH_MENU.anchorWaitMs + ATTACH_MENU.touchGuardMs + 100);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('attachment-pick-photo'));
    });
    expect(h.onPickPhoto).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('attach-photo-host')).toBeNull();
  });
});
