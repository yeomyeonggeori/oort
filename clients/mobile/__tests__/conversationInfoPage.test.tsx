import {
  CHANNEL_COPY_GROUP_LABEL,
  CHANNEL_LEAVE_CONFIRM_TITLE,
  CHANNEL_LEAVE_LABEL,
  DM_CLOSE_LABEL,
  channelCopyIdLabel,
  channelCopyNameLabel,
  channelLeaveConfirmBody,
  channelMuteToggleLabel,
} from '@momo/core/features/channels/model';
import type {ChannelActionKey} from '@momo/core/features/channels/actionModel';
import {copyLinkActionLabel} from '@momo/core/features/timeline/copyLabels';
import type {StatusDot as PeerStatus} from '@momo/core/features/presence/statusDot';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {RosterMember} from '@momo/core/lib/api';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {Animated, Dimensions, Image, StyleSheet} from 'react-native';

import {SHEET_ICONS} from '../src/design/icons';
import {EASE_OUT, LAYER_POP_MS, LAYER_PUSH_MS} from '../src/design/motion';
import {FixedScheme} from '../src/design/theme';
import {TOUCH_TARGET} from '../src/design/tokens';
import {
  ConversationInfoPage,
  type ConversationInfoPageProps,
} from '../src/features/conversation/ConversationInfoPage';
import {
  CONVERSATION_INFO_ACTION_KEYS,
  conversationInfoActionItems,
} from '../src/features/conversation/conversationMenu';
import {PROFILE_FACE_SQUARE_RING_RADIUS} from '../src/features/profile/ProfileFace';
import type {ChannelRowTarget} from '../src/features/sidebar/channelRowActions';
import {finger, pane} from './fixtures/finger';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {releaseReduceMotion, setReduceMotion} from './fixtures/sheetContract';

// =============================================================================
// 대화·채널 정보 페이지 (#4319, owner 10-27 — 머리 가운데 이름·상태 알약이 여는 곳).
//
// 이 파일은 페이지 **하나**를 props 로 잰다(화면·서버·훅은 없다): 바깥틀(‹ 머리·층·닫는 길 셋), 히어로(사람·사진·에이전트·채널), 행(코어 표의 답을 그대로
// 그리는가), 나가기 확인 단계. 셸 안에서 끝까지(알약·⋮ → 페이지 → 서버 → 걷힘)는 `conversationMenuSheet.test.tsx` 가 잰다.
//
// 인물은 모두 가상이다(이도현·박서연·최민수, 에이전트 달무리 도우미, 회사 달무리 스튜디오).
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;
/** 1×1 PNG — `data:` 주소라 서버 주소·받기 없이 `Avatar` 가 이미지로 싣는다. */
const PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const flatten = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const HIDDEN = {includeHiddenElements: true} as const;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '최민수',
    handle: 'minsu',
    role: 'member',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const SELF_MEMBER = member({id: SELF, displayName: '이도현', handle: 'dohyun', role: 'owner'});
const HUMAN = member({id: OTHER, displayName: '박서연', handle: 'seoyeon'});
const AGENT_MEMBER = member({
  id: AGENT,
  kind: 'agent',
  displayName: '달무리 도우미',
  handle: 'dalmuri-helper',
  ownerHumanId: SELF,
});
const DIRECTORY = makeDirectory([SELF_MEMBER, HUMAN, AGENT_MEMBER]);

const channelTarget = (over: Partial<ChannelRowTarget> = {}): ChannelRowTarget => ({
  channel: {id: 'ch-general', kind: 'public', topic: ''},
  title: 'general',
  muted: false,
  selfRole: 'admin',
  readState: null,
  ...over,
});
const dmTarget = (over: Partial<ChannelRowTarget> = {}): ChannelRowTarget =>
  channelTarget({
    channel: {id: 'ch-dm', kind: 'dm', topic: ''},
    title: '박서연',
    selfRole: 'member',
    closeOffered: true,
    ...over,
  });

