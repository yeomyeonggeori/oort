import {File} from 'expo-file-system';
import 'react-native-url-polyfill/auto';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import {AppState, Platform, StyleSheet} from 'react-native';
import * as api from '@momo/core/lib/api';
import * as host from '@momo/core/runtime/host';
import {catalog as enCatalog} from '@momo/core/i18n/generated/en-US';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import {expressionChoice} from '@momo/core/features/expressions/cards';
import {PHOTO_FIXTURE_PROMPTS} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_MEMBER_ID,
  FIXTURE_READY_DRAFT,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {
  PHOTO_BRANCHES,
  PHOTO_REQUEST_TIMEOUT_MS,
  expressionActivateRequest,
  type PhotoBranch,
  type PhotoProvider,
} from '@momo/core/features/expressions/photo';
import type {ExpressionDraft} from '@momo/core/features/expressions/types';
import {
  ExpressionPhotoSurface,
  PHOTO_SCENES,
  createPhotoSceneTransport,
  type PhotoScene,
} from '../measure/expressionPhoto';
import {paletteFor} from '../src/design/theme';
import {ExpressionMakeEntry} from '../src/features/expressions/ExpressionMakeEntry';
import {
  ExpressionPhotoForm,
  PHOTO_FAILURE_KEY,
} from '../src/features/expressions/ExpressionPhotoForm';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {
  expressionTransport,
  type ExpressionRequest,
} from '../src/features/expressions/transport';
import type {PlainMessageKey} from '../src/features/expressions/useExpressionMessages';
import {pinReduceMotion} from './fixtures/reduceMotion';

// 폰 「AI와 만들기」 사진 길 (#4984, 웹 #4941). 서버 쪽은 코어 가짜 서버(+ 폰 캡처 표면의 얇은 겉옷)가 맡고, 폰이 정하는
// 규칙은 없다 — 요청 본문·실패 → 상황은 코어(`photo.ts`)가, 문장은 사전(`expressions.photo.*`)이 말한 그대로다.
// 시험은 문장을 폼의 표에서 읽지 않고 **사전과 서버의 코드로 직접** 적는다: 폼이 제 문구를 쓰거나 표가 어긋나면 빨개진다.

const ko = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog});
const en = createMessageService({messageLocale: 'en-US', catalog: enCatalog});
const root = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
const imagePicker = jest.requireMock('expo-image-picker') as {
  __state: {result: unknown; failure: unknown; permission: unknown};
  __reset: () => void;
};
let release: (() => void) | undefined;
const stores: PhoneExpressionStore[] = [];

const OPENAI: PhotoScene = {model: 'openai'};

function setup(scene: PhotoScene) {
  const inner = createPhotoSceneTransport(scene);
  const request = jest.fn((input: ExpressionRequest) => inner.request(input));
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    {write: (key: string) => `file:///fixture/${key}`, remove: jest.fn()},
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  return {store, request};
}
async function mount(store: PhoneExpressionStore, node?: React.ReactElement) {
  const props = {
    onBack: jest.fn(),
    onImport: jest.fn(),
    onAgent: jest.fn(),
    onDone: jest.fn(),
  };
  const view = render(
    <PhoneExpressions.Provider value={store}>
      {node ?? <ExpressionPhotoForm {...props} />}
    </PhoneExpressions.Provider>,
  );
  // 처음 세울 때 도는 모델 확인까지 act 안에서 받는다.
  await act(async () => {});
  return {...props, view};
}
/**
 * 한 시험 안에서 다시 세운다. `cleanup()` 은 비동기로 내려서, 곧바로 `render` 하면 「unmounted test renderer」로 깨진다
 * — 한 번 진짜 타이머를 돌려 보낸다.
 */
async function remount() {
  await act(async () => {});
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  stores.splice(0).forEach(store => store.dispose());
}
// 누른 뒤 이어지는 비동기 갱신(모델 확인·이름 검사·요청의 답)까지 act 안에서 받는다.
async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
  await act(async () => {});
}
async function type(testID: string, value: string) {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId(testID), value);
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
const has = (testID: string) => screen.queryByTestId(testID) !== null;
// 낭독에서 숨긴 장식(스피너)까지 센다: 「돌지 않는다」는 보이지 않는 것도 포함해서 잰다.
const hasHidden = (testID: string) =>
  screen.queryByTestId(testID, {includeHiddenElements: true}) !== null;
