import { ApiError, type WorkSession } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import type { DisplayFailure } from "./displayStream";

// =============================================================================
// 직접 조작 (LIVE-5 / ADR-0004 증보 3): the sandbox's screen, live, in a frame
// that CAN click back — and the boundary that keeps what is typed into it from
// existing anywhere on this machine.
//
// WHY THIS IS A SECOND MODULE AND NOT A FLAG ON THE FIRST.
//
// `displayStream.ts` says it in its own words: "If control is ever granted
// (ADR-0004 증보 3), it belongs in a different module with its own review."
// This is that module. The observer half holds its guarantee by ABSENCE — no
// `open_input` encoder, no `createDataChannel`, no input handler — and an
// absence cannot survive a boolean threaded through it. So the absence stays
// intact over there, whole and greppable, and everything that can carry a
// keystroke lives here where a reviewer can read all of it at once.
//
// THE THREE THINGS THIS MODULE HOLDS.
//
//   1. THE CLIENT NEVER OPENS THE CHANNEL. `createDataChannel` does not appear
//      in this file or in `DisplayController.tsx`, and neither does the viewer
//      word `open_input`. The producer opens the input channel, and it does so
//      because ITS OWN re-validation answered `input_enabled: true`
//      (template.spec.json `producer.inputDatachannelOnDemand.trigger`) — not
//      because a viewer asked. That ordering is the whole of 증보 3: a client
//      that could open its own way in would make the server's grant decorative.
//      This side listens on `ondatachannel` and nothing else.
//
//   2. NOTHING TYPED IS RETAINED. The only function here that touches a key is
//      [`forwardKey`], and its return type is a three-word union. There is no
//      shape it could return that a keystroke would fit in, so a caller cannot
//      store what it does not receive: the component can learn WHETHER a frame
//      went, never WHAT was in it. No `console`, no state, no attribute, no
//      error string in this file carries the payload, and
//      `controlStream.test.ts` proves that by planting a marker in each of
//      those four places and failing.
//
//      THE ONE THING THAT IS KEPT, stated here rather than discovered later:
//      [`ControlKeyPresses`] remembers what the RESERVED key's keydown decided,
//      for exactly as long as that one key is physically held (#1563). It is a
//      single slot holding one of three decisions about Escape — never a code
//      the person chose, never a sequence, never anything that outlives the
//      finger on the key. Why it has to exist at all, and why one slot is
//      enough for every key on the keyboard, is argued at [`dispositionForKey`].
//
//   3. THE WINDOW ALWAYS CLOSES. A control window that outlives the person
//      holding it is an agent left stopped, so a failed return is a state this
//      surface has to be able to describe. Three paths close it here
//      (negotiation deadline, a producer that went away, the person pressing
//      반환) and a fourth closes it with no client at all — the server's 90
//      second lease. The copy names that backstop instead of pretending the
//      client is the only way back, because on the one path where the client
//      has already failed, it is the only true thing left to say.
//
// WHAT IS SHARED WITH THE VIEWER, AND WHY. The endpoint check, the CSP
// classifier, the close classifier, the id grammar and the whole
// `DisplayFailure` vocabulary are IMPORTED. They are facts about dialling a
// producer from a browser and they do not change grade with the bearer; a
// second copy is what would drift. What is NOT shared is anything about input,
// because over there it does not exist.
// =============================================================================

/**
 * The grade this module can render, and the word the server has to have sent.
 *
 * Checked rather than assumed for the same reason `DISPLAY_OBSERVER_MODE` is:
 * a controllable stream and a view-only one look identical, and the failure is
 * asymmetric in the dangerous direction. A viewer drawn as a controller invites
 * someone to type a password into a window that will not deliver it; a
 * controller drawn as a viewer merely disappoints.
 */
export const DISPLAY_CONTROLLER_MODE = "controller";

/**
 * The label of the datachannel the PRODUCER opens once its own validate answers
 * `input_enabled: true`.
 *
 * Declared in `template.spec.json` under `signalling.inputChannel` and read
 * from there by the test beside this file, so the two halves of a contract that
 * no microVM has ever run cannot drift while nobody is looking. The producer
 * half is LIVE-5c (`unverified.inputDelivery`); until it exists, this constant
 * is a DECLARED contract and is labelled as one everywhere it is quoted.
 */
export const CONTROL_INPUT_CHANNEL_LABEL = "momo.input.v1";

/**
 * How long the whole controller handshake gets, from the capability call to a
 * usable input channel.
 *
 * 30 seconds, and the number is picked against the SERVER's clock rather than
 * guessed: the control window's lease is 90 seconds
 * (`display_control.rs::CONTROL_WINDOW_LEASE_SECONDS`), and a client that gave
 * up later than the lease would be reporting a failure about a window that had
 * already closed itself. Landing at a third of it leaves room for the return
 * call to be made, to fail, and for the backstop to still be the thing that
 * finishes the job.
 *
 * It is the same 30 seconds `DISPLAY_NEGOTIATE_TIMEOUT_MS` uses and that is a
 * coincidence worth stating rather than a shared constant: that one bounds a
 * media negotiation and would move if the reachability measurement said so;
 * this one is bounded by a lease and moves only if the lease does.
 */
