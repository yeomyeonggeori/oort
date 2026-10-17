import {
  ACCESSIBLE,
  getGenericPassword,
  resetGenericPassword,
  setGenericPassword,
} from 'react-native-keychain';

import {appOnlyGroupFrom} from '../storage/keychainGroups';
import {PUSH_ACTION_KEYCHAIN_SERVICE, PUSH_ACTION_SESSION_ACCOUNT} from './contract';
import {keychainAccessGroup} from './native';
import type {MintedPushActionToken} from './pushActionToken';

// =============================================================================
// 앱 → 잠금 화면 처리기로 넘기는 자격 (#3931, ADR-0204 D6).
//
// 이 파일은 `pushFetchSession.ts` 의 짝이지만 **반대편에 놓는다.** 그쪽은 알림 확장이 읽을
// 공유 그룹(`app.momo.ios.shared`)에 푸시 본문을 읽는 토큰을 둔다. 이쪽은 승인을
// **결정하는** 토큰이다. 확장이 읽을 수 있는 곳에는 한 줄도 두지 않는다 — 앱 전용 그룹
// (`app.momo.ios.devicekey`, 앱의 entitlement 에만 있다)에만 쓴다. 그 그룹이 무엇인지는
// 빌드가 Info.plist 로 알려 주고(`MomoDeviceKeyAccessGroup`), JS 는 공유 그룹에서 같은
// 팀 접두를 빌려 도출한다(`appOnlyGroupFrom`).
//
// ## 그룹을 못 정하면 쓰지 않는다
//
// 그룹 없이 쓴 항목은 앱의 **첫 번째** keychain-access-group 으로 들어가고, 그 첫 번째가
// 공유 그룹이다(entitlements 의 순서가 그렇다 — `secureSession.ts` 머리말). 그러니
// 그룹이 풀리지 않는 빌드(시뮬레이터에서 plist 키가 없을 때, Jest)에서 「일단 쓴다」는
// 이 자격을 정확히 확장이 읽는 곳에 놓는 일이다. 그때는 쓰지 않고 `no-access-group` 을
// 돌려준다. 읽기와 지우기도 같은 이유로 그룹이 풀릴 때만 한다.
//
// ## 읽는 쪽
//
// Swift(`MomoPushActionCore.swift` 의 `MomoPushActionSession.Wire`)가 이 JSON 을 읽는다.
// 키 이름이 계약이다 — 대소문자까지, `pushContract.test.ts` 가 Swift 소스를 읽어 맞춰
// 본다. `memberID`·`ttlSeconds` 는 이쪽의 장부(누구 것인가, 수명이 얼마인가)이고 Swift 는
// 무시한다.
// =============================================================================

/** Swift `MomoPushActionSession.Wire` 의 키 — 이 이름들이 계약이다. */
interface PushActionSessionPayload {
  baseURL: string;
  workspaceID: string;
  memberID: string;
  actionToken: string;
  expiresAtMs: number;
  ttlSeconds: number;
}

export type PushActionSessionOutcome =
  | {kind: 'published'; accessGroup: string}
  /** 이 빌드가 앱 전용 그룹을 말하지 못한다. 그룹 없이 쓰면 공유 그룹으로 가므로 쓰지 않았다. */
  | {kind: 'no-access-group'}
  | {kind: 'failed'; reason: string};

export interface PushActionSessionInput {
  /** 처리기가 요청을 보낼 절대 origin. */
  baseUrl: string;
  workspaceId: string;
  /** 이 토큰을 받은 멤버. 로그아웃 없이 다른 사람이 들어온 폰에서 앞 사람의 자격을 쓰지 않으려는 장부다. */
  memberId: string;
  token: string;
  expiresAtMs: number;
  ttlSeconds: number;
}

function appOnlyGroup(): string | null {
  return appOnlyGroupFrom(keychainAccessGroup());
}

/**
 * 이 빌드가 앱 전용 그룹을 말할 수 있는가. 못 하면 놓을 곳이 없으니 **받지도 않는다**: 서버는
 * 세션 계열당 살아 있는 이 토큰을 4개까지만 내주므로(초과 429), 놓지 못할 토큰으로 칸을
 * 태울 이유가 없다 (#3931 보안 검수).
 */
export function pushActionSessionAvailable(): boolean {
  return appOnlyGroup() !== null;
}

