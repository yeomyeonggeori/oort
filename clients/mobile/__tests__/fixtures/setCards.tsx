import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import React, {useState} from 'react';
import {StyleSheet} from 'react-native';
import * as api from '@momo/core/lib/api';
import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import * as host from '@momo/core/runtime/host';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_CHANNEL_ID,
  FIXTURE_MEMBER_ID,
  FIXTURE_NOW_MS,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {EXPRESSION_SET_ACTION_ID} from '@momo/core/features/expressions/set';
import {
  FIXTURE_SET_APPROVAL_ID,
  FIXTURE_SET_CARDS,
} from '@momo/core/features/expressions/setFixtures';
import {EXPRESSION_SET_PLAN_ACTION_ID} from '@momo/core/features/expressions/setWire';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import {PhoneExpressions} from '../../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../../src/features/expressions/store';
import type {ApprovalGate, ApprovalReceipt} from '../../src/features/conversation/approvalGate';
import {MessageRow} from '../../src/features/conversation/MessageRow';
import {resetAttachmentContentForTest} from '../../src/features/attachments/content';
import {SessionProvider} from '../../src/session/useSession';
import {pinReduceMotion} from './reduceMotion';
import '../../src/boot/polyfills';
import '../../src/boot/coreHost';

// =============================================================================
// 이모티콘 세트 카드 둘(#5463)의 시험 바탕: 코어 fake 서버가 만든 저장소·대화 줄(`MessageRow`)·결정 라우트의 답.
// 세트 카드는 fake 서버가 결정까지 받고, 계획 카드는 호스트가 없어 영수증을 손으로 쓴다(`answer`). 두 시험 파일이 같은 바탕을 쓴다.
// =============================================================================

export const WS = FIXTURE_WORKSPACE_ID;
export const SELF = FIXTURE_MEMBER_ID;
export const HERMES = 'cccccccc-1111-4111-8111-cccccccccccc';
export const BASE = `/v1/workspaces/${WS}`;
export const NOW = FIXTURE_NOW_MS;
export const GATE: ApprovalGate = {
  approvalId: FIXTURE_SET_APPROVAL_ID,
  reversible: false,
  expiresAtMs: null,
};

export const ME: Member = {
  id: SELF,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};
export const roster = (id: string): RosterMember =>
  ({
    id,
    workspaceId: WS,
    kind: id === HERMES ? 'agent' : 'human',
    status: 'active',
    displayName: id === HERMES ? 'hermes' : '곽성재',
    handle: id === HERMES ? 'hermes' : 'seongjae',
    channelCount: 1,
    channelIds: [FIXTURE_CHANNEL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  }) as RosterMember;
export const DIRECTORY = makeDirectory([roster(SELF), roster(HERMES)]);

/** 서버가 올린 세트 승인 카드 한 장: `props.action.expressionSet`. 승인 줄의 나머지는 다른 행동 승인과 같다. */
export function setMessage(
  set: unknown,
  over: {status?: string; result?: unknown; action?: string} = {},
): Message {
  return {
    id: '0199aa11-2222-7000-8000-0000000000d1',
    channelId: FIXTURE_CHANNEL_ID,
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: HERMES,
    type: 'approval_request',
    body: '세트 제안',
    state: 'sent',
    createdAtMs: NOW,
    props: {
      approval_id: FIXTURE_SET_APPROVAL_ID,
      run_id: '0199aa11-2222-7000-8000-0000000000b2',
      channel_id: FIXTURE_CHANNEL_ID,
      action_type: 'workspace_action',
      status: over.status ?? 'pending',
      expires_at_ms: NOW + 3_600_000,
      title: '고양이 세트',
      action: {
        id: over.action ?? EXPRESSION_SET_ACTION_ID,
        rows: [],
        expressionSet: set,
      },
      ...(over.result === undefined ? {} : {result: over.result}),
    },
  } as unknown as Message;
}

const stores: PhoneExpressionStore[] = [];
const views: Array<{unmount: () => void}> = [];
/** 한 시험 안에서 다시 그리기 전에 지금 화면을 내린다. (`cleanup()` 을 시험 가운데서 부르면 다음 `render` 가 빈 화면이 된다.) */
export async function unmountAll() {
  await act(async () => {});
  views.splice(0).forEach(view => view.unmount());
  await act(async () => {});
}
export function makeStore() {
  const server = createExpressionFixtureServer({
    nowMs: NOW,
    sets: FIXTURE_SET_CARDS,
  });
  const request = jest.fn(async (input: ExpressionFixtureRequest) =>
    server.request(input),
  );
  const store = createPhoneExpressionStore(
    WS,
    SELF,
    {request},
    {write: (key: string) => `file:///fixture/${key}`, remove: jest.fn()},
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  return {store, request, server};
}

/** 대화 화면의 영수증 표를 그대로 흉내 낸다: 결정이 끝나면 그 승인의 영수증이 서고, 카드가 그 상태를 읽는다. */
export function Screen({
  message,
  store,
  settled,
  offline = false,
  gates,
}: {
  message: Message;
  store: PhoneExpressionStore | null;
  settled: jest.Mock;
  offline?: boolean;
  gates?: ReadonlyMap<string, ApprovalGate>;
}) {
  const [receipts, setReceipts] = useState<ReadonlyMap<string, ApprovalReceipt>>(
    new Map(),
  );
  const client = React.useMemo(
    () => new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}}),
    [],
  );
  return (
    <QueryClientProvider client={client}>
      <SessionProvider member={ME}>
        <PhoneExpressions.Provider value={store}>
          <MessageRow
            message={message}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gates ?? new Map([[FIXTURE_SET_APPROVAL_ID, GATE]])}
            approvalReceipts={receipts}
            approvalOffline={offline}
            approvalsProvided
            onApprovalSettled={(id: string, outcome: DecisionOutcome) => {
              settled(id, outcome);
              setReceipts(
                new Map([
                  [
                    id,
                    {
                      note: '',
                      ...(outcome.status === undefined
                        ? {}
                        : {status: outcome.status}),
                    },
                  ],
                ]),
              );
            }}
          />
        </PhoneExpressions.Provider>
      </SessionProvider>
    </QueryClientProvider>
  );
}


