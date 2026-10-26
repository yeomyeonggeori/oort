import {activityDetail, activityLines} from '@momo/core/features/agents/turnCopy';
import {elapsedLabel, type AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory, memberNameParts} from '@momo/core/features/workspace/directory';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet, Text, View} from 'react-native';

import {AgentActivityBar, reserveClockDigits, reserveTickingDigits} from '../src/features/agents/turnSurfaces';

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

/** 「동작 줄이기」의 첫 답(비동기)을 `act` 안에서 흘려보낸다 — 「일하는 턴」 줄의 점(`RespondingDots`)이 그 답을 받아 다시 그린다. */
const settleReduceMotion = () =>
  act(async () => {
    await Promise.resolve();
  });

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
async function tickingTexts(turns: readonly AgentWorkingSignal[], fromMs: number) {
  render(bar(turns, fromMs));
  await settleReduceMotion();
  const before = screen.UNSAFE_getAllByType(Text).map(textOf);
  screen.rerender(bar(turns, fromMs + 1_000));
  const nodes = screen.UNSAFE_getAllByType(Text);
  // 구조가 같아야 같은 자리끼리 비교할 수 있다 — 시계 한 칸으로 글자 노드가 생기거나 사라지면 이 시험이 잘못 읽는다.
  expect(nodes).toHaveLength(before.length);
  return nodes.filter((node, index) => textOf(node) !== before[index]);
}