export const CONTROL_NEGOTIATE_TIMEOUT_MS = 30_000;

/**
 * The server's own backstop, mirrored so the surface can say it in seconds.
 *
 * MIRRORED, not authoritative: the ledger's `CONTROL_WINDOW_LEASE_SECONDS` is
 * the fact, this is a sentence about it. It is here rather than inlined into
 * copy so that a reader of this file can see the one relation that matters
 * (`CONTROL_NEGOTIATE_TIMEOUT_MS` < this) without opening a Rust crate.
 */
export const CONTROL_LEASE_MS = 90_000;

// ---- who is offered this at all ---------------------------------------------

/**
 * Whether this surface draws a way into control, and if not, whether it says
 * anything about it.
 *
 * TWO ANSWERS, NOT ONE, and the split is the LIVE-4 어포던스 부재 rule made
 * mechanical. A control that cannot work is not drawn disabled — a permanently
 * dead button asks the reader what they did wrong — but silence is not always
 * right either: a session whose host publishes no screen has a REASON, and the
 * reason is a fact worth stating once, in the register of an explanation.
 *
 * The one case that gets neither control nor sentence is **not being the
 * owner**. Control is owner-only by 증보 3 D1, and telling a teammate "you are
 * not allowed to take this keyboard" answers a question they did not ask, on a
 * screen where nothing they can do would change the answer. They see the live
 * screen and the boundary notice, which is exactly what they are entitled to.
 */
export interface ControlAffordance {
  /** Draw the control that starts a window. */
  offered: boolean;
  /** Say this instead. Null means say nothing at all. */
  note: string | null;
}

/**
 * `displayGate` for the keyboard.
 *
 * Deliberately NOT derived from `displayGate` by adding a clause, even though
 * every condition below is also one of its conditions. The two answer different
 * questions and diverge on the one that matters: `owner_only` OPENS the screen
 * for the owner and is irrelevant here, while being a teammate CLOSES the
 * keyboard and is irrelevant there. Sharing the function would put an `isOwner`
 * branch on both sides of the same `if`, which is how the two surfaces end up
 * disagreeing about who is looking at them.
 */
export function controlAffordance(
  session: Pick<WorkSession, "status" | "remoteDisplayAvailable">,
  isOwner: boolean
): ControlAffordance {
  // Not the owner: nothing, and no sentence. See the type's docstring.
  if (!isOwner) return { offered: false, note: null };
  if (session.status !== "running" && session.status !== "idle") {
    return {
      offered: false,
      note:
        session.status === "orphaned"
          ? "호스트 연결이 끊겨 이 세션을 직접 조작할 수 없습니다."
          : "끝난 세션은 직접 조작할 수 없습니다.",
    };
  }
  if (!session.remoteDisplayAvailable) {
    return {
      offered: false,
      note: "이 세션은 호스트 화면을 열어 두지 않아 직접 조작할 수 없습니다. 화면을 띄운 호스트에서 실행한 세션만 조작할 수 있습니다.",
    };
  }
  return { offered: true, note: null };
}

/**
 * What a decoded frame count means for the control affordance: NOTHING.
 *
 * It is here as a named function returning a constant because the question gets
 * asked every time somebody reads this file, and the answer is a decision
 * rather than an oversight. Gating 직접 조작 on `framesDecoded > 0` sounds
 * careful and is wrong twice: an IDLE desktop decodes no new frames, so the
 * control would vanish from exactly the sessions most likely to need a person,
 * and the reader would be told nothing about why. So the frame count stays what
 * it is on the viewer surface — a fact printed under the picture — and the
 * affordance is decided by the ledger.
 */
export function framesGateControl(): false {
  return false;
}

// ---- what the person typed, and where it is allowed to go -------------------

/**
 * A key as this surface is willing to know it.
 *
 * `code` is the PHYSICAL key (`"KeyA"`, `"Digit1"`, `"Enter"`), not the
 * character it produced. That is the right model for a remote keyboard — the
 * VM's own layout turns a physical key into a character, exactly as a real
 * keyboard plugged into it would — and it has a second property this module
 * cares about more: the character a password is made of never forms as a value
 * this client owns. There is no `key` field to leak, because there is no `key`
 * field.
 *
 * The modifiers ride along because a physical key without them is not a
 * keystroke, and `repeat` because auto-repeat is a fact about the keyboard
 * rather than about the person.
 */
