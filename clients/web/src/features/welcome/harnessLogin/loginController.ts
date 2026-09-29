// =============================================================================
// 로그인 모달의 PTY 한 개 (#2816, ADR-0190 D3-f).
//
// 숨은 PTY에서 공식 CLI의 로그인 명령(셸 `LOGIN_COMMANDS`)을 돌린다. 이 모듈은
// 그 PTY를 로컬 터미널 칸과 같은 세션 관리자(`createLocalSessions`)로 들되,
// **따로 만든 인스턴스**다: 도크의 세션과 섞이지 않고, 스크롤백 저장소가 없다
// (`storage: () => null`). 그래서 로그인 화면(URL·코드)이 이 기기의 저장소에
// 남지 않는다. 출력은 headless 미러가 받고, 사람이 「터미널로 보기」를 펼칠 때만
// 보이는 xterm이 그 미러를 그린다. 이 모듈은 출력 바이트를 해석하지 않는다:
// 디코딩·검색·저장·로그·서버 전송이 없다(소스 시험 `loginController.test.ts`).
//
// 판정: PTY가 끝나면 셸의 상태 명령(#2813)을 한 번 묻고 그 값으로만 정한다.
// 취소는 PTY를 끝내고 모달을 닫는다. 시간 제한은 PTY를 끝내고 실패로 둔다
// (화면은 남겨 「터미널로 보기」로 까닭을 볼 수 있다).
// =============================================================================

