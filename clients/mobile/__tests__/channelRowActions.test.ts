import type {Channel, MembershipRole, ReadState} from '@momo/core/lib/api';
import {
  CHANNEL_COPY_GROUP_LABEL,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_UNREAD_LABEL,
  CHANNEL_MUTE_LABEL,
  CHANNEL_UNMUTE_LABEL,
} from '@momo/core/features/channels/model';

import {
  PHONE_CHANNEL_ACTION_KEYS,
  channelRowAccessibilityActions,
  channelRowActionItems,
  channelRowActionKeyOf,
  type ChannelRowTarget,
} from '../src/features/sidebar/channelRowActions';
import {readIntentWire} from '../src/features/readState/advertise';

// =============================================================================
// 행 길게 누르기 시트의 **항목 판정** (#4229). 표는 코어(`channels/actionModel`)의 것이고,
// 이 시험은 폰이 그 표에 넘기는 손과 그 결과를 잰다.
// =============================================================================

const read = (over: Partial<ReadState> = {}): ReadState => ({
  channelId: 'c1',
  lastReadSeq: 10,
  latestSeq: 12,
  unreadCount: 2,
  mentionCount: 0,
  markedUnreadBeforeSeq: null,
  ...over,
});

function target(over: Partial<ChannelRowTarget> & {kind?: Channel['kind']} = {}): ChannelRowTarget {
  const {kind = 'public', ...rest} = over;
  return {
    channel: {id: 'c1', kind, topic: '주제가 있는 채널'},
    title: '일반',
    muted: false,
    selfRole: 'admin',
    readState: read(),
    ...rest,
  };
}

const keys = (t: ChannelRowTarget, copied?: Parameters<typeof channelRowActionItems>[1]) =>
  channelRowActionItems(t, copied).map(item => item.key);

describe('채널 행', () => {
  it('안 읽음이 있으면 복사 셋 → 읽음 처리 → 알림 → 나가기, 이 차례 그대로', () => {
    expect(keys(target())).toEqual([
      'copy-name',
      'copy-link',
      'copy-id',
      'mark-read',
      'mute',
      'leave',
    ]);
  });

  it('다 읽었으면 「읽음 처리」 자리에 「읽지 않음으로 표시」가 선다 — 둘이 함께 서지 않는다', () => {
    const items = channelRowActionItems(
      target({readState: read({lastReadSeq: 12, unreadCount: 0})}),
    );
    expect(items.map(item => item.key)).toContain('mark-unread');
    expect(items.map(item => item.key)).not.toContain('mark-read');
    expect(items.find(item => item.key === 'mark-unread')?.label).toBe(CHANNEL_MARK_UNREAD_LABEL);
  });

  it('읽음 투영이 없으면 읽음 쪽 항목이 없다 — 광고할 자리를 모르면서 내놓지 않는다', () => {
    const k = keys(target({readState: null}));
    expect(k).not.toContain('mark-read');
    expect(k).not.toContain('mark-unread');
  });

  it('메시지가 없는 채널에는 「읽지 않음으로 표시」가 없다', () => {
    expect(
      keys(target({readState: read({latestSeq: 0, lastReadSeq: 0, unreadCount: 0})})),
    ).not.toContain('mark-unread');
  });

  it('알림의 낱말은 상태다', () => {
    const label = (muted: boolean) =>
      channelRowActionItems(target({muted})).find(item => item.key === 'mute')?.label;
    expect(label(false)).toBe(CHANNEL_MUTE_LABEL);
    expect(label(true)).toBe(CHANNEL_UNMUTE_LABEL);
  });

  it('일반 멤버에게는 「채널 나가기」가 없다 — 서버가 403 으로 막는 막다른 길', () => {
    expect(keys(target({selfRole: 'member'}))).not.toContain('leave');
    expect(keys(target({selfRole: 'guest'}))).not.toContain('leave');
    expect(keys(target({selfRole: 'owner'}))).toContain('leave');
    // 역할을 모르면 내놓고 서버가 답한다(코어 규칙).
    expect(keys(target({selfRole: undefined}))).toContain('leave');
  });

  it('나가기는 위험 톤이고 마지막이다', () => {
    const items = channelRowActionItems(target());
    expect(items[items.length - 1]).toMatchObject({key: 'leave', tone: 'danger', label: CHANNEL_LEAVE_LABEL});
  });

  it('복사 무리만 제목(「복사」)을 달고, 무리가 바뀌는 자리에만 구분선이 선다', () => {
    const items = channelRowActionItems(target());
    expect(items.map(item => item.separatorBefore)).toEqual([
      false, // copy-name (첫 항목은 선을 이지 않는다)
      false,
      false,
      true, // mark-read: 복사 → 상태
      false, // mute
      true, // leave: 상태 → 나가기
    ]);
    expect(items[0].cluster).toBe('copy');
    // 제목 낱말은 코어 상수다.
    expect(CHANNEL_COPY_GROUP_LABEL).toBe('복사');
  });
});

