import { useEffect } from "react";
import { useSession } from "@/app/session";

// =============================================================================
// 작업공간 출석부에 세어지는 일 (ADR-0160 ② 가용성, #4692).
//
// Renders nothing. 로그인한 동안 이 앱이 「온라인」으로 보이도록 `online:ws<WS>` 에 붙어 있는다.
// 이 구독에서 받는 것은 없다: Centrifugo 의 presence 표에 「이 사람은 연결돼 있다」가 적힐 뿐이고, 그 표는
// 서버만 읽어 명부 행의 `online` 으로 싣는다(`RealtimeHandle.joinOnlineRollCall`).
//
// 구독은 소켓을 따라간다. 재연결이면 스스로 다시 붙고, 소켓이 내려가면 함께 내려간다. 그래서 이 컴포넌트가
// 하는 일은 작업공간이 바뀌거나 세션이 끝날 때 떠나는 것뿐이다.
// =============================================================================

export function OnlineRollCall() {
  const { workspaceId, realtime } = useSession();

  useEffect(
    () => realtime?.joinOnlineRollCall?.(workspaceId),
    [realtime, workspaceId]
  );

  return null;
}
