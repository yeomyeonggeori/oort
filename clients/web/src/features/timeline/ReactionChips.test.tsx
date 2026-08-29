// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { ReactionChip } from "@momo/core/features/timeline/reactions";
import {
  REACTION_ADD_HINT,
  REACTION_REMOVE_HINT,
  REACTION_SELF_LABEL,
} from "@momo/core/features/timeline/reactionNames";
import { ReactionChips } from "./ReactionChips";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "11111111-2222-3333-4444-555555555555";
const MINJUN = "aaaaaaaa-bbbb-cccc-dddd-000000000001";
const SEOYEON = "aaaaaaaa-bbbb-cccc-dddd-000000000002";

function member(
  over: Partial<RosterMember> & { id: string; displayName: string; handle: string }
): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const DIRECTORY = makeDirectory([
  member({ id: ME, displayName: "데모 사용자", handle: "demo" }),
  member({ id: MINJUN, displayName: "김민준", handle: "minjun" }),
  member({ id: SEOYEON, displayName: "이서연", handle: "seoyeon" }),
]);

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(node);
  });
  return host;
}

describe("ReactionChips", () => {
  it("renders nothing when there are no chips, so the row keeps its rhythm", () => {
    const root = mount(
      createElement(ReactionChips, {
        chips: [],
        directory: DIRECTORY,
        myMemberId: ME,
        onToggle: () => undefined,
      })
    );
    expect(root.querySelector("[data-testid='reaction-chips']")).toBeNull();
  });

  it("exposes names on hover (title) and keyboard focus, and keeps the toggle", () => {
    const onToggle = vi.fn();
    const chips: ReactionChip[] = [
      {
        emoji: "👍",
        count: 2,
        mine: true,
        memberIds: [ME, MINJUN],
      },
    ];
    const root = mount(
      createElement(ReactionChips, {
        chips,
        directory: DIRECTORY,
        myMemberId: ME,
        onToggle,
        onOpenPicker: () => undefined,
      })
    );
    const chip = root.querySelector<HTMLButtonElement>(
      "[data-testid='reaction-chip']"
    );
    expect(chip).not.toBeNull();
    if (!chip) throw new Error("missing chip");

    const names = `${REACTION_SELF_LABEL}(${REACTION_REMOVE_HINT}), 김민준`;
    expect(chip.getAttribute("title")).toBe(names);
    expect(chip.getAttribute("aria-label")).toBe(`👍 반응 2개, ${names}`);
    expect(chip.getAttribute("data-row-action")).toBe("");
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(chip.getAttribute("title")).toBe(names);

    act(() => {
      chip.focus();
    });
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute("title")).toBe(names);
    expect(chip.getAttribute("aria-label")).toBe(`👍 반응 2개, ${names}`);

    act(() => {
      chip.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("👍");

    const add = root.querySelector("[data-testid='reaction-add']");
    expect(add).not.toBeNull();
    expect(add?.getAttribute("data-row-action")).toBe("");
  });

  it("names other reactors and keeps the add hint on a chip that is not mine", () => {
    const chips: ReactionChip[] = [
      {
        emoji: "🎉",
        count: 2,
        mine: false,
        memberIds: [MINJUN, SEOYEON],
      },
    ];
    const root = mount(
      createElement(ReactionChips, {
        chips,
        directory: DIRECTORY,
        myMemberId: ME,
        onToggle: () => undefined,
      })
    );
    const chip = root.querySelector("[data-testid='reaction-chip']");
    expect(chip?.getAttribute("title")).toBe("김민준, 이서연");
    expect(chip?.getAttribute("aria-label")).toBe(
      `🎉 반응 2개, 김민준, 이서연, ${REACTION_ADD_HINT}`
    );
    expect(chip?.getAttribute("aria-pressed")).toBe("false");
  });
});
