import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Channel } from "@momo/core/lib/api";
import {
  channelBrowseSwitchFailure,
  setChannelBrowseListed,
  type ChannelBrowseSwitchFailure,
} from "@momo/core/features/channels/browse";
import { upsertChannel } from "@momo/core/features/directory/model";

// =============================================================================
// 「둘러보기에 보이기」 스위치의 왕복 한 벌 (ADR-0224 D2, #5843). 채널 머리 ⋮ 메뉴의 체크 줄과 둘러보기 창의 관리자 묶음이
// 같은 이 훅을 쓴다 — 두 문이 각자 PATCH 를 들면 캐시를 고치는 방식이 갈라진다.
//
// 낙관 갱신은 하지 않는다: 서버가 답한 뒤에 응답의 `channel` 로 캐시를 고친다(줄은 그동안 진행 중으로 서 있고, 실패하면 바꿀
// 것이 없다). 성공하면 내 채널 목록 캐시에 응답을 세우고(사이드바 · 머리 · 관리자 묶음이 함께 바뀐다), 서버 목록(둘러보기 창의
// 위 목록)은 다시 읽는다. 둘러보기는 실시간 이벤트가 없어 다른 사람의 창은 다시 열 때 바뀐 목록을 받는다.
// =============================================================================

export type BrowseSwitchResult =
  | { ok: true; channel: Channel }
  | { ok: false; failure: ChannelBrowseSwitchFailure };

export interface SetBrowseListed {
  /** 왕복을 보내 놓고 답을 기다리는 채널 id. */
  pending: ReadonlySet<string>;
  /** 같은 채널이 이미 진행 중이면 null(둘째 누름은 버린다). */
  run: (channelId: string, listed: boolean) => Promise<BrowseSwitchResult | null>;
}

export function useSetBrowseListed(workspaceId: string): SetBrowseListed {
  const client = useQueryClient();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const run = useCallback(
    async (channelId: string, listed: boolean): Promise<BrowseSwitchResult | null> => {
      if (inFlight.current.has(channelId)) return null;
      inFlight.current.add(channelId);
      setPending((current) => new Set(current).add(channelId));
      try {
        const channel = await setChannelBrowseListed(workspaceId, channelId, listed);
        client.setQueryData<Channel[]>(["channels", workspaceId], (current) =>
          current ? upsertChannel(current, channel) : [channel]
        );
        void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
        void client.invalidateQueries({ queryKey: ["channel-browse", workspaceId] });
        return { ok: true, channel };
      } catch (error) {
        return { ok: false, failure: channelBrowseSwitchFailure(error) };
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
