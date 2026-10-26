import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {AgentActivityBar} from '../src/features/agents/turnSurfaces';

// =============================================================================
// 활동 줄의 「N초째」·시계는 바뀌는 동안 같은 폭이다 (#4613)
//
// 실기 보고: 「채팅 진입 및 작성 초반에 진동이 반복」. 대기 중인 실행이 있는 DM 은 **첫 1분 동안 매초** 「N초째 기다려요」가 바뀐다. 활동 줄은 줄바꿈이 되는 줄
// (`flexWrap`)이고 근거 글은 그 안에서 줄어드는 글자라서, 글자 폭이 줄바꿈 경계를 넘나들면 줄 수가 한 줄↔두 줄로 뒤집히고 도크가 그만큼 자라고 줄어 대화가 같은 양만큼
// 오르내린다(시뮬레이터 실측: 375pt·글자 ×1.118·「grok … 앞에 2건」에서 첫 1분에 11번·26pt씩, `measure/activityRows.tsx` 의 높이 표). 숫자 글리프가 가변폭(「1」은 좁고
// 「4」·「8」은 넓다)이라 **같은 자릿수끼리도** 폭이 달랐던 것이 원인이다. 디자인 시스템은 이미 「숫자는 `tabular-nums` 항상」이라고 하고 폰 12곳이 그렇게 쓰는데 이 줄만 빠져 있었다.
//
// 제스트에는 레이아웃이 없어 줄 수를 못 잰다(그 숫자는 시뮬레이터의 높이 표가 증거다). 이 파일은 **그 원인을 막는 메커니즘**을 잠근다: 시계가 1초 가면 **글자가 달라지는 모든 글자**가
// 같은 폭의 숫자를 쓴다. 「달라지는 글자」를 이름이 아니라 실제로 두 번 그려 비교해서 고르므로, 앞으로 이 줄에 매초 바뀌는 글자가 더해져도 같은 규칙에 걸린다.
// =============================================================================

const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CHANNEL = 'cccccccc-1111-4111-8111-cccccccccccc';
const NOW = 1_760_000_000_000;

const DIRECTORY = makeDirectory([
  {
    id: AGENT,
    workspaceId: 'ws',
    kind: 'agent',
    status: 'active',
    displayName: 'grok',
    handle: 'grok',
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember,
]);

/** 방금 대기에 든 사람 요청 — 첫 1분 동안 「N초째 기다려요 · 에이전트 앞에 2건」이 매초 바뀐다. */
const QUEUED: AgentWorkingSignal = {
  memberId: AGENT,
  channelId: CHANNEL,
  state: 'queued',
  source: 'run',
  runId: 'A2222222-2222-4222-8222-A22222222222',
  headlines: [],
  lastActivityAtMs: NOW,
  server: {phase: 'queued', leaseState: 'none', queuePosition: 1, aheadTotal: 2, queuedAtMs: NOW},
};

/** 레일이 본 일하는 턴 — 서버 근거 글이 없어서 줄 끝에 「2m 05s」 시계가 선다(매초 바뀐다). */
const WORKING: AgentWorkingSignal = {
  memberId: AGENT,
  channelId: CHANNEL,
  state: 'working',
  source: 'status',
  headlines: [],
  lastActivityAtMs: NOW,
  startedAtMs: NOW,
};

function bar(turns: readonly AgentWorkingSignal[], nowMs: number) {
  return (
    <AgentActivityBar
      turns={turns}
      directory={DIRECTORY}
      nowMs={nowMs}
      live
      renderStop={() => <View testID="stop-slot" />}
    />
  );
}

type Rendered = ReturnType<typeof screen.UNSAFE_getAllByType>[number];

/** 글자 노드의 보이는 글(중첩 `Text` 까지 이어 붙인다). */
function textOf(node: Rendered): string {
  const walk = (child: unknown): string => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (Array.isArray(child)) return child.map(walk).join('');
    if (child !== null && typeof child === 'object' && 'props' in (child as object)) {
      return walk((child as {props: {children?: unknown}}).props.children);
    }
    return '';
  };
  return walk(node.props.children);
}

const styleOf = (node: Rendered) => (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<string, unknown>;

/** 같은 줄을 시계만 1초 옮겨 두 번 그려서 **글자가 달라진 글자 노드**를 고른다. */
function tickingTexts(turns: readonly AgentWorkingSignal[], fromMs: number) {
  render(bar(turns, fromMs));
  const before = screen.UNSAFE_getAllByType(Text).map(textOf);
  screen.rerender(bar(turns, fromMs + 1_000));
  const nodes = screen.UNSAFE_getAllByType(Text);
  // 구조가 같아야 같은 자리끼리 비교할 수 있다 — 시계 한 칸으로 글자 노드가 생기거나 사라지면 이 시험이 잘못 읽는다.
  expect(nodes).toHaveLength(before.length);
  return nodes.filter((node, index) => textOf(node) !== before[index]);
}

afterEach(() => {
  cleanup();
});

describe('활동 줄의 매초 바뀌는 글자는 같은 폭의 숫자를 쓴다 (#4613)', () => {
  it('대기 중 실행의 「N초째」 근거 글: 1초 사이에 달라지는 글자가 실제로 있고(대조), 그것들은 모두 tabular-nums 다', () => {
    const changed = tickingTexts([QUEUED], NOW + 12_000);
    // 양성 대조: 이 시험이 아무것도 안 고르고 통과하는 길을 막는다 — 근거 글 노드가 달라진 글자로 뽑혀야 한다.
    const detail = screen.getByTestId('activity-detail');
    expect(changed).toContain(detail);
    expect(textOf(detail)).toContain('13초째');
    for (const node of changed) {
      expect(styleOf(node).fontVariant).toEqual(expect.arrayContaining(['tabular-nums']));
    }
  });

  it('일하는 턴의 시계(「2m 05s」): 1초 사이에 달라지는 글자가 실제로 있고(대조), 그것도 tabular-nums 다', () => {
    const changed = tickingTexts([WORKING], NOW + 125_000);
    // 시계 노드는 시계 자신의 글(`m`·`s` 가 든 것)이다 — 달라진 글자 중에 그 글이 있어야 한다.
    const clock = changed.filter(node => /\d+m \d{2}s$/.test(textOf(node)));
    expect(clock).toHaveLength(1);
    expect(textOf(clock[0])).toBe('2m 06s');
    for (const node of changed) {
      expect(styleOf(node).fontVariant).toEqual(expect.arrayContaining(['tabular-nums']));
    }
  });

  it('대조: 1초가 가도 글자가 안 바뀌는 글자(이름·단계)는 이 규칙의 대상이 아니다 — 시험이 모든 글자를 싸잡지 않는다', () => {
    const changed = tickingTexts([QUEUED], NOW + 12_000);
    const all = screen.UNSAFE_getAllByType(Text);
    // 달라진 글자는 전체의 일부일 뿐이다(이름 줄·「중단/취소」 글자는 그대로).
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(all.length);
  });
});
