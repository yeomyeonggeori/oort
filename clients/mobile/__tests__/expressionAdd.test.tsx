import {File} from 'expo-file-system';
import 'react-native-url-polyfill/auto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
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
import {Animated, AppState, StyleSheet} from 'react-native';
import * as api from '@momo/core/lib/api';
import * as host from '@momo/core/runtime/host';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
  type ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';
import {
  expressionChoice,
  expressionDraftCard,
} from '@momo/core/features/expressions/cards';
import {
  FIXTURE_LIST,
  FIXTURE_MEMBER_ID,
  FIXTURE_READY_DRAFT,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {
  MAKE_DEFAULT_SIZE,
  MAKE_PLAYS,
  MOTION_PRESETS,
  STILL_MOTION,
  buildMakeRequest,
} from '@momo/core/features/expressions/make';
import type {
  ExpressionDraft,
  ManualUploadCode,
} from '@momo/core/features/expressions/types';
import {circleLook} from '../src/design/sheetModel';
import {FixedScheme, paletteFor} from '../src/design/theme';
import {PhotoPickRow} from '../src/features/expressions/ExpressionChapter';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {TeamExpressionPicker} from '../src/features/expressions/TeamExpressionPicker';
import {expressionTransport} from '../src/features/expressions/transport';
import {EXPRESSION_ACCEPTED_MIMES} from '../src/features/expressions/photoPicker';
import {
  MAKE_PREVIEW_KEYFRAMES,
  trackValueAt,
} from '../src/features/expressions/makePreviewModel';
import * as uploadTransport from '../src/features/attachments/uploadTransport';
import {makeFailureKey} from '../src/features/expressions/makeFlow';
import {pinReduceMotion} from './fixtures/reduceMotion';

// 팀 이모지 고르개의 「＋」(#4891): 메뉴 두 갈래·가져오기·AI와 만들기. 서버 쪽은 코어 fixture 서버가 맡고, 폰이 정하는
// 규칙은 없다 — 한도·이름 규칙·요청 본문·실패 문장은 코어(와 웹)가 말한 값을 시험이 코어 함수로 다시 계산해 대조한다.

const WEB = join(__dirname, '../../web/src/features/expressions');
const ko = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog});
const root = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
const imagePicker = jest.requireMock('expo-image-picker') as {
  __state: {result: unknown; failure: unknown; permission: unknown};
  __reset: () => void;
};
let release: (() => void) | undefined;
const stores: PhoneExpressionStore[] = [];

function setup(
  options: {importFailure?: ManualUploadCode; addPolicy?: 'members' | 'admins'} = {},
) {
  const server = createExpressionFixtureServer({
    nowMs: Date.now(),
    importFailure: options.importFailure,
  });
  const request = jest.fn(
    async (
      input: ExpressionFixtureRequest,
    ): Promise<ExpressionFixtureResponse> => {
      const response = server.request(input);
      return options.addPolicy &&
        input.method === 'GET' &&
        input.path.endsWith('/expressions')
        ? {
            ...response,
            json: {
              ...(response.json as object),
              addPolicy: options.addPolicy,
            },
          }
        : response;
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
function mount(store: PhoneExpressionStore, node?: React.ReactElement) {
  return render(
    <PhoneExpressions.Provider value={store}>
      {node ?? <TeamExpressionPicker query="" onSelect={jest.fn()} />}
    </PhoneExpressions.Provider>,
  );
}
async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
}
async function type(testID: string, text: string) {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId(testID), text);
  });
}
function album(asset: Record<string, unknown> | null) {
  imagePicker.__state.result =
    asset === null
      ? {canceled: true, assets: null}
      : {
          canceled: false,
          assets: [
            {
              uri: 'file:///cache/ImagePicker/dance.png',
              fileName: 'dance.png',
              mimeType: 'image/png',
              fileSize: 120_000,
              width: 1024,
              height: 768,
              ...asset,
            },
          ],
        };
}
const text = (testID: string) =>
  screen.getByTestId(testID).props.children as string;
const disabled = (testID: string) =>
  Boolean(screen.getByTestId(testID).props.accessibilityState?.disabled);

