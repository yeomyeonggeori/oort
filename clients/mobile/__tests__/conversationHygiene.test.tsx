import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {
  PendingMessage,
  TimelineStreamItem,
} from '@momo/core/features/timeline/model';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import {
  color,
  line,
  SAFE_GUTTER,
  slopTo,
  TOUCH_TARGET,
} from '../src/design/tokens';
import {
  MessageRow,
  PendingRow,
} from '../src/features/conversation/MessageRow';
import {
  foldDeletedRuns,
  foldedStandInIndex,
} from '../src/features/conversation/deletedFold';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// U4-5M — 폰 위생 (감사 U4-i: M-1 · M-12 · M-13 · M-14) + 착지 틴트 (#1076)
//
// 이 파일이 잠그는 것은 **산수**다. 위 넷은 전부 「보기에 괜찮은데 값이 틀린」
// 종류의 결함이었다: 6+17+6 은 29 이지 44 가 아니고, 여백 없는 그릇에 자식을
// 직결하면 좌우가 0 이고, 하드코딩된 hex 는 토큰이 바뀌어도 안 따라온다. 그런
// 결함은 사진으로 잡기 어렵고 **세면 언제나 잡힌다.**
//
// 그래서 단정은 가능한 한 그려진 트리에서 값을 읽는다 — 소스 문자열 매칭은
// 표현이 바뀌면 조용히 아무것도 안 묻게 되므로, 그것으로만 지킬 수 있는 것
// (예: 파일 전체에 hex 가 없다)에만 쓴다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;

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

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '본문',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

function pending(over: Partial<PendingMessage> = {}): PendingMessage {
  return {
    clientMsgId: 'c-1',
    channelId: 'ch',
    authorMemberId: SELF,
    body: '보내는 중인 본문',
    status: 'sending',
    createdAtMs: BASE_MS,
    ...over,
  } as PendingMessage;
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

/** `hitSlop` 을 네 변 숫자로 편다. RN 은 숫자 하나도 허용한다. */
function slop(value: unknown): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  if (typeof value === 'number') {
    return {top: value, bottom: value, left: value, right: value};
  }
  const s = (value ?? {}) as Record<string, number>;
  return {
    top: s.top ?? 0,
    bottom: s.bottom ?? 0,
    left: s.left ?? 0,
    right: s.right ?? 0,
  };
}

