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
  /**
   * #5005 - 입력칸 위의 링크 미리보기 카드를 닫는다. ✕와 같은 선택이다(이번 메시지는 미리보기 없이 보내기).
   *
   * Esc 하나에 두 뜻을 겹치지 않는 규칙은 그대로다: 멘션 목록이 열려 있으면 목록이 먼저이고, 그 다음이 이
   * 카드, 그 다음이 인용이다. 카드를 인용보다 앞에 두는 이유: 카드는 사람이 부른 적 없이 **저절로** 나타난
   * 것이라 Esc로 물리치는 것이 가장 흔한 손짓이고, 인용은 사람이 일부러 건 것이라 카드를 보고 누른 Esc가
   * 인용을 날리면 안 된다. Esc를 한 번 더 누르면 인용이 내려온다.
   */
  | "preview-dismiss"
  /**
   * #5476 - 입력칸 위에 떠 있는 이모티콘 추천 줄(글 키워드에 맞는 그림 몇 개)을 닫는다. 줄만 닫고 쓴 글과 낱말은 건드리지 않는다.
   *
   * Esc 하나에 두 뜻을 겹치지 않는 규칙은 그대로다: 멘션 목록이 먼저이고, 그 다음이 **이 줄**, 그 다음이 링크 카드, 이모티콘 미리 보기, 인용이다.
   * 추천 줄을 링크 카드보다 앞에 두는 이유는 같은 논리의 연장이다: 사람이 부른 적 없이 **글을 치다 저절로** 떠서(링크 카드는 붙여넣은 주소에,
   * 이 줄은 마지막 낱말에) Esc 로 물리치는 손짓이 가장 흔하고, 일부러 고른 미리 보기나 인용을 이 Esc 가 날리면 안 된다.
   */
  | "suggest-dismiss"
  /**
   * #5476 - 입력칸에서 ↑: 추천 줄로 포커스를 옮긴다(줄은 입력칸 바로 위에 뜨므로 위쪽 화살표가 자연스럽다).
   *
   * 키가 이 뜻이 되는 것은 추천 줄이 떠 있고, 캐럿이 글의 **첫 줄**에 있고(더 오를 줄이 없다), 수식키가 없고, 한글 조합이 열려 있지 않고, 멘션 목록이
   * 닫혀 있을 때뿐이다. 여러 줄 글을 ↑ 로 오르는 손을 가로채지 않으려는 것이다. 줄은 글이 비면 없으므로 빈 입력칸의 ↑(`edit-last`)와 겹치지 않는다.
   * Tab 은 그대로다: 줄은 입력칸보다 앞(위)에 있어서 Shift+Tab 도 같은 곳에 닿는다.
   */
  | "suggest-focus"
  /**
   * #5191 - 빈 입력칸의 ↑: 이 대화에서 **내** 마지막 글 있는 메시지를 고친다(Slack식).
   *
   * 메시지 고치기는 `⋯` 메뉴 맨 아래에 있어 사람들이 찾지 못했다(#5191). 그래서 가장 손에 익은 길을 하나 더 연다:
   * 방금 보낸 글의 오타는 입력칸에서 ↑ 한 번이면 고쳐진다. 열리는 자리와 대상은 호출부(`lastEditableMessage`)가 정한다.
   *
   * 키가 이 뜻이 되는 것은 **입력칸이 비어 있고** 수식키가 없고 한글 조합이 열려 있지 않고 멘션 목록이 닫혀 있을 때뿐이다.
   * 글이 든 입력칸의 ↑ 는 커서를 옮기는 원래 키이고(`pass`), 멘션 목록이 열려 있으면 ↑ 는 그 목록의 것이다.
   */
  | "edit-last"
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
  /**
   * #5005 - 이 입력칸 위에 링크 미리보기 카드가 떠 있다(그릴 카드가 하나 이상). 카드가 없으면 Esc는 이
   * 키를 모르는 것처럼 지나간다. 옵셔널이라, 카드를 모르는 표면(폰 입력칸)이 이 키를 적지 않아도 동작이
   * 이전과 한 글자도 다르지 않다.
   */
  previewOpen?: boolean;
  /**
   * #5476 - 입력칸 위에 이모티콘 추천 줄이 떠 있다. 떠 있지 않으면 Esc·↑ 는 이 줄을 모르는 것처럼 지나간다. 옵셔널이라 이 줄을 모르는 표면(스레드
   * 입력칸·폰 입력칸)이 이 키를 적지 않아도 동작이 이전과 한 글자도 다르지 않다.
   */
  suggestOpen?: boolean;
  /**
   * #5476 - 캐럿이 입력칸 글의 첫 **화면** 줄에 있다. 앞에 줄바꿈이 없어도 글이 길게 감겨 캐럿이 둘째 줄 이후면 거짓이다(#5489: 줄바꿈만 보면 감긴 문단의 아래 줄에서
   * 도 ↑ 를 가로챈다). 화면 줄은 렌더에서만 알 수 있어 호출하는 표면이 잰다(웹은 `caretLine.ts`). `suggestOpen` 과 함께일 때만 ↑ 가 추천 줄로 간다.
   *
   * **함수로도 줄 수 있다**: 재는 일(렌더 배치를 읽는다)이 싸지 않으므로, 함수를 넘기면 이 판정이 ↑ 에서 나머지 조건(추천 줄이 떠 있고 수식키가 없다)이 모두 맞을 때에만
   * 한 번 부른다. 다른 키·다른 상태에서는 부르지 않는다.
   */
  caretOnFirstLine?: boolean | (() => boolean);
  /**
   * #5191 - 입력칸이 **비어 있다**(글이 한 글자도 없다). `true`일 때만 ↑ 가 `edit-last` 가 된다. 공백만 든 글은 빈 것이
   * 아니다: 그 입력칸의 ↑ 는 여전히 커서의 것이다.
   *
   * 옵셔널이라 이 키를 적지 않는 표면(스레드 입력칸·폰 입력칸)은 동작이 이전과 한 글자도 다르지 않다.
   */
  textEmpty?: boolean;
}

