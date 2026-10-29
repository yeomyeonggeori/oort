import type {Channel, Member, Message, RosterMember} from '@momo/core/lib/api';
import {
  channelLabel,
  makeDirectory,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from './fixtures/darkWorld';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {LINK_ONCE_LEAD} from '@momo/core/features/approvals/secretOnce';
import {
  roleRequiredCopy,
} from '@momo/core/features/approvals/actionRole';
import {EXPIRED_LINE_NOTE} from '@momo/core/features/approvals/expiry';
import {MESSAGE_PREVIEW_LINK_LABEL} from '@momo/core/features/approvals/messagePreview';
import {
  AGENT_INITIATIVE_LABEL,
  AGENT_INITIATIVE_RATIONALE_LABEL,
  approvalHeadTitle,
  rationaleTag,
} from '@momo/core/features/timeline/agentInitiative';
import {
  APPROVAL_STATUS_LABEL,
  TURN_STATUS_LABEL,
} from '@momo/core/features/timeline/agentCardModel';
import {
  ACTION_RESULT_SECRET_ONCE_NOTE,
  ACTION_RESULT_STATUS_LABEL,
  ACTION_RESULT_STATUS_NOTE,
  type ActionResultStatus,
} from '@momo/core/features/timeline/actionResultCard';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import type {RowPresentation} from '@momo/core/features/timeline/rowModel';
import {color, TOUCH_TARGET} from '../src/design/tokens';
import {
  linkOnceFrom,
  type ApprovalGate,
  type ApprovalReceipt,
} from '../src/features/conversation/approvalGate';
import {COPY_RECEIPT_MS} from '../src/features/conversation/copy';
import {MESSAGE_PREVIEW_ACTION_NAME} from '../src/features/conversation/ApprovalMessagePreview';
import {jumpMissedNotice} from '../src/features/conversation/jumpNotice';
import {MessageRow, type MessageRowActions} from '../src/features/conversation/MessageRow';
import PushProvider from '../src/push/PushProvider';
import {RealtimeProvider} from '../src/realtime/RealtimeProvider';
import ConversationScreen from '../src/screens/ConversationScreen';
import {SessionProvider} from '../src/session/useSession';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// AX-7 (#2513) + U4-g (#1084): 폰 타임라인의 행동 승인 카드 · 1회 링크 · 결과 카드
//
// 픽스처는 **ADR-0186 부록 A·B·C 그대로**다 — 웹 AX-4 의 시험
// (`clients/web/src/features/timeline/actionCards.test.tsx`)과 같은 글자다. 두 클라가
// 같은 계약을 같은 입력으로 재야 「웹과 같은 의미」가 주장이 아니라 측정이 된다.
//
// 이 파일이 재는 것은 넷이다:
//
//   1. **결정은 타임라인 카드에서 한다** (#1084). 컨트롤은 인박스의 것을 그대로
//      부르고(`ApprovalDecision`), 행동 승인만 문장 두 칸이 갈린다 — 확정 문장과
//      403 안내. 403 은 무장을 풀고 조용한 안내로 선다(웹 R1 M1).
//   2. **1회 링크는 메모리에만 산다** (D4). 화면 수준에서 결정한 뒤 MMKV·키체인·
//      쿼리 캐시·콘솔을 뒤져 값이 **0회** 나타나는지, 대화를 다시 열거나 앱을 다시
//      띄우면 사라지는지를 **렌더 트리**에서 잰다. 픽스처에 값이 없는 것은 아무것도
//      증명하지 않는다 — 재는 것은 제품이 그 값을 어디에도 적지 않았다는 사실이다.
//   3. **결과 카드** (부록 B). 네 상태 · 1회 고지 · 결정한 사람 · 「다음 길」 문장.
//      폰에는 설정 화면이 없으므로 문이 아니라 문장이다(이탈 기록).
//   4. **모델 소비 단일점.** 폰은 코어가 읽어 준 모델만 그린다. `rowPresentation` 이
//      내놓은 카드를 바꿔치기하면 화면이 **바꾼 값**을 그려야 하고, props 원문을
//      그리면 폰이 어딘가에서 스스로 파싱하고 있다는 뜻이다.
// =============================================================================

// ---- 모델 소비 단일점의 이음매 --------------------------------------------------
//
// 폰이 카드 모델을 얻는 자리는 `MessageRow` 의 `rowPresentation(message)` 하나다.
// 그 함수를 감싸, 시험이 원할 때만 모델을 바꿔치기한다. 기본값(`null`)이면 코어의
// 답이 그대로 지나가므로 이 파일의 다른 시험은 진짜 모델 위에서 돈다.
//
// `agentCardModel` 이 아니라 `rowPresentation` 을 감싸는 이유: 앞의 것은
// `actionResultCard` 와 서로를 import 하는 모듈이라, 감싸는 팩토리가 도는 도중에
// 자기 자신을 다시 부르게 된다. `rowModel` 은 그 고리 밖에 있다.
let mockCardTransform:
  | ((card: NonNullable<RowPresentation['card']>) => RowPresentation['card'])
  | null = null;

jest.mock('@momo/core/features/timeline/rowModel', () => {
  const actual = jest.requireActual('@momo/core/features/timeline/rowModel');
  return {
    ...actual,
    rowPresentation: (message: unknown) => {
      const presentation = actual.rowPresentation(message);
      if (mockCardTransform === null || presentation.card === null) {
        return presentation;
      }
      return {...presentation, card: mockCardTransform(presentation.card)};
    },
  };
});

// ---- 계약 픽스처 (부록 A·B·C) ---------------------------------------------------

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const HERMES = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'ch-general';
/** 대화를 닫지 않고 옮겨 갈 두 번째 방. */
const OTHER = 'ch-random';
const APPROVAL_ID = '0199aa11-2222-7000-8000-0000000000a1';
const INVITE_ID = '0199aa11-2222-7000-8000-0000000000f1';
const SECRET = 'https://oort.test/join?code=Ab3-_xQ7';
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;

/** 부록 A. */
function appendixA(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approval_id: APPROVAL_ID,
    run_id: '0199aa11-2222-7000-8000-0000000000b2',
    channel_id: GENERAL,
    action_type: 'workspace_action',
    status: 'pending',
    expires_at_ms: 0,
    title: '팀원 초대 링크 만들기',
    summary:
      'hermes가 제안했습니다. 승인하면 관리자 권한으로 초대 링크를 만듭니다.',
    action: {
      id: 'invite.create',
      rows: [
        {label: '역할', value: 'member'},
        {label: '사용 횟수', value: '1회'},
        {label: '만료', value: '7일'},
      ],
      rationale: '새 팀원 온보딩 요청',
      required_role: 'admin',
    },
    ...over,
  };
}

/** 부록 C (200). */
const APPENDIX_C = {
  approval_id: APPROVAL_ID,
  status: 'approved',
  decided_by: SELF_ID,
  decided_at_ms: BASE_MS + 60_000,
  result: {
    actionId: 'invite.create',
    ref: {type: 'invite', id: INVITE_ID},
    secretOnce: {kind: 'invite_link', value: SECRET, expiresAtMs: BASE_MS + 7 * 86_400_000},
  },
};

/** 부록 B. `next` 는 정오표 뒤의 서버 값(`section=members`)이다. */
function appendixB(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'momo.action_result': {
      v: 1,
      action_id: 'invite.create',
      status: 'executed',
      approval_id: APPROVAL_ID,
      decided_by: SELF_ID,
      ref: {type: 'invite', id: INVITE_ID},
      rows: [
        {label: '역할', value: 'member'},
        {label: '만료', value: '2026-09-29'},
      ],
      secret_shown_once: true,
      next: {
        label: '설정 › 멤버와 초대에서 보기',
        href: '/settings?section=members',
      },
      ...over,
    },
  };
}

function approvalMessage(props: Record<string, unknown> = appendixA()): Message {
  return {
    id: '0199aa11-2222-7000-8000-0000000000d1',
    channelId: GENERAL,
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: HERMES,
    type: 'approval_request',
    body: 'Approve invite.create',
    state: 'sent',
    createdAtMs: BASE_MS,
    props,
  } as unknown as Message;
}

function resultMessage(props: Record<string, unknown> = appendixB()): Message {
  return {
    id: '0199aa11-2222-7000-8000-0000000000d2',
    channelId: GENERAL,
    seq: 11,
    hlcTs: 11,
    hlcCount: 0,
    authorMemberId: HERMES,
    type: 'tool_result',
    body: '초대 링크를 만들었습니다.',
    state: 'sent',
    createdAtMs: BASE_MS + 61_000,
    props,
  } as unknown as Message;
}