const SRC_DIR = path.resolve(__dirname, '../src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// M-14 — 44pt
// ---------------------------------------------------------------------------

describe('M-14 — 누를 것은 전부 44pt 다', () => {
  it('슬롭 산수가 한 자리에 있고, 그 자리가 44 를 넘긴다', () => {
    // `slopTo` 가 틀리면 아래 모든 단정이 함께 틀린다. 그래서 먼저 그것부터.
    expect(line.meta + 2 * slopTo(line.meta)).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(32 + 2 * slopTo(32)).toBeGreaterThanOrEqual(TOUCH_TARGET);
    // 이미 44 를 채우는 상자에는 슬롭이 붙지 않는다 — 붙이면 이웃을 훔친다.
    expect(slopTo(TOUCH_TARGET)).toBe(0);
    expect(slopTo(TOUCH_TARGET + 10)).toBe(0);
  });

  function row(over: Partial<React.ComponentProps<typeof MessageRow>> = {}) {
    return render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[{emoji: '👍', count: 1, mine: false}]}
        nowMs={BASE_MS}
        actions={{
          myMemberId: SELF,
          onToggleReaction: async () => {},
          onEdit: async () => {},
          onDelete: async () => {},
          onOpenThread: () => {},
        }}
        {...over}
      />,
    );
  }

  it('반응 칩 — 세로만이 아니라 **가로도** 44 다 (감사: 슬롭 좌우 2 뿐이었다)', () => {
    row();
    const chip = screen.getByTestId('reaction-chip-👍');
    const style = flatten(chip.props.style);
    const s = slop(chip.props.hitSlop);
    expect(Number(style.minHeight) + s.top + s.bottom).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
    // 한 자리 숫자 반응 칩의 실제 폭은 글자에 달려 있으므로 **바닥**을 잰다:
    // 바닥이 44 를 채우면 어떤 이모지가 와도 채운다.
    expect(Number(style.minWidth) + s.left + s.right).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
  });

  it('답글 표식 — 29pt 였다', () => {
    row({
      message: message({rootId: 'root-1'} as Partial<Message>),
      replyParent: message({id: 'root-1', seq: 4}),
    });
    const marker = screen.getByTestId('reply-marker');
    const s = slop(marker.props.hitSlop);
    const label = flatten(
      screen.getByText(/답글$/).props.style,
    );
    expect(Number(label.lineHeight) + s.top + s.bottom).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
    expect(Number(label.minWidth) + s.left + s.right).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
  });

  it('스레드 롤업 — 29pt 였다', () => {
    row({rollup: {replyCount: 2, lastReplySeq: 12, lastReplyAtMs: BASE_MS}});
    const rollup = screen.getByTestId('thread-rollup');
    const s = slop(rollup.props.hitSlop);
    const label = flatten(screen.getByText(/답글 2개/).props.style);
    expect(Number(label.lineHeight) + s.top + s.bottom).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
  });

  it('행 오류 「닫기」 — 33pt 였다', async () => {
    // 오류 슬롯은 실패한 액션이 세운다. 반응 토글을 거절시켜 세운다.
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[{emoji: '👍', count: 1, mine: false}]}
        nowMs={BASE_MS}
        actions={{
          myMemberId: SELF,
          onToggleReaction: async () => {
            throw new Error('nope');
          },
          onEdit: async () => {},
          onDelete: async () => {},
        }}
      />,
    );
    fireEvent.press(screen.getByTestId('reaction-chip-👍'));
    await act(async () => {
      await Promise.resolve();
    });
    const dismiss = screen.getByTestId('message-action-error-dismiss');
    const s = slop(dismiss.props.hitSlop);
    const label = flatten(screen.getByText('닫기').props.style);
    expect(Number(label.lineHeight) + s.top + s.bottom).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
    expect(Number(label.minWidth) + s.left + s.right).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
  });
});

// ---------------------------------------------------------------------------
// M-12 — 낙관적 메아리의 여백
// ---------------------------------------------------------------------------

