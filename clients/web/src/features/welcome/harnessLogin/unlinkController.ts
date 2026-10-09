// =============================================================================
// 연결 해제의 PTY 한 개 (#2878 AA-4, ADR-0190 D3-f 「연결 해제 순서」).
//
// oort 프로필의 「연결 해제」는 로그인 모달과 대칭이다. 숨은 PTY에서 공식 CLI의
// 로그아웃 명령(셸 `LOGOUT_COMMANDS`, 늘 그 프로필 폴더)을 돌리고:
//
//   종료 코드 0 → 셸 `harness_profile_remove` → 셸이 상태 명령을 그 폴더로 다시
//   돌려 「로그인 안 됨」일 때만 폴더를 지운다 → 끝.
//
// 그 밖의 결말(0이 아닌 종료·신호·시간 초과·셸 거부·아직 로그인됨·상태 모름)에서는
// 폴더가 남고 화면이 그 사실을 말한다. 폴더를 지울지 정하는 것은 셸이다: 이 모듈이
// 틀려도 로그인된 폴더는 지워지지 않는다(`harness_profile.rs` 시험).
//
// 로그인 컨트롤러와 같은 규율: 따로 만든 세션 관리자, 스크롤백 저장소 없음
// (`storage: () => null`), 출력 바이트를 해석·저장·로그·전송하지 않는다(소스 시험
// `loginController.test.ts`가 이 폴더 전체를 본다). 출력은 사람이 「터미널로 보기」를
// 펼칠 때만 그 화면에 보인다.
// =============================================================================