describe('DM 행', () => {
  it('나가기가 없다 — DM 은 멤버십을 지워 닫는 것이 아니다', () => {
    expect(keys(target({kind: 'dm'}))).toEqual([
      'copy-name',
      'copy-link',
      'copy-id',
      'mark-read',
      'mute',
    ]);
  });
});

describe('죽은 항목이 없다', () => {
  const roles: (MembershipRole | undefined)[] = ['owner', 'admin', 'member', 'guest', undefined];
  const reads: (ReadState | null)[] = [
    null,
    read(),
    read({lastReadSeq: 12, unreadCount: 0}),
    read({latestSeq: 0, lastReadSeq: 0, unreadCount: 0}),
  ];

  it('어떤 입력에서도 폰이 실행할 줄 아는 열쇠만 나온다', () => {
    const seen = new Set<string>();
    for (const kind of ['public', 'private', 'dm'] as const) {
      for (const selfRole of roles) {
        for (const readState of reads) {
          for (const muted of [false, true]) {
            for (const item of channelRowActionItems(
              target({kind, selfRole, readState, muted}),
            )) {
              seen.add(item.key);
              expect(PHONE_CHANNEL_ACTION_KEYS.has(item.key)).toBe(true);
            }
          }
        }
      }
    }
    // 실행할 줄 아는 일곱 가지가 모두 어딘가에서는 나온다 — 허용 목록이 헛돌지 않는다.
    expect([...seen].sort()).toEqual([...PHONE_CHANNEL_ACTION_KEYS].sort());
  });

  it('별표·섹션 이동·DM 닫기·주제·기억·GitHub 는 어떤 입력에서도 폰 시트에 없다', () => {
    for (const kind of ['public', 'private', 'dm'] as const) {
      const k = keys(target({kind}));
      for (const absent of ['star', 'move-to-section', 'close-dm', 'topic', 'memory', 'github']) {
        expect(k).not.toContain(absent);
      }
    }
  });
});

describe('VoiceOver 로터는 시트와 같은 배열이다', () => {
  it('항목 하나마다 동작 하나, 이름·차례·낱말이 같다', () => {
    const items = channelRowActionItems(target());
    const actions = channelRowAccessibilityActions(items);
    expect(actions.map(action => action.label)).toEqual(items.map(item => item.label));
    expect(actions.map(action => channelRowActionKeyOf(action.name))).toEqual(
      items.map(item => item.key),
    );
  });

  it('모르는 동작 이름은 아무 열쇠도 아니다', () => {
    expect(channelRowActionKeyOf('activate')).toBeNull();
    expect(channelRowActionKeyOf('momoChannel:close-dm')).toBeNull();
    expect(channelRowActionKeyOf('momoChannel:star')).toBeNull();
  });
});

describe('읽음 광고의 사유 (ADR-0178 D6)', () => {
  it('시트의 읽음 처리는 명시 열람이다', () => {
    expect(readIntentWire('mark_read_menu')).toBe('explicit_open');
  });

  it('「읽지 않음으로 표시」는 판별자를 싣지 않는다 — 실으면 마크를 건 같은 tx 가 마크를 지운다', () => {
    expect(readIntentWire('mark_unread')).toBeUndefined();
  });
});
