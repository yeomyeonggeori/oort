import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PTY_WRITE_MAX_BYTES } from "@momo/core/features/workbench/ptyFlow";
import { scrollbackEntry, serializeScrollback } from "@momo/core/features/workbench/scrollbackStore";
import type { PtyExit } from "@/lib/tauri";
import { Terminal as HeadlessTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  RESTORE_SEPARATOR,
  createLocalSessions,
  type MirrorFactory,
  type MirrorTerminal,
  type PtyPort,
  type ScrollbackStorage,
  type TerminalLike,
} from "./localSessions";

// 세션 관리자의 흐름 제어·붙여넣기·복원·저장을 가짜 PTY와 가짜 미러로 잰다.
// 가짜 미러는 쓴 것을 문자열로 모으고, 쓰기 콜백을 마이크로태스크로 늦춘다
// (xterm의 파싱이 비동기인 것과 같은 모양).

class FakeMirror implements MirrorTerminal {
  cols: number;
  rows: number;
  text = "";
  disposed = false;
  private title: ((t: string) => void) | null = null;
  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  write(data: string | Uint8Array, callback?: () => void) {
    this.text += typeof data === "string" ? data : new TextDecoder().decode(data);
    if (callback) queueMicrotask(callback);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  dispose() {
    this.disposed = true;
  }
  onTitleChange(listener: (t: string) => void) {
    this.title = listener;
    return { dispose: () => (this.title = null) };
  }
  setTitle(t: string) {
    this.title?.(t);
  }
}

class FakeView implements TerminalLike {
  cols = 80;
  rows = 24;
  text = "";
  write(data: string | Uint8Array) {
    this.text += typeof data === "string" ? data : new TextDecoder().decode(data);
  }
  resize() {}
  dispose() {}
}

function memoryStorage(seed: Record<string, string> = {}): ScrollbackStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

/** 진짜 headless 미러(앱이 쓰는 것과 같은 조합). 파싱 순서와 콜백 시점이 진짜다. */
const realFactory: MirrorFactory = {
  create(cols, rows) {
    const mirror = new HeadlessTerminal({ cols, rows, scrollback: 5_000, allowProposedApi: true });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer as unknown as Parameters<typeof mirror.loadAddon>[0]);
    return {
      mirror: mirror as unknown as MirrorTerminal,
      serialize: (lines) => serializer.serialize({ scrollback: lines }),
    };
  },
};

