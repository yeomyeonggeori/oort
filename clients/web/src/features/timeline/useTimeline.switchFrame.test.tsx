// @vitest-environment jsdom
// #5678 — 대화를 바꾼 첫 렌더는 앞 대화의 상태를 내주지 않는다.
//
// 같은 훅 인스턴스가 대화만 바꿔 쓰인다(`c/:channelId` 라우트는 `ChatShell` 을 다시 만들지 않는다). 받아 둔 글을 비우는 것은 읽기 효과라서
// 대화를 바꾼 **첫 렌더**는 아직 앞 대화의 상태를 들고 있었다: 앞 대화에 글이 있으면 새 대화의 머리 아래 그 글이, 비어 있었으면(읽기가 끝나
// `ready` · 처음까지 닿음) 「…님과의 대화를 시작하세요」 빈 안내가 한 프레임 그려졌다(화소 실측: 누른 뒤 35~60ms). 이 시험은 렌더마다 훅이
// 내준 값을 적어, 새 대화의 렌더에 앞 대화의 글이나 「다 읽었는데 비었다」가 한 번도 나오지 않는지 본다. 렌더 단위의 사실이라 jsdom 으로 잰다
// (줄 높이 · 스크롤은 게이트 `gate-timeline-still.mjs` 의 진입 장면이 잰다).

import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { useTimeline } from "./useTimeline";

const WS = "00000000-0000-7000-8000-000000000001";
/** 글이 있는 대화(A) · 빈 대화(E) · 옮겨 가는 대화(B). */
const CH_A = "00000000-0000-7000-8000-0000000000a1";
const CH_E = "00000000-0000-7000-8000-0000000000e1";
const CH_B = "00000000-0000-7000-8000-0000000000b2";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";

const net = vi.hoisted(() => ({ rows: new Map<string, unknown[]>() }));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(async (_ws: string, channel: string) => ({ messages: net.rows.get(channel) ?? [], nextBefore: undefined })),
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
  };
});

interface Seen {
  channelId: string;
  status: string;
  reachedStart: boolean;
  channels: string[];
}
const renders: Seen[] = [];

function Probe({ channelId }: { channelId: string }): ReactElement {
  const t = useTimeline(null, WS, channelId, ME);
  // 렌더마다(효과가 아니라) 적는다: 그 렌더가 화면에 내놓을 값이다.
  renders.push({ channelId, status: t.status, reachedStart: t.reachedStart, channels: [...new Set(t.state.messages.map((m) => m.channelId))] });
  return createElement("div");
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
  }
});

beforeEach(() => {
  net.rows.clear();
  renders.length = 0;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function row(channelId: string, seq: number): Message {
  return {
    id: `0199${channelId.slice(-4)}-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId,
    seq,
    hlcTs: 1_000 + seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: `본문 ${seq}`,
    state: "sent",
    createdAtMs: 1_000 + seq,
  };
}

async function show(channelId: string): Promise<void> {
  if (host === null) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(createElement(Probe, { channelId }));
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** 대화 `channelId` 로 바꾼 뒤의 렌더들. */
const after = (channelId: string, from: number) => renders.slice(from).filter((seen) => seen.channelId === channelId);

describe("대화를 바꾼 첫 렌더 (#5678)", () => {
  it("글이 있는 대화에서 옮기면 새 대화의 어느 렌더에도 앞 대화의 글이 없고, 첫 렌더는 읽는 중이다", async () => {
    net.rows.set(CH_A, [row(CH_A, 1), row(CH_A, 2)]);
    net.rows.set(CH_B, [row(CH_B, 7)]);
    await show(CH_A);
    expect(renders.at(-1)).toMatchObject({ status: "ready", channels: [CH_A] });
    const mark = renders.length;
    await show(CH_B);
    const seen = after(CH_B, mark);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toMatchObject({ status: "loading", reachedStart: false, channels: [] });
    expect(seen.filter((one) => one.channels.includes(CH_A))).toEqual([]);
    expect(seen.at(-1)).toMatchObject({ status: "ready", channels: [CH_B] });
  });

  it("빈 대화에서 옮기면 새 대화를 「다 읽었는데 비었다」(ready · 처음까지 닿음 · 글 0)로 한 번도 내주지 않는다 — 빈 안내가 서는 모양", async () => {
    net.rows.set(CH_B, [row(CH_B, 7)]);
    await show(CH_E);
    expect(renders.at(-1)).toMatchObject({ status: "ready", reachedStart: true, channels: [] });
    const mark = renders.length;
    await show(CH_B);
    const seen = after(CH_B, mark);
    expect(seen[0]).toMatchObject({ status: "loading", reachedStart: false, channels: [] });
    expect(seen.filter((one) => one.status === "ready" && one.channels.length === 0)).toEqual([]);
    expect(seen.at(-1)).toMatchObject({ status: "ready", channels: [CH_B] });
  });

  it("같은 대화에 머무는 렌더는 그대로다(받아 둔 글을 비우지 않는다)", async () => {
    net.rows.set(CH_A, [row(CH_A, 1)]);
    await show(CH_A);
    const mark = renders.length;
    await show(CH_A);
    expect(after(CH_A, mark).every((one) => one.status === "ready" && one.channels.join() === CH_A)).toBe(true);
  });
});
