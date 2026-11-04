import { describe, expect, it, vi } from "vitest";
import { ApiError, type ThreadReadState } from "../../lib/api";
import { createThreadReadSender } from "./threadRead";

const ROOT = "0199aaaa-0000-7000-8000-000000000001";
const OTHER_ROOT = "0199aaaa-0000-7000-8000-000000000002";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const read = (unreadReplyCount: number): ThreadReadState => ({ following: true, lastReadReplySeq: 1, unreadReplyCount });

function setup(send = vi.fn(async (): Promise<ThreadReadState> => read(0))) {
  const onState = vi.fn();
  return { sender: createThreadReadSender({ send, onState }), send, onState };
}

describe("읽음 신호는 앞으로만, 오를 때만 나간다", () => {
  it("처음 값은 보내고, 같은 값·낮은 값은 보내지 않고, 높은 값은 보낸다", async () => {
    const { sender, send } = setup();
    sender.note(ROOT, 12);
    sender.note(ROOT, 12);
    sender.note(ROOT, 9);
    await flush();
    expect(send.mock.calls).toEqual([[ROOT, 12]]);
    sender.note(ROOT, 14);
    await flush();
    expect(send.mock.calls).toEqual([[ROOT, 12], [ROOT, 14]]);
  });

  it("답글이 없으면(null) 보내지 않는다", async () => {
    const { sender, send } = setup();
    sender.note(ROOT, null);
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("스레드마다 따로 센다 — 한 루트의 값이 다른 루트의 신호를 막지 않는다", async () => {
    const { sender, send } = setup();
    sender.note(ROOT, 12);
    sender.note(OTHER_ROOT, 12);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("대소문자만 다른 루트 id는 같은 스레드로 센다", async () => {
    const { sender, send } = setup();
    sender.note(ROOT, 12);
    sender.note(ROOT.toUpperCase(), 12);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("응답은 화면에 반영하는 쪽으로 넘어간다", async () => {
    const send = vi.fn(async (): Promise<ThreadReadState> => read(0));
    const { sender, onState } = setup(send);
    sender.note(ROOT, 12);
    await flush();
    expect(onState).toHaveBeenCalledWith(ROOT, read(0));
  });
});

describe("실패와 옛 응답", () => {
  it.each([404, 405])("%s 는 이 서버에 기능이 없다는 뜻 — 그 뒤로는 어느 스레드에도 더 보내지 않는다", async (status) => {
    const send = vi.fn(async (): Promise<ThreadReadState> => {
      throw new ApiError(status, "no route");
    });
    const { sender } = setup(send);
    sender.note(ROOT, 12);
    await flush();
    sender.note(ROOT, 20);
    sender.note(OTHER_ROOT, 5);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("그 밖의 오류(5xx·403·네트워크)는 삼키고, 같은 seq도 다음 신호에 다시 시도한다", async () => {
    let fail = true;
    const send = vi.fn(async (): Promise<ThreadReadState> => {
      if (fail) throw new ApiError(500, "boom");
      return read(0);
    });
    const { sender, onState } = setup(send);
    sender.note(ROOT, 12);
    await flush();
    expect(onState).not.toHaveBeenCalled();
    fail = false;
    sender.note(ROOT, 12);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it("네트워크 오류(ApiError가 아닌 예외)도 삼키고 다음 신호에 다시 시도한다 — 처리되지 않은 거절은 vitest가 실패로 센다", async () => {
    let calls = 0;
    const send = vi.fn(async (): Promise<ThreadReadState> => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      return read(0);
    });
    const { sender, onState } = setup(send);
    sender.note(ROOT, 12);
    await flush();
    sender.note(ROOT, 12);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it("늦게 온 옛 응답은 새 응답을 덮지 않는다: 5를 보내고 7을 보냈다면 7의 응답만 반영한다", async () => {
    const resolvers: Array<(state: ThreadReadState) => void> = [];
    const send = vi.fn(
      () => new Promise<ThreadReadState>((resolve) => resolvers.push(resolve))
    );
    const { sender, onState } = setup(send);
    sender.note(ROOT, 5);
    sender.note(ROOT, 7);
    resolvers[1](read(0)); // 7의 응답이 먼저
    await flush();
    resolvers[0](read(3)); // 5의 응답이 늦게
    await flush();
    expect(onState.mock.calls).toEqual([[ROOT, read(0)]]);
  });

  it("화면 반영(onState)이 던져도 신호는 보낸 것으로 남는다 — 같은 seq를 다시 보내지 않는다", async () => {
    const send = vi.fn(async (): Promise<ThreadReadState> => read(0));
    const onState = vi.fn(() => {
      throw new Error("render failed");
    });
    const sender = createThreadReadSender({ send, onState });
    sender.note(ROOT, 12);
    await flush();
    sender.note(ROOT, 12);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
