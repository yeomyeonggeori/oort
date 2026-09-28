// =============================================================================
// One refresh rotation at a time across every tab and window of this origin
// (#3067).
//
// The refresh token is single-use and since #3065 the server reads a spent
// token coming back as THEFT (reuse detection, with the lineage sweep behind
// `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS`). Tabs share one stored token, so two
// tabs rotating at once — every tab booting after a browser restart does — hand
// the server one legitimate rotation and one "stolen" token. This module is
// the exclusive section the session store wraps each rotation in.
//
//   navigator.locks   the real thing: exclusive, origin-wide, and released by
//                     the browser when the holding tab closes or crashes.
//   localStorage      fallback where the Locks API is missing (older WebKit
//   lease             webviews). No compare-and-swap exists, so acquisition is
//                     write → wait → re-read and back off on a lost race; the
//                     lease is renewed while held and expires on its own when
//                     the holder dies, so a closed tab blocks others for at most
//                     LEASE_TTL_MS.
//   neither           no shared store either, so there is nothing to race.
//
// Residual, stated rather than hidden: a tab closed while its refresh POST is in
// the air loses the answer. The server has already spent the token, the new one
// never reaches storage, and the next holder presents the spent one. Holding
// the lock longer cannot help (the answer is gone either way); the server's
// 30 s retry grace (#3065) is what absorbs this case.
//
// Waiting is bounded (LOCK_WAIT_MS). A rotation stuck behind a holder that never
// finishes rejects, which the core reports as `unreachable` — the session is
// kept, not declared dead.
// =============================================================================

export const ROTATION_LOCK_NAME = "momo.session.rotation";
export const LEASE_KEY = "momo.session.rotationLease.v1";

/** Longer than one rotation's own deadline (REQUEST_TIMEOUT_MS, 15 s). */
export const LOCK_WAIT_MS = 20_000;
/** Kept well under the server's 30 s retry grace, renewed while held. */
export const LEASE_TTL_MS = 5_000;
const LEASE_SETTLE_MS = 40;

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: "exclusive"; signal?: AbortSignal },
    callback: () => Promise<T>
  ): Promise<T>;
}

interface Lease {
  owner: string;
  expiresAt: number;
}

export interface RotationLockEnv {
  locks: () => LockManagerLike | null;
  storage: () => Storage | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const browserEnv: RotationLockEnv = {
  locks: () => {
    try {
      const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
      return locks && typeof locks.request === "function" ? locks : null;
    } catch {
      return null;
    }
  },
  storage: () => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/** Run `work` while holding the origin-wide rotation lock. */
export function withRotationLock<T>(
  work: () => Promise<T>,
  env: RotationLockEnv = browserEnv
): Promise<T> {
  const locks = env.locks();
  if (locks) return withLocksApi(locks, work);
  const storage = env.storage();
  if (storage) return withLease(storage, work, env);
  return work();
}

async function withLocksApi<T>(locks: LockManagerLike, work: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCK_WAIT_MS);
  try {
    return await locks.request(
      ROTATION_LOCK_NAME,
      { mode: "exclusive", signal: controller.signal },
      async () => {
        clearTimeout(timer);
        return work();
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

function readLease(storage: Storage): Lease | null {
  try {
    const raw = storage.getItem(LEASE_KEY);
    if (!raw) return null;
    const lease = JSON.parse(raw) as Partial<Lease>;
    if (typeof lease.owner !== "string" || typeof lease.expiresAt !== "number") return null;
    return { owner: lease.owner, expiresAt: lease.expiresAt };
  } catch {
    return null;
  }
}

function writeLease(storage: Storage, lease: Lease | null): boolean {
  try {
    if (lease) storage.setItem(LEASE_KEY, JSON.stringify(lease));
    else storage.removeItem(LEASE_KEY);
    return true;
  } catch {
    return false;
  }
}

function newOwner(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

async function withLease<T>(
  storage: Storage,
  work: () => Promise<T>,
  env: RotationLockEnv
): Promise<T> {
  const owner = newOwner();
  const deadline = env.now() + LOCK_WAIT_MS;
  for (;;) {
    const held = readLease(storage);
    if (!held || held.expiresAt <= env.now()) {
      // Storage refuses writes (quota, policy): nothing another tab can read
      // either, so there is no shared token to race over.
      if (!writeLease(storage, { owner, expiresAt: env.now() + LEASE_TTL_MS })) return work();
      // Two tabs can both see the lease free and both write. The last write
      // wins; whoever still reads its own name after the settle window owns it.
      await env.sleep(LEASE_SETTLE_MS);
      if (readLease(storage)?.owner === owner) break;
    }
    if (env.now() >= deadline) throw new Error("rotation lease wait timed out");
    await env.sleep(50 + Math.floor(Math.random() * 50));
  }

  const renew = setInterval(() => {
    if (readLease(storage)?.owner === owner) {
      writeLease(storage, { owner, expiresAt: env.now() + LEASE_TTL_MS });
    }
  }, LEASE_TTL_MS / 3);
  const releaseOnHide = () => release();
  function release(): void {
    clearInterval(renew);
    if (readLease(storage)?.owner === owner) writeLease(storage, null);
  }
  try {
    globalThis.addEventListener?.("pagehide", releaseOnHide);
  } catch {
    // Not a window (tests, workers): the TTL still frees the lease.
  }
  try {
    return await work();
  } finally {
    release();
    try {
      globalThis.removeEventListener?.("pagehide", releaseOnHide);
    } catch {
      // see above
    }
  }
}
