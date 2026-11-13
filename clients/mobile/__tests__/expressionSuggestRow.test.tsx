import 'react-native-url-polyfill/auto';
import React from 'react';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import {AccessibilityInfo, Dimensions, Keyboard, StyleSheet} from 'react-native';
import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {createExpressionFixtureServer, type ExpressionFixtureRequest} from '@momo/core/features/expressions/fixtureServer';
import {FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import {emptyExpressionFavorites, toggleExpressionFavorite} from '@momo/core/features/expressions/favorites';
import {mutedKeywords, resetSuggestMuteForTest} from '@momo/core/features/expressions/suggestMute';
import type {Expression} from '@momo/core/features/expressions/types';
import {emptyExpressionUsage, recordExpressionUse} from '@momo/core/features/expressions/usage';
import {slopTo, space, TOUCH_TARGET} from '../src/design/tokens';
import {Composer} from '../src/features/conversation/Composer';
import {composerFloat} from '../src/features/conversation/convDesign';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {channelDraftKey, readDraft} from '../src/features/conversation/drafts';
import type {ReplyTarget} from '../src/features/conversation/replyTarget';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {rememberEmojiCatalog} from '../src/features/emoji/catalogMemory';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {resetPanelTab} from '../src/features/expressions/ExpressionKeyboardPanel';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {createPhoneExpressionStore, type PhoneExpressionStore} from '../src/features/expressions/store';
import {writeExpressionFavorites} from '../src/features/expressions/useExpressionFavorites';
import {__setNonSecretStore, type NonSecretStore} from '../src/storage/kv';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {finger} from './fixtures/finger';
import {SWIPE_DISMISS_PT} from '../src/features/expressions/ComposerExpressionSuggest';

jest.mock('../src/features/emoji/catalog', () => ({loadPhoneEmojiCatalog: jest.fn()}));
jest.mock('../src/lib/haptics', () => ({haptics: {event: jest.fn(), light: jest.fn()}}));
// 그림 부품은 자리만 선다: 이 시험은 줄의 동작(언제 서고 무엇을 하는가)을 잰다. 그림 칸 자체는 `expressionImageStable.test` 의 몫이다. 어떤 크기로 그리는지는 `img-<크기>-<이름>` 이 말한다.
jest.mock('../src/features/expressions/ExpressionImage', () => {
  const {View: Box} = require('react-native');
  return {ExpressionImage: ({expression, size}: {expression: {name: string}; size: string}) => <Box testID={`img-${size}-${expression.name}`} />};
});

// =============================================================================
// 키워드 추천 줄 (#5478, 코어 #5454 1단계, 웹 #5476 의 짝) — 글을 치다 0.3초 멈추면 입력창 위에 맞는 그림 몇 개, 누르면 미리 보기, 저절로 보내지 않는다, ✕ 로 이 대화의 그 낱말을 끈다.
// #5588: 문구 안의 낱말 모두를 맞춰 낱말이 나온 차례로 한 줄에 함께 세우고, 누를 때 글이 그 낱말뿐이면 글을 그림으로 바꾸고(보내면 그림만) 문구면 글을 두고 그림을 더한다.
// #5602: 줄은 방금 친 낱말이 키워드일 때만 서고(M1), ✕ 는 그 낱말 하나만 끄고(M2), 「이번만 닫기」(쓸어내리기·접근성 동작)는 다음 키워드까지 닫아 두고, 바꾸기는 낭독으로 알린다(M3).
// 언제 서는지의 가장자리 표는 코어 `suggest.test.ts` 가 잰다. 여기서는 진짜 입력창의 배선(캐럿·닫힘·끔·손짓·알림)을 잰다.
// 진짜 `Composer`·`ConversationLayout`·폰 저장소·코어 맞추기. 가짜: 서버(코어 fixture)·표준 이모지 목록·그림 부품. 줄이 흐름에 들지 않고 입력창이 안 움직이는 것은 시뮬레이터가 잰다.
// =============================================================================

const PNG = FIXTURE_MEDIA.png.image;
const PNG_MEDIA = {...FIXTURE_EXPRESSIONS[1].media!, small: {...PNG}, large: {...PNG}};
const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const sticker = (n: number, name: string, tags: string[], kind: Expression['kind'] = 'sticker'): Expression => ({
  ...FIXTURE_EXPRESSIONS[2],
  id: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, '0')}`,
  name,
  displayName: `${name} 표시`,
  tags,
  kind,
  media: PNG_MEDIA,
});
const laughA = sticker(1, 'laugh_a', ['ㅋㅋ', '웃음']);
const laughB = sticker(2, 'laugh_b', ['ㅋㅋ']);
const laughC = sticker(3, 'laugh_c', ['ㅋㅋ']);
const sigh = sticker(4, 'sigh_a', ['한숨']);
const hungry = sticker(5, 'hungry_a', ['배고픔']);
const tinyLaugh = sticker(6, 'tiny_laugh', ['ㅋㅋ'], 'emoji');
const other = sticker(7, 'hello_a', ['안녕']);
const sincere = sticker(8, 'sincere_a', ['진심']);
const LIBRARY = [laughA, laughB, laughC, sigh, hungry, tinyLaugh, other, sincere];
const party: CatalogEmoji = {glyph: '🎉', name: 'party popper', koreanName: '축하', shortcodes: ['tada'], keywords: [], category: 'activity', version: 1};
const DIRECTORY = makeDirectory([]);
const TARGET = {workspaceId: 'ws', channelId: 'ch'};
const OTHER_TARGET = {workspaceId: 'ws', channelId: 'ch-other'};

function memoryKv(): NonSecretStore {
  const map = new Map<string, string>();
  return {getString: (key: string) => map.get(key), set: (key: string, value: string) => void map.set(key, value), remove: (key: string) => void map.delete(key)} as unknown as NonSecretStore;
}

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;
async function loadedStore(usage: unknown = null) {
  const server = createExpressionFixtureServer();
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    const response = server.request(input);
    const json = response.json as {items?: Expression[]} | undefined;
    return input.method === 'GET' && input.path.split('?')[0] === base && json?.items ? {...response, json: {...json, items: LIBRARY}} : response;
  });
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    {write: jest.fn((key: string) => `file:///fixture/${key}`), remove: jest.fn()},
    {read: () => usage, write: jest.fn()},
  );
  stores.push(store);
  await store.refresh(true);
  return {store, request};
}

