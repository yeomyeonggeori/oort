// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type AgentRunProgress, type Message, type ThreadReadState } from "@momo/core/lib/api";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { RealtimeHandle } from "@/lib/realtime";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ThreadPanel } from "./ThreadPanel";
import { THREAD_REPLIES_LEAD_CLASS } from "./spacing";

// =============================================================================
// 스레드 패널이 「여기까지 읽었어요」를 보내는 때와 그 응답의 길 (#4878, #4889 2단계), 그리고 머리·생각 줄 자리.
// 서버는 가짜 응답이다. 규칙(앞으로만·404 중단·옛 응답)의 단위 시험은 코어 `threadRead.test.ts`에 있고,
// 여기서는 패널이 **언제 부르고 응답을 어디로 넘기는가**를 잰다.
// =============================================================================

const WS = "workspace";
const CH = "channel";
const ME = "human-me";
const OTHER = "human-other";
const api = vi.hoisted(() => ({ fetch: vi.fn(), read: vi.fn() }));
const runs = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("@momo/core/lib/api", async (original) => ({
  ...(await original<typeof import("@momo/core/lib/api")>()),
  fetchThreadReplies: api.fetch,
  markThreadRead: api.read,
}));
vi.mock("@/features/agents/agentRunProgressStore", () => ({ useChannelRuns: () => runs.current }));
vi.mock("./MessageRow", () => ({
  MessageRow: ({ message, showThought }: { message: Message; showThought?: boolean }) => (
    <div data-testid="timeline-message" data-message-id={message.id} data-show-thought={String(showThought)}>
      {message.body}
    </div>
  ),
}));
vi.mock("./ThreadComposer", () => ({ ThreadComposer: () => null }));

const root = { id: "root", channelId: CH, seq: 1, authorMemberId: ME, type: "text", body: "소개를 바꿔 줘요", state: "sent", createdAtMs: 1, hlcTs: 1, hlcCount: 0 } as Message;
const reply = (seq: number): Message => ({ ...root, id: `r${seq}`, rootId: "root", seq, authorMemberId: OTHER, body: `답글 ${seq}` });
const read = (unreadReplyCount: number): ThreadReadState => ({ following: true, lastReadReplySeq: 12, unreadReplyCount });

let handlers: Parameters<RealtimeHandle["subscribeChannel"]>[2];
const realtime = {
  subscribeChannel: (_ws: string, _ch: string, value: typeof handlers) => {
    handlers = value;
    return () => undefined;
  },
} as unknown as RealtimeHandle;
const frame = () => ({ type: "message.new", v: 1, ts: 1, seq: 13, payload: { id: "r13", root_id: "root", channel_id: CH } }) as MessageNewEvent;

const actions = {
  myMemberId: ME,
  onToggleReaction: vi.fn(),
  onTogglePin: vi.fn(),
  onEditMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
};
let focused = true;

