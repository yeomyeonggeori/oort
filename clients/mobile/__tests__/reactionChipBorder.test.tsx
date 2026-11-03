import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React from 'react';

import {cleanup, render, screen, within} from './fixtures/darkWorld';
import {color} from '../src/design/tokens';
import {MessageRow} from '../src/features/conversation/MessageRow';

// =============================================================================
// 반응 칩 테두리 규칙 (#4879, owner 2026-10-31 — 웹 `ReactionChips`와 같은 말, Buzz 기준)
//
// 내 칩은 1px 강조(`accent`) 테두리 + 강조 바탕 + 강조색 숫자, 남의 칩은 테두리 없음 + 흐린 바탕 +
// `textMuted` 숫자. 「테두리 없음」은 폭 1 을 **투명**으로 두는 것이라 두 상태의 상자가 같다 —
// 눌러서 바뀌어도 이웃 칩이 밀리지 않는다. 옛 규칙(내 것은 테두리 없음, 남의 것은 `border` 테두리)의
// 정반대이므로, 그쪽으로 되돌아가면 아래 단정이 읽은 값으로 붉어진다.
//
// 단정은 그려진 트리의 **스타일 값**을 읽는다(소스 문자열 매칭이 아니다). 폰에는 기계적 디자인
// 프리플라이트가 없다 — 이 시험이 그 자리에서 읽는 값은 테두리 색·폭, 바탕, 숫자 색, 상자 치수뿐이고,
// 캡처·실기기 인상은 스택 검증이 본다.
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

function message(): Message {
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
  };
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

afterEach(cleanup);

function renderChips() {
  render(
    <MessageRow
      message={message()}
      startsGroup
      directory={DIRECTORY}
      chips={[
        {emoji: '👍', count: 2, mine: true},
        {emoji: '🎉', count: 12, mine: false},
      ]}
      nowMs={BASE_MS}
      actions={{
        myMemberId: SELF,
        onToggleReaction: async () => {},
        onEdit: async () => {},
        onDelete: async () => {},
        onOpenThread: () => {},
      }}
    />,
  );
  const mine = screen.getByTestId('reaction-chip-👍');
  const other = screen.getByTestId('reaction-chip-🎉');
  return {
    mine,
    other,
    mineStyle: flatten(mine.props.style),
    otherStyle: flatten(other.props.style),
    mineCount: flatten(within(mine).getByText('2').props.style),
    otherCount: flatten(within(other).getByText('12').props.style),
  };
}

describe('반응 칩 테두리 규칙 (#4879): 내 것은 강조 테두리, 남의 것은 테두리 없음', () => {
  it('내 칩: 1px 강조 테두리 + 강조 바탕 + 강조색 숫자, 선택 상태', () => {
    const {mine, mineStyle, mineCount} = renderChips();
    expect(mineStyle.borderWidth).toBe(1);
    expect(mineStyle.borderColor).toBe(color.accent);
    expect(mineStyle.borderColor).not.toBe('transparent');
    expect(mineStyle.backgroundColor).toBe(color.accentSurface);
    expect(mineCount.color).toBe(color.accentText);
    expect(mine.props.accessibilityState).toMatchObject({selected: true});
  });

  it('남의 칩: 테두리 없음(투명) + 흐린 바탕 + textMuted 숫자, 선택 아님', () => {
    const {other, otherStyle, otherCount} = renderChips();
    // 「테두리 없음」 = 보이는 테두리 색이 없다. 폭은 남겨 상자가 내 칩과 같다(아래 시험).
    expect(otherStyle.borderColor).toBe('transparent');
    expect(otherStyle.borderColor).not.toBe(color.border);
    expect(otherStyle.borderColor).not.toBe(color.accent);
    expect(otherStyle.backgroundColor).toBe(color.surfaceMuted);
    expect(otherCount.color).toBe(color.textMuted);
    expect(other.props.accessibilityState).toMatchObject({selected: false});
  });

  it('두 상태의 상자는 같다: 폭·최소 크기·안쪽 여백이 같아 눌러 바꿔도 이웃이 밀리지 않는다', () => {
    const {mineStyle, otherStyle} = renderChips();
    const boxKeys = [
      'borderWidth',
      'borderRadius',
      'minHeight',
      'minWidth',
      'paddingHorizontal',
      'paddingVertical',
      'gap',
    ];
    // jest 의 expect 는 메시지 인자를 받지 않는다 — 어긋난 키 이름이 실패 메시지에 보이도록 목록을 비교한다.
    expect(boxKeys.filter(key => mineStyle[key] === undefined)).toEqual([]);
    expect(
      boxKeys.filter(key => mineStyle[key] !== otherStyle[key]),
    ).toEqual([]);
  });
});
