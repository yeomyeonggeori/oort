import { describe, expect, it, vi } from "vitest";
import {
  composerKeyIntent,
  isComposingEvent,
  keyKeepsCompositionGuard,
  messageEditorKeyIntent,
  suggestRowKey,
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

  // #5191 - 빈 입력칸의 ↑ 는 「이 대화에서 내 마지막 메시지 고치기」다(Slack식). 글이 든 입력칸에서 ↑ 는
  // 커서를 옮기는 원래 키로 남고, 멘션 목록·한글 조합·수식키가 쥔 ↑ 는 우리 것이 아니다.
  describe("edit-last (#5191)", () => {
    const EMPTY: ComposerKeyState = { ...IDLE, textEmpty: true };

    it("opens the last own message on a bare ArrowUp in an empty composer", () => {
      expect(composerKeyIntent(key("ArrowUp"), EMPTY)).toBe("edit-last");
    });

    it("leaves ArrowUp to the caret as soon as the composer holds text", () => {
      expect(composerKeyIntent(key("ArrowUp"), { ...IDLE, textEmpty: false })).toBe("pass");
    });

    it("is unchanged for a surface that never says textEmpty (thread composer, phone)", () => {
      expect(composerKeyIntent(key("ArrowUp"), IDLE)).toBe("pass");
      expect(composerKeyIntent(key("ArrowUp"), PHONE)).toBe("pass");
    });

    it("is not ours with a modifier held", () => {
      for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
        expect(composerKeyIntent(key("ArrowUp", { [modifier]: true }), EMPTY)).toBe("pass");
      }
    });

    it("yields the arrow to an open IME and to the mention list", () => {
      expect(composerKeyIntent(key("ArrowUp", { composing: true }), EMPTY)).toBe("pass");
      expect(composerKeyIntent(key("ArrowUp"), { ...EMPTY, mentionsOpen: true })).toBe("mention-prev");
    });

    it("is only ArrowUp: no other key and not ArrowDown", () => {
      expect(composerKeyIntent(key("ArrowDown"), EMPTY)).toBe("pass");
      expect(composerKeyIntent(key("ArrowLeft"), EMPTY)).toBe("pass");
      expect(composerKeyIntent(key("Enter"), EMPTY)).toBe("send");
    });
  });

  it("dismisses the link preview card on Escape, below the mention list and above the quote", () => {
    const CARD: ComposerKeyState = { ...IDLE, previewOpen: true };
    expect(composerKeyIntent(key("Escape"), CARD)).toBe("preview-dismiss");
    // The topmost thing goes first: the mention list, then the card, then the quote.
    expect(composerKeyIntent(key("Escape"), { ...CARD, mentionsOpen: true })).toBe("mention-close");
    expect(composerKeyIntent(key("Escape"), { ...CARD, quoteOpen: true })).toBe("preview-dismiss");
    expect(composerKeyIntent(key("Escape"), { ...IDLE, quoteOpen: true })).toBe("quote-cancel");
    // An IME owns Escape while it composes, and a surface that never says `previewOpen` is unchanged.
    expect(composerKeyIntent(key("Escape", { composing: true }), CARD)).toBe("pass");
    expect(composerKeyIntent(key("Escape"), { ...IDLE, previewOpen: false })).toBe("pass");
    // Escape is not a send key: the card never changes what Enter and Cmd+Enter do.
    expect(composerKeyIntent(key("Enter"), CARD)).toBe("send");
    expect(composerKeyIntent(key("Enter", { metaKey: true }), CARD)).toBe("send");
  });

  // #5476 - 입력칸 위 이모티콘 추천 줄. 줄은 글을 치다 저절로 뜨므로 Esc 는 링크 카드·미리 보기·인용보다 먼저 이 줄을 닫고, 맨 ↑ 는 (캐럿이 첫 줄일 때)
  // 이 줄로 들어간다. **Enter 는 한 글자도 달라지지 않는다**: 줄이 떠 있다고 Enter 가 추천을 고르지 않고 보내기로 남는다(멘션 목록과 다른 점).
  describe("suggest row (#5476)", () => {
    const ROW: ComposerKeyState = { ...IDLE, suggestOpen: true, caretOnFirstLine: true };
    const PHONE_ROW: ComposerKeyState = { ...ROW, enterSends: false };

    it("closes the row on Escape, after the mention list and before the card, the preview and the quote", () => {
      expect(composerKeyIntent(key("Escape"), ROW)).toBe("suggest-dismiss");
      expect(composerKeyIntent(key("Escape"), { ...ROW, mentionsOpen: true })).toBe("mention-close");
      expect(composerKeyIntent(key("Escape"), { ...ROW, previewOpen: true, quoteOpen: true })).toBe("suggest-dismiss");
      // 줄이 없으면 Esc 는 이전 순서 그대로다.
      expect(composerKeyIntent(key("Escape"), { ...IDLE, suggestOpen: false, previewOpen: true })).toBe("preview-dismiss");
      expect(composerKeyIntent(key("Escape"), { ...IDLE, previewOpen: true, quoteOpen: true })).toBe("preview-dismiss");
      expect(composerKeyIntent(key("Escape", { composing: true }), ROW)).toBe("pass");
    });

    it("moves focus into the row on a bare ArrowUp from the first line", () => {
      expect(composerKeyIntent(key("ArrowUp"), ROW)).toBe("suggest-focus");
    });

    it("leaves ArrowUp to the caret when it is not on the first line, or when no row is open", () => {
      expect(composerKeyIntent(key("ArrowUp"), { ...ROW, caretOnFirstLine: false })).toBe("pass");
      expect(composerKeyIntent(key("ArrowUp"), { ...IDLE, suggestOpen: true })).toBe("pass");
      expect(composerKeyIntent(key("ArrowUp"), { ...IDLE, suggestOpen: false, caretOnFirstLine: true })).toBe("pass");
      expect(composerKeyIntent(key("ArrowUp"), IDLE)).toBe("pass");
    });

    // #5489 - 「첫 화면 줄」은 렌더에서만 알 수 있고 재는 일이 싸지 않다: 함수로 받으면 ↑ 가 줄로 들어갈 수 있는 모든 조건이 맞을 때에만 한 번 묻는다.
    it("takes caretOnFirstLine as a function and asks it once, only when a bare ArrowUp could enter the open row", () => {
      const ask = vi.fn(() => true);
      const lazy: ComposerKeyState = { ...IDLE, suggestOpen: true, caretOnFirstLine: ask };
      expect(composerKeyIntent(key("ArrowUp"), lazy)).toBe("suggest-focus");
      expect(ask).toHaveBeenCalledTimes(1);

      // 묻지 않는 경우: 다른 키, 수식키, 한글 조합 중, 멘션 목록이 열림, 줄이 없음.
      ask.mockClear();
      const notAsked = [
        composerKeyIntent(key("ArrowDown"), lazy),
        composerKeyIntent(key("Enter"), lazy),
        composerKeyIntent(key("Escape"), lazy),
        composerKeyIntent(key("a"), lazy),
        composerKeyIntent(key("ArrowUp", { shiftKey: true }), lazy),
        composerKeyIntent(key("ArrowUp", { altKey: true }), lazy),
        composerKeyIntent(key("ArrowUp", { composing: true }), lazy),
        composerKeyIntent(key("ArrowUp"), { ...lazy, mentionsOpen: true }),
        composerKeyIntent(key("ArrowUp"), { ...lazy, suggestOpen: false }),
      ];
      expect(notAsked).toEqual(["pass", "send", "suggest-dismiss", "pass", "pass", "pass", "pass", "mention-prev", "pass"]);
      expect(ask).not.toHaveBeenCalled();

      // 거짓이면 ↑ 는 글(커서)의 것이다.
      const wrapped: ComposerKeyState = { ...IDLE, suggestOpen: true, caretOnFirstLine: () => false };
      expect(composerKeyIntent(key("ArrowUp"), wrapped)).toBe("pass");
    });

    it("is not ours with a modifier held, under an open IME, or with the mention list open", () => {
      for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
        expect(composerKeyIntent(key("ArrowUp", { [modifier]: true }), ROW)).toBe("pass");
      }
      expect(composerKeyIntent(key("ArrowUp", { composing: true }), ROW)).toBe("pass");
      expect(composerKeyIntent(key("ArrowUp"), { ...ROW, mentionsOpen: true })).toBe("mention-prev");
      expect(composerKeyIntent(key("ArrowDown"), ROW)).toBe("pass");
    });

    it("never changes what Enter, Shift+Enter, Cmd+Enter and Tab do: the row does not pick anything", () => {
      expect(composerKeyIntent(key("Enter"), ROW)).toBe("send");
      expect(composerKeyIntent(key("Enter", { shiftKey: true }), ROW)).toBe("newline");
      expect(composerKeyIntent(key("Enter", { metaKey: true }), ROW)).toBe("send");
      expect(composerKeyIntent(key("Enter"), PHONE_ROW)).toBe("newline");
      expect(composerKeyIntent(key("Tab"), ROW)).toBe("pass");
      // 한글 조합을 끝내는 Enter 도 그대로 IME 의 것이다.
      expect(composerKeyIntent(key("Enter", { composing: true }), ROW)).toBe("pass");
      expect(composerKeyIntent(key("Enter"), { ...ROW, justComposed: true })).toBe("pass");
    });
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

// #5476 - 추천 줄 안에 포커스가 있을 때의 키. ← → Home End 로 이웃 단추, Esc 로 줄 닫기, ↓ 로 입력칸으로 돌아간다. Enter·Space 는 단추의 기본 동작이라 여기 없다.
describe("suggestRowKey", () => {
  it("walks the row with the horizontal keys", () => {
    expect(suggestRowKey(key("ArrowLeft"))).toEqual({ move: "prev" });
    expect(suggestRowKey(key("ArrowRight"))).toEqual({ move: "next" });
    expect(suggestRowKey(key("Home"))).toEqual({ move: "first" });
    expect(suggestRowKey(key("End"))).toEqual({ move: "last" });
  });

  it("closes the row on Escape and returns to the input on ArrowDown", () => {
    expect(suggestRowKey(key("Escape"))).toEqual({ dismiss: true });
    expect(suggestRowKey(key("ArrowDown"))).toEqual({ toInput: true });
  });

  it("leaves Enter and Space to the focused button, and every other key to the browser", () => {
    for (const other of ["Enter", " ", "Tab", "ArrowUp", "a", "Backspace"]) {
      expect(suggestRowKey(key(other))).toBeNull();
    }
  });

  it("is not ours under an open IME or with a modifier held", () => {
    expect(suggestRowKey(key("Escape", { composing: true }))).toBeNull();
    for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
      expect(suggestRowKey(key("ArrowRight", { [modifier]: true }))).toBeNull();
      expect(suggestRowKey(key("Escape", { [modifier]: true }))).toBeNull();
    }
  });
});

