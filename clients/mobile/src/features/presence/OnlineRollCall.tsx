import {useEffect} from 'react';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useSession} from '../../session/useSession';

// =============================================================================
// 작업공간 출석부에 세어지는 일 (ADR-0160 ② 가용성, #4692).
//
// Renders nothing. 로그인한 동안 이 폰이 「온라인」으로 보이도록 `online:ws<WS>` 에 붙어 있는다. 이 구독에서
// 받는 것은 없다: Centrifugo 의 presence 표에 「이 사람은 연결돼 있다」가 적힐 뿐이고, 그 표는 서버만 읽어
// 명부 행의 `online` 으로 싣는다.
//
// 구독은 소켓을 따라간다. 백그라운드 정책이 소켓을 내리면(15초 유예 뒤) 함께 내려가고, 앱이 돌아와 소켓이
// 다시 서면 스스로 다시 붙는다. 그래서 이 컴포넌트는 `subscriptionsWanted` 를 읽지 않는다: 32개를 붙이는
// 에이전트 레일과 달리 구독이 하나라 내리고 올리는 비용이 없고, 소켓이 없을 때의 구독은 아무것도 세지 않는다.
// 이 컴포넌트가 하는 일은 작업공간이 바뀌거나 세션이 끝날 때 떠나는 것뿐이다.
// =============================================================================

export function OnlineRollCall(): null {
  const {workspaceId} = useSession();
  const {rail} = useRealtime();

  useEffect(
    () => rail?.joinOnlineRollCall(workspaceId),
    [rail, workspaceId],
  );

  return null;
}
