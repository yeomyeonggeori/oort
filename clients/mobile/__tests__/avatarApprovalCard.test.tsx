import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  __resetMemberAvatarCache,
  clearMemberAvatarCache,
  loadMemberAvatar,
  memberAvatarCacheKey,
  peekMemberAvatar,
} from '../src/features/conversation/memberAvatarImage';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {SessionProvider} from '../src/session/useSession';
import {__resetSessionStore, sessionPort, replacePersistedMember} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import type {ApprovalGate} from '../src/features/conversation/approvalGate';

// =============================================================================
// #4394 — 폰 승인 카드: 「내 프로필 사진 바꾸기」(`member.avatar.set`, ADR-0186 증보 v4)
//
// 픽스처는 서버 계약 그대로다(#4385 PR #4398 의 카드 props). 이 트리에는 서버가 없어서
// **runtime-unverified** 다 — 서버가 실제로 이 모양을 보내는지는 #4385 랜딩 뒤 실샘플로
// 갈아 끼운다. 이름·핸들은 가상 인물이다. 웹의 같은 시험:
// `clients/web/src/features/timeline/avatarApprovalCard.test.tsx`.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'ch-general';
const APPROVAL_ID = '0199aa11-2222-7000-8000-0000000000a1';
const SHA = 'ab'.repeat(32);
const PREVIEW_PATH = `/v1/workspaces/${WS}/approvals/${APPROVAL_ID}/avatar-preview?v=${SHA}`;
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;

function avatarProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approval_id: APPROVAL_ID,
    run_id: '0199aa11-2222-7000-8000-0000000000b2',
    channel_id: GENERAL,
    action_type: 'workspace_action',
    status: 'pending',
    expires_at_ms: 0,
    title: '내 프로필 사진 바꾸기',
    summary:
      '내가 이 대화에 보낸 사진으로 내 프로필 사진을 바꿔요. 대상은 말을 건 본인뿐이고, 본인만 승인할 수 있어요.',
    action: {
      id: 'member.avatar.set',
      rows: [
        {label: '대상', value: '이도현 (@dohyun)'},
        {label: '프로필 사진', value: '없음 → 새 이미지'},
        {label: '사진 출처', value: '내가 이 대화에 보낸 첨부'},
      ],
      required_role: 'requesting_member',
      preview: {
        kind: 'avatar_image',
        imageId: '11111111-1111-4111-8111-111111111111',
        sha256: SHA,
        mime: 'image/png',
        width: 512,
        height: 384,
        sizeBytes: 48213,
        origin: 'attachment',
      },
    },
    ...over,
  };
}

function approvalMessage(props: Record<string, unknown>): Message {
  return {
    id: '0199aa11-2222-7000-8000-0000000000d1',
    channelId: GENERAL,
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: 'approval_request',
    body: '승인 요청: 내 프로필 사진 바꾸기',
    state: 'sent',
    createdAtMs: BASE_MS,
    props,
  } as unknown as Message;
}

function resultMessage(status: string): Message {
  return {
    id: '0199aa11-2222-7000-8000-0000000000d2',
    channelId: GENERAL,
    seq: 11,
    hlcTs: 11,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: 'tool_result',
    body: '프로필 사진을 바꿨어요',
    state: 'sent',
    createdAtMs: BASE_MS + 1000,
    props: {
      'momo.action_result': {
        v: 1,
        action_id: 'member.avatar.set',
        status,
        approval_id: APPROVAL_ID,
        decided_by: SELF_ID,
        ref: {type: 'member', id: SELF_ID},
        rows: [{label: '프로필 사진', value: '카드에 보인 이미지로 바뀌었어요'}],
        secret_shown_once: false,
      },
    },
  } as unknown as Message;
}

