// @vitest-environment jsdom
import { render, renderHook, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Message } from "@momo/core/lib/api";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { RealtimeHandle } from "@/lib/realtime";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { koreanLocale } from "@/testing/koLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { followingKnown, resetThreadFollowStoreForTest } from "@/features/notifications/threadFollowStore";
import { isThreadViewed, resetViewedThreadForTest } from "@/features/notifications/viewedThread";
import { ThreadPanel } from "./ThreadPanel";
import { useThreadFollow } from "./useThreadFollow";

// =============================================================================
// 스레드 패널 머리의 「따라가기 / 그만 따라가기」 (#4890). 서버는 가짜 응답이다. 규칙(낙관적 갱신·되돌림·숨김)의 단위 시험은
// 코어 `threadFollow.test.ts` 에 있고, 여기서는 **패널이 단추를 언제 세우고 무엇을 보이는가**를 잰다:
// 상태 둘(말로 하는 라벨)·누르면 즉시 바뀜·실패하면 되돌리고 안내·쓸 수 없는 곳은 숨김·열린 스레드를 알림에 알림.
// 그리고(#5017) 입력창 곁의 한 줄 「답하면 이 스레드를 따라가요」가 **처음 답할 때만** 서는지: 규칙 표는 코어
// `threadFollow.test.ts` 가 재고, 여기서는 패널이 서버 값·누른 적·내 답글을 코어에 **제대로 물리는지**를 잰다.
// =============================================================================

const WS = "workspace";
const CH = "channel";
const ME = "human-me";
const OTHER = "human-other";
const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  read: vi.fn(),
  follow: vi.fn(),
  unfollow: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (original) => ({
  ...(await original<typeof import("@momo/core/lib/api")>()),
  fetchThreadReplies: api.fetch,
  markThreadRead: api.read,
  followThread: api.follow,
  unfollowThread: api.unfollow,
}));
vi.mock("@/features/agents/agentRunProgressStore", () => ({ useChannelRuns: () => [] }));
vi.mock("./MessageRow", () => ({
  MessageRow: ({ message }: { message: Message }) => <div data-testid="timeline-message">{message.body}</div>,
}));
// 입력창은 가짜다: 패널이 건넨 힌트 줄만 그대로 그린다(줄의 모양·`aria-describedby` 는 `ThreadComposer` 시험이 잰다).
vi.mock("./ThreadComposer", () => ({
  ThreadComposer: ({ followHint }: { followHint?: string }) =>
    followHint === undefined ? null : <p data-testid="thread-composer-follow-hint">{followHint}</p>,
}));

const root = { id: "root", channelId: CH, seq: 1, authorMemberId: ME, type: "text", body: "소개를 바꿔 줘요", state: "sent", createdAtMs: 1, hlcTs: 1, hlcCount: 0 } as Message;
const reply = (seq: number): Message => ({ ...root, id: `r${seq}`, rootId: "root", seq, authorMemberId: OTHER, body: `답글 ${seq}` });

let handlers: Parameters<RealtimeHandle["subscribeChannel"]>[2];
const realtime = {
  subscribeChannel: (_ws: string, _ch: string, value: typeof handlers) => {
    handlers = value;
    return () => undefined;
  },
} as unknown as RealtimeHandle;

const actions = {
  myMemberId: ME,
  onToggleReaction: vi.fn(),
  onTogglePin: vi.fn(),
  onEditMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
};

let ko: AppLocale;
beforeAll(async () => {
  ko = await koreanLocale();
});

function mount(options: { withActions?: boolean; followable?: boolean; root?: Message } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <LocaleProvider locale={ko}>
      <QueryClientProvider client={client}>
        <ThreadPanel
          workspaceId={WS}
          channelId={CH}
          root={options.root ?? root}
          directory={makeDirectory([])}
          channels={[]}
          realtime={realtime}
          actions={options.withActions === false ? undefined : actions}
          followable={options.followable}
          onClose={() => undefined}
        />
      </QueryClientProvider>
    </LocaleProvider>
  );
}
const button = () => screen.getByTestId("thread-follow");
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const ON = "이 스레드를 따라가고 있어요. 누르면 그만 따라가요.";
const OFF = "이 스레드를 따라가지 않아요. 누르면 따라가요.";

