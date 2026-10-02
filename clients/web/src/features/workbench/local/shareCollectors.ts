import type { GitReadCommand, GitReadResult } from "@momo/core/features/workbench/gitRead";
import {
  createShareCollector,
  noopShareSender,
  type GitInputs,
  type S1Harness,
  type ShareCollector,
  type ShareSender,
  type ShareSummaryS1,
} from "@momo/core/features/workbench/shareSummary";
import type { PtyProgram } from "@/lib/tauri";
import type { LocalSessionView, LocalSessions } from "./localSessions";

// 칸마다 S1 수집기 하나(#2861, ADR-0190 D4-b). 이 모듈은 `LocalSessionView`의
// **구조 필드**(phase·exit·signal·title)와 마지막 출력 **시각**, 그리고 셸의 git
// 읽기 결과를 수집기의 타입 있는 입구로 옮길 뿐이다. 출력 바이트·미러·스크롤백에는
// 손대지 않는다: 이 파일이 import하는 세션 표면은 `subscribe`·`getSnapshot`·
// `lastOutputAtOf`·`ptyIdOf`뿐이고, 소스 시험이 잠근다.
//
// 서버로 보내는 길은 #2862가 `senderFor`로 붙인다. 지금은 아무것도 보내지 않는다
// (`noopShareSender`, 공유 기본 꺼짐). git은 **공유가 켜진 칸만** 읽는다.

export type ShareGitReader = (command: GitReadCommand, ptyId: number) => Promise<GitReadResult>;

export const SHARE_GIT_REFRESH_MS = 30_000;
export const SHARE_ACTIVITY_POLL_MS = 15_000;

export type ShareSessionsPort = Pick<LocalSessions, "subscribe" | "getSnapshot" | "lastOutputAtOf" | "ptyIdOf">;

export interface ShareCollectorsDeps {
  sessions: ShareSessionsPort;
  readGit: ShareGitReader;
  senderFor?: (paneId: string) => ShareSender;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => () => void;
}

export function harnessOf(program: PtyProgram): S1Harness {
  if (program.kind === "shell") return "shell";
  return program.id === "claude" || program.id === "codex" || program.id === "grok" ? program.id : "other";
}

interface Entry {
  collector: ShareCollector;
  phase: LocalSessionView["phase"] | null;
  signal: LocalSessionView["signal"];
  title: string | null;
  sharing: boolean;
  gitRun: number;
}

export interface ShareCollectors {
  /** 공유를 켜면 그 칸의 git을 읽고 요약을 보낸다. 기본은 꺼짐(D4). */
  setSharing(paneId: string, on: boolean): void;
  /** 주인이 칸 메뉴에 붙여 넣은 PR URL. 형식 밖이면 버린다. */
  setPrUrl(paneId: string, url: string | null): void;
  summaryOf(paneId: string): ShareSummaryS1 | null;
  dispose(): void;
}

export function createShareCollectors(deps: ShareCollectorsDeps): ShareCollectors {
  const now = deps.now ?? Date.now;
  const every =
    deps.setInterval ??
    ((fn, ms) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    });
  const entries = new Map<string, Entry>();
  let disposed = false;

  function entryFor(view: LocalSessionView): Entry {
    let e = entries.get(view.paneId);
    if (!e) {
      e = {
        collector: createShareCollector({
          harness: harnessOf(view.program),
          sender: deps.senderFor?.(view.paneId) ?? noopShareSender,
          now,
        }),
        phase: null,
        signal: null,
        title: null,
        sharing: false,
        gitRun: 0,
      };
      entries.set(view.paneId, e);
    }
    return e;
  }

  async function readGit(paneId: string, e: Entry): Promise<void> {
    const ptyId = deps.sessions.ptyIdOf(paneId);
    if (!e.sharing || ptyId === null) return;
    const run = ++e.gitRun;
    const inputs: GitInputs = {};
    // G1·G2·G4·G7·G8만. 커밋 읽기(G5)는 요청하지 않는다(Q2: 커밋 제목 제외).
    const [g1, g2, g4, g7, g8] = await Promise.all(
      (["g1", "g2", "g4", "g7", "g8"] as const).map((c) => deps.readGit(c, ptyId))
    );
    if (disposed || !e.sharing || run !== e.gitRun) return;
    inputs.g1 = g1;
    inputs.g2 = g2;
    inputs.g4 = g4;
    inputs.g7 = g7;
    inputs.g8 = g8;
    e.collector.onGit(inputs);
  }

  function sync(): void {
    if (disposed) return;
    const views = deps.sessions.getSnapshot();
    for (const [paneId, e] of entries) {
      if (!views.has(paneId)) {
        e.collector.dispose();
        entries.delete(paneId);
      }
    }
    for (const view of views.values()) {
      const e = entryFor(view);
      const phaseChanged = e.phase !== view.phase;
      if (phaseChanged) {
        e.phase = view.phase;
        e.collector.onLifecycle(view.phase, view.exit?.code ?? null, view.exit?.signal ?? null);
      }
      if (e.signal !== view.signal) {
        e.signal = view.signal;
        if (view.signal !== null) e.collector.onSignal(view.signal);
        if (view.signal === "turn-done") void readGit(view.paneId, e);
      }
      if (e.title !== view.title) {
        e.title = view.title;
        e.collector.onTitle(view.title);
      }
      if (phaseChanged && view.phase === "running") void readGit(view.paneId, e);
    }
  }

  function pollActivity(): void {
    for (const paneId of entries.keys()) {
      const at = deps.sessions.lastOutputAtOf(paneId);
      if (at !== null) entries.get(paneId)!.collector.onActivity(at);
    }
  }

  const unsubscribe = deps.sessions.subscribe(sync);
  const stopActivity = every(pollActivity, SHARE_ACTIVITY_POLL_MS);
  const stopGit = every(() => {
    for (const [paneId, e] of entries) if (e.sharing) void readGit(paneId, e);
  }, SHARE_GIT_REFRESH_MS);
  sync();

  return {
    setSharing(paneId, on) {
      const view = deps.sessions.getSnapshot().get(paneId);
      if (!view) return;
      const e = entryFor(view);
      e.sharing = on;
      if (on) {
        pollActivity();
        e.collector.setSharing(true);
        void readGit(paneId, e);
      } else {
        e.gitRun++;
        e.collector.setSharing(false);
      }
    },
    setPrUrl(paneId, url) {
      entries.get(paneId)?.collector.onPrUrl(url);
    },
    summaryOf(paneId) {
      return entries.get(paneId)?.collector.snapshot() ?? null;
    },
    dispose() {
      disposed = true;
      unsubscribe();
      stopActivity();
      stopGit();
      for (const e of entries.values()) e.collector.dispose();
      entries.clear();
    },
  };
}
