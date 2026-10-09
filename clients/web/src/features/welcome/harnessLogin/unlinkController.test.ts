// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_LOGOUT_TIMEOUT_MS,
  type ProfileRemoveOutcome,
} from "@momo/core/features/settings/harnessProfiles";
import type { MirrorFactory, PtyPort } from "@/features/workbench/local/localSessions";
import type { PtyExit, PtySpawnRequest } from "@/lib/tauri";
import { createUnlinkController } from "./unlinkController";

// 가짜 CLI(가짜 PTY)로 연결 해제를 잰다(#2878, ADR-0190 D3-f 「연결 해제 순서」).
// 폴더 삭제(`remove`)는 로그아웃이 종료 코드 0으로 끝났을 때만 불린다. 그 밖의 결말
// 에서는 한 번도 불리지 않는다(폴더가 남는다). 가짜 CLI가 토큰 모양 문자열을 내도
// 저장소·콘솔에 남지 않는다.

const FAKE_TOKEN = "sk-ant-oat01-FAKE2878TOKENvalue";
const ENC = new TextEncoder();
const PROFILE = { harness: "claude" as const, label: "회사" };

function fakeCli(outcome: ProfileRemoveOutcome | Error = "removed") {
  const spawns: PtySpawnRequest[] = [];
  const kills: number[] = [];
  let output: (b: ArrayBuffer) => void = () => undefined;
  let exit: (e: PtyExit) => void = () => undefined;
  let nextId = 1;
  let spawnError: Error | null = null;
  const pty: PtyPort = {
    spawn: vi.fn(async (request, onOutput, onExit) => {
      if (spawnError) throw spawnError;
      spawns.push(request);
      output = onOutput;
      exit = onExit;
      return nextId++;
    }),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    kill: vi.fn(async (id) => void kills.push(id)),
    ack: vi.fn(async () => undefined),
  };
  const factory: MirrorFactory = {
    create(cols, rows) {
      return {
        mirror: {
          cols,
          rows,
          write: (_d: string | Uint8Array, cb?: () => void) => cb && queueMicrotask(cb),
          resize: () => undefined,
          dispose: () => undefined,
          onTitleChange: () => ({ dispose: () => undefined }),
        },
        serialize: () => FAKE_TOKEN,
      };
    },
  };
  const remove = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return {
    deps: { pty, loadMirror: async () => factory, remove },
    spawns,
    kills,
    remove,
    failSpawn(error: Error) {
      spawnError = error;
    },
    print() {
      output(ENC.encode(`Logging out ${FAKE_TOKEN}\r\n`).buffer as ArrayBuffer);
    },
    exit(code: number | null, signal: string | null = null) {
      exit({ id: nextId - 1, code, signal });
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

let setItem: ReturnType<typeof vi.spyOn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  localStorage.clear();
  setItem = vi.spyOn(Storage.prototype, "setItem");
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function expectNothingKept() {
  expect(setItem).not.toHaveBeenCalled();
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) expect(String(call)).not.toContain(FAKE_TOKEN);
  }
}

describe("unlinkController (가짜 CLI)", () => {
  it("확인 전에는 아무것도 띄우지 않고, 확인하면 셸의 로그아웃 줄 하나를 프로필 라벨로 연다", async () => {
    const cli = fakeCli();
    const unlink = createUnlinkController(PROFILE, cli.deps);
    await flush();
    expect(cli.spawns).toEqual([]);
    expect(unlink.getState().status).toEqual({ phase: "confirm" });
    unlink.confirm();
    await flush();
    expect(cli.spawns).toEqual([
      { program: { kind: "logout", id: "claude", profile: "회사" }, cols: 80, rows: 24 },
    ]);
    expect(unlink.getState().status).toEqual({ phase: "signing-out" });
    unlink.dispose();
  });

  it("로그아웃 0 → 셸 삭제 → 끝", async () => {
    const cli = fakeCli("removed");
    const unlink = createUnlinkController(PROFILE, cli.deps);
    unlink.confirm();
    await flush();
    cli.print();
    cli.exit(0);
    await flush();
    expect(cli.remove).toHaveBeenCalledTimes(1);
    expect(cli.remove).toHaveBeenCalledWith(PROFILE);
    expect(unlink.getState().status).toEqual({ phase: "done" });
    expectNothingKept();
    unlink.dispose();
  });

  it("로그아웃이 0이 아니면(또는 신호로 끝나면) 폴더를 지우지 않는다", async () => {
    for (const [code, signal] of [
      [1, null],
      [null, "SIGHUP"],
    ] as const) {
      const cli = fakeCli("removed");
      const unlink = createUnlinkController(PROFILE, cli.deps);
      unlink.confirm();
      await flush();
      cli.exit(code, signal);
      await flush();
      expect(cli.remove, `${code} ${signal}`).not.toHaveBeenCalled();
      expect(unlink.getState().status).toEqual({ phase: "failed", reason: "logout-failed" });
      unlink.dispose();
    }
  });

  it("셸이 아직 로그인됨·모름이라 하면 실패로 둔다(셸이 폴더를 남겼다)", async () => {
    for (const [outcome, reason] of [
      ["still_signed_in", "still-signed-in"],
      ["unknown", "unknown"],
    ] as const) {
      const cli = fakeCli(outcome);
      const unlink = createUnlinkController(PROFILE, cli.deps);
      unlink.confirm();
      await flush();
      cli.exit(0);
      await flush();
      expect(unlink.getState().status).toEqual({ phase: "failed", reason });
      unlink.dispose();
    }
  });

  it("셸 삭제가 거부되면 remove-failed", async () => {
    const cli = fakeCli(new Error("refused: a step of the profile folder is a symlink"));
    const unlink = createUnlinkController(PROFILE, cli.deps);
    unlink.confirm();
    await flush();
    cli.exit(0);
    await flush();
    expect(unlink.getState().status).toEqual({ phase: "failed", reason: "remove-failed" });
    unlink.dispose();
  });

  it("정리만 실패했으면 다시 시도는 로그아웃을 건너뛰고 셸 정리만 다시 묻는다", async () => {
    const cli = fakeCli(new Error("could not remove: busy"));
    const unlink = createUnlinkController(PROFILE, cli.deps);
    unlink.confirm();
    await flush();
    cli.exit(0);
    await flush();
    expect(unlink.getState().status).toEqual({ phase: "failed", reason: "remove-failed" });
    cli.remove.mockResolvedValueOnce("removed");
    unlink.confirm();
    await flush();
    expect(cli.spawns).toHaveLength(1);
    expect(cli.remove).toHaveBeenCalledTimes(2);
    expect(unlink.getState().status).toEqual({ phase: "done" });
    unlink.dispose();
  });

  it("시간 초과: PTY를 끝내고 실패로 둔다. 뒤늦은 종료 0도 폴더를 지우지 않는다", async () => {
    vi.useFakeTimers();
    const cli = fakeCli("removed");
    const unlink = createUnlinkController(PROFILE, cli.deps);
    unlink.confirm();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HARNESS_LOGOUT_TIMEOUT_MS - 1);
    expect(unlink.getState().status).toEqual({ phase: "signing-out" });
    await vi.advanceTimersByTimeAsync(1);
    expect(unlink.getState().status).toEqual({ phase: "failed", reason: "timeout" });
    expect(cli.kills).toEqual([1]);
    cli.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(cli.remove).not.toHaveBeenCalled();
    unlink.dispose();
  });

  it("닫기(취소): PTY를 끝내고, 뒤늦은 종료가 삭제를 부르지 않는다", async () => {
    const cli = fakeCli("removed");
    const unlink = createUnlinkController(PROFILE, cli.deps);
    unlink.confirm();
    await flush();
    unlink.dispose();
    expect(cli.kills).toEqual([1]);
    cli.exit(0);
    await flush();
    expect(cli.remove).not.toHaveBeenCalled();
  });

  it("셸이 PTY를 거부하면 spawn 실패, 폴더 그대로", async () => {
    const cli = fakeCli("removed");
    cli.failSpawn(new Error("refused: that is a CLI's default folder"));
    const unlink = createUnlinkController(PROFILE, cli.deps);
    unlink.confirm();
    await flush();
    await flush();
    expect(unlink.getState().status).toEqual({ phase: "failed", reason: "spawn" });
    expect(cli.remove).not.toHaveBeenCalled();
    unlink.dispose();
  });

  it("다시 시도: 앞 PTY를 닫고 새 로그아웃을 연다", async () => {
    const cli = fakeCli("removed");
    const unlink = createUnlinkController(PROFILE, cli.deps);
    unlink.confirm();
    await flush();
    cli.exit(1);
    await flush();
    unlink.confirm();
    await flush();
    expect(cli.spawns).toHaveLength(2);
    expect(unlink.getState()).toMatchObject({ paneId: "logout-2", status: { phase: "signing-out" } });
    // 진행 중에는 다시 누를 수 없다.
    unlink.confirm();
    await flush();
    expect(cli.spawns).toHaveLength(2);
    cli.exit(0);
    await flush();
    expect(unlink.getState().status).toEqual({ phase: "done" });
    unlink.dispose();
  });
});