const disabled = (testID: string) =>
  Boolean(screen.getByTestId(testID).props.accessibilityState?.disabled);
const checked = (testID: string) =>
  Boolean(screen.getByTestId(testID).props.accessibilityState?.checked);
const posts = (request: jest.Mock) =>
  request.mock.calls
    .map(([input]) => input as ExpressionRequest)
    .filter(input => input.method === 'POST' && input.path.endsWith('/photo-drafts'));
const modelChecks = (request: jest.Mock) =>
  request.mock.calls.filter(([input]) =>
    (input as ExpressionRequest).path.endsWith('/photo-model'),
  ).length;

async function ready() {
  await waitFor(() => expect(has('expression-photo-form')).toBe(true));
}
async function fill(options: {consent?: boolean; branch?: PhotoBranch} = {}) {
  album({});
  await press('expression-photo-file');
  await waitFor(() => expect(has('expression-photo-file-preview')).toBe(true));
  await type('expression-photo-name', 'happy_dance');
  await type('expression-photo-display-name', '신나는 춤');
  await type('expression-photo-tags', '축하, 춤');
  if (options.branch) await press(`expression-photo-branch-${options.branch}`);
  if (options.consent !== false) await press('expression-photo-consent');
}
async function send(options: {consent?: boolean; branch?: PhotoBranch} = {}) {
  await fill(options);
  await press('expression-photo-submit');
}

