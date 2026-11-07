import 'react-native-url-polyfill/auto';
import React from 'react';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import {Keyboard, Text} from 'react-native';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {createExpressionFixtureServer, type ExpressionFixtureRequest} from '@momo/core/features/expressions/fixtureServer';
import {FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import {resetSuggestMuteForTest} from '@momo/core/features/expressions/suggestMute';
import type {Expression} from '@momo/core/features/expressions/types';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {rememberEmojiCatalog} from '../src/features/emoji/catalogMemory';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {resetPanelTab} from '../src/features/expressions/ExpressionKeyboardPanel';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {createPhoneExpressionStore, type PhoneExpressionStore} from '../src/features/expressions/store';
import {useExpressionSuggest} from '../src/features/expressions/useExpressionSuggest';
import {
  readExpressionSuggestOn,
  resetExpressionSuggestSettingForTest,
  writeExpressionSuggestOn,
} from '../src/features/expressions/useExpressionSuggestSetting';
import {ExpressionSuggestSettingRow} from '../src/features/profile/ExpressionSuggestSetting';
import {__setNonSecretStore, NON_SECRET_KEYS, type NonSecretStore} from '../src/storage/kv';
import {pinReduceMotion} from './fixtures/reduceMotion';

jest.mock('../src/features/emoji/catalog', () => ({loadPhoneEmojiCatalog: jest.fn().mockResolvedValue([])}));
jest.mock('../src/lib/haptics', () => ({haptics: {event: jest.fn(), light: jest.fn()}}));
// 그림 부품은 자리만 선다: 이 시험은 줄이 서는가 아닌가를 잰다(그림 칸 자체는 `expressionImageStable.test` 의 몫).
jest.mock('../src/features/expressions/ExpressionImage', () => {
  const {View: Box} = require('react-native');
  return {ExpressionImage: ({expression, size}: {expression: {name: string}; size: string}) => <Box testID={`img-${size}-${expression.name}`} />};
});

// =============================================================================
// 설정 › 보기 › 「이모티콘 추천」 켜기·끄기 (#5493, 웹 설정 › 모양 › 대화 표시의 짝, owner 2026-11-07 「설정에서 다 끌 수도 있어요」).
//   · 끄면 입력창 위 추천 줄이 서지 않고(맞는 낱말을 쳐도 0), 켜면 앱을 다시 켜지 않아도 이미 친 글에 0.3초 뒤 다시 선다.
//   · 값은 이 기기 · 이 워크스페이스 · 이 사람의 것(`NON_SECRET_KEYS.expressionSuggest`): 다른 사람의 끔은 닿지 않고, 옛 모양·깨진 값은 켜짐, 저장소가 막혀도 스위치는 눌린 대로 선다.
//   · 줄을 만드는 훅 한 곳이 값을 읽는다: 대화 입력창이든 스레드 입력창이든 그 훅을 쓰는 곳은 모두 따라온다(훅을 직접 불러 잰다).
// 설정 페이지 안의 자리(보기 카드·스위치 상태)는 `settingsPage.test.tsx` 의 같은 이름 묶음이 잰다. 가짜: 서버(코어 fixture)·표준 이모지 목록·그림 부품.
// =============================================================================

const PNG = FIXTURE_MEDIA.png.image;
const PNG_MEDIA = {...FIXTURE_EXPRESSIONS[1].media!, small: {...PNG}, large: {...PNG}};
const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const sticker = (n: number, name: string, tags: string[]): Expression => ({
  ...FIXTURE_EXPRESSIONS[2],
  id: `00000000-0000-4000-8000-0000000007${String(n).padStart(2, '0')}`,
  name,
  displayName: `${name} 표시`,
  tags,
  kind: 'sticker',
  media: PNG_MEDIA,
});
const laugh = sticker(1, 'laugh_a', ['ㅋㅋ', '웃음']);
const sigh = sticker(2, 'sigh_a', ['한숨']);
const LIBRARY = [laugh, sigh];
const DIRECTORY = makeDirectory([]);
const TARGET = {workspaceId: 'ws', channelId: 'ch'};
const SCOPE = 'ws:ch';

function memoryKv(): NonSecretStore {
  const map = new Map<string, string>();
  return {getString: (key: string) => map.get(key), set: (key: string, value: string) => void map.set(key, value), remove: (key: string) => void map.delete(key)} as unknown as NonSecretStore;
}

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;
async function loadedStore() {
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
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  await store.refresh(true);
  return store;
}

/** 진짜 입력창과 진짜 설정 줄(스위치)을 같은 보관함 저장소 아래에 올린다. */
function mount(store: PhoneExpressionStore) {
  return render(
    <PhoneExpressions.Provider value={store}>
      <ConversationLayout
        list={null}
        composer={<Composer recipient="place" channelLabel="agent-lab" directory={DIRECTORY} attachmentTarget={TARGET} onSend={jest.fn()} expressionBundle />}
      />
      <ExpressionSuggestSettingRow workspaceId={FIXTURE_WORKSPACE_ID} memberId={FIXTURE_MEMBER_ID} />
    </PhoneExpressions.Provider>,
  );
}

const SETTING_KEY = `${FIXTURE_WORKSPACE_ID}:${FIXTURE_MEMBER_ID}`.toLowerCase();
const settingMap = () => JSON.parse(kv.getString(NON_SECRET_KEYS.expressionSuggest) ?? '{}') as Record<string, unknown>;
const seedMap = (map: Record<string, unknown>) => kv.set(NON_SECRET_KEYS.expressionSuggest, JSON.stringify(map));
const seedOff = (memberId = FIXTURE_MEMBER_ID) =>
  seedMap({[`${FIXTURE_WORKSPACE_ID}:${memberId}`.toLowerCase()]: {v: 1, workspaceId: FIXTURE_WORKSPACE_ID, memberId, on: false}});

const input = () => screen.getByTestId('composer-input');
const row = () => screen.queryByTestId('composer-expression-suggest');
const rowSwitch = () => screen.getByTestId('settings-expression-suggest-row');
const switchValue = () => Boolean(rowSwitch().props.accessibilityState?.checked);
const typeText = (text: string) => act(() => void fireEvent.changeText(input(), text));
const focusInput = () => act(() => void fireEvent(input(), 'focus'));
const wait = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
const typeAndPause = (text: string) => {
  focusInput();
  typeText(text);
  wait(300);
};

let kv: NonSecretStore;
beforeEach(() => {
  jest.clearAllMocks();
  kv = memoryKv();
  __setNonSecretStore(kv);
  resetSuggestMuteForTest();
  resetExpressionSuggestSettingForTest();
  resetPanelTab();
  rememberEmojiCatalog(null);
  emojiFrequency.reset();
  emojiSkinTone.reset();
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
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
beforeAll(async () => {
  release = await pinReduceMotion(true);
});

describe('입력창 - 끄면 줄이 서지 않고, 켜면 앱을 다시 켜지 않아도 다시 선다', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it('끈 채로 열면 맞는 낱말을 쳐도 줄이 0이다 - 같은 글이 켜져 있으면 뜬다(대조)', async () => {
    seedOff();
    const store = await loadedStore();
    mount(store);
    expect(switchValue()).toBe(false);
    typeAndPause('ㅋㅋㅋ');
    expect(row()).toBeNull();
    wait(1000); // 기다림이 더 지나도 서지 않는다
    expect(row()).toBeNull();
    // 대조: 저장된 끔을 켜 두면(기본) 같은 낱말에 줄이 선다 - 위의 0이 「안 맞아서」가 아님을 보인다.
    act(() => writeExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, true));
    wait(300);
    expect(row()).not.toBeNull();
  });

  it('설정 스위치를 누르면 떠 있던 줄이 그 순간 걷히고, 다시 누르면 이미 친 글에 0.3초 뒤 다시 선다', async () => {
    const store = await loadedStore();
    mount(store);
    expect(switchValue()).toBe(true); // 기본은 켜짐
    typeAndPause('ㅋㅋㅋ');
    expect(row()).not.toBeNull();

    fireEvent.press(rowSwitch());
    expect(switchValue()).toBe(false);
    expect(rowSwitch().props.accessibilityRole).toBe('switch');
    expect(row()).toBeNull(); // 기다림 없이 바로
    expect(input().props.value).toBe('ㅋㅋㅋ'); // 쓰던 글은 그대로
    wait(1000);
    expect(row()).toBeNull();
    typeAndPause('한숨'); // 끈 채로 글을 바꿔 쳐도 줄이 없다
    expect(row()).toBeNull();
    expect(settingMap()[SETTING_KEY]).toEqual({v: 1, workspaceId: FIXTURE_WORKSPACE_ID, memberId: FIXTURE_MEMBER_ID, on: false});

    fireEvent.press(rowSwitch());
    expect(switchValue()).toBe(true);
    expect(row()).toBeNull(); // 켜도 0.3초는 기다린다
    wait(300);
    expect(row()).not.toBeNull();
    expect(settingMap()[SETTING_KEY]).toEqual({v: 1, workspaceId: FIXTURE_WORKSPACE_ID, memberId: FIXTURE_MEMBER_ID, on: true});
  });

  it('줄을 만드는 훅 한 곳이 값을 읽는다 - 이 훅을 쓰는 입력창(대화·스레드)은 모두 따라온다', async () => {
    const store = await loadedStore();
    const seen: number[] = [];
    function Probe({enabled}: {enabled: boolean}) {
      const suggest = useExpressionSuggest({scope: SCOPE, text: 'ㅋㅋㅋ', enabled});
      seen.push(suggest.items.length);
      return <Text testID="probe">{String(suggest.items.length)}</Text>;
    }
    render(
      <PhoneExpressions.Provider value={store}>
        <Probe enabled />
      </PhoneExpressions.Provider>,
    );
    wait(300);
    expect(screen.getByTestId('probe')).toHaveTextContent('1'); // 켜짐: 맞는 그림 하나
    act(() => writeExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, false));
    expect(screen.getByTestId('probe')).toHaveTextContent('0'); // 그 순간 걷힌다
    wait(1000);
    expect(screen.getByTestId('probe')).toHaveTextContent('0');
    act(() => writeExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, true));
    wait(300);
    expect(screen.getByTestId('probe')).toHaveTextContent('1');
  });
});

