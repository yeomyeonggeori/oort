import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { restoreDialogOpenerFocus, type DialogFocusTarget } from "./dialog";

describe("popover opener restore", () => {
  it("reuses the dialog helper so picker close returns to the trigger", () => {
    const focus = vi.fn();
    const opener: DialogFocusTarget = { isConnected: true, focus };
    expect(restoreDialogOpenerFocus(opener)).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("wires onCloseAutoFocus through restoreDialogOpenerFocus", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./popover.tsx", import.meta.url)),
      "utf8"
    );
    expect(source).toContain("restoreDialogOpenerFocus");
    expect(source).toContain("onCloseAutoFocus");
  });
});
