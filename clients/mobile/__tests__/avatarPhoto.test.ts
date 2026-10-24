import {ApiError, type RosterMember} from '@momo/core/lib/api';

import {
  AVATAR_CAMERA_UNAVAILABLE_COPY,
  AVATAR_DENIED_COPY,
  AVATAR_UNREADABLE_COPY,
  centerSquareCrop,
  changeAvatarPhoto,
  shrinkRequestFor,
  withMyAvatar,
  type AvatarPhotoPorts,
  type AvatarPickOutcome,
} from '../src/features/profile/avatarPhoto';

// =============================================================================
// #4384 — 폰 프로필 사진 바꾸기의 약속 (순서·줄이기·상한·정리·roster)
//
// 서버 두 호출(세션 열기·complete)만 가짜다. 포트는 호출 인자와 순서를 기록해서, 「성공만 돌려주는
// 가짜」가 통과시키는 시험이 없게 한다(각 단정은 수리를 되돌려 빨개지는 것을 확인했다 — PR 본문의 표).
// =============================================================================

const mockCreate = jest.fn();
const mockComplete = jest.fn();
jest.mock('@momo/core/lib/api', () => {
  const actual = jest.requireActual('@momo/core/lib/api');
  return {
    ...actual,
    createMyAvatarUpload: (...a: unknown[]) => mockCreate(...a),
    completeMyAvatarUpload: (...a: unknown[]) => mockComplete(...a),
  };
});

const WS = 'ws-1';
const MIB = 1024 * 1024;
const NEW_PATH = '/v1/workspaces/ws-1/members/me-1/avatar/content?v=media-2';

let log: string[];

function ports(over: Partial<AvatarPhotoPorts> & {picked?: AvatarPickOutcome} = {}) {
  const {picked, ...rest} = over;
  const base: AvatarPhotoPorts = {
    pick: jest.fn(async (source: string) => {
      log.push(`pick:${source}`);
      return (
        picked ?? {kind: 'picked', uri: 'file:///cache/picked.jpg', width: 1000, height: 1000}
      );
    }),
    shrink: jest.fn(async (uri: string) => {
      log.push(`shrink:${uri}`);
      return {uri: 'file:///cache/shrunk.jpg', width: 512, height: 512};
    }),
    sizeOf: jest.fn(() => 90_000),
    put: jest.fn(async (url: string, uri: string, mime: string) => {
      log.push(`put:${url}|${uri}|${mime}`);
      return {ok: true};
    }),
    discard: jest.fn((uri: string) => {
      log.push(`discard:${uri}`);
    }),
  };
  return {...base, ...rest} as AvatarPhotoPorts;
}

beforeEach(() => {
  log = [];
  mockCreate.mockReset().mockImplementation(async (_ws: string, file: unknown) => {
    log.push(`create:${JSON.stringify(file)}`);
    return {id: 'media-2', status: 'pending', uploadUrl: 'https://drive.example/cap'};
  });
  mockComplete.mockReset().mockImplementation(async () => {
    log.push('complete');
    return {id: 'media-2', memberId: 'me-1', status: 'ready', avatarUrl: NEW_PATH};
  });
});

describe('changeAvatarPhoto — 순서와 업로드 대상', () => {
  it('고르기 → 줄이기 → 세션 열기 → PUT → complete, 줄인 파일(고른 원본이 아니다)이 올라간다', async () => {
    const outcome = await changeAvatarPhoto(WS, 'library', ports());
    expect(outcome).toEqual({ok: true, avatarUrl: NEW_PATH});
    expect(log.filter(line => !line.startsWith('discard'))).toEqual([
      'pick:library',
      'shrink:file:///cache/picked.jpg',
      'create:{"name":"avatar.jpg","mime":"image/jpeg","size":90000}',
      'put:https://drive.example/cap|file:///cache/shrunk.jpg|image/jpeg',
      'complete',
    ]);
    expect(mockComplete).toHaveBeenCalledWith(WS, 'media-2');
  });

  it('선언한 size 는 줄인 파일의 실제 바이트 수다(고른 원본이 아니다)', async () => {
    const p = ports({sizeOf: jest.fn((uri: string) => (uri.includes('shrunk') ? 4321 : 9_999_999))});
    await changeAvatarPhoto(WS, 'camera', p);
    expect(mockCreate).toHaveBeenCalledWith(WS, {name: 'avatar.jpg', mime: 'image/jpeg', size: 4321});
  });

  it('작은 사진도 그대로 올리지 않고 다시 인코딩한다(위치 정보 제거)', async () => {
    const p = ports({picked: {kind: 'picked', uri: 'file:///cache/tiny.heic', width: 200, height: 200}});
    await changeAvatarPhoto(WS, 'library', p);
    expect(p.shrink).toHaveBeenCalledTimes(1);
    expect(p.shrink).toHaveBeenCalledWith('file:///cache/tiny.heic', {
      crop: null,
      resizeLongSide: null,
      quality: 0.85,
    });
    expect(p.put).toHaveBeenCalledWith(expect.any(String), 'file:///cache/shrunk.jpg', 'image/jpeg');
  });
});