export interface ControlKeyEvent {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** A pointer position, in the frame's own normalised coordinates. */
export interface ControlPointerEvent {
  /** 0..1 across the video's own box, so the VM's resolution stays the VM's. */
  x: number;
  y: number;
  /** `MouseEvent.button`. Absent for a move. */
  button?: number;
}

/**
 * Everything this module can tell its caller about a keystroke.
 *
 * THIS TYPE IS THE GUARANTEE. It is a union of three words, and none of them is
 * a string the caller supplied or a shape a key could hide in, so a component
 * that stores the outcome of every keystroke stores three possible words. The
 * absence of a `{ code }` field here is doing the same job the absence of
 * `createDataChannel` does one module over: it is not a rule anybody has to
 * remember, it is a thing that is not there.
 *
 * `dropped` is deliberately undifferentiated. "The channel is closed" and "the
 * channel threw" are the same fact to a person holding a keyboard — the
 * keystroke did not land — and splitting them would invite a message that
 * quotes the failure, which is where a payload gets into an error string.
 */
export type ControlSendOutcome = "sent" | "dropped" | "no_channel";

/** The narrowest thing that can carry a frame. A datachannel satisfies it. */
export interface ControlInputSink {
  readyState: string;
  send(frame: string): void;
}

/**
 * Encode one key event for the producer.
 *
 * Exported for the test, not for the component: the component calls
 * [`forwardKey`], which is the only path that also has somewhere to put the
 * result. A caller that could encode without sending would be holding the one
 * string in this system that contains a keystroke.
 */
export function keyInputFrame(
  event: ControlKeyEvent,
  action: "down" | "up"
): string {
  return JSON.stringify({
    type: "key",
    action,
    code: event.code,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    repeat: event.repeat,
  });
}

/** Encode one pointer event. Coordinates are normalised by the caller. */
export function pointerInputFrame(
  event: ControlPointerEvent,
  action: "move" | "down" | "up"
): string {
  return JSON.stringify({
    type: "pointer",
    action,
    x: event.x,
    y: event.y,
    ...(event.button === undefined ? {} : { button: event.button }),
  });
}

/** Encode one wheel event. Deltas are the browser's own pixels. */
export function wheelInputFrame(deltaX: number, deltaY: number): string {
  return JSON.stringify({ type: "wheel", action: "scroll", dx: deltaX, dy: deltaY });
}

/**
 * Hand one keystroke to the producer and forget it.
 *
 * The frame is built, sent and dropped inside this call. It is never stored,
 * never returned, never logged, and never named in the outcome. A `try` around
 * the send rather than a check afterwards, because a datachannel can close
 * between the readyState read and the send, and the throw that follows is the
 * one place a payload could reach a stack trace: it is swallowed whole.
 */
export function forwardKey(
  sink: ControlInputSink | null,
  event: ControlKeyEvent,
  action: "down" | "up"
): ControlSendOutcome {
  if (sink === null || sink.readyState !== "open") return "no_channel";
  try {
    sink.send(keyInputFrame(event, action));
    return "sent";
  } catch {
    return "dropped";
  }
}

/** [`forwardKey`] for a pointer. Same discipline, same three words. */
export function forwardPointer(
  sink: ControlInputSink | null,
  event: ControlPointerEvent,
  action: "move" | "down" | "up"
): ControlSendOutcome {
  if (sink === null || sink.readyState !== "open") return "no_channel";
  try {
    sink.send(pointerInputFrame(event, action));
    return "sent";
  } catch {
    return "dropped";
  }
}

/** [`forwardKey`] for a wheel. */
export function forwardWheel(
  sink: ControlInputSink | null,
  deltaX: number,
  deltaY: number
): ControlSendOutcome {
  if (sink === null || sink.readyState !== "open") return "no_channel";
  try {
    sink.send(wheelInputFrame(deltaX, deltaY));
    return "sent";
  } catch {
    return "dropped";
  }
}

/**
 * Where the pointer is inside the picture, 0..1.
 *
 * Normalised here rather than sent as browser pixels because the two boxes are
 * not the same box: the video is letterboxed inside its own element
 * (`object-contain`), so the reader's pixel is not the desktop's pixel and the
 * offset changes with the pane width. Clamped because a drag can leave the box
 * and a coordinate outside the screen is not a place the VM can click.
 */
export function normalisedPoint(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number }
): ControlPointerEvent | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  return {
    x: Math.min(1, Math.max(0, Number(x.toFixed(4)))),
    y: Math.min(1, Math.max(0, Number(y.toFixed(4)))),
  };
}

// ---- the keys this browser keeps for itself ---------------------------------

/**
 * Keystrokes the browser will not let a page have, plus the two this surface
 * reserves for itself — stated rather than hidden.
 *
 * THE FIRST SENTENCE is the boundary nobody can move: a window manager or the
 * browser chrome takes some keys before the page is asked, and on several of
 * them the page is never told they happened. `preventDefault` cannot reach
 * those. Pretending otherwise is the failure this sentence exists against — a
 * person holding what looks like a full keyboard, pressing Cmd-Tab, and
 * watching their own desktop switch instead of the VM's.
 *
 * THE REST is the release path, and it is here rather than in a tooltip because
 * a reserved key nobody announced is a key that appears to be broken. See
 * [`dispositionForKey`] for why Escape is the one reserved.
 */
