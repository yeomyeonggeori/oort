import { describe, expect, it, vi } from "vitest";
import { restoreDialogOpenerFocus, type DialogFocusTarget } from "./dialog";

describe("dialog focus restoration", () => {
  it("returns a closed programmatic dialog to its opener", () => {
    const focus = vi.fn();
    const opener: DialogFocusTarget = { isConnected: true, focus };
    expect(restoreDialogOpenerFocus(opener)).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });
});
