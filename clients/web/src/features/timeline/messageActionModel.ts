import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import { pinActionLabel } from "@momo/core/features/timeline/pins";
import { QUICK_REACTIONS } from "@momo/core/features/timeline/reactions";
import { QUOTE_ACTION_LABEL } from "@momo/core/features/timeline/quote";
import {
  copyLinkActionLabel,
  copyMessageActionLabel,
} from "@momo/core/features/timeline/copyLabels";
import { REMINDER_MENU_LABEL } from "@momo/core/features/reminders/model";
import { MARK_UNREAD_ACTION_LABEL } from "@momo/core/features/readState/copy";

export type MessageActionItemKey =
  | `react:${string}`
  | "react-more"
  | "reply"
  | "quote"
  | "copy"
  | "copy-link"
  | "pin"
  | "remind"
  | "mark-unread"
  | "edit"
  | "delete";

/**
 * 묶음 (#5192, Buzz 대응표). 포인터 메뉴(⋯·우클릭)는 같은 묶음끼리 모아 묶음 사이에 구분선을 긋는다.
 *
 *   react        빠른 반응 · 다른 반응 고르기
 *   reply        답글 달기
 *   message      고치기(내 글 메시지만) · 인용해서 답하기 · 고정 · 나중에 알림 · 여기부터 안 읽음 (이 메시지에 하는 일)
 *   copy         메시지 복사 · 링크 복사
 *   destructive  지우기(내 메시지만). 구분선 아래 혼자 맨 아래에 서서 자주 쓰는 고치기와 붙어 있지 않다.
 *
 * 고치기는 **메뉴 첫 줄**이고 도구 막대에는 올리지 않는다: Buzz(`MessageActionBar.tsx`)도 도구 막대는 반응·답글·링크 복사·⋮이고 고치기는
 * 내 메시지에서만 ⋮ 메뉴의 맨 첫 줄이며(지우기는 구분선 아래), Slack도 ⋮ 안의 「Edit message」와 빈 입력칸 ↑로 둔다. 찾기 어렵다는 지적은
 * 첫 줄 승격(옛 15~16번째)과 빈 입력칸 ↑(#5191)로 닫는다. 도구 막대에 연필을 올리면 내 행의 막대만 34px 늘어 좁은 판 겹침(#4231 1번)이
 * 커지고 내·남의 행의 막대 모양이 달라진다(인계 문서에 측정값).
 *
 * 값이 문자열이 아니라 숫자인 이유: 문구 장부(`direct-copy`)가 코드 안의 영어 낱말 문자열을 사용자 문구 후보로 세기 때문이다.
 * 기술 식별자에 장부 칸을 쓰지 않는다(이름은 식별자라 세지 않는다).
 */
export const MESSAGE_ACTION_GROUP = {
  react: 0,
  reply: 1,
  message: 2,
  copy: 3,
  destructive: 4,
} as const;
export type MessageActionGroup =
  (typeof MESSAGE_ACTION_GROUP)[keyof typeof MESSAGE_ACTION_GROUP];

/** 묶음이 서는 표면. `toolbar` = 호버 도구 막대, `menu` = ⋯ 와 우클릭이 같이 쓰는 목록. */
export const MESSAGE_ACTION_PLACE = { toolbar: 0, menu: 1 } as const;
export type MessageActionPlace =
  (typeof MESSAGE_ACTION_PLACE)[keyof typeof MESSAGE_ACTION_PLACE];

/**
 * 묶음이 서는 자리. **한 표**다: 어느 표면에 무엇이 서는지는 여기서만 정한다.
 *
 *   toolbar  호버 도구 막대가 직접 보여 주는 묶음(반응·답글). 포인터 메뉴는 이것을 되풀이하지 않는다. 메뉴 안에 반응 줄이
 *            있던 것이 owner가 투박하다고 한 모양이고, Buzz는 도구 막대와 메뉴가 서로 겹치지 않는다.
 *   menu     ⋯ 와 우클릭이 같이 쓰는 목록(두 표면은 늘 같은 목록이다).
 *
 * 길게 누르기 시트(`sheet`)는 도구 막대가 없는 터치 표면이라 **전부** 낸다(반응·답글도). 그래서 어떤 동작도 포인터에서
 * 사라지지 않는다: 도구 막대 ∪ 메뉴 = 시트 = 전체 인벤토리(시험이 잠근다).
 *
 * 답글을 메뉴에도 두고 싶으면(우클릭 한 번에 답글) 그 묶음의 배열에 `MESSAGE_ACTION_PLACE.menu`를 더하는 한 줄이다. 그때는
 * 시험의 「겹침 없음」 한 줄이 Buzz 규칙(되풀이하지 않는다)을 지키는 단정이라 함께 바꾸는 결정이 된다.
 */
export const MESSAGE_ACTION_GROUP_PLACEMENT: Readonly<
  Record<MessageActionGroup, readonly MessageActionPlace[]>
> = {
  [MESSAGE_ACTION_GROUP.react]: [MESSAGE_ACTION_PLACE.toolbar],
  [MESSAGE_ACTION_GROUP.reply]: [MESSAGE_ACTION_PLACE.toolbar],
  [MESSAGE_ACTION_GROUP.message]: [MESSAGE_ACTION_PLACE.menu],
  [MESSAGE_ACTION_GROUP.copy]: [MESSAGE_ACTION_PLACE.menu],
  [MESSAGE_ACTION_GROUP.destructive]: [MESSAGE_ACTION_PLACE.menu],
};

