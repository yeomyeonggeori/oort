// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { useRequestThreadLanding } from "./useRequestThreadLanding";
import { requestNotificationTarget } from "@/features/notifications/requestNotificationTarget";

const fetchMessages = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/lib/api", async original => ({ ...await original<typeof import("@momo/core/lib/api")>(), fetchMessages }));
const root = { id: "request", channelId: "channel", authorMemberId: "human", seq: 1, type: "text", state: "sent", body: "소개 바꿔 줘요", createdAtMs: 1, hlcTs: 1, hlcCount: 0 } as Message;
const open = vi.fn();
const missing = vi.fn();
const empty: Message[] = [];
function Probe({ messages = empty, channelId = "channel" }: { messages?: Message[]; channelId?: string }) {
  const target = useRequestThreadLanding({ workspaceId: "workspace", channelId, messages, onOpen: open, onMissing: missing });
  const location = useLocation();
  return <><output data-testid="route">{location.pathname}{location.search}</output><output data-testid="target">{target?.messageId}</output></>;
}
function tree(path: string, messages = empty, channelId = "channel") {
  return <MemoryRouter initialEntries={[path]}><Probe messages={messages} channelId={channelId} /></MemoryRouter>;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("알림에서 요청 스레드 카드로 착지", () => {
  it("서버 root가 있으면 그 스레드를 열고 카드 id를 패널로 넘기며 같은 주소를 다시 쓸 수 있게 소비한다", async () => {
    const path = requestNotificationTarget("channel", "CARD", "REQUEST");
    render(tree(path, [root]));
    await waitFor(() => expect(open).toHaveBeenCalledWith(root));
    expect(screen.getByTestId("target").textContent).toBe("card");
    expect(screen.getByTestId("route").textContent).toBe("/c/channel");
    expect(fetchMessages).not.toHaveBeenCalled();
  });
  it("root가 없는 구 서버 알림은 기존 카드 앵커를 유지한다", () => {
    const path = requestNotificationTarget("channel", "CARD");
    expect(path).toBe("/c/channel?msg=card");
    render(tree(path));
    expect(open).not.toHaveBeenCalled();
    expect(fetchMessages).not.toHaveBeenCalled();
  });
  it("root가 로컬 창 밖이면 제한된 페이지에서 읽고, 없는 root는 끝없이 탐색하지 않는다", async () => {
    fetchMessages.mockImplementation(async (_ws, _ch, query) => ({ messages: [{ ...root, id: "other" }], nextBefore: (query.before ?? 100) - 1 }));
    render(tree(requestNotificationTarget("channel", "card", "request")));
    await waitFor(() => expect(missing).toHaveBeenCalledOnce());
    expect(fetchMessages).toHaveBeenCalledTimes(8);
    expect(open).not.toHaveBeenCalled();
  });
  it("다른 대화로 옮긴 뒤 늦게 온 root 응답은 열지 않는다", async () => {
    let resolve: (value: { messages: Message[] }) => void = () => undefined;
    fetchMessages.mockImplementation(() => new Promise(value => { resolve = value; }));
    const path = requestNotificationTarget("channel", "card", "request");
    const view = render(tree(path));
    await waitFor(() => expect(fetchMessages).toHaveBeenCalledOnce());
    view.rerender(tree(path, empty, "other-channel"));
    await act(async () => resolve({ messages: [root] }));
    expect(open).not.toHaveBeenCalled();
    expect(missing).not.toHaveBeenCalled();
  });
  it("착지한 뒤 기록이 갱신되거나 대화를 나갔다 돌아와도 지난 알림을 다시 열지 않는다", async () => {
    const path = requestNotificationTarget("channel", "card", "request");
    const view = render(tree(path, [root]));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    view.rerender(tree(path, [{ ...root, body: "고친 요청" }]));
    expect(open).toHaveBeenCalledOnce();
    view.rerender(tree(path, empty, "other-channel"));
    view.rerender(tree(path, [root]));
    expect(open).toHaveBeenCalledOnce();
  });
});
