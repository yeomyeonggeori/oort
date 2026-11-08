import 'react-native-url-polyfill/auto';
import React from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import * as api from '@momo/core/lib/api';
import type {Message} from '@momo/core/lib/api';
import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {createExpressionFixtureServer, type ExpressionFixtureRequest} from '@momo/core/features/expressions/fixtureServer';
import {FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import {DEFAULT_EXPRESSION_PICKER_TAB} from '@momo/core/features/expressions/kind';
import type {Expression} from '@momo/core/features/expressions/types';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {rememberEmojiCatalog} from '../src/features/emoji/catalogMemory';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {ExpressionKeyboardPanel, resetPanelTab} from '../src/features/expressions/ExpressionKeyboardPanel';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {createPhoneExpressionStore, type PhoneExpressionStore} from '../src/features/expressions/store';
import {__setNonSecretStore, type NonSecretStore} from '../src/storage/kv';
import {pinReduceMotion} from './fixtures/reduceMotion';

jest.mock('../src/features/emoji/catalog', () => ({loadPhoneEmojiCatalog: jest.fn()}));
jest.mock('../src/lib/haptics', () => ({haptics: {event: jest.fn(), light: jest.fn()}}));
// 그림 부품은 자리만 선다: 이 시험은 고르개의 구조(탭·고른 뒤의 일)를 잰다. 그림 칸 자체는 `expressionImageStable.test` 의 몫이다.
jest.mock('../src/features/expressions/ExpressionImage', () => {
  const {View} = require('react-native');
  return {ExpressionImage: ({expression, size}: {expression: {name: string}; size: string}) => <View testID={`img-${size}-${expression.name}`} />};
});

// =============================================================================
// 반응 고르개 (#5504, owner 2026-11-07: GIF·이모티콘도 반응으로) - 폰도 웹처럼 세 탭(이모티콘 · 이모지 · GIF)이고 처음은 이모지다.
// 진짜 부품: `MessageActionSheet`(「＋」 → 고르개)·`ReactionPicker`·`ExpressionKeyboardPanel`·`ExpressionPanelGrid`·`TeamEmojiRow`·`EmojiPicker` 본문·폰 저장소.
// 가짜: 서버(코어 fixture)·표준 이모지 목록·그림 부품. 약속: 고르면 그 표현이 **반응 하나**로 달리고(`onToggleReaction` 한 번, `:이름:` 그대로) 큰 그림 메시지는 보내지 않는다.
// =============================================================================

const PNG = FIXTURE_MEDIA.png.image;
const GIF_MEDIA = FIXTURE_EXPRESSIONS[1].media!;
const PNG_MEDIA = {...GIF_MEDIA, small: {...PNG}, large: {...PNG}};
const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;

let serial = 0;
function item(name: string, tags: string[], shelf: 'emoticon' | 'gif' | 'team'): Expression {
  serial += 1;
  return {
    ...FIXTURE_EXPRESSIONS[2],
    id: `00000000-0000-4000-8000-0000000004${String(serial).padStart(2, '0')}`,
    name,
    displayName: tags[tags.length - 1],
    tags,
    kind: shelf === 'team' ? 'emoji' : 'sticker',
    media: shelf === 'emoticon' ? PNG_MEDIA : GIF_MEDIA,
  };
}
const makeLibrary = () => {
  serial = 0;
  return [
    item('chi_yay', ['치이카와', '야호'], 'emoticon'),
    item('chi_cry', ['치이카와', '엉엉'], 'emoticon'),
    item('nya_dance', ['냥코', '춤'], 'gif'),
    item('nya_jump', ['냥코', '점프'], 'gif'),
    item('party_parrot', ['축하', '앵무새'], 'team'),
  ];
};

const party: CatalogEmoji = {glyph: '🎉', name: 'party popper', koreanName: '축하', shortcodes: ['tada'], keywords: [], category: 'activity', version: 1};

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;

function memoryKv(): NonSecretStore {
  const map = new Map<string, string>();
  return {
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => void map.delete(key),
  } as unknown as NonSecretStore;
}

/** `library.items` 를 시험이 바꾸면 다음 목록 읽기부터 그 목록이다(고르는 사이 숨겨진 경우). */
function makeStore() {
  const library = {items: makeLibrary()};
  const server = createExpressionFixtureServer();
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    const response = server.request(input);
    if (input.method === 'GET' && input.path.split('?')[0] === base) {
      const json = response.json as {items?: Expression[]} | undefined;
      return json?.items ? {...response, json: {...json, items: library.items}} : response;
    }
    return response;
  });
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    {write: jest.fn((key: string) => `file:///fixture/${key}`), remove: jest.fn()},
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  return {store, library, request};
}

