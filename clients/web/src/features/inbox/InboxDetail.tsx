import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  fetchMessages,
  fetchThreadReplies,
  sendMessage,
  type Message,
} from "@momo/core/lib/api";
import type { MailboxEntry } from "@momo/core/features/inbox/mailbox";
import { isComposingEvent } from "@momo/core/features/chat/composerKeys";
import { replyFailureMessage } from "@momo/core/features/timeline/actionCopy";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { Avatar } from "@/features/timeline/MessageRow";
import { MessageBody } from "@/features/timeline/MessageBody";
import { ThreadComposer } from "@/features/timeline/ThreadComposer";
import {
  memberFor,
  useChannels,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { channelPath, watchForMessage } from "./anchor";
import { InboxApprovalActions } from "./InboxApprovalActions";
import { approvalRowControl } from "./approvalsPanel";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";

// =============================================================================
// 인박스 오른쪽 패널 (#3663): 목록에서 고른 항목의 **맥락**.
//
//   DM       그 대화의 최근 메시지 + 답장 입력
//   멘션     나를 부른 메시지와 그 앞뒤 + 답장 입력(그 메시지를 인용 답장)
//   스레드   내 글과 그 스레드의 답글 + 스레드 답장(`ThreadComposer`)
//   처리할 일 무엇을 허락해 달라는지 + 결정 버튼(타임라인 카드와 같은 컨트롤)
//
// 채널 전체(`ChatShell`)를 끼우지 않는다. 그 셸은 라우트·읽음 동결·가상 스크롤을
// 쥐고 있어서 패널 안에서는 두 번째 셸이 된다. 여기는 맥락을 읽고 바로 답하는 데
// 필요한 만큼만이고, 더 보려면 「대화에서 보기」로 같은 메시지에 착지한다.
// =============================================================================

const CONTEXT_PAGE = 20;

function timeText(ms: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}

function ContextRow({
  message,
  directory,
  selfMemberId,
  highlighted,
}: {
  message: Message;
  directory: Directory;
  selfMemberId: string;
  highlighted: boolean;
}) {
  const member = memberFor(directory, message.authorMemberId) ?? null;
  const name = member?.displayName ?? message.authorMemberId.slice(0, 8);
  const isAgent = member?.kind === "agent";
  const body =
    message.state === "deleted" ? "삭제된 메시지입니다." : (message.body ?? "");
  return (
    <li
      data-testid="inbox-context-row"
      data-highlighted={highlighted ? "true" : undefined}
      className={cn(
        "flex gap-3 rounded-md px-3 py-2",
        highlighted && "bg-accent-soft"
      )}
    >
      <span className="shrink-0 pt-0.5">
        <Avatar member={member} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-body font-semibold",
              isAgent ? "text-agent" : "text-ink"
            )}
          >
            {name}
          </span>
          <span className="text-timestamp text-ink-muted" data-numeric>
            {timeText(message.createdAtMs)}
          </span>
        </span>
        <span
          className={cn(
            "text-body",
            message.state === "deleted" ? "text-ink-muted" : "text-ink"
          )}
        >
          <MessageBody
            body={body}
            directory={directory}
            selfMemberId={selfMemberId}
            foldKey={message.id}
          />
        </span>
      </span>
    </li>
  );
}

function useContextMessages(entry: MailboxEntry) {
  const { workspaceId } = useSession();
  return useQuery({
    queryKey: ["inbox-context", workspaceId, entry.key, entry.seq ?? 0],
    enabled: entry.kind !== "task",
    queryFn: async (): Promise<Message[]> => {
      if (entry.kind === "thread" && entry.rootId !== undefined) {
        const page = await fetchThreadReplies(
          workspaceId,
          entry.channelId,
          entry.rootId,
          undefined,
          CONTEXT_PAGE
        );
        return page.messages;
      }
      // 멘션은 그 메시지가 목록에 들어오도록 `before`를 seq 뒤로 조금 민다.
      const page = await fetchMessages(workspaceId, entry.channelId, {
        limit: CONTEXT_PAGE,
        ...(entry.kind === "mention" && entry.seq !== undefined
          ? { before: entry.seq + 3 }
          : {}),
      });
      return page.messages;
    },
  });
}

function ReplyBox({
  entry,
  onSent,
}: {
  entry: MailboxEntry;
  onSent: () => void;
}) {
  const { workspaceId } = useSession();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = draft.trim();

  const send = useCallback(async () => {
    if (body.length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(
        workspaceId,
        entry.channelId,
        crypto.randomUUID(),
        body,
        // 멘션은 그 메시지를 인용해 답한다(ADR-0148): 어느 말에 대한 답인지 남는다.
        entry.kind === "mention" && entry.messageId !== undefined
          ? { replyToId: entry.messageId }
          : undefined
      );
      setDraft("");
      onSent();
    } catch (err) {
      setError(replyFailureMessage(err));
    } finally {
      setSending(false);
    }
  }, [body, sending, workspaceId, entry, onSent]);

  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
      {error && (
        <InlineBanner message={error} tone="error" testId="inbox-reply-error" />
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            if (isComposingEvent(event.nativeEvent)) return;
            event.preventDefault();
            void send();
          }}
          rows={2}
          aria-label={
            entry.kind === "mention" ? "이 메시지에 답장" : "메시지 입력"
          }
          placeholder={
            entry.kind === "mention"
              ? "이 메시지에 답장합니다"
              : `${entry.channelLabel}에게 메시지 보내기`
          }
          data-testid="inbox-reply-input"
          className="min-h-control max-h-40 flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring"
        />
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={body.length === 0 || sending}
          data-testid="inbox-reply-send"
        >
          보내기
        </Button>
      </div>
    </div>
  );
}

