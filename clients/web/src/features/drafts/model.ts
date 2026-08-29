import type { Channel } from "@momo/core/lib/api";
import type { DraftRecord } from "@/features/chat/draftStore";
import {
  channelLabelParts,
  type Directory,
} from "@/features/workspace/useWorkspace";

// =============================================================================
// 초안 패널의 판정. 저장 스키마는 `draftStore`가 지고, 여기는 목록이 무엇을
// 보여 주고 무엇을 버리는지만 말한다.
//
// 스레드 컴포저 본문은 이 저장소에 없다. 열쇠는 워크스페이스+채널뿐이라, 목록의
// 대상은 채널(공개·비공개·DM)이다. 「스레드 출처」 행은 생길 수 없다.
// =============================================================================

export type DraftKind = Channel["kind"];

export interface DraftDestination {
  text: string;
  handle: string | null;
  kind: DraftKind;
  isAgent: boolean;
}

export interface DraftViewItem {
  workspaceId: string;
  channelId: string;
  text: string;
  atMs: number;
  preview: string;
  destination: DraftDestination;
}

/** 미리보기 한 줄. 줄바꿈은 공백으로 접고, 화면의 truncate가 길이를 자른다. */
export function previewDraft(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function liveChannelIdSet(channels: readonly Channel[]): Set<string> {
  const ids = new Set<string>();
  for (const channel of channels) {
    ids.add(channel.id.toLowerCase());
  }
  return ids;
}

/**
 * 채널 목록이 도착한 뒤에만 대상을 확정한다. 도착 전에는 출처 불명 행을
 * 그리지 않고, 도착한 뒤에는 목록에 없는 채널의 초안을 숨긴다.
 */
export function visibleDrafts(
  drafts: readonly DraftRecord[],
  liveChannelIds: ReadonlySet<string>,
  channelsReady: boolean
): DraftRecord[] {
  if (!channelsReady) return [];
  return drafts.filter((draft) =>
    liveChannelIds.has(draft.channelId.toLowerCase())
  );
}

/**
 * 채널이 삭제됐거나 이 멤버가 떠난 초안. `channelsReady`가 아니면 비운다:
 * 로딩·오류 중에 지우면 살아 있는 초안을 함께 버린다.
 */
export function orphanDrafts(
  drafts: readonly DraftRecord[],
  liveChannelIds: ReadonlySet<string>,
  channelsReady: boolean
): DraftRecord[] {
  if (!channelsReady) return [];
  return drafts.filter(
    (draft) => !liveChannelIds.has(draft.channelId.toLowerCase())
  );
}

/**
 * 사이드바 「초안」 줄. 0개면 숨긴다. 채널 목록이 오기 전에는 이 워크스페이스에
 * 초안이 있기만 하면 보여, 로딩 한 프레임에 줄이 사라졌다 나타나지 않게 한다.
 */
export function shouldShowDraftsNav(
  drafts: readonly DraftRecord[],
  liveChannelIds: ReadonlySet<string>,
  channelsReady: boolean
): boolean {
  if (drafts.length === 0) return false;
  if (!channelsReady) return true;
  return drafts.some((draft) =>
    liveChannelIds.has(draft.channelId.toLowerCase())
  );
}

export function draftDestination(
  channel: Channel,
  directory: Directory,
  selfMemberId: string
): DraftDestination {
  const parts = channelLabelParts(channel, directory, selfMemberId);
  return {
    text: parts.text,
    handle: parts.handle,
    kind: channel.kind,
    isAgent: parts.isAgent,
  };
}

export function toDraftViewItem(
  draft: DraftRecord,
  channel: Channel,
  directory: Directory,
  selfMemberId: string
): DraftViewItem {
  return {
    workspaceId: draft.workspaceId,
    channelId: draft.channelId,
    text: draft.text,
    atMs: draft.atMs,
    preview: previewDraft(draft.text),
    destination: draftDestination(channel, directory, selfMemberId),
  };
}

export function channelPathForDraft(channelId: string): string {
  return `/c/${encodeURIComponent(channelId)}`;
}