function rosterMember(id: string, over: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: id === HERMES ? 'agent' : 'human',
    status: 'active',
    displayName: id === HERMES ? 'hermes' : '곽성재',
    handle: id === HERMES ? 'hermes' : 'seongjae',
    channelCount: 1,
    channelIds: [GENERAL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const ROSTER = [rosterMember(SELF_ID), rosterMember(HERMES)];
const DIRECTORY = makeDirectory(ROSTER);
const ME: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

const GATE: ApprovalGate = {
  approvalId: APPROVAL_ID,
  reversible: false,
  expiresAtMs: null,
};

const PREFIX = `card-approval-${APPROVAL_ID}`;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
const keychainItems = (
  jest.requireMock('react-native-keychain') as {
    __items: Map<string, {username: string; password: string}>;
  }
).__items;
const clipboard = (
  jest.requireMock('expo-clipboard') as {__box: {value: string | null}}
).__box;

/** RN 스타일은 값이거나 (중첩된) 배열이다. */
function flat(style: unknown): Record<string, unknown> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

/**
 * 이 트리의 모든 글자 — 본문과 접근성 이름까지. 「값이 0회 나타난다」를 렌더
 * 트리에서 재는 데 쓴다. `toJSON()` 을 통째로 직렬화하지 않는 이유: props 에
 * 컨텍스트 객체가 매달려 있어 순환이고, 재야 하는 것은 **사람에게 닿는 글자**다.
 */
function renderedText(): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const element = node as {
      children?: unknown[] | null;
      props?: Record<string, unknown>;
    };
    for (const key of ['accessibilityLabel', 'accessibilityHint', 'value']) {
      const text = element.props?.[key];
      if (typeof text === 'string') out.push(text);
    }
    element.children?.forEach(walk);
  };
  walk(screen.toJSON());
  return out.join('\n');
}

/** 테스트가 쥔 시계(기한 판정이 `Date.now` 를 읽는다). */
let nowMs = BASE_MS;

beforeEach(() => {
  nowMs = BASE_MS;
  jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  mockCardTransform = null;
  mmkvStore.clear();
  keychainItems.clear();
  clipboard.value = null;
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: ME,
  });
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ---- 행 수준 하네스 --------------------------------------------------------------

interface DecisionLog {
  calls: {approve: boolean; key: string}[];
}

/** 결정 POST 하나만 답하는 fetch. 행 수준 시험은 원장 목록을 부르지 않는다. */
function installDecision(respond: () => Response): DecisionLog {
  const log: DecisionLog = {calls: []};
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/decision')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      log.calls.push({approve: body.approve, key: body.client_decision_id});
      return respond();
    }
    throw new Error(`unrouted request: ${target}`);
  }) as unknown as typeof fetch;
  return log;
}

function renderRow(props: {
  message?: Message;
  gates?: ReadonlyMap<string, ApprovalGate>;
  receipts?: ReadonlyMap<string, ApprovalReceipt>;
  onSettled?: (approvalId: string, outcome: DecisionOutcome) => void;
  nowMs?: number;
  /** 행이 할 수 있는 일(#4705: 「전문 보기」가 여는 곳). 없으면 읽기 전용 표면이다. */
  actions?: MessageRowActions;
  directory?: Directory;
}) {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={ME}>
        <MessageRow
          message={props.message ?? approvalMessage()}
          startsGroup
          directory={props.directory ?? DIRECTORY}
          chips={[]}
          nowMs={props.nowMs ?? BASE_MS}
          approvalGates={props.gates ?? new Map([[APPROVAL_ID, GATE]])}
          approvalReceipts={props.receipts}
          approvalsProvided
          onApprovalSettled={props.onSettled ?? (() => {})}
          actions={props.actions}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

/** 한 번 탭하면 결정이 나간다 (#3819). 확정 단계는 없다. */
async function armAndCommit(direction: 'approve' | 'reject'): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`${PREFIX}-${direction}`));
  });
}

// =============================================================================
describe('#1084 — 타임라인 승인 카드에서 바로 결정한다', () => {
  it('행동 승인 카드에 승인·거부 버튼이 선다 — 다른 데로 가라는 문장이 아니라', () => {
    renderRow({});
    const card = screen.getByTestId('agent-card');
    expect(within(card).getByTestId(`${PREFIX}-approve`)).toBeTruthy();
    expect(within(card).getByTestId(`${PREFIX}-reject`)).toBeTruthy();
    expect(
      within(card).queryByText('이 결정은 인박스나 데스크톱 앱에서 할 수 있어요.'),
    ).toBeNull();
  });

  it('승인 한 번에 결정이 나가고 확정 단계가 서지 않는다 (#3819)', async () => {
    const log = installDecision(() => jsonResponse(200, APPENDIX_C));
    renderRow({});
    expect(screen.queryByTestId(`${PREFIX}-confirm`)).toBeNull();
    await armAndCommit('approve');
    await waitFor(() => expect(log.calls).toHaveLength(1));
    expect(screen.queryByTestId(`${PREFIX}-confirm`)).toBeNull();
    expect(screen.queryByTestId(`${PREFIX}-commit`)).toBeNull();
    // 서버가 실행한다는 사실은 눌리기 전에 카드가 이미 말한다(결정 권한 행).
    expect(renderedText()).not.toContain('에이전트가 이어서');
  });

  it('기한이 지난 행동 승인은 누르기 전에 만료를 말한다', () => {
    renderRow({
      gates: new Map([[APPROVAL_ID, {...GATE, expiresAtMs: BASE_MS - 1}]]),
    });
    expect(
      within(screen.getByTestId(`${PREFIX}-actions`)).getByText(
        /만료로 기록돼요/,
      ),
    ).toBeTruthy();
  });

  it('승인을 확정하면 결정이 한 번 나가고 원장의 답(부록 C)이 호출자에게 간다', async () => {
    const log = installDecision(() => jsonResponse(200, APPENDIX_C));
    const settled: DecisionOutcome[] = [];
    renderRow({onSettled: (_id, outcome) => settled.push(outcome)});
    await armAndCommit('approve');
    await waitFor(() => expect(settled).toHaveLength(1));
    expect(log.calls).toEqual([{approve: true, key: expect.any(String)}]);
    expect(settled[0]).toMatchObject({kind: 'committed', status: 'approved'});
    expect(linkOnceFrom(settled[0])?.value).toBe(SECRET);
  });

  it('거부도 한 번에 나가고, 거부된 결정에는 링크가 없다', async () => {
    const log = installDecision(() =>
      jsonResponse(200, {...APPENDIX_C, status: 'rejected', result: undefined}),
    );
    const settled: DecisionOutcome[] = [];
    renderRow({onSettled: (_id, outcome) => settled.push(outcome)});
    await armAndCommit('reject');
    await waitFor(() => expect(settled).toHaveLength(1));
    expect(log.calls).toEqual([{approve: false, key: expect.any(String)}]);
    expect(settled[0]).toMatchObject({kind: 'committed', status: 'rejected'});
    expect(linkOnceFrom(settled[0])).toBeUndefined();
  });
});

// =============================================================================
describe('#1084 — 403 은 「관리자가 승인해야 해요」라는 조용한 안내다 (ADR-0186 §5)', () => {
  const ROLE_COPY = roleRequiredCopy('admin');

  it('영수증이 role_required 라고 말하면 조용한 안내가 서고 버튼은 그대로다', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    installDecision(() =>
      jsonResponse(403, {approval_id: APPROVAL_ID, status: 'role_required'}),
    );
    renderRow({});
    await armAndCommit('approve');
    const notice = await screen.findByTestId(`${PREFIX}-error`);
    expect(notice.props.children).toBe(ROLE_COPY);
    expect(ROLE_COPY).toContain('관리자가 승인해야 해요.');
    expect(ROLE_COPY).toContain('아직 대기 중');
    // 사고가 아니다 — 붉지 않다. 웹의 `unavailable`(ink-muted)과 같은 자리.
    expect(flat(notice.props.style).color).toBe(color.textMuted);
    expect(flat(notice.props.style).color).not.toBe(color.danger);
    // 확정 버튼은 애초에 없다(#3819) — 승인·거부가 그대로 서 있을 뿐이다.
    expect(screen.queryByTestId(`${PREFIX}-commit`)).toBeNull();
    // 요청은 여전히 대기다 — 다른 사람이 이어받을 수 있다.
    expect(screen.getByTestId(`${PREFIX}-approve`)).toBeTruthy();
    expect(screen.getByTestId(`${PREFIX}-reject`)).toBeTruthy();
    expect(within(screen.getByTestId('agent-card')).getByText('승인 대기')).toBeTruthy();
    // 엄지 밑의 버튼이 바뀐 것을 소리로도 말한다.
    expect(announce).toHaveBeenCalledWith(ROLE_COPY);
  });

  it('이름 없는 403 도 같은 갈래를 탄다 — 웹의 판정 그대로', async () => {
    installDecision(() => jsonResponse(403, {status: 'pending'}));
    renderRow({});
    await armAndCommit('approve');
    const notice = await screen.findByTestId(`${PREFIX}-error`);
    expect(notice.props.children).toBe(ROLE_COPY);
    expect(screen.queryByTestId(`${PREFIX}-commit`)).toBeNull();
  });

  it('다시 누르면 안내가 걷히고 같은 결정을 다시 보낸다', async () => {
    installDecision(() =>
      jsonResponse(403, {approval_id: APPROVAL_ID, status: 'role_required'}),
    );
    renderRow({});
    await armAndCommit('approve');
    await screen.findByTestId(`${PREFIX}-error`);
    // 다시 누르면 안내가 걷히고 요청이 다시 나간다(같은 403 이 안내를 다시 세운다).
    await armAndCommit('approve');
    await screen.findByTestId(`${PREFIX}-error`);
    expect(screen.getByTestId(`${PREFIX}-approve`)).toBeTruthy();
  });

  it('행동 블록이 없는 승인의 403 은 지금까지의 붉은 문장이다 (회귀 0)', async () => {
    installDecision(() => jsonResponse(403, {status: 'pending'}));
    renderRow({
      message: approvalMessage({
        approval_id: APPROVAL_ID,
        title: 'github.search_issues 실행 허가',
        approval_status: 'pending',
      }),
    });
    await armAndCommit('approve');
    const error = await screen.findByTestId(`${PREFIX}-error`);
    expect(error.props.children).toBe(
      '이 승인을 결정할 권한이 없어요. 채널 멤버인지 확인해 주세요.',
    );
    expect(flat(error.props.style).color).toBe(color.danger);
    // 버튼은 그대로 남는다(다른 멤버가 이어받을 수 있다).
    expect(screen.getByTestId(`${PREFIX}-approve`)).toBeTruthy();
  });
});