function mount(store: PhoneExpressionStore, composerProps: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = jest.fn();
  const element = (target: typeof TARGET) => (
    <PhoneExpressions.Provider value={store}>
      <ConversationLayout
        list={null}
        composer={<Composer recipient="place" channelLabel="agent-lab" directory={DIRECTORY} attachmentTarget={target} onSend={onSend} expressionBundle {...composerProps} />}
      />
    </PhoneExpressions.Provider>
  );
  let view = render(element(TARGET));
  // 입력창을 내리고 다른 대화에서 새로 세운다(끈 낱말의 기억은 입력창이 아니라 모듈에 있다).
  const remountIn = (target: typeof TARGET) => {
    view.unmount();
    view = render(element(target));
  };
  return {onSend, remountIn};
}

const input = () => screen.getByTestId('composer-input');
const row = () => screen.queryByTestId('composer-expression-suggest');
const names = () => within(screen.getByTestId('composer-expression-suggest')).queryAllByTestId(/^composer-expression-suggest-item-/).map(node => String(node.props.testID).replace('composer-expression-suggest-item-', ''));
const typeText = (text: string) => act(() => void fireEvent.changeText(input(), text));
const focusInput = () => act(() => void fireEvent(input(), 'focus'));
const wait = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
/** 입력창에 포커스를 주고 글을 친 뒤 0.3초(300ms) 기다린다. */
const typeAndPause = (text: string) => {
  focusInput();
  typeText(text);
  wait(300);
};

let kv: NonSecretStore;
beforeEach(async () => {
  jest.clearAllMocks();
  kv = memoryKv();
  __setNonSecretStore(kv);
  resetSuggestMuteForTest();
  resetPanelTab();
  rememberEmojiCatalog(null);
  release = await pinReduceMotion(true);
  (loadPhoneEmojiCatalog as jest.Mock).mockResolvedValue([party]);
  emojiFrequency.reset();
  emojiSkinTone.reset();
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  jest.useFakeTimers();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  jest.useRealTimers();
  stores.splice(0).forEach(store => store.dispose());
  __setNonSecretStore(null);
  release?.();
  jest.restoreAllMocks();
});

