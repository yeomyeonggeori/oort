import 'react-native-url-polyfill/auto';
import React from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import {AccessibilityInfo, Dimensions, FlatList} from 'react-native';
import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
} from '@momo/core/features/expressions/fixtureServer';
import {FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import type {Expression} from '@momo/core/features/expressions/types';
import {emptyExpressionUsage, recordExpressionUse} from '@momo/core/features/expressions/usage';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {rememberEmojiCatalog} from '../src/features/emoji/catalogMemory';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {ExpressionKeyboardPanel, resetPanelTab} from '../src/features/expressions/ExpressionKeyboardPanel';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  layoutPanelSections,
  PANEL_HEADER_HEIGHT,
  PANEL_ROW_HEIGHT,
  panelColumns,
} from '../src/features/expressions/panelModel';
import {readExpressionFavorites} from '../src/features/expressions/useExpressionFavorites';
import {createPhoneExpressionStore, type PhoneExpressionStore} from '../src/features/expressions/store';
import {__setNonSecretStore, NON_SECRET_KEYS, type NonSecretStore} from '../src/storage/kv';
import {pinReduceMotion} from './fixtures/reduceMotion';

jest.mock('../src/features/emoji/catalog', () => ({loadPhoneEmojiCatalog: jest.fn()}));
// 그림 부품은 자리만 선다: 이 시험은 창의 구조(탭·구역·띠·상태)를 잰다. 그림 칸 자체는 `expressionImageStable.test` 의 몫이다.
jest.mock('../src/features/expressions/ExpressionImage', () => {
  const {View} = require('react-native');
  return {ExpressionImage: ({expression, size}: {expression: {name: string}; size: string}) => <View testID={`img-${size}-${expression.name}`} />};
});

// =============================================================================
// 키보드 자리의 이모티콘 창 (#5452, owner 2026-11-07) — 세 탭 · 그림만 있는 격자 · 세트 띠 · 네 상태 · 즐겨찾기(이 기기).
// 진짜 부품: `ExpressionKeyboardPanel`·`ExpressionPanelGrid`·`TeamEmojiRow`·`EmojiPicker` 본문·폰 저장소. 가짜: 서버(코어 fixture)·표준 이모지 목록(둘)·그림 부품.
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
    id: `00000000-0000-4000-8000-0000000003${String(serial).padStart(2, '0')}`,
    name,
    displayName: tags[tags.length - 1],
    tags,
    kind: shelf === 'team' ? 'emoji' : 'sticker',
    media: shelf === 'emoticon' ? PNG_MEDIA : GIF_MEDIA,
  };
}
/** 이모티콘 탭 둘 이상의 세트 둘 + 낱개, GIF 탭 세트 하나 + 낱개, 이모지 탭의 팀 이모지 하나. */
const makeLibrary = () => {
  serial = 0;
  return [
    item('dam_kk', ['농담곰', '킹받네'], 'emoticon'),
    item('dam_haa', ['농담곰', '하'], 'emoticon'),
    item('chi_yay', ['치이카와', '야호'], 'emoticon'),
    item('chi_cry', ['치이카와', '엉엉'], 'emoticon'),
    item('cheers_still', ['축하', '건배'], 'emoticon'),
    item('nya_dance', ['냥코', '춤'], 'gif'),
    item('nya_jump', ['냥코', '점프'], 'gif'),
    item('solo_gif', ['놀람', '기절'], 'gif'),
    item('party_parrot', ['축하', '앵무새'], 'team'),
  ];
};

const party: CatalogEmoji = {glyph: '🎉', name: 'party popper', koreanName: '축하', shortcodes: ['tada'], keywords: [], category: 'activity', version: 1};

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;

function memoryKv(): NonSecretStore & {map: Map<string, string>} {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => void map.delete(key),
  } as unknown as NonSecretStore & {map: Map<string, string>};
}

