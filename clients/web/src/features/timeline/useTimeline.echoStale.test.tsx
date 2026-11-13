// @vitest-environment jsdom
// #5624 검수 1회차 H1: 장부(`pinSettledEchoes`)는 메아리가 얼마나 오래됐는지 보지 않았다. 실패한 글은 다시 보내도 처음 시각을 들고
// 있으므로(#5221), 밤에 못 보낸 글을 아침에 다시 보내면 확정본이 어제 시각으로 자기 날 줄을 판정받아 오늘 줄 아래에 어제 날 줄이 다시
// 서고(목록 키 `day-…`가 겹친다), 오늘 말이 없으면 오늘이 통째로 어제 날짜 아래에 놓였다.
//
// 이 시험은 실제 훅으로 보내고·실패하고·다시 보내며, **매 렌더**의 줄 모양을 잰다: 키가 겹치지 않고, 날 줄이 시간 순서이고, 확정본마다
// 바로 위 날 줄이 자기 서버 시각의 날이다. 그리고 같은 날 몇 분 뒤 저절로 다시 나간 글은 확정 순간에 머리가 서지 않는다(장부를 좁은
// 문턱으로 끊으면 여기서 뒤집힘이 되살아난다).

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Message } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { buildTimelineItems, dayKey, type TimelineItem } from "@momo/core/features/timeline/model";
import { resetServerClockForTests } from "@momo/core/features/timeline/serverClock";
import { clearAllDrafts } from "@/features/chat/draftStore";
import { useTimeline } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const PEER = "00000000-0000-7000-8000-0000000002ff";

const api = vi.hoisted(() => ({ sendMessage: vi.fn(), fetchMessages: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    ...api,
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
  };
});

const realtime = {
  subscribeChannel: () => () => undefined,
  subscribeAgent: () => () => undefined,
  subscribeTyping: () => () => undefined,
  subscribeWorkSession: () => () => undefined,
  subscribeCascade: () => () => undefined,
  subscribeHuddle: () => () => undefined,
  reconnect: () => undefined,
  dispose: () => undefined,
} as unknown as RealtimeHandle;

const out: { t: ReturnType<typeof useTimeline> | null; renders: TimelineItem[][] } = { t: null, renders: [] };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
  // 화면(`Timeline.tsx`)이 줄을 짓는 것과 같은 호출이다.
  const items = buildTimelineItems(t.state.messages, {
    pending: t.pending,
    echoPins: t.echoPins,
    serverOffsetMs: t.serverOffsetMs,
  });
  useEffect(() => {
    out.t = t;
    out.renders.push(items);
  });
  return createElement("div");
}

/** 한 렌더의 날짜가 맞는가: 키 겹침 0, 날 줄은 시간 순서, 확정본마다 바로 위 날 줄이 자기 서버 시각의 날. */
function dayIssues(items: TimelineItem[]): string[] {
  const issues: string[] = [];
  const keys = items.map((item) => item.key);
  const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (repeated.length > 0) issues.push(`겹친 키 ${repeated.join(",")}`);
  let day: string | null = null;
  let dayAt = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item.kind === "day") {
      if (item.atMs <= dayAt) issues.push(`날 줄 순서 ${item.key}`);
      day = item.key;
      dayAt = item.atMs;
    }
    if (item.kind === "message" && day !== `day-${dayKey(item.message.createdAtMs)}`) {
      issues.push(`「${item.message.body}」이 ${day} 아래`);
    }
  }
  return issues;
}

/** 모든 렌더의 날짜 문제(렌더 차례와 함께). */
function everyRenderIssues(): string[] {
  return out.renders.flatMap((items, index) => dayIssues(items).map((issue) => `#${index} ${issue}`));
}

/** 한 글이 그려진 모든 렌더에서의 머리/이어짐 이력(바뀔 때만 적는다). */
function headHistory(body: string): boolean[] {
  const seen: boolean[] = [];
  for (const items of out.renders) {
    for (const item of items) {
      const head =
        item.kind === "message" && item.message.body === body
          ? item.startsGroup
          : item.kind === "pending" && item.pending.body === body
            ? item.startsGroup
            : undefined;
      if (head === undefined) continue;
      if (seen.length === 0 || seen[seen.length - 1] !== head) seen.push(head);
    }
  }
  return seen;
}

const on = (d: number, h: number, m: number, s = 0) => new Date(2026, 10, d, h, m, s).getTime();
let seq = 0;
const said = (author: string, body: string, createdAtMs: number): Message => {
  seq += 1;
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs,
  } as Message;
};

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (q: string) => ({
        matches: false,
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  }
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  resetServerClockForTests();
  clearAllDrafts();
  api.sendMessage.mockReset();
  out.renders = [];
  out.t = null;
  seq = 0;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  clearAllDrafts();
  vi.useRealTimers();
});

