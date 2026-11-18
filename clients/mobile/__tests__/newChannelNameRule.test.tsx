import type {LocalePreferencePort} from '@momo/core/i18n';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {SessionProvider} from '../src/session/useSession';
import {NewChannelSheet} from '../src/shell/NewChannelSheet';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {releaseReduceMotion, setReduceMotion} from './fixtures/sheetContract';

// =============================================================================
// 폰 새 채널 시트의 이름 칸 — 웹과 같은 말·같은 처리 (#5834, ADR-0225 D13).
//
// 지키는 것 셋: ① 칸의 값은 친 그대로이고, 친 것과 저장될 이름이 다를 때만 「#… 이름으로 만들어져요」가 선다 ② 안내·자리표시자·거절·실패 문장이
// 사전 키라 영어 화면에 한글이 없다 ③ 줄이 서고 걷혀도 자리가 움직이지 않게 서지 않은 문장의 가장 큰 높이를 자리에 깐다.
// 보낼 때 접은 이름이 나가는 것은 `shellChrome.test.tsx` 의 「새 채널」 흐름이 이미 잠근다(' Design-Review ' → `design-review`).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};
const HANGUL = /[\uAC00-\uD7A3]/;

function port(language: string): LocalePreferencePort {
  return {
    readPreference: () => 'system',
    writePreference: () => {},
    readDevice: () => ({languages: [language], timeZone: 'UTC'}),
  };
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {get: () => 'application/json'},
  } as unknown as Response;
}

async function mount(language: string) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  render(
    <MobileLocaleProvider createController={() => createMobileLocaleController({port: port(language)})}>
      <QueryClientProvider client={client}>
        <SessionProvider member={SELF}>
          <NewChannelSheet onOpenConversation={jest.fn()} onClose={jest.fn()} />
        </SessionProvider>
      </QueryClientProvider>
    </MobileLocaleProvider>,
  );
  await screen.findByTestId('new-channel-name');
}

const nameBox = () => screen.getByTestId('new-channel-name');
const type = (text: string) => fireEvent.changeText(nameBox(), text);
const statusText = (id: 'rule' | 'preview' | 'issue') =>
  screen.getByTestId(`new-channel-name-${id}`).props.children as string;

beforeEach(async () => {
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
  await setReduceMotion(true);
});
afterEach(() => {
  cleanup();
  releaseReduceMotion();
  jest.restoreAllMocks();
});

describe('칸의 값과 「저장될 이름」 줄', () => {
  it.each([
    // 친 것, 줄(null 이면 안내 글이 선다)
    ['design-review', null],
    ['Design Review', '#design-review 이름으로 만들어져요'],
    ['디자인 리뷰', '#디자인-리뷰 이름으로 만들어져요'],
    ['  ', null],
  ])('%j 를 치면 칸은 그대로이고 줄은 %j', async (typed, line) => {
    await mount('ko-KR');
    type(typed);
    expect(nameBox().props.value).toBe(typed);
    if (line === null) {
      expect(screen.queryByTestId('new-channel-name-preview')).toBeNull();
      expect(statusText('rule')).toMatch(/^글자, 숫자, 하이픈\(-\), 밑줄\(_\)로 80자까지/);
    } else {
      expect(statusText('preview')).toBe(line);
      expect(screen.queryByTestId('new-channel-name-rule')).toBeNull();
    }
  });

  it('규칙을 어기면 미리보기 대신 오류가 서고, 칸은 그대로다', async () => {
    await mount('ko-KR');
    type('A.B');
    expect(nameBox().props.value).toBe('A.B');
    expect(statusText('issue')).toBe('글자, 숫자, 하이픈(-), 밑줄(_)만 쓸 수 있어요.');
    expect(screen.queryByTestId('new-channel-name-preview')).toBeNull();
  });
});

describe('영어 화면에는 한글이 없다', () => {
  it('자리표시자 · 안내 · 미리보기 · 거절 문장이 사전의 영어다', async () => {
    await mount('en-US');
    expect(nameBox().props.placeholder).toBe('design-review');
    expect(nameBox().props.placeholder).not.toMatch(HANGUL);
    expect(statusText('rule')).not.toMatch(HANGUL);
    type('Design Review');
    expect(statusText('preview')).toBe('Will be created as #design-review');
    type('a.b');
    expect(statusText('issue')).not.toMatch(HANGUL);
    type('-bad');
    expect(statusText('issue')).not.toMatch(HANGUL);
    type('a'.repeat(81));
    expect(statusText('issue')).toMatch(/80/);
    expect(statusText('issue')).not.toMatch(HANGUL);
  });

  it.each([
    [409, 'new-channel-name-issue', /already exists/i],
    [403, 'new-channel-error', /permission|owner|admin/i],
    [429, 'new-channel-error', /too many|again/i],
  ])('서버가 %i 로 거절하면 그 문장도 영어다', async (status, testID, wording) => {
    globalThis.fetch = jest.fn(async () => response(status, {error: 'refused'})) as unknown as typeof fetch;
    await mount('en-US');
    type('ops-room');
    fireEvent.press(screen.getByTestId('new-channel-create'));
    const shown = await screen.findByTestId(testID);
    expect(shown).toHaveTextContent(wording);
    expect(shown).not.toHaveTextContent(HANGUL);
  });
});

describe('줄이 서고 걷혀도 자리가 움직이지 않는다', () => {
  it('서지 않은 문장 가운데 가장 큰 높이가 자리의 최소 높이가 되고, 문장이 바뀌어도 그대로다', async () => {
    await mount('ko-KR');
    const slot = () => StyleSheet.flatten(screen.getByTestId('new-channel-name-rule').props.style);
    expect(slot().minHeight).toBeUndefined();
    // 화면이 숨은 사본들을 꺾어 잰 높이(안내 2줄·거절 1줄·서버 거절 2줄처럼 제각각)를 알린다.
    for (const [index, height, lines] of [[0, 32, 2], [1, 16, 1], [2, 16, 1], [5, 48, 3]] as const) {
      const copy = screen.getByTestId(`new-channel-name-reserve-${index}`, {includeHiddenElements: true});
      act(() => {
        fireEvent(copy, 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 370, height}}});
        fireEvent(copy, 'textLayout', {nativeEvent: {lines: Array.from({length: lines}, () => ({}))}});
      });
    }
    expect(slot().minHeight).toBe(48);
    type('A.B');
    expect(StyleSheet.flatten(screen.getByTestId('new-channel-name-issue').props.style).minHeight).toBe(48);
    type('Design Review');
    const preview = screen.getByTestId('new-channel-name-preview');
    expect(StyleSheet.flatten(preview.props.style).minHeight).toBe(48);
    // 미리보기는 예약된 줄 수(화면이 꺾은 가장 많은 줄) 안에서 접는다 — 긴 이름이 시트를 밀지 않는다.
    expect(preview.props.numberOfLines).toBe(3);
  });
});
