import {MAX_ATTACHMENTS_PER_MESSAGE} from '@momo/core/features/attachments/model';

import {
  clampSelection,
  extensionOf,
  jpegName,
  mimeForExtension,
  needsJpeg,
  permissionFromResponse,
  photoDateLabel,
  photoRoom,
  PhotoResolveError,
  resolvePhotoWith,
  selectionOrder,
  toggleSelection,
  type PhotoAsset,
  type PhotoFileGateway,
} from '../src/features/attachments/photoLibrary';

// =============================================================================
// 사진 보관함의 순수 절반 (#4181) — 권한 4상태·선택 상한·자산→파일 변환.
//
// 이 파일의 단정은 전부 「고친 분기를 되돌리면 이름 있는 시험이 실패한다」로 짰다
// (사보타주 기록은 PR 본문). 상한·iCloud 분기·HEIC 분기·권한 매핑이 각각 자기 시험을 갖는다.
// =============================================================================

function asset(id: string, filename = `${id}.JPG`): PhotoAsset {
  return {
    id,
    uri: `ph://${id}`,
    filename,
    width: 4032,
    height: 3024,
    creationTimeMs: Date.UTC(2026, 9, 21, 3, 0, 0),
  };
}

describe('권한 매핑 — expo 의 응답이 네 상태로 접힌다', () => {
  it.each([
    [{status: 'undetermined', accessPrivileges: 'none'}, 'undetermined'],
    [{status: 'denied', accessPrivileges: 'none'}, 'denied'],
    [{status: 'granted', accessPrivileges: 'all'}, 'granted'],
    [{status: 'granted', accessPrivileges: 'limited'}, 'limited'],
    // 일부 허용은 status 가 granted 여도 따로 선다 — 합치면 「더 고르기」가 사라진다.
    [{status: 'granted'}, 'granted'],
    [{status: 'unknown-future-value'}, 'undetermined'],
  ] as const)('%j → %s', (response, expected) => {
    expect(permissionFromResponse(response)).toBe(expected);
  });
});

