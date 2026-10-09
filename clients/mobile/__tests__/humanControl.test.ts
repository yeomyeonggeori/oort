import {createPublicKey, verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {base64ToBytes, bytesToBase64} from '../src/deviceKey/base64';
import {hex, sha256} from '../src/deviceKey/sha256';

// =============================================================================
// #3026 stage 2 — the phone's signing call path builds the exact E1 bytes.
//
// Every `momo.human.control.v2` and `v3` case of the shared vectors (#3027,
// #3118) is rebuilt
// here from its INPUTS (schema, fields, content) and compared byte for byte
// with the payload Rust, Swift and WebCrypto agreed on — and the vector's own
// signatures are verified over the bytes this file built, so "equal" cannot be
// two copies of the same mistake. Then the call path: the schema is an argument
// (E7 #3027 is minting v2) and an unknown one is refused before Face ID.
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

// native.ts reads the module once at import; the proxy forwards to whatever
// double the current test installed.
jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (name: string) =>
    name === 'MomoDeviceKeyNative'
      ? new Proxy(
          {},
          {get: (_target, prop) => (mockNative as Record<string | symbol, unknown> | null)?.[prop]},
        )
      : null,
}));

import {
  PHONE_SIGNING_SCHEMA,
  phoneSigningSchema,
  HUMAN_CONTROL_SCHEMAS,
  humanControlContentBytes,
  HumanControlInputError,
  humanControlPayload,
  SIGN_REASONS,
  signHumanControl,
  type HumanControlContent,
  type HumanControlFields,
} from '../src/deviceKey/humanControl';

interface VectorCase {
  name: string;
  schema: string;
  fields: Record<string, string | number | null>;
  content: Record<string, unknown>;
  content_sha256: string;
  payload: string;
  signatures: {public_key: string; signature: string}[] | Record<string, unknown>;
}

const vectors = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures/human-control-signing.vectors.json'),
    'utf8',
  ),
) as {cases: VectorCase[]};

const PHONE_KINDS = new Set(['input', 'spawn', 'permission']);
const controlCases = vectors.cases.filter(
  c => c.schema === 'momo.human.control.v1' && PHONE_KINDS.has(String(c.content.kind)),
);
// #3096: v1 is retired on the phone — `controlCases` (the #3021 v1 vectors) now
// only prove that a v1 statement is refused, and give free-text samples.

// #3028: the E7 v2 vectors (docs/api, #3027), read in place.
const vectorsV2 = JSON.parse(
  readFileSync(
    join(__dirname, '../../../docs/api/human-control-signing-v2.vectors.json'),
    'utf8',
  ),
) as {cases: VectorCase[]};
const v2Cases = vectorsV2.cases.filter(
  c => c.schema === 'momo.human.control.v2' && PHONE_KINDS.has(String(c.content.kind)),
);

// #3128: the #3118 v3 vectors, read in place.
const vectorsV3 = JSON.parse(
  readFileSync(
    join(__dirname, '../../../docs/api/human-control-signing-v3.vectors.json'),
    'utf8',
  ),
) as {cases: VectorCase[]};
const v3Cases = vectorsV3.cases.filter(
  c => c.schema === 'momo.human.control.v3' && PHONE_KINDS.has(String(c.content.kind)),
);

function toFields(c: VectorCase): HumanControlFields {
  const f = c.fields;
  return {
    instanceId: String(f.instance_id),
    workspaceId: String(f.workspace_id),
    memberId: String(f.member_id),
    deviceKeyId: String(f.device_key_id),
    hostId: String(f.host_id),
    sessionId: f.session_id === null ? null : String(f.session_id),
    nonce: String(f.nonce),
    issuedAtMs: Number(f.issued_at_ms),
    expiresAtMs: Number(f.expires_at_ms),
  };
}

function toContent(c: VectorCase): HumanControlContent {
  const x = c.content as Record<string, string>;
  switch (x.kind) {
    case 'input':
      return {kind: 'input', mode: x.mode as 'queue' | 'interrupt', text: x.text};
    case 'spawn':
      return {
        kind: 'spawn',
        agentMemberId: x.agent_member_id,
        folderId: x.folder_id,
        ...(x.tool !== undefined ? {tool: x.tool, channelId: x.channel_id} : {}),
        firstPrompt: x.first_prompt,
      };
    case 'permission':
      return {
        kind: 'permission',
        requestEventId: x.request_event_id,
        optionId: x.option_id,
        optionKind: x.option_kind,
        scope: x.scope as 'once' | 'session',
        ...(x.preview_sha256 !== undefined ? {previewSha256: x.preview_sha256} : {}),
      };
    default:
      throw new Error(`not a phone kind: ${x.kind}`);
  }
}