function sheet(store: PhoneExpressionStore, over: Partial<{onToggleReaction: jest.Mock; onClose: jest.Mock}> = {}) {
  const onToggleReaction = over.onToggleReaction ?? jest.fn();
  const onClose = over.onClose ?? jest.fn();
  const view = render(
    <PhoneExpressions.Provider value={store}>
      <MessageActionSheet
        message={{id: 'msg', authorMemberId: 'self', body: '금요일 배포', createdAtMs: 0} as Message}
        chips={[]}
        availability={{react: true, reply: false, quote: false, pin: false, edit: false, delete: false}}
        authorLabel="기획팀"
        onClose={onClose}
        onToggleReaction={onToggleReaction}
        onReply={jest.fn()}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
      />
    </PhoneExpressions.Provider>,
  );
  return {onToggleReaction, onClose, view};
}
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
async function openPicker() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('all-reactions'));
  });
  await screen.findByTestId('expression-panel');
}
const selectedTab = () =>
  (['emoticon', 'emoji', 'gif'] as const).filter(id => screen.getByTestId(`expression-panel-tab-${id}`).props.accessibilityState.selected);

beforeEach(async () => {
  release = await pinReduceMotion(true);
  __setNonSecretStore(memoryKv());
  resetPanelTab();
  (loadPhoneEmojiCatalog as jest.Mock).mockResolvedValue([party]);
  rememberEmojiCatalog([party]);
  emojiFrequency.reset();
  emojiSkinTone.reset();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  release?.();
  release = undefined;
  jest.restoreAllMocks();
});

describe('반응 고르개: 세 탭, 처음은 이모지', () => {
  it('「＋」를 누르면 이모티콘 · 이모지 · GIF 세 탭이 서고 처음 고른 탭은 이모지다(표준 목록 + 팀 이모지 줄)', async () => {
    const {store} = makeStore();
    await act(async () => store.refresh(true));
    sheet(store);
    await openPicker();
    const tabs = within(screen.getByTestId('expression-panel-tabs')).getAllByRole('tab');
    expect(tabs.map(tab => tab.props.testID)).toEqual(['expression-panel-tab-emoticon', 'expression-panel-tab-emoji', 'expression-panel-tab-gif']);
    expect(selectedTab()).toEqual(['emoji']);
    expect(DEFAULT_EXPRESSION_PICKER_TAB).toBe('emoticon'); // 입력창 창은 이모티콘부터다 - 반응만 이모지부터 연다.
    expect(await screen.findByTestId('expression-panel-emoji')).toBeTruthy();
    expect(await screen.findByTestId('emoji-pick-🎉')).toBeTruthy();
    expect(screen.getByTestId('team-emoji-row')).toBeTruthy();
    expect(screen.queryByTestId('expression-panel-grid')).toBeNull();
    // 예전 시트의 머리·검색 칸은 그대로다.
    expect(screen.getByTestId('emoji-picker-close')).toBeTruthy();
    expect(screen.getByTestId('emoji-search')).toBeTruthy();
  });

  it('이모티콘·GIF 탭은 그림 격자와 세트 띠이고, 칸에는 글이 없다', async () => {
    const {store} = makeStore();
    await act(async () => store.refresh(true));
    sheet(store);
    await openPicker();
    await act(async () => {
      fireEvent.press(screen.getByTestId('expression-panel-tab-gif'));
    });
    expect(selectedTab()).toEqual(['gif']);
    expect(screen.getByTestId('expression-panel-grid')).toBeTruthy();
    expect(screen.getByTestId('expression-pick-nya_dance')).toBeTruthy();
    expect(screen.getByTestId('expression-pick-nya_jump')).toBeTruthy();
    expect(screen.queryByTestId('expression-pick-chi_cry')).toBeNull();
    expect(screen.getByTestId('expression-panel-strip')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('expression-panel-tab-emoticon'));
    });
    expect(screen.getByTestId('expression-pick-chi_cry')).toBeTruthy();
    expect(screen.queryByTestId('expression-pick-nya_dance')).toBeNull();
  });

  it('반응 고르개에서 탭을 옮겨도 입력창 이모티콘 창이 기억한 탭은 바뀌지 않는다', async () => {
    const {store} = makeStore();
    await act(async () => store.refresh(true));
    const {view} = sheet(store);
    await openPicker();
    await act(async () => {
      fireEvent.press(screen.getByTestId('expression-panel-tab-gif'));
    });
    view.unmount();
    render(
      <PhoneExpressions.Provider value={store}>
        <ExpressionKeyboardPanel previewId={null} onPickBig={jest.fn()} onInsertText={jest.fn()} onInsertToken={jest.fn()} />
      </PhoneExpressions.Provider>,
    );
    expect(selectedTab()).toEqual([DEFAULT_EXPRESSION_PICKER_TAB]);
  });
});

