import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Comments in this repository quote counter-examples verbatim; strip them. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

const DOCK = readFileSync(new URL("./TerminalDock.tsx", import.meta.url), "utf8");
const DOCK_CODE = codeOnly(DOCK);
const SHELL = readFileSync(
  new URL("../chat/ChatShell.tsx", import.meta.url),
  "utf8"
);
const SHELL_CODE = codeOnly(SHELL);
const OBSERVER = readFileSync(
  new URL("./ObserverTerminal.tsx", import.meta.url),
  "utf8"
);

describe("TC-1 terminal dock is observation-only UI on the existing session model", () => {
  it("does not invent a new-session control or stdin encoder", () => {
    expect(DOCK_CODE).not.toMatch(/createWorkSession/);
    expect(DOCK_CODE).not.toMatch(/\bPlus\b/);
    expect(DOCK_CODE).not.toMatch(/send_stdin|sendInput|onData/);
    expect(DOCK).toMatch(/testId="terminal-dock-empty"/);
    expect(DOCK).toMatch(/data-testid="terminal-dock-loading"/);
    expect(DOCK).toMatch(/testId="terminal-dock-error"/);
    expect(DOCK).toMatch(/testId="terminal-dock-offline"/);
  });

  it("reuses ObserverTerminal in dock layout and names the surface read-only", () => {
    expect(DOCK_CODE).toMatch(/variant="dock"/);
    expect(DOCK_CODE).toMatch(/<ObserverTerminal/);
    expect(OBSERVER).toMatch(/variant\?: "pane" \| "dock"/);
    expect(OBSERVER).toMatch(/disableStdin: true/);
  });

  it("declares tablist keyboard traversal and Escape close", () => {
    expect(DOCK).toMatch(/role="tablist"/);
    expect(DOCK_CODE).toMatch(/ArrowLeft/);
    expect(DOCK_CODE).toMatch(/ArrowRight/);
    expect(DOCK_CODE).toMatch(/event\.key !== "Escape"/);
    expect(DOCK).toMatch(/data-testid="terminal-dock-expand"/);
    expect(DOCK).toMatch(/data-testid="terminal-dock-close"/);
    expect(DOCK).toMatch(/data-scroll-x=""/);
    expect(DOCK_CODE).toMatch(/terminal-dock/);
    expect(DOCK_CODE).not.toMatch(/h-pane/);
    expect(DOCK).toMatch(/aria-label="터미널 크게 보기"/);
    expect(DOCK).toMatch(/headingLevel=\{2\}/);
  });

  it("imports lucide glyphs by static name at 16px", () => {
    expect(DOCK).toMatch(/import \{ ChevronsUpDown, X \} from "lucide-react"/);
    expect(DOCK).toMatch(/ChevronsUpDown aria-hidden="true" className="size-4"/);
    expect(DOCK).toMatch(/<X aria-hidden="true" className="size-4"/);
  });
});

describe("channel header terminal opens the dock, not a fake input", () => {
  it("wires the header SquareTerminal to TerminalDock", () => {
    expect(SHELL_CODE).toMatch(/<TerminalDock /);
    expect(SHELL_CODE).toMatch(/setDockOpen/);
    expect(SHELL).toMatch(/aria-label="터미널"/);
    expect(SHELL).toMatch(/data-testid="open-terminal-dock"/);
    expect(SHELL_CODE).not.toMatch(/data-testid="open-work-panel"/);
    expect(SHELL_CODE).toMatch(/requestAnimationFrame/);
  });

  it("XOR the right work panel so ObserverTerminal is not mounted twice", () => {
    expect(SHELL_CODE).toMatch(/!dockOpen/);
    expect(SHELL_CODE).toMatch(/setDockOpen\(false\)/);
  });
});

describe("WorkPanel is reached from the work console, not the header", () => {
  const CONSOLE = readFileSync(
    new URL("../workConsole/WorkConsoleRoute.tsx", import.meta.url),
    "utf8"
  );

  it("keeps open-work-panel on the work console route", () => {
    expect(CONSOLE).toMatch(/data-testid="open-work-panel"/);
    expect(CONSOLE).toMatch(/\?work-panel=1/);
    expect(CONSOLE).toMatch(/이 채널에서 작업 보기/);
    expect(CONSOLE).toMatch(/selected\?\.channelId/);
    expect(CONSOLE).not.toMatch(/channels\[0\]/);
    expect(SHELL_CODE).toMatch(/anchorWorkPanel/);
    expect(SHELL_CODE).toMatch(/work-panel/);
  });
});
