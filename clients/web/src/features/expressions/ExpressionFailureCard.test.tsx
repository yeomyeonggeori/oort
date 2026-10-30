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

// ADR-0218 section 7 G3.8. A failure card is the request loop's own card closed on a code
// (`props.code`); the screen reads the sentence from the core dictionary and the server writes
// the same sentence into `body`. These are typed out by hand so the table is the witness.
const G38 = [
  ["generation_failed", "그림을 만들지 못했어요"],
  ["assembly_source_invalid", "이 그림에는 움직임을 입힐 수 없어요"],
  ["assembly_source_too_large", "그림이 너무 커서 움직임을 입힐 수 없어요"],
  ["assembly_output_too_large", "움직이는 그림이 너무 커요"],
  ["assembly_timeout", "움직임을 입히다가 시간이 다 됐어요"],
  ["assembly_busy", "지금 다른 그림을 처리하고 있어요. 잠시 뒤에 다시 해 주세요"],
] as const;

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-0000000001ff";
const AGENT = "019f9a01-0000-7000-8000-000000000401";
const MEASURED = 1_234_567;

function failureMessage(code: string, status: string, extra: Record<string, unknown> = {}): Message {
  return {
    id: "0199aa11-2222-7000-8000-0000000000d1", channelId: "00000000-0000-7000-8000-000000000201", seq: 9, hlcTs: 1_753_400_000_000, hlcCount: 0,
    authorMemberId: AGENT, type: "approval_request", body: "움직이는 그림이 너무 커요", state: "sent", createdAtMs: 1_753_400_000_000,
    props: { approval_id: "0199aa11-2222-7000-8000-0000000000a1", run_id: "0199aa11-2222-7000-8000-0000000000b2", channel_id: "00000000-0000-7000-8000-000000000201", status, code, title: "팀 그림 만들기 요청", ...extra },
  } as unknown as Message;
}
const DIRECTORY = makeDirectory([{ id: AGENT, workspaceId: WORKSPACE_ID, kind: "agent", status: "active", role: "member", displayName: "달무리봇", handle: "dalmuri", channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 }] as never);
const SESSION = { session: { accessToken: "access", refreshToken: "refresh", member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "이도현", handle: "dohyun" }, realtimeWebSocketUrl: "wss://example.test/connection/websocket" }, workspaceId: WORKSPACE_ID, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined } as unknown as SessionContextValue;

function draw(message: Message) {
  const card = agentCardModel(message);
  if (card === null) throw new Error("no card for these props");
  return render(<SessionProvider value={SESSION}><AgentCard card={card} directory={DIRECTORY} viewerMemberId={ME} /></SessionProvider>);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); resetSettledApprovalsForTest();
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); });

describe("the request loop's failure card for a generated or assembled picture", () => {
  it.each(G38)("%s ends the card on the table's sentence, with nothing left to decide", (code, line) => {
    for (const status of ["cancelled", "rejected", "expired"]) {
      const view = draw(failureMessage(code, status));
      expect(within(view.container).getAllByText(line)).toHaveLength(1);
      expect(view.queryByTestId("approval-approve")).toBeNull();
      expect(view.queryByTestId("approval-reject")).toBeNull();
      cleanup();
    }
  });
  it("is the same card that still offers the decision while it waits, so the missing buttons mean something", () => {
    const view = draw(failureMessage("assembly_busy", "pending"));
    expect(view.getByTestId("approval-approve")).toBeTruthy();
    expect(view.getByTestId("approval-reject")).toBeTruthy();
    expect(within(view.container).queryByText("지금 다른 그림을 처리하고 있어요. 잠시 뒤에 다시 해 주세요")).toBeNull();
  });
  it("stands with the measured size on the card, and shows that size as a number nowhere", () => {
    const view = draw(failureMessage("assembly_output_too_large", "cancelled", { bytes: MEASURED }));
    expect(within(view.container).getAllByText("움직이는 그림이 너무 커요")).toHaveLength(1);
    // Everything the card does not read is admitted to in one honest count, not dropped.
    expect(view.getByTestId("agent-payload-withheld").textContent).toMatch(/숨김\s*1개/u);
    const text = view.container.textContent ?? "";
    expect(text).not.toContain(String(MEASURED));
    expect(text).not.toContain("1,234,567");
    expect(text).not.toMatch(/1\.2\s*MB|MiB|바이트/u);
  });
  it("does not invent a sentence for the call error that never becomes a card", () => {
    const view = draw(failureMessage("assembly_params_invalid", "cancelled"));
    expect(view.container.textContent ?? "").not.toMatch(/움직임을 입|그림을 만들지|너무 커/u);
    expect(view.getByTestId("agent-card")).toBeTruthy();
  });
  it("prefers the code's sentence over free text on a closed card, as it already does for every other code", () => {
    const view = draw(failureMessage("assembly_busy", "cancelled", { summary: "잠시 쉬었다가 다시 만들어 볼게요" }));
    // The dictionary decides, not the free text.
    expect(within(view.container).queryByText("잠시 쉬었다가 다시 만들어 볼게요")).toBeNull();
    expect(within(view.container).getAllByText("지금 다른 그림을 처리하고 있어요. 잠시 뒤에 다시 해 주세요")).toHaveLength(1);
  });
});
