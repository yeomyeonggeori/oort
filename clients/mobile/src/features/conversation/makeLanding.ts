import {createContext, useCallback, useContext, useRef} from 'react';
import {
  channelLabel,
  type Directory,
} from '@momo/core/features/workspace/directory';
import type {Channel} from '@momo/core/lib/api';
import {useRememberOpenedDm} from '../workspace/queries';

// =============================================================================
// 「AI와 만들기」 요청을 보낸 뒤 그 에이전트 DM 으로 가는 길 (#4962, #4891·#4942 후속).
//
// 웹은 `ExpressionMakeForm` 의 `LandOnDm` 이 한다 — 새 DM 을 채널 캐시에 넣고, 그 대화로 가고, 고르개를 닫는다. 폰은 고르개가 두 호스트
// (입력창의 표현 시트 `Composer` · 메시지 액션 시트 `MessageActionSheet`)의 시트 안에 서고 대화로 건너가는 일은 셸이 한다
// (`onOpenConversation(channelId, title)`). 그 길을 대화 화면이 컨텍스트로 두 호스트에 내리고, 호스트는 그것을 고르개의
// `onOpenConversation` 으로 넘긴다. 고르개의 폼은 시트를 먼저 내린 뒤(`usePageSheetAction`) 이 길을 부른다 — Modal 위에 Modal 을
// 쌓지 않고, 웹이 고르개를 닫고 이동하는 것과 같은 결과다.
//
// 왜 props 가 아니라 컨텍스트인가: 호스트는 `ConversationScreen` 아래 네 곳이다(채널의 입력창·스레드의 입력창·두 목록의 행 시트).
// 행으로 가는 길(`MessageRowActions`)에 실으면 길마다 한 줄씩 더 이어야 하고 — 하나라도 빠지면 그 표면만 조용히 「확인」으로
// 돌아온다 — 행 시트는 `Timeline`·`MessageRow` 두 겹을 더 건넌다. `useOpenDecisionStage` 와 같은 모양이다. 줄 곳이 없으면(시험·
// 계측 하네스) 값이 `undefined` 이고 고르개는 지금처럼 「요청을 보냈어요…」 + 「확인」으로 끝난다.
//
// 값은 `Channel` 을 받는다. 고르개의 계약(`ExpressionMakeForm` 의 `onOpenConversation`)이 이미 그 모양이고, `(channelId, title)` 로
// 바꾸는 일은 방 이름을 푸는 명부와 내 id 를 아는 대화 화면이 한 곳에서 한다(`useLandOnMadeDm`) — 다른 DM 입구(`NewMessageSheet`·
// `AgentDetailScreen`·프로필의 DM 열기)가 같은 `channelLabel` 로 이름을 푸는 것과 같다.
// =============================================================================

export type OpenMadeConversation = (channel: Channel) => void;

export const MakeLandingContext = createContext<
  OpenMadeConversation | undefined
>(undefined);

/** 호스트(입력창·메시지 액션 시트)가 고르개의 `onOpenConversation` 으로 넘긴다. 없으면 고르개는 「확인」으로 끝난다. */
export const useMakeLanding = () => useContext(MakeLandingContext);

/**
 * 대화 화면이 컨텍스트에 싣는 값. 요청이 나간 DM(`openDirectMessage` 가 돌려준 채널)을 받아 웹 `LandOnDm` 과 같은 차례로 간다:
 * 채널 캐시에 먼저 넣고, 열려 있던 스레드 판을 접고, 그 대화로 건너간다.
 *
 *  - 캐시에 먼저 넣는 이유(#4016): 아직 DM 이 없던 에이전트와의 첫 DM 은 채널 목록에 없어서 대화 화면이 `channel === null` 로 서고,
 *    머리의 상대 얼굴·「에이전트」 부제·자동 응답 안내가 빠진다. 목록은 뒤따라 다시 읽어 맞춘다.
 *  - 스레드를 접는 이유: 이 화면은 방을 옮길 때 언마운트되지 않고 `thread` 상태는 방이 바뀐다고 비워지지 않는다. 스레드의 입력창에서
 *    만든 요청이 새 DM 위에 옛 방의 스레드 판을 남기면 안 된다. 본류의 입력창에서는 열린 판이 없어 아무 일도 아니다.
 *  - 이미 그 DM 안에서 만들었다면 같은 방을 한 번 더 연다. 셸의 같은 액션이 새 객체를 만들 뿐 화면은 그대로다(웹도 무조건 이동한다).
 *
 * 셸이 대화를 열 길(`onOpenConversation`)을 주지 않으면 갈 곳이 없으므로 값도 없다 — 고르개가 「확인」 길을 쓴다.
 */
export function useLandOnMadeDm({
  workspaceId,
  selfMemberId,
  directory,
  onOpenConversation,
  closeThread,
}: {
  workspaceId: string;
  selfMemberId: string;
  directory: Directory;
  onOpenConversation: ((channelId: string, title: string) => void) | undefined;
  closeThread: () => void;
}): OpenMadeConversation | undefined {
  const rememberOpenedDm = useRememberOpenedDm(workspaceId);
  // 방 이름을 푸는 명부는 ref 로 든다: 이 값은 컨텍스트를 타고 입력창이 읽는데, 명부가 갱신될 때마다(`AVAILABILITY_REFRESH_MS`)
  // 새로 만들어지면 읽는 쪽이 이유 없이 다시 그려진다(`openApprovalMessage` 의 `channelNamesRef` 와 같은 모양).
  const names = useRef({directory, selfMemberId});
  names.current = {directory, selfMemberId};
  const land = useCallback(
    (opened: Channel) => {
      rememberOpenedDm(opened);
      closeThread();
      const known = names.current;
      onOpenConversation?.(
        opened.id,
        channelLabel(opened, known.directory, known.selfMemberId),
      );
    },
    [rememberOpenedDm, closeThread, onOpenConversation],
  );
  return onOpenConversation === undefined ? undefined : land;
}
