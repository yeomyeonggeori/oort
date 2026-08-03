import {
  ACCESSIBLE,
  resetGenericPassword,
  setGenericPassword,
} from 'react-native-keychain';

import {PUSH_FETCH_SESSION_ACCOUNT, PUSH_KEYCHAIN_SERVICE} from './contract';
import {keychainAccessGroup} from './native';

// =============================================================================
// The app→extension handoff (goal RN-N1). THIS is the load-bearing seam.
//
// ADR-0120 D2-A ships id-only payloads: the push carries a message id and no
// content, and the extension fetches the real title/body itself while the phone
// is locked. To do that it needs a base URL, a workspace id and an access token,
// and the two processes share exactly one channel for them — a keychain item in
// a shared ACCESS GROUP.
//
// Not the App Group. ADR-0137 D7 정오 2항 corrected the ADR on this: the App
// Group is declared in both entitlement files but nothing on the extension's
// code path reads it. `MomoKeychainValueStore` uses `kSecAttrAccessGroup`
// (PushNotification.swift:73). Get the App Group right and the access group
// wrong and the extension does not crash — it fails open and shows the
// placeholder alert forever.
//
// ## Why JS is allowed to write an item Swift reads
//
// The attributes have to match exactly or `SecItemCopyMatching` returns
// errSecItemNotFound. react-native-keychain's write path was read to confirm
// each one (node_modules/react-native-keychain/ios/RNKeychainManager/RNKeychainManager.m):
//
//   kSecClass            kSecClassGenericPassword   :453  == PushNotification.swift:68
//   kSecAttrService      options.service            :455  == :69
//   kSecAttrAccount      username argument          :456  == :70
//   kSecAttrSynchronizable  false by default        :457, cloudSyncValue :138-144 == :71
//   kSecAttrAccessGroup  options.accessGroup        :251  == :73
//   kSecAttrAccessible   options.accessible         :247  == :58
//
// The reader's query omits kSecAttrAccessible, so that one only has to be
// permissive enough — AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY is required because
// the extension runs on a locked screen, which is exactly when a push arrives.
// =============================================================================

/** The JSON shape `PushFetchSession` decodes — PushNotification.swift:93-103.
 *  Swift's JSONDecoder uses property names verbatim here (no key strategy), so
 *  these three keys are the contract, capitalisation included. */
interface PushFetchSessionPayload {
  baseURL: string;
  workspaceID: string;
  accessToken: string;
}

export type PushFetchSessionOutcome =
  | {kind: 'published'; accessGroup: string}
  /** The build could not resolve the shared access group. Writing without one
   *  would put the item in the app's private group where the extension cannot
   *  see it — silently. Refusing is better than writing to nowhere. */
  | {kind: 'no-access-group'}
  /** The keychain refused. On device the interesting case is
   *  errSecMissingEntitlement (-34018): the access group is not granted to this
   *  binary. The simulator is permissive and will not reproduce it. */
  | {kind: 'failed'; reason: string};

export interface PushFetchSessionInput {
  /** Absolute origin the extension will fetch from, e.g. `https://host:28001`. */
  baseUrl: string;
  workspaceId: string;
  accessToken: string;
}

/**
 * Publish (or refresh) the session the extension fetches with.
 *
 * Must be called again whenever the access token rotates — roughly every 15
 * minutes. A stale token makes the extension's fetch 401, and a 401 is
 * indistinguishable to the user from a working push with an empty body, because
 * the resolver falls back to the placeholder either way
 * (PushNotification.swift:248-252).
 */
export async function publishPushFetchSession(
  input: PushFetchSessionInput,
): Promise<PushFetchSessionOutcome> {
  const accessGroup = keychainAccessGroup();
  if (!accessGroup) {
    return {kind: 'no-access-group'};
  }

  const payload: PushFetchSessionPayload = {
    baseURL: input.baseUrl,
    workspaceID: input.workspaceId,
    accessToken: input.accessToken,
  };

  try {
    await setGenericPassword(
      PUSH_FETCH_SESSION_ACCOUNT,
      JSON.stringify(payload),
      {
        service: PUSH_KEYCHAIN_SERVICE,
        accessGroup,
        accessible: ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      },
    );
    return {kind: 'published', accessGroup};
  } catch (cause) {
    return {kind: 'failed', reason: describe(cause)};
  }
}

/**
 * Drop the extension's copy of the session.
 *
 * Called on sign-out. If this is skipped, a signed-out phone keeps resolving
 * push bodies against the previous account's token until the server revokes it
 * — the extension has no idea anyone signed out.
 */
export async function clearPushFetchSession(): Promise<void> {
  const accessGroup = keychainAccessGroup();
  try {
    await resetGenericPassword({
      service: PUSH_KEYCHAIN_SERVICE,
      ...(accessGroup ? {accessGroup} : {}),
    });
  } catch {
    // Deliberately swallowed: sign-out must not be blocked by the keychain, and
    // the token it protects is revoked server-side by the same flow.
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
