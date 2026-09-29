import type {DeviceKey} from '@momo/core/features/auth/deviceKeys';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {bytesToBase64} from '../src/deviceKey/base64';
import {
  deriveDeviceKeyView,
  enrollDeviceKey,
  EnrollError,
  forgetDeviceKeyOnSignOut,
  replaceInvalidatedKey,
  type DeviceKeyView,
} from '../src/deviceKey/enrollment';
import {deviceKeyCopy, QR_LINK_STEPS} from '../src/features/deviceKey/copy';
import {DeviceKeyLinkGate} from '../src/features/deviceKey/DeviceKeyLinkSheet';
import {DeviceKeyPanel} from '../src/features/deviceKey/DeviceKeyPanel';
import {useDeviceKey} from '../src/features/deviceKey/useDeviceKey';
import {deviceLinkDevice} from '../src/features/deviceLink/deviceIdentity';
import {noteConnectRoute, resetConnectRoute} from '../src/features/onboarding/phoneFlow';
import {SessionProvider, useSession} from '../src/session/useSession';
import {__setNonSecretStore} from '../src/storage/kv';
import {
  __resetSessionStore,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

/**
 * The Mac's own function, from clients/web as it ships. Loaded with `require`
 * so this project's `tsc` does not type-check the web tree (its `@/` alias is
 * the web project's); jest runs it through babel like the core.
 */
const {deviceKeyFingerprint: webFingerprint} =
  require('../../web/src/features/settings/deviceKeysShared') as {
    deviceKeyFingerprint: (publicKeyB64: string) => Promise<string>;
  };

// =============================================================================
// #3026 stage 2 — the phone's key is made at QR link, registered, and waits for
// the root Mac (ADR-0146 개정 2026-09-28 D-2 · D-6 ② · D-7).
//
// Under test: what the enrollment does to the enclave double and the server
// double, what each state says on screen, and the two deletion rules —
// `invalidated` is deleted only on the person's press, and sign-out deletes the
// key the server just revoked. Real enclave / Face ID is runtime-unverified
// (owner device check).
// =============================================================================

type NativeDouble = {
  secureEnclaveAvailable: boolean;
  status: jest.Mock;
  create: jest.Mock;
  publicKey: jest.Mock;
  sign: jest.Mock;
  remove: jest.Mock;
};

let mockNative: NativeDouble | null = null;

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (name: string) =>
    name === 'MomoDeviceKeyNative'
      ? new Proxy(
          {},
          {
            get: (_target, prop) =>
              (mockNative as Record<string | symbol, unknown> | null)?.[prop],
          },
        )
      : null,
}));

const WS = '22222222-2222-4222-8222-222222222222';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://api.example.com';
const KEY = 'A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW';
const OTHER_KEY = bytesToBase64(Uint8Array.from([0x03, ...new Array(32).fill(5)]));
const SHARED_FINGERPRINT = '5BAF F89D E7DE 5C1D 7B61';

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {
    id: MEMBER,
    workspaceId: WS,
    kind: 'human' as const,
    displayName: '곽성재',
    handle: 'seongjae',
  },
};

function nativeError(code: string): Error {
  return Object.assign(new Error(code), {code});
}

/** An enclave double with a key slot, like MomoDeviceKeyStore. */
function phone(initial: {key?: string | null; status?: string} = {}): NativeDouble {
  let key: string | null = initial.key ?? null;
  let forced: string | undefined = initial.status;
  return {
    secureEnclaveAvailable: true,
    status: jest.fn(async () => forced ?? (key ? 'ready' : 'absent')),
    create: jest.fn(async () => {
      if (key) throw nativeError('DEVICE_KEY_ALREADY_EXISTS');
      key = KEY;
      forced = undefined;
      return key;
    }),
    publicKey: jest.fn(async () => key),
    sign: jest.fn(),
    remove: jest.fn(async () => {
      key = null;
      forced = undefined;
    }),
  };
}

