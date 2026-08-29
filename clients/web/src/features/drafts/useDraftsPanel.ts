import { useMemo } from "react";
import { useSession } from "@/app/session";
import {
  listWorkspaceDrafts,
  useDraftsEpoch,
  type DraftRecord,
} from "@/features/chat/draftStore";
import {
  useChannels,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import type { Channel } from "@momo/core/lib/api";
import {
  liveChannelIdSet,
  shouldShowDraftsNav,
  toDraftViewItem,
  visibleDrafts,
  type DraftViewItem,
} from "./model";

export interface DraftsPanelState {
  items: DraftViewItem[];
  showNav: boolean;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

function allLiveChannels(groups: {
  channels: Channel[];
  dms: Channel[];
}): Channel[] {
  return [...groups.channels, ...groups.dms];
}

function channelsById(channels: Channel[]): Map<string, Channel> {
  const map = new Map<string, Channel>();
  for (const channel of channels) {
    map.set(channel.id.toLowerCase(), channel);
  }
  return map;
}

function viewItems(
  drafts: DraftRecord[],
  live: Channel[],
  directory: Directory,
  selfMemberId: string
): DraftViewItem[] {
  const byId = channelsById(live);
  const items: DraftViewItem[] = [];
  for (const draft of drafts) {
    const channel = byId.get(draft.channelId.toLowerCase());
    if (!channel) continue;
    items.push(toDraftViewItem(draft, channel, directory, selfMemberId));
  }
  return items;
}

/**
 * 초안 목록과 사이드바 항법이 같은 판정을 읽는다. 채널 목록이 오기 전에는
 * 출처 불명 행을 그리지 않고, 온 뒤에는 목록에 없는 채널을 숨긴다. 저장소
 * 삭제는 여기서 하지 않는다: 로딩 한 프레임의 빈 목록이 살아 있는 초안을
 * 지우는 길을 막기 위해서다. 고아는 TTL·정원·그 채널을 다시 열 때의
 * `readDraft`가 정리한다.
 */
export function useDraftsPanel(): DraftsPanelState {
  const { session, workspaceId } = useSession();
  const epoch = useDraftsEpoch();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const groups = channelsQuery.groups;
  const live = useMemo(() => allLiveChannels(groups), [groups]);
  const liveIds = useMemo(() => liveChannelIdSet(live), [live]);
  const channelsReady = channelsQuery.isSuccess;
  const drafts = useMemo(
    () => listWorkspaceDrafts(workspaceId),
    [workspaceId, epoch]
  );

  const visible = visibleDrafts(drafts, liveIds, channelsReady);
  const items = channelsReady
    ? viewItems(visible, live, directoryQuery.directory, session.member.id)
    : [];

  return {
    items,
    showNav: shouldShowDraftsNav(drafts, liveIds, channelsReady),
    isPending: channelsQuery.isPending && channelsQuery.data === undefined,
    isError: channelsQuery.isError && channelsQuery.data === undefined,
    refetch: () => {
      void channelsQuery.refetch();
    },
  };
}