beforeEach(async () => {
  release = await pinReduceMotion(true);
  AppState.currentState = 'active';
  imagePicker.__reset();
  album(null);
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

describe('「＋」 메뉴', () => {
  it('두 갈래(가져오기·AI와 만들기)를 제자리에서 펼치고, 열림과 이름을 보조기술에 말한다', async () => {
    const {store} = setup();
    await store.refresh(true);
    mount(store);
    const trigger = screen.getByTestId('expression-add-menu');
    expect(trigger.props.accessibilityLabel).toBe(
      ko.formatMessage('expressions.add.trigger'),
    );
    expect(trigger.props.accessibilityState).toMatchObject({expanded: false});
    expect(screen.queryByTestId('expression-add-import')).toBeNull();
    await press('expression-add-menu');
    expect(
      screen.getByTestId('expression-add-menu').props.accessibilityState,
    ).toMatchObject({expanded: true});
    expect(
      screen.getByTestId('expression-add-import').props.accessibilityLabel,
    ).toContain(ko.formatMessage('expressions.add.import'));
    expect(
      screen.getByTestId('expression-add-make').props.accessibilityLabel,
    ).toContain(ko.formatMessage('expressions.add.make'));
    // 두 행은 각각 자기 장으로 들어가고, 장에는 「목록으로」가 있다.
    await press('expression-add-import');
    expect(screen.getByTestId('expression-import')).toBeTruthy();
    expect(
      screen.getByTestId('expression-chapter-back').props.accessibilityLabel,
    ).toBe(ko.formatMessage('expressions.add.backLabel'));
    await press('expression-chapter-back');
    await press('expression-add-menu');
    jest.spyOn(api, 'fetchRoster').mockResolvedValue([]);
    await press('expression-add-make');
    // 「AI와 만들기」는 사진 양식으로 먼저 열리고(#4984), 에이전트에게 부탁하는 길은 그 안의 단추 하나다.
    // 이 가짜 서버에는 이미지 모델 길이 없어 확인이 실패해도 그 단추는 막히지 않는다.
    await waitFor(() =>
      expect(screen.getByTestId('expression-photo-agent')).toBeTruthy(),
    );
    expect(screen.queryByTestId('expression-make')).toBeNull();
    await press('expression-photo-agent');
    expect(screen.getByTestId('expression-make')).toBeTruthy();
  });

  it('관리자 전용 정책에서는 일반 멤버에게 잠기고, 끊기면 잠기며, 잠긴 이유를 말한다', async () => {
    const roster = jest.spyOn(api, 'fetchRoster');
    const member = (role: 'member' | 'admin') =>
      [
        {id: FIXTURE_MEMBER_ID, role, kind: 'human', status: 'active'},
      ] as unknown as Awaited<ReturnType<typeof api.fetchRoster>>;
    // 정책이 members 이면 명단을 부르지 않는다.
    const open = setup();
    await open.store.refresh(true);
    mount(open.store);
    expect(disabled('expression-add-menu')).toBe(false);
    expect(roster).not.toHaveBeenCalled();
    cleanup();
    // admins + 일반 멤버: 잠김 + 이유 한 줄.
    roster.mockResolvedValue(member('member'));
    const admins = setup({addPolicy: 'admins'});
    await admins.store.refresh(true);
    mount(admins.store);
    await act(async () => {});
    expect(disabled('expression-add-menu')).toBe(true);
    expect(text('expression-add-admins-only')).toBe(
      ko.formatMessage('expressions.add.adminsOnly'),
    );
    cleanup();
    // admins + 관리자: 열린다. 끊기면 다시 잠기고 힌트가 말한다.
    roster.mockResolvedValue(member('admin'));
    const adminOk = setup({addPolicy: 'admins'});
    await adminOk.store.refresh(true);
    mount(adminOk.store);
    await act(async () => {});
    expect(disabled('expression-add-menu')).toBe(false);
    await act(async () => adminOk.store.setOnline(false));
    expect(disabled('expression-add-menu')).toBe(true);
    expect(
      screen.getByTestId('expression-add-menu').props.accessibilityHint,
    ).toBe(ko.formatMessage('expressions.add.offlineHint'));
  });
});

describe('가져오기', () => {
  async function openImport() {
    await press('expression-add-menu');
    await press('expression-add-import');
  }
  async function fillMetadata() {
    await type('expression-import-name', 'happy_dance');
    await type('expression-import-display-name', '신나는 춤');
    await type('expression-import-tags', '축하, 춤');
  }

  it('앨범 사진: 올려서 초안을 받고, 미리보기를 본 뒤 권한을 확인해야 등록한다', async () => {
    const {store, request} = setup();
    await store.refresh(true);
    mount(store);
    await openImport();
    album({});
    await press('expression-import-photo');
    await waitFor(() =>
      expect(screen.getByTestId('expression-import-photo-preview')).toBeTruthy(),
    );
    await fillMetadata();
    await press('expression-import-submit');
    await waitFor(() => expect(screen.getByTestId('expression-draft')).toBeTruthy());
    // 웹과 같은 서버 경로·같은 메타데이터, 그림은 multipart 의 file.
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      path: `${root}/expressions/uploads`,
      body: {
        name: 'happy_dance',
        displayName: '신나는 춤',
        tags: ['축하', '춤'],
        subjectMemberId: null,
      },
      file: {
        uri: 'file:///cache/ImagePicker/dance.png',
        name: 'dance.png',
        mime: 'image/png',
      },
    });
    // 미리보기를 보기 전에는 등록할 수 없다 — 권한 확인만으로는 켜지지 않는다.
    await waitFor(() =>
      expect(screen.getByTestId('expression-draft-preview')).toBeTruthy(),
    );
    // 동작 줄이기(이 시험의 기본)에서는 움직이는 그림도 정지 그림(thumb)으로 본다.
    expect(
      request.mock.calls.some(
        ([input]) =>
          input.path.includes('/expression-drafts/') &&
          input.path.includes('/image?size=thumb&'),
      ),
    ).toBe(true);
    expect(disabled('expression-draft-approve')).toBe(true);
    await press('expression-draft-rights');
    expect(disabled('expression-draft-approve')).toBe(true);
    await act(async () => {
      fireEvent(screen.getByTestId('expression-draft-preview'), 'load');
    });
    expect(disabled('expression-draft-approve')).toBe(false);
    // 권한 확인을 걷으면 다시 잠긴다 — 보기만 해서는 등록할 수 없다.
    await press('expression-draft-rights');
    expect(disabled('expression-draft-approve')).toBe(true);
    await press('expression-draft-rights');
    expect(disabled('expression-draft-approve')).toBe(false);
    await press('expression-draft-approve');
    // 보고 고른 바로 그 초안(개정·large 해시)만 등록하고, 목록에 바로 들어온다.
    const uploaded = request.mock.calls.findIndex(([input]) =>
      input.path.endsWith('/expressions/uploads'),
    );
    const draft = (await request.mock.results[uploaded].value)
      .json as ExpressionDraft;
    const choice = expressionChoice(draft, Date.now());
    expect(choice).not.toBeNull();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        method: 'POST',
        path: `${root}/expressions`,
        body: choice,
      }),
    );
    await waitFor(() =>
      expect(store.snapshot().items.map(item => item.name)).toContain(
        'happy_dance',
      ),
    );
    expect(screen.queryByTestId('expression-import')).toBeNull();
  });

  it('링크: 같은 이름 규칙으로 /import 에 보내고, 링크를 적으면 앨범은 잠긴다', async () => {
    const {store, request} = setup();
    await store.refresh(true);
    mount(store);
    await openImport();
    await fillMetadata();
    await type('expression-import-url', 'https://giphy.com/gifs/example');
    expect(disabled('expression-import-photo')).toBe(true);
    await press('expression-import-submit');
    await waitFor(() => expect(screen.getByTestId('expression-draft')).toBeTruthy());
    const call = request.mock.calls.find(([input]) =>
      input.path.endsWith('/expressions/import'),
    )![0];
    expect(call).toEqual({
      method: 'POST',
      path: `${root}/expressions/import`,
      body: {
        name: 'happy_dance',
        displayName: '신나는 춤',
        tags: ['축하', '춤'],
        subjectMemberId: null,
        url: 'https://giphy.com/gifs/example',
      },
    });
    expect('file' in call).toBe(false);
    expect(text('expression-draft-source')).toBe(
      ko.formatMessage('expressions.draft.source', {host: 'giphy.com'}),
    );
  });

  it('한도를 넘는 그림과 규칙을 어기는 이름은 서버를 부르기 전에 막고, 웹과 같은 문장으로 말한다', async () => {
    const {store, request} = setup();
    await store.refresh(true);
    mount(store);
    await openImport();
    await fillMetadata();
    // 5 MiB + 1 바이트.
    album({fileSize: 5 * 1024 * 1024 + 1});
    await press('expression-import-photo');
    await press('expression-import-submit');
    expect(text('expression-import-error')).toBe(
      ko.formatMessage('expressions.import.fileIssue'),
    );
    // 허용 형식 밖(HEIC 가 아닌 그림 형식).
    album({mimeType: 'image/heic'});
    await press('expression-import-photo');
    await press('expression-import-submit');
    expect(text('expression-import-error')).toBe(
      ko.formatMessage('expressions.import.fileIssue'),
    );
    // 정확히 5 MiB 는 한도 안이다.
    album({fileSize: 5 * 1024 * 1024});
    await press('expression-import-photo');
    await type('expression-import-name', 'A');
    await press('expression-import-submit');
    expect(text('expression-import-error')).toBe(
      ko.formatMessage('expressions.import.metadataIssue'),
    );
    expect(
      request.mock.calls.filter(([input]) => input.method !== 'GET'),
    ).toHaveLength(0);
    // 같은 한도·같은 문장이 웹에도 있다.
    const web = readFileSync(join(WEB, 'media.ts'), 'utf8');
    expect(web).toContain(`"${EXPRESSION_ACCEPTED_MIMES.join(',')}"`);
    expect(
      readFileSync(join(WEB, 'TeamExpressionsPanel.tsx'), 'utf8'),
    ).toContain(ko.formatMessage('expressions.import.fileIssue'));
  });

  it('받지 못한 그림의 사유는 코어 문장 그대로이고, 같은 초안에 직접 올려 이어 간다', async () => {
    release?.();
    release = await pinReduceMotion(false);
    const {store, request} = setup({importFailure: 'source_blocked'});
    await store.refresh(true);
    mount(store);
    await openImport();
    await fillMetadata();
    await type('expression-import-url', 'https://giphy.com/gifs/example');
    await press('expression-import-submit');
    await waitFor(() => expect(screen.getByTestId('expression-draft')).toBeTruthy());
    const draft = (
      await request.mock.results[request.mock.results.length - 1].value
    ).json as ExpressionDraft;
    const card = expressionDraftCard(draft, Date.now());
    expect(card.code).toBe('source_blocked');
    // 폰이 사유를 다시 지어 말하지 않는다: 화면의 줄은 코어 카드가 말한 줄이다.
    expect(text('expression-draft-line')).toBe(card.line);
    expect(screen.queryByTestId('expression-draft-approve')).toBeNull();
    expect(
      within(screen.getByTestId('expression-draft-upload')).getByText(
        card.uploadLabel,
      ),
    ).toBeTruthy();
    // 직접 올리기 → PUT …/expression-drafts/{id}/file → 새 개정이 ready 로 와서 등록 길이 열린다.
    album({fileName: 'mine.png', uri: 'file:///cache/ImagePicker/mine.png'});
    await press('expression-draft-upload');
    await waitFor(() =>
      expect(screen.getByTestId('expression-draft-approve')).toBeTruthy(),
    );
    expect(request).toHaveBeenCalledWith({
      method: 'PUT',
      path: `${root}/expression-drafts/${draft.draftId}/file`,
      file: {
        uri: 'file:///cache/ImagePicker/mine.png',
        name: 'mine.png',
        mime: 'image/png',
      },
    });
    // 동작 줄이기가 꺼져 있으면 등록 전 미리보기는 large 이다.
    await waitFor(() =>
      expect(
        request.mock.calls.some(([input]) =>
          input.path.includes('/image?size=large&'),
        ),
      ).toBe(true),
    );
  });

  // #5065 H1: 같은 부품(`PhotoPickRow`)을 쓰는 자리 — 가져오기의 앨범 알약도 시트 위 보조 알약이다(부품 시험은 아래 「앨범 알약」).
  it('앨범 알약은 시트 위 보조 알약이다 — `surface` 채움 + `elevationRest` 그림자 (#5065)', async () => {
    const {store} = setup();
    await store.refresh(true);
    mount(store);
    await openImport();
    const palette = paletteFor('light');
    const pill = StyleSheet.flatten(
      screen.getByTestId('expression-import-photo').props.style,
    );
    expect(pill.backgroundColor).toBe(palette.surface);
    expect(pill.boxShadow).toBe(palette.elevationRest);
    expect(pill.backgroundColor).not.toBe(palette.surfaceMuted);
  });
});

