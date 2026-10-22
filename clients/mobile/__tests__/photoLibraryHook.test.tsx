import {act, cleanup, renderHook} from '@testing-library/react-native';

import type {PhotoAsset, PhotoLibraryPorts, PhotoPermission} from '../src/features/attachments/photoLibrary';
import {usePhotoLibrary} from '../src/features/attachments/usePhotoLibrary';

// =============================================================================
// 사진 카드 훅 (#4181) — 화면을 거치지 않고 **행동**을 직접 부른다. 카드의 버튼은 상태에 따라 아예
// 서지 않으므로(거부 면에 「허용」이 없다), 「그 상태에서 그 행동을 불러도 헛일이다」는 화면 시험이
// 닿지 못하는 가드다 — 호출을 직접 걸어 포트 호출 횟수로 잰다.
// =============================================================================

afterEach(cleanup);

function ports(permission: PhotoPermission, answer: PhotoPermission = 'granted') {
  const state = {permission};
  const assets: PhotoAsset[] = [
    {id: 'a1', uri: 'ph://a1', filename: 'a1.JPG', width: 1, height: 1, creationTimeMs: 1},
  ];
  const fake: jest.Mocked<PhotoLibraryPorts> = {
    getPermission: jest.fn(async () => state.permission),
    requestPermission: jest.fn(async () => {
      state.permission = answer;
      return state.permission;
    }),
    presentLimitedPicker: jest.fn(async () => undefined),
    listPhotos: jest.fn(async (_after: string | null, _first: number) => ({
      assets,
      endCursor: 'a1',
      hasNextPage: false,
    })),
    resolvePhoto: jest.fn(),
    subscribe: jest.fn((_onChange: () => void) => () => undefined),
    openSettings: jest.fn(),
  };
  return fake;
}

async function mount(fake: PhotoLibraryPorts, active = true) {
  const view = renderHook(
    (props: {active: boolean}) =>
      usePhotoLibrary({
        ports: fake,
        active: props.active,
        room: 20,
        onAttach: jest.fn(),
        onDone: jest.fn(),
      }),
    {initialProps: {active}},
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

describe('request — 미결정일 때만 묻는다', () => {
  it('미결정에서 부르면 한 번 묻고 답을 상태로 받는다', async () => {
    const fake = ports('undetermined', 'limited');
    const view = await mount(fake);
    expect(view.result.current.permission).toBe('undetermined');
    await act(async () => {
      view.result.current.request();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fake.requestPermission).toHaveBeenCalledTimes(1);
    expect(view.result.current.permission).toBe('limited');
  });

  it.each(['denied', 'limited', 'granted'] as const)(
    '%s 에서 부르면 묻지 않는다(iOS 는 다시 묻지 않으므로 헛일이다)',
    async permission => {
      const fake = ports(permission);
      const view = await mount(fake);
      await act(async () => {
        view.result.current.request();
        await Promise.resolve();
      });
      expect(fake.requestPermission).not.toHaveBeenCalled();
    },
  );

  it('두 번 연달아 눌러도 프롬프트는 한 번이다', async () => {
    const fake = ports('undetermined');
    const view = await mount(fake);
    await act(async () => {
      view.result.current.request();
      view.result.current.request();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fake.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('닫힌 상태에서는 아무 행동도 포트를 부르지 않는다', async () => {
    const fake = ports('undetermined');
    const view = await mount(fake, false);
    await act(async () => {
      view.result.current.request();
      view.result.current.retry();
      view.result.current.loadMore();
      await Promise.resolve();
    });
    expect(fake.getPermission).not.toHaveBeenCalled();
    expect(fake.requestPermission).not.toHaveBeenCalled();
    // `retry` 는 목록 재읽기라 사진을 읽을 수 없는 상태에서는 부르지 않는다.
    expect(fake.listPhotos).not.toHaveBeenCalled();
  });
});
