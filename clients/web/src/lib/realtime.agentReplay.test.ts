import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProgressEvent } from "@momo/core/lib/realtimeEvents";

// =============================================================================
// `subscribeAgent`의 replay 게이트에 뚫린 **하나의 구멍**을 잠근다 (goal WEB-WP1).
//
// agent 네임스페이스는 서버에서 force_recovery다(infra/centrifugo.json). 그래서
// 재구독은 끊긴 동안의 프레임을 통째로 되재생하고, 그걸 그대로 접으면 이미 끝난
// 턴이 시계를 달고 화면에 되살아난다 — 그래서 배치를 버린다. 그런데 **그 배치가
// 곧, 끊긴 사이에 끝난 턴의 종료 프레임이 다시 제안되는 유일한 자리**이기도
// 하다. 노트북 뚜껑을 1분 닫았다 열면 그 사이 끝난 run의 종료를 우리는 영영 못
// 보고, 사이드바 배지와 컴포저 줄은 90초 TTL이 쓸어 갈 때까지 「작업 중」을
// 주장한다. 작업 패널은 그것을 더 나쁘게 만든다: 사람이 **읽고 있는** 표면에
// 살아 있는 상태 칩이 남는다.
//
// RN이 같은 구멍을 같은 core 술어로 이미 뚫었다(clients/mobile channelRail.ts,
// issue 994 2R H1). 두 클라가 "이 턴이 끝났는가"에 다르게 답하지 않도록 웹도 그것을
// 쓴다. 안전한 이유는 `isTerminalProgressFrame`의 주석에 있다: 종료 프레임을
// 접는 경로는 run 표에서 **지우기만** 하므로 턴을 만들 수도, 새로고칠 수도,
// 시계를 움직일 수도 없다.
// =============================================================================

type PublicationHandler = (ctx: { data?: unknown }) => void;
type SubscribedHandler = (ctx: { recovered?: boolean }) => void;

const mocks = vi.hoisted(() => ({
  /** 마지막으로 만들어진 가짜 구독. 테스트가 여기에 프레임을 흘린다. */
  sub: null as null | {
    state: string;
    handlers: { subscribed: SubscribedHandler[]; publication: PublicationHandler[] };
    on: (name: string, fn: unknown) => void;
    off: (name: string, fn: unknown) => void;
    subscribe: () => void;
    unsubscribe: () => void;
  },
}));

vi.mock("centrifuge", () => {
  class FakeCentrifuge {
    on(): void {}
    connect(): void {}
    disconnect(): void {}
    getSubscription(): null {
      return null;
    }
    newSubscription() {
      const handlers: {
        subscribed: SubscribedHandler[];
        publication: PublicationHandler[];
      } = { subscribed: [], publication: [] };
      const sub = {
        state: "unsubscribed",
        handlers,
        on(name: string, fn: unknown) {
          if (name === "subscribed") handlers.subscribed.push(fn as SubscribedHandler);
          if (name === "publication") handlers.publication.push(fn as PublicationHandler);
        },
        off(name: string, fn: unknown) {
          const list = name === "subscribed" ? handlers.subscribed : handlers.publication;
          const index = list.indexOf(fn as never);
          if (index >= 0) list.splice(index, 1);
        },
        subscribe() {
          sub.state = "subscribed";
        },
        unsubscribe() {
          sub.state = "unsubscribed";
        },
      };
      mocks.sub = sub;
      return sub;
    }
    removeSubscription(): void {}
  }
  return { Centrifuge: FakeCentrifuge };
});

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const AGENT = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const RUN = "9F1C8B2A-0000-7000-8000-00000000RUN1";

function status(
  phase: string,
  runStatus: string
): AgentProgressEvent {
  return {
    type: "agent.status",
    v: 1,
    ts: Date.now(),
    payload: {
      run_id: RUN,
      agent_member_id: AGENT,
      channel_id: CHANNEL,
      phase,
      run_status: runStatus,
    },
  } as AgentProgressEvent;
}

function partial(text: string): AgentProgressEvent {
  return {
    type: "agent.partial",
    v: 1,
    ts: Date.now(),
    payload: { run_id: RUN, channel_id: CHANNEL, text_delta: text },
  };
}