/** 토큰이 만료되기 전에 다시 불러야 한다(`pushFetchKeeper.ts` 가 때를 정한다). */
export async function publishPushActionSession(
  input: PushActionSessionInput,
): Promise<PushActionSessionOutcome> {
  const accessGroup = appOnlyGroup();
  if (!accessGroup) {
    return {kind: 'no-access-group'};
  }
  const payload: PushActionSessionPayload = {
    baseURL: input.baseUrl,
    workspaceID: input.workspaceId,
    memberID: input.memberId,
    actionToken: input.token,
    expiresAtMs: input.expiresAtMs,
    ttlSeconds: input.ttlSeconds,
  };
  try {
    await setGenericPassword(PUSH_ACTION_SESSION_ACCOUNT, JSON.stringify(payload), {
      service: PUSH_ACTION_KEYCHAIN_SERVICE,
      accessGroup,
      accessible: ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    return {kind: 'published', accessGroup};
  } catch (cause) {
    return {kind: 'failed', reason: cause instanceof Error ? cause.message : String(cause)};
  }
}

/**
 * 폰에서 이 자격을 지운다 — 로그아웃, 이 폰의 푸시를 끈 것, OS 가 알림을 막은 것.
 *
 * 서버의 토큰은 세션이 끝날 때 함께 죽지만(ADR-0204 D6) 그 사이 폰에 남은 사본이
 * 승인을 결정할 수 있다.
 *
 * 처리기가 만드는 기기 비밀은 이 서비스 아래에 **없다.** react-native-keychain 의
 * `setGenericPassword`/`resetGenericPassword` 는 계정이 아니라 서비스 단위로 지우므로(그룹
 * 안의 그 서비스 항목 전부) 같은 서비스에 두면 토큰을 새로 놓을 때마다 비밀이 사라지고,
 * 잠금 화면에 떠 있는 알림의 멱등 키가 그 밑에서 바뀐다. 비밀은 자기 서비스에 있고(Swift
 * `deviceSecretService`), 아무도 가리키지 않는 무작위 값이라 로그아웃에도 남는다.
 */
export async function clearPushActionSession(): Promise<void> {
  const accessGroup = appOnlyGroup();
  if (!accessGroup) {
    // 쓴 적이 없다. 그룹 없이 지우면 첫 그룹(공유)을 건드리는데, 그 서비스 이름의 항목은
    // 어디에도 없으니 지울 것도 없다.
    return;
  }
  try {
    await resetGenericPassword({service: PUSH_ACTION_KEYCHAIN_SERVICE, accessGroup});
  } catch {
    // 로그아웃은 키체인이 막지 못한다. 이 토큰은 서버가 같은 흐름에서 회수한다.
  }
}

export interface PushActionRestoreExpectation {
  baseUrl: string;
  workspaceId: string;
  memberId: string;
}

/**
 * 지난 실행이 폰에 놔 둔 자격이 **지금 이 사람의 것이고 아직 살아 있으면** 그것을 돌려준다.
 *
 * 이게 없으면 `pushFetchKeeper` 는 실행마다 「받은 토큰 없음」으로 시작해 매번 새로 받는다.
 * 서버는 세션 계열당 살아 있는 이 토큰을 4개까지만 내주므로(초과 429) 6시간 안에 앱을 다섯 번
 * 다시 켜면 자격이 끊긴다. 남은 수명이 절반 위인 토큰을 이어 쓰면 그 상한에 닿지 않는다.
 *
 * 다른 멤버의 것이거나 다른 서버의 것이면 **그 자리에서 지운다**: 로그아웃을 거치지 않고
 * 사람이 바뀐 폰에서(앱이 죽은 채 세션이 끝난 경우) 앞 사람의 자격이 새 사람의 알림을
 * 결정하게 두지 않는다.
 */
export async function restorePushActionSession(
  expected: PushActionRestoreExpectation,
  now: () => number = Date.now,
): Promise<MintedPushActionToken | null> {
  const accessGroup = appOnlyGroup();
  if (!accessGroup) {
    return null;
  }
  let stored: Partial<PushActionSessionPayload>;
  try {
    const item = await getGenericPassword({
      service: PUSH_ACTION_KEYCHAIN_SERVICE,
      accessGroup,
    });
    if (item === false) {
      return null;
    }
    stored = JSON.parse(item.password) as Partial<PushActionSessionPayload>;
  } catch {
    return null;
  }
  if (
    typeof stored.actionToken !== 'string' ||
    stored.actionToken.length === 0 ||
    typeof stored.workspaceID !== 'string' ||
    typeof stored.memberID !== 'string' ||
    typeof stored.baseURL !== 'string' ||
    typeof stored.expiresAtMs !== 'number' ||
    typeof stored.ttlSeconds !== 'number'
  ) {
    return null;
  }
  if (stored.memberID !== expected.memberId || stored.baseURL !== expected.baseUrl) {
    await clearPushActionSession();
    return null;
  }
  if (stored.workspaceID.toLowerCase() !== expected.workspaceId.toLowerCase()) {
    return null;
  }
  if (stored.expiresAtMs <= now()) {
    return null;
  }
  return {
    token: stored.actionToken,
    expiresAtMs: stored.expiresAtMs,
    ttlSeconds: stored.ttlSeconds,
    workspaceId: stored.workspaceID,
  };
}
