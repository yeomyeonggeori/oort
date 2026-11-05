import {
  CONNECTION_MARK,
  nextBandStood,
  presentBand,
  type ConnectionPresentation,
} from '@momo/core/features/connection/presentation';
import {useEffect, useMemo, useState} from 'react';
import {appStateForeground} from '../readState/useViewingBeat';
import {useConnection} from './ConnectionProvider';

// =============================================================================
// 대화 화면 머리 밑 띠가 말할 것 (#5222, #5201 S-D, #5403).
//
// 코어 연결 상태 모델의 모습(`view`)과 「방금 돌아왔다」(`recovered`)를 `presentBand` 한 곳으로 모은다. 모든 원인이 이 띠로
// 말한다(연결 중 · 실시간만 끊김 · 알 수 없음 · 오프라인 · 서버에 닿지 못함 · 복구). 홈·받은함·에이전트 목록 위의 셸 띠는 기기 오프라인과
// 서버에 닿지 못함만 말한다(`ShellConnectionStrip`). 연결 상태 공급자가 없는 자리(격리 하네스·시험)는 `band: null` 이다 - 말할 것이 없다.
//
// ## 「다시 연결됐어요」는 이 띠가 끊김을 그린 적이 있을 때만 (#5403)
//
// 모델의 「끊김이 보였다」는 모델이 끊김으로 읽은 것이지 이 띠가 그린 것이 아니다. 대화를 막 열었을 때(띠가 새로 선 곳)나 앱이 뒤에 있던 동안의
// 끊김은 사람이 본 적이 없다. 그래서 띠가 **앞에서 끊김을 실제로 그렸을 때** 기억(`stood`)이 서고(셸 띠의 `stood` 와 같은 문법), 그 기억이
// 있을 때만 복구 2초를 말한다. 기억은 틈이 완전히 가라앉으면 잊는다.
//
// ## 복구 표시는 깨움이 늦어도 다음 렌더에서 거둔다 (#5403)
//
// 복구 표시를 거두는 것은 저장소의 깨움 시계인데, 상태는 깨움이 와야 바뀐다. 시계가 늦거나 사라지면 낡은 표시가 보내기 같은 다음 사건까지
// 남는다. 이 훅은 렌더마다 자기 시각을 `recoveredUntil` 과 견주어, 끝난 표시는 깨움을 기다리지 않고 거둔다.
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
  const view = connection?.view ?? null;
  // 렌더 시각. 복구 표시가 끝난 시각을 지났으면 깨움이 아직 안 왔어도 그리지 않는다.
  const now = Date.now();
  const recovered =
    connection !== null &&
    connection.recovered &&
    (connection.recoveredUntil === null || now < connection.recoveredUntil);

  const [stood, setStood] = useState(false);
  useEffect(() => {
    if (view === null) return;
    // 뒤에 있는 동안 그려진 끊김은 본 것이 아니다(`foreground`): 기억을 세우지 않는다.
    const next = nextBandStood(view, recovered, stood, appStateForeground.isForeground());
    if (next !== stood) setStood(next);
  }, [view, recovered, stood]);

  return useMemo<ConnectionBand>(() => {
    if (view === null) return {band: null, recovering: false};
    const band = presentBand(view, recovered, stood);
    return {
      band,
      recovering: band !== null && band.mark !== CONNECTION_MARK.check,
    };
  }, [view, recovered, stood]);
}
