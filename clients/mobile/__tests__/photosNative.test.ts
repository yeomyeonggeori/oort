import {Linking} from 'react-native';

import {PHOTO_CARD} from '../src/features/attachments/photoCardDesign';
import {
  HEIC_JPEG_QUALITY,
  nativePhotoPorts,
  PHOTO_ATTACH_DIRECTORY,
} from '../src/features/attachments/photosNative';
import {PhotoResolveError, type PhotoAsset} from '../src/features/attachments/photoLibrary';

// =============================================================================
// 사진 보관함의 네이티브 포트 (#4181) — 유일하게 `expo-media-library/legacy` 에 닿는 파일의
// 변환과 호출. 모듈은 jest.setup.js 의 목이다. 진짜 네이티브가 하는 일(PhotoKit)은 시뮬레이터
// 캡처가 보이고, 여기서는 **어떤 인자로 무엇을 부르는가**와 결과의 모양을 못 박는다.
// =============================================================================

interface MediaLibraryMock {
  __state: {
    permission: {status: string; accessPrivileges: string; granted: boolean; canAskAgain: boolean};
    answer: {status: string; accessPrivileges: string; granted: boolean; canAskAgain: boolean};
    assets: unknown[];
    info: Map<string, unknown>;
    failure: Error | null;
    listeners: Set<(event: unknown) => void>;
  };
  __reset: () => void;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  presentPermissionsPickerAsync: jest.Mock;
  getAssetsAsync: jest.Mock;
  getAssetInfoAsync: jest.Mock;
  addListener: jest.Mock;
}

interface FileSystemMock {
  File: {new (...parts: string[]): {uri: string}; prototype: Record<string, unknown>};
  __files: Set<string>;
  __state: {sizes: Map<string, number>};
  __reset: () => void;
}

interface ManipulatorMock {
  ImageManipulator: {manipulate: jest.Mock};
}

const mediaLibrary = jest.requireMock('expo-media-library/legacy') as MediaLibraryMock;
const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;
// 목 `File` 은 주소의 `///` 를 `//` 로 접는다(자기 `join`). 시험의 기대값도 같은 `File` 을 통해 만든다.
const norm = (uri: string): string => new fileSystem.File(uri).uri;
const manipulator = jest.requireMock('expo-image-manipulator') as ManipulatorMock;

// 목 `File` 에는 `copy` 가 없다 — 이 파일의 시험이 필요로 하는 만큼만 붙인다.
const copies: Array<{from: string; to: string}> = [];
beforeAll(() => {
  fileSystem.File.prototype.copy = async function copy(
    this: {uri: string},
    destination: {uri: string},
  ) {
    copies.push({from: this.uri, to: destination.uri});
    fileSystem.__files.add(destination.uri);
    fileSystem.__state.sizes.set(
      destination.uri,
      fileSystem.__state.sizes.get(this.uri) ?? 0,
    );
  };
});

beforeEach(() => {
  mediaLibrary.__reset();
  fileSystem.__reset();
  copies.length = 0;
  jest.clearAllMocks();
});

function nativeAsset(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    filename: `${id}.JPG`,
    uri: `ph://${id}`,
    mediaType: 'photo',
    width: 4032,
    height: 3024,
    creationTime: 1_760_000_000_000,
    modificationTime: 1_760_000_000_000,
    duration: 0,
    ...over,
  };
}

function asset(id: string, filename = `${id}.JPG`): PhotoAsset {
  return {
    id,
    uri: `ph://${id}`,
    filename,
    width: 4032,
    height: 3024,
    creationTimeMs: 1_760_000_000_000,
  };
}