export function InboxDetail({
  entry,
  directory,
  offline,
  onBack,
  onToggleRead,
  onDecided,
  readBusy,
}: {
  entry: MailboxEntry;
  directory: Directory;
  offline: boolean;
  /** 좁은 화면에서 목록으로 돌아간다. 넓은 화면에서는 주지 않는다. */
  onBack?: () => void;
  onToggleRead: (entry: MailboxEntry) => void;
  onDecided: (outcome: DecisionOutcome) => void;
  readBusy: boolean;
}) {
  const { session, workspaceId } = useSession();
  const client = useQueryClient();
  const channelsQuery = useChannels(workspaceId);
  const context = useContextMessages(entry);
  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );

  const messages = useMemo(
    () =>
      (context.data ?? [])
        .filter((m) => m.type === "text" || m.type === "system")
        .sort((a, b) => a.seq - b.seq),
    [context.data]
  );

  const refresh = useCallback(() => {
    void client.invalidateQueries({
      queryKey: ["inbox-context", workspaceId, entry.key],
    });
  }, [client, workspaceId, entry.key]);

  const control =
    entry.task === undefined
      ? null
      : approvalRowControl(entry.task, { offline });

  return (
    <section
      aria-label="인박스 맥락"
      data-testid="inbox-detail"
      data-kind={entry.kind}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        {onBack && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onBack}
            aria-label="목록으로"
            data-testid="inbox-detail-back"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-body font-semibold text-ink">
            {entry.typeLabel}
          </h2>
          <p className="truncate text-meta text-ink-muted">{entry.reason}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onToggleRead(entry)}
          disabled={readBusy || entry.seq === undefined || entry.kind === "task"}
          data-testid="inbox-toggle-read"
          hidden={entry.kind === "task"}
        >
          {entry.unread ? "읽음으로 표시" : "안 읽음으로 표시"}
        </Button>
        <Link
          to={channelPath(entry.channelId, entry.seq)}
          onClick={() => {
            if (entry.seq !== undefined) watchForMessage(entry.seq);
          }}
          data-testid="inbox-open-conversation"
          className="press inline-flex h-control-sm items-center rounded-sm px-3 text-body text-ink hover:bg-surface-hover focus-visible:focus-ring"
        >
          대화에서 보기
        </Link>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {entry.kind === "task" ? (
          <div className="flex flex-col gap-3 px-2" data-testid="inbox-task">
            <p className="text-body text-ink">
              <span
                className={cn(
                  "font-semibold",
                  entry.actorIsAgent ? "text-agent" : "text-ink"
                )}
              >
                {entry.actor}
              </span>{" "}
              {entry.preview}
            </p>
            <p className="text-meta text-ink-muted">
              {entry.channelLabel}
              {entry.timeLabel ? ` · ${entry.timeLabel}` : ""}
            </p>
            {entry.task?.detail && (
              <p className="text-body text-ink-muted">{entry.task.detail}</p>
            )}
            {entry.task?.note && (
              <p className="text-meta text-warn" data-testid="inbox-task-note">
                {entry.task.note}
              </p>
            )}
            {entry.task?.managedBy && (
              <p className="text-meta text-ink-muted">
                {entry.task.managedBy} 님이 관리하는 에이전트예요.
              </p>
            )}
            {control?.kind === "decide" && entry.task && (
              <InboxApprovalActions
                approvalId={control.approvalId}
                onSettled={onDecided}
                reversible={entry.task.reversible}
                execution={entry.task.execution}
              />
            )}
            {control?.kind === "offline" && (
              <p
                className="text-meta text-ink-muted"
                data-testid="inbox-approval-offline"
              >
                연결이 끊겨 지금은 결정할 수 없습니다. 다시 연결되면 여기서
                승인하거나 거부할 수 있습니다.
              </p>
            )}
          </div>
        ) : (
          <>
            {entry.kind === "thread" && entry.rootPreview && (
              <div
                className="mx-2 mb-2 rounded-md border border-line px-3 py-2"
                data-testid="inbox-thread-root"
              >
                <p className="text-meta text-ink-muted">내가 쓴 글</p>
                <p className="text-body text-ink">{entry.rootPreview}</p>
              </div>
            )}
            <Skeleton ready={!context.isLoading} rows={3} className="p-2">
              {context.isError ? (
                <InlineBanner
                  message="대화를 불러오지 못했습니다."
                  actionLabel="다시 시도"
                  onAction={() => void context.refetch()}
                  testId="inbox-context-error"
                />
              ) : messages.length === 0 ? (
                <p className="px-3 text-body text-ink-muted">
                  보여 줄 메시지가 없습니다.
                </p>
              ) : (
                <ul className="flex flex-col" data-testid="inbox-context">
                  {messages.map((message) => (
                    <ContextRow
                      key={message.id}
                      message={message}
                      directory={directory}
                      selfMemberId={session.member.id}
                      highlighted={
                        entry.kind === "mention" &&
                        entry.messageId === message.id
                      }
                    />
                  ))}
                </ul>
              )}
            </Skeleton>
          </>
        )}
      </div>

      {entry.kind === "thread" && entry.rootId !== undefined ? (
        <div className="border-t border-line px-4 py-3">
          <ThreadComposer
            workspaceId={workspaceId}
            channelId={entry.channelId}
            rootId={entry.rootId}
            directory={directory}
            channels={channels}
            onSent={refresh}
          />
        </div>
      ) : entry.kind === "task" ? null : offline ? (
        <p
          className="border-t border-line px-4 py-3 text-meta text-ink-muted"
          data-testid="inbox-reply-offline"
        >
          오프라인이라 답장을 보낼 수 없습니다. 연결되면 여기서 답할 수 있습니다.
        </p>
      ) : (
        <ReplyBox entry={entry} onSent={refresh} />
      )}
    </section>
  );
}
