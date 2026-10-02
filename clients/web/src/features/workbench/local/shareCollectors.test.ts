import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitReadCommand, GitReadResult } from "@momo/core/features/workbench/gitRead";
import { STAGE_LABEL, type ShareSender, type ShareSummaryS1 } from "@momo/core/features/workbench/shareSummary";
import type { PtyExit } from "@/lib/tauri";
import {
  createLocalSessions,
  type MirrorFactory,
  type MirrorTerminal,
  type PtyPort,
} from "./localSessions";
import { createShareCollectors, harnessOf } from "./shareCollectors";

// #2861 red proof: 진짜 세션 관리자(가짜 PTY·가짜 미러)에 토큰·커밋 제목·하네스 모양의
// 출력을 흘려도 공유 요약은 시각 말고는 달라지지 않는다.

class FakeMirror implements MirrorTerminal {
  cols = 80;
  rows = 24;
  private title: ((t: string) => void) | null = null;
  write(_data: string | Uint8Array, callback?: () => void) {
    if (callback) queueMicrotask(callback);
  }
  resize() {}
  dispose() {}
  onTitleChange(listener: (t: string) => void) {
    this.title = listener;
    return { dispose: () => (this.title = null) };
  }
  setTitle(t: string) {
    this.title?.(t);
  }
}

const CANARY = [
  "sk-ant-api03-CANARY",
  "ghp_CANARYTOKEN",
  "fix: acme-corp 고객 환불 (commit subject)",
  "Allow this command? (y/n)",
  "permission_prompt",
  "/Users/me/secret-repo",
];

function rig() {
  const mirrors: FakeMirror[] = [];
  let output: (b: ArrayBuffer) => void = () => undefined;
  let exit: (e: PtyExit) => void = () => undefined;
  let signal: (s: unknown) => void = () => undefined;
  let nextId = 1;
  const pty: PtyPort = {
    spawn: vi.fn(async (_req, onOutput, onExit, onSignal) => {
      output = onOutput;
      exit = onExit;
      signal = onSignal ?? (() => undefined);
      return nextId++;
    }),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    ack: vi.fn(async () => undefined),
  };
  const factory: MirrorFactory = {
    create() {
      const mirror = new FakeMirror();
      mirrors.push(mirror);
      return { mirror, serialize: () => "" };
    },
  };
  let t = 5_000_000;
  const sessions = createLocalSessions({
    pty,
    loadMirror: async () => factory,
    storage: () => null,
    now: () => t,
  });
  const gitCalls: GitReadCommand[] = [];
  const sent: ShareSummaryS1[] = [];
  const sender: ShareSender = { send: (s) => void sent.push(s) };
  const ok = (value: unknown): GitReadResult => ({ outcome: "ok", value: value as never });
  const intervals: (() => void)[] = [];
  const collectors = createShareCollectors({
    sessions,
    senderFor: () => sender,
    now: () => t,
    setInterval: (fn) => {
      intervals.push(fn);
      return () => undefined;
    },
    readGit: async (command) => {
      gitCalls.push(command);
      switch (command) {
        case "g1":
          return ok({ kind: "repo", name: "oort" });
        case "g2":
          return ok({ kind: "branch", name: "feat/x" });
        case "g4":
          return ok({ kind: "aheadBehind", ahead: 1, behind: 0 });
        case "g7":
          return ok({ kind: "diff", files: [], totals: { files: 2, added: 10, deleted: 3, binary: 0 } });
        case "g8":
          return ok({ kind: "status", modified: 1, added: 0, deleted: 0, untracked: 0 });
        default:
          return { outcome: "unknown" };
      }
    },
  });
  return {
    sessions,
    collectors,
    mirrors,
    gitCalls,
    sent,
    tick: (ms: number) => {
      t += ms;
      intervals.forEach((f) => f());
    },
    emit: (text: string) => output(new TextEncoder().encode(text).buffer as ArrayBuffer),
    exit: (e: PtyExit) => exit(e),
    signal: (v: unknown) => signal(v),
  };
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("세션 관리자 → S1 요약 (#2861)", () => {
  it("구조 필드가 요약으로 옮겨진다: 생명주기·hook 신호·git 숫자", async () => {
    const h = rig();
    h.sessions.setPendingProgram("p1", { kind: "harness", id: "claude" } as never);
    await h.sessions.ensure("p1", 80, 24);
    await settle();
    h.collectors.setSharing("p1", true);
    await settle();
    h.signal("working");
    await settle();
    const s = h.collectors.summaryOf("p1")!;
    expect(s).toMatchObject({
      harness: "claude",
      state: "running",
      repo: "oort",
      branch: "feat/x",
      diff: { added: 10, deleted: 3, files: 2, ahead: 1, behind: 0, uncommitted: 1 },
    });
    expect(s.stages).toEqual([STAGE_LABEL.started, STAGE_LABEL.working]);
    expect(h.gitCalls.every((c) => ["g1", "g2", "g4", "g7", "g8"].includes(c))).toBe(true);
    expect(h.gitCalls).not.toContain("g5");
    h.exit({ id: 1, code: 0, signal: null });
    await settle();
    expect(h.collectors.summaryOf("p1")!.state).toBe("done");
  });

  it("공유가 꺼져 있으면 git을 읽지 않고 아무것도 보내지 않는다", async () => {
    const h = rig();
    await h.sessions.ensure("p1", 80, 24);
    await settle();
    h.signal("turn-done");
    h.emit("hello");
    h.tick(120_000);
    await settle();
    expect(h.gitCalls).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("가짜 PTY 출력(토큰·커밋 제목·점 글자·OSC 제목 모양)은 요약을 바꾸지 않는다 — 시각만 움직인다", async () => {
    const h = rig();
    await h.sessions.ensure("p1", 80, 24);
    await settle();
    h.collectors.setSharing("p1", true);
    await settle();
    const before = h.collectors.summaryOf("p1")!;
    for (const text of CANARY) {
      h.emit(`${text}\r\n`);
      h.emit(`◐ ${text}\r\n`); // 제목 점 모양으로 시작하는 출력
      h.emit(`\u001b]0;◐ ${text}\u0007`); // OSC 제목 시퀀스 모양의 출력 바이트
    }
    h.tick(60_000);
    await settle();
    const after = h.collectors.summaryOf("p1")!;
    expect({ ...after, lastActivityAt: null }).toEqual({ ...before, lastActivityAt: null });
    expect(after.lastActivityAt).not.toBeNull();
    const everything = JSON.stringify([after, h.sent]);
    for (const text of CANARY) expect(everything).not.toContain(text);
  });

  it("OSC 제목은 점 모양 하나만 읽고 글은 어디에도 남지 않는다", async () => {
    const h = rig();
    await h.sessions.ensure("p1", 80, 24);
    await settle();
    h.collectors.setSharing("p1", true);
    for (const text of CANARY) h.mirrors[0]!.setTitle(`◐ ${text}`);
    await settle();
    const everything = JSON.stringify([h.collectors.summaryOf("p1"), h.sent]);
    for (const text of CANARY) expect(everything).not.toContain(text);
    expect(h.collectors.summaryOf("p1")!.stages).toContain(STAGE_LABEL["title-working"]);
  });

  it("하네스 라벨은 닫힌 목록으로만 옮긴다", () => {
    expect(harnessOf({ kind: "shell" })).toBe("shell");
    expect(harnessOf({ kind: "harness", id: "codex" } as never)).toBe("codex");
    expect(harnessOf({ kind: "harness", id: "mystery" } as never)).toBe("other");
  });
});
