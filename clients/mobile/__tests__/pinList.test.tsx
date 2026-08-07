import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {PinnedMessageWire} from '@momo/core/lib/api';
import {
  applyPinned,
  emptyPins,
  type PinListStatus,
  type PinMap,
} from '@momo/core/features/timeline/pins';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {PinListPanel} from '../src/features/conversation/PinListPanel';
import {APP_NOTE_MARK} from '../src/features/conversation/appVoice';
import {TOUCH_TARGET} from '../src/design/tokens';

// =============================================================================
// 고정 목록 화면 (이슈 #1112) — 폰 몫.
//
// 코어가 순서·낱말·접기를 순수 함수로 이미 증명한다(`pins.test.ts`). 여기서
// 증명하는 것은 그 규칙이 이 화면에 배선돼 있는가와, 이 화면이 **가는 곳**으로서
// 지켜야 할 세 가지다: 누르면 나간다, 빈 상태가 말을 한다, 손가락이 닿는다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const CHANNEL = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE_MS = 1_700_000_000_000;
/** 「지금」. 고정 도장이 오늘인지 어제인지는 이 값에서만 나온다. */
const NOW_MS = BASE_MS + 2_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function wire(over: Partial<PinnedMessageWire> = {}): PinnedMessageWire {
  return {
    messageId: 'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
    channelId: CHANNEL,
    seq: 12,
    authorMemberId: SELF,
    type: 'text',
    state: 'sent',
    body: '배포 순서는 이 문서가 정본입니다.',
    createdAtMs: BASE_MS,
    pinnedBy: SELF,
    pinnedAtMs: BASE_MS + 1_000,
    ...over,
  };
}

function pinsOf(...entries: PinnedMessageWire[]): PinMap {
  return entries.reduce(applyPinned, emptyPins());
}

function renderPanel(pins: PinMap, status: PinListStatus = 'ready') {
  const onJump = jest.fn();
  const onClose = jest.fn();
  const onRetry = jest.fn();
  render(
    <PinListPanel
      pins={pins}
      status={status}
      directory={DIRECTORY}
      nowMs={NOW_MS}
      onJump={onJump}
      onClose={onClose}
      onRetry={onRetry}
    />,
  );
  return {onJump, onClose, onRetry};
}

/**
 * 조각으로 그려진 라벨을 한 문자열로. 도장은 숫자와 산문이 갈라져 있고(자릿폭
 * 표지는 숫자에만 붙는다), 그 갈라짐 자체는 여기서 재는 것이 아니다 — 재는 것은
 * **무슨 날짜를 말하는가**다.
 */
function flatText(node: {props: {children?: unknown}}): string {
  const parts: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    if (Array.isArray(child)) {
      child.forEach(walk);
      return;
    }
    if (child !== null && typeof child === 'object' && 'props' in child) {
      walk((child as {props: {children?: unknown}}).props.children);
    }
  };
  walk(node.props.children);
  return parts.join('');
}

afterEach(cleanup);

