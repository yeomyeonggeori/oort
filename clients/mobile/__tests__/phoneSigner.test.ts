import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
}));

import {SignerRefusal, type ControlToSign} from '@momo/core/features/auth/signedControl';

import {humanControlPayload} from '../src/deviceKey/humanControl';
import {DeviceKeyError} from '../src/deviceKey/native';
import {phoneSigner, phoneSignerRefusal, phoneSignInput} from '../src/deviceKey/signer';

// =============================================================================
// #3028 R2-E8 — the phone's half of the cross test.
//
// The desktop page's requests to its shell are pinned in
// `clients/web/src/features/work/__fixtures__/desktop-sign-requests.json` (made
// by `shellControlRequest`, rebuilt into the v2 vector bytes by the Rust shell).
// The SAME `ControlToSign` given to the phone signer must build the SAME bytes:
// phone and desktop sign one statement for one intent.
// =============================================================================

interface Entry {
  name: string;
  signer: {workspaceId: string; memberId: string; keyId: string};
  request: {
    workspaceId: string;
    instanceId: string;
    hostId: string;
    sessionId: string | null;
    nonce: string;
    issuedAtMs: number;
    expiresAtMs: number;
    content: ControlToSign['content'];
  };
  payload: string;
}

const entries = JSON.parse(
  readFileSync(
    join(__dirname, '../../web/src/features/work/__fixtures__/desktop-sign-requests.json'),
    'utf8',
  ),
) as Entry[];

const golden = JSON.parse(
  readFileSync(join(__dirname, '../../../docs/api/work-instruction.golden.json'), 'utf8'),
) as {cases: {name: string; body: {humanSignature: Record<string, unknown>}}[]};

const context = (instanceId: string, serverTimeMs: number) => ({
  instanceId,
  serverTimeMs,
  maxLifetimeMs: 600_000,
  maxClockSkewMs: 300_000,
  humanControlSignatureRequired: true,
  hostRegisterSignatureRequired: false,
});

describe('phone ↔ desktop: one intent, one statement', () => {
  it('reads all five app requests', () => {
    expect(entries.map(e => e.name).sort()).toEqual(
      [
        'control_v2_input_interrupt',
        'control_v2_input_queue_nfc',
        'control_v2_permission_session',
        'control_v2_spawn',
        'control_v2_spawn_resume',
      ].sort(),
    );
  });

  it.each(entries.map(e => [e.name, e] as const))(
    '%s: the phone builds the bytes the desktop shell builds',
    (_name, e) => {
      const control: ControlToSign = {
        hostId: e.request.hostId,
        sessionId: e.request.sessionId,
        nonce: e.request.nonce,
        content: e.request.content,
      };
      const input = phoneSignInput(
        {workspaceId: e.signer.workspaceId, memberId: e.signer.memberId, deviceKeyId: e.signer.keyId},
        control,
        context(e.request.instanceId, e.request.issuedAtMs),
        0,
      );
      expect(input.schema).toBe('momo.human.control.v2');
      const bytes = humanControlPayload(
        input.schema,
        {
          instanceId: input.context.instanceId,
          workspaceId: input.workspaceId,
          memberId: input.memberId,
          deviceKeyId: input.deviceKeyId,
          hostId: input.hostId,
          sessionId: input.sessionId,
          nonce: input.nonce,
          issuedAtMs: e.request.issuedAtMs,
          expiresAtMs: e.request.expiresAtMs,
        },
        input.content,
      );
      expect(Buffer.from(bytes).toString('utf8')).toBe(e.payload);
    },
  );
});

describe('phoneSigner', () => {
  const e = entries.find(x => x.name === 'control_v2_input_queue_nfc')!;
  const control: ControlToSign = {
    hostId: e.request.hostId,
    sessionId: e.request.sessionId,
    nonce: e.request.nonce,
    content: e.request.content,
  };
  const identity = {workspaceId: 'w', memberId: 'm', deviceKeyId: 'k'};

  it('returns exactly the server’s envelope keys (no `schema`)', async () => {
    const sign = jest.fn(async () => ({
      schema: 'momo.human.control.v2' as const,
      deviceKeyId: 'k',
      nonce: control.nonce,
      issuedAtMs: 1,
      expiresAtMs: 2,
      signature: 'sig',
      mode: 'queue' as const,
    }));
    const signer = phoneSigner(identity, {
      context: async () => context('i', 1_790_550_000_000),
      sign,
      now: () => 1_790_550_000_000,
    });
    const envelope = await signer.sign(control);
    const keys = Object.keys(golden.cases.find(c => c.name === 'queue')!.body.humanSignature).sort();
    expect(Object.keys(envelope).sort()).toEqual(keys);
    expect(sign.mock.calls[0][0]).toMatchObject({schema: 'momo.human.control.v2', deviceKeyId: 'k'});
  });

  it.each([
    ['DEVICE_KEY_CANCELLED', true],
    ['DEVICE_KEY_LOCKED_OUT', false],
    ['DEVICE_KEY_INVALIDATED', false],
    ['DEVICE_KEY_BIOMETRY_UNAVAILABLE', false],
    ['DEVICE_KEY_ABSENT', false],
    ['DEVICE_KEY_FAILED', false],
  ] as const)('%s becomes a 해요체 sentence (cancelled=%s), never the code', async (code, cancelled) => {
    const signer = phoneSigner(identity, {
      context: async () => context('i', 0),
      sign: async () => {
        throw new DeviceKeyError(code, 'native words');
      },
      now: () => 0,
    });
    const error = (await signer.sign(control).catch((x: unknown) => x)) as SignerRefusal;
    expect(error).toBeInstanceOf(SignerRefusal);
    expect(error.cancelled).toBe(cancelled);
    expect(error.message).not.toContain('DEVICE_KEY');
    expect(error.message).toMatch(/요\.$/);
    expect(phoneSignerRefusal(new DeviceKeyError(code, 'x')).message).toBe(error.message);
  });
});
