// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import type { Message } from "@momo/core/lib/api";
import { fetchAttachmentContent } from "@momo/core/lib/api";
import { FIXTURE_CHANNEL_ID, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { EXPRESSION_SET_ACTION_ID } from "@momo/core/features/expressions/set";
import { FIXTURE_SET_APPROVAL_ID, FIXTURE_SET_NORMAL, FIXTURE_SET_PLAN_CARD, fixtureSetOverLimit } from "@momo/core/features/expressions/setFixtures";
import { EXPRESSION_SET_PLAN_ACTION_ID } from "@momo/core/features/expressions/setWire";
import { AgentCard } from "@/features/timeline/AgentCard";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";
import { LocaleContext } from "@/i18n/localeContext";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import { ExpressionStore } from "./ExpressionStore";
import { createExpressionFixtureTransport } from "./transport";
import { ExpressionsContext } from "./context";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchAttachmentContent: vi.fn(), authedResponse: vi.fn(), fetchRoster: vi.fn().mockResolvedValue([]) }));
vi.mock("./ExpressionImage", () => ({ ExpressionImage: () => <span data-testid="stub-image" /> }));

// ADR-0218 §12 L5 and L2.5: the two set cards stand in the conversation as ordinary action approvals (`approval_request`, `props.action`).
// This is the route: no new message type, no new screen, and the old card for a single picture is untouched.
const AGENT = "019f9a01-0000-7000-8000-000000000401";
const ME = FIXTURE_MEMBER_ID;
const SESSION = { session: { accessToken: "access", refreshToken: "refresh", member: { id: ME, workspaceId: FIXTURE_WORKSPACE_ID, kind: "human", displayName: "이도현", handle: "dohyun" }, realtimeWebSocketUrl: "wss://example.test/connection/websocket" } } as unknown as SessionContextValue;
const DIRECTORY = makeDirectory([{ id: AGENT, workspaceId: FIXTURE_WORKSPACE_ID, kind: "agent", status: "active", role: "member", displayName: "oort 도우미", handle: "oort", channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 }] as never);
const live = <T extends { expiresAtMs: number }>(value: T): T => ({ ...value, expiresAtMs: Date.now() + 3_600_000 });

function message(action: Record<string, unknown>, extra: Record<string, unknown> = {}): Message {
  return {
    id: "0199aa11-2222-7000-8000-0000000000d1", channelId: FIXTURE_CHANNEL_ID, seq: 9, hlcTs: 1_753_400_000_000, hlcCount: 0, authorMemberId: AGENT, type: "approval_request",
    body: "그림 세트", state: "sent", createdAtMs: 1_753_400_000_000,
    props: { approval_id: FIXTURE_SET_APPROVAL_ID, status: "pending", title: "그림 세트", action, ...extra },
  } as unknown as Message;
}
let korean: Awaited<ReturnType<typeof koreanLocaleForTest>>;
function draw(source: Message) {
  const card = agentCardModel(source);
  if (card === null) throw new Error("no card for these props");
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID));
  return render(<SessionProvider value={SESSION}><LocaleContext.Provider value={korean}><ExpressionsContext.Provider value={store}>
    <AgentCard card={card} expressionProps={source.props} directory={DIRECTORY} viewerMemberId={ME} />
  </ExpressionsContext.Provider></LocaleContext.Provider></SessionProvider>);
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); resetSettledApprovalsForTest(); vi.clearAllMocks();
  vi.mocked(fetchAttachmentContent).mockResolvedValue(new Blob([Uint8Array.from([137, 80, 78, 71])], { type: "image/png" }));
  korean = await koreanLocaleForTest();
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); });

describe("the two set cards stand in the conversation as action approvals", () => {
  it("draws a set approval as the set card, from props.action.expressionSet", () => {
    const view = draw(message({ id: EXPRESSION_SET_ACTION_ID, expressionSet: live(FIXTURE_SET_NORMAL) }));
    expect(view.getByTestId("expression-set")).toBeTruthy();
    expect(view.getAllByTestId("expression-set-tile")).toHaveLength(10);
    expect(view.queryByTestId("expression-approval")).toBeNull();
  });

  it("draws a plan approval as the plan card, from props.action.expressionSetPlan", () => {
    const view = draw(message({ id: EXPRESSION_SET_PLAN_ACTION_ID, expressionSetPlan: live(FIXTURE_SET_PLAN_CARD) }));
    expect(view.getByTestId("expression-plan")).toBeTruthy();
    expect(view.getAllByTestId("expression-plan-scene")).toHaveLength(10);
    expect(view.queryByTestId("expression-set")).toBeNull();
  });

  it("never draws the generic approve and reject buttons for either card: a set over the limits shows the unreadable line and the decline only", () => {
    const view = draw(message({ id: EXPRESSION_SET_ACTION_ID, expressionSet: live(fixtureSetOverLimit()) }));
    expect(view.getByTestId("expression-set-unreadable")).toBeTruthy();
    expect(view.queryByTestId("expression-set-grid")).toBeNull();
    expect(view.container.querySelectorAll("button")).toHaveLength(1);
  });

  it("does not read the payload of one card under the id of the other", () => {
    const wrongPlan = draw(message({ id: EXPRESSION_SET_PLAN_ACTION_ID, expressionSet: live(FIXTURE_SET_NORMAL) }));
    expect(wrongPlan.getByTestId("expression-plan-unreadable")).toBeTruthy();
    cleanup();
    const wrongSet = draw(message({ id: EXPRESSION_SET_ACTION_ID, expressionSetPlan: live(FIXTURE_SET_PLAN_CARD) }));
    expect(wrongSet.getByTestId("expression-set-unreadable")).toBeTruthy();
  });
});
