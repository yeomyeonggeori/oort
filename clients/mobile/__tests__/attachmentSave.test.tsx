import type {MessageAttachment} from '@momo/core/lib/api';
import {act, cleanup, renderHook, waitFor} from '@testing-library/react-native';
import {AccessibilityInfo, Linking} from 'react-native';

import {resetAttachmentContentForTest} from '../src/features/attachments/content';
import {nativeLibrarySave} from '../src/features/attachments/photosNative';
import {
  addPermissionFromResponse,
  fileNameFor,
  libraryExtension,
  runSave,
  saveRouteFor,
  uniqueName,
  type AddPermission,
  type SaveFile,
  type SavePorts,
} from '../src/features/attachments/saveAttachment';
import {
  isPickerCancel,
  nativeFileSave,
  PICKER_CANCELLED_CODE,
} from '../src/features/attachments/saveNative';
import {SAVE_RECEIPT_MS, saveNoticeKey, useSaveAttachment} from '../src/features/attachments/useSaveAttachment';

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({workspaceId: 'ws', member: {id: 'self'}, signOut: jest.fn()}),
}));

// =============================================================================
// 첨부 「저장」 (#5209, ADR-0168 증보 3): 사진·영상은 사진 보관함에 **추가 전용**으로, 그 밖의 파일은 파일 앱에서 위치를 골라.
//
// 이 파일이 지키는 것은 네 가지다 — 지킬 줄마다 고의로 깨서 빨개지는 것을 확인했다(인계의 사보타주 표).
//   ① 길: 무엇이 사진 갈래이고 무엇이 파일 갈래인가(보관함이 못 받는 형식은 처음부터 파일로).
//   ② 순서: 권한은 내려받기보다 **먼저**, 미결정에서만 한 번 묻고, 거부면 내려받지도 저장하지도 않는다.
//   ③ 포트: 권한은 `writeOnly` 로만 묻고(읽기·쓰기를 묻지 않는다), 확장자가 어긋난 파일은 맞는 사본으로, 파일 앱에는 사람이 보던 이름으로.
//   ④ 훅: 영수증만 시간으로 걷히고 실패·거부는 남는다. 취소는 실패가 아니다. 두 번 눌러도 한 번이다.
// =============================================================================

interface MediaLibraryMock {
  __state: {
    permission: {status: string};
    addPermission: {status: string};
    addAnswer: {status: string; accessPrivileges: string; granted: boolean; canAskAgain: boolean};
    saved: string[];
    saveFailure: Error | null;
  };
  __reset: () => void;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  saveToLibraryAsync: jest.Mock;
}

interface FileSystemMock {
  File: {new (...parts: unknown[]): {uri: string; exists: boolean}};
  __files: Set<string>;
  __state: {
    downloads: unknown[];
    failure: Error | null;
    pick: {directory: string; cancel: boolean; failure: Error | null};
    pickCalls: number;
  };
  __reset: () => void;
}

const mediaLibrary = jest.requireMock('expo-media-library/legacy') as MediaLibraryMock;
const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;

const PHOTO: MessageAttachment = {id: 'p1', name: '현장.png', mime: 'image/png', sizeBytes: 48_000};
const VIDEO: MessageAttachment = {id: 'v1', name: '영상.mp4', mime: 'video/mp4', sizeBytes: 6_000_000};
const PDF: MessageAttachment = {id: 'f1', name: '배포-결과.pdf', mime: 'application/pdf', sizeBytes: 2048};

