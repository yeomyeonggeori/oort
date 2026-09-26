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

import { bool, record } from "../../lib/wire";
import { settingsRequest } from "./api";

export interface NotificationRules {
  /** Suppress every push for this member across the workspace. */
  dnd: boolean;
  /** Let a mention through a channel this member muted (ADR-0124 D3). */
  mentionOverridesMute: boolean;
}

export const DEFAULT_NOTIFICATION_RULES: NotificationRules = {
  dnd: false,
  mentionOverridesMute: false,
};

export function notificationRulesFromWire(value: unknown): NotificationRules {
  const body = record(value) ?? {};
  return {
    dnd: bool(body, "dnd") ?? false,
    mentionOverridesMute: bool(body, "mentionOverridesMute") ?? false,
  };
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
  rules: NotificationRules
): Promise<NotificationRules> {
  return settingsRequest<unknown>(rulesPath(workspaceId), {
    method: "PUT",
    // The whole rule is replaced; both switches always go on the wire so the
    // server never has to guess which one a partial body meant.
    body: JSON.stringify({
      dnd: rules.dnd,
      mentionOverridesMute: rules.mentionOverridesMute,
    }),
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