// =============================================================================
describe('design-review H-1 — 카드가 누가 결정하는지를 한 가지로만 말한다', () => {
  const DEFAULT_LEAD = '실행하기 전에 허가가 필요해요.';

  it('행동 승인 카드는 기본 머리 문장(「허가가 필요해요」)을 세우지 않는다 — 결정 권한 행과 부딪친다', () => {
    renderRow({});
    const card = screen.getByTestId('agent-card');
    expect(within(card).getByText('관리자만 승인할 수 있어요.')).toBeTruthy();
    expect(within(card).queryByText(DEFAULT_LEAD)).toBeNull();
    // 컨트롤은 그대로 선다.
    expect(within(card).getByTestId(`${PREFIX}-approve`)).toBeTruthy();
  });

  it('403 뒤에도 서로 반박하는 문장이 함께 서지 않는다', async () => {
    installDecision(() =>
      jsonResponse(403, {approval_id: APPROVAL_ID, status: 'role_required'}),
    );
    renderRow({});
    await armAndCommit('approve');
    await screen.findByTestId(`${PREFIX}-error`);
    const card = screen.getByTestId('agent-card');
    expect(within(card).queryByText(DEFAULT_LEAD)).toBeNull();
    expect(within(card).getByText(roleRequiredCopy('admin'))).toBeTruthy();
  });

  it('도구 호출 승인은 머리 문장을 그대로 든다 (회귀 0)', () => {
    renderRow({
      message: approvalMessage({
        approval_id: APPROVAL_ID,
        title: 'github.search_issues 실행 허가',
        approval_status: 'pending',
      }),
    });
    expect(
      within(screen.getByTestId('agent-card')).getByText(DEFAULT_LEAD),
    ).toBeTruthy();
    // 사실 표가 없으니 가르는 선도 없다 — 이 카드의 기존 캡처가 낡지 않는다.
    expect(screen.queryByTestId('approval-action-footer')).toBeNull();
  });

  it('행동 승인의 컨트롤·영수증 자리는 사실 표와 선 하나로 갈린다 (M-1)', () => {
    const pending = renderRow({});
    const footer = screen.getByTestId('approval-action-footer');
    expect(within(footer).getByTestId(`${PREFIX}-approve`)).toBeTruthy();
    const style = flat(footer.props.style);
    expect(style.borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(style.borderTopColor).toBe(color.border);
    // 영수증과 링크도 같은 자리에 선다.
    pending.unmount();
    renderRow({
      gates: new Map(),
      receipts: new Map([
        [
          APPROVAL_ID,
          {
            note: '승인을 기록했어요.',
            status: 'approved',
            secretOnce: {kind: 'invite_link', value: SECRET, expiresAtMs: null},
          },
        ],
      ]),
    });
    const settled = screen.getByTestId('approval-action-footer');
    expect(within(settled).getByTestId('card-approval-receipt')).toBeTruthy();
    expect(within(settled).getByTestId('card-approval-link-once')).toBeTruthy();
  });
});

// =============================================================================
describe('#2513 — 행동 승인 카드의 행·사유·결정 권한 (부록 A)', () => {
  it('action 행 셋(역할·횟수·만료)과 사유·결정 권한을 그린다', () => {
    renderRow({});
    const rows = screen.getAllByTestId('approval-action-row');
    expect(rows).toHaveLength(3);
    const text = (node: (typeof rows)[number]) =>
      within(node)
        .getAllByText(/.+/)
        .map(child => child.props.children)
        .join('|');
    expect(rows.map(text)).toEqual(['역할|member', '사용 횟수|1회', '만료|7일']);
    expect(
      within(screen.getByTestId('approval-action-rationale')).getByText(
        '새 팀원 온보딩 요청',
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('approval-action-role')).getByText(
        '관리자만 승인할 수 있어요.',
      ),
    ).toBeTruthy();
  });

  it('행의 값은 본문 잉크로 선다 — 원본 데이터 접힘보다 한 단 앞이다', () => {
    renderRow({});
    const [row] = screen.getAllByTestId('approval-action-row');
    const value = within(row).getByText('member');
    expect(flat(value.props.style).color).toBe(color.text);
  });

  it('상한을 넘거나 모양이 어긋난 행은 개수로 말한다', () => {
    renderRow({
      message: approvalMessage(
        appendixA({
          action: {
            id: 'invite.create',
            rows: [{label: '역할', value: 'member'}, {label: '', value: 'x'}, 'bad'],
            required_role: 'admin',
          },
        }),
      ),
    });
    expect(screen.getAllByTestId('approval-action-row')).toHaveLength(1);
    expect(
      within(screen.getByTestId('approval-action-omitted')).getByText(
        '2개를 표시하지 못했습니다.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('approval-action-rationale')).toBeNull();
  });

  it('도구 호출 승인에는 행동 행이 하나도 붙지 않는다 (회귀 0)', () => {
    renderRow({
      message: approvalMessage({
        approval_id: APPROVAL_ID,
        title: 'github.search_issues 실행 허가',
        approval_status: 'pending',
      }),
    });
    expect(screen.queryByTestId('approval-action-rows')).toBeNull();
    expect(screen.queryByTestId('approval-action-role')).toBeNull();
    expect(screen.getByTestId(`${PREFIX}-approve`)).toBeTruthy();
  });
});

// =============================================================================
// #4705 — 먼저 제안 카드 · 고정 카드 · 만료 줄 (ADR-0186 증보 v5 U-c·U-e)
//
// 픽스처는 서버 PR A(`agent_initiative.rs`)가 쓰는 모양 그대로다: `props.origin` 은 최상위,
// `props.action.preview` 는 `{kind:"message", messageId, channelId, totalChars, truncated}`,
// 만료 줄은 `tool_result` 의 `{call_id:"", output:<영어 본문>, is_error:true, status:"expired", …}`.
// 웹 시험(`actionCards.test.tsx`)과 같은 글자다. 서버가 아직 이 트랙에 없으므로 실서버 확인은
// 승격 뒤다(runtime-unverified).
//
// 카드의 모양은 다음 묶음에서 새로 짠다(2026-10-29 범위 조정). 그래서 여기서 재는 것은 셋뿐이다:
// 제목 끝 꼬리표와 사유 이름표 · 고정 카드의 링크 하나(결정 전에만, 열 곳이 있을 때만) · 만료 줄이
// 실패의 얼굴을 입지 않는 것.
// =============================================================================

const PLANNER_ID = '019f9a01-0000-7000-8000-0000000004a1';
const PIN_CHANNEL = '00000000-0000-7000-8000-000000000302';
const PIN_MESSAGE = '0199aa11-2222-7000-8000-0000000000c1';
const PIN_TITLE = '승인 요청: 메시지 고정';
const PIN_RATIONALE = '안내문을 채널 맨 위에 두고 싶어요';
const PIN_ROWS = [
  {label: '채널', value: '#달무리 공지'},
  {label: '쓴 사람', value: '박서연'},
  {label: '글자 수', value: '1234자'},
];
const EXPIRY_BODY = 'Tool call expired without a human approval.';

/** 이도현(나)과 플래너(에이전트)만 있는 명부. 카드 작성자는 플래너다. */
const PIN_ROSTER = [
  rosterMember(SELF_ID, {displayName: '이도현', handle: 'dohyun'}),
  rosterMember(PLANNER_ID, {kind: 'agent', displayName: '플래너', handle: 'planner'}),
];
const PIN_DIRECTORY = makeDirectory(PIN_ROSTER);

/** 서버가 먼저 제안한 고정 카드에 싣는 props. */
function pinProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return appendixA({
    title: PIN_TITLE,
    origin: 'agent_initiated',
    summary: '플래너가 먼저 제안했어요.',
    action: {
      id: 'message.pin',
      rows: PIN_ROWS,
      rationale: PIN_RATIONALE,
      required_role: 'admin',
      preview: {
        kind: 'message',
        messageId: PIN_MESSAGE,
        channelId: PIN_CHANNEL,
        totalChars: 1234,
        truncated: true,
      },
    },
    ...over,
  });
}

function pinMessage(props: Record<string, unknown> = pinProps()): Message {
  return {...approvalMessage(props), authorMemberId: PLANNER_ID} as Message;
}

/** 이 카드를 어떤 표면에 그리는가: 열 곳(`onOpenMessage`)을 아는가 모르는가. */
function pinActions(over: Partial<MessageRowActions> = {}): MessageRowActions {
  return {
    myMemberId: SELF_ID,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    ...over,
  };
}

function renderPin(
  props: Record<string, unknown> = pinProps(),
  over: Parameters<typeof renderRow>[0] = {},
) {
  return renderRow({message: pinMessage(props), directory: PIN_DIRECTORY, ...over});
}

/** 로터 행동의 이름들. 행은 접근성 요소 하나라 카드 안 링크에는 로터로만 닿는다. */
function rotorNames(): string[] {
  const actions = (screen.getByTestId('message-row').props.accessibilityActions ??
    []) as {name: string}[];
  return actions.map(action => action.name);
}

/** 렌더 트리의 testID 를 눈이 읽는 순서(문서 순서)대로. 「결정 버튼 위」를 재는 데 쓴다. */
function testIdsInOrder(): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const element = node as {
      props?: Record<string, unknown>;
      children?: unknown[] | null;
    };
    const id = element.props?.testID;
    if (typeof id === 'string') out.push(id);
    element.children?.forEach(walk);
  };
  walk(screen.toJSON());
  return out;
}

