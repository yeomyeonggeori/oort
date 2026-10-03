// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ThreadComposer } from "@/features/timeline/ThreadComposer";
import { ComposerAutocompleteList } from "./ComposerAutocompleteList";
import { memberCandidates } from "./composerAutocomplete";

// =============================================================================
// AIH-9 (#3439): 멘션 후보의 보조 줄과 작성 중 한 줄. 문장은 코어가 만들고(`aiMention.test.ts`),
// 여기서는 (1) 후보가 그것을 싣는지, (2) 목록이 그리는지, (3) 작성 창이 한 줄을 올리는지 잰다.
// =============================================================================

const VIEWER = "00000000-0000-7000-8000-00000000000a";
const OWNER = "00000000-0000-7000-8000-00000000000b";

function agent(over: Partial<RosterMember> & { handle: string }): RosterMember {
  return {
    id: `id-${over.handle}`,
    workspaceId: "w",
    kind: "agent",
    status: "active",
    displayName: over.displayName ?? over.handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const MEMBERS: RosterMember[] = [
  agent({ handle: "intern", displayName: "김인턴", brain: "team_key", callableBy: "everyone" }),
  agent({
    handle: "sj",
    displayName: "성재의 Claude Code",
    brain: "subscription",
    callableBy: "owner_only",
    ownerHumanId: OWNER,
    owner: { id: OWNER, displayName: "성재" },
    hostOnline: false,
  }),
  agent({ handle: "legacy", displayName: "옛 서버 에이전트" }),
  agent({ handle: "hanul", displayName: "하늘", kind: "human" }),
];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
});

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(node));
  return host;
}

describe("memberCandidates", () => {
  it("carries the core line, badge and lock for agents only", () => {
    const rows = memberCandidates(MEMBERS, "", undefined, VIEWER);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("id-intern")?.agent).toEqual({ line: "팀 키 · 누구나", badge: "팀 키", locked: false });
    expect(byId.get("id-sj")?.agent).toEqual({
      line: "성재 님 개인 구독 · 성재 님만 부를 수 있어요 · 맥 꺼짐",
      badge: "성재 님만",
      locked: true,
    });
    // 서버가 쓰는 AI를 말하지 않은 에이전트와 사람은 줄이 없다.
    expect(byId.get("id-legacy")?.agent).toBeUndefined();
    expect(byId.get("id-hanul")?.agent).toBeUndefined();
  });
});

describe("ComposerAutocompleteList with agent annotations", () => {
  function list() {
    return mount(
      createElement(ComposerAutocompleteList, {
        id: "l",
        kind: "mention",
        candidates: memberCandidates(MEMBERS, "", undefined, VIEWER),
        highlight: 0,
        onChoose: () => undefined,
        testId: "l",
        optionTestId: "o",
      })
    );
  }

  it("draws the second line, the badge and a lock only on the row the viewer cannot call", () => {
    const root = list();
    const options = [...root.querySelectorAll<HTMLElement>("[data-testid='o']")];
    expect(options).toHaveLength(4);
    const sj = options.find((o) => o.textContent?.includes("@sj"));
    expect(sj?.querySelector("[data-testid='mention-agent-line']")?.textContent).toBe(
      "성재 님 개인 구독 · 성재 님만 부를 수 있어요 · 맥 꺼짐"
    );
    expect(sj?.querySelector("[data-testid='mention-badge']")?.textContent).toBe("성재 님만");
    expect(sj?.querySelector("[data-testid='mention-locked-mark']")).not.toBeNull();
    expect(sj?.hasAttribute("data-locked")).toBe(true);
    const intern = options.find((o) => o.textContent?.includes("@intern"));
    expect(intern?.querySelector("[data-testid='mention-locked-mark']")).toBeNull();
    expect(intern?.hasAttribute("data-locked")).toBe(false);
    const legacy = options.find((o) => o.textContent?.includes("@legacy"));
    expect(legacy?.querySelector("[data-testid='mention-agent-line']")).toBeNull();
  });

  it("stays selectable: a locked row still inserts the handle", () => {
    const chosen: string[] = [];
    mount(
      createElement(ComposerAutocompleteList, {
        id: "l",
        kind: "mention",
        candidates: memberCandidates(MEMBERS, "sj", undefined, VIEWER),
        highlight: 0,
        onChoose: (c) => chosen.push(c.insert),
        testId: "l",
        optionTestId: "o",
      })
    );
    const option = document.querySelector<HTMLElement>("[data-testid='o']");
    act(() => {
      option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(chosen).toEqual(["@sj "]);
  });

  it("keeps the narrow list when no row carries a line", () => {
    mount(
      createElement(ComposerAutocompleteList, {
        id: "l",
        kind: "mention",
        candidates: memberCandidates([MEMBERS[3]], "", undefined, VIEWER),
        highlight: 0,
        onChoose: () => undefined,
        testId: "l",
        optionTestId: "o",
      })
    );
    expect(document.querySelector("[data-testid='l']")?.className).toContain("w-pane-sm");
  });
});

describe("ThreadComposer one-liner", () => {
  function session(): SessionContextValue {
    return {
      session: {
        accessToken: "a",
        refreshToken: "r",
        member: { id: VIEWER, workspaceId: "w", kind: "human", displayName: "하늘", handle: "hanul" },
      },
      workspaceId: "w",
      realtime: null,
      connStatus: "connected",
      logout: () => undefined,
      replaceSessionMember: () => undefined,
    } as unknown as SessionContextValue;
  }

  function type(root: HTMLElement, value: string) {
    const area = root.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setter?.call(area, value);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function open() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return mount(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          SessionProvider,
          { value: session() },
          createElement(ThreadComposer, {
            workspaceId: "w",
            channelId: "c",
            rootId: "r",
            directory: makeDirectory(MEMBERS),
            channels: [],
            onSent: vi.fn(),
          })
        )
      )
    );
  }

  it("warns above the input when the draft calls an agent only someone else may call", () => {
    const root = open();
    expect(root.querySelector("[data-testid='thread-composer-agent-notice']")).toBeNull();
    type(root, "@intern 부탁해요");
    expect(root.querySelector("[data-testid='thread-composer-agent-notice']")).toBeNull();
    type(root, "@sj 배포 요약 부탁해요");
    expect(root.querySelector("[data-testid='thread-composer-agent-notice']")?.textContent).toBe(
      "성재의 Claude Code는 성재 님만 부를 수 있어요. 보내도 답하지 않아요."
    );
    type(root, "배포 요약 부탁해요");
    expect(root.querySelector("[data-testid='thread-composer-agent-notice']")).toBeNull();
  });
});
