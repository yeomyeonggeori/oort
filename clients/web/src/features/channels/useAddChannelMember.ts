import { createContext, useCallback, useContext, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { addChannelMember, type RosterMember } from "@momo/core/lib/api";
import {
  addChannelMemberFailure,
  withChannelMemberAdded,
} from "@momo/core/features/channels/memberAdd";
import { useSession } from "@/app/session";

// =============================================================================
// 채널에 멤버 추가 (검수 #2): one dialog for the whole shell adds people to a
// channel, so the empty-channel invite has the same behaviour wherever it is
// opened from.
//
// Shaped after useCreateChannel for the same reasons: the shell owns one dialog
// and hands down the verb, and the write goes through the roster cache
// (`["roster", workspaceId]`) that already feeds the picker. Each roster row
// carries its own channelIds, so adding a member is a local edit of that row —
// the channel appears in channelIds and channelCount ticks up — which is why
// the picker can show the just-added person flip to "멤버" the instant the
// button is pressed, before the server has answered.
// =============================================================================

/** The channel a member is being added to. Name is only for the dialog title. */
export interface AddChannelMemberTarget {
  id: string;
  name: string;
}

export interface AddChannelMemberHandle {
  /** memberIds whose add is in flight. The row shows an in-button spinner. */
  pendingIds: ReadonlySet<string>;
  /** memberId -> the last rejection about adding that member. */
  failures: ReadonlyMap<string, string>;
  /** Add a member to the channel. Resolves true when the server accepted it. */
  add: (memberId: string) => Promise<boolean>;
  /** Drop a member's rejection because the reader is trying again. */
  clearFailure: (memberId: string) => void;
}

/**
 * The add is optimistic against the roster cache and rolls back on failure.
 * `channelId` is the target; the roster query key is workspace-scoped, so one
 * cache feeds the picker, the header member count and the sidebar alike.
 */
export function useAddChannelMember(channelId: string): AddChannelMemberHandle {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(
    new Map()
  );

  const add = useCallback(
    async (memberId: string): Promise<boolean> => {
      // 이미 이 사람에 대한 추가가 진행 중이면 두 번 쏘지 않는다. 버튼은 그동안
      // 바쁜 상태이므로 클릭이 여기 다시 오는 일은 드물지만, 계약으로 막는다.
      if (pendingIds.has(memberId)) return false;

      const key = ["roster", workspaceId];
      setPendingIds((prev) => new Set(prev).add(memberId));
      setFailures((prev) => {
        if (!prev.has(memberId)) return prev;
        const next = new Map(prev);
        next.delete(memberId);
        return next;
      });

      // 진행 중인 로스터 refetch가 낙관적 갱신을 덮어쓰지 못하게 먼저 세운다
      // (react-query 낙관적 갱신의 표준 순서). 스냅샷은 되돌릴 자리다.
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<RosterMember[]>(key);
      client.setQueryData<RosterMember[]>(key, (current) =>
        current ? withChannelMemberAdded(current, channelId, memberId) : current
      );

      try {
        await addChannelMember(workspaceId, channelId, memberId);
        // 서버가 받았다. 낙관적 값은 유지하고, 진짜 행(가입 시각 등)으로 맞춘다.
        void client.invalidateQueries({ queryKey: key });
        return true;
      } catch (error) {
        // 실패하면 낙관적 편집을 통째로 되돌린다. `withChannelMemberAdded`가
        // 입력을 건드리지 않으므로 previous는 추가 이전 상태 그대로다.
        client.setQueryData<RosterMember[]>(key, previous);
        setFailures((prev) =>
          new Map(prev).set(memberId, addChannelMemberFailure(error))
        );
        return false;
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(memberId);
          return next;
        });
      }
    },
    [pendingIds, workspaceId, channelId, client]
  );

  const clearFailure = useCallback((memberId: string) => {
    setFailures((prev) => {
      if (!prev.has(memberId)) return prev;
      const next = new Map(prev);
      next.delete(memberId);
      return next;
    });
  }, []);

  return { pendingIds, failures, add, clearFailure };
}

// ---- opening the dialog from anywhere in the shell --------------------------
// The empty-channel invite opens this, and a header entry point (W-QA3's menu)
// can too, so the dialog is owned once by the shell and the openers pass the
// channel they mean. The open verb carries the target because, unlike 채널
// 만들기, this dialog is about one specific channel.

export const AddChannelMemberOpenContext = createContext<
  ((target: AddChannelMemberTarget) => void) | null
>(null);

export function useOpenAddChannelMember(): (
  target: AddChannelMemberTarget
) => void {
  const open = useContext(AddChannelMemberOpenContext);
  if (!open) {
    throw new Error(
      "useOpenAddChannelMember must be used inside AddChannelMemberProvider"
    );
  }
  return open;
}

/**
 * 멤버 추가 다이얼로그가 지금 열려 있는가.
 *
 * 셸의 전역 단축키(⌘K, ⌘⇧A)는 window에 걸려 있어 모달이 떠 있어도 발화한다.
 * 채널 만들기·에이전트 프로필과 같은 이유로, 이 모달이 떠 있는 동안에도 전역
 * 키는 물러서야 한다(그래야 ⌘K 팔레트가 폼 위에 겹쳐 뜨지 않는다). 여는 함수와
 * 열림 상태를 다른 컨텍스트로 나눈 이유도 같다: verb만 쓰는 진입점이 열림 상태
 * 변화로 다시 그릴 이유가 없다.
 */
export const AddChannelMemberOpenStateContext = createContext(false);

export function useAddChannelMemberOpen(): boolean {
  return useContext(AddChannelMemberOpenStateContext);
}