const SETTLED_APPROVED = new Map<string, ApprovalReceipt>([
  [APPROVAL_ID, {note: '승인을 기록했어요.', status: 'approved'}],
]);

// =============================================================================
describe('#4705 — 먼저 제안 카드 (ADR-0186 증보 v5 U-c)', () => {
  it('제목 끝에 꼬리표가 붙고 사유 이름표가 「에이전트가 쓴 글」이다 — 새 행은 서지 않는다', () => {
    renderPin();
    const head = screen.getByTestId('approval-card-title').props.children as string;
    expect(head).toBe(approvalHeadTitle({title: PIN_TITLE, agentInitiated: true}));
    // 위 문장이 코어와 같다는 것만으로는 꼬리표가 있다는 증거가 못 된다 — 눈에 닿는 글자를 잰다.
    expect(head.startsWith(PIN_TITLE)).toBe(true);
    expect(head).toContain(AGENT_INITIATIVE_LABEL);
    const rationale = screen.getByTestId('approval-action-rationale');
    expect(within(rationale).getByText(AGENT_INITIATIVE_RATIONALE_LABEL)).toBeTruthy();
    expect(within(rationale).getByText(PIN_RATIONALE)).toBeTruthy();
    // 이름표뿐이다: 사유 아래 줄을 더 세우지 않고, 서버 행 말고는 행이 없다.
    expect(screen.queryByTestId('approval-action-rationale-note')).toBeNull();
    expect(screen.getAllByTestId('approval-action-row')).toHaveLength(PIN_ROWS.length);
    expect(screen.queryByTestId('approval-initiative')).toBeNull();
    // 결정 컨트롤은 그대로 선다.
    expect(screen.getByTestId(`${PREFIX}-approve`)).toBeTruthy();
    expect(screen.getByTestId(`${PREFIX}-reject`)).toBeTruthy();
  });

  it('origin 이 없거나 모르는 값이면 지금까지의 카드 그대로다 — 꼬리표도 이름표도 없다', () => {
    const plainLabel = rationaleTag({}).label;
    expect(plainLabel).not.toBe(AGENT_INITIATIVE_RATIONALE_LABEL);
    const withoutOrigin = pinProps();
    delete withoutOrigin.origin;
    for (const props of [withoutOrigin, pinProps({origin: 'scheduled'})]) {
      const view = renderPin(props);
      expect(screen.getByTestId('approval-card-title').props.children).toBe(PIN_TITLE);
      const rationale = screen.getByTestId('approval-action-rationale');
      expect(within(rationale).queryByText(AGENT_INITIATIVE_RATIONALE_LABEL)).toBeNull();
      expect(within(rationale).getByText(plainLabel)).toBeTruthy();
      view.unmount();
    }
  });

  it('결정이 난 카드에도 꼬리표는 남는다 — 이 카드가 무엇이었는지는 바뀌지 않는다', () => {
    renderPin(pinProps(), {gates: new Map(), receipts: SETTLED_APPROVED});
    expect(screen.getByTestId('approval-card-title').props.children).toContain(
      AGENT_INITIATIVE_LABEL,
    );
  });
});