describe('맞는 그림이 뜬다 — 기기 안에서만', () => {
  it('「ㅋㅋㅋ」: 0.3초 전엔 없고 멈추면 큰 이모티콘만 뜬다(작은 이모지 제외). 글 없는 줄·접근성 이름만·요청 0', async () => {
    const {store, request} = await loadedStore();
    mount(store);
    const before = request.mock.calls.length;
    focusInput();
    typeText('ㅋㅋㅋ');
    wait(299);
    expect(row()).toBeNull();
    wait(1);
    expect(names()).toEqual(['laugh_a', 'laugh_b', 'laugh_c']);
    const found = screen.getByTestId('composer-expression-suggest');
    // 이모티콘 창의 칸과 같은 정지 그림 크기. (그림은 칸의 이름이 대신해서 접근성 트리에서 숨겨져 있다 -> hidden 도 찾는다.)
    expect(within(found).getByTestId('img-grid-laugh_a', {hidden: true})).toBeTruthy();
    expect(found.props.accessibilityRole).toBe('toolbar');
    expect(found.props.accessibilityLabel).toBe('이모티콘 추천');
    expect(within(found).getByTestId('composer-expression-suggest-item-laugh_a').props.accessibilityLabel).toBe('laugh_a 표시 미리 보기에 올리기');
    expect(within(found).getByTestId('composer-expression-suggest-mute').props.accessibilityLabel).toBe('이 낱말 추천 끄기');
    expect(within(found).queryAllByText(/./)).toHaveLength(0); // 안내 글 없음 - 보이는 글자가 하나도 없다
    expect(request.mock.calls.length).toBe(before); // 친 글이 어떤 요청에도 실리지 않는다(맞추기는 기기 안)
  });

  it.each([
    ['한숨', 'sigh_a'],
    ['배고파', 'hungry_a'],
    ['배고프다', 'hungry_a'], // 끝말표: 배고프다 → 배고파 ← 꼬리표 「배고픔」
  ])('「%s」 → %s', async (typed, expected) => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause(typed);
    expect(names()).toEqual([expected]);
  });

  it('안 맞는 글·공백뿐인 글에는 줄이 없고, 계속 치면 줄이 그 순간 사라진다', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('안녕하세요요');
    expect(row()).toBeNull();
    typeAndPause('   ');
    expect(row()).toBeNull();
    typeAndPause('ㅋㅋㅋ');
    expect(row()).not.toBeNull();
    typeText('ㅋㅋㅋㅎ'); // 한 글자 더 - 기다리지 않고 바로 걷힌다
    expect(row()).toBeNull();
    wait(300);
    expect(row()).toBeNull(); // 「ㅋㅋㅎ」은 맞는 것이 없다
  });

  it('최근 쓴 것이 앞이고 즐겨찾기가 다음이다 - 즐겨찾기는 줄이 뜨는 순간 저장소에서 읽는다(입력창을 연 뒤에 바뀌어도 낡지 않는다)', async () => {
    const used = recordExpressionUse(emptyExpressionUsage(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID), laughC.id, 5);
    const {store} = await loadedStore(used);
    mount(store);
    writeExpressionFavorites(toggleExpressionFavorite(emptyExpressionFavorites(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID), laughB.id));
    typeAndPause('ㅋㅋㅋ');
    expect(names()).toEqual(['laugh_c', 'laugh_b', 'laugh_a']);
  });
});

describe('여러 낱말 — 낱말이 나온 차례로 한 줄에 함께 (#5588)', () => {
  it('「ㅋㅋ 개웃기네 진심」: ㅋㅋ 쪽 둘 다음 진심 쪽 하나(맞지 않는 「개웃기네」는 자리가 없다). 낱말을 바꿔 치면 묶음 차례도 바뀐다', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋ 개웃기네 진심');
    expect(names()).toEqual(['laugh_a', 'laugh_b', 'sincere_a']);
    typeAndPause('진심 개웃기네 ㅋㅋ');
    expect(names()).toEqual(['sincere_a', 'laugh_a', 'laugh_b']);
  });
});

