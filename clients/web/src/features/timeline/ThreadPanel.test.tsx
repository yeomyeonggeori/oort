// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { RealtimeHandle } from "@/lib/realtime";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ThreadPanel } from "./ThreadPanel";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@momo/core/lib/api", async original => ({ ...await original<typeof import("@momo/core/lib/api")>(), fetchThreadReplies: api.fetch }));
vi.mock("./MessageRow", () => ({ MessageRow: ({ message }: { message: Message }) => <div data-testid="timeline-message" data-message-id={message.id}>{message.body} {String(message.props?.status ?? "")}</div> }));
vi.mock("./ThreadComposer", () => ({ ThreadComposer: () => null }));
const root = { id: "request", channelId: "channel", seq: 1, authorMemberId: "human", type: "text", body: "소개를 바꿔 줘요", state: "sent", createdAtMs: 1, hlcTs: 1, hlcCount: 0 } as Message;
const card = { ...root, id: "card", rootId: "request", seq: 2, type: "approval_request", body: "승인 카드", props: { approval_id: "approval", status: "pending", action_type: "workspace_action" } } as Message;
const line = { ...root, id: "result", rootId: "request", seq: 3, body: "옛 결과 줄", props: { bundle_of: "approval" } } as Message;
let handlers: Parameters<RealtimeHandle["subscribeChannel"]>[2];
const realtime = { subscribeChannel: (_ws: string, _ch: string, value: typeof handlers) => { handlers = value; return () => undefined; } } as unknown as RealtimeHandle;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
function mount(landing = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><ThreadPanel workspaceId="workspace" channelId="channel" root={root} directory={makeDirectory([])} channels={[]} realtime={realtime} requestLanding={landing ? { channelId: "channel", rootId: "request", messageId: "card", token: 1 } : null} onClose={() => undefined} /></QueryClientProvider>);
}
const event = (type = "message.new") => ({ type, v: 1, ts: 1, seq: 2, payload: { id: "card", root_id: "request", channel_id: "channel" } }) as MessageNewEvent;
beforeEach(() => { api.fetch.mockReset(); });
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll); else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("요청 스레드의 카드와 착지", () => {
  it("읽기 중 도착한 카드 프레임은 옛 응답 뒤 다시 읽어서 반영한다", async () => {
    let finish: (value: { messages: Message[] }) => void = () => undefined;
    api.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ messages: [card] });
    mount();
    await waitFor(() => expect(api.fetch).toHaveBeenCalledOnce());
    act(() => handlers.onMessage(event()));
    await act(async () => finish({ messages: [] }));
    await waitFor(() => expect(screen.getByText("승인 카드 pending")).toBeTruthy());
    expect(api.fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it("빈 스레드를 연 뒤 도착한 카드·다른 기기의 종결 패치·재접속을 읽는다", async () => {
    let messages: Message[] = [];
    api.fetch.mockImplementation(async () => ({ messages }));
    mount();
    await waitFor(() => expect(screen.getByTestId("thread-empty")).toBeTruthy());
    messages = [card];
    act(() => handlers.onMessage(event()));
    await waitFor(() => expect(screen.getByText("승인 카드 pending")).toBeTruthy());
    messages = [{ ...card, props: { ...card.props, status: "approved" } }];
    act(() => handlers.onMessage(event("message.edited")));
    await waitFor(() => expect(screen.getByText("승인 카드 approved")).toBeTruthy());
    messages = [{ ...card, props: { ...card.props, status: "rejected" } }];
    act(() => handlers.onSubscribed({} as never));
    await waitFor(() => expect(screen.getByText("승인 카드 rejected")).toBeTruthy());
  });
  it("다음 페이지의 화면 밖 카드를 먼저 스크롤하고 같은 행에 도착 강조를 붙인다", async () => {
    api.fetch.mockImplementation(async (_ws, _ch, _root, cursor) => cursor === undefined ? { messages: [{ ...root, id: "first-reply", rootId: root.id }], nextCursor: 10 } : { messages: [card] });
    const scroll = vi.fn(function(this: HTMLElement) { this.dataset.scrolled = "true"; });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scroll, configurable: true, writable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) { const top = this.dataset.scrolled ? 100 : 2000; return { top, bottom: top + 24, height: 24, x: 0, y: top, width: 100, left: 0, right: 100, toJSON() {} }; });
    mount(true);
    await waitFor(() => expect(document.querySelector('[data-message-id="card"]')?.classList.contains("landed-surface")).toBe(true));
    expect(api.fetch).toHaveBeenCalledWith("workspace", "channel", "request", 10, 200);
    expect(scroll).toHaveBeenCalled();
  });
  it.each([true, false])("같은 목록에 종결 카드가 있는 경우(%s)에만 옛 결과 줄을 접는다", async (withCard) => {
    api.fetch.mockResolvedValue({ messages: withCard ? [{ ...card, props: { ...card.props, status: "rejected" } }, line] : [line] });
    mount();
    await waitFor(() => expect(screen.queryByTestId("thread-loading")).toBeNull());
    await waitFor(() => expect(document.querySelector('[data-message-id="result"]') === null).toBe(withCard));
    if (withCard) expect(document.querySelector('[data-message-id="card"]')).toBeTruthy();
  });
  it("카드를 찾지 못하거나 커서가 반복되면 유한하게 멈추고 다시 읽는 문을 남긴다", async () => {
    api.fetch.mockResolvedValue({ messages: [], nextCursor: 10 });
    mount(true);
    await waitFor(() => expect(screen.getByTestId("thread-landing-missing")).toBeTruthy());
    expect(api.fetch.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
