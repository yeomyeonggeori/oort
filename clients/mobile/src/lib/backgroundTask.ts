import {requireOptionalNativeModule} from 'expo-modules-core';

// =============================================================================
// Extra background time for work that must not be frozen halfway (#3098).
//
// iOS suspends the app about five seconds after it leaves the foreground. The
// one piece of work that cannot survive that is a refresh rotation: the server
// revokes the presented token as it answers, so a response that never lands —
// or lands and never reaches the keychain — leaves a dead token stored and
// signs the person out on the next launch. `modules/momo-background-task-native`
// wraps `beginBackgroundTask`/`endBackgroundTask`; this is the JS side.
//
// `requireOptionalNativeModule` for the same reason as `src/push/native.ts`:
// under Jest, and in a build without the module, the answer is null and the
// work runs exactly as it did before — no extra time, no failure.
// =============================================================================

/** How the native side found the task when JS ended it. */
export type BackgroundTaskEnd = 'ended' | 'expired' | 'unknown';

export interface MomoBackgroundTaskModule {
  /** A handle, or null when iOS refused to grant extra time. */
  begin(name: string): Promise<number | null>;
  end(handle: number): Promise<BackgroundTaskEnd>;
}

const nativeModule =
  requireOptionalNativeModule<MomoBackgroundTaskModule>('MomoBackgroundTask');

/**
 * Run `work` inside one iOS background task: begun BEFORE `work` starts (Apple:
 * "before you start the task", not once the app is already leaving) and ended
 * only after `work` settles, success or failure.
 *
 * Never adds a failure of its own. If the task cannot be begun, `work` runs
 * without it; if ending fails, `work`'s result stands.
 *
 * When iOS's time ran out first, the native expiration handler has already
 * ended the task — the only honest thing it can do, since a request already
 * sent cannot be unsent. That is reported here, not hidden.
 */
export async function withBackgroundTask<T>(
  name: string,
  work: () => Promise<T>,
  native: MomoBackgroundTaskModule | null = nativeModule,
): Promise<T> {
  let handle: number | null = null;
  if (native) {
    try {
      handle = await native.begin(name);
    } catch {
      handle = null;
    }
  }
  try {
    return await work();
  } finally {
    if (native && handle !== null) {
      try {
        const how = await native.end(handle);
        if (how === 'expired') {
          console.warn(
            `[oort] background task "${name}" outlived its time; iOS ended it first`,
          );
        }
      } catch {
        // The task is ended by iOS on expiry at the latest; nothing to add.
      }
    }
  }
}