/** True when the keystroke belongs to an in-flight IME composition. */
function imeOwns(event: ComposerKeyEvent, state: ComposerKeyState): boolean {
  return event.composing || state.justComposed;
}

/** `caretOnFirstLine` 은 값이거나, 필요할 때에만 재는 함수다(#5489). 적지 않았으면 첫 줄이 아니다. */
function isCaretOnFirstLine(value: boolean | (() => boolean) | undefined): boolean {
  return typeof value === "function" ? value() : value === true;
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
    if (event.composing) return "pass";
    if (state.mentionsOpen) {
      return event.key === "ArrowDown" ? "mention-next" : "mention-prev";
    }
    // #5476 - 추천 줄이 떠 있고 캐럿이 첫 줄이면 맨 ↑ 는 그 줄로 들어간다. 수식키가 붙은 ↑ 는 위 `edit-last` 와 같은 이유로 운영체제와 브라우저의 것이다.
    if (
      event.key === "ArrowUp" &&
      state.suggestOpen === true &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      isCaretOnFirstLine(state.caretOnFirstLine)
    ) {
      return "suggest-focus";
    }
    // #5191 - 목록이 닫혀 있고 입력칸이 비어 있을 때의 맨 ↑. 수식키가 붙은 ↑ (⌥↑ 줄 맨 앞, ⌘↑ 글 맨 앞, ⇧↑ 선택 늘이기)는
    // 운영체제와 브라우저의 것이다.
    if (
      event.key === "ArrowUp" &&
      state.textEmpty === true &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      return "edit-last";
    }
    return "pass";
  }

  if (event.key === "Escape") {
    if (event.composing) return "pass";
    if (state.mentionsOpen) return "mention-close";
    if (state.suggestOpen === true) return "suggest-dismiss";
    if (state.previewOpen === true) return "preview-dismiss";
    if (state.quoteOpen === true) return "quote-cancel";
    return "pass";
  }

  return "pass";
}

