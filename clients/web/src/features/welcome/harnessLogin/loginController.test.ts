// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import { HARNESS_LOGIN_TIMEOUT_MS } from "@momo/core/features/onboarding/harnessLogin";
import type { MirrorFactory, MirrorTerminal, PtyPort } from "@/features/workbench/local/localSessions";
import type { PtyExit, PtySpawnRequest } from "@/lib/tauri";
import { createLoginController, type LoginControllerDeps } from "./loginController";

// 가짜 CLI(가짜 PTY)로 로그인 흐름을 잰다: 콜백 성공, 코드 입력, 취소, 시간 초과,
// 로그인이 안 된 종료, 셸 거부. 가짜 CLI는 URL·코드·토큰 모양 문자열을 출력한다.
// 그 문자열이 저장소·콘솔 어디에도 남지 않아야 한다(ADR-0190 D3-g).

const FAKE_URL = "https://claude.ai/oauth/authorize?code_challenge=FAKE2816url";
const FAKE_TOKEN = "sk-ant-oat01-FAKE2816TOKENvalue";
const PASTED = "PASTED-2816-code#state";
const ENC = new TextEncoder();

class FakeMirror implements MirrorTerminal {
  cols: number;
  rows: number;
  chunks = 0;
  disposed = false;
  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  // 그리기만 흉내 낸다: 바이트를 해석하지 않고 개수만 센다.
  write(_data: string | Uint8Array, callback?: () => void) {
    this.chunks += 1;
    if (callback) queueMicrotask(callback);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  dispose() {
    this.disposed = true;
  }
  onTitleChange() {
    return { dispose: () => undefined };
  }
}

function fakeCli(probesAfter: LocalHarnessProbe[] | Error = []) {
  const spawns: PtySpawnRequest[] = [];
  const writes: Uint8Array[] = [];
  const kills: number[] = [];
  const mirrors: FakeMirror[] = [];
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
    write: vi.fn(async (_id, bytes) => void writes.push(bytes)),
    resize: vi.fn(async () => undefined),
    kill: vi.fn(async (id) => void kills.push(id)),
    ack: vi.fn(async () => undefined),
  };
  const loadMirror = async (): Promise<MirrorFactory> => ({
    create(cols, rows) {
      const mirror = new FakeMirror(cols, rows);
      mirrors.push(mirror);
      return { mirror, serialize: () => "" };
    },
  });
  const detect = vi.fn(async () => {
    if (probesAfter instanceof Error) throw probesAfter;
    return probesAfter;
  });
  const deps: LoginControllerDeps = { pty, loadMirror, detect };
  return {
    deps,
    spawns,
    writes,
    kills,
    mirrors,
    detect,
    failSpawn(error: Error) {
      spawnError = error;
    },
    /** 가짜 CLI가 로그인 화면을 그린다. */
    printLoginScreen() {
      for (const line of [`Opening ${FAKE_URL}\r\n`, "Paste code here if prompted > ", `token ${FAKE_TOKEN}\r\n`]) {
        output(ENC.encode(line).buffer as ArrayBuffer);
      }
    },
    exit(code: number | null, signal: string | null = null) {
      exit({ id: nextId - 1, code, signal });
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const LOGGED_IN: LocalHarnessProbe[] = [{ id: "claude", installed: true, auth: "logged_in" }];
const NEEDS_LOGIN: LocalHarnessProbe[] = [{ id: "claude", installed: true, auth: "needs_login" }];

let setItem: ReturnType<typeof vi.spyOn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setItem = vi.spyOn(Storage.prototype, "setItem");
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level)
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** URL·코드·토큰이 이 기기의 저장소와 콘솔 어디에도 없다. */
function expectNothingKept() {
  const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
  for (const secret of [FAKE_URL, FAKE_TOKEN, PASTED, "PASTED-2816"]) {
    expect(stored).not.toContain(secret);
    for (const call of setItem.mock.calls) expect(String(call)).not.toContain(secret);
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) expect(String(call)).not.toContain(secret);
    }
  }
  expect(setItem).not.toHaveBeenCalled();
}

