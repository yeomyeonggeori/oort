import {
  CONNECTION_MARK,
  presentConnection,
  type ConnectionPresentation,
} from '@momo/core/features/connection/presentation';
import {useMemo} from 'react';
import {useConnection} from './ConnectionProvider';

// =============================================================================
// 대화 화면 머리 밑 띠가 말할 것 (#5222, #5201 S-D).
//
// 코어 연결 상태 모델의 모습(`view`)과 「방금 돌아왔다」(`recovered`)를 `presentConnection` 한 곳으로 모은다. 모든 원인이 이 띠로
// 말한다(연결 중 · 실시간만 끊김 · 알 수 없음 · 오프라인 · 서버에 닿지 못함 · 복구). 홈·받은함·에이전트 목록 위의 셸 띠는 기기 오프라인과
// 서버에 닿지 못함만 말한다(`ShellConnectionStrip`). 연결 상태 공급자가 없는 자리(격리 하네스·시험)는 `band: null` 이다 - 말할 것이 없다.
// =============================================================================

export interface ConnectionBand {
  /** 띠가 지금 그릴 것. 말할 것이 없으면 null(정상 · 끊긴 첫 1초의 침묵). */
  band: ConnectionPresentation | null;
  /**
   * 「연결 복구 중」인가: 사람이 보는 띠가 서 있고 그것이 방금 돌아왔다는 확인 표시가 아닐 때. 이전 이력이 남아 있어도 당겨서 다시 맞출 수
   * 있는 문(#4783)이 이것을 읽는다. 끊긴 첫 1초(띠가 조용한 동안)에는 문이 바뀌지 않는다(#4949).
   */
  recovering: boolean;
}

export function useConnectionBand(): ConnectionBand {
  const connection = useConnection();
  return useMemo<ConnectionBand>(() => {
    if (connection === null) return {band: null, recovering: false};
    const band = presentConnection(connection.view, connection.recovered);
    return {
      band,
      recovering: band !== null && band.mark !== CONNECTION_MARK.check,
    };
  }, [connection]);
}
