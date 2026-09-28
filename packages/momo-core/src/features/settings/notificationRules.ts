// =============================================================================
// 알림 규칙 — member-global notification rules (ADR-0124 증보 1, W-B2-3).
//
// Wire contract: docs/api/openapi.yaml `notification-rules` (GET/PUT/PATCH),
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

/**
 * Whole-object replace. Kept for the server's older-client contract; the web
 * and phone surfaces write through {@link patchNotificationRules} (#3042).
 */
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

/**
 * The fields a {@link patchNotificationRules} call changes. Every one is
 * optional and an omitted field keeps what the server holds **when the write
 * lands** (#3012, ADR-0124 증보 3) — the merge happens under the server's row
 * lock, not over this client's last read.
 */
export interface NotificationRulesPatch {
  dnd?: boolean;
  mentionOverridesMute?: boolean;
  /** PUT meaning: `null` = open-ended, a number must be in the future. */
  dndUntilMs?: number | null;
}

/**
 * Change only the named switches (#3042). Web settings and the phone each own a
 * different switch; a whole-object PUT built from a read that is even a second
 * old erases the switch the other device just changed. Sending just the field
 * this surface touched is what keeps both. An empty patch is refused here, as
 * the server would (400), rather than spent as a round trip.
 */
export function patchNotificationRules(
  workspaceId: string,
  patch: NotificationRulesPatch
): Promise<NotificationRules> {
  const body: Record<string, unknown> = {};
  if (patch.dnd !== undefined) body.dnd = patch.dnd;
  if (patch.mentionOverridesMute !== undefined) {
    body.mentionOverridesMute = patch.mentionOverridesMute;
  }
  if (patch.dndUntilMs !== undefined) body.dndUntilMs = patch.dndUntilMs;
  if (Object.keys(body).length === 0) {
    return Promise.reject(new Error("empty notification-rules patch"));
  }
  return settingsRequest<unknown>(rulesPath(workspaceId), {
    method: "PATCH",
    body: JSON.stringify(body),
  }).then(notificationRulesFromWire);
}

// ---- 낱말 (#2848) -------------------------------------------------------------
//
// 이 규칙의 `dnd` 는 **알림 일시 중지**라고 부른다. 「방해 금지」는 선언 상태
// (ADR-0160 `presence_status='dnd'`, 남에게 보이는 표시)의 이름이고, 두 필드는
// 서버에서 다르다 — 푸시 판정은 이 규칙만 읽는다. 한 낱말이 두 필드를 가리키면
// 데스크탑에서 「방해 금지」를 켠 사람이 폰의 「방해 금지」 줄에서 반대 설명을
// 읽게 된다(#2848 design-review H-1). 그래서 이름과 설명을 웹·폰이 여기서 함께 읽는다.

export const NOTIFICATION_PAUSE_LABEL = "알림 일시 중지";

export const NOTIFICATION_PAUSE_DESCRIPTION =
  "켜면 이 워크스페이스의 모든 알림을 받지 않습니다. 멘션과 승인 요청도 포함됩니다. 읽지 않은 표시는 그대로 쌓입니다.";

export const MENTION_OVERRIDES_MUTE_DESCRIPTION = `채널 알림을 꺼도 나를 멘션한 알림은 옵니다. ${NOTIFICATION_PAUSE_LABEL}가 켜져 있으면 멘션도 오지 않습니다.`;

export const NOTIFICATION_RULES_SERVER_NOTE = `${NOTIFICATION_PAUSE_LABEL}와 멘션 예외는 서버에 하나만 있습니다. 기기를 바꿔도 같은 규칙이 적용됩니다.`;

export const NOTIFICATION_PAUSE_LOAD_FAILED = "알림 설정을 불러오지 못했습니다.";
export const NOTIFICATION_PAUSE_SAVE_FAILED =
  "알림 설정을 바꾸지 못했습니다. 다시 시도하세요.";
