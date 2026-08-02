import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { fetchThreadReplies, type Message } from "@momo/core/lib/api";
import type { Directory } from "@/features/workspace/useWorkspace";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { startsAuthorGroup } from "@momo/core/features/timeline/model";
import { MessageRow, type MessageRowActions } from "./MessageRow";
import { ThreadComposer } from "./ThreadComposer";
import { chipsFor, type ReactionMap } from "@momo/core/features/timeline/reactions";

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
  actions,
  reactions,
  onOpenWorkSession,
  onClose,
}: {
  workspaceId: string;
  channelId: string;
  root: Message;
  directory: Directory;
  /**
   * B11 — the same actions the channel row offers, so a reply is edited,
   * deleted and reacted to exactly where it is read. Omitted by the work
   * session panel, whose rows are an event log.
   */
  actions?: Omit<MessageRowActions, "chips">;
  reactions?: ReactionMap;
  onOpenWorkSession?: (sessionId: string) => void;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["thread", workspaceId, channelId, root.id],
    queryFn: () => fetchThreadReplies(workspaceId, channelId, root.id),
  });

  const replies = query.data?.messages ?? [];

  /** Per-row actions, with this row's chips folded in. */
  const rowActions = (message: Message): MessageRowActions | undefined =>
    actions && {
      ...actions,
      chips: chipsFor(reactions ?? {}, message.id, actions.myMemberId),
    };

  return (
    // `thread-pane` (goal B6): 넓은 창에서는 그대로 320px 열이고, 폰에서는 채널
    // 표면 전체를 덮는 서랍이 된다 (tokens.css). 320px 패널이 390px 화면에서
    // 채널에 70px만 남기던 자리다.
    <aside
      aria-label="스레드"
      data-testid="thread-panel"
      className="thread-pane flex h-full shrink-0 flex-col border-l border-line bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-body font-semibold">스레드</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="스레드 닫기"
          data-testid="thread-close"
          className="tap-target flex size-6 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <MessageRow
          message={root}
          startsGroup
          directory={directory}
          actions={rowActions(root)}
          onOpenWorkSession={onOpenWorkSession}
        />
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
            actions={rowActions(reply)}
            onOpenWorkSession={onOpenWorkSession}
          />
        ))}
      </div>

      {/* B11 — the half that was missing. Reading a thread and not being able
          to answer in it made 답글 a link to a transcript. Offered only where
          the surface is a conversation: the work session panel passes no
          `actions`, and its event log stays read-only. */}
      {actions && (
        <ThreadComposer
          workspaceId={workspaceId}
          channelId={channelId}
          rootId={root.id}
          onSent={() => void query.refetch()}
        />
      )}
    </aside>
  );
}
