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
  deletedFoldLabel,
  DELETED_TOMBSTONE_COPY,
  foldDeletedRuns,
  foldedStandInIndex,
} from '@momo/core/features/timeline/deletedFold';
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
  // ## 이 블록은 이제 **코어를 부른다** (U4-6, #1102 승격 · #1100 이탈 1 종결)
  //
  // 규칙이 폰 로컬에 있던 동안 이 파일이 그 규칙의 유일한 가드였다. 규칙이
  // 코어로 올라갔으므로 코어 테스트가 규칙을 지키고, 여기 남는 질문은 하나다:
  // **이 클라가 그 정본을 실제로 소비하는가.** 그래서 임포트가 코어를 가리키고,
  // 아래 마지막 두 단정이 「폰 로컬 판이 남아 있지 않다」와 「대리 착지 계약이
  // 폰 화면에서도 그대로다」를 잰다.
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

  // -------------------------------------------------------------------------
  // U4-6 — 승격분 소비
  // -------------------------------------------------------------------------

  it('폰 로컬 판이 남아 있지 않다 — 정본은 하나다', () => {
    // 로컬 파일이 남으면 두 규칙이 공존하고, 갈라지는 쪽은 아무도 보고 있지
    // 않은 쪽이다. 소비처가 코어를 부르는지도 함께 본다 — 파일만 지우고 다른
    // 로컬 사본을 만드는 것으로는 이 단정을 통과하지 못한다.
    expect(
      fs.existsSync(path.resolve(SRC_DIR, 'features/conversation/deletedFold.ts')),
    ).toBe(false);
    const timeline = fs.readFileSync(
      path.resolve(SRC_DIR, 'features/conversation/Timeline.tsx'),
      'utf8',
    );
    expect(timeline).toContain(
      "from '@momo/core/features/timeline/deletedFold'",
    );
  });

  it('화면이 짓는 문장이 코어의 문장과 **같다**', () => {
    // 「문자열 동일성」을 눈이 아니라 함수로 잰다. 폰이 자기 파일에서 조사를
    // 붙이면 여기서 빨강이 된다.
    for (const count of [undefined, 1, 2, 3, 12] as const) {
      const view = render(
        <MessageRow
          message={message({state: 'deleted', body: ''})}
          startsGroup
          directory={DIRECTORY}
          chips={[]}
          deletedRepeat={count}
          nowMs={BASE_MS}
        />,
      );
      expect(view.getByTestId('tombstone').props.children).toContain(
        deletedFoldLabel(count),
      );
      view.unmount();
    }
    expect(deletedFoldLabel(undefined)).toBe(DELETED_TOMBSTONE_COPY);
  });

  it('대리 착지 계약이 그대로다 — 진짜 없는 것은 여전히 없다 (#1105 인계)', () => {
    // 승격이 되돌려서는 안 되는 자리. 둘 다 참이어야 하고, 하나만 참이면 이
    // 함수는 거짓말을 한다: ①접혀 들어간 것은 대신 서는 행을 답한다,
    // ②애초에 로드되지 않은 것은 **여전히 -1** 이다(그래야 화면의 「더 위쪽에
    // 있습니다」가 참인 자리에서만 뜬다).
    const folded = foldDeletedRuns(
      [deletedItem(2, true), deletedItem(3, false)],
      NO_EXTRAS,
    );
    expect(foldedStandInIndex(folded, 'm-3')).toBe(0);
    expect(foldedStandInIndex(folded, 'm-1000')).toBe(-1);
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

  it('`src/` 어디에도 사용자 문장 속 em-dash 가 없다 (u45 리뷰 M-2)', () => {
    // 리뷰가 둘을 셌다(`MessageRow.tsx:610`·`715`). 둘 다 이 배치 이전부터
    // 있던 것이라 「스윕」이 요청됐고, 스윕은 두 줄을 고치는 것이 아니라 **다시
    // 들어올 수 없게 하는 것**이다 — hex 를 잡은 위 단정과 같은 종류의 일이고,
    // 그래서 같은 자리에 산다.
    //
    // 판정 규칙(design-taste SKILL §Copy): 사용자에게 보이는 문자열에 `—`/`–`
    // 는 0 건. 이진값이다.
    //
    // 두 가지를 빼고 본다.
    //
    //   **주석.** 이 저장소의 주석은 한국어 산문이고 거기서 em-dash 는 옳은
    //   글자다. 화면에 나가지 않는다.
    //   **`console.*` 인자.** SKILL 이 스스로 「developer/diagnostic surfaces」를
    //   따로 두고, 그 문장을 읽는 사람은 개발자다. 지금 `src/push/` 에 셋 있고
    //   전부 `console.error` 다.
    const withoutProse = (source: string): string =>
      source
        // 블록 주석 — JSX 의 `{/* … */}` 도 여기서 걸린다.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // 줄 주석. `https://` 의 `//` 는 건드리지 않는다.
        .replace(/(?<!:)\/\/.*$/gm, '')
        .replace(/console\.(error|warn|log|info|debug)\([\s\S]*?\);/g, '');
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const code = withoutProse(fs.readFileSync(file, 'utf8'));
      for (const [index, text] of code.split('\n').entries()) {
        if (/[—–]/.test(text)) {
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

  it('「내가 한 것」의 옷이 아니다 — 폰에서 accent 는 그 뜻이다', () => {
    // u44 직전 리뷰가 인용 레일에 대해 내린 판정과 같은 규칙이다: accent 는 이미
    // 보내기 버튼과 내 반응 칩의 뜻이므로 세 번째 뜻을 갖지 않는다. 착지에
    // `accentSurface` 를 쓰면 방금 점프해 온 행이 **내가 반응한 행**의 옷을 입는다.
    //
    // 이 단정의 이름이 「파랑이 아니다」였다 (#1155 이전). 그때는 폰 accent 가
    // 파랑이라 착지 틴트가 그쪽으로 새면 **눈으로도** 보였고, 그래서 이름이 색을
    // 불렀다. 이제 accent 는 웹과 같은 호박이라 두 값은 이웃이고(OKLab 거리 0.047),
    // 새더라도 눈에는 잘 안 띈다 — 지키는 것이 색이 아니라 **뜻**이라는 사실이
    // 그만큼 더 중요해졌으므로 이름을 뜻으로 되돌린다. 단정은 그대로다.
    expect(color.warnSurface).not.toBe(color.accentSurface);
    expect(color.warnSurface).not.toBe(color.accent);
  });

  it('띠가 아니라 물듦이다 — 고도(`surface`)로 오해되지 않을 만큼만', () => {
    const tint = contrast(color.warnSurface, color.bg);
    // 배경과 구별은 되고(고도 한 단 1.100 보다 크다 — 이 순위가 #1164 에서 팔레트가
    // 웹으로 옮겨간 뒤에도 살아 있도록 여섯 상태 채움이 배경 대비 같은 걸음을 들고
    // 따라갔다),
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

// ---------------------------------------------------------------------------
// #1422 — 여러 줄 입력창은 전부 어절에서 끊는다 (design-review M2)
// ---------------------------------------------------------------------------

/**
 * 이 스윕이 **처음 쓰던 자**. 지워지지 않고 남아 있는 이유는 아래 red proof 다 —
 * 이 정규식이 무엇을 놓쳤는지가 값으로 남아 있어야 다음 사람이 「한 줄이면 되는데」
 * 하고 되돌리지 않는다.
 *
 * 게으른 `[\s\S]*?` 는 **첫 `>`** 에서 멈춘다. JSX 의 속성값은 화살표 함수를 흔히
 * 들고(`onChangeText={(t) => …}`), 그 `=>` 의 `>` 가 태그의 끝으로 읽힌다.
 */
const NAIVE_TAG = /<TextInput\b[\s\S]*?\/?>/g;

/**
 * `<Name …>` 여는 태그를 **통째로** 집는다.
 *
 * 태그의 끝은 「첫 `>`」가 아니라 **중괄호 밖·따옴표 밖·주석 밖의 `>`** 다. JSX 는
 * 모든 식을 `{}` 안에 넣으므로 깊이만 세면 화살표 함수(`=>`)도, 비교식도, 문자열
 * 안의 `>` 도 태그를 안 끊는다. 주석을 함께 건너뛰는 이유는 이 레포의 JSX 태그가
 * 속성 사이에 긴 한국어 주석을 들기 때문이다(폰 `Composer.tsx` 의 그 태그가
 * 스무 줄이다).
 *
 * 안 닫힌 태그는 **버린다**. 소스가 깨졌다는 뜻이고, 그때 스윕이 파일 끝까지를
 * 태그로 치면 없는 속성을 봤다고 말하게 된다.
 *
 * 안 보는 것 하나: `<TextInput<Props> …>` 같은 제네릭 인자. 이 클라에 그 모양은
 * 없고, 생기면 그때 각도 괄호 깊이가 이 함수에 들어온다.
 */
function openingTags(
  source: string,
  name: string,
): {tag: string; index: number}[] {
  const found: {tag: string; index: number}[] = [];
  for (const match of source.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    const from = match.index ?? 0;
    let i = from + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    while (i < source.length) {
      const c = source[i];
      if (quote !== null) {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) quote = null;
        i += 1;
        continue;
      }
      if (c === '/' && source[i + 1] === '/') {
        const nl = source.indexOf('\n', i);
        i = nl === -1 ? source.length : nl + 1;
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        const close = source.indexOf('*/', i + 2);
        i = close === -1 ? source.length : close + 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        i += 1;
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) {
        end = i + 1;
        break;
      }
      i += 1;
    }
    if (end !== -1) found.push({tag: source.slice(from, end), index: from});
  }
  return found;
}

describe('#1422 — 여러 줄 입력창의 줄바꿈 규칙은 전수다', () => {
  it('`multiline` 인 TextInput 은 하나도 빠짐없이 `hangul-word` 를 든다', () => {
    // 이 배치의 첫 판은 **허용목록**이었다: 컴포저 하나를 지목해 규칙을 재는
    // 단정. 그 모양의 문제는 §5.5 ② 가 이미 적어 뒀다 — 목록 밖은 측정되지
    // 않고, 목록 밖이 늘어난 것을 아무도 모른다. 실제로 리뷰가 하나를 더 찾았고
    // (`MessageEditorSheet`), 그것이 이 스윕이 있는 이유다.
    //
    // 잔량이 아니라 **0** 인 이유: 지금 이 클라의 여러 줄 입력창은 둘뿐이고
    // 둘 다 한국어 문장을 받는다. 기준선을 세우면 그 파일이 다음 사람에게
    // "여기까지는 괜찮다"고 거짓말한다.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      // `<TextInput … />` 한 덩어리씩. 여는 태그의 끝까지만 본다 — 그 「끝」을
      // 정규식이 아니라 `openingTags` 가 찾는 이유는 아래 red proof 에 있다.
      for (const {tag, index} of openingTags(source, 'TextInput')) {
        if (!/\bmultiline\b/.test(tag)) continue;
        if (/lineBreakStrategyIOS=["']hangul-word["']/.test(tag)) continue;
        const line = source.slice(0, index).split('\n').length;
        offenders.push(`${path.relative(SRC_DIR, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('스윕의 구멍 — 화살표 함수의 `>` 가 태그를 조기 종료하던 자리', () => {
    // 이 단정이 red proof 다. 픽스처 둘은 이 클라에 오늘 없는 모양이지만
    // **한 줄만 더 쓰면 생기는** 모양이고(`onChangeText={(t) => …}` 는 RN 의 기본
    // 어법이다), 옛 자로 재면 구멍이 두 방향으로 열린다:
    //
    //   ① 놓친다 — `multiline` 이 화살표 뒤에 있으면 태그가 `=>` 에서 끝나
    //      「여러 줄 입력창이 아니다」가 되고, 규칙 없는 상자가 조용히 통과한다.
    //      스윕이 0 을 내는데 0 이 아닌 판이라 **fail-unsafe** 쪽이다.
    //   ② 헛짚는다 — `hangul-word` 가 화살표 뒤에 있으면 규칙을 든 상자가
    //      위반으로 잡힌다. 이쪽은 시끄러울 뿐이지만 같은 원인이다.
    const missed = [
      '<TextInput',
      '  ref={inputRef}',
      '  onChangeText={(next: string) => setText(next)}',
      '  multiline',
      '/>',
    ].join('\n');
    const misjudged = [
      '<TextInput',
      '  multiline',
      '  onChangeText={(t) => set(t)}',
      '  lineBreakStrategyIOS="hangul-word"',
      '/>',
    ].join('\n');

    // 옛 자의 실측. 두 태그 다 `=>` 에서 잘린다.
    const naive = (source: string) =>
      Array.from(source.matchAll(NAIVE_TAG), m => m[0]);
    expect(naive(missed)[0]).toBe(
      '<TextInput\n  ref={inputRef}\n  onChangeText={(next: string) =>',
    );
    expect(/\bmultiline\b/.test(naive(missed)[0])).toBe(false);
    expect(
      /lineBreakStrategyIOS=["']hangul-word["']/.test(naive(misjudged)[0]),
    ).toBe(false);

    // 지금 자. 여는 태그가 통째로 잡히고, 두 판정이 다 뒤집힌다.
    const tagsOf = (source: string) =>
      openingTags(source, 'TextInput').map(t => t.tag);
    expect(tagsOf(missed)).toEqual([missed]);
    expect(tagsOf(misjudged)).toEqual([misjudged]);
    expect(/\bmultiline\b/.test(tagsOf(missed)[0])).toBe(true);
    expect(
      /lineBreakStrategyIOS=["']hangul-word["']/.test(tagsOf(misjudged)[0]),
    ).toBe(true);
  });

  it('태그 끝을 가리는 나머지 셋 — 문자열·주석·안 닫힌 태그', () => {
    // 화살표만 막으면 같은 구멍이 다른 이름으로 돌아온다. 셋 다 이 레포에 이미
    // 있는 모양이다: 속성값의 `>`(한국어 안내 문구가 화살표를 쓴다), 속성 사이의
    // 긴 주석(폰 `Composer.tsx` 의 그 태그가 스무 줄이다), 그리고 깨진 소스.
    const inString = '<TextInput placeholder="a > b" multiline />';
    expect(openingTags(inString, 'TextInput').map(t => t.tag)).toEqual([
      inString,
    ]);

    const inComment = [
      '<TextInput',
      '  // 다음 판에서 -> 로 바꾼다',
      '  multiline',
      '/>',
    ].join('\n');
    expect(openingTags(inComment, 'TextInput').map(t => t.tag)).toEqual([
      inComment,
    ]);

    // 안 닫힌 태그는 지어내지 않는다 — 파일 끝까지를 태그로 치면 그 뒤에 있는
    // 남의 속성을 이 태그의 것으로 읽는다.
    expect(openingTags('<TextInput multiline', 'TextInput')).toEqual([]);

    // 타입 자리의 `<TextInput …>` 은 태그가 아니지만 잡혀도 해가 없다: 속성이
    // 없으니 `multiline` 도 없다. 그 사실을 값으로 적어 둔다.
    const typePosition = 'const r = useRef<TextInput | null>(null);';
    expect(openingTags(typePosition, 'TextInput').map(t => t.tag)).toEqual([
      '<TextInput | null>',
    ]);
    expect(/\bmultiline\b/.test('<TextInput | null>')).toBe(false);
  });

  it('그 값의 정본은 `Sentence` 다 — 스윕이 문자열을 지어내지 않았는지 확인한다', () => {
    // 위 스윕은 정규식이라 값을 손으로 들 수밖에 없다. 그 손이 정본과 갈라지지
    // 않는지는 여기서 잰다: `atoms.tsx` 가 같은 값을 들고 있는가.
    const atoms = fs.readFileSync(
      path.resolve(SRC_DIR, 'design/atoms.tsx'),
      'utf8',
    );
    expect(atoms).toContain('lineBreakStrategyIOS="hangul-word"');
  });
});