describe("unlinkController: 이 맥의 기본 로그인 (ADR-0198 D3, 「내 도구」 연결 끊기)", () => {
  const DEFAULT = { harness: "claude" as const, label: null };
  function withVerify(auth: "logged_in" | "needs_login" | "unknown", cli = fakeCli()) {
    const verify = vi.fn(async () => [{ id: "claude" as const, installed: true, auth }]);
    return { cli, verify, deps: { ...cli.deps, verify } };
  }

  it("프로필 없는 로그아웃 줄 하나를 연다(경로·인자 없음)", async () => {
    const { cli, deps } = withVerify("needs_login");
    const unlink = createUnlinkController(DEFAULT, deps);
    unlink.confirm();
    await flush();
    expect(cli.spawns).toEqual([
      { program: { kind: "logout", id: "claude" }, cols: 80, rows: 24 },
    ]);
    unlink.dispose();
  });

  it("종료 0 뒤 상태 명령이 로그인 아님일 때만 done이고, 폴더 삭제(remove)는 부르지 않는다", async () => {
    const { cli, deps, verify } = withVerify("needs_login");
    const unlink = createUnlinkController(DEFAULT, deps);
    unlink.confirm();
    await flush();
    cli.exit(0);
    await flush();
    await flush();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(unlink.getState().status).toEqual({ phase: "done" });
    expect(cli.remove).not.toHaveBeenCalled();
    unlink.dispose();
  });

  it("종료 0이어도 아직 로그인이면 still-signed-in, 상태를 모르면 unknown", async () => {
    for (const [auth, reason] of [
      ["logged_in", "still-signed-in"],
      ["unknown", "unknown"],
    ] as const) {
      const { cli, deps } = withVerify(auth);
      const unlink = createUnlinkController(DEFAULT, deps);
      unlink.confirm();
      await flush();
      cli.exit(0);
      await flush();
      await flush();
      expect(unlink.getState().status).toEqual({ phase: "failed", reason });
      unlink.dispose();
    }
  });

  it("종료가 0이 아니면 상태 명령을 묻지도 않고 실패다", async () => {
    const { cli, deps, verify } = withVerify("needs_login");
    const unlink = createUnlinkController(DEFAULT, deps);
    unlink.confirm();
    await flush();
    cli.exit(1);
    await flush();
    expect(unlink.getState().status).toEqual({ phase: "failed", reason: "logout-failed" });
    expect(verify).not.toHaveBeenCalled();
    unlink.dispose();
  });

  it("상태 명령 자체가 실패하면 끊겼다고 하지 않는다", async () => {
    const cli = fakeCli();
    const verify = vi.fn(async () => {
      throw new Error("shell down");
    });
    const unlink = createUnlinkController(DEFAULT, { ...cli.deps, verify });
    unlink.confirm();
    await flush();
    cli.exit(0);
    await flush();
    await flush();
    expect(unlink.getState().status).toEqual({ phase: "failed", reason: "unknown" });
    unlink.dispose();
  });
});

