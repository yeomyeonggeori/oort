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
//
// The same cycle keeps the lock screen's approval credential fresh (#3931,
// `pushActionToken.ts`): it is the same response shape with the same six-hour
// life. The one thing that credential adds is `restore` — see the deps.
// =============================================================================

/** 키퍼가 다루는 좁은 토큰의 모양. push-fetch(알림 확장, #3121)와 push-action(잠금 화면
 *  승인, #3931)이 같은 응답 모양이라 같은 주기를 쓴다. */
export interface MintedNarrowToken {
  token: string;
  expiresAtMs: number;
  ttlSeconds: number;
  workspaceId: string;
}

export interface PushFetchKeeperDeps<T extends MintedNarrowToken = MintedPushFetchToken> {
  /** Whether a session exists right now. Nothing is minted without one. */
  hasSession: () => boolean;
  mint: () => Promise<T | null>;
  /** True only when the item is now in the keychain. The second argument is the
   *  whole minted token, for a publisher that also stores when it lapses. */
  publish: (token: string, minted: T) => Promise<boolean>;
  /**
   * 지난 실행이 놔 둔, 아직 살아 있는 토큰 (#3931). 첫 `ensureFresh` 에서 **한 번만** 읽고,
   * 있으면 그것을 「받은 토큰」으로 삼아 남은 수명이 절반 위인 동안 새로 받지 않는다.
   *
   * 없으면 실행마다 새로 받는다 — 서버가 세션 계열당 살아 있는 토큰을 제한할 때(push_action
   * 은 4개, 초과 429) 6시간 안의 다섯 번째 실행부터 자격이 끊긴다. 주지 않으면 지금까지의
   * 동작 그대로다(push-fetch).
   */
  restore?: () => Promise<T | null>;
  now: () => number;
}

export function createPushFetchKeeper<T extends MintedNarrowToken = MintedPushFetchToken>(
  deps: PushFetchKeeperDeps<T>,
): {
  ensureFresh: (workspaceId: string) => Promise<void>;
  /** After this, a mint still in flight publishes nothing (workspace switch,
   *  unmount). */
  dispose: () => void;
} {
  let current: T | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let restored = false;

  const stale = (workspaceId: string): boolean => {
    if (!current || current.workspaceId !== workspaceId) {
      return true;
    }
    const remaining = current.expiresAtMs - deps.now();
    return remaining < (current.ttlSeconds * 1000) / 2;
  };

  const restoreOnce = async (): Promise<void> => {
    if (restored || !deps.restore) {
      return;
    }
    restored = true;
    try {
      const found = await deps.restore();
      // 읽는 사이에 받은 것이 있으면 그쪽이 새것이다.
      if (found && !disposed && current === null) {
        current = found;
      }
    } catch {
      // 읽지 못하면 받지 않은 것과 같다: 새로 받는다.
    }
  };

  const run = async (workspaceId: string): Promise<void> => {
    const minted = await deps.mint();
    if (disposed || !minted || minted.workspaceId !== workspaceId) {
      return;
    }
    if (await deps.publish(minted.token, minted)) {
      current = minted;
    }
  };

  return {
    ensureFresh(workspaceId) {
      if (disposed || !deps.hasSession()) {
        return Promise.resolve();
      }
      // 읽을 것이 남지 않았으면 예전과 같이 동기로 판정한다(push-fetch 는 늘 여기).
      if ((restored || !deps.restore) && !stale(workspaceId)) {
        return Promise.resolve();
      }
      inFlight ??= (async () => {
        await restoreOnce();
        if (disposed || !stale(workspaceId)) {
          return;
        }
        await run(workspaceId);
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    dispose() {
      disposed = true;
    },
  };
}
