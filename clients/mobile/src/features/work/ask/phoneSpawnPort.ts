import {
  fetchHumanControlSignatureRequired,
  listDeviceKeys,
  type DeviceKey,
} from '@momo/core/features/auth/deviceKeys';
import {
  spawnLabelText,
  spawnPromptText,
} from '@momo/core/features/auth/humanControlV4';
import {callFailureLine} from '@momo/core/features/auth/personalAgentCall';
import {
  newNonce,
  SignerRefusal,
  type HumanControlSigner,
} from '@momo/core/features/auth/signedControl';
import {ApiError, postWorkSpawn} from '@momo/core/lib/api';

import {
  deriveDeviceKeyView,
  readLocalDeviceKey,
  type LocalDeviceKey,
} from '../../../deviceKey/enrollment';
import {phoneSigner} from '../../../deviceKey/signer';
import {KEY_NOT_READY_DETAIL, UNKNOWN_FAILURE_SENTENCE} from './model';
import type {SpawnOutcome, SpawnPort, SpawnRequest} from './spawnPort';

// =============================================================================
// 진짜 spawn 포트 (#3638, #3597 T6b 후속 · ADR-0198 「T5 확정」 1 · 「P1 확정」 4).
//
// 시트와 폰 컴포저의 개인 에이전트 호출은 **같은 서명자**를 쓴다. 서명 바이트는 코어
// (`humanControlV4.ts`)가 한 번 만들고, 폰은 Face ID만 올린다(`deviceKey/signer.ts`).
// 이 파일이 하는 일은 셋이다.
//   1. 서명 키가 **지금** 승인된 키인지 보고(`approvedDeviceKeyId`),
//   2. 아니면 서명 전에 사람 말로 멈추고(`lazyPhoneSigner`), 서버가 서명 요구를 꺼 두었으면
//      Face ID를 올리기 전에 멈추고,
//   3. 서명한 문장을 `POST /work-spawns`로 보내 결과를 `SpawnOutcome`으로 돌려준다.
//
// 신원(워크스페이스·멤버·기기 키)은 부팅 때가 아니라 **보낼 때** 읽는다 — 포트는 로그인 전에
// 등록되고, 키는 보내는 순간에 승인 상태일 수 있다.
// =============================================================================

/** 서버가 서명 요구를 꺼 둔 것(403 `signed_spawn_disabled`) — Face ID 전에 알아낸 경우. */
export class FlagOffRefusal extends SignerRefusal {
  constructor() {
    super(callFailureLine(new ApiError(403, '', 'signed_spawn_disabled')));
    this.name = 'FlagOffRefusal';
  }
}

export interface PhoneSpawnDeps {
  readLocal: () => Promise<LocalDeviceKey>;
  listRows: (workspaceId: string) => Promise<DeviceKey[]>;
  /** 서버가 서명을 요구하는가. 모르면 `null`(서버가 정한다). */
  signatureRequired: (workspaceId: string) => Promise<boolean | null>;
  makeSigner: (identity: {
    workspaceId: string;
    memberId: string;
    deviceKeyId: string;
  }) => HumanControlSigner;
  post: typeof postWorkSpawn;
}

export const DEFAULT_PHONE_SPAWN_DEPS: PhoneSpawnDeps = {
  readLocal: readLocalDeviceKey,
  listRows: listDeviceKeys,
  signatureRequired: async workspaceId => {
    try {
      return await fetchHumanControlSignatureRequired(workspaceId);
    } catch {
      return null;
    }
  },
  makeSigner: identity => phoneSigner(identity),
  post: postWorkSpawn,
};

/** 지금 서명할 수 있는 이 폰의 키 행 id. 승인되지 않았거나 Face ID가 꺼져 있으면 `null`. */
export async function approvedDeviceKeyId(
  workspaceId: string,
  deps: Pick<PhoneSpawnDeps, 'readLocal' | 'listRows'>,
): Promise<string | null> {
  try {
    const local = await deps.readLocal();
    const rows =
      local.publicKey === null ? undefined : await deps.listRows(workspaceId);
    const view = deriveDeviceKeyView({
      local,
      localError: undefined,
      rows,
      rowsError: undefined,
    });
    return view.kind === 'approved' && !view.biometryOff ? view.row.id : null;
  } catch {
    return null;
  }
}

/**
 * 서명하는 순간에 신원을 읽는 서명자. 막히면 **아무것도 서명하지 않고** 사람 말을 던진다.
 *   - 서버가 서명 요구를 꺼 두었으면 `FlagOffRefusal`(Face ID 전),
 *   - 승인된 키가 없으면(시뮬레이터 포함) 「이 폰의 서명 키가 필요해요」.
 */
export function lazyPhoneSigner(
  identity: {workspaceId: string; memberId: string},
  deps: PhoneSpawnDeps = DEFAULT_PHONE_SPAWN_DEPS,
): HumanControlSigner {
  return {
    async sign(control) {
      if ((await deps.signatureRequired(identity.workspaceId)) === false) {
        throw new FlagOffRefusal();
      }
      const deviceKeyId = await approvedDeviceKeyId(identity.workspaceId, deps);
      if (deviceKeyId === null) throw new SignerRefusal(KEY_NOT_READY_DETAIL);
      return deps.makeSigner({...identity, deviceKeyId}).sign(control);
    },
  };
}

function outcomeFromError(error: unknown): SpawnOutcome {
  if (error instanceof FlagOffRefusal) return {kind: 'flag_off'};
  if (error instanceof SignerRefusal) {
    return error.cancelled
      ? {kind: 'cancelled', sentence: error.message}
      : {kind: 'refused', sentence: error.message};
  }
  if (error instanceof ApiError) {
    if (error.code === 'work_host_offline') return {kind: 'mac_off'};
    if (error.code === 'signed_spawn_disabled') return {kind: 'flag_off'};
  }
  const sentence = callFailureLine(error);
  return {kind: 'refused', sentence: sentence || UNKNOWN_FAILURE_SENTENCE};
}

/** 부팅에서 `registerSpawnPort`로 꽂는 포트. `wired`가 입구(FAB·AI 시트)를 연다. */
export function createPhoneSpawnPort(
  deps: PhoneSpawnDeps = DEFAULT_PHONE_SPAWN_DEPS,
): SpawnPort {
  return {
    wired: true,
    async spawn(request: SpawnRequest): Promise<SpawnOutcome> {
      try {
        // 서명과 몸이 **같은 글자**여야 한다: 코어가 서명할 NFC 본문과 제목을 먼저 확정한다.
        const prompt = spawnPromptText(request.prompt);
        const label = spawnLabelText(request.label);
        const humanSignature = await lazyPhoneSigner(
          {workspaceId: request.workspaceId, memberId: request.memberId},
          deps,
        ).sign({
          hostId: request.hostId,
          sessionId: null,
          nonce: newNonce(),
          content: {
            kind: 'spawn_task',
            agentMemberId: null,
            folderId: request.folderId,
            tool: request.tool,
            channelId: request.channelId,
            threadRootId: null,
            originMessageId: null,
            label,
            prompt,
          },
        });
        const result = await deps.post(request.workspaceId, {
          tool: request.tool,
          label,
          prompt,
          channelId: request.channelId,
          targetHostId: request.hostId,
          humanSignature,
        });
        return {
          kind: 'sent',
          controlId: result.workControl.id,
          replayed: result.replayed,
        };
      } catch (error) {
        return outcomeFromError(error);
      }
    },
  };
}