// =============================================================================
describe('#4705 — 고정·고정 풀기 카드의 「전문 보기」 (ADR-0186 증보 v5 U-e)', () => {
  it('미리보기와 열 곳이 있으면 결정 버튼 위에 링크가 서고, 누르면 (채널, 메시지)로 연다', () => {
    const onOpenMessage = jest.fn();
    renderPin(pinProps(), {actions: pinActions({onOpenMessage})});
    const link = screen.getByTestId('approval-message-preview-link');
    expect(link.props.accessibilityRole).toBe('link');
    expect(within(link).getByText(MESSAGE_PREVIEW_LINK_LABEL)).toBeTruthy();
    // 누르는 면은 44 이상이다(글자는 한 줄이지만 손가락은 그보다 크다).
    expect(flat(link.props.style).minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    // 사실 행 아래, 결정 버튼 위 — 앞 120자만 보고 누르지 않게 버튼 바로 앞에 선다.
    const order = testIdsInOrder();
    const at = order.indexOf('approval-message-preview-link');
    expect(at).toBeGreaterThan(order.indexOf('approval-action-rows'));
    expect(at).toBeLessThan(order.indexOf('approval-action-footer'));
    expect(screen.getByTestId(`${PREFIX}-approve`)).toBeTruthy();
    fireEvent.press(link);
    expect(onOpenMessage).toHaveBeenCalledTimes(1);
    expect(onOpenMessage).toHaveBeenCalledWith(PIN_CHANNEL, PIN_MESSAGE);
  });

  it('VoiceOver 는 로터로 같은 문에 닿는다 — 승인·거부보다 앞이다', () => {
    const onOpenMessage = jest.fn();
    renderPin(pinProps(), {actions: pinActions({onOpenMessage})});
    const row = screen.getByTestId('message-row');
    // 행이 접근성 요소 하나라는 전제부터 잰다(위 1회 링크 시험과 같은 이유).
    expect(row.props.accessible).toBe(true);
    const rotor = (row.props.accessibilityActions ?? []) as {name: string; label: string}[];
    const names = rotor.map(action => action.name);
    expect(names).toContain(MESSAGE_PREVIEW_ACTION_NAME);
    expect(rotor.find(action => action.name === MESSAGE_PREVIEW_ACTION_NAME)?.label).toBe(
      MESSAGE_PREVIEW_LINK_LABEL,
    );
    expect(names.indexOf(MESSAGE_PREVIEW_ACTION_NAME)).toBeLessThan(
      names.indexOf('momoApprove'),
    );
    fireEvent(row, 'accessibilityAction', {
      nativeEvent: {actionName: MESSAGE_PREVIEW_ACTION_NAME},
    });
    expect(onOpenMessage).toHaveBeenCalledWith(PIN_CHANNEL, PIN_MESSAGE);
  });

  it('열 곳을 모르는 표면에는 링크도 로터 행동도 없다 — 눌러도 아무 일 없는 버튼을 두지 않는다', () => {
    // 읽기 전용 표면(actions 없음)과, 행동은 있으나 열 곳은 없는 표면.
    for (const actions of [undefined, pinActions()]) {
      const view = renderPin(pinProps(), actions === undefined ? {} : {actions});
      expect(screen.queryByTestId('approval-message-preview-link')).toBeNull();
      expect(rotorNames()).not.toContain(MESSAGE_PREVIEW_ACTION_NAME);
      // 서버 행과 결정 컨트롤은 그대로다.
      expect(screen.getAllByTestId('approval-action-row')).toHaveLength(PIN_ROWS.length);
      expect(screen.getByTestId(`${PREFIX}-approve`)).toBeTruthy();
      view.unmount();
    }
  });

  it('대상 메시지가 없거나 모르는 종류의 미리보기, 고정이 아닌 카드에는 링크가 없다', () => {
    const onOpenMessage = jest.fn();
    const noPreview = pinProps();
    delete (noPreview.action as Record<string, unknown>).preview;
    const unknownKind = pinProps();
    (unknownKind.action as Record<string, unknown>).preview = {kind: 'thread'};
    for (const props of [noPreview, unknownKind, appendixA()]) {
      const view = renderPin(props, {actions: pinActions({onOpenMessage})});
      expect(screen.queryByTestId('approval-message-preview-link')).toBeNull();
      expect(rotorNames()).not.toContain(MESSAGE_PREVIEW_ACTION_NAME);
      view.unmount();
    }
    expect(onOpenMessage).not.toHaveBeenCalled();
  });

  it('결정이 난 카드에는 링크도 로터 행동도 없다 — 이 문은 결정 전에 읽는 것이다', () => {
    const onOpenMessage = jest.fn();
    const decided = pinProps({
      status: 'approved',
      approval_status: 'approved',
      decided_by: SELF_ID,
      decided_at_ms: BASE_MS + 60_000,
    });
    const cases: Parameters<typeof renderRow>[0][] = [
      // 이 기기에서 방금 결정한 영수증(승인·거부).
      {gates: new Map(), receipts: SETTLED_APPROVED},
      {
        gates: new Map(),
        receipts: new Map([[APPROVAL_ID, {note: '거부를 기록했어요.', status: 'rejected'}]]),
      },
      // 서버가 카드 props 에 결정을 기록해 보낸 스냅샷.
      {gates: new Map()},
    ];
    cases.forEach((over, index) => {
      const view = renderPin(index === 2 ? decided : pinProps(), {
        ...over,
        actions: pinActions({onOpenMessage}),
      });
      expect(screen.queryByTestId('approval-message-preview-link')).toBeNull();
      expect(rotorNames()).not.toContain(MESSAGE_PREVIEW_ACTION_NAME);
      view.unmount();
    });
    expect(onOpenMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe('#4705 — 만료 스윕이 남긴 줄은 실패가 아니다 (검수 L4, ADR-0132)', () => {
  /** 서버 `approval_sweep.rs` 가 만료한 승인마다 쓰는 줄. 본문은 영어 기본 문구다. */
  function expiryMessage(props: Record<string, unknown> = {}): Message {
    return {
      ...resultMessage({
        call_id: '',
        output: EXPIRY_BODY,
        is_error: true,
        approval_id: APPROVAL_ID,
        run_id: '0199aa11-2222-7000-8000-0000000000b2',
        status: 'expired',
        decided_at_ms: BASE_MS + 3_600_000,
        ...props,
      }),
      authorMemberId: PLANNER_ID,
      body: EXPIRY_BODY,
    } as Message;
  }

  it('조용한 한국어 한 줄이다: 결과 문장 하나, 중립의 「만료됨」, 실패가 아닌 빈 표지', () => {
    renderRow({message: expiryMessage(), gates: new Map(), directory: PIN_DIRECTORY});
    const steps = screen.getByTestId('agent-card-steps');
    // 문장은 결과 한 줄뿐이다(「동사 → 결과」로 잇지 않는다).
    expect(within(steps).getByText(EXPIRED_LINE_NOTE)).toBeTruthy();
    expect(within(steps).queryByText(/→/)).toBeNull();
    const meta = within(steps).getByText(APPROVAL_STATUS_LABEL.expired);
    expect(flat(meta.props.style).color).not.toBe(color.danger);
    // 표지는 실패의 ✕ 가 아니라 빈 원이다.
    expect(within(steps).getByTestId('step-mark-idle')).toBeTruthy();
    expect(screen.queryByTestId('step-mark-fail')).toBeNull();
    // 영어 본문도 「실패」 낱말도 화면에 없다.
    expect(screen.queryByText(EXPIRY_BODY)).toBeNull();
    expect(screen.queryByText(TURN_STATUS_LABEL.error)).toBeNull();
    // 조용한 한 줄이다: 「표시하지 않은 항목 N개」 줄도 서지 않는다(코어가 이 줄의 숨김 수를 0으로 준다).
    expect(screen.queryByTestId('agent-card-withheld')).toBeNull();
  });

  it('스윕 줄이 아닌 같은 is_error 도구 실패는 지금까지처럼 실패로 선다 (회귀 0)', () => {
    renderRow({
      message: expiryMessage({
        call_id: 'call-1',
        tool_name: 'github.search_issues',
        output: '요청이 거절됐어요.',
        status: undefined,
        approval_id: undefined,
      }),
      gates: new Map(),
      directory: PIN_DIRECTORY,
    });
    expect(screen.getByTestId('step-mark-fail')).toBeTruthy();
    expect(screen.getByText(TURN_STATUS_LABEL.error)).toBeTruthy();
    expect(screen.queryByTestId('step-mark-idle')).toBeNull();
    // 위 스윕 줄의 「숨김 줄 없음」 단정이 헛초록이 아님을 같은 자로 보인다: 읽지 않는 키(`call_id`·`output`)가
    // 있는 보통의 도구 카드에는 그 줄이 선다.
    expect(screen.getByTestId('agent-card-withheld')).toBeTruthy();
  });
});

// =============================================================================
describe('#2513 — 1회 링크는 영수증 자리에만 선다 (ADR-0182 ① · D4)', () => {
  const SECRET_ONCE = {kind: 'invite_link', value: SECRET, expiresAtMs: null};

  it('승인 영수증에 값이 있으면 버튼 자리에 리드·값·복사가 선다', () => {
    renderRow({
      gates: new Map(),
      receipts: new Map([
        [
          APPROVAL_ID,
          {note: '승인을 기록했어요.', status: 'approved', secretOnce: SECRET_ONCE},
        ],
      ]),
    });
    const card = screen.getByTestId('agent-card');
    expect(within(card).getByTestId('card-approval-receipt')).toBeTruthy();
    expect(
      within(card).getByTestId('card-approval-link-once-lead').props.children,
    ).toBe(LINK_ONCE_LEAD);
    // 잘리지 않는다 (웹 R1 B1) — 값 전체가 한 요소에, 줄 수 제한 없이.
    const value = within(card).getByTestId('card-approval-link-once-value');
    expect(value.props.children).toBe(SECRET);
    expect(value.props.numberOfLines).toBeUndefined();
    // 고를 수 없다(design-review M-3). 이 값은 길게 누르면 액션 시트가 열리는 행
    // 안에 있고, 그 행의 규칙은 「시트가 있으면 선택은 끈다」다 — 켜면 두 길게
    // 누르기가 다투고, 시트의 복사는 링크가 아니라 메시지 본문을 준다.
    expect(value.props.selectable).not.toBe(true);
    expect(within(card).queryByTestId(`${PREFIX}-approve`)).toBeNull();
  });

  it('복사하면 클립보드에 값이 들어가고, 라벨이 잠시 「복사됨」이 된다', async () => {
    jest.useFakeTimers();
    renderRow({
      gates: new Map(),
      receipts: new Map([
        [
          APPROVAL_ID,
          {note: '승인을 기록했어요.', status: 'approved', secretOnce: SECRET_ONCE},
        ],
      ]),
    });
    const copy = screen.getByTestId('card-approval-link-once-copy');
    expect(copy.props.accessibilityLabel).toBe('링크 복사하기');
    await act(async () => {
      fireEvent.press(copy);
    });
    expect(clipboard.value).toBe(SECRET);
    expect(within(copy).getByText('복사됨')).toBeTruthy();
    expect(
      screen.getByTestId('card-approval-link-once-copy').props.accessibilityLabel,
    ).toBe('링크 복사됨');
    // ADR-0182 D5: in-place 확인은 ≤1.6s 뒤 돌아온다.
    expect(COPY_RECEIPT_MS).toBeLessThanOrEqual(1_600);
    act(() => {
      jest.advanceTimersByTime(COPY_RECEIPT_MS);
    });
    expect(
      within(screen.getByTestId('card-approval-link-once-copy')).getByText('복사하기'),
    ).toBeTruthy();
  });

  it('VoiceOver 는 로터로 복사한다 — 행은 접근성 요소 하나라 카드 안 버튼에 닿지 못한다', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    renderRow({
      gates: new Map(),
      receipts: new Map([
        [
          APPROVAL_ID,
          {note: '승인을 기록했어요.', status: 'approved', secretOnce: SECRET_ONCE},
        ],
      ]),
    });
    const row = screen.getByTestId('message-row');
    // 행이 접근성 요소 하나라는 전제부터 잰다. 이것이 거짓이 되면 로터가 아니라
    // 버튼 자체가 답이고, 이 시험은 무엇을 지키는지 다시 물어야 한다.
    expect(row.props.accessible).toBe(true);
    const rotor = (row.props.accessibilityActions ?? []) as {
      name: string;
      label: string;
    }[];
    expect(rotor[0]).toEqual({name: 'momoCopyLinkOnce', label: '링크 복사하기'});
    await act(async () => {
      fireEvent(row, 'accessibilityAction', {
        nativeEvent: {actionName: 'momoCopyLinkOnce'},
      });
    });
    expect(clipboard.value).toBe(SECRET);
    expect(announce).toHaveBeenCalledWith('링크 복사됨');
    // 값 자체를 소리로 흘리지 않는다.
    expect(
      announce.mock.calls.some(([text]) => String(text).includes(SECRET)),
    ).toBe(false);
  });

  it('링크가 없는 카드에는 그 로터 항목도 없다', () => {
    renderRow({
      gates: new Map(),
      receipts: new Map([[APPROVAL_ID, {note: '거부를 기록했어요.', status: 'rejected'}]]),
    });
    const rotor = (screen.getByTestId('message-row').props.accessibilityActions ??
      []) as {name: string}[];
    expect(rotor.map(action => action.name)).not.toContain('momoCopyLinkOnce');
  });

  it('값이 없는 영수증(거부·다른 데서 결정)에는 링크가 서지 않는다', () => {
    renderRow({
      gates: new Map(),
      receipts: new Map([[APPROVAL_ID, {note: '거부를 기록했어요.', status: 'rejected'}]]),
    });
    expect(screen.queryByTestId('card-approval-link-once')).toBeNull();
    expect(renderedText()).not.toContain(SECRET);
  });

  it('`linkOnceFrom` — 방금 이 기기에서 승인으로 기록된 결정에만 값이 있다', () => {
    const result = {
      actionId: 'invite.create',
      ref: null,
      secretOnce: SECRET_ONCE,
    };
    expect(
      linkOnceFrom({kind: 'committed', status: 'approved', result})?.value,
    ).toBe(SECRET);
    // 방향은 원장이 답한 것으로 판정한다. 상태가 없거나 거부면 없다.
    expect(linkOnceFrom({kind: 'committed', result})).toBeUndefined();
    expect(
      linkOnceFrom({kind: 'committed', status: 'rejected', result}),
    ).toBeUndefined();
    // 다른 데서 이미 결정된 것을 따라잡은 영수증은 그 사람의 링크가 아니다.
    expect(
      linkOnceFrom({kind: 'superseded', status: 'approved', result}),
    ).toBeUndefined();
    expect(linkOnceFrom({kind: 'error', errorCopy: 'x'})).toBeUndefined();
  });
});

// =============================================================================
describe('#2513 — 영속 결과 카드 (부록 B)', () => {
  function renderResult(over: Record<string, unknown> = {}) {
    return renderRow({message: resultMessage(appendixB(over)), gates: new Map()});
  }

  it('행 · 결정한 사람 · 상태 문장 · 1회 고지를 그린다', () => {
    renderResult();
    const rows = screen.getAllByTestId('action-result-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('역할')).toBeTruthy();
    expect(within(rows[0]).getByText('member')).toBeTruthy();
    expect(
      within(screen.getByTestId('action-result-decided-by')).getByText('곽성재'),
    ).toBeTruthy();
    expect(screen.getByTestId('action-result-note').props.children).toBe(
      '실행을 마쳤어요.',
    );
    expect(screen.getByTestId('action-result-secret-once').props.children).toBe(
      ACTION_RESULT_SECRET_ONCE_NOTE,
    );
  });

  it('「멤버와 초대에서 보기」는 문이 아니라 할 일과 자리를 말하는 문장이다 (폰에 화면이 없다)', () => {
    renderResult();
    const elsewhere = screen.getByTestId('action-result-elsewhere');
    // 이 앱의 다른 「여기서는 못 한다」 문장과 같은 모양 — 할 일을 이름으로, 자리로
    // 끝난다(design-review M-4). 서버의 버튼 캡션을 옮겨 붙이지 않는다.
    expect(elsewhere.props.children).toBe(
      '링크 목록 확인과 새 링크 만들기는 데스크톱이나 웹에서 할 수 있습니다.',
    );
    expect(elsewhere.props.children).not.toContain('에서 보기');
    // 누를 것이 아니다 — 없는 방으로 가는 버튼을 세우지 않는다.
    expect(
      within(screen.getByTestId('agent-card')).queryAllByRole('button'),
    ).toHaveLength(0);
  });

  it('목적지는 알아도 할 일을 모르는 행동에는 문장이 없다', () => {
    // `webhook.create` 는 코어 표가 목적지를 안다. 그러나 이 빌드는 그 행동 뒤에
    // 사람이 할 일을 문장으로 모른다 — 모르는 채 「데스크톱에서 하세요」라고
    // 말하지 않는다.
    renderResult({
      action_id: 'webhook.create',
      next: {label: '설정 › 웹훅에서 보기', href: '/settings?section=webhooks'},
    });
    expect(screen.queryByTestId('action-result-elsewhere')).toBeNull();
    expect(screen.getByTestId('action-result-note')).toBeTruthy();
  });

  it('모르는 목적지(부록 B 원문 `section=invites`)에는 그 문장도 서지 않는다 — 웹 R1 H1', () => {
    renderResult({
      next: {label: '설정 › 초대에서 보기', href: '/settings?section=invites'},
    });
    expect(screen.queryByTestId('action-result-elsewhere')).toBeNull();
    // 카드는 말을 잃지 않는다.
    expect(screen.getByTestId('action-result-note')).toBeTruthy();
    expect(screen.getByTestId('action-result-secret-once')).toBeTruthy();
  });

  it('네 상태가 각자의 칩과 문장을 세운다', () => {
    for (const status of [
      'executed',
      'rejected',
      'expired',
      'role_required',
    ] as ActionResultStatus[]) {
      const view = renderResult({status, secret_shown_once: false});
      const card = view.getByTestId('agent-card');
      expect(within(card).getByText(ACTION_RESULT_STATUS_LABEL[status])).toBeTruthy();
      expect(view.getByTestId('action-result-note').props.children).toBe(
        ACTION_RESULT_STATUS_NOTE[status],
      );
      expect(view.queryByTestId('action-result-secret-once')).toBeNull();
      view.unmount();
    }
  });

  it('카드에는 링크 값이 없다 — 사실과 길 하나뿐이다 (D4)', () => {
    renderResult();
    expect(renderedText()).not.toContain(SECRET);
    expect(renderedText()).not.toContain('code=');
  });

  it('모르는 판은 결과 카드가 아니라 도구 결과로 떨어진다 (본문 폴백)', () => {
    renderResult({v: 2});
    expect(screen.queryByTestId('action-result-note')).toBeNull();
    expect(screen.getByTestId('agent-card')).toBeTruthy();
  });
});

// =============================================================================
// 모델 소비 단일점 — 사보타주 ③ 이 여기서 빨개진다
// =============================================================================
describe('모델 소비 단일점 — 폰은 코어가 읽어 준 모델만 그린다', () => {
  it('승인 카드: 모델을 바꿔치기하면 화면이 **바꾼 값**을 그린다', () => {
    mockCardTransform = card =>
      card.kind === 'approval' && card.action !== null
        ? {
            ...card,
            action: {
              ...card.action,
              rows: card.action.rows.map(row => ({
                label: row.label,
                value: `모델:${row.value}`,
              })),
              rationale: '모델:사유',
              requiredRole: 'owner',
            },
          }
        : card;
    renderRow({});
    const values = screen
      .getAllByTestId('approval-action-row')
      .map(row => within(row).getAllByText(/.+/)[1].props.children);
    expect(values).toEqual(['모델:member', '모델:1회', '모델:7일']);
    expect(screen.getByText('모델:사유')).toBeTruthy();
    // props 원문(`required_role: admin`)이 아니라 모델의 역할이 문장이 된다.
    expect(screen.getByText('소유자만 승인할 수 있어요.')).toBeTruthy();
    expect(screen.queryByText('관리자만 승인할 수 있어요.')).toBeNull();
    // props 원문 그대로의 값은 어디에도 서지 않는다.
    expect(screen.queryByText('member')).toBeNull();
    expect(screen.queryByText('새 팀원 온보딩 요청')).toBeNull();
  });

  it('결과 카드: 상태·행·1회 고지가 모델에서 온다', () => {
    mockCardTransform = card =>
      card.kind === 'action_result'
        ? {
            ...card,
            status: 'expired',
            rows: card.rows.map(row => ({label: row.label, value: `모델:${row.value}`})),
            secretShownOnce: true,
          }
        : card;
    renderRow({
      message: resultMessage(appendixB({secret_shown_once: false})),
      gates: new Map(),
    });
    expect(screen.getByText(ACTION_RESULT_STATUS_LABEL.expired)).toBeTruthy();
    expect(screen.getByTestId('action-result-note').props.children).toBe(
      ACTION_RESULT_STATUS_NOTE.expired,
    );
    expect(screen.getByText('모델:member')).toBeTruthy();
    expect(screen.queryByText('member')).toBeNull();
    expect(screen.getByTestId('action-result-secret-once')).toBeTruthy();
  });

  it('폰 소스에는 메시지 props 를 스스로 읽는 코드가 0줄이다', () => {
    const SRC = path.resolve(__dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(50);
    // 부록 A·B 의 **전송 표기**(snake_case 키·네임스페이스)와 props 멤버 접근.
    // 모델의 이름(camelCase)은 여기 걸리지 않는다 — 그것을 읽는 것이 옳은 모양이다.
    const RAW = [
      // `message.props` 에 손대는 자리. 전개(`{...props}`)는 컴포넌트 props 라 뺀다.
      /(?<!\.\.)\.props\b/,
      /\bprops\s*(?:\?\.|\.|\[)/,
      /momo\.action_result/,
      /\brequired_role\b/,
      /\bsecret_shown_once\b/,
      /\baction_id\b/,
      /\bdecided_by\b/,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      for (const pattern of RAW) {
        if (pattern.test(code)) {
          offenders.push(`${path.relative(SRC, file)} ~ ${pattern.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// 화면 수준 — 결정 → 링크 1회 → 재진입·새로고침 뒤 사라짐 (D4) · 사보타주 ② 자리
// =============================================================================

interface ServerState {
  /** 결정이 기록됐는가. 기록되면 원장·메시지가 서버의 새 사실을 답한다. */
  decided: boolean;
}

function installServer(decision: (state: ServerState) => Response): ServerState {
  const state: ServerState = {decided: false};
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/decision') && init?.method === 'POST') {
      return decision(state);
    }
    if (target.includes('/approvals')) {
      return jsonResponse(200, {
        approvals: state.decided
          ? []
          : [
              {
                id: APPROVAL_ID,
                workspaceId: WS,
                runId: 'run-1',
                channelId: GENERAL,
                requestedBy: HERMES,
                actionType: 'workspace_action',
                status: 'pending',
                expiresAtMs: BASE_MS + 600_000,
                createdAtMs: BASE_MS,
              },
            ],
      });
    }
    if (target.includes(`/channels/${OTHER}/messages`)) {
      return jsonResponse(200, {messages: []});
    }
    if (target.includes('/messages')) {
      // 결정 뒤의 서버: 승인 카드 props 가 패치되고(decided), 에이전트 명의
      // 결과 메시지가 붙는다(부록 B). 어느 쪽에도 값은 없다 — 서버가 그렇게 한다.
      const messages = state.decided
        ? [
            approvalMessage(
              appendixA({
                approval_status: 'approved',
                decided_by: SELF_ID,
                decided_at_ms: BASE_MS + 60_000,
              }),
            ),
            resultMessage(),
          ]
        : [approvalMessage()];
      return jsonResponse(200, {messages});
    }
    if (target.includes('/reactions')) return jsonResponse(200, {});
    if (target.includes('/channels')) {
      return jsonResponse(200, {
        channels: [
          {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
          {id: OTHER, workspaceId: WS, kind: 'public', name: 'random', muted: false},
        ],
      });
    }
    if (target.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (target.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (target.includes('/agent-runs') || target.includes('/runs')) {
      return jsonResponse(200, {runs: []});
    }
    if (target.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (target.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    throw new Error(`unrouted request: ${target}`);
  }) as unknown as typeof fetch;
  return state;
}

let shellClient: QueryClient | null = null;

function mountShell() {
  shellClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={shellClient}>
      <AppShell member={ME} />
    </QueryClientProvider>,
  );
}

const SETTLE = {timeout: 10_000};
jest.setTimeout(30_000);

async function openGeneral(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy(), SETTLE);
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  await waitFor(
    () => expect(screen.getByTestId('conversation-title')).toBeTruthy(),
    SETTLE,
  );
}

/** 이 프로세스가 값을 둘 수 있었던 모든 자리. 하나라도 값을 들면 D4 위반이다. */
function persistedPlaces(consoleCalls: unknown[][]): string {
  return JSON.stringify({
    mmkv: [...mmkvStore.entries()],
    keychain: [...keychainItems.values()],
    queryCache: shellClient?.getQueryCache().getAll().map(query => query.state.data),
    console: consoleCalls,
  });
}

describe('D4 — 1회 링크는 폰 메모리에만 있고, 다시 열면 사라진다', () => {
  /**
   * 콘솔로 나간 모든 인자. 스파이는 **흘려보낸다**(원래 출력도 그대로 간다) —
   * 삼키면 이 시험이 실패할 때 그 이유까지 삼킨다.
   */
  let consoleSpies: jest.SpyInstance[] = [];
  const consoleCalls = (): unknown[][] =>
    consoleSpies.flatMap(spy => spy.mock.calls as unknown[][]);

  beforeEach(() => {
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      method => jest.spyOn(console, method),
    );
  });

  it('승인하면 링크가 한 번 서고, 어디에도 적히지 않으며, 재진입·새로고침 뒤 사라진다', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const server = installServer(state => {
      state.decided = true;
      return jsonResponse(200, APPENDIX_C);
    });
    const firstLaunch = mountShell();
    await openGeneral();

    // ① 타임라인 카드에서 바로 결정한다.
    await waitFor(
      () => expect(screen.getByTestId(`${PREFIX}-approve`)).toBeTruthy(),
      SETTLE,
    );
    expect(screen.getAllByTestId('approval-action-row')).toHaveLength(3);
    await act(async () => {
      fireEvent.press(screen.getByTestId(`${PREFIX}-approve`));
    });

    // ② 영수증 자리에 링크가 **한 번** 선다.
    const value = await screen.findByTestId('card-approval-link-once-value', {}, SETTLE);
    expect(value.props.children).toBe(SECRET);
    // 아래의 「0회」 단정들이 헛초록이 아니려면 같은 자가 **있을 때는 본다**는
    // 것부터 재야 한다.
    expect(renderedText()).toContain(SECRET);
    expect(screen.getByTestId('card-approval-receipt').props.children).toBe(
      '승인을 기록했어요.',
    );
    expect(announce).toHaveBeenCalledWith(`승인을 기록했어요. ${LINK_ONCE_LEAD}`);
    // 원장을 다시 읽어 컨트롤은 사라졌지만 영수증과 링크는 남는다.
    await waitFor(
      () => expect(screen.queryByTestId(`${PREFIX}-approve`)).toBeNull(),
      SETTLE,
    );
    expect(screen.getByTestId('card-approval-link-once-value').props.children).toBe(
      SECRET,
    );

    // ③ 복사는 클립보드로 — 사람이 옮기는 유일한 길.
    await act(async () => {
      fireEvent.press(screen.getByTestId('card-approval-link-once-copy'));
    });
    expect(clipboard.value).toBe(SECRET);

    // ④ 이 프로세스가 값을 적을 수 있었던 모든 자리에 값이 **0회**다.
    //    먼저 있었다는 것을 잰 뒤에(②) 없다는 것을 잰다.
    expect(persistedPlaces(consoleCalls())).not.toContain(SECRET);
    expect(persistedPlaces(consoleCalls())).not.toContain('Ab3-_xQ7');

    // ⑤ 재진입: 대화를 닫고 다시 연다. 서버는 이제 패치된 승인 카드와 결과
    //    카드를 답하고, 어느 쪽에도 값이 없다. 화면에도 없어야 한다.
    fireEvent.press(screen.getByTestId('header-back'));
    await waitFor(
      () => expect(screen.queryByTestId('conversation-title')).toBeNull(),
      SETTLE,
    );
    expect(renderedText()).not.toContain(SECRET);
    await openGeneral();
    await screen.findByTestId('action-result-secret-once', {}, SETTLE);
    expect(screen.queryByTestId('card-approval-link-once')).toBeNull();
    expect(renderedText()).not.toContain(SECRET);
    expect(screen.getByText('승인됨')).toBeTruthy();
    expect(screen.getByTestId('action-result-note').props.children).toBe(
      '실행을 마쳤어요.',
    );

    // ⑥ 새로고침: 앱을 통째로 내렸다 다시 띄운다(새 쿼리 클라이언트, 같은 디스크).
    //    디스크(MMKV·키체인)가 값을 들고 있었다면 여기서 되살아난다.
    //    `cleanup()` 이 아니라 `unmount()` 다 — 앞의 것 뒤에 셸을 다시 그리면 RNTL
    //    이 새 렌더러를 곧바로 내린다(실측, 이 파일 밖 재현에서도 같다).
    firstLaunch.unmount();
    shellClient?.clear();
    mountShell();
    await openGeneral();
    await screen.findByTestId('action-result-secret-once', {}, SETTLE);
    expect(screen.queryByTestId('card-approval-link-once')).toBeNull();
    expect(renderedText()).not.toContain(SECRET);
    expect(persistedPlaces(consoleCalls())).not.toContain(SECRET);
    expect(server.decided).toBe(true);
  });

  it('대화를 닫지 않고 다른 방으로 옮겼다 돌아와도 링크는 없다 — 재진입은 경로와 무관하다', async () => {
    // 셸은 대화를 닫지 않고 **바꾸기도** 한다(`onOpenConversation` — 프로필의 DM
    // 열기, ADE 카드). 그때 화면은 언마운트되지 않고 `channelId` 만 바뀌므로, 표를
    // 비우는 자리가 따로 없으면 A 의 링크가 B 를 거쳐 A 로 돌아왔을 때 다시 선다.
    installServer(state => {
      state.decided = true;
      return jsonResponse(200, APPENDIX_C);
    });
    shellClient = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}},
    });
    const tree = (channelId: string) => (
      <QueryClientProvider client={shellClient as QueryClient}>
        <SessionProvider member={ME}>
          <PushProvider>
            <RealtimeProvider>
              <ConversationScreen
                channelId={channelId}
                title={channelId === GENERAL ? 'general' : 'random'}
                onBack={() => {}}
              />
            </RealtimeProvider>
          </PushProvider>
        </SessionProvider>
      </QueryClientProvider>
    );
    const view = render(tree(GENERAL));
    await waitFor(
      () => expect(screen.getByTestId(`${PREFIX}-approve`)).toBeTruthy(),
      SETTLE,
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId(`${PREFIX}-approve`));
    });
    await screen.findByTestId('card-approval-link-once-value', {}, SETTLE);
    expect(renderedText()).toContain(SECRET);

    // 같은 화면 인스턴스가 다른 방을 그린다(언마운트 없음).
    view.rerender(tree(OTHER));
    await waitFor(
      () => expect(screen.queryByTestId('agent-card')).toBeNull(),
      SETTLE,
    );
    // 그리고 돌아온다.
    view.rerender(tree(GENERAL));
    await screen.findByTestId('action-result-secret-once', {}, SETTLE);
    expect(screen.queryByTestId('card-approval-link-once')).toBeNull();
    expect(renderedText()).not.toContain(SECRET);
  });

  it('AsyncStorage 는 이 앱에 없다 — 값을 쓸 네 번째 저장소가 존재하지 않는다', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
    ) as {dependencies: Record<string, string>};
    expect(
      Object.keys(pkg.dependencies).filter(name => /async-storage/i.test(name)),
    ).toEqual([]);
  });
});

// =============================================================================
// #4705 — 「전문 보기」는 화면의 앵커 열기를 탄다 (ADE 카드의 「대화로」와 같은 기계)
//
// 가짜는 `fetch` 하나뿐이다. 타임라인·채널 목록·셸·점프 기계는 전부 진짜이고, 그래서 이 단정들은
// 「호출했는가」가 아니라 **화면이 무엇을 받았는가**에 대한 것이다. 링크가 새 길을 만들지 않고 이미
// 있는 점프를 탄다는 것(같은 방은 방을 다시 열지 않고, 다른 방은 셸이 열고, 못 찾으면 자기 낱말로
// 말한다)이 이 묶음의 주장이다.
// =============================================================================

const PIN_TARGET_TEXT = '이번 주 배포 순서는 이 글이 정본이에요.';
const OTHER_CHANNEL_WIRE = {
  id: OTHER,
  workspaceId: WS,
  kind: 'public',
  name: 'random',
  muted: false,
};

function pinTargetMessage(channelId: string): Message {
  return {
    id: PIN_MESSAGE,
    channelId,
    seq: 3,
    hlcTs: 3,
    hlcCount: 0,
    authorMemberId: SELF_ID,
    type: 'text',
    body: PIN_TARGET_TEXT,
    state: 'sent',
    createdAtMs: BASE_MS - 60_000,
  } as unknown as Message;
}

/** GENERAL 의 먼저 제안 카드. 가리키는 메시지는 `targetChannelId` 방에 있다. */
function pinCardIn(targetChannelId: string): Message {
  const props = pinProps();
  (props.action as {preview: Record<string, unknown>}).preview.channelId = targetChannelId;
  return pinMessage(props);
}

function installPinServer(pages: Record<string, Message[]>): void {
  globalThis.fetch = jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/approvals')) {
      return jsonResponse(200, {
        approvals: [
          {
            id: APPROVAL_ID,
            workspaceId: WS,
            runId: 'run-1',
            channelId: GENERAL,
            requestedBy: PLANNER_ID,
            actionType: 'workspace_action',
            status: 'pending',
            expiresAtMs: BASE_MS + 600_000,
            createdAtMs: BASE_MS,
          },
        ],
      });
    }
    if (target.includes('/messages')) {
      const channel = target.includes(`/channels/${OTHER}/`) ? OTHER : GENERAL;
      return jsonResponse(200, {messages: pages[channel] ?? []});
    }
    if (target.includes('/reactions')) return jsonResponse(200, {});
    if (target.includes('/channels')) {
      return jsonResponse(200, {
        channels: [
          {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
          OTHER_CHANNEL_WIRE,
        ],
      });
    }
    if (target.includes('/roster')) return jsonResponse(200, {members: PIN_ROSTER});
    if (target.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (target.includes('/agent-runs') || target.includes('/runs')) {
      return jsonResponse(200, {runs: []});
    }
    if (target.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (target.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    throw new Error(`unrouted request: ${target}`);
  }) as unknown as typeof fetch;
}

/** 화면이 목록에 건 점프. `Timeline` 이 받는 프롭을 그대로 읽는다(`anchorJump.test` 와 같은 자). */
function jumpTargetOf(): {messageId: string; seq: number | null} | null {
  const nodes = screen.UNSAFE_root.findAll(
    (node: {props?: Record<string, unknown>}) => node.props?.jumpTarget !== undefined,
  );
  return (nodes[0]?.props?.jumpTarget as {messageId: string; seq: number | null}) ?? null;
}

/** 대화 화면 하나(셸 없이). `onOpenConversation` 이 있어야 「전문 보기」가 선다. */
function mountConversation(onOpenConversation: (channelId: string, title: string) => void) {
  shellClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={shellClient}>
      <SessionProvider member={ME}>
        <PushProvider>
          <RealtimeProvider>
            <ConversationScreen
              channelId={GENERAL}
              title="general"
              onBack={() => {}}
              onOpenConversation={onOpenConversation}
            />
          </RealtimeProvider>
        </PushProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('#4705 — 「전문 보기」는 화면의 앵커 점프를 탄다', () => {
  it('같은 방의 메시지면 방을 다시 열지 않고 그 메시지로 점프한다', async () => {
    installPinServer({[GENERAL]: [pinTargetMessage(GENERAL), pinCardIn(GENERAL)]});
    const onOpenConversation = jest.fn();
    mountConversation(onOpenConversation);
    const link = await screen.findByTestId('approval-message-preview-link', {}, SETTLE);
    await act(async () => {
      fireEvent.press(link);
    });
    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe(PIN_MESSAGE), SETTLE);
    // 이미 그 방이다 — 셸에 같은 대화를 한 번 더 밀지 않는다.
    expect(onOpenConversation).not.toHaveBeenCalled();
    expect(screen.queryByTestId('jump-missed')).toBeNull();
  });

  it('불러온 목록에 그 메시지가 없으면 「카드가 가리킨 메시지」라고 말한다 — 남의 낱말이 아니라', async () => {
    installPinServer({[GENERAL]: [pinCardIn(GENERAL)]});
    mountConversation(jest.fn());
    const link = await screen.findByTestId('approval-message-preview-link', {}, SETTLE);
    await act(async () => {
      fireEvent.press(link);
    });
    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy(), SETTLE);
    const notice = jumpMissedNotice('unknown', 'approval');
    expect(screen.getByTestId('jump-missed')).toHaveTextContent(notice.headline, {exact: false});
    // ADE 카드의 「이 작업을 시작한 메시지」 주어를 빌려 말하지 않는다.
    expect(notice.headline).not.toBe(jumpMissedNotice('unknown', 'session').headline);
  });

  it('다른 방의 메시지면 셸이 그 방(이름은 명부에서 푼다)을 열고 그 메시지로 점프한다', async () => {
    installPinServer({
      [GENERAL]: [pinCardIn(OTHER)],
      [OTHER]: [pinTargetMessage(OTHER)],
    });
    mountShell();
    await openGeneral();
    const link = await screen.findByTestId('approval-message-preview-link', {}, SETTLE);
    await act(async () => {
      fireEvent.press(link);
    });
    await waitFor(
      () =>
        expect(screen.getByTestId('conversation-title')).toHaveTextContent(
          channelLabel(OTHER_CHANNEL_WIRE as unknown as Channel, PIN_DIRECTORY, SELF_ID),
        ),
      SETTLE,
    );
    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe(PIN_MESSAGE), SETTLE);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
  });
});

// =============================================================================
describe('두 클라가 같은 문장을 든다', () => {
  it('1회 링크 리드는 웹이 든 글자와 같다 (코어 승격분 대조)', () => {
    const web = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../web/src/features/timeline/ApprovalActions.tsx',
      ),
      'utf8',
    );
    const found = /export const LINK_ONCE_LEAD\s*=\s*"([^"]+)"/.exec(web);
    if (found === null) {
      // 웹이 코어를 import 하게 되면 이 대조는 할 일을 잃는다 — 그때 지울 것.
      throw new Error(
        '웹의 LINK_ONCE_LEAD 글자를 찾지 못했다. 웹이 코어 상수를 쓰게 됐다면 이 ' +
          '대조를 지우고, 아니라면 정규식을 고칠 것 — 못 찾은 채 초록이면 없는 것과 같다',
      );
    }
    expect(found[1]).toBe(LINK_ONCE_LEAD);
  });
});
