import {
  fetchSigningContext,
  type SigningContext,
} from '@momo/core/features/auth/deviceKeys';
import {
  SignerRefusal,
  type ControlToSign,
  type HumanControlSigner,
} from '@momo/core/features/auth/signedControl';
import {humanSignatureRequestBody} from '@momo/core/lib/api';

import {
  HumanControlInputError,
  PHONE_SIGNING_SCHEMA,
  signHumanControl,
  type HumanControlContent,
  type SignHumanControlInput,
} from './humanControl';
import {DeviceKeyError} from './native';

// =============================================================================
// The phone as a `HumanControlSigner` (#3028 R2-E8; ADR-0146 개정 D-2 · D-5).
//
// The shared core flow (`@momo/core/features/auth/signedControl`) says WHAT is
// signed and where it goes; this file only turns one `ControlToSign` into the
// Face ID call (`signHumanControl`, control v2) and the enclave's refusals into
// 해요체 sentences. The desktop app's twin is
// `clients/web/src/features/work/signedWork.ts`; both are pinned to the same
// v2 vector bytes (cross test in `__tests__/phoneSigner.test.ts`).
// =============================================================================

export function phoneContent(content: ControlToSign['content']): HumanControlContent {
  switch (content.kind) {
    case 'input':
      return {kind: 'input', mode: content.mode, text: content.text};
    case 'permission':
      return {
        kind: 'permission',
        requestEventId: content.requestEventId,
        optionId: content.optionId,
        optionKind: content.optionKind,
        scope: content.scope,
      };
    case 'spawn':
      return {
        kind: 'spawn',
        agentMemberId: content.agentMemberId,
        folderId: content.folderId,
        tool: content.tool,
        channelId: content.channelId,
        firstPrompt: content.firstPrompt,
      };
  }
}

export interface PhoneSignerIdentity {
  workspaceId: string;
  memberId: string;
  /** This phone's `member_device_key` row id (the approved one). */
  deviceKeyId: string;
}

/** The exact `signHumanControl` input for one statement. Pure. */
export function phoneSignInput(
  identity: PhoneSignerIdentity,
  control: ControlToSign,
  context: SigningContext,
  contextReadAtMs: number,
): SignHumanControlInput {
  return {
    schema: PHONE_SIGNING_SCHEMA,
    context,
    contextReadAtMs,
    workspaceId: identity.workspaceId,
    memberId: identity.memberId,
    deviceKeyId: identity.deviceKeyId,
    hostId: control.hostId,
    sessionId: control.sessionId,
    nonce: control.nonce,
    content: phoneContent(control.content),
  };
}

/** The enclave's and the builder's refusals, as the sentence the card shows. */
export function phoneSignerRefusal(error: unknown): SignerRefusal {
  if (error instanceof SignerRefusal) return error;
  if (error instanceof HumanControlInputError) {
    return new SignerRefusal(
      '보이지 않는 문자나 올바르지 않은 값이 있어 서명하지 않았어요. 내용을 고친 뒤 다시 보내 주세요.',
    );
  }
  const code = error instanceof DeviceKeyError ? error.code : null;
  switch (code) {
    case 'DEVICE_KEY_CANCELLED':
      return new SignerRefusal('Face ID를 취소해서 보내지 않았어요.', true);
    case 'DEVICE_KEY_LOCKED_OUT':
      return new SignerRefusal(
        'Face ID가 잠겨 보내지 않았어요. 기기 암호로 잠금을 푼 뒤 다시 보내 주세요.',
      );
    case 'DEVICE_KEY_BIOMETRY_UNAVAILABLE':
      return new SignerRefusal(
        'Face ID를 쓸 수 없어 보내지 않았어요. 설정에서 oort의 Face ID를 켠 뒤 다시 보내 주세요.',
      );
    case 'DEVICE_KEY_INVALIDATED':
      return new SignerRefusal(
        'Face ID 등록이 바뀌어 이 폰의 서명 키를 더 쓸 수 없어요. 프로필 › 지시 기기에서 새 키로 등록해 주세요.',
      );
    case 'DEVICE_KEY_ABSENT':
      return new SignerRefusal(
        '이 폰에 지시 서명 키가 없어요. 프로필 › 지시 기기에서 등록해 주세요.',
      );
    case 'DEVICE_KEY_UNSUPPORTED':
    case 'DEVICE_KEY_NOT_LINKED':
    case 'DEVICE_KEY_MISCONFIGURED':
      return new SignerRefusal('이 빌드에서는 지시에 서명할 수 없어요.');
    default:
      return new SignerRefusal('기기 서명을 하지 못해 보내지 않았어요. 다시 보내 주세요.');
  }
}

export interface PhoneSignerDeps {
  context: (workspaceId: string) => Promise<SigningContext>;
  sign: typeof signHumanControl;
  now: () => number;
}

const DEFAULT_DEPS: PhoneSignerDeps = {
  context: fetchSigningContext,
  sign: signHumanControl,
  now: () => Date.now(),
};

/**
 * Reads the signing context fresh for every statement (its instance id is
 * echoed verbatim, its clock corrects the phone's, D-5 · D-9), then Face ID.
 */
export function phoneSigner(
  identity: PhoneSignerIdentity,
  deps: PhoneSignerDeps = DEFAULT_DEPS,
): HumanControlSigner {
  return {
    async sign(control) {
      const before = deps.now();
      const context = await deps.context(identity.workspaceId);
      const readAt = Math.round((before + deps.now()) / 2);
      try {
        const signed = await deps.sign({
          ...phoneSignInput(identity, control, context, readAt),
          now: deps.now,
        });
        // `schema` is the phone's own record; the server's body has no such key.
        return humanSignatureRequestBody(signed);
      } catch (error) {
        throw phoneSignerRefusal(error);
      }
    },
  };
}
