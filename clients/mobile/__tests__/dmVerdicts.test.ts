import type {Channel, ReadState, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {GoneUnreadVerdict} from '@momo/core/features/sidebar/goneDm';

import {
  dmClosedEntries,
  dmClosureMode,
  dmVerdicts,
  type DmVerdictsInput,
} from '../src/features/sidebar/dmVerdicts';

// =============================================================================
// 폰 사이드바의 DM 보임 판정 (#4367, ADR-0177 증보 D8). 표(코어 `dmVisibility`)는 코어 시험이 잰다.
// 이 시험은 폰이 그 표에 **무엇을 넣는가**를 잰다: 서버 행을 그대로, 옛 서버는 전체 seq 로, 오는 중에는 나간 상대만 숨김.
// =============================================================================

const WS = 'wwwwwwww-2222-4222-8222-wwwwwwwwwwww';
const SELF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PEER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const GONE_ID = 'ffffffff-1111-4111-8111-ffffffffffff';

function member(id: string, displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName,
    handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const DIRECTORY = makeDirectory([
  member(SELF_ID, '이도현', 'dohyun'),
  member(PEER_ID, '박서연', 'seoyeon'),
]);

const dm = (id: string, peer: string): Channel => ({
  id,
  workspaceId: WS,
  kind: 'dm',
  muted: false,
  memberIds: [SELF_ID, peer],
});
const DM_PEER = dm('ch-dm-peer', PEER_ID);
const DM_GONE = dm('ch-dm-gone', GONE_ID);

const row = (channelId: string, over: Partial<ReadState> = {}): ReadState => ({
  channelId,
  lastReadSeq: 5,
  latestSeq: 5,
  unreadCount: 0,
  mentionCount: 0,
  markedUnreadBeforeSeq: null,
  ...over,
});

function verdicts(rows: ReadState[], over: Partial<DmVerdictsInput> = {}) {
  return dmVerdicts({
    dms: [DM_PEER, DM_GONE],
    directory: DIRECTORY,
    selfMemberId: SELF_ID,
    byChannel: new Map(rows.map(state => [state.channelId, state])),
    openChannelId: null,
    phase: 'ready',
    mode: dmClosureMode(rows),
    ...over,
  });
}

describe('dmClosureMode: 서버가 닫기를 싣는가는 투영 행이 말한다', () => {
  it('행이 둘 중 하나라도 말하면 server', () => {
    expect(dmClosureMode([row('a', {closedAtSeq: null})])).toBe('server');
    expect(dmClosureMode([row('a', {latestReadableSeq: 5})])).toBe('server');
    expect(dmClosureMode([row('a'), row('b', {closedAtSeq: 3})])).toBe('server');
  });
  it('행이 있는데 아무도 말하지 않으면 legacy', () => {
    expect(dmClosureMode([row('a'), row('b')])).toBe('legacy');
  });
  it('투영이 없거나 행이 0개면 증거가 없다: unknown', () => {
    expect(dmClosureMode(undefined)).toBe('unknown');
    expect(dmClosureMode([])).toBe('unknown');
  });
});

describe('server 갈래: 행 그대로 코어 판정에 넣는다', () => {
  it('내가 닫았고 읽을 것이 없다 -> 숨김 (7번)', () => {
    const v = verdicts([row(DM_PEER.id, {closedAtSeq: 5, latestReadableSeq: 5})]);
    expect(v.get(DM_PEER.id)).toEqual({shown: false, rule: 7});
  });

  it('닫은 뒤 읽을 메시지가 왔다 -> 보임 (8번, 되살림)', () => {
    const v = verdicts([row(DM_PEER.id, {closedAtSeq: 5, latestReadableSeq: 7, latestSeq: 7})]);
    expect(v.get(DM_PEER.id)).toEqual({shown: true, rule: 8});
  });

  it('닫은 뒤 온 것이 기계 메시지뿐이면 latestReadableSeq 가 그대로라 계속 숨는다', () => {
    const v = verdicts([row(DM_PEER.id, {closedAtSeq: 5, latestReadableSeq: 5, latestSeq: 9})]);
    expect(v.get(DM_PEER.id)?.shown).toBe(false);
  });

  it('닫지 않았다(closedAtSeq null) -> 보임 (9번)', () => {
    const v = verdicts([row(DM_PEER.id, {closedAtSeq: null, latestReadableSeq: 5})]);
    expect(v.get(DM_PEER.id)).toEqual({shown: true, rule: 9});
  });

  it('열려 있는 DM 은 닫혀 있어도 보인다 (1번), 대소문자가 달라도 같은 DM 이다', () => {
    const rows = [row(DM_PEER.id, {closedAtSeq: 5, latestReadableSeq: 5})];
    expect(verdicts(rows, {openChannelId: DM_PEER.id}).get(DM_PEER.id)).toEqual({shown: true, rule: 1});
    expect(verdicts(rows, {openChannelId: DM_PEER.id.toUpperCase()}).get(DM_PEER.id)?.shown).toBe(true);
  });

  it('멘션·「여기부터 안 읽음」은 닫았어도 보인다 (5번, 사람이 직접 남긴 신호)', () => {
    const closed = {closedAtSeq: 5, latestReadableSeq: 5};
    expect(verdicts([row(DM_PEER.id, {...closed, mentionCount: 1})]).get(DM_PEER.id)?.rule).toBe(5);
    expect(
      verdicts([row(DM_PEER.id, {...closed, markedUnreadBeforeSeq: 3})]).get(DM_PEER.id)?.rule,
    ).toBe(5);
  });

  it('행이 읽을 seq 를 말하지 않았다(옛 행)면 전체 seq 로 대신한다: 더 많이 보이는 쪽', () => {
    const v = verdicts([row(DM_PEER.id, {closedAtSeq: 5, latestSeq: 8})]);
    expect(v.get(DM_PEER.id)).toEqual({shown: true, rule: 8});
  });

  it('이 행이 닫힘을 말하지 않았다(undefined)면 안 닫았다고 읽지 않고 보인다 (hold → 보임)', () => {
    const v = verdicts([
      row(DM_PEER.id, {closedAtSeq: null, latestReadableSeq: 5}),
      row('other', {closedAtSeq: 2, latestReadableSeq: 2}),
    ]);
    expect(v.get(DM_PEER.id)?.shown).toBe(true);
    const missing = verdicts(
      [row(DM_PEER.id, {latestReadableSeq: 5}), row('other', {closedAtSeq: null})],
    );
    expect(missing.get(DM_PEER.id)).toEqual({shown: true, rule: 3});
  });

  it('투영 행이 없는 DM(메시지가 한 번도 없다)은 보인다', () => {
    const v = verdicts([row('other', {closedAtSeq: null})]);
    expect(v.get(DM_PEER.id)?.shown).toBe(true);
  });
});

describe('나간 상대 (6번): 닫기보다 먼저, 안 읽은 것이 없을 때만', () => {
  it('안 읽은 것이 없으면 숨고, 사람이 읽을 것이 있으면 보인다', () => {
    const read = row(DM_GONE.id, {closedAtSeq: null, latestReadableSeq: 5});
    expect(verdicts([read]).get(DM_GONE.id)).toEqual({shown: false, rule: 6});
    const unread = row(DM_GONE.id, {
      closedAtSeq: null,
      latestReadableSeq: 8,
      latestSeq: 8,
      lastReadSeq: 5,
    });
    expect(verdicts([unread]).get(DM_GONE.id)?.shown).toBe(true);
  });

  it('기계 메시지만 안 읽었으면(latestReadableSeq 가 읽은 자리) 서버 갈래에서는 메시지를 읽지 않고도 숨는다', () => {
    const v = verdicts([
      row(DM_GONE.id, {closedAtSeq: null, latestReadableSeq: 5, latestSeq: 9, lastReadSeq: 5, unreadCount: 4}),
    ]);
    expect(v.get(DM_GONE.id)).toEqual({shown: false, rule: 6});
  });

  it('명부를 믿을 수 없으면(못 받았다) 6번을 건너뛴다: 「불러오는 중」은 나간 멤버가 아니다', () => {
    const rows = [row(DM_GONE.id, {closedAtSeq: null, latestReadableSeq: 5})];
    expect(
      verdicts(rows, {directory: makeDirectory([]), rosterReady: false}).get(DM_GONE.id)?.shown,
    ).toBe(true);
  });

  it('명부가 한도(200)에 닿아 잘렸을 수 있으면 6번을 건너뛴다', () => {
    const many = Array.from({length: 200}, (_, i) =>
      member(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `멤버${i}`, `m${i}`),
    );
    const rows = [row(DM_GONE.id, {closedAtSeq: null, latestReadableSeq: 5})];
    expect(
      verdicts(rows, {directory: makeDirectory([member(SELF_ID, '이도현', 'dohyun'), ...many])}).get(
        DM_GONE.id,
      )?.shown,
    ).toBe(true);
  });

  it('나간 상대의 DM 도 내가 닫았으면 「닫은 대화」 이유는 gone 이다(6번이 7번보다 먼저)', () => {
    const rows = [row(DM_GONE.id, {closedAtSeq: 5, latestReadableSeq: 5})];
    expect(verdicts(rows).get(DM_GONE.id)?.rule).toBe(6);
  });
});

describe('legacy 갈래 (옛 서버): 닫힘은 없고, 나간 상대 접기만 같은 판정으로 돈다', () => {
  it('닫기를 말하지 않는 행은 닫히지 않은 것으로 읽는다: 보임', () => {
    const v = verdicts([row(DM_PEER.id, {latestSeq: 5, lastReadSeq: 5})]);
    expect(v.get(DM_PEER.id)?.shown).toBe(true);
  });

  it('나간 상대의 DM: 안 읽음이 없으면 숨는다', () => {
    const v = verdicts([row(DM_GONE.id, {latestSeq: 5, lastReadSeq: 5})]);
    expect(v.get(DM_GONE.id)).toEqual({shown: false, rule: 6});
  });

  const unread = row(DM_GONE.id, {latestSeq: 8, lastReadSeq: 3, unreadCount: 5});
  const withVerdict = (gone?: GoneUnreadVerdict) =>
    verdicts([unread], {goneVerdicts: gone === undefined ? undefined : new Map([[DM_GONE.id, gone]])})
      .get(DM_GONE.id);

  it('안 읽음이 기계 메시지뿐이라고 판정되면(ambient)·읽는 중이면(pending) 숨는다', () => {
    expect(withVerdict('ambient')).toEqual({shown: false, rule: 6});
    expect(withVerdict('pending')).toEqual({shown: false, rule: 6});
  });

  it('사람이 읽을 것이 있다(human)·못 읽었다(error)·판정이 없다 -> 보인다', () => {
    for (const verdict of ['human', 'error', undefined] as const) {
      expect({verdict, shown: withVerdict(verdict)?.shown}).toEqual({verdict, shown: true});
    }
  });
});

describe('투영이 오는 중(loading)이면 나간 상대만 숨은 채다', () => {
  it('나간 상대의 DM 은 숨고, 그 밖의 DM 은 보인다 (깜빡이며 나타났다 사라지지 않게)', () => {
    const v = verdicts([], {phase: 'loading', mode: 'unknown'});
    expect(v.get(DM_GONE.id)?.shown).toBe(false);
    expect(v.get(DM_PEER.id)?.shown).toBe(true);
  });

  it('열려 있는 DM 은 오는 중에도 보인다', () => {
    const v = verdicts([], {phase: 'loading', mode: 'unknown', openChannelId: DM_GONE.id});
    expect(v.get(DM_GONE.id)).toEqual({shown: true, rule: 1});
  });

  it('투영을 못 읽었으면(error) 아무것도 숨기지 않는다: 모를 때 숨기는 쪽이 최악이다', () => {
    const v = verdicts([], {phase: 'error', mode: 'unknown'});
    expect([...v.values()].every(verdict => verdict.shown)).toBe(true);
  });
});

describe('dmClosedEntries: 「닫은 대화」 목록은 숨은 DM 중 닫음(7)과 나감(6)만', () => {
  it('보이는 대화는 넣지 않고, 이유를 붙인다', () => {
    const rows = [
      row(DM_PEER.id, {closedAtSeq: 5, latestReadableSeq: 5}),
      row(DM_GONE.id, {closedAtSeq: null, latestReadableSeq: 5}),
    ];
    const v = verdicts(rows);
    expect(
      dmClosedEntries([DM_PEER, DM_GONE], v).map(entry => [entry.channel.id, entry.reason]),
    ).toEqual([
      ['ch-dm-peer', 'closed'],
      ['ch-dm-gone', 'gone'],
    ]);
  });

  it('되살아난 DM·열린 DM·닫지 않은 DM 은 목록에 없다', () => {
    const revived = verdicts([row(DM_PEER.id, {closedAtSeq: 5, latestReadableSeq: 7, latestSeq: 7})]);
    expect(dmClosedEntries([DM_PEER], revived)).toEqual([]);
    const open = verdicts([row(DM_PEER.id, {closedAtSeq: 5, latestReadableSeq: 5})], {
      openChannelId: DM_PEER.id,
    });
    expect(dmClosedEntries([DM_PEER], open)).toEqual([]);
    const plain = verdicts([row(DM_PEER.id, {closedAtSeq: null, latestReadableSeq: 5})]);
    expect(dmClosedEntries([DM_PEER], plain)).toEqual([]);
  });
});
