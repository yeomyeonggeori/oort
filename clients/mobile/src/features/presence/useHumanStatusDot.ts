import type {RosterMember} from '@momo/core/lib/api';
import {
  humanPresenceDot,
  withOwnConnection,
  type StatusDot,
} from '@momo/core/features/presence/statusDot';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useSession} from '../../session/useSession';

// =============================================================================
// 사람 한 명의 상태 점 (#4692). 판정은 코어의 `humanPresenceDot`(선언 상태 > 접속 여부, 모르면 점 없음) 한
// 함수이고, 이 훅이 가져다 넣는 것은 **보는 사람 자기 행**의 접속 여부 하나다: 자기 행은 이 폰 자신의 소켓
// 연결(`withOwnConnection`)이고 남의 행은 서버의 `online` 그대로다. 에이전트에게는 점이 없다(ADR-0160 D4:
// 에이전트의 생존감은 서버의 생존 판정이다 - 홈 줄·대화 머리는 `dmPeerStatusDot` 이 그 길을 이미 탄다).
//
// 홈 DM 줄과 대화 머리는 `dmPeerStatusDot` 을 직접 부르므로 이 훅이 필요 없다. 이 훅은 **그 밖의 사람 표면**(새
// DM 시트, 프로필 시트)이 한 곳에서 같은 판정을 읽게 하려는 공용 자리다.
// =============================================================================

export function useHumanStatusDot(member: RosterMember | null): StatusDot | null {
  const {member: self} = useSession();
  const {status} = useRealtime();
  if (member === null || member.kind !== 'human') return null;
  return humanPresenceDot(
    withOwnConnection(member, self.id, status === 'connected'),
    Date.now(),
  );
}
