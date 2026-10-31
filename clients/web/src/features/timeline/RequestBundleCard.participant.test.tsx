// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import type { Message } from "@momo/core/lib/api";
import { AgentCard } from "@/features/timeline/AgentCard";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";

// #4920. The merged tree draws the DM admission consent card (ADR-0217, action dm.agent.admit) as the
// request bundle card. The server makes one card per person, pinned to that person alone, so the card
// names the one person it waits for. It used to put two sentences on the requester's card: the bundle
// card's stand-in "관리자의 승인을 기다려요" and the plain card's "이 카드에 표시된 참여자의 허락을 기다려요.",
// neither true. Everything below is the card face with the details closed.
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const REQUESTER = "00000000-0000-7000-8000-0000000000a1";
const TARGET = "00000000-0000-7000-8000-0000000000b2";
const PEER = "00000000-0000-7000-8000-0000000000c3";
const AGENT = "019f9a01-0000-7000-8000-000000000401";
// The lines are written by hand: the code that builds the sentence and a test that shares its template
// would be wrong together and stay green.
const TARGET_LINE = "박연구원 님의 허락을 기다려요";
const PEER_LINE = "이도현 님의 허락을 기다려요";
const UNNAMED_LINE = "다른 참여자의 허락을 기다려요";
const OFFLINE_LINE = "연결이 끊겨 지금은 결정할 수 없어요. 다시 연결되면 여기서 승인하거나 거부할 수 있어요.";

function member(id: string, kind: "human" | "agent", displayName: string) {
  return { id, workspaceId: WORKSPACE_ID, kind, status: "active", role: "member", displayName, handle: displayName, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
}
const ROSTER = [member(REQUESTER, "human", "김인턴"), member(TARGET, "human", "박연구원"), member(PEER, "human", "이도현"), member(AGENT, "agent", "코메토")];
const DIRECTORY = makeDirectory(ROSTER as never);
const WITHOUT_TARGET = makeDirectory(ROSTER.filter((entry) => entry.id !== TARGET) as never);

function sessionFor(viewer: string, connStatus: "connected" | "disconnected" = "connected") {
  return { session: { accessToken: "access", refreshToken: "refresh", member: { id: viewer, workspaceId: WORKSPACE_ID, kind: "human", displayName: "보는 사람", handle: "viewer" }, realtimeWebSocketUrl: "wss://example.test/connection/websocket" }, workspaceId: WORKSPACE_ID, realtime: null, connStatus, logout: () => undefined, replaceSessionMember: () => undefined } as unknown as SessionContextValue;
}

function consentCard(target: string, approvalId: string, extra: Record<string, unknown> = {}): Message {
  return {
    id: `0199aa11-2222-7000-8000-${approvalId.padStart(12, "0")}`, channelId: "00000000-0000-7000-8000-000000000201", seq: 9, hlcTs: 1_753_400_000_000, hlcCount: 0,
    // The card's author is the person who asked (the requester), as the server writes it.
    authorMemberId: REQUESTER, type: "approval_request", body: "코메토 들이기 허락을 기다려요", state: "sent", createdAtMs: 1_753_400_000_000,
    props: {
      approval_id: `0199aa11-2222-7000-8000-${approvalId.padStart(12, "0")}`, run_id: "0199aa11-2222-7000-8000-0000000000b2", channel_id: "00000000-0000-7000-8000-000000000201",
      action_type: "workspace_action", status: "pending", title: "에이전트를 이 대화에 들이기", expires_at_ms: Date.now() + 900_000, target_member_id: target,
      action: { id: "dm.agent.admit", required_role: "dm_participant", target_member_id: target, rows: [{ label: "에이전트", value: "코메토 (@kometto)" }] },
      ...extra,
    },
  } as unknown as Message;
}

function draw(viewer: string, options: { message?: Message; directory?: typeof DIRECTORY; connStatus?: "connected" | "disconnected" } = {}) {
  const card = agentCardModel(options.message ?? consentCard(TARGET, "a1"));
  if (card === null) throw new Error("no card for these props");
  return render(
    <SessionProvider value={sessionFor(viewer, options.connStatus)}>
      <AgentCard card={card} directory={options.directory ?? DIRECTORY} viewerMemberId={viewer} />
    </SessionProvider>
  );
}

const WAITING = /허락을 기다려요/gu;
const waitingLines = (host: HTMLElement) => host.textContent?.match(WAITING) ?? [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); resetSettledApprovalsForTest();
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); });

