import type { Message, RosterMember } from '@momo/core/lib/api';
import type { StatusDot as PeerStatus } from '@momo/core/features/presence/statusDot';
import { makeDirectory } from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import React from 'react';
import { Dimensions, Image } from 'react-native';

import { CONV } from '../src/features/conversation/convDesign';
import {
  COPY_RECEIPT_MS,
  copyText,
} from '../src/features/conversation/copy';
import { SHEET_ICONS } from '../src/design/icons';
import { slopTo, SHEET, TOUCH_TARGET } from '../src/design/tokens';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import { MemberProfileSheet } from '../src/features/directory/MemberProfileSheet';
import {
  tileLabelWidth,
  tilesFitInRow,
} from '../src/features/directory/profileTiles';
import {
  PROFILE_FACE,
  PROFILE_FACE_SQUARE_RADIUS,
} from '../src/features/profile/ProfileFace';
import {
  describeCloseContract,
  releaseReduceMotion,
  setReduceMotion,
} from './fixtures/sheetContract';

// =============================================================================
// 다른 사람 프로필 시트 (#4319). 옛 시트는 자체 Modal·글자 「닫기」·「구분·상태·역할」 키-값 줄·테두리 안내 상자였고 owner 의 평가는
// 「우리꺼는 너무 구려」였다. 이제 공용 시트(`PageSheet` + `SheetHeader` + `SheetScroll`)에 가운데 큰 얼굴·이름·상태 칩·큰 행동 타일이다.
//
// 인물은 모두 가상이다(이도현·박서연·최민수·정하윤, 회사 「달무리 스튜디오」).
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;
/** 1×1 PNG — 업로드 사진이 아니라 `data:` 주소라 서버 주소·받기 없이 `Avatar` 가 이미지로 싣는다. */
const PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 복사 실패는 클립보드 모듈이 아니라 **복사 길**(`copyText`)의 답(`false`)으로 흉내 낸다 — 기본은 진짜 구현(상자에 담는다)을 그대로 부른다.
jest.mock('../src/features/conversation/copy', () => {
  const actual = jest.requireActual('../src/features/conversation/copy');
  return { ...actual, copyText: jest.fn(actual.copyText) };
});

const clipboard = jest.requireMock('expo-clipboard') as {
  __box: { value: string | null };
};

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
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