/** Every signature the vector file carries for a case, flattened. */
function signaturesOf(c: VectorCase): {publicKey: string; signature: string}[] {
  const out: {publicKey: string; signature: string}[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (typeof v.public_key === 'string' && typeof v.signature === 'string') {
        out.push({publicKey: v.public_key, signature: v.signature});
      } else Object.values(v).forEach(visit);
    }
  };
  visit(c.signatures);
  return out;
}

function p256Verify(publicKeyB64: string, payload: Uint8Array, sigB64: string): boolean {
  const compressed = base64ToBytes(publicKeyB64)!;
  // SPKI for a compressed P-256 point: fixed prefix + 33 bytes.
  const spki = Buffer.concat([
    Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'),
    Buffer.from(compressed),
  ]);
  const key = createPublicKey({key: spki, format: 'der', type: 'spki'});
  return verify(
    'sha256',
    payload,
    {key, dsaEncoding: 'ieee-p1363'},
    Buffer.from(base64ToBytes(sigB64)!),
  );
}

describe('momo.human.control.v1 — retired on the phone (#3096)', () => {
  it('covers every phone kind in the vector file', () => {
    expect(new Set(controlCases.map(c => c.content.kind))).toEqual(PHONE_KINDS);
  });

  it.each(controlCases.map(c => [c.name, c] as const))(
    '%s: no v1 recipe — nothing is hashed, nothing reaches Face ID',
    (_name, c) => {
      expect(() =>
        humanControlContentBytes(c.schema, toContent(c)),
      ).toThrow(HumanControlInputError);
      expect(() =>
        humanControlPayload(c.schema, toFields(c), toContent(c)),
      ).toThrow(/no recipe for schema momo\.human\.control\.v1/);
    },
  );

  it('NFC-normalises free text (the vector text is decomposed on purpose)', () => {
    const c = controlCases.find(x => x.name === 'control_input_queue_nfc')!;
    const text = String(c.content.text);
    expect(text.normalize('NFC')).not.toBe(text);
  });

  it('refuses a field that would move the lines', () => {
    const c = v2Cases.find(x => x.content.kind === 'input')!;
    const fields = {...toFields(c), hostId: 'host\nforged'};
    expect(() => humanControlPayload(c.schema, fields, toContent(c))).toThrow(
      HumanControlInputError,
    );
    expect(() =>
      humanControlPayload(c.schema, {...toFields(c), nonce: ''}, toContent(c)),
    ).toThrow(HumanControlInputError);
    expect(() =>
      humanControlPayload(
        c.schema,
        {...toFields(c), expiresAtMs: toFields(c).issuedAtMs},
        toContent(c),
      ),
    ).toThrow(HumanControlInputError);
  });

  it('knows v2, v3 and v4 only, and refuses a schema it has no recipe for', () => {
    expect(HUMAN_CONTROL_SCHEMAS).toEqual([
      'momo.human.control.v2',
      'momo.human.control.v3',
      'momo.human.control.v4',
    ]);
    const c = v2Cases.find(x => x.content.kind === 'input')!;
    expect(() =>
      humanControlPayload('momo.human.control.v4', toFields(c), toContent(c)),
    ).toThrow(HumanControlInputError);
  });

});

describe('momo.human.control.v2 bytes — rebuilt from the E7 vectors (#3028)', () => {
  it('covers input, spawn (new and resume) and permission', () => {
    expect(v2Cases.map(c => c.name).sort()).toEqual(
      [
        'control_v2_input_interrupt',
        'control_v2_input_queue_nfc',
        'control_v2_permission_session',
        'control_v2_spawn',
        'control_v2_spawn_resume',
      ].sort(),
    );
    expect(PHONE_SIGNING_SCHEMA).toBe('momo.human.control.v2');
  });

  it.each(v2Cases.map(c => [c.name, c] as const))(
    '%s: bytes match and every signer’s signature verifies over them',
    (_name, c) => {
      const content = toContent(c);
      expect(hex(sha256(humanControlContentBytes(c.schema, content)))).toBe(
        c.content_sha256,
      );
      const payload = humanControlPayload(c.schema, toFields(c), content);
      expect(Buffer.from(payload).toString('utf8')).toBe(c.payload);
      const signatures = signaturesOf(c);
      expect(signatures.length).toBeGreaterThanOrEqual(3);
      for (const s of signatures) {
        expect(p256Verify(s.publicKey, payload, s.signature)).toBe(true);
      }
    },
  );

  it('a v2 spawn binds tool and channel: without them nothing is built', () => {
    const c = v2Cases.find(x => x.name === 'control_v2_spawn')!;
    const content = toContent(c) as Extract<HumanControlContent, {kind: 'spawn'}>;
    expect(() =>
      humanControlPayload(c.schema, toFields(c), {...content, tool: undefined}),
    ).toThrow(HumanControlInputError);
    const other = humanControlPayload(c.schema, toFields(c), {
      ...content,
      channelId: '00000000-0000-7000-8000-00000000cc02',
    });
    expect(Buffer.from(other).toString('utf8')).not.toBe(c.payload);
  });
});

