// =============================================================================
// Presence, as pure functions (ADR-0160, 사용자 프레즌스 6b).
//
// The vocabulary the client renders, kept platform-agnostic so web and phone
// name the same states the same way. Token classes (which color a dot gets) are
// NOT here: those are Tailwind on web and a token object on phone, so each client
// maps `EffectivePresence` to its own surface. What lives here is the copy and
// the ordered dropdown — the product's answer to "what do we call these states",
// which must not fork per platform.
//
// Three declared statuses (auto/away/dnd) are the durable intent a person sets;
// four effective values (online/away/dnd/offline) are what actually shows, after
// `effectivePresence` composes the intent with availability. The dropdown offers
// the declared statuses; the indicator and its accessible name describe the
// effective value.
// =============================================================================

import type { EffectivePresence, PresenceStatus } from "../../lib/api";

/**
 * The status-change dropdown: the declared statuses, **in order and nothing
 * else**.
 *
 * It deliberately carries no labels (design-review M2). The first cut paired
 * each status with a `label` string that repeated `declaredStatusLabel`'s
 * answer, which is two sources for one word: renaming 자리 비움 in the function
 * would leave the menu rendering the stale copy while every test stayed green,
 * because the tests read the same stale field. The order is the only thing this
 * list knows; the words come from the function below, always.
 */
export const PRESENCE_OPTIONS: readonly PresenceStatus[] = ["auto", "away", "dnd"];

/**
 * The label for a declared status, as the dropdown words it.
 *
 * `auto` is worded 온라인 because that is exactly what it renders as while the
 * client is connected, and picking it is how a person clears a manual away/dnd —
 * the same model Slack's "Active" follows. The stored value is still `auto` (the
 * enum deliberately avoids `active`, a lifecycle label); this is only how the
 * choice is worded.
 */
export function declaredStatusLabel(status: PresenceStatus): string {
  switch (status) {
    case "auto":
      return "온라인";
    case "away":
      return "자리 비움";
    case "dnd":
      return "방해 금지";
  }
}

/** The label for an effective value, for the indicator's accessible name. */
export function effectivePresenceLabel(effective: EffectivePresence): string {
  switch (effective) {
    case "online":
      return "온라인";
    case "away":
      return "자리 비움";
    case "dnd":
      return "방해 금지";
    case "offline":
      return "오프라인";
  }
}

/**
 * What the status menu is *about* — the visible title over its options, and the
 * opening words of the trigger's accessible name.
 *
 * It is one constant used twice rather than one string written twice, for the
 * reason `PRESENCE_OPTIONS` above states in its own words: two sources for one
 * word drift, and the tests read the same stale source the screen does. The
 * trigger already said 내 상태 before the menu had a title, so the title is not
 * new copy — it is that name, made visible where the options are.
 */
export const PRESENCE_MENU_LABEL = "내 상태";

/**
 * The accessible name for the status control's trigger: it states the current
 * effective status and that pressing changes it, so a screen-reader user is not
 * left with a color-only cue.
 */
export function presenceTriggerLabel(effective: EffectivePresence): string {
  return `${PRESENCE_MENU_LABEL}: ${effectivePresenceLabel(effective)} (변경하려면 누르세요)`;
}
