import 'react-native-url-polyfill/auto';
import React from 'react';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import {Dimensions, Keyboard, StyleSheet} from 'react-native';
import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {createExpressionFixtureServer, type ExpressionFixtureRequest} from '@momo/core/features/expressions/fixtureServer';
import {FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import {emptyExpressionFavorites, toggleExpressionFavorite} from '@momo/core/features/expressions/favorites';
import {resetSuggestMuteForTest} from '@momo/core/features/expressions/suggestMute';
import type {Expression} from '@momo/core/features/expressions/types';
import {emptyExpressionUsage, recordExpressionUse} from '@momo/core/features/expressions/usage';
import {slopTo, space, TOUCH_TARGET} from '../src/design/tokens';
import {Composer} from '../src/features/conversation/Composer';
import {composerFloat} from '../src/features/conversation/convDesign';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {rememberEmojiCatalog} from '../src/features/emoji/catalogMemory';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {resetPanelTab} from '../src/features/expressions/ExpressionKeyboardPanel';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {createPhoneExpressionStore, type PhoneExpressionStore} from '../src/features/expressions/store';
import {writeExpressionFavorites} from '../src/features/expressions/useExpressionFavorites';
import {__setNonSecretStore, type NonSecretStore} from '../src/storage/kv';
import {pinReduceMotion} from './fixtures/reduceMotion';

jest.mock('../src/features/emoji/catalog', () => ({loadPhoneEmojiCatalog: jest.fn()}));
jest.mock('../src/lib/haptics', () => ({haptics: {event: jest.fn(), light: jest.fn()}}));
// 그림 부품은 자리만 선다: 이 시험은 줄의 동작(언제 서고 무엇을 하는가)을 잰다. 그림 칸 자체는 `expressionImageStable.test` 의 몫이다. 어떤 크기로 그리는지는 `img-<크기>-<이름>` 이 말한다.
jest.mock('../src/features/expressions/ExpressionImage', () => {
  const {View: Box} = require('react-native');
  return {ExpressionImage: ({expression, size}: {expression: {name: string}; size: string}) => <Box testID={`img-${size}-${expression.name}`} />};
});

// =============================================================================
// 키워드 추천 줄 (#5478, 코어 #5454 1단계, 웹 #5476 의 짝) — 글을 치다 0.3초 멈추면 입력창 위에 맞는 그림 몇 개, 누르면 미리 보기, 저절로 보내지 않는다, ✕ 로 이 대화의 그 낱말을 끈다.
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
const LIBRARY = [laughA, laughB, laughC, sigh, hungry, tinyLaugh, other];
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

describe('누르면 미리 보기에 올라간다 — 저절로 보내지 않는다', () => {
  it('고르면 줄은 사라지고 미리 보기가 서며, 5초가 지나도 보내지 않는다. 보내기 한 번에 글과 같이 간다', async () => {
    const {store} = await loadedStore();
    const {onSend} = mount(store);
    typeAndPause('ㅋㅋㅋ');
    fireEvent.press(screen.getByTestId('composer-expression-suggest-item-laugh_b'));
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    expect(row()).toBeNull();
    wait(5000);
    expect(onSend).not.toHaveBeenCalled(); // 자동 전송 없음
    expect(row()).toBeNull();
    expect(input().props.value).toBe('ㅋㅋㅋ'); // 쓴 글은 그대로
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('ㅋㅋㅋ');
    expect(onSend.mock.calls[0][1].expression.name).toBe('laugh_b');
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

  it('스레드 입력창(묶음 보내기가 없다: 미리 보기에 올릴 곳이 없다)에는 없다', async () => {
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

describe('자리', () => {
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

  it('그림과 ✕ 의 자리·크기는 그대로다 - 왼쪽부터 서고(칸 44×44, ✕ 보이는 28 + 눌림 44), 띠는 위로만 자라서 아래 끝은 그대로다', async () => {
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
    expect(28 + 2 * Number(screen.getByTestId('composer-expression-suggest-mute').props.hitSlop)).toBe(TOUCH_TARGET);
    expect(28 + 2 * slopTo(28)).toBe(TOUCH_TARGET);
    // 위 안쪽 여백만 한 단 더 두껍다(덮은 한 줄 말풍선의 윗변이 띠 위로 비어져 나오지 않게). 옆·아래 여백과 알약과의 틈(`marginBottom`)은 그대로라서 아래 끝과 그림의 자리가 안 움직인다.
    expect(Number(tray.paddingTop)).toBe(Number(tray.padding) + space.xs);
    expect(tray.paddingBottom ?? tray.padding).toBe(space.xs);
    const host = flat('composer-expression-suggest-host');
    expect([host.bottom, host.marginBottom]).toEqual(['100%', space.sm]);
  });
});