describe('AI와 만들기', () => {
  const agent = {
    id: '00000000-0000-4000-8000-0000000000a1',
    workspaceId: FIXTURE_WORKSPACE_ID,
    kind: 'agent',
    status: 'active',
    displayName: '김인턴',
    handle: 'intern',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
  };
  const channel = {id: 'dm-1', kind: 'dm'} as unknown as api.Channel;
  function wire(sendResults: (Error | null)[] = [null]) {
    const order: string[] = [];
    const sends: unknown[][] = [];
    const calls = {
      dm: jest.spyOn(api, 'openDirectMessage').mockImplementation(async () => {
        order.push('dm');
        return {channel, created: true};
      }),
      create: jest
        .spyOn(api, 'createAttachmentUpload')
        .mockImplementation(async () => {
          order.push('create');
          return {id: `att-${order.length}`, status: 'pending', uploadUrl: 'https://u.invalid/p'};
        }),
      put: jest
        .spyOn(uploadTransport, 'putAttachmentBytes')
        .mockImplementation(() => {
          order.push('put');
          return {done: Promise.resolve({ok: true}), abort: jest.fn()};
        }),
      complete: jest
        .spyOn(api, 'completeAttachmentUpload')
        .mockImplementation(async (_w, _c, id) => {
          order.push('complete');
          return {id} as Awaited<ReturnType<typeof api.completeAttachmentUpload>>;
        }),
      send: jest.spyOn(api, 'sendMessage').mockImplementation(async (...args) => {
        order.push('send');
        sends.push(args);
        const failure = sendResults[Math.min(sends.length, sendResults.length) - 1];
        if (failure) throw failure;
        return {} as Awaited<ReturnType<typeof api.sendMessage>>;
      }),
    };
    // 사람과 잠긴(비활성) 에이전트는 「만들 에이전트」에 서지 않는다.
    jest.spyOn(api, 'fetchRoster').mockResolvedValue([
      agent,
      {...agent, id: 'human-1', kind: 'human', displayName: '사람'},
      {...agent, id: 'suspended-1', status: 'suspended', displayName: '쉬는 에이전트'},
    ] as unknown as Awaited<ReturnType<typeof api.fetchRoster>>);
    return {order, sends, calls};
  }
  async function openMake(onOpenConversation?: (channel: api.Channel) => void) {
    const {store} = setup();
    await store.refresh(true);
    mount(
      store,
      <TeamExpressionPicker
        query=""
        onSelect={jest.fn()}
        onOpenConversation={onOpenConversation}
      />,
    );
    await press('expression-add-menu');
    await press('expression-add-make');
    await waitFor(() =>
      expect(screen.getByTestId('expression-photo-agent')).toBeTruthy(),
    );
    await press('expression-photo-agent');
    await waitFor(() =>
      expect(screen.getByTestId(`expression-make-agent-${agent.id}`)).toBeTruthy(),
    );
    return store;
  }

  it('코어 make.ts 의 요청 본문 그대로, DM → 올릴 자리 → 올리기 → 확인 → 보내기 순서로 한 메시지에 담아 보낸다', async () => {
    const {order, sends} = wire();
    await openMake();
    expect(screen.queryByTestId('expression-make-agent-human-1')).toBeNull();
    expect(screen.queryByTestId('expression-make-agent-suspended-1')).toBeNull();
    await press('expression-make-chip-bounce');
    await press('expression-make-chip-sparkle');
    await type('expression-make-note', '웃는 얼굴로');
    album({});
    await press('expression-make-photo');
    await press('expression-make-submit');
    await waitFor(() => expect(screen.getByTestId('expression-make-sent')).toBeTruthy());
    expect(order).toEqual(['dm', 'create', 'put', 'complete', 'send']);
    const body = buildMakeRequest({
      presets: ['bounce', 'sparkle'],
      note: '웃는 얼굴로',
      size: MAKE_DEFAULT_SIZE,
    });
    expect(sends[0]).toEqual([
      FIXTURE_WORKSPACE_ID,
      'dm-1',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      body,
      {attachmentIds: ['att-2']},
    ]);
    // 코어가 말한 모양: 첫 문장·움직임 줄(영문 id 가 에이전트가 읽는 값)·크기·요청 줄, 파일 이름·주소는 없다.
    expect(body.split('\n')).toEqual([
      '이 사진으로 움직이는 팀 이모티콘을 만들어 주세요.',
      '- 움직임: 통통(bounce), 반짝(sparkle)',
      '- 크기: 360',
      '- 요청: 웃는 얼굴로',
    ]);
    expect(body).not.toContain('dance.png');
  });

  it('다시 시도는 실패한 단계부터 같은 메시지로 이어 가고, 본문이 바뀌면 첨부를 다시 올린다', async () => {
    const boom = new Error('network');
    const {sends, calls} = wire([boom, boom, null]);
    await openMake();
    await press('expression-make-chip-pulse');
    album({});
    await press('expression-make-photo');
    await press('expression-make-submit');
    await waitFor(() => expect(screen.getByTestId('expression-make-error')).toBeTruthy());
    expect(text('expression-make-error')).toBe(
      ko.formatMessage('expressions.make.failSend'),
    );
    // 같은 입력: DM·첨부는 그대로, 같은 clientMsgId 로 다시 보낸다.
    await press('expression-make-submit');
    await waitFor(() => expect(calls.send).toHaveBeenCalledTimes(2));
    expect(calls.dm).toHaveBeenCalledTimes(1);
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.complete).toHaveBeenCalledTimes(1);
    expect(sends[1][2]).toBe(sends[0][2]);
    expect(sends[1][4]).toEqual(sends[0][4]);
    // 보내기를 한 번이라도 시도한 뒤 본문이 바뀌면: 새 메시지 키, 첨부는 다시 올린다(DM 은 그대로).
    await waitFor(() => expect(screen.getByTestId('expression-make-error')).toBeTruthy());
    await type('expression-make-note', '더 크게');
    await press('expression-make-submit');
    await waitFor(() => expect(calls.send).toHaveBeenCalledTimes(3));
    expect(calls.dm).toHaveBeenCalledTimes(1);
    expect(calls.create).toHaveBeenCalledTimes(2);
    expect(sends[2][2]).not.toBe(sends[0][2]);
    expect(sends[2][4]).not.toEqual(sends[0][4]);
  });

  it('고르지 않은 칸은 보내기 전에 코어 규칙 문장으로 막고, 움직임 없이는 다른 움직임과 함께 고를 수 없다', async () => {
    const {calls} = wire();
    jest
      .spyOn(api, 'fetchRoster')
      .mockResolvedValue([
        agent,
        {...agent, id: '00000000-0000-4000-8000-0000000000a2', displayName: '박인턴', handle: 'park', paused: true},
      ] as unknown as Awaited<ReturnType<typeof api.fetchRoster>>);
    const store = await openMake();
    await press('expression-make-submit');
    expect(text('expression-make-photo-error')).toBe(
      ko.formatMessage('expressions.make.photoMissing'),
    );
    expect(text('expression-make-motion-status')).toBe(
      ko.formatMessage('expressions.make.motionMissing'),
    );
    expect(text('expression-make-agent-error')).toBe(
      ko.formatMessage('expressions.make.agentMissing'),
    );
    expect(calls.dm).not.toHaveBeenCalled();
    // 잠든 에이전트는 숨기지 않고 표시해서 고를 수 있게 한다.
    expect(
      within(
        screen.getByTestId('expression-make-agent-00000000-0000-4000-8000-0000000000a2'),
      ).getByText(ko.formatMessage('expressions.make.agentPaused', {name: '박인턴'})),
    ).toBeTruthy();
    // 먼저 고른 쪽을 두고 「움직임 없이」를 더하면 막고 이유를 말한다(말없이 지우지 않는다).
    await press('expression-make-chip-bounce');
    await press('expression-make-chip-still');
    expect(text('expression-make-motion-status')).toBe(
      ko.formatMessage('expressions.make.motionStillMixed'),
    );
    expect(
      screen.getByTestId('expression-make-chip-bounce').props.accessibilityState,
    ).toMatchObject({checked: true});
    expect(
      screen.getByTestId('expression-make-chip-still').props.accessibilityState,
    ).toMatchObject({checked: false});
    // 끊기면 보낼 수 없고 이유를 말한다.
    await act(async () => store.setOnline(false));
    expect(disabled('expression-make-submit')).toBe(true);
    expect(
      screen.getByText(ko.formatMessage('expressions.make.offline')),
    ).toBeTruthy();
  });

  it('동작 줄이기에서는 사진을 골라도 미리보기 애니메이션을 만들지 않는다', async () => {
    wire();
    const timing = jest.spyOn(Animated, 'timing');
    const loop = jest.spyOn(Animated, 'loop');
    await openMake();
    album({});
    await press('expression-make-photo');
    await waitFor(() =>
      expect(screen.getByTestId('expression-make-photo-preview')).toBeTruthy(),
    );
    expect(timing).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
  });

  it('동작 줄이기가 꺼져 있으면 칸마다 G3.3 한 번 재생 시간으로 총 4회 재생한다', async () => {
    wire();
    release?.();
    release = await pinReduceMotion(false);
    const timing = jest.spyOn(Animated, 'timing');
    const loop = jest.spyOn(Animated, 'loop');
    await openMake();
    album({});
    await press('expression-make-photo');
    await waitFor(() => expect(loop).toHaveBeenCalled());
    // 프레임 수 × 지연: 통통 16×40·흔들흔들 16×40·두근두근 12×50·반짝 20×50.
    const ascending = (a: number, b: number) => a - b;
    const durations = timing.mock.calls
      .map(([, config]) => config.duration as number)
      .sort(ascending);
    expect(durations).toEqual(
      MOTION_PRESETS.map(preset => preset.playMs).sort(ascending),
    );
    expect(durations).toEqual([600, 640, 640, 1000]);
    expect(loop.mock.calls.map(([, config]) => config?.iterations)).toEqual(
      MOTION_PRESETS.map(() => MAKE_PLAYS),
    );
  });

  it('미리보기 키프레임은 웹 CSS 와 같은 숫자이고, 칩은 보조기술에 이름·설명·선택을 말한다', async () => {
    const css = readFileSync(join(WEB, 'expressions.css'), 'utf8');
    const frames = (name: string) =>
      [
        ...css
          .match(new RegExp(`@keyframes expression-make-${name} \\{([\\s\\S]*?)\\n\\}`))![1]
          .matchAll(/([\d.,% ]+)\{ transform: ([^}]*?); \}/g),
      ].flatMap(([, positions, transform]) =>
        positions
          .split(',')
          .map(position => ({at: parseFloat(position) / 100, transform})),
      );
    const number = (value: string | undefined) => parseFloat(value ?? 'NaN');
    for (const frame of frames('bounce')) {
      const y = number(/translateY\(([-\d.]+)%?\)/.exec(frame.transform)?.[1]);
      const [, sx, sy] = /scale\(([\d.]+), ([\d.]+)\)/.exec(frame.transform)!;
      const bounce = MAKE_PREVIEW_KEYFRAMES.bounce;
      expect(trackValueAt(bounce.translateY, frame.at) * 100).toBeCloseTo(y, 1);
      expect(trackValueAt(bounce.scaleX, frame.at)).toBeCloseTo(number(sx), 5);
      expect(trackValueAt(bounce.scaleY, frame.at)).toBeCloseTo(number(sy), 5);
    }
    for (const frame of frames('wobble')) {
      const deg = number(/rotate\(([-\d.]+)deg\)/.exec(frame.transform)?.[1]);
      expect(trackValueAt(MAKE_PREVIEW_KEYFRAMES.wobble.rotateDeg, frame.at)).toBeCloseTo(deg, 5);
    }
    for (const frame of frames('pulse')) {
      const scale = number(/scale\(([\d.]+)\)/.exec(frame.transform)?.[1]);
      expect(trackValueAt(MAKE_PREVIEW_KEYFRAMES.pulse.scale, frame.at)).toBeCloseTo(scale, 5);
    }
    // VoiceOver: 칩은 체크박스이고 이름은 「이름, 설명」, 그림은 장식이라 숨는다.
    wire();
    await openMake();
    const chip = screen.getByTestId('expression-make-chip-bounce');
    const preset = MOTION_PRESETS[0];
    expect(chip.props.accessibilityRole).toBe('checkbox');
    expect(chip.props.accessibilityLabel).toBe(
      ko.formatMessage('expressions.make.chipLabel', {
        label: preset.label,
        description: preset.description,
      }),
    );
    expect(
      screen.getByTestId('expression-make-preview-bounce', {
        includeHiddenElements: true,
      }).props.importantForAccessibility,
    ).toBe('no-hide-descendants');
    expect(
      screen.getByTestId('expression-make-photo').props.accessibilityLabel,
    ).toBe(ko.formatMessage('expressions.make.photoPick'));
  });

  // #5065 M1: 움직임 칸의 설명은 문장이다. 맨 `Text` 는 글자 단위로 끊어 「흔들려 / 요」·「두근 / 거려요」(캡처 4891-…-014)가 됐다.
  it('움직임 칸의 설명은 어절 단위로 줄바꿈한다 — 프리셋 넷과 「움직임 없이」 모두 (#5065)', async () => {
    wire();
    await openMake();
    const motions = [...MOTION_PRESETS, STILL_MOTION];
    expect(motions).toHaveLength(5);
    for (const motion of motions) {
      const chip = screen.getByTestId(`expression-make-chip-${motion.id}`);
      const description = within(chip).getByText(motion.description);
      expect({id: motion.id, breaks: description.props.lineBreakStrategyIOS}).toEqual({
        id: motion.id,
        breaks: 'hangul-word',
      });
    }
  });

  // #5065 H1: 같은 부품을 쓰는 자리 — 「AI와 만들기」 첫 단계의 앨범 알약(캡처 4891-…-014 가 그릇 없는 글자로 찍힌 자리).
  it('앨범 알약은 시트 위 보조 알약이다 — `surface` 채움 + `elevationRest` 그림자 (#5065)', async () => {
    wire();
    await openMake();
    const palette = paletteFor('light');
    const pill = StyleSheet.flatten(
      screen.getByTestId('expression-make-photo').props.style,
    );
    expect(pill.backgroundColor).toBe(palette.surface);
    expect(pill.boxShadow).toBe(palette.elevationRest);
    expect(pill.backgroundColor).not.toBe(palette.surfaceMuted);
  });
});

