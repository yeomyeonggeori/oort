import 'react-native-url-polyfill/auto';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import {AppState, StyleSheet} from 'react-native';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
  type ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import {tokenizeExpressions} from '@momo/core/features/expressions/message';
import {searchExpressions} from '@momo/core/features/expressions/search';
import type {Expression} from '@momo/core/features/expressions/types';
import {
  emptyExpressionUsage,
  recordExpressionUse,
} from '@momo/core/features/expressions/usage';
import {Composer} from '../src/features/conversation/Composer';
import {CONV} from '../src/features/conversation/convDesign';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {
  ExpressionComposerModal,
  ExpressionComposerPicker,
} from '../src/features/expressions/ExpressionComposerPicker';
import {ExpressionImage} from '../src/features/expressions/ExpressionImage';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  browseExpressions,
  EXPRESSION_TABS,
  insertExpressionToken,
} from '../src/features/expressions/expressionViews';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {createMobileLocaleController} from '../src/i18n/controller';
import {haptics} from '../src/lib/haptics';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {pinReduceMotion} from './fixtures/reduceMotion';

jest.mock('../src/features/emoji/catalog', () => ({
  loadPhoneEmojiCatalog: jest.fn(),
}));
jest.mock('../src/lib/haptics', () => ({
  haptics: {event: jest.fn(), light: jest.fn()},
}));

// =============================================================================
// 입력창 표현 시트 (#4942, owner 10-31) — 보내기 왼쪽 단추 하나가 여는 네 탭 시트.
//
// 진짜 부품만 쓴다: 진짜 `Composer`·`PageSheet`·`EmojiPicker` 본문·`TeamExpressionPicker`·폰 저장소. 가짜는 서버(코어 fixture
// 서버)와 표준 이모지 목록(두 개)뿐이다. 코어 fixture 의 세 표현은 모두 움직이는 GIF 라서 GIF 보기가 거를 **정지 그림**이
// 있도록 엄지척 하나를 PNG 로 바꿔 내려 준다(`stillThumbs`).
//
// 이 파일이 잰다: 단추의 자리와 보임 · 네 탭과 검색 하나 · 보내기/넣기 규칙 · 탭 안 검색과 최근 먼저 · 움직이는 미리보기의
// 동작 줄이기 · 영어 사전. jest 가 못 재는 것(실제 폭·줄바꿈·낭독·키보드·캡처)은 인계의 「스택 검증 메모」다.
// =============================================================================

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const [parrot, jeol, thumbs] = FIXTURE_EXPRESSIONS;
const PNG = FIXTURE_MEDIA.png.image;

const waving: CatalogEmoji = {
  glyph: '👋',
  name: 'waving hand',
  koreanName: '손 흔들기',
  shortcodes: ['wave'],
  keywords: ['hello'],
  category: 'people',
  version: 1,
};
const party: CatalogEmoji = {
  glyph: '🎉',
  name: 'party popper',
  koreanName: '축하',
  shortcodes: ['tada'],
  keywords: [],
  category: 'activity',
  version: 1,
};

/** 서버 목록의 엄지척을 정지 그림(PNG)으로 바꾼다 — thumb 는 원래 PNG 라 그림 길은 그대로다. */
function stillThumbs(
  response: ExpressionFixtureResponse,
): ExpressionFixtureResponse {
  const json = response.json as {items?: Expression[]} | undefined;
  if (!json?.items) return response;
  return {
    ...response,
    json: {
      ...json,
      items: json.items.map(item =>
        item.id === thumbs.id && item.media
          ? {...item, media: {...item.media, small: {...PNG}, large: {...PNG}}}
          : item,
      ),
    },
  };
}

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;

function setup() {
  const server = createExpressionFixtureServer();
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    const response = server.request(input);
    return input.method === 'GET' && input.path.split('?')[0] === base
      ? stillThumbs(response)
      : response;
  });
  const files = {
    write: jest.fn((key: string) => `file:///fixture/${key}`),
    remove: jest.fn(),
  };
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    files,
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  return {store, request, server};
}

const handlers = () => ({
  onClose: jest.fn(),
  onInsert: jest.fn(),
  onInsertExpression: jest.fn(),
  onSend: jest.fn(),
});

