// @vitest-environment jsdom
import { render, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ThreadPanel } from "./ThreadPanel";

// =============================================================================
// 스레드 답글 목록의 자리 지키기를 거는 자리 (#5649).
//
// 답글 상자는 브라우저 스크롤 앵커링을 끄고(`timeline-scroller`) 타임라인과 같은 손(`scrollHold`)이 읽던 자리를 지킨다. 이 시험은 패널이
// 그 손을 **언제 · 어느 상자에 · 어떤 규칙으로** 거는지 잰다(손 자체는 가짜로 바꿔 쥔다):
//   - 상자가 `timeline-scroller` 를 입는다 — 그 클래스가 `overflow-anchor:none` 으로 계산되는 것은 `Timeline.burst.chromium.test.ts` 가
//     진짜 엔진에서 잠근다. 클래스만 붙이고 손을 안 걸면 위쪽 답글이 자랄 때 읽던 답글이 그 높이만큼 밀린다.
//   - 평범한 목록 규칙(`plainListHold("data-message-id")`)으로 건다 — 「맨 위에 선 채로는 바닥이 아니다」가 그 안에 있어, 스레드를 열 때
//     답글이 채워지며 바닥으로 끌려가지 않는다(진짜 엔진에서는 `scrollHold.chromium.test.ts` · 게이트 T0 가 잰다).
//   - 루트가 바뀌면 앞 손을 걷고 새로 건다.
//   - 내가 단 답글이 목록에 서면 `expectBottom` 을 부른다(직접 scrollTop 을 놓으면 보던 답글 지키기가 되돌린다).
// 진짜 엔진의 숫자(WebKit · Chromium: 보던 답글 ≤ 2px · 바닥 ≤ 1px · 열면 맨 위)는 `gates/gate-thread-hold.mjs` 가 잰다.
// =============================================================================

const WS = "workspace";
const CH = "channel";
const ME = "human-me";
const OTHER = "human-other";

const api = vi.hoisted(() => ({ fetch: vi.fn(), read: vi.fn() }));
const composer = vi.hoisted(() => ({ onSent: null as (() => void) | null }));
type FakeHold = { node: HTMLElement; options: unknown; expectBottom: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
const holds = vi.hoisted(() => ({ made: [] as FakeHold[] }));

vi.mock("@momo/core/lib/api", async (original) => ({
  ...(await original<typeof import("@momo/core/lib/api")>()),
  fetchThreadReplies: api.fetch,
  markThreadRead: api.read,
}));
vi.mock("@/features/agents/agentRunProgressStore", () => ({ useChannelRuns: () => [] }));
vi.mock("./MessageRow", () => ({
  MessageRow: ({ message }: { message: Message }) => (
    <div data-testid="timeline-message" data-message-id={message.id}>
      {message.body}
    </div>
  ),
}));
vi.mock("./ThreadComposer", () => ({
  ThreadComposer: ({ onSent }: { onSent: () => void }) => {
    composer.onSent = onSent;
    return null;
  },
}));
vi.mock("./scrollHold", () => ({
  plainListHold: (rowAttribute: string) => ({ plainList: rowAttribute }),
  holdScrollPosition: (node: HTMLElement, options: unknown) => {
    const hold: FakeHold = { node, options, expectBottom: vi.fn(), stop: vi.fn() };
    holds.made.push(hold);
    return hold;
  },
}));

const rootOf = (id: string) =>
  ({ id, channelId: CH, seq: 1, authorMemberId: ME, type: "text", body: "소개를 바꿔 줘요", state: "sent", createdAtMs: 1, hlcTs: 1, hlcCount: 0 }) as Message;
const reply = (seq: number, author = OTHER): Message => ({ ...rootOf("root"), id: `r${seq}`, rootId: "root", seq, authorMemberId: author, body: `답글 ${seq}` });

const actions = {
  myMemberId: ME,
  onToggleReaction: vi.fn(),
  onTogglePin: vi.fn(),
  onEditMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
};

function tree(client: QueryClient, root: Message) {
  return (
    <QueryClientProvider client={client}>
      <ThreadPanel workspaceId={WS} channelId={CH} root={root} directory={makeDirectory([])} channels={[]} actions={actions} onClose={() => undefined} />
    </QueryClientProvider>
  );
}
function mount(root = rootOf("root")) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(tree(client, root));
  return { ...view, client };
}
const scrollBox = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-message-scroll-container]");