describe('줄이기 산수', () => {
  it('긴 변이 512 를 넘으면 512, 아니면 키우지 않는다', () => {
    expect(shrinkRequestFor(4000, 4000).resizeLongSide).toBe(512);
    expect(shrinkRequestFor(513, 513).resizeLongSide).toBe(512);
    expect(shrinkRequestFor(512, 512).resizeLongSide).toBeNull();
    expect(shrinkRequestFor(300, 300).resizeLongSide).toBeNull();
  });

  it('정사각이 아니면 가운데 정사각으로 자른 뒤의 변으로 줄인다', () => {
    expect(centerSquareCrop(4032, 3024)).toEqual({originX: 504, originY: 0, width: 3024, height: 3024});
    expect(centerSquareCrop(3024, 4032)).toEqual({originX: 0, originY: 504, width: 3024, height: 3024});
    expect(centerSquareCrop(1000, 1000)).toBeNull();
    expect(centerSquareCrop(1000, 1001)).toBeNull();
    // 긴 변은 4032 지만 자른 정사각은 400 이라 줄일 것이 없다.
    expect(shrinkRequestFor(4032, 400)).toEqual({
      crop: {originX: 1816, originY: 0, width: 400, height: 400},
      resizeLongSide: null,
      quality: 0.85,
    });
  });
});

describe('실패는 서버를 부르기 전에 / 부른 뒤에 멈춘다', () => {
  it('PUT 이 실패하면 complete 를 부르지 않는다', async () => {
    const p = ports({put: jest.fn(async () => ({ok: false}))});
    const outcome = await changeAvatarPhoto(WS, 'library', p);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ok: false, failure: {kind: 'upload'}});
  });

  it('5MiB 를 넘으면 세션을 열지 않는다', async () => {
    const p = ports({sizeOf: jest.fn(() => 5 * MIB + 1)});
    const outcome = await changeAvatarPhoto(WS, 'library', p);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(p.put).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ok: false, failure: {kind: 'too-large'}});
  });

  it('정확히 5MiB 는 올린다', async () => {
    const outcome = await changeAvatarPhoto(WS, 'library', ports({sizeOf: jest.fn(() => 5 * MIB)}));
    expect(outcome.ok).toBe(true);
  });

  it('바이트 수를 못 읽으면 올리지 않는다', async () => {
    const outcome = await changeAvatarPhoto(WS, 'library', ports({sizeOf: jest.fn(() => null)}));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({failure: {kind: 'unreadable'}});
  });

  it('줄이기가 던지면 읽지 못했다고 하고 고른 임시 파일을 지운다', async () => {
    const p = ports({shrink: jest.fn(async () => Promise.reject(new Error('decode')))});
    const outcome = await changeAvatarPhoto(WS, 'library', p);
    expect(outcome).toMatchObject({failure: {kind: 'unreadable'}});
    expect(mockCreate).not.toHaveBeenCalled();
    expect(p.discard).toHaveBeenCalledWith('file:///cache/picked.jpg');
  });

  it.each([
    [413, '프로필 사진은 5MB까지 올릴 수 있어요.'],
    [422, '이 이미지는 사용할 수 없어요. 열 수 있는 이미지이고 가로세로 4096px 이하인지 확인해 주세요.'],
    [409, '파일 형식이 맞지 않거나 그사이 다른 사진으로 바뀌었어요. 이미지를 다시 골라 주세요.'],
    [429, '프로필 사진을 너무 자주 바꿨어요. 잠시 뒤에 다시 시도해 주세요.'],
  ])('서버 %i 는 자기 문장으로 말한다', async (status, text) => {
    mockComplete.mockRejectedValueOnce(new ApiError(status, 'x'));
    const outcome = await changeAvatarPhoto(WS, 'library', ports());
    expect(outcome).toEqual({ok: false, cancelled: false, failure: {kind: 'upload', message: text}});
  });

  it('임시 파일(고른 것·줄인 것)은 성공이든 실패든 지운다', async () => {
    await changeAvatarPhoto(WS, 'library', ports());
    expect(log).toEqual(expect.arrayContaining(['discard:file:///cache/picked.jpg', 'discard:file:///cache/shrunk.jpg']));
    log = [];
    await changeAvatarPhoto(WS, 'library', ports({put: jest.fn(async () => ({ok: false}))}));
    expect(log).toEqual(expect.arrayContaining(['discard:file:///cache/picked.jpg', 'discard:file:///cache/shrunk.jpg']));
  });
});

