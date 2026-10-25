import type {AgentLiveness, Channel} from '@momo/core/lib/api';
import {
  isSystemRun,
  queuedWaitCopy,
} from '@momo/core/features/agents/runWaiting';
import {
  byOldestTurn,
  isStaleSignal,
  type AgentWorkingSignal,
} from '@momo/core/features/agents/workingSignal';
import {
  activityDetail,
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
//
// ## 「누가 기다리는 일」만 싣는다 (#4285)
//
// 부른 사람이 없는 시스템 작업(환영 run, `ServerRunFacts.system`)은 카드에 싣지 않는다.
// 성재 2026-10-23: 새 멤버가 들어올 때 서버가 만든 환영 작업이 「대기 1번째 · 5시간째
// 기다려요」로 홈에 떠 있었다 — 아무도 부르지 않은 일을 사람은 자기가 기다리는 줄 안다.
// 사람이 부른 요청이 아무에게도 가져가지 않은 채 오래 머물면 낱말이 「아직 받지 않았어요」로
// 바뀌고(`runWaiting`) 카드가 「취소」를 낸다.
// =============================================================================

export type WorkingStep = 0 | 1 | 2 | 3;

/** 세 칸 각각의 이름. 보조기술이 막대 대신 이것을 읽는다. */
export const WORKING_STEP_LABELS: Readonly<Record<WorkingStep, string>> = {
  // 아무도 시작하지 않은 run(ADR-0200): 막대는 한 칸도 켜지 않는다. 「시작함」은 거짓이다.
  0: '아직 시작 전',
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
  /** 오른쪽 낱말: 「작업 중」·「승인 대기」, 서버가 알린 대기 순번·「가져감」. 코어 문자열. */
  liveText: string;
  /** 서버가 아는 run의 근거 한 줄(「11분째 기다려요 · 에이전트 앞에 2건」). 없으면 null. */
  detail: string | null;
  state: AgentWorkingSignal['state'];
  step: WorkingStep;
  /** 이 카드가 보이지 않는 나머지 열린 턴 수. */
  others: number;
  /** 실시간 레일이 붙어 있나. 끊겼으면 카드가 그것을 말한다. */
  live: boolean;
  /**
   * 사람이 부른 요청을 아무도 가져가지 않은 채 N분을 넘었는가(`runWaiting`). 카드가 낱말을
   * 바꾸고 「취소」를 내는 조건이다.
   */
  uncollected: boolean;
  /** 이유 한 문장(「연결이 꺼져 있을 수 있어요」). 서버 판정에 근거가 있을 때만, 없으면 null. */
  reason: string | null;
  /** 취소가 보내는 실행. 레일이 진행 중에 붙어 id를 모르는 턴이면 null. */
  runId: string | null;
  /** 이 카드로 합쳐진 동시 실행의 수. 합치지 않았으면 null. */
  runCount: number | null;
  /** 카드 전체를 한 문장으로. */
  accessibilityLabel: string;
}

/**
 * 카드가 「취소」를 내는가, 낸다면 어느 실행을. 아무도 가져가지 않은 채 N분을 넘은 사람 요청이고
 * (`uncollected`), 실시간 연결이 살아 있고(끊긴 화면은 마지막으로 확인된 상태일 뿐이고 그 요청은 이미
 * 끝났을 수 있다 — 대화 아래 활동 줄과 같은 규칙), 취소가 보낼 실행을 아는 카드만이다.
 */
export function cardCancelRunId(card: WorkingCardModel): string | null {
  return card.uncollected && card.live ? card.runId : null;
}

/** 관찰한 사실에서 단계를 고른다(파일 머리 주석). */
export function workingStep(turn: AgentWorkingSignal): WorkingStep {
  if (turn.state === 'queued') return 0;
  if (turn.state === 'awaiting_approval') return 3;
  return turn.headlines.length > 0 ? 2 : 1;
}

/**
 * 카드가 말할 수 있는 열린 턴, 가장 오래된 것부터. 만료된 신호(코어 TTL)와 **부른 사람이 없는
 * 시스템 작업**(환영 run)은 거른다 — 카드는 「누가 기다리는 일」만 말한다. 「그 밖에 n건」의 n도
 * 이 목록에서 센다: 보이지 않는 일을 세면 카드가 없는 일을 있다고 말한다.
 */
function openCardTurns(
  signals: ReadonlyMap<string, AgentWorkingSignal>,
  nowMs: number,
): AgentWorkingSignal[] {
  return [...signals.values()]
    .filter(signal => !isStaleSignal(signal, nowMs) && !isSystemRun(signal.server))
    .sort(byOldestTurn);
}

/**
 * 지금 카드가 보이는 턴(가장 오래된 하나), 없으면 undefined. 화면이 그 에이전트의 서버 생존
 * 판정을 읽을 때 누구를 읽을지 알려고 쓴다 — 카드를 만들기 전에 필요한 한 가지다.
 */
export function leadWorkingTurn(
  signals: ReadonlyMap<string, AgentWorkingSignal>,
  nowMs: number,
): AgentWorkingSignal | undefined {
  return openCardTurns(signals, nowMs)[0];
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
  liveness,
}: {
  signals: ReadonlyMap<string, AgentWorkingSignal>;
  nowMs: number;
  directory: Directory;
  /** 공개·비공개·DM 전부 — 턴은 어느 대화에서든 열린다. */
  channels: readonly Channel[];
  selfMemberId: string;
  live: boolean;
  /**
   * 카드 에이전트의 서버 생존 판정(D4). 아직 읽는 중이면 undefined, 호스티드가 아니면 null.
   * 아무도 가져가지 않은 요청의 근거 줄 맨 앞과 이유 문장만 이것을 읽는다.
   */
  liveness?: AgentLiveness | null;
}): WorkingCardModel | null {
  const open = openCardTurns(signals, nowMs);
  const turn = open[0];
  if (turn === undefined) return null;

  const parts = memberNameParts(directory, turn.memberId, UNKNOWN_AGENT_NAME);
  const nameFor = (memberId: string) =>
    memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME);
  const copy = agentTurnBadgeCopy([turn], nameFor);
  // 사람이 부른 요청을 아직 아무도 가져가지 않았다: 서버 생존 경고가 근거 줄 맨 앞에 서고, N분을
  // 넘으면 「대기 n번째」 대신 「아직 받지 않았어요」다. 가져간 run·다른 상태는 null이다.
  const wait =
    turn.state === 'queued'
      ? queuedWaitCopy({facts: turn.server, nowMs, liveness})
      : null;
  const uncollected = wait !== null && wait.uncollected;
  // `open` 이 비지 않았으므로 코어는 null 을 주지 않는다.
  const liveText = wait !== null && uncollected ? wait.word : (copy?.text ?? '작업 중');

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
  const detail =
    turn.server === undefined || turn.state === 'awaiting_approval'
      ? null
      : wait !== null
        ? (wait.detail ?? null)
        : (activityDetail(
            {
              key: turn.memberId,
              memberId: turn.memberId,
              name: parts,
              state: turn.state,
              server: turn.server,
            },
            nowMs,
          ) ?? null);
  const reason = wait?.reason ?? null;
  const step = workingStep(turn);
  const others = open.length - 1;

  const sentence = [
    `에이전트 ${agentLabel(parts)}`,
    liveText,
    place,
    headline,
    detail,
    reason,
    step === 0
      ? WORKING_STEP_LABELS[0]
      : `진행 ${step}/3, ${WORKING_STEP_LABELS[step]}`,
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
    detail,
    state: turn.state,
    step,
    others,
    live,
    uncollected,
    reason,
    runId: turn.runId ?? null,
    runCount: turn.runCount ?? null,
    accessibilityLabel: sentence,
  };
}
