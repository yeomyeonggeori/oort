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
import {AppState, StyleSheet, View} from 'react-native';
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
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {rememberEmojiCatalog} from '../src/features/emoji/catalogMemory';
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
  expressionActionOf,
  insertExpressionToken,
} from '../src/features/expressions/expressionViews';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {pinReduceMotion} from './fixtures/reduceMotion';

jest.mock('../src/features/emoji/catalog', () => ({
  loadPhoneEmojiCatalog: jest.fn(),
}));
jest.mock('../src/lib/haptics', () => ({
  haptics: {event: jest.fn(), light: jest.fn()},
}));

// =============================================================================
// 입력창 표현 시트 (#4942, owner 10-31 → 11-07 #5453) — 보내기 왼쪽 단추 하나가 여는 세 탭 시트(이모티콘 · 이모지 · GIF).
//
// 진짜 부품만 쓴다: 진짜 `Composer`·`PageSheet`·`EmojiPicker` 본문·`TeamEmojiRow`·`TeamExpressionPicker`·폰 저장소. 가짜는 서버(코어 fixture
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

/**
 * 서버 목록의 엄지척을 정지 그림(PNG)으로 바꾼다 — thumb 는 원래 PNG 라 그림 길은 그대로다. 코어 fixture 의 종류는 앵무새
 * `emoji`·기절 `sticker`·엄지척 `sticker` 라서 이 바꿈 뒤의 세 탭은 이모티콘 = 엄지척(정지한 큰 것) · 이모지 = 앵무새(팀의 작은 것) · GIF = 기절이다
 * (ADR-0218 §10 J2의 네 칸이 탭마다 한 칸씩, 2026-11-07 #5453). 종류를 바꿔 재는 시험은 `rewrite` 로 한 등록의 종류를 바꿔 내린다.
 */
function stillThumbs(
  response: ExpressionFixtureResponse,
  rewrite: (item: Expression) => Expression = item => item,
): ExpressionFixtureResponse {
  const json = response.json as {items?: Expression[]} | undefined;
  if (!json?.items) return response;
  return {
    ...response,
    json: {
      ...json,
      items: json.items.map(item =>
        rewrite(
          item.id === thumbs.id && item.media
            ? {...item, media: {...item.media, small: {...PNG}, large: {...PNG}}}
            : item,
        ),
      ),
    },
  };
}

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;

