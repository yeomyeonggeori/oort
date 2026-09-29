import type {MintedPushFetchToken} from './pushFetchToken';

// =============================================================================
// Keeps the extension's parked token fresh (#3121).
//
// The old loop re-published the access token on every rotation (~15 minutes).
// The push-fetch token lives six hours, so the same trigger now mostly does
// nothing: mint once, publish once, and mint again only when less than half the
// lifetime is left. Everything is injected so the properties that matter can be
// held in a test:
//
//   - the value handed to `publish` is ALWAYS a minted push-fetch token, never
//     the access token (there is no code path that reads the access token here);
//   - a failed mint publishes nothing and leaves the last good item in place;
//   - concurrent triggers share one mint.
// =============================================================================

export interface PushFetchKeeperDeps {
  /** Whether a session exists right now. Nothing is minted without one. */
  hasSession: () => boolean;
  mint: () => Promise<MintedPushFetchToken | null>;
  /** True only when the item is now in the keychain. */
  publish: (token: string) => Promise<boolean>;
  now: () => number;
}

export function createPushFetchKeeper(deps: PushFetchKeeperDeps): {
  ensureFresh: (workspaceId: string) => Promise<void>;
} {
  let current: MintedPushFetchToken | null = null;
  let inFlight: Promise<void> | null = null;

  const stale = (workspaceId: string): boolean => {
    if (!current || current.workspaceId !== workspaceId) {
      return true;
    }
    const remaining = current.expiresAtMs - deps.now();
    return remaining < (current.ttlSeconds * 1000) / 2;
  };

  const run = async (workspaceId: string): Promise<void> => {
    const minted = await deps.mint();
    if (!minted || minted.workspaceId !== workspaceId) {
      return;
    }
    if (await deps.publish(minted.token)) {
      current = minted;
    }
  };

  return {
    ensureFresh(workspaceId) {
      if (!deps.hasSession() || !stale(workspaceId)) {
        return Promise.resolve();
      }
      inFlight ??= run(workspaceId).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