// #5065 H1: 「앨범에서 고르기」 알약(`PhotoPickRow`)은 사진을 고르지 않으면 이 장에서 아무것도 할 수 없는 유일한 입구인데, 보조 채움
// (`surfaceMuted`)이 라이트에서 시트와 1.009 라 알약 안팎이 같은 색이었다. 시트 위 보조 알약은 `surface` 채움 + `elevationRest` 그림자다
// (phone-sheets.md §4, README §3.3). 채움·가장자리는 시트 머리의 원과 같은 규칙(`circleLook`)이라 다크는 한 단 위 채움 + 윗면 한 줄이
// 맡는다(그 규칙이 모든 테마에서 시트와 갈리는지는 `sheetKit.test.tsx` 가 잰다).
describe('앨범 알약', () => {
  const photoRow = (photo: React.ComponentProps<typeof PhotoPickRow>['photo']) => (
    <PhotoPickRow
      photo={photo}
      pickLabel="앨범에서 고르기"
      changeLabel="다른 사진 고르기"
      previewLabel="고른 사진"
      onPick={jest.fn()}
      testID="pick"
    />
  );

  it.each(['light', 'dark'] as const)(
    '채움·그림자·가장자리가 설계 토큰이고 시트 바탕과 같은 색이 아니다 (%s)',
    scheme => {
      render(<FixedScheme scheme={scheme}>{photoRow(null)}</FixedScheme>);
      const palette = paletteFor(scheme);
      const pill = StyleSheet.flatten(screen.getByTestId('pick').props.style);
      expect(pill.boxShadow).toBe(palette.elevationRest);
      expect(pill.backgroundColor).toBe(circleLook(palette).fill);
      expect(pill.borderColor).toBe(circleLook(palette).ring);
      // 결함 그대로의 값이 아니다: 시트 바탕(`sheet`)과 같지 않다.
      expect(pill.backgroundColor).not.toBe(palette.sheet);
      if (scheme === 'light') {
        // 계약 그대로: `surface` 채움이고, 시트와 1.009 로만 갈리던 옛 보조 채움(`surfaceMuted`)이 아니다.
        expect(pill.backgroundColor).toBe(palette.surface);
        expect(pill.backgroundColor).not.toBe(palette.surfaceMuted);
      }
    },
  );

  it('사진을 고른 뒤의 「다른 사진 고르기」도 같은 알약이다', () => {
    render(
      <FixedScheme scheme="light">
        {photoRow({uri: 'file:///x.png', name: 'dance.png', bytes: 120_000})}
      </FixedScheme>,
    );
    const palette = paletteFor('light');
    const pill = StyleSheet.flatten(screen.getByTestId('pick').props.style);
    expect(screen.getByText('다른 사진 고르기')).toBeTruthy();
    expect(pill.backgroundColor).toBe(palette.surface);
    expect(pill.boxShadow).toBe(palette.elevationRest);
  });
});

