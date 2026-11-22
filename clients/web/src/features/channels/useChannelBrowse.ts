import { createContext, useCallback, useContext, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import {
  channelJoinFailure,
  joinChannel,
  type ChannelBrowseFailure,
} from "@momo/core/features/channels/browse";
import { upsertChannel } from "@momo/core/features/directory/model";
import { withChannelMemberAdded } from "@momo/core/features/channels/memberAdd";
import type { DialogFocusTarget } from "@/design/ui/dialog";
import { useSession } from "@/app/session";
import { rosterQueryKey } from "@/features/workspace/useWorkspace";

// =============================================================================
// 채널 둘러보기 창의 문과 참여 (ADR-0224 화면 · D4, #5842).
//
// 문은 둘이다(사이드바 「채널」 머리의 +, ⌘K). 창은 셸에 한 벌만 있고 문은 여는 동사만 받는다(채널 만들기 ·
// 멤버 추가와 같은 틀). 셸 밖에서 그리는 화면(시험 · 하네스)에는 동사가 없다 — 그때 문은 서지 않는다
// (`useOpenChannelBrowse()` 가 null). 열 길이 없는 문을 세우지 않는다.
// =============================================================================

export interface ChannelBrowseTarget {
  /** 닫을 때 캐럿을 돌려줄 문(사이드바 +). 없으면 여는 순간의 activeElement. */
  opener?: DialogFocusTarget | null;
  /** 거르기 칸에 미리 넣을 말(⌘K 에서 친 이름). */
  query?: string;
}

export type OpenChannelBrowse = (target?: ChannelBrowseTarget) => void;

export const ChannelBrowseOpenContext = createContext<OpenChannelBrowse | null>(null);

/** 창을 여는 동사. 셸(`ChannelBrowseProvider`) 밖이면 null — 그 화면에는 둘러보기 문이 없다. */
export function useOpenChannelBrowse(): OpenChannelBrowse | null {
  return useContext(ChannelBrowseOpenContext);
}

/** 창이 지금 열려 있는가(전역 단축키가 물러서고, 사이드바 머리의 +가 붙들려 있게). */
export const ChannelBrowseOpenStateContext = createContext(false);

export function useChannelBrowseOpen(): boolean {
  return useContext(ChannelBrowseOpenStateContext);
}

export interface JoinBrowsedChannel {
  /** 참여를 보내 놓고 답을 기다리는 채널 id. */
  pending: ReadonlySet<string>;
  /** 채널 id → 마지막 실패. 다시 누르면 지워진다. */
  failures: ReadonlyMap<string, ChannelBrowseFailure>;
  join: (channelId: string) => Promise<Channel | null>;
}

/**
 * 스스로 참여 한 번. 같은 채널을 두 번 눌러도 요청은 하나다(답을 기다리는 동안 둘째 누름은 버린다 — 서버도 늦은 쪽에
 * `newlyJoined:false` 로 답하지만 두 번 보낼 까닭이 없다).
 *
 * 성공하면 응답의 `channel` 을 채널 목록 캐시에 바로 세우고(다시 읽기 한 번을 기다리지 않는다), 명부에도 나를 그 채널에
 * 넣는다 — 채널 머리의 멤버 수는 명부의 `channelIds` 로 세므로, 넣지 않으면 다음 명부 읽기까지 나를 빼고 센다(#5784 와
 * 같은 까닭, `useCreateChannel`). 읽음 위치는 서버가 같은 tx 에서 채널 끝으로 옮겼으니(D9) 읽음 투영을 다시 읽는다.
 */
export function useJoinBrowsedChannel(onJoined: (channel: Channel) => void): JoinBrowsedChannel {
  const { session, workspaceId } = useSession();
  const selfId = session.member.id;
  const client = useQueryClient();
  const navigate = useNavigate();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, ChannelBrowseFailure>>(() => new Map());

  const join = useCallback(
    async (channelId: string): Promise<Channel | null> => {
      if (inFlight.current.has(channelId)) return null;
      inFlight.current.add(channelId);
      setPending((current) => new Set(current).add(channelId));
      setFailures((current) => {
        if (!current.has(channelId)) return current;
        const next = new Map(current);
        next.delete(channelId);
        return next;
      });
      try {
        const { channel } = await joinChannel(workspaceId, channelId);
        client.setQueryData<Channel[]>(["channels", workspaceId], (current) =>
          current ? upsertChannel(current, channel) : [channel]
        );
        void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
        client.setQueryData<RosterMember[]>(rosterQueryKey(workspaceId), (current) =>
          current ? withChannelMemberAdded(current, channel.id, selfId) : current
        );
        void client.invalidateQueries({ queryKey: rosterQueryKey(workspaceId) });
        void client.invalidateQueries({ queryKey: ["read-state", workspaceId] });
        onJoined(channel);
        navigate(`/c/${channel.id}`);
        return channel;
      } catch (error) {
        setFailures((current) => new Map(current).set(channelId, channelJoinFailure(error)));
        return null;
      } finally {
        inFlight.current.delete(channelId);
        setPending((current) => {
          const next = new Set(current);
          next.delete(channelId);
          return next;
        });
      }
    },
    [workspaceId, selfId, client, navigate, onJoined]
  );

  return { pending, failures, join };
}