describe('권한', () => {
  it('상태를 읽는 것은 프롬프트 없는 getPermissionsAsync 한 번이다', async () => {
    expect(await nativePhotoPorts.getPermission()).toBe('undetermined');
    expect(mediaLibrary.getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('전체·일부·거부를 읽는다', async () => {
    mediaLibrary.__state.permission = {
      status: 'granted',
      accessPrivileges: 'limited',
      granted: true,
      canAskAgain: true,
    };
    expect(await nativePhotoPorts.getPermission()).toBe('limited');
    mediaLibrary.__state.permission = {
      status: 'granted',
      accessPrivileges: 'all',
      granted: true,
      canAskAgain: true,
    };
    expect(await nativePhotoPorts.getPermission()).toBe('granted');
    mediaLibrary.__state.permission = {
      status: 'denied',
      accessPrivileges: 'none',
      granted: false,
      canAskAgain: false,
    };
    expect(await nativePhotoPorts.getPermission()).toBe('denied');
  });

  it('요청은 사람의 답을 4상태로 돌려준다', async () => {
    mediaLibrary.__state.answer = {
      status: 'granted',
      accessPrivileges: 'limited',
      granted: true,
      canAskAgain: true,
    };
    expect(await nativePhotoPorts.requestPermission()).toBe('limited');
    expect(mediaLibrary.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('일부 허용 창은 사진 종류를 photo 로 묻는다', async () => {
    await nativePhotoPorts.presentLimitedPicker();
    expect(mediaLibrary.presentPermissionsPickerAsync).toHaveBeenCalledWith(['photo']);
  });

  it('설정 열기는 기기 설정 앱으로 간다', () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    nativePhotoPorts.openSettings();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('목록 — 최신순·사진만·커서', () => {
  it('첫 쪽은 after 없이, 다음 쪽은 endCursor 를 after 로 부른다', async () => {
    mediaLibrary.__state.assets = Array.from({length: 5}, (_, index) =>
      nativeAsset(`n${index + 1}`),
    );
    const first = await nativePhotoPorts.listPhotos(null, 2);
    expect(mediaLibrary.getAssetsAsync).toHaveBeenLastCalledWith({
      first: 2,
      after: undefined,
      mediaType: ['photo'],
      sortBy: [['creationTime', false]],
    });
    expect(first.assets.map(a => a.id)).toEqual(['n1', 'n2']);
    expect(first.hasNextPage).toBe(true);
    expect(first.endCursor).toBe('n2');
    const second = await nativePhotoPorts.listPhotos(first.endCursor, 2);
    expect(mediaLibrary.getAssetsAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({after: 'n2'}),
    );
    expect(second.assets.map(a => a.id)).toEqual(['n3', 'n4']);
    const last = await nativePhotoPorts.listPhotos(second.endCursor, 2);
    expect(last.hasNextPage).toBe(false);
  });

  it('자산은 우리 모양으로 옮긴다(촬영 시각은 ms)', async () => {
    mediaLibrary.__state.assets = [nativeAsset('m1', {filename: 'IMG_0001.HEIC'})];
    const page = await nativePhotoPorts.listPhotos(null, PHOTO_CARD.pageSize);
    expect(page.assets[0]).toEqual({
      id: 'm1',
      uri: 'ph://m1',
      filename: 'IMG_0001.HEIC',
      width: 4032,
      height: 3024,
      creationTimeMs: 1_760_000_000_000,
    });
  });

  it('사라진 커서는 던진다(호출자가 첫 쪽으로 되돌린다)', async () => {
    mediaLibrary.__state.assets = [nativeAsset('x1')];
    await expect(nativePhotoPorts.listPhotos('gone', 2)).rejects.toThrow();
  });

  it('보관함 변경을 듣고 해제한다', () => {
    const onChange = jest.fn();
    const off = nativePhotoPorts.subscribe(onChange);
    expect(mediaLibrary.__state.listeners.size).toBe(1);
    for (const listener of mediaLibrary.__state.listeners) listener({hasIncrementalChanges: false});
    expect(onChange).toHaveBeenCalledTimes(1);
    off();
    expect(mediaLibrary.__state.listeners.size).toBe(0);
  });
});

describe('자산 → 파일', () => {
  it('기기에 있는 JPEG 는 원본을 앱 캐시 아래로 복사해 그 파일을 준다', async () => {
    mediaLibrary.__state.info.set('j1', {localUri: 'file:///library/IMG_J1.JPG'});
    fileSystem.__state.sizes.set(norm('file:///library/IMG_J1.JPG'), 2048);
    const onDownloading = jest.fn();
    const file = await nativePhotoPorts.resolvePhoto(asset('j1', 'IMG_J1.JPG'), {onDownloading});
    expect(mediaLibrary.getAssetInfoAsync).toHaveBeenCalledTimes(1);
    expect(mediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('j1', {
      shouldDownloadFromNetwork: false,
    });
    expect(copies).toHaveLength(1);
    expect(copies[0].from).toBe(norm('file:///library/IMG_J1.JPG'));
    expect(copies[0].to).toMatch(
      new RegExp(`^${norm('file:///cache')}/${PHOTO_ATTACH_DIRECTORY}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(file).toEqual({
      uri: copies[0].to,
      name: 'IMG_J1.JPG',
      mime: 'image/jpeg',
      sizeBytes: 2048,
      sizeKnown: true,
    });
    expect(onDownloading).not.toHaveBeenCalled();
    // 복사본이 사는 디렉터리가 만들어졌다.
    expect(fileSystem.__files.has(copies[0].to)).toBe(true);
  });

  it('HEIC 는 이미지 변환기로 JPEG 품질 0.9 로 다시 쓰고, 쓴 뒤 두 객체를 놓는다', async () => {
    mediaLibrary.__state.info.set('h1', {localUri: 'file:///library/IMG_H1.HEIC'});
    const release = jest.fn();
    const saveAsync = jest.fn(async () => ({
      uri: 'file:///cache/ImageManipulator/out.jpg',
      width: 4032,
      height: 3024,
    }));
    const renderAsync = jest.fn(async () => ({width: 4032, height: 3024, saveAsync, release}));
    const contextRelease = jest.fn();
    manipulator.ImageManipulator.manipulate.mockImplementationOnce(() => ({
      renderAsync,
      release: contextRelease,
    }));
    fileSystem.__state.sizes.set(norm('file:///cache/ImageManipulator/out.jpg'), 777);
    fileSystem.__files.add(norm('file:///cache/ImageManipulator/out.jpg'));

    const file = await nativePhotoPorts.resolvePhoto(asset('h1', 'IMG_H1.HEIC'), {
      onDownloading: jest.fn(),
    });
    expect(manipulator.ImageManipulator.manipulate).toHaveBeenCalledWith(
      'file:///library/IMG_H1.HEIC',
    );
    expect(saveAsync).toHaveBeenCalledWith({compress: HEIC_JPEG_QUALITY, format: 'jpeg'});
    expect(HEIC_JPEG_QUALITY).toBe(0.9);
    expect(release).toHaveBeenCalledTimes(1);
    expect(contextRelease).toHaveBeenCalledTimes(1);
    expect(copies).toHaveLength(0);
    expect(file).toEqual({
      uri: 'file:///cache/ImageManipulator/out.jpg',
      name: 'IMG_H1.jpg',
      mime: 'image/jpeg',
      sizeBytes: 777,
      sizeKnown: true,
    });
  });

  it('변환이 실패해도 두 객체를 놓는다', async () => {
    mediaLibrary.__state.info.set('h2', {localUri: 'file:///library/IMG_H2.HEIC'});
    const release = jest.fn();
    const contextRelease = jest.fn();
    manipulator.ImageManipulator.manipulate.mockImplementationOnce(() => ({
      renderAsync: async () => ({
        saveAsync: async () => {
          throw new Error('encode failed');
        },
        release,
      }),
      release: contextRelease,
    }));
    await expect(
      nativePhotoPorts.resolvePhoto(asset('h2', 'IMG_H2.HEIC'), {onDownloading: jest.fn()}),
    ).rejects.toThrow('encode failed');
    expect(release).toHaveBeenCalledTimes(1);
    expect(contextRelease).toHaveBeenCalledTimes(1);
  });

  it('iCloud 에만 있으면 먼저 기기 쪽을 묻고, 없다고 하면 내려받는다', async () => {
    const seen: boolean[] = [];
    mediaLibrary.__state.info.set('c1', (options: {shouldDownloadFromNetwork: boolean}) => {
      seen.push(options.shouldDownloadFromNetwork);
      return options.shouldDownloadFromNetwork
        ? {id: 'c1', localUri: 'file:///library/IMG_C1.JPG'}
        : {id: 'c1', isNetworkAsset: true};
    });
    const onDownloading = jest.fn();
    const file = await nativePhotoPorts.resolvePhoto(asset('c1', 'IMG_C1.JPG'), {onDownloading});
    expect(seen).toEqual([false, true]);
    expect(onDownloading).toHaveBeenCalledTimes(1);
    expect(file.name).toBe('IMG_C1.JPG');
  });

  it('원본을 못 받으면 PhotoResolveError 로 던진다(자산을 못 찾아도 같다)', async () => {
    mediaLibrary.__state.info.set('u1', {isNetworkAsset: false});
    const error = await nativePhotoPorts
      .resolvePhoto(asset('u1'), {onDownloading: jest.fn()})
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PhotoResolveError);
    expect((error as PhotoResolveError).reason).toBe('unavailable');
    // 목록에 없는 자산(방금 지워짐): 모듈이 빈 객체를 돌려준다.
    const missing = await nativePhotoPorts
      .resolvePhoto(asset('zzz'), {onDownloading: jest.fn()})
      .catch((caught: unknown) => caught);
    expect(missing).toBeInstanceOf(PhotoResolveError);
  });
});
