import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { uuidEq, type Channel } from "@momo/core/lib/api";

interface NotificationTarget {
  workspaceId: string;
  channelId: string;
  previousMuted: boolean;
  muted: boolean;
}

// 알림은 켜짐·꺼짐을 즉시 보인다(#4797). 이 훅은 muted 값만 바꾸고 행을 지우지
// 않는다. 나가기의 확인·실패 화면을 보존하는 정본의 삭제 규칙(#1937)과 분리한다.
export function useChannelNotificationMutation({
  mutationFn,
  onStart,
  onSuccess,
  onError,
}: {
  mutationFn: (target: NotificationTarget) => Promise<unknown>;
  onStart: () => void;
  onSuccess: () => void;
  onError: () => void;
}) {
  const client = useQueryClient();
  const [optimisticMute, setOptimisticMute] = useState<NotificationTarget | null>(null);
  const mutation = useMutation({
    mutationFn,
    // 워크스페이스나 채널이 바뀌어도 요청 당시 대상만 갱신·복구한다.
    onMutate: async (target) => {
      onStart();
      setOptimisticMute(target);
      const queryKey = ["channels", target.workspaceId];
      await client.cancelQueries({ queryKey });
      client.setQueryData<Channel[]>(queryKey, (rows) =>
        rows?.map((row) => uuidEq(row.id, target.channelId) ? { ...row, muted: target.muted } : row)
      );
    },
    onSuccess,
    onError: (_error, target) => {
      setOptimisticMute(null);
      client.setQueryData<Channel[]>(["channels", target.workspaceId], (rows) =>
        rows?.map((row) => uuidEq(row.id, target.channelId)
          ? { ...row, muted: target.previousMuted } : row)
      );
      onError();
    },
    onSettled: async (_data, _error, target) => {
      await client.invalidateQueries({ queryKey: ["channels", target.workspaceId] });
      setOptimisticMute(null);
    },
  });
  return { mutation, optimisticMute };
}
