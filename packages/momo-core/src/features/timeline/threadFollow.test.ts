import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit/i18n";
import { createThreadFollowController, followIsUnavailable, followOnReplyHint, threadFollowCopy } from "./threadFollow";

// =============================================================================
// 스레드 머리의 따라가기 단추 규칙 (#4890). 서버는 가짜 응답이고, 여기서는 단추가 **무엇을 언제 바꾸는가**를 잰다:
// 낙관적 갱신·실패하면 되돌림·중복 누름 무시·「쓸 수 없음」이면 숨김·서버 값은 누르기 전까지만 받음.
// =============================================================================

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(initial: boolean, send = vi.fn(async (follow: boolean) => ({ following: follow }))) {
  const onSettled = vi.fn();
  const controller = createThreadFollowController({ initial, send, onSettled });
  return { controller, send, onSettled };
}

describe("누르면 화면이 먼저 바뀌고, 서버 효과값으로 확정된다", () => {
  it("따라가기는 PUT(true), 그만 따라가기는 DELETE(false)를 보내고 요청 중에도 바뀐 값을 보인다", async () => {
    const wire = deferred<{ following: boolean }>();
    const { controller, send } = setup(false, vi.fn(() => wire.promise));
    const pending = controller.toggle();
    expect(send).toHaveBeenCalledWith(true);
    expect(controller.getSnapshot()).toMatchObject({ following: true, pending: true, failed: false });
    wire.resolve({ following: true });
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ following: true, pending: false });

    const second = setup(true);
    await second.controller.toggle();
    expect(second.send).toHaveBeenCalledWith(false);
    expect(second.controller.getSnapshot()).toMatchObject({ following: false, pending: false });
  });

  it("서버가 말한 효과값이 낙관값을 이긴다 — 확정 값을 호출부(장부·캐시)로 넘긴다", async () => {
    const { controller, onSettled } = setup(false, vi.fn(async () => ({ following: false })));
    await controller.toggle();
    expect(controller.getSnapshot().following).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(false);
  });

  it("요청이 나가 있는 동안 다시 눌러도 두 번째 요청은 없다", async () => {
    const wire = deferred<{ following: boolean }>();
    const { controller, send } = setup(false, vi.fn(() => wire.promise));
    const first = controller.toggle();
    await controller.toggle();
    await controller.toggle();
    expect(send).toHaveBeenCalledTimes(1);
    wire.resolve({ following: true });
    await first;
    expect(controller.getSnapshot().following).toBe(true);
  });
});

