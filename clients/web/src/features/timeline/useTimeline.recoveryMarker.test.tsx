// @vitest-environment jsdom
// 복구 표지는 「복구가 **남의 새 메시지**를 들였을 때만」 선다(#4328, 폰 #4292 규칙을 코어로 올려 웹·데스크탑도).
// 실제 useTimeline 을 가짜 RealtimeHandle 로 굴려 훅의 통합 표면에서 잰다 — 판정 자체(대소문자·누계·id 집합)는
// 코어 `recoveryMarker.test.ts` 가 재고, 여기서는 **웹 훅이 그 판정에 올바른 줄을 올바른 때에 먹이는가**를 본다:
// 병합 전에 묻는가, 줄을 들이는 모든 길이 id 를 등록하는가, 되쏘기 창이 동기 flush 까지만 열리는가.
//
// 음성(표지가 서지 않는다) 시험은 전부 같은 파일의 양성(선다)과 짝이다 — 「없다」만 재는 시험은 표지 배선을 통째로
// 지워도 초록이다. 그래서 음성 시험은 끝에 대조군을 하나 더 얹는다: 같은 배선이 남의 새 줄에는 표지를 세운다.

import { createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import type { RecoveryMarker } from "@momo/core/features/timeline/model";
import { useTimeline, type ResumeInfo } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const OTHER_2 = "00000000-0000-7000-8000-000000000102";

/** 글자(e)가 든 id 라 대소문자를 바꾸면 실제로 다른 문자열이 된다. */
const id = (n: number) => `0199eeee-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ECHO = "0199eeee-0000-7000-8000-0000000000ec";
const CONTROL = id(900);

const rest = vi.hoisted(() => ({
  head: [] as unknown[],
  older: [] as unknown[],
  /** `?after` 읽기에 차례로 답한다. 비면 빈 페이지. Promise 를 넣으면 그 읽기를 붙잡아 둘 수 있다. */
  tail: [] as Array<unknown[] | Promise<unknown[]>>,
  tailReads: 0,
  echo: ((_body: string) => ({})) as (body: string) => unknown,
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(
      async (
        _workspaceId: string,
        _channelId: string,
        opts?: { before?: number; after?: number }
      ) => {
        if (opts?.before != null) {
          return { messages: rest.older, nextBefore: undefined };
        }
        if (opts?.after != null) {
          rest.tailReads += 1;
          const next = rest.tail.shift() ?? [];
          return { messages: await next };
        }
        return {
          messages: rest.head,
          nextBefore: rest.older.length > 0 ? 1 : undefined,
        };
      }
    ),
    sendMessage: vi.fn(
      async (_w: string, _c: string, _key: string, body: string) =>
        rest.echo(body)
    ),
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
  markers: RecoveryMarker[];
  resume: ResumeInfo | null;
  messages: Message[];
  status: string;
  loadOlder: (() => Promise<void>) | null;
  send: ((body: string) => Promise<void>) | null;
} = {
  markers: [],
  resume: null,
  messages: [],
  status: "loading",
  loadOlder: null,
  send: null,
};

function Probe({ me }: { me: string }): ReactElement {
  const t = useTimeline(realtime, WS, CH, me);
  useEffect(() => {
    out.markers = t.recoveryMarkers;
    out.resume = t.resume;
    out.messages = t.state.messages;
    out.status = t.status;
    out.loadOlder = t.loadOlder;
    out.send = t.send;
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

beforeEach(() => {
  rest.head = [];
  rest.older = [];
  rest.tail = [];
  rest.tailReads = 0;
  rest.echo = (body) => message(ECHO, 100, ME, body);
  out.markers = [];
  out.resume = null;
  out.messages = [];
  out.status = "loading";
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  rail.handlers = null;
});

/** REST 가 주는 모양(camelCase). */
function message(
  msgId: string,
  seq: number,
  author: string = OTHER,
  body = "확인했어요"
): Message {
  return {
    id: msgId,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1000,
  };
}

/** 레일이 주는 모양(snake_case 프레임). */
function frame(
  msgId: string,
  seq: number,
  author: string = OTHER,
  type = "message.new",
  body = "확인했어요"
) {
  return {
    type,
    v: 1,
    ts: 1_700_000_000_000 + seq * 1000,
    seq,
    payload: {
      id: msgId,
      channel_id: CH,
      seq,
      hlc_ts: seq,
      hlc_count: 0,
      author_member_id: author,
      type: "text",
      body,
      state: "sent",
      created_at_ms: 1_700_000_000_000 + seq * 1000,
    },
  } as unknown as Parameters<NonNullable<Handlers["onMessage"]>>[0];
}

const tick = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

async function mount(me: string = ME): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe, { me }));
  });
  await tick();
  expect(out.status).toBe("ready");
}

/** 첫 구독. 표지는 없다(끊겼던 구간이 없다) — 꼬리 읽기 한 번이 `rest.tail` 에서 한 칸을 먹는다. */
async function subscribeFirst(): Promise<void> {
  await act(async () => {
    rail.handlers?.onSubscribed({ recovered: false });
  });
  await tick();
}

/** 복구되지 않은 재구독 — REST `?after` 로 꼬리를 메운다. */
async function resubscribeNotRecovered(): Promise<void> {
  await act(async () => {
    rail.handlers?.onSubscribed({ recovered: false });
  });
  await tick();
}

/**
 * 레일이 끊겼다 붙고 끊긴 구간을 되쏜다. centrifuge-js 는 되쏜 publication 을 `subscribed` 직후 **같은 호출 스택**에서
 * 흘리므로 둘은 한 `act` 몸통 안에서 동기로 부른다.
 */
async function replay(frames: ReturnType<typeof frame>[] = []): Promise<void> {
  await act(async () => {
    rail.handlers?.onSubscribed({ recovered: true });
    for (const f of frames) rail.handlers?.onMessage(f);
  });
  await tick();
}

/** 이미 있던 줄이 실시간으로 먼저 닿는다. */
async function live(f: ReturnType<typeof frame>): Promise<void> {
  await act(async () => {
    rail.handlers?.onMessage(f);
  });
}

/**
 * 대조군. 같은 배선이 남의 새 줄에는 표지를 **세운다.** 바로 앞의 「표지가 없다」가 배선이 죽어서 없는 것이 아님을 보인다.
 */
async function expectMarkerStillRaised(): Promise<void> {
  await replay([frame(CONTROL, 9_000, OTHER_2)]);
  expect(out.markers).toHaveLength(1);
  expect(out.markers[0]).toMatchObject({ source: "replay" });
}

describe("복구 표지 — 남의 새 메시지를 들였을 때만 선다 (#4328)", () => {
  describe("양성: 복구가 남의 새 줄을 들였다", () => {
    it("되쏘기가 남의 새 줄을 실어 오면 표지가 선다 — replay, 가장 새 seq 까지", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();

      await replay([frame(id(2), 2), frame(id(3), 3, OTHER_2)]);

      expect(out.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
      expect(out.markers).toHaveLength(1);
      expect(out.markers[0]).toMatchObject({ source: "replay", seq: 3 });
    });

    it("꼬리 읽기가 남의 새 줄을 가져오면 표지가 선다 — backfill", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();

      rest.tail = [[message(id(2), 2), message(id(3), 3, OTHER_2)]];
      await resubscribeNotRecovered();

      expect(out.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
      expect(out.resume?.lastBackfillCount).toBe(2);
      expect(out.markers).toHaveLength(1);
      expect(out.markers[0]).toMatchObject({ source: "backfill", seq: 3 });
    });

    it("꼬리가 두 페이지로 와도 첫 페이지의 남의 새 줄이 지워지지 않는다 — 판정은 페이지를 이어 누계한다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();

      // 한 페이지(50줄)가 가득 차면 다음 페이지를 이어 읽는다. 남의 새 줄은 첫 페이지에만 있고, 둘째 페이지는 내 줄뿐이다.
      const firstPage = Array.from({ length: 50 }, (_, i) =>
        message(id(100 + i), 100 + i, i === 0 ? OTHER : ME)
      );
      rest.tail = [firstPage, [message(id(200), 200, ME)]];
      const readsBefore = rest.tailReads;
      await resubscribeNotRecovered();

      expect(rest.tailReads - readsBefore).toBe(2);
      expect(out.resume?.lastBackfillCount).toBe(51);
      expect(out.markers).toHaveLength(1);
      expect(out.markers[0]).toMatchObject({ source: "backfill", seq: 200 });
    });

    it("남의 줄이 내 줄보다 작은 seq 로 뒤늦게 닿아도 선다 — 새것은 seq 가 아니라 id 로 가린다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();
      // 내 확정 응답이 가장 새 seq(100)를 이미 쥐고 있다.
      await act(async () => {
        await out.send?.("안녕하세요");
      });
      expect(out.messages.map((m) => m.id)).toContain(ECHO);

      // 남의 줄(seq 99)은 그보다 작지만 이 타임라인에는 처음이다. 내 줄(seq 100)은 이미 들어 있다.
      await replay([
        frame(id(99), 99, OTHER),
        frame(ECHO, 100, ME, "message.new", "안녕하세요"),
      ]);

      expect(out.messages.map((m) => m.seq)).toEqual([1, 99, 100]);
      expect(out.markers).toHaveLength(1);
      expect(out.markers[0]).toMatchObject({ source: "replay" });
    });
  });

  describe("음성: 복구가 들인 것이 없거나 남의 새 줄이 아니다", () => {
    it("처음 연 구독은 남의 새 줄을 가져와도 표지를 세우지 않는다 — 끊겼던 구간이 없다", async () => {
      rest.head = [message(id(1), 1)];
      rest.tail = [[message(id(2), 2)]];
      await mount();
      await subscribeFirst();

      expect(out.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("되쏜 것이 없다(recovered 인데 publication 이 비었다) — 몇 번을 이어 붙어도 표지가 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();

      // `recovered: true` 는 「끊긴 구간을 이을 수 있었다」일 뿐 그 구간에 무엇이 있었다는 말이 아니다.
      await replay();
      await replay();
      await replay();

      expect(out.resume?.resubscribeCount).toBe(3);
      expect(out.resume?.lastRecovered).toBe(true);
      expect(out.messages.map((m) => m.seq)).toEqual([1]);
      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("꼬리를 읽었더니 빈손이다 — 재구독마다 읽었지만 표지가 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();
      const readsBefore = rest.tailReads;

      await resubscribeNotRecovered();
      await resubscribeNotRecovered();

      // 읽기가 정말 일어났다(빈손이 「읽지 않음」이 아님을 센다).
      expect(rest.tailReads - readsBefore).toBe(2);
      expect(out.resume?.lastBackfillCount).toBe(0);
      expect(out.messages.map((m) => m.seq)).toEqual([1]);
      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("되쏘기에 실려 온 것이 내 줄뿐이다 — 줄은 들어오고 표지는 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();

      await replay([frame(id(2), 2, ME), frame(id(3), 3, ME)]);

      expect(out.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("내 확정 응답이 먼저 들어와 있었다 — 같은 줄이 되쏘기로 또 와도 표지가 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();
      await act(async () => {
        await out.send?.("안녕하세요");
      });
      expect(out.messages.map((m) => m.id)).toContain(ECHO);

      await replay([frame(ECHO, 100, ME, "message.new", "안녕하세요")]);

      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("꼬리 읽기가 가져온 것이 내 줄뿐이다 — 가져온 수는 그대로 세고 표지는 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();

      rest.tail = [[message(id(2), 2, ME), message(id(3), 3, ME)]];
      await resubscribeNotRecovered();

      expect(out.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
      expect(out.resume?.lastBackfillCount).toBe(2);
      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("읽는 사이 내 확정 응답이 먼저 들어왔다 — 같은 줄이 꼬리 읽기에도 실려 와도 표지가 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();

      // 재구독의 꼬리 읽기를 붙잡아 둔다.
      let release: (rows: unknown[]) => void = () => undefined;
      rest.tail = [
        new Promise<unknown[]>((resolve) => {
          release = resolve;
        }),
      ];
      await act(async () => {
        rail.handlers?.onSubscribed({ recovered: false });
      });
      // 읽는 동안 내 확정 응답이 같은 줄을 먼저 들인다.
      await act(async () => {
        await out.send?.("안녕하세요");
      });
      await act(async () => {
        release([message(ECHO, 100, ME, "안녕하세요")]);
      });
      await tick();

      expect(out.resume?.lastBackfillCount).toBe(1);
      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("남의 줄이라도 이미 든 줄이면 — 되쏘기에 또 실려 와도 — 표지가 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();
      await live(frame(id(2), 2));
      expect(out.messages.map((m) => m.seq)).toEqual([1, 2]);

      await replay([frame(id(2), 2)]);

      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("읽는 사이 남의 줄이 실시간으로 먼저 들어왔다 — 같은 줄이 꼬리 읽기에도 실려 와도 표지가 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();

      let release: (rows: unknown[]) => void = () => undefined;
      rest.tail = [
        new Promise<unknown[]>((resolve) => {
          release = resolve;
        }),
      ];
      await act(async () => {
        rail.handlers?.onSubscribed({ recovered: false });
      });
      await live(frame(id(2), 2));
      await act(async () => {
        release([message(id(2), 2)]);
      });
      await tick();

      expect(out.resume?.lastBackfillCount).toBe(1);
      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("위로 더 읽은 줄(loadOlder)의 수정 프레임이 되쏘기로 와도 표지가 없다 — 그 쪽의 id 도 이미 든 것이다", async () => {
      rest.head = [message(id(10), 10), message(id(11), 11)];
      rest.older = [message(id(8), 8), message(id(9), 9)];
      await mount();
      await subscribeFirst();
      await act(async () => {
        await out.loadOlder?.();
      });
      expect(out.messages.map((m) => m.seq)).toEqual([8, 9, 10, 11]);

      // 끊긴 사이 남이 그 오래된 줄(seq 8)을 고쳤다 — 새 줄이 아니라 이미 든 줄의 수정이다.
      await replay([frame(id(8), 8, OTHER, "message.edited", "고쳐 썼어요")]);

      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("작성자 id 의 대소문자가 달라도 내 줄이다 — 표지가 없다", async () => {
      const me = "AbCdEf12-0000-7000-8000-0000000001ff";
      rest.head = [message(id(1), 1)];
      await mount(me);
      await subscribeFirst();

      await replay([frame(id(2), 2, me.toLowerCase())]);

      expect(out.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("줄 id 의 대소문자가 달라도 이미 든 줄이다 — 소문자로 든 줄이 대문자로 되쏘여 와도 표지가 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();
      await live(frame(id(2), 2));

      await replay([frame(id(2).toUpperCase(), 2)]);

      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("줄 id 의 대소문자가 달라도 이미 든 줄이다 — 대문자로 든 줄이 소문자로 되쏘여 와도 표지가 없다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();
      await live(frame(id(2).toUpperCase(), 2));

      await replay([frame(id(2), 2)]);

      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });

    it("되쏘기 창은 동기 flush 까지다 — 그 뒤에 닿은 남의 실시간 줄은 복구한 것이 아니다", async () => {
      rest.head = [message(id(1), 1)];
      await mount();
      await subscribeFirst();

      await act(async () => {
        rail.handlers?.onSubscribed({ recovered: true });
        // 마이크로태스크 경계 — 되쏘기 flush 는 끝났고 창이 닫힌다.
        await Promise.resolve();
        // 그 뒤 다음 매크로태스크 전에 닿은 실시간 줄. 되쏜 것이 아니라 방금 온 것이다.
        rail.handlers?.onMessage(frame(id(2), 2));
      });
      await tick();

      expect(out.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(out.markers).toEqual([]);
      await expectMarkerStillRaised();
    });
  });
});
