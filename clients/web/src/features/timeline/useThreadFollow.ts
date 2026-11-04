import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { followThread, unfollowThread, type ThreadRepliesPage } from "@momo/core/lib/api";
import {
  createThreadFollowController,
  threadFollowCopy,
  type ThreadFollowCopy,
  type ThreadFollowView,
} from "@momo/core/features/timeline/threadFollow";
import { noteFollowing } from "@/features/notifications/threadFollowStore";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// 스레드 패널 머리의 따라가기 상태 (#4890). 규칙(낙관적 갱신·실패하면 되돌림·쓸 수 없으면 숨김·서버 값은 누르기 전까지만)은
// 코어 `threadFollow` 가 정하고, 이 훅은 그것을 웹에 붙인다: 요청은 `followThread`/`unfollowThread`, 확정된 값은 스레드 질의
// 캐시와 데스크탑 알림의 장부(`threadFollowStore`)에 적는다.
//
// 장부에는 **서버가 말한 값만** 적는다: 스레드를 열 때의 `following`(컨트롤러가 받았을 때만 — 누른 뒤의 옛 읽기는 받지 않는다)과
// 따라가기 응답의 효과값. 컨트롤러는 루트마다 하나다(`rootId` 가 바뀌면 새로 만든다).
// =============================================================================

export interface ThreadFollowState {
  view: ThreadFollowView;
  copy: ThreadFollowCopy;
  toggle: () => void;
  dismissError: () => void;
}

export function useThreadFollow({
  workspaceId,
  channelId,
  rootId,
  queryKey,
  serverFollowing,
}: {
  workspaceId: string;
  channelId: string;
  rootId: string;
  /** 스레드 열기 질의의 키 — 확정된 값을 그 캐시에도 적어 뒤의 재조회가 옛 값을 되돌려 놓지 않게 한다. */
  queryKey: QueryKey;
  /** 스레드 열기 응답의 `following`. 아직 못 받았으면 `undefined`. */
  serverFollowing: boolean | undefined;
}): ThreadFollowState {
  const formatMessage = useFormatMessage();
  const queryClient = useQueryClient();
  // 서버 값이 처음 닿는 순간에 컨트롤러를 **그 값으로** 새로 만든다(`known` 이 켜질 때 한 번). 값이 닿은 뒤에 효과로 `sync` 하면
  // 첫 그림에 거꾸로 선 모양이 한 프레임 보인다. 이후의 재조회는 `sync` 가 맡는다(누르기 전까지만 받는다).
  const known = serverFollowing !== undefined;
  const controller = useMemo(
    () =>
      createThreadFollowController({
        initial: serverFollowing === true,
        send: (follow) =>
          follow
            ? followThread(workspaceId, channelId, rootId)
            : unfollowThread(workspaceId, channelId, rootId),
        onSettled: (following) => {
          noteFollowing(workspaceId, rootId, following);
          queryClient.setQueryData<ThreadRepliesPage>(queryKey, (page) =>
            page === undefined ? page : { ...page, following }
          );
        },
      }),
    // `queryKey` 는 (workspaceId, channelId, rootId)에서 나오는 값이라 따로 의존하지 않고, `serverFollowing` 은 `known` 이 켜질 때의
    // 첫 값만 쓴다(위).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, channelId, rootId, queryClient, known]
  );
  useEffect(() => {
    if (serverFollowing === undefined) return;
    if (controller.sync(serverFollowing)) noteFollowing(workspaceId, rootId, serverFollowing);
  }, [controller, serverFollowing, workspaceId, rootId]);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const copy = threadFollowCopy(view.following, formatMessage);
  return {
    view,
    copy,
    toggle: () => void controller.toggle(),
    dismissError: controller.dismissError,
  };
}
