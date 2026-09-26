import { describe, expect, it } from "vitest";
import {
  PTY_ACK_BATCH_BYTES,
  PTY_WRITE_MAX_BYTES,
  chunkBytes,
  createAckBatcher,
  type AckScheduler,
} from "./ptyFlow";

function manualScheduler() {
  const timers = new Map<number, () => void>();
  let next = 1;
  const scheduler: AckScheduler = {
    schedule: (run) => {
      const id = next++;
      timers.set(id, run);
      return id;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
  };
  const tick = () => {
    const runs = [...timers.values()];
    timers.clear();
    runs.forEach((run) => run());
  };
  return { scheduler, tick, pending: () => timers.size };
}

describe("ack 묶음(#2824 R1: 조각마다 ack하면 RSS 700 MB)", () => {
  it("한 틱에 온 1 KiB 조각 100개는 ack 한 번(100 KiB 미만이면 시간으로)", () => {
    const sent: number[] = [];
    const { scheduler, tick } = manualScheduler();
    const batcher = createAckBatcher((n) => sent.push(n), scheduler);
    for (let i = 0; i < 50; i++) batcher.add(1024);
    expect(sent).toEqual([]);
    tick();
    expect(sent).toEqual([50 * 1024]);
  });

  it("64 KiB에 이르면 시간을 기다리지 않고 보낸다", () => {
    const sent: number[] = [];
    const { scheduler, tick, pending } = manualScheduler();
    const batcher = createAckBatcher((n) => sent.push(n), scheduler);
    for (let i = 0; i < 100; i++) batcher.add(1024);
    // 1 KiB 조각 100개에 ack는 64 KiB 한 번뿐이다. 나머지는 타이머 하나가 든다.
    expect(sent).toEqual([PTY_ACK_BATCH_BYTES]);
    expect(pending()).toBe(1);
    tick();
    expect(sent).toEqual([PTY_ACK_BATCH_BYTES, 100 * 1024 - PTY_ACK_BATCH_BYTES]);
  });

  it("dispose 뒤에는 아무것도 보내지 않는다(세션이 끝난 뒤 ack는 거부된다)", () => {
    const sent: number[] = [];
    const { scheduler, tick } = manualScheduler();
    const batcher = createAckBatcher((n) => sent.push(n), scheduler);
    batcher.add(10);
    batcher.dispose();
    batcher.add(10);
    tick();
    expect(sent).toEqual([]);
  });
});

describe("붙여넣기 조각", () => {
  it("1.5 MiB는 1 MiB 이하 두 조각으로, 바이트를 잃지 않고", () => {
    const big = new Uint8Array(PTY_WRITE_MAX_BYTES + PTY_WRITE_MAX_BYTES / 2).map((_, i) => i % 251);
    const parts = chunkBytes(big);
    expect(parts.map((p) => p.length)).toEqual([PTY_WRITE_MAX_BYTES, PTY_WRITE_MAX_BYTES / 2]);
    const joined = new Uint8Array(big.length);
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    expect(joined).toEqual(big);
  });

  it("작은 입력은 한 조각, 빈 입력은 없음", () => {
    expect(chunkBytes(new Uint8Array(3)).length).toBe(1);
    expect(chunkBytes(new Uint8Array(0))).toEqual([]);
  });
});