function makeStore(options: {items?: Expression[]; usage?: unknown; fail?: boolean} = {}) {
  const library = options.items ?? makeLibrary();
  const server = createExpressionFixtureServer();
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    const response = server.request(input);
    if (input.method === 'GET' && input.path.split('?')[0] === base) {
      if (options.fail) return {status: 500, json: {code: 'internal'}} as typeof response;
      const json = response.json as {items?: Expression[]} | undefined;
      return json?.items ? {...response, json: {...json, items: library}} : response;
    }
    return response;
  });
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    {write: jest.fn((key: string) => `file:///fixture/${key}`), remove: jest.fn()},
    {read: () => options.usage ?? null, write: jest.fn()},
  );
  stores.push(store);
  return {store, library, request};
}

const props = () => ({
  previewId: null as string | null,
  onPickBig: jest.fn(),
  onInsertText: jest.fn(),
  onInsertToken: jest.fn(),
});
function mountPanel(store: PhoneExpressionStore, extra: Partial<ReturnType<typeof props>> = {}) {
  const p = {...props(), ...extra};
  const view = render(
    <PhoneExpressions.Provider value={store}>
      <ExpressionKeyboardPanel {...p} />
    </PhoneExpressions.Provider>,
  );
  return {...p, view};
}
const cellNames = () => screen.queryAllByTestId(/^expression-pick-/).map(node => String(node.props.testID).replace('expression-pick-', ''));
const sections = () => screen.queryAllByTestId(/^expression-panel-section-/).map(node => String(node.props.testID).replace('expression-panel-section-', ''));
const strip = () => screen.queryAllByTestId(/^expression-panel-set-/).map(node => String(node.props.testID).replace('expression-panel-set-', ''));

let kv: ReturnType<typeof memoryKv>;
beforeEach(async () => {
  jest.clearAllMocks();
  kv = memoryKv();
  __setNonSecretStore(kv);
  resetPanelTab();
  rememberEmojiCatalog(null);
  release = await pinReduceMotion(true);
  (loadPhoneEmojiCatalog as jest.Mock).mockResolvedValue([party]);
  emojiFrequency.reset();
  emojiSkinTone.reset();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  __setNonSecretStore(null);
  release?.();
  jest.restoreAllMocks();
});

describe('세 탭 — 이모티콘 · 이모지 · GIF', () => {
  it('이 차례로 서고 처음은 이모티콘이며 「이모지」는 탭 이름에만 있다 - 보이는 글자 어디에도 더는 없다', async () => {
    const {store} = makeStore();
    await store.refresh(true);
    mountPanel(store);
    const tabs = ['emoticon', 'emoji', 'gif'].map(id => screen.getByTestId(`expression-panel-tab-${id}`));
    expect(tabs.map(tab => [tab.props.accessibilityRole, tab.props.accessibilityLabel, tab.props.accessibilityState.selected])).toEqual([
      ['tab', '이모티콘', true],
      ['tab', '이모지', false],
      ['tab', 'GIF', false],
    ]);
    expect(screen.getByTestId('expression-panel-tabs').props.accessibilityRole).toBe('tablist');
    // 옛 시트의 머리·검색 칸·「우리 팀」·「기본」 구분은 없다.
    for (const id of ['expression-sheet-search', 'expression-sheet-close', 'emoji-search', 'emoji-tab-team']) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.queryByText(/우리 팀|기본/)).toBeNull();
    // 「이모지」 글자는 탭 줄의 한 곳뿐이다(이모티콘 탭 본문에는 없다).
    expect(screen.queryAllByText(/이모지/)).toHaveLength(1);
    fireEvent.press(tabs[1]);
    expect(screen.queryAllByText(/이모지/)).toHaveLength(1);
  });

  it('마지막으로 본 탭을 다시 열어도 기억한다(이번 실행 동안)', async () => {
    const {store} = makeStore();
    await store.refresh(true);
    const first = mountPanel(store);
    fireEvent.press(screen.getByTestId('expression-panel-tab-gif'));
    first.view.unmount();
    mountPanel(store);
    expect(screen.getByTestId('expression-panel-tab-gif').props.accessibilityState.selected).toBe(true);
    expect(cellNames().sort()).toEqual(['nya_dance', 'nya_jump', 'solo_gif']);
  });
});