function row(overrides: Partial<DeviceKey> = {}): DeviceKey {
  return {
    id: '00000000-0000-7000-8000-00000000d002',
    workspaceId: WS,
    memberId: MEMBER,
    alg: 'p256',
    publicKey: KEY,
    platform: 'ios',
    label: 'iPhone',
    state: 'unendorsed',
    canInstruct: false,
    current: true,
    lineageLive: true,
    createdAtMs: 1_790_550_000_000,
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[];
let serverRows: DeviceKey[];
let registerStatus: number;
let registerCode: string | undefined;
let listFails: boolean;

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

beforeEach(async () => {
  __setNonSecretStore(memoryStore());
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();
  resetConnectRoute();
  mockNative = phone();
  calls = [];
  serverRows = [];
  registerStatus = 201;
  registerCode = undefined;
  listFails = false;
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({method, path: url.pathname, body});
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: {'Content-Type': 'application/json'},
      });
    if (url.pathname === `/v1/workspaces/${WS}/device-keys`) {
      if (method === 'POST') {
        if (registerStatus !== 201) {
          return json(registerStatus, {error: {message: 'no', code: registerCode}});
        }
        const created = row({publicKey: body.publicKey, label: body.label, createdAtMs: Date.now()});
        serverRows = [created, ...serverRows];
        return json(201, {deviceKey: created});
      }
      if (listFails) throw new TypeError('Network request failed');
      return json(200, {deviceKeys: serverRows});
    }
    return json(200, {status: 'ok'});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
});

const posts = () => calls.filter(c => c.method === 'POST' && c.path.endsWith('/device-keys'));
const LABEL = () => deviceLinkDevice().name;

// ---- the view ---------------------------------------------------------------

describe('deriveDeviceKeyView — every state says only what it knows', () => {
  const ready = {status: 'ready' as const, publicKey: KEY};
  const derive = (over: Partial<Parameters<typeof deriveDeviceKeyView>[0]>) =>
    deriveDeviceKeyView({local: ready, localError: null, rows: [], rowsError: null, ...over});

  it('maps the enclave and the server row to one state', () => {
    expect(derive({local: {status: 'unsupported', publicKey: null}}).kind).toBe('unsupported');
    expect(derive({local: {status: 'invalidated', publicKey: null}}).kind).toBe('invalidated');
    expect(derive({local: {status: 'absent', publicKey: null}}).kind).toBe('unregistered');
    expect(derive({local: {status: 'biometryUnavailable', publicKey: null}}).kind).toBe(
      'biometryOff',
    );
    expect(derive({rows: []}).kind).toBe('unregistered');
    expect(derive({rows: [row()]}).kind).toBe('pending');
    expect(derive({rows: [row({state: 'endorsed', canInstruct: true})]}).kind).toBe('approved');
    expect(derive({rows: [row({state: 'revoked'})]}).kind).toBe('revoked');
    expect(derive({rows: undefined}).kind).toBe('loading');
    expect(derive({rowsError: new Error('offline')}).kind).toBe('serverError');
    expect(derive({local: undefined}).kind).toBe('loading');
  });

  it('prefers the live row over an older revoked one for the same key', () => {
    const rows = [
      row({id: 'old', state: 'revoked', createdAtMs: 1}),
      row({id: 'new', state: 'unendorsed', createdAtMs: 2}),
    ];
    const view = derive({rows});
    expect(view.kind).toBe('pending');
    expect(view.kind === 'pending' && view.row.id).toBe('new');
  });

  it("ignores other devices' keys — a Mac root or another phone is not this phone", () => {
    const rows = [
      row({publicKey: OTHER_KEY, state: 'endorsed'}),
      row({platform: 'macos', state: 'root'}),
    ];
    expect(derive({rows}).kind).toBe('unregistered');
  });

  it('keeps a key whose Face ID is merely off, and says so', () => {
    const view = derive({
      local: {status: 'biometryUnavailable', publicKey: KEY},
      rows: [row({state: 'endorsed'})],
    });
    expect(view).toMatchObject({kind: 'approved', biometryOff: true});
  });

  it('shows the Mac fingerprint, not a phone-only one', async () => {
    const view = derive({rows: [row()]});
    expect(view.kind === 'pending' && view.fingerprint).toBe(SHARED_FINGERPRINT);
    expect(await webFingerprint(KEY)).toBe(SHARED_FINGERPRINT);
  });
});

// ---- the actions --------------------------------------------------------------

