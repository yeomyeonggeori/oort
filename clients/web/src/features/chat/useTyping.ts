import { useCallback, useEffect, useRef } from "react";
import {
  ApiError,
  publishTyping,
  requestTypingGrant,
  type TypingGrantResponse,
} from "@momo/core/lib/api";
import {
  emptyTypingSendState,
  nextTypingAction,
  typingGrantFrom,
  withTypingGrant,
  withTypingPublished,
  withTypingRefusal,
  type TypingSendState,
} from "@momo/core/features/chat/typing";
import type { RealtimeHandle } from "@momo/core/lib/realtimeEvents";
import {
  recordTyping,
  rememberTypingThreshold,
  resetTyping,
} from "./typingStore";

// =============================================================================
// 「작성 중」 송·수신 배선 (ADR-0149 · goal B3 W2).
//
// 규칙은 코어에 있고 여기 있는 것은 그 규칙을 실제 fetch와 실제 구독에 잇는 배선뿐
// 이다. 두 훅으로 나눈 이유는 **둘의 조건이 다르다**는 것이다: 수신은 채널을 보고
// 있으면 항상 걸리고, 송신은 이 사람이 글을 쓸 때만 일어난다.
// =============================================================================

/**
 * 이 채널의 「작성 중」을 듣는다.
 *
 * **보이는 채널만.** 사이드바의 모든 채널을 구독하면 방마다 사람마다 3초에 한 번씩
 * 프레임이 들어오고, 그 전부가 화면에 없는 채널의 것이다. 채널 표면이 열려 있는 동안만
 * 구독하는 것이 이 레일의 유일한 폭 제어다(서버는 상태가 없으므로 「누구에게 보낼지」를
 * 모른다 — 구독한 사람 전원에게 간다).
 *
 * `channelId`가 null이면 아무것도 걸지 않는다. 명부는 그대로 남아 있고 만료로 늙는다:
 * 채널을 옮겼다고 남이 치던 사실이 거짓이 되는 것은 아니다.
 */
export function useTypingReceive(
  realtime: RealtimeHandle | null,
  workspaceId: string,
  channelId: string | null
): void {
  useEffect(() => {
    if (!realtime || channelId === null) return;
    return realtime.subscribeTyping(workspaceId, channelId, {
      onTyping: (frame) => recordTyping(frame),
    });
  }, [realtime, workspaceId, channelId]);

  // 다른 워크스페이스(로그아웃·전환)는 아무것도 물려받지 않는다. 명부는 모듈 상태이고
  // 앞 워크스페이스의 채널 id로 들어온 신호가 새 워크스페이스의 채널 id와 맞아떨어질
  // 이유는 없지만, **배선되지 않은 teardown은 teardown이 아니다**
  // (design-review PR 1059 N-3). `AgentWorkingRail`이 `resetAgentWorking`을 같은
  // 모양으로 부르는 그 자리와 대칭이다.
  //
  // 6초 만료가 어차피 쓸어 가므로 영향은 작다 — 그래서 이것은 정확성 수리가 아니라
  // 「독스트링이 약속한 것을 코드가 지키게」 하는 수리다.
  useEffect(() => {
    return () => resetTyping();
  }, [workspaceId]);
}

export interface TypingSender {
  /**
   * 사람이 방금 한 글자 쳤다.
   *
   * **타이머가 없다.** 이 함수를 부르지 않으면 아무것도 나가지 않으므로, 「입력이
   * 멈추면 송신도 멈춘다」가 코드가 아니라 구조로 지켜진다. 흐림·탭 전환·백그라운드·
   * 언마운트에 끌 것이 없다는 뜻이고, 그중 하나를 잊어서 컴포저를 떠난 사람이 계속
   * 작성 중으로 남는 경로가 아예 없다는 뜻이다.
   *
   * 던지지 않는다. 「작성 중」이 실패한 것은 사람이 알아야 할 일이 아니다 — 실패하면
   * 표시가 안 뜨는 것이 전부이고, 그 대가로 컴포저에 배너가 뜨면 그게 더 나쁘다.
   */
  onInput: () => void;
}