import type { LocalHarnessId, LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import {
  HARNESS_LOGIN_TIMEOUT_MS,
  harnessLoginVerdict,
  type HarnessLoginMethod,
  type HarnessLoginPhase,
} from "@momo/core/features/onboarding/harnessLogin";
import {
  createLocalSessions,
  type LocalSessions,
  type MirrorFactory,
  type PtyPort,
} from "@/features/workbench/local/localSessions";

export interface LoginControllerDeps {
  pty: PtyPort;
  loadMirror: () => Promise<MirrorFactory>;
  /**
   * 셸 상태 명령. 기본 로그인은 `detect_local_harnesses`, 프로필은 그 폴더로 돌린
   * `harness_profile_status`(#2878) — 부른 쪽이 고른다.
   */
  detect: () => Promise<LocalHarnessProbe[]>;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface LoginControllerState {
  harness: LocalHarnessId;
  method: HarnessLoginMethod;
  /** 지금 PTY의 칸 id. 다시 시도하면 바뀐다(보이는 터미널이 새로 붙는다). */
  paneId: string;
  status: HarnessLoginPhase;
}

/** 숨은 PTY의 첫 크기. 사람이 터미널을 펼치면 그 칸 크기로 바뀐다. */
const HIDDEN_COLS = 80;
const HIDDEN_ROWS = 24;
const TEXT_ENCODER = new TextEncoder();

export function createLoginController(
  harness: LocalHarnessId,
  initialMethod: HarnessLoginMethod,
  deps: LoginControllerDeps,
  /**
   * oort 프로필 라벨(#2878, 시안 §3·§4). 있으면 셸이 그 폴더를 CLI의 설정 폴더로
   * 넘긴다(ADR-0190 D3-f A1·A3). 없으면 이 맥의 기본 위치다.
   */
  profile: string | null = null,
  /**
   * `profile`이 이 맥의 「원격 작업」 계정 라벨이다(#3157). 셸이 그 폴더를 workd에게
   * 묻고, 없으면 로그인하지 않는다(기본 위치로 조용히 넘어가지 않는다).
   */
  remote = false
) {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  // 이 컨트롤러가 띄운 PTY가 아직 살아 있는가(#2996 재검수 M-1). 취소한 뒤 새
  // 프로필 폴더를 치우려면, 로그인 CLI가 정말 끝난 뒤여야 한다: 끝나기 전에 치우면
  // CLI가 자격을 마저 쓰거나 폴더를 되살릴 수 있다.
  const alive = new Set<number>();
  const exitedEarly = new Set<number>();
  let spawning = 0;
  let endWaiters: (() => void)[] = [];
  const settleEnd = () => {
    if (spawning > 0 || alive.size > 0) return;
    const waiters = endWaiters;
    endWaiters = [];
    waiters.forEach((resolve) => resolve());
  };
  const trackedPty: PtyPort = {
    ...deps.pty,
    spawn: async (request, onOutput, onExit, onSignal) => {
      spawning += 1;
      try {
        const id = await deps.pty.spawn(
          request,
          onOutput,
          (exit) => {
            if (!alive.delete(exit.id)) exitedEarly.add(exit.id);
            onExit(exit);
            settleEnd();
          },
          onSignal
        );
        if (!exitedEarly.delete(id)) alive.add(id);
        return id;
      } finally {
        spawning -= 1;
        settleEnd();
      }
    },
  };
  const sessions: LocalSessions = createLocalSessions({
    pty: trackedPty,
    loadMirror: deps.loadMirror,
    // 로그인 화면은 이 기기에 남기지 않는다.
    storage: () => null,
    sessionKey: "harness-login",
  });

  let attempt = 0;
  let state: LoginControllerState = {
    harness,
    method: initialMethod,
    paneId: "",
    status: { phase: "waiting" },
  };
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<LoginControllerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const start = (method: HarnessLoginMethod) => {
    const mine = ++attempt;
    const paneId = `login-${mine}`;
    // 이 시도가 판정을 끝냈는가(시간 제한·판정 뒤의 종료 사건은 버린다).
    let settled = false;
    set({ method, paneId, status: { phase: "waiting" } });

    const settle = (status: HarnessLoginPhase) => {
      if (disposed || settled || attempt !== mine) return;
      settled = true;
      stopTimer();
      set({ status });
    };

    unsubscribe?.();
    unsubscribe = sessions.subscribe(() => {
      if (disposed || attempt !== mine || settled) return;
      const view = sessions.getSnapshot().get(paneId);
      if (!view) return;
      if (view.phase === "failed") {
        settle({ phase: "failed", reason: "spawn" });
      } else if (view.phase === "exited" && state.status.phase === "waiting") {
        set({ status: { phase: "checking" } });
        void deps.detect().then(
          (probes) => settle(harnessLoginVerdict(harness, probes)),
          () => settle(harnessLoginVerdict(harness, null))
        );
      }
    });

    stopTimer();
    timer = setTimer(() => {
      if (disposed || attempt !== mine || settled) return;
      settle({ phase: "failed", reason: "timeout" });
      const id = sessions.ptyIdOf(paneId);
      if (id !== null) void deps.pty.kill(id).catch(() => undefined);
    }, HARNESS_LOGIN_TIMEOUT_MS);

    // 원격 작업 로그인은 계정 라벨이 있어야 한다: 없으면 기본 위치 로그인으로 조용히
    // 떨어지지 않고 시작 실패로 둔다(#3157).
    if (remote && profile === null) {
      settle({ phase: "failed", reason: "spawn" });
      return;
    }
    sessions.setPendingProgram(
      paneId,
      profile === null
        ? { kind: "login", id: harness, method }
        : remote
          ? { kind: "remoteLogin", id: harness, method, profile }
          : { kind: "login", id: harness, method, profile }
    );
    void sessions.ensure(paneId, HIDDEN_COLS, HIDDEN_ROWS).catch(() => {
      settle({ phase: "failed", reason: "spawn" });
    });
  };

  const api = {
    sessions,
    getState(): LoginControllerState {
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 모달이 열릴 때 한 번. */
    open(): void {
      if (attempt === 0 && !disposed) start(initialMethod);
    },
    /**
     * 사람이 붙인 코드를 CLI의 입력으로 그대로 보낸다(Enter 포함). 이 함수는
     * 코드를 어디에도 두지 않는다: PTY 입력 큐로 넘기고 끝이다.
     */
    submitCode(code: string): void {
      if (disposed || state.status.phase !== "waiting") return;
      const trimmed = code.trim();
      if (trimmed === "") return;
      sessions.input(state.paneId, TEXT_ENCODER.encode(`${trimmed}\r`));
    },
    /** 다시 시도 또는 다른 방법(Codex 기기 코드). 앞의 PTY는 끝낸다. */
    retry(method: HarnessLoginMethod = state.method): void {
      if (disposed) return;
      const previous = state.paneId;
      start(method);
      if (previous !== "") sessions.close(previous);
    },
    /**
     * 이 컨트롤러가 띄운 로그인 CLI가 모두 끝났는가. `timeoutMs` 안에 끝나면 true,
     * 아니면 false(부른 쪽은 폴더를 치우지 않는다).
     */
    whenEnded(timeoutMs = 5_000): Promise<boolean> {
      if (spawning === 0 && alive.size === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimer(() => resolve(false), timeoutMs);
        endWaiters.push(() => {
          clearTimer(timer);
          resolve(true);
        });
      });
    },
    /** 취소·닫기: PTY를 끝내고 미러를 버린다. 다시 쓰지 않는다. */
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
  return api;
}

export type LoginController = ReturnType<typeof createLoginController>;
