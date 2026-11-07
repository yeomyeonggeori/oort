import 'react-native-url-polyfill/auto';
import React, {useContext} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import {AccessibilityInfo, Keyboard, View} from 'react-native';
import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {createExpressionFixtureServer, type ExpressionFixtureRequest} from '@momo/core/features/expressions/fixtureServer';
import {FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import type {Expression} from '@momo/core/features/expressions/types';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {DockFollowContext} from '../src/features/conversation/dockFollow';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {rememberEmojiCatalog} from '../src/features/emoji/catalogMemory';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {resetPanelTab} from '../src/features/expressions/ExpressionKeyboardPanel';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {createPhoneExpressionStore, type PhoneExpressionStore} from '../src/features/expressions/store';
import {haptics} from '../src/lib/haptics';
import {pinReduceMotion} from './fixtures/reduceMotion';

jest.mock('../src/features/emoji/catalog', () => ({loadPhoneEmojiCatalog: jest.fn()}));
jest.mock('../src/lib/haptics', () => ({haptics: {event: jest.fn(), light: jest.fn()}}));
jest.mock('../src/features/expressions/ExpressionImage', () => {
  const {View: Box} = require('react-native');
  return {ExpressionImage: ({expression, size}: {expression: {name: string}; size: string}) => <Box testID={`img-${size}-${expression.name}`} />};
});

// =============================================================================
// 입력창 ↔ 키보드 자리의 창 (#5452, owner 2026-11-07) — ☺ 로 창이 서고, 그림을 고르면 입력창 위에 **그림과 ✕뿐**인 미리 보기가 뜨고, 보내기 한 번에 그림과 글이 같이 간다.
// 진짜 `Composer`·`ConversationLayout`·창·폰 저장소. 가짜: 서버(코어 fixture)·표준 이모지 목록·그림 부품. 입력창의 y 이동은 시뮬레이터가 잰다(`measure/panel-steady.py`).
// =============================================================================

const PNG = FIXTURE_MEDIA.png.image;
const PNG_MEDIA = {...FIXTURE_EXPRESSIONS[1].media!, small: {...PNG}, large: {...PNG}};
const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const sticker = (n: number, name: string, tags: string[]): Expression => ({
  ...FIXTURE_EXPRESSIONS[2],
  id: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, '0')}`,
  name,
  displayName: tags[tags.length - 1],
  tags,
  kind: 'sticker',
  media: PNG_MEDIA,
});
const kk = sticker(1, 'dam_kk', ['농담곰', '킹받네']);
const haa = sticker(2, 'dam_haa', ['농담곰', '하']);
const parrot = FIXTURE_EXPRESSIONS[0];
const party: CatalogEmoji = {glyph: '🎉', name: 'party popper', koreanName: '축하', shortcodes: ['tada'], keywords: [], category: 'activity', version: 1};
const DIRECTORY = makeDirectory([]);
const TARGET = {workspaceId: 'ws', channelId: 'ch'};

type Emitter = {emit: (event: string, payload: unknown) => void};
const emit = (event: string, height = 336) =>
  (Keyboard as unknown as {_emitter: Emitter})._emitter.emit(event, {endCoordinates: {height, screenX: 0, screenY: 0, width: 402}, duration: 250, easing: 'keyboard'});

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;
async function loadedStore() {
  const server = createExpressionFixtureServer();
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    const response = server.request(input);
    const json = response.json as {items?: Expression[]} | undefined;
    return input.method === 'GET' && input.path.split('?')[0] === base && json?.items ? {...response, json: {...json, items: [kk, haa, parrot]}} : response;
  });
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    {write: jest.fn((key: string) => `file:///fixture/${key}`), remove: jest.fn()},
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  await store.refresh(true);
  return store;
}

let rest: (() => void) | null = null;
function ListProbe() {
  const follow = useContext(DockFollowContext);
  rest = follow === null ? null : () => follow.rest();
  return <View testID="list-slot" />;
}
function mount(store: PhoneExpressionStore, composerProps: Partial<React.ComponentProps<typeof Composer>> = {expressionBundle: true}) {
  const onSend = jest.fn();
  render(
    <PhoneExpressions.Provider value={store}>
      <ConversationLayout
        list={<ListProbe />}
        composer={<Composer recipient="place" channelLabel="agent-lab" directory={DIRECTORY} attachmentTarget={TARGET} onSend={onSend} {...composerProps} />}
      />
    </PhoneExpressions.Provider>,
  );
  return {onSend};
}
const input = () => screen.getByTestId('composer-input');
const sendDisabled = () => Boolean(screen.getByTestId('composer-send').props.accessibilityState?.disabled);
const openPanel = () => fireEvent.press(screen.getByTestId('composer-expression'));
const pick = (name: string) => fireEvent.press(screen.getByTestId(`expression-pick-${name}`));

beforeEach(async () => {
  jest.clearAllMocks();
  resetPanelTab();
  rememberEmojiCatalog(null);
  release = await pinReduceMotion(true);
  (loadPhoneEmojiCatalog as jest.Mock).mockResolvedValue([party]);
  emojiFrequency.reset();
  emojiSkinTone.reset();
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  release?.();
  rest = null;
  jest.restoreAllMocks();
});