/** 결정 라우트의 답을 코어 fake 서버가 쓴다. */
export function serve(server: {request: (input: ExpressionFixtureRequest) => {status: number; json?: unknown}}) {
  post.mockImplementation((async (path: string, init: {method: string; body: string}) => {
    const response = server.request({
      method: init.method as 'POST',
      path,
      body: JSON.parse(init.body),
    });
    return {
      status: response.status,
      json: () => response.json,
      jsonOrNull: () => response.json ?? null,
      text: JSON.stringify(response.json ?? null),
    };
  }) as never);
}
export const answer = (status: number, json: unknown) =>
  post.mockResolvedValueOnce({
    status,
    json: () => json,
    jsonOrNull: () => json,
    text: JSON.stringify(json),
  } as never);
export const sentBody = (call = 0) =>
  JSON.parse(String(post.mock.calls[call][1].body)) as Record<string, unknown>;
export const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
export const tile = (index: number) => screen.getByTestId(`expression-set-tile-${index}`);
export const checked = (index: number) =>
  Boolean(tile(index).props.accessibilityState?.checked);
export const disabled = (testID: string) =>
  Boolean(screen.getByTestId(testID).props.accessibilityState?.disabled);
export const registerLabel = () =>
  within(screen.getByTestId('expression-set-register')).getByText(/개 등록|등록 중/)
    .props.children as string;
export async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
}
export async function settle() {
  await act(async () => {});
}
export async function mount(
  set: unknown,
  options: Partial<React.ComponentProps<typeof Screen>> & {
    message?: Message;
    store?: PhoneExpressionStore | null;
  } = {},
) {
  const made = makeStore();
  const settled = options.settled ?? jest.fn();
  const view = render(
    <Screen
      message={options.message ?? setMessage(set)}
      store={options.store === undefined ? made.store : options.store}
      settled={settled}
      offline={options.offline ?? false}
      gates={options.gates}
    />,
  );
  views.push(view);
  await settle();
  return {...made, settled, view};
}

/** 서버가 올린 계획 카드 한 장: `props.action.expressionSetPlan`. */
export function planMessage(
  plan: unknown,
  over: {status?: string} = {},
): Message {
  const base = setMessage(null, over);
  const props = base.props as Record<string, unknown>;
  return {
    ...base,
    body: '세트 계획',
    props: {
      ...props,
      title: '세트 계획',
      action: {
        id: EXPRESSION_SET_PLAN_ACTION_ID,
        rows: [],
        expressionSetPlan: plan,
      },
    },
  } as unknown as Message;
}

/** 결정 라우트로 가는 요청을 가로채는 하나의 목: 시험이 `mockResolvedValueOnce`·`mock.calls` 로 읽는다. */
export const post = jest.fn();
let authed: jest.SpyInstance | undefined;
let apiBase: jest.SpyInstance | undefined;
let clock: jest.SpyInstance | undefined;
let release: (() => void) | undefined;

/** 동작 줄이기의 시스템 답을 바꾼다(시험 가운데에서). */
export async function setReduceMotion(value: boolean) {
  release?.();
  release = await pinReduceMotion(value);
}

/** 두 시험 파일이 맨 위에서 한 번 부른다: 시계·결정 목·동작 줄이기를 세우고 끝나면 이 파일이 세운 것만 걷는다. */
export function installSetCardsHarness() {
  beforeEach(async () => {
    release = await pinReduceMotion(true);
    clock = jest.spyOn(Date, 'now').mockImplementation(() => NOW);
    post.mockReset();
    post.mockRejectedValue(new Error('no request expected'));
    authed = jest
      .spyOn(api, 'authedResponse')
      .mockImplementation(((...args: unknown[]) => post(...args)) as never);
    apiBase = jest.spyOn(host, 'apiBase').mockReturnValue('https://fixture.invalid');
    resetAttachmentContentForTest();
    (
      jest.requireMock('expo-file-system') as {
        __state: {downloads: unknown[]};
      }
    ).__state.downloads.length = 0;
  });
  afterEach(async () => {
    await act(async () => {});
    cleanup();
    stores.splice(0).forEach(store => store.dispose());
    release?.();
    release = undefined;
    // `jest.restoreAllMocks()` 는 setup 이 세운 전역 목(`Appearance.getColorScheme`)까지 비운다: 이 바탕이 세운 것만 되돌린다.
    authed?.mockRestore();
    clock?.mockRestore();
    apiBase?.mockRestore();
  });
}

/** 지금까지 내려받기 시도(`expo-file-system` 목): 참조 그림 썸네일이 대화의 첨부 길을 쓰는지 잰다. */
export function downloadedUrls(): string[] {
  return (
    jest.requireMock('expo-file-system') as {
      __state: {downloads: Array<{url: string}>};
    }
  ).__state.downloads.map(entry => entry.url);
}