describe('반응 고르개: 고르면 반응 하나가 달리고 메시지는 보내지 않는다', () => {
  async function expectOneReaction(pick: () => Promise<void> | void, expected: string, tab?: 'emoticon' | 'gif') {
    const sendMessage = jest.spyOn(api, 'sendMessage');
    const {store, request} = makeStore();
    await act(async () => store.refresh(true));
    const {onToggleReaction, onClose} = sheet(store);
    await openPicker();
    if (tab) {
      await act(async () => {
        fireEvent.press(screen.getByTestId(`expression-panel-tab-${tab}`));
      });
    }
    const writes = () => request.mock.calls.filter(([input]) => input.method !== 'GET').length;
    const before = writes();
    await act(async () => {
      await pick();
    });
    await waitFor(() => expect(onToggleReaction).toHaveBeenCalledTimes(1));
    // 반응 요청 한 건: 고른 표현 그대로(`:이름:`, 표준 그림 문자는 글자 그대로) - 와이어는 바뀌지 않는다.
    expect(onToggleReaction).toHaveBeenCalledWith(expected);
    expect(onClose).toHaveBeenCalledTimes(1);
    // 메시지 전송 0: 미리 보기·보내기 단추가 한 번도 서지 않았고, 메시지 API 도, 보관함 쓰기 요청도 없다.
    expect(screen.queryByTestId('expression-send-preview')).toBeNull();
    expect(screen.queryByTestId('expression-confirm-send')).toBeNull();
    expect(screen.queryByTestId('composer-expression-preview')).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
  }

  it('GIF 를 고르면 그 GIF 가 `:이름:` 반응으로 달린다', async () => {
    await expectOneReaction(() => fireEvent.press(screen.getByTestId('expression-pick-nya_dance')), ':nya_dance:', 'gif');
  });

  it('이모티콘을 고르면 `:이름:` 반응으로 달린다', async () => {
    await expectOneReaction(() => fireEvent.press(screen.getByTestId('expression-pick-chi_cry')), ':chi_cry:', 'emoticon');
  });

  it('이모지 탭의 팀 이모지 줄에서 고르면 `:이름:` 반응으로 달린다', async () => {
    await expectOneReaction(async () => {
      fireEvent.press(await screen.findByTestId('expression-pick-party_parrot'));
    }, ':party_parrot:');
  });

  it('이모지 탭의 표준 그림 문자를 고르면 글자 그대로 반응이 된다', async () => {
    await expectOneReaction(async () => {
      fireEvent.press(await screen.findByTestId('emoji-pick-🎉'));
    }, '🎉');
  });
});

describe('반응 고르개: 고르는 사이 사라진 표현', () => {
  it('고른 순간 다시 읽어 숨겨졌으면 반응을 달지 않고 한 문장으로 말하고, 시트는 그대로다', async () => {
    const {store, library} = makeStore();
    await act(async () => store.refresh(true));
    const {onToggleReaction, onClose} = sheet(store);
    await openPicker();
    await act(async () => {
      fireEvent.press(screen.getByTestId('expression-panel-tab-gif'));
    });
    // 다른 곳에서 신고·삭제되어 다음 목록에 없다.
    library.items = library.items.filter(entry => entry.name !== 'nya_dance');
    await act(async () => {
      fireEvent.press(screen.getByTestId('expression-pick-nya_dance'));
    });
    await settle();
    expect(await screen.findByTestId('reaction-picker-unavailable')).toBeTruthy();
    expect(onToggleReaction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('expression-panel')).toBeTruthy();
    // 다른 표현은 이어서 고를 수 있다.
    await act(async () => {
      fireEvent.press(screen.getByTestId('expression-pick-nya_jump'));
    });
    await waitFor(() => expect(onToggleReaction).toHaveBeenCalledWith(':nya_jump:'));
  });
});

describe('반응 고르개: 검색 칸 하나가 세 탭을 모두 거른다', () => {
  it('글자를 치면 현재 탭의 결과만 남고, 맞는 게 없으면 한 문장이다', async () => {
    const {store} = makeStore();
    await act(async () => store.refresh(true));
    sheet(store);
    await openPicker();
    await act(async () => {
      fireEvent.press(screen.getByTestId('expression-panel-tab-gif'));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('emoji-search'), 'jump');
    });
    expect(screen.getByTestId('expression-pick-nya_jump')).toBeTruthy();
    expect(screen.queryByTestId('expression-pick-nya_dance')).toBeNull();
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('emoji-search'), '없는이름');
    });
    expect(screen.queryByTestId('expression-pick-nya_jump')).toBeNull();
    expect(screen.getByTestId('expression-panel-empty')).toBeTruthy();
  });
});