beforeEach(() => {
  holds.made.length = 0;
  composer.onSent = null;
  api.fetch.mockReset();
  api.read.mockReset();
  api.read.mockResolvedValue({ following: true, lastReadReplySeq: 0, unreadReplyCount: 0 });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("스레드 답글 목록의 자리 지키기 (#5649)", () => {
  it("답글 상자는 스크롤 앵커링을 끄는 클래스를 입고, 그 상자에 평범한 목록 규칙으로 손을 한 번 건다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(11), reply(12)] });
    const { container } = mount();
    await waitFor(() => expect(scrollBox(container)?.querySelectorAll("[data-message-id]")).toHaveLength(3));
    expect(scrollBox(container)?.classList.contains("timeline-scroller")).toBe(true);
    // 답글을 읽는 동안에도, 채워진 뒤에도 같은 손 하나다(다시 걸지 않는다).
    expect(holds.made).toHaveLength(1);
    expect(holds.made[0].stop).not.toHaveBeenCalled();
    expect(holds.made[0].node).toBe(scrollBox(container));
    expect(holds.made[0].options).toEqual({ plainList: "data-message-id" });
    // 줄 선택자가 실제 줄과 맞는다: 그 속성으로 루트와 답글이 잡힌다.
    expect(scrollBox(container)?.querySelectorAll("[data-message-id]")).toHaveLength(3);
  });

  it("루트가 바뀌면 앞 손을 걷고 새로 건다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(11)] });
    const { rerender, client } = mount();
    await waitFor(() => expect(holds.made).toHaveLength(1));
    // 새 루트의 답글이 이미 받아져 있다(읽는 중을 거치지 않는다): 다시 거는 까닭은 루트가 바뀐 것 하나다.
    client.setQueryData(["thread", WS, CH, "other-root"], { messages: [{ ...reply(21), rootId: "other-root" }] });
    rerender(tree(client, rootOf("other-root")));
    await waitFor(() => expect(holds.made).toHaveLength(2));
    expect(holds.made[0].stop).toHaveBeenCalledTimes(1);
    expect(holds.made[1].stop).not.toHaveBeenCalled();
  });

  it("내가 단 답글이 목록에 서면 손에게 「이제 바닥」을 알린다 — 남의 답글에는 알리지 않는다", async () => {
    let messages = [reply(11), reply(12)];
    api.fetch.mockImplementation(async () => ({ messages }));
    const { client } = mount();
    await waitFor(() => expect(holds.made).toHaveLength(1));
    const hold = holds.made[0];

    // 남의 답글이 왔다(다시 읽기): 알리지 않는다.
    messages = [...messages, reply(13)];
    await act(async () => {
      await client.refetchQueries({ queryKey: ["thread", WS, CH, "root"] });
    });
    expect(hold.expectBottom).not.toHaveBeenCalled();

    // 내가 달았다: 보낸 뒤 다시 읽어 맨 끝 답글이 바뀌면 한 번 알린다.
    messages = [...messages, reply(14, ME)];
    await act(async () => {
      composer.onSent?.();
    });
    await waitFor(() => expect(hold.expectBottom).toHaveBeenCalledTimes(1));
  });

  it("패널이 닫히면 손을 걷는다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(11)] });
    const { unmount } = mount();
    await waitFor(() => expect(holds.made).toHaveLength(1));
    unmount();
    expect(holds.made[0].stop).toHaveBeenCalledTimes(1);
  });
});