/** 시트 하나를 진짜 그릇(`PageSheet`) 안에 선다. 동작 줄이기가 켜져 있으면 「닫고 나서 하기」가 바로 불린다. */
function openSheet(store: PhoneExpressionStore) {
  const h = handlers();
  render(
    <PhoneExpressions.Provider value={store}>
      <ExpressionComposerModal {...h} />
    </PhoneExpressions.Provider>,
  );
  return h;
}

async function loaded() {
  const made = setup();
  await made.store.refresh(true);
  return made;
}

const pressTab = (id: (typeof EXPRESSION_TABS)[number]) =>
  fireEvent.press(screen.getByTestId(`expression-sheet-tab-${id}`));
const cellNames = () =>
  screen
    .queryAllByTestId(/^expression-pick-/)
    .map(node => String(node.props.testID).replace('expression-pick-', ''));
const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<
    string,
    number | string | undefined
  >;

beforeEach(async () => {
  jest.clearAllMocks();
  release = await pinReduceMotion(true);
  AppState.currentState = 'active';
  (loadPhoneEmojiCatalog as jest.Mock).mockResolvedValue([waving, party]);
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
  jest.useRealTimers();
});

// ---- 순수: 같은 보관함의 보기 ---------------------------------------------------
describe('탭이 고르는 것 — 종류가 아니라 같은 보관함의 보기', () => {
  const items: Expression[] = [
    parrot,
    jeol,
    {...thumbs, media: {...thumbs.media!, small: {...PNG}, large: {...PNG}}},
  ];
  const ids = (list: Expression[]) => list.map(item => item.name);

  it('이모티콘·팀 이모지는 보관함 전체, GIF 는 움직이는 것만 — 빈 검색은 최근에 쓴 것이 먼저, 검색어가 있으면 관련도', () => {
    expect(ids(browseExpressions(items, 'emoticon', ''))).toEqual([
      'ki_jeol',
      'party_parrot',
      'thumbs_up',
    ]);
    expect(ids(browseExpressions(items, 'team', ''))).toEqual(
      ids(browseExpressions(items, 'emoticon', '')),
    );
    expect(ids(browseExpressions(items, 'gif', ''))).toEqual([
      'ki_jeol',
      'party_parrot',
    ]);

    // 최근 먼저: 파티 앵무새를 세 번(오래전), 엄지척을 한 번(방금) 썼다. 코어의 빈 검색은 **횟수** 순이라 앵무새가 앞이고(대조),
    // 이 시트는 **최근** 순이라 엄지척이 앞이다 — 둘이 갈리는 자료라야 「최근 먼저」를 잰다.
    let usage = emptyExpressionUsage(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID);
    for (const at of [1000, 1001, 1002]) usage = recordExpressionUse(usage, parrot.id, at);
    usage = recordExpressionUse(usage, thumbs.id, 5000);
    expect(ids(searchExpressions(items, '', usage))).toEqual([
      'party_parrot',
      'thumbs_up',
      'ki_jeol',
    ]);
    expect(ids(browseExpressions(items, 'emoticon', '', usage))).toEqual([
      'thumbs_up',
      'party_parrot',
      'ki_jeol',
    ]);
    // 방금 쓴 정지 그림도 GIF 보기에는 서지 않는다.
    expect(ids(browseExpressions(items, 'gif', '', usage))).toEqual([
      'party_parrot',
      'ki_jeol',
    ]);
    // 검색어가 있으면 거르고, 앞뒤 콜론은 이름 검색으로 읽는다.
    expect(ids(browseExpressions(items, 'emoticon', '엄지', usage))).toEqual([
      'thumbs_up',
    ]);
    expect(ids(browseExpressions(items, 'team', ':ki_jeol:', usage))).toEqual([
      'ki_jeol',
    ]);
  });

  it('입력칸에 넣는 토큰은 앞이 글자·주소여도 토큰으로 읽히게 띄우고, 뒤에 한 칸을 둔다', () => {
    expect(insertExpressionToken('', ':party_parrot:')).toBe(':party_parrot: ');
    expect(insertExpressionToken('안녕', ':party_parrot:')).toBe(
      '안녕 :party_parrot: ',
    );
    expect(insertExpressionToken('안녕 ', ':party_parrot:')).toBe(
      '안녕 :party_parrot: ',
    );
    // 주소 바로 뒤에 붙으면 코어가 토큰을 주소의 일부로 읽는다 — 띄우지 않으면 그림이 안 선다.
    const glued = tokenizeExpressions('http://x.com:party_parrot:', items);
    expect(glued.some(token => token.type === 'expression')).toBe(false);
    const spaced = tokenizeExpressions(
      insertExpressionToken('http://x.com', ':party_parrot:'),
      items,
    );
    expect(spaced.some(token => token.type === 'expression')).toBe(true);
  });
});