describe('M-12 — 낙관적 메아리도 같은 여백을 진다', () => {
  it('내가 방금 보낸 메시지만 화면 가장자리에 붙지 않는다', () => {
    render(
      <PendingRow pending={pending()} startsGroup directory={DIRECTORY} />,
    );
    const body = screen.getByText('보내는 중인 본문');
    // 본문에서 위로 올라가며 `SAFE_GUTTER` 를 문 그릇을 찾는다. 있으면 그 값이
    // 확정 행의 것과 같아야 한다 — 「같은 규율」이 이 단정의 전부다.
    interface Walkable {
      parent: Walkable | null;
      props: {style?: unknown};
    }
    let node: Walkable | null = body as unknown as Walkable;
    let gutter: number | undefined;
    while (node) {
      const style = flatten(node.props?.style);
      if (style.paddingHorizontal !== undefined) {
        gutter = Number(style.paddingHorizontal);
        break;
      }
      node = node.parent;
    }
    expect(gutter).toBe(SAFE_GUTTER);
  });

  it('시각 칸은 예약하지 않는다 — 이 행에는 시각이 없다', () => {
    // `WorkingRow` 가 이미 고른 규율. 없는 것을 위해 자리를 비우면 그것은
    // 예약이 아니라 그냥 여백이다.
    render(
      <PendingRow pending={pending()} startsGroup directory={DIRECTORY} />,
    );
    expect(screen.queryByTestId('row-time')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M-1 — 삭제 메시지 접기
// ---------------------------------------------------------------------------

describe('M-1 — 연달아 지워진 메시지가 한 줄로 접힌다', () => {
  const NO_EXTRAS = () => ({hasRollup: false, hasReactions: false});

  function deletedItem(
    seq: number,
    startsGroup: boolean,
  ): TimelineStreamItem {
    return {
      kind: 'message',
      key: `m-${seq}`,
      message: message({id: `m-${seq}`, seq, state: 'deleted', body: ''}),
      startsGroup,
    };
  }

  function liveItem(seq: number): TimelineStreamItem {
    return {
      kind: 'message',
      key: `m-${seq}`,
      message: message({id: `m-${seq}`, seq}),
      startsGroup: false,
    };
  }

  it('셋이 하나가 되고, 살아남은 행이 셋을 대신한다고 말한다', () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, false), deletedItem(3, false)],
      NO_EXTRAS,
    );
    expect(folded).toHaveLength(1);
    expect(folded[0].deletedRepeat).toBe(3);
  });

  it('묶음의 머리는 접지 않는다 — 접으면 「누가 지웠는가」가 사라진다', () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, true)],
      NO_EXTRAS,
    );
    expect(folded).toHaveLength(2);
    expect(folded[0].deletedRepeat).toBeUndefined();
  });

  it('살아 있는 메시지가 사이에 들어오면 「연달아」가 아니다', () => {
    const folded = foldDeletedRuns(
      [
        deletedItem(1, true),
        deletedItem(2, false),
        liveItem(3),
        deletedItem(4, false),
        deletedItem(5, false),
      ],
      NO_EXTRAS,
    );
    // 두 묶음이 각각 접히고, 사이의 살아 있는 행은 그대로 선다.
    expect(folded.map(i => (i as {deletedRepeat?: number}).deletedRepeat)).toEqual(
      [2, undefined, 2],
    );
  });

  it('구분선도 묶음을 끊는다', () => {
    const folded = foldDeletedRuns(
      [
        deletedItem(1, true),
        {kind: 'day', key: 'day-1', atMs: BASE_MS},
        deletedItem(2, false),
      ],
      NO_EXTRAS,
    );
    expect(folded).toHaveLength(3);
  });

  it('답글이 달린 묘비는 접지 않는다 — 문을 접어 없애는 일이 된다', () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, false), deletedItem(3, false)],
      item => ({hasRollup: item.message.seq === 2, hasReactions: false}),
    );
    // 1 은 혼자, 2 는 자기 자리를 지키고, 3 은 2 밑으로 접힌다.
    expect(folded).toHaveLength(2);
    expect(folded[0].deletedRepeat).toBeUndefined();
    expect(folded[1].deletedRepeat).toBe(2);
  });

  it('반응이 달린 묘비도 접지 않는다', () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, false)],
      item => ({hasRollup: false, hasReactions: item.message.seq === 2}),
    );
    expect(folded).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // H-1 — 접힌 행은 자기가 **누구를** 대신하는지 안다
  //
  // 개수만으로는 「이 행이 그 메시지를 대신한다」를 답할 수 없고, 그 질문에
  // 답하지 못한 것이 인용 점프의 거짓 안내였다.
  // -------------------------------------------------------------------------
  it('접힌 행이 자기가 흡수한 id 를 든다 — 자기 것은 빼고', () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, false), deletedItem(3, false)],
      NO_EXTRAS,
    );
    expect(folded[0].deletedFoldedIds).toEqual(['m-2', 'm-3']);
  });

  it('대신 서는 행을 id 로 되찾는다 — 대소문자를 접고, 없으면 -1', () => {
    const folded = foldDeletedRuns(
      [
        liveItem(1),
        deletedItem(2, true),
        deletedItem(3, false),
        deletedItem(4, false),
      ],
      NO_EXTRAS,
    );
    // `m-3` 은 목록에 자기 행이 없다. 그것을 대신해 서 있는 행은 `m-2` 다.
    expect(foldedStandInIndex(folded, 'M-3')).toBe(1);
    // 자기 행이 그대로 있는 것은 이 함수의 질문이 아니다(호출자의 findIndex).
    expect(foldedStandInIndex(folded, 'm-2')).toBe(-1);
    expect(foldedStandInIndex(folded, 'm-99')).toBe(-1);
  });

  it('행이 접힌 수를 화면에도 로터에도 말한다', () => {
    render(
      <MessageRow
        message={message({state: 'deleted', body: ''})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        deletedRepeat={3}
        nowMs={BASE_MS}
      />,
    );
    expect(screen.getByTestId('tombstone').props.children).toContain(
      '삭제된 메시지 3개',
    );
    expect(screen.getByTestId('message-row').props.accessibilityLabel).toContain(
      '삭제된 메시지 3개',
    );
  });

  it('접히지 않은 묘비는 세지 않는다 — 「1개」는 아무도 묻지 않았다', () => {
    render(
      <MessageRow
        message={message({state: 'deleted', body: ''})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    expect(screen.getByTestId('tombstone').props.children).not.toContain('개');
  });
});

// ---------------------------------------------------------------------------
// M-13 — hex 가 토큰을 우회하지 않는다
// ---------------------------------------------------------------------------

describe('M-13 — 색은 전부 토큰에서 나온다', () => {
  it('`src/` 어디에도 hex 리터럴이 없다 — `tokens.ts` 만 예외다', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      if (file.endsWith(path.join('design', 'tokens.ts'))) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const [index, text] of source.split('\n').entries()) {
        // 주석은 값이 아니다 — 이 저장소의 주석은 옛 값을 근거로 인용한다.
        if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
        if (/#[0-9a-fA-F]{3,8}['"]/.test(text)) {
          offenders.push(`${path.relative(SRC_DIR, file)}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('라이트 모드가 들어와도 깨지지 않을 이름들이다', () => {
    // M-13 이 말한 위험은 「값이 못생겼다」가 아니라 **「스킴이 하나 더 생기는
    // 순간 이 지점들이 전부 깨진다」** 였다. 그러니 단정은 이름이 존재하는지다.
    for (const name of [
      'accentSurface',
      'accentSurfaceStrong',
      'onAccent',
      'agentSurface',
      'warnSurface',
      'warnBorder',
      'onWarn',
      'dangerText',
      'scrim',
      'shadow',
    ] as const) {
      expect(typeof color[name]).toBe('string');
    }
  });

  it('danger 상자 안의 글자가 그 상자 위에서 AA 를 지난다', () => {
    expect(contrast(color.dangerText, color.dangerSurface)).toBeGreaterThanOrEqual(
      4.5,
    );
    // 그리고 그 값이 `danger` 보다 **밝다** — 상자 안의 글자는 상자 밖의 표식
    // (「전송 실패」 같은 한 낱말)보다 오래 읽히므로 한 단 올려 둔 것이다.
    // 두 값이 뒤집히면 상자 안이 상자 밖보다 어두워진다.
    expect(luminance(color.dangerText)).toBeGreaterThan(luminance(color.danger));
  });
});

// ---------------------------------------------------------------------------
// #1076 — 착지 틴트
// ---------------------------------------------------------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '').slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('#1076 — 인용 점프가 도착했다고 말한다', () => {
  function landedRow(landed: boolean) {
    return render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        landed={landed}
        nowMs={BASE_MS}
      />,
    );
  }

  it('도착한 행이 물든다', () => {
    const style = flatten(
      landedRow(true).getByTestId('message-row').props.style,
    );
    expect(style.backgroundColor).toBe(color.warnSurface);
  });

  it('도착하지 않은 행은 물들지 않는다', () => {
    const style = flatten(
      landedRow(false).getByTestId('message-row').props.style,
    );
    expect(style.backgroundColor).toBeUndefined();
  });

  it('틴트가 **그릇**에 있다 — 안쪽에 걸면 좌우 여백이 안 물든다', () => {
    const view = landedRow(true);
    const outer = flatten(view.getByTestId('message-row').props.style);
    const inner = flatten(view.getByTestId('message-press').props.style);
    expect(outer.backgroundColor).toBe(color.warnSurface);
    expect(inner.backgroundColor).toBeUndefined();
  });

  it('파랑이 아니다 — 폰에서 accent 는 「내가 한 것」이다', () => {
    // u44 직전 리뷰가 인용 레일에 대해 내린 판정과 같은 규칙이다: accent 는 이미
    // 보내기 버튼과 내 반응 칩의 뜻이므로 세 번째 뜻을 갖지 않는다. 착지에
    // `accentSurface` 를 쓰면 방금 점프해 온 행이 **내가 반응한 행**의 옷을 입는다.
    expect(color.warnSurface).not.toBe(color.accentSurface);
    expect(color.warnSurface).not.toBe(color.accent);
  });

  it('띠가 아니라 물듦이다 — 고도(`surface`)로 오해되지 않을 만큼만', () => {
    const tint = contrast(color.warnSurface, color.bg);
    // 배경과 구별은 되고(고도 한 단 1.084 보다 크다),
    expect(tint).toBeGreaterThan(contrast(color.surface, color.bg));
    // 같은 팔레트의 다른 부드러운 단들과 한 계단이다(카드가 되지 않는다).
    expect(tint).toBeLessThan(1.25);
    expect(tint).toBeLessThan(contrast(color.dangerSurface, color.bg) + 0.05);
  });

  // -------------------------------------------------------------------------
  // 목록까지 이어져 있는가 (단위가 아니라 배선)
  // -------------------------------------------------------------------------
  describe('목록이 실제로 그 표시를 세우고 거둔다', () => {
    const HISTORY = [
      message({id: 'm-1', seq: 1, body: '첫 줄'}),
      message({id: 'm-2', seq: 2, body: '가운데 줄'}),
      message({id: 'm-3', seq: 3, body: '마지막 줄'}),
    ];

    function tinted() {
      return screen
        .getAllByTestId('message-row')
        .filter(
          node => flatten(node.props.style).backgroundColor === color.warnSurface,
        );
    }

    it('점프한 행 하나만 물들고, 손가락이 닿으면 물러난다', async () => {
      const view = render(
        <Timeline
          messages={HISTORY}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={BASE_MS}
        />,
      );
      expect(tinted()).toHaveLength(0);

      await act(async () => {
        view.rerender(
          <Timeline
            messages={HISTORY}
            directory={DIRECTORY}
            status="ready"
            myMemberId={SELF}
            nowMs={BASE_MS}
            jumpTarget={{messageId: 'm-2', seq: 2, token: 1}}
          />,
        );
      });
      // **하나만.** 「방금 여기로 왔다」가 두 행에 있으면 그것은 표시가 아니다.
      expect(tinted()).toHaveLength(1);
      expect(within(tinted()[0]).getByText('가운데 줄')).toBeTruthy();

      // 사람이 화면을 다시 가져간다.
      await act(async () => {
        fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag', {
          nativeEvent: {
            contentOffset: {y: 0},
            contentSize: {height: 1000, width: 390},
            layoutMeasurement: {height: 800, width: 390},
          },
        });
      });
      expect(tinted()).toHaveLength(0);
    });

    it('목록이 연달아 지워진 행을 실제로 접는다', () => {
      render(
        <Timeline
          messages={[
            message({id: 'd-1', seq: 1, state: 'deleted', body: ''}),
            message({id: 'd-2', seq: 2, state: 'deleted', body: ''}),
            message({id: 'd-3', seq: 3, state: 'deleted', body: ''}),
          ]}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={BASE_MS}
        />,
      );
      // 세 줄이 아니라 한 줄이고, 그 한 줄이 셋을 말한다.
      expect(screen.getAllByTestId('tombstone')).toHaveLength(1);
      expect(screen.getByTestId('tombstone').props.children).toContain(
        '삭제된 메시지 3개',
      );
    });

    // -----------------------------------------------------------------------
    // H-1 (design-review U4-5) — 접기와 항법이 서로를 안다
    //
    // 첫 판에서 두 기계는 서로를 몰랐다: 삭제 원본을 가리키는 인용은 문이고, 그
    // 원본이 접히면 목록의 `findIndex` 가 빈손으로 돌아와 화면이 「위로 올려 이전
    // 대화를 더 불러오세요」라고 말했다 — 이미 로드돼 있고 접혀 있을 뿐인데.
    // 그 문장은 **사람이 해도 아무 일도 일어나지 않는 지시**다.
    //
    // 아래 둘은 그 배선을 잰다. 접기 단위 테스트도, 고지 문장 테스트도 이것을
    // 못 잡았던 이유는 결함이 **둘 사이**에 있었기 때문이다.
    // -----------------------------------------------------------------------
    describe('H-1 — 접힌 묘비를 겨눈 인용 점프', () => {
      /** 셋 연속 삭제 + 그중 가운데를 인용한 라이브 메시지. */
      const RUN_WITH_QUOTE = [
        message({id: 'd-1', seq: 1, state: 'deleted', body: ''}),
        message({id: 'd-2', seq: 2, state: 'deleted', body: ''}),
        message({id: 'd-3', seq: 3, state: 'deleted', body: ''}),
        message({id: 'm-9', seq: 9, body: '그 줄 말입니다', replyToId: 'd-2'}),
      ];

      /** 인용 블록이 **문**이 되려면 목록이 그 핸들러를 들고 있어야 한다. */
      const ACTIONS = {
        myMemberId: SELF,
        onToggleReaction: async () => {},
        onEdit: async () => {},
        onDelete: async () => {},
        onJumpToQuoted: () => {},
      };

      function jumpTo(
        messageId: string,
        seq: number | null,
      ): {missed: jest.Mock; landed: jest.Mock} {
        const missed = jest.fn();
        const landed = jest.fn();
        const props = {
          messages: RUN_WITH_QUOTE,
          directory: DIRECTORY,
          status: 'ready' as const,
          myMemberId: SELF,
          nowMs: BASE_MS,
          actions: ACTIONS,
          onJumpMissed: missed,
          onJumpLanded: landed,
        };
        const view = render(<Timeline {...props} />);
        act(() => {
          view.rerender(
            <Timeline {...props} jumpTarget={{messageId, seq, token: 1}} />,
          );
        });
        return {missed, landed};
      }

      it('거짓 지시를 하지 않는다 — 그 메시지는 이미 로드돼 있다', () => {
        const {missed, landed} = jumpTo('d-2', 2);
        // 이것이 결함이었다: 「위로 올려 이전 대화를 더 불러오세요」.
        expect(missed).not.toHaveBeenCalled();
        expect(landed).toHaveBeenCalled();
      });

      it('대신 서 있는 행에 착지하고, 그 행이 무엇을 포함하는지 말한다', () => {
        jumpTo('d-2', 2);
        const marks = tinted();
        expect(marks).toHaveLength(1);
        // 「삭제된 메시지 3개」 — 원본은 이 셋 안에 있고, 사람이 누른 인용 블록은
        // 이미 「삭제된 메시지」라고 말해 두었다. 없는 것을 있다고 하지 않는다.
        expect(
          within(marks[0]).getByTestId('tombstone').props.children,
        ).toContain('삭제된 메시지 3개');
      });

      it('라이브로 온 인용도 같은 문이다 — 상류에 가드가 없다', () => {
        // `m-9` 에는 `replyTo` 가 없다(실시간 프레임). 목록이 화면의 행에서 풀어
        // 주므로 블록은 `deleted` 가 되고 **문이 된다** — 어디에도 「접힌 대상은
        // 인용이 풀리지 않게 한다」는 가드가 없다. 그래서 이 경로도 같은 결함을
        // 밟았고, 같은 수리로 함께 낫는다. seq 는 `null` 이다(프레임이 안 나른다).
        const {missed, landed} = jumpTo('d-2', null);
        expect(screen.getByTestId('quote-block').props.accessibilityRole).toBe(
          'button',
        );
        expect(screen.getByTestId('quote-tombstone')).toBeTruthy();
        expect(missed).not.toHaveBeenCalled();
        expect(landed).toHaveBeenCalled();
      });

      it('진짜로 없는 것은 여전히 없다고 말한다', () => {
        // 접기가 항법을 삼키지 않는다. 로드 범위 밖은 그대로 고지가 뜬다.
        const {missed, landed} = jumpTo('m-없음', null);
        expect(missed).toHaveBeenCalledWith('unknown');
        expect(landed).not.toHaveBeenCalled();
      });
    });
  });

  it('사라짐이 타이머가 아니라 손가락이다', () => {
    // 웹은 1,600ms 타이머를 쓴다. 폰의 점프는 애니메이션이고 실패 시 한 번 더
    // 돌므로, 시한은 이동과 경주한다 — 그래서 기준을 바꿨다. 그 결정은 코드에
    // 있어야 하고, 이 단정이 그것이 되돌려지는 순간 말을 한다.
    const timeline = fs.readFileSync(
      path.resolve(SRC_DIR, 'features/conversation/Timeline.tsx'),
      'utf8',
    );
    const code = timeline
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/onScrollBeginDrag[\s\S]{0,400}setLandedId\(null\)/);
    // 타이머로 거두지 않는다.
    expect(code).not.toMatch(/setTimeout\([^)]*setLandedId/);
  });
});
