import * as Keychain from 'react-native-keychain';

import {
  PUSH_ACTION_KEYCHAIN_SERVICE,
  PUSH_ACTION_SESSION_ACCOUNT,
} from '../src/push/contract';
import {
  clearPushActionSession,
  publishPushActionSession,
  pushActionSessionAvailable,
  restorePushActionSession,
} from '../src/push/pushActionSession';

// =============================================================================
// #3931 — 잠금 화면 승인의 자격이 폰의 어디에 놓이고, 어디에는 **절대** 놓이지 않는가.
//
// 이 토큰은 승인을 결정한다. 알림 확장은 별개의 바이너리이고 공유 키체인 그룹을 읽는다
// (`app.momo.ios.shared`) — 거기에 한 줄이라도 있으면 확장이 읽을 수 있다. 그룹을 말하지
// 않고 쓴 항목은 앱의 **첫 번째** 그룹, 곧 그 공유 그룹으로 간다. 이 파일의 시험은 그 두
// 사실 위에서 「앱 전용 그룹에만, 그룹이 풀릴 때만」을 못박는다.
// =============================================================================

const mockGroup = {value: 'YWQQFQM38J.app.momo.ios.shared' as string | null};
jest.mock('../src/push/native', () => ({
  keychainAccessGroup: () => mockGroup.value,
  apnsEnvironment: () => 'sandbox',
  pushNativeModuleAvailable: () => true,
  nativeApprovalHandlerAttached: () => false,
}));

const APP_ONLY = 'YWQQFQM38J.app.momo.ios.devicekey';
const SHARED = 'YWQQFQM38J.app.momo.ios.shared';
const WS = '22222222-2222-4222-8222-222222222222';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://api.example.com';
const NOW = 1_800_000_000_000;

const keychain = Keychain as unknown as {
  __items: Map<string, {username: string; password: string; options: Record<string, unknown>}>;
  setGenericPassword: jest.Mock;
  getGenericPassword: jest.Mock;
  resetGenericPassword: jest.Mock;
};

const input = {
  baseUrl: BASE,
  workspaceId: WS,
  memberId: MEMBER,
  token: 'push-action-token-1',
  expiresAtMs: NOW + 6 * 3_600_000,
  ttlSeconds: 21_600,
};

beforeEach(() => {
  mockGroup.value = SHARED;
  keychain.__items.clear();
  keychain.setGenericPassword.mockClear();
  keychain.getGenericPassword.mockClear();
  keychain.resetGenericPassword.mockClear();
});

describe('놓는 곳', () => {
  it('앱 전용 그룹에, 확장의 서비스가 아닌 자기 서비스로, 첫 잠금 해제 뒤 이 기기에서만 읽히게 쓴다', async () => {
    const outcome = await publishPushActionSession(input);

    expect(outcome).toEqual({kind: 'published', accessGroup: APP_ONLY});
    expect(keychain.setGenericPassword).toHaveBeenCalledTimes(1);
    const [account, password, options] = keychain.setGenericPassword.mock.calls[0];
    expect(account).toBe(PUSH_ACTION_SESSION_ACCOUNT);
    expect(options).toEqual({
      service: PUSH_ACTION_KEYCHAIN_SERVICE,
      accessGroup: APP_ONLY,
      accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly',
    });
    expect(options.accessGroup).not.toBe(SHARED);
    // 확장의 항목(`app.momo.ios.session`)과 서비스가 다르다.
    expect(options.service).not.toBe('app.momo.ios.session');
    expect(JSON.parse(password)).toEqual({
      baseURL: BASE,
      workspaceID: WS,
      memberID: MEMBER,
      actionToken: 'push-action-token-1',
      expiresAtMs: input.expiresAtMs,
      ttlSeconds: 21_600,
    });
  });

  it('앱 전용 그룹을 못 정하면 아무 데도 쓰지 않는다 — 그룹 없이 쓰면 공유 그룹으로 간다', async () => {
    mockGroup.value = null;

    const outcome = await publishPushActionSession(input);

    expect(outcome).toEqual({kind: 'no-access-group'});
    expect(keychain.setGenericPassword).not.toHaveBeenCalled();
    expect(keychain.__items.size).toBe(0);
  });

  it('공유 그룹이 아닌 이름은 앱 전용 그룹으로 도출되지 않는다', async () => {
    mockGroup.value = 'YWQQFQM38J.something.else';

    expect(await publishPushActionSession(input)).toEqual({kind: 'no-access-group'});
    expect(keychain.setGenericPassword).not.toHaveBeenCalled();
  });

  it('키체인이 거절하면 이유를 담아 failed 를 돌려주고 던지지 않는다', async () => {
    keychain.setGenericPassword.mockRejectedValueOnce(new Error('errSecMissingEntitlement (-34018)'));

    expect(await publishPushActionSession(input)).toEqual({
      kind: 'failed',
      reason: 'errSecMissingEntitlement (-34018)',
    });
  });

  it('쓰기·읽기·지우기 어느 호출도 공유 그룹을 이름으로 대지 않는다', async () => {
    await publishPushActionSession(input);
    await restorePushActionSession({baseUrl: BASE, workspaceId: WS, memberId: MEMBER}, () => NOW);
    await clearPushActionSession();

    const groups = [
      ...keychain.setGenericPassword.mock.calls.map(call => call[2]?.accessGroup),
      ...keychain.getGenericPassword.mock.calls.map(call => call[0]?.accessGroup),
      ...keychain.resetGenericPassword.mock.calls.map(call => call[0]?.accessGroup),
    ];
    expect(groups.length).toBe(3);
    expect(groups.every(group => group === APP_ONLY)).toBe(true);
  });
});

