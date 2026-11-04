import {
  IDLE_CUTOFF_MS,
  type AgentWorkingSignal,
  type ApprovalWait,
} from '@momo/core/features/agents/workingSignal';
import {
  isUntakenHumanRun,
  uncollectedDeadlineMs,
} from '@momo/core/features/agents/runWaiting';
import type {RosterMember} from '@momo/core/lib/api';
import type {Directory} from '@momo/core/features/workspace/directory';
import {useEffect} from 'react';
import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
import {space} from '../../design/tokens';
import {CONV} from '../conversation/convDesign';
import {TYPING_RESERVE} from '../conversation/TypingBar';

// =============================================================================
// 입력창 레일의 시계와 칸 (#4620, #4577 권장 A). 판정·낱말은 코어(`activityRail`)이고, 이 파일은 폰이 그것을 **언제
// 다시 그리는가**와 **칸을 얼마나 잡는가**만 정한다.
//
// ## 초 단위로 다시 그리지 않는다
//
// 예전 대화 화면은 열린 턴이 있는 동안 1초마다 다시 그렸다(`useTickingNow`): 「3초째」가 「4초째」가 되는 글자를
// 보이려는 것이었고, 그 글자가 줄 수를 뒤집어 입력창 위의 대화를 흔들었다(#4613). 레일의 글자에는 시간이 없다. 시간이
// 사실을 바꾸는 순간은 둘뿐이다 — ① 서버가 모르는(라이브 프레임뿐인) 턴이 90초 조용해져 만료되는 때, ② 사람이 부른 요청이
// 아무도 가져가지 않은 채 유예(`uncollectedDeadlineMs`)를 넘는 때. 그 순간에 **한 번만** 다시 그린다. 그 밖의 변화는
// 스토어의 사실이 바뀌는 것(프레임·진행 읽기)이고 그때는 스토어가 이미 렌더를 일으킨다.
// =============================================================================

/**
 * 시간이 레일의 사실을 바꾸는 **가장 이른 순간**(ms). 없으면 null. 세 가지다:
 *
 *   - 라이브 신호의 만료: 서버가 답한 턴에는 걸리지 않는다(서버가 끝낸다, ADR-0200 D1). 경계는 코어와 같다 — `now - last > 90초`라 마지막 활동 + 90초 + 1ms.
 *   - 아무도 가져가지 않은 요청의 유예 마감(`uncollectedDeadlineMs`): `now >= 마감`이라 마감에.
 *   - 대기 승인의 기한(`waits`): 코어 `applyApprovalWaits`는 `expiresAtMs > now`인 승인만 기다림으로 세므로 기한에 승인 낱말이 걷힌다. 예전 5초 격자 시계는
 *     이 전환을 5초 안에 잡았다 — 시계를 걷은 지금은 이 마감이 그 몫이다.
 *
 * 타이머가 경계에서 1ms 일찍 불려도 다음 계산이 같은 마감을 다시 건다(스스로 바로잡는다).
 */
export function nextRailDeadlineMs(
  turns: readonly AgentWorkingSignal[],
  nowMs: number,
  graceMs?: number,
  waits: readonly Pick<ApprovalWait, 'expiresAtMs'>[] = [],
): number | null {
  let next: number | null = null;
  const consider = (at: number): void => {
    if (at > nowMs && (next === null || at < next)) next = at;
  };
  for (const turn of turns) {
    if (turn.server === undefined) {
      consider(turn.lastActivityAtMs + IDLE_CUTOFF_MS + 1);
    } else if (isUntakenHumanRun(turn.server)) {
      consider(uncollectedDeadlineMs(turn.server.queuedAtMs, undefined, graceMs));
    }
  }
  for (const wait of waits) {
    if (wait.expiresAtMs !== undefined && Number.isFinite(wait.expiresAtMs)) consider(wait.expiresAtMs);
  }
  return next;
}