describe("loginController (가짜 CLI)", () => {
  it("runs exactly the shell's login row and nothing the page chose", async () => {
    const cli = fakeCli(LOGGED_IN);
    const login = createLoginController("claude", "browser", cli.deps);
    login.open();
    await flush();
    expect(cli.spawns).toEqual([
      { program: { kind: "login", id: "claude", method: "browser" }, cols: 80, rows: 24 },
    ]);
    login.dispose();
  });

  it("콜백 성공: CLI가 끝나고 상태 명령이 로그인됨이면 연결됨", async () => {
    const cli = fakeCli(LOGGED_IN);
    const login = createLoginController("claude", "browser", cli.deps);
    login.open();
    await flush();
    cli.printLoginScreen();
    expect(login.getState().status).toEqual({ phase: "waiting" });
    cli.exit(0);
    await flush();
    expect(cli.detect).toHaveBeenCalledTimes(1);
    expect(login.getState().status).toEqual({ phase: "connected" });
    // 출력은 미러가 그렸다(그리기만).
    expect(cli.mirrors[0]!.chunks).toBeGreaterThan(0);
    expectNothingKept();
    login.dispose();
  });

  it("코드 입력: 붙인 코드를 Enter와 함께 PTY 입력으로만 넘긴다", async () => {
    const cli = fakeCli(LOGGED_IN);
    const login = createLoginController("claude", "browser", cli.deps);
    login.open();
    await flush();
    cli.printLoginScreen();
    login.submitCode(`  ${PASTED}\n`);
    await flush();
    expect(cli.writes.map((b) => new TextDecoder().decode(b))).toEqual([`${PASTED}\r`]);
    cli.exit(0);
    await flush();
    expect(login.getState().status).toEqual({ phase: "connected" });
    expectNothingKept();
    login.dispose();
  });

  it("종료 0이어도 상태 명령이 로그인됨이 아니면 실패다(종료 코드로 판정하지 않는다)", async () => {
    const cli = fakeCli(NEEDS_LOGIN);
    const login = createLoginController("claude", "browser", cli.deps);
    login.open();
    await flush();
    cli.exit(0);
    await flush();
    expect(login.getState().status).toEqual({ phase: "failed", reason: "not-logged-in" });
    login.dispose();
  });

  it("상태 명령이 실패해도 연결됨이라 하지 않는다", async () => {
    const cli = fakeCli(new Error("no shell"));
    const login = createLoginController("claude", "browser", cli.deps);
    login.open();
    await flush();
    cli.exit(0);
    await flush();
    expect(login.getState().status).toEqual({ phase: "failed", reason: "not-logged-in" });
    login.dispose();
  });

  it("취소: PTY를 끝내고, 뒤늦은 종료가 판정을 부르지 않는다", async () => {
    const cli = fakeCli(LOGGED_IN);
    const login = createLoginController("claude", "browser", cli.deps);
    login.open();
    await flush();
    cli.printLoginScreen();
    login.dispose();
    expect(cli.kills).toEqual([1]);
    expect(cli.mirrors[0]!.disposed).toBe(true);
    cli.exit(null, "SIGHUP");
    await flush();
    expect(cli.detect).not.toHaveBeenCalled();
    expectNothingKept();
  });

  it("시간 초과: 5분 뒤 PTY를 끝내고 실패로 둔다. 그 뒤의 종료는 무시한다", async () => {
    vi.useFakeTimers();
    const cli = fakeCli(LOGGED_IN);
    const login = createLoginController("codex", "browser", cli.deps);
    login.open();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HARNESS_LOGIN_TIMEOUT_MS - 1);
    expect(login.getState().status).toEqual({ phase: "waiting" });
    expect(cli.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(login.getState().status).toEqual({ phase: "failed", reason: "timeout" });
    expect(cli.kills).toEqual([1]);
    cli.exit(null, "SIGHUP");
    await vi.advanceTimersByTimeAsync(0);
    expect(cli.detect).not.toHaveBeenCalled();
    expect(login.getState().status).toEqual({ phase: "failed", reason: "timeout" });
    // 화면(미러)은 남아 「터미널로 보기」로 볼 수 있다.
    expect(cli.mirrors[0]!.disposed).toBe(false);
    login.dispose();
  });

  it("셸이 거부하면(PTY 없음) spawn 실패로 Phase 1에 넘긴다", async () => {
    const cli = fakeCli(LOGGED_IN);
    cli.failSpawn(new Error("local terminal unavailable"));
    const login = createLoginController("claude", "browser", cli.deps);
    login.open();
    await flush();
    await flush();
    expect(login.getState().status).toEqual({ phase: "failed", reason: "spawn" });
    login.dispose();
  });

  it("Codex 기기 코드로 다시 시도: 앞 PTY를 끝내고 device 줄을 연다", async () => {
    const cli = fakeCli([{ id: "codex", installed: true, auth: "needs_login" }]);
    const login = createLoginController("codex", "browser", cli.deps);
    login.open();
    await flush();
    cli.exit(1);
    await flush();
    expect(login.getState().status).toEqual({ phase: "failed", reason: "not-logged-in" });
    login.retry("device");
    await flush();
    expect(cli.spawns.map((s) => s.program)).toEqual([
      { kind: "login", id: "codex", method: "browser" },
      { kind: "login", id: "codex", method: "device" },
    ]);
    expect(login.getState()).toMatchObject({ method: "device", paneId: "login-2", status: { phase: "waiting" } });
    // 코드 입력은 claude browser 흐름에서만 의미가 있지만, 기다림이 아니면 아무것도 보내지 않는다.
    login.dispose();
    login.submitCode("x");
    expect(cli.writes).toEqual([]);
  });
});

