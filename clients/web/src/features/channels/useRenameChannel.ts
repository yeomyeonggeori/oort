import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Channel } from "@momo/core/lib/api";
import { channelRenameFailure, renameChannel, type ChannelRenameFailure } from "@momo/core/features/channels/rename";
import { upsertChannel } from "@momo/core/features/directory/model";

// =============================================================================
// 채널 이름 바꾸기의 왕복 한 벌 (ADR-0225 D10, #5835). 낙관 갱신은 하지 않는다: 서버가 답한 뒤에 응답의 `channel` 로 내 채널 목록 캐시를
// 고치고(사이드바 · 채널 머리가 같은 캐시에서 이름을 읽는다), 서버 목록(둘러보기 창)은 다시 읽는다. 실시간 이벤트는 없다 — 다른
// 사람은 다음 채널 목록 조회에서 새 이름을 받는다.
// =============================================================================

export interface RenameChannelHandle {
  /** 보내 놓고 답을 기다리는 중. 창은 이 동안 닫히지 않는다. */
  pending: boolean;
  /** 마지막 거절. 이름을 고치거나 창을 닫으면 지운다. */
  failure: ChannelRenameFailure | null;
  /** 바뀐 채널 줄(성공) 또는 null(거절 · 이미 진행 중). */
  rename: (channelId: string, name: string) => Promise<Channel | null>;
  clearFailure: () => void;
}

export function useRenameChannel(workspaceId: string): RenameChannelHandle {
  const client = useQueryClient();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ChannelRenameFailure | null>(null);

  const rename = useCallback(
    async (channelId: string, name: string): Promise<Channel | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setPending(true);
      setFailure(null);
      try {
        const channel = await renameChannel(workspaceId, channelId, name);
        client.setQueryData<Channel[]>(["channels", workspaceId], (current) =>
          current ? upsertChannel(current, channel) : [channel]
        );
        void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
        void client.invalidateQueries({ queryKey: ["channel-browse", workspaceId] });
        return channel;
      } catch (error) {
        setFailure(channelRenameFailure(error));
        return null;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [workspaceId, client]
  );

  const clearFailure = useCallback(() => setFailure(null), []);
  return { pending, failure, rename, clearFailure };
}