beforeEach(async () => {
  release = await pinReduceMotion(true);
  AppState.currentState = 'active';
  imagePicker.__reset();
  album(null);
});
afterEach(async () => {
  jest.useRealTimers();
  await remount();
  release?.();
  release = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('모델 확인', () => {
  it('모델이 없으면 만들지 않고 안내한다: 운영자에게는 어디서 연결하는지, 일반 멤버에게는 운영자에게 알리라고 — 둘 다 가져오기로 등록하는 길', async () => {
    for (const [scene, line, other] of [
      [{model: 'none'}, 'expressions.photo.noModelManagePhone', 'ask'],
      [{model: 'none', canManage: false}, 'expressions.photo.noModelAsk', 'manage'],
    ] as const) {
      const {store, request} = setup(scene);
      const {onImport, onAgent} = await mount(store);
      await waitFor(() => expect(has('expression-photo-no-model')).toBe(true));
      expect(has('expression-photo-form')).toBe(false);
      expect(
        text(scene.canManage === false ? 'expression-photo-ask' : 'expression-photo-manage'),
      ).toBe(ko.formatMessage(line));
      expect(has(`expression-photo-${other}`)).toBe(false);
      await press('expression-photo-import');
      expect(onImport).toHaveBeenCalledTimes(1);
      expect(onAgent).not.toHaveBeenCalled();
      // 모델이 없으면 어떤 사진 요청도 나가지 않는다.
      expect(posts(request)).toHaveLength(0);
      await remount();
    }
  });

  it('확인이 안 되면 다시 시도로 다시 묻고, 이 팀에서 올릴 수 없다는 답(403)은 다시 시도 없이 그렇게 말한다 — 에이전트에게 부탁하는 길은 막지 않는다', async () => {
    const failed = setup({check: 500});
    const first = await mount(failed.store);
    await waitFor(() => expect(has('expression-photo-check-error')).toBe(true));
    expect(text('expression-photo-check-error')).toBe(
      ko.formatMessage('expressions.photo.checkFailed'),
    );
    expect(modelChecks(failed.request)).toBe(1);
    await press('expression-photo-retry');
    await waitFor(() => expect(modelChecks(failed.request)).toBe(2));
    await press('expression-photo-agent');
    expect(first.onAgent).toHaveBeenCalledTimes(1);
    await remount();
    // 권한 없음은 서버가 닫힌 코드로 답했을 때만 그렇게 말한다(상태 403 만으로는 일반 확인 실패다).
    const bare = setup({check: 403});
    await mount(bare.store);
    await waitFor(() => expect(has('expression-photo-check-error')).toBe(true));
    await remount();
    const refused = setup(PHOTO_SCENES['check-refused']);
    await mount(refused.store);
    await waitFor(() => expect(has('expression-photo-check-refused')).toBe(true));
    expect(text('expression-photo-check-refused')).toBe(
      ko.formatMessage('expressions.photo.errorRole'),
    );
    expect(has('expression-photo-retry')).toBe(false);
    expect(has('expression-photo-agent')).toBe(true);
  });
});

describe('양식', () => {
  // #5065 H1: 같은 부품(`PhotoPickRow`)을 쓰는 사진 양식의 앨범 알약도 시트 위 보조 알약이다(부품 시험은 `expressionAdd.test.tsx`).
  it('앨범 알약은 시트 위 보조 알약이다 — `surface` 채움 + `elevationRest` 그림자 (#5065)', async () => {
    const {store} = setup(OPENAI);
    await mount(store);
    await ready();
    const palette = paletteFor('light');
    const pill = StyleSheet.flatten(
      screen.getByTestId('expression-photo-file').props.style,
    );
    expect(pill.backgroundColor).toBe(palette.surface);
    expect(pill.boxShadow).toBe(palette.elevationRest);
    expect(pill.backgroundColor).not.toBe(palette.surfaceMuted);
  });

  it.each([
    ['openai', 'expressions.photo.providerOpenai'],
    ['gemini', 'expressions.photo.providerGemini'],
  ] as const)(
    '동의 줄에 사진이 가는 회사 이름이 들어가고, 동의한 회사(%s)가 요청에 실린다',
    async (provider: PhotoProvider, nameKey) => {
      const {store, request} = setup({model: provider});
      await mount(store);
      await ready();
      const row = screen.getByTestId('expression-photo-consent');
      expect(row.props.accessibilityLabel).toBe(
        ko.formatMessage('expressions.photo.consent', {
          provider: ko.formatMessage(nameKey),
        }),
      );
      expect(row.props.accessibilityRole).toBe('switch');
      expect(checked('expression-photo-consent')).toBe(false);
      await send();
      await waitFor(() => expect(posts(request)).toHaveLength(1));
      expect(posts(request)[0].body).toMatchObject({acknowledgedProvider: provider});
    },
  );

  it('갈래 둘은 사전의 이름과 설명으로 서고 기본은 배경 지우기이며, 고른 갈래가 요청에 실린다', async () => {
    const {store, request} = setup(OPENAI);
    await mount(store);
    await ready();
    const [cutout, caricature] = PHOTO_BRANCHES;
    const row = (branch: PhotoBranch) =>
      screen.getByTestId(`expression-photo-branch-${branch}`);
    expect(row(cutout).props.accessibilityLabel).toBe(
      ko.formatMessage('expressions.photo.cutoutLabel'),
    );
    expect(row(cutout).props.accessibilityHint).toBe(
      ko.formatMessage('expressions.photo.cutoutHint'),
    );
    expect(row(caricature).props.accessibilityHint).toBe(
      ko.formatMessage('expressions.photo.caricatureHint'),
    );
    expect(row(cutout).props.accessibilityState).toMatchObject({selected: true});
    await send({branch: caricature});
    await waitFor(() => expect(posts(request)).toHaveLength(1));
    expect(posts(request)[0].body).toMatchObject({branch: caricature});
    // 캐리커처는 배경을 건드리지 않으니 「배경에 한 일」 줄이 없다.
    await waitFor(() => expect(has('expression-photo-made')).toBe(true));
    expect(has('expression-photo-cutout')).toBe(false);
  });

  it('서버가 낸 갈래만 보인다(모델이 캐리커처만 주면 그것이 기본이다)', async () => {
    const {store, request} = setup(OPENAI);
    const inner = createPhotoSceneTransport(OPENAI);
    request.mockImplementation(async input => {
      const response = await inner.request(input);
      return input.path.endsWith('/photo-model')
        ? {...response, json: {...(response.json as object), branches: ['caricature']}}
        : response;
    });
    await mount(store);
    await ready();
    expect(has('expression-photo-branch-cutout')).toBe(false);
    expect(
      screen.getByTestId('expression-photo-branch-caricature').props
        .accessibilityState,
    ).toMatchObject({selected: true});
    await send();
    await waitFor(() => expect(posts(request)).toHaveLength(1));
    expect(posts(request)[0].body).toMatchObject({branch: 'caricature'});
  });
});

describe('보내기 전 검사', () => {
  it('동의 없이는 보내지 않는다: 요청이 나가지 않고, 동의 줄 아래에 사전 문장이 선다', async () => {
    const {store, request} = setup(OPENAI);
    await mount(store);
    await ready();
    await send({consent: false});
    expect(text('expression-photo-error-consent')).toBe(
      ko.formatMessage('expressions.photo.consentMissing'),
    );
    expect(posts(request)).toHaveLength(0);
    expect(has('expression-photo-busy')).toBe(false);
    // 동의하면 그 문장이 걷히고 보내진다.
    await press('expression-photo-consent');
    expect(has('expression-photo-error-consent')).toBe(false);
    await press('expression-photo-submit');
    await waitFor(() => expect(posts(request)).toHaveLength(1));
  });

  it('사진·이름·얼굴이 어긋나면 모델을 부르기 전에 막는다: 사진 없음·형식·크기·빈 파일, 이름 규칙·표준 이모지와 겹침, 다른 사람 얼굴', async () => {
    // 표준 이모지 목록은 기기(iOS) 버전이 알려져야 선다(시험의 기본은 모른다).
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue('26.4');
    const {store, request} = setup(OPENAI);
    await mount(store);
    await ready();
    await press('expression-photo-consent');
    await press('expression-photo-submit');
    expect(text('expression-photo-error-photo')).toBe(
      ko.formatMessage('expressions.photo.photoMissing'),
    );
    expect(text('expression-photo-error-fields')).toBe(
      ko.formatMessage('expressions.photo.fieldsInvalid'),
    );
    for (const [asset, key] of [
      [{mimeType: 'image/heic'}, 'expressions.photo.photoType'],
      [{fileSize: 5 * 1024 * 1024 + 1}, 'expressions.photo.photoSize'],
      [{fileSize: 0}, 'expressions.make.photoEmpty'],
    ] as const) {
      album(asset);
      await press('expression-photo-file');
      await press('expression-photo-submit');
      expect(text('expression-photo-error-photo')).toBe(ko.formatMessage(key));
    }
    album({});
    await press('expression-photo-file');
    // 표준 이모지 이름과 겹치면 서버가 거절하니 먼저 알려 준다.
    await type('expression-photo-name', 'smile');
    await type('expression-photo-display-name', '웃음');
    await press('expression-photo-submit');
    await waitFor(() =>
      expect(text('expression-photo-error-fields')).toBe(
        ko.formatMessage('expressions.photo.errorName'),
      ),
    );
    await type('expression-photo-name', 'happy_dance');
    await press('expression-photo-face-other');
    await press('expression-photo-submit');
    expect(text('expression-photo-error-face')).toBe(
      ko.formatMessage('expressions.photo.faceOtherBlocked'),
    );
    expect(posts(request)).toHaveLength(0);
  });
});

describe('만드는 중', () => {
  it('코어가 만든 요청 그대로 한 번 보내고(경로·본문·사진·150초), 만드는 동안은 한 줄과 취소만 있다', async () => {
    const {store, request} = setup({...OPENAI, hold: true});
    await mount(store);
    await ready();
    await send({branch: 'caricature'});
    await waitFor(() => expect(has('expression-photo-busy')).toBe(true));
    const [sent] = posts(request);
    expect(sent).toMatchObject({
      method: 'POST',
      path: `${root}/expressions/photo-drafts`,
      body: {
        branch: 'caricature',
        acknowledgedProvider: 'openai',
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
      timeoutMs: PHOTO_REQUEST_TIMEOUT_MS,
    });
    expect(PHOTO_REQUEST_TIMEOUT_MS).toBe(150_000);
    expect(sent.signal?.aborted).toBe(false);
    expect(text('expression-photo-busy')).toBe(
      ko.formatMessage('expressions.photo.busy'),
    );
    // 두 번째 요청은 나가지 않는다(모델 호출은 돈이다): 만드는 동안 「만들기」는 잠기고, 「에이전트에게 부탁하기」는 숨는다.
    expect(disabled('expression-photo-submit')).toBe(true);
    await press('expression-photo-submit');
    expect(posts(request)).toHaveLength(1);
    expect(has('expression-photo-agent')).toBe(false);
    // 동작 줄이기에서는 스피너를 돌리지 않는다. 한 줄이 그 일을 말한다.
    expect(hasHidden('expression-photo-spinner')).toBe(false);
  });

  it('동작 줄이기가 꺼져 있으면 스피너가 돈다', async () => {
    release?.();
    release = await pinReduceMotion(false);
    const {store} = setup({...OPENAI, hold: true});
    await mount(store);
    await ready();
    await send();
    await waitFor(() => expect(has('expression-photo-busy')).toBe(true));
    expect(hasHidden('expression-photo-spinner')).toBe(true);
  });

  it('취소: 기다리기를 멈추고(요청의 신호가 선다) 양식으로 돌아온다 — 입력은 그대로, 실패 줄은 없고, 서버가 끝까지 할 수 있다는 사전 문장이 선다', async () => {
    const {store, request} = setup({...OPENAI, hold: true});
    await mount(store);
    await ready();
    await send();
    await waitFor(() => expect(has('expression-photo-cancel')).toBe(true));
    const [sent] = posts(request);
    expect(sent.signal?.aborted).toBe(false);
    // 낭독은 눌러 얻는 것(기다리기만 멈춘다)을 누르기 전에 말한다.
    expect(
      screen.getByTestId('expression-photo-cancel').props.accessibilityLabel,
    ).toBe(
      `${ko.formatMessage('expressions.photo.cancel')} ${ko.formatMessage(
        'expressions.photo.cancelHint',
      )}`,
    );
    await press('expression-photo-cancel');
    expect(sent.signal?.aborted).toBe(true);
    await waitFor(() => expect(has('expression-photo-busy')).toBe(false));
    expect(has('expression-photo-failure')).toBe(false);
    expect(has('expression-photo-made')).toBe(false);
    expect(text('expression-photo-cancelled')).toBe(
      ko.formatMessage('expressions.photo.cancelled'),
    );
    // 입력은 그대로라서 바로 다시 보낼 수 있다.
    expect(screen.getByTestId('expression-photo-name').props.value).toBe(
      'happy_dance',
    );
    expect(checked('expression-photo-consent')).toBe(true);
    expect(disabled('expression-photo-submit')).toBe(false);
    await press('expression-photo-submit');
    await waitFor(() => expect(posts(request)).toHaveLength(2));
  });

  // #5099 M2(검증 줄 2회차 화면): 만드는 동안(최대 2분) 사진 단추·갈래·얼굴·동의는 흐려지는데 잠긴 입력 칸 셋은 평소 그대로여서
  // 눌러도 자판이 안 오르는 칸이 고칠 수 있는 칸처럼 보였다. 기준은 숫자가 아니라 **같은 화면의 잠긴 행**이다 — 한쪽 값만 바뀌면
  // 한 화면이 잠김을 두 가지로 그린다.
  it('만드는 동안 잠긴 입력 칸 셋(고정 이름·표시 이름·태그)은 잠긴 행과 같은 흐림이고 보조기술에도 잠겼다고 말하며, 끝나면 도로 살아난다 (#5099 M2)', async () => {
    const {store} = setup({...OPENAI, hold: true});
    await mount(store);
    await ready();
    const FIELDS = ['name', 'display-name', 'tags'].map(
      key => `expression-photo-${key}`,
    );
    const opacityOf = (testID: string) =>
      StyleSheet.flatten(screen.getByTestId(testID).props.style)?.opacity;
    const locked = (testID: string) =>
      screen.getByTestId(testID).props.accessibilityState?.disabled === true;
    // 보내기 전의 살아 있는 칸은 흐리지 않고 잠겼다고 말하지도 않는다(`editable` 을 생략한 것을 잠김으로 읽지 않는다).
    for (const id of FIELDS) {
      expect({id, opacity: opacityOf(`${id}-pill`), locked: locked(id)}).toEqual({
        id,
        opacity: undefined,
        locked: false,
      });
    }
    await send({branch: 'caricature'});
    await waitFor(() => expect(has('expression-photo-busy')).toBe(true));
    // 기준: 같은 순간 잠긴 갈래 행의 흐림. 둘 다 1 이라서 맞는 빈 비교가 되지 않게 실제로 흐린지부터 본다.
    const row = opacityOf('expression-photo-branch-cutout');
    expect(row).toBeLessThan(1);
    expect(disabled('expression-photo-branch-cutout')).toBe(true);
    for (const id of FIELDS) {
      expect({id, opacity: opacityOf(`${id}-pill`), locked: locked(id)}).toEqual({
        id,
        opacity: row,
        locked: true,
      });
    }
    // 기다리기를 그만두면(취소) 칸은 도로 살아난다.
    await press('expression-photo-cancel');
    await waitFor(() => expect(has('expression-photo-busy')).toBe(false));
    for (const id of FIELDS) {
      expect({id, opacity: opacityOf(`${id}-pill`), locked: locked(id)}).toEqual({
        id,
        opacity: undefined,
        locked: false,
      });
    }
  });

  it('화면을 닫아도 기다리기를 멈춘다(요청의 신호가 선다)', async () => {
    const {store, request} = setup({...OPENAI, hold: true});
    const {view} = await mount(store);
    await ready();
    await send();
    await waitFor(() => expect(posts(request)).toHaveLength(1));
    const [sent] = posts(request);
    expect(sent.signal?.aborted).toBe(false);
    view.unmount();
    expect(sent.signal?.aborted).toBe(true);
  });

  it('실패는 열세 가지 상황마다 사전의 한 줄이다: 서버의 코드·상태로 말하고, 폼의 문구가 아니다', async () => {
    const rows: readonly [string, PhotoScene, PlainMessageKey][] = [
      ['unavailable', {...OPENAI, failure: 'image_model_unavailable'}, 'expressions.photo.errorUnavailable'],
      ['changed', {...OPENAI, failure: 'image_model_changed'}, 'expressions.photo.errorChanged'],
      ['refused', {...OPENAI, failure: 'image_model_refused'}, 'expressions.photo.errorRefused'],
      ['failed', {...OPENAI, failure: 'image_model_failed'}, 'expressions.photo.errorFailed'],
      ['timeout', {...OPENAI, failure: 'image_model_timeout'}, 'expressions.photo.errorTimeout'],
      ['busy', {...OPENAI, answer: {status: 503}}, 'expressions.photo.errorBusy'],
      ['quota', {...OPENAI, answer: {status: 409, code: 'expression_quota'}}, 'expressions.photo.errorQuota'],
      ['role', {...OPENAI, answer: {status: 403, code: 'expression_role_required'}}, 'expressions.photo.errorRole'],
      ['name', {...OPENAI, answer: {status: 409, code: 'expression_name_reserved'}}, 'expressions.photo.errorName'],
      ['name', {...OPENAI, answer: {status: 400, code: 'expression_invalid'}}, 'expressions.photo.errorName'],
      ['media', {...OPENAI, answer: {status: 415, code: 'expression_media_invalid'}}, 'expressions.photo.errorMedia'],
      ['too_large', {...OPENAI, answer: {status: 413, code: 'expression_media_invalid'}}, 'expressions.photo.photoSize'],
      ['offline', {...OPENAI, answer: {status: 0}}, 'expressions.photo.errorOffline'],
      ['generic', {...OPENAI, answer: {status: 500}}, 'expressions.photo.errorGeneric'],
    ];
    expect(new Set(rows.map(([situation]) => situation)).size).toBe(
      Object.keys(PHOTO_FAILURE_KEY).length,
    );
    for (const [situation, scene, key] of rows) {
      const {store} = setup(scene);
      await mount(store);
      await ready();
      await send();
      await waitFor(() => expect(has('expression-photo-failure')).toBe(true));
      expect({situation, line: text('expression-photo-failure')}).toEqual({
        situation,
        line: ko.formatMessage(key),
      });
      // 실패하면 양식이 그대로 서서 고쳐 다시 보낼 수 있다.
      expect(has('expression-photo-busy')).toBe(false);
      expect(disabled('expression-photo-submit')).toBe(false);
      await remount();
    }
  });
});

describe('만든 그림', () => {
  it.each([
    ['model', {...OPENAI, cutout: 'model'}, 'cutout', 'expressions.photo.cutoutModel'],
    ['erased', {...OPENAI, cutout: 'erased'}, 'cutout', 'expressions.photo.cutoutErased'],
    ['unchanged', {...OPENAI, cutout: 'unchanged'}, 'cutout', 'expressions.photo.cutoutUnchanged'],
    ['캐리커처(줄 없음)', OPENAI, 'caricature', null],
  ] as const)(
    '서버가 배경에 한 일(%s)을 사전의 한 줄로 말하고, 서버가 쓴 고정 문장을 「만든 방법」 아래에 보인다',
    async (_label, scene: PhotoScene, branch: PhotoBranch, line) => {
      const {store} = setup(scene);
      await mount(store);
      await ready();
      await send({branch});
      await waitFor(() => expect(has('expression-photo-made')).toBe(true));
      // 기대하는 사전 키는 폼의 표가 아니라 여기서 서버의 답(cutout)마다 적는다: 표가 어긋나면 빨개진다.
      if (line === null) {
        expect(has('expression-photo-cutout')).toBe(false);
      } else {
        expect(text('expression-photo-cutout')).toBe(ko.formatMessage(line));
      }
      expect(text('expression-draft-prompt')).toBe(
        `${ko.formatMessage('expressions.photo.originLabel')} ${PHOTO_FIXTURE_PROMPTS[branch]}`,
      );
      expect(
        screen.getByTestId('expression-draft-another').props.accessibilityLabel,
      ).toBe(ko.formatMessage('expressions.photo.anotherPhoto'));
      // 서버가 준 초안을 그대로 보인다: 이름·표시 이름·태그.
      expect(screen.getByText('신나는 춤')).toBeTruthy();
    },
  );

  it('보고 고른 바로 그 초안만 등록하고(코어의 등록 요청 그대로) 목록에 들어온다. 다른 사진으로 다시 만들면 동의는 다시 받는다', async () => {
    const {store, request} = setup(OPENAI);
    const {onDone} = await mount(store);
    await ready();
    await send();
    await waitFor(() => expect(has('expression-photo-made')).toBe(true));
    await waitFor(() => expect(has('expression-draft-preview')).toBe(true));
    await act(async () => {
      fireEvent(screen.getByTestId('expression-draft-preview'), 'load');
    });
    await press('expression-draft-rights');
    const index = request.mock.calls.findIndex(
      ([input]) => (input as ExpressionRequest).path.endsWith('/photo-drafts'),
    );
    const draft = (await request.mock.results[index].value).json.draft as ExpressionDraft;
    const choice = expressionChoice(draft, Date.now());
    expect(choice).not.toBeNull();
    await press('expression-draft-approve');
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining(expressionActivateRequest(root, choice)),
      ),
    );
    await waitFor(() =>
      expect(store.snapshot().items.map(item => item.name)).toContain('happy_dance'),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
    // 같은 장면에서 다른 사진으로: 양식으로 돌아오고 입력은 남지만 동의는 다시 받는다.
    await remount();
    const again = setup(OPENAI);
    await mount(again.store);
    await ready();
    await send();
    await waitFor(() => expect(has('expression-photo-made')).toBe(true));
    await press('expression-draft-another');
    expect(has('expression-photo-form')).toBe(true);
    expect(screen.getByTestId('expression-photo-name').props.value).toBe('happy_dance');
    expect(checked('expression-photo-consent')).toBe(false);
  });
});

describe('입구', () => {
  it('「AI와 만들기」는 사진 양식으로 먼저 열리고, 「에이전트에게 부탁하기」가 기존 에이전트 양식으로 보내며, 「‹」는 사진 양식으로 돌아온다', async () => {
    jest.spyOn(api, 'fetchRoster').mockResolvedValue([]);
    const {store} = setup(OPENAI);
    const onBack = jest.fn();
    await mount(
      store,
      <ExpressionMakeEntry onBack={onBack} onDone={jest.fn()} onImport={jest.fn()} />,
    );
    await ready();
    expect(has('expression-make')).toBe(false);
    await press('expression-photo-agent');
    expect(has('expression-make')).toBe(true);
    expect(has('expression-photo')).toBe(false);
    await press('expression-chapter-back');
    expect(has('expression-photo')).toBe(true);
    expect(onBack).not.toHaveBeenCalled();
    await press('expression-chapter-back');
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('개발 스위치', () => {
  it('폰 캡처 표면의 모든 장면이 서고 각자 자기 표지를 보인다 — 영어 판은 영어 사전의 문장이다', async () => {
    const landmark = (scene: string) =>
      scene === 'checking'
        ? 'expression-photo-checking'
        : scene === 'check-failed'
        ? 'expression-photo-check-error'
        : scene === 'check-refused'
        ? 'expression-photo-check-refused'
        : scene.startsWith('no-model')
        ? 'expression-photo-no-model'
        : scene === 'busy'
        ? 'expression-photo-busy'
        : scene === 'form-no-consent'
        ? 'expression-photo-error-consent'
        : scene.startsWith('form')
        ? 'expression-photo-form'
        : scene.startsWith('failed')
        ? 'expression-photo-failure'
        : 'expression-photo-made';
    const scenes = Object.keys(PHOTO_SCENES);
    expect(scenes.length).toBeGreaterThanOrEqual(20);
    for (const scene of scenes) {
      render(<ExpressionPhotoSurface which={scene} />);
      await act(async () => {});
      await waitFor(() => expect({scene, found: has(landmark(scene))}).toEqual({scene, found: true}));
      await remount();
    }
    render(<ExpressionPhotoSurface which="form-gemini-en" />);
    await act(async () => {});
    await waitFor(() => expect(has('expression-photo-form')).toBe(true));
    expect(
      screen.getByTestId('expression-photo-consent').props.accessibilityLabel,
    ).toBe(
      en.formatMessage('expressions.photo.consent', {
        provider: en.formatMessage('expressions.photo.providerGemini'),
      }),
    );
    expect(
      screen.getByTestId('expression-photo-submit').props.accessibilityState,
    ).toMatchObject({disabled: false});
    expect(
      screen.getByText(en.formatMessage('expressions.photo.submit')),
    ).toBeTruthy();
    await remount();
    // 영어 판 장면 하나가 한글 한 글자 없이 선다: 모델 없음.
    render(<ExpressionPhotoSurface which="no-model-member-en" />);
    await act(async () => {});
    await waitFor(() => expect(has('expression-photo-no-model')).toBe(true));
    expect(text('expression-photo-ask')).toBe(
      en.formatMessage('expressions.photo.noModelAsk'),
    );
    expect(text('expression-photo-ask')).not.toMatch(/[ᄀ-ᇿ㄰-㆏가-힯]/);
  });
});

describe('전송 길', () => {
  it('multipart 는 부르는 쪽이 준 시간(150초)까지 기다리고, 부르는 쪽의 신호로 멈춘다', async () => {
    jest.useFakeTimers();
    try {
      await transportDeadlines();
    } finally {
      jest.useRealTimers();
    }
  });
});

async function transportDeadlines() {
    const session = host.coreSession();
    jest.spyOn(host, 'coreSession').mockReturnValue({
      ...session,
      getAccessToken: () => 'fixture-access-token',
      getRefreshToken: () => 'fixture-refresh-token',
    });
    jest.spyOn(host, 'apiBase').mockReturnValue('https://fixture.invalid');
    const signals: AbortSignal[] = [];
    jest.spyOn(File.prototype, 'createUploadTask').mockImplementation(
      (_url: string, options?: {signal?: AbortSignal}) =>
        ({
          uploadAsync: () =>
            new Promise((_resolve, reject) => {
              const signal = options?.signal as AbortSignal;
              signals.push(signal);
              // 진짜 올리기도 이미 멈춘 신호에는 곧바로 거절한다.
              if (signal.aborted) reject(new Error('aborted'));
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
          cancel: jest.fn(),
          release: jest.fn(),
        }) as unknown as ReturnType<File['createUploadTask']>,
    );
    const file = {uri: 'file:///cache/ImagePicker/dance.png', name: 'dance.png', mime: 'image/png'};
    const call = (extra: Partial<ExpressionRequest>) =>
      expressionTransport.request({
        method: 'POST',
        path: `${root}/expressions/photo-drafts`,
        body: {name: 'happy_dance'},
        file,
        ...extra,
      });
    // 시간: 150초 전에는 서 있고 150초에 선다.
    const slow = call({timeoutMs: PHOTO_REQUEST_TIMEOUT_MS});
    const slowSettled = slow.catch(() => 'aborted');
    await jest.advanceTimersByTimeAsync(PHOTO_REQUEST_TIMEOUT_MS - 1);
    expect(signals[0].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    await expect(slowSettled).resolves.toBe('aborted');
    // 시간을 주지 않으면 올리기 기본(60초)이다.
    const plain = call({}).catch(() => 'aborted');
    await jest.advanceTimersByTimeAsync(59_999);
    expect(signals[1].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(signals[1].aborted).toBe(true);
    await plain;
    // 신호: 부르는 쪽이 멈추면 올리기가 멈추고, 이미 멈춘 신호는 보내기 전에 멈춘다.
    const controller = new AbortController();
    const stopped = call({signal: controller.signal}).catch(() => 'aborted');
    await jest.advanceTimersByTimeAsync(10);
    expect(signals[2].aborted).toBe(false);
    controller.abort();
    expect(signals[2].aborted).toBe(true);
    await expect(stopped).resolves.toBe('aborted');
    const before = new AbortController();
    before.abort();
    const early = call({signal: before.signal}).catch(() => 'aborted');
    await jest.advanceTimersByTimeAsync(10);
    expect(signals[3].aborted).toBe(true);
    await early;
    expect(FIXTURE_READY_DRAFT.workspaceId).toBe(FIXTURE_WORKSPACE_ID);
}
