import {
  MAILBOX_FILTERS,
  mailboxFilterLabel,
  mailboxPanelId,
  mailboxTabId,
  parseMailboxFilter,
  type MailboxFilter,
} from "@momo/core/features/inbox/mailbox";
import type { FilterTabsSpec } from "@momo/core/features/common/filterTabs";
import { REMINDER_TAB_LABEL } from "@momo/core/features/reminders/model";

/** 웹 인박스의 탭: 메일함 필터 여섯 + 맨 끝의 「나중에」(리마인더). */
export type WebMailboxFilter = MailboxFilter | "reminders";

export function mailboxTabs(tasksAvailable: boolean): WebMailboxFilter[] {
  // 승인 원장이 없는 서버에서는 「처리할 일」 탭이 언제나 빈 목록이 된다. 빈
  // 목록은 「처리할 일이 없다」로 읽히는데 우리가 모르는 사실이므로 탭을 세우지 않는다.
  return [
    ...MAILBOX_FILTERS.filter((f) => f !== "task" || tasksAvailable),
    "reminders",
  ];
}

export function parseWebMailboxFilter(
  raw: string | null,
  available: readonly WebMailboxFilter[]
): WebMailboxFilter {
  if (raw === "reminders") return "reminders";
  const parsed = parseMailboxFilter(raw);
  return available.includes(parsed) ? parsed : "all";
}

function labelFor(filter: WebMailboxFilter): string {
  return filter === "reminders" ? REMINDER_TAB_LABEL : mailboxFilterLabel(filter);
}
function tabIdFor(filter: WebMailboxFilter): string {
  return filter === "reminders" ? "inbox-tab-reminders" : mailboxTabId(filter);
}
function panelIdFor(filter: WebMailboxFilter): string {
  return filter === "reminders" ? "inbox-panel-reminders" : mailboxPanelId(filter);
}

export function mailboxTabsSpec(
  values: readonly WebMailboxFilter[]
): FilterTabsSpec<WebMailboxFilter> {
  return {
    label: "인박스 필터",
    values,
    labelFor,
    tabId: tabIdFor,
    panelId: panelIdFor,
    testId: tabIdFor,
  };
}

export { tabIdFor as webMailboxTabId, panelIdFor as webMailboxPanelId };