async function mount(first: Message[]): Promise<void> {
  api.fetchMessages.mockReset().mockResolvedValue({ messages: first, nextBefore: undefined });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe));
  });
}

/** 실시간으로 도착한 메시지(훅의 `applyBatch` — message.new와 같은 문). */
async function arrive(message: Message): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("oort.capture.message.new", { detail: message }));
  });
}

/** 지금 보내다 실패한 글 하나(연결 끊김). */
async function sendFailing(body: string): Promise<string> {
  api.sendMessage.mockRejectedValueOnce(new NetworkError("unreachable", 15_000));
  await act(async () => {
    await out.t!.send(body);
  });
  const row = out.t!.pending.find((p) => p.body === body);
  expect(row?.status).toBe("failed");
  return row!.clientMsgId;
}

describe("#5624 H1 — 밤에 못 보낸 글을 다음 날 다시 보내도 날 줄이 하나이고 제자리다(실제 훅)", () => {
  it("오늘 남의 말이 이미 있으면: 확정 순간 오늘 줄 아래에 어제 날 줄이 다시 서지 않는다(키 겹침 0)", async () => {
    vi.setSystemTime(on(9, 23, 55));
    await mount([said(PEER, "어제 남의 말", on(9, 23, 50))]);
    const failed = await sendFailing("실패했던 글");
    vi.setSystemTime(on(10, 9, 0));
    await arrive(said(PEER, "오늘 남의 말", on(10, 9, 0)));
    vi.setSystemTime(on(10, 9, 5));
    api.sendMessage.mockResolvedValueOnce(said(ME, "실패했던 글", on(10, 9, 5)));
    await act(async () => {
      await out.t!.resend(failed);
    });
    expect(out.t!.pending).toHaveLength(0);
    expect(everyRenderIssues()).toEqual([]);
    const days = out.renders.at(-1)!.filter((item) => item.kind === "day").map((item) => item.key);
    expect(days).toEqual([`day-${dayKey(on(9, 0, 0))}`, `day-${dayKey(on(10, 0, 0))}`]);
  });

  it("오늘 말이 없으면: 확정본 위에 오늘 날 줄이 서고, 뒤에 오는 오늘 말도 어제 날짜 아래에 놓이지 않는다", async () => {
    vi.setSystemTime(on(9, 23, 55));
    await mount([said(PEER, "어제 남의 말", on(9, 23, 50))]);
    const failed = await sendFailing("실패했던 글");
    vi.setSystemTime(on(10, 9, 5));
    api.sendMessage.mockResolvedValueOnce(said(ME, "실패했던 글", on(10, 9, 5)));
    await act(async () => {
      await out.t!.resend(failed);
    });
    vi.setSystemTime(on(10, 9, 6));
    await arrive(said(PEER, "그 뒤 남의 말", on(10, 9, 6)));
    expect(everyRenderIssues()).toEqual([]);
    const last = out.renders.at(-1)!;
    expect(last.filter((item) => item.kind === "day").map((item) => item.key)).toEqual([
      `day-${dayKey(on(9, 0, 0))}`,
      `day-${dayKey(on(10, 0, 0))}`,
    ]);
  });

  it("같은 날 몇 분 뒤 저절로 다시 나간 글(연결이 돌아옴)은 확정 순간에도 메아리 때의 이어진 줄을 지킨다", async () => {
    vi.setSystemTime(on(9, 10, 47, 10));
    await mount([]);
    api.sendMessage.mockResolvedValueOnce(said(ME, "앞 글", on(9, 10, 47, 10)));
    await act(async () => {
      await out.t!.send("앞 글");
    });
    vi.setSystemTime(on(9, 10, 47, 30));
    const failed = await sendFailing("이어 보낸 글");
    // 3분 뒤 연결이 돌아온다: 훅이 같은 멱등 키로 저절로 다시 보내고, 서버는 그때(10:50:31)를 찍는다.
    vi.setSystemTime(on(9, 10, 50, 30));
    api.sendMessage.mockResolvedValueOnce(said(ME, "이어 보낸 글", on(9, 10, 50, 31)));
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const posts = api.sendMessage.mock.calls.filter((call) => call[3] === "이어 보낸 글");
    expect(posts.map((call) => call[2])).toEqual([failed, failed]);
    expect(out.t!.pending).toHaveLength(0);
    expect(out.t!.state.messages.map((m) => m.body)).toEqual(["앞 글", "이어 보낸 글"]);
    expect(headHistory("이어 보낸 글")).toEqual([false]);
    expect(everyRenderIssues()).toEqual([]);
  });
});