// ---- 시트 ---------------------------------------------------------------------
describe('표현 시트', () => {
  it('네 탭이 이 차례로 서고 맨 위 검색은 하나다 — 낭독 이름·선택 상태·탭마다 다른 검색 이름', async () => {
    const {store} = await loaded();
    openSheet(store);
    const tabs = screen.getByTestId('expression-sheet-tabs');
    expect(tabs.props.accessibilityRole).toBe('tablist');
    const labels = EXPRESSION_TABS.map(id => {
      const tab = screen.getByTestId(`expression-sheet-tab-${id}`);
      expect(tab.props.accessibilityRole).toBe('tab');
      return [id, tab.props.accessibilityLabel, tab.props.accessibilityState.selected];
    });
    expect(labels).toEqual([
      ['emoticon', '이모티콘', false],
      ['emoji', '이모지', true], // 처음 열 때: 옛 고르개가 열던 표준 이모지
      ['team', '팀 이모지', false],
      ['gif', 'GIF', false],
    ]);
    expect(within(tabs).getAllByRole('tab')).toHaveLength(4);
    // 검색은 시트에 하나 — 이모지 본문(`embedded`)은 제 검색 칸·「우리 팀」 탭·머리를 세우지 않는다.
    expect(screen.getAllByTestId('expression-sheet-search')).toHaveLength(1);
    expect(screen.queryByTestId('emoji-search')).toBeNull();
    expect(screen.queryByTestId('emoji-tab-team')).toBeNull();
    expect(screen.queryByTestId('emoji-picker-close')).toBeNull();
    expect(
      screen.getByTestId('expression-sheet-search').props.accessibilityLabel,
    ).toBe('이모지 검색');
    expect(
      screen.getByTestId('expression-sheet-close').props.accessibilityLabel,
    ).toBe('이모티콘·이모지·GIF 닫기');
    pressTab('team');
    expect(
      screen.getByTestId('expression-sheet-search').props.accessibilityLabel,
    ).toBe('팀 이모지 검색');
    expect(
      screen.getByTestId('expression-sheet-tab-team').props.accessibilityState
        .selected,
    ).toBe(true);
    expect(
      screen.getByTestId('expression-sheet-tab-emoji').props.accessibilityState
        .selected,
    ).toBe(false);
  });

  it('이모지 탭: 검색은 시트의 검색 하나가 걸러 주고, 고르면 입력칸에 넣는다(보내지 않는다)', async () => {
    const {store} = await loaded();
    const h = openSheet(store);
    // 처음 칸(자주 쓰는 것)에는 🎉 가 있고 👋 는 없다 — 검색어가 본문까지 닿아야 👋 만 남는다.
    await screen.findByTestId('emoji-pick-🎉');
    expect(screen.queryByTestId('emoji-pick-👋')).toBeNull();
    fireEvent.changeText(screen.getByTestId('expression-sheet-search'), '손 흔들기');
    await screen.findByTestId('emoji-pick-👋');
    expect(screen.queryByTestId('emoji-pick-🎉')).toBeNull();
    fireEvent.press(screen.getByTestId('emoji-pick-👋'));
    expect(h.onInsert).toHaveBeenCalledTimes(1);
    expect(h.onInsert).toHaveBeenCalledWith('👋');
    expect(h.onInsertExpression).not.toHaveBeenCalled();
    expect(h.onSend).not.toHaveBeenCalled();
  });

  // #5065 B1: 시트가 검색어를 쥐고 이모지 본문을 끼워 넣는데(`embedded`), 빈 결과의 「검색 지우기」가 본문 안의 상태만 비우면
  // 화면의 검색어와 결과는 그대로라 눌러도 아무 일도 없는 죽은 단추가 된다(#4942 의 끼워 넣기에서 생긴 결함). 독립 고르개의 같은
  // 단추는 `emojiPicker.test.tsx` 가 지킨다 — 여기서는 **시트의 검색 칸**과 **목록**이 눌림에 따라 돌아오는지를 렌더로 잰다.
  it('이모지 탭: 빈 결과의 「검색 지우기」를 누르면 시트의 검색어가 비고 목록이 돌아온다 (#5065)', async () => {
    const {store} = await loaded();
    openSheet(store);
    await screen.findByTestId('emoji-pick-🎉');
    fireEvent.changeText(screen.getByTestId('expression-sheet-search'), 'zzzz');
    // 아무것도 못 맞췄다: 격자가 비고, 빈 문장 아래에 지우기 단추가 서고, 검색 칸은 그대로 「zzzz」다.
    expect(screen.queryByTestId('emoji-pick-🎉')).toBeNull();
    expect(screen.getByTestId('emoji-empty')).toBeTruthy();
    expect(screen.getByTestId('expression-sheet-search').props.value).toBe('zzzz');
    fireEvent.press(screen.getByTestId('emoji-clear-search'));
    // 눌림이 화면에 닿았다: 시트의 검색 칸이 비고, 본문이 처음 칸(자주 쓰는 것)으로 돌아온다.
    expect(screen.getByTestId('expression-sheet-search').props.value).toBe('');
    await screen.findByTestId('emoji-pick-🎉');
    expect(screen.queryByTestId('emoji-empty')).toBeNull();
  });

  // #5065 M1·L1: 같은 검색어가 걸린 세 탭의 빈 결과 안내. 맨 `Text` 는 글자 단위로 끊어 「…검색해 보세 / 요.」(캡처 4942-…-017·019)가 됐고,
  // 이모지 탭만 합쇼체(「없습니다」)라 한 시트 안에서 말씨가 갈렸다. 렌더된 글자 노드의 줄바꿈 속성과 문장 끝(해요체)을 잰다.
  it('빈 결과 안내는 세 탭 모두 어절 단위로 줄바꿈하고 같은 말씨(해요체)로 끝난다 (#5065)', async () => {
    const {store} = await loaded();
    openSheet(store);
    await screen.findByTestId('emoji-pick-🎉');
    fireEvent.changeText(screen.getByTestId('expression-sheet-search'), 'zzzz');
    const emptyLines: string[] = [];
    const read = (container: string, sentence: string) => {
      const node = within(screen.getByTestId(container)).getByText(sentence);
      expect({container, breaks: node.props.lineBreakStrategyIOS}).toEqual({
        container,
        breaks: 'hangul-word',
      });
      emptyLines.push(sentence);
    };
    read('emoji-empty', '찾는 이모지가 없어요. 다른 이름으로 검색해 보세요.');
    pressTab('team');
    await screen.findByTestId('emoji-team-empty');
    read('emoji-team-empty', '찾는 표현이 없어요. 다른 이름이나 태그로 검색해 보세요.');
    pressTab('gif');
    read('emoji-team-empty', '찾는 표현이 없어요. 다른 이름이나 태그로 검색해 보세요.');
    // 말씨: 문장마다 「요.」로 끝난다 — 「…없습니다.」·「…하세요.」가 하나라도 섞이면 빨개진다.
    const sentences = emptyLines.flatMap(line => line.split(/(?<=\.)\s+/));
    expect(sentences.length).toBeGreaterThanOrEqual(6);
    expect(sentences.filter(sentence => !/요\.$/.test(sentence))).toEqual([]);
  });

  it('팀 이모지 탭: 고르면 `:이름:` 을 입력칸에 넣는다 — 미리보기도 보내기도 없다', async () => {
    const {store} = await loaded();
    const h = openSheet(store);
    pressTab('team');
    fireEvent.press(await screen.findByTestId('expression-pick-party_parrot'));
    await waitFor(() => expect(h.onInsertExpression).toHaveBeenCalledTimes(1));
    expect(h.onInsertExpression).toHaveBeenCalledWith(':party_parrot:');
    expect(screen.queryByTestId('expression-send-preview')).toBeNull();
    expect(h.onSend).not.toHaveBeenCalled();
    expect(h.onInsert).not.toHaveBeenCalled();
  });

  it('이모티콘 탭: 큰 그림을 먼저 보고 「보내기」를 눌러야 한 메시지로 간다 — 입력칸에는 안 들어간다', async () => {
    const {store} = await loaded();
    const h = openSheet(store);
    pressTab('emoticon');
    fireEvent.press(await screen.findByTestId('expression-pick-party_parrot'));
    expect(screen.getByTestId('expression-send-preview')).toBeTruthy();
    expect(h.onSend).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('expression-confirm-send'));
    await waitFor(() => expect(h.onSend).toHaveBeenCalledTimes(1));
    expect(h.onSend).toHaveBeenCalledWith(':party_parrot:');
    expect(h.onInsertExpression).not.toHaveBeenCalled();
    expect(h.onInsert).not.toHaveBeenCalled();
  });

  it('GIF 탭은 움직이는 것만 보이고 같은 방식으로 보낸다 — 「＋ 추가하기」는 이모티콘·팀 이모지 탭에만 있다', async () => {
    const {store} = await loaded();
    const h = openSheet(store);
    pressTab('emoticon');
    await screen.findByTestId('expression-pick-thumbs_up');
    expect(screen.getByTestId('expression-add-menu')).toBeTruthy();
    pressTab('team');
    expect(screen.getByTestId('expression-add-menu')).toBeTruthy();
    expect(cellNames()).toEqual(['ki_jeol', 'party_parrot', 'thumbs_up']);
    pressTab('gif');
    // 엄지척은 정지 그림(PNG) — 코어 fixture 의 나머지 둘만 움직인다.
    expect(cellNames()).toEqual(['ki_jeol', 'party_parrot']);
    expect(screen.queryByTestId('expression-add-menu')).toBeNull();
    fireEvent.press(screen.getByTestId('expression-pick-ki_jeol'));
    fireEvent.press(screen.getByTestId('expression-confirm-send'));
    await waitFor(() => expect(h.onSend).toHaveBeenCalledWith(':ki_jeol:'));
    expect(h.onInsertExpression).not.toHaveBeenCalled();
  });

  it('검색어는 탭을 옮겨도 남고 지금 탭 안에서만 거른다 — 최근에 쓴 것이 먼저다', async () => {
    const {store} = await loaded();
    // 앵무새를 세 번(오래전), 엄지척을 한 번(방금) 보냈다 — 횟수 순이면 앵무새가 앞이고 최근 순이면 엄지척이 앞이다.
    const now = jest.spyOn(Date, 'now');
    [1000, 1001, 1002].forEach((at, index) => {
      now.mockReturnValueOnce(at);
      store.recordSuccess(`message:parrot-${index}`, ':party_parrot:');
    });
    now.mockReturnValueOnce(5000);
    store.recordSuccess('message:thumbs', ':thumbs_up:');
    openSheet(store);
    pressTab('team');
    await screen.findByTestId('expression-pick-party_parrot');
    expect(cellNames()).toEqual(['thumbs_up', 'party_parrot', 'ki_jeol']);
    fireEvent.changeText(screen.getByTestId('expression-sheet-search'), '엄지');
    expect(cellNames()).toEqual(['thumbs_up']);
    // 같은 검색어가 다른 탭에도 걸려 있다 — GIF 탭에는 정지 그림인 엄지척이 없으니 비어 보인다.
    pressTab('gif');
    expect(cellNames()).toEqual([]);
    expect(screen.getByTestId('emoji-team-empty')).toBeTruthy();
    pressTab('emoticon');
    expect(cellNames()).toEqual(['thumbs_up']);
    expect(screen.getByTestId('expression-sheet-search').props.value).toBe(
      '엄지',
    );
  });

  it('움직이는 미리보기는 동작 줄이기에서 정지 그림이고, 꺼져 있으면 큰 그림을 불러 움직인다', async () => {
    const {store, request} = await loaded();
    const sizes = () =>
      request.mock.calls
        .map(([input]) => /size=(\w+)/.exec(input.path)?.[1])
        .filter(Boolean);
    const h = handlers();
    const view = render(
      <PhoneExpressions.Provider value={store}>
        <ExpressionComposerPicker {...h} />
      </PhoneExpressions.Provider>,
    );
    pressTab('emoticon');
    fireEvent.press(await screen.findByTestId('expression-pick-party_parrot'));
    await act(async () => {});
    expect(screen.getByTestId('expression-send-preview')).toBeTruthy();
    // 동작 줄이기 켬: 격자도 미리보기도 thumb 뿐 — large·small 은 한 번도 안 불렀다.
    expect(new Set(sizes())).toEqual(new Set(['thumb']));
    view.unmount();

    // 대조(꺼짐): 같은 길이 큰 그림을 부른다 — 위 단정이 원래 아무것도 안 불러서 통과한 것이 아니다.
    release?.();
    release = await pinReduceMotion(false);
    render(
      <PhoneExpressions.Provider value={store}>
        <ExpressionComposerPicker {...h} />
      </PhoneExpressions.Provider>,
    );
    pressTab('emoticon');
    fireEvent.press(await screen.findByTestId('expression-pick-party_parrot'));
    await act(async () => {});
    expect(sizes()).toContain('large');
    // 큰 그림을 부른 것은 미리보기 하나뿐이다 — 이모티콘·GIF 의 큰 칸(`tile`)은 보이는 칸이어도 움직이지 않는다(thumb = PNG).
    expect(
      request.mock.calls.filter(([input]) => input.path.includes('size=large'))
        .length,
    ).toBe(1);
    render(
      <PhoneExpressions.Provider value={store}>
        <ExpressionImage expression={parrot} size="tile" visible />
      </PhoneExpressions.Provider>,
    );
    await act(async () => {});
    expect(
      screen.getByTestId('expression-image-party_parrot-tile').props.source.uri,
    ).toMatch(/png$/);
  });

  it('「＋ 추가하기」의 안쪽 장이 열린 동안은 검색·탭 줄이 접히고, ‹ 로 돌아오면 다시 선다', async () => {
    const {store} = await loaded();
    openSheet(store);
    pressTab('emoticon');
    await screen.findByTestId('expression-add-menu');
    fireEvent.press(screen.getByTestId('expression-add-menu'));
    fireEvent.press(screen.getByTestId('expression-add-import'));
    expect(screen.getByTestId('expression-import')).toBeTruthy();
    expect(screen.queryByTestId('expression-sheet-search')).toBeNull();
    expect(screen.queryByTestId('expression-sheet-tabs')).toBeNull();
    fireEvent.press(screen.getByTestId('expression-chapter-back'));
    expect(screen.getByTestId('expression-sheet-search')).toBeTruthy();
    expect(screen.getByTestId('expression-sheet-tabs')).toBeTruthy();
  });
});

