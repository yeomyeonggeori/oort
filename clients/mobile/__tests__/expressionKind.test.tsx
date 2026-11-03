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
import {AppState} from 'react-native';
import {catalog as enCatalog} from '@momo/core/i18n/generated/en-US';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
  type ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_LIST,
  FIXTURE_MEMBER_ID,
  FIXTURE_READY_DRAFT,
  FIXTURE_WORKSPACE_ID,
  fixtureManualDraft,
} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import {EXPRESSION_TABS as CORE_EXPRESSION_TABS} from '@momo/core/features/expressions/kind';
import {
  EXPRESSION_KINDS,
  type Expression,
  type ExpressionDraft,
  type ExpressionKind,
  type ExpressionList,
  type ExpressionMedia,
} from '@momo/core/features/expressions/types';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {ExpressionComposerPicker} from '../src/features/expressions/ExpressionComposerPicker';
import {ExpressionDraftStep} from '../src/features/expressions/ExpressionDraftStep';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  browseExpressions,
  EXPRESSION_TABS,
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
// 팀 표현의 종류 값 — 폰 몫 (#5112, ADR-0218 증보 4 §10, #4961 후속).
//
// 정본은 웹 시험(`clients/web/src/features/expressions/ExpressionKind.test.tsx`)이다: 같은 세 사실을 폰의 진짜 부품으로 잰다.
//   ① 네 탭이 보관함을 겹치지 않게 나눈다(코어 `expressionsForTab`) — 순수 함수와 시트에 그려진 격자 둘 다.
//   ② 초안 단계가 종류를 미리 고르고(코어 `recommendedKindForDraft`), 사람이 바꾸고, 고른 값이 `Choice.kind` 로 간다.
//   ③ 그렇게 등록한 그림이 **고른 종류의 탭에만** 선다(진짜 가져오기 장 → 코어 fixture 서버 → 시트).
// 가짜는 서버(코어 fixture 서버)와 표준 이모지 목록뿐이다. 추천 규칙 자체(임계값·움직임)는 코어 시험이 서버와 같은 벡터로 잰다 —
// 여기서는 폰이 **그 함수의 답을 미리 고르는가**를 재므로 기대값은 코어 함수를 다시 부르지 않고 낱말로 적는다.
// =============================================================================

const ko = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog});
const en = createMessageService({messageLocale: 'en-US', catalog: enCatalog});

// 종류 이름·설명의 낱말은 ADR-0218 증보 4 §10 이 정한 것이다(planner 결정, #5112 2단계): `emoji` = 팀 이모지(작은 것), `sticker` =
// 이모티콘(큰 것). 폰 시트의 탭 이름(이모티콘 · 이모지 · 팀 이모지 · GIF)과 같은 말이고, 「이모지」만 쓰면 표준 유니코드 이모지 탭과
// 겹친다. 기대값은 사전에서 읽지 않고 **글자로 못 박는다**: 사전에서 읽으면 사전이 옛 낱말로 돌아가도 시험이 함께 따라가서 빨개지지 않는다.
// 순서는 코어 `EXPRESSION_KINDS`(emoji → sticker)다.
const KIND_WORDS = {
  ko: {
    labels: ['팀 이모지', '이모티콘'],
    hintEmoji: '작은 그림이에요. 글 사이와 반응에 써요. 움직여도 팀 이모지예요.',
    hintSticker: '큰 그림이에요. 크게 보내고, 움직이면 GIF에서 볼 수 있어요.',
  },
  en: {
    labels: ['Team emoji', 'Emoticon'],
    hintEmoji:
      'A small picture. Use it between words and in reactions. It stays a team emoji even when it moves.',
    hintSticker:
      'A large picture. It is sent big, and a moving one shows under GIF.',
  },
} as const;
/** 쓰지 않기로 한 옛 이름: 종류 이름 「이모지」·「스티커」(화면의 다른 「팀 이모지」와 겹치거나 탭 이름과 다르다)와 없는 곳 「팀 GIF」. */
const RETIRED_KO = /스티커|팀 GIF/;
const RETIRED_EN = /Sticker|Team GIF/;
const root = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
const base = `${root}/expressions`;
const PNG = FIXTURE_MEDIA.png.image;
const STILL: ExpressionMedia = {small: {...PNG}, large: {...PNG}, thumb: {...PNG}};
const MOVING: ExpressionMedia = FIXTURE_EXPRESSIONS[0].media!;
const imagePicker = jest.requireMock('expo-image-picker') as {
  __state: {result: unknown; failure: unknown; permission: unknown};
  __reset: () => void;
};

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

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;

