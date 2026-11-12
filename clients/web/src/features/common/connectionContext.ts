import { createContext, useContext, useMemo } from "react";
import { useSession } from "@/app/session";
import type { RealtimeHandle, RealtimeStatus } from "@/lib/realtime";
import type { ConnectionView } from "@momo/core/features/connection/model";
import { viewWithoutRest } from "@momo/core/features/connection/screenState";
import { useBrowserOffline } from "./browserOffline";

// =============================================================================
// 웹·데스크탑이 연결 상태 모델을 읽는 자리의 문 (#5220, #5201 S-B). 공급자(`connectionModel.tsx`)가 돌린 모습을
// 읽는다. 화면은 이 파일의 `useConnection()`만 알면 된다.
//
// `SessionContextValue`에 얹지 않은 이유: 그 값을 손으로 짓는 시험이 150개 가까이 되고, 필드 하나가 늘면 그
// 전부를 고쳐야 한다. 공급자가 없는 곳(시험, 셸 밖)에서는 소켓 상태와 브라우저 오프라인만으로 같은 모델을 돌린
// 모습을 준다(`fallbackConnection`) — REST 입력이 없을 뿐 규칙은 같다.
// =============================================================================

export interface ConnectionContextValue {
  readonly view: ConnectionView;
  /** 「끊김」이 보였다가 정상으로 돌아온 직후 2초. */
  readonly recovered: boolean;
  /**
   * 「지금 다시 연결」: 소켓을 다시 열고 틈의 시계를 새로 시작한다(말하던 카드는 곧바로 「연결 중」으로
   * 이어진다). 돌아온 순간·깨어난 순간에 소켓이 끊겼거나 잠든 사이 죽었다고 판정될 때(코어 `resume.ts`, #5660)도 같은 길이다.
   */
  readonly reconnectNow: () => void;
}

export const ConnectionContext = createContext<ConnectionContextValue | null>(null);

function fallbackConnection(
  connStatus: RealtimeStatus,
  browserOffline: boolean,
  realtime: RealtimeHandle | null
): ConnectionContextValue {
  return {
    // 소켓 상태 하나와 브라우저 오프라인만으로 같은 모델을 돌린 모습(REST 입력만 없다).
    view: viewWithoutRest(connStatus, !browserOffline, Date.now()),
    recovered: false,
    reconnectNow: () => realtime?.reconnect(),
  };
}

/**
 * 지금의 연결 모습. 공급자 안이면 모델이 돌린 모습이고, 아니면 소켓·브라우저만으로 낸 모습이다.
 * 세션 안에서만 부른다(`useSession`): 셸 위의 라우트는 `useBrowserOffline`을 쓴다.
 */
export function useConnection(): ConnectionContextValue {
  const provided = useContext(ConnectionContext);
  const { connStatus, realtime } = useSession();
  const browserOffline = useBrowserOffline();
  return useMemo(
    () => provided ?? fallbackConnection(connStatus, browserOffline, realtime),
    [provided, connStatus, browserOffline, realtime]
  );
}