const SOURCES = import.meta.glob(
  ["../../**/*.ts", "../../**/*.tsx", "!../../**/*.test.ts", "!../../**/*.test.tsx"],
  { query: "?raw", import: "default", eager: true }
) as Record<string, string>;

describe("로그아웃 명령은 해제 창만 만든다 (ADR-0190 D3-g)", () => {
  it("`kind: \"logout\"`을 만드는 곳은 unlinkController 하나다", () => {
    const builders = Object.entries(SOURCES)
      .filter(([, src]) => /kind:\s*"logout"/.test(src))
      .map(([name]) => name);
    expect(builders).toEqual(["./unlinkController.ts"]);
  });

  it("oort 화면 코드는 CLI의 자격 파일·키체인 항목을 이름으로도 부르지 않는다", () => {
    const names = Object.keys(SOURCES);
    for (const required of ["./unlinkController.ts", "./HarnessUnlinkDialog.tsx", "./HarnessLoginDialog.tsx"]) {
      expect(names).toContain(required);
    }
    expect(names.some((name) => name.endsWith("settings/AiMyAccountsSection.tsx"))).toBe(true);
    for (const [name, src] of Object.entries(SOURCES)) {
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const needle of [".credentials.json", "auth.json", "Claude Code-credentials", "delete-generic-password"]) {
        // 온보딩의 auth.json 안내는 오래된 붙여 넣기 경로의 제거 문장이다: 여기서는
        // 새로 쓴 해제 표면만 본다.
        const surface =
          name.startsWith("./") ||
          name.endsWith("settings/AiMyAccountsSection.tsx") ||
          name.endsWith("settings/AddSubscriptionDialog.tsx") ||
          name.endsWith("settings/aiMyAccountsModel.ts");
        if (!surface) continue;
        expect(code.includes(needle), `${name} names ${needle}`).toBe(false);
      }
    }
  });
});