describe('저장 - 이 기기 · 이 워크스페이스 · 이 사람', () => {
  it('다른 사람이 끈 값은 이 사람에게 닿지 않는다 - 값은 사람마다 따로다', () => {
    seedOff('someone-else');
    expect(readExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID)).toBe(true);
    expect(readExpressionSuggestOn(FIXTURE_WORKSPACE_ID, 'someone-else')).toBe(false);
    // 이 사람이 끄면 다른 사람의 항목은 그대로 남는다.
    writeExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, false);
    expect(readExpressionSuggestOn(FIXTURE_WORKSPACE_ID, 'someone-else')).toBe(false);
    expect(readExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID)).toBe(false);
    expect(Object.keys(settingMap()).sort()).toEqual([SETTING_KEY, `${FIXTURE_WORKSPACE_ID}:someone-else`].sort());
  });

  it('옛 모양·깨진 값은 켜짐이다', () => {
    for (const raw of ['{not json', '[]', '"off"', '0', JSON.stringify({[SETTING_KEY]: {v: 0, workspaceId: FIXTURE_WORKSPACE_ID, memberId: FIXTURE_MEMBER_ID, on: false}}), JSON.stringify({[SETTING_KEY]: false})]) {
      kv.set(NON_SECRET_KEYS.expressionSuggest, raw);
      expect({raw, on: readExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID)}).toEqual({raw, on: true});
    }
  });

  it('저장소가 막혀 쓰지 못해도 스위치는 눌린 대로 서고, 저장소가 돌아오면 저장소가 다시 쥔다', async () => {
    const store = await loadedStore();
    const blocked = jest.spyOn(kv, 'set').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    mount(store);
    fireEvent.press(rowSwitch());
    expect(blocked).toHaveBeenCalled();
    expect(switchValue()).toBe(false);
    expect(readExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID)).toBe(false);
    expect(kv.getString(NON_SECRET_KEYS.expressionSuggest)).toBeUndefined();

    blocked.mockRestore();
    fireEvent.press(rowSwitch());
    expect(switchValue()).toBe(true);
    expect(settingMap()[SETTING_KEY]).toEqual({v: 1, workspaceId: FIXTURE_WORKSPACE_ID, memberId: FIXTURE_MEMBER_ID, on: true});
  });
});
