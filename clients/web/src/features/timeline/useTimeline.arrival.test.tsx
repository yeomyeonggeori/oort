// @vitest-environment jsdom
// Drives the real useTimeline through a fake RealtimeHandle and measures
// the arrival counts ADR-0179 D3 claims, at the hook's integration surface.

import { createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { MAX_PENDING_ARRIVAL_GRANTS } from "@momo/core/features/timeline/arrival";
import { useTimeline } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const CH2 = "00000000-0000-7000-8000-000000000003";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";

const restPage = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(async () => ({
      messages: restPage.messages,
      nextBefore: undefined,
    })),
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
  };
});

type Handlers = Parameters<RealtimeHandle["subscribeChannel"]>[2];
const rail: { handlers: Handlers | null } = { handlers: null };

const realtime = {
  subscribeChannel: (_ws: string, _ch: string, handlers: Handlers) => {
    rail.handlers = handlers;
    return () => {
      rail.handlers = null;
    };
  },
  subscribeAgent: () => () => undefined,
  subscribeTyping: () => () => undefined,
  subscribeWorkSession: () => () => undefined,
  subscribeCascade: () => () => undefined,
  subscribeHuddle: () => () => undefined,
  reconnect: () => undefined,
  dispose: () => undefined,
} as unknown as RealtimeHandle;

const out: {
  isPlayEntrance: ((id: string) => boolean) | null;
  consume: ((id: string) => void) | null;
  messages: Message[];
} = { isPlayEntrance: null, consume: null, messages: [] };

function Probe({ channelId }: { channelId: string }): ReactElement {
  const t = useTimeline(realtime, WS, channelId, ME);
  useEffect(() => {
    out.isPlayEntrance = t.isPlayEntrance;
    out.consume = t.consumeEntrance;
    out.messages = t.state.messages;
  });
  return createElement("div");
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function defaultMatchMedia(q: string) {
  return {
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: defaultMatchMedia,
    });
  }
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  rail.handlers = null;
  restPage.messages = [];
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: defaultMatchMedia,
  });
});

async function mount(channelId = CH): Promise<void> {
  if (host === null) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(createElement(Probe, { channelId }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function frame(id: string, author: string, seq: number, type = "message.new") {
  return {
    type,
    v: 1,
    ts: Date.now(),
    seq,
    payload: {
      id,
      channel_id: CH,
      seq,
      hlc_ts: Date.now(),
      hlc_count: 0,
      author_member_id: author,
      type: "text",
      body: "새 메시지 도착 arrival",
      state: "sent",
      created_at_ms: Date.now(),
    },
  } as unknown as Parameters<NonNullable<Handlers["onMessage"]>>[0];
}

const ID_LIVE = "0199cccc-0000-7000-8000-000000000301";
const ID_SELF = "0199cccc-0000-7000-8000-000000000302";
const ID_REST = "0199cccc-0000-7000-8000-000000000303";

function restMessage(id: string, seq: number): Message {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: "히스토리 행",
    state: "sent",
    createdAtMs: 1,
  };
}

describe("useTimeline arrival counts", () => {
  it("초기 REST 로드 = 0", async () => {
    restPage.messages = [restMessage(ID_REST, 1)];
    await mount();
    expect(out.messages.length).toBe(1);
    expect(out.isPlayEntrance?.(ID_REST)).toBe(false);
  });

  it("실시간 타 사용자 도착 = 1, 소비 후 0", async () => {
    await mount();
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
    });
    await act(async () => {
      rail.handlers?.onMessage(frame(ID_LIVE, OTHER, 10));
    });
    expect(out.isPlayEntrance?.(ID_LIVE)).toBe(true);
    act(() => out.consume?.(ID_LIVE));
    expect(out.isPlayEntrance?.(ID_LIVE)).toBe(false);
    await act(async () => {
      rail.handlers?.onMessage(frame(ID_LIVE, OTHER, 10));
    });
    expect(out.isPlayEntrance?.(ID_LIVE)).toBe(false);
  });

  it("자기 메시지 실시간 도착 = 0", async () => {
    await mount();
    await act(async () => {
      rail.handlers?.onMessage(frame(ID_SELF, ME, 11));
    });
    expect(out.isPlayEntrance?.(ID_SELF)).toBe(false);
  });

  it("message.edited = 0", async () => {
    await mount();
    await act(async () => {
      rail.handlers?.onMessage(frame(ID_LIVE, OTHER, 12, "message.edited"));
    });
    expect(out.isPlayEntrance?.(ID_LIVE)).toBe(false);
  });

  it("리플레이 게이트(recovered=true, 동기 플러시) = 0", async () => {
    await mount();
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: true });
      rail.handlers?.onMessage(frame(ID_LIVE, OTHER, 13));
    });
    expect(out.isPlayEntrance?.(ID_LIVE)).toBe(false);
  });

  it("부분 복구(recovered=false, hasRecoveredPublications=true) 는 0", async () => {
    await mount();
    await act(async () => {
      rail.handlers?.onSubscribed({
        recovered: false,
        hasRecoveredPublications: true,
      });
      rail.handlers?.onMessage(frame(ID_LIVE, OTHER, 14));
    });
    expect(out.isPlayEntrance?.(ID_LIVE)).toBe(false);
  });

  it("이미 들고 있는 REST 행의 라이브 에코 = 0", async () => {
    restPage.messages = [restMessage(ID_REST, 1)];
    await mount();
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
      rail.handlers?.onMessage(frame(ID_REST, OTHER, 1));
    });
    expect(out.isPlayEntrance?.(ID_REST)).toBe(false);
  });

  it("백로그: 마운트되지 않은 라이브 도착은 상한만 남긴다", async () => {
    await mount();
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
      for (let i = 0; i < 50; i += 1) {
        rail.handlers?.onMessage(
          frame(
            `0199dddd-0000-7000-8000-0000000004${String(i).padStart(2, "0")}`,
            OTHER,
            100 + i
          )
        );
      }
    });
    let granted = 0;
    for (let i = 0; i < 50; i += 1) {
      if (
        out.isPlayEntrance?.(
          `0199dddd-0000-7000-8000-0000000004${String(i).padStart(2, "0")}`
        )
      )
        granted += 1;
    }
    expect(MAX_PENDING_ARRIVAL_GRANTS).toBe(1);
    expect(granted).toBe(MAX_PENDING_ARRIVAL_GRANTS);
    expect(
      out.isPlayEntrance?.("0199dddd-0000-7000-8000-000000000449")
    ).toBe(true);
  });

  it("채널 전환은 남은 grant 를 버린다", async () => {
    await mount(CH);
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
      rail.handlers?.onMessage(frame(ID_LIVE, OTHER, 20));
    });
    expect(out.isPlayEntrance?.(ID_LIVE)).toBe(true);
    await mount(CH2);
    expect(out.isPlayEntrance?.(ID_LIVE)).toBe(false);
  });

  it("reduced-motion = 0", async () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (q: string) => ({
        matches: q.includes("reduced-motion"),
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    await mount();
    await act(async () => {
      rail.handlers?.onMessage(frame(ID_LIVE, OTHER, 15));
    });
    expect(out.isPlayEntrance?.(ID_LIVE)).toBe(false);
  });
});