beforeEach(() => {
  api.fetch.mockReset();
  api.read.mockReset();
  api.follow.mockReset();
  api.unfollow.mockReset();
  api.read.mockResolvedValue({ following: true, lastReadReplySeq: 1, unreadReplyCount: 0 });
  resetThreadFollowStoreForTest();
  resetViewedThreadForTest();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("머리의 단추: 지금 상태를 말로 한다", () => {
  it("따라가는 스레드는 켜진 모양과 「따라가고 있어요」 라벨, 따라가지 않는 스레드는 꺼진 모양과 「따라가지 않아요」 라벨이다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: true });
    mount();
    await waitFor(() => expect(button().getAttribute("aria-label")).toBe(ON));
    expect(button().getAttribute("data-following")).toBe("true");
    cleanup();

    api.fetch.mockResolvedValue({ messages: [reply(2)], following: false });
    mount();
    await waitFor(() => expect(button().getAttribute("aria-label")).toBe(OFF));
    expect(button().getAttribute("data-following")).toBe("false");
  });

  it("옛 서버(following 키 없음)는 따라가지 않는 것으로 읽는다 — 모름으로 두지 않는다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)] });
    mount();
    await waitFor(() => expect(button().getAttribute("aria-label")).toBe(OFF));
  });

  it("스레드를 받기 전과 받지 못했을 때는 단추가 없다", async () => {
    api.fetch.mockRejectedValue(new ApiError(500, "boom"));
    mount();
    await waitFor(() => expect(screen.getByTestId("thread-error")).toBeTruthy());
    expect(screen.queryByTestId("thread-follow")).toBeNull();
  });

  it("DM 같은 곳(followable=false)과 읽는 대화가 아닌 곳(작업 세션 패널: actions 없음)에는 단추가 없다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: false });
    mount({ followable: false });
    await waitFor(() => expect(screen.getAllByTestId("timeline-message").length).toBeGreaterThan(1));
    expect(screen.queryByTestId("thread-follow")).toBeNull();
    cleanup();
    mount({ withActions: false });
    await waitFor(() => expect(screen.getAllByTestId("timeline-message").length).toBeGreaterThan(1));
    expect(screen.queryByTestId("thread-follow")).toBeNull();
  });
});

describe("누르면 바로 바뀌고 서버 값으로 확정된다", () => {
  it("따라가기: 응답이 오기 전에 켜진 모양이 되고, 확정되면 데스크탑 알림의 장부에도 서버가 말한 값으로 적힌다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: false });
    let respond!: (value: { following: boolean }) => void;
    api.follow.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    mount();
    await waitFor(() => expect(button().getAttribute("data-following")).toBe("false"));
    fireEvent.click(button());
    expect(button().getAttribute("data-following")).toBe("true"); // 낙관적: 아직 응답 전
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(api.follow).toHaveBeenCalledWith(WS, CH, "root");
    expect(followingKnown(WS, "root")).toBe(false); // 서버가 말하기 전에는 낙관값을 장부에 적지 않는다(열 때의 값 그대로)
    await act(async () => respond({ following: true }));
    expect(button().getAttribute("aria-label")).toBe(ON);
    expect(button().getAttribute("aria-busy")).toBeNull();
    expect(followingKnown(WS, "root")).toBe(true);
  });

  it("그만 따라가기: DELETE 를 보내고 꺼진 모양이 된다. 누르는 동안 다시 눌러도 요청은 한 번이다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: true });
    api.unfollow.mockResolvedValue({ following: false });
    mount();
    await waitFor(() => expect(button().getAttribute("data-following")).toBe("true"));
    fireEvent.click(button());
    fireEvent.click(button());
    await settle();
    expect(api.unfollow).toHaveBeenCalledTimes(1);
    expect(api.follow).not.toHaveBeenCalled(); // 낙관적으로 꺼진 모양을 다시 누른 것이 「따라가기」 요청이 되지 않는다
    expect(button().getAttribute("aria-label")).toBe(OFF);
    expect(followingKnown(WS, "root")).toBe(false);
  });

  it("누른 뒤 실시간으로 다시 읽은 옛 값이 방금 확정한 값을 뒤집지 않는다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: false });
    api.follow.mockResolvedValue({ following: true });
    mount();
    await waitFor(() => expect(button().getAttribute("data-following")).toBe("false"));
    fireEvent.click(button());
    await settle();
    expect(button().getAttribute("data-following")).toBe("true");
    // 누르기 직전에 출발한 옛 읽기가 늦게 닿은 모양: 같은 질의가 `following: false` 로 다시 채워진다.
    api.fetch.mockResolvedValue({ messages: [reply(2), reply(3)], following: false });
    act(() => handlers.onMessage({ type: "message.new", v: 1, ts: 1, seq: 3, payload: { id: "r3", root_id: "root", channel_id: CH } } as MessageNewEvent));
    await waitFor(() => expect(screen.getAllByTestId("timeline-message").length).toBe(3));
    expect(button().getAttribute("data-following")).toBe("true");
  });
});

