// @vitest-environment jsdom

import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  type ReactElement,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import {
  EMPTY_ADD_MEMBER_ACTION_LABEL,
  EMPTY_WRITE_ACTION_LABEL,
} from "@momo/core/features/timeline/model";
import { CHANNEL_INTRO_STARTED, DM_INTRO_STARTED } from "./channelIntro";
import { Timeline } from "./Timeline";

const virtuoso = vi.hoisted(() => ({
  data: [] as { kind: string; key: string }[],
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (index: number, item: { kind: string; key: string }) => ReactElement;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    virtuoso.data = props.data;
    useImperativeHandle(ref, () => ({
      scrollToIndex: () => undefined,
    }));
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) =>
        createElement("div", { key: item.key }, props.itemContent(index, item))
      )
    );
  }),
}));

vi.mock("./MessageRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MessageRow")>();
  return {
    ...actual,
    DayDivider: () => createElement("div", { "data-testid": "day-divider" }),
    RecoveryDivider: () => createElement("div", { "data-testid": "recovery-divider" }),
    UnreadDivider: () => createElement("div", { "data-testid": "unread-divider" }),
    MessageRow: ({ message }: { message: { seq: number } }) =>
      createElement("div", {
        "data-testid": "timeline-message",
        "data-seq": message.seq,
      }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

const CHANNEL = "0199cccc-0000-7000-8000-000000000201";
const OTHER = "00000000-0000-7000-8000-000000000101";
const DIRECTORY = makeDirectory([]);

function message(seq: number): Message {
  return {
    id: `0199cccc-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CHANNEL,
    seq,
    authorMemberId: OTHER,
    body: `메시지 ${seq}`,
    type: "text",
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1_000,
    hlcTs: 1_700_000_000_000 + seq * 1_000,
    hlcCount: 0,
  };
}

function peer(over: Partial<RosterMember> = {}): RosterMember {
  return {
    id: "00000000-0000-7000-8000-0000000001aa",
    workspaceId: "ws",
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  };
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  virtuoso.data = [];
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
});

function mount(
  over: {
    messages?: Message[];
    channelKind?: "public" | "private" | "dm";
    channelName?: string;
    channelTopic?: string;
    canAddMember?: boolean;
    reachedStart?: boolean;
    peer?: RosterMember | null;
    onStartWriting?: () => void;
    onAddMember?: () => void;
    welcomePhase?: "hidden" | "stage" | "exiting" | "backstop";
  } = {}
): HTMLElement {
  if (host === null) {
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
  }
  act(() => {
    mountedRoot?.render(
      createElement(Timeline, {
        messages: over.messages ?? [],
        directory: DIRECTORY,
        status: "ready",
        channelKind: over.channelKind ?? "public",
        channelName: over.channelName ?? "엔진",
        channelTopic: over.channelTopic,
        canAddMember: over.canAddMember ?? true,
        reachedStart: over.reachedStart,
        peer: over.peer,
        onStartWriting: over.onStartWriting,
        onAddMember: over.onAddMember,
        welcomePhase: over.welcomePhase,
      })
    );
  });
  return host;
}

describe("Timeline channel intro leading row", () => {
  it("renders the intro as the virtuoso's first row on an empty channel", () => {
    const root = mount();
    expect(root.querySelector("[data-testid='timeline-virtuoso']")).not.toBeNull();
    expect(virtuoso.data[0]?.kind).toBe("intro");
    const intro = root.querySelector("[data-testid='timeline-empty']");
    expect(intro).not.toBeNull();
    expect(intro?.getAttribute("data-channel-intro")).toBe("");
    expect(intro?.getAttribute("data-empty-kind")).toBe("channel");
    const heading = intro?.querySelector("h2");
    expect(heading?.textContent).toBe("엔진");
    expect(heading?.getAttribute("title")).toBe("엔진");
    expect(heading?.id).toBe("");
    const write = root.querySelector(
      "[data-testid='timeline-empty-primary']"
    ) as HTMLButtonElement | null;
    const add = root.querySelector(
      "[data-testid='timeline-empty-secondary']"
    ) as HTMLButtonElement | null;
    expect(write?.tagName).toBe("BUTTON");
    expect(write?.textContent).toContain(EMPTY_WRITE_ACTION_LABEL);
    expect(write?.dataset.actionKind).toBe("write");
    expect(write?.getAttribute("aria-label")).toBeNull();
    expect(add?.textContent).toContain(EMPTY_ADD_MEMBER_ACTION_LABEL);
    expect(add?.dataset.actionKind).toBe("add-member");
  });

  it("keeps the intro node and scrollTop when a message arrives, without empty-state copy", () => {
    const root = mount();
    const scroller = root.querySelector(
      "[data-testid='timeline-virtuoso']"
    ) as HTMLElement | null;
    const intro = root.querySelector("[data-channel-intro]");
    expect(scroller).not.toBeNull();
    expect(intro).not.toBeNull();
    const scrollTop = scroller?.scrollTop;

    mount({ messages: [message(1)], reachedStart: true, canAddMember: true });

    expect(root.querySelector("[data-testid='timeline-virtuoso']")).toBe(scroller);
    expect(virtuoso.data[0]?.kind).toBe("intro");
    expect(virtuoso.data.some((item) => item.kind === "message")).toBe(true);
    const still = root.querySelector("[data-channel-intro]");
    expect(still).toBe(intro);
    expect(scroller?.scrollTop).toBe(scrollTop);
    expect(root.querySelector("[data-testid='timeline-message']")).not.toBeNull();
    expect(root.querySelector("[data-testid='timeline-empty']")).toBeNull();
    expect(root.querySelector("[data-testid='message-channel-intro']")).toBe(intro);
    expect(root.querySelector("[data-testid='timeline-empty-primary']")).toBeNull();
    expect(root.querySelector("[data-testid='timeline-empty-secondary']")).toBeNull();
    expect(still?.textContent).toContain(CHANNEL_INTRO_STARTED);
    expect(still?.textContent).not.toContain("첫 메시지");
  });

  it("hides the add-member card for a role that cannot add", () => {
    const root = mount({ canAddMember: false });
    expect(root.querySelector("[data-testid='timeline-empty-primary']")).not.toBeNull();
    expect(root.querySelector("[data-testid='timeline-empty-secondary']")).toBeNull();
  });

  it("swaps icon, name, and copy on a DM and never offers add-member", () => {
    const root = mount({
      channelKind: "dm",
      channelName: "곽성재 @seongjae",
      peer: peer(),
      canAddMember: true,
    });
    const intro = root.querySelector("[data-testid='timeline-empty']");
    expect(intro?.getAttribute("data-empty-kind")).toBe("dm");
    expect(intro?.querySelector("h2")?.textContent).toBe("곽성재 @seongjae");
    expect(intro?.textContent).toContain("곽성재님과의 대화를 시작하세요.");
    expect(intro?.textContent).toContain(
      "여기 쓴 메시지는 둘만 봅니다. 참여자는 이 둘로 고정됩니다."
    );
    expect(intro?.querySelector("[data-testid='message-channel-intro-icon']")).not.toBeNull();
    expect(root.querySelector("[data-testid='timeline-empty-secondary']")).toBeNull();
  });

  it("paints an agent DM title with --agent and keeps the contract without write copy when history exists", () => {
    const root = mount({
      channelKind: "dm",
      channelName: "hermes",
      peer: peer({ kind: "agent", displayName: "hermes", handle: "hermes" }),
      messages: [message(1)],
      reachedStart: true,
      canAddMember: true,
    });
    const intro = root.querySelector("[data-testid='message-channel-intro']");
    const heading = intro?.querySelector("h2");
    expect(heading?.textContent).toBe("hermes");
    expect(heading?.className).toContain("text-agent");
    expect(intro?.textContent).toContain(DM_INTRO_STARTED);
    expect(intro?.textContent).toContain("여기 쓴 메시지는 둘만 봅니다");
    expect(intro?.textContent).not.toContain("첫");
    expect(root.querySelector("[data-testid='timeline-empty-primary']")).toBeNull();
  });

  it("focuses the composer when 첫 메시지 쓰기 is pressed", () => {
    const composer = document.createElement("textarea");
    composer.id = "composer-input";
    composer.setAttribute("data-testid", "composer-input");
    document.body.append(composer);
    const root = mount({
      onStartWriting: () => composer.focus(),
    });
    const write = root.querySelector(
      "[data-testid='timeline-empty-primary']"
    ) as HTMLButtonElement;
    act(() => {
      write.click();
    });
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it("hides 첫 메시지 쓰기 while the welcome stage is mounted", () => {
    const root = mount({ welcomePhase: "stage" });
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).not.toBeNull();
    expect(root.querySelector("[data-testid='timeline-empty-primary']")).toBeNull();
    expect(root.textContent).not.toContain(EMPTY_WRITE_ACTION_LABEL);
    expect(root.querySelector("[data-testid='timeline-empty-secondary']")).not.toBeNull();
  });

  it("keeps 첫 메시지 쓰기 when welcome is hidden", () => {
    const root = mount({ welcomePhase: "hidden" });
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    expect(root.querySelector("[data-testid='timeline-empty-primary']")?.textContent).toContain(
      EMPTY_WRITE_ACTION_LABEL
    );
  });
});
