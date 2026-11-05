import type {PendingMessage} from '@momo/core/features/timeline/model';

import {
  DRAFT_TTL_MS,
} from '../src/features/conversation/drafts';
import {
  clearAllFailedSends,
  FAILED_SEND_LIMIT,
  forgetFailedSend,
  readFailedSends,
  rememberFailedSend,
} from '../src/features/conversation/failedSends';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';

// =============================================================================
// 보내지 못한 글을 이 기기에 남기는 저장소 (#5222, #5201 결정 ⑤, 웹 `draftStore.failedSends.test.ts` 의 짝).
// 규칙은 초안(`drafts.ts`)과 같다: 30일 · 최대 50개 · API 키 모양 거부 · 로그아웃이 전부 지움. 거기에 이 저장소만의 약속 둘:
// 읽은 행은 언제나 「못 보낸」 행이고, 다른 사람이 쓴 글은 돌려주지 않는다.
// 숫자는 상수가 아니라 글자 그대로(30일, 50개)로 단정한다.
// =============================================================================

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

let store = memoryStore();
beforeEach(() => {
  store = memoryStore();
  __setNonSecretStore(store);
});
afterEach(() => __setNonSecretStore(null));

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const WS = 'ws-1';
const CH = 'ch-1';
const ME = 'member-me';

const row = (id: string, over: Partial<PendingMessage> = {}): PendingMessage => ({
  clientMsgId: id,
  channelId: CH,
  authorMemberId: ME,
  body: `글 ${id}`,
  status: 'sending',
  sinceSeq: 4,
  createdAtMs: NOW + Number(id.replace(/\D/g, '') || 0),
  ...over,
});

describe('남기고 되살린다', () => {
  it('행 전체(멱등 키 · 첨부 id · 인용 · 미리보기 끔)가 그대로 돌아오고, 상태는 언제나 「못 보낸」이다', () => {
    const original = row('m1', {
      status: 'sending', // 화면을 떠나던 순간의 보내는 중 행도 실패 행으로 돌아온다.
      replyToId: 'quoted-1',
      suppressUnfurl: true,
      attachments: [{id: 'att-1', name: '회의록.pdf', mime: 'application/pdf', sizeBytes: 2048}],
    });
    rememberFailedSend(WS, original, 'server', NOW);
    const [back] = readFailedSends(WS, CH, ME, NOW + 1_000);
    expect(back.kind).toBe('server');
    expect(back.row).toEqual({...original, status: 'failed'});
  });

  it('보낸 순서(만든 시각)대로 돌려주고, 같은 열쇠를 다시 남기면 갱신이다', () => {
    rememberFailedSend(WS, row('m3'), null, NOW);
    rememberFailedSend(WS, row('m1'), 'offline', NOW);
    rememberFailedSend(WS, row('m2'), 'rejected', NOW);
    rememberFailedSend(WS, row('m1'), 'server', NOW + 5);
    const rows = readFailedSends(WS, CH, ME, NOW + 10);
    expect(rows.map(r => r.row.clientMsgId)).toEqual(['m1', 'm2', 'm3']);
    expect(rows.map(r => r.kind)).toEqual(['server', 'rejected', null]);
  });

  it('이 채널·이 워크스페이스·이 사람의 글만 돌려준다 - 같은 기기를 나눠 쓰는 계정이 서로의 글을 보지 않는다', () => {
    rememberFailedSend(WS, row('m1'), null, NOW);
    rememberFailedSend(WS, row('m2', {channelId: 'ch-2'}), null, NOW);
    rememberFailedSend('ws-2', row('m3'), null, NOW);
    rememberFailedSend(WS, row('m4', {authorMemberId: 'someone-else'}), null, NOW);
    expect(readFailedSends(WS, CH, ME, NOW).map(r => r.row.clientMsgId)).toEqual(['m1']);
    // 열쇠는 대소문자를 가리지 않는다(UUID 가 섞인 대소문자로 오간다).
    expect(readFailedSends(WS.toUpperCase(), CH.toUpperCase(), ME.toUpperCase(), NOW)).toHaveLength(1);
  });

  it('끝난 글(보냈다 · 지웠다 · 서버가 이미 받았다)은 지워진다. 없는 글을 지워도 아무 일이 없다', () => {
    rememberFailedSend(WS, row('m1'), null, NOW);
    rememberFailedSend(WS, row('m2'), null, NOW);
    forgetFailedSend(WS, CH, 'm1');
    forgetFailedSend(WS, CH, 'never-there');
    expect(readFailedSends(WS, CH, ME, NOW).map(r => r.row.clientMsgId)).toEqual(['m2']);
    forgetFailedSend(WS, CH, 'm2');
    // 비면 키 자체가 없다(위 초안과 같은 약속).
    expect(store.map.has(NON_SECRET_KEYS.failedSends)).toBe(false);
  });
});