describe("실패하면 되돌리고 짧게 알린다", () => {
  it("서버 오류: 낙관값이 보이다가 누르기 전 모양으로 돌아가고 안내가 서며, 닫으면 사라진다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: false });
    let fail!: (error: unknown) => void;
    api.follow.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    mount();
    await waitFor(() => expect(button().getAttribute("data-following")).toBe("false"));
    fireEvent.click(button());
    expect(button().getAttribute("data-following")).toBe("true"); // 요청이 실패하기 전까지는 낙관값이 보인다
    await act(async () => fail(new ApiError(500, "boom")));
    expect(button().getAttribute("data-following")).toBe("false");
    expect(button().getAttribute("aria-label")).toBe(OFF);
    const banner = screen.getByTestId("thread-follow-failed");
    expect(banner.textContent).toContain("따라가기를 바꾸지 못했어요. 잠시 뒤에 다시 시도해 주세요.");
    fireEvent.click(banner.querySelector("button")!);
    expect(screen.queryByTestId("thread-follow-failed")).toBeNull();
  });

  it("실패한 요청의 낙관값은 장부에 적히지 않는다 — 장부에는 스레드를 열 때 서버가 말한 값만 있다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: false });
    api.follow.mockRejectedValue(new ApiError(503, "unavailable"));
    mount();
    await waitFor(() => expect(button().getAttribute("data-following")).toBe("false"));
    expect(followingKnown(WS, "root")).toBe(false);
    fireEvent.click(button());
    await settle();
    expect(screen.getByTestId("thread-follow-failed")).toBeTruthy();
    expect(followingKnown(WS, "root")).toBe(false);
  });
});

describe("쓸 수 없는 곳이면 칸을 숨긴다", () => {
  it.each([
    ["옛 서버 404", new ApiError(404, "not found")],
    ["옛 서버 405", new ApiError(405, "method not allowed")],
    ["DM 스레드 400", new ApiError(400, "not applicable", "thread_follow_not_applicable")],
  ])("%s → 누른 뒤 단추가 사라지고 실패 안내도 세우지 않는다", async (_name, error) => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: false });
    api.follow.mockRejectedValue(error);
    mount();
    await waitFor(() => expect(button().getAttribute("data-following")).toBe("false"));
    fireEvent.click(button());
    await settle();
    expect(screen.queryByTestId("thread-follow")).toBeNull();
    expect(screen.queryByTestId("thread-follow-failed")).toBeNull();
  });
});

describe("열려 있는 스레드를 데스크탑 알림에 알린다", () => {
  it("패널이 열려 있는 동안 그 루트가 보는 중으로 적히고, 닫히면(언마운트) 지워진다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: true });
    const view = mount();
    expect(isThreadViewed("root")).toBe(true);
    view.unmount();
    expect(isThreadViewed("root")).toBe(false);
  });

  it("읽는 대화가 아닌 곳(actions 없음)은 보는 중으로 적지 않는다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: true });
    mount({ withActions: false });
    expect(isThreadViewed("root")).toBe(false);
  });
});