/**
 * #5476 - 추천 줄 **안**에 포커스가 있을 때 한 키가 뜻하는 것. 줄은 가로로 늘어선 단추들(그림 몇 개와 끝의 ✕)이 탭 정거장 하나를 나눠 쓰는 도구줄이다.
 *
 * - `move`: ← → Home End 가 줄 안의 이웃 단추로(`prev`·`next`·`first`·`last`). 끝에서 돌아 나가지 않는 것은 호출부 몫이다.
 * - `dismiss`: Esc 가 줄을 닫는다. 호출부가 포커스를 입력칸에 돌려준다.
 * - `toInput`: ↓ 가 줄을 닫지 않고 입력칸으로 돌아간다. 들어올 때 쓴 ↑ 의 짝이다.
 * Enter·Space 는 여기 없다: 포커스가 놓인 것은 단추라 브라우저가 누름으로 바꾼다. 이 줄의 Enter 는 보내기가 아니라 그 단추를 누르는 일이다.
 * 한글 조합 중이거나 수식키가 붙은 키, 그 밖의 키는 우리 것이 아니라 `null` 이다.
 *
 * 값을 문자열 이름이 아니라 필드로 돌려주는 이유: 호출하는 웹 화면 파일은 직접 문구 장부가 문자열 리터럴을 세므로(`"dismiss"` 한 낱말도 한 건이다) 이름을
 * 비교하지 않고 필드를 읽게 한다. `move` 의 값은 `trayModel.moveTarget` 이 그대로 받는 낱말이다.
 */
export interface SuggestRowKey {
  move?: "prev" | "next" | "first" | "last";
  dismiss?: true;
  toInput?: true;
}

export function suggestRowKey(event: ComposerKeyEvent): SuggestRowKey | null {
  if (event.composing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  switch (event.key) {
    case "ArrowLeft":
      return { move: "prev" };
    case "ArrowRight":
      return { move: "next" };
    case "Home":
      return { move: "first" };
    case "End":
      return { move: "last" };
    case "Escape":
      return { dismiss: true };
    case "ArrowDown":
      return { toInput: true };
    default:
      return null;
  }
}

/** What one keystroke means inside the box that edits a sent message (#5191). */
export type MessageEditorKeyIntent = "save" | "cancel" | "pass";

/**
 * 메시지를 고치는 입력칸의 키: Enter = 저장 · Esc = 취소 · Shift+Enter = 줄바꿈.
 *
 * **컴포저의 규칙과 같다**고 약속한 키들이라, 따로 쓰지 않고 `composerKeyIntent` 위에 선다: 한글 조합을 끝내는
 * Enter 는 Chromium 순서(`isComposing`)로도 WebKit 순서(`justComposed`)로도 저장이 아니다. 편집기는 한글 문장을
 * 여는 곳이라 이 guard 가 새면 쓰던 글이 조합 중간에 저장된다. Esc 도 조합 중에는 IME 의 것이다(후보 창을 닫는
 * 키이고, 편집을 버리는 키가 아니다).
 */
export function messageEditorKeyIntent(
  event: ComposerKeyEvent,
  state: { justComposed: boolean }
): MessageEditorKeyIntent {
  if (event.key === "Enter") {
    const intent = composerKeyIntent(event, {
      mentionsOpen: false,
      justComposed: state.justComposed,
      enterSends: true,
    });
    return intent === "send" ? "save" : "pass";
  }
  if (event.key === "Escape") return event.composing ? "pass" : "cancel";
  return "pass";
}

/**
 * 「조합이 막 끝났다」 깃발(`justComposed`)을 이 키 뒤에도 쥐고 있어야 하는가.
 *
 * 깃발은 조합을 끝낸 **바로 그 keydown 한 번**을 위한 것이다. 조합을 끝낼 수 있는 키는 Enter 와 Tab 뿐이므로(컴포저의
 * `onKeyDown` 첫머리가 같은 말을 한다), 다른 키가 눌렸다면 조합이 키 입력 없이 끝났다는 증거다(보내기 단추를 누르는 중의 클릭).
 * 그때 깃발이 남으면 다음 Enter 가 조합 끝으로 오인돼 삼켜진다. 편집기(`MessageEditor`)는 이 판정을 여기서 가져간다 — 웹
 * 파일에 키 이름을 또 적지 않으려는 것이고(직접 문구 장부는 문자열 리터럴 수를 센다), 두 입력칸이 같은 규칙을 한 곳에서 읽게 하려는 것이다.
 */
export function keyKeepsCompositionGuard(key: string): boolean {
  return key === "Enter" || key === "Tab";
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