describe('☺ — 창이 키보드 자리에 선다(바텀시트가 아니다)', () => {
  it('누르면 대화 레이아웃의 창 자리에 세 탭이 서고, 단추는 눌린 모양(선택 상태)·키보드 단추의 낭독 이름으로 바뀐다', async () => {
    const store = await loadedStore();
    mount(store);
    const button = screen.getByTestId('composer-expression');
    expect(button.props.accessibilityLabel).toBe('이모티콘 고르기');
    expect(button.props.accessibilityState.selected).toBe(false);
    expect(screen.queryByTestId('expression-panel')).toBeNull();
    openPanel();
    expect(within(screen.getByTestId('composer-panel')).getByTestId('expression-panel')).toBeTruthy();
    expect(screen.getByTestId('composer-expression').props.accessibilityLabel).toBe('키보드 열기');
    expect(screen.getByTestId('composer-expression').props.accessibilityState.selected).toBe(true);
    // 옛 시트의 요소는 어디에도 없다.
    for (const id of ['expression-sheet-search', 'expression-sheet-close', 'expression-sheet-tabs']) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('창이 서 있는 동안 알약은 펼친 채다 - 키보드가 내려가며 포커스를 잃어도 접히지 않는다(입력창이 안 움직인다)', async () => {
    const store = await loadedStore();
    mount(store);
    fireEvent(input(), 'focus');
    expect(screen.getByTestId('composer-tools')).toBeTruthy();
    openPanel();
    fireEvent(input(), 'blur'); // 키보드가 내려갔다
    expect(screen.getByTestId('composer-tools')).toBeTruthy();
    // 창이 거두어지면 펼침의 이유가 없어 접힌다(대조).
    act(() => rest?.());
    expect(screen.queryByTestId('composer-panel')).toBeNull();
    expect(screen.getByTestId('composer-expression').props.accessibilityLabel).toBe('이모티콘 고르기');
  });

  it('오프라인이면 누를 수 없다', async () => {
    const store = await loadedStore();
    mount(store, {expressionBundle: true, offline: true});
    openPanel();
    expect(screen.queryByTestId('expression-panel')).toBeNull();
  });

  it('입력창을 누르면 키보드가 돌아오고 창은 키보드가 다 올라온 뒤에 걷힌다 - 미리 보기는 그대로 남는다', async () => {
    const store = await loadedStore();
    mount(store);
    openPanel();
    pick('dam_kk');
    fireEvent(input(), 'focus');
    expect(screen.getByTestId('expression-panel')).toBeTruthy(); // 올라오는 동안은 그대로
    act(() => emit('keyboardDidShow'));
    expect(screen.queryByTestId('expression-panel')).toBeNull();
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    expect(screen.getByTestId('composer-expression').props.accessibilityLabel).toBe('이모티콘 고르기');
  });

  it('☺ 를 한 번 더 누르면(키보드 단추) 키보드가 돌아온다 - 입력칸에 초점을 준다', async () => {
    const store = await loadedStore();
    mount(store);
    openPanel();
    openPanel(); // 키보드 단추
    expect(screen.getByTestId('expression-panel')).toBeTruthy(); // 키보드가 올라오는 동안은 그대로
    act(() => emit('keyboardDidShow'));
    expect(screen.queryByTestId('expression-panel')).toBeNull();
  });

  it('목록을 누르면(쉬기) 창이 거두어진다', async () => {
    const store = await loadedStore();
    mount(store);
    openPanel();
    expect(screen.getByTestId('expression-panel')).toBeTruthy();
    act(() => rest?.());
    expect(screen.queryByTestId('expression-panel')).toBeNull();
  });
});

describe('미리 보기 — 입력창 위에 그림과 작은 ✕만', () => {
  it('고르면 서고(보내지 않는다) 보이는 글은 없다 - ✕ 의 낭독 이름만 있다. 창은 그대로다', async () => {
    const store = await loadedStore();
    const {onSend} = mount(store);
    openPanel();
    pick('dam_kk');
    const preview = screen.getByTestId('composer-expression-preview');
    // 그림 칸은 낭독에서 빠져 있다(그림의 뜻은 ✕ 의 이름이 말한다) - 숨긴 요소까지 찾는다.
    expect(within(preview).getByTestId('img-large-dam_kk', {includeHiddenElements: true})).toBeTruthy();
    expect(within(preview).queryAllByText(/./)).toHaveLength(0); // 보이는 글자 0
    const clear = within(preview).getByTestId('composer-expression-preview-clear');
    expect(clear.props.accessibilityRole).toBe('button');
    expect(clear.props.accessibilityLabel).toBe('킹받네 · 농담곰 미리 보기 지우기');
    expect(screen.getByTestId('expression-panel')).toBeTruthy(); // 창은 그대로
    expect(onSend).not.toHaveBeenCalled();
  });

  it('다른 것을 누르면 바뀐다 - 미리 보기는 하나뿐이다', async () => {
    const store = await loadedStore();
    mount(store);
    openPanel();
    pick('dam_kk');
    pick('dam_haa');
    expect(screen.getAllByTestId('composer-expression-preview')).toHaveLength(1);
    expect(screen.getByTestId('composer-expression-preview-clear').props.accessibilityLabel).toBe('하 · 농담곰 미리 보기 지우기');
  });

  it('✕ 는 지우고, 소리로 알린다(눌린 단추가 사라진다) - 글 없이는 보내기가 다시 닫힌다', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const store = await loadedStore();
    mount(store);
    openPanel();
    expect(sendDisabled()).toBe(true);
    pick('dam_kk');
    expect(sendDisabled()).toBe(false); // 글 없이 그림만 보내도 된다
    fireEvent.press(screen.getByTestId('composer-expression-preview-clear'));
    expect(screen.queryByTestId('composer-expression-preview')).toBeNull();
    expect(sendDisabled()).toBe(true);
    expect(announce).toHaveBeenCalledWith('미리 보기를 지웠어요');
  });
});

describe('보내기 하나 — 그림과 글을 같이(와이어는 큰 표현 메시지 → 글 메시지, 호스트의 묶음 보내기)', () => {
  it('글 없이 그림만: onSend("", {expression}) 한 번 - 보낸 뒤 미리 보기가 비고 창은 그대로다', async () => {
    const store = await loadedStore();
    const {onSend} = mount(store);
    openPanel();
    pick('dam_kk');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('', {expression: expect.objectContaining({id: kk.id, name: 'dam_kk'})});
    expect(haptics.light).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('composer-expression-preview')).toBeNull();
    expect(screen.getByTestId('expression-panel')).toBeTruthy();
  });

  it('글과 함께: 같은 호출 하나에 글과 표현이 실린다 - 입력창의 글은 비워진다', async () => {
    const store = await loadedStore();
    const {onSend} = mount(store);
    openPanel();
    pick('dam_haa');
    fireEvent.changeText(input(), '고생 많았어요');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('고생 많았어요', {expression: expect.objectContaining({id: haa.id})});
    expect(screen.getByTestId('composer-input').props.value).toBe('');
  });

  it('고른 뒤 그 표현이 숨겨졌거나 지워졌다면 보내지 않고 한 문장으로 말한다 - 미리 보기는 남아 다시 고르게 한다', async () => {
    const store = await loadedStore();
    const {onSend} = mount(store);
    openPanel();
    pick('dam_kk');
    jest.spyOn(store, 'snapshot').mockReturnValue({...store.snapshot(), items: [haa, parrot]});
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-expression-unavailable').props.accessibilityRole).toBe('alert');
    expect(screen.getByText('이 표현을 지금 쓸 수 없어요. 다시 골라 주세요.')).toBeTruthy();
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    // 다시 고르면 문장이 걷힌다.
    pick('dam_haa');
    expect(screen.queryByTestId('composer-expression-unavailable')).toBeNull();
  });

  it('스레드 입력창(묶음 없음): 이모티콘은 `:이름:` 글로 입력칸에 들어가고 미리 보기는 서지 않는다', async () => {
    const store = await loadedStore();
    const {onSend} = mount(store, {});
    openPanel();
    pick('dam_kk');
    expect(screen.getByTestId('composer-input').props.value).toBe(':dam_kk: ');
    expect(screen.queryByTestId('composer-expression-preview')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('이모지 — 글자처럼 캐럿 자리에 들어간다(미리 보기로 가지 않는다)', () => {
  const placeCaret = (at: number) => fireEvent(input(), 'selectionChange', {nativeEvent: {selection: {start: at, end: at}}});

  it('표준 그림 문자와 팀의 작은 이모지가 글 가운데 캐럿 자리에 들어간다', async () => {
    const store = await loadedStore();
    mount(store);
    fireEvent.changeText(input(), '안녕');
    placeCaret(1);
    openPanel();
    fireEvent.press(screen.getByTestId('expression-panel-tab-emoji'));
    fireEvent.press(await screen.findByTestId('emoji-pick-🎉'));
    await waitFor(() => expect(input().props.value).toBe('안🎉녕'));
    expect(screen.queryByTestId('composer-expression-preview')).toBeNull();
    // 이어서: 캐럿은 넣은 글자 뒤다 - 팀의 작은 이모지는 앞뒤를 띄운다.
    fireEvent.press(await screen.findByTestId('expression-pick-party_parrot'));
    await waitFor(() => expect(input().props.value).toBe('안🎉 :party_parrot: 녕'));
    expect(screen.getByTestId('expression-panel')).toBeTruthy(); // 창은 그대로(키보드가 안 돌아온다)
  });

  it('캐럿을 한 번도 모르는 초안(복원된 글)은 끝에 붙는다', async () => {
    const store = await loadedStore();
    mount(store);
    openPanel();
    fireEvent.press(screen.getByTestId('expression-panel-tab-emoji'));
    fireEvent.press(await screen.findByTestId('emoji-pick-🎉'));
    await waitFor(() => expect(input().props.value).toBe('🎉'));
  });
});
