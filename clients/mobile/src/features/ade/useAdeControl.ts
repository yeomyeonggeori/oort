import {
  adeCounts,
  adeItems,
  type AdeCounts,
  type AdeItem,
} from '@momo/core/features/work/adeControl';
import {UNKNOWN_AGENT_NAME} from '@momo/core/features/agents/turnCopy';
import {isStaleSignal} from '@momo/core/features/agents/workingSignal';
import {memberNameParts} from '@momo/core/features/workspace/directory';
import {useCallback, useMemo} from 'react';
import {useSession} from '../../session/useSession';
import {useWorkHosts, useWorkSessions} from '../agents/queries';
import {
  TURN_STALENESS_GRID_MS,
  useAgentWorkingSignals,
} from '../agents/workingSignal';
import {useDirectory} from '../workspace/queries';

// =============================================================================
// ADE 관제 표면이 읽는 것 — 폰의 절반 (이슈 1137, ADR-0154 D2 "폰은 목록형").
//
// 규칙은 하나도 여기 있지 않다. 3분류도, 생존성 등급도, 정렬도, 요약 줄의 문구도
// 전부 `@momo/core/features/work/adeControl` 의 것이고 #1136 이 웹과 함께 세웠다.
// 이 파일이 아는 것은 **어느 스토어에서 재료를 꺼내는가**뿐이다 —
// `clients/web/src/features/ade/useAdeControl.ts` 의 폰 형제이고, 그쪽이 아는 것도
// 딱 그만큼이다.
//
//   턴   `features/agents/workingSignal` 스토어. `AgentWorkingRail` 이 셸에 이미
//        마운트돼 있으므로(그것이 그 파일이 셸에 사는 이유다) 구독을 하나도 더
//        열지 않는다. 즉시 갱신된다.
//   세션 `["work-sessions", ws]` 질의 — 에이전트 탭·에이전트 상세와 **같은 키**라,
//        그 탭이 떠 있든 아니든 요청은 한 벌이다.
//
// ## 왜 이 훅이 시계를 만들지 않는가
//
// 시계는 호출자의 것이다. 폰에는 이유가 하나 더 있다: 요약 줄은 숫자를 인쇄하지
// 않으므로 1Hz 가 **필요 없고**, 목록 화면은 경과를 인쇄하므로 필요하다. 훅이
// 시계를 쥐면 그 둘 중 하나는 반드시 자기에게 없는 박자를 지불한다 — 대화 화면이
// `hasChannelTurn` 으로 같은 판단을 이미 하고 있고, 에이전트 탭은 아예 1Hz 를
// 거절하며 그 이유를 적어 두었다("a per-second re-render of the whole list would
// run forever, in the background of a screen nobody is looking at").
//
// 대신 만료 판정만은 **격자에 맞춘다**(`TURN_STALENESS_GRID_MS`). 대화 화면이
// 채널 스코프에서 하던 그것이고, 상수가 스토어로 옮겨 간 이유가 이 두 번째
// 소비자다: 두 표면이 서로 다른 격자로 같은 신호를 거르면 한 화면은 살아 있다고
// 하고 다른 화면은 아니라고 하는 구간이 생긴다.
// =============================================================================

/**
 * 세션 반쪽의 신선도 상한, ms. 웹이 고른 그 값이다.
 *
 * 폰에서 이 숫자를 다시 검토한 이유는 배터리다. 그런데 이 표면이 없으면 대화를
 * 열어 둔 사람에게 세션 절반은 **마운트 시각에 얼어붙는다** — 채널을 연 2분 뒤에
 * 작업 세션이 하나 생겨도 줄은 침묵한다. 「지금 몇 개가 돌고 있나」에 조용히 틀린
 * 답을 하는 줄은 없는 줄보다 나쁘다.
 *
 * 값을 지불하는 방식이 폰에서 더 싸다는 것이 결론을 갈랐다. react-query 는 한 키의
 * 여러 관측자 중 **가장 짧은** 간격을 쓰므로 요청은 여전히 한 벌이고, 인터벌
 * 재조회는 `refetchIntervalInBackground` 기본값(false)에 걸린다 — 그리고 그 기본값이
 * 이 플랫폼에서 실제로 뜻을 갖는 이유는 `query/queryClient.ts` 가 `focusManager` 를
 * `AppState` 에 이어 두었기 때문이다. 앱이 뒤로 가면 이 폴링은 멈춘다.
 */