describe('enrollDeviceKey', () => {
  it('creates a key and registers it as this phone, under the QR redeem name', async () => {
    const outcome = await enrollDeviceKey({workspaceId: WS, label: LABEL()});
    expect(outcome).toEqual({kind: 'registered', publicKey: KEY});
    expect(mockNative!.create).toHaveBeenCalledTimes(1);
    expect(posts().map(c => c.body)).toEqual([
      {alg: 'p256', publicKey: KEY, platform: 'ios', label: LABEL()},
    ]);
  });

  it('does not register twice when the key already has a live row', async () => {
    mockNative = phone({key: KEY});
    serverRows = [row()];
    await enrollDeviceKey({workspaceId: WS, label: LABEL()});
    expect(mockNative.create).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
  });

  it('re-registers a good key whose row was revoked (the Mac re-approves)', async () => {
    mockNative = phone({key: KEY});
    serverRows = [row({state: 'revoked'})];
    await enrollDeviceKey({workspaceId: WS, label: LABEL()});
    expect(mockNative.remove).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
  });

  it('treats 409 already-registered as done when the list shows it live', async () => {
    mockNative = phone({key: KEY});
    registerStatus = 409;
    registerCode = 'device_key_already_registered';
    let listed = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        listed += 1;
        serverRows = listed === 1 ? [] : [row()];
      }
      return realFetch(input, init);
    }) as unknown as typeof fetch;
    await expect(enrollDeviceKey({workspaceId: WS, label: LABEL()})).resolves.toEqual({
      kind: 'registered',
      publicKey: KEY,
    });
  });

  it('never deletes an invalidated key on its own', async () => {
    mockNative = phone({key: KEY, status: 'invalidated'});
    expect(await enrollDeviceKey({workspaceId: WS, label: LABEL()})).toEqual({
      kind: 'invalidated',
    });
    expect(mockNative.remove).not.toHaveBeenCalled();
    expect(mockNative.create).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
  });

  it('says unsupported on a simulator', async () => {
    mockNative = {...phone(), secureEnclaveAvailable: false, status: jest.fn(async () => 'unsupported')};
    expect((await enrollDeviceKey({workspaceId: WS, label: 'x'})).kind).toBe('unsupported');
    // A module that refuses with UNSUPPORTED mid-way (MomoDeviceKeyStore.create).
    mockNative = phone();
    mockNative.create.mockRejectedValueOnce(nativeError('DEVICE_KEY_UNSUPPORTED'));
    expect((await enrollDeviceKey({workspaceId: WS, label: 'x'})).kind).toBe('unsupported');
    expect(posts()).toHaveLength(0);
  });

  it('says Face ID is off when there is no biometry to bind a key to', async () => {
    mockNative = phone({status: 'biometryUnavailable'});
    expect((await enrollDeviceKey({workspaceId: WS, label: 'x'})).kind).toBe('biometryOff');
    mockNative = phone();
    mockNative.create.mockRejectedValueOnce(nativeError('DEVICE_KEY_BIOMETRY_UNAVAILABLE'));
    expect((await enrollDeviceKey({workspaceId: WS, label: 'x'})).kind).toBe('biometryOff');
  });

  it('fails with a sentence, not a code, when the server cannot be reached', async () => {
    listFails = true;
    const error = await enrollDeviceKey({workspaceId: WS, label: 'x'}).catch(e => e);
    expect(error).toBeInstanceOf(EnrollError);
    expect(error.message).toBe(
      '지시 기기로 등록하지 못했습니다. 연결을 확인하고 다시 시도하세요.',
    );
  });

  it('names an ended sign-in', async () => {
    registerStatus = 409;
    registerCode = 'session_lineage_ended';
    const error = await enrollDeviceKey({workspaceId: WS, label: 'x'}).catch(e => e);
    expect(error.message).toBe(
      '이 로그인으로는 더 이상 키를 등록할 수 없습니다. 다시 로그인하세요.',
    );
  });

  it('tells a phone signed in by address to link by QR from the Mac (#3119)', async () => {
    registerStatus = 403;
    registerCode = 'device_key_requires_linked_session';
    const error = await enrollDeviceKey({workspaceId: WS, label: 'x'}).catch(e => e);
    expect(error).toBeInstanceOf(EnrollError);
    expect(error.message).toBe(
      '이 폰으로 지시하려면 맥에서 QR로 한 번 연결하세요. 대화와 알림은 그대로 씁니다.',
    );
  });
});

// ---- #3103: a live key on an ended sign-in moves itself ------------------------

