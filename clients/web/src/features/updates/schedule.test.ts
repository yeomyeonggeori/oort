import { describe, expect, it } from "vitest";
import {
  RECHECK_INTERVAL_MS,
  RETRY_AFTER_FAILURE_MS,
  SCHEDULE_TICK_MS,
  WAKE_RECHECK_GAP_MS,
  startUpdateSchedule,
  type ScheduledCheckResult,
} from "./schedule";

// 켜 둔 앱이 새 버전을 알아채기까지의 상한 (#5661). 가짜 맥: 벽시계와, 시험이 말할 때만 도는 타이머 줄.
// 맥이 자는 동안 웹뷰의 타이머는 서 있다(단조 시계). 그래서 `sleep`은 벽시계만 옮기고 타이머의 마감도 같이 민다 — 깬 뒤 첫 타이머는
// 벽시계로 그만큼 늦게 깬다.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function fakeMac(results: ScheduledCheckResult[] = []) {
  let now = Date.UTC(2026, 10, 11, 3, 0, 0);
  const started = now;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const checks: number[] = [];
  const deps = {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      seq += 1;
      timers.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    check: async (): Promise<ScheduledCheckResult> => {
      checks.push(now);
      return results.shift() ?? "current";
    },
  };
  return {
    deps,
    checks,
    /** 지금까지 흐른 벽시계(시작부터). */
    elapsed: () => now - started,
    pendingTimers: () => timers.size,
    /** 깨어 있는 `ms` 동안: 시계가 흐르고, 마감이 된 타이머가 차례로 돈다. */
    async awake(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; run: () => void }] | null = null;
        for (const entry of timers) if (next === null || entry[1].at < next[1].at) next = entry;
        if (next === null || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
        await settle();
      }
      now = end;
      await settle();
    },
    /** 자는 `ms` 동안: 벽시계만 흐르고, 타이머는 서 있다(마감이 그만큼 밀린다). */
    sleep(ms: number): void {
      now += ms;
      for (const timer of timers.values()) timer.at += ms;
    },
  };
}

describe("startUpdateSchedule (#5661)", () => {
  it("뜨자마자 한 번 묻고, 깨어 있는 동안 다음 확인은 6시간 + 시계 한 칸 안이다", async () => {
    const mac = fakeMac();
    startUpdateSchedule(mac.deps);
    await settle();
    expect(mac.checks).toHaveLength(1);

    await mac.awake(RECHECK_INTERVAL_MS - SCHEDULE_TICK_MS);
    expect(mac.checks).toHaveLength(1);

    await mac.awake(2 * SCHEDULE_TICK_MS);
    expect(mac.checks).toHaveLength(2);
    const gap = (mac.checks[1] ?? 0) - (mac.checks[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(RECHECK_INTERVAL_MS);
    expect(gap).toBeLessThanOrEqual(RECHECK_INTERVAL_MS + SCHEDULE_TICK_MS);
  });

  it("엿새 동안 켜 두면 깨어 있는 6시간마다 묻는다 (멈추지 않는다)", async () => {
    const mac = fakeMac();
    startUpdateSchedule(mac.deps);
    await settle();
    await mac.awake(6 * 24 * HOUR);
    // 6일 = 24번의 6시간. 시계 한 칸만큼 밀릴 수 있어 마지막 한 번은 경계에 걸린다.
    expect(mac.checks.length).toBeGreaterThanOrEqual(24);
    expect(mac.checks.length).toBeLessThanOrEqual(25);
    for (let i = 1; i < mac.checks.length; i += 1) {
      expect((mac.checks[i] ?? 0) - (mac.checks[i - 1] ?? 0)).toBeLessThanOrEqual(RECHECK_INTERVAL_MS + SCHEDULE_TICK_MS);
    }
  });

  it("맥이 자고 깨면 첫 시계 칸 안에 묻는다 (마지막 확인이 30분보다 오래됐을 때)", async () => {
    const mac = fakeMac();
    startUpdateSchedule(mac.deps);
    await settle();
    await mac.awake(1 * HOUR);
    // 1시간 잔다: 벽시계로 마감(6시간)은 아직이다. 깼다는 사실만으로 묻는다.
    mac.sleep(1 * HOUR);
    const wokeAt = mac.elapsed();
    await mac.awake(SCHEDULE_TICK_MS);
    expect(mac.checks).toHaveLength(2);
    expect((mac.checks[1] ?? 0) - (mac.checks[0] ?? 0) - wokeAt).toBeLessThanOrEqual(SCHEDULE_TICK_MS);
  });

  it("밤새 자도 벽시계로 마감을 넘겼으면 깬 뒤 첫 칸에 묻는다", async () => {
    const mac = fakeMac();
    startUpdateSchedule(mac.deps);
    await settle();
    await mac.awake(30 * MINUTE);
    mac.sleep(10 * HOUR);
    await mac.awake(SCHEDULE_TICK_MS);
    expect(mac.checks).toHaveLength(2);
  });

  it("확인이 실패하면 6시간이 아니라 30분 뒤에 다시 묻는다", async () => {
    const mac = fakeMac(["failed"]);
    startUpdateSchedule(mac.deps);
    await settle();
    await mac.awake(RETRY_AFTER_FAILURE_MS - SCHEDULE_TICK_MS);
    expect(mac.checks).toHaveLength(1);
    await mac.awake(2 * SCHEDULE_TICK_MS);
    expect(mac.checks).toHaveLength(2);
    // 두 번째는 성공했다: 그다음은 다시 6시간 간격이다.
    await mac.awake(RECHECK_INTERVAL_MS - 2 * SCHEDULE_TICK_MS);
    expect(mac.checks).toHaveLength(2);
  });

  it("돌아왔다는 신호(창 보임·초점·온라인)는 30분이 안 됐으면 묻지 않고, 지났으면 곧바로 묻는다", async () => {
    const mac = fakeMac();
    const schedule = startUpdateSchedule(mac.deps);
    await settle();
    await mac.awake(10 * MINUTE);
    schedule.nudge();
    await settle();
    expect(mac.checks).toHaveLength(1);
    await mac.awake(WAKE_RECHECK_GAP_MS - 10 * MINUTE);
    schedule.nudge();
    await settle();
    expect(mac.checks).toHaveLength(2);
    expect(mac.checks[1]).toBe(mac.checks[0]! + WAKE_RECHECK_GAP_MS);
  });

  it("거절된 확인(받는 중)은 마감을 옮기지 않아 다음 칸이 다시 묻는다", async () => {
    const mac = fakeMac(["refused"]);
    startUpdateSchedule(mac.deps);
    await settle();
    expect(mac.checks).toHaveLength(1);
    await mac.awake(SCHEDULE_TICK_MS);
    expect(mac.checks).toHaveLength(2);
  });

  it("멈춘 뒤에는 묻지 않고 시계도 남기지 않는다", async () => {
    const mac = fakeMac();
    const schedule = startUpdateSchedule(mac.deps);
    await settle();
    schedule.stop();
    expect(mac.pendingTimers()).toBe(0);
    schedule.nudge();
    await mac.awake(2 * RECHECK_INTERVAL_MS);
    expect(mac.checks).toHaveLength(1);
  });
});