describe("the consent card names the one person it waits for (#4920)", () => {
  it.each([["the person who asked", REQUESTER], ["another person in a group conversation", PEER]] as const)("%s reads one sentence that names the decider, with no decision control", (_who, viewer) => {
    const view = draw(viewer);
    expect(within(view.container).getAllByText(TARGET_LINE)).toHaveLength(1);
    expect(waitingLines(view.container)).toHaveLength(1);
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("관리자");
    expect(text).not.toContain("표시된");
    expect(view.queryByTestId("approval-approve")).toBeNull();
    expect(view.queryByTestId("approval-reject")).toBeNull();
    // The keyboard shortcuts would arm a decision this person cannot make.
    expect(view.getByTestId("agent-card").getAttribute("aria-keyshortcuts")).toBeNull();
  });

  it("the named decider gets the controls and no waiting sentence at all", () => {
    const view = draw(TARGET);
    expect(view.getByTestId("approval-approve")).toBeTruthy();
    expect(view.getByTestId("approval-reject")).toBeTruthy();
    expect(waitingLines(view.container)).toHaveLength(0);
    expect(view.container.textContent ?? "").not.toContain("관리자");
    expect(view.getByTestId("agent-card").getAttribute("aria-keyshortcuts")).toBe("y n");
  });

  it("each card of a three-person conversation names its own person, once", () => {
    const forTarget = consentCard(TARGET, "a1");
    const forPeer = consentCard(PEER, "a2");
    const cards = [forTarget, forPeer].map((message) => agentCardModel(message)!);
    const view = render(
      <SessionProvider value={sessionFor(REQUESTER)}>
        {cards.map((card, index) => <AgentCard key={index} card={card} directory={DIRECTORY} viewerMemberId={REQUESTER} />)}
      </SessionProvider>
    );
    const [first, second] = view.getAllByTestId("agent-card");
    expect(within(first!).getAllByText(TARGET_LINE)).toHaveLength(1);
    expect(within(second!).getAllByText(PEER_LINE)).toHaveLength(1);
    expect(waitingLines(first!)).toHaveLength(1);
    expect(waitingLines(second!)).toHaveLength(1);
    expect(view.queryByTestId("approval-approve")).toBeNull();
  });

  it("a name the roster cannot give is said without a name, still once and still not the admin", () => {
    const view = draw(REQUESTER, { directory: WITHOUT_TARGET });
    expect(within(view.container).getAllByText(UNNAMED_LINE)).toHaveLength(1);
    expect(waitingLines(view.container)).toHaveLength(1);
    expect(view.container.textContent ?? "").not.toMatch(/관리자|표시된/u);
  });

  it("someone who can never decide is not told to come back online to decide", () => {
    for (const viewer of [REQUESTER, PEER]) {
      const view = draw(viewer, { connStatus: "disconnected" });
      expect(within(view.container).getAllByText(TARGET_LINE)).toHaveLength(1);
      expect(view.container.textContent ?? "").not.toContain("연결이 끊겨");
      expect(view.queryByTestId("approval-approve")).toBeNull();
      cleanup();
    }
    // The decider is the one for whom the connection matters, and the offline sentence stands in for the controls.
    const decider = draw(TARGET, { connStatus: "disconnected" });
    expect(within(decider.container).getAllByText(OFFLINE_LINE)).toHaveLength(1);
    expect(waitingLines(decider.container)).toHaveLength(0);
    expect(decider.queryByTestId("approval-approve")).toBeNull();
  });

  it("a card that has been decided says no waiting sentence", () => {
    for (const status of ["rejected", "expired", "cancelled"]) {
      const view = draw(REQUESTER, { message: consentCard(TARGET, "a1", { status }) });
      expect(waitingLines(view.container)).toHaveLength(0);
      expect(view.container.textContent ?? "").not.toContain("관리자");
      cleanup();
    }
  });
});

describe("every other approval card keeps its waiting sentence (#4920)", () => {
  it("a workspace action the viewer cannot decide still says the admin, once, and no participant line", () => {
    const message = consentCard(TARGET, "b1", {
      can_decide: false, decision_mode: "inline", title: "자기 소개 바꾸기",
      action: { id: "agent.profile.update", required_role: "agent_editor", target_member_id: TARGET, rows: [{ label: "소개", value: "새 소개" }] },
    });
    const view = draw(PEER, { message });
    expect(within(view.container).getAllByText("관리자의 승인을 기다려요")).toHaveLength(1);
    expect(waitingLines(view.container)).toHaveLength(0);
    expect(view.queryByTestId("approval-approve")).toBeNull();
  });
});