describe('상한 — 트레이에 이미 있는 만큼 뺀다', () => {
  it('빈 트레이는 20, 가득 찬 트레이는 0, 넘쳐도 음수가 아니다', () => {
    expect(photoRoom(0)).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(photoRoom(18)).toBe(2);
    expect(photoRoom(MAX_ATTACHMENTS_PER_MESSAGE)).toBe(0);
    expect(photoRoom(MAX_ATTACHMENTS_PER_MESSAGE + 5)).toBe(0);
  });

  it('상한에서 더 고를 수 없고, 막힌 사실을 알린다', () => {
    const full = toggleSelection(['a', 'b'], 'c', 2);
    expect(full).toEqual({next: ['a', 'b'], blocked: true});
  });

  it('상한에서도 이미 고른 것을 빼는 것은 막히지 않는다', () => {
    const removed = toggleSelection(['a', 'b'], 'a', 2);
    expect(removed).toEqual({next: ['b'], blocked: false});
    // 빼고 나면 다시 더할 수 있다.
    expect(toggleSelection(removed.next, 'c', 2)).toEqual({next: ['b', 'c'], blocked: false});
  });

  it('비어 있지 않은 트레이의 경계: 18개가 있으면 둘째 사진까지만 고른다', () => {
    const room = photoRoom(18);
    let selected: string[] = [];
    for (const id of ['a', 'b', 'c']) {
      selected = toggleSelection(selected, id, room).next;
    }
    expect(selected).toEqual(['a', 'b']);
  });

  it('고른 순서가 순번이고, 빼면 뒤의 번호가 당겨진다', () => {
    let selected: string[] = [];
    for (const id of ['x', 'y', 'z']) selected = toggleSelection(selected, id, 20).next;
    expect([selectionOrder(selected, 'x'), selectionOrder(selected, 'y'), selectionOrder(selected, 'z')]).toEqual([1, 2, 3]);
    selected = toggleSelection(selected, 'x', 20).next;
    expect([selectionOrder(selected, 'x'), selectionOrder(selected, 'y'), selectionOrder(selected, 'z')]).toEqual([0, 1, 2]);
  });

  it('상한이 줄면 뒤쪽 선택부터 걷는다', () => {
    expect(clampSelection(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b']);
    expect(clampSelection(['a'], 2)).toEqual(['a']);
  });
});

describe('파일 이름·MIME·형식', () => {
  it('확장자는 소문자이고 없으면 빈 문자열이다', () => {
    expect(extensionOf('IMG_0412.HEIC')).toBe('heic');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });

  it('MIME 은 확장자로 가른다', () => {
    expect(mimeForExtension('jpg')).toBe('image/jpeg');
    expect(mimeForExtension('jpeg')).toBe('image/jpeg');
    expect(mimeForExtension('png')).toBe('image/png');
    expect(mimeForExtension('heic')).toBe('image/heic');
    expect(mimeForExtension('xyz')).toBe('application/octet-stream');
  });

  it('JPEG 로 바꿔 올리는 것은 HEIC 과 HEIF 뿐이다', () => {
    expect(needsJpeg('heic')).toBe(true);
    expect(needsJpeg('heif')).toBe(true);
    for (const kept of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'dng', '']) {
      expect(needsJpeg(kept)).toBe(false);
    }
    expect(jpegName('IMG_0412.HEIC')).toBe('IMG_0412.jpg');
    expect(jpegName('a.b.heif')).toBe('a.b.jpg');
    expect(jpegName('noext')).toBe('noext.jpg');
  });

  it('낭독용 날짜는 「10월 21일」이고 모르면 null 이다', () => {
    const label = photoDateLabel(new Date(2026, 9, 21, 12).getTime());
    expect(label).toBe('10월 21일');
    expect(photoDateLabel(0)).toBeNull();
    expect(photoDateLabel(Number.NaN)).toBeNull();
  });
});

describe('자산 → PickedAttachmentFile', () => {
  function gateway(over: Partial<PhotoFileGateway> = {}) {
    const calls: string[] = [];
    const base: PhotoFileGateway = {
      info: jest.fn(async (id: string, download: boolean) => {
        calls.push(`info:${id}:${download ? 'net' : 'local'}`);
        return {localUri: `file:///library/${id}.jpg`};
      }),
      copyToCache: jest.fn(async (uri: string, extension: string) => {
        calls.push(`copy:${extension}`);
        return `file:///cache/oort-photo-attach/copy.${extension || 'jpg'}`;
      }),
      toJpeg: jest.fn(async () => {
        calls.push('toJpeg');
        return 'file:///cache/ImageManipulator/converted.jpg';
      }),
      sizeOf: jest.fn(() => 12345),
    };
    return {calls, gateway: {...base, ...over} as PhotoFileGateway};
  }

  it('기기에 있는 JPEG 는 캐시로 복사하고 이름·MIME·크기를 기존 계약대로 낸다', async () => {
    const {gateway: g, calls} = gateway();
    const onDownloading = jest.fn();
    const file = await resolvePhotoWith(g, asset('a', 'IMG_1.JPG'), {onDownloading});
    expect(file).toEqual({
      uri: 'file:///cache/oort-photo-attach/copy.jpg',
      name: 'IMG_1.JPG',
      mime: 'image/jpeg',
      sizeBytes: 12345,
      sizeKnown: true,
    });
    // 기기에 있는 사진에 「iCloud에서 내려받는 중」이 서면 거짓이다.
    expect(onDownloading).not.toHaveBeenCalled();
    expect(calls).toEqual(['info:a:local', 'copy:jpg']);
  });

  it('PNG 는 형식을 바꾸지 않는다', async () => {
    const {gateway: g} = gateway();
    const file = await resolvePhotoWith(g, asset('p', 'Screenshot.PNG'), {
      onDownloading: jest.fn(),
    });
    expect(file.name).toBe('Screenshot.PNG');
    expect(file.mime).toBe('image/png');
    expect(g.toJpeg).not.toHaveBeenCalled();
  });

  it('HEIC 는 JPEG 로 바꿔 올리고 이름·MIME 도 JPEG 가 된다', async () => {
    const {gateway: g, calls} = gateway();
    const file = await resolvePhotoWith(g, asset('h', 'IMG_0412.HEIC'), {
      onDownloading: jest.fn(),
    });
    expect(file.name).toBe('IMG_0412.jpg');
    expect(file.mime).toBe('image/jpeg');
    expect(file.uri).toBe('file:///cache/ImageManipulator/converted.jpg');
    expect(g.copyToCache).not.toHaveBeenCalled();
    expect(calls).toEqual(['info:h:local', 'toJpeg']);
  });

  it('iCloud 에만 있으면 그때만 「내려받는 중」을 알리고 네트워크로 한 번 더 묻는다', async () => {
    const order: string[] = [];
    const {gateway: g} = gateway({
      info: jest.fn(async (_id: string, download: boolean) => {
        order.push(download ? 'info:net' : 'info:local');
        return download
          ? {localUri: 'file:///library/c.jpg'}
          : {localUri: undefined, isNetworkAsset: true};
      }),
    });
    const onDownloading = jest.fn(() => order.push('downloading'));
    const file = await resolvePhotoWith(g, asset('c', 'IMG_C.JPG'), {onDownloading});
    expect(file.sizeKnown).toBe(true);
    expect(onDownloading).toHaveBeenCalledTimes(1);
    // 알림은 내려받기 **앞**이다 — 화면이 기다리는 동안 이유를 말할 수 있어야 한다.
    expect(order).toEqual(['info:local', 'downloading', 'info:net']);
  });

  it('iCloud 에서도 못 받으면 이유가 cloud 다', async () => {
    const {gateway: g} = gateway({
      info: jest.fn(async (_id: string, download: boolean) =>
        download ? {localUri: undefined} : {localUri: undefined, isNetworkAsset: true},
      ),
    });
    const error = await resolvePhotoWith(g, asset('d'), {onDownloading: jest.fn()}).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PhotoResolveError);
    expect((error as PhotoResolveError).reason).toBe('cloud');
  });

  it('기기에도 없고 iCloud 도 아니면 unavailable 이다(내려받기를 시도하지 않는다)', async () => {
    const {gateway: g} = gateway({
      info: jest.fn(async () => ({localUri: undefined, isNetworkAsset: false})),
    });
    const onDownloading = jest.fn();
    const error = await resolvePhotoWith(g, asset('e'), {onDownloading}).catch(
      (caught: unknown) => caught,
    );
    expect((error as PhotoResolveError).reason).toBe('unavailable');
    expect(onDownloading).not.toHaveBeenCalled();
    expect(g.info).toHaveBeenCalledTimes(1);
  });

  it('크기를 못 재면 sizeKnown 이 false 다(0바이트 파일과 구분한다)', async () => {
    const {gateway: g} = gateway({sizeOf: jest.fn(() => null)});
    const file = await resolvePhotoWith(g, asset('f'), {onDownloading: jest.fn()});
    expect(file.sizeKnown).toBe(false);
    expect(file.sizeBytes).toBe(0);
    const {gateway: zero} = gateway({sizeOf: jest.fn(() => 0)});
    const empty = await resolvePhotoWith(zero, asset('z'), {onDownloading: jest.fn()});
    expect(empty.sizeKnown).toBe(true);
  });

  it('파일 이름이 없는 자산에는 이름을 지어 준다', async () => {
    const {gateway: g} = gateway();
    const file = await resolvePhotoWith(g, asset('ABC-123/L0/001', ''), {
      onDownloading: jest.fn(),
    });
    expect(file.name).toMatch(/^photo-[A-Za-z0-9]+\.jpg$/);
  });

  it('복사·변환이 던지면 그대로 던진다(훅이 실패로 센다)', async () => {
    const {gateway: g} = gateway({
      copyToCache: jest.fn(async () => {
        throw new Error('disk full');
      }),
    });
    await expect(
      resolvePhotoWith(g, asset('g'), {onDownloading: jest.fn()}),
    ).rejects.toThrow('disk full');
  });
});
