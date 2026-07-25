import { useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { Message } from "@/lib/api";
import { uuidEq } from "@/lib/api";
import { cn } from "@/design/lib/cn";

function MessageRow({
  message,
  selfMemberId,
}: {
  message: Message;
  selfMemberId: string;
}) {
  const mine = uuidEq(message.authorMemberId, selfMemberId);
  const deleted = message.state === "deleted";
  return (
    <div
      className="px-4 py-1"
      data-testid="timeline-message"
      data-seq={message.seq}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-timestamp tabular-nums text-ink-muted">
          #{message.seq}
        </span>
        <span
          className={cn(
            "text-meta font-medium",
            mine ? "text-accent" : "text-ink"
          )}
        >
          {message.authorMemberId.slice(0, 8)}
        </span>
      </div>
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-body leading-relaxed",
          deleted && "italic text-ink-muted"
        )}
      >
        {deleted ? "(삭제된 메시지)" : message.body}
      </p>
    </div>
  );
}

export function Timeline({
  messages,
  selfMemberId,
  onStartReached,
}: {
  messages: Message[];
  selfMemberId: string;
  onStartReached?: () => void;
}) {
  const ref = useRef<VirtuosoHandle>(null);

  return (
    <Virtuoso
      ref={ref}
      className="h-full"
      data={messages}
      data-testid="timeline-virtuoso"
      alignToBottom
      followOutput="auto"
      startReached={onStartReached}
      // initialItemCount forces a first paint of rows independent of the
      // ResizeObserver measurement pass (in an embedded webview the scroller
      // height can resolve a tick after mount, leaving the list empty).
      initialItemCount={Math.min(messages.length, 24)}
      defaultItemHeight={48}
      increaseViewportBy={{ top: 600, bottom: 600 }}
      computeItemKey={(_index, message) => message.id}
      itemContent={(_index, message) => (
        <MessageRow message={message} selfMemberId={selfMemberId} />
      )}
    />
  );
}