describe('rebind — 409 device_key_rebind_required and lineageLive: false (#3103)', () => {
  const SESSION = '33333333-3333-4333-8333-333333333333';
  const SIG = bytesToBase64(new Uint8Array(64).fill(9));
  let rebindAnswer: {status: number; body: unknown} | null;
  let contextSession: string | null;

  beforeEach(() => {
    rebindAnswer = null;
    contextSession = SESSION;
    const base = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const json = (status: number, value: unknown) =>
        new Response(JSON.stringify(value), {
          status,
          headers: {'Content-Type': 'application/json'},
        });
      if (url.pathname.endsWith('/device-keys/signing-context')) {
        calls.push({method: 'GET', path: url.pathname, body: undefined});
        return json(200, {
          instanceId: 'inst',
          serverTimeMs: Date.now(),
          maxLifetimeMs: 600_000,
          maxClockSkewMs: 300_000,
          humanControlSignatureRequired: true,
          hostRegisterSignatureRequired: false,
          sessionId: contextSession,
        });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (init?.method === 'POST' && body?.rebind) {
        calls.push({method: 'POST', path: url.pathname, body});
        const answer = rebindAnswer ?? {
          status: 200,
          body: {deviceKey: row({state: 'endorsed', current: true, lineageLive: true})},
        };
        return json(answer.status, answer.body);
      }
      return base(input, init);
    }) as unknown as typeof fetch;
  });

  const rebinds = () => posts().filter(c => (c.body as {rebind?: unknown}).rebind);

  it('moves a live, approved row on an ended sign-in with its own letter — no new row', async () => {
    mockNative = phone({key: KEY});
    mockNative.sign.mockResolvedValue(SIG);
    serverRows = [row({state: 'endorsed', current: false, lineageLive: false})];
    await expect(enrollDeviceKey({workspaceId: WS, label: LABEL()})).resolves.toEqual({
      kind: 'registered',
      publicKey: KEY,
    });
    expect(mockNative.create).not.toHaveBeenCalled();
    // One letter, signed with Face ID, naming this key and the context's sign-in.
    expect(mockNative.sign).toHaveBeenCalledTimes(1);
    const [message, reason] = mockNative.sign.mock.calls[0] as [string, string];
    const lines = Buffer.from(message, 'base64').toString('utf8').split('\n');
    expect(lines.slice(0, 6)).toEqual([
      'momo.human.device_rebind.v1',
      WS,
      MEMBER,
      row().id,
      KEY,
      SESSION,
    ]);
    expect(reason).toBe('이 폰의 지시 키를 새 로그인에 다시 연결해요');
    expect(rebinds()).toHaveLength(1);
    expect(rebinds()[0]!.body).toMatchObject({
      alg: 'p256',
      publicKey: KEY,
      platform: 'ios',
      rebind: {signature: SIG, signedAtMs: Number(lines[6])},
    });
    // Never a fresh registration (that would need the Mac to approve again).
    expect(posts().filter(c => !(c.body as {rebind?: unknown}).rebind)).toHaveLength(0);
  });

  it('answers a 409 device_key_rebind_required (stale list) by moving the key', async () => {
    mockNative = phone({key: KEY});
    mockNative.sign.mockResolvedValue(SIG);
    registerStatus = 409;
    registerCode = 'device_key_rebind_required';
    let listed = 0;
    const withRebind = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && String(input).endsWith('/device-keys')) {
        listed += 1;
        serverRows = listed === 1 ? [] : [row({current: false, lineageLive: false})];
      }
      return withRebind(input, init);
    }) as unknown as typeof fetch;
    await enrollDeviceKey({workspaceId: WS, label: LABEL()});
    expect(mockNative.sign).toHaveBeenCalledTimes(1);
    expect(rebinds()).toHaveLength(1);
  });

  it('treats a 200 whose row is not current as a failure, and says so', async () => {
    mockNative = phone({key: KEY});
    mockNative.sign.mockResolvedValue(SIG);
    serverRows = [row({current: false, lineageLive: false})];
    rebindAnswer = {
      status: 200,
      // Live lineage, but not THIS sign-in's: still not moved here.
      body: {deviceKey: row({current: false, lineageLive: true})},
    };
    const error = await enrollDeviceKey({workspaceId: WS, label: LABEL()}).catch(e => e);
    expect(error).toBeInstanceOf(EnrollError);
    expect(error.message).toBe(
      '서버가 이 키를 이 로그인으로 옮기지 않았습니다. 다시 시도하세요.',
    );
  });

  it('signs nothing without a sign-in to move to, and names a refused letter', async () => {
    mockNative = phone({key: KEY});
    mockNative.sign.mockResolvedValue(SIG);
    serverRows = [row({current: false, lineageLive: false})];
    contextSession = null;
    const none = await enrollDeviceKey({workspaceId: WS, label: LABEL()}).catch(e => e);
    expect(none.message).toBe(
      '이 로그인으로는 키를 옮길 수 없습니다. 로그아웃한 뒤 다시 로그인하세요.',
    );
    expect(mockNative.sign).not.toHaveBeenCalled();
    contextSession = SESSION;
    rebindAnswer = {
      status: 403,
      body: {error: {message: 'no', code: 'device_signature_invalid'}},
    };
    const refused = await enrollDeviceKey({workspaceId: WS, label: LABEL()}).catch(e => e);
    expect(refused.message).toContain('시계');
  });

  it('says a cancelled Face ID plainly', async () => {
    mockNative = phone({key: KEY});
    mockNative.sign.mockRejectedValue(nativeError('DEVICE_KEY_CANCELLED'));
    serverRows = [row({current: false, lineageLive: false})];
    const error = await enrollDeviceKey({workspaceId: WS, label: LABEL()}).catch(e => e);
    expect(error.message).toBe('Face ID를 취소해 다시 연결하지 않았습니다.');
    expect(rebinds()).toHaveLength(0);
  });

  it('shows 「다시 연결 필요」, never 「승인됨」, for such a row', () => {
    const view = deriveDeviceKeyView({
      local: {status: 'ready', publicKey: KEY},
      localError: null,
      rows: [row({state: 'endorsed', canInstruct: true, current: false, lineageLive: false})],
      rowsError: null,
    });
    expect(view.kind).toBe('reconnect');
    expect(deviceKeyCopy(view).badge).toBe('다시 연결 필요');
    expect(deviceKeyCopy(view, true).badge).toBe('다시 연결 중');
    // A server from before #3097 (no field) reads as live.
    expect(
      deriveDeviceKeyView({
        local: {status: 'ready', publicKey: KEY},
        localError: null,
        rows: [row({state: 'endorsed'})],
        rowsError: null,
      }).kind,
    ).toBe('approved');
  });
});

