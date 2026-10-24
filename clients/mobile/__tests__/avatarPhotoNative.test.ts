import * as Device from 'expo-device';
import {ImageManipulator} from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import {nativeAvatarPhotoPorts} from '../src/features/profile/avatarPhotoNative';

// =============================================================================
// #4384 — 프로필 사진의 네이티브 포트가 expo 에 **무엇을 시키는가**
//
// 순수 순서 시험(`avatarPhoto.test.ts`)은 포트를 바꿔 끼우므로 여기서 잴 것은 어댑터의 약속이다:
// 시스템 편집기(정사각 자르기)를 켠다 · EXIF 를 달고 오지 않는다 · 카메라는 권한을 먼저 받고
// 실기기가 아니면 열지 않는다 · 줄일 때 JPEG 로 다시 쓴다.
// =============================================================================

const mockPutBytes = jest.fn();
jest.mock('../src/features/attachments/uploadTransport', () => ({
  putAttachmentBytes: (...a: unknown[]) => mockPutBytes(...a),
}));

const picker = ImagePicker as unknown as {
  __state: {
    result: unknown;
    failure: unknown;
    permission: {status: string};
    cameraPermission: {status: string; granted: boolean};
    cameraResult: unknown;
    cameraFailure: unknown;
  };
  __reset: () => void;
  launchImageLibraryAsync: jest.Mock;
  launchCameraAsync: jest.Mock;
  requestCameraPermissionsAsync: jest.Mock;
};
const device = Device as unknown as {__state: {isDevice: boolean}};

const PICKED = {
  canceled: false,
  assets: [{uri: 'file:///cache/edited.jpg', width: 900, height: 900}],
};

beforeEach(() => {
  picker.__reset();
  picker.launchImageLibraryAsync.mockClear();
  picker.launchCameraAsync.mockClear();
  picker.requestCameraPermissionsAsync.mockClear();
  device.__state.isDevice = true;
  mockPutBytes.mockReset();
});

describe('사진 보관함', () => {
  it('편집기(정사각 자르기)를 켜고 위치 정보를 달고 오지 않는다', async () => {
    picker.__state.result = PICKED;
    const outcome = await nativeAvatarPhotoPorts.pick('library');
    expect(outcome).toEqual({kind: 'picked', uri: 'file:///cache/edited.jpg', width: 900, height: 900});
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({allowsEditing: true, aspect: [1, 1], exif: false, mediaTypes: ['images']}),
    );
  });

  it('취소는 취소다', async () => {
    expect(await nativeAvatarPhotoPorts.pick('library')).toEqual({kind: 'cancelled'});
  });

  it('열리지 못했고 권한이 거부면 거부, 아니면 오류', async () => {
    picker.__state.failure = new Error('nope');
    picker.__state.permission = {status: 'denied'};
    expect(await nativeAvatarPhotoPorts.pick('library')).toEqual({kind: 'denied'});
    picker.__state.permission = {status: 'granted'};
    expect(await nativeAvatarPhotoPorts.pick('library')).toEqual({kind: 'error'});
  });
});

describe('카메라', () => {
  it('권한을 먼저 받고, 실기기면 편집기를 켜고 연다', async () => {
    picker.__state.cameraResult = PICKED;
    const outcome = await nativeAvatarPhotoPorts.pick('camera');
    expect(outcome.kind).toBe('picked');
    expect(picker.requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(picker.launchCameraAsync).toHaveBeenCalledWith(
      expect.objectContaining({allowsEditing: true, aspect: [1, 1], exif: false, mediaTypes: ['images']}),
    );
  });

  it('권한이 거부면 카메라를 열지 않는다', async () => {
    picker.__state.cameraPermission = {status: 'denied', granted: false};
    expect(await nativeAvatarPhotoPorts.pick('camera')).toEqual({kind: 'denied'});
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('실기기가 아니면(시뮬레이터) 카메라를 열지 않는다 — 네이티브 예외로 앱이 죽는다', async () => {
    device.__state.isDevice = false;
    expect(await nativeAvatarPhotoPorts.pick('camera')).toEqual({kind: 'camera-unavailable'});
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('카메라가 던지면 열리지 못한 것이다', async () => {
    picker.__state.cameraFailure = new Error('busy');
    expect(await nativeAvatarPhotoPorts.pick('camera')).toEqual({kind: 'camera-unavailable'});
  });
});

describe('줄이기와 올리기', () => {
  function spyContext() {
    const calls: string[] = [];
    const context: {
      crop: jest.Mock;
      resize: jest.Mock;
      renderAsync: jest.Mock;
    } = {
      crop: jest.fn(),
      resize: jest.fn(),
      renderAsync: jest.fn(async () => ({
        saveAsync: jest.fn(async (options: unknown) => {
          calls.push(`save:${JSON.stringify(options)}`);
          return {uri: 'file:///cache/out.jpg', width: 512, height: 512};
        }),
      })),
    };
    context.crop.mockImplementation((rect: unknown) => {
      calls.push(`crop:${JSON.stringify(rect)}`);
      return context;
    });
    context.resize.mockImplementation((size: unknown) => {
      calls.push(`resize:${JSON.stringify(size)}`);
      return context;
    });
    jest.spyOn(ImageManipulator, 'manipulate').mockReturnValue(context as never);
    return {calls, context};
  }

  it('자르고 → 줄이고 → JPEG 로 저장한다(순서 그대로)', async () => {
    const {calls} = spyContext();
    const out = await nativeAvatarPhotoPorts.shrink('file:///cache/big.jpg', {
      crop: {originX: 504, originY: 0, width: 3024, height: 3024},
      resizeLongSide: 512,
      quality: 0.85,
    });
    expect(calls).toEqual([
      'crop:{"originX":504,"originY":0,"width":3024,"height":3024}',
      'resize:{"width":512}',
      'save:{"compress":0.85,"format":"jpeg"}',
    ]);
    expect(out.uri).toBe('file:///cache/out.jpg');
  });

  it('자를 것도 줄일 것도 없어도 다시 JPEG 로 저장한다(재인코딩)', async () => {
    const {calls, context} = spyContext();
    await nativeAvatarPhotoPorts.shrink('file:///cache/small.png', {crop: null, resizeLongSide: null, quality: 0.85});
    expect(context.crop).not.toHaveBeenCalled();
    expect(context.resize).not.toHaveBeenCalled();
    expect(calls).toEqual(['save:{"compress":0.85,"format":"jpeg"}']);
  });

  it('올리기는 capability URL 로 JPEG 바이트를 보내고 성공 여부만 돌려준다', async () => {
    mockPutBytes.mockReturnValue({done: Promise.resolve({ok: true})});
    expect(await nativeAvatarPhotoPorts.put('https://drive.example/cap', 'file:///cache/out.jpg', 'image/jpeg')).toEqual({ok: true});
    expect(mockPutBytes).toHaveBeenCalledWith('https://drive.example/cap', 'file:///cache/out.jpg', 'image/jpeg', expect.any(Function));
    mockPutBytes.mockReturnValue({done: Promise.resolve({ok: false, failure: 'status', status: 403})});
    expect(await nativeAvatarPhotoPorts.put('u', 'file:///x', 'image/jpeg')).toEqual({ok: false});
  });
});