export const CONTROL_CAPTURE_LIMIT_COPY =
  "브라우저와 운영체제가 먼저 가져가는 단축키는 전달되지 않습니다. 새 탭 열기, 창 전환, 전체 화면 종료 같은 키는 이 브라우저에서 처리됩니다. Esc는 호스트로 가지 않고, 키보드를 이 화면에서 풀어 화면 돌려주기 버튼으로 옮깁니다. 호스트에 Esc를 보내려면 Shift+Esc를 누르세요.";

/**
 * What this surface does with one key press.
 *
 * ## Why a release key exists at all (design-review B-1)
 *
 * Taking control puts the keyboard inside a box that swallows Tab, and the
 * first version of this surface then had NO WAY OUT for somebody not using a
 * mouse. Tab was captured (correctly — a VM's own forms need it), the caret was
 * planted on the capture box the moment control began, and 화면 돌려주기 sat
 * one un-reachable Tab away. A person could take a keyboard and be unable to
 * give it back, which turns the whole auto-return design into something only a
 * mouse user can trigger and leaves everyone else waiting out the 90 second
 * lease.
 *
 * ## Why Escape, and what it costs
 *
 * Escape is the key a reader already tries when something has them trapped, and
 * it is the one this client can reserve without taking something the VM needs
 * more: the alternatives were Tab (which forms inside the VM need constantly)
 * and a chord nobody would guess.
 *
 * It is not forwarded, and it does NOT end control either — pressing Escape
 * must never stop somebody's agent, so it moves the caret and nothing else.
 * From there the ordinary keyboard works: 화면 돌려주기 is the next thing in
 * the tab order, and Tab is no longer captured because the caret is no longer
 * inside the box.
 *
 * The cost is real: plain Escape cannot reach the VM, and a remote desktop
 * without Escape is missing something (every dialog in there closes with it).
 * So Shift+Escape sends it, and the modifier is STRIPPED on the way out — the
 * person means "Escape", not "Shift+Escape", and a VM told the literal chord
 * would hand it to whatever has that chord bound. That is a deliberate
 * translation and the only one this module makes.
 */
export type ControlKeyDisposition =
  /**
   * Not forwarded. The caret leaves the capture surface for the control that
   * ends the window; nothing is sent and nothing is stopped.
   */
  | { kind: "release" }
  /**
   * Forwarded. `event` is what goes on the wire, which is not always what was
   * pressed (Shift+Escape leaves as Escape), and `preventDefault` says whether
   * the page must be stopped from acting on it as well.
   */
  | { kind: "forward"; event: ControlKeyEvent; preventDefault: boolean }
  /**
   * Nothing happens: not forwarded, and not the release gesture either.
   *
   * The `keyup` of a key this surface never saw go down — pressed before the
   * caret arrived, or taken by the browser on the way in. The host is not
   * holding that key, so sending it a release would be inventing a keystroke
   * this person never made. It is a separate word from `release` because a
   * caller that treated it as one would move the caret on somebody else's
   * stray key.
   */
  | { kind: "ignore" };

/**
 * What the reserved key's keydown decided, kept until that key comes back up.
 *
 * It carries the DECISION and not the event, because the keyup has to be
 * encoded from the keyup — its own modifiers, its own `repeat` — with only the
 * press's judgement laid over it. Storing the keydown and re-sending it would
 * put a second copy of the down on the wire.
 */
type ControlReleaseKeyPress =
  | { kind: "release" }
  | { kind: "forward"; stripShift: boolean; preventDefault: boolean };

/**
 * The press this surface has to remember, and the only one.
 *
 * ONE SLOT, NOT A MAP OF HELD KEYS, and the difference is the module's second
 * guarantee. A ledger keyed by physical code would be a live record of what is
 * under the person's fingers — small and short-lived, but a record of the
 * keystroke itself, in the one file that promises not to keep one. It is not
 * needed: read [`dispositionForKey`] and the only key whose MEANING can change
 * between its down and its up is Escape. Every other key is forwarded on both
 * edges no matter what the modifiers do mid-press, so its up needs no memory
 * of its down.
 *
 * Created per control window and carried by the component. Module-level state
 * would let one window's held key decide the next window's first press.
 */
export interface ControlKeyPresses {
  /** The outstanding Escape press, or `null` when Escape is not held. */
  escape: ControlReleaseKeyPress | null;
}

/** A window's press memory, empty. */
export function createKeyPresses(): ControlKeyPresses {
  return { escape: null };
}

/** What one Escape keydown means, decided from the modifiers held with it. */
function escapePressFor(event: ControlKeyEvent): ControlReleaseKeyPress {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    // A chord this surface has no rule for. Forward it whole rather than
    // guessing which half the person meant.
    return { kind: "forward", stripShift: false, preventDefault: false };
  }
  if (event.shiftKey) {
    return { kind: "forward", stripShift: true, preventDefault: true };
  }
  return { kind: "release" };
}