beforeEach(() => {
  // 「일하는 턴」 줄에는 답하는 중 점(`RespondingDots`)이 선다. 동작 줄이기의 첫 답은 비동기라, 모르는 채로 시험이 끝나면 답이 **환경이 내려간 뒤** 와서 점 애니메이션을
  // 시작하고 그 시계가 죽은 렌더러를 건드려 워커가 죽는다. 켜짐으로 고정하면 점은 멈춘 채 서고 시계가 생기지 않는다 — 이 파일이 재는 것(글자 폭)과 무관하다.
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('활동 줄의 매초 바뀌는 글자는 같은 폭의 숫자를 쓴다 (#4613)', () => {
  it('대기 중 실행의 「N초째」 근거 글: 1초 사이에 달라지는 글자가 실제로 있고(대조), 그것들은 모두 tabular-nums 다', async () => {
    const changed = await tickingTexts([QUEUED], NOW + 12_000);
    // 양성 대조: 이 시험이 아무것도 안 고르고 통과하는 길을 막는다 — 근거 글 노드가 달라진 글자로 뽑혀야 한다.
    const detail = screen.getByTestId('activity-detail');
    // `changed` 는 복합 컴포넌트(`Text`)이고 `getByTestId` 는 호스트 노드라 같은 객체가 아니다 — 같은 글자인지는 testID 로 가린다.
    expect(changed.map(node => node.props.testID)).toContain('activity-detail');
    expect(textOf(detail)).toContain('13초째');
    for (const node of changed) {
      expect(styleOf(node).fontVariant).toEqual(expect.arrayContaining(['tabular-nums']));
    }
  });

  it('일하는 턴의 시계(「2m 05s」): 1초 사이에 달라지는 글자가 실제로 있고(대조), 그것도 tabular-nums 다', async () => {
    const changed = await tickingTexts([WORKING], NOW + 125_000);
    // 시계 노드는 시계 자신의 글(`m`·`s` 가 든 것)이다 — 달라진 글자 중에 그 글이 있어야 한다.
    const clock = changed.filter(node => /\d+m \d{2}s$/.test(textOf(node)));
    expect(clock).toHaveLength(1);
    expect(textOf(clock[0])).toBe('2m 06s');
    for (const node of changed) {
      expect(styleOf(node).fontVariant).toEqual(expect.arrayContaining(['tabular-nums']));
    }
  });

  it('대조: 1초가 가도 글자가 안 바뀌는 글자(이름·단계)는 이 규칙의 대상이 아니다 — 시험이 모든 글자를 싸잡지 않는다', async () => {
    const changed = await tickingTexts([QUEUED], NOW + 12_000);
    const all = screen.UNSAFE_getAllByType(Text);
    // 달라진 글자는 전체의 일부일 뿐이다(이름 줄·「중단/취소」 글자는 그대로).
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(all.length);
  });
});

// =============================================================================
// 숫자 칸 폭을 두 자리로 예약한다 (#4613 결정 1)
//
// `tabular-nums` 뒤에도 남은 것: 숫자가 한 자리에서 두 자리로 넘어가는 순간(9→10초) 글자가 한 자리만큼 길어져, 375pt·글자 ×1.118 의 「grok … 앞에 2건」이 첫 1분에 한 번
// 한 줄→두 줄로 뒤집혔다(`measure/activityRows.tsx` 높이 표). 수리는 보이는 글에서 한 자리 숫자 앞에 숫자 폭 공백(U+2007)을 하나 두는 것이다.
//
// 제스트는 레이아웃이 없어 폭을 못 잰다. 그래서 이 시험은 **폭의 서명**을 잠근다: 숫자(와 숫자 폭 공백)는 `D`, 한글 음절은 `H` — tabular-nums 에서 같은 서명은 같은 폭이다.
// 「숫자 폭 공백이 실제로 숫자와 같은 폭인가」는 글꼴의 일이라 제스트가 증명하지 못한다: 그 증거는 시뮬레이터 높이 표(`measure/activity-rows.mjs`, PR 본문)다.
// =============================================================================

const FIGURE_SPACE = '\u2007';
/** 폭의 서명: 숫자·숫자 폭 공백 → D, 한글 음절 → H. 나머지(공백·가운뎃점·영문)는 그대로. */
const widthSignature = (text: string): string => text.replace(/[\d\u2007]/g, 'D').replace(/[가-힣]/g, 'H');

/** 코어가 만든 근거 글 그대로(숫자 폭을 잡기 전) — 시험의 양성 대조. */
function rawDetail(turn: AgentWorkingSignal, nowMs: number): string {
  const {lines} = activityLines([turn], id => memberNameParts(DIRECTORY, id, '에이전트'));
  return activityDetail(lines[0], nowMs) as string;
}

/** 실행기가 일을 시작해 진행 중이고 마지막 보고가 방금인 run — 근거 글이 「N초째 · 마지막 보고 M초 전」이라 매초 바뀌는 숫자가 둘이다. */
const RUNNING: AgentWorkingSignal = {
  memberId: AGENT,
  channelId: CHANNEL,
  state: 'working',
  source: 'run',
  runId: 'B3333333-3333-4333-8333-B33333333333',
  headlines: [],
  lastActivityAtMs: NOW,
  startedAtMs: NOW,
  server: {phase: 'running', leaseState: 'live', queuedAtMs: NOW - 5_000, claimedAtMs: NOW - 4_000, startedAtMs: NOW, lastEventAtMs: NOW},
};

/** 한 번 그리고 시계만 옮겨 가며(`rerender`) 그려진 근거 글을 시각마다 모은다. */
async function detailTexts(ticksMs: readonly number[], turn: AgentWorkingSignal = QUEUED): Promise<string[]> {
  render(bar([turn], NOW));
  await settleReduceMotion();
  return ticksMs.map(tick => {
    screen.rerender(bar([turn], NOW + tick));
    return textOf(screen.getByTestId('activity-detail'));
  });
}

describe('활동 줄은 바뀌는 숫자의 폭을 두 자리로 예약한다 (#4613)', () => {
  it('양성 대조: 코어 원문은 9초와 10초에서 폭이 다르다(그래서 수리가 필요하다)', () => {
    const nine = widthSignature(rawDetail(QUEUED, NOW + 9_000));
    const ten = widthSignature(rawDetail(QUEUED, NOW + 10_000));
    expect(nine).not.toBe(ten);
    // 분도 같다: 「9분째」→「10분째」, 그리고 「59초째」→「1분째」는 한 글자(숫자)가 줄어든다.
    expect(widthSignature(rawDetail(QUEUED, NOW + 59_000))).not.toBe(widthSignature(rawDetail(QUEUED, NOW + 60_000)));
    expect(widthSignature(rawDetail(QUEUED, NOW + 9 * 60_000))).not.toBe(widthSignature(rawDetail(QUEUED, NOW + 10 * 60_000)));
  });

  it('1초부터 59분까지 그려진 근거 글의 폭 서명은 하나다 — 매초·매분 바뀌어도 줄 수가 뒤집힐 폭 변화가 없다', async () => {
    const ticks: number[] = [];
    for (let second = 1; second <= 59; second += 1) ticks.push(second * 1_000);
    for (let minute = 1; minute <= 4; minute += 1) ticks.push(minute * 60_000 + 30_000); // 5분을 넘으면 낱말이 「아직 받지 않았어요」로 바뀐다 — 근거 글은 같다.
    ticks.push(9 * 60_000, 10 * 60_000, 59 * 60_000);
    const signatures = new Set((await detailTexts(ticks)).map(widthSignature));
    expect([...signatures]).toHaveLength(1);
  });

  it('한 자리 숫자 앞에만 공백이 선다: 5초째는 두 칸, 12초째는 그대로', async () => {
    const [five, twelve, oneMinute] = await detailTexts([5_000, 12_000, 60_000]);
    expect(five).toContain(`${FIGURE_SPACE}5초째 기다려요`);
    expect(twelve).toContain('12초째 기다려요');
    expect(twelve).not.toContain(FIGURE_SPACE);
    // 분: 「 1분째」는 59초째와 같은 두 칸.
    expect(oneMinute).toContain(`${FIGURE_SPACE}1분째 기다려요`);
  });

  it('진행 중인 run 의 「N초째 · 마지막 보고 M초 전」은 두 숫자가 모두 두 칸이다', async () => {
    const shown = await detailTexts([1_000, 5_000, 9_000, 10_000, 30_000, 59_000], RUNNING);
    // 양성 대조: 같은 근거 글의 코어 원문은 서명이 하나가 아니다.
    const raw = new Set([1_000, 9_000, 10_000, 59_000].map(tick => widthSignature(rawDetail(RUNNING, NOW + tick))));
    expect(raw.size).toBeGreaterThan(1);
    expect(new Set(shown.map(widthSignature)).size).toBe(1);
    expect(shown[1]).toBe(`${FIGURE_SPACE}5초째 · 마지막 보고 ${FIGURE_SPACE}5초 전`);
  });

  it('시계(「5s」): 1초 사이에 바뀌는 글자가 0…59초에서 한 폭이다', async () => {
    const signatures = new Set<string>();
    const raw = new Set<string>();
    for (let second = 0; second <= 59; second += 1) {
      raw.add(widthSignature(elapsedLabel(NOW, NOW + second * 1_000)));
      signatures.add(widthSignature(reserveClockDigits(elapsedLabel(NOW, NOW + second * 1_000))));
    }
    expect(raw.size).toBeGreaterThan(1); // 양성 대조: 「9s」와 「10s」
    expect([...signatures]).toHaveLength(1);
    // 그려진 시계도 그 글이다.
    render(bar([WORKING], NOW + 5_000));
    await settleReduceMotion();
    const clock = screen.UNSAFE_getAllByType(Text).filter(node => /^[\d\u2007]+s$/.test(textOf(node)));
    expect(clock).toHaveLength(1);
    expect(textOf(clock[0])).toBe(`${FIGURE_SPACE}5s`);
  });

  it('건드리지 않는 글: 두 자리 숫자·시간·건수·「방금」·분 이상의 시계는 그대로이고, 두 번 입혀도 같다', () => {
    for (const same of ['17시간째 기다려요', '12분째 · 마지막 보고 11분 전', '에이전트 앞에 2건', '방금 들어왔어요', '3시간 전에 가져감']) {
      expect(reserveTickingDigits(same)).toBe(same);
    }
    for (const same of ['2m 05s', '12m 03s', '1h 04m', '10s', '59s']) expect(reserveClockDigits(same)).toBe(same);
    const once = reserveTickingDigits('깨웠지만 아직 안 가져감 · 5초째 기다려요 · 에이전트 앞에 2건');
    expect(once).toBe(`깨웠지만 아직 안 가져감 · ${FIGURE_SPACE}5초째 기다려요 · 에이전트 앞에 2건`);
    expect(reserveTickingDigits(once)).toBe(once);
    expect(reserveTickingDigits('1분 전에 가져감')).toBe(`${FIGURE_SPACE}1분 전에 가져감`);
    expect(reserveClockDigits('5s')).toBe(`${FIGURE_SPACE}5s`);
  });
});
