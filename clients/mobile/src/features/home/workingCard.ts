import type {Channel} from '@momo/core/lib/api';
import {
  byOldestTurn,
  isStaleSignal,
  type AgentWorkingSignal,
} from '@momo/core/features/agents/workingSignal';
import {
  agentLabel,
  agentTurnBadgeCopy,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
} from '@momo/core/features/agents/turnCopy';
import {
  channelLabelParts,
  idKey,
  memberNameParts,
  type Directory,
} from '@momo/core/features/workspace/directory';

// =============================================================================
// 홈 맨 위 「작업 중」 카드가 말하는 것 — 순수 함수 (DS2-3 #2715, ADR-0189 D1).
//
// 시안 A `.a-now`: 에이전트 사각 + 이름 + 「에이전트」 태그 + 오른쪽 「작업 중」,
// 그 아래 `#채널 · 한 줄`, 그 아래 세 칸 진행 막대. 에이전트 탭이 없어진 자리를
// 이 카드와 DM 섹션이 받는다(ADR-0189 결재 「에이전트 탭 홈 흡수」).
//
// ## 판정은 코어의 것이다
//
// 어떤 턴이 살아 있나(`isStaleSignal`, 90초), 어느 턴을 먼저 보이나
// (`byOldestTurn`), 무슨 낱말로 말하나(`agentTurnBadgeCopy` — `awaiting_approval`은
// 언제나 「승인 대기」이고 결코 「작업 중」이 아니다), 이름이 둘이면 핸들을 붙이나
// (`memberNameParts`). 이 파일은 그 답들을 카드 한 장의 모양으로 모을 뿐이다.
//
// ## 세 칸은 **관찰한 사실**이다 — 진척률이 아니다
//
// 신호에는 진척률이 없다. 시안의 「세 칸 중 두 칸」을 숫자로 박으면 무엇을 보든
// 같은 막대가 서고, 그것은 사람에게 거짓 진척을 보이는 장식이 된다. 그래서 세
// 칸은 이 폰이 **실제로 본** 턴의 단계다:
//
//   1  턴이 열렸다              — 레일이 이 턴을 봤다
//   2  에이전트가 글을 내고 있다  — 스트리밍된 한 줄(`headlines`)이 있다
//   3  사람의 결정을 기다린다     — 런이 `awaiting_approval`로 멈췄다
//
// 셋째 칸이 켜지면 카드의 오른쪽 낱말은 「승인 대기」다. 다음 수가 사람에게 넘어온
// 순간이 이 턴에서 폰이 볼 수 있는 가장 먼 단계라서 그 칸이 끝에 있다.
// =============================================================================

export type WorkingStep = 1 | 2 | 3;

/** 세 칸 각각의 이름. 보조기술이 막대 대신 이것을 읽는다. */
export const WORKING_STEP_LABELS: Readonly<Record<WorkingStep, string>> = {
  1: '시작함',
  2: '답을 쓰는 중',
  3: '결정을 기다림',
};

export interface WorkingCardModel {
  /** 카드가 보이는 턴의 에이전트. */
  memberId: string;
  /** 표시 이름. 이름이 둘이면 핸들이 따로 선다(`handle`). */
  name: string;
  handle: string | null;
  /** 누르면 열 대화. */
  channelId: string;
  /** `#agent-lab`처럼 읽히는 자리 이름. 명부·채널 목록이 못 대면 null. */
  place: string | null;
  /** 대화 머리에 넘길 제목 — 목록 행과 같은 낱말. */
  conversationTitle: string;
  /** 에이전트가 낸 마지막 한 줄. 아직 없으면 null — 지어내지 않는다. */
  headline: string | null;
  /** 오른쪽 낱말: 「작업 중」 또는 「승인 대기」. 코어 문자열. */
  liveText: string;
  state: AgentWorkingSignal['state'];
  step: WorkingStep;
  /** 이 카드가 보이지 않는 나머지 열린 턴 수. */
  others: number;
  /** 실시간 레일이 붙어 있나. 끊겼으면 카드가 그것을 말한다. */
  live: boolean;
  /** 카드 전체를 한 문장으로. */
  accessibilityLabel: string;
}

/** 관찰한 사실에서 단계를 고른다(파일 머리 주석). */
export function workingStep(turn: AgentWorkingSignal): WorkingStep {
  if (turn.state === 'awaiting_approval') return 3;
  return turn.headlines.length > 0 ? 2 : 1;
}

/**
 * 카드 한 장, 또는 열린 턴이 없으면 null.
 *
 * 여러 턴이 열려 있으면 **가장 오래된 하나**를 보이고 나머지는 수로 센다 — 한 줄만
 * 보이는 표면이 가장 오래 달린 턴을 보이는 코어 규칙(`byOldestTurn`)과 같다.
 */
export function buildWorkingCard({
  signals,
  nowMs,
  directory,
  channels,
  selfMemberId,
  live,
}: {
  signals: ReadonlyMap<string, AgentWorkingSignal>;
  nowMs: number;
  directory: Directory;
  /** 공개·비공개·DM 전부 — 턴은 어느 대화에서든 열린다. */
  channels: readonly Channel[];
  selfMemberId: string;
  live: boolean;
}): WorkingCardModel | null {
  const open = [...signals.values()]
    .filter(signal => !isStaleSignal(signal, nowMs))
    .sort(byOldestTurn);
  const turn = open[0];
  if (turn === undefined) return null;

  const parts = memberNameParts(directory, turn.memberId, UNKNOWN_AGENT_NAME);
  const nameFor = (memberId: string) =>
    memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME);
  const copy = agentTurnBadgeCopy([turn], nameFor);
  // `open` 이 비지 않았으므로 코어는 null 을 주지 않는다.
  const liveText = copy?.text ?? '작업 중';

  const channel = channels.find(
    candidate => idKey(candidate.id) === idKey(turn.channelId),
  );
  let place: string | null = null;
  let conversationTitle = '대화';
  if (channel) {
    const label = channelLabelParts(channel, directory, selfMemberId);
    const text = label.handle ? `${label.text} ${label.handle}` : label.text;
    place = channel.kind === 'dm' ? text : `#${text}`;
    conversationTitle = text;
  }

  const headline = turn.headlines[0] ?? null;
  const step = workingStep(turn);
  const others = open.length - 1;

  const sentence = [
    `에이전트 ${agentLabel(parts)}`,
    liveText,
    place,
    headline,
    `진행 ${step}/3, ${WORKING_STEP_LABELS[step]}`,
    others > 0 ? `그 밖에 열린 작업 ${others}건` : null,
    live ? null : TURN_STALE_SENTENCE,
  ]
    .filter((piece): piece is string => piece !== null && piece !== '')
    .join(', ');

  return {
    memberId: turn.memberId,
    name: parts.name,
    handle: parts.handle ?? null,
    channelId: turn.channelId,
    place,
    conversationTitle,
    headline,
    liveText,
    state: turn.state,
    step,
    others,
    live,
    accessibilityLabel: sentence,
  };
}
