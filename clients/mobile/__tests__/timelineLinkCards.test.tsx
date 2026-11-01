import type {Message, RosterMember} from '@momo/core/lib/api';
import type {MessageUnfurl, UnfurlMap} from '@momo/core/features/timeline/unfurl';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {Dimensions} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {Timeline} from '../src/features/conversation/Timeline';
import {resetUnfurlImagesForTest} from '../src/features/conversation/unfurlImage';

// =============================================================================
// 목록이 줄마다 자기 메시지의 링크 카드를 건네고, 사이트 아이콘은 **목록이 「이 줄이 보인다」고 알린 뒤**에만 받는다
// (#4883, ADR-0170 증보 D9).
//
// 가상화 목록의 마운트됨은 보임이 아니다(열 화면 위의 줄도 마운트돼 있다). 폰에는 `IntersectionObserver` 가 없으므로
// 신호는 `FlatList` 의 `onViewableItemsChanged` 이고, 그것을 거는 표면은 필이 있는 대화뿐이다(`unreadJumpPills.test.tsx`
// 「필을 켜지 않은 표면」이 스레드·하네스에 그 콜백이 없음을 잠근다). 그래서 두 표면의 규칙은 이렇다:
//   필이 있는 대화   그림은 줄이 서면 바로, 아이콘은 목록이 그 줄을 보인다고 알린 뒤
//   스레드·하네스    목록이 보임을 모르므로 아이콘도 마운트 때(짧은 목록이라 마운트됨이 보임에 가깝다)
// 목록이 아이콘 요청의 문을 열어 주는 배선(`Timeline` 의 제공자 + 콜백)을 여기서 잰다 — 카드 쪽 문 자체는
// `unfurlCards.test.tsx` 가 잰다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;
const ICON_PATH = '/v1/workspaces/ws/unfurls/u1/icon';
const BASE_WINDOW = Dimensions.get('window');

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(seq: number, body: string): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}

const PLAIN = message(1, '링크 없는 말');
const LINKED = message(2, '이거 보세요 https://example.com/post');
const OTHER_LINKED = message(3, '저건 https://example.com/other');

function card(messageId: string, over: Partial<MessageUnfurl> = {}): MessageUnfurl {
  return {
    id: `u-${messageId}`,
    messageId,
    url: 'https://example.com/post',
    status: 'ok',
    title: `${messageId} 제목`,
    domain: 'example.com',
    ...over,
  };
}

const UNFURLS: UnfurlMap = {
  [LINKED.id]: [card(LINKED.id, {iconUrl: ICON_PATH})],
  [OTHER_LINKED.id]: [card(OTHER_LINKED.id, {url: 'https://example.com/other'})],
};

let requests: string[] = [];

function mount(over: {jumpPills: boolean; unfurls?: UnfurlMap}) {
  return render(
    <Timeline
      messages={[PLAIN, LINKED, OTHER_LINKED]}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS}
      lastReadSeq={null}
      unreadCount={0}
      jumpPills={over.jumpPills}
      unfurls={over.unfurls ?? UNFURLS}
    />,
  );
}

const list = () => screen.getByTestId('timeline-list');

/** 목록이 「이 행들이 보인다」고 보고한다. */
function reportVisible(...keys: string[]) {
  const data = list().props.data as {key: string}[];
  const viewableItems = data
    .map((item, index) => ({item, key: item.key, index, isViewable: true}))
    .filter(token => keys.includes(token.key));
  act(() => {
    list().props.onViewableItemsChanged({viewableItems, changed: viewableItems});
  });
}

async function settled() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  const window = {...BASE_WINDOW, fontScale: 1};
  Dimensions.set({window, screen: window});
  requests = [];
  resetUnfurlImagesForTest(async imageUrl => {
    requests.push(imageUrl);
    return 'data:image/png;base64,AAAA';
  });
});
afterEach(() => {
  cleanup();
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
  resetUnfurlImagesForTest();
});