// ---- 입력창의 단추 ------------------------------------------------------------
describe('입력창의 표현 단추', () => {
  const DIRECTORY = makeDirectory([]);
  const TARGET = {workspaceId: 'ws', channelId: 'ch'};

  function mountComposer(
    store: PhoneExpressionStore,
    props: Partial<React.ComponentProps<typeof Composer>> = {},
  ) {
    const onSend = jest.fn();
    render(
      <PhoneExpressions.Provider value={store}>
        <Composer
          recipient="place"
          channelLabel="agent-lab"
          directory={DIRECTORY}
          attachmentTarget={TARGET}
          onSend={onSend}
          {...props}
        />
      </PhoneExpressions.Provider>,
    );
    return {onSend};
  }
  const field = () => flat(screen.getByTestId('composer-field').props.style);

  it('보내기 바로 왼쪽에 서고 접힘·펼침·입력 중에 모두 보인다 — 도구 줄에는 더는 없다', async () => {
    const {store} = await loaded();
    mountComposer(store);
    const send = flat(screen.getByTestId('composer-send').props.style);
    const button = flat(screen.getByTestId('composer-expression').props.style);

    // 쉬는(접힌) 알약: 단추가 서 있고 글 칸은 오른쪽에서 두 칸(보내기 + 단추)을 비운다. 왼쪽은 + 원 하나다.
    expect(screen.queryByTestId('composer-tools')).toBeNull();
    expect(screen.getByTestId('composer-expression')).toBeTruthy();
    expect(field()).toMatchObject({
      marginLeft: CONV.composerCircle,
      marginRight: CONV.composerCircle + CONV.composerExpression,
    });
    // 보내기 원의 **바로 왼쪽**(같은 바닥선·같은 지름), 채운 원은 아니다.
    expect(button).toMatchObject({
      position: 'absolute',
      right: Number(send.right) + CONV.composerCircle,
      bottom: send.bottom,
      width: CONV.composerExpression,
      height: send.height,
    });
    expect(button.backgroundColor).toBeUndefined();

    // 입력 중(포커스·글): 펼친 알약에서도 같은 자리에 서고, 도구 줄에는 @ 만 남는다.
    fireEvent(screen.getByTestId('composer-input'), 'focus');
    fireEvent.changeText(screen.getByTestId('composer-input'), '안녕');
    expect(screen.getByTestId('composer-tools')).toBeTruthy();
    expect(screen.getByTestId('composer-expression')).toBeTruthy();
    expect(
      flat(screen.getByTestId('composer-expression').props.style),
    ).toMatchObject({right: button.right, bottom: button.bottom});
    expect(field()).toMatchObject({marginLeft: 0, marginRight: 0});
    expect(screen.queryByTestId('composer-tool-emoji')).toBeNull();
    expect(within(screen.getByTestId('composer-tools')).queryByTestId('composer-expression')).toBeNull();
    expect(screen.getByTestId('composer-tool-mention')).toBeTruthy();
  });

  it('눌러 시트를 열고, 팀 이모지는 글 뒤에 띄어 넣고, 이모티콘은 입력 중인 글을 건드리지 않고 보낸다', async () => {
    const {store} = await loaded();
    const {onSend} = mountComposer(store);
    fireEvent.changeText(screen.getByTestId('composer-input'), '안녕');
    fireEvent.press(screen.getByTestId('composer-expression'));
    expect(await screen.findByTestId('expression-sheet-search')).toBeTruthy();
    pressTab('team');
    fireEvent.press(await screen.findByTestId('expression-pick-party_parrot'));
    await waitFor(() =>
      expect(screen.getByTestId('composer-input').props.value).toBe(
        '안녕 :party_parrot: ',
      ),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(haptics.light).not.toHaveBeenCalled(); // 넣기는 보내기가 아니다
    expect(screen.queryByTestId('expression-sheet-search')).toBeNull();

    // 이모티콘: 미리보기 → 보내기. 입력창의 글은 그대로다. 보내기 = light 한 번(`submit` 과 같은 규칙).
    fireEvent.press(screen.getByTestId('composer-expression'));
    pressTab('emoticon');
    fireEvent.press(await screen.findByTestId('expression-pick-ki_jeol'));
    fireEvent.press(screen.getByTestId('expression-confirm-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(':ki_jeol:'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(haptics.light).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('composer-input').props.value).toBe(
      '안녕 :party_parrot: ',
    );
  });

  it('앱 언어가 영어면 단추·탭·검색의 이름이 영어다 — 문구는 사전의 것이다', async () => {
    const {store} = await loaded();
    const controller = await createMobileLocaleController({
      port: {
        readPreference: () => 'en-US',
        writePreference: () => {},
        readDevice: () => ({languages: ['en-US'], timeZone: 'UTC'}),
      },
    });
    render(
      <MobileLocaleProvider createController={async () => controller}>
        <PhoneExpressions.Provider value={store}>
          <Composer
            recipient="place"
            channelLabel="agent-lab"
            directory={DIRECTORY}
            attachmentTarget={TARGET}
            onSend={() => {}}
          />
        </PhoneExpressions.Provider>
      </MobileLocaleProvider>,
    );
    const button = await screen.findByTestId('composer-expression');
    expect(button.props.accessibilityLabel).toBe(
      'Choose an emoticon, emoji or GIF',
    );
    fireEvent.press(button);
    await screen.findByTestId('expression-sheet-search');
    expect(
      EXPRESSION_TABS.map(
        id =>
          screen.getByTestId(`expression-sheet-tab-${id}`).props
            .accessibilityLabel,
      ),
    ).toEqual(['Emoticons', 'Emoji', 'Team emoji', 'GIF']);
    expect(
      screen.getByTestId('expression-sheet-search').props.accessibilityLabel,
    ).toBe('Search emoji');
    expect(
      screen.getByTestId('expression-sheet-close').props.accessibilityLabel,
    ).toBe('Close emoticons, emoji and GIFs');
    controller.dispose();
  });
});