describe('웹과 같은 문장·같은 전송', () => {
  it('폰 사전의 한국어는 웹이 화면에 쓰는 문장과 같다', () => {
    const sources = {
      panel: readFileSync(join(WEB, 'TeamExpressionsPanel.tsx'), 'utf8'),
      draft: readFileSync(join(WEB, 'ExpressionDraftCard.tsx'), 'utf8'),
      form: readFileSync(join(WEB, 'ExpressionMakeForm.tsx'), 'utf8'),
      flow: readFileSync(join(WEB, 'makeFlow.ts'), 'utf8'),
    };
    const same = (
      source: keyof typeof sources,
      keys: Parameters<typeof ko.formatMessage>[0][],
    ) =>
      keys.forEach(key => {
        const sentence = ko.formatMessage(key as 'expressions.add.trigger');
        expect({key, found: sources[source].includes(sentence)}).toEqual({key, found: true});
      });
    same('panel', [
      'expressions.add.adminsOnly',
      'expressions.import.faceOtherIssue',
      'expressions.import.metadataIssue',
      'expressions.import.fileIssue',
      'expressions.import.urlIssue',
      'expressions.import.nameTaken',
      'expressions.import.prepareFailed',
      'expressions.import.fixedNote',
    ]);
    same('draft', [
      'expressions.draft.rights',
      'expressions.draft.approve',
      'expressions.draft.waiting',
      'expressions.draft.approveFailed',
      'expressions.draft.replaceFailed',
    ]);
    same('form', [
      'expressions.make.intro',
      'expressions.make.photoMissing',
      'expressions.make.photoDimensions',
      'expressions.make.photoSize',
      'expressions.make.motionMissing',
      'expressions.make.motionStillMixed',
      'expressions.make.agentHint',
      'expressions.make.noAgentsDetail',
      'expressions.make.sent',
      'expressions.make.offline',
    ]);
    same('flow', [
      'expressions.make.failDmForbidden',
      'expressions.make.failDmMissing',
      'expressions.make.failDm',
      'expressions.make.failUploadTooLarge',
      'expressions.make.failUploadForbidden',
      'expressions.make.failUploadNoArchive',
      'expressions.make.failUpload',
      'expressions.make.failSend',
    ]);
  });

  it('실패 사유는 단계와 상태 코드마다 웹과 같은 문장을 고른다(고칠 수 없는 원인은 그대로 말한다)', () => {
    const status = (code: number) => new api.ApiError(code, 'x');
    expect(
      [
        makeFailureKey('dm', status(403)),
        makeFailureKey('dm', status(404)),
        makeFailureKey('dm', new Error('network')),
        makeFailureKey('upload', status(413)),
        makeFailureKey('upload', status(400)),
        makeFailureKey('upload', status(403)),
        makeFailureKey('upload', status(503)),
        makeFailureKey('upload', status(502)),
        makeFailureKey('upload', status(500)),
        makeFailureKey('upload', new Error('network')),
        makeFailureKey('send', status(403)),
        makeFailureKey('send', new Error('network')),
      ],
    ).toEqual([
      'expressions.make.failDmForbidden',
      'expressions.make.failDmMissing',
      'expressions.make.failDm',
      'expressions.make.failUploadTooLarge',
      'expressions.make.failUploadTooLarge',
      'expressions.make.failUploadForbidden',
      'expressions.make.failUploadNoArchive',
      'expressions.make.failUploadNoArchive',
      'expressions.make.failUpload',
      'expressions.make.failUpload',
      'expressions.make.failSend',
      'expressions.make.failSend',
    ]);
  });

  it('live 전송은 베어러를 싣는 multipart 로 보내고 401 은 한 번만 돌려 다시 보낸다', async () => {
    const session = host.coreSession();
    jest.spyOn(host, 'coreSession').mockReturnValue({
      ...session,
      getAccessToken: () => 'fixture-access-token',
      getRefreshToken: () => 'fixture-refresh-token',
    });
    jest.spyOn(host, 'apiBase').mockReturnValue('https://fixture.invalid');
    const rotate = jest.spyOn(api, 'rotateAfterUnauthorized').mockResolvedValue(true);
    const replies = [
      {status: 401, body: '', headers: {}},
      {status: 201, body: JSON.stringify(FIXTURE_READY_DRAFT), headers: {}},
    ];
    const create = jest
      .spyOn(File.prototype, 'createUploadTask')
      .mockImplementation(
        () =>
          ({
            uploadAsync: async () => replies.shift(),
            cancel: jest.fn(),
            release: jest.fn(),
          }) as unknown as ReturnType<File['createUploadTask']>,
      );
    const body = {name: 'happy_dance', displayName: '신나는 춤', tags: [], subjectMemberId: null};
    const response = await expressionTransport.request({
      method: 'POST',
      path: `${root}/expressions/uploads`,
      body,
      file: {uri: 'file:///cache/ImagePicker/dance.png', name: 'dance.png', mime: 'image/png'},
    });
    expect(response).toEqual({status: 201, json: FIXTURE_READY_DRAFT});
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith(
      `https://fixture.invalid${root}/expressions/uploads`,
      expect.objectContaining({
        httpMethod: 'POST',
        uploadType: 1,
        fieldName: 'file',
        mimeType: 'image/png',
        parameters: {metadata: JSON.stringify(body)},
        headers: {Authorization: 'Bearer fixture-access-token'},
      }),
    );
    await expect(
      expressionTransport.request({
        method: 'POST',
        path: `${root}/other/uploads`,
        file: {uri: 'file:///x.png', name: 'x.png', mime: 'image/png'},
      }),
    ).rejects.toThrow('Invalid expression path');
    expect(create).toHaveBeenCalledTimes(2);
    expect(FIXTURE_LIST.addPolicy).toBe('members');
  });
});