/**
 * 실물 그대로의 재생 순서. centrifuge-js는 회복된 publication을
 * `subscribed` 직후 **동기적으로** 흘리고(`_handleSubscribeResult`), 게이트는
 * 다음 마이크로태스크에서 내려간다. 그래서 배치는 await 없이 이어 붙인다.
 */
function replayBatch(frames: readonly AgentProgressEvent[]): void {
  const sub = mocks.sub;
  if (!sub) throw new Error("no subscription was created");
  for (const fn of sub.handlers.subscribed) fn({ recovered: true });
  for (const frame of frames) {
    for (const fn of sub.handlers.publication) fn({ data: frame });
  }
}

function liveFrame(frame: AgentProgressEvent): void {
  const sub = mocks.sub;
  if (!sub) throw new Error("no subscription was created");
  for (const fn of sub.handlers.publication) fn({ data: frame });
}

async function subscribe(): Promise<{
  seen: AgentProgressEvent[];
  stop: () => void;
}> {
  const { createRealtime } = await import("./realtime");
  const handle = createRealtime("ws://replay.invalid/connection/websocket", () => {});
  const seen: AgentProgressEvent[] = [];
  const stop = handle.subscribeAgent(WORKSPACE, CHANNEL, AGENT, {
    onEvent: (event) => seen.push(event),
  });
  return { seen, stop };
}

beforeEach(() => {
  mocks.sub = null;
  vi.resetModules();
});

describe("subscribeAgent replay gate", () => {
  it("회복 배치의 진행 프레임은 버린다 (끝난 턴을 되살리지 않는다)", async () => {
    const { seen, stop } = await subscribe();
    replayBatch([
      status("thinking", "running"),
      partial("끊긴 사이에 흘러간 부분 응답"),
      status("streaming", "running"),
    ]);
    expect(seen).toHaveLength(0);
    stop();
  });

  it("회복 배치의 종료 프레임은 통과시킨다 (그 자리가 유일한 기회다)", async () => {
    const { seen, stop } = await subscribe();
    replayBatch([
      status("thinking", "running"),
      partial("중간 조각"),
      status("done", "succeeded"),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("agent.status");
    expect((seen[0] as { payload: { run_status: string } }).payload.run_status).toBe(
      "succeeded"
    );
    stop();
  });

  it("phase가 error로 끝난 프레임도 종료 프레임이다", async () => {
    const { seen, stop } = await subscribe();
    replayBatch([status("error", "running")]);
    expect(seen).toHaveLength(1);
    stop();
  });

  it("`agent.partial`은 종료 프레임이 될 수 없다", async () => {
    const { seen, stop } = await subscribe();
    // 종료를 말할 수 있는 필드(`run_status`)가 이 프레임에는 없다. 재생된
    // partial에는 참으로 남은 말이 하나도 없으므로 예외에 끼지 않는다.
    replayBatch([partial("긴 답의 마지막 조각")]);
    expect(seen).toHaveLength(0);
    stop();
  });

  it("게이트가 내려간 뒤의 라이브 프레임은 전부 통과한다", async () => {
    const { seen, stop } = await subscribe();
    replayBatch([status("thinking", "running")]);
    expect(seen).toHaveLength(0);
    // 게이트는 다음 마이크로태스크에서 내려간다.
    await Promise.resolve();
    liveFrame(status("streaming", "running"));
    liveFrame(partial("라이브 조각"));
    expect(seen).toHaveLength(2);
    stop();
  });

  it("회복이 아닌 구독은 아무것도 막지 않는다", async () => {
    const { seen, stop } = await subscribe();
    const sub = mocks.sub;
    if (!sub) throw new Error("no subscription");
    for (const fn of sub.handlers.subscribed) fn({ recovered: false });
    liveFrame(status("thinking", "running"));
    expect(seen).toHaveLength(1);
    stop();
  });

  it("agent 프레임이 아닌 것은 어느 쪽으로도 새지 않는다", async () => {
    const { seen, stop } = await subscribe();
    const sub = mocks.sub;
    if (!sub) throw new Error("no subscription");
    for (const fn of sub.handlers.subscribed) fn({ recovered: false });
    for (const fn of sub.handlers.publication) {
      fn({ data: { type: "message.new", v: 1, ts: Date.now(), payload: {} } });
      fn({ data: { type: "agent.status", v: 1, ts: Date.now() } }); // payload 없음
      fn({ data: undefined });
    }
    expect(seen).toHaveLength(0);
    stop();
  });
});