describe('누르면 미리 보기에 올라간다 — 저절로 보내지 않는다', () => {
  const DRAFT = channelDraftKey('ch');

  it('글이 그 낱말뿐이면(「ㅋㅋㅋ!!」) 누르는 순간 글과 초안이 지워지고 미리 보기가 선다. 5초가 지나도 보내지 않고, 보내기 한 번에 글 없이 그림만 간다 (#5588)', async () => {
    const {store} = await loadedStore();
    const {onSend} = mount(store, {draftKey: DRAFT});
    typeAndPause('ㅋㅋㅋ!!');
    expect(readDraft(DRAFT)).toBe('ㅋㅋㅋ!!');
    fireEvent.press(screen.getByTestId('composer-expression-suggest-item-laugh_b'));
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    expect(row()).toBeNull();
    expect(input().props.value).toBe(''); // 글은 그림으로 바뀌었다
    expect(readDraft(DRAFT)).toBe('');
    wait(5000);
    expect(onSend).not.toHaveBeenCalled(); // 자동 전송 없음
    expect(row()).toBeNull();
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe(''); // 글 없이
    expect(onSend.mock.calls[0][1].expression.name).toBe('laugh_b'); // 그림만
  });

  it('낱말이 문구 안에 있으면(「ㅋㅋㅋ 개웃기네 진심」) 글은 그대로 두고 그림을 더한다 - 보내기 한 번에 글과 그림이 같이 간다 (#5588)', async () => {
    const {store} = await loadedStore();
    const {onSend} = mount(store, {draftKey: DRAFT});
    typeAndPause('ㅋㅋㅋ 개웃기네 진심');
    fireEvent.press(screen.getByTestId('composer-expression-suggest-item-sincere_a'));
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    expect(row()).toBeNull();
    expect(input().props.value).toBe('ㅋㅋㅋ 개웃기네 진심'); // 쓴 글은 그대로
    expect(readDraft(DRAFT)).toBe('ㅋㅋㅋ 개웃기네 진심');
    wait(5000);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('ㅋㅋㅋ 개웃기네 진심');
    expect(onSend.mock.calls[0][1].expression.name).toBe('sincere_a');
  });

  it('이미 미리 보기가 있으면 다른 글에도 줄이 서지 않는다(보내기 한 번에 큰 그림은 하나)', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋㅋ');
    fireEvent.press(screen.getByTestId('composer-expression-suggest-item-laugh_a'));
    typeAndPause('ㅋㅋㅋ ㅋㅋ'); // 새 글 - 미리 보기가 없었다면 다시 맞춘다
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    expect(row()).toBeNull();
  });
});

describe('✕ — 이 대화에서 그 낱말 추천을 끈다', () => {
  it('여러 낱말 줄의 ✕ 는 줄을 띄운 낱말 하나만 끈다 - 이름 「이 낱말 추천 끄기」와 같은 수 (#5602 M2)', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋ 개웃기네 진심');
    expect(screen.getByTestId('composer-expression-suggest-mute').props.accessibilityLabel).toBe('이 낱말 추천 끄기');
    fireEvent.press(screen.getByTestId('composer-expression-suggest-mute'));
    expect(row()).toBeNull();
    expect(mutedKeywords('ws:ch')).toEqual(['진심']); // 옛 판은 [ㅋㅋ, 진심] 둘을 껐다
    typeAndPause('진심');
    expect(row()).toBeNull();
    typeAndPause('진심 한숨');
    expect(names()).toEqual(['sigh_a']);
    typeAndPause('진심 ㅋㅋ'); // ㅋㅋ 는 꺼지지 않았다. 끈 진심 쪽 그림은 그 줄에도 없다
    expect(names()).toEqual(['laugh_a', 'laugh_b', 'laugh_c']);
  });

  it('끈 낱말은 글을 지웠다 다시 쳐도, 입력창을 다시 세워도 안 뜬다. 다른 낱말·다른 대화에는 뜬다', async () => {
    const {store} = await loadedStore();
    const {remountIn} = mount(store);
    typeAndPause('ㅋㅋㅋ');
    fireEvent.press(screen.getByTestId('composer-expression-suggest-mute'));
    expect(row()).toBeNull();
    typeAndPause('');
    typeAndPause('ㅋㅋㅋ');
    expect(row()).toBeNull(); // 같은 낱말은 꺼진 채
    typeAndPause('한숨');
    expect(names()).toEqual(['sigh_a']); // 다른 낱말은 뜬다
    remountIn(OTHER_TARGET); // 다른 대화에서 입력창을 새로 세운다
    typeAndPause('ㅋㅋㅋ');
    expect(names()).toEqual(['laugh_a', 'laugh_b', 'laugh_c']);
    remountIn(TARGET); // 원래 대화로 돌아와 다시 세워도 꺼진 채
    typeAndPause('ㅋㅋ');
    expect(row()).toBeNull();
  });
});

/** 줄이 **선** 횟수: 쉼마다 줄이 없다가 있게 되면 하나. 쉼 사이에 글이 바뀌어 줄은 매번 걷힌다(글이 바뀌는 순간 사라진다). */
function countingPauses() {
  let count = 0;
  return {
    pause(text: string) {
      const before = row() !== null;
      focusInput();
      typeText(text);
      const hidden = row() === null;
      wait(300);
      if ((hidden || !before) && row() !== null) count += 1;
    },
    get count() {
      return count;
    },
  };
}