function setup(rewrite?: (item: Expression) => Expression) {
  const server = createExpressionFixtureServer();
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    const response = server.request(input);
    return input.method === 'GET' && input.path.split('?')[0] === base
      ? stillThumbs(response, rewrite)
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

async function loaded(rewrite?: (item: Expression) => Expression) {
  const made = setup(rewrite);
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
  rememberEmojiCatalog(null); // 푼 목록의 기억은 모듈 값이다 — 시험마다 비운다.
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

// ---- 순수: 보관함을 나누는 두 보기 ---------------------------------------------------
describe('탭이 고르는 것 — 종류와 움직임이 보관함을 겹치지 않게 나눈다 (ADR-0218 §10 J2 + 2026-11-05 증보)', () => {
  const still = {
    ...thumbs,
    media: {...thumbs.media!, small: {...PNG}, large: {...PNG}},
  };
  const items: Expression[] = [parrot, jeol, still];
  const ids = (list: Expression[]) => list.map(item => item.name);

  it('이모티콘 = 정지한 sticker · 이모지 = 작은 emoji(움직여도) · GIF = 움직이는 sticker — 한 등록은 정확히 한 탭에 선다', () => {
    expect(ids(browseExpressions(items, 'emoticon', ''))).toEqual([
      'thumbs_up',
    ]);
    expect(ids(browseExpressions(items, 'emoji', ''))).toEqual(['party_parrot']);
    expect(ids(browseExpressions(items, 'gif', ''))).toEqual(['ki_jeol']);
    // 합집합은 전체, 교집합은 없다 — 등록이 두 번 서거나 빠지지 않는다.
    const all = [
      ...browseExpressions(items, 'emoticon', ''),
      ...browseExpressions(items, 'emoji', ''),
      ...browseExpressions(items, 'gif', ''),
    ];
    expect(new Set(all.map(item => item.id))).toEqual(
      new Set(items.map(item => item.id)),
    );
    expect(all).toHaveLength(items.length);
  });

  it('고른 뒤의 동작은 탭이 아니라 등록이 정한다 — 작은 것은 입력칸에, 큰 것(움직여도)은 보낸다', () => {
    expect(expressionActionOf(parrot)).toBe('insert'); // emoji: 움직여도 작은 것
    expect(expressionActionOf(still)).toBe('send'); // 정지한 sticker
    expect(expressionActionOf(jeol)).toBe('send'); // 움직이는 sticker
  });

  it('한 탭 안에서: 빈 검색은 최근에 쓴 것이 먼저, 검색어가 있으면 관련도 — 거르기는 탭 밖의 등록을 들이지 않는다', () => {
    // 한 탭에 둘이 서야 차례를 잰다: 엄지척을 작은 이모티콘(`emoji`)으로 두면 이모지 탭에 앵무새와 엄지척이 선다.
    const team: Expression[] = [parrot, {...still, kind: 'emoji'}, jeol];

    // 최근 먼저: 파티 앵무새를 세 번(오래전), 엄지척을 한 번(방금) 썼다. 코어의 빈 검색은 **횟수** 순이라 앵무새가 앞이고(대조),
    // 이 시트는 **최근** 순이라 엄지척이 앞이다 — 둘이 갈리는 자료라야 「최근 먼저」를 잰다.
    let usage = emptyExpressionUsage(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID);
    for (const at of [1000, 1001, 1002]) usage = recordExpressionUse(usage, parrot.id, at);
    usage = recordExpressionUse(usage, thumbs.id, 5000);
    expect(ids(searchExpressions(team, '', usage))).toEqual([
      'party_parrot',
      'thumbs_up',
      'ki_jeol',
    ]);
    expect(ids(browseExpressions(team, 'emoji', '', usage))).toEqual([
      'thumbs_up',
      'party_parrot',
    ]);
    // 방금 쓴 정지 그림이어도 GIF 보기에는 서지 않는다.
    expect(ids(browseExpressions(team, 'gif', '', usage))).toEqual(['ki_jeol']);
    // 검색어가 있으면 거르고, 앞뒤 콜론은 이름 검색으로 읽는다. 다른 탭의 등록은 이름이 맞아도 서지 않는다.
    expect(ids(browseExpressions(team, 'emoji', '엄지', usage))).toEqual([
      'thumbs_up',
    ]);
    expect(
      ids(browseExpressions(team, 'emoji', ':party_parrot:', usage)),
    ).toEqual(['party_parrot']);
    expect(ids(browseExpressions(team, 'gif', ':party_parrot:', usage))).toEqual(
      [],
    );
    expect(
      ids(browseExpressions(team, 'emoticon', ':party_parrot:', usage)),
    ).toEqual([]);
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
  it('세 탭이 이 차례로 서고 맨 위 검색은 하나다 — 낭독 이름·선택 상태·탭마다 다른 검색 이름', async () => {
    const {store} = await loaded();
    openSheet(store);
    const tabs = screen.getByTestId('expression-sheet-tabs');
    expect(tabs.props.accessibilityRole).toBe('tablist');
    const labels = EXPRESSION_TABS.map(id => {
      const tab = screen.getByTestId(`expression-sheet-tab-${id}`);
      expect(tab.props.accessibilityRole).toBe('tab');
      return [id, tab.props.accessibilityLabel, tab.props.accessibilityState.selected];
    });
    // 세 탭은 그림의 모양으로 가른다(owner 11-07 #5453): 우리 팀이 올린 것과 기본을 탭으로 가르지 않는다. 「이모지」는 탭 이름에만 쓴다.
    expect(labels).toEqual([
      ['emoticon', '이모티콘', false],
      ['emoji', '이모지', true], // 처음 열 때: 옛 고르개가 열던 표준 목록
      ['gif', 'GIF', false],
    ]);
    expect(within(tabs).getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByTestId('expression-sheet-tab-team')).toBeNull();
    // 검색은 시트에 하나 — 이모지 본문(`embedded`)은 제 검색 칸·「우리 팀」 탭·머리를 세우지 않는다.
    expect(screen.getAllByTestId('expression-sheet-search')).toHaveLength(1);
    expect(screen.queryByTestId('emoji-search')).toBeNull();
    expect(screen.queryByTestId('emoji-tab-team')).toBeNull();
    expect(screen.queryByTestId('emoji-picker-close')).toBeNull();
    expect(
      screen.getByTestId('expression-sheet-search').props.accessibilityLabel,
    ).toBe('이름으로 검색');
    expect(
      screen.getByTestId('expression-sheet-close').props.accessibilityLabel,
    ).toBe('이모티콘 닫기');
    pressTab('emoticon');
    expect(
      screen.getByTestId('expression-sheet-search').props.accessibilityLabel,
    ).toBe('이모티콘 검색');
    expect(
      screen.getByTestId('expression-sheet-tab-emoticon').props
        .accessibilityState.selected,
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
  // 기본 탭만 합쇼체(「없습니다」)라 한 시트 안에서 말씨가 갈렸다. 렌더된 글자 노드의 줄바꿈 속성과 문장 끝(해요체)을 잰다.
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
    read('emoji-empty', '찾는 이모티콘이 없어요. 다른 이름으로 검색해 보세요.');
    pressTab('emoticon');
    await screen.findByTestId('emoji-team-empty');
    read('emoji-team-empty', '찾는 표현이 없어요. 다른 이름이나 태그로 검색해 보세요.');
    pressTab('gif');
    read('emoji-team-empty', '찾는 표현이 없어요. 다른 이름이나 태그로 검색해 보세요.');
    // 말씨: 문장마다 「요.」로 끝난다 — 「…없습니다.」·「…하세요.」가 하나라도 섞이면 빨개진다.
    const sentences = emptyLines.flatMap(line => line.split(/(?<=\.)\s+/));
    expect(sentences.length).toBeGreaterThanOrEqual(6);
    expect(sentences.filter(sentence => !/요\.$/.test(sentence))).toEqual([]);
  });

  it('이모지 탭의 팀 작은 이모지: 고르면 `:이름:` 을 입력칸에 넣는다 — 미리보기도 보내기도 없다', async () => {
    const {store} = await loaded();
    const h = openSheet(store);
    // 처음 여는 탭이 이모지다: 표준 목록 위에 팀의 작은 이모지 한 줄이 선다.
    fireEvent.press(await screen.findByTestId('expression-pick-party_parrot'));
    await waitFor(() => expect(h.onInsertExpression).toHaveBeenCalledTimes(1));
    expect(h.onInsertExpression).toHaveBeenCalledWith(':party_parrot:');
    expect(screen.queryByTestId('expression-send-preview')).toBeNull();
    expect(h.onSend).not.toHaveBeenCalled();
    expect(h.onInsert).not.toHaveBeenCalled();
  });

  it('이모티콘 탭의 큰 것: 큰 그림을 먼저 보고 「보내기」를 눌러야 한 메시지로 간다 — 입력칸에는 안 들어간다', async () => {
    const {store} = await loaded();
    const h = openSheet(store);
    pressTab('emoticon');
    // 큰 것(엄지척)은 미리 본다. 작은 앵무새(emoji)는 이모지 탭, 기절(움직이는 sticker)은 GIF 탭이다.
    fireEvent.press(await screen.findByTestId('expression-pick-thumbs_up'));
    expect(screen.getByTestId('expression-send-preview')).toBeTruthy();
    expect(h.onSend).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('expression-confirm-send'));
    await waitFor(() => expect(h.onSend).toHaveBeenCalledTimes(1));
    expect(h.onSend).toHaveBeenCalledWith(':thumbs_up:');
    expect(h.onInsertExpression).not.toHaveBeenCalled();
    expect(h.onInsert).not.toHaveBeenCalled();
  });

  it('GIF 탭은 움직이는 것만 보이고 같은 방식으로 보낸다 — 「＋ 추가하기」는 이모티콘·GIF 탭에 있다(이모지 탭에는 없다)', async () => {
    const {store} = await loaded();
    const h = openSheet(store);
    pressTab('emoticon');
    await screen.findByTestId('expression-pick-thumbs_up');
    expect(screen.getByTestId('expression-add-menu')).toBeTruthy();
    // 정지한 큰 엄지척만 선다 - 작은 앵무새(emoji, 움직여도)는 이모지 탭이다.
    expect(cellNames()).toEqual(['thumbs_up']);
    pressTab('gif');
    // 움직이는 sticker 만 — 엄지척은 정지 그림이라 이모티콘 탭이고, 움직이는 앵무새는 emoji 라 이모지 탭이다.
    expect(cellNames()).toEqual(['ki_jeol']);
    // GIF 의 빈 안내(「추가하기」로 가져오거나 만들 수 있어요)가 가리키는 단추가 이 탭에도 있다.
    expect(screen.getByTestId('expression-add-menu')).toBeTruthy();
    pressTab('emoji');
    expect(screen.queryByTestId('expression-add-menu')).toBeNull();
    pressTab('gif');
    fireEvent.press(screen.getByTestId('expression-pick-ki_jeol'));
    fireEvent.press(screen.getByTestId('expression-confirm-send'));
    await waitFor(() => expect(h.onSend).toHaveBeenCalledWith(':ki_jeol:'));
    expect(h.onInsertExpression).not.toHaveBeenCalled();
  });

  it('검색어는 탭을 옮겨도 남고 지금 탭 안에서만 거른다 — 최근에 쓴 것이 먼저다', async () => {
    // 이모지 탭에 앵무새와 엄지척이 함께 선다(엄지척을 emoji 로 내리면 같은 탭이다 — 정지해도 작은 이모지다).
    const {store} = await loaded(item =>
      item.id === thumbs.id ? {...item, kind: 'emoji'} : item,
    );
    // 앵무새를 세 번(오래전), 엄지척을 한 번(방금) 보냈다 — 횟수 순이면 앵무새가 앞이고 최근 순이면 엄지척이 앞이다.
    const now = jest.spyOn(Date, 'now');
    [1000, 1001, 1002].forEach((at, index) => {
      now.mockReturnValueOnce(at);
      store.recordSuccess(`message:parrot-${index}`, ':party_parrot:');
    });
    now.mockReturnValueOnce(5000);
    store.recordSuccess('message:thumbs', ':thumbs_up:');
    openSheet(store);
    await screen.findByTestId('expression-pick-party_parrot');
    // 한 탭 안의 차례: 방금 쓴 엄지척이 앞이다. 기절(움직이는 sticker)은 이 탭이 아니다.
    expect(cellNames()).toEqual(['thumbs_up', 'party_parrot']);
    fireEvent.changeText(screen.getByTestId('expression-sheet-search'), '엄지');
    expect(cellNames()).toEqual(['thumbs_up']);
    // 같은 검색어가 GIF 탭에도 걸려 있다 — 엄지척은 emoji 라 GIF 탭에는 없으니 비어 보인다.
    pressTab('gif');
    expect(cellNames()).toEqual([]);
    expect(screen.getByTestId('emoji-team-empty')).toBeTruthy();
    expect(screen.getByTestId('expression-sheet-search').props.value).toBe(
      '엄지',
    );
    pressTab('emoji');
    expect(cellNames()).toEqual(['thumbs_up']);
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
    // 움직이는 그림이 서는 탭은 GIF 다(기절 = 움직이는 sticker).
    pressTab('gif');
    fireEvent.press(await screen.findByTestId('expression-pick-ki_jeol'));
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
    pressTab('gif');
    fireEvent.press(await screen.findByTestId('expression-pick-ki_jeol'));
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

  // #5330: 시트를 닫았다 다시 열 때마다 「불러오는 중이에요」가 다시 떴다(원인은 인계 맨 위). 한 번 읽은 목록은 첫 그림부터 서고, 목록을 다시 받지도 않는다.
  it('시트를 닫았다 다시 열어도 처음 그리는 순간부터 목록이 서고 「불러오는 중」이 없다 — 목록을 다시 받지도 않는다 (#5330)', async () => {
    const {store, request} = await loaded();
    const lists = () =>
      request.mock.calls.filter(
        ([input]) =>
          input.method === 'GET' && input.path.split('?')[0] === base,
      ).length;
    expect(lists()).toBe(1);
    for (let round = 0; round < 3; round += 1) {
      const view = render(
        <PhoneExpressions.Provider value={store}>
          <ExpressionComposerPicker {...handlers()} />
        </PhoneExpressions.Provider>,
      );
      if (round === 0) await act(async () => {}); // 표준 목록을 처음 한 번 읽는다
      // 기다리지 않는다(`getBy`): 이미 읽은 것이 같은 렌더 안에서 서 있다. 팀의 작은 이모지 한 줄은 처음 여는 이모지 탭에 첫 그림부터 선다.
      if (round > 0) {
        expect(screen.getByTestId('emoji-pick-🎉')).toBeTruthy();
        expect(screen.queryByTestId('emoji-empty')).toBeNull();
      }
      expect(screen.getByTestId('expression-pick-party_parrot')).toBeTruthy();
      pressTab('emoticon');
      expect(screen.getByTestId('expression-pick-thumbs_up')).toBeTruthy();
      expect(screen.queryByTestId('expression-loading')).toBeNull();
      pressTab('gif');
      expect(screen.getByTestId('expression-pick-ki_jeol')).toBeTruthy();
      expect(screen.queryByTestId('expression-loading')).toBeNull();
      view.unmount();
    }
    expect(lists()).toBe(1); // 열 때마다 받지 않았다
  });

  it('앱이 앞으로 돌아와 전체를 다시 읽는 동안에도 열려 있는 시트의 목록이 그대로 선다 (#5330)', async () => {
    const {store, request, server} = await loaded();
    openSheet(store);
    pressTab('emoticon');
    await screen.findByTestId('expression-pick-thumbs_up');
    const before = cellNames();
    let reply!: () => void;
    request.mockImplementationOnce(async input => {
      await new Promise<void>(resolve => {
        reply = resolve;
      });
      return stillThumbs(server.request(input));
    });
    let reading!: Promise<void>;
    act(() => {
      reading = store.refresh(true);
    });
    expect(screen.queryByTestId('expression-loading')).toBeNull();
    expect(cellNames()).toEqual(before);
    await act(async () => {
      reply();
      await reading;
    });
    expect(screen.queryByTestId('expression-loading')).toBeNull();
    expect(cellNames()).toEqual(before);
  });

  // owner 11-07: 「이모지」라는 말은 탭 이름에만 쓴다. 시트의 어느 탭·어느 상태에도(목록·빈 안내·메뉴) 글자로도 낭독 이름으로도 없다.
  // 「스티커」와 옛 첫 탭 이름 「우리 팀」은 탭 줄에도 없다(옛 탭 이름 「기본」은 위 「세 탭이 이 차례로」 시험이 이름을 글자로 못 박는다 - 「기본 피부」처럼 다른 뜻으로 쓰이는 낱말이라 여기서 훑지 않는다).
  it('세 탭 어디에도(목록·빈 안내·「추가하기」 메뉴) 「이모지」는 탭 줄 밖에 없고 「스티커」·「우리 팀」은 어디에도 없다 — 보이는 글자와 낭독 이름 모두', async () => {
    const {store} = await loaded();
    openSheet(store);
    await screen.findByTestId('emoji-pick-🎉');
    // `skip`: 이 testID 의 줄기는 건너뛴다(탭 줄 밖의 글만 볼 때).
    const copy = (skip?: string) => {
      const seen: string[] = [];
      const walk = (node: unknown): void => {
        if (typeof node === 'string') seen.push(node);
        else if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') {
          const {props, children} = node as {
            props?: Record<string, unknown>;
            children?: unknown;
          };
          if (skip !== undefined && props?.testID === skip) return;
          for (const key of ['accessibilityLabel', 'accessibilityHint', 'placeholder'])
            if (typeof props?.[key] === 'string') seen.push(props[key] as string);
          walk(children);
        }
      };
      walk(screen.toJSON());
      return seen.join('\n');
    };
    const RETIRED = /스티커|우리 팀/;
    const TAB_ROW = 'expression-sheet-tabs';
    // 건너뛰기가 헛돌지 않는다는 증거: 탭 줄까지 읽으면 「이모지」가 보이고(탭의 글자·낭독 이름), 탭 줄을 건너뛰면 사라진다.
    expect(copy().match(/이모지/g)).not.toBeNull();
    expect(copy(TAB_ROW).match(/이모지/)).toBeNull();
    const sweep = (where: string) =>
      expect({
        where,
        retired: copy().match(RETIRED)?.[0] ?? null,
        emojiOutsideTabs: copy(TAB_ROW).match(/이모지/)?.[0] ?? null,
      }).toEqual({where, retired: null, emojiOutsideTabs: null});
    for (const tab of ['emoji', 'emoticon', 'gif', 'emoji'] as const) {
      pressTab(tab);
      if (tab === 'emoticon')
        await screen.findByTestId('expression-pick-thumbs_up');
      sweep(`${tab} 목록`);
      // 아무것도 못 맞추는 검색: 탭마다 다른 빈 안내가 선다.
      fireEvent.changeText(screen.getByTestId('expression-sheet-search'), 'zzzz');
      sweep(`${tab} 빈 안내`);
      fireEvent.changeText(screen.getByTestId('expression-sheet-search'), '');
    }
    pressTab('emoticon');
    fireEvent.press(await screen.findByTestId('expression-add-menu'));
    await screen.findByTestId('expression-add-doors');
    sweep('이모티콘 「추가하기」 메뉴');
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

  // 「눌러 시트를 열고 … 큰 이모티콘을 보낸다」 흐름은 이제 키보드 자리의 창이다(#5452): `expressionComposerPanel.test.tsx` 가 ☺ → 창 → 미리 보기 → 보내기 한 번을 재고,
  // 이 파일의 시트 시험은 옛 고르개 시트(`ExpressionComposerPicker`)를 직접 세워 잰다 - 입력창은 더는 이 시트를 열지 않는다.

  it('앱 언어가 영어면 단추·창·탭의 이름이 영어다 — 문구는 사전의 것이다', async () => {
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
          <ConversationLayout
            list={<View />}
            composer={
              <Composer
                recipient="place"
                channelLabel="agent-lab"
                directory={DIRECTORY}
                attachmentTarget={TARGET}
                onSend={() => {}}
              />
            }
          />
        </PhoneExpressions.Provider>
      </MobileLocaleProvider>,
    );
    const button = await screen.findByTestId('composer-expression');
    expect(button.props.accessibilityLabel).toBe(
      'Choose an emoticon, emoji or GIF',
    );
    fireEvent.press(button);
    await screen.findByTestId('expression-panel');
    expect(screen.getByTestId('expression-panel').props.accessibilityLabel).toBe('Emoticon panel');
    expect(screen.getByTestId('composer-expression').props.accessibilityLabel).toBe('Show keyboard');
    expect(
      EXPRESSION_TABS.map(
        id =>
          screen.getByTestId(`expression-panel-tab-${id}`).props
            .accessibilityLabel,
      ),
    ).toEqual(['Emoticons', 'Emoji', 'GIF']);
    controller.dispose();
  });
});