describe('받아도 되는 빌드인가', () => {
  it('앱 전용 그룹을 말할 수 있으면 참이다', () => {
    expect(pushActionSessionAvailable()).toBe(true);
  });

  it('그룹을 못 정하면(plist 키 없음, 모르는 이름) 거짓이다 — 놓을 곳이 없으면 받지도 않는다', () => {
    mockGroup.value = null;
    expect(pushActionSessionAvailable()).toBe(false);
    mockGroup.value = 'YWQQFQM38J.something.else';
    expect(pushActionSessionAvailable()).toBe(false);
  });
});

// 기기 비밀(Swift 가 만드는 32바이트)은 이 자격과 **다른 서비스**에 산다. react-native-keychain 의
// `setGenericPassword`/`resetGenericPassword` 는 계정이 아니라 서비스 단위로 그룹 안의 항목을 전부
// 지운다(RNKeychainManager.m) — 같은 서비스에 두면 토큰을 새로 놓을 때마다 비밀이 사라지고, 잠금 화면에
// 떠 있는 알림의 멱등 키가 그 밑에서 바뀐다 (독립 보안 검수 1번). 시험용 키체인은 서비스를 키로
// 삼으므로 실제 동작과 같은 입자로 잴 수 있다.
describe('기기 비밀은 이 자격의 서비스 밖에 있다', () => {
  const SECRET_SERVICE = 'app.momo.ios.pushaction.secret';
  const plantSecret = () =>
    keychain.__items.set(SECRET_SERVICE, {username: 'device-secret-v1', password: 'secret', options: {}});

  it('놓기·이어 쓰기·사람이 바뀐 폰에서 지우기·지우기 어느 쪽도 비밀을 건드리지 않는다', async () => {
    plantSecret();

    await publishPushActionSession(input);
    await publishPushActionSession({...input, token: 'push-action-token-2'});
    await restorePushActionSession({baseUrl: BASE, workspaceId: WS, memberId: MEMBER}, () => NOW);
    await restorePushActionSession(
      {baseUrl: BASE, workspaceId: WS, memberId: '99999999-9999-4999-8999-999999999999'},
      () => NOW,
    );
    await clearPushActionSession();

    expect(keychain.__items.get(SECRET_SERVICE)?.password).toBe('secret');
    // 지워진 것은 이 자격뿐이다.
    expect(keychain.__items.has(PUSH_ACTION_KEYCHAIN_SERVICE)).toBe(false);
  });

  it('JS 가 키체인에 대는 서비스는 이 자격의 하나뿐이다', async () => {
    await publishPushActionSession(input);
    await restorePushActionSession({baseUrl: BASE, workspaceId: WS, memberId: MEMBER}, () => NOW);
    await clearPushActionSession();

    const services = [
      ...keychain.setGenericPassword.mock.calls.map(call => call[2]?.service),
      ...keychain.getGenericPassword.mock.calls.map(call => call[0]?.service),
      ...keychain.resetGenericPassword.mock.calls.map(call => call[0]?.service),
    ];
    expect(services).toHaveLength(3);
    expect(new Set(services)).toEqual(new Set([PUSH_ACTION_KEYCHAIN_SERVICE]));
    expect(PUSH_ACTION_KEYCHAIN_SERVICE).not.toBe(SECRET_SERVICE);
  });
});