let serial = 40;
/** 보관함의 등록 하나. `kind` 를 `undefined` 로 주면 키가 없는 등록(옛 서버·옛 캐시)이다. */
function made(
  name: string,
  kind: ExpressionKind | undefined,
  moving: boolean,
): Expression {
  const item = {
    ...FIXTURE_EXPRESSIONS[1],
    id: `00000000-0000-4000-8000-${String(serial++).padStart(12, '0')}`,
    name,
    displayName: name,
    tags: [],
    kind,
    media: moving ? MOVING : STILL,
  } as Expression;
  if (kind === undefined) delete (item as Partial<Expression>).kind;
  return item;
}
// 여섯 등록 — 종류 둘 × 움직임 둘, 그리고 종류 키가 없는 옛 등록 둘(옛 등록은 모두 `sticker`).
const CATALOGUE = [
  made('emoji_still', 'emoji', false),
  made('emoji_moving', 'emoji', true),
  made('sticker_still', 'sticker', false),
  made('sticker_moving', 'sticker', true),
  made('older_still', undefined, false),
  made('older_moving', undefined, true),
];
const SHELVES = {
  emoticon: ['older_still', 'sticker_still'],
  team: ['emoji_moving', 'emoji_still'],
  gif: ['older_moving', 'sticker_moving'],
} as const;

type Tab = (typeof EXPRESSION_TABS)[number];

/** 코어 fixture 서버 + (주면) 이 목록으로 바꾼 보관함 목록 + 손으로 만든 초안의 미리보기 그림. */
function setup(
  options: {items?: Expression[]; drafts?: ExpressionDraft[]} = {},
) {
  const server = createExpressionFixtureServer({nowMs: Date.now()});
  const known = new Map((options.drafts ?? []).map(d => [d.draftId, d]));
  const request = jest.fn(
    async (
      input: ExpressionFixtureRequest,
    ): Promise<ExpressionFixtureResponse> => {
      if (
        options.items &&
        input.method === 'GET' &&
        input.path.split('?')[0] === base
      ) {
        const list: ExpressionList = {
          ...FIXTURE_LIST,
          version: '9',
          items: options.items,
        };
        return {status: 200, json: list};
      }
      // 서버가 모르는(손으로 만든) 초안의 미리보기: 어떤 크기든 그 크기의 그림이다. 이걸 답하지 않으면 미리보기가 안 떠서
      // 등록 단추가 영영 잠긴다 — 종류와 상관없는 가짜 RED 가 된다.
      const image = /\/expression-drafts\/([^/?]+)\/image\?size=(small|large|thumb)/.exec(
        input.path,
      );
      const draft = image ? known.get(image[1]) : undefined;
      if (input.method === 'GET' && image && draft?.state === 'ready') {
        const mime = draft.media[image[2] as 'small' | 'large' | 'thumb'].mime;
        return {
          status: 200,
          bodyBase64:
            mime === 'image/gif'
              ? FIXTURE_MEDIA.gif.bodyBase64
              : FIXTURE_MEDIA.png.bodyBase64,
        };
      }
      return server.request(input);
    },
  );
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    {write: (key: string) => `file:///fixture/${key}`, remove: jest.fn()},
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  return {store, request, server};
}