/** The press's judgement, laid over the event actually in hand. */
function dispositionFromPress(
  press: ControlReleaseKeyPress,
  event: ControlKeyEvent
): ControlKeyDisposition {
  if (press.kind === "release") return { kind: "release" };
  return {
    kind: "forward",
    event: press.stripShift ? { ...event, shiftKey: false } : event,
    preventDefault: press.preventDefault,
  };
}

/**
 * What this surface does with one key EVENT, judged by the PRESS it belongs to.
 *
 * ## The stuck key this shape exists against (#1563, #1560 재확인 ②)
 *
 * The first version of this function was pure in the wrong variable: it read
 * the modifiers on the event in front of it, so the same physical press could
 * be judged one way going down and another coming up. A person presses
 * Shift+Escape — forwarded, the host sees Escape go down — and then lifts
 * SHIFT FIRST, which is the ordinary way a hand leaves a chord. The keyup that
 * follows carries `shiftKey: false`, matches the plain-Escape rule, and is
 * classified as the release gesture: not sent. The host is left holding a key
 * nobody is pressing, forever, and the only cure is another Shift+Escape that
 * the person has no reason to guess at.
 *
 * So the unit of judgement is the PRESS, not the event. `action` and the
 * window's [`ControlKeyPresses`] are parameters for that reason and no other:
 * the keydown decides, and every event of that press — the auto-repeats and
 * the keyup — follows the decision, whatever the modifiers have done since.
 *
 * ## Why one slot covers a whole keyboard
 *
 * Only Escape can change its mind. Everything else forwards on both edges
 * regardless of modifiers, so its keyup can be judged fresh and still agree
 * with its keydown; `preventDefault` is asked again for those because it is a
 * question about the PAGE's default for the event in hand, not about the press.
 *
 * ## The two ends that have no press behind them
 *
 * A non-repeat keydown always re-decides and overwrites the slot: a press left
 * outstanding by a caret that walked away mid-chord can never make the next
 * real press mean something the person did not do. And an Escape keyup with no
 * press behind it is `ignore` — this client emitted nothing for that key, so
 * emitting its release now would hand the host a keystroke that never happened.
 */
export function dispositionForKey(
  event: ControlKeyEvent,
  action: "down" | "up",
  presses: ControlKeyPresses
): ControlKeyDisposition {
  if (event.code !== "Escape") {
    return { kind: "forward", event, preventDefault: controlSwallowsKey(event) };
  }
  if (action === "up") {
    const press = presses.escape;
    presses.escape = null;
    if (press === null) return { kind: "ignore" };
    return dispositionFromPress(press, event);
  }
  // Auto-repeat is the same press continuing, so it keeps the same judgement:
  // releasing Shift while Escape is held must not turn the repeats into a
  // caret jump under a hand that has not moved.
  if (event.repeat && presses.escape !== null) {
    return dispositionFromPress(presses.escape, event);
  }
  const press = escapePressFor(event);
  presses.escape = press;
  return dispositionFromPress(press, event);
}

/**
 * The keyboard is not in the capture surface, so keys are going somewhere else.
 *
 * THE SILENCE THIS REPLACES (design-review H-2): the chip said 조작 중 whether
 * or not the surface held the caret, so a person who clicked outside the frame
 * went on typing into a page that forwarded nothing, with nothing on screen
 * disagreeing with them. The window really is still open — control has not
 * ended — so the honest split is per-INPUT rather than per-window: the keyboard
 * left, the pointer still works over the picture, and the way back is one press
 * or one Tab.
 */
export const CONTROL_KEYBOARD_LOST_COPY =
  "키보드가 이 화면에서 벗어나, 지금 누르는 키는 호스트로 가지 않습니다. 화면을 한 번 누르거나 Tab으로 이 화면에 오면 다시 이어집니다. 조작 창은 그대로 열려 있습니다.";

/** The chip word while the window stands but the caret is elsewhere. */
export const CONTROL_KEYBOARD_LOST_LABEL = "키보드 놓침";

/**
 * Keys this surface stops the PAGE from acting on, because the page's own
 * action would be worse than the VM missing the key.
 *
 * Only browser-level navigation a `keydown` handler can actually stop:
 * Backspace and the arrows scroll or navigate the HOST page while somebody
 * believes they are typing into a VM. Tab is here because a VM's own forms are
 * full of it — and it can be here honestly only because Escape now exists as a
 * release path (see [`dispositionForKey`]). Before that, capturing Tab was how
 * a keyboard user got stuck.
 */
export function controlSwallowsKey(event: ControlKeyEvent): boolean {
  if (event.metaKey || event.ctrlKey) return false;
  return (
    event.code === "Tab" ||
    event.code === "Backspace" ||
    event.code === "Space" ||
    event.code.startsWith("Arrow")
  );
}

