// =============================================================================
// 데스크탑 셸이 배너의 클릭에 대해 하는 말의 어휘와 읽기 (#5059, #4667 후속).
//
// 셸(Rust)은 두 가지를 말한다. `notification_show_clickable` 의 답(`clickable | plain | refused`)과, 클릭이 났을 때의
// `momo:notification-click` 페이로드(`{ id, target }`). 둘 다 IPC 경계를 넘어온 값이라 웹은 모양부터 읽는다. 그 읽기는
// 플랫폼과 무관한 순수 함수라서 여기에 둔다 — 웹의 `lib/tauri.ts`(셸 다리)와 `features/notifications/bannerClicks.ts`(장부)가
// 같은 어휘를 쓰고, 어휘 단어는 한 곳에서만 적힌다.
//
// Rust 쪽 짝: `clients/desktop/src-tauri/src/notification.rs`(`ClickableOutcome`, 소문자 직렬화)와
// `notification_click.rs`(`NotificationClick`, camelCase 직렬화). 단어가 어긋나면 앱 안에서만 조용히 죽으므로 양쪽 시험이
// 각자 단어를 글자 그대로 적는다.
// =============================================================================

/**
 * `notification_show_clickable` 이 돌려주는 말.
 *
 * - `clickable`: 배너가 떴고 눌리면 `momo:notification-click` 이 온다.
 * - `plain`: 배너는 떴지만 클릭은 오지 않는다(다른 OS, 동시에 기다리는 배너가 한도를 넘음, 스레드를 못 띄움, 요청 모양이 틀림).
 * - `refused`: 배너가 뜨지 않았다(권한 없음).
 */
export const CLICKABLE_OUTCOME = {
  clickable: "clickable",
  plain: "plain",
  refused: "refused",
} as const;

export type ClickableOutcome = (typeof CLICKABLE_OUTCOME)[keyof typeof CLICKABLE_OUTCOME];

/**
 * 셸의 답을 읽는다. 모르는 말과 모양이 틀린 값은 「배너가 뜨지 않았다」로 읽는다 — 뜬 것으로 잘못 읽어 클릭을 기다리거나
 * 어림을 거두는 것보다, 안 뜬 것으로 읽는 쪽이 사람에게 덜 해롭다.
 */
export function readClickableOutcome(value: unknown): ClickableOutcome {
  return value === CLICKABLE_OUTCOME.clickable || value === CLICKABLE_OUTCOME.plain
    ? value
    : CLICKABLE_OUTCOME.refused;
}

/** 셸이 배너 클릭을 알리는 페이로드. 두 값 모두 웹이 배너를 띄울 때 셸에 준 값 그대로다. */
export interface NotificationClick {
  id: string;
  target: string;
}

/**
 * IPC 를 넘어온 클릭 페이로드를 읽는다. `id`·`target` 이 둘 다 문자열인 객체만 받고, 그 밖에는 `null`.
 * 이 함수는 모양만 본다 — 이 클릭이 앱이 띄운 배너의 것인지는 호출한 쪽이 자기 장부와 대조한다.
 */
export function readNotificationClick(value: unknown): NotificationClick | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, target } = value as { id?: unknown; target?: unknown };
  return typeof id === "string" && typeof target === "string" ? { id, target } : null;
}