describe('replaceInvalidatedKey — the person pressed 「새 키로 다시 등록」', () => {
  it('deletes the proven-dead key, makes a new one and registers it', async () => {
    mockNative = phone({key: OTHER_KEY, status: 'invalidated'});
    const outcome = await replaceInvalidatedKey({workspaceId: WS, label: LABEL()});
    expect(mockNative.remove).toHaveBeenCalledTimes(1);
    expect(mockNative.create).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({kind: 'registered', publicKey: KEY});
    expect(posts()).toHaveLength(1);
  });

  it('refuses to delete a key that is not invalidated any more (stale screen)', async () => {
    mockNative = phone({key: KEY});
    serverRows = [row()];
    await replaceInvalidatedKey({workspaceId: WS, label: LABEL()});
    expect(mockNative.remove).not.toHaveBeenCalled();
  });
});

describe('sign-out', () => {
  it('forgets the enclave key the server revokes with the lineage', async () => {
    mockNative = phone({key: KEY});
    let signOut: (() => void) | null = null;
    function Probe(): null {
      signOut = useSession().signOut;
      return null;
    }
    render(
      <QueryClientProvider client={new QueryClient({defaultOptions: {queries: {gcTime: 0}}})}>
        <SessionProvider member={LOGIN_BODY.member as never}>
          <Probe />
        </SessionProvider>
      </QueryClientProvider>,
    );
    act(() => signOut!());
    await waitFor(() => expect(mockNative!.remove).toHaveBeenCalledTimes(1));
  });

  it('is quiet where there is no module (simulator build without it)', () => {
    mockNative = null;
    expect(() => forgetDeviceKeyOnSignOut()).not.toThrow();
  });
});

// ---- the screens --------------------------------------------------------------

/** The fingerprint as a person reads it: every group, in order. */
function shownFingerprint(): string {
  return screen
    .getAllByTestId('device-key-fingerprint-group')
    .map(node => node.props.children)
    .join(' ');
}

function panelFor(view: DeviceKeyView, over: {failure?: string | null; busy?: boolean} = {}) {
  const state = {
    view,
    enroll: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
    busy: over.busy ?? false,
    failure: over.failure ?? null,
  };
  render(<DeviceKeyPanel state={state} />);
  return state;
}