describe("서버 값이 닿는 첫 그림부터 맞는 모양이다", () => {
  it("값이 닿은 뒤에 효과로 맞추지 않는다 — 거꾸로 선 모양이 한 프레임도 그려지지 않는다", () => {
    const client = new QueryClient();
    const seen: boolean[] = [];
    const { rerender } = renderHook(
      ({ serverFollowing }: { serverFollowing: boolean | undefined }) => {
        const state = useThreadFollow({
          workspaceId: WS,
          channelId: CH,
          rootId: "root",
          queryKey: ["thread", WS, CH, "root"],
          serverFollowing,
        });
        seen.push(state.view.following);
        return state;
      },
      {
        initialProps: { serverFollowing: undefined as boolean | undefined },
        wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
      }
    );
    seen.length = 0;
    rerender({ serverFollowing: true });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((following) => following)).toBe(true);
  });
});


describe("처음 답할 때만 입력창 곁에 「답하면 이 스레드를 따라가요」가 선다 (#5017)", () => {
  const HINT = "답하면 이 스레드를 따라가요.";
  const hint = () => screen.queryByTestId("thread-composer-follow-hint");
  /** 남이 연 스레드: 내가 아직 말한 적이 없다. (기본 `root` 는 내 글이라 답글이 달리면 이미 따라가던 쪽이다.) */
  const othersRoot = { ...root, authorMemberId: OTHER } as Message;
  const mine = (seq: number): Message => ({ ...reply(seq), authorMemberId: ME, body: `내 답글 ${seq}` });

  it("서버가 따라가지 않는다고 말했고 아직 답한 적이 없으면 선다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: false });
    mount({ root: othersRoot });
    await waitFor(() => expect(hint()?.textContent).toBe(HINT));
  });

  it.each([
    // 패널이 서버가 **말한** 값(`following` 의 키 없음 = 옛 서버)과 내 답글을 코어 규칙에 그대로 물리는지. 나머지 갈래(따라가는 스레드·
    // 내 글의 스레드·다 못 불러옴·칸 없음)의 표는 코어 `threadFollow.test.ts` 가 잰다.
    ["옛 서버(following 키 없음): 답해도 따라가지 않는다", { messages: [reply(2)] }],
    ["내가 이미 답한 스레드", { messages: [reply(2), mine(3)], following: false }],
  ])("%s → 서지 않는다", async (_name, page) => {
    api.fetch.mockResolvedValue(page);
    mount({ root: othersRoot });
    await waitFor(() => expect(button()).toBeTruthy());
    expect(hint()).toBeNull();
  });

  it("사람이 눌러 끈 스레드에서는 서지 않는다 — 끈 스레드는 답글로 돌아오지 않는다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: true });
    api.unfollow.mockResolvedValue({ following: false });
    mount({ root: othersRoot });
    await waitFor(() => expect(button().getAttribute("data-following")).toBe("true"));
    fireEvent.click(button());
    await settle();
    expect(button().getAttribute("data-following")).toBe("false");
    expect(hint()).toBeNull();
  });

  it("첫 답글을 보낸 뒤 서버가 따라간다고 다시 말하면 거둬진다", async () => {
    api.fetch.mockResolvedValue({ messages: [reply(2)], following: false });
    mount({ root: othersRoot });
    await waitFor(() => expect(hint()?.textContent).toBe(HINT));
    api.fetch.mockResolvedValue({ messages: [reply(2), mine(3)], following: true });
    act(() => handlers.onMessage({ type: "message.new", v: 1, ts: 1, seq: 3, payload: { id: "r3", root_id: "root", channel_id: CH } } as MessageNewEvent));
    await waitFor(() => expect(screen.getAllByTestId("timeline-message").length).toBe(3));
    expect(hint()).toBeNull();
    expect(button().getAttribute("data-following")).toBe("true");
  });
});
