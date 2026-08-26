import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import { pinActionLabel } from "@momo/core/features/timeline/pins";
import { QUICK_REACTIONS } from "@momo/core/features/timeline/reactions";
import { QUOTE_ACTION_LABEL } from "@momo/core/features/timeline/quote";
import {
  copyLinkActionLabel,
  copyMessageActionLabel,
} from "@momo/core/features/timeline/copyLabels";

export type MessageActionItemKey =
  | `react:${string}`
  | "react-more"
  | "reply"
  | "quote"
  | "copy"
  | "copy-link"
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

export interface MessageActionCopyState {
  canCopy: boolean;
  copied: boolean;
  canCopyLink: boolean;
  copiedLink: boolean;
  pinned: boolean;
}

/**
 * UX-D3 (#1755) inventory notes, so a later surface cannot "complete" buzz by
 * inventing a server. The ⋯ / right-click / sheet lists are this function;
 * they must not grow a local branch.
 *
 *   * copy        — already shipped as raw-markdown copy. Visible copy is
 *                   `copyMessageActionLabel` so it sits next to the link
 *                   action; both are verb phrases, same as the phone sheet.
 *   * copy-link   — `#/c/{ch}?msg=&seq=` already lands (ChatShell + searchHitPath).
 *   * mark unread — PUT read-state is monotone (`GREATEST`). Accrued.
 *   * remind later / report — no surface. Accrued.
 */
export function messageActionItems(
  available: MessageActionAvailability,
  { canCopy, copied, canCopyLink, copiedLink, pinned }: MessageActionCopyState
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
      label: copyMessageActionLabel(copied),
      accessibleLabel: copyMessageActionLabel(copied),
    });
  }
  if (canCopyLink) {
    items.push({
      key: "copy-link",
      testKey: "copy-link",
      label: copyLinkActionLabel(copiedLink),
      accessibleLabel: copyLinkActionLabel(copiedLink),
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
  state: MessageActionCopyState
): MessageActionItem[] {
  return messageActionItems(available, state);
}

/**
 * Copy receipts have to stay on screen. `react-more` hands off to a picker
 * on the pointer menus (⋯ and right-click).
 *
 * The sheet never meets this key: `react-more` is filtered out of `regular`
 * and its own button always `close()`s first. The name reads as a three-surface
 * fact; it is a two-surface fact. If `regular` later includes that key, the
 * picker would open on top of the sheet and Esc would have to fire twice.
 */
export function actionKeepsMenuOpen(key: MessageActionItemKey): boolean {
  return key === "copy" || key === "copy-link" || key === "react-more";
}
