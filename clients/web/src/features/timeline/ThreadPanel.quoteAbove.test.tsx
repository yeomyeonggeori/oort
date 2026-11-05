// @vitest-environment jsdom
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ThreadPanel } from "./ThreadPanel";

// =============================================================================
// 스레드 목록의 「바로 위」 (#5357). 에이전트 답의 인용이 바로 위 메시지를 가리키면 행이 인용을 그리지 않는데, 그 판정(코어 `isQuoteRedundant`)은
// 행이 하고 **무엇이 바로 위인지**는 목록이 알려 준다. 스레드는 루트 다음에 답글이 줄줄이 이어지므로 첫 답글의 위는 루트, 그다음부터는 앞 답글이다.
// 행을 가짜로 두고 목록이 행에 건넨 값만 읽는다 - 판정 표는 코어 `quote.test.ts`, 진짜 행이 그리는 모양은 `Timeline.agentQuote.test.tsx`가 든다.
// =============================================================================

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@momo/core/lib/api", async (original) => ({
  ...(await original<typeof import("@momo/core/lib/api")>()),
  fetchThreadReplies: api.fetch,
}));
vi.mock("./MessageRow", () => ({
  MessageRow: ({ message, aboveMessageId }: { message: Message; aboveMessageId?: string }) => (
    <div data-testid="timeline-message" data-message-id={message.id} data-above={aboveMessageId ?? ""} />
  ),
}));
vi.mock("./ThreadComposer", () => ({ ThreadComposer: () => null }));

const root = {
  id: "root",
  channelId: "channel",
  seq: 1,
  authorMemberId: "human",
  type: "text",
  body: "스레드 시작",
  state: "sent",
  createdAtMs: 1,
  hlcTs: 1,
  hlcCount: 0,
} as Message;
const first = { ...root, id: "first", rootId: "root", seq: 2, body: "첫 답글" } as Message;
const second = { ...root, id: "second", rootId: "root", seq: 3, authorMemberId: "agent", body: "에이전트의 답" } as Message;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadPanel
        workspaceId="workspace"
        channelId="channel"
        root={root}
        directory={makeDirectory([])}
        channels={[]}
        onClose={() => undefined}
      />
    </QueryClientProvider>
  );
}
const aboveOf = (id: string) => document.querySelector(`[data-message-id="${id}"]`)?.getAttribute("data-above");

beforeEach(() => {
  api.fetch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("스레드 목록이 행에 알리는 바로 위 메시지", () => {
  it("루트에는 없고, 첫 답글의 위는 루트이며, 그다음 답글의 위는 앞 답글이다", async () => {
    api.fetch.mockResolvedValue({ messages: [first, second] });
    mount();
    await waitFor(() => expect(screen.queryByTestId("thread-loading")).toBeNull());
    await waitFor(() => expect(document.querySelector('[data-message-id="second"]')).not.toBeNull());
    expect(aboveOf("root")).toBe("");
    expect(aboveOf("first")).toBe("root");
    expect(aboveOf("second")).toBe("first");
  });
});
