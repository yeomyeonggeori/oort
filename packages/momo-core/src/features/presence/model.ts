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
import type { LocaleService } from "../../i18n/context";
import type { PlainMessageKey } from "../../i18n/keys";

// 문구는 `i18n/catalogs/<언어>/presence.json`에 있다. 이 파일은 어느 자리가 어느 키를 읽는지만 정한다.
type FormatMessage = LocaleService["formatMessage"];

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
export function declaredStatusLabelKey(status: PresenceStatus): PlainMessageKey {
  switch (status) {
    case "auto":
      return "presence.status.online";
    case "away":
      return "presence.status.away";
    case "dnd":
      return "presence.status.dnd";
  }
}

/**
 * How often a screen that draws people's dots re-reads the roster while it is in
 * front of the person (#4692), in milliseconds.
 *
 * **This is the whole of "real time" for availability, and it is a choice, not a
 * limit of the transport.** Availability is read by the server from Centrifugo's
 * presence table when the roster is read, so a dot is as fresh as the last roster
 * read. A push (Centrifugo join/leave on the roll-call) would be fresher and was
 * rejected for this version: join/leave would hand every subscriber, a guest
 * among them, the connect/disconnect stream of people outside their roster, which
 * is exactly what ADR-0160 guard 5 forbids. Reading the roster they may already
 * read has no such leak.
 *
 * 30 s matches the read-state refresh the same screens already run, and a dot
 * that lags a person's arrival by at most that long is the accepted cost. The
 * refresh runs only while the screen is foreground (never in the background).
 */
export const AVAILABILITY_REFRESH_MS = 30_000;

/**
 * Declared presence as shown on someone else's profile, not on the self radio.
 *
 * `away` and `dnd` are durable facts the person set, so naming them is true.
 * `auto` is not named **here**: it means "defer to live availability", and this
 * function sees only the declared half. The availability half is the roster row's
 * `online` (#4692); a surface that has the whole row composes both through
 * `humanPresenceDot` (statusDot.ts) and names `온라인`/`오프라인` only when
 * `online` is known. `declaredStatusLabel` words `auto` as 온라인 because that is
 * what it renders **while this client is connected** — that function is the self
 * radio's copy, not a roster fact.
 */
export function otherMemberDeclaredPresenceLabelKey(
  status: PresenceStatus | undefined
): PlainMessageKey | null {
  if (status === "away" || status === "dnd") {
    return declaredStatusLabelKey(status);
  }
  return null;
}

/** The label for an effective value, for the indicator's accessible name. */
export function effectivePresenceLabelKey(
  effective: EffectivePresence
): PlainMessageKey {
  switch (effective) {
    case "online":
      return "presence.status.online";
    case "away":
      return "presence.status.away";
    case "dnd":
      return "presence.status.dnd";
    case "offline":
      return "presence.status.offline";
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
export const PRESENCE_MENU_LABEL_KEY = "presence.menu.label" satisfies PlainMessageKey;

/**
 * The accessible name for the status control's trigger: it states the current
 * effective status and that pressing changes it, so a screen-reader user is not
 * left with a color-only cue.
 */
export function presenceTriggerLabel(
  formatMessage: FormatMessage,
  effective: EffectivePresence
): string {
  return formatMessage("presence.menu.triggerLabel", {
    status: formatMessage(effectivePresenceLabelKey(effective)),
  });
}

/**
 * 「방해 금지」 선언 상태의 설명 (#2848 → #2899, ADR-0124 증보 2).
 *
 * 이 상태는 남에게 보이는 표시이고, **고르면 서버가 같은 트랜잭션에서 알림 일시 중지도
 * 함께 켠다**(증보 2 「묶어」). 설명이 두 사실을 모두 말해야 한다. 처음 문장은 「알림은
 * 「알림 일시 중지」가 멈춥니다」여서 증보 2 의 요구와 반대였고, 방해 금지를 고른 사람이
 * 알림이 15일 동안 멈춘 것을 화면에서 알 수 없었다(ADR-0204 맥락). 두 낱말의 경계는
 * `features/settings/notificationRules.ts` 의 낱말 주석에 있다.
 */
export const PRESENCE_DND_HINT_KEY = "presence.dnd.hint" satisfies PlainMessageKey;

/** 선언 상태 쓰기가 실패했을 때 (웹 `PresenceControl` 과 같은 문장). */
export const PRESENCE_WRITE_FAILED_KEY = "presence.write.failed" satisfies PlainMessageKey;