describe('DeviceKeyPanel — each state on screen', () => {
  const r = row();
  const cases: [DeviceKeyView, string | null, string[]][] = [
    [{kind: 'unsupported'}, null, []],
    [{kind: 'biometryOff'}, null, ['settings', 'recheck']],
    [{kind: 'invalidated'}, null, ['replace']],
    [{kind: 'unregistered', fingerprint: null}, null, ['enroll']],
    [{kind: 'pending', fingerprint: SHARED_FINGERPRINT, row: r, biometryOff: false}, SHARED_FINGERPRINT, []],
    [{kind: 'approved', fingerprint: SHARED_FINGERPRINT, row: r, biometryOff: false}, SHARED_FINGERPRINT, []],
    [{kind: 'approved', fingerprint: SHARED_FINGERPRINT, row: r, biometryOff: true}, SHARED_FINGERPRINT, ['settings', 'recheck']],
    [{kind: 'revoked', fingerprint: SHARED_FINGERPRINT, row: r, biometryOff: false}, SHARED_FINGERPRINT, ['reenroll']],
    [{kind: 'serverError', fingerprint: SHARED_FINGERPRINT}, SHARED_FINGERPRINT, ['retry']],
    [{kind: 'reconnect', fingerprint: SHARED_FINGERPRINT, row: r, biometryOff: false}, SHARED_FINGERPRINT, ['reconnect']],
    [{kind: 'reconnect', fingerprint: SHARED_FINGERPRINT, row: r, biometryOff: true}, SHARED_FINGERPRINT, ['settings', 'recheck']],
  ];

  it.each(cases.map(c => [c[0].kind, ...c] as const))(
    '%s: badge, sentence, fingerprint and actions',
    (_kind, view, fingerprint, actions) => {
      panelFor(view);
      const copy = deviceKeyCopy(view);
      expect(screen.getByTestId('device-key-badge').props.children).toBe(copy.badge);
      expect(screen.getByTestId('device-key-headline').props.children).toBe(copy.headline);
      if (fingerprint) {
        expect(shownFingerprint()).toBe(fingerprint);
      } else {
        expect(screen.queryByTestId('device-key-fingerprint')).toBeNull();
      }
      const shown = ['enroll', 'reenroll', 'reconnect', 'replace', 'settings', 'recheck', 'retry'].filter(
        a => screen.queryByTestId(`device-key-action-${a}`) !== null,
      );
      expect(shown).toEqual(actions);
    },
  );

  it('approved with Face ID off does not claim the phone can instruct (R1 H1)', () => {
    panelFor({kind: 'approved', fingerprint: SHARED_FINGERPRINT, row: r, biometryOff: true});
    expect(screen.getByTestId('device-key-badge').props.children).toBe('Face ID 필요');
    expect(screen.getByTestId('device-key-headline').props.children).not.toBe(
      '이 폰으로 에이전트에게 지시할 수 있습니다.',
    );
  });

  it('shows every fingerprint group, one element each, so a line never breaks inside a group (R1 B1)', () => {
    panelFor({kind: 'pending', fingerprint: SHARED_FINGERPRINT, row: r, biometryOff: false});
    const groups = screen.getAllByTestId('device-key-fingerprint-group');
    expect(groups.map(g => g.props.children)).toEqual(SHARED_FINGERPRINT.split(' '));
    for (const g of groups) expect(g.props.numberOfLines).toBeUndefined();
  });

  it('says it is registering while it is, not that the phone is not an instruction device', () => {
    panelFor({kind: 'unregistered', fingerprint: null}, {busy: true});
    expect(screen.getByTestId('device-key-badge').props.children).toBe('등록 중');
  });

  it('pending tells the person where on the Mac to approve', () => {
    panelFor({kind: 'pending', fingerprint: SHARED_FINGERPRINT, row: r, biometryOff: false});
    expect(screen.getByTestId('device-key-detail').props.children).toContain(
      '설정 › 기기 › 지시 서명',
    );
  });

  it('invalidated only offers the explicit replacement, and wires it to replace()', () => {
    const state = panelFor({kind: 'invalidated'});
    fireEvent.press(screen.getByTestId('device-key-action-replace'));
    expect(state.replace).toHaveBeenCalledTimes(1);
    expect(state.enroll).not.toHaveBeenCalled();
  });

  it('shows the failure sentence and a busy action', () => {
    panelFor({kind: 'unregistered', fingerprint: null}, {failure: '실패 문장', busy: true});
    expect(screen.getByTestId('device-key-failure').props.children).toBe('실패 문장');
    expect(screen.getByTestId('device-key-action-enroll').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});

// ---- QR link → key → sheet ------------------------------------------------------

function renderGate() {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={LOGIN_BODY.member as never}>
        <DeviceKeyLinkGate />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('the QR link gate', () => {
  it('after a QR link: makes the key, registers it, and shows 「승인 전」 with the Mac fingerprint', async () => {
    noteConnectRoute('qr');
    renderGate();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({platform: 'ios', publicKey: KEY, label: LABEL()});
    await waitFor(() =>
      expect(screen.getByTestId('device-key-badge').props.children).toBe('승인 전'),
    );
    expect(shownFingerprint()).toBe(
      await webFingerprint(KEY),
    );
    expect(mockNative!.sign).not.toHaveBeenCalled();
  });

  it('on a simulator: says so honestly and registers nothing', async () => {
    mockNative = {...phone(), secureEnclaveAvailable: false, status: jest.fn(async () => 'unsupported')};
    noteConnectRoute('qr');
    renderGate();
    await waitFor(() =>
      expect(screen.getByTestId('device-key-badge').props.children).toBe('쓸 수 없음'),
    );
    expect(posts()).toHaveLength(0);
  });

  it('does nothing after a password sign-in or an invite', async () => {
    noteConnectRoute('qr');
    noteConnectRoute('signIn');
    renderGate();
    await act(async () => {});
    expect(screen.queryByTestId('device-key-link-sheet')).toBeNull();
    expect(mockNative!.create).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
  });

  it('runs once per link: a remount does not register again', async () => {
    noteConnectRoute('qr');
    const first = renderGate();
    await waitFor(() => expect(posts()).toHaveLength(1));
    first.unmount();
    renderGate();
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(screen.queryByTestId('device-key-link-sheet')).toBeNull();
  });
});

// ---- #3129: 「QR 연결로만」 on the phone -----------------------------------------
// (ADR-0146 D-6 증보, #3119). A sign-in that is not a QR link cannot make this
// phone an instruction device; the panel says so before the button is pressed
// when it can know (the connect route this run), and after the server's
// refusal when it cannot (an app restart).

describe('#3129 — a sign-in that is not a QR link', () => {
  const ready = {status: 'ready' as const, publicKey: KEY};
  const derive = (over: Partial<Parameters<typeof deriveDeviceKeyView>[0]>) =>
    deriveDeviceKeyView({local: ready, localError: null, rows: [], rowsError: null, ...over});

  it('an unapprovable waiting key is never 「승인 전」', () => {
    expect(derive({rows: [row({linkedSession: false, linkedFromMac: false})]})).toEqual({
      kind: 'unlinked',
      reason: 'address',
      fingerprint: SHARED_FINGERPRINT,
    });
    expect(derive({rows: [row({linkedSession: true, linkedFromMac: false})]})).toMatchObject({
      kind: 'unlinked',
      reason: 'notFromMac',
    });
    // An older server says nothing: nothing is inferred.
    expect(derive({rows: [row()]}).kind).toBe('pending');
    expect(derive({rows: [row({linkedSession: true, linkedFromMac: true})]}).kind).toBe('pending');
    // An approved key before the rule keeps working (the Mac marks it 「QR 아님」).
    expect(
      derive({rows: [row({state: 'endorsed', canInstruct: true, linkedSession: false})]}).kind,
    ).toBe('approved');
  });

  it('a known unlinked sign-in turns 「등록 안 됨」 and 「끊김」 into 「QR 연결 필요」, nothing else', () => {
    expect(derive({rows: [], signInUnlinked: true})).toMatchObject({
      kind: 'unlinked',
      reason: 'address',
    });
    expect(derive({local: {status: 'absent', publicKey: null}, signInUnlinked: true})).toEqual({
      kind: 'unlinked',
      reason: 'address',
      fingerprint: null,
    });
    expect(derive({rows: [row({state: 'revoked'})], signInUnlinked: true}).kind).toBe('unlinked');
    expect(
      derive({rows: [row({state: 'endorsed', canInstruct: true})], signInUnlinked: true}).kind,
    ).toBe('approved');
    expect(derive({local: {status: 'unsupported', publicKey: null}, signInUnlinked: true}).kind).toBe(
      'unsupported',
    );
  });

  it('the panel says how, offers no refused button, and uses 합니다체', () => {
    panelFor({kind: 'unlinked', reason: 'address', fingerprint: null});
    expect(screen.getByTestId('device-key-badge').props.children).toBe('QR 연결 필요');
    expect(screen.getByTestId('device-key-headline').props.children).toBe(
      '이 폰으로 지시하려면 맥에서 QR로 한 번 연결해야 합니다.',
    );
    expect(screen.getAllByTestId('device-key-step').map(n => n.props.children)).toEqual([
      ...QR_LINK_STEPS,
    ]);
    expect(QR_LINK_STEPS[0]).toContain('설정 › 기기 › 폰 연결');
    expect(screen.queryByTestId('device-key-action-enroll')).toBeNull();
    for (const kind of ['address', 'notFromMac'] as const) {
      const copy = deviceKeyCopy({kind: 'unlinked', reason: kind, fingerprint: null});
      for (const sentence of [copy.headline, copy.detail, ...(copy.steps ?? [])]) {
        expect(sentence).toMatch(/(니다|세요)\.$/);
      }
    }
  });

  it('a QR from somewhere other than a Mac says so, with the same way forward', () => {
    panelFor({kind: 'unlinked', reason: 'notFromMac', fingerprint: SHARED_FINGERPRINT});
    expect(screen.getAllByTestId('device-key-step')).toHaveLength(QR_LINK_STEPS.length);
    expect(shownFingerprint()).toBe(SHARED_FINGERPRINT);
    expect(screen.getByTestId('device-key-detail').props.children).toContain(
      '맥이 아닌 곳에서 띄운 QR',
    );
  });

  function Probe() {
    const state = useDeviceKey(WS, {poll: false});
    return <DeviceKeyPanel state={state} />;
  }
  function renderProbe() {
    const client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {gcTime: 0}},
    });
    return render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  }

  it('after an address sign-in this run: says so before any press, and registers nothing', async () => {
    noteConnectRoute('signIn');
    renderProbe();
    await waitFor(() =>
      expect(screen.getByTestId('device-key-badge').props.children).toBe('QR 연결 필요'),
    );
    expect(screen.queryByTestId('device-key-action-enroll')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("after a restart (route unknown): the server's refusal turns the panel, once, without a second sentence", async () => {
    registerStatus = 403;
    registerCode = 'device_key_requires_linked_session';
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('device-key-action-enroll')).toBeTruthy());
    fireEvent.press(screen.getByTestId('device-key-action-enroll'));
    await waitFor(() =>
      expect(screen.getByTestId('device-key-badge').props.children).toBe('QR 연결 필요'),
    );
    expect(posts()).toHaveLength(1);
    expect(screen.queryByTestId('device-key-failure')).toBeNull();
    expect(screen.queryByTestId('device-key-action-enroll')).toBeNull();
  });

  it('another refusal is still a failure sentence under the enroll button', async () => {
    registerStatus = 403;
    registerCode = 'forbidden';
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('device-key-action-enroll')).toBeTruthy());
    fireEvent.press(screen.getByTestId('device-key-action-enroll'));
    await waitFor(() => expect(screen.getByTestId('device-key-failure')).toBeTruthy());
    expect(screen.getByTestId('device-key-badge').props.children).toBe('등록 안 됨');
  });

  it('marks only the linked-session refusal as unlinked', async () => {
    registerStatus = 403;
    registerCode = 'device_key_requires_linked_session';
    const error = await enrollDeviceKey({workspaceId: WS, label: 'x'}).catch(e => e);
    expect(error).toBeInstanceOf(EnrollError);
    expect(error.unlinked).toBe(true);
    registerCode = 'session_lineage_ended';
    const other = await enrollDeviceKey({workspaceId: WS, label: 'x'}).catch(e => e);
    expect(other.unlinked).toBe(false);
  });
});

describe('#3129 — the link sheet after a QR no Mac made', () => {
  it('does not say the link is done next to 「QR 연결 필요」', async () => {
    serverRows = [row({publicKey: KEY, linkedSession: true, linkedFromMac: false})];
    mockNative = phone({key: KEY});
    noteConnectRoute('qr');
    renderGate();
    await waitFor(() =>
      expect(screen.getByTestId('device-key-badge').props.children).toBe('QR 연결 필요'),
    );
    expect(screen.getByTestId('device-key-link-intro').props.children).toBe(
      '대화와 알림은 연결됐습니다.',
    );
  });
});
