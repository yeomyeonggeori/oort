// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { MessageRowActions } from "./MessageRow";
import { ThreadPanel } from "./ThreadPanel";

// =============================================================================
// 스레드 패널 안에서 내 답글을 고치면 패널이 새 글로 바뀐다 (#5191).
//
// 고치기 요청(`actions.onEditMessage`)은 **채널 타임라인**의 상태를 고친다. 스레드 답글은 거기 없고(본류가 `rootId` 있는 행을
// 거른다), 패널의 목록은 자기 질의(`fetchThreadReplies`)에서 온다. 그래서 저장한 사람 자기 패널은 응답을 받고도 옛 글을 그렸고,
// 다른 기기·다른 사람에게서 오는 `message.edited` 에코가 도착해야 바뀌었다 — 에코가 늦거나 끊기면(웹소켓이 떨어진 데스크탑)
// 「저장이 안 됐다」로 읽혔다. 패널이 저장 뒤에 목록을 다시 읽는다. 이 시험은 에코를 **일부러 보내지 않는다**.
// =============================================================================

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@momo/core/lib/api", async (original) => ({
  ...(await original<typeof import("@momo/core/lib/api")>()),
  fetchThreadReplies: api.fetch,
}));

// 행은 자기가 받은 `actions.onEditMessage` 를 단추 하나로 부를 수 있게만 한다: 시험이 재는 것은 패널이 그 함수를 **감싸는지**다.
let lastRowError: unknown = null;
vi.mock("./MessageRow", () => ({
  MessageRow: ({ message, actions }: { message: Message; actions?: MessageRowActions }) => (
    <div data-testid="timeline-message" data-message-id={message.id}>
      <span>{message.body}</span>
      {actions && (
        <button
          type="button"
          data-testid={`edit-${message.id}`}
          onClick={() => {
            lastRowError = null;
            void actions.onEditMessage(message, "고친 답글").catch((error: unknown) => {
              lastRowError = error;
            });
          }}
        >
          고치기
        </button>
      )}
    </div>
  ),
}));
vi.mock("./ThreadComposer", () => ({ ThreadComposer: () => null }));

const root = { id: "root", channelId: "channel", seq: 1, authorMemberId: "me", type: "text", body: "스레드 루트", state: "sent", createdAtMs: 1, hlcTs: 1, hlcCount: 0 } as Message;
const reply = { ...root, id: "reply", rootId: "root", seq: 2, body: "처음 답글" } as Message;

function mount(onEditMessage: MessageRowActions["onEditMessage"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const actions = {
    myMemberId: "me",
    onToggleReaction: async () => undefined,
    onTogglePin: async () => undefined,
    onEditMessage,
    onDeleteMessage: async () => undefined,
  } as Omit<MessageRowActions, "chips" | "pinned">;
  return render(
    <QueryClientProvider client={client}>
      <ThreadPanel workspaceId="workspace" channelId="channel" root={root} directory={makeDirectory([])} channels={[]} actions={actions} onClose={() => undefined} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  api.fetch.mockReset();
  lastRowError = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("스레드 패널의 고치기", () => {
  it("저장이 끝나면 에코를 기다리지 않고 답글 목록을 다시 읽어 새 글을 그린다", async () => {
    let stored = "처음 답글";
    api.fetch.mockImplementation(async () => ({ messages: [{ ...reply, body: stored }] }));
    const onEditMessage = vi.fn(async (_message: Message, body: string) => {
      stored = body; // 서버가 저장한다. 실시간 프레임은 오지 않는다.
    });
    mount(onEditMessage);
    await waitFor(() => expect(screen.getByText("처음 답글")).toBeTruthy());
    const before = api.fetch.mock.calls.length;

    fireEvent.click(screen.getByTestId("edit-reply"));
    await waitFor(() => expect(screen.getByText("고친 답글")).toBeTruthy());
    expect(onEditMessage).toHaveBeenCalledTimes(1);
    expect(onEditMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "reply" }), "고친 답글");
    expect(api.fetch.mock.calls.length).toBeGreaterThan(before);
  });

  it("저장이 실패하면 목록을 다시 읽지 않고 실패가 행까지 올라간다(행이 자기 자리에 문구를 띄운다)", async () => {
    api.fetch.mockResolvedValue({ messages: [reply] });
    const failure = new Error("forbidden");
    const onEditMessage = vi.fn(async () => {
      throw failure;
    });
    mount(onEditMessage);
    await waitFor(() => expect(screen.getByText("처음 답글")).toBeTruthy());
    const before = api.fetch.mock.calls.length;

    fireEvent.click(screen.getByTestId("edit-reply"));
    await waitFor(() => expect(lastRowError).toBe(failure));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.fetch.mock.calls.length).toBe(before);
  });
});
