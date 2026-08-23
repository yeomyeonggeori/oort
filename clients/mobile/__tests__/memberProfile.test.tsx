import type { Message, RosterMember } from '@momo/core/lib/api';
import { makeDirectory } from '@momo/core/features/workspace/directory';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import React from 'react';

import { AVATAR_SIZE } from '@momo/core/features/workspace/avatar';
import { line, slopTo, TOUCH_TARGET } from '../src/design/tokens';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import { MemberProfileSheet } from '../src/features/directory/MemberProfileSheet';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '김모모',
    handle: 'momo',
    role: 'member',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const SELF_MEMBER = member({
  id: SELF,
  displayName: '곽성재',
  handle: 'seongjae',
});
const HUMAN = member({ id: OTHER });
const AGENT_MEMBER = member({
  id: AGENT,
  kind: 'agent',
  displayName: '김인턴',
  handle: 'intern-kim',
  ownerHumanId: SELF,
});
const DIRECTORY = makeDirectory([SELF_MEMBER, HUMAN, AGENT_MEMBER]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '프로필을 엽니다.',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

function actions(over: Partial<MessageRowActions> = {}): MessageRowActions {
  return {
    myMemberId: SELF,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    ...over,
  };
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

function renderProfile(
  profileMember: RosterMember,
  over: Partial<React.ComponentProps<typeof MemberProfileSheet>> = {},
) {
  return render(
    <MemberProfileSheet
      member={profileMember}
      directory={makeDirectory([SELF_MEMBER, profileMember])}
      selfMemberId={SELF}
      online
      dmPending={false}
      dmError={null}
      onClose={jest.fn()}
      onOpenDm={jest.fn()}
      {...over}
    />,
  );
}

afterEach(cleanup);

describe('사람 프로필 시트', () => {
  it.each([
    ['active', '활성', true],
    ['invited', '초대됨', false],
    ['suspended', '정지됨', false],
    ['deleted', '삭제됨', false],
  ] as const)(
    '%s 상태를 숨기지 않고 DM 가능 여부와 맞춘다',
    (status, label, canDm) => {
      renderProfile(member({ id: OTHER, status }));
      expect(screen.getByTestId('profile-status').props.children).toBe(label);
      expect(screen.queryByTestId('profile-open-dm') !== null).toBe(canDm);
      expect(screen.queryByTestId('profile-dm-unavailable') !== null).toBe(
        !canDm,
      );
    },
  );

  it('이름·핸들·사람 구분과 실제 DM 액션을 한 시트에 둔다', () => {
    const onOpenDm = jest.fn();
    renderProfile(HUMAN, { onOpenDm });
    expect(screen.getByTestId('profile-name').props.children).toBe('김모모');
    expect(screen.getByTestId('profile-handle').props.children).toBe('@momo');
    expect(screen.getByTestId('profile-kind').props.children).toBe('사람');
    fireEvent.press(screen.getByTestId('profile-open-dm'));
    expect(onOpenDm).toHaveBeenCalledTimes(1);
  });

  it('에이전트는 기존 상세 화면의 문과 관리자 귀속을 얻는다', () => {
    const onOpenAgent = jest.fn();
    renderProfile(AGENT_MEMBER, {
      directory: DIRECTORY,
      onOpenAgent,
    });
    expect(screen.getByTestId('profile-kind').props.children).toBe('에이전트');
    expect(screen.getByText('곽성재님이 관리')).toBeTruthy();
    fireEvent.press(screen.getByTestId('profile-open-agent'));
    expect(onOpenAgent).toHaveBeenCalledTimes(1);
  });

  it('오프라인과 오류에는 죽은 DM 버튼 대신 이유·재시도를 둔다', () => {
    const onOpenDm = jest.fn();
    const view = renderProfile(HUMAN, { online: false, onOpenDm });
    expect(screen.queryByTestId('profile-open-dm')).toBeNull();
    expect(
      screen.getByText('오프라인에서는 대화를 열 수 없습니다.'),
    ).toBeTruthy();
    view.rerender(
      <MemberProfileSheet
        member={HUMAN}
        directory={DIRECTORY}
        selfMemberId={SELF}
        online
        dmPending={false}
        dmError={new Error('boom')}
        onClose={jest.fn()}
        onOpenDm={onOpenDm}
      />,
    );
    fireEvent.press(screen.getByTestId('profile-dm-error-retry'));
    expect(onOpenDm).toHaveBeenCalledTimes(1);
  });

  it('보이는 닫기와 주요 액션의 레이아웃 목표가 44pt다', () => {
    renderProfile(HUMAN);
    const close = flatten(
      screen.getByTestId('member-profile-close').props.style,
    );
    const dm = flatten(screen.getByTestId('profile-open-dm').props.style);
    expect(close.minHeight).toBe(TOUCH_TARGET);
    expect(close.minWidth).toBe(TOUCH_TARGET);
    expect(dm.minHeight).toBe(TOUCH_TARGET);
  });
});

describe('메시지 작성자 탭과 롱프레스', () => {
  it('아바타·작성자명이 같은 프로필을 열고 목표 크기는 44pt를 채운다', () => {
    const onOpenProfile = jest.fn();
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({ onOpenProfile })}
      />,
    );
    const avatar = screen.getByTestId('profile-avatar-target');
    const author = screen.getByTestId('profile-author-target');
    fireEvent.press(avatar);
    fireEvent.press(author);
    expect(onOpenProfile).toHaveBeenNthCalledWith(1, OTHER);
    expect(onOpenProfile).toHaveBeenNthCalledWith(2, OTHER);

    const avatarSlop = avatar.props.hitSlop.top;
    const authorSlop = author.props.hitSlop.top;
    expect(AVATAR_SIZE + avatarSlop * 2).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(line.head + authorSlop * 2).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(avatarSlop).toBe(slopTo(AVATAR_SIZE));
  });

  it('작성자명을 길게 누르면 프로필 탭이 아니라 기존 메시지 액션시트가 열린다', () => {
    const onOpenProfile = jest.fn();
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({ onOpenProfile })}
      />,
    );
    fireEvent(screen.getByTestId('message-row'), 'touchStart', {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    fireEvent(screen.getByTestId('profile-author-target'), 'longPress');
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('profile-author-target'));
    expect(onOpenProfile).not.toHaveBeenCalled();
  });
});