describe('이모티콘·GIF 탭 — 그림만 있는 격자와 세트 띠', () => {
  it('구역은 세트별 + 기타이고 우리 팀·기본 구분이 없다 - 칸에는 글이 없고 낭독 이름만 있다', async () => {
    const {store} = makeStore();
    await store.refresh(true);
    mountPanel(store);
    expect(sections().sort()).toEqual(['other', 'set:chi', 'set:dam']);
    expect(cellNames().sort()).toEqual(['cheers_still', 'chi_cry', 'chi_yay', 'dam_haa', 'dam_kk']);
    // 칸 안의 글: 그림 자리(모의)뿐이다 - 이름·코드 글자가 없다.
    for (const cell of screen.getAllByTestId(/^expression-pick-/)) {
      expect(within(cell).queryAllByText(/./)).toHaveLength(0);
      expect(cell.props.accessibilityRole).toBe('button');
      expect(String(cell.props.accessibilityLabel)).toMatch(/·|[가-힣]/);
    }
    // 구역 이름줄: 세트의 이름표(공통 태그)·기타.
    expect(screen.getByText('농담곰')).toBeTruthy();
    expect(screen.getByText('치이카와')).toBeTruthy();
    // 「기타」: 구역 이름줄과 띠의 단추 글자, 둘이다.
    expect(screen.getAllByText('기타')).toHaveLength(2);
    // GIF 탭은 움직이는 것만, 같은 구조다.
    fireEvent.press(screen.getByTestId('expression-panel-tab-gif'));
    expect(sections().sort()).toEqual(['other', 'set:nya']);
    expect(cellNames().sort()).toEqual(['nya_dance', 'nya_jump', 'solo_gif']);
  });

  it('세트 띠: 세트마다 첫 그림 단추 · 기타 · ＋ (최근·즐겨찾기는 비어 있으면 없다) - 누르면 그 구역으로 건너뛰고 지금 구역이 표시된다', async () => {
    const {store} = makeStore();
    await store.refresh(true);
    mountPanel(store);
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    expect(strip().sort()).toEqual(['other', 'set:chi', 'set:dam']);
    expect(screen.getByTestId('expression-panel-add').props.accessibilityLabel).toBe('추가하기');
    expect(screen.queryByTestId('expression-panel-set-recent')).toBeNull();
    expect(screen.queryByTestId('expression-panel-set-favorites')).toBeNull();

    const {width, fontScale} = Dimensions.get('window');
    const columns = panelColumns(width, 16, fontScale, 72);
    const {layouts} = layoutPanelSections(
      sections().map(id => ({id, kind: id === 'other' ? 'other' : 'set', label: id, items: sectionItems(id)})) as never,
      columns,
    );
    const second = layouts[1];
    fireEvent.press(screen.getByTestId(`expression-panel-set-${second.section.id}`));
    // 건너뛰는 자리는 앞 구역들의 높이 합(이름줄 + 칸 줄)이다.
    const before = layouts[0];
    expect(second.top).toBe(PANEL_HEADER_HEIGHT + Math.ceil(before.section.items.length / columns) * PANEL_ROW_HEIGHT);
    expect(scroll).toHaveBeenCalledWith({offset: second.top, animated: false});
    expect(screen.getByTestId(`expression-panel-set-${second.section.id}`).props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId(`expression-panel-set-${layouts[0].section.id}`).props.accessibilityState.selected).toBe(false);
  });

  it('칸을 누르면 고른 등록을 넘길 뿐 보내지 않는다 - 미리 보기는 호스트(입력창)가 연다', async () => {
    const {store, library} = makeStore();
    await store.refresh(true);
    const {onPickBig, onInsertText, onInsertToken} = mountPanel(store);
    fireEvent.press(screen.getByTestId('expression-pick-dam_kk'));
    expect(onPickBig).toHaveBeenCalledTimes(1);
    expect(onPickBig.mock.calls[0][0]).toMatchObject({id: library[0].id, name: 'dam_kk'});
    expect(onInsertText).not.toHaveBeenCalled();
    expect(onInsertToken).not.toHaveBeenCalled();
  });

  it('미리 보기에 오른 그림은 눌린 모양으로 표시된다(선택 상태)', async () => {
    const {store, library} = makeStore();
    await store.refresh(true);
    mountPanel(store, {previewId: library[1].id});
    expect(screen.getByTestId('expression-pick-dam_haa').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('expression-pick-dam_kk').props.accessibilityState.selected).toBe(false);
  });

  it('쓴 적이 있으면 「최근」 구역이 맨 앞에 서고 띠의 첫 단추가 된다', async () => {
    const library = makeLibrary();
    const usage = recordExpressionUse(emptyExpressionUsage(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID), library[3].id, 5000);
    const {store} = makeStore({items: library, usage});
    await store.refresh(true);
    mountPanel(store);
    expect(sections()[0]).toBe('recent');
    expect(strip()[0]).toBe('recent');
    expect(screen.getByText('최근')).toBeTruthy();
    // 같은 그림이 최근과 세트에 한 번씩 선다.
    expect(screen.getAllByTestId('expression-pick-chi_cry')).toHaveLength(2);
  });
});