/**
 * 컴포저의 키 입력을 「작성 중」 발행으로 잇는다.
 *
 * 상태를 ref에 두는 이유: 이 상태는 화면에 아무것도 그리지 않는다(그리는 것은 남의
 * 작성 중이다). `useState`로 두면 키를 누를 때마다 컴포저 전체가 다시 렌더되고,
 * 그것은 한글 조합 중에 60건짜리 멘션 목록을 재렌더하는 것보다 나쁜 이유가 없는
 * 순수한 낭비다.
 */
export function useTypingSend(
  workspaceId: string,
  channelId: string | null,
  options: { enabled: boolean }
): TypingSender {
  const stateRef = useRef<TypingSendState>(emptyTypingSendState());
  const inFlightRef = useRef(false);
  const channelRef = useRef<string | null>(channelId);

  useEffect(() => {
    // 채널이 바뀌면 자격도 바뀐다: grant는 (멤버, 워크스페이스, **채널**)에 묶여
    // 있으므로 앞 방의 grant로 이 방에 발행하면 403이다. `disabled`는 인스턴스의
    // 성질이라 넘어온다 — 채널을 옮겨도 이 서버는 여전히 휘발 신호를 하지 않는다.
    channelRef.current = channelId;
    stateRef.current = {
      ...emptyTypingSendState(),
      disabled: stateRef.current.disabled,
    };
  }, [channelId]);

  const onInput = useCallback(() => {
    if (!options.enabled) return;
    const channel = channelRef.current;
    if (channel === null) return;
    // 한 번에 한 요청. 없으면 빠르게 치는 사람의 키 하나하나가 grant 요청을 띄우고,
    // 서버는 그 전부에 멤버십 SELECT를 돌린다 — grant를 따로 뗀 이유를 정확히 되돌린다.
    if (inFlightRef.current) return;

    /**
     * 한 걸음 밟고, 자격을 새로 얻었으면 한 번 더 묻는다.
     *
     * `depth`가 있는 이유: 첫 타에 grant만 받고 끝내면 **두 번째 키를 누를 때까지**
     * 아무도 이 사람이 쓰는 줄 모른다. 한 글자만 치고 멈춘 사람은 영영 안 뜬다 — 그건
     * 설계가 아니라 사고였다. 그래서 grant가 손에 들어온 직후 바로 한 번 더 평가하고,
     * 거기서 멈춘다: 2가 상한이라 실패한 자격으로 무한히 다시 시도하는 길이 없다.
     */
    const step = (depth: number): void => {
      if (depth > 2) return;
      const channelNow = channelRef.current;
      if (channelNow !== channel) return;
      const now = Date.now();
      const action = nextTypingAction(stateRef.current, now);
      if (action.kind === "wait") return;

      inFlightRef.current = true;
      const settle = () => {
        inFlightRef.current = false;
      };
      const refuse = (error: unknown) => {
        // ApiError만 상태에 반영한다. 네트워크가 죽은 것은 이 신호의 문제가 아니고,
        // 그 경우 다음 키가 그대로 재시도다.
        if (error instanceof ApiError) {
          stateRef.current = withTypingRefusal(stateRef.current, error.status, {
            nowMs: Date.now(),
          });
        }
      };

      if (action.kind === "grant") {
        requestTypingGrant(workspaceId, channel)
          .then((wire: TypingGrantResponse) => {
            // 응답이 오는 사이에 방을 옮겼으면 이 자격은 저 방의 것이다.
            if (channelRef.current !== channel) return;
            stateRef.current = withTypingGrant(
              stateRef.current,
              typingGrantFrom(wire),
              Date.now()
            );
            // 서버가 뭉치기 임계를 여기서 말한다. 화면이 그 값을 쓰는 유일한 통로다.
            rememberTypingThreshold(wire.aggregateThreshold);
          })
          .catch(refuse)
          .finally(() => {
            settle();
            step(depth + 1);
          });
        return;
      }

      publishTyping(workspaceId, channel, action.grant)
        .then(() => {
          if (channelRef.current !== channel) return;
          stateRef.current = withTypingPublished(stateRef.current, now);
        })
        .catch(refuse)
        .finally(settle);
    };

    step(1);
  }, [workspaceId, options.enabled]);

  return { onInput };
}
