import { useCallback, useMemo } from "react";
import { UNKNOWN_AGENT_NAME } from "@momo/core/features/agents/turnCopy";
import {
  adeCounts,
  adeItems,
  type AdeCounts,
  type AdeItem,
} from "@momo/core/features/work/adeControl";
import { useSession } from "@/app/session";
import { memberNameParts, useDirectory } from "@/features/workspace/useWorkspace";
import { useWorkHosts, useWorkSessions } from "@/features/work/useWorkSessions";
import { useApprovalWaits } from "@/features/inbox/useInbox";
import {
  isStaleSignal,
  useAgentWorkingSignals,
  useTickingNow,
  withApprovalWaits,
} from "@/features/agents/agentWorkingSignal";

// =============================================================================
// ADE 관제 표면이 읽는 것 (이슈 1135). 규칙은 전부 코어에 있고, 여기 있는 것은 **어느
// 스토어에서 재료를 꺼내는가**뿐이다.
//
//   턴   `agentWorkingSignal` 스토어 — AgentWorkingRail 이 셸에 이미 마운트돼
//        있어서 구독을 하나도 더 열지 않는다. 즉시 갱신된다. **승인 원장이 그
//        위에 덮인다**(#5125, 아래).
//   세션 `["work-sessions", ws]` 쿼리 — 작업 세션 패널과 **같은 키**라, 패널이
//        열려 있든 아니든 요청은 한 벌이다.
//
// ## 승인 원장이 레일보다 이긴다 (#5125)
//
// 서버는 승인에 걸린 run 을 레일 프레임으로 알리지 않는다(중간 프레임은 늘 `running`). 스토어의 원본 신호만 읽으면 사람의 결정을 기다리는
// 에이전트도 「실행 중」으로 세어져서 요약 줄이 「대기」를 말하지 못한다 — 같은 승인을 사이드바 채널 알약과 컴포저 활동 줄은 이미
// 「승인 필요」라고 말한다(#3738). 그 덮어쓰기(`applyApprovalWaits`)를 채널마다 부르는 `withApprovalWaits` 를 지난 사본을 읽는다. 원장은
// 같은 쿼리 키(`useApprovalWaits`)를 읽어 캐시는 한 벌이고, 실시간 동기(`ApprovalsLiveSync`)와 30초 폴링이 신선도를 맡는다.
//
// ## 왜 여기서 `useWorkSessionRail` 을 마운트하지 않는가
//
// 그 훅은 채널을 최대 8개까지 구독하고 ACP 이벤트를 400개까지 버퍼에 쌓는다.
// 요약 줄이 필요한 것은 **원장의 상태 전이**뿐이고 이벤트 본문은 한 글자도 쓰지
// 않는다. 셸에 상주하는 표면이 아무도 안 보는 터미널 스트림을 계속 받아 적으면,
// 이 줄의 비용은 그것이 나르는 정보와 무관해진다.
//
// 대신 이 관측자는 폴링 간격을 20초로 낮춘다. React Query 는 한 키의 여러
// 관측자 중 **가장 짧은** 간격을 쓰므로, 패널이 함께 떠 있어도 요청은 여전히 한
// 벌이고 신선도만 올라간다. 20초는 세션 반쪽의 지연 상한이라는 뜻이고, 턴 반쪽은
// 레일이 즉시 갱신한다. (세션 수명주기 프레임만 듣는 가벼운 구독은 후속이다.)
// =============================================================================

/** 세션 반쪽의 신선도 상한. 위 주석의 근거로 60초 기본값 대신 쓴다. */
const ADE_SESSION_POLL_MS = 20_000;

export interface AdeControl {
  items: AdeItem[];
  counts: AdeCounts;
  /** 이 렌더의 시각. 서랍의 경과 시계가 쓰고, TTL 필터가 이미 쓴 값이다. */
  nowMs: number;
  /**
   * 원장을 못 읽었다. 요약 줄은 이 경우 세션 반쪽을 **세지 않는다**(0 으로
   * 세는 것이 아니라 모른다) — 서랍이 그 사실을 한 줄로 말하고 다시 시도를 준다.
   */
  sessionsFailed: boolean;
  /** 그 읽기가 던진 오류 객체(#5279 B): 서랍이 실패의 원인(오프라인 / 서버에 닿지 못함 / 그 밖)을 말하는 데 쓴다. 실패가 아니면 `null`. */
  sessionsError: unknown;
  retrySessions: () => void;
}