export const ADE_SESSION_POLL_MS = 20_000;

export interface AdeControl {
  items: AdeItem[];
  counts: AdeCounts;
  /**
   * 원장을 못 읽었다. 요약 줄은 이 경우 세션 반쪽을 **세지 않는다**(0 으로 세는
   * 것이 아니라 모른다) — 목록 화면이 그 사실을 한 줄로 말하고 다시 시도를 준다.
   */
  sessionsFailed: boolean;
  /**
   * 호스트 등록기가 아직 답하지 않았다.
   *
   * 「모른다」와 **「아직 안 물어봤다」** 는 다른 사실이고, 카드가 생존성 배지를
   * 세울 자격은 뒤의 것이 끝난 뒤에 생긴다. 코어의 `itemDurabilityBadge` 는 등록기가
   * 답한 뒤의 `unknown` 을 「실행 위치 확인 필요」로 말하라고 하는데, 그것은 사람이
   * 랩탑을 덮을지 정하는 자리의 **경고**다 — 질의가 날아가는 중이라는 이유로 모든
   * 카드가 그 경고를 하나씩 달고 뜬 다음 조용히 지워지면, 경고는 로딩 스피너가 되고
   * 로딩 스피너가 된 경고는 다음번에 아무도 읽지 않는다.
   *
   * 이 앱은 같은 구별을 이미 한 번 했다: `agentProfileRead` 의 pending / forbidden /
   * failed / ready. 여기서는 pending 하나만 있으면 된다.
   */
  hostsPending: boolean;
  retrySessions: () => void;
}

/**
 * @param nowMs 이 렌더의 시각. 호출자가 쥔다(위 머리말).
 * @param withHosts 호스트 등록기를 읽을 것인가.
 *
 *   요약 줄은 **읽지 않는다.** 생존성은 카드에만 있는 사실이고(계수에는 들어가지
 *   않는다), 대화를 열 때마다 아무도 안 볼 등록기를 한 번 더 부르는 것은 폰에서
 *   라디오다. 목록 화면이 열릴 때 켜지고, 그때부터는 `staleTime` 안에서 따뜻하다.
 */
export function useAdeControl(nowMs: number, withHosts: boolean): AdeControl {
  const {workspaceId} = useSession();
  const {directory} = useDirectory(workspaceId);
  const sessionsQuery = useWorkSessions(workspaceId, true, ADE_SESSION_POLL_MS);
  const hostsQuery = useWorkHosts(workspaceId, withHosts);
  const signals = useAgentWorkingSignals();

  const sessions = sessionsQuery.data;
  const hosts = hostsQuery.data;

  // 만료 판정에만 쓰는 양자화된 시각. 올림인 이유는 대화 화면이 적어 둔 그대로다:
  // 내림은 격자만큼 과거를 먹여 만료를 늦추고, 늦은 만료는 「실행 중」을 사실보다
  // 오래 말하는 쪽이다.
  const staleBucket = Math.ceil(nowMs / TURN_STALENESS_GRID_MS);

  const items = useMemo(() => {
    const staleAtMs = staleBucket * TURN_STALENESS_GRID_MS;
    // 스토어의 TTL 필터는 렌더 시점에 건다. 좀비 스윕(120초)과 TTL(90초) 사이의
    // 30초 동안 스토어에는 남아 있지만 살아 있다고 말하면 안 되는 신호가 있다.
    // 대화 화면은 여기서 채널로 좁히고, 이 표면은 **좁히지 않는다** — 관제가
    // 「내가 안 보고 있는 것」을 못 보여주면 그것은 관제가 아니다.
    const turns = [...signals.values()].filter(
      signal => !isStaleSignal(signal, staleAtMs),
    );
    return adeItems(sessions ?? [], hosts, turns, memberId =>
      memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME),
    );
  }, [sessions, hosts, signals, directory, staleBucket]);

  const refetch = sessionsQuery.refetch;
  const retrySessions = useCallback(() => void refetch(), [refetch]);

  return {
    items,
    counts: adeCounts(items),
    sessionsFailed: sessionsQuery.isError,
    // 질의가 꺼져 있으면 react-query 는 데이터 없이 `pending` 을 유지한다 — 그리고
    // 그것이 정확히 참이다: 아직 안 물어봤다.
    hostsPending: hostsQuery.isPending,
    retrySessions,
  };
}