describe('momo.human.control.v3 bytes — rebuilt from the #3118 vectors (#3128)', () => {
  it('covers input, spawn (new and resume) and two previewed permissions', () => {
    expect(v3Cases.map(c => c.name).sort()).toEqual(
      [
        'control_v3_input_queue_nfc',
        'control_v3_permission_once',
        'control_v3_permission_session',
        'control_v3_spawn',
        'control_v3_spawn_resume',
      ].sort(),
    );
    // An allow is signed as v3; input and spawn stay v2 (both accepted).
    expect(phoneSigningSchema('permission')).toBe('momo.human.control.v3');
    expect(phoneSigningSchema('input')).toBe('momo.human.control.v2');
    expect(phoneSigningSchema('spawn')).toBe('momo.human.control.v2');
  });

  it.each(v3Cases.map(c => [c.name, c] as const))(
    '%s: bytes match and every signer’s signature verifies over them',
    (_name, c) => {
      const content = toContent(c);
      expect(hex(sha256(humanControlContentBytes(c.schema, content)))).toBe(
        c.content_sha256,
      );
      const payload = humanControlPayload(c.schema, toFields(c), content);
      expect(Buffer.from(payload).toString('utf8')).toBe(c.payload);
      const signatures = signaturesOf(c);
      expect(signatures.length).toBeGreaterThanOrEqual(3);
      for (const s of signatures) {
        expect(p256Verify(s.publicKey, payload, s.signature)).toBe(true);
      }
    },
  );

  it('the preview line is v3’s alone: missing under v3, refused under v2', () => {
    const c = v3Cases.find(x => x.name === 'control_v3_permission_once')!;
    const content = toContent(c) as Extract<HumanControlContent, {kind: 'permission'}>;
    expect(() =>
      humanControlPayload(c.schema, toFields(c), {...content, previewSha256: undefined}),
    ).toThrow(/preview hash/);
    expect(() =>
      humanControlPayload(c.schema, toFields(c), {
        ...content,
        previewSha256: content.previewSha256!.toUpperCase(),
      }),
    ).toThrow(/preview hash/);
    expect(() =>
      humanControlPayload('momo.human.control.v2', toFields(c), content),
    ).toThrow(/only as v3/);
    // Another preview's hash is other bytes: the recorded signatures fail.
    const swapped = humanControlPayload(c.schema, toFields(c), {
      ...content,
      previewSha256: 'a'.repeat(64),
    });
    for (const s of signaturesOf(c)) {
      expect(p256Verify(s.publicKey, swapped, s.signature)).toBe(false);
    }
  });
});