describe('즐겨찾기 — 길게 누르면 켜고 끈다(이 기기 안, 서버 계약 없음)', () => {
  it('켜면 ★ 구역과 띠의 ★ 이 서고 이 기기에 남는다 - 다시 열어도 그대로, 다시 길게 누르면 빠진다', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const {store, library} = makeStore();
    await store.refresh(true);
    const first = mountPanel(store);
    fireEvent(screen.getByTestId('expression-pick-dam_haa'), 'longPress');
    expect(sections()[0]).toBe('favorites');
    expect(strip()[0]).toBe('favorites');
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('즐겨찾기에 추가했어요'));
    expect(first.onPickBig).not.toHaveBeenCalled(); // 길게 누름은 고르기가 아니다
    // 이 기기에 남는다: 워크스페이스·사람 단위 한 키.
    expect(kv.map.has(NON_SECRET_KEYS.expressionFavorites)).toBe(true);
    expect(readExpressionFavorites(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID).ids).toEqual([library[1].id]);
    // 다른 사람의 것은 읽지 않는다.
    expect(readExpressionFavorites(FIXTURE_WORKSPACE_ID, 'someone-else').ids).toEqual([]);
    first.view.unmount();
    mountPanel(store);
    expect(sections()[0]).toBe('favorites');
    // 다시 길게 누르면 빠진다(★ 구역이 비면 구역도 띠의 단추도 없다).
    fireEvent(screen.getAllByTestId('expression-pick-dam_haa')[0], 'longPress');
    expect(sections()).not.toContain('favorites');
    expect(strip()).not.toContain('favorites');
    expect(announce).toHaveBeenLastCalledWith(expect.stringContaining('즐겨찾기에서 뺐어요'));
  });

  it('깨진 저장값은 빈 목록이다 - 글 하나 때문에 창이 죽지 않는다', async () => {
    kv.map.set(NON_SECRET_KEYS.expressionFavorites, '{not json');
    const {store} = makeStore();
    await store.refresh(true);
    mountPanel(store);
    expect(sections()).not.toContain('favorites');
    expect(cellNames()).toHaveLength(5);
  });
});