describe('지우기', () => {
  it('이 서비스를 앱 전용 그룹에서 지운다', async () => {
    await publishPushActionSession(input);
    expect(keychain.__items.size).toBe(1);

    await clearPushActionSession();

    expect(keychain.resetGenericPassword).toHaveBeenCalledWith({
      service: PUSH_ACTION_KEYCHAIN_SERVICE,
      accessGroup: APP_ONLY,
    });
    expect(keychain.__items.size).toBe(0);
  });

  it('그룹을 못 정하면 아무것도 건드리지 않는다 (쓴 적이 없다)', async () => {
    mockGroup.value = null;

    await clearPushActionSession();

    expect(keychain.resetGenericPassword).not.toHaveBeenCalled();
  });

  it('키체인이 던져도 로그아웃을 막지 않는다', async () => {
    keychain.resetGenericPassword.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(clearPushActionSession()).resolves.toBeUndefined();
  });
});

describe('지난 실행이 놔 둔 자격을 이어 쓸 때', () => {
  const expected = {baseUrl: BASE, workspaceId: WS, memberId: MEMBER};

  it('이 사람의 것이고 이 서버의 것이고 살아 있으면 그대로 돌려준다', async () => {
    await publishPushActionSession(input);

    expect(await restorePushActionSession(expected, () => NOW)).toEqual({
      token: 'push-action-token-1',
      expiresAtMs: input.expiresAtMs,
      ttlSeconds: 21_600,
      workspaceId: WS,
    });
  });

  it('워크스페이스 id 는 대소문자를 가리지 않는다', async () => {
    await publishPushActionSession({...input, workspaceId: WS.toUpperCase()});

    expect(
      (await restorePushActionSession(expected, () => NOW))?.token,
    ).toBe('push-action-token-1');
  });

  it('놓인 것이 없으면 null 이다', async () => {
    expect(await restorePushActionSession(expected, () => NOW)).toBeNull();
  });

  it('다른 멤버의 것이면 null 이고 **그 자리에서 지운다** (로그아웃 없이 사람이 바뀐 폰)', async () => {
    await publishPushActionSession({...input, memberId: '99999999-9999-4999-8999-999999999999'});

    expect(await restorePushActionSession(expected, () => NOW)).toBeNull();
    expect(keychain.__items.size).toBe(0);
  });

  it('다른 서버의 것이면 null 이고 지운다', async () => {
    await publishPushActionSession({...input, baseUrl: 'https://other.example.com'});

    expect(await restorePushActionSession(expected, () => NOW)).toBeNull();
    expect(keychain.__items.size).toBe(0);
  });

  it('같은 사람의 다른 워크스페이스 것이면 null 이되 지우지는 않는다 (곧 덮어쓴다)', async () => {
    await publishPushActionSession({...input, workspaceId: '33333333-3333-4333-8333-333333333333'});

    expect(await restorePushActionSession(expected, () => NOW)).toBeNull();
    expect(keychain.__items.size).toBe(1);
  });

  it('만료됐으면 null 이다', async () => {
    await publishPushActionSession(input);

    expect(await restorePushActionSession(expected, () => input.expiresAtMs)).toBeNull();
    expect(await restorePushActionSession(expected, () => input.expiresAtMs + 1)).toBeNull();
  });

  it.each([
    ['JSON 이 아니다', 'not json'],
    ['토큰이 비었다', JSON.stringify({baseURL: BASE, workspaceID: WS, memberID: MEMBER, actionToken: '', expiresAtMs: NOW + 1, ttlSeconds: 1})],
    ['멤버가 없다', JSON.stringify({baseURL: BASE, workspaceID: WS, actionToken: 't', expiresAtMs: NOW + 1, ttlSeconds: 1})],
    ['만료 시각이 문자열이다', JSON.stringify({baseURL: BASE, workspaceID: WS, memberID: MEMBER, actionToken: 't', expiresAtMs: 'soon', ttlSeconds: 1})],
  ])('읽을 수 없는 항목(%s)은 null 이다', async (_name, password) => {
    keychain.__items.set(PUSH_ACTION_KEYCHAIN_SERVICE, {
      username: PUSH_ACTION_SESSION_ACCOUNT,
      password,
      options: {},
    });

    expect(await restorePushActionSession(expected, () => NOW)).toBeNull();
  });

  it('그룹을 못 정하면 읽지 않는다', async () => {
    await publishPushActionSession(input);
    mockGroup.value = null;
    keychain.getGenericPassword.mockClear();

    expect(await restorePushActionSession(expected, () => NOW)).toBeNull();
    expect(keychain.getGenericPassword).not.toHaveBeenCalled();
  });

  it('키체인이 던지면 null 이다', async () => {
    keychain.getGenericPassword.mockRejectedValueOnce(new Error('locked'));

    expect(await restorePushActionSession(expected, () => NOW)).toBeNull();
  });
});