/** 이 초안은 그림 카드가 「만료」로 읽지 않게 지금 기준으로 산다(코어 fixture 의 시계는 고정이다). */
const live = (draft: ExpressionDraft): ExpressionDraft => ({
  ...draft,
  expiresAtMs: Date.now() + 3_600_000,
});
const stillDraft = (media: ExpressionMedia = STILL): ExpressionDraft =>
  live({...FIXTURE_READY_DRAFT, state: 'ready', code: null, media});
const movingDraft = (): ExpressionDraft => live(FIXTURE_READY_DRAFT);

function openSheet(store: PhoneExpressionStore) {
  const handlers = {
    onClose: jest.fn(),
    onInsert: jest.fn(),
    onInsertExpression: jest.fn(),
    onSend: jest.fn(),
  };
  render(
    <PhoneExpressions.Provider value={store}>
      <ExpressionComposerPicker {...handlers} />
    </PhoneExpressions.Provider>,
  );
  return handlers;
}

const press = async (testID: string) => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
};
const pressTab = (id: Tab) => press(`expression-sheet-tab-${id}`);
const type = async (testID: string, value: string) => {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId(testID), value);
  });
};
const cellNames = () =>
  screen
    .queryAllByTestId(/^expression-pick-/)
    .map(node => String(node.props.testID).replace('expression-pick-', ''))
    .sort();
const text = (testID: string) =>
  screen.getByTestId(testID).props.children as string;
const disabled = (testID: string) =>
  Boolean(screen.getByTestId(testID).props.accessibilityState?.disabled);
/** 지금 고른 줄의 종류들(하나여야 한다). */
const picked = () =>
  EXPRESSION_KINDS.filter(
    kind =>
      screen.getByTestId(`expression-draft-kind-${kind}`).props
        .accessibilityState?.selected === true,
  );

