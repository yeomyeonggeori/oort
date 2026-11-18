import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Channel } from "@momo/core/lib/api";
import {
  channelDefaultFailure,
  setChannelDefault,
  type ChannelDefaultFailure,
} from "@momo/core/features/channels/defaultChannel";
import { upsertChannel } from "@momo/core/features/directory/model";

// =============================================================================
// 「기본 채널로 지정」의 왕복 한 벌 (ADR-0224 D6, #5845). `useSetBrowseListed` 와 같은 모양이다: 낙관 갱신 없이 서버가 답한 뒤 응답의
// `channel` 로 내 채널 목록 캐시를 고치고, 서버 목록(둘러보기 창의 「기본」 표시)은 다시 읽게 한다.
// =============================================================================

export type DefaultSwitchResult =
  | { ok: true; channel: Channel }
  | { ok: false; failure: ChannelDefaultFailure };

export interface SetChannelDefault {
  /** 왕복을 보내 놓고 답을 기다리는 채널 id. */
  pending: ReadonlySet<string>;
  /** 같은 채널이 이미 진행 중이면 null(둘째 누름은 버린다). */
  run: (channelId: string, isDefault: boolean) => Promise<DefaultSwitchResult | null>;
}

export function useSetChannelDefault(workspaceId: string): SetChannelDefault {
  const client = useQueryClient();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const run = useCallback(
    async (channelId: string, isDefault: boolean): Promise<DefaultSwitchResult | null> => {
      if (inFlight.current.has(channelId)) return null;
      inFlight.current.add(channelId);
      setPending((current) => new Set(current).add(channelId));
      try {
        const channel = await setChannelDefault(workspaceId, channelId, isDefault);
        client.setQueryData<Channel[]>(["channels", workspaceId], (current) =>
          current ? upsertChannel(current, channel) : [channel]
        );
        void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
        void client.invalidateQueries({ queryKey: ["channel-browse", workspaceId] });
        return { ok: true, channel };
      } catch (error) {
        return { ok: false, failure: channelDefaultFailure(error) };
      } finally {
        inFlight.current.delete(channelId);
        setPending((current) => {
          const next = new Set(current);
          next.delete(channelId);
          return next;
        });
      }
    },
    [workspaceId, client]
  );

  return { pending, run };
}