function pageProps(over: Partial<ConversationInfoPageProps> = {}): ConversationInfoPageProps {
  return {
    kind: 'dm',
    title: '박서연',
    directory: DIRECTORY,
    items: conversationInfoActionItems(dmTarget()),
    confirmingLeave: false,
    isPending: () => false,
    error: null,
    leave: {pending: false, error: null},
    onRun: jest.fn(),
    onConfirmLeave: jest.fn(),
    onCancelLeave: jest.fn(),
    onClose: jest.fn(),
    peer: HUMAN,
    status: null,
    nowMs: BASE_MS,
    ...over,
  };
}

/** 한 시험 안에서 다시 세우면 앞의 것을 **내리고** 세운다 — `cleanup()` 뒤에 `render()` 를 부르면 RNTL 이 새 렌더러를 곧바로 내린다. */
let mounted: ReturnType<typeof render> | null = null;
function renderPage(over: Partial<ConversationInfoPageProps> = {}): ConversationInfoPageProps {
  const props = pageProps(over);
  mounted?.unmount();
  mounted = render(
    <FixedScheme scheme="light">
      <ConversationInfoPage {...props} />
    </FixedScheme>,
  );
  return props;
}

afterEach(() => {
  cleanup();
  mounted = null;
  releaseReduceMotion();
});

/** 슬라이드 없이 바로 걷혀 ‹·escape 가 동기 단정이 된다. */
function motionOff() {
  beforeEach(async () => {
    await setReduceMotion(true);
  });
}

/** 페이지가 **그린 순서대로**의 행 이름(`conversation-info-` 뒤). */
const rowKeys = () =>
  screen
    .queryAllByTestId(/^conversation-info-(mute-toggle|copy-name|copy-link|copy-id|close-dm|leave|agent-open|owner)$/)
    .map(node => String(node.props.testID).replace('conversation-info-', ''));

// ---- 1. 바깥틀 ---------------------------------------------------------------