beforeEach(async () => {
  jest.clearAllMocks();
  release = await pinReduceMotion(true);
  AppState.currentState = 'active';
  imagePicker.__reset();
  imagePicker.__state.result = {canceled: true, assets: null};
  (loadPhoneEmojiCatalog as jest.Mock).mockResolvedValue([waving, party]);
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

// ---- ① 네 탭이 보관함을 겹치지 않게 나눈다 ----------------------------------------
describe('네 탭은 같은 보관함을 겹치지 않게 나눈다 (ADR-0218 §10 J2)', () => {
  it('탭 값은 코어의 `EXPRESSION_TABS` 그대로다 — 폰이 따로 적은 목록이 아니다', () => {
    expect(EXPRESSION_TABS).toBe(CORE_EXPRESSION_TABS);
    expect([...EXPRESSION_TABS]).toEqual(['emoticon', 'emoji', 'team', 'gif']);
  });

  it('순수: 이모티콘 = 정지한 sticker, 팀 이모지 = emoji(움직여도), GIF = 움직이는 sticker, 옛 등록은 sticker — 합집합은 전체, 교집합은 없다', () => {
    const names = (tab: Exclude<Tab, 'emoji'>) =>
      browseExpressions(CATALOGUE, tab, '')
        .map(item => item.name)
        .sort();
    expect({
      emoticon: names('emoticon'),
      team: names('team'),
      gif: names('gif'),
    }).toEqual(SHELVES);
    const all = [...names('emoticon'), ...names('team'), ...names('gif')];
    expect([...all].sort()).toEqual(CATALOGUE.map(item => item.name).sort());
    expect(new Set(all).size).toBe(CATALOGUE.length);
  });

  it('시트에 그려진 격자도 같다: 네 탭이 서로 다른 것을 보이고(이모지 탭에는 보관함 등록이 없다) 합치면 보관함 전체다', async () => {
    const {store} = setup({items: CATALOGUE});
    await store.refresh(true);
    openSheet(store);
    await screen.findByTestId('emoji-pick-🎉');
    // 처음 열 때의 이모지 탭: 표준 이모지 목록뿐이다.
    expect(cellNames()).toEqual([]);
    const seen: Record<string, string[]> = {};
    for (const tab of ['emoticon', 'team', 'gif'] as const) {
      await pressTab(tab);
      seen[tab] = cellNames();
    }
    await pressTab('emoji');
    await screen.findByTestId('emoji-pick-🎉');
    seen.emoji = cellNames();
    expect(seen).toEqual({...SHELVES, emoji: []});
    const all = [...seen.emoticon, ...seen.team, ...seen.gif];
    expect(new Set(all).size).toBe(CATALOGUE.length);
    expect([...all].sort()).toEqual(CATALOGUE.map(item => item.name).sort());
  });
});

// ---- ② 초안 단계가 종류를 고른다 ---------------------------------------------------
describe('초안 단계는 종류를 등록하는 순간 정한다 (ADR-0218 §10 J3)', () => {
  async function mountStep(
    draft: ExpressionDraft,
    onApprove = jest.fn().mockResolvedValue(undefined),
  ) {
    const {store, request} = setup({drafts: [draft]});
    const view = render(
      <PhoneExpressions.Provider value={store}>
        <ExpressionDraftStep
          draft={draft}
          onReplace={jest.fn()}
          onApprove={onApprove}
          onAnother={jest.fn()}
        />
      </PhoneExpressions.Provider>,
    );
    // 미리보기가 뜨고 불러와지면 등록 길이 열린다(보기 전에는 못 누른다).
    await waitFor(() =>
      expect(screen.queryByTestId('expression-draft-preview')).toBeTruthy(),
    );
    return {store, request, view, onApprove};
  }
  /** 미리보기를 보고 권한을 확인해 등록 단추를 켠다. */
  async function ready() {
    await waitFor(() =>
      expect(screen.getByTestId('expression-draft-preview')).toBeTruthy(),
    );
    await act(async () => {
      fireEvent(screen.getByTestId('expression-draft-preview'), 'load');
    });
    await press('expression-draft-rights');
    expect(disabled('expression-draft-approve')).toBe(false);
  }

  it.each([
    ['작은 정지 그림', 'still', 'emoji'],
    ['움직이는 그림', 'moving', 'sticker'],
  ] as const)(
    '%s: 추천을 미리 고르고, 그렇게 골랐다고 말하고, 등록하면 그 값이 `Choice.kind` 로 간다',
    async (_label, which, want) => {
      const draft = which === 'still' ? stillDraft() : movingDraft();
      const {onApprove} = await mountStep(draft);
      expect(picked()).toEqual([want]);
      expect(text('expression-draft-kind-auto')).toBe(
        ko.formatMessage('expressions.kind.autoNote'),
      );
      await ready();
      await press('expression-draft-approve');
      await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
      expect(onApprove.mock.calls[0][0]).toEqual({
        draftId: draft.draftId,
        revision: draft.revision,
        sha256: draft.media!.large.sha256,
        kind: want,
      });
    },
  );

  it('사람이 고른 값이 대신 가고, 더는 「골라 뒀어요」라고 하지 않고, 설명이 고른 종류를 따라 바뀐다', async () => {
    const {onApprove} = await mountStep(movingDraft());
    expect(picked()).toEqual(['sticker']);
    expect(text('expression-draft-kind-hint')).toBe(KIND_WORDS.ko.hintSticker);
    await press('expression-draft-kind-emoji');
    expect(picked()).toEqual(['emoji']);
    expect(screen.queryByTestId('expression-draft-kind-auto')).toBeNull();
    expect(text('expression-draft-kind-hint')).toBe(KIND_WORDS.ko.hintEmoji);
    // 추천과 같은 쪽을 사람이 직접 고르면 그것도 「고른 것」이다 — 안내는 돌아오지 않는다.
    await press('expression-draft-kind-sticker');
    expect(picked()).toEqual(['sticker']);
    expect(screen.queryByTestId('expression-draft-kind-auto')).toBeNull();
    await press('expression-draft-kind-emoji');
    await ready();
    await press('expression-draft-approve');
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0][0].kind).toBe('emoji');
  });

  it('고른 값은 그 그림에 묶인다: 다른 그림으로 바뀌면 옛 선택이 따라가지 않고 추천이 다시 선다', async () => {
    const {store, view} = await mountStep(stillDraft());
    await press('expression-draft-kind-sticker');
    expect(picked()).toEqual(['sticker']);
    const other = stillDraft({...STILL, large: {...PNG, sha256: 'c'.repeat(64)}});
    view.rerender(
      <PhoneExpressions.Provider value={store}>
        <ExpressionDraftStep
          draft={{...other, revision: '2'}}
          onReplace={jest.fn()}
          onApprove={jest.fn()}
          onAnother={jest.fn()}
        />
      </PhoneExpressions.Provider>,
    );
    expect(picked()).toEqual(['emoji']);
    expect(screen.getByTestId('expression-draft-kind-auto')).toBeTruthy();
  });

  it('등록하는 동안에는 고를 수 없다 — 이미 보낸 값이 화면과 어긋나지 않는다', async () => {
    let finish: () => void = () => {};
    const onApprove = jest.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    await mountStep(movingDraft(), onApprove);
    await ready();
    await press('expression-draft-approve');
    for (const kind of EXPRESSION_KINDS) {
      expect(disabled(`expression-draft-kind-${kind}`)).toBe(true);
    }
    await press('expression-draft-kind-emoji');
    expect(picked()).toEqual(['sticker']);
    await act(async () => finish());
  });

  it('고르는 줄은 보조기술에 한 묶음(radiogroup · 「종류」)이고 줄마다 radio 다 — 순서는 코어 목록 그대로', async () => {
    await mountStep(movingDraft());
    const group = screen.getByTestId('expression-draft-kind');
    expect(group.props.accessibilityRole).toBe('radiogroup');
    expect(group.props.accessibilityLabel).toBe(
      ko.formatMessage('expressions.kind.legend'),
    );
    // 화면에 선 **차례대로** 읽는다(testID 로 하나씩 찾으면 거꾸로 그려도 같은 답이 나온다): 묶음 안의 radio 줄.
    const rows = within(group).getAllByRole('radio');
    expect(rows.map(row => row.props.testID)).toEqual(
      EXPRESSION_KINDS.map(kind => `expression-draft-kind-${kind}`),
    );
    expect(rows.map(row => row.props.accessibilityLabel)).toEqual([
      ...KIND_WORDS.ko.labels,
    ]);
    // 눈에 보이는 글자도 같다(낭독 이름만 맞고 화면 글자가 다른 경우를 막는다).
    expect(
      rows.map(row => within(row).getByText(/\S/).props.children),
    ).toEqual([...KIND_WORDS.ko.labels]);
    // 웹 초안 카드와 같은 차례(팀 이모지 → 이모티콘)다. 코어 목록이 바뀌면 이 줄이 빨개져 웹·폰이 함께 보게 된다.
    expect([...EXPRESSION_KINDS]).toEqual(['emoji', 'sticker']);
  });

  it('그림이 없는 초안(받지 못했어요)에는 종류를 묻지 않는다', async () => {
    const draft = live(fixtureManualDraft());
    const {store} = setup({drafts: [draft]});
    render(
      <PhoneExpressions.Provider value={store}>
        <ExpressionDraftStep
          draft={draft}
          onReplace={jest.fn()}
          onApprove={jest.fn()}
          onAnother={jest.fn()}
        />
      </PhoneExpressions.Provider>,
    );
    expect(screen.getByTestId('expression-draft-upload')).toBeTruthy();
    for (const id of [
      'expression-draft-kind',
      'expression-draft-kind-hint',
      'expression-draft-kind-auto',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('앱 언어가 영어면 이름·설명·「골라 뒀어요」가 영어다 — 문구는 사전의 것이다', async () => {
    const draft = movingDraft();
    const {store} = setup({drafts: [draft]});
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
          <ExpressionDraftStep
            draft={draft}
            onReplace={jest.fn()}
            onApprove={jest.fn()}
            onAnother={jest.fn()}
          />
        </PhoneExpressions.Provider>
      </MobileLocaleProvider>,
    );
    const group = await screen.findByTestId('expression-draft-kind');
    expect(group.props.accessibilityLabel).toBe(
      en.formatMessage('expressions.kind.legend'),
    );
    expect(
      EXPRESSION_KINDS.map(
        kind =>
          screen.getByTestId(`expression-draft-kind-${kind}`).props
            .accessibilityLabel,
      ),
    ).toEqual([...KIND_WORDS.en.labels]);
    expect(text('expression-draft-kind-hint')).toBe(KIND_WORDS.en.hintSticker);
    expect(text('expression-draft-kind-auto')).toBe(
      en.formatMessage('expressions.kind.autoNote'),
    );
    // 영어가 한국어 문장과 같은 글자가 아니다(사전이 둘 다 있다는 증거).
    expect(text('expression-draft-kind-auto')).not.toBe(
      ko.formatMessage('expressions.kind.autoNote'),
    );
    // 쓰지 않기로 한 옛 이름이 이 단계의 어느 글자·낭독 이름에도 없다.
    expect(JSON.stringify(screen.toJSON())).not.toMatch(RETIRED_EN);
    controller.dispose();
  });

  it('종류 이름은 폰 시트의 탭 이름과 같은 말이다 — 한국어는 글자 그대로, 영어는 단수 · 문장 첫 글자만 대문자', () => {
    // 같은 말을 두 곳에 따로 적었으니, 한쪽만 바뀌면 빨개진다(탭을 고치면 종류 이름도 같이 고치게 한다).
    expect(ko.formatMessage('expressions.kind.emoji')).toBe(
      ko.formatMessage('expressions.sheet.tabTeam'),
    );
    expect(ko.formatMessage('expressions.kind.sticker')).toBe(
      ko.formatMessage('expressions.sheet.tabEmoticon'),
    );
    expect(en.formatMessage('expressions.kind.emoji')).toBe(
      en.formatMessage('expressions.sheet.tabTeam'),
    );
    // 탭 「Emoticons」는 목록의 이름(복수)이고 종류 「Emoticon」은 한 그림의 분류(단수)다. 응답 카드의 발췌 낱말도 단수 「Emoticon」이다.
    expect(en.formatMessage('expressions.kind.sticker')).toBe(
      en.formatMessage('expressions.sheet.tabEmoticon').replace(/s$/, ''),
    );
    expect(en.formatMessage('expressions.kind.sticker')).toBe(
      en.formatMessage('reply.card.excerptExpression'),
    );
    // sentence case: 첫 글자만 대문자, 뒤의 낱말은 소문자(「Team Emoji」가 아니다).
    for (const label of KIND_WORDS.en.labels) {
      expect(label).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    }
    // 이름과 설명이 옛 이름으로 돌아가지 않았다(글자 그대로 못 박은 상수와 사전이 같다).
    expect([
      ko.formatMessage('expressions.kind.emoji'),
      ko.formatMessage('expressions.kind.sticker'),
    ]).toEqual([...KIND_WORDS.ko.labels]);
    expect([
      en.formatMessage('expressions.kind.emoji'),
      en.formatMessage('expressions.kind.sticker'),
    ]).toEqual([...KIND_WORDS.en.labels]);
    expect(ko.formatMessage('expressions.kind.hintEmoji')).toBe(
      KIND_WORDS.ko.hintEmoji,
    );
    expect(ko.formatMessage('expressions.kind.hintSticker')).toBe(
      KIND_WORDS.ko.hintSticker,
    );
    expect(en.formatMessage('expressions.kind.hintEmoji')).toBe(
      KIND_WORDS.en.hintEmoji,
    );
    expect(en.formatMessage('expressions.kind.hintSticker')).toBe(
      KIND_WORDS.en.hintSticker,
    );
  });

  it('한국어 화면 전체에 옛 이름(스티커·팀 GIF)이 없고, 설명이 움직이는 그림을 두 종류 모두에서 말한다', async () => {
    await mountStep(movingDraft());
    expect(JSON.stringify(screen.toJSON())).not.toMatch(RETIRED_KO);
    // 움직이는 그림은 세 번째 종류가 아니다: 팀 이모지는 움직여도 팀 이모지이고, 이모티콘이 움직이면 GIF 에서 본다.
    expect(text('expression-draft-kind-hint')).toMatch(/움직이면 GIF/);
    await press('expression-draft-kind-emoji');
    expect(text('expression-draft-kind-hint')).toMatch(/움직여도 팀 이모지/);
  });
});

// ---- ③ 등록한 그림은 고른 종류의 탭에만 선다 -----------------------------------------
describe('가져오기로 등록하면 고른 종류의 탭에만 선다 (진짜 장 → 코어 fixture 서버 → 시트)', () => {
  // 코어 fixture 서버의 초안은 늘 움직이는 GIF 라서 추천은 `sticker`(→ GIF 탭)다. 사람이 `emoji` 를 고르면 움직이는 그림도
  // 팀 이모지 탭에만 선다(J2: 움직임이 가르는 것은 sticker 뿐).
  it.each([
    ['팀 이모지를 고르면(추천과 다르게)', 'emoji', 'emoji', ['team']],
    ['고르지 않으면(추천 그대로)', null, 'sticker', ['gif']],
  ] as const)(
    '%s → 등록 요청의 kind 가 정해지고, 그림은 한 탭에만 선다',
    async (_label, pick, want, shelves) => {
      const {store, request} = setup();
      await store.refresh(true);
      openSheet(store);
      await screen.findByTestId('emoji-pick-🎉');
      await pressTab('team');
      await press('expression-add-menu');
      await press('expression-add-import');
      imagePicker.__state.result = {
        canceled: false,
        assets: [
          {
            uri: 'file:///cache/ImagePicker/dot.png',
            fileName: 'dot.png',
            mimeType: 'image/png',
            fileSize: 120,
            width: 64,
            height: 64,
          },
        ],
      };
      await press('expression-import-photo');
      await waitFor(() =>
        expect(screen.getByTestId('expression-import-photo-preview')).toBeTruthy(),
      );
      await type('expression-import-name', 'kind_probe');
      await type('expression-import-display-name', '종류 시험');
      await press('expression-import-submit');
      await waitFor(() =>
        expect(screen.getByTestId('expression-draft')).toBeTruthy(),
      );
      await waitFor(() =>
        expect(screen.getByTestId('expression-draft-preview')).toBeTruthy(),
      );
      await act(async () => {
        fireEvent(screen.getByTestId('expression-draft-preview'), 'load');
      });
      if (pick !== null) await press(`expression-draft-kind-${pick}`);
      await press('expression-draft-rights');
      await press('expression-draft-approve');
      await waitFor(() =>
        expect(store.snapshot().items.map(item => item.name)).toContain(
          'kind_probe',
        ),
      );
      // 등록 요청: 본문의 `kind` 가 사람이 고른 값(안 골랐으면 코어가 미리 고른 추천)이다.
      const registered = request.mock.calls
        .map(([input]) => input)
        .filter(input => input.method === 'POST' && input.path === base);
      expect(registered).toHaveLength(1);
      expect((registered[0].body as {kind?: string}).kind).toBe(want);
      expect(store.snapshot().items.find(item => item.name === 'kind_probe')?.kind).toBe(
        want,
      );
      // 이 그림이 보이는 탭은 정확히 하나다.
      const where: string[] = [];
      for (const tab of ['emoticon', 'team', 'gif'] as const) {
        await pressTab(tab);
        if (cellNames().includes('kind_probe')) where.push(tab);
      }
      expect(where).toEqual(shelves);
    },
  );
});