function harness(
  options: { storage?: ScrollbackStorage | null; writeError?: string; real?: boolean } = {}
) {
  const mirrors: FakeMirror[] = [];
  const acks: number[] = [];
  const writes: Uint8Array[] = [];
  const kills: number[] = [];
  const resizes: [number, number, number][] = [];
  let output: (b: ArrayBuffer) => void = () => undefined;
  let exit: (e: PtyExit) => void = () => undefined;
  let nextId = 1;
  const spawns: unknown[] = [];
  const pty: PtyPort = {
    spawn: vi.fn(async (request, onOutput, onExit) => {
      spawns.push(request);
      output = onOutput;
      exit = onExit;
      return nextId++;
    }),
    write: vi.fn(async (_id, bytes) => {
      writes.push(bytes);
      if (options.writeError) throw new Error(options.writeError);
    }),
    resize: vi.fn(async (id, cols, rows) => void resizes.push([id, cols, rows])),
    kill: vi.fn(async (id) => void kills.push(id)),
    ack: vi.fn(async (_id, bytes) => void acks.push(bytes)),
  };
  const factory: MirrorFactory = {
    create(cols, rows) {
      const mirror = new FakeMirror(cols, rows);
      mirrors.push(mirror);
      return { mirror, serialize: (lines) => `[${lines}]` + mirror.text };
    },
  };
  const storage = options.storage === undefined ? memoryStorage() : options.storage;
  const sessions = createLocalSessions({
    pty,
    loadMirror: async () => (options.real ? realFactory : factory),
    storage: () => storage,
  });
  return {
    sessions,
    pty,
    mirrors,
    acks,
    writes,
    kills,
    resizes,
    spawns,
    storage,
    emit: (text: string) => output(new TextEncoder().encode(text).buffer as ArrayBuffer),
    emitBytes: (n: number) => output(new Uint8Array(n).fill(65).buffer as ArrayBuffer),
    exit: (e: PtyExit) => exit(e),
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("흐름 제어(ack)", () => {
  it("1 KiB 조각 200개에 pty_ack는 몇 번뿐이고, 합은 받은 바이트와 같다", async () => {
    const h = harness();
    await h.sessions.ensure("p1", 80, 24);
    for (let i = 0; i < 200; i++) h.emitBytes(1024);
    await settle();
    vi.advanceTimersByTime(20);
    await settle();
    // 조각마다 ack하면 200번이다(#2824 R1의 RSS 700 MB 원인).
    expect(h.acks.length).toBeLessThanOrEqual(4);
    expect(h.acks.reduce((a, b) => a + b, 0)).toBe(200 * 1024);
  });

  it("ack는 미러가 파싱을 끝낸 뒤에 센다(콜백 전에는 0)", async () => {
    const h = harness();
    await h.sessions.ensure("p1", 80, 24);
    for (let i = 0; i < 100; i++) h.emitBytes(1024);
    // 동기 구간: 미러 콜백이 아직 안 돌았다.
    expect(h.acks).toEqual([]);
    await settle();
    expect(h.acks.length).toBeGreaterThan(0);
  });

  it("프로세스가 끝난 뒤에는 ack를 보내지 않는다", async () => {
    const h = harness();
    await h.sessions.ensure("p1", 80, 24);
    h.emitBytes(10);
    h.exit({ id: 1, code: 0, signal: null });
    await settle();
    vi.advanceTimersByTime(50);
    expect(h.acks).toEqual([]);
    expect(h.sessions.getSnapshot().get("p1")?.phase).toBe("exited");
    expect(h.mirrors[0]!.text).toContain("프로세스가 끝났습니다(코드 0)");
  });
});

describe("입력", () => {
  it("1.5 MiB 붙여넣기는 1 MiB 이하 두 번의 pty_write로 순서대로 간다", async () => {
    const h = harness();
    await h.sessions.ensure("p1", 80, 24);
    const big = "가".repeat(Math.ceil((PTY_WRITE_MAX_BYTES * 1.5) / 3));
    h.sessions.input("p1", big);
    await settle();
    expect(h.writes.length).toBe(2);
    expect(h.writes.every((w) => w.length <= PTY_WRITE_MAX_BYTES)).toBe(true);
    const joined = new Uint8Array(h.writes[0]!.length + h.writes[1]!.length);
    joined.set(h.writes[0]!, 0);
    joined.set(h.writes[1]!, h.writes[0]!.length);
    expect(new TextDecoder().decode(joined)).toBe(big);
  });

  it("셸이 busy로 거부하면 칸에 한 줄로 말한다", async () => {
    const h = harness({ writeError: "busy: the terminal is not reading its input" });
    await h.sessions.ensure("p1", 80, 24);
    h.sessions.input("p1", "ls\r");
    await settle();
    expect(h.sessions.getSnapshot().get("p1")?.inputNotice).toContain("입력을 읽지 않아");
  });
});

describe("복원과 저장", () => {
  it("저장된 화면을 미러에 먼저 쓰고 구분선 뒤에 새 셸을 띄운다", async () => {
    const storage = memoryStorage({
      [scrollbackEntry("dock", "p1")]: serializeScrollback({
        v: 1,
        data: "$ echo 전의 화면\r\n전의 화면\r\n",
        cols: 80,
        rows: 24,
        savedAt: 1,
      }),
    });
    const h = harness({ storage });
    await h.sessions.ensure("p1", 80, 24);
    const text = h.mirrors[0]!.text;
    expect(text.indexOf("전의 화면")).toBeLessThan(text.indexOf(RESTORE_SEPARATOR));
    expect(h.sessions.getSnapshot().get("p1")?.restored).toBe(true);
    expect(h.spawns).toEqual([{ program: { kind: "shell" }, cols: 80, rows: 24 }]);
  });

  it("출력이 멎으면 이 기기에 저장하고, 계속 흘러도 최대 대기 안에 저장한다", async () => {
    const storage = memoryStorage();
    const h = harness({ storage });
    await h.sessions.ensure("p1", 80, 24);
    h.emit("hello\r\n");
    vi.advanceTimersByTime(900);
    expect(storage.getItem(scrollbackEntry("dock", "p1"))).toContain("hello");

    // 200 ms마다 출력이 이어지면 멎은 틈이 없어도 3초 안에 저장된다.
    storage.map.clear();
    for (let t = 0; t < 3200; t += 200) {
      h.emit(`tick ${t}\r\n`);
      vi.advanceTimersByTime(200);
    }
    expect(storage.getItem(scrollbackEntry("dock", "p1"))).not.toBeNull();
  });

  it("저장소가 없으면 칸이 그렇다고 말한다(조용히 잃지 않는다)", async () => {
    const h = harness({ storage: null });
    await h.sessions.ensure("p1", 80, 24);
    h.emit("x");
    vi.advanceTimersByTime(900);
    expect(h.sessions.getSnapshot().get("p1")?.storageFailed).toBe(true);
  });

  it("칸을 닫으면 프로세스를 끝내고 저장한 화면도 지운다", async () => {
    const storage = memoryStorage();
    const h = harness({ storage });
    await h.sessions.ensure("p1", 80, 24);
    h.emit("secret-ish output\r\n");
    vi.advanceTimersByTime(900);
    expect(storage.map.size).toBe(1);
    h.sessions.close("p1");
    expect(h.kills).toEqual([1]);
    expect(storage.map.size).toBe(0);
    expect(h.mirrors[0]!.disposed).toBe(true);
  });

  it("지금 배치에 없는 칸의 항목만 정리한다", () => {
    const storage = memoryStorage({
      [scrollbackEntry("dock", "p1")]: "a",
      [scrollbackEntry("dock", "p9")]: "b",
      "momo.web.theme": "dark",
    });
    const h = harness({ storage });
    h.sessions.prune(["p1"]);
    expect([...storage.map.keys()].sort()).toEqual([scrollbackEntry("dock", "p1"), "momo.web.theme"].sort());
  });
});

describe("보이는 xterm 붙이기", () => {
  it("미러가 받아 둔 것부터 그리고, 붙는 동안 온 조각을 잃지 않는다(진짜 headless)", async () => {
    vi.useRealTimers();
    const h = harness({ real: true });
    await h.sessions.ensure("p1", 80, 24);
    h.emit("before\r\n");
    const view = new FakeView();
    h.sessions.attach("p1", view);
    h.emit("during\r\n");
    await vi.waitFor(() => expect(view.text).toContain("during"));
    h.emit("after\r\n");
    expect(view.text).toContain("before");
    expect(view.text.indexOf("before")).toBeLessThan(view.text.indexOf("during"));
    expect(view.text.indexOf("during")).toBeLessThan(view.text.indexOf("after"));
    // 「during」은 직렬화에도 큐에도 들어가 두 번 그려지면 안 된다.
    expect(view.text.split("during").length - 1).toBe(1);
  });

  it("같은 칸을 두 번 ensure해도 PTY는 하나", async () => {
    const h = harness();
    await Promise.all([h.sessions.ensure("p1", 80, 24), h.sessions.ensure("p1", 80, 24)]);
    expect(h.spawns.length).toBe(1);
  });

  it("새 세션 메뉴가 고른 하네스로 칸을 띄운다", async () => {
    const h = harness();
    h.sessions.setPendingProgram("p2", { kind: "harness", id: "codex" });
    await h.sessions.ensure("p2", 100, 30);
    expect(h.spawns).toEqual([{ program: { kind: "harness", id: "codex" }, cols: 100, rows: 30 }]);
  });
});

describe("앱 재시작 왕복(진짜 headless 미러)", () => {
  it("앞 실행이 저장한 스크롤백이 다음 실행의 칸 위에 그대로 있다", async () => {
    vi.useRealTimers();
    const storage = memoryStorage();
    const first = harness({ storage, real: true });
    await first.sessions.ensure("p1", 80, 24);
    for (let i = 0; i < 300; i++) first.emit(`line ${i} 한글 줄\r\n`);
    await vi.waitFor(() => {
      first.sessions.persistAll();
      expect(storage.getItem(scrollbackEntry("dock", "p1")) ?? "").toContain("line 299 한글 줄");
    });

    // 새 실행: 새 관리자, 같은 저장소. PTY는 새로 뜬다.
    const second = harness({ storage, real: true });
    await second.sessions.ensure("p1", 80, 24);
    const view = new FakeView();
    second.sessions.attach("p1", view);
    await vi.waitFor(() => expect(view.text).toContain("line 299 한글 줄"));
    expect(view.text).toContain("line 0 한글 줄");
    expect(view.text).toContain("앱을 다시 열어 새 셸을 시작했습니다");
    expect(second.spawns.length).toBe(1);
  });
});