describe('스레드 답글의 행 (#5262)', () => {
  const reply = (id: string, over: Partial<PendingMessage> = {}): PendingMessage =>
    row(id, {rootId: 'root-1', ...over});

  it('뿌리가 그대로 돌아오고, 같은 채널의 글과 한 지도에 섞여 있어도 서로를 해치지 않는다', () => {
    rememberFailedSend(WS, row('m1'), 'server', NOW);
    rememberFailedSend(WS, reply('m2'), 'offline', NOW + 1);
    const back = readFailedSends(WS, CH, ME, NOW + 10);
    expect(back.map(r => r.row.clientMsgId)).toEqual(['m1', 'm2']);
    expect(back[0].row.rootId).toBeUndefined();
    expect(back[1].row).toEqual({...reply('m2'), status: 'failed'});
    expect(back[1].kind).toBe('offline');
  });

  it('대화의 글과 같은 규칙이다: 30일에 버리고, 50개 정원에 함께 세고, 로그아웃이 함께 지운다', () => {
    rememberFailedSend(WS, reply('old'), null, NOW);
    expect(readFailedSends(WS, CH, ME, NOW + 29 * DAY)).toHaveLength(1);
    expect(readFailedSends(WS, CH, ME, NOW + 30 * DAY)).toEqual([]);

    for (let i = 1; i <= 52; i += 1) {
      rememberFailedSend(WS, i % 2 === 0 ? reply(`m${i}`) : row(`m${i}`), null, NOW + i);
    }
    const kept = readFailedSends(WS, CH, ME, NOW + 100).map(r => r.row.clientMsgId);
    expect(kept).toHaveLength(50);
    expect(kept).not.toContain('m1');
    expect(kept).not.toContain('m2');
    expect(kept).toContain('m52');

    clearAllFailedSends();
    expect(readFailedSends(WS, CH, ME, NOW + 100)).toEqual([]);
    expect(store.map.has(NON_SECRET_KEYS.failedSends)).toBe(false);
  });
});

describe('수명과 정원', () => {
  it('30일이 지난 글은 읽는 순간 버린다 - 29일은 산다', () => {
    expect(DRAFT_TTL_MS).toBe(30 * DAY);
    rememberFailedSend(WS, row('old'), null, NOW);
    expect(readFailedSends(WS, CH, ME, NOW + 29 * DAY)).toHaveLength(1);
    expect(readFailedSends(WS, CH, ME, NOW + 30 * DAY)).toEqual([]);
    // 읽는 김에 저장소에서도 지웠다.
    expect(store.map.has(NON_SECRET_KEYS.failedSends)).toBe(false);
  });

  it('50개를 넘으면 가장 오래된 것부터 버린다', () => {
    expect(FAILED_SEND_LIMIT).toBe(50);
    for (let i = 1; i <= 52; i += 1) rememberFailedSend(WS, row(`m${i}`), null, NOW + i);
    const kept = readFailedSends(WS, CH, ME, NOW + 100).map(r => r.row.clientMsgId);
    expect(kept).toHaveLength(50);
    expect(kept).not.toContain('m1');
    expect(kept).not.toContain('m2');
    expect(kept).toContain('m3');
    expect(kept).toContain('m52');
  });
});

describe('저장소가 지키는 것', () => {
  it('API 키 모양이 든 글은 남기지 않고, 이미 남은 같은 글도 지운다', () => {
    // 무작위로 보이는 긴 낱말이 접두 뒤에 붙은 모양(코어 `containsSecretKey` 의 판정). 같은 글자를 되풀이한 값은 키로 보지 않는다.
    // 접두와 꼬리를 모두 10자 아래 조각으로 이어 붙인다(저장소 비밀 검사가 시험 속 가짜 키를 진짜로 읽지 않게).
    const keyLike = ['s', 'k-', 'ant-', 'api03-', 'aB3xK9mQ', '2vL7nR4t', 'Y8wZ1cD5', 'fG6hJ0pS'].join('');
    rememberFailedSend(WS, row('m1', {body: '평범한 글'}), null, NOW);
    rememberFailedSend(WS, row('m1', {body: `키는 ${keyLike} 이에요`}), null, NOW + 1);
    expect(readFailedSends(WS, CH, ME, NOW + 2)).toEqual([]);
    rememberFailedSend(WS, row('m2', {body: `또 ${keyLike}`}), null, NOW);
    expect(readFailedSends(WS, CH, ME, NOW + 2)).toEqual([]);
  });

  it('깨진 저장본은 빈 것으로 읽는다 - 글 하나 때문에 앱이 죽지 않는다. 깨진 항목만 걷힌다', () => {
    store.map.set(NON_SECRET_KEYS.failedSends, '{not json');
    expect(readFailedSends(WS, CH, ME, NOW)).toEqual([]);
    rememberFailedSend(WS, row('m1'), null, NOW);
    const map = JSON.parse(store.map.get(NON_SECRET_KEYS.failedSends) as string) as Record<string, unknown>;
    store.map.set(
      NON_SECRET_KEYS.failedSends,
      JSON.stringify({...map, [`${WS}:${CH}:broken`]: '{"row":{"clientMsgId":""},"atMs":1}', other: 7}),
    );
    expect(readFailedSends(WS, CH, ME, NOW).map(r => r.row.clientMsgId)).toEqual(['m1']);
    expect(Object.keys(JSON.parse(store.map.get(NON_SECRET_KEYS.failedSends) as string))).toEqual([`${WS}:${CH}:m1`]);
  });

  it('저장소가 던져도 던지지 않는다: 보내기 흐름이 깨지면 안 된다', () => {
    __setNonSecretStore({
      getString: () => {
        throw new Error('mmkv down');
      },
      set: () => {
        throw new Error('mmkv down');
      },
      remove: () => {
        throw new Error('mmkv down');
      },
    });
    expect(() => rememberFailedSend(WS, row('m1'), null, NOW)).not.toThrow();
    expect(() => forgetFailedSend(WS, CH, 'm1')).not.toThrow();
    expect(readFailedSends(WS, CH, ME, NOW)).toEqual([]);
    expect(() => clearAllFailedSends()).not.toThrow();
  });

  it('로그아웃은 전부 지운다', () => {
    rememberFailedSend(WS, row('m1'), null, NOW);
    rememberFailedSend(WS, row('m2', {channelId: 'ch-2'}), null, NOW);
    clearAllFailedSends();
    expect(readFailedSends(WS, CH, ME, NOW)).toEqual([]);
    expect(readFailedSends(WS, 'ch-2', ME, NOW)).toEqual([]);
    expect(store.map.has(NON_SECRET_KEYS.failedSends)).toBe(false);
  });
});