import type { LocalHarnessId, LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import { disconnectVerdict } from "@momo/core/features/ai/harnessCard";
import {
  HARNESS_LOGOUT_TIMEOUT_MS,
  unlinkAfterExit,
  unlinkAfterRemove,
  type HarnessProfileRef,
  type ProfileRemoveOutcome,
  type UnlinkPhase,
} from "@momo/core/features/settings/harnessProfiles";
import {
  createLocalSessions,
  type LocalSessions,
  type MirrorFactory,
  type PtyPort,
} from "@/features/workbench/local/localSessions";

/**
 * 로그아웃 대상. `label`이 null이면 이 맥의 기본 로그인이다(「내 도구」 카드의 연결 끊기,
 * ADR-0198 D3): 같은 공식 로그아웃 행을 기본 위치에서 돌리고, 폴더를 지우는 대신
 * `verify`(셸 상태 명령)로 **로그인 아님**을 확인해야 끝난다.
 */
export interface UnlinkTarget {
  harness: LocalHarnessId;
  label: string | null;
}

export interface UnlinkControllerDeps {
  pty: PtyPort;
  loadMirror: () => Promise<MirrorFactory>;
  /** 셸 `harness_profile_remove`. 셸이 상태를 다시 묻고 지울지 정한다(프로필 대상). */
  remove: (profile: HarnessProfileRef) => Promise<ProfileRemoveOutcome>;
  /** 셸 상태 명령(`detect_local_harnesses`). 기본 로그인 대상의 로그아웃 확인에 쓴다. */
  verify?: () => Promise<LocalHarnessProbe[]>;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface UnlinkControllerState {
  harness: LocalHarnessId;
  /** 지금 PTY의 칸 id. 다시 시도하면 바뀐다. 시작 전에는 빈 문자열. */
  paneId: string;
  status: UnlinkPhase;
}

const HIDDEN_COLS = 80;
const HIDDEN_ROWS = 24;

export function createUnlinkController(target: UnlinkTarget, deps: UnlinkControllerDeps) {
  const profile = target.label === null ? null : { harness: target.harness, label: target.label };
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const sessions: LocalSessions = createLocalSessions({
    pty: deps.pty,
    loadMirror: deps.loadMirror,
    // 로그아웃 화면도 이 기기에 남기지 않는다.
    storage: () => null,
    sessionKey: "harness-logout",
  });

  let attempt = 0;
  let state: UnlinkControllerState = {
    harness: target.harness,
    paneId: "",
    status: { phase: "confirm" },
  };
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<UnlinkControllerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const start = () => {
    const mine = ++attempt;
    const paneId = `logout-${mine}`;
    let settled = false;
    let exited = false;
    set({ paneId, status: { phase: "signing-out" } });

    const settle = (status: UnlinkPhase) => {
      if (disposed || settled || attempt !== mine) return;
      settled = true;
      stopTimer();
      set({ status });
    };

    unsubscribe?.();
    unsubscribe = sessions.subscribe(() => {
      if (disposed || attempt !== mine || settled || exited) return;
      const view = sessions.getSnapshot().get(paneId);
      if (!view) return;
      if (view.phase === "failed") {
        settle({ phase: "failed", reason: "spawn" });
      } else if (view.phase === "exited") {
        exited = true;
        const next = unlinkAfterExit(view.exit);
        if (next.phase !== "removing") {
          settle(next);
          return;
        }
        if (profile === null) {
          // 기본 로그인: 로그아웃이 0으로 끝난 것만으로는 끊겼다고 하지 않는다.
          // 상태 명령이 로그인 아님을 알린 뒤에만 끝난다(`disconnectVerdict`).
          stopTimer();
          set({ status: next });
          const exit = view.exit;
          void (deps.verify ? deps.verify() : Promise.reject(new Error("no verify"))).then(
            (probes) => settle(fromVerdict(disconnectVerdict(target.harness, exit, probes))),
            () => settle({ phase: "failed", reason: "unknown" })
          );
          return;
        }
        // 로그아웃이 끝났다. 시간 제한은 여기서 멈춘다(셸의 삭제는 상태 명령
        // 한도 안에서 끝난다).
        stopTimer();
        set({ status: next });
        void deps.remove(profile).then(
          (outcome) => settle(unlinkAfterRemove(outcome)),
          () => settle({ phase: "failed", reason: "remove-failed" })
        );
      }
    });

    stopTimer();
    timer = setTimer(() => {
      if (disposed || attempt !== mine || settled || exited) return;
      settle({ phase: "failed", reason: "timeout" });
      const id = sessions.ptyIdOf(paneId);
      if (id !== null) void deps.pty.kill(id).catch(() => undefined);
    }, HARNESS_LOGOUT_TIMEOUT_MS);

    sessions.setPendingProgram(
      paneId,
      profile === null
        ? { kind: "logout", id: target.harness }
        : { kind: "logout", id: profile.harness, profile: profile.label }
    );
    void sessions.ensure(paneId, HIDDEN_COLS, HIDDEN_ROWS).catch(() => {
      settle({ phase: "failed", reason: "spawn" });
    });
  };

  return {
    sessions,
    getState(): UnlinkControllerState {
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 확인 창의 「연결 해제」. 확인 전·실패 뒤(다시 시도)에만 돈다. */
    confirm(): void {
      if (disposed) return;
      const current = state.status;
      const phase = current.phase;
      if (phase !== "confirm" && phase !== "failed") return;
      // 로그아웃은 이미 됐고 폴더 정리만 실패했다: 로그아웃을 다시 돌리지 않고
      // 정리만 다시 묻는다(셸이 여전히 상태를 확인한 뒤에만 지운다).
      if (profile !== null && current.phase === "failed" && current.reason === "remove-failed") {
        const mine = ++attempt;
        set({ status: { phase: "removing" } });
        void deps.remove(profile).then(
          (outcome) => {
            if (!disposed && attempt === mine) set({ status: unlinkAfterRemove(outcome) });
          },
          () => {
            if (!disposed && attempt === mine) set({ status: { phase: "failed", reason: "remove-failed" } });
          }
        );
        return;
      }
      const previous = state.paneId;
      start();
      if (previous !== "") sessions.close(previous);
    },
    /** 닫기: PTY를 끝내고 미러를 버린다. 다시 쓰지 않는다. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopTimer();
      unsubscribe?.();
      unsubscribe = null;
      if (state.paneId !== "") sessions.close(state.paneId);
      listeners.clear();
    },
  };
}

function fromVerdict(verdict: ReturnType<typeof disconnectVerdict>): UnlinkPhase {
  if (verdict.phase === "done") return { phase: "done" };
  if (verdict.phase !== "failed") return { phase: "failed", reason: "unknown" };
  switch (verdict.reason) {
    case "still-logged-in":
      return { phase: "failed", reason: "still-signed-in" };
    case "logout-failed":
    case "spawn":
    case "timeout":
    case "unknown":
      return { phase: "failed", reason: verdict.reason };
  }
}

export type UnlinkController = ReturnType<typeof createUnlinkController>;