// #5191 - 메시지를 고치는 입력칸의 키. Enter = 저장 · Esc = 취소는 컴포저의 규칙과 같아야 해서, 한글 조합 guard 가
// 새는 곳이 없게 컴포저의 판정(`composerKeyIntent`) 위에 선다.
describe("messageEditorKeyIntent", () => {
  const STATE = { justComposed: false };

  it("saves on Enter, cancels on Escape, breaks the line on Shift+Enter", () => {
    expect(messageEditorKeyIntent(key("Enter"), STATE)).toBe("save");
    expect(messageEditorKeyIntent(key("Escape"), STATE)).toBe("cancel");
    expect(messageEditorKeyIntent(key("Enter", { shiftKey: true }), STATE)).toBe("pass");
  });

  it("keeps the ⌘↵ / Ctrl+↵ save, like the composer's send", () => {
    expect(messageEditorKeyIntent(key("Enter", { metaKey: true }), STATE)).toBe("save");
    expect(messageEditorKeyIntent(key("Enter", { ctrlKey: true }), STATE)).toBe("save");
  });

  it("never saves on the Enter that commits a Chromium or WebKit composition", () => {
    expect(messageEditorKeyIntent(key("Enter", { composing: true }), STATE)).toBe("pass");
    expect(messageEditorKeyIntent(key("Enter"), { justComposed: true })).toBe("pass");
  });

  it("leaves Escape to the IME while it composes: it closes the candidate window, not the editor", () => {
    expect(messageEditorKeyIntent(key("Escape", { composing: true }), STATE)).toBe("pass");
  });

  it("passes every other key through, arrows included", () => {
    expect(messageEditorKeyIntent(key("ArrowUp"), STATE)).toBe("pass");
    expect(messageEditorKeyIntent(key("a"), STATE)).toBe("pass");
  });
});

describe("keyKeepsCompositionGuard", () => {
  it("keeps the just-composed flag only across the keys that can commit a composition", () => {
    expect(keyKeepsCompositionGuard("Enter")).toBe(true);
    expect(keyKeepsCompositionGuard("Tab")).toBe(true);
  });

  it("lets every other key clear it: a composition that ended without a keystroke must not swallow the next Enter", () => {
    for (const other of ["a", "ㅎ", "ArrowUp", "ArrowDown", "Escape", "Backspace", " ", "Shift"]) {
      expect(keyKeepsCompositionGuard(other)).toBe(false);
    }
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
