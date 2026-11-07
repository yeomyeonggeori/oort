import 'react-native-url-polyfill/auto';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
// 세 탭의 분류 모델과 입력창의 표현 단추 (#4942, owner 10-31 → 11-07 #5453 → #5452·#5482) — 보내기 왼쪽 단추 하나가 세 탭(이모티콘 · 이모지 · GIF) 창을 연다.
//
// 이 파일의 이름이 말하듯 처음에는 입력창의 바텀시트를 세워 쟀지만, 그 시트는 #5452 가 키보드 자리의 창으로 바꿨고 #5482 가 죽은 시트 코드와 함께 이 파일의
// 시트 시험을 지웠다. 시트 시험이 재던 것은 창의 시험이 이어 잰다 - 창의 구조·네 상태·다시 열기·말 규칙·「＋」: `expressionPanel.test.tsx`, ☺ → 창 → 미리 보기 → 보내기:
// `expressionComposerPanel.test.tsx`, 종류와 등록 뒤의 탭: `expressionKind.test.tsx`. 시트의 검색 칸은 없어졌다(이름·꼬리표 찾기는 입력창 위 키워드 추천 몫, #5454).
//
// 남은 것: ① 순수 모델 - 탭이 고르는 것, 고른 뒤의 동작, 탭 안 차례(최근 먼저), 입력칸에 넣는 토큰(`expressionViews.ts`) ② 입력창의 ☺ 단추의 자리와 보임, 영어 사전.
// 진짜 `Composer`·`ConversationLayout`·폰 저장소를 쓰고, 가짜는 서버(코어 fixture 서버)와 표준 이모지 목록(두 개)뿐이다. 코어 fixture 의 세 표현은 모두 움직이는 GIF 라서
// GIF 보기가 거를 **정지 그림**이 있도록 엄지척 하나를 PNG 로 바꿔 내려 준다(`stillThumbs`). jest 가 못 재는 것(실제 폭·줄바꿈·낭독·키보드·캡처)은 인계의 「스택 검증 메모」다.
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

async function loaded(rewrite?: (item: Expression) => Expression) {
  const made = setup(rewrite);
  await made.store.refresh(true);
  return made;
}

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
    // 창은 **최근** 순이라 엄지척이 앞이다 — 둘이 갈리는 자료라야 「최근 먼저」를 잰다.
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

  // 「눌러 열고 … 큰 이모티콘을 보낸다」 흐름은 키보드 자리의 창이다(#5452): `expressionComposerPanel.test.tsx` 가 ☺ → 창 → 미리 보기 → 보내기 한 번을 잰다.

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
