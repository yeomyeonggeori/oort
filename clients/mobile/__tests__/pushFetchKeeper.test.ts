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

  it('a mint that finishes after dispose publishes nothing', async () => {
    const t = setup();
    t.setNext(minted('push-fetch-1', t.now()));
    const pending = t.keeper.ensureFresh(WS);
    t.keeper.dispose();
    await pending;
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('refuses a token minted for another workspace', async () => {
    const t = setup();
    t.setNext({...minted('push-fetch-1', t.now()), workspaceId: 'other'});
    await t.keeper.ensureFresh(WS);
    expect(t.publish).not.toHaveBeenCalled();
  });
});

// =============================================================================
// #3931 — 잠금 화면 승인의 자격도 같은 키퍼가 맡는다. 다른 점은 하나, `restore` 다.
//
// 서버는 세션 계열당 살아 있는 push_action 토큰을 4개까지만 내준다(초과 429). 키퍼는 실행마다
// 「받은 토큰 없음」으로 시작하므로, 지난 실행이 폰에 놔 둔 것을 읽어 이어 쓰지 않으면 6시간
// 안의 다섯 번째 실행부터 자격이 끊긴다.
// =============================================================================

describe('지난 실행이 놔 둔 토큰을 이어 쓴다 (restore)', () => {
  function withRestore(restored: MintedPushFetchToken | null | 'throws') {
    let now = 1_000_000;
    const published: Array<{token: string; whole: MintedPushFetchToken}> = [];
    let next: MintedPushFetchToken | null = null;
    const mint = jest.fn(async () => next);
    const publish = jest.fn(async (token: string, whole: MintedPushFetchToken) => {
      published.push({token, whole});
      return true;
    });
    const restore = jest.fn(async () => {
      if (restored === 'throws') throw new Error('keychain locked');
      return restored;
    });
    const keeper = createPushFetchKeeper({
      hasSession: () => true,
      mint,
      publish,
      restore,
      now: () => now,
    });
    return {
      keeper,
      mint,
      publish,
      restore,
      published,
      setNext: (m: MintedPushFetchToken | null) => (next = m),
      advance: (ms: number) => (now += ms),
      now: () => now,
    };
  }

  it('남은 수명이 절반 위인 토큰이 있으면 새로 받지 않는다 (실행마다 받아 429 에 닿지 않는다)', async () => {
    const t = withRestore(minted('restored', 1_000_000 - 1 * HOUR));
    t.setNext(minted('fresh', 1_000_000));

    await t.keeper.ensureFresh(WS);
    await t.keeper.ensureFresh(WS);

    expect(t.mint).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('이어 받은 토큰도 수명이 절반 아래로 내려가면 새로 받는다', async () => {
    const t = withRestore(minted('restored', 1_000_000 - 1 * HOUR));
    t.setNext(minted('fresh', 1_000_000));
    await t.keeper.ensureFresh(WS);
    expect(t.mint).not.toHaveBeenCalled();

    t.advance(2 * HOUR + 1); // 6시간 중 1시간 지났던 토큰: 3시간을 넘게 쓴 것
    await t.keeper.ensureFresh(WS);

    expect(t.published.map(p => p.token)).toEqual(['fresh']);
  });

  it('이어 받을 토큰의 남은 수명이 절반 아래면 새로 받는다', async () => {
    const t = withRestore(minted('old', 1_000_000 - 4 * HOUR));
    t.setNext(minted('fresh', 1_000_000));

    await t.keeper.ensureFresh(WS);

    expect(t.published.map(p => p.token)).toEqual(['fresh']);
  });

  it('놓인 것이 없으면(null) 새로 받는다', async () => {
    const t = withRestore(null);
    t.setNext(minted('fresh', 1_000_000));

    await t.keeper.ensureFresh(WS);

    expect(t.restore).toHaveBeenCalledTimes(1);
    expect(t.published.map(p => p.token)).toEqual(['fresh']);
  });

  it('읽다가 던져도 새로 받는다 — 읽지 못한 것은 받지 않은 것과 같다', async () => {
    const t = withRestore('throws');
    t.setNext(minted('fresh', 1_000_000));

    await t.keeper.ensureFresh(WS);

    expect(t.published.map(p => p.token)).toEqual(['fresh']);
  });

  it('다른 워크스페이스의 토큰은 이어 쓰지 않는다', async () => {
    const t = withRestore({...minted('other-ws', 1_000_000), workspaceId: 'other'});
    t.setNext(minted('fresh', 1_000_000));

    await t.keeper.ensureFresh(WS);

    expect(t.published.map(p => p.token)).toEqual(['fresh']);
  });

  it('읽기는 처음 한 번뿐이다', async () => {
    const t = withRestore(null);
    t.setNext(minted('fresh', 1_000_000));

    await t.keeper.ensureFresh(WS);
    await t.keeper.ensureFresh(WS);
    t.advance(4 * HOUR);
    t.setNext(minted('fresh-2', 1_000_000 + 4 * HOUR));
    await t.keeper.ensureFresh(WS);

    expect(t.restore).toHaveBeenCalledTimes(1);
  });

  it('동시에 불려도 읽기와 받기는 한 번씩이다', async () => {
    const t = withRestore(null);
    t.setNext(minted('fresh', 1_000_000));

    await Promise.all([t.keeper.ensureFresh(WS), t.keeper.ensureFresh(WS), t.keeper.ensureFresh(WS)]);

    expect(t.restore).toHaveBeenCalledTimes(1);
    expect(t.mint).toHaveBeenCalledTimes(1);
  });

  it('읽는 사이에 dispose 되면 아무것도 놓지 않는다', async () => {
    const t = withRestore(null);
    t.setNext(minted('fresh', 1_000_000));

    const pending = t.keeper.ensureFresh(WS);
    t.keeper.dispose();
    await pending;

    expect(t.publish).not.toHaveBeenCalled();
  });

  it('publish 는 받은 토큰 전체를 두 번째 인자로 받는다 (만료 시각을 함께 놓으려고)', async () => {
    const t = withRestore(null);
    const fresh = minted('fresh', 1_000_000);
    t.setNext(fresh);

    await t.keeper.ensureFresh(WS);

    expect(t.published).toEqual([{token: 'fresh', whole: fresh}]);
  });
});