describe('고정 목록은 가는 곳이다', () => {
  /**
   * 누르면 **이 화면이 물러나고** 그 줄이 열린다. 둘이 겹쳐 서면 위가 아래를
   * 가린 채로 남고, 사람은 방금 누른 것이 어디 갔는지 모른다 — 작업 목록이 같은
   * 이유로 같은 순서를 지킨다.
   */
  it('항목을 누르면 닫히고 원본으로 데려간다', () => {
    const entry = wire();
    const {onJump, onClose} = renderPanel(pinsOf(entry));
    fireEvent.press(screen.getByTestId('pin-list-item'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(entry.messageId, entry.seq);
  });

  /**
   * `seq` 를 함께 넘기는 것이 요점이다. 대화 화면은 그것으로 「더 위에 있어 아직
   * 안 불러왔다」를 추측이 아니라 사실로 말한다 — 서버의 고정 항목이 메시지의
   * seq 를 나르기 때문에 가능한 일이고, id 만 넘기면 그 문장이 불가능해진다.
   */
  it('원본의 seq 를 함께 넘긴다', () => {
    const entry = wire({seq: 4_099});
    const {onJump} = renderPanel(pinsOf(entry));
    fireEvent.press(screen.getByTestId('pin-list-item'));
    expect(onJump.mock.calls[0][1]).toBe(4_099);
  });

  /** 최근 고정이 위다 — 도착 순서가 아니라 고정 시각이 줄을 세운다. */
  it('최근에 고정한 것이 맨 위다', () => {
    const older = wire({
      messageId: 'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
      body: '오래된 고정',
      pinnedAtMs: BASE_MS + 1_000,
    });
    const newer = wire({
      messageId: 'aaaa0002-1111-4111-8111-aaaaaaaaaaaa',
      authorMemberId: OTHER,
      body: '방금 고정',
      pinnedAtMs: BASE_MS + 2_000,
    });
    // 오래된 것을 먼저 받아도 순서는 고정 시각이 정한다.
    renderPanel(pinsOf(older, newer));
    const items = screen.getAllByTestId('pin-list-item');
    expect(items).toHaveLength(2);
    expect(
      (items[0].props.accessibilityLabel as string).startsWith('김인턴'),
    ).toBe(true);
  });

  /**
   * 화면에는 두 줄이지만 VoiceOver 에게는 한 문장이어야 한다 — 그리고 그 문장은
   * **무엇이 열리는지**로 끝나야 한다. 「곽성재」만 읽어 주면 누를 이유를 모른다.
   */
  it('항목 하나가 한 문장으로 읽히고, 무엇이 열리는지로 끝난다', () => {
    renderPanel(pinsOf(wire()));
    const label = screen.getByTestId('pin-list-item').props
      .accessibilityLabel as string;
    expect(label).toContain('곽성재');
    expect(label).toContain('배포 순서는');
    expect(label.endsWith('원본으로 이동')).toBe(true);
  });

  /**
   * 본문 없는 메시지(텍스트 첨부만 있는 것)의 줄은 **앱이 말하는 문장**이다.
   * 저자의 말과 같은 결로 서면 사람은 앱의 해명을 남의 말로 읽는다 — 그래서
   * `※` 를 달고, 라벨에는 달지 않는다(로터는 순차적으로 듣는다).
   */
  it('본문이 없는 항목은 앱의 문장으로 선다 — 표시를 달되 라벨에는 없다', () => {
    renderPanel(pinsOf(wire({body: null})));
    expect(screen.getByText(new RegExp(`^${APP_NOTE_MARK} `))).toBeTruthy();
    const label = screen.getByTestId('pin-list-item').props
      .accessibilityLabel as string;
    expect(label).not.toContain(APP_NOTE_MARK);
    expect(label).toContain('내용 없는 메시지');
  });

  /** 손가락이 닿아야 한다. 두 줄짜리 카드라 높이는 고정이 아니라 바닥이다. */
  it('항목은 44pt 를 깔고 앉는다', () => {
    renderPanel(pinsOf(wire()));
    const style = screen.getByTestId('pin-list-item').props.style as
      | Record<string, unknown>
      | Record<string, unknown>[];
    const flat = Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean))
      : style;
    expect(flat.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    // 고정 높이가 아니다: 접근성 글꼴에서 두 번째 줄이 자라면 카드가 따라 자란다.
    expect(flat.height).toBeUndefined();
  });
});

describe('빈 목록도 말을 한다', () => {
  /**
   * 헤더의 문은 고정이 하나도 없어도 남는다 — 처음 고정하는 사람이 목록이 어디
   * 있는지 배울 자리가 필요하기 때문이다. 그래서 빈 화면은 침묵하면 안 되고,
   * **한쪽 surface 의 제스처를 지시해서도** 안 된다(웹은 ⋯, 폰은 길게 누르기).
   */
  it('무엇을 하면 채워지는지 말하되 제스처를 지시하지 않는다', () => {
    renderPanel(emptyPins());
    expect(screen.queryAllByTestId('pin-list-item')).toHaveLength(0);
    expect(screen.getByTestId('pin-list-empty')).toBeTruthy();
    expect(screen.getByText('고정한 메시지가 없습니다.')).toBeTruthy();
    expect(screen.getByText(/메시지 액션에서 고정하면/)).toBeTruthy();
    expect(screen.queryByText(/길게 눌러/)).toBeNull();
    // 같은 사실을 두 번 말하지 않는다 (실측으로 잡은 결함).
    expect(screen.queryAllByText(/고정한 메시지가 없습니다/)).toHaveLength(1);
  });

  /**
   * 그리고 못 불러왔을 때는 수를 말하지 않는다 (#1146 M2). 실패 문장 위의 제목이
   * 「고정 2개」라고 말하면, 고친 거짓말이 한 줄 위로 옮겨 간 것뿐이다.
   */
  it('못 불러왔을 때는 개수를 말하지 않는다', () => {
    renderPanel(
      pinsOf(wire(), wire({messageId: 'aaaa0002-1111-4111-8111-aaaaaaaaaaaa'})),
      'failed',
    );
    expect(screen.getByTestId('pin-list-title').props.children).toBe(
      '고정한 메시지',
    );
    expect(screen.getAllByTestId('pin-list-item')).toHaveLength(2);
  });

  /** 헤더는 개수를 말한다. */
  it('헤더가 개수를 말한다', () => {
    renderPanel(
      pinsOf(wire(), wire({messageId: 'aaaa0002-1111-4111-8111-aaaaaaaaaaaa'})),
    );
    expect(screen.getByTestId('pin-list-title').props.children).toBe('고정 2개');
  });

  /** 0이면 숫자를 말하지 않는다 — 「고정 0개」는 아무것도 알리지 않는다. */
  it('없을 때는 개수를 말하지 않는다', () => {
    renderPanel(emptyPins());
    expect(screen.getByTestId('pin-list-title').props.children).toBe(
      '고정한 메시지',
    );
  });

  /** 덮는 표면은 자기가 무엇을 닫는지 말한다 (`ScreenHeader.backLabel`). */
  it('뒤로가기가 「뒤로」가 아니라 무엇을 닫는지 말한다', () => {
    const {onClose} = renderPanel(emptyPins());
    const back = screen.getByTestId('header-back');
    expect(back.props.accessibilityLabel).toBe('고정 목록 닫기');
    fireEvent.press(back);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('시각은 정렬 근거다 (#1146 N1)', () => {
  /**
   * 1차는 **쓰인 때**를 그리면서 **고정된 때**로 줄을 세웠다. 그래서 어제 쓴 글을
   * 방금 고정하면 맨 위에 어제 날짜가 서고, 목록은 정렬이 깨진 것처럼 보인다.
   * 화면과 정렬 근거가 같은 값이어야 사람이 자기가 보는 순서를 믿는다.
   */
  it('도장은 쓰인 때가 아니라 고정된 때를 그린다', () => {
    // 오래전에 쓰였고, 방금 고정됐다 — 두 값이 다른 날에 떨어지게 벌려 둔다.
    renderPanel(
      pinsOf(
        wire({
          createdAtMs: BASE_MS - 30 * 86_400_000,
          pinnedAtMs: NOW_MS - 1_000,
        }),
      ),
    );
    const stamp = screen.getByTestId('pin-list-stamp');
    // 「오늘」은 고정된 때의 낱말이다. 쓰인 때를 그렸다면 한 달 전 날짜가 선다.
    expect(flatText(stamp)).toBe('오늘');
  });

  /** 해를 넘긴 고정은 **연도를 말한다** — 1차에는 그 자리가 없었다. */
  it('해가 다르면 연도가 붙는다', () => {
    const at = new Date(NOW_MS);
    const lastYear = new Date(
      at.getFullYear() - 1,
      11,
      31,
      12,
      0,
      0,
    ).getTime();
    renderPanel(pinsOf(wire({pinnedAtMs: lastYear})));
    expect(flatText(screen.getByTestId('pin-list-stamp'))).toBe(
      `${at.getFullYear() - 1}년 12월 31일`,
    );
  });

  /**
   * 눈은 「오늘」로 충분하지만 귀에 「오늘」만 남기는 것은 정보를 빼는 것이다 —
   * 화면을 되돌아볼 수 없는 사람에게 그 낱말은 어느 날인지 알려주지 않는다.
   * 날짜 구분선이 같은 판단을 하고, 같은 재료를 쓴다.
   */
  it('낭독은 절대 날짜로, 그리고 그것이 고정 시각임을 말한다', () => {
    renderPanel(pinsOf(wire({pinnedAtMs: NOW_MS - 1_000})));
    const at = new Date(NOW_MS - 1_000);
    const label = screen.getByTestId('pin-list-item').props
      .accessibilityLabel as string;
    expect(label).toContain(
      `${at.getFullYear()}년 ${at.getMonth() + 1}월 ${at.getDate()}일에 고정`,
    );
  });
});

describe('못 불러온 목록은 「없다」고 말하지 않는다 (#1146 M2)', () => {
  /**
   * **1차의 거짓말이 여기 있었다.** `/pins` 가 실패해도 지도는 조용히 비어 있었고,
   * 화면은 「고정한 메시지가 없습니다」를 인쇄했다 — 채널에 고정이 열 개 있어도.
   * 오프라인에서 그것을 읽은 사람은 고정이 지워졌다고 결론 내린다.
   */
  it('실패하면 못 불러왔다고 말하고, 「없습니다」는 말하지 않는다', () => {
    renderPanel(emptyPins(), 'failed');
    expect(screen.getByTestId('pin-list-failed')).toBeTruthy();
    expect(screen.getByText('고정 목록을 불러오지 못했습니다.')).toBeTruthy();
    expect(screen.queryByTestId('pin-list-empty')).toBeNull();
    expect(screen.queryByText(/고정한 메시지가 없습니다/)).toBeNull();
  });

  /** 다음 행동이 그 자리에 있다. 이 앱의 오류 블록은 언제나 재시도를 함께 낸다. */
  it('다시 시도가 목록만 다시 읽는다', () => {
    const {onRetry} = renderPanel(emptyPins(), 'failed');
    fireEvent.press(screen.getByTestId('pin-list-failed-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  /**
   * 프레임으로 들어온 고정이 있으면 **둘 다** 그린다. 「가진 것은 이게 전부가
   * 아니다」와 「가진 것은 이것들이다」는 둘 다 참이고, 하나를 지우면 다시
   * 거짓말이 된다.
   */
  it('실패해도 이미 가진 항목은 지우지 않는다', () => {
    renderPanel(pinsOf(wire()), 'failed');
    expect(screen.getByTestId('pin-list-failed')).toBeTruthy();
    expect(screen.getAllByTestId('pin-list-item')).toHaveLength(1);
  });

  /**
   * 아직 불러오는 중인 것도 「없다」가 아니다. 한 번의 REST 왕복은 문장을 세울
   * 만큼 길지 않지만, 그 사이에 빈 문장을 그리면 다음 순간 스스로를 뒤집는다.
   */
  it('불러오는 중에는 아무 말도 하지 않는다', () => {
    renderPanel(emptyPins(), 'loading');
    expect(screen.queryByTestId('pin-list-empty')).toBeNull();
    expect(screen.queryByTestId('pin-list-failed')).toBeNull();
  });
});