describe('목록이 줄마다 자기 카드를 건넨다', () => {
  it('카드는 자기 메시지의 줄에만 서고, 링크 없는 줄에는 서지 않는다', async () => {
    mount({jumpPills: true});
    await settled();
    expect(screen.getAllByTestId('unfurl-card')).toHaveLength(2);
    const rows = screen.getAllByTestId('message-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).queryByTestId('unfurl-card')).toBeNull();
    expect(within(rows[1]).getByTestId('unfurl-title')).toHaveTextContent('msg-2 제목');
    expect(within(rows[2]).getByTestId('unfurl-title')).toHaveTextContent('msg-3 제목');
  });

  it('카드 지도가 없으면(`unfurls` 를 안 주는 표면) 카드는 그려지지 않는다', async () => {
    render(
      <Timeline
        messages={[PLAIN, LINKED]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS}
        lastReadSeq={null}
        unreadCount={0}
        jumpPills
      />,
    );
    await settled();
    expect(screen.queryByTestId('unfurl-card')).toBeNull();
  });

  it('한 메시지의 카드만 새로 오면 그 줄만 바뀐다 — 지도 전체를 바꿔도 다른 줄은 같은 것을 그린다', async () => {
    const view = mount({jumpPills: true});
    await settled();
    expect(screen.getAllByTestId('unfurl-card')).toHaveLength(2);
    // 두 번째 메시지의 카드가 지워졌다(묘비). 첫 카드 줄은 그대로다.
    view.rerender(
      <Timeline
        messages={[PLAIN, LINKED, OTHER_LINKED]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS}
        lastReadSeq={null}
        unreadCount={0}
        jumpPills
        unfurls={{...UNFURLS, [OTHER_LINKED.id]: []}}
      />,
    );
    await settled();
    expect(screen.getAllByTestId('unfurl-card')).toHaveLength(1);
    expect(screen.getByTestId('unfurl-title')).toHaveTextContent('msg-2 제목');
  });
});

describe('사이트 아이콘은 줄이 보인다고 목록이 알린 뒤에', () => {
  it('필이 있는 대화: 보이기 전에는 요청이 없고, 그 줄이 보인다고 하면 한 번 요청한다', async () => {
    mount({jumpPills: true});
    await settled();
    expect(requests).toEqual([]);
    // 다른 줄이 보이는 것은 이 줄의 아이콘을 켜지 않는다.
    reportVisible('m-1');
    await settled();
    expect(requests).toEqual([]);
    reportVisible('m-2');
    await waitFor(() => expect(requests).toEqual([ICON_PATH]));
    // 화면을 떠났다 돌아와도 다시 묻지 않는다.
    reportVisible('m-1');
    reportVisible('m-2');
    await settled();
    expect(requests).toEqual([ICON_PATH]);
  });

  it('방을 옮기면 「보였다」가 비워진다 — 줄 키(m-<seq>)가 방마다 겹쳐도 새 방의 줄은 보이기 전에 켜지지 않는다', async () => {
    const view = mount({jumpPills: true});
    await settled();
    reportVisible('m-2');
    await waitFor(() => expect(requests).toEqual([ICON_PATH]));

    // 같은 seq(= 같은 줄 키)를 가진 다른 방. 아이콘 경로만 다르다.
    const OTHER_ICON = '/v1/workspaces/ws/unfurls/u2/icon';
    const roomB = (messages: Message[]) => messages.map(m => ({...m, channelId: 'ch-b', id: `b-${m.seq}`}));
    const bMessages = roomB([PLAIN, LINKED, OTHER_LINKED]);
    view.rerender(
      <Timeline
        messages={bMessages}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS}
        lastReadSeq={null}
        unreadCount={0}
        jumpPills
        unfurls={{
          'b-2': [card('b-2', {iconUrl: OTHER_ICON})],
        }}
      />,
    );
    await settled();
    expect(requests).toEqual([ICON_PATH]);
    reportVisible('m-2');
    await waitFor(() => expect(requests).toEqual([ICON_PATH, OTHER_ICON]));
  });

  it('필이 없는 표면(스레드·하네스): 목록에 보임 콜백이 없고 아이콘은 마운트 때 켜진다', async () => {
    mount({jumpPills: false});
    expect(list().props.onViewableItemsChanged).toBeUndefined();
    await waitFor(() => expect(requests).toEqual([ICON_PATH]));
  });
});