/**
 * @param clockAlways 서랍이 열려 있는가. 열려 있으면 경과 시계 때문에 1Hz 가
 *   필요하고, 닫혀 있으면 **열린 턴이 있을 때만** 필요하다(TTL 을 재려고).
 *
 *   턴이 하나도 없으면 시계를 아예 마운트하지 않는다. 세션만으로 이루어진
 *   요약은 쿼리가 갱신될 때만 바뀌므로, 초당 한 번 다시 그릴 이유가 없다 —
 *   `hasChannelTurn` 이 컴포저에서 같은 판단을 하는 그 이유다.
 * @param sessionsEnabled 세션 반쪽(원장과 호스트 목록 읽기)을 읽는가. 기본은 읽는다. 관제 표면이 서 있지 않은 곳
 *   (온라인 호스트가 없다, 서버에 그 경로가 없다)에서 이 훅을 부르는 쪽(메뉴 막대 상태, #5193)이 끈다: 서랍과 요약 줄은
 *   `SurfaceGate` 뒤에 있어서 그런 곳에서는 아예 마운트되지 않지만, 셸에 늘 마운트된 호출은 그 문이 없으므로 직접 끈다 —
 *   꺼 두지 않으면 호스트가 없는 워크스페이스에서도 원장을 20초마다 묻는다. 꺼져 있으면 쿼리를 열지 않고, 이미 캐시에
 *   남은 옛 세션도 쓰지 않는다(없는 호스트의 세션을 「실행 중」으로 말하지 않는다). 턴 반쪽은 실시간 스토어에서 오므로
 *   이 값과 무관하게 그대로 흐른다.
 */
export function useAdeControl(
  clockAlways: boolean,
  sessionsEnabled: boolean = true
): AdeControl {
  const { workspaceId } = useSession();
  const { directory } = useDirectory(workspaceId);
  const sessionsQuery = useWorkSessions(workspaceId, ADE_SESSION_POLL_MS, sessionsEnabled);
  const hostsQuery = useWorkHosts(workspaceId, undefined, sessionsEnabled);
  const signals = useAgentWorkingSignals();
  const approvalWaits = useApprovalWaits();
  const nowMs = useTickingNow(clockAlways || signals.size > 0);

  const sessions = sessionsEnabled ? sessionsQuery.data : undefined;
  const hosts = sessionsEnabled ? hostsQuery.data : undefined;

  const items = useMemo(
    () => {
      // 스토어의 TTL 필터는 렌더 시점에 건다. 좀비 스윕(120초)과 TTL(90초) 사이의
      // 30초 동안 스토어에는 남아 있지만 살아 있다고 말하면 안 되는 신호가 있고,
      // `agentTurnsInChannel` 이 채널 표면에서 하는 것과 같은 판정이다 — 다만 이
      // 표면은 워크스페이스 전역이라 채널로 좁히지 않는다.
      //
      // 승인 원장은 이 거름 **앞**에서 덮는다: 덮기 함수가 대기 승인이 있는 채널의 만료 신호를 스스로 먼저 걸러 승인을 근거로 새 턴을 세우고,
      // 아래 거름은 그 밖의 채널에 남은 만료 신호를 거른다.
      const turns = [...withApprovalWaits(signals, approvalWaits, nowMs).values()].filter(
        (signal) => !isStaleSignal(signal, nowMs)
      );
      return adeItems(sessions ?? [], hosts, turns, (memberId) =>
        memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME)
      );
    },
    [sessions, hosts, signals, approvalWaits, directory, nowMs]
  );

  const refetch = sessionsQuery.refetch;
  const retrySessions = useCallback(() => void refetch(), [refetch]);

  return {
    items,
    counts: adeCounts(items),
    nowMs,
    sessionsFailed: sessionsEnabled && sessionsQuery.isError,
    sessionsError: sessionsEnabled ? (sessionsQuery.error ?? null) : null,
    retrySessions,
  };
}