beforeEach(() => {
  mediaLibrary.__reset();
  fileSystem.__reset();
  resetAttachmentContentForTest();
  jest.clearAllMocks();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ---- ① 길 ----------------------------------------------------------------------

describe('① 길 — 무엇이 사진 보관함으로, 무엇이 파일 앱으로 가는가', () => {
  it.each([
    ['image/jpeg', 'photos'],
    ['image/png', 'photos'],
    ['image/heic', 'photos'],
    ['image/gif', 'photos'],
    ['image/webp', 'photos'],
    ['video/mp4', 'photos'],
    ['video/quicktime', 'photos'],
    ['IMAGE/PNG; charset=binary', 'photos'],
  ])('%s 는 %s 갈래다', (mime, route) => {
    expect(saveRouteFor({mime})).toBe(route);
  });

  it.each([
    // SVG 는 보관함이 읽지 못한다(`UIImage(data:)` 가 nil) — 눌러 보기 전에 파일로.
    ['image/svg+xml'],
    // WebM·MKV 는 `UIVideoAtPathIsCompatibleWithSavedPhotosAlbum` 이 거절한다.
    ['video/webm'],
    ['video/x-matroska'],
    ['application/pdf'],
    ['application/zip'],
    ['text/plain'],
    ['application/octet-stream'],
    [''],
  ])('%s 는 파일 갈래다', mime => {
    expect(saveRouteFor({mime})).toBe('files');
  });

  it('확장자가 형식에 맞으면 그대로, 없거나 어긋나면 그 형식의 정식 확장자로 고친다', () => {
    expect(libraryExtension('image/jpeg', 'IMG_1.JPG')).toBeNull();
    expect(libraryExtension('image/jpeg', 'IMG_1.jpeg')).toBeNull();
    expect(libraryExtension('image/heic', 'a.heif')).toBeNull();
    expect(libraryExtension('video/quicktime', 'clip.mov')).toBeNull();
    expect(libraryExtension('video/mp4', 'clip.m4v')).toBeNull();
    // 이름에 확장자가 없다 — `saveToLibraryAsync` 는 확장자가 없으면 던진다.
    expect(libraryExtension('image/png', '현장')).toBe('png');
    // 확장자가 있지만 형식과 어긋난다(`assetType(for:)` 가 확장자로 가른다).
    expect(libraryExtension('image/png', 'photo.dat')).toBe('png');
    expect(libraryExtension('video/quicktime', 'clip.mp4')).toBe('mov');
    // 사진 갈래가 아닌 형식은 고치지 않는다.
    expect(libraryExtension('application/pdf', '문서')).toBeNull();
  });

  it('추가 전용 권한은 3상태이고 「일부 허용」을 따로 세우지 않는다', () => {
    expect(addPermissionFromResponse({status: 'granted'})).toBe('granted');
    expect(addPermissionFromResponse({status: 'denied'})).toBe('denied');
    expect(addPermissionFromResponse({status: 'undetermined'})).toBe('undetermined');
    expect(addPermissionFromResponse({status: 'whatever'})).toBe('undetermined');
  });

  it('폴더에 둘 이름은 경로가 되지 않고, 같은 이름이 있으면 번호를 붙인다', () => {
    expect(fileNameFor('a/b\\c:d.pdf')).toBe('a-b-c-d.pdf');
    expect(fileNameFor('   ')).toBe('attachment');
    expect(uniqueName('a.pdf', () => false)).toBe('a.pdf');
    expect(uniqueName('a.pdf', name => name === 'a.pdf')).toBe('a 2.pdf');
    expect(uniqueName('a.pdf', name => ['a.pdf', 'a 2.pdf'].includes(name))).toBe('a 3.pdf');
    expect(uniqueName('README', name => name === 'README')).toBe('README 2');
  });
});

// ---- ② 순서 ---------------------------------------------------------------------

function fakePorts(over: Partial<SavePorts> = {}, calls: string[] = []): SavePorts & {calls: string[]} {
  return {
    calls,
    getAddPermission: jest.fn(async (): Promise<AddPermission> => {
      calls.push('get');
      return 'granted';
    }),
    requestAddPermission: jest.fn(async (): Promise<AddPermission> => {
      calls.push('request');
      return 'granted';
    }),
    saveToLibrary: jest.fn(async () => {
      calls.push('library');
    }),
    saveToFiles: jest.fn(async () => {
      calls.push('files');
      return 'saved' as const;
    }),
    openSettings: jest.fn(),
    ...over,
  };
}

const FILE: SaveFile = {uri: 'file:///cache/p1-현장.png', name: '현장.png', mime: 'image/png'};

describe('② 순서 — 권한은 내려받기보다 먼저, 거부면 아무것도 받지 않는다', () => {
  it('허용돼 있으면 읽기 → 내려받기 → 보관함이다(프롬프트 없음)', async () => {
    const ports = fakePorts();
    const download = jest.fn(async () => {
      ports.calls.push('download');
      return FILE;
    });
    await expect(runSave('photos', {ports, download})).resolves.toEqual({kind: 'saved', route: 'photos'});
    expect(ports.calls).toEqual(['get', 'download', 'library']);
    expect(ports.saveToLibrary).toHaveBeenCalledWith(FILE);
    expect(ports.requestAddPermission).not.toHaveBeenCalled();
    expect(ports.saveToFiles).not.toHaveBeenCalled();
  });

  it('미결정이면 프롬프트를 **한 번** 묻고, 허용하면 그대로 저장한다', async () => {
    const ports = fakePorts({
      getAddPermission: jest.fn(async () => {
        return 'undetermined' as const;
      }),
    });
    await expect(runSave('photos', {ports, download: async () => FILE})).resolves.toEqual({
      kind: 'saved',
      route: 'photos',
    });
    expect(ports.requestAddPermission).toHaveBeenCalledTimes(1);
    expect(ports.saveToLibrary).toHaveBeenCalledTimes(1);
  });

  it('프롬프트에서 허용하지 않으면 내려받지도 저장하지도 않는다', async () => {
    const ports = fakePorts({
      getAddPermission: jest.fn(async () => 'undetermined' as const),
      requestAddPermission: jest.fn(async () => 'denied' as const),
    });
    const download = jest.fn(async () => FILE);
    await expect(runSave('photos', {ports, download})).resolves.toEqual({kind: 'denied'});
    expect(download).not.toHaveBeenCalled();
    expect(ports.saveToLibrary).not.toHaveBeenCalled();
  });

  it('이미 거부했으면 다시 묻지 않고(iOS 는 다시 묻지 않는다) 내려받지도 않는다', async () => {
    const ports = fakePorts({getAddPermission: jest.fn(async () => 'denied' as const)});
    const download = jest.fn(async () => FILE);
    await expect(runSave('photos', {ports, download})).resolves.toEqual({kind: 'denied'});
    expect(ports.requestAddPermission).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(ports.saveToLibrary).not.toHaveBeenCalled();
  });

  it('보관함이 던지면 실패다(내려받기는 한 번 했다)', async () => {
    const ports = fakePorts({saveToLibrary: jest.fn(async () => Promise.reject(new Error('boom')))});
    const download = jest.fn(async () => FILE);
    await expect(runSave('photos', {ports, download})).resolves.toEqual({kind: 'failed'});
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('내려받기가 던지면 어느 갈래든 실패이고 아무 데도 쓰지 않는다', async () => {
    for (const route of ['photos', 'files'] as const) {
      const ports = fakePorts();
      await expect(
        runSave(route, {ports, download: async () => Promise.reject(new Error('network'))}),
      ).resolves.toEqual({kind: 'failed'});
      expect(ports.saveToLibrary).not.toHaveBeenCalled();
      expect(ports.saveToFiles).not.toHaveBeenCalled();
    }
  });

  it('파일 갈래는 권한을 읽지도 묻지도 않고 보관함에 닿지 않는다', async () => {
    const ports = fakePorts();
    await expect(runSave('files', {ports, download: async () => FILE})).resolves.toEqual({
      kind: 'saved',
      route: 'files',
    });
    expect(ports.getAddPermission).not.toHaveBeenCalled();
    expect(ports.requestAddPermission).not.toHaveBeenCalled();
    expect(ports.saveToLibrary).not.toHaveBeenCalled();
    expect(ports.saveToFiles).toHaveBeenCalledWith(FILE);
  });

  it('폴더 선택 창을 닫은 것은 실패가 아니라 취소다', async () => {
    const ports = fakePorts({saveToFiles: jest.fn(async () => 'cancelled' as const)});
    await expect(runSave('files', {ports, download: async () => FILE})).resolves.toEqual({kind: 'cancelled'});
  });

  it('파일 앱 쪽이 던지면 실패다', async () => {
    const ports = fakePorts({saveToFiles: jest.fn(async () => Promise.reject(new Error('copy')))});
    await expect(runSave('files', {ports, download: async () => FILE})).resolves.toEqual({kind: 'failed'});
  });
});

// ---- ③ 포트 ---------------------------------------------------------------------

describe('③ 사진 보관함 포트 — 추가 전용으로만 묻고, 확장자를 맞춰 넘긴다', () => {
  it('읽기는 writeOnly 로 부르고, 끝에 읽기·쓰기 수준으로 되돌려 놓는다(모듈이 마지막 수준을 기억한다)', async () => {
    mediaLibrary.__state.addPermission = {status: 'granted'};
    await expect(nativeLibrarySave.getAddPermission()).resolves.toBe('granted');
    expect(mediaLibrary.getPermissionsAsync.mock.calls).toEqual([[true], []]);
    expect(mediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('요청은 writeOnly 한 번뿐이다 — 읽기·쓰기 프롬프트는 이 길로 뜨지 않는다', async () => {
    await expect(nativeLibrarySave.requestAddPermission()).resolves.toBe('granted');
    expect(mediaLibrary.requestPermissionsAsync.mock.calls).toEqual([[true]]);
    // 요청 뒤에도 읽기 수준으로 되돌린다.
    expect(mediaLibrary.getPermissionsAsync.mock.calls).toEqual([[]]);
  });

  it('사람이 거부하면 denied 로 읽힌다', async () => {
    mediaLibrary.__state.addAnswer = {status: 'denied', accessPrivileges: 'none', granted: false, canAskAgain: false};
    await expect(nativeLibrarySave.requestAddPermission()).resolves.toBe('denied');
  });

  it('확장자가 맞는 파일은 같은 주소 그대로 보관함에 더한다(사본 없음)', async () => {
    mediaLibrary.__state.addPermission = {status: 'granted'};
    const source = new fileSystem.File('file:///cache/p1-현장.png');
    fileSystem.__files.add(source.uri);
    await nativeLibrarySave.saveToLibrary({uri: source.uri, name: '현장.png', mime: 'image/png'});
    expect(mediaLibrary.saveToLibraryAsync.mock.calls).toEqual([[source.uri]]);
  });

  it('확장자가 없는 파일은 맞는 확장자의 임시 사본을 넘기고 끝나면 지운다', async () => {
    mediaLibrary.__state.addPermission = {status: 'granted'};
    const source = new fileSystem.File('file:///cache/p1-현장');
    fileSystem.__files.add(source.uri);
    await nativeLibrarySave.saveToLibrary({uri: source.uri, name: '현장', mime: 'image/png'});
    const [uri] = mediaLibrary.saveToLibraryAsync.mock.calls[0] as [string];
    expect(uri).toMatch(/\.png$/);
    expect(uri).not.toBe(source.uri);
    // 임시 사본은 지웠다.
    expect(fileSystem.__files.has(uri)).toBe(false);
  });

  it('보관함이 던져도 임시 사본은 남지 않는다', async () => {
    mediaLibrary.__state.addPermission = {status: 'granted'};
    mediaLibrary.__state.saveFailure = new Error('boom');
    const source = new fileSystem.File('file:///cache/v1-영상');
    fileSystem.__files.add(source.uri);
    await expect(
      nativeLibrarySave.saveToLibrary({uri: source.uri, name: '영상', mime: 'video/quicktime'}),
    ).rejects.toThrow('boom');
    expect([...fileSystem.__files].filter(uri => uri !== source.uri)).toEqual([]);
  });

  it('설정 열기는 기기 설정 앱으로 간다', () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    nativeLibrarySave.openSettings();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('③ 파일 앱 포트 — 사람이 고른 폴더에 사람이 보던 이름으로', () => {
  const cacheFile = 'file:///cache/oort-attachments/f1-배포-결과.pdf';
  beforeEach(() => {
    fileSystem.__files.add(new fileSystem.File(cacheFile).uri);
  });

  it('폴더를 고르게 하고 캐시 이름(id 접두)이 아니라 첨부 이름으로 복사한다', async () => {
    await expect(
      nativeFileSave.saveToFiles({uri: cacheFile, name: '배포-결과.pdf', mime: 'application/pdf'}),
    ).resolves.toBe('saved');
    expect(fileSystem.__state.pickCalls).toBe(1);
    const target = new fileSystem.File(new fileSystem.File('file:///picked'), '배포-결과.pdf');
    expect(fileSystem.__files.has(target.uri)).toBe(true);
  });

  it('같은 이름이 이미 있으면 덮어쓰지도 실패하지도 않고 번호를 붙인다', async () => {
    const file = {uri: cacheFile, name: '배포-결과.pdf', mime: 'application/pdf'};
    await nativeFileSave.saveToFiles(file);
    await expect(nativeFileSave.saveToFiles(file)).resolves.toBe('saved');
    const second = new fileSystem.File(new fileSystem.File('file:///picked'), '배포-결과 2.pdf');
    expect(fileSystem.__files.has(second.uri)).toBe(true);
  });

  it('폴더 선택 창을 닫으면 cancelled 이고 아무것도 복사하지 않는다', async () => {
    fileSystem.__state.pick.cancel = true;
    const before = fileSystem.__files.size;
    await expect(
      nativeFileSave.saveToFiles({uri: cacheFile, name: '배포-결과.pdf', mime: 'application/pdf'}),
    ).resolves.toBe('cancelled');
    expect(fileSystem.__files.size).toBe(before);
  });

  it('취소가 아닌 실패는 던진다', async () => {
    fileSystem.__state.pick.failure = Object.assign(new Error('x'), {code: 'ERR_PICKING_IN_PROGRESS'});
    await expect(
      nativeFileSave.saveToFiles({uri: cacheFile, name: 'a.pdf', mime: 'application/pdf'}),
    ).rejects.toThrow('x');
  });

  it('취소는 코드로 읽는다 — 글자가 같아도 코드가 다르면 취소가 아니다', () => {
    expect(PICKER_CANCELLED_CODE).toBe('ERR_FILE_PICKING_CANCELLED');
    expect(isPickerCancel({code: 'ERR_FILE_PICKING_CANCELLED'})).toBe(true);
    expect(isPickerCancel({code: 'ERR_OTHER', message: 'File picking was cancelled by the user'})).toBe(false);
    expect(isPickerCancel(new Error('File picking was cancelled by the user'))).toBe(false);
    expect(isPickerCancel(null)).toBe(false);
  });
});

// ---- ④ 훅 -----------------------------------------------------------------------

function mount(attachment: MessageAttachment, ports: SavePorts) {
  return renderHook(({item}: {item: MessageAttachment}) => useSaveAttachment('ws', 'ch', item, ports), {
    initialProps: {item: attachment},
  });
}

describe('④ 훅 — 영수증은 걷히고 실패·거부는 남는다', () => {
  it('마운트만으로는 권한을 읽지도 묻지도 않는다 — 저장을 누른 순간에만 묻는다', async () => {
    const ports = fakePorts();
    mount(PHOTO, ports);
    await act(async () => {});
    expect(ports.getAddPermission).not.toHaveBeenCalled();
    expect(ports.requestAddPermission).not.toHaveBeenCalled();
    expect(mediaLibrary.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('idle → working → saved(photos) 이고 영수증은 SAVE_RECEIPT_MS 뒤 걷힌다', async () => {
    jest.useFakeTimers();
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const ports = fakePorts();
    const {result} = mount(PHOTO, ports);
    expect(result.current.state).toEqual({status: 'idle'});
    expect(result.current.route).toBe('photos');
    act(() => result.current.save());
    expect(result.current.state).toEqual({status: 'working'});
    await act(async () => {});
    expect(result.current.state).toEqual({status: 'saved', route: 'photos'});
    expect(saveNoticeKey(result.current.state)).toBe('mobile.attachmentSave.savedToPhotos');
    expect(announce).toHaveBeenCalledWith('사진에 저장했어요');
    act(() => {
      jest.advanceTimersByTime(SAVE_RECEIPT_MS - 1);
    });
    expect(result.current.state.status).toBe('saved');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.state).toEqual({status: 'idle'});
    // 내려받은 파일이 보관함으로 갔다 — 첨부 이름이 아니라 내려받은 캐시 파일이다.
    const call = (ports.saveToLibrary as jest.Mock).mock.calls[0]?.[0] as SaveFile;
    expect(call).toMatchObject({name: '현장.png', mime: 'image/png', uri: expect.stringMatching(/^file:/)});
    expect(fileSystem.__state.downloads).toHaveLength(1);
  });

  it('파일 갈래의 영수증은 「파일에 저장했어요」다', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const ports = fakePorts();
    const {result} = mount(PDF, ports);
    expect(result.current.route).toBe('files');
    act(() => result.current.save());
    await waitFor(() => expect(result.current.state).toEqual({status: 'saved', route: 'files'}));
    expect(announce).toHaveBeenCalledWith('파일에 저장했어요');
  });

  it('거부는 걷히지 않고(보조기술에도 알린다) 「설정 열기」가 설정 앱으로 이어진다', async () => {
    jest.useFakeTimers();
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const ports = fakePorts({getAddPermission: jest.fn(async () => 'denied' as const)});
    const {result} = mount(VIDEO, ports);
    act(() => result.current.save());
    await act(async () => {});
    expect(result.current.state).toEqual({status: 'denied'});
    expect(announce).toHaveBeenCalledWith('사진 접근이 꺼져 있어요 · 설정 열기');
    // 아무리 기다려도 남는다.
    act(() => {
      jest.advanceTimersByTime(SAVE_RECEIPT_MS * 10);
    });
    expect(result.current.state).toEqual({status: 'denied'});
    // 내려받지 않았다.
    expect(fileSystem.__state.downloads).toHaveLength(0);
    act(() => result.current.openSettings());
    expect(ports.openSettings).toHaveBeenCalledTimes(1);
  });

  it('실패는 걷히지 않고, 다시 누르면 다시 시도해 저장된다', async () => {
    jest.useFakeTimers();
    const library = jest.fn(async () => {});
    library.mockRejectedValueOnce(new Error('boom'));
    const ports = fakePorts({saveToLibrary: library});
    const {result} = mount(PHOTO, ports);
    act(() => result.current.save());
    await act(async () => {});
    expect(result.current.state).toEqual({status: 'failed'});
    expect(saveNoticeKey(result.current.state)).toBe('mobile.attachmentSave.failed');
    act(() => {
      jest.advanceTimersByTime(SAVE_RECEIPT_MS * 10);
    });
    expect(result.current.state).toEqual({status: 'failed'});
    act(() => result.current.save());
    await act(async () => {});
    expect(result.current.state).toEqual({status: 'saved', route: 'photos'});
  });

  it('폴더 선택 창을 닫으면 아무 말도 하지 않는다(실패가 아니다)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const ports = fakePorts({saveToFiles: jest.fn(async () => 'cancelled' as const)});
    const {result} = mount(PDF, ports);
    act(() => result.current.save());
    await waitFor(() => expect(ports.saveToFiles).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.state).toEqual({status: 'idle'});
    expect(announce).not.toHaveBeenCalled();
  });

  it('하는 중에 다시 눌러도 한 번만 저장한다', async () => {
    let release: () => void = () => {};
    const library = jest.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    const ports = fakePorts({saveToLibrary: library});
    const {result} = mount(PHOTO, ports);
    act(() => result.current.save());
    await waitFor(() => expect(library).toHaveBeenCalledTimes(1));
    act(() => result.current.save());
    act(() => result.current.save());
    expect(result.current.state).toEqual({status: 'working'});
    await act(async () => {
      release();
    });
    expect(library).toHaveBeenCalledTimes(1);
    expect(ports.getAddPermission).toHaveBeenCalledTimes(1);
  });

  it('다른 첨부로 넘어가면 앞 장의 영수증은 걷힌다', async () => {
    const ports = fakePorts();
    const {result, rerender} = mount(PHOTO, ports);
    act(() => result.current.save());
    await waitFor(() => expect(result.current.state.status).toBe('saved'));
    rerender({item: {...PHOTO, id: 'p2'}});
    expect(result.current.state).toEqual({status: 'idle'});
  });

  it('끝나기 전에 사라져도 던지지 않는다', async () => {
    let release: () => void = () => {};
    const ports = fakePorts({
      saveToLibrary: jest.fn(
        () =>
          new Promise<void>(resolve => {
            release = resolve;
          }),
      ),
    });
    const {result, unmount} = mount(PHOTO, ports);
    act(() => result.current.save());
    await waitFor(() => expect(ports.saveToLibrary).toHaveBeenCalled());
    unmount();
    await act(async () => {
      release();
    });
  });
});
