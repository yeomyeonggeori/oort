import type {Message, RosterMember} from '@momo/core/lib/api';
import type {MessageUnfurl} from '@momo/core/features/timeline/unfurl';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';
import {Linking, Share} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {setLinkPreviewPreference} from '../src/features/conversation/linkPreviewPreference';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import {resetUnfurlImagesForTest} from '../src/features/conversation/unfurlImage';

// =============================================================================
// 행 안의 링크 카드 (#4883) — 행은 카드를 **놓을 자리·낭독·로터·시트**만 맡는다.
//
// 이 행은 접근성 원소 하나다. 카드 안의 `Pressable` 라벨은 VoiceOver 에 닿지 않으므로, 「링크 미리보기: 제목, 도메인」은 행의
// 낭독 문장에 실리고 로터에 카드마다 「열기」가 오른다. 손가락은 카드를 눌러 열고, 길게 눌러 링크 시트(복사·공유·작성자만
// 「미리보기 지우기」)를 연다 — 행 전체의 길게 누르기(메시지 액션 시트)와 다른 문이다.
// =============================================================================

const clipboard = jest.requireMock('expo-clipboard') as {__box: {value: string | null}};
const mmkv = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;
const URL = 'https://example.com/post';

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

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 7,
    hlcTs: 7,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `이거 보세요 ${URL}`,
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

function card(over: Partial<MessageUnfurl> = {}): MessageUnfurl {
  return {
    id: 'u1',
    messageId: 'msg-1',
    url: URL,
    status: 'ok',
    title: '배포 후기',
    description: '세 번째 시도에서 드디어 성공한 이야기',
    domain: 'example.com',
    ...over,
  };
}

function actions(over: Partial<MessageRowActions> = {}): MessageRowActions {
  return {
    myMemberId: SELF,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    ...over,
  };
}

function row(
  over: {
    message?: Message;
    unfurls?: readonly MessageUnfurl[];
    actions?: MessageRowActions | undefined;
  } = {},
) {
  return (
    <MessageRow
      message={over.message ?? message()}
      startsGroup
      directory={DIRECTORY}
      chips={[]}
      nowMs={BASE_MS}
      unfurls={'unfurls' in over ? over.unfurls : [card()]}
      actions={'actions' in over ? over.actions : actions()}
    />
  );
}

const rotor = (): {name: string; label: string}[] =>
  screen.getByTestId('message-row').props.accessibilityActions ?? [];