export interface MessageActionItem {
  key: MessageActionItemKey;
  testKey: string;
  label: string;
  accessibleLabel?: string;
  tone?: "danger";
  group: MessageActionGroup;
}

export const MESSAGE_ACTION_SURFACES = ["menu", "context", "sheet"] as const;
export type MessageActionSurface = (typeof MESSAGE_ACTION_SURFACES)[number];
/** 길게 누르기 시트. 목록에서 꺼내 쓰는 이유: 같은 낱말 문자열을 한 번 더 적으면 문구 장부가 사용자 문구로 센다. */
const SHEET_SURFACE = MESSAGE_ACTION_SURFACES[2];

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
 *   * mark unread — ADR-0178. 「여기부터 안 읽음」 in this inventory.
 *   * remind later — ADR-0175 / #1888. 「나중에 알림」 in this inventory.
 *   * report — no surface. Accrued.
 *
 * 순서는 묶음 순서다(#5192): react · reply · message · copy · destructive. 한 묶음 안의 순서도 여기서만 정한다.
 * 어느 묶음이 어느 표면에 서는지는 `MESSAGE_ACTION_GROUP_PLACEMENT` 한 표다.
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
        group: MESSAGE_ACTION_GROUP.react,
      });
    }
    items.push({
      key: "react-more",
      testKey: "react-more",
      label: "다른 반응 고르기",
      group: MESSAGE_ACTION_GROUP.react,
    });
  }
  if (available.reply) {
    items.push({
      key: "reply",
      testKey: "reply",
      label: "답글 달기",
      group: MESSAGE_ACTION_GROUP.reply,
    });
  }
  if (available.edit) {
    items.push({
      key: "edit",
      testKey: "edit",
      label: "고치기",
      group: MESSAGE_ACTION_GROUP.message,
    });
  }
  if (available.quote) {
    items.push({
      key: "quote",
      testKey: "quote",
      label: QUOTE_ACTION_LABEL,
      group: MESSAGE_ACTION_GROUP.message,
    });
  }
  if (available.pin) {
    items.push({
      key: "pin",
      testKey: "pin",
      label: pinActionLabel(pinned),
      group: MESSAGE_ACTION_GROUP.message,
    });
  }
  if (available.remind) {
    items.push({
      key: "remind",
      testKey: "remind",
      label: REMINDER_MENU_LABEL,
      group: MESSAGE_ACTION_GROUP.message,
    });
  }
  if (available.markUnread) {
    items.push({
      key: "mark-unread",
      testKey: "mark-unread",
      label: MARK_UNREAD_ACTION_LABEL,
      group: MESSAGE_ACTION_GROUP.message,
    });
  }
  if (canCopy) {
    items.push({
      key: "copy",
      testKey: "copy",
      label: copyMessageActionLabel(copied),
      accessibleLabel: copyMessageActionLabel(copied),
      group: MESSAGE_ACTION_GROUP.copy,
    });
  }
  if (canCopyLink) {
    items.push({
      key: "copy-link",
      testKey: "copy-link",
      label: copyLinkActionLabel(copiedLink),
      accessibleLabel: copyLinkActionLabel(copiedLink),
      group: MESSAGE_ACTION_GROUP.copy,
    });
  }
  if (available.delete) {
    items.push({
      key: "delete",
      testKey: "delete",
      label: "지우기",
      tone: "danger",
      group: MESSAGE_ACTION_GROUP.destructive,
    });
  }
  return items;
}

/**
 * Named per surface so tests exercise the same three paths people use. ⋯ and
 * right-click are **always the same list** (both are the pointer menu); the sheet
 * is the whole inventory because a finger has no toolbar. What differs is only
 * the group table above, never a per-surface branch in the list.
 */
export function messageActionItemsForSurface(
  surface: MessageActionSurface,
  available: MessageActionAvailability,
  state: MessageActionCopyState
): MessageActionItem[] {
  const items = messageActionItems(available, state);
  if (surface === SHEET_SURFACE) return items;
  return items.filter((item) =>
    MESSAGE_ACTION_GROUP_PLACEMENT[item.group].includes(MESSAGE_ACTION_PLACE.menu)
  );
}

/**
 * 호버 도구 막대가 직접 보여 주는 항목(반응·답글). 도구 막대는 이 목록으로 자기 단추를 정한다: 표와 화면이 따로 놀 수 없다.
 * 반응 **칸**은 빈도 저장소가 정한다(`HOVER_TOOLBAR_SLOT_COUNT`). 여기서는 반응이 서는지 여부만 말한다.
 */
export function messageToolbarItems(
  available: MessageActionAvailability,
  state: MessageActionCopyState
): MessageActionItem[] {
  return messageActionItems(available, state).filter((item) =>
    MESSAGE_ACTION_GROUP_PLACEMENT[item.group].includes(MESSAGE_ACTION_PLACE.toolbar)
  );
}

/**
 * 같은 묶음이 이어진 덩어리로 자른다. 메뉴는 덩어리 사이에 구분선을 긋는다: 첫 덩어리 앞·마지막 덩어리 뒤·빈 덩어리는
 * 구조상 생기지 않는다(비면 덩어리 자체가 없다).
 */
export function messageActionGroups(
  items: readonly MessageActionItem[]
): MessageActionItem[][] {
  const groups: MessageActionItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last[0].group === item.group) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

/**
 * Copy receipts have to stay on screen: the label flips in place (「복사됨」),
 * so the pointer menus (⋯ and right-click) and the sheet leave the list open.
 */
export function actionKeepsMenuOpen(key: MessageActionItemKey): boolean {
  return key === "copy" || key === "copy-link";
}
