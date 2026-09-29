import {createPushFetchKeeper} from '../src/push/pushFetchKeeper';
import type {MintedPushFetchToken} from '../src/push/pushFetchToken';

// #3121 — what the notification extension is handed, and when.

const WS = '22222222-2222-4222-8222-222222222222';
const HOUR = 3_600_000;

function minted(token: string, now: number, ttlHours = 6): MintedPushFetchToken {
  return {
    token,
    expiresAtMs: now + ttlHours * HOUR,
    ttlSeconds: ttlHours * 3600,
    workspaceId: WS,
  };
}

function setup(overrides: {hasSession?: boolean} = {}) {
  let now = 1_000_000;
  const published: string[] = [];
  let next: MintedPushFetchToken | null = null;
  let publishOk = true;
  const mint = jest.fn(async () => next);
  const publish = jest.fn(async (t: string) => {
    published.push(t);
    return publishOk;
  });
  const keeper = createPushFetchKeeper({
    hasSession: () => overrides.hasSession ?? true,
    mint,
    publish,
    now: () => now,
  });
  return {
    keeper,
    mint,
    publish,
    published,
    setNext: (m: MintedPushFetchToken | null) => (next = m),
    setPublishOk: (ok: boolean) => (publishOk = ok),
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

describe('the extension is handed a minted push-fetch token, when one is needed', () => {
  it('mints once, publishes that token, and treats session rotations as a no-op', async () => {
    const t = setup();
    t.setNext(minted('push-fetch-1', t.now()));
    await t.keeper.ensureFresh(WS);
    await t.keeper.ensureFresh(WS);
    t.advance(15 * 60_000); // an access-token rotation later
    await t.keeper.ensureFresh(WS);
    expect(t.mint).toHaveBeenCalledTimes(1);
    expect(t.published).toEqual(['push-fetch-1']);
  });

  it('mints a fresh one once less than half the lifetime is left', async () => {
    const t = setup();
    t.setNext(minted('push-fetch-1', t.now()));
    await t.keeper.ensureFresh(WS);
    t.advance(3 * HOUR + 1);
    t.setNext(minted('push-fetch-2', t.now()));
    await t.keeper.ensureFresh(WS);
    expect(t.published).toEqual(['push-fetch-1', 'push-fetch-2']);
  });

  it('a failed mint publishes NOTHING — there is no fallback to the access token', async () => {
    const t = setup();
    t.setNext(null);
    await t.keeper.ensureFresh(WS);
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('does not mint without a session', async () => {
    const t = setup({hasSession: false});
    await t.keeper.ensureFresh(WS);
    expect(t.mint).not.toHaveBeenCalled();
  });

  it('retries after a publish that did not land', async () => {
    const t = setup();
    t.setNext(minted('push-fetch-1', t.now()));
    t.setPublishOk(false);
    await t.keeper.ensureFresh(WS);
    t.setPublishOk(true);
    await t.keeper.ensureFresh(WS);
    expect(t.published).toEqual(['push-fetch-1', 'push-fetch-1']);
  });

  it('concurrent triggers share one mint', async () => {
    const t = setup();
    t.setNext(minted('push-fetch-1', t.now()));
    await Promise.all([t.keeper.ensureFresh(WS), t.keeper.ensureFresh(WS)]);
    expect(t.mint).toHaveBeenCalledTimes(1);
  });

  it('refuses a token minted for another workspace', async () => {
    const t = setup();
    t.setNext({...minted('push-fetch-1', t.now()), workspaceId: 'other'});
    await t.keeper.ensureFresh(WS);
    expect(t.publish).not.toHaveBeenCalled();
  });
});
