// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import type { MailboxEntry } from "@momo/core/features/inbox/mailbox";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { InboxDetail } from "./InboxDetail";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const NOW = 1_800_000_000_000;

const api = vi.hoisted(() => ({
  fetchMessages: vi.fn(),
  fetchThreadReplies: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  fetchMessages: api.fetchMessages,
  fetchThreadReplies: api.fetchThreadReplies,
  sendMessage: api.sendMessage,
}));
vi.mock("@/features/workspace/useWorkspace", () => ({
  memberFor: () => undefined,
  useChannels: () => ({ groups: { channels: [], dms: [] } }),
}));
vi.mock("@/features/timeline/MessageRow", () => ({ Avatar: () => null }));
vi.mock("@/features/timeline/MessageBody", () => ({
  MessageBody: ({ body }: { body: string }) => createElement("span", null, body),
}));
vi.mock("@/features/timeline/ThreadComposer", () => ({
  ThreadComposer: ({ rootId }: { rootId: string }) =>
    createElement("div", { "data-testid": "thread-composer", "data-root": rootId }),
}));
vi.mock("./InboxApprovalActions", () => ({
  InboxApprovalActions: ({ approvalId }: { approvalId: string }) =>
    createElement("div", { "data-testid": "approval-actions", "data-id": approvalId }),
}));

const directory = { members: [], byId: new Map() } as never;

function msg(seq: number, body: string, extra: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`, channelId: CH, seq, hlcTs: NOW, hlcCount: 0, authorMemberId: ME,
    type: "text", body, createdAtMs: NOW + seq, ...extra,
  };
}

function entry(over: Partial<MailboxEntry>): MailboxEntry {
  return {
    key: "k", kind: "dm", channelId: CH, channelLabel: "서연", typeLabel: "DM · 서연", actor: "서연",
    actorIsAgent: false, preview: "p", atMs: NOW, timeLabel: "방금", unread: true, unreadCount: 1,
    seq: 5, reason: "r", ...over,
  };
}

const task: FeedItem = {
  key: "approval:a1", kind: "approval", tone: "warn", actor: "@kim-intern", actorIsAgent: true,
  predicate: "세션 종료 허가를 요청했습니다", outcome: null, outcomeTone: "muted", channelId: CH,
  channelLabel: "#workbench", timeLabel: "5분 후 만료", sortAtMs: NOW, pending: true, reason: "r",
  approvalId: "a1", expiresAtMs: undefined,
} as FeedItem;

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a", refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "나", handle: "me" },
      realtimeWebSocketUrl: "wss://x.test/ws",
    },
    workspaceId: WS, realtime: null, connStatus: "connected", logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as SessionContextValue;
}

async function mount(e: MailboxEntry, offline = false): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider, { client },
        createElement(SessionProvider, { value: session() },
          createElement(MemoryRouter, null,
            createElement(InboxDetail, {
              entry: e, directory, offline, onToggleRead: () => undefined,
              onDecided: () => undefined, readBusy: false,
            })))
      )
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return host;
}

beforeAll(() => { env.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  api.fetchMessages.mockResolvedValue({ messages: [msg(6, "둘째"), msg(5, "첫째")] });
  api.fetchThreadReplies.mockResolvedValue({ messages: [msg(9, "답글 하나")] });
  api.sendMessage.mockResolvedValue(msg(10, "ok"));
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null; host?.remove(); host = null;
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe("InboxDetail", () => {
  it("DM: 최근 대화를 오래된 순으로 보이고 답장 입력이 있다", async () => {
    const h = await mount(entry({}));
    const rows = Array.from(h.querySelectorAll('[data-testid="inbox-context-row"]'));
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("첫째"), expect.stringContaining("둘째"),
    ]);
    expect(h.querySelector('[data-testid="inbox-reply-input"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="inbox-open-conversation"]')?.getAttribute("href")).toBe(`/c/${CH}?seq=5`);
  });

  it("멘션: 그 메시지를 강조하고, 보내면 그 메시지를 인용(replyToId)해 보낸다", async () => {
    const h = await mount(entry({ key: "mention:m5", kind: "mention", messageId: "m5", typeLabel: "멘션 · #w" }));
    expect(h.querySelector('[data-highlighted="true"]')?.textContent).toContain("첫째");
    expect(api.fetchMessages).toHaveBeenCalledWith(WS, CH, { limit: 20, before: 8 });
    const input = h.querySelector<HTMLTextAreaElement>('[data-testid="inbox-reply-input"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(input, "확인했어요");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      h.querySelector<HTMLButtonElement>('[data-testid="inbox-reply-send"]')!.click();
      await Promise.resolve();
    });
    expect(api.sendMessage).toHaveBeenCalledWith(WS, CH, expect.any(String), "확인했어요", { replyToId: "m5" });
  });

  it("스레드: 내 글과 답글을 보이고 스레드 입력을 쓴다 (채널 입력이 아니다)", async () => {
    const h = await mount(entry({ key: "thread:r1", kind: "thread", rootId: "r1", rootPreview: "배포 언제?" }));
    expect(h.querySelector('[data-testid="inbox-thread-root"]')?.textContent).toContain("배포 언제?");
    expect(h.textContent).toContain("답글 하나");
    expect(h.querySelector('[data-testid="thread-composer"]')?.getAttribute("data-root")).toBe("r1");
    expect(h.querySelector('[data-testid="inbox-reply-input"]')).toBeNull();
    expect(api.fetchThreadReplies).toHaveBeenCalled();
  });

  it("처리할 일: 결정 버튼이 있고 대화는 불러오지 않는다", async () => {
    const h = await mount(entry({ key: "approval:a1", kind: "task", task, typeLabel: "처리할 일", seq: undefined }));
    expect(h.querySelector('[data-testid="approval-actions"]')?.getAttribute("data-id")).toBe("a1");
    expect(api.fetchMessages).not.toHaveBeenCalled();
    expect(h.querySelector('[data-testid="inbox-reply-input"]')).toBeNull();
    expect(h.querySelector('[data-testid="inbox-toggle-read"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("처리할 일 + 오프라인이면 버튼 대신 이유를 말한다", async () => {
    const h = await mount(entry({ key: "approval:a1", kind: "task", task, seq: undefined }), true);
    expect(h.querySelector('[data-testid="approval-actions"]')).toBeNull();
    expect(h.querySelector('[data-testid="inbox-approval-offline"]')).not.toBeNull();
  });

  it("오프라인에서는 답장 입력 대신 이유를 말한다", async () => {
    const h = await mount(entry({}), true);
    expect(h.querySelector('[data-testid="inbox-reply-input"]')).toBeNull();
    expect(h.querySelector('[data-testid="inbox-reply-offline"]')).not.toBeNull();
  });

  it("맥락을 못 불러오면 오류와 다시 시도", async () => {
    api.fetchMessages.mockRejectedValue(new Error("boom"));
    const h = await mount(entry({}));
    expect(h.querySelector('[data-testid="inbox-context-error"]')).not.toBeNull();
  });

  it("전송이 실패하면 입력은 남고 이유가 보인다", async () => {
    api.sendMessage.mockRejectedValue(new Error("x"));
    const h = await mount(entry({}));
    const input = h.querySelector<HTMLTextAreaElement>('[data-testid="inbox-reply-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "안녕");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      h.querySelector<HTMLButtonElement>('[data-testid="inbox-reply-send"]')!.click();
      await Promise.resolve();
    });
    expect(h.querySelector('[data-testid="inbox-reply-error"]')).not.toBeNull();
    expect(input.value).toBe("안녕");
  });
});
