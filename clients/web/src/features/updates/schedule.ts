import { startWakeWatch } from "@momo/core/features/connection/diagnosticLog";

// =============================================================================
// 켜 둔 앱이 언제 새 버전을 묻나 (#5661).
//
// 예전에는 `setInterval(6시간)` 하나였다. 웹뷰의 타이머는 맥이 자는 동안 흐르지 않고(단조 시계), 창이 뒤에 있으면 낮잠으로 늦게
// 깬다. 그래서 「6시간마다」는 「깨어 있는 시간으로 6시간마다」였고, 밤마다 덮어 두는 노트북에서는 그 6시간이 며칠이 될 수 있었다.
// 이 일정은 **벽시계**로 잰다:
//
//   - 앱이 뜰 때 한 번 묻는다.
//   - 1분마다 깨는 시계(코어 `startWakeWatch`, 연결 기록과 같은 판정)가 벽시계로 마감을 본다. 마지막으로 물은 지 6시간이 지났으면
//     묻는다. 실패했으면 30분 뒤에 다시 묻는다.
//   - 맥이 잠에서 깼거나(시계가 10초 넘게 늦게 깸), 창이 다시 보이거나, 기기가 다시 온라인이면 곧바로 묻는다. 다만 마지막으로 물은 지
//     30분이 안 됐으면 묻지 않는다(창을 오가는 손에 피드를 두드리지 않게).
//
// 상한(시험이 잰다): 깨어 있는 동안 새 버전이 나온 뒤 늦어도 6시간 + 시계 한 칸(1분) 안에 묻는다. 잠에서 깬 뒤에는 첫 시계 칸(1분)
// 안에, 마지막 확인이 30분보다 오래됐으면 묻는다.
//
// 순수하다: 시계·타이머·확인 함수는 인자로 받는다. 저장소(`store.ts`)가 진짜를 물리고, 시험이 가짜를 물린다.
// =============================================================================

/** 깨어 있는 동안 두 확인 사이의 가장 긴 벽시계 간격. */
export const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 확인이 실패했을 때 다시 묻기까지. 6시간을 기다리면 잠깐의 오프라인이 하루를 잃게 한다. */
export const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
/** 깸·창 보임·온라인이 곧바로 묻게 하는 조건: 마지막으로 **답을 받은** 지 이만큼은 지났다. */
export const WAKE_RECHECK_GAP_MS = 30 * 60 * 1000;
/**
 * 실패 뒤 창 보임·초점이 다시 묻기까지의 바닥. 오프라인에서 창을 오갈 때마다 실패를 쌓지 않게 한다. 「다시 온라인」은 이 바닥을
 * 지나지 않는다: 뚜껑을 열면 늦게 깬 시계가 망이 붙기 전에 묻고 실패하는 것이 보통이고, 몇 초 뒤의 온라인이 바로 그 답을 받을 차례다.
 */
export const NUDGE_AFTER_FAILURE_MS = 60 * 1000;
/** 벽시계 마감을 보는 시계의 간격. 숫자만 비교하므로 싸다. */
export const SCHEDULE_TICK_MS = 60 * 1000;

/**
 * 확인 한 번이 알게 된 것. `refused`는 확인하지 않았다는 뜻이다(받는 중이거나 이미 묻는 중): 마감을 옮기지 않아 다음 칸이 다시 묻는다.
 */
export type ScheduledCheckResult = "current" | "available" | "failed" | "off" | "refused";

export interface UpdateScheduleDeps {
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** 확인 한 번. 거절하지 않는다(실패도 결과다). */
  readonly check: () => Promise<ScheduledCheckResult>;
}

/** 「돌아왔다」는 신호의 종류. `online`은 실패 뒤 바닥(1분)을 지나지 않는다. */
export type NudgeReason = "back" | "online";

export interface UpdateSchedule {
  /**
   * 창이 다시 보임·초점(`back`)·다시 온라인(`online`) 같은 「돌아왔다」는 신호. 마지막으로 답을 받은 지 30분이 넘었으면 곧바로
   * 묻는다. 마지막 시도가 실패였다면 `back`은 그 시도 뒤 1분이 지나야 묻는다.
   */
  readonly nudge: (reason?: NudgeReason) => void;
  readonly stop: () => void;
}

/** 이 결과 뒤 다음 확인의 벽시계 마감. `refused`는 마감을 옮기지 않는다(null). */
export function nextDueAt(result: ScheduledCheckResult, checkedAt: number): number | null {
  switch (result) {
    case "refused":
      return null;
    case "failed":
      return checkedAt + RETRY_AFTER_FAILURE_MS;
    default:
      return checkedAt + RECHECK_INTERVAL_MS;
  }
}

/** 일정을 건다. 곧바로 한 번 묻는다. 돌려주는 `stop`이 시계를 멈춘다. */
export function startUpdateSchedule(deps: UpdateScheduleDeps): UpdateSchedule {
  let stopped = false;
  let running = false;
  /** 마지막으로 답을 받은(실패·거절이 아닌) 확인의 시각. 「돌아왔다」 신호의 30분 간격은 이것으로 잰다. */
  let lastAnsweredAt: number | null = null;
  /** 마지막으로 실제로 물은(거절되지 않은) 시각. 실패 뒤 1분 바닥은 이것으로 잰다. */
  let lastAttemptAt: number | null = null;
  let dueAt = Number.NEGATIVE_INFINITY;

  async function run(): Promise<void> {
    if (stopped || running) return;
    running = true;
    const at = deps.now();
    try {
      const result = await deps.check();
      const due = nextDueAt(result, at);
      if (due !== null) {
        lastAttemptAt = at;
        if (result !== "failed") lastAnsweredAt = at;
        dueAt = due;
      }
    } finally {
      running = false;
    }
  }

  function nudge(reason: NudgeReason = "back"): void {
    if (stopped) return;
    const now = deps.now();
    if (lastAnsweredAt !== null && now - lastAnsweredAt < WAKE_RECHECK_GAP_MS) return;
    // 실패한 시도가 방금 있었다: 창을 오가는 손으로는 1분에 한 번까지만. 다시 온라인은 곧바로.
    if (reason !== "online" && lastAttemptAt !== null && now - lastAttemptAt < NUDGE_AFTER_FAILURE_MS) return;
    void run();
  }

  void run();
  const stopWatch = startWakeWatch(
    {
      now: deps.now,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      // 맥이 잤다(시계가 늦게 깼다): 「돌아왔다」와 같다.
      onLate: () => nudge(),
      onTick: (at) => {
        if (at >= dueAt) void run();
      },
    },
    SCHEDULE_TICK_MS
  );

  return {
    nudge,
    stop: () => {
      stopped = true;
      stopWatch();
    },
  };
}