function invoke(name: string): void {
  fireEvent(screen.getByTestId('message-row'), 'accessibilityAction', {
    nativeEvent: {actionName: name},
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openLinkSheet() {
  fireEvent(screen.getByTestId('unfurl-card'), 'longPress');
  await screen.findByTestId('link-action-sheet');
}

beforeEach(() => {
  mmkv.clear();
  clipboard.__box.value = null;
  resetUnfurlImagesForTest(async () => 'data:image/png;base64,AAAA');
});
afterEach(() => {
  cleanup();
  resetUnfurlImagesForTest();
  jest.restoreAllMocks();
});

describe('카드의 자리와 낭독', () => {
  it('카드는 본문 아래에 서고, 행의 낭독 문장과 로터에 같은 이름이 실린다', () => {
    render(row());
    expect(screen.getByTestId('unfurl-card')).toBeTruthy();
    const spoken = screen.getByTestId('message-row').props.accessibilityLabel as string;
    expect(spoken).toContain('링크 미리보기: 배포 후기, example.com');
    // 로터: 카드마다 「열기」(이름이 곧 낭독 문장) 하나, 그리고 시트 하나.
    const open = rotor().filter(action => action.name.startsWith('momoUnfurlOpen:'));
    expect(open).toEqual([
      {name: 'momoUnfurlOpen:0', label: '링크 미리보기: 배포 후기, example.com'},
    ]);
    expect(rotor().some(action => action.name === 'momoUnfurlMenu')).toBe(true);
  });

  it('로터의 「열기」는 그 카드의 링크를 연다', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    render(
      row({
        unfurls: [
          card(),
          card({id: 'u2', url: 'https://example.com/second', title: '두 번째'}),
        ],
      }),
    );
    invoke('momoUnfurlOpen:1');
    expect(open).toHaveBeenCalledWith('https://example.com/second');
  });

  it('카드가 없는 행에는 카드 관련 낭독도 로터도 없다', () => {
    render(row({unfurls: []}));
    expect(screen.queryByTestId('unfurl-group')).toBeNull();
    expect(screen.getByTestId('message-row').props.accessibilityLabel).not.toContain('링크 미리보기');
    expect(rotor().filter(action => action.name.startsWith('momoUnfurl'))).toEqual([]);
  });

  it('「끄기」면 카드도 낭독도 로터도 없다 — 본문의 링크만 남는다', () => {
    setLinkPreviewPreference('off');
    render(row());
    expect(screen.queryByTestId('unfurl-group')).toBeNull();
    expect(screen.getByTestId('message-row').props.accessibilityLabel).not.toContain('링크 미리보기');
    expect(rotor().filter(action => action.name.startsWith('momoUnfurl'))).toEqual([]);
  });

  it('지워진 메시지(묘비)에는 카드가 없다', () => {
    render(row({message: message({state: 'deleted', body: undefined})}));
    expect(screen.queryByTestId('unfurl-group')).toBeNull();
    expect(screen.getByTestId('message-row').props.accessibilityLabel).not.toContain('링크 미리보기');
  });

  it('카드가 서버에서 바뀌면(투영 배열이 새것) 그 행이 다시 그려진다', () => {
    const {rerender} = render(row({unfurls: []}));
    expect(screen.queryByTestId('unfurl-card')).toBeNull();
    rerender(row({unfurls: [card()]}));
    expect(screen.getByTestId('unfurl-card')).toBeTruthy();
    rerender(row({unfurls: []}));
    expect(screen.queryByTestId('unfurl-card')).toBeNull();
  });
});

describe('길게 누르면 링크 시트 — 복사 · 공유', () => {
  it('카드를 길게 누르면 메시지 액션 시트가 아니라 링크 시트가 선다', async () => {
    render(row());
    await openLinkSheet();
    expect(screen.getByTestId('link-sheet-domain')).toHaveTextContent('example.com');
    expect(screen.getByTestId('link-sheet-title')).toHaveTextContent('배포 후기');
    expect(screen.queryByTestId('message-action-sheet')).toBeNull();
  });

  it('복사는 그 링크 주소를 클립보드에 넣고 그 행에 「링크 복사됨」을 말한다', async () => {
    render(row());
    await openLinkSheet();
    fireEvent.press(screen.getByTestId('link-sheet-copy'));
    await waitFor(() => expect(clipboard.__box.value).toBe(URL));
    await waitFor(() => expect(screen.getByText('링크 복사됨')).toBeTruthy());
  });

  it('공유는 시스템 공유 시트에 그 링크를 넘긴다', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({action: 'dismissedAction'});
    render(row());
    await openLinkSheet();
    fireEvent.press(screen.getByTestId('link-sheet-share'));
    await waitFor(() => expect(share).toHaveBeenCalledWith({url: URL}));
  });

  it('작성자가 아니면 「미리보기 지우기」가 없다 — 서버가 403 으로 지키는 규칙을 화면이 먼저 지킨다', async () => {
    render(row({actions: actions({onRemoveUnfurls: async () => {}})}));
    await openLinkSheet();
    expect(screen.getByTestId('link-sheet-copy')).toBeTruthy();
    expect(screen.queryByTestId('link-sheet-remove')).toBeNull();
  });
});

describe('작성자의 「미리보기 지우기」 — 확인 창 뒤에 모두에게서', () => {
  const mine = () => message({authorMemberId: SELF});

  it('지우기 행 → 확인 단계(모두에게서 지워진다고 말한다) → 확인하면 그 메시지로 지운다', async () => {
    const onRemoveUnfurls = jest.fn(async () => {});
    render(row({message: mine(), actions: actions({onRemoveUnfurls})}));
    await openLinkSheet();
    fireEvent.press(screen.getByTestId('link-sheet-remove'));
    expect(screen.getByTestId('link-remove-step-headline')).toHaveTextContent(
      '링크 미리보기를 지울까요?',
    );
    expect(screen.getByTestId('link-remove-step-detail').props.children).toMatch(/모두에게서/);
    // 확인 전에는 아무것도 지우지 않았다.
    expect(onRemoveUnfurls).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('link-remove-confirm'));
    await waitFor(() => expect(onRemoveUnfurls).toHaveBeenCalledTimes(1));
    expect(onRemoveUnfurls).toHaveBeenCalledWith(expect.objectContaining({id: 'msg-1'}));
    await waitFor(() => expect(screen.queryByTestId('link-action-sheet')).toBeNull());
  });

  it('취소하면 지우지 않고 목록으로 돌아온다', async () => {
    const onRemoveUnfurls = jest.fn(async () => {});
    render(row({message: mine(), actions: actions({onRemoveUnfurls})}));
    await openLinkSheet();
    fireEvent.press(screen.getByTestId('link-sheet-remove'));
    fireEvent.press(screen.getByTestId('link-remove-cancel'));
    expect(onRemoveUnfurls).not.toHaveBeenCalled();
    expect(screen.getByTestId('link-sheet-copy')).toBeTruthy();
  });

  it('실패하면 확인 단계 안에서 문장으로 말하고 시트를 닫지 않는다', async () => {
    const onRemoveUnfurls = jest.fn(async () => {
      throw new Error('403');
    });
    render(row({message: mine(), actions: actions({onRemoveUnfurls})}));
    await openLinkSheet();
    fireEvent.press(screen.getByTestId('link-sheet-remove'));
    fireEvent.press(screen.getByTestId('link-remove-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('link-remove-error')).toHaveTextContent(
        '링크 미리보기를 지우지 못했어요. 연결을 확인하고 다시 해 보세요.',
      ),
    );
    expect(screen.getByTestId('link-action-sheet')).toBeTruthy();
    await flush();
  });

  it('지울 길(`onRemoveUnfurls`)이 없는 표면에는 작성자에게도 지우기 행이 없다', async () => {
    render(row({message: mine(), actions: actions()}));
    await openLinkSheet();
    expect(screen.queryByTestId('link-sheet-remove')).toBeNull();
  });
});
