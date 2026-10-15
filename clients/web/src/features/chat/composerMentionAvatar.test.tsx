// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { ComposerAutocompleteList } from "./ComposerAutocompleteList";
import { memberCandidates } from "./composerAutocomplete";

// #3821: 멘션 목록은 사람과 에이전트의 사진(없으면 이니셜)을 같은 컴포넌트로 그린다.

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const base = {
  workspaceId: "w", status: "active" as const, channelCount: 0, channelIds: [],
  capabilities: [], createdAtMs: 0, updatedAtMs: 0,
};
const MEMBERS: RosterMember[] = [
  { ...base, id: "h1", kind: "human", displayName: "곽성재", handle: "seongjae" },
  { ...base, id: "a1", kind: "agent", displayName: "그록", handle: "grok" },
];

describe("멘션 목록 아바타", () => {
  it("모든 후보 줄이 아바타를 갖고, 에이전트는 에이전트 문법이며 이니셜로 물러난다", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const candidates = memberCandidates(MEMBERS, "");
    act(() => {
      root?.render(
        createElement(ComposerAutocompleteList, {
          id: "ac", kind: "mention", candidates, highlight: 0, onChoose: () => undefined,
          testId: "ac-list", optionTestId: "ac-option",
        })
      );
    });
    const rows = [...document.querySelectorAll("[data-testid='ac-option']")];
    expect(rows).toHaveLength(2);
    const avatars = rows.map((row) => row.querySelector("[data-testid='member-avatar']"));
    expect(avatars.every((a) => a !== null)).toBe(true);
    expect(avatars.map((a) => a?.getAttribute("data-avatar-kind")).sort()).toEqual(["agent", "human"]);
    expect(avatars.every((a) => a?.getAttribute("data-avatar-size") === "sm")).toBe(true);
    expect(avatars.map((a) => a?.textContent).sort()).toEqual(["곽", "그"]);
  });

  it("후보가 명부 행을 그대로 들고 있어야 아바타를 그릴 수 있다", () => {
    expect(memberCandidates(MEMBERS, "gro")[0]?.member?.id).toBe("a1");
  });
});
