import { createContext, useCallback, useContext, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { createChannel, type Channel, type CreateChannelInput } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { upsertChannel } from "@momo/core/features/directory/model";
import { createChannelFailure, type CreateChannelFailure } from "@momo/core/features/channels/model";

// =============================================================================
// 채널 만들기 (AX-1a / MOMO-614): one place creates a channel, so the sidebar
// header, the sidebar empty state and the empty workspace cannot drift apart.
//
// Shaped after useOpenDm for the same reason it was: the SERVER names the
// channel. The POST answers with the created row, so this navigates to the id
// it was given instead of searching the local list for "the channel I just
// made", and it seeds that row into the channels cache on the way there so the
// sidebar shows it immediately rather than one refetch later.
// =============================================================================

export interface CreateChannelHandle {
  /** A create is in flight. The dialog disables its inputs while this is true. */
  pending: boolean;
  /** The last rejection, addressed to a field or to the form. */
  failure: CreateChannelFailure | null;
  /** Resolves true when the channel was created and the route changed. */
  create: (input: CreateChannelInput) => Promise<boolean>;
  /** Drop the rejection because the input it was about has changed. */
  clearFailure: () => void;
}

export function useCreateChannel(): CreateChannelHandle {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CreateChannelFailure | null>(null);

  const create = useCallback(
    async (input: CreateChannelInput): Promise<boolean> => {
      setPending(true);
      setFailure(null);
      try {
        const created = await createChannel(workspaceId, input);
        // upsert, not append: the same rule the DM path uses, and it compares
        // ids case-insensitively, because a channel that arrived from another
        // response in the other case would otherwise become a second row for
        // one channel.
        client.setQueryData<Channel[]>(["channels", workspaceId], (current) =>
          current ? upsertChannel(current, created.channel) : [created.channel]
        );
        void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
        navigate(`/c/${created.channel.id}`);
        return true;
      } catch (error) {
        setFailure(createChannelFailure(error));
        return false;
      } finally {
        setPending(false);
      }
    },
    [workspaceId, client, navigate]
  );

  const clearFailure = useCallback(() => setFailure(null), []);

  return { pending, failure, create, clearFailure };
}

// ---- opening the dialog from anywhere in the shell --------------------------
// Three entry points open the same dialog, and a dialog per entry point would
// mean three copies of the form state and three ways for one of them to go
// stale. So the shell owns one dialog and hands down the verb.

export const CreateChannelOpenContext = createContext<(() => void) | null>(null);

export function useOpenCreateChannel(): () => void {
  const open = useContext(CreateChannelOpenContext);
  if (!open) {
    throw new Error("useOpenCreateChannel must be used inside CreateChannelProvider");
  }
  return open;
}

/**
 * 폼 다이얼로그가 지금 열려 있는가.
 *
 * 셸의 전역 단축키(⌘K, ⌘⇧K, ⌘,, ⌘⇧A)는 window에 걸려 있어 모달이 떠 있어도
 * 그대로 발화했다. ⌘K는 팔레트를 폼 위에 겹쳐 띄우고 캐럿을 가져갔으며, 거기서
 * 채널을 하나 고르면 폼이 열린 채로 다른 채널로 이동했다(R2 M4). 모달이 떠
 * 있다는 것은 그동안 앱의 유일한 대화 상대가 그것이라는 뜻이므로, 전역 키는 이
 * 값을 보고 물러선다.
 *
 * 여는 함수와 열림 상태를 다른 컨텍스트로 나눈 이유는, 열고 닫을 때마다 verb만
 * 쓰는 구독자(사이드바, 본문 빈 상태)까지 다시 그리지 않기 위해서다.
 */
export const CreateChannelOpenStateContext = createContext(false);

export function useCreateChannelOpen(): boolean {
  return useContext(CreateChannelOpenStateContext);
}