// ---- how a window ends ------------------------------------------------------

/**
 * Why control ended. THE THREE PATHS OF LIVE-5b, plus the one the server owns.
 *
 * They are separate words because the reader's next step differs on each, and
 * because two of them are things the reader did not do. A person who pressed
 * 반환 and a person whose producer died both end up watching a screen they no
 * longer control, and telling them the same sentence would leave one of them
 * wondering what they pressed.
 */
export type ControlReturnReason =
  /** The person pressed 반환. */
  | "requested"
  /** The handshake did not finish inside `CONTROL_NEGOTIATE_TIMEOUT_MS`. */
  | "negotiate_timeout"
  /** The producer or the relay went away while control was held. */
  | "producer_lost"
  /**
   * The producer served the stream and never opened an input channel. The grant
   * said controller; the wire did not agree.
   */
  | "input_unavailable"
  /** The session's own end closed the window under it. */
  | "session_ended";

/**
 * Everything that can happen to a held keyboard, as this client can observe it.
 *
 * A NAMED LIST rather than a set of `if`s inside the component, because the
 * question "does this end the window" has to have exactly one answer per event
 * and the answers have to be readable side by side. Written as branches in a
 * socket handler, the two silences — a deadline, and a socket that closed
 * before the producer ever offered — drift apart, and they are the SAME failure
 * to a reader: nothing ever came up. Telling them two different sentences would
 * be inventing a distinction out of which timer happened to fire first.
 */
export type ControlLifecycleEvent =
  /** The handshake ran out of time. */
  | { kind: "negotiate_deadline" }
  /** The signalling socket closed. `offered` separates the two silences. */
  | { kind: "socket_closed"; offered: boolean; sessionGone: boolean }
  /** ICE gave up on a connection that had been negotiated. */
  | { kind: "peer_failed" }
  /** The input channel closed under a held keyboard. */
  | { kind: "channel_closed" }
  /** The producer refused something by name, mid-session. */
  | { kind: "producer_error" }
  /** The producer served a screen and opened no way in. */
  | { kind: "no_input_channel" }
  /** The person pressed 반환. */
  | { kind: "person_returned" }
  /** The ledger stopped permitting this stream while it was held. */
  | { kind: "ledger_revoked" };

/**
 * WHY THE WINDOW IS CLOSING. One function, every path.
 *
 * This is the auto-return contract, and it is TOTAL: there is no event this
 * client can observe that leaves a control window open with nobody holding it.
 * The component's job shrinks to noticing things and calling this, which is
 * what makes "control always comes back" a property that can be tested without
 * a browser — and then proved end to end in one.
 */
export function autoReturnFor(event: ControlLifecycleEvent): ControlReturnReason {
  switch (event.kind) {
    case "person_returned":
      return "requested";
    case "ledger_revoked":
      return "session_ended";
    case "no_input_channel":
      return "input_unavailable";
    case "negotiate_deadline":
      return "negotiate_timeout";
    case "socket_closed":
      // A session the ledger has ended is not a producer that went away, even
      // though the socket looks identical from here. The reader whose session
      // ended did not lose a connection; their work finished.
      if (event.sessionGone) return "session_ended";
      return event.offered ? "producer_lost" : "negotiate_timeout";
    case "peer_failed":
    case "channel_closed":
    case "producer_error":
      return "producer_lost";
  }
}

/**
 * What the surface says once control is over, per path.
 *
 * Every one of them states the same two facts in the same order — control ended,
 * the agent has the session back — and then differs on the third, which is why
 * it ended and what the reader may do now. `requested` has no third sentence
 * because a person who pressed a button does not need to be told what they
 * pressed.
 */
export const CONTROL_RETURN_COPY: Readonly<Record<ControlReturnReason, string>> =
  {
    requested: "조작을 마치고 화면을 돌려주었습니다. 에이전트가 이 세션에서 다시 실행됩니다.",
    negotiate_timeout: `${Math.round(
      CONTROL_NEGOTIATE_TIMEOUT_MS / 1000
    )}초 안에 조작 연결이 서지 않아 화면을 돌려주었습니다. 에이전트가 다시 실행되며, 필요하면 다시 시작할 수 있습니다.`,
    producer_lost:
      "조작 중에 호스트 연결이 끊겨 화면을 돌려주었습니다. 에이전트가 다시 실행되며, 연결이 돌아오면 다시 시작할 수 있습니다.",
    input_unavailable:
      "호스트가 화면은 보냈지만 입력 채널을 열지 않아 화면을 돌려주었습니다. 에이전트가 다시 실행되며, 이 호스트의 화면 구성 요소가 조작을 지원하는지 확인하세요.",
    session_ended: "세션이 끝나면서 조작 창도 닫혔습니다.",
  };

