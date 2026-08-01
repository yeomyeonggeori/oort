import { describe, expect, it } from "vitest";
import {
  composerKeyIntent,
  isComposingEvent,
  type ComposerKeyEvent,
  type ComposerKeyState,
} from "./composerKeys";

function key(
  name: string,
  overrides: Partial<ComposerKeyEvent> = {}
): ComposerKeyEvent {
  return {
    key: name,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    composing: false,
    ...overrides,
  };
}

const IDLE: ComposerKeyState = {
  mentionsOpen: false,
  justComposed: false,
  enterSends: true,
};
const MENTIONS: ComposerKeyState = { ...IDLE, mentionsOpen: true };
/** The phone shell, where a software keyboard has no Shift+Enter to offer. */
const PHONE: ComposerKeyState = { ...IDLE, enterSends: false };

describe("composerKeyIntent", () => {
  it("sends on Enter and breaks the line on Shift+Enter", () => {
    expect(composerKeyIntent(key("Enter"), IDLE)).toBe("send");
    expect(composerKeyIntent(key("Enter", { shiftKey: true }), IDLE)).toBe(
      "newline"
    );
  });

  it("keeps the old ⌘↵ / Ctrl+↵ send", () => {
    expect(composerKeyIntent(key("Enter", { metaKey: true }), IDLE)).toBe("send");
    expect(composerKeyIntent(key("Enter", { ctrlKey: true }), IDLE)).toBe("send");
    // Even with the mention list open: the habit predates the list.
    expect(composerKeyIntent(key("Enter", { metaKey: true }), MENTIONS)).toBe(
      "send"
    );
  });

  // The ticket. 한글 is typed inside a composition session, and the Enter that
  // closes that session is the IME's. Sending on it posts half a sentence.
  it("never sends on the Enter that commits a Chromium composition", () => {
    expect(composerKeyIntent(key("Enter", { composing: true }), IDLE)).toBe(
      "pass"
    );
  });

  // WebKit (and therefore the Tauri shell) dispatches compositionend BEFORE the
  // keydown of the same Enter, so `isComposing` is already false by then. The
  // caller's compositionend->keyup window is what catches that order.
  it("never sends on the Enter that commits a WebKit composition", () => {
    expect(
      composerKeyIntent(key("Enter"), { ...IDLE, justComposed: true })
    ).toBe("pass");
  });

  it("releases the guard once a key has been released", () => {
    // Same event, guard lowered: this is the deliberate second Enter.
    expect(
      composerKeyIntent(key("Enter"), { ...IDLE, justComposed: false })
    ).toBe("send");
  });

  it("does not let a committing Enter pick a mention either", () => {
    expect(composerKeyIntent(key("Enter", { composing: true }), MENTIONS)).toBe(
      "pass"
    );
    expect(
      composerKeyIntent(key("Enter"), { ...MENTIONS, justComposed: true })
    ).toBe("pass");
  });

  it("accepts a mention with Enter or Tab while the list is open", () => {
    expect(composerKeyIntent(key("Enter"), MENTIONS)).toBe("mention-accept");
    expect(composerKeyIntent(key("Tab"), MENTIONS)).toBe("mention-accept");
    expect(composerKeyIntent(key("Tab"), IDLE)).toBe("pass");
  });

  it("still breaks the line on Shift+Enter with the list open", () => {
    expect(composerKeyIntent(key("Enter", { shiftKey: true }), MENTIONS)).toBe(
      "newline"
    );
  });

  it("moves the mention highlight, and yields the arrows to an open IME", () => {
    expect(composerKeyIntent(key("ArrowDown"), MENTIONS)).toBe("mention-next");
    expect(composerKeyIntent(key("ArrowUp"), MENTIONS)).toBe("mention-prev");
    expect(
      composerKeyIntent(key("ArrowDown", { composing: true }), MENTIONS)
    ).toBe("pass");
    expect(composerKeyIntent(key("ArrowDown"), IDLE)).toBe("pass");
  });

  it("closes the mention list on Escape unless the IME is composing", () => {
    expect(composerKeyIntent(key("Escape"), MENTIONS)).toBe("mention-close");
    expect(composerKeyIntent(key("Escape", { composing: true }), MENTIONS)).toBe(
      "pass"
    );
    expect(composerKeyIntent(key("Escape"), IDLE)).toBe("pass");
  });

  // A phone has no Shift+Enter. Sending on Enter there would remove the line
  // break entirely, so Enter keeps its old meaning and the send button sends.
  it("keeps Enter as a line break on the phone shell", () => {
    expect(composerKeyIntent(key("Enter"), PHONE)).toBe("newline");
    expect(composerKeyIntent(key("Enter", { shiftKey: true }), PHONE)).toBe(
      "newline"
    );
    // The explicit send paths still send there.
    expect(composerKeyIntent(key("Enter", { metaKey: true }), PHONE)).toBe("send");
    // …and picking a mention still works, which is what Enter did before.
    expect(
      composerKeyIntent(key("Enter"), { ...PHONE, mentionsOpen: true })
    ).toBe("mention-accept");
  });

  it("passes every other key through", () => {
    expect(composerKeyIntent(key("a"), MENTIONS)).toBe("pass");
    expect(composerKeyIntent(key("Backspace"), MENTIONS)).toBe("pass");
  });
});

describe("isComposingEvent", () => {
  it("reads isComposing, and the legacy keyCode 229 spelling", () => {
    expect(isComposingEvent({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isComposingEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposingEvent({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isComposingEvent({})).toBe(false);
  });
});
