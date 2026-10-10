jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
}));

import type {DeviceKey} from '@momo/core/features/auth/deviceKeys';
import {
  SignerRefusal,
  type ControlToSign,
  type HumanControlSigner,
} from '@momo/core/features/auth/signedControl';
import {ApiError, type HumanSignatureRequest} from '@momo/core/lib/api';

import {myToolsGateOpen} from '../src/features/ai/aiSheetModel';
import {
  approvedDeviceKeyId,
  createPhoneSpawnPort,
  FlagOffRefusal,
  lazyPhoneSigner,
  type PhoneSpawnDeps,
} from '../src/features/work/ask/phoneSpawnPort';
import {
  KEY_NOT_READY_DETAIL,
  ownMacs,
} from '../src/features/work/ask/model';
import {
  __resetSpawnPort,
  registerSpawnPort,
  spawnPort,
  type SpawnRequest,
} from '../src/features/work/ask/spawnPort';

// =============================================================================
// #3638 — 진짜 spawn 포트 (T6b 「내 맥에 물어보기」의 보내기).
//
// 가짜는 네 칸뿐이다: 키 저장소 읽기, 서버의 키 목록, 서명자(Face ID), `postWorkSpawn`.
// 몸을 만드는 코어(`spawnPromptText`·`spawnLabelText`)·결과 분류·문장은 진짜다.
//
// 단정이 각각 무엇을 잡는가 (RED PROOF — 제품 소스를 한 번 틀려서 붉어짐을 봤다)
//   ① 포트 등록 → 게이트 열림     `wired: true`를 `false`로 바꾸면 붉어진다.
//   ② 서명 내용                   `agentMemberId: null`·`originMessageId: null`·hostId 줄을 바꾸면 붉어진다.
//   ③ 서명이 몸으로 간다          `humanSignature`를 몸에서 빼거나 다른 서명을 넣으면 붉어진다.
//   ④ 실패 사유별 문장            `outcomeFromError`의 코드 분기를 지우면 붉어진다.
//   ⑤ 서명 전 막힘                키 없음·플래그 꺼짐에서 서명자를 부르면 붉어진다(서명자 호출 0).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const ME = '11111111-1111-4111-8111-111111111111';
const KEY_ROW = '00000000-0000-7000-8000-00000000d002';
const PUBLIC = 'A'.repeat(44);

function keyRow(over: Partial<DeviceKey> = {}): DeviceKey {
  return {
    id: KEY_ROW,
    workspaceId: WS,
    memberId: ME,
    alg: 'p256',
    publicKey: PUBLIC,
    platform: 'ios',
    label: 'iPhone',
    state: 'endorsed',
    canInstruct: true,
    current: true,
    lineageLive: true,
    createdAtMs: 1,
    ...over,
  } as DeviceKey;
}

const REQUEST: SpawnRequest = {
  workspaceId: WS,
  memberId: ME,
  hostId: 'mac-1',
  folderId: 'folder-q',
  tool: 'claude',
  channelId: 'ch-1',
  label: '로그인 버그 보기',
  prompt: '로그인 버그 보기\n재현 순서를 정리해 줘',
};

const SIGNATURE: HumanSignatureRequest = {
  deviceKeyId: KEY_ROW,
  nonce: 'n',
  issuedAtMs: 1,
  expiresAtMs: 2,
  signature: 'c2ln',
  folderId: 'folder-q',
};

interface Rig {
  deps: PhoneSpawnDeps;
  signed: ControlToSign[];
  posted: Array<{workspaceId: string; body: unknown}>;
  makeSigner: jest.Mock;
}