describe('signHumanControl — the call path', () => {
  const CONTEXT = {
    instanceId: 'inst_01J9Z6T3QK8Y2W5N7M4R0P1XAB',
    serverTimeMs: 1_790_550_000_000,
    maxLifetimeMs: 600_000,
    maxClockSkewMs: 300_000,
    humanControlSignatureRequired: true,
    hostRegisterSignatureRequired: false,
  };
  const RAW_SIG = bytesToBase64(new Uint8Array(64).fill(9));

  beforeEach(() => {
    mockNative = {
      secureEnclaveAvailable: true,
      status: jest.fn(async () => 'ready'),
      create: jest.fn(),
      publicKey: jest.fn(),
      sign: jest.fn(async () => RAW_SIG),
      remove: jest.fn(),
    };
  });

  it('signs the vector bytes with the server clock, a Face ID reason, and returns the route body', async () => {
    const c = v2Cases.find(x => x.name === 'control_v2_input_queue_nfc')!;
    const f = toFields(c);
    // The phone's clock runs 90 s behind the server; it read the context 5 s ago.
    const readAt = CONTEXT.serverTimeMs - 90_000 - 5_000;
    const localNow = readAt + 5_000;
    const result = await signHumanControl({
      schema: 'momo.human.control.v2',
      context: {...CONTEXT, serverTimeMs: f.issuedAtMs},
      contextReadAtMs: readAt,
      now: () => localNow,
      lifetimeMs: f.expiresAtMs - f.issuedAtMs + 60_000_000,
      workspaceId: f.workspaceId,
      memberId: f.memberId,
      deviceKeyId: f.deviceKeyId,
      hostId: f.hostId,
      sessionId: f.sessionId,
      nonce: f.nonce,
      content: toContent(c),
    });
    // issued = server time at read + 5 s elapsed; lifetime capped at 10 min.
    expect(result.issuedAtMs).toBe(f.issuedAtMs + 5_000);
    expect(result.expiresAtMs).toBe(result.issuedAtMs + 600_000);
    const [messageB64, reason] = mockNative!.sign.mock.calls[0];
    const signed = Buffer.from(base64ToBytes(messageB64)!).toString('utf8');
    const expected = humanControlPayload(
      'momo.human.control.v2',
      {...f, issuedAtMs: result.issuedAtMs, expiresAtMs: result.expiresAtMs},
      toContent(c),
    );
    expect(signed).toBe(Buffer.from(expected).toString('utf8'));
    expect(signed.split('\n')[1]).toBe(CONTEXT.instanceId);
    expect(reason).toBe(SIGN_REASONS.input);
    expect(result).toEqual({
      schema: 'momo.human.control.v2',
      deviceKeyId: f.deviceKeyId,
      nonce: f.nonce,
      issuedAtMs: result.issuedAtMs,
      expiresAtMs: result.expiresAtMs,
      signature: RAW_SIG,
      mode: 'queue',
    });
  });

  it('carries spawn and permission fields the route needs', async () => {
    const spawn = v2Cases.find(x => x.content.kind === 'spawn')!;
    const base = {
      schema: 'momo.human.control.v2',
      context: CONTEXT,
      contextReadAtMs: 0,
      now: () => 0,
      workspaceId: 'w',
      memberId: 'm',
      deviceKeyId: 'k',
      hostId: 'h',
      nonce: 'n',
    };
    const s = await signHumanControl({...base, sessionId: null, content: toContent(spawn)});
    expect(s.agentMemberId).toBe(spawn.content.agent_member_id);
    expect(s.folderId).toBe(spawn.content.folder_id);
    expect(mockNative!.sign.mock.calls[0][1]).toBe(SIGN_REASONS.spawn);
    const permission = v2Cases.find(x => x.content.kind === 'permission')!;
    const p = await signHumanControl({...base, sessionId: 's', content: toContent(permission)});
    expect(p.scope).toBe('session');
    expect(p.mode).toBeUndefined();
  });

  it.each(['momo.human.control.v4', 'momo.human.control.v1'])(
    'refuses %s before Face ID is raised',
    async schema => {
      const c = v2Cases.find(x => x.content.kind === 'input')!;
      await expect(
        signHumanControl({
          schema,
          context: CONTEXT,
          contextReadAtMs: 0,
          workspaceId: 'w',
          memberId: 'm',
          deviceKeyId: 'k',
          hostId: 'h',
          sessionId: 's',
          nonce: 'n',
          content: toContent(c),
        }),
      ).rejects.toBeInstanceOf(HumanControlInputError);
      expect(mockNative!.sign).not.toHaveBeenCalled();
    },
  );

  it('asks Face ID in 해요체', () => {
    for (const reason of Object.values(SIGN_REASONS)) {
      expect(reason).toMatch(/요$/);
    }
  });
});

// =============================================================================
// #3592 (P1) — `momo.human.control.v4`, the new-work spawn. Every case of the
// shared v4 vectors is rebuilt from its inputs; the recipe is the core's, so
// this also proves the phone's own sha256/utf8 agree with the core's.
// =============================================================================

interface V4Case {
  name: string;
  schema: string;
  fields: Record<string, string | number | null>;
  content: Record<string, string | null>;
  content_sha256: string;
  payload: string;
}

const vectorsV4 = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/human-control-signing-v4.vectors.json'), 'utf8'),
) as {cases: V4Case[]};