describe('네 상태 — 불러오는 중 · 오류 · 비어 있음 · 있음 (＋ 는 어느 상태에서도 선다)', () => {
  it('불러오는 중: 한 문장, ＋ 는 있다', () => {
    const {store} = makeStore();
    mountPanel(store); // 아직 읽지 않았다
    expect(screen.getByTestId('expression-panel-loading')).toBeTruthy();
    expect(screen.getByText('팀 보관함을 불러오는 중이에요.')).toBeTruthy();
    expect(screen.getByTestId('expression-panel-add')).toBeTruthy();
    expect(cellNames()).toEqual([]);
  });

  it('오류: 다시 시도 단추가 읽기를 다시 한다 - 고치면 격자가 선다', async () => {
    const failing = makeStore({fail: true});
    await failing.store.refresh(true);
    mountPanel(failing.store);
    expect(screen.getByTestId('expression-panel-error')).toBeTruthy();
    expect(screen.getByText('팀 보관함을 불러오지 못했어요. 다시 시도해 주세요.')).toBeTruthy();
    expect(screen.getByTestId('expression-panel-add')).toBeTruthy();
    const refresh = jest.spyOn(failing.store, 'refresh');
    fireEvent.press(screen.getByTestId('expression-panel-retry'));
    expect(refresh).toHaveBeenCalledWith(true);
  });

  it('비어 있음: 만드는 길을 한 문장으로 말한다(탭마다 다르다)', async () => {
    const {store} = makeStore({items: []});
    await store.refresh(true);
    mountPanel(store);
    expect(screen.getByTestId('expression-panel-empty')).toBeTruthy();
    expect(screen.getByText('아직 이모티콘이 없어요. 아래의 ＋로 만들거나 가져와 보세요.')).toBeTruthy();
    expect(screen.getByTestId('expression-panel-add')).toBeTruthy();
    fireEvent.press(screen.getByTestId('expression-panel-tab-gif'));
    expect(screen.getByText('아직 움직이는 이모티콘이 없어요. 아래의 ＋로 가져오거나 만들 수 있어요.')).toBeTruthy();
  });

  it('끊김(오프라인)은 같은 자리에 한 문장이다', async () => {
    const {store} = makeStore();
    await store.refresh(true);
    store.setOnline(false);
    mountPanel(store);
    expect(screen.getByTestId('expression-panel-offline')).toBeTruthy();
    expect(screen.getByText('오프라인이에요. 연결되면 팀 보관함을 볼 수 있어요.')).toBeTruthy();
  });
});

describe('이모지 탭 — 글자처럼 입력창에 들어간다(미리 보기로 가지 않는다)', () => {
  it('표준 그림 문자는 글자로, 팀의 작은 이모지는 `:이름:` 으로 넘긴다', async () => {
    const {store} = makeStore();
    await store.refresh(true);
    const {onPickBig, onInsertText, onInsertToken} = mountPanel(store);
    fireEvent.press(screen.getByTestId('expression-panel-tab-emoji'));
    fireEvent.press(await screen.findByTestId('expression-pick-party_parrot'));
    await waitFor(() => expect(onInsertToken).toHaveBeenCalledWith(':party_parrot:'));
    // 표준 목록은 제 머리·검색·피부색 줄 없이(compact) 본문만 선다.
    expect(screen.queryByTestId('emoji-search')).toBeNull();
    expect(screen.queryByTestId('emoji-tones')).toBeNull();
    fireEvent.press(await screen.findByTestId('emoji-pick-🎉'));
    expect(onInsertText).toHaveBeenCalledWith('🎉');
    expect(onPickBig).not.toHaveBeenCalled();
  });
});

// ---- 이 시험의 보조 -------------------------------------------------------------------------
/** 렌더된 한 구역의 등록(칸 id 로 보관함에서 찾는다). */
function sectionItems(id: string): Expression[] {
  const node = screen.getByTestId(`expression-panel-section-${id}`);
  return within(node)
    .getAllByTestId(/^expression-pick-/)
    .map(cell => ({id: String(cell.props.testID)}) as Expression);
}