function rig(over: {
  local?: {status: string; publicKey: string | null};
  rows?: DeviceKey[];
  flag?: boolean | null;
  signError?: unknown;
  postError?: unknown;
} = {}): Rig {
  const signed: ControlToSign[] = [];
  const posted: Rig['posted'] = [];
  const signer: HumanControlSigner = {
    sign: async control => {
      signed.push(control);
      if (over.signError !== undefined) throw over.signError;
      return SIGNATURE;
    },
  };
  const makeSigner = jest.fn(() => signer);
  const deps: PhoneSpawnDeps = {
    readLocal: async () =>
      (over.local ?? {status: 'ready', publicKey: PUBLIC}) as never,
    listRows: async () => over.rows ?? [keyRow()],
    signatureRequired: async () => (over.flag === undefined ? true : over.flag),
    makeSigner,
    post: async (workspaceId, body) => {
      posted.push({workspaceId, body});
      if (over.postError !== undefined) throw over.postError;
      return {workControl: {id: 'ctl-1', status: 'pending'}, replayed: false};
    },
  };
  return {deps, signed, posted, makeSigner};
}

afterEach(() => __resetSpawnPort());

describe('부팅 등록 → 게이트', () => {
  it('포트를 꽂기 전에는 입구가 닫혀 있고, 꽂으면 열린다', () => {
    expect(myToolsGateOpen()).toBe(false);
    registerSpawnPort(createPhoneSpawnPort(rig().deps));
    expect(spawnPort().wired).toBe(true);
    expect(myToolsGateOpen()).toBe(true);
  });
});

describe('spawn — 서명 → /work-spawns', () => {
  it('하네스 새 작업(agent 없음·원본 메시지 없음)을 서명하고, 그 서명을 몸에 실어 보낸다', async () => {
    const r = rig();
    const outcome = await createPhoneSpawnPort(r.deps).spawn(REQUEST);
    expect(outcome).toEqual({kind: 'sent', controlId: 'ctl-1', replayed: false});
    expect(r.signed).toHaveLength(1);
    expect(r.signed[0]).toMatchObject({
      hostId: 'mac-1',
      sessionId: null,
      content: {
        kind: 'spawn_task',
        agentMemberId: null,
        folderId: 'folder-q',
        tool: 'claude',
        channelId: 'ch-1',
        threadRootId: null,
        originMessageId: null,
        label: '로그인 버그 보기',
        prompt: '로그인 버그 보기\n재현 순서를 정리해 줘',
      },
    });
    expect(r.makeSigner).toHaveBeenCalledWith({
      workspaceId: WS,
      memberId: ME,
      deviceKeyId: KEY_ROW,
    });
    expect(r.posted).toEqual([
      {
        workspaceId: WS,
        body: {
          tool: 'claude',
          label: '로그인 버그 보기',
          prompt: '로그인 버그 보기\n재현 순서를 정리해 줘',
          channelId: 'ch-1',
          targetHostId: 'mac-1',
          humanSignature: SIGNATURE,
        },
      },
    ]);
  });

  it('Face ID를 접으면 cancelled이고 아무것도 보내지 않는다', async () => {
    const r = rig({signError: new SignerRefusal('Face ID를 취소해서 보내지 않았어요.', true)});
    const outcome = await createPhoneSpawnPort(r.deps).spawn(REQUEST);
    expect(outcome).toEqual({kind: 'cancelled', sentence: 'Face ID를 취소해서 보내지 않았어요.'});
    expect(r.posted).toEqual([]);
  });

  it.each([
    ['work_host_offline', 409, {kind: 'mac_off'}],
    ['signed_spawn_disabled', 403, {kind: 'flag_off'}],
    [
      'spawn_folder_not_found',
      409,
      {kind: 'refused', sentence: '내 맥이 이 작업 폴더를 허용하고 있지 않아요. 맥 앱에서 폴더를 확인해 주세요.'},
    ],
    [
      'spawn_nonce_reused',
      409,
      {kind: 'refused', sentence: '보낸 호출과 서명이 맞지 않아 서버가 받지 않았어요. 다시 부르면 새로 서명해요.'},
    ],
    [
      'something_new',
      500,
      {kind: 'refused', sentence: '내 맥을 부르지 못했어요. 연결을 확인한 뒤 다시 불러 주세요.'},
    ],
  ])('서버가 %s로 거절하면 사유에 맞는 결과다', async (code, status, expected) => {
    const r = rig({postError: new ApiError(status, 'x', code)});
    expect(await createPhoneSpawnPort(r.deps).spawn(REQUEST)).toEqual(expected);
  });

  it('서명 키가 없으면 서명자를 부르지 않고 키 안내 문장으로 멈춘다', async () => {
    const r = rig({local: {status: 'unsupported', publicKey: null}});
    const outcome = await createPhoneSpawnPort(r.deps).spawn(REQUEST);
    expect(outcome).toEqual({kind: 'refused', sentence: KEY_NOT_READY_DETAIL});
    expect(r.makeSigner).not.toHaveBeenCalled();
    expect(r.signed).toEqual([]);
    expect(r.posted).toEqual([]);
  });

  it('서버가 서명 요구를 꺼 두었으면 Face ID를 올리기 전에 flag_off다', async () => {
    const r = rig({flag: false});
    expect(await createPhoneSpawnPort(r.deps).spawn(REQUEST)).toEqual({kind: 'flag_off'});
    expect(r.makeSigner).not.toHaveBeenCalled();
    expect(r.posted).toEqual([]);
  });

  it('서명할 수 없는 글(제어 문자)은 서명하지 않고 말로 거절한다', async () => {
    const r = rig();
    const outcome = await createPhoneSpawnPort(r.deps).spawn({
      ...REQUEST,
      prompt: '안녕​하세요',
    });
    expect(outcome.kind).toBe('refused');
    expect(r.signed).toEqual([]);
    expect(r.posted).toEqual([]);
  });
});