/** `setTimeout`이 한 번에 받는 상한(2^31 - 1ms). 넘기면 즉시 불린다. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * `deadlineMs`에 **한 번** `onFire`를 부른다. 마감이 바뀌면 이전 시계는 걷고 새로 건다. 마감이 없으면 시계가 없다 — 이것이
 * 이 화면에 남은 유일한 타이머이고, 간격(`setInterval`)이 아니다.
 */
export function useFireAt(deadlineMs: number | null, onFire: () => void): void {
  useEffect(() => {
    if (deadlineMs === null) return;
    const id = setTimeout(
      onFire,
      Math.min(Math.max(deadlineMs - Date.now(), 0), MAX_TIMEOUT_MS),
    );
    return () => clearTimeout(id);
  }, [deadlineMs, onFire]);
}

/** 에이전트가 이 채널의 활동 멤버인가(웹 `channelHasAgent`와 같은 판정). */
export function channelHasAgent(directory: Directory, channelId: string): boolean {
  const key = channelId.toLowerCase();
  for (const member of directory.byId.values()) {
    if (
      member.kind === 'agent' &&
      member.status === 'active' &&
      member.channelIds.some(id => id.toLowerCase() === key)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 이 대화가 레일 칸을 **미리 잡는가**(웹 `isRailReserved`, planner 결정 4). 에이전트가 있는 대화에서만이다: 에이전트 DM이거나
 * 활동 중인 에이전트 멤버가 이 채널에 있을 때. 사람만 있는 대화는 칸도 없고 마지막 행 → 알약 간격은 그대로 20이다.
 */
export function isRailReserved(options: {
  dmAgent: Pick<RosterMember, 'kind'> | null;
  directory: Directory;
  channelId: string;
}): boolean {
  return options.dmAgent !== null || channelHasAgent(options.directory, options.channelId);
}

/**
 * 레일 칸의 높이. 줄 상자 하나(`CONV.agentRailSlot`)를 글자 크기 배율(바 단추의 상한까지)만큼 키운다 — 같은 글자 크기에서는
 * 비어 있든 한 줄이든 합친 줄이든 끊긴 문장이든 **같은 값**이고, 이 값이 줄이 서고 질 때 목록의 맨 아래 행이 움직이지 않는
 * 이유다. 칸을 키우는 배율을 상한에서 끊는 것은 글자(`maxFontSizeMultiplier`)와 같은 상한을 쓰기 위해서다.
 */
export function railSlotHeight(fontScale: number): number {
  return CONV.agentRailSlot * Math.min(fontScale, BAR_CONTROL_MAX_SCALE);
}

/**
 * 레일 줄의 손가락 슬롭. **위로는 넓히지 않는다**: RN(Fabric)은 자식의 `hitSlop`을 부모의 겹침 영역에 합치고(`YogaLayoutableShadowNode`의
 * contentBounds) 도크는 목록보다 **뒤 형제**라서, 겹친 구간의 탭을 도크가 먼저 받는다 — 위로 넓히면 목록 마지막 행의 아랫부분을 눌러도 시트가 열린다
 * (웹이 같은 가로챔 때문에 24에서 멈춘 이유, design-review r1 H3). 아래로는 「작성 중」 예약 줄(`TYPING_RESERVE`, `pointerEvents="none"`이라 터치가
 * 지나간다)까지만: 그 아래는 컴포저 루트(뒤 형제)가 먼저 받아 슬롭이 닿지 않는다. 좌우는 줄의 글 폭이 짧아(이름 하나) 넓힌다 — 옆에 누를 것이 없다.
 *
 * 합친 세로 누르는 면 = 칸 + `TYPING_RESERVE`(글자 배율 1에서 28)로 손가락 높이 44(`TOUCH_TARGET`)보다 작다. **알려진 한계**다(웹 24와 같은 종류).
 * 더 키우려면 도크 위 세로 자리를 늘려야 하고, 그것은 owner가 줄인 간격(#4264)을 되돌리는 결정이다.
 */
export const RAIL_HIT_SLOP = {
  top: 0,
  bottom: TYPING_RESERVE,
  left: space.md,
  right: space.md,
} as const;