function mount(options: { withActions?: boolean; onThreadRead?: (rootId: string, state: ThreadReadState) => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadPanel
        workspaceId={WS}
        channelId={CH}
        root={root}
        directory={makeDirectory([])}
        channels={[]}
        realtime={realtime}
        actions={options.withActions === false ? undefined : actions}
        onThreadRead={options.onThreadRead}
        onClose={() => undefined}
      />
    </QueryClientProvider>
  );
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  focused = true;
  runs.current = [];
  api.fetch.mockReset();
  api.read.mockReset();
  api.read.mockResolvedValue(read(0));
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("읽음 신호를 보내는 때", () => {
  it("열면 화면에 든 답글의 최대 seq를 한 번 보내고, 응답을 호스트로 넘긴다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(11), reply(12)] });
    const onThreadRead = vi.fn();
    mount({ onThreadRead });
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
    expect(api.read).toHaveBeenCalledWith(WS, CH, "root", 12);
    await waitFor(() => expect(onThreadRead).toHaveBeenCalledWith("root", read(0)));
  });

  it("새 답글이 그려지면 더 높은 seq를 다시 보내고, 같은 값이면 보내지 않는다", async () => {
    let messages = [reply(11), reply(12)];
    api.fetch.mockImplementation(async () => ({ messages }));
    mount();
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
    act(() => handlers.onMessage(frame()));
    await settle();
    expect(api.read).toHaveBeenCalledTimes(1); // 되쏘기: 같은 목록이라 새 신호가 없다
    messages = [reply(11), reply(12), reply(13)];
    act(() => handlers.onMessage(frame()));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    expect(api.read).toHaveBeenLastCalledWith(WS, CH, "root", 13);
  });

  it("창이 뒤에 있는 동안은 보내지 않고, 앞으로 오면 그때 보낸다", async () => {
    focused = false;
    api.fetch.mockResolvedValue({ messages: [reply(11), reply(12)] });
    mount();
    await waitFor(() => expect(screen.getAllByTestId("timeline-message").length).toBeGreaterThan(1));
    await settle();
    expect(api.read).not.toHaveBeenCalled();
    focused = true;
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
    expect(api.read).toHaveBeenCalledWith(WS, CH, "root", 12);
  });

  it("답글이 없으면 보낼 것이 없다", async () => {
    api.fetch.mockResolvedValue({ messages: [] });
    mount();
    await waitFor(() => expect(screen.getByTestId("thread-empty")).toBeTruthy());
    await settle();
    expect(api.read).not.toHaveBeenCalled();
  });

  it("대화 표면이 아니면(작업 세션 패널: actions 없음) 읽은 것이 아니다 — 보내지 않는다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(11), reply(12)] });
    mount({ withActions: false });
    await waitFor(() => expect(screen.getAllByTestId("timeline-message").length).toBeGreaterThan(1));
    await settle();
    expect(api.read).not.toHaveBeenCalled();
  });

  it("옛 서버(404)면 그 뒤 새 답글에도 더 보내지 않는다", async () => {
    let messages = [reply(11)];
    api.fetch.mockImplementation(async () => ({ messages }));
    api.read.mockRejectedValue(new ApiError(404, "no route"));
    mount();
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
    await settle();
    messages = [reply(11), reply(12)];
    act(() => handlers.onMessage(frame()));
    await settle();
    expect(api.read).toHaveBeenCalledTimes(1);
  });
});

describe("머리와 간격", () => {
  it("닫기는 채널 머리의 아이콘 단추와 같은 문법이다(34px 둥근 사각, 아주 연한 선)", async () => {
    api.fetch.mockResolvedValue({ messages: [] });
    mount();
    const close = screen.getByTestId("thread-close");
    expect(close.getAttribute("aria-label")).toBe("스레드 닫기");
    expect(close.className).toContain("size-icon-button");
    expect(close.className).toContain("rounded-md");
    expect(close.className).toContain("border-line");
    expect(close.className).not.toContain("size-6");
    await waitFor(() => expect(screen.getByTestId("thread-empty")).toBeTruthy());
  });

  it("루트 아래 띠는 이름 붙은 상수 하나다", async () => {
    api.fetch.mockResolvedValue({ messages: [] });
    mount();
    expect(screen.getByTestId("thread-replies").className).toBe(THREAD_REPLIES_LEAD_CLASS);
    await waitFor(() => expect(screen.getByTestId("thread-empty")).toBeTruthy());
  });

  it("생각 줄의 24px 자리는 run이 있는 스레드에서만 선다 — run 없는 평범한 스레드의 내 루트 아래에 빈 줄이 없다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(11)] });
    mount();
    await waitFor(() => expect(screen.getAllByTestId("timeline-message")).toHaveLength(2));
    for (const row of screen.getAllByTestId("timeline-message")) expect(row.getAttribute("data-show-thought")).toBe("false");
    cleanup();

    runs.current = [
      {
        id: "run-1", channelId: CH, agentMemberId: "agent", triggerMessageId: "root", phase: "running", status: "running",
        leaseState: "live", ahead: [], stepCount: 0, createdAtMs: 1, updatedAtMs: 1,
      } satisfies AgentRunProgress,
    ];
    mount();
    await waitFor(() => expect(screen.getAllByTestId("timeline-message")).toHaveLength(2));
    for (const row of screen.getAllByTestId("timeline-message")) expect(row.getAttribute("data-show-thought")).toBe("true");
  });
});
