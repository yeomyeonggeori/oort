import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { removeChannelMember, type RosterMember } from "@momo/core/lib/api";
import {
  channelMemberRemoveFailure,
  withChannelMemberRemoved,
} from "@momo/core/features/channels/memberRemove";
import { useSession } from "@/app/session";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// 채널 멤버 패널의 「채널에서 내보내기」 실행 (#5778). 서버 길은 소유자·관리자 전용 `removeChannelMember`
// (`…/channels/{ch}/members/{member}`) — 「채널 나가기」(본인 길 `leaveChannel`)와 다른 행위다.
//
// 낙관 갱신을 하지 않는다: 확인 단계가 서 있는 파괴 행동이라 사람은 단계를 보고 있고, 줄이 먼저 사라지면 「내보내는 중」과
// 실패 문장이 설 자리가 없다(`channelActions.tsx` 나가기의 design-review #1937 H-1 과 같은 이유). 서버가 받은 **뒤에**
// 명부 캐시에서 그 사람의 이 채널을 빼고, 다시 읽어 서버와 맞춘다. 404(이미 나감)도 명부를 다시 읽는다 — 그 줄은 낡았다.
// =============================================================================

export interface RemoveChannelMemberHandle {
  pending: boolean;
  /** 확인 단계 안에서 하는 말(토스트가 아니다). */
  error: string | null;
  /** 서버가 받았으면 true. */
  remove: (memberId: string) => Promise<boolean>;
  clearError: () => void;
}

export function useRemoveChannelMember(channelId: string): RemoveChannelMemberHandle {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const formatMessage = useFormatMessage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = useCallback(
    async (memberId: string): Promise<boolean> => {
      if (pending) return false;
      const key = ["roster", workspaceId];
      setPending(true);
      setError(null);
      try {
        await removeChannelMember(workspaceId, channelId, memberId);
        await client.cancelQueries({ queryKey: key });
        client.setQueryData<RosterMember[]>(key, (current) =>
          current ? withChannelMemberRemoved(current, channelId, memberId) : current
        );
        void client.invalidateQueries({ queryKey: key });
        return true;
      } catch (cause) {
        const failure = channelMemberRemoveFailure(cause);
        setError(formatMessage(failure.key, failure.values as never));
        if (failure.key === "timeline.memberPanel.removeErrorNotFound") {
          void client.invalidateQueries({ queryKey: key });
        }
        return false;
      } finally {
        setPending(false);
      }
    },
    [pending, workspaceId, channelId, client, formatMessage]
  );

  const clearError = useCallback(() => setError(null), []);

  return { pending, error, remove, clearError };
}