function rosterMember(id: string): RosterMember {
  const agent = id === AGENT;
  return {
    id,
    workspaceId: WS,
    kind: agent ? 'agent' : 'human',
    status: 'active',
    displayName: agent ? '달무리봇' : '이도현',
    handle: agent ? 'dalmuri' : 'dohyun',
    channelCount: 1,
    channelIds: [GENERAL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([rosterMember(SELF_ID), rosterMember(AGENT)]);
const ME: Member = {id: SELF_ID, workspaceId: WS, kind: 'human', displayName: '이도현', handle: 'dohyun'};
const GATE: ApprovalGate = {approvalId: APPROVAL_ID, reversible: false, expiresAtMs: null};

const fsMock = jest.requireMock('expo-file-system') as {
  __files: Set<string>;
  __state: {
    downloads: {url: string; destination: {uri: string}; options: {headers?: Record<string, string>}}[];
    failures: Error[];
  };
  __reset: () => void;
};
const downloads = () => fsMock.__state.downloads;

beforeEach(() => {
  __resetMemberAvatarCache();
  __resetSessionStore();
  __resetServerBaseCache();
  fsMock.__reset();
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
  fsMock.__reset();
});

function renderRow(message: Message) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={ME}>
        <MessageRow
          message={message}
          startsGroup
          directory={DIRECTORY}
          chips={[]}
          nowMs={BASE_MS}
          approvalGates={new Map([[APPROVAL_ID, GATE]])}
          approvalsProvided
          onApprovalSettled={() => {}}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('#4394 — member.avatar.set 승인 카드 (폰)', () => {
  it('한 문장과 제안된 사진을 서버 행 아래·버튼 위에 그린다 — 베어러로 받은 file:// 이미지', async () => {
    renderRow(approvalMessage(avatarProps()));
    expect(screen.getByTestId('approval-avatar-headline').props.children).toBe(
      '달무리봇이 내 프로필 사진을 이 사진으로 바꾸려고 해요',
    );
    const image = await screen.findByTestId('approval-avatar-image');
    expect(String(image.props.source.uri).startsWith('file://')).toBe(true);
    expect(screen.getByTestId('approval-avatar-caption').props.children).toContain('승인하면');

    // 정확히 이 승인·이 해시의 주소를 베어러와 함께 한 번.
    expect(downloads()).toHaveLength(1);
    expect(downloads()[0].url).toBe(`${BASE}${PREVIEW_PATH}`);
    expect(downloads()[0].options.headers).toEqual({Authorization: 'Bearer access-token-1'});

    // 서버 행은 그대로이고 승인·거부 버튼이 선다.
    const card = screen.getByTestId('agent-card');
    expect(within(card).getAllByTestId('approval-action-row')).toHaveLength(3);
    expect(within(card).getByTestId(`card-approval-${APPROVAL_ID}-approve`)).toBeTruthy();
  });

  it('결정 권한 줄은 관리자가 아니라 사진 주인 본인을 말한다', async () => {
    renderRow(approvalMessage(avatarProps()));
    await screen.findByTestId('approval-avatar-image');
    expect(screen.getByTestId('approval-action-role')).toHaveTextContent(/요청한 본인만 승인할 수 있어요\./);
    expect(JSON.stringify(screen.toJSON())).not.toContain('requesting_member');
  });

  it('본인이 아니라 서버가 404 를 주면 사진 자리가 본인만 볼 수 있다고 말한다', async () => {
    fsMock.__state.failures = [new Error('HTTP 404')];
    renderRow(approvalMessage(avatarProps()));
    await waitFor(() =>
      expect(screen.getByTestId('approval-avatar-caption').props.children).toBe(
        '이 사진은 요청한 본인만 볼 수 있어요.',
      ),
    );
    expect(screen.queryByTestId('approval-avatar-image')).toBeNull();
    // 폰은 주인을 추측하지 않는다 — 버튼은 서 있고 403 이 서버의 답이다.
    expect(screen.getByTestId(`card-approval-${APPROVAL_ID}-approve`)).toBeTruthy();
  });

  it('미리보기 블록이 어긋난 카드는 사진을 요청하지 않는다', async () => {
    const props = avatarProps();
    (props.action as Record<string, unknown>).preview = {kind: 'avatar_image', sha256: 'nope'};
    renderRow(approvalMessage(props));
    expect(downloads()).toHaveLength(0);
    expect(screen.getByTestId('approval-avatar-caption').props.children).toContain('본인만');
  });

  it('결정이 난 카드에는 사진 블록이 서지 않는다', () => {
    renderRow(approvalMessage(avatarProps({status: 'approved'})));
    expect(screen.queryByTestId('approval-avatar-preview')).toBeNull();
    expect(downloads()).toHaveLength(0);
  });

  it('다른 행동 카드에는 사진 블록이 붙지 않는다 (회귀 0)', () => {
    const props = avatarProps();
    (props.action as Record<string, unknown>).id = 'agent.rename';
    renderRow(approvalMessage(props));
    expect(screen.queryByTestId('approval-avatar-preview')).toBeNull();
    expect(downloads()).toHaveLength(0);
  });

  it('승인 미리보기 경로 밖의 주소에는 베어러를 싣지 않는다', async () => {
    for (const bad of [
      `/v1/workspaces/${WS}/approvals/${APPROVAL_ID}/avatar-preview`,
      `/v1/workspaces/${WS}/approvals/${APPROVAL_ID}/attachments/x?v=${SHA}`,
      `https://evil.example/v1/workspaces/${WS}/approvals/${APPROVAL_ID}/avatar-preview?v=${SHA}`,
    ]) {
      await expect(loadMemberAvatar(bad)).resolves.toBeNull();
    }
    expect(downloads()).toHaveLength(0);
  });
});

describe('#4394 — 계정 경계 (보안 검수)', () => {
  it('로그아웃 비우기는 승인 미리보기 사진도 지운다 — 다음 사람 기기에 앞 사람의 얼굴이 남지 않는다', async () => {
    const uri = await loadMemberAvatar(PREVIEW_PATH);
    expect(uri).not.toBeNull();
    expect(peekMemberAvatar(memberAvatarCacheKey(PREVIEW_PATH))).toBe(uri);

    clearMemberAvatarCache();

    expect(peekMemberAvatar(memberAvatarCacheKey(PREVIEW_PATH))).toBeNull();
    // 같은 경로는 서버에 다시 묻는다(본인이 아니면 서버가 404 를 준다).
    await loadMemberAvatar(PREVIEW_PATH);
    expect(downloads()).toHaveLength(2);
  });

  it('점 세그먼트가 낀 주소에는 베어러를 싣지 않는다', async () => {
    for (const bad of [
      `/v1/workspaces/${WS}/approvals/../avatar-preview?v=${SHA}`,
      `/v1/workspaces/${WS}/approvals/%2e%2e/avatar-preview?v=${SHA}`,
    ]) {
      await expect(loadMemberAvatar(bad)).resolves.toBeNull();
    }
    expect(downloads()).toHaveLength(0);
  });
});

describe('#4394 — member.avatar.set 결과 카드 (폰)', () => {
  it('권한이 모자란 결정은 관리자가 아니라 사진 주인 본인을 가리킨다', () => {
    renderRow(resultMessage('role_required'));
    expect(screen.getByText('사진 주인 본인이 승인해야 해요.')).toBeTruthy();
    expect(screen.queryByText('관리자가 승인해야 해요.')).toBeNull();
  });

  it('거부 줄은 프로필 사진이 그대로라고 말한다', () => {
    renderRow(resultMessage('rejected'));
    expect(screen.getByText('승인하지 않아 프로필 사진은 그대로예요.')).toBeTruthy();
  });

  it('실행됨은 기본 문장이다', () => {
    renderRow(resultMessage('executed'));
    expect(screen.getByText('실행을 마쳤어요.')).toBeTruthy();
  });
});

describe('#4791 — 이름과 에이전트 사진 승인', () => {
  it('내 이름 카드가 전후 글자와 본인 권한을 보여 준다', () => {
    const props = avatarProps({
      title: '내 이름 바꾸기',
      action: {
        id: 'member.display_name.set',
        required_role: 'requesting_member',
        rows: [
          { label: '바꾸기 전', value: '하늘' },
          { label: '바꾼 뒤', value: '별하늘' },
        ],
      },
    });
    renderRow(approvalMessage(props));
    expect(screen.getByText('바꾸기 전')).toBeTruthy();
    expect(screen.getByText('하늘')).toBeTruthy();
    expect(screen.getByText('바꾼 뒤')).toBeTruthy();
    expect(screen.getByText('별하늘')).toBeTruthy();
    expect(screen.getByTestId('approval-action-role')).toHaveTextContent(
      /요청한 본인만 승인할 수 있어요\./,
    );
    expect(screen.queryByTestId('approval-avatar-preview')).toBeNull();
  });

  it('에이전트 사진도 이전 사진과 제안 사진을 베어러로 읽어 그린다', async () => {
    const props = avatarProps();
    const action = props.action as Record<string, unknown>;
    action.id = 'agent.profile.update';
    action.required_role = 'agent_editor';
    const before = `/v1/workspaces/${WS}/members/${AGENT}/avatar/content?v=previous-image`;
    (action.preview as Record<string, unknown>).previousAvatarUrl = before;
    renderRow(approvalMessage(props));
    expect(await screen.findByLabelText('바꾸기 전 프로필 사진')).toBeTruthy();
    expect(
      await screen.findByLabelText('에이전트의 프로필 사진으로 제안된 사진'),
    ).toBeTruthy();
    expect(screen.getByText('바꾸기 전')).toBeTruthy();
    expect(screen.getByText('바꾼 뒤')).toBeTruthy();
    expect(downloads().some(row => row.url === `${BASE}${before}`)).toBe(true);
    expect(downloads()).toHaveLength(2);
    for (const row of downloads()) {
      expect(row.options.headers).toEqual({
        Authorization: 'Bearer access-token-1',
      });
    }
  });
});

describe('#4791 — 확정된 내 이름의 세션 반영', () => {
  it('서버에서 읽은 자기 프로필만 바꾸고 두 자격 증명은 그대로 둔다', () => {
    const before = sessionPort.getPersistedSession()!;
    const access = sessionPort.getAccessToken();
    replacePersistedMember({ ...before.member, displayName: '새 이름' });
    expect(sessionPort.getPersistedSession()?.member.displayName).toBe(
      '새 이름',
    );
    expect(sessionPort.getAccessToken()).toBe(access);
    expect(sessionPort.getRefreshToken()).toBe(before.refreshToken);
    replacePersistedMember({
      ...before.member,
      id: 'another-person',
      displayName: '다른 이름',
    });
    expect(sessionPort.getPersistedSession()?.member.displayName).toBe(
      '새 이름',
    );
  });
});