describe('정보 페이지 — 바깥틀: ‹ 머리 · 층 · 닫는 길 셋 (#4319)', () => {
  motionOff();

  it('머리는 ‹ 뒤로(「대화로 돌아가기」)이고 X 가 없다 — 대화 위에 쌓인 안쪽 장이다. 제목은 DM 「대화 정보」·채널 「채널 정보」', () => {
    renderPage();
    expect(screen.getByTestId('conversation-info-title')).toHaveTextContent('대화 정보');
    const back = screen.getByTestId('conversation-info-back');
    expect(back.props.accessibilityLabel).toBe('대화로 돌아가기');
    expect(back.props.accessibilityRole).toBe('button');
    // X(닫기)는 이 머리에 없다 — 한 머리에 나가는 문이 둘이면 어느 것이 어디로 가는지 모른다. 머리의 단추는 ‹ 하나다.
    const headerButtons = within(screen.getByTestId('conversation-info-header')).getAllByRole('button');
    expect(headerButtons.map(node => node.props.accessibilityLabel)).toEqual(['대화로 돌아가기']);
    renderPage({kind: 'public', title: 'general', items: conversationInfoActionItems(channelTarget()), peer: null});
    expect(screen.getByTestId('conversation-info-title')).toHaveTextContent('채널 정보');
    expect(screen.getByTestId('conversation-info-title').props.accessibilityRole).toBe('header');
  });

  it('층이다 — 밑의 대화를 VoiceOver 가 못 읽게 모달 경계이고, 대화를 덮는 한 겹이다', () => {
    renderPage();
    const layer = screen.getByTestId('conversation-info-pane');
    expect(layer.props.accessibilityViewIsModal).toBe(true);
    const frame = flatten(layer.props.style);
    expect([frame.position, frame.top, frame.left, frame.right, frame.bottom]).toEqual(['absolute', 0, 0, 0, 0]);
  });

  it('‹ 를 누르면 한 번 걷힌다', () => {
    const props = renderPage();
    fireEvent.press(screen.getByTestId('conversation-info-back'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('VoiceOver 두 손가락 문지르기(escape)도 한 번 걷는다', () => {
    const props = renderPage();
    act(() => {
      screen.getByTestId('conversation-info-page').props.onAccessibilityEscape();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('왼쪽 가장자리에서 오른쪽으로 밀면 걷힌다', async () => {
    const props = renderPage();
    const touch = finger(pane('conversation-info-pane'));
    touch.down(6, 400);
    touch.move(200, 400);
    touch.move(500, 400);
    touch.up();
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it('화면 한가운데에서 시작한 밀기는 걷지 않는다 — 가장자리에서만', () => {
    const props = renderPage();
    const touch = finger(pane('conversation-info-pane'));
    touch.down(200, 400);
    touch.move(300, 400);
    touch.move(500, 400);
    touch.up();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

// ---- 2. 히어로 -----------------------------------------------------------------

describe('정보 페이지 — 히어로 (#4319)', () => {
  motionOff();

  describe('DM — 사람', () => {
    it('큰 얼굴 · 이름 · 「@핸들 · 역할」', () => {
      renderPage();
      expect(screen.getByTestId('avatar-human', HIDDEN)).toBeTruthy();
      expect(screen.getByTestId('conversation-info-name')).toHaveTextContent('박서연');
      expect(screen.getByTestId('conversation-info-handle')).toHaveTextContent('@seoyeon');
      expect(screen.getByTestId('conversation-info-role')).toHaveTextContent('멤버');
    });

    it('상태 칩은 코어 판정의 낱말을 **전문 그대로** 말한다 — 머리 알약에는 줄어 서는 것이 여기서는 다 선다', () => {
      const status: PeerStatus = {tone: 'muted', label: '조용함 · 마지막 응답 5분 전'};
      renderPage({peer: AGENT_MEMBER, status, title: '달무리 도우미'});
      expect(screen.getByTestId('conversation-info-status')).toHaveTextContent('조용함 · 마지막 응답 5분 전');
      expect(screen.getByTestId('conversation-info-status').props.accessibilityLabel).toBe(
        '상태: 조용함 · 마지막 응답 5분 전',
      );
      expect(screen.getByTestId('conversation-info-status-dot', HIDDEN)).toBeTruthy();
    });

    it('상태를 모르면 칩이 없다 — 모르는 것을 짓지 않는다', () => {
      renderPage({status: null});
      expect(screen.queryByTestId('conversation-info-status')).toBeNull();
    });

    it('활성이 아닌 멤버는 멤버십 낱말이 먼저 말한다(「초대됨」) — 점은 없다', () => {
      renderPage({peer: member({...HUMAN, status: 'invited'}), status: {tone: 'ok', label: '응답함'}});
      expect(screen.getByTestId('conversation-info-status')).toHaveTextContent('초대됨');
      expect(screen.queryByTestId('conversation-info-status-dot', HIDDEN)).toBeNull();
    });

    it('한 줄 상태는 만료 전에만 선다', () => {
      const withStatus = member({
        ...HUMAN,
        statusEmoji: '📅',
        statusText: '회의 중',
        statusExpiresAtMs: BASE_MS + 60_000,
      });
      renderPage({peer: withStatus});
      expect(screen.getByTestId('conversation-info-status-text')).toHaveTextContent('📅 회의 중');
      renderPage({peer: member({...withStatus, statusExpiresAtMs: BASE_MS - 1})});
      expect(screen.queryByTestId('conversation-info-status-text')).toBeNull();
    });
  });

  describe('큰 얼굴 — 사진이 있을 때만 눌려 크게 본다', () => {
    const withPhoto = (over: Partial<RosterMember> = {}) =>
      makeDirectory([SELF_MEMBER, member({...HUMAN, avatarUrl: PHOTO, ...over}), AGENT_MEMBER]);

    it('사진이 있으면 단추다 — 누르면 사진 주소와 이름을 대화 화면에 건넨다(뷰어는 대화 화면이 연다)', () => {
      const onEnlargeAvatar = jest.fn();
      renderPage({directory: withPhoto(), peer: member({...HUMAN, avatarUrl: PHOTO}), onEnlargeAvatar});
      const face = screen.getByTestId('conversation-info-face');
      expect(face.props.accessibilityRole).toBe('button');
      expect(face.props.accessibilityLabel).toBe('박서연 프로필 사진 크게 보기');
      fireEvent.press(face);
      expect(onEnlargeAvatar).toHaveBeenCalledTimes(1);
      expect(onEnlargeAvatar).toHaveBeenCalledWith({uri: PHOTO, label: '박서연 프로필 사진'});
    });

    it('이니셜 얼굴은 단추가 아니다 — 눌러도 아무 일이 없다(눌리는 척하는 얼굴은 없다)', () => {
      const onEnlargeAvatar = jest.fn();
      renderPage({onEnlargeAvatar});
      const face = screen.getByTestId('conversation-info-face');
      expect(face.props.accessibilityRole).toBeUndefined();
      fireEvent.press(face);
      expect(onEnlargeAvatar).not.toHaveBeenCalled();
    });

    it('크게 볼 곳을 모르면(`onEnlargeAvatar` 없음) 사진이 있어도 단추가 아니다', () => {
      renderPage({directory: withPhoto(), peer: member({...HUMAN, avatarUrl: PHOTO})});
      expect(screen.getByTestId('conversation-info-face').props.accessibilityRole).toBeUndefined();
    });
  });

  describe('DM — 에이전트', () => {
    const agentPage = (over: Partial<ConversationInfoPageProps> = {}) =>
      renderPage({peer: AGENT_MEMBER, title: '달무리 도우미', onOpenAgent: jest.fn(), ...over});

    it('얼굴은 둥근 사각이다(사람은 원) — 설정 페이지의 큰 얼굴과 같은 링', () => {
      agentPage();
      expect(screen.getByTestId('avatar-agent', HIDDEN)).toBeTruthy();
      expect(flatten(screen.getByTestId('conversation-info-face').props.style).borderRadius).toBe(
        PROFILE_FACE_SQUARE_RING_RADIUS,
      );
      renderPage();
      expect(flatten(screen.getByTestId('conversation-info-face').props.style).borderRadius).not.toBe(
        PROFILE_FACE_SQUARE_RING_RADIUS,
      );
    });

    it('「○○님이 관리」 줄과 「에이전트 정보 ›」 행이 선다 — 행을 누르면 상세 화면을 한 번 연다', () => {
      const props = agentPage();
      expect(screen.getByTestId('conversation-info-owner')).toHaveTextContent('이도현님이 관리');
      expect(rowKeys().slice(0, 2)).toEqual(['owner', 'agent-open']);
      fireEvent.press(screen.getByTestId('conversation-info-agent-open'));
      expect(props.onOpenAgent).toHaveBeenCalledTimes(1);
    });

    it('상세 화면으로 가는 문(`onOpenAgent`)이 없으면 행이 서지 않는다 — 눌러도 아무 일 없는 행은 없다', () => {
      agentPage({onOpenAgent: undefined});
      expect(screen.queryByTestId('conversation-info-agent-open')).toBeNull();
      expect(screen.getByTestId('conversation-info-owner')).toBeTruthy();
    });

    it('관리자를 모르면 그렇게 말한다 — 이름을 짓지 않는다', () => {
      agentPage({peer: member({...AGENT_MEMBER, ownerHumanId: undefined})});
      expect(screen.getByTestId('conversation-info-owner')).toHaveTextContent('관리자 정보 없음');
    });

    it('사람 DM 에는 에이전트 카드가 없다', () => {
      renderPage();
      expect(screen.queryByTestId('conversation-info-agent')).toBeNull();
    });
  });

  describe('채널', () => {
    const channelPage = (over: Partial<ConversationInfoPageProps> = {}) =>
      renderPage({
        kind: 'public',
        title: 'agent-lab',
        peer: null,
        items: conversationInfoActionItems(channelTarget()),
        subtitle: '6명 · 달무리 도우미 참여 중',
        ...over,
      });

    it('큰 `#` 얼굴 · 이름 · 긴 부제(「6명 · 달무리 도우미 참여 중」) — 머리 알약이 줄여 낸 문장이 여기서 다 선다', () => {
      channelPage();
      expect(within(screen.getByTestId('conversation-info-face')).getByText('#', HIDDEN)).toBeTruthy();
      expect(screen.getByTestId('conversation-info-name')).toHaveTextContent('agent-lab');
      expect(screen.getByTestId('conversation-info-subtitle')).toHaveTextContent('6명 · 달무리 도우미 참여 중');
      // 공개 채널에는 자물쇠가 없다.
      expect(screen.queryByTestId('conversation-info-lock', HIDDEN)).toBeNull();
    });

    it('비공개 채널은 자물쇠 배지가 앉고 얼굴이 「비공개 채널」이라 읽힌다', () => {
      channelPage({kind: 'private'});
      expect(screen.getByTestId('conversation-info-lock', HIDDEN)).toBeTruthy();
      expect(screen.getByTestId('conversation-info-face').props.accessibilityLabel).toBe('비공개 채널');
    });

    it('주제가 있으면 한 문단으로 서고, 없으면 줄이 없다', () => {
      channelPage({topic: '다음 배포 일정과 장애 대응을 이야기해요.'});
      expect(screen.getByTestId('conversation-info-topic')).toHaveTextContent('다음 배포 일정과 장애 대응을 이야기해요.');
      expect(screen.getByTestId('conversation-info-topic').props.lineBreakStrategyIOS).toBe('hangul-word');
      channelPage({topic: ''});
      expect(screen.queryByTestId('conversation-info-topic')).toBeNull();
      channelPage({topic: undefined});
      expect(screen.queryByTestId('conversation-info-topic')).toBeNull();
    });

    it('부제를 모르면(멤버 목록이 안 왔다) 줄이 없다', () => {
      channelPage({subtitle: undefined});
      expect(screen.queryByTestId('conversation-info-subtitle')).toBeNull();
    });
  });
});

// ---- 3. 행: 코어 표의 답을 그대로 그린다 --------------------------------------------

describe('정보 페이지 — 행은 코어 표의 답이다 (#4319)', () => {
  motionOff();

  it('DM(닫기를 내밂): 알림 → 복사 셋 → 대화 닫기, 낱말은 코어 것이다', () => {
    renderPage();
    expect(rowKeys()).toEqual(['mute-toggle', 'copy-name', 'copy-link', 'copy-id', 'close-dm']);
    expect(screen.getByTestId('conversation-info-mute-toggle')).toHaveTextContent(channelMuteToggleLabel(false));
    expect(screen.getByTestId('conversation-info-copy-name')).toHaveTextContent(channelCopyNameLabel(false));
    expect(screen.getByTestId('conversation-info-copy-link')).toHaveTextContent(copyLinkActionLabel(false));
    expect(screen.getByTestId('conversation-info-copy-id')).toHaveTextContent(channelCopyIdLabel(false));
    expect(screen.getByTestId('conversation-info-close-dm')).toHaveTextContent(DM_CLOSE_LABEL);
    // 복사 카드는 코어의 제목 하나를 이고 선다.
    expect(within(screen.getByTestId('conversation-info-copy')).getByText(CHANNEL_COPY_GROUP_LABEL)).toBeTruthy();
  });

  it('DM: 닫기를 내밀지 않으면(`closeOffered` 거짓) 「대화 닫기」가 없다 — 나머지는 그대로다', () => {
    renderPage({items: conversationInfoActionItems(dmTarget({closeOffered: false}))});
    expect(rowKeys()).toEqual(['mute-toggle', 'copy-name', 'copy-link', 'copy-id']);
  });

  it('알림이 꺼진 대화는 「알림 켜기」다', () => {
    renderPage({items: conversationInfoActionItems(dmTarget({muted: true}))});
    expect(screen.getByTestId('conversation-info-mute-toggle')).toHaveTextContent(channelMuteToggleLabel(true));
  });

  it('채널: 소유자·관리자에게는 「채널 나가기」가 선다 — 위험색이고 DM 의 「대화 닫기」는 없다', () => {
    renderPage({kind: 'public', title: 'general', peer: null, items: conversationInfoActionItems(channelTarget())});
    expect(rowKeys()).toEqual(['mute-toggle', 'copy-name', 'copy-link', 'copy-id', 'leave']);
    const leave = screen.getByTestId('conversation-info-leave');
    expect(leave).toHaveTextContent(CHANNEL_LEAVE_LABEL);
    const color = (id: string) =>
      flatten(within(screen.getByTestId(id)).getAllByText(/\S/)[0].props.style).color;
    expect(color('conversation-info-leave')).not.toBe(color('conversation-info-mute-toggle'));
  });

  it('채널: 일반 멤버·손님에게는 「채널 나가기」가 없다(`canLeaveChannel`) — 서버가 403 으로 답할 막다른 길이다', () => {
    for (const selfRole of ['member', 'guest'] as const) {
      renderPage({
        kind: 'public',
        title: 'general',
        peer: null,
        items: conversationInfoActionItems(channelTarget({selfRole})),
      });
      expect([selfRole, rowKeys()]).toEqual([selfRole, ['mute-toggle', 'copy-name', 'copy-link', 'copy-id']]);
    }
  });

  it('별표·섹션 이동은 없다 — 폰에 그 손이 없다(죽은 항목 금지). 열쇠도 낱말도', () => {
    renderPage({kind: 'public', title: 'general', peer: null, items: conversationInfoActionItems(channelTarget())});
    expect(screen.queryByText(/별표|섹션/)).toBeNull();
    expect(screen.queryByTestId('conversation-info-star')).toBeNull();
    expect(screen.queryByTestId('conversation-info-move-to-section')).toBeNull();
    // 코어 표가 입력에서 이미 막는다 — 읽음·별표·섹션은 이 페이지의 열쇠가 아니다. 열쇠 집합은 **적어 둔 목록**과 견준다(자기가 거른 집합에 자기가 들었는지
    // 묻는 단정은 실패할 수 없다).
    const keys = conversationInfoActionItems(channelTarget()).map(item => item.key);
    expect([...keys].sort()).toEqual(['copy-id', 'copy-link', 'copy-name', 'leave', 'mute']);
    expect([...CONVERSATION_INFO_ACTION_KEYS].sort()).toEqual([
      'close-dm',
      'copy-id',
      'copy-link',
      'copy-name',
      'leave',
      'mute',
    ]);
    // 코어 표에 별표·섹션 이동이 **있어도** 폰이 손이 없다고 입력으로 막은 답이다 — 풀면 열쇠가 늘어난다.
    expect(keys).not.toContain('star');
    expect(keys).not.toContain('move-to-section');
  });

  it('읽음 투영이 있는 대화에도 「읽지 않음으로 표시」·「읽음 처리」는 이 페이지의 행이 아니다 — 지금 읽고 있는 대화에 건네는 말이 아니다', () => {
    const caughtUp = {
      channelId: 'ch-general',
      lastReadSeq: 9,
      latestSeq: 9,
      unreadCount: 0,
      mentionCount: 0,
      markedUnreadBeforeSeq: null,
    } as ChannelRowTarget['readState'];
    const unread = {...caughtUp, lastReadSeq: 4, unreadCount: 5} as ChannelRowTarget['readState'];
    for (const readState of [caughtUp, unread]) {
      const keys = conversationInfoActionItems(channelTarget({readState})).map(item => item.key);
      expect([...keys].sort()).toEqual(['copy-id', 'copy-link', 'copy-name', 'leave', 'mute']);
    }
  });

  it('행을 누르면 그 열쇠로 실행을 부탁한다 — 페이지는 닫히지 않는다(닫는 길이 없다)', () => {
    const props = renderPage();
    const pressed: ChannelActionKey[] = [];
    (props.onRun as jest.Mock).mockImplementation((key: ChannelActionKey) => pressed.push(key));
    for (const key of ['mute-toggle', 'copy-name', 'copy-link', 'copy-id', 'close-dm']) {
      fireEvent.press(screen.getByTestId(`conversation-info-${key}`));
    }
    expect(pressed).toEqual(['mute', 'copy-name', 'copy-link', 'copy-id', 'close-dm']);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('왕복 중인 행은 진행 낱말로 바뀌고 busy 를 말한다 — 잠그거나 흐리게 하지 않는다', () => {
    renderPage({isPending: key => key === 'mute'});
    const mute = screen.getByTestId('conversation-info-mute-toggle');
    expect(mute).toHaveTextContent('알림 끄는 중');
    expect(mute.props.accessibilityState).toMatchObject({busy: true, disabled: false});
    expect(screen.getByTestId('conversation-info-close-dm').props.accessibilityState).toMatchObject({busy: false});
  });

  it('복사 영수증은 코어의 「복사됨」 낱말이고 그 줄만 바뀐다 — 페이지는 그대로다', () => {
    const props = renderPage({items: conversationInfoActionItems(dmTarget(), {name: true, link: false, id: false})});
    expect(screen.getByTestId('conversation-info-copy-name')).toHaveTextContent(channelCopyNameLabel(true));
    expect(screen.getByTestId('conversation-info-copy-link')).toHaveTextContent(copyLinkActionLabel(false));
    expect(screen.getByTestId('conversation-info-copy-id')).toHaveTextContent(channelCopyIdLabel(false));
    expect(channelCopyNameLabel(true)).not.toBe(channelCopyNameLabel(false));
    expect(screen.getByTestId('conversation-info-name')).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('실패는 페이지 안에서 alert 문장으로 말한다 — 토스트가 아니고, 없으면 줄도 없다', () => {
    renderPage({error: '알림을 바꾸지 못했어요. 다시 시도해 주세요.'});
    const error = screen.getByTestId('conversation-info-error');
    expect(error).toHaveTextContent(/알림을 바꾸지 못했어요/);
    expect(error.props.accessibilityRole).toBe('alert');
    renderPage({error: null});
    expect(screen.queryByTestId('conversation-info-error')).toBeNull();
  });

  it('모든 카드가 앞 아이콘이 없다 — 한 표면의 카드는 모두 앞 칸을 갖거나 모두 갖지 않는다(§4). 복사 행은 오른쪽에 복사 글리프다', () => {
    renderPage({
      peer: AGENT_MEMBER,
      title: '달무리 도우미',
      onOpenAgent: jest.fn(),
    });
    for (const key of rowKeys()) {
      const id = `conversation-info-${key}`;
      expect([key, screen.queryByTestId(`${id}-lead`) === null]).toEqual([key, true]);
    }
    for (const key of ['copy-name', 'copy-link', 'copy-id']) {
      const glyphs = within(screen.getByTestId(`conversation-info-${key}`))
        .UNSAFE_queryAllByType(Image)
        .filter(node => node.props.source === SHEET_ICONS.copy);
      expect([key, glyphs.length]).toEqual([key, 1]);
    }
  });

  it('행은 엄지에 닿는다(44 이상) — 제목은 어절 단위로 줄바꿈하고 잘리지 않는다', () => {
    renderPage();
    for (const key of rowKeys()) {
      const row = screen.getByTestId(`conversation-info-${key}`);
      expect([key, Number(flatten(row.props.style).minHeight) >= TOUCH_TARGET]).toEqual([key, true]);
      const title = within(row).getAllByText(/\S/)[0];
      expect([key, title.props.numberOfLines]).toEqual([key, undefined]);
      expect([key, title.props.lineBreakStrategyIOS]).toEqual([key, 'hangul-word']);
    }
  });
});

// ---- 4. 채널 나가기의 확인 단계 --------------------------------------------------------

describe('정보 페이지 — 채널 나가기의 확인 단계 (#4319)', () => {
  motionOff();

  const confirming = (over: Partial<ConversationInfoPageProps> = {}) =>
    renderPage({
      kind: 'public',
      title: 'general',
      peer: null,
      items: conversationInfoActionItems(channelTarget()),
      confirmingLeave: true,
      ...over,
    });

  it('확인 단계는 코어 문장 그대로이고, 항목 카드는 사라진다 — 머리·히어로는 그대로다', () => {
    confirming();
    expect(screen.getByTestId('conversation-info-leave-confirm-headline')).toHaveTextContent(
      CHANNEL_LEAVE_CONFIRM_TITLE,
    );
    expect(screen.getByTestId('conversation-info-leave-confirm-detail')).toHaveTextContent(
      channelLeaveConfirmBody('general'),
    );
    expect(screen.getByTestId('conversation-info-leave-confirm-button')).toHaveTextContent(CHANNEL_LEAVE_LABEL);
    expect(rowKeys()).toEqual([]);
    expect(screen.getByTestId('conversation-info-name')).toHaveTextContent('general');
    expect(screen.getByTestId('conversation-info-back')).toBeTruthy();
  });

  it('「취소」와 「채널 나가기」가 제 일을 한 번씩 부르고 페이지는 닫히지 않는다', () => {
    const props = confirming();
    fireEvent.press(screen.getByTestId('conversation-info-leave-cancel'));
    expect(props.onCancelLeave).toHaveBeenCalledTimes(1);
    expect(props.onConfirmLeave).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('conversation-info-leave-confirm-button'));
    expect(props.onConfirmLeave).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('왕복 중이면 위험 단추가 잠기고 「나가는 중…」이 진행을 말한다', () => {
    const props = confirming({leave: {pending: true, error: null}});
    const button = screen.getByTestId('conversation-info-leave-confirm-button');
    expect(button).toHaveTextContent('나가는 중…');
    expect(button.props.accessibilityState).toMatchObject({busy: true, disabled: true});
    fireEvent.press(button);
    expect(props.onConfirmLeave).not.toHaveBeenCalled();
  });

  it('실패는 확인 단계 안에서 말한다 — 페이지를 닫지 않는다', () => {
    const props = confirming({leave: {pending: false, error: '채널에서 나갈 권한이 없습니다.'}});
    expect(screen.getByTestId('conversation-info-leave-error')).toHaveTextContent(/나갈 권한이 없습니다/);
    expect(screen.getByTestId('conversation-info-leave-confirm')).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

// ---- 5. 움직임: 오른쪽에서 밀려 들어오고 ‹ 는 오른쪽으로 물러난다 ----------------------------------------

describe('정보 페이지 — 안쪽 장의 움직임 (#4319, `phone-sheets.md` §1)', () => {
  const {width: WIDTH} = Dimensions.get('window');
  let release: (() => void) | null = null;
  let timing: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    // 시킨 설정만 본다 — 네이티브 구동 애니메이션은 시험 환경에서 끝나지 않는다(`layerMotion.test.tsx` 와 같은 이음매).
    timing = jest
      .spyOn(Animated, 'timing')
      .mockImplementation(() => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never);
  });
  afterEach(() => {
    cleanup();
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.restoreAllMocks();
    release?.();
    release = null;
  });

  const transformOf = () =>
    Object.assign(
      {},
      ...(StyleSheet.flatten(screen.getByTestId('conversation-info-pane').props.style).transform as object[]),
    ) as {translateX?: number; translateY?: number};

  async function mountMoving() {
    release = await pinReduceMotion(false);
    mounted?.unmount();
    const props = pageProps();
    mounted = render(
      <FixedScheme scheme="light">
        <ConversationInfoPage {...props} />
      </FixedScheme>,
    );
    return props;
  }

  it('들어올 때 화면 오른쪽 밖(화면 너비)에서 시작해 0 으로 밀려 들어온다 — 240ms, 세로로는 움직이지 않는다', async () => {
    await mountMoving();
    expect(transformOf()).toEqual({translateX: WIDTH});
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: 0,
      duration: LAYER_PUSH_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
  });

  it('‹ 는 들어온 길의 반대로 오른쪽 밖까지 물러난 뒤(180ms) 한 번 걷는다 — 누른 즉시가 아니다', async () => {
    const props = await mountMoving();
    timing.mockClear();
    fireEvent.press(screen.getByTestId('conversation-info-back'));
    // 아직 걷지 않았다 — 물러나는 움직임이 먼저다.
    expect(props.onClose).not.toHaveBeenCalled();
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: WIDTH,
      duration: LAYER_POP_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    act(() => {
      jest.advanceTimersByTime(LAYER_POP_MS - 1);
    });
    expect(props.onClose).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(2);
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('물러나는 동안 ‹ 를 다시 눌러도 걷는 일은 한 번이다', async () => {
    const props = await mountMoving();
    timing.mockClear();
    fireEvent.press(screen.getByTestId('conversation-info-back'));
    fireEvent.press(screen.getByTestId('conversation-info-back'));
    fireEvent.press(screen.getByTestId('conversation-info-back'));
    expect(timing).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(LAYER_POP_MS * 3);
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('VoiceOver escape 도 같은 길로 물러난 뒤 한 번 걷는다', async () => {
    const props = await mountMoving();
    act(() => {
      screen.getByTestId('conversation-info-page').props.onAccessibilityEscape();
    });
    expect(props.onClose).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(LAYER_POP_MS + 1);
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
