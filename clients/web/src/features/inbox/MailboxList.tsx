import { useCallback, useRef } from "react";
import { AtSign, MessageSquareReply, ShieldAlert } from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  entryAriaLabel,
  type MailboxEntry,
} from "@momo/core/features/inbox/mailbox";
import { Avatar } from "@/features/timeline/MessageRow";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 인박스 목록 (#3663). 메일함의 한 줄: 보낸 이 · 종류와 장소 · 시각 · 미리보기 ·
// 안 읽음 점. 줄은 링크가 아니라 **선택**이다 — 누르면 오른쪽 패널이 그 맥락을 연다.
// 채널로 나가는 길은 패널의 「대화에서 보기」에 있다.
//
// 안 읽음은 색 하나로만 말하지 않는다: 점 + 굵은 보낸 이 + 스크린리더용 문장.
// ↑/↓ 이동은 목록이 갖고 Enter/클릭은 선택이다 (listbox 패턴, 포커스는 옵션에).
// =============================================================================

function KindGlyph({ kind }: { kind: MailboxEntry["kind"] }) {
  const className = "size-4";
  if (kind === "task") return <ShieldAlert className={cn(className, "text-warn")} />;
  if (kind === "mention") return <AtSign className={cn(className, "text-signal-text")} />;
  return <MessageSquareReply className={cn(className, "text-ink-muted")} />;
}

function Leading({
  entry,
  directory,
}: {
  entry: MailboxEntry;
  directory: Directory;
}) {
  const member =
    entry.actorMemberId === undefined
      ? null
      : (memberFor(directory, entry.actorMemberId) ?? null);
  if (member === null) {
    return (
      <span
        aria-hidden="true"
        className="flex size-8 items-center justify-center rounded-full bg-surface-hover"
      >
        <KindGlyph kind={entry.kind} />
      </span>
    );
  }
  return <Avatar member={member} />;
}

export function MailboxList({
  entries,
  selectedKey,
  onSelect,
  directory,
  testId = "inbox-list",
}: {
  entries: readonly MailboxEntry[];
  selectedKey: string | null;
  onSelect: (entry: MailboxEntry) => void;
  directory: Directory;
  testId?: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-mailbox-row]") ?? []
    );
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    rows[(Math.max(index, 0) + (index < 0 ? 0 : step) + rows.length) % rows.length]?.focus();
  }, []);

  return (
    <ul
      ref={listRef}
      onKeyDown={onKeyDown}
      data-testid={testId}
      aria-label="인박스 목록"
      className="flex flex-col"
    >
      {entries.map((entry) => {
        const selected = entry.key === selectedKey;
        return (
          <li key={entry.key} className="border-b border-line">
            <button
              type="button"
              data-mailbox-row=""
              data-testid="mailbox-row"
              data-kind={entry.kind}
              data-unread={entry.unread ? "true" : "false"}
              aria-current={selected ? "true" : undefined}
              aria-label={entryAriaLabel(entry)}
              title={entry.reason}
              onClick={() => onSelect(entry)}
              className={cn(
                "flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring",
                selected && "bg-surface-pressed"
              )}
            >
              <span className="shrink-0 pt-0.5">
                <Leading entry={entry} directory={directory} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "min-w-0 truncate text-body",
                      entry.unread ? "font-semibold text-ink" : "text-ink",
                      entry.actorIsAgent && "text-agent"
                    )}
                  >
                    {entry.actor}
                  </span>
                  <span
                    className="shrink-0 text-timestamp text-ink-muted"
                    data-numeric
                    data-testid="mailbox-row-time"
                  >
                    {entry.timeLabel}
                  </span>
                </span>
                <span className="truncate text-meta text-ink-muted">
                  {entry.typeLabel}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-body",
                      entry.unread ? "text-ink" : "text-ink-muted"
                    )}
                  >
                    {entry.preview}
                  </span>
                  {entry.unread && (
                    <span
                      data-testid="mailbox-unread"
                      aria-hidden="true"
                      className={cn(
                        "shrink-0 rounded-full bg-signal",
                        entry.unreadCount > 1
                          ? "sidebar-badge text-on-signal"
                          : "size-2"
                      )}
                    >
                      {entry.unreadCount > 1
                        ? entry.unreadCount > 99
                          ? "99+"
                          : entry.unreadCount
                        : null}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
