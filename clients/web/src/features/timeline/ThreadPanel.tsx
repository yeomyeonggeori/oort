import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { fetchThreadReplies, type Message } from "@/lib/api";
import type { Directory } from "@/features/workspace/useWorkspace";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { startsAuthorGroup } from "./model";
import { MessageRow } from "./MessageRow";

// =============================================================================
// Thread panel (R-1 §3 "스레드 진입 자리", P12: replies live outside the channel
// so the main view stays readable). A right-hand panel rather than an inline
// expansion, sharing the exact MessageRow anatomy of the channel timeline.
// =============================================================================

export function ThreadPanel({
  workspaceId,
  channelId,
  root,
  directory,
  onClose,
}: {
  workspaceId: string;
  channelId: string;
  root: Message;
  directory: Directory;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["thread", workspaceId, channelId, root.id],
    queryFn: () => fetchThreadReplies(workspaceId, channelId, root.id),
  });

  const replies = query.data?.messages ?? [];

  return (
    <aside
      aria-label="스레드"
      data-testid="thread-panel"
      className="flex h-full w-pane shrink-0 flex-col border-l border-line bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-body font-semibold">스레드</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="스레드 닫기"
          data-testid="thread-close"
          className="flex size-6 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <MessageRow message={root} startsGroup directory={directory} />
        <div className="mx-4 my-2 h-px bg-line" />

        {query.isLoading && <SkeletonRows rows={3} className="p-4" />}
        {query.error && (
          <InlineBanner
            message="답글을 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="thread-error"
          />
        )}
        {!query.isLoading && !query.error && replies.length === 0 && (
          <EmptyInvite
            headline="첫 답글을 남겨 이 대화를 이어가세요."
            testId="thread-empty"
          />
        )}
        {replies.map((reply, index) => (
          <MessageRow
            key={reply.seq}
            message={reply}
            startsGroup={startsAuthorGroup(replies[index - 1], reply)}
            directory={directory}
          />
        ))}
      </div>
    </aside>
  );
}
