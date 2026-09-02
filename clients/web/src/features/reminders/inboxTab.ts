import {
  filterLabel,
  panelId,
  parseFilter,
  tabId,
  type InboxFilter,
} from "@momo/core/features/inbox/model";
import type { FilterTabsSpec } from "@momo/core/features/common/filterTabs";
import { REMINDER_TAB_LABEL } from "@momo/core/features/reminders/model";

/**
 * Web-only 4th inbox tab. Core `InboxFilter` stays three values so the phone
 * surface does not grow a tab it cannot serve yet.
 */
export type WebInboxFilter = InboxFilter | "reminders";

export function withRemindersTab(available: InboxFilter[]): WebInboxFilter[] {
  return [...available, "reminders"];
}

export function parseWebInboxFilter(
  raw: string | null,
  available: InboxFilter[]
): WebInboxFilter {
  if (raw === "reminders") return "reminders";
  return parseFilter(raw, available);
}

export function webInboxFilterLabel(filter: WebInboxFilter): string {
  return filter === "reminders" ? REMINDER_TAB_LABEL : filterLabel(filter);
}

export function webInboxTabId(filter: WebInboxFilter): string {
  return filter === "reminders" ? "inbox-tab-reminders" : tabId(filter);
}

export function webInboxPanelId(filter: WebInboxFilter): string {
  return filter === "reminders" ? "inbox-panel-reminders" : panelId(filter);
}

export function webInboxFilterTabs(
  values: WebInboxFilter[]
): FilterTabsSpec<WebInboxFilter> {
  return {
    label: "인박스 필터",
    values,
    labelFor: webInboxFilterLabel,
    tabId: webInboxTabId,
    panelId: webInboxPanelId,
    testId: webInboxTabId,
  };
}
