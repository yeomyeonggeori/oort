// @vitest-environment jsdom
import { createElement, forwardRef, type ReactElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { Timeline } from "./Timeline";
import { ThreadPanel } from "./ThreadPanel";

// #4986. 서버는 `tool_call` 행을 한 번 쓰고 고치지 않고, 끝은 같은 call_id 의 `tool_result` 행으로 따로 온다.
// 호출 카드가 「생각 중」으로 계속 돌던 결함의 수리는 코어 한 함수(`presentableRows`)이고, 이 시험은 그것을 부르는
// 두 자리(본류 `Timeline`, 요청 스레드 `ThreadPanel`)가 행에 닫힌 상태를 실제로 건네는지를 잰다.
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@momo/core/lib/api", async (original) => ({ ...await original<typeof import("@momo/core/lib/api")>(), fetchThreadReplies: api.fetch }));
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(props: { data: { kind: string; key: string }[]; itemContent: (index: number, item: { kind: string; key: string }) => ReactElement }, _ref) {
    return createElement("div", { "data-testid": "timeline-virtuoso" }, props.data.map((item, index) => createElement("div", { key: item.key }, props.itemContent(index, item))));
  }),
}));
vi.mock("./MessageRow", async (importOriginal) => ({
  ...await importOriginal<typeof import("./MessageRow")>(),
  DayDivider: () => null,
  RecoveryDivider: () => null,
  UnreadDivider: () => null,
  MessageRow: ({ message }: { message: Message }) => <div data-testid="timeline-message" data-message-id={message.id} data-type={message.type}>{String(message.props?.status ?? "")}</div>,
}));
vi.mock("./ThreadComposer", () => ({ ThreadComposer: () => null }));

const CHANNEL = "channel";
function row(type: "tool_call" | "tool_result", id: string, seq: number, props: Record<string, unknown>, extra: Partial<Message> = {}): Message {
  return { id, channelId: CHANNEL, seq, hlcTs: seq, hlcCount: 0, authorMemberId: "agent", type, body: id, state: "sent", createdAtMs: seq, props, ...extra } as Message;
}
const started = (extra: Partial<Message> = {}) => row("tool_call", "call", 1, { name: "work.session.end", arguments: {}, call_id: "c1" }, extra);
const finished = (extra: Partial<Message> = {}) => row("tool_result", "result", 2, { call_id: "c1", output: "ok", is_error: false }, extra);
const statusOf = (id: string) => document.querySelector(`[data-message-id="${id}"]`)?.textContent;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.fetch.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mountTimeline(messages: Message[]) {
  return render(<Timeline messages={messages} directory={makeDirectory([])} status="ready" channelKind="public" channelName="엔진" canAddMember />);
}
function mountThread(replies: Message[]) {
  api.fetch.mockResolvedValue({ messages: replies });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = { id: "request", channelId: CHANNEL, seq: 0, authorMemberId: "human", type: "text", body: "요청", state: "sent", createdAtMs: 0, hlcTs: 0, hlcCount: 0 } as Message;
  return render(<QueryClientProvider client={client}><ThreadPanel workspaceId="workspace" channelId={CHANNEL} root={root} directory={makeDirectory([])} channels={[]} realtime={null} requestLanding={null} onClose={() => undefined} /></QueryClientProvider>);
}

describe("끝난 도구 호출은 본류와 스레드에서 닫힌 상태로 그려진다 (#4986)", () => {
  it("본류: 결과가 목록에 있는 호출 행은 완료를 건네받고, 결과가 없는 호출 행은 그대로다", () => {
    mountTimeline([started(), finished()]);
    expect(statusOf("call")).toBe("done");
    cleanup();
    mountTimeline([started()]);
    expect(statusOf("call")).toBe("");
  });

  it("본류: 호출 뒤에 결과가 실시간으로 도착하면 같은 행이 닫힌다", () => {
    const view = mountTimeline([started()]);
    expect(statusOf("call")).toBe("");
    act(() => { view.rerender(<Timeline messages={[started(), finished()]} directory={makeDirectory([])} status="ready" channelKind="public" channelName="엔진" canAddMember />); });
    expect(statusOf("call")).toBe("done");
  });

  it("스레드: 같은 짝짓기가 요청 스레드 안에서도 선다", async () => {
    mountThread([started({ rootId: "request" }), finished({ rootId: "request" })]);
    await waitFor(() => expect(screen.queryByTestId("thread-loading")).toBeNull());
    await waitFor(() => expect(statusOf("call")).toBe("done"));
    expect(document.querySelector('[data-message-id="result"]')).toBeTruthy();
  });

  it("스레드: 결과가 아직 없으면 「생각 중」이 맞는 말이라 손대지 않는다", async () => {
    mountThread([started({ rootId: "request" })]);
    await waitFor(() => expect(document.querySelector('[data-message-id="call"]')).toBeTruthy());
    expect(statusOf("call")).toBe("");
  });
});