describe("실패하면 누르기 전 값으로 되돌리고 안내를 세운다", () => {
  it.each([
    ["네트워크 오류", new TypeError("network")],
    ["서버 오류 500", new ApiError(500, "boom")],
    ["권한 403", new ApiError(403, "not a member of this channel")],
    ["너무 잦음 429", new ApiError(429, "slow down")],
    ["코드 없는 400", new ApiError(400, "bad request")],
  ])("%s → 되돌림 + failed, 칸은 그대로 있다", async (_name, error) => {
    const { controller, onSettled } = setup(false, vi.fn(async () => Promise.reject(error)));
    await controller.toggle();
    expect(controller.getSnapshot()).toEqual({ following: false, pending: false, failed: true, unavailable: false, touched: true });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("안내는 닫으면 사라지고, 닫지 않아도 다음 누르기가 지운다 — 되돌린 값에서 다시 시도한다", async () => {
    const send = vi.fn<(follow: boolean) => Promise<{ following: boolean }>>();
    send.mockRejectedValueOnce(new ApiError(500, "boom"));
    send.mockRejectedValueOnce(new ApiError(500, "boom"));
    send.mockResolvedValueOnce({ following: true });
    const { controller } = setup(false, send);
    await controller.toggle();
    expect(controller.getSnapshot().failed).toBe(true);
    controller.dismissError();
    expect(controller.getSnapshot().failed).toBe(false);

    await controller.toggle(); // 두 번째 실패
    expect(controller.getSnapshot()).toMatchObject({ following: false, failed: true });
    const retry = controller.toggle(); // 닫지 않고 다시 누르면 시작과 함께 안내가 지워진다
    expect(controller.getSnapshot()).toMatchObject({ following: true, pending: true, failed: false });
    await retry;
    expect(controller.getSnapshot()).toMatchObject({ following: true, pending: false, failed: false });
    expect(send.mock.calls.map((call) => call[0])).toEqual([true, true, true]);
  });
});

describe("쓸 수 없는 곳(옛 서버·DM)에서는 칸을 숨기고 더 보내지 않는다", () => {
  it.each([
    ["404 옛 서버", new ApiError(404, "not found")],
    ["405 옛 서버", new ApiError(405, "method not allowed")],
    ["400 DM 스레드", new ApiError(400, "thread follow not applicable", "thread_follow_not_applicable")],
  ])("%s → unavailable, 값은 되돌리고 이후 누르기는 요청이 없다", async (_name, error) => {
    const send = vi.fn(async () => Promise.reject(error));
    const { controller } = setup(false, send);
    await controller.toggle();
    expect(controller.getSnapshot()).toEqual({ following: false, pending: false, failed: false, unavailable: true, touched: true });
    await controller.toggle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("followIsUnavailable: ApiError가 아니면, 그리고 다른 코드의 400이면 숨기지 않는다", () => {
    expect(followIsUnavailable(new Error("x"))).toBe(false);
    expect(followIsUnavailable(new ApiError(400, "x", "something_else"))).toBe(false);
    expect(followIsUnavailable(new ApiError(403, "x"))).toBe(false);
  });
});

describe("서버가 알려 준 값은 사람이 누르기 전까지만 받는다", () => {
  it("스레드를 열 때의 값은 받고, 구독자에게 알린다", () => {
    const { controller } = setup(false);
    const listener = vi.fn();
    controller.subscribe(listener);
    expect(controller.sync(true)).toBe(true);
    expect(controller.getSnapshot().following).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.sync(true)).toBe(true); // 받았다는 뜻이고, 같은 값이라 다시 알리지는 않는다
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("누른 적이 있는지(touched)는 서버 값을 받는 동안은 꺼져 있고, 한 번 누르면 켜져서 그대로다 — 실패한 누르기도 센다", async () => {
    const { controller } = setup(false);
    expect(controller.getSnapshot().touched).toBe(false);
    controller.sync(true);
    expect(controller.getSnapshot().touched).toBe(false);
    const failing = setup(false, vi.fn(async () => Promise.reject(new ApiError(500, "boom"))));
    await failing.controller.toggle();
    expect(failing.controller.getSnapshot()).toMatchObject({ following: false, touched: true });
  });

  it("요청이 나가 있는 동안, 그리고 한 번 누른 뒤에는 옛 읽기가 늦게 와도 값을 뒤집지 못한다", async () => {
    const wire = deferred<{ following: boolean }>();
    const { controller } = setup(false, vi.fn(() => wire.promise));
    const pending = controller.toggle();
    expect(controller.sync(false)).toBe(false);
    expect(controller.getSnapshot().following).toBe(true);
    wire.resolve({ following: true });
    await pending;
    expect(controller.sync(false)).toBe(false); // 누르기 직전에 출발한 옛 읽기의 늦은 도착
    await flush();
    expect(controller.getSnapshot().following).toBe(true);
  });
});

describe("문구: 지금 상태를 말로 한다", () => {
  const copyKo = createMessageCopy({ messageLocale: "ko-KR", catalog: ko });
  const copyEn = createMessageCopy({ messageLocale: "en-US" });

  it("한국어: 켜짐·꺼짐의 접근성 라벨이 서로 다른 문장이고, 동작 이름은 누르면 하는 일이다", () => {
    const on = threadFollowCopy(true, copyKo);
    const off = threadFollowCopy(false, copyKo);
    expect(on.label).toBe("이 스레드를 따라가고 있어요. 누르면 그만 따라가요.");
    expect(off.label).toBe("이 스레드를 따라가지 않아요. 누르면 따라가요.");
    expect(on.action).toBe("그만 따라가기");
    expect(off.action).toBe("따라가기");
    expect(on.failed).toBe("따라가기를 바꾸지 못했어요. 잠시 뒤에 다시 시도해 주세요.");
    expect(on.dismiss).toBe("닫기");
    expect(on.replyHint).toBe("답하면 이 스레드를 따라가요.");
    expect(off.replyHint).toBe(on.replyHint); // 상태와 무관한 한 문장이다(세울지는 `followOnReplyHint`)
  });

  it("영어도 같은 짝이다", () => {
    expect(threadFollowCopy(true, copyEn)).toMatchObject({
      label: "Following this thread. Press to stop following.",
      action: "Stop following",
    });
    expect(threadFollowCopy(false, copyEn)).toMatchObject({
      label: "Not following this thread. Press to follow.",
      action: "Follow thread",
      replyHint: "Replying makes you follow this thread.",
    });
  });
});

describe("처음 답할 때의 힌트 (#5017): 말이 틀릴 수 있는 갈래에서는 서지 않는다", () => {
  const ME = "00000000-0000-7000-8000-000000000101";
  const OTHER = "00000000-0000-7000-8000-0000000005d1";
  const base = {
    available: true,
    serverFollowing: false as boolean | undefined,
    touched: false,
    selfMemberId: ME as string | undefined,
    rootAuthorId: OTHER,
    replies: [{ authorMemberId: OTHER }] as ReadonlyArray<{ authorMemberId: string }>,
    complete: true,
  };

  it("서버가 따라가지 않는다고 했고 아직 이 스레드에서 말한 적이 없으면 선다 — 답글이 없는 내 글의 스레드도 마찬가지다", () => {
    expect(followOnReplyHint(base)).toBe(true);
    expect(followOnReplyHint({ ...base, rootAuthorId: ME, replies: [] })).toBe(true);
  });

  it.each([
    ["칸이 없는 곳(DM·작업 세션·서버 응답 전·쓸 수 없음)", { available: false }],
    ["따라가는 스레드", { serverFollowing: true }],
    ["옛 서버(following 키 없음): 답해도 따라가지 않는다", { serverFollowing: undefined }],
    ["사람이 이 패널에서 누른 적이 있다: 끈 것은 답글로 돌아오지 않는다", { touched: true }],
    ["내가 이미 답한 스레드(대소문자가 달라도)", { replies: [{ authorMemberId: ME.toUpperCase() }, { authorMemberId: OTHER }] }],
    ["내 글에 답글이 달린 스레드: 루트 작성자는 첫 답글에서 이미 따라가기 시작했다", { rootAuthorId: ME }],
    ["답글을 다 못 불러왔다: 안 보이는 쪽에 내 답글이 있을 수 있다", { complete: false }],
    ["읽는 사람을 모른다", { selfMemberId: undefined }],
  ])("%s → 서지 않는다", (_name, override) => {
    expect(followOnReplyHint({ ...base, ...override })).toBe(false);
  });
});