/**
 * What the surface says when the return call itself failed.
 *
 * THIS IS THE SENTENCE THE WHOLE auto-return DESIGN EXISTS FOR. Every other
 * path ends with the ledger agreeing that the window is shut. Here it does not,
 * and the honest thing is neither to claim success nor to leave a person
 * staring at an error with no idea whether their agent is stopped forever.
 *
 * So it says the true thing: the window closes on its own within the lease, and
 * it says how long that is. It names no button, because pressing one again is
 * exactly what the client just failed at and the backstop does not need help.
 * The number comes from the mirrored lease constant rather than being written
 * out, so a lease change cannot leave a false number on a screen.
 */
export const CONTROL_RETURN_FAILED_COPY = `화면을 돌려주지 못했습니다. 조작 창은 서버에서 최대 ${Math.round(
  CONTROL_LEASE_MS / 1000
)}초 뒤에 저절로 닫히고, 그때 에이전트가 다시 실행됩니다. 이 화면을 닫아도 됩니다.`;

/**
 * The four states this surface can be in, named where a reader will read them.
 *
 * 반환 중 is a state and not a spinner on a button because the return is a
 * round trip that can fail, and a surface that showed only the button would
 * have nowhere to put the failure sentence above.
 */
export const CONTROL_PHASE_COPY: Readonly<
  Record<"connecting" | "controlling" | "returning", string>
> = {
  connecting: "조작 연결 준비 중",
  // 칩 한 낱말. 섹션 제목이 이미 「직접 조작」이라 낱말이 짧고, 그래서 프레임
  // 아래에 「직접 조작 중」을 한 번 더 적을 자리가 없다 — 같은 사실을 두 번
  // 말하는 카드는 두 가지가 일어났다고 읽힌다.
  controlling: "조작 중",
  returning: "화면을 돌려주는 중",
};

/** What is true while somebody holds the keyboard. Said once, under the frame. */
export const CONTROL_ACTIVE_DETAIL =
  "이 동안 에이전트는 이 세션의 화면을 보지 못하고 입력도 하지 못합니다. 호스트는 계속 실행 중이고 사용 시간도 계속 쌓입니다.";

/**
 * What taking control DOES, said before it is taken.
 *
 * The invite has to carry the cost, because the cost is the surprising part: a
 * person who wanted to click one button in a browser inside the VM has also
 * stopped their agent and closed the screen to their team. Both are reversible
 * and both are theirs to reverse, which is why this is an invitation and not a
 * warning.
 */
export const CONTROL_INVITE_COPY =
  "직접 조작을 시작하면 에이전트가 이 세션에서 멈추고, 조작이 끝날 때까지 관전은 소유자만 보기로 바뀝니다. 화면을 돌려주면 둘 다 원래대로 돌아옵니다.";

/** The verb, on the control that starts a window. 인수 is banned (증보 3 D1). */
export const CONTROL_START_LABEL = "직접 조작 시작";
/** The verb, on the control that ends one. */
export const CONTROL_RETURN_LABEL = "화면 돌려주기";

/**
 * What observation went back to, said only when it actually moved.
 *
 * The server forces `owner_only` for the life of the window and restores the
 * owner's own setting when it closes (LIVE-5a, one transaction). A surface that
 * announced "관전이 다시 열렸습니다" unconditionally would be wrong for every
 * owner who had already closed observation themselves, and that owner is not a
 * rare case — they are the one most likely to be taking control.
 */
export function controlObservationRestoredNote(
  observationBefore: WorkSession["observation"]
): string | null {
  return observationBefore === "open"
    ? "관전이 다시 팀원에게 열렸습니다."
    : null;
}

// ---- failures ---------------------------------------------------------------

/**
 * Every way taking control can fail, on top of every way watching can.
 *
 * The shared members are `DisplayFailure`'s and are imported: a refused
 * capability, a blocked connect-src and an unroutable host do not change
 * because the bearer was a controller one. What is added is what only the
 * keyboard can do.
 */
export type ControlFailure =
  | DisplayFailure
  /** Somebody else already holds this session's control window (409). */
  | "control_taken"
  /** The server refused the grade to this caller: not the owner (403). */
  | "control_denied"
  /** The producer served a screen and opened no input channel. */
  | "input_unavailable";

/**
 * Why the controller capability call failed.
 *
 * A SEPARATE CLASSIFIER from `classifyDisplayGrantFailure`, and 409 is why. On
 * the observer route 409 means "this session has no screen"; on a controller
 * request it ALSO means "one window per session, and it is not yours" — the
 * unique index, not a race. Folding them would tell an owner whose teammate is
 * mid-login that their session has no screen, which is both false and
 * unactionable.
 *
 * The two cannot be told apart from the status alone, so the sentence for this
 * one names both possibilities in the order they are likely. That is a
 * deliberate second-best: the alternative is inventing a distinction the server
 * did not make.
 */
export function classifyControlGrantFailure(error: unknown): ControlFailure {
  if (error instanceof NetworkError) return "server_unreachable";
  if (error instanceof ApiError) {
    if (error.status === 403) return "control_denied";
    if (error.status === 401) return "capability_denied";
    if (error.status === 409) return "control_taken";
    if (error.status === 404) return "session_unavailable";
  }
  return "server_unreachable";
}

