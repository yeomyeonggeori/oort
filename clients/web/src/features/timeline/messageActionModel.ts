import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import { pinActionLabel } from "@momo/core/features/timeline/pins";
import { QUICK_REACTIONS } from "@momo/core/features/timeline/reactions";
import { QUOTE_ACTION_LABEL } from "@momo/core/features/timeline/quote";

export type MessageActionItemKey =
  | `react:${string}`
  | "react-more"
  | "reply"
  | "quote"
  | "copy"
  | "pin"
  | "edit"
  | "delete";

export interface MessageActionItem {
  key: MessageActionItemKey;
  testKey: string;
  label: string;
  accessibleLabel?: string;
  tone?: "danger";
}

export const MESSAGE_ACTION_SURFACES = ["menu", "context", "sheet"] as const;
export type MessageActionSurface = (typeof MESSAGE_ACTION_SURFACES)[number];

/** The one inventory rendered by the ⋯ menu, right-click menu and sheet. */
export function messageActionItems(
  available: MessageActionAvailability,
  {
    canCopy,
    copied,
    pinned,
  }: { canCopy: boolean; copied: boolean; pinned: boolean }
): MessageActionItem[] {
  const items: MessageActionItem[] = [];
  if (available.react) {
    for (const emoji of QUICK_REACTIONS) {
      items.push({
        key: `react:${emoji}`,
        testKey: `react-${emoji}`,
        label: emoji,
        accessibleLabel: `${emoji} 반응 남기기`,
      });
    }
    items.push({
      key: "react-more",
      testKey: "react-more",
      label: "다른 반응 고르기",
    });
  }
  if (available.reply) {
    items.push({ key: "reply", testKey: "reply", label: "답글 달기" });
  }
  if (available.quote) {
    items.push({
      key: "quote",
      testKey: "quote",
      label: QUOTE_ACTION_LABEL,
    });
  }
  if (canCopy) {
    items.push({
      key: "copy",
      testKey: "copy",
      label: copied ? "복사됨" : "복사",
      accessibleLabel: copied ? "메시지 복사됨" : "메시지 복사",
    });
  }
  if (available.pin) {
    items.push({
      key: "pin",
      testKey: "pin",
      label: pinActionLabel(pinned),
    });
  }
  if (available.edit) {
    items.push({ key: "edit", testKey: "edit", label: "고치기" });
  }
  if (available.delete) {
    items.push({
      key: "delete",
      testKey: "delete",
      label: "지우기",
      tone: "danger",
    });
  }
  return items;
}

/**
 * Named per surface so tests exercise the same three paths people use. The
 * surface is intentionally not a branch: input changes how the list opens,
 * never which message actions exist once it has opened.
 */
export function messageActionItemsForSurface(
  _surface: MessageActionSurface,
  available: MessageActionAvailability,
  state: { canCopy: boolean; copied: boolean; pinned: boolean }
): MessageActionItem[] {
  return messageActionItems(available, state);
}