const SELF_MEMBER = member({
  id: SELF,
  displayName: '이도현',
  handle: 'dohyun',
  role: 'owner',
});
const HUMAN = member({ id: OTHER, displayName: '박서연', handle: 'seoyeon' });
const AGENT_MEMBER = member({
  id: AGENT,
  kind: 'agent',
  displayName: '달무리 도우미',
  handle: 'dalmuri-helper',
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

type Props = React.ComponentProps<typeof MemberProfileSheet>;

function renderProfile(profileMember: RosterMember, over: Partial<Props> = {}) {
  return render(
    <MemberProfileSheet
      member={profileMember}
      directory={makeDirectory([SELF_MEMBER, AGENT_MEMBER, profileMember])}
      selfMemberId={SELF}
      online
      dmPending={false}
      dmError={null}
      nowMs={BASE_MS}
      onClose={jest.fn()}
      onOpenDm={jest.fn()}
      {...over}
    />,
  );
}

const TILE_IDS = [
  'profile-open-settings',
  'profile-open-dm',
  'profile-copy-mention',
  'profile-open-agent',
] as const;

/** 시트 안에 서 있는 행동 타일의 testID — **그려진 순서**대로(눌리는 것들 가운데 타일만 걸러 읽는다). */
function tilesOnScreen(): string[] {
  return within(screen.getByTestId('member-profile-scroll'))
    .getAllByRole('button')
    .map(node => String(node.props.testID))
    .filter(id => (TILE_IDS as readonly string[]).includes(id));
}

type Instance = ReturnType<typeof screen.getByTestId>;

/** 가장 가까운 호스트(진짜 뷰) 조상 — 타일을 감싸는 줄/쌓기 상자의 스타일을 읽는다. */
function hostParent(node: Instance): Instance {
  let current: Instance | null = node.parent;
  while (current && typeof current.type !== 'string') current = current.parent;
  return current as Instance;
}

const BASE_WINDOW = Dimensions.get('window');
function setWindow(next: { width?: number; height?: number; fontScale?: number }) {
  const window = { ...BASE_WINDOW, ...next };
  Dimensions.set({ window, screen: window });
}

/**
 * 슬라이드 없이 바로 닫혀 `closesSheet` 행동(「에이전트 정보」·「설정 열기」·얼굴)이 동기 단정이 된다. **묶음 안에서만** 켠다 —
 * `describeCloseContract` 는 동작 줄이기 켬/끔을 시험마다 스스로 정하므로 파일 전체에 걸면 그 계약을 가린다.
 */
function motionOff() {
  beforeEach(async () => {
    await setReduceMotion(true);
  });
  afterEach(() => {
    releaseReduceMotion();
  });
}

afterEach(() => {
  cleanup();
  Dimensions.set({ window: BASE_WINDOW, screen: BASE_WINDOW });
  jest.useRealTimers();
  jest.clearAllMocks();
  clipboard.__box.value = null;
});

describe('다른 사람 프로필 시트 — 공용 그릇과 머리 (#4319)', () => {
  motionOff();
  it('공용 시트(PageSheet)다 — 손잡이 띠·머리 제목 「프로필」·원형 X 가 서고 글자 「닫기」 단추가 없다', () => {
    renderProfile(HUMAN);
    const sheet = within(screen.getByTestId('page-sheet'));
    expect(screen.getByTestId('page-sheet-handle')).toBeTruthy();
    expect(sheet.getAllByRole('header')[0]).toHaveTextContent('프로필');
    const close = screen.getByTestId('member-profile-close');
    expect(close.props.accessibilityLabel).toBe('프로필 닫기');
    expect(screen.queryByText('닫기')).toBeNull();
    // 시트의 몸은 공용 스크롤이다 — 끌어내리기가 본문까지 이어지려면 시트에 자기를 알리는 `SheetScroll` 이어야 한다.
    expect(screen.getByTestId('member-profile-scroll')).toBeTruthy();
  });

  it('머리의 X 는 눌림 영역 44pt 를, 타일은 최소 높이 44pt 이상을 채운다', () => {
    renderProfile(HUMAN);
    const close = screen.getByTestId('member-profile-close');
    expect(SHEET.circle + slopTo(SHEET.circle) * 2).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
    expect(close.props.hitSlop).toBe(slopTo(SHEET.circle));
    const tile = flatten(screen.getByTestId('profile-open-dm').props.style);
    expect(Number(tile.minHeight)).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });
});

describe('다른 사람 프로필 시트 — 가운데 큰 얼굴과 이름 (#4319)', () => {
  motionOff();
  it('이름·핸들·역할이 한 덩어리로 가운데에 선다 — 옛 「구분·상태·역할」 키-값 줄은 없다', () => {
    renderProfile(HUMAN);
    expect(screen.getByTestId('profile-name').props.children).toBe('박서연');
    expect(screen.getByTestId('profile-handle').props.children).toBe(
      '@seoyeon',
    );
    expect(screen.getByTestId('profile-role').props.children).toBe('멤버');
    expect(screen.queryByText('구분')).toBeNull();
    expect(screen.queryByText('역할')).toBeNull();
    expect(screen.queryByTestId('profile-kind')).toBeNull();
  });

  it('워크스페이스 역할 표시명 오버라이드를 기본 라벨보다 먼저 쓴다', () => {
    renderProfile(HUMAN, { roleLabels: { member: '동료' } });
    expect(screen.getByTestId('profile-role').props.children).toBe('동료');
    expect(screen.queryByText('멤버')).toBeNull();
  });

  it('사람의 얼굴은 설정 페이지와 같은 큰 원이다', () => {
    renderProfile(HUMAN);
    const face = flatten(screen.getByTestId('avatar-human', { includeHiddenElements: true }).props.style);
    expect(face.width).toBe(PROFILE_FACE);
    expect(face.height).toBe(PROFILE_FACE);
    expect(face.borderRadius).toBe(PROFILE_FACE / 2);
  });

  it('에이전트의 얼굴은 둥근 사각이고 모서리가 큰 얼굴의 비율로 자란다 — 원이 아니다', () => {
    renderProfile(AGENT_MEMBER);
    const face = flatten(screen.getByTestId('avatar-agent', { includeHiddenElements: true }).props.style);
    expect(face.width).toBe(PROFILE_FACE);
    expect(face.borderRadius).toBe(PROFILE_FACE_SQUARE_RADIUS);
    expect(face.borderRadius).not.toBe(PROFILE_FACE / 2);
    // 에이전트는 역할이 없다 — 이름 아래 한 줄이 「에이전트」라고 말한다(얼굴은 보조기술에서 숨는다).
    expect(screen.getByTestId('profile-role').props.children).toBe('에이전트');
  });
});

describe('다른 사람 프로필 시트 — 상태 칩과 한 줄 상태 (#4319)', () => {
  motionOff();
  const DND: PeerStatus = { tone: 'danger', label: '방해 금지' };
  const RESPONSIVE: PeerStatus = { tone: 'ok', label: '응답함 3분 전' };

  it('활성 사람에게 말할 상태가 없으면 칩이 없다 — 「활성」을 모든 사람에게 붙이지 않는다', () => {
    renderProfile(HUMAN, { status: null });
    expect(screen.queryByTestId('profile-status')).toBeNull();
    expect(screen.queryByText('활성')).toBeNull();
  });

  it('상태가 있으면 점과 낱말이 한 칩에 선다 — 점의 톤은 core 판정 그대로다', () => {
    renderProfile(HUMAN, { status: DND });
    const chip = screen.getByTestId('profile-status');
    expect(within(chip).getByText('방해 금지')).toBeTruthy();
    expect(chip.props.accessibilityLabel).toBe('상태: 방해 금지');
    const dot = within(chip).getByTestId('profile-status-dot', { includeHiddenElements: true });
    expect(flatten(dot.props.style).backgroundColor).toBeDefined();
  });

  it('에이전트의 생존 판정도 같은 칩이다', () => {
    renderProfile(AGENT_MEMBER, { status: RESPONSIVE });
    expect(
      within(screen.getByTestId('profile-status')).getByText('응답함 3분 전'),
    ).toBeTruthy();
  });

  it.each([
    ['invited', '초대됨'],
    ['suspended', '정지됨'],
    ['deleted', '삭제됨'],
  ] as const)(
    '%s 멤버십은 칩이 그 낱말을 말한다 — 점이 없고, 같이 온 상태보다 먼저 말한다',
    (status, word) => {
      renderProfile(member({ id: OTHER, status }), { status: RESPONSIVE });
      const chip = screen.getByTestId('profile-status');
      expect(within(chip).getByText(word)).toBeTruthy();
      expect(within(chip).queryByTestId('profile-status-dot', { includeHiddenElements: true })).toBeNull();
      expect(screen.queryByText('응답함 3분 전')).toBeNull();
    },
  );

  it('보이는 한 줄 상태는 이모지와 글이 한 줄로 선다', () => {
    renderProfile(
      member({
        id: OTHER,
        statusEmoji: '📅',
        statusText: '회의 중',
        statusExpiresAtMs: BASE_MS + 60_000,
      }),
    );
    expect(screen.getByTestId('profile-status-text').props.children).toBe(
      '📅 회의 중',
    );
    // 글이 있으면 글이 이름이고 이모지는 장식이다(core `customStatusAccessibleText`).
    expect(screen.getByTestId('profile-status-text').props.accessibilityLabel).toBe(
      '회의 중',
    );
  });

  it('이모지만 있는 상태는 이모지가 읽힌다', () => {
    renderProfile(member({ id: OTHER, statusEmoji: '🌴' }));
    expect(screen.getByTestId('profile-status-text').props.children).toBe('🌴');
    expect(screen.getByTestId('profile-status-text').props.accessibilityLabel).toBe(
      '🌴',
    );
  });

  it('만료된 한 줄 상태는 그리지 않는다 — 옛 명부 행이 만료 도장을 들고 있어도', () => {
    renderProfile(
      member({
        id: OTHER,
        statusEmoji: '📅',
        statusText: '회의 중',
        statusExpiresAtMs: BASE_MS - 1,
      }),
    );
    expect(screen.queryByTestId('profile-status-text')).toBeNull();
  });
});

describe('다른 사람 프로필 시트 — 어느 타일이 서는가 (#4319)', () => {
  motionOff();
  it('사람(활성·온라인)은 메시지 → 멘션 복사 순서이고 까닭 문장이 없다', () => {
    renderProfile(HUMAN);
    expect(tilesOnScreen()).toEqual(['profile-open-dm', 'profile-copy-mention']);
    expect(screen.queryByTestId('profile-dm-unavailable')).toBeNull();
    expect(screen.queryByTestId('profile-details')).toBeNull();
  });

  it('에이전트는 「에이전트 정보」가 셋째로 선다 — 문이 있을 때만', () => {
    renderProfile(AGENT_MEMBER, { onOpenAgent: jest.fn() });
    expect(tilesOnScreen()).toEqual([
      'profile-open-dm',
      'profile-copy-mention',
      'profile-open-agent',
    ]);
  });

  it('에이전트 정보 문이 없는 화면(`onOpenAgent` 없음)에서는 그 타일이 없다', () => {
    renderProfile(AGENT_MEMBER);
    expect(tilesOnScreen()).toEqual(['profile-open-dm', 'profile-copy-mention']);
  });

  it('사람에게는 「에이전트 정보」가 없다 — 문을 줘도', () => {
    renderProfile(HUMAN, { onOpenAgent: jest.fn() });
    expect(screen.queryByTestId('profile-open-agent')).toBeNull();
  });

  it('에이전트는 관리자 귀속 문장이 정보 카드에 선다', () => {
    renderProfile(AGENT_MEMBER, { directory: DIRECTORY });
    expect(
      within(screen.getByTestId('profile-details')).getByText('이도현님이 관리'),
    ).toBeTruthy();
    expect(screen.queryByText('관리자 정보 없음')).toBeNull();
  });

  it('소유자를 모르는 에이전트는 「관리자 정보 없음」이라고 말한다 — 이름을 지어내지 않는다', () => {
    renderProfile(member({ ...AGENT_MEMBER, ownerHumanId: undefined }));
    expect(screen.getByText('관리자 정보 없음')).toBeTruthy();
    expect(screen.queryByText(/님이 관리/)).toBeNull();
  });

  it('나(자기 자신)는 DM 타일 자리에 「설정 열기」가 선다 — 옛 「내 프로필입니다」 상자는 없다', () => {
    renderProfile(SELF_MEMBER, { onOpenSettings: jest.fn() });
    expect(tilesOnScreen()).toEqual([
      'profile-open-settings',
      'profile-copy-mention',
    ]);
    expect(screen.queryByTestId('profile-open-dm')).toBeNull();
    expect(screen.queryByTestId('profile-dm-unavailable')).toBeNull();
    expect(screen.queryByText('내 프로필입니다.')).toBeNull();
  });

  it('설정으로 가는 문이 없는 호스트(`onOpenSettings` 없음)의 나는 타일 없이 까닭 문장이 선다', () => {
    renderProfile(SELF_MEMBER);
    expect(tilesOnScreen()).toEqual(['profile-copy-mention']);
    const reason = screen.getByTestId('profile-dm-unavailable');
    expect(within(reason).getByText('내 프로필입니다.')).toBeTruthy();
    expect(
      within(reason).getByText('자기 자신과는 다이렉트 메시지를 열 수 없습니다.'),
    ).toBeTruthy();
  });

  it.each([
    ['invited', '초대됨'],
    ['suspended', '정지됨'],
    ['deleted', '삭제됨'],
  ] as const)(
    '%s 멤버는 죽은 DM 타일 대신 까닭을 말한다 — 멘션 복사는 그대로다',
    (status, word) => {
      renderProfile(member({ id: OTHER, status }));
      expect(tilesOnScreen()).toEqual(['profile-copy-mention']);
      const reason = screen.getByTestId('profile-dm-unavailable');
      expect(within(reason).getByText(`이 멤버는 ${word} 상태입니다.`)).toBeTruthy();
      expect(
        within(reason).getByText(
          '활성 멤버가 되면 다이렉트 메시지를 열 수 있습니다.',
        ),
      ).toBeTruthy();
    },
  );

  it('오프라인에서는 DM 타일 대신 까닭을 말한다', () => {
    renderProfile(HUMAN, { online: false });
    expect(tilesOnScreen()).toEqual(['profile-copy-mention']);
    expect(
      screen.getByText('오프라인에서는 대화를 열 수 없습니다.'),
    ).toBeTruthy();
    expect(screen.getByText('연결이 돌아오면 다시 시도하세요.')).toBeTruthy();
  });
});

describe('다른 사람 프로필 시트 — 행동 (#4319)', () => {
  motionOff();
  it('메시지 보내기는 DM 열기를 한 번 부르고 시트를 닫지 않는다 — 진행·실패를 이 시트가 보인다', () => {
    const onOpenDm = jest.fn();
    const onClose = jest.fn();
    renderProfile(HUMAN, { onOpenDm, onClose });
    fireEvent.press(screen.getByTestId('profile-open-dm'));
    expect(onOpenDm).toHaveBeenCalledTimes(1);
    // `closesSheet` 로 보내면 시트가 먼저 걷혀 `profile-dm-error` 가 말할 곳이 없다(`phone-sheets.md` §2).
    expect(onClose).not.toHaveBeenCalled();
  });

  it('DM 을 여는 동안(`dmPending`)은 타일이 바쁘고 다시 눌러도 요청은 하나다', () => {
    const onOpenDm = jest.fn();
    renderProfile(HUMAN, { dmPending: true, onOpenDm });
    const tile = screen.getByTestId('profile-open-dm');
    expect(tile.props.accessibilityState.busy).toBe(true);
    fireEvent.press(tile);
    expect(onOpenDm).not.toHaveBeenCalled();
  });

  it('DM 열기가 실패하면 문장과 「다시 시도」가 선다 — 재시도는 같은 요청을 다시 부른다', () => {
    const onOpenDm = jest.fn();
    renderProfile(HUMAN, { dmError: new Error('boom'), onOpenDm });
    expect(screen.getByTestId('profile-dm-error')).toBeTruthy();
    fireEvent.press(screen.getByTestId('profile-dm-error-retry'));
    expect(onOpenDm).toHaveBeenCalledTimes(1);
  });

  it('DM 을 열 수 없는 사람의 실패 문장에는 「다시 시도」가 없다 — 눌러도 할 수 있는 일이 없다', () => {
    renderProfile(HUMAN, { online: false, dmError: new Error('boom') });
    expect(screen.getByTestId('profile-dm-error')).toBeTruthy();
    expect(screen.queryByTestId('profile-dm-error-retry')).toBeNull();
  });

  it('「에이전트 정보」는 시트를 내린 뒤 한 번 부른다', () => {
    const calls: string[] = [];
    renderProfile(AGENT_MEMBER, {
      onClose: () => calls.push('close'),
      onOpenAgent: () => calls.push('agent'),
    });
    fireEvent.press(screen.getByTestId('profile-open-agent'));
    expect(calls).toEqual(['close', 'agent']);
  });

  it('「설정 열기」는 시트를 내린 뒤 한 번 부른다', () => {
    const calls: string[] = [];
    renderProfile(SELF_MEMBER, {
      onClose: () => calls.push('close'),
      onOpenSettings: () => calls.push('settings'),
    });
    fireEvent.press(screen.getByTestId('profile-open-settings'));
    expect(calls).toEqual(['close', 'settings']);
  });
});

describe('다른 사람 프로필 시트 — 멘션 복사 (#4319)', () => {
  motionOff();
  const flushCopy = () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

  it('「@핸들」이 클립보드에 들어가고 「복사됨」 영수증이 서며 시트는 닫히지 않는다 — 영수증은 때가 되면 걷힌다', async () => {
    jest.useFakeTimers();
    const onClose = jest.fn();
    renderProfile(HUMAN, { onClose });
    const tile = () => screen.getByTestId('profile-copy-mention');
    expect(tile().props.accessibilityLabel).toBe('멘션 복사');

    fireEvent.press(tile());
    await flushCopy();
    // 화면에 그려진 모양이 아니라 사람이 붙여 넣을 글이다.
    expect(clipboard.__box.value).toBe('@seoyeon');
    expect(tile().props.accessibilityLabel).toBe('복사됨');
    expect(onClose).not.toHaveBeenCalled();
    // 영수증이 서 있는 동안 글리프도 복사에서 ✓ 로 바뀐다.
    expect(within(tile()).UNSAFE_getByType(Image).props.source).toBe(
      SHEET_ICONS.check,
    );

    act(() => {
      jest.advanceTimersByTime(COPY_RECEIPT_MS - 1);
    });
    expect(tile().props.accessibilityLabel).toBe('복사됨');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(tile().props.accessibilityLabel).toBe('멘션 복사');
    expect(within(tile()).UNSAFE_getByType(Image).props.source).toBe(
      SHEET_ICONS.copy,
    );
  });

  it('복사가 안 되면 같은 자리에서 그렇게 말하고 영수증은 서지 않는다', async () => {
    (copyText as jest.Mock).mockResolvedValueOnce(false);
    renderProfile(HUMAN);
    fireEvent.press(screen.getByTestId('profile-copy-mention'));
    await flushCopy();
    expect(screen.getByTestId('profile-copy-error')).toBeTruthy();
    expect(screen.getByTestId('profile-copy-mention').props.accessibilityLabel).toBe(
      '멘션 복사',
    );
  });

  it('시트가 걷히면 영수증 타이머도 걷힌다 — 걷힌 시트가 1.5 초 뒤에 상태를 넣으려고 대기하지 않는다', async () => {
    jest.useFakeTimers();
    const setSpy = jest.spyOn(global, 'setTimeout');
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    try {
      const view = renderProfile(HUMAN);
      fireEvent.press(screen.getByTestId('profile-copy-mention'));
      await flushCopy();
      // 영수증 타이머가 서 있다 — 그 타이머의 번호를 잡아 둔다(다른 부품의 타이머와 섞이지 않게 영수증 시간으로 찾는다).
      const at = setSpy.mock.calls.findIndex(([, delay]) => delay === COPY_RECEIPT_MS);
      expect(at).toBeGreaterThanOrEqual(0);
      const receiptTimer = setSpy.mock.results[at].value;
      expect(clearSpy).not.toHaveBeenCalledWith(receiptTimer);
      view.unmount();
      // 언마운트가 그 타이머를 지웠다.
      expect(clearSpy).toHaveBeenCalledWith(receiptTimer);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

describe('다른 사람 프로필 시트 — 이메일 자리 (#4319)', () => {
  motionOff();
  it('이메일을 주지 않으면(지금의 대화 화면) 자리도 없다 — 사람 프로필에는 정보 카드 자체가 없다', () => {
    renderProfile(HUMAN);
    expect(screen.queryByTestId('profile-email')).toBeNull();
    expect(screen.queryByText('이메일')).toBeNull();
    expect(screen.queryByTestId('profile-details')).toBeNull();
  });

  it('이메일을 주면 정보 카드에 「이메일」 한 줄이 선다', () => {
    renderProfile(HUMAN, { email: 'seoyeon@dalmuri.example' });
    const row = within(screen.getByTestId('profile-details')).getByTestId(
      'profile-email',
    );
    expect(within(row).getByText('이메일')).toBeTruthy();
    expect(within(row).getByText('seoyeon@dalmuri.example')).toBeTruthy();
  });

  it('공백뿐인 이메일은 값이 아니다', () => {
    renderProfile(HUMAN, { email: '   ' });
    expect(screen.queryByTestId('profile-email')).toBeNull();
  });

  it('에이전트의 카드에서 이메일이 관리자 줄 위에 선다', () => {
    renderProfile(AGENT_MEMBER, {
      directory: DIRECTORY,
      email: 'helper@dalmuri.example',
    });
    const card = within(screen.getByTestId('profile-details'));
    expect(card.getByTestId('profile-email')).toBeTruthy();
    expect(card.getByTestId('profile-owner')).toBeTruthy();
    expect(card.getAllByTestId('group-divider')).toHaveLength(1);
  });
});

describe('다른 사람 프로필 시트 — 큰 얼굴 크게 보기 (#4319)', () => {
  motionOff();
  const withPhoto = (over: Partial<RosterMember> = {}) =>
    member({ id: OTHER, displayName: '박서연', handle: 'seoyeon', avatarUrl: PHOTO, ...over });

  it('사진이 있는 얼굴만 단추다 — 시트를 내린 뒤 사진 주소와 이름을 한 번 넘긴다', () => {
    const calls: unknown[] = [];
    renderProfile(withPhoto(), {
      onClose: () => calls.push('close'),
      onEnlargeAvatar: photo => calls.push(photo),
    });
    const face = screen.getByTestId('profile-face');
    expect(face.props.accessibilityRole).toBe('button');
    expect(face.props.accessibilityLabel).toBe('박서연 프로필 사진 크게 보기');
    fireEvent.press(face);
    expect(calls).toEqual([
      'close',
      { uri: PHOTO, label: '박서연 프로필 사진' },
    ]);
  });

  it('에이전트의 사진도 같다', () => {
    const onEnlargeAvatar = jest.fn();
    renderProfile(
      member({ ...AGENT_MEMBER, avatarUrl: PHOTO }),
      { onEnlargeAvatar },
    );
    fireEvent.press(screen.getByTestId('profile-face'));
    expect(onEnlargeAvatar).toHaveBeenCalledWith({
      uri: PHOTO,
      label: '달무리 도우미 프로필 사진',
    });
  });

  it('사진이 없는 얼굴(이니셜)은 단추가 아니고 눌러도 아무 일도 없다', () => {
    const onEnlargeAvatar = jest.fn();
    const onClose = jest.fn();
    renderProfile(HUMAN, { onEnlargeAvatar, onClose });
    const face = screen.getByTestId('profile-face');
    expect(screen.getByTestId('avatar-initial', { includeHiddenElements: true })).toBeTruthy();
    expect(face.props.accessibilityRole).toBeUndefined();
    expect(face.props.onClick).toBeUndefined();
    fireEvent.press(face);
    expect(onEnlargeAvatar).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('크게 볼 문(`onEnlargeAvatar`)이 없는 호스트에서는 사진이 있어도 단추가 아니다', () => {
    renderProfile(withPhoto());
    const face = screen.getByTestId('profile-face');
    expect(screen.getByTestId('avatar-image', { includeHiddenElements: true })).toBeTruthy();
    expect(face.props.accessibilityRole).toBeUndefined();
  });
});

describe('다른 사람 프로필 시트 — 작은 화면·큰 글씨에서 타일 라벨이 잘리지 않는다 (#4319)', () => {
  motionOff();
  it('라벨 폭 어림은 한글을 한 글자 1em, 공백을 0.3em 으로 센다', () => {
    // 「멘션 복사」= 한글 4 + 공백 1 = 4.3em, 글자 13pt.
    expect(tileLabelWidth('멘션 복사', 1)).toBeCloseTo(4.3 * 13, 5);
    expect(tileLabelWidth('멘션 복사', 2)).toBeCloseTo(4.3 * 13 * 2, 5);
    // 영문·숫자는 한글보다 좁게 센다.
    expect(tileLabelWidth('AB', 1)).toBeLessThan(tileLabelWidth('가나', 1));
  });

  it('보통 크기에서는 16 Pro·SE(375) 모두 세 타일이 한 줄에 선다', () => {
    const labels = ['메시지 보내기', '멘션 복사', '에이전트 정보'];
    expect(tilesFitInRow(labels, 393, 1)).toBe(true);
    expect(tilesFitInRow(labels, 375, 1)).toBe(true);
  });

  it('글씨가 커지면 쌓는다 — SE 에서 세 타일은 1.3배부터, 접근성 크기는 둘도 쌓는다', () => {
    const three = ['메시지 보내기', '멘션 복사', '에이전트 정보'];
    const two = ['메시지 보내기', '멘션 복사'];
    expect(tilesFitInRow(three, 375, 1.3)).toBe(false);
    expect(tilesFitInRow(two, 375, 1.3)).toBe(true);
    expect(tilesFitInRow(two, 393, 3.1)).toBe(false);
    expect(tilesFitInRow(three, 393, 3.1)).toBe(false);
  });

  it('타일이 하나뿐이면 늘 한 줄이다 — 이미 폭 전체를 쓰므로 쌓아도 나아지지 않는다', () => {
    // 가장 긴 라벨이 가장 큰 글씨의 가장 좁은 폭에서 폭 전체에도 안 들어가는 경우(6.3em × 13pt × 3.5 ≈ 287pt + 숨 8 > 288pt).
    expect(tileLabelWidth('메시지 보내기', 3.5) + 2 * 4).toBeGreaterThan(320 - 32);
    expect(tilesFitInRow(['메시지 보내기'], 320, 3.5)).toBe(true);
  });

  it('렌더: 보통 크기의 에이전트 시트는 타일이 한 줄이고, 접근성 큰 글씨에서는 한 줄씩 쌓인다', () => {
    setWindow({ width: 393, height: 852, fontScale: 1 });
    const view = renderProfile(AGENT_MEMBER, { onOpenAgent: jest.fn() });
    const rowStyle = flatten(
      hostParent(screen.getByTestId('profile-open-dm')).props.style,
    );
    expect(rowStyle.flexDirection).toBe('row');
    view.unmount();

    setWindow({ width: 393, height: 852, fontScale: 3.1 });
    renderProfile(AGENT_MEMBER, { onOpenAgent: jest.fn() });
    const stackStyle = flatten(
      hostParent(screen.getByTestId('profile-open-dm')).props.style,
    );
    expect(stackStyle.flexDirection).toBeUndefined();
    // 같은 세 타일이 모두 그대로 있다 — 쌓는다고 타일이 사라지지 않는다.
    expect(tilesOnScreen()).toEqual([
      'profile-open-dm',
      'profile-copy-mention',
      'profile-open-agent',
    ]);
  });
});

const closes = jest.fn();

describeCloseContract({
  name: 'MemberProfileSheet',
  open: () => {
    closes.mockReset();
    renderProfile(HUMAN, { onClose: closes });
  },
  closedCount: () => closes.mock.calls.length,
  closeTestID: 'member-profile-close',
  closeLabel: '프로필 닫기',
  scrimTestID: 'member-profile-backdrop',
  scrimLabel: '프로필 닫기',
});

describe('메시지의 프로필 문은 얼굴이다 — 이름은 문이 아니다 (#4666)', () => {
  it('얼굴이 프로필을 열고 목표 크기는 44pt를 채운다', () => {
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
    fireEvent.press(avatar);
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    expect(onOpenProfile).toHaveBeenCalledWith(OTHER);

    const avatarSlop = avatar.props.hitSlop.top;
    // 대화의 얼굴은 40 이다(DS2-4, owner 표). 슬롭은 그 크기에서 도출된다.
    expect(CONV.avatar + avatarSlop * 2).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(avatarSlop).toBe(slopTo(CONV.avatar));
  });

  it('작성자 이름 줄은 눌리는 단추가 아니다 — 길게 누르기·탭 회귀는 messageTap 이 잰다', () => {
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({ onOpenProfile: jest.fn() })}
      />,
    );
    expect(screen.queryByTestId('profile-author-target')).toBeNull();
    expect(screen.getByText('박서연')).toBeTruthy();
  });
});