// ---- 소스 시험 --------------------------------------------------------------

const SOURCES = import.meta.glob(["./*.ts", "./*.tsx", "!./*.test.ts", "!./*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("로그인 PTY 출력은 해석·저장·로그·전송 경로에 닿지 않는다 (ADR-0190 D3-f·D3-g)", () => {
  it("covers the controller and the dialog", () => {
    expect(Object.keys(SOURCES).sort()).toEqual(
      expect.arrayContaining(["./HarnessLoginDialog.tsx", "./loginController.ts"])
    );
  });

  it("no decoder, storage, console, network or server call in the sign-in code", () => {
    for (const [name, src] of Object.entries(SOURCES)) {
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const needle of [
        "TextDecoder",
        "fromCharCode",
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "console.",
        "fetch(",
        "XMLHttpRequest",
        "WebSocket",
        "sendBeacon",
        "@momo/core/api",
        "browserStorage",
        "loadScrollback",
      ]) {
        expect(code.includes(needle), `${name} uses ${needle}`).toBe(false);
      }
    }
  });

  it("the controller's session manager has no scrollback storage", () => {
    const src = SOURCES["./loginController.ts"]!;
    expect(src).toContain("storage: () => null");
    expect(src.match(/createLocalSessions\(/g)).toHaveLength(1);
  });
});

const OTHER_PTY_CALLERS = import.meta.glob(
  ["../../workbench/**/*.ts", "../../workbench/**/*.tsx", "!../../**/*.test.ts", "!../../**/*.test.tsx"],
  { query: "?raw", import: "default", eager: true }
) as Record<string, string>;

describe("로그인 명령은 로그인 모달만 띄운다", () => {
  it("the terminal dock and workbench never build a login program", () => {
    expect(Object.keys(OTHER_PTY_CALLERS).length).toBeGreaterThan(5);
    for (const [name, src] of Object.entries(OTHER_PTY_CALLERS)) {
      expect(/kind:\s*"login"/.test(src), `${name} builds a login program`).toBe(false);
    }
    expect(SOURCES["./loginController.ts"]).toMatch(/kind:\s*"login"/);
  });
});