function v4Content(c: V4Case): HumanControlContent {
  const x = c.content;
  return {
    kind: 'spawn_task',
    agentMemberId: x.agent_member_id,
    folderId: x.folder_id as string,
    tool: x.tool as string,
    channelId: x.channel_id as string,
    threadRootId: x.thread_root_id,
    originMessageId: x.origin_message_id,
    label: x.label as string,
    prompt: x.prompt as string,
  };
}

function v4Fields(c: V4Case): HumanControlFields {
  return toFields(c as unknown as VectorCase);
}

describe('momo.human.control.v4 — the new-work spawn (#3592)', () => {
  it('has the four shared cases and the fixture equals docs/api', () => {
    expect(vectorsV4.cases).toHaveLength(4);
    expect(
      readFileSync(join(__dirname, 'fixtures/human-control-signing-v4.vectors.json'), 'utf8'),
    ).toBe(
      readFileSync(
        join(__dirname, '../../../docs/api/human-control-signing-v4.vectors.json'),
        'utf8',
      ),
    );
  });

  it.each(vectorsV4.cases.map(c => [c.name, c] as const))(
    '%s: the phone rebuilds the payload byte for byte',
    (_name, c) => {
      expect(HUMAN_CONTROL_SCHEMAS).toContain(c.schema);
      expect(phoneSigningSchema('spawn_task')).toBe(c.schema);
      const bytes = humanControlPayload(c.schema, v4Fields(c), v4Content(c));
      expect(Buffer.from(bytes).toString('utf8')).toBe(c.payload);
      expect(hex(sha256(humanControlContentBytes(c.schema, v4Content(c))))).toBe(
        c.content_sha256,
      );
    },
  );

  it('v4 is the new-work spawn only, in both directions', () => {
    const c = vectorsV4.cases[0]!;
    const input = v2Cases.find(x => x.content.kind === 'input')!;
    expect(() => humanControlPayload('momo.human.control.v4', toFields(input), toContent(input))).toThrow(
      HumanControlInputError,
    );
    for (const schema of ['momo.human.control.v2', 'momo.human.control.v3']) {
      expect(() => humanControlPayload(schema, v4Fields(c), v4Content(c))).toThrow(HumanControlInputError);
      expect(() => humanControlContentBytes(schema, v4Content(c))).toThrow(HumanControlInputError);
    }
  });

  it('refuses an empty id, a control character and a bad window before Face ID', () => {
    const c = vectorsV4.cases[0]!;
    const content = v4Content(c) as HumanControlContent & {kind: 'spawn_task'};
    for (const bad of [
      {...content, folderId: ''},
      {...content, tool: 'cl\naude'},
      {...content, label: 'a\nb'},
      {...content, prompt: '/clear'},
    ]) {
      expect(() => humanControlPayload(c.schema, v4Fields(c), bad)).toThrow(HumanControlInputError);
    }
    expect(() =>
      humanControlPayload(c.schema, {...v4Fields(c), expiresAtMs: v4Fields(c).issuedAtMs}, content),
    ).toThrow(HumanControlInputError);
  });

  it('signs a spawn_task as v4 with the agent only when one was named', async () => {
    mockNative = {
      secureEnclaveAvailable: true,
      status: jest.fn(),
      create: jest.fn(),
      publicKey: jest.fn(),
      sign: jest.fn(async () => bytesToBase64(new Uint8Array(64).fill(9))),
      remove: jest.fn(),
    };
    const run = async (c: V4Case) =>
      signHumanControl({
        schema: c.schema,
        context: {instanceId: String(c.fields.instance_id), serverTimeMs: 1, maxLifetimeMs: 600_000} as never,
        contextReadAtMs: 1,
        workspaceId: String(c.fields.workspace_id),
        memberId: String(c.fields.member_id),
        deviceKeyId: String(c.fields.device_key_id),
        hostId: String(c.fields.host_id),
        sessionId: null,
        nonce: String(c.fields.nonce),
        content: v4Content(c),
        now: () => 1,
      });
    const withAgent = await run(vectorsV4.cases[0]!);
    expect(withAgent).toMatchObject({
      schema: 'momo.human.control.v4',
      agentMemberId: vectorsV4.cases[0]!.content.agent_member_id,
      folderId: 'fld_0123456789abcdef0123',
    });
    const bare = await run(vectorsV4.cases[2]!);
    expect(bare.agentMemberId).toBeUndefined();
    expect(bare.folderId).toBe('fld_aaaaaaaaaaaaaaaaaaaa');
    expect(SIGN_REASONS.spawn_task).toMatch(/요$/);
  });
});
