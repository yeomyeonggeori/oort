// -----------------------------------------------------------------------------
// 실기기 제약 (스파이크 #837 게이트 1, iPhone 17 / iOS 26.5.1) — 어기면 한글이 깨진다
//
// **컴포저의 `value` 는 반드시 동기로 반영한다.** `setTimeout(() => setValue(next), 0)`
// 한 틱만 늦춰도 iOS IME 의 조합 상태가 끊어져 자모가 **아예 합쳐지지 않는다**:
// 표준 키보드 `ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ`, 10키 `ㅇ|·ㄴㄴ··|ㅇㅎ|·ㅅ·` (목표는
// `안녕하세요`). 제어 입력 자체는 무죄다 — 조합 중 60건짜리 멘션 목록을 매 타에
// 재렌더해도 통과했다(케이스 C).
//
// 따라서 입력 value 가 네트워크·스토어·큐를 거쳐 되돌아오는 구조를 만들지 말 것.
// 낙관적 로컬 상태는 동기로 유지하고 서버 왕복은 별도 경로로 둔다.
//
// 덧: 그 깨진 케이스는 조합 불변식 위반이 **0건**이었다(되돌아갈 것이 없었으므로).
// "위반 0"은 "정상"이 아니며, 주 판정은 언제나 최종 문자열이다.
// -----------------------------------------------------------------------------


// =============================================================================
// What one keystroke means inside the composer (goal B8 H4).
//
// Pure on purpose. The rule this file encodes is not "Enter sends": it is
// "Enter sends EXCEPT while an IME owns the keystroke", and that exception is
// the whole ticket. A Korean sentence is typed through a composition session,
// and the Enter that ENDS that session belongs to the IME, not to us. Send on
// it and 한글 users lose half a sentence into the channel on every second line,
// which is exactly what the QA sweep hit.
//
// Two browser orders exist for the committing Enter and the guard has to cover
// both, because the same bundle runs in Chrome and in the Tauri WKWebView:
//
//   Chromium/Gecko:  keydown(Enter, isComposing=true) -> compositionend -> keyup
//   WebKit:          compositionend -> keydown(Enter, isComposing=false) -> keyup
//
// The first order is caught by `composing` (KeyboardEvent.isComposing, with
// `keyCode === 229` as the legacy spelling some engines still use). The second
// order is caught by `justComposed`: the caller raises it on `compositionend`
// and lowers it on the next `keyup`, so it covers exactly the one keydown that
// can sit between a composition ending and the key being released, and nothing
// after it. No timers, so a fast typist cannot outrun it and a slow one cannot
// be stranded by it.
//
// Arrow/Escape/Tab carry the same exception for the same reason: while a
// composition is open those keys drive the IME's own candidate UI.
// =============================================================================

export type ComposerKeyIntent =
  | "send"
  /** Insert a line break: the textarea's own default, so the caller does nothing. */
  | "newline"
  | "mention-accept"
  | "mention-next"
  | "mention-prev"
  | "mention-close"
  /**
   * ADR-0148 - 컴포저에 걸린 인용을 뗀다.
   *
   * Esc 하나에 두 뜻을 겹치지 않는다: 멘션 목록이 열려 있으면 Esc는 그 목록을
   * 닫고(`mention-close`), 닫혀 있을 때만 인용으로 내려온다. 「지금 열려 있는
   * 가장 위의 것을 닫는다」는 Esc의 보편 규칙이고, 순서를 뒤집으면 후보를 고르다
   * Esc를 눌렀을 때 목록은 그대로인데 인용이 사라진다.
   */
  | "quote-cancel"
  /** Not ours: let the textarea (or the IME) have it. */
  | "pass";

export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** An IME composition owns this keystroke (isComposing, or keyCode 229). */
  composing: boolean;
}

export interface ComposerKeyState {
  /** The @mention listbox is on screen with at least one candidate. */
  mentionsOpen: boolean;
  /**
   * A composition ended and no key has been released since — i.e. this keydown
   * may be the very keystroke that committed it (WebKit order).
   */
  justComposed: boolean;
  /**
   * Enter is the send key here. False on the phone shell, where it is the ONLY
   * line break the person has: a software keyboard has no Shift+Enter, so
   * sending on Enter would take multi-line messages away from exactly the
   * readers who need them most (Slack, Messages and KakaoTalk all keep Enter as
   * a newline on a phone and put send on the button). The composer's Enter hint
   * is hidden at the same breakpoint, so what is on screen and what the key does
   * cannot disagree.
   */
  enterSends: boolean;
  /**
   * ADR-0148 - 이 컴포저에 인용이 걸려 있다. Esc가 뗄 것이 있는지를 여기서만
   * 묻는다: 걸려 있지 않으면 Esc는 `pass`로 남아 textarea(와 그 위 다이얼로그)의
   * 것이 된다.
   *
   * 옵셔널이다. 인용을 아직 모르는 표면(스레드 컴포저)이 이 키를 적어 넣지 않아도
   * 동작이 이전과 한 글자도 다르지 않아야 한다.
   */
  quoteOpen?: boolean;
}

/** True when the keystroke belongs to an in-flight IME composition. */
function imeOwns(event: ComposerKeyEvent, state: ComposerKeyState): boolean {
  return event.composing || state.justComposed;
}

/**
 * Decide what a composer keydown means. The caller applies it; nothing here
 * touches the DOM, so every branch below is asserted in composerKeys.test.ts
 * rather than reasoned about from the component.
 */
export function composerKeyIntent(
  event: ComposerKeyEvent,
  state: ComposerKeyState
): ComposerKeyIntent {
  if (event.key === "Enter") {
    // The IME's Enter. Never a send, never a newline: the textarea has already
    // been given the composed text by the time we would act on it.
    if (imeOwns(event, state)) return "pass";
    // ⌘↵ / Ctrl+↵ stays a send, and it outranks the mention list: it was the
    // only send path this composer had, and a keyboard habit that quietly
    // starts inserting a handle instead of sending is worse than one that
    // still sends.
    if (event.metaKey || event.ctrlKey) return "send";
    if (state.mentionsOpen && !event.shiftKey && !event.altKey) {
      return "mention-accept";
    }
    // Shift+Enter is the line break, and where Enter sends it is the only one,
    // which is why the composer prints the hint: a send key that used to be a
    // newline key has to say so where the typing happens.
    if (event.shiftKey) return "newline";
    return state.enterSends ? "send" : "newline";
  }

  if (event.key === "Tab") {
    if (imeOwns(event, state)) return "pass";
    return state.mentionsOpen ? "mention-accept" : "pass";
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    // `composing` only (not `justComposed`): arrows do not commit a
    // composition, so a released-key window says nothing about them.
    if (event.composing || !state.mentionsOpen) return "pass";
    return event.key === "ArrowDown" ? "mention-next" : "mention-prev";
  }

  if (event.key === "Escape") {
    if (event.composing) return "pass";
    if (state.mentionsOpen) return "mention-close";
    if (state.quoteOpen === true) return "quote-cancel";
    return "pass";
  }

  return "pass";
}

/**
 * `KeyboardEvent.isComposing`, with the legacy spelling engines that predate it
 * still use. Read as a plain shape rather than a DOM type so the composer can
 * hand over a React synthetic event's `nativeEvent` and a test can hand over an
 * object literal.
 */
export function isComposingEvent(event: {
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