describe('방금 친 낱말이 키워드일 때만 선다 (#5602 M1)', () => {
  it('확인 숫자: 「ㅋㅋ 개웃기네 진심」을 낱말마다 쉬며 치면(쉼 7번) 줄이 선 횟수 2(옛 판 7) - 끝의 줄에는 ㅋㅋ 쪽과 진심 쪽이 함께 있다', async () => {
    const {store} = await loadedStore();
    mount(store);
    const seen = countingPauses();
    for (const text of ['ㅋㅋ', 'ㅋㅋ 개', 'ㅋㅋ 개웃', 'ㅋㅋ 개웃기네', 'ㅋㅋ 개웃기네 ', 'ㅋㅋ 개웃기네 진', 'ㅋㅋ 개웃기네 진심']) seen.pause(text);
    expect(seen.count).toBe(2);
    expect(names()).toEqual(['laugh_a', 'laugh_b', 'sincere_a']);
  });

  it('캐럿은 쉼이 끝날 때 입력창이 아는 값이다: 글 가운데(「진심|」)를 고치면 그 낱말로 서고, 키워드가 아닌 낱말(「오늘|」)이면 끝 낱말이 키워드여도 서지 않는다', async () => {
    const {store} = await loadedStore();
    mount(store);
    const caretAt = (start: number) => act(() => void fireEvent(input(), 'selectionChange', {nativeEvent: {selection: {start, end: start}}}));
    focusInput();
    typeText('오늘 저녁 ㅋㅋ');
    caretAt(2);
    wait(300);
    expect(row()).toBeNull();
    typeText('진심 저녁 ㅋㅋ');
    caretAt(2);
    wait(300);
    expect(names()).toEqual(['sincere_a', 'laugh_a', 'laugh_b']);
  });
});

describe('「이번만 닫기」 — 줄을 아래로 쓸어내리기, 낭독은 같은 일을 하는 접근성 동작 (#5602)', () => {
  const tray = () => screen.getByTestId('composer-expression-suggest') as unknown as {props: Record<string, (event: unknown) => unknown>};

  it('확인 숫자: 반 칸 넘게 쓸어내리면 닫히고 - 같은 낱말 0번, 다음 키워드 1번. 끄지 않는다(✕ 와 다르다)', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋ');
    const hand = finger(tray());
    hand.down(100, 400);
    expect(hand.move(102, 410)).toBe(true); // 아래로, 문턱(8) 넘게 → 줄이 가져간다
    // 가져간 자리부터 잰다(`PanResponder` 는 가져가는 순간 거리를 0으로 둔다): 반 칸(22)보다 2 더, 천천히(속도로 닫히지 않게).
    hand.move(102, 410 + SWIPE_DISMISS_PT + 2, 400);
    hand.up();
    expect(row()).toBeNull();
    expect(mutedKeywords('ws:ch')).toEqual([]);
    const seen = countingPauses();
    seen.pause('ㅋㅋㅋ');
    wait(2000);
    expect(seen.count).toBe(0);
    seen.pause('ㅋㅋㅋ 진심');
    expect(seen.count).toBe(1);
    expect(names()).toEqual(['laugh_a', 'laugh_b', 'sincere_a']);
  });

  it('짧게·천천히 끌다 놓으면 닫히지 않고, 가로로 먼저 움직인 손가락과 탭은 줄이 가져가지 않는다(그림 누르기 그대로)', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋ');
    const slow = finger(tray());
    slow.down(100, 400);
    expect(slow.move(100, 412, 200)).toBe(true);
    slow.move(100, 412 + SWIPE_DISMISS_PT - 2, 400); // 가져간 자리부터 반 칸에 2 모자라게, 천천히
    slow.up();
    expect(row()).not.toBeNull();
    const sideways = finger(tray());
    sideways.down(100, 400);
    expect(sideways.move(130, 410)).toBe(false);
    const up = finger(tray());
    up.down(100, 400);
    expect(up.move(100, 380)).toBe(false);
    const tap = finger(tray());
    tap.down(100, 400);
    expect(tap.move(101, 404)).toBe(false);
    expect(row()).not.toBeNull();
    // 짧아도 아래로 빠르게 튕기면 닫는다(0.7pt/ms 넘게).
    const flick = finger(tray());
    flick.down(100, 400);
    expect(flick.move(100, 410, 10)).toBe(true);
    flick.move(100, 420, 10);
    flick.up();
    expect(row()).toBeNull();
  });

  it('낭독: 칸·✕ 의 동작 목록에 「이번만 닫기」가 있고 누르면 쓸어내린 것과 같다 - 두 손가락 Z(나가기)도 같다', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋ');
    const cell = screen.getByTestId('composer-expression-suggest-item-laugh_a');
    expect(cell.props.accessibilityActions).toEqual([{name: expect.any(String), label: '이번만 닫기'}]);
    expect(screen.getByTestId('composer-expression-suggest-mute').props.accessibilityActions).toEqual(cell.props.accessibilityActions);
    fireEvent(cell, 'accessibilityAction', {nativeEvent: {actionName: cell.props.accessibilityActions[0].name}});
    expect(row()).toBeNull();
    typeAndPause('ㅋㅋㅋ');
    expect(row()).toBeNull(); // 다음 키워드까지 닫힌 채
    typeAndPause('ㅋㅋㅋ 한숨');
    expect(names()).toEqual(['laugh_a', 'laugh_b', 'sigh_a']);
    act(() => void screen.getByTestId('composer-expression-suggest').props.onAccessibilityEscape());
    expect(row()).toBeNull();
    typeAndPause('ㅋㅋㅋ 한숨!!');
    expect(row()).toBeNull();
    expect(mutedKeywords('ws:ch')).toEqual([]);
  });

  it('줄이 설 수 없는 동안(키보드를 내림)에 글을 다 지워도 닫힘이 풀린다 - 돌아와 같은 낱말을 치면 선다', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋ');
    const cell = screen.getByTestId('composer-expression-suggest-item-laugh_a');
    fireEvent(cell, 'accessibilityAction', {nativeEvent: {actionName: cell.props.accessibilityActions[0].name}});
    act(() => void fireEvent(input(), 'blur'));
    typeText('');
    typeText('ㅋㅋㅋ');
    focusInput();
    wait(300);
    expect(row()).not.toBeNull();
  });

  it('보내면 닫힘이 풀린다 - 같은 낱말을 다시 치면 선다', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋ');
    const cell = screen.getByTestId('composer-expression-suggest-item-laugh_a');
    fireEvent(cell, 'accessibilityAction', {nativeEvent: {actionName: cell.props.accessibilityActions[0].name}});
    typeAndPause('ㅋㅋㅋ');
    expect(row()).toBeNull();
    fireEvent.press(screen.getByTestId('composer-send'));
    typeAndPause('ㅋㅋ');
    expect(row()).not.toBeNull();
  });
});

