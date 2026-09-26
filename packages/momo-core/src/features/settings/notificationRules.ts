// =============================================================================
// 알림 규칙 — member-global notification rules (ADR-0124 증보 1, W-B2-3).
//
// Wire contract: docs/api/openapi.yaml `notification-rules` (GET/PUT),
// server-rust/bins/momo-server/src/routes/notification_rules.rs,
// server/Migrations/066_notification_rule.sql.
//
// Two orthogonal switches, both the SIGNED-IN member's own, workspace-global:
//   * dnd                   — suppress every push for me in this workspace.
//   * mentionOverridesMute  — let a mention through a channel I muted (018).
//   * dndUntilMs            — ADR-0124 증보 2: when a timed pause ends (present
//                             only while one is running). The server judges the
//                             expiry itself; a client never runs a timer for it.
//
// Its own file rather than an addition to ./api.ts (같은 이유 ./eventSubscriptions.ts
// states): batch-2 workers edit the settings surface in parallel and the shared
// client is the file most likely to collide. It reuses `settingsRequest`, so
// there is one transport and one auth path.
//
// Parsed defensively through `notificationRulesFromWire`: this route is new, so a
// proxy or an older server answering 200 with a different body must degrade to
// "both off" rather than throw inside render (the ./chainModel lesson). A missing
// switch is `false`, which is exactly what "no stored row" means on the server.
// =============================================================================

import { bool, num, record } from "../../lib/wire";
import { settingsRequest } from "./api";

export interface NotificationRules {
  /** Suppress every push for this member across the workspace. */
  dnd: boolean;
  /** Let a mention through a channel this member muted (ADR-0124 D3). */
  mentionOverridesMute: boolean;
  /** ADR-0124 증보 2: epoch ms while a timed pause is running. */
  dndUntilMs?: number;
}

/** Options for {@link putNotificationRules}. */
export interface NotificationRulesWriteOptions {
  /**
   * ADR-0124 증보 2. Present = set the pause expiry (`null` = open-ended, a
   * number must be in the future). Omitted = keep a running expiry. Kept out
   * of {@link NotificationRules} so echoing a read never resends a stale stamp.
   */
  dndUntilMs?: number | null;
}

export const DEFAULT_NOTIFICATION_RULES: NotificationRules = {
  dnd: false,
  mentionOverridesMute: false,
};

export function notificationRulesFromWire(value: unknown): NotificationRules {
  const body = record(value) ?? {};
  const rules: NotificationRules = {
    dnd: bool(body, "dnd") ?? false,
    mentionOverridesMute: bool(body, "mentionOverridesMute") ?? false,
  };
  const until = num(body, "dndUntilMs");
  if (rules.dnd && until !== undefined) rules.dndUntilMs = until;
  return rules;
}

function rulesPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/notification-rules`;
}

export function fetchNotificationRules(
  workspaceId: string
): Promise<NotificationRules> {
  return settingsRequest<unknown>(rulesPath(workspaceId)).then(
    notificationRulesFromWire
  );
}

export function putNotificationRules(
  workspaceId: string,
  rules: NotificationRules,
  options: NotificationRulesWriteOptions = {}
): Promise<NotificationRules> {
  // The whole rule is replaced; both switches always go on the wire so the
  // server never has to guess which one a partial body meant. The expiry is a
  // patch and goes only when the caller chose one.
  const body: Record<string, unknown> = {
    dnd: rules.dnd,
    mentionOverridesMute: rules.mentionOverridesMute,
  };
  if (options.dndUntilMs !== undefined) body.dndUntilMs = options.dndUntilMs;
  return settingsRequest<unknown>(rulesPath(workspaceId), {
    method: "PUT",
    body: JSON.stringify(body),
  }).then(notificationRulesFromWire);
}
