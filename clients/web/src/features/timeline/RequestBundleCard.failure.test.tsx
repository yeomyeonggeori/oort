// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, within } from "@testing-library/react";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import type { Message } from "@momo/core/lib/api";
import { AgentCard } from "@/features/timeline/AgentCard";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";

// #4914. The merged tree draws every approval card as the request bundle card. A card that closed on
// one of the six generation or assembly failure codes (ADR-0218 section 7 G3.8) says the code's golden
// sentence on its face instead of the generic state sentence. Nothing else about the bundle card moves:
// raw data (the honest count of what the card does not read) is for workspace admins, inside the opened
// details, and a card that still asks for a decision keeps asking.
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-0000000001ff";
const AGENT = "019f9a01-0000-7000-8000-000000000401";
const MEASURED = 1_234_567;
const LINE = "움직이는 그림이 너무 커요";

function member(id: string, kind: "human" | "agent", role: "owner" | "member", displayName: string) {
  return { id, workspaceId: WORKSPACE_ID, kind, status: "active", role, displayName, handle: displayName, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
}
const AS_MEMBER = makeDirectory([member(AGENT, "agent", "member", "달무리봇")] as never);
const AS_OWNER = makeDirectory([member(AGENT, "agent", "member", "달무리봇"), member(ME, "human", "owner", "이도현")] as never);
const SESSION = { session: { accessToken: "access", refreshToken: "refresh", member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "이도현", handle: "dohyun" }, realtimeWebSocketUrl: "wss://example.test/connection/websocket" }, workspaceId: WORKSPACE_ID, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined } as unknown as SessionContextValue;

function closedCard(extra: Record<string, unknown>): Message {
  return {
    id: "0199aa11-2222-7000-8000-0000000000d1", channelId: "00000000-0000-7000-8000-000000000201", seq: 9, hlcTs: 1_753_400_000_000, hlcCount: 0,
    authorMemberId: AGENT, type: "approval_request", body: LINE, state: "sent", createdAtMs: 1_753_400_000_000,
    props: { approval_id: "0199aa11-2222-7000-8000-0000000000a1", run_id: "0199aa11-2222-7000-8000-0000000000b2", channel_id: "00000000-0000-7000-8000-000000000201", status: "cancelled", title: "팀 그림 만들기 요청", ...extra },
  } as unknown as Message;
}

function draw(message: Message, directory: typeof AS_MEMBER) {
  const card = agentCardModel(message);
  if (card === null) throw new Error("no card for these props");
  return render(<SessionProvider value={SESSION}><AgentCard card={card} directory={directory} viewerMemberId={ME} /></SessionProvider>);
}

function openDetails(container: HTMLElement) {
  const details = container.querySelector<HTMLDetailsElement>('[data-testid="request-bundle-details"]')!;
  act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); resetSettledApprovalsForTest();
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); });

describe("the bundle card closed on a generation or assembly failure code (#4914)", () => {
  it.each([["a plain member", AS_MEMBER], ["a workspace owner", AS_OWNER]] as const)("%s reads the code's sentence once on the closed card, with no raw data and no measured size", (_who, directory) => {
    const view = draw(closedCard({ code: "assembly_output_too_large", bytes: MEASURED }), directory);
    expect(view.getByTestId("request-bundle-result").textContent).toBe(LINE);
    expect(within(view.container).getAllByText(LINE)).toHaveLength(1);
    expect(view.queryByTestId("agent-payload")).toBeNull();
    expect(view.container.textContent ?? "").not.toMatch(/1,?234,?567/u);
  });
  it("keeps the state word of the card and offers nothing to decide", () => {
    for (const [status, word] of [["cancelled", "취소"], ["rejected", "거부"], ["expired", "만료"]] as const) {
      const view = draw(closedCard({ code: "assembly_output_too_large", status }), AS_MEMBER);
      expect(view.getByTestId("request-bundle-state").textContent).toBe(word);
      expect(view.getByTestId("request-bundle-result").textContent).toBe(LINE);
      expect(view.queryByTestId("approval-approve")).toBeNull();
      cleanup();
    }
  });
  it("gives the raw data to an owner once, inside the opened details, and never to a plain member", () => {
    const owner = draw(closedCard({ code: "assembly_output_too_large", bytes: MEASURED }), AS_OWNER);
    openDetails(owner.container);
    expect(owner.getAllByTestId("agent-payload-withheld")).toHaveLength(1);
    expect(owner.getByTestId("agent-payload-withheld").textContent).toMatch(/숨김\s*1개/u);
    expect(owner.container.textContent ?? "").not.toMatch(/1,?234,?567/u);
    cleanup();
    const plain = draw(closedCard({ code: "assembly_output_too_large", bytes: MEASURED }), AS_MEMBER);
    openDetails(plain.container);
    expect(plain.queryByTestId("agent-payload")).toBeNull();
  });
});

describe("every other bundle card keeps the sentence it had (#4914)", () => {
  it("a card closed without a code says the state sentence", () => {
    const view = draw(closedCard({ bytes: MEASURED }), AS_MEMBER);
    expect(view.getByTestId("request-bundle-result").textContent).toBe("요청이 취소됐어요");
  });
  it("the call error that never becomes a card, and a code this build has never seen, stay on the state sentence", () => {
    for (const code of ["assembly_params_invalid", "a_future_code"]) {
      const view = draw(closedCard({ code, bytes: MEASURED }), AS_MEMBER);
      expect(view.getByTestId("request-bundle-result").textContent).toBe("요청이 취소됐어요");
      cleanup();
    }
  });
  it("a card with a failure code that still waits for a decision keeps asking and says no failure line", () => {
    const view = draw(closedCard({ code: "assembly_busy", status: "pending" }), AS_MEMBER);
    expect(view.getByTestId("approval-approve")).toBeTruthy();
    expect(view.queryByTestId("request-bundle-result")).toBeNull();
    expect(within(view.container).queryByText("지금 다른 그림을 처리하고 있어요. 잠시 뒤에 다시 해 주세요")).toBeNull();
  });
});