/**
 * The three sentences this module adds to the display table.
 *
 * Read through [`controlFailureCopy`] rather than indexed, so a caller cannot
 * reach for this table and silently miss the imported ones.
 */
const CONTROL_FAILURE_COPY: Readonly<
  Record<"control_taken" | "control_denied" | "input_unavailable", string>
> = {
  control_taken:
    "이 세션의 조작 창을 이미 누군가 잡고 있거나, 지금은 화면을 열 수 없습니다. 잠시 뒤 다시 시도하세요.",
  control_denied:
    "이 세션을 직접 조작할 수 없습니다. 직접 조작은 세션을 시작한 사람만 할 수 있습니다.",
  input_unavailable:
    "호스트가 화면은 보냈지만 입력 채널을 열지 않았습니다. 이 호스트의 화면 구성 요소가 조작을 지원하는지 확인하세요.",
};

/**
 * The sentence for a control failure.
 *
 * Falls through to the display table for everything the two surfaces share,
 * with the OWNER form always chosen: this module only ever runs for the session
 * owner (`controlAffordance` refuses everyone else), so passing `false` here
 * would hand the owner a sentence written about somebody else.
 */
export function controlFailureCopy(
  failure: ControlFailure,
  displayCopy: (failure: DisplayFailure, isOwner: boolean) => string
): string {
  if (
    failure === "control_taken" ||
    failure === "control_denied" ||
    failure === "input_unavailable"
  ) {
    return CONTROL_FAILURE_COPY[failure];
  }
  return displayCopy(failure, true);
}

/**
 * Whether a failed control attempt offers 다시 시도.
 *
 * `control_denied` does not, and it is the one worth arguing about: a retry
 * would send the same member id to the same route and get the same 403. The way
 * in is being the session's owner, which is not a thing a button changes.
 *
 * `input_unavailable` does not either, for the reason
 * `producer_input_channel` does not on the viewer surface: the producer would
 * do the same thing again, and the way out is a host that opens the channel.
 */
export function controlOffersRetry(
  failure: ControlFailure,
  affordance: ControlAffordance
): boolean {
  if (!affordance.offered) return false;
  return failure !== "control_denied" && failure !== "input_unavailable";
}

// -----------------------------------------------------------------------------
// THE OVERLAY ENTRY POINT — DESIGNED, NOT BUILT (LIVE-5b §1.4)
// -----------------------------------------------------------------------------
//
// 설계 1문단. 관전 화면 위의 「직접 조작」 진입점은 프레임을 덮는 반투명 띠가
// 아니라 **프레임 우하단에 떠 있는 작은 컨트롤 하나**여야 한다: 이 표면에서 사람이
// 보고 있는 것은 에이전트가 지금 무엇을 하는가이고, 그 위에 무엇을 덮는 순간 그
// 감시가 끊긴다. 그래서 오버레이는 (1) 프레임 안에 있되 화면을 가리지 않는 크기로
// 우하단에 앉고, (2) 소유자에게만·`controlAffordance().offered` 가 참일 때만
// 존재하며(비활성 상태 없음 — 없으면 그냥 없다), (3) 포인터가 프레임 위에 있거나
// 프레임 안 어딘가에 포커스가 있을 때 나타나되 **키보드 포커스가 닿으면 항상**
// 보인다(hover 전용 컨트롤은 키보드 사용자에게 존재하지 않는 컨트롤이다), (4)
// 누르면 곧바로 창을 열지 않고 이 파일의 `CONTROL_INVITE_COPY` 를 실은 확인 단계를
// 지난다 — 누르는 순간 에이전트가 멈추는 동작에 즉발 버튼을 주면, 화면을 크게 보려고
// 눌렀다가 남의 실행을 멈춘 사람이 생긴다. (5) 창이 열려 있는 동안 이 자리에는
// 아무것도 서지 않는다: 그때 프레임은 조작 표면 자신이고, 조작 중인 화면 위의 떠 있는
// 버튼은 클릭이 VM 으로 갈지 이 버튼으로 갈지 알 수 없게 만든다.
//
// 구현하지 않은 이유는 이 goal 의 범위 결정이다(패킷 §1.4 — 리뷰 판정). 목업은
// `clients/web/gates/fixtures/display-control-overlay.html` 이고, 게이트가
// light/dark 로 찍는다.

/**
 * The overlay mockup's own sentences, kept HERE rather than in the fixture.
 *
 * A mockup that invents its own copy is a mockup that reviews a screen the
 * product will never show. These two strings are the ones a built overlay would
 * use, and the fixture reads them, so the picture in the review is made of the
 * same words as the thing being proposed.
 */
export const CONTROL_OVERLAY_MOCKUP = {
  label: CONTROL_START_LABEL,
  confirm: CONTROL_INVITE_COPY,
} as const;