describe('고르기의 갈래', () => {
  it('취소는 아무것도 부르지 않고 알림도 없다', async () => {
    const p = ports({picked: {kind: 'cancelled'}});
    expect(await changeAvatarPhoto(WS, 'library', p)).toEqual({ok: false, cancelled: true});
    expect(p.shrink).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('거부는 사진과 카메라가 서로 다른 문장이다(설정에서 다른 행)', async () => {
    const lib = await changeAvatarPhoto(WS, 'library', ports({picked: {kind: 'denied'}}));
    const cam = await changeAvatarPhoto(WS, 'camera', ports({picked: {kind: 'denied'}}));
    expect(lib).toMatchObject({failure: {kind: 'denied', source: 'library'}});
    expect(cam).toMatchObject({failure: {kind: 'denied', source: 'camera'}});
    expect(AVATAR_DENIED_COPY.library).toContain('사진');
    expect(AVATAR_DENIED_COPY.camera).toContain('카메라');
    expect(AVATAR_DENIED_COPY.library).not.toBe(AVATAR_DENIED_COPY.camera);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('카메라가 없는 곳·읽지 못한 사진은 각자의 갈래다', async () => {
    expect(await changeAvatarPhoto(WS, 'camera', ports({picked: {kind: 'camera-unavailable'}}))).toMatchObject({
      failure: {kind: 'camera-unavailable'},
    });
    expect(await changeAvatarPhoto(WS, 'library', ports({picked: {kind: 'error'}}))).toMatchObject({
      failure: {kind: 'unreadable'},
    });
    expect(AVATAR_CAMERA_UNAVAILABLE_COPY).not.toBe(AVATAR_UNREADABLE_COPY);
  });

  it('크기를 모르는 사진(0·NaN)은 줄이기를 부르지 않는다', async () => {
    const p = ports({picked: {kind: 'picked', uri: 'file:///cache/x.jpg', width: 0, height: Number.NaN}});
    expect(await changeAvatarPhoto(WS, 'library', p)).toMatchObject({failure: {kind: 'unreadable'}});
    expect(p.shrink).not.toHaveBeenCalled();
    expect(p.discard).toHaveBeenCalledWith('file:///cache/x.jpg');
  });
});

describe('withMyAvatar — roster 에서 나만 바뀐다', () => {
  const row = (id: string, avatarUrl?: string): RosterMember =>
    ({
      id,
      workspaceId: WS,
      kind: 'human',
      status: 'active',
      displayName: id === 'me-1' ? '이도현' : '박서연',
      handle: id,
      channelCount: 0,
      channelIds: [],
      capabilities: [],
      ...(avatarUrl ? {avatarUrl} : {}),
    }) as RosterMember;

  it('내 행의 avatarUrl 만 새 주소가 되고 남의 행은 같은 객체다', () => {
    const rows = [row('me-1', '/old?v=1'), row('other', '/other?v=9')];
    const next = withMyAvatar(rows, 'me-1', NEW_PATH);
    expect(next?.[0].avatarUrl).toBe(NEW_PATH);
    expect(next?.[1]).toBe(rows[1]);
    expect(rows[0].avatarUrl).toBe('/old?v=1');
  });

  it('지우면 내 행에서 avatarUrl 키가 없어지고 남의 행은 그대로다', () => {
    const rows = [row('me-1', '/old?v=1'), row('other', '/other?v=9')];
    const next = withMyAvatar(rows, 'me-1', undefined);
    expect(next?.[0]).not.toHaveProperty('avatarUrl');
    expect(next?.[1].avatarUrl).toBe('/other?v=9');
  });

  it('아직 읽지 않은 roster 는 만들어 내지 않는다', () => {
    expect(withMyAvatar(undefined, 'me-1', NEW_PATH)).toBeUndefined();
  });
});
