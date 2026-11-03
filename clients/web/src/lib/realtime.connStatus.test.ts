import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeStatus } from "@momo/core/lib/realtimeEvents";

// #786 / #5201: 소켓의 `connecting`은 읽는 사람에게 두 가지를 뜻하고 centrifuge-js에게는 하나다.
// 첫 `connected` 전의 `connecting`은 여는 중의 핸드셰이크이고 「연결 중」이 맞다. 한 번 붙은 뒤의
// `connecting`은 모든 끊김마다 들어가는 재연결 고리라, 사용자에게는 「연결이 아님」이다. `createRealtime`이
// 그 둘을 가른다(MOMO-613, `everConnected`). 연결 상태 모델(`@momo/core/features/connection/model`)은
// 이 매핑을 전제로 `connecting`과 `disconnected`를 같은 틈으로 읽는다. 이 시험이 그 매핑을 고정한다.
//
// 가짜 centrifuge는 `on(이름, 처리기)`로 처리기를 기억해, 시험이 `connecting`·`connected`·`disconnected`를
// 손으로 쏠 수 있게 한다(다른 realtime 시험의 가짜는 처리기를 버린다).

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
}));

vi.mock("centrifuge", () => {
  class FakeCentrifuge {
    on(name: string, handler: () => void): void {
      mocks.handlers.set(name, handler);
    }
    connect(): void {}
    disconnect(): void {}
    getSubscription(): null {
      return null;
    }
    removeSubscription(): void {}
  }
  return { Centrifuge: FakeCentrifuge };
});

beforeEach(() => {
  mocks.handlers.clear();
  vi.resetModules();
});

type Raw = "connecting" | "connected" | "disconnected";

async function rail(): Promise<{ reported: RealtimeStatus[]; emit: (raw: Raw) => void }> {
  const { createRealtime } = await import("./realtime");
  const reported: RealtimeStatus[] = [];
  createRealtime("ws://status.invalid/connection/websocket", (status) => reported.push(status));
  return {
    reported,
    emit(raw) {
      const handler = mocks.handlers.get(raw);
      if (handler === undefined) throw new Error(`createRealtime registered no "${raw}" handler`);
      handler();
    },
  };
}

describe("createRealtime 상태 매핑 (#786)", () => {
  it("첫 연결 전의 connecting은 connecting으로 남는다(여는 중의 핸드셰이크)", async () => {
    const { reported, emit } = await rail();
    emit("connecting");
    emit("connecting");
    emit("connecting");
    expect(reported).toEqual(["connecting", "connecting", "connecting"]);
  });

  it("한 번 붙은 뒤의 connecting은 disconnected로 보고하고, 다시 붙으면 connected다", async () => {
    const { reported, emit } = await rail();
    emit("connecting");
    emit("connected");
    emit("connecting");
    emit("connected");
    expect(reported).toEqual(["connecting", "connected", "disconnected", "connected"]);
  });

  it("centrifuge가 알리는 disconnected는 첫 연결 전이든 뒤든 disconnected 그대로다", async () => {
    const before = await rail();
    before.emit("disconnected");
    expect(before.reported).toEqual(["disconnected"]);

    mocks.handlers.clear();
    const after = await rail();
    after.emit("connected");
    after.emit("disconnected");
    expect(after.reported).toEqual(["connected", "disconnected"]);
  });
});