describe('승인된 키 판정', () => {
  it('승인된 행의 id만 돌려준다 — 대기·해지·Face ID 꺼짐은 null', async () => {
    const idOf = (r: Rig) => approvedDeviceKeyId(WS, r.deps);
    expect(await idOf(rig())).toBe(KEY_ROW);
    expect(await idOf(rig({rows: [keyRow({state: 'unendorsed', canInstruct: false})]}))).toBeNull();
    expect(await idOf(rig({rows: [keyRow({state: 'revoked'})]}))).toBeNull();
    expect(await idOf(rig({rows: []}))).toBeNull();
    expect(await idOf(rig({local: {status: 'biometryUnavailable', publicKey: PUBLIC}}))).toBeNull();
  });

  it('lazyPhoneSigner는 플래그 꺼짐을 FlagOffRefusal로 던진다', async () => {
    const signer = lazyPhoneSigner({workspaceId: WS, memberId: ME}, rig({flag: false}).deps);
    await expect(
      signer.sign({hostId: 'h', sessionId: null, nonce: 'n', content: {kind: 'input', mode: 'queue', text: 't'}}),
    ).rejects.toBeInstanceOf(FlagOffRefusal);
  });
});

describe('N5 — 폴더는 코어 타입에서 읽힌다', () => {
  it('ownMacs가 folders·defaultFolderId를 호스트 행에서 그대로 옮긴다', () => {
    const macs = ownMacs(
      [
        {
          id: 'mac-1',
          workspaceId: WS,
          scope: 'member',
          ownerMemberId: ME,
          type: 'workd',
          displayName: 'MacBook',
          capabilities: {},
          createdAtMs: 1,
          online: true,
          folders: [
            {id: 'f-q', displayName: '질문용 폴더', kind: 'question'},
            {id: 'f-p', displayName: 'momo', kind: 'project'},
          ],
          defaultFolderId: 'f-q',
        },
      ],
      ME,
    );
    expect(macs[0]).toMatchObject({
      defaultFolderId: 'f-q',
      folders: [
        {id: 'f-q', displayName: '질문용 폴더', kind: 'question'},
        {id: 'f-p', displayName: 'momo', kind: 'project'},
      ],
    });
  });
});
