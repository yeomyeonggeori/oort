import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composerKeyIntent } from "@momo/core/features/chat/composerKeys";
import {
  MOVE_UNREAD_CHANNEL_SHORTCUT,
  OPEN_INBOX_SHORTCUT,
  OPEN_NEW_DM_SHORTCUT,
  OPEN_QUICK_SWITCHER_SHORTCUT,
  OPEN_SETTINGS_SHORTCUT,
  PRIMARY_ACTION_SHORTCUT,
  REGISTERED_SHORTCUTS,
  ROW_ACTIONS_SHORTCUT,
  SHORTCUT_HELP_GROUPS,
  isTextEntryTarget,
  shouldOpenShortcutHelp,
  type ShortcutEvent,
} from "./keyboardShortcuts";

function key(
  value: string,
  overrides: Partial<ShortcutEvent> = {}
): ShortcutEvent {
  return {
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("shortcut registry", () => {
  it("renders every registered shortcut exactly once", () => {
    const grouped = SHORTCUT_HELP_GROUPS.flatMap((group) => group.shortcuts);
    expect(grouped).toEqual(REGISTERED_SHORTCUTS);
    expect(new Set(grouped.map((shortcut) => shortcut.id)).size).toBe(
      grouped.length
    );
    expect(grouped).toHaveLength(8);
  });

  it("matches the global navigation registrations", () => {
    expect(OPEN_QUICK_SWITCHER_SHORTCUT.matches(key("k", { metaKey: true }))).toBe(
      true
    );
    expect(OPEN_NEW_DM_SHORTCUT.matches(key("K", { ctrlKey: true, shiftKey: true }))).toBe(
      true
    );
    expect(OPEN_SETTINGS_SHORTCUT.matches(key(",", { metaKey: true }))).toBe(true);
    expect(
      OPEN_INBOX_SHORTCUT.matches(key("a", { metaKey: true, shiftKey: true }))
    ).toBe(true);
    expect(
      MOVE_UNREAD_CHANNEL_SHORTCUT.matches(key("ArrowDown", { altKey: true }))
    ).toBe(true);

    expect(OPEN_QUICK_SWITCHER_SHORTCUT.matches(key("k"))).toBe(false);
    expect(
      OPEN_INBOX_SHORTCUT.matches(
        key("a", { ctrlKey: true, shiftKey: true })
      )
    ).toBe(false);
    expect(MOVE_UNREAD_CHANNEL_SHORTCUT.matches(key("ArrowDown"))).toBe(false);
  });

  it("keeps the shared primary-action help entry aligned with the composer", () => {
    const event = key("Enter", { metaKey: true });
    expect(PRIMARY_ACTION_SHORTCUT.matches(event)).toBe(true);
    expect(
      composerKeyIntent(
        {
          ...event,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          composing: false,
        },
        {
          mentionsOpen: false,
          justComposed: false,
          enterSends: true,
          quoteOpen: false,
        }
      )
    ).toBe("send");
  });

  it("keeps row roving limited to left and right", () => {
    expect(ROW_ACTIONS_SHORTCUT.matches(key("ArrowLeft"))).toBe(true);
    expect(ROW_ACTIONS_SHORTCUT.matches(key("ArrowRight"))).toBe(true);
    expect(ROW_ACTIONS_SHORTCUT.matches(key("ArrowDown"))).toBe(false);
  });
});

describe("? shortcut", () => {
  const target = { tagName: "BUTTON" } as unknown as EventTarget;

  it("opens on Shift+/ from a non-input target", () => {
    expect(
      shouldOpenShortcutHelp({
        ...key("?", { shiftKey: true }),
        code: "Slash",
        target,
      })
    ).toBe(true);
  });

  it("does not open while a person is typing", () => {
    for (const tagName of ["INPUT", "TEXTAREA"]) {
      expect(
        shouldOpenShortcutHelp({
          ...key("?", { shiftKey: true }),
          code: "Slash",
          target: { tagName } as unknown as EventTarget,
        })
      ).toBe(false);
    }
    expect(
      isTextEntryTarget({
        tagName: "SPAN",
        isContentEditable: true,
      } as unknown as EventTarget)
    ).toBe(true);
  });

  it("leaves composing, handled, and ordinary keys alone", () => {
    expect(
      shouldOpenShortcutHelp({
        ...key("?", { shiftKey: true }),
        target,
        isComposing: true,
      })
    ).toBe(false);
    expect(
      shouldOpenShortcutHelp({
        ...key("?", { shiftKey: true }),
        target,
        defaultPrevented: true,
      })
    ).toBe(false);
    expect(shouldOpenShortcutHelp({ ...key("/"), target })).toBe(false);
  });
});

describe("registration drift guard", () => {
  const source = (relative: string) =>
    readFileSync(new URL(relative, import.meta.url), "utf8");

  it("makes every handler consume the same definitions the dialog renders", () => {
    const quickSwitcher = source("./QuickSwitcher.tsx");
    expect(quickSwitcher).toContain("OPEN_NEW_DM_SHORTCUT.matches(event)");
    expect(quickSwitcher).toContain("OPEN_QUICK_SWITCHER_SHORTCUT.matches(event)");
    expect(quickSwitcher).toContain("OPEN_SETTINGS_SHORTCUT.matches(event)");

    expect(source("../features/inbox/InboxHotkeys.tsx")).toContain(
      "OPEN_INBOX_SHORTCUT.matches(event)"
    );
    expect(source("../features/sidebar/Sidebar.tsx")).toContain(
      "MOVE_UNREAD_CHANNEL_SHORTCUT.matches(event)"
    );
    expect(source("../features/timeline/rowFocus.ts")).toContain(
      "ROW_ACTIONS_SHORTCUT.matches({ key })"
    );

    for (const relative of [
      "../features/channels/CreateChannelDialog.tsx",
      "../features/workspace/AddWorkspaceDialog.tsx",
      "../features/agentHub/CreateAgentDialog.tsx",
      "../features/routing/AgentProfileDialog.tsx",
    ]) {
      expect(source(relative), relative).toContain(
        "PRIMARY_ACTION_SHORTCUT.matches(event)"
      );
    }
  });

  it("uses the programmatic dialog opener pattern for Esc focus return", () => {
    const dialog = source("./ShortcutHelpDialog.tsx");
    expect(dialog).toContain("<Dialog open={open} onOpenChange={setDialogOpen}>");
    expect(dialog).toContain("opener={openerRef.current}");
    expect(dialog).toContain("onClick={() => openFrom(triggerRef.current)}");
    expect(dialog).not.toMatch(/<DialogTrigger|import\s+\{[^}]*DialogTrigger/);
  });
});