describe('「바꾸기」는 낭독으로 한 번 알린다 (#5602 M3)', () => {
  it('글이 그 낱말뿐이라 글이 지워질 때 알림 1번, 문구에 그림을 더할 때는 0번', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋㅋ!!');
    fireEvent.press(screen.getByTestId('composer-expression-suggest-item-laugh_b'));
    expect(input().props.value).toBe('');
    expect(announce.mock.calls).toEqual([['쓴 글을 laugh_b 표시 이모티콘으로 바꿨어요']]);
    fireEvent.press(screen.getByTestId('composer-send'));
    announce.mockClear();
    typeAndPause('ㅋㅋㅋ 개웃기네 진심');
    fireEvent.press(screen.getByTestId('composer-expression-suggest-item-sincere_a'));
    expect(input().props.value).toBe('ㅋㅋㅋ 개웃기네 진심');
    expect(announce).not.toHaveBeenCalled();
  });
});

describe('답글 머리말이 걸려 있어도 선다 (#5490)', () => {
  it('머리말이 걸린 입력창에도 줄이 서고, 그림을 누르면 미리 보기에 오른다 - 머리말은 그대로이고 저절로 보내지 않는다', async () => {
    const {store} = await loadedStore();
    const reply: ReplyTarget = {messageId: 'message-1', authorMemberId: 'author-1', rootId: 'root-1', mine: true, excerpt: {kind: 'text', text: '금요일에 배포해요'}};
    const {onSend} = mount(store, {replyTarget: reply, onCancelReply: jest.fn()});
    typeAndPause('ㅋㅋㅋ');
    expect(names()).toEqual(['laugh_a', 'laugh_b', 'laugh_c']);
    fireEvent.press(screen.getByTestId('composer-expression-suggest-item-laugh_b'));
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    expect(screen.getByTestId('reply-draft-card')).toBeTruthy();
    expect(row()).toBeNull();
    wait(5000);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('줄이 서지 않는 때', () => {
  it('이모티콘 창이 열려 있는 동안에는 없다(키보드로 칠 때만)', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋㅋ');
    expect(row()).not.toBeNull();
    fireEvent.press(screen.getByTestId('composer-expression'));
    expect(row()).toBeNull();
    wait(1000);
    expect(row()).toBeNull();
  });

  it('입력창에 포커스가 없으면(키보드를 내렸으면) 없고, 돌아오면 다시 맞춘다', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋㅋ');
    expect(row()).not.toBeNull();
    act(() => void fireEvent(input(), 'blur'));
    expect(row()).toBeNull();
    wait(1000);
    expect(row()).toBeNull();
    focusInput();
    wait(300);
    expect(row()).not.toBeNull();
  });

  it('묶음 보내기를 켜지 않은 입력창(미리 보기에 올릴 곳이 없다)에는 없다', async () => {
    const {store} = await loadedStore();
    mount(store, {expressionBundle: false});
    typeAndPause('ㅋㅋㅋ');
    expect(row()).toBeNull();
  });

  it('오프라인에서는 없다(그림을 받을 수 없다)', async () => {
    const {store} = await loadedStore();
    mount(store, {offline: true});
    typeAndPause('ㅋㅋㅋ');
    expect(row()).toBeNull();
  });
});

type JsonNode = {type: string; props: Record<string, unknown>; children: Array<JsonNode | string> | null};
/** 흐름 안의 화면: 절대 위치 층(흐름 밖이라 자리를 먹지 않는다)을 뺀 나머지 트리. 이것이 같으면 도크·목록의 배치 입력이 같다. */
function flowTree(node: JsonNode | JsonNode[] | string | null): unknown {
  if (node === null || typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flowTree);
  if ((StyleSheet.flatten(node.props.style as never) as {position?: string} | undefined)?.position === 'absolute') return null;
  // 손잡이(함수)는 렌더마다 새 값이라 뺀다: 배치를 정하는 것은 값(스타일·글·속성)이다.
  const values = Object.fromEntries(Object.entries(node.props).filter(([, value]) => typeof value !== 'function'));
  return {type: node.type, props: {...values, style: StyleSheet.flatten(node.props.style as never)}, children: (node.children ?? []).map(flowTree).filter(child => child !== null)};
}

describe('자리', () => {
  it('줄이 서고 질 때 대화 목록 이동 0 (#5602): 화면에서 흐름 안의 트리가 줄이 선 때·진 때·다시 선 때 똑같다 - 도크 높이가 그대로라 목록이 밀리지 않는다', async () => {
    const {store} = await loadedStore();
    mount(store);
    focusInput();
    typeText('ㅋㅋ');
    const before = flowTree(screen.toJSON() as JsonNode);
    wait(300);
    expect(row()).not.toBeNull();
    const withRow = flowTree(screen.toJSON() as JsonNode);
    const cell = screen.getByTestId('composer-expression-suggest-item-laugh_a');
    fireEvent(cell, 'accessibilityAction', {nativeEvent: {actionName: cell.props.accessibilityActions[0].name}});
    expect(row()).toBeNull();
    const withoutRow = flowTree(screen.toJSON() as JsonNode);
    typeAndPause('ㅋㅋ 한숨');
    expect(row()).not.toBeNull();
    typeText('ㅋㅋ');
    wait(300);
    // 「ㅋㅋ」(0째)는 이미 닫았지만 「ㅋㅋ 한숨」에서 풀렸다 → 같은 글에서 다시 선다.
    expect(row()).not.toBeNull();
    const back = flowTree(screen.toJSON() as JsonNode);
    expect(withRow).toEqual(before);
    expect(withoutRow).toEqual(before);
    expect(back).toEqual(before);
  });

  it('도크 밖으로 뜬다: 흐름에 들지 않고(서고 사라져도 입력창·대화가 안 움직인다) 바깥 칸은 눌림을 받지 않는다', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋㅋ');
    const host = screen.getByTestId('composer-expression-suggest-host');
    const style = StyleSheet.flatten(host.props.style);
    expect(style.position).toBe('absolute');
    expect(style.bottom).toBe('100%');
    expect(host.props.pointerEvents).toBe('box-none');
    // 입력창 뿌리 바로 아래에 멘션 목록과 같은 층으로 선다.
    expect(within(screen.getByTestId('composer-root')).getByTestId('composer-expression-suggest-host')).toBeTruthy();
  });
});

// 덮는 층의 모양 (#5492, 검증 7b M1): 내용 폭만 한 카드(그림 셋이면 약 188pt)는 덮은 마지막 말풍선의 조각이 카드 옆·위로 비어져 나와 반쯤 잘린 말풍선처럼 읽혔다.
// 폰 시험에는 배치 엔진이 없어서(조각이 비어져 나오는지는 화면 캡처의 몫) 여기서는 폭과 자리를 정하는 **스타일 값**을 재고, 알약과 같은 폭인지는 알약의 실제 스타일과 맞대어 본다.
describe('덮는 층은 알약 폭 전체의 띠다', () => {
  const flat = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<string, unknown>;
  /** 한 변의 실제 바깥 여백: 그 변 값이 먼저이고 없으면 `marginHorizontal` 이다. */
  const edge = (style: Record<string, unknown>, side: 'marginLeft' | 'marginRight') => Number(style[side] ?? style.marginHorizontal ?? 0);

  it('내용 폭에 갇히지 않고 양쪽 바깥 여백이 알약과 같다 - 띠의 폭 = 알약의 폭(거터 안쪽 끝에서 끝)', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋㅋ'); // 그림 셋(옛 카드는 약 188pt)
    const host = flat('composer-expression-suggest-host');
    const tray = flat('composer-expression-suggest');
    const pill = flat('composer-pill');
    const {width, fontScale} = Dimensions.get('window');
    const inset = composerFloat(width, fontScale);
    // 바깥 칸은 좌우 0: 알약이 선 도크의 폭 전체다. 띠는 거기서 양쪽 바깥 여백만 뺀다.
    expect([host.left, host.right]).toEqual([0, 0]);
    // 폭을 가두는 값이 하나도 없다(옛 카드는 `alignSelf: 'flex-start'` + `maxWidth: '100%'`).
    for (const key of ['alignSelf', 'maxWidth', 'width', 'minWidth', 'flexBasis', 'flexGrow', 'flexShrink']) {
      expect({[key]: tray[key]}).toEqual({[key]: undefined});
    }
    // 양쪽 바깥 여백이 알약의 것과 같다(옛 카드는 왼쪽 한 변뿐) -> 양끝이 알약의 양쪽 가장자리와 맞는다.
    expect([edge(pill, 'marginLeft'), edge(pill, 'marginRight')]).toEqual([inset, inset]);
    expect([edge(tray, 'marginLeft'), edge(tray, 'marginRight')]).toEqual([inset, inset]);
    expect(width - edge(tray, 'marginLeft') - edge(tray, 'marginRight')).toBe(width - edge(pill, 'marginLeft') - edge(pill, 'marginRight'));
  });

  it('그림은 왼쪽부터 서고 ✕ 는 띠의 오른쪽 끝이다(owner 목업) - 칸 44×44, ✕ 보이는 28 + 눌림 44, 띠는 위로만 자라서 아래 끝은 그대로다', async () => {
    const {store} = await loadedStore();
    mount(store);
    typeAndPause('ㅋㅋㅋ');
    const tray = flat('composer-expression-suggest');
    // 왼쪽부터 쌓는다: 오른쪽 끝으로 미는 정렬 값이 없다.
    expect(tray.flexDirection).toBe('row');
    expect(tray.justifyContent).toBeUndefined();
    for (const name of ['laugh_a', 'laugh_b', 'laugh_c']) {
      const cell = flat(`composer-expression-suggest-item-${name}`);
      expect([cell.width, cell.height]).toEqual([TOUCH_TARGET, TOUCH_TARGET]);
    }
    const mute = flat('composer-expression-suggest-mute');
    expect([mute.width, mute.height]).toEqual([28, 28]);
    // ✕ 만 자기 왼쪽 여백으로 오른쪽 끝에 선다. 오른쪽 여백은 예전 값 그대로다(띠 안쪽 끝과의 틈).
    expect([mute.marginLeft, mute.marginRight]).toEqual(['auto', space.xs]);
    expect(28 + 2 * Number(screen.getByTestId('composer-expression-suggest-mute').props.hitSlop)).toBe(TOUCH_TARGET);
    expect(28 + 2 * slopTo(28)).toBe(TOUCH_TARGET);
    // 위 안쪽 여백만 한 단 더 두껍다(덮은 한 줄 말풍선의 윗변이 띠 위로 비어져 나오지 않게). 옆·아래 여백과 알약과의 틈(`marginBottom`)은 그대로라서 아래 끝과 그림의 자리가 안 움직인다.
    expect(Number(tray.paddingTop)).toBe(Number(tray.padding) + space.xs);
    expect(tray.paddingBottom ?? tray.padding).toBe(space.xs);
    const host = flat('composer-expression-suggest-host');
    expect([host.bottom, host.marginBottom]).toEqual(['100%', space.sm]);
  });
});
