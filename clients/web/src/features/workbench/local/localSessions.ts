// =============================================================================
// 로컬 터미널 세션 관리자 (#2774, ADR-0190 D1·D2).
//
// 칸(pane) 하나 = PTY 하나 + headless 미러 하나. 이 모듈이 둘을 들고, React는
// 보이는 xterm만 붙였다 뗀다. 그래서:
//
// - 도크를 닫아도 PTY는 계속 돈다. 출력은 미러가 받는다. 다시 열면 보이는
//   xterm이 미러를 직렬화한 것부터 그리고 이어 받는다(`attach`).
// - 칸 최대화·전체 화면 전환으로 React가 칸을 다시 그려도 세션이 끊기지 않는다.
// - 앱을 닫았다 열면 PTY는 새로 뜬다(앱이 닫힐 때 셸이 모든 세션을 끝낸다,
//   #2772). 미러가 이 기기에 남긴 직렬화를 먼저 그리고, 구분선 뒤에 새 셸을
//   띄운다. 저장은 출력이 멎은 뒤 짧게 기다렸다 한다(종료 이벤트에 기대지
//   않는다: ⌘Q에서 WKWebView가 pagehide를 쏜다는 보장이 없다).
//
// 흐름 제어: 출력 조각은 미러가 파싱을 끝낸 뒤(`write` 콜백) 그 바이트 수를
// ack 묶음에 더한다. 묶음은 64 KiB 또는 16 ms 단위로 `pty_ack`를 보낸다
// (@momo/core ptyFlow). 보이는 xterm은 미러와 같은 속도로 파싱하므로 따로
// 세지 않는다.
//
// raw 출력은 이 기기 밖으로 나가지 않는다(ADR-0190 D2). 서버 호출이 없다.
// =============================================================================

import {
  chunkBytes,
  createAckBatcher,
  type AckBatcher,
} from "@momo/core/features/workbench/ptyFlow";
import {
  SCROLLBACK_ENTRY_PREFIX,
  SCROLLBACK_TOTAL_MAX_CHARS,
  fitSerialized,
  parseScrollback,
  scrollbackEntry,
  serializeScrollback,
  staleScrollbackEntries,
} from "@momo/core/features/workbench/scrollbackStore";
import { desktopPty, type PtyExit, type PtyProgram } from "@/lib/tauri";

/** 보이는 xterm이든 미러든, 이 모듈이 쓰는 xterm 표면. */
export interface TerminalLike {
  readonly cols: number;
  readonly rows: number;
  write(data: string | Uint8Array, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface MirrorTerminal extends TerminalLike {
  onTitleChange(listener: (title: string) => void): { dispose(): void };
}

export interface MirrorFactory {
  create(cols: number, rows: number): { mirror: MirrorTerminal; serialize: (lines: number) => string };
}

export interface PtyPort {
  spawn: typeof desktopPty.spawn;
  write: typeof desktopPty.write;
  resize: typeof desktopPty.resize;
  kill: typeof desktopPty.kill;
  ack: typeof desktopPty.ack;
}

export interface ScrollbackStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** 저장소의 모든 항목 이름. 오래된 스크롤백 정리에 쓴다. */
  keys(): string[];
}

export type LocalSessionPhase = "starting" | "running" | "exited" | "failed";

/** React가 읽는 한 칸의 상태. 바뀔 때마다 새 객체다. */
export interface LocalSessionView {
  paneId: string;
  program: PtyProgram;
  phase: LocalSessionPhase;
  /** OSC 제목(셸이 알려 준 것). 없으면 null. */
  title: string | null;
  exit: PtyExit | null;
  /** 시작 실패 사유(셸이 돌려준 글). */
  error: string | null;
  /** 입력을 보내지 못했을 때 한 줄. 다음 입력이 성공하면 지운다. */
  inputNotice: string | null;
  /** 앱을 다시 열어 전의 화면을 복원했다. */
  restored: boolean;
  /** 스크롤백을 이 기기에 저장하지 못했다. */
  storageFailed: boolean;
}

export const DOCK_SESSION_KEY = "dock";

/** 저장 대기: 출력이 이만큼 멎으면 저장한다. 계속 흐르면 최대 대기에서 한다. */
const PERSIST_IDLE_MS = 800;
const PERSIST_MAX_WAIT_MS = 3000;

const MIN_COLS = 2;
const MAX_COLS = 1000;
const MIN_ROWS = 1;
const MAX_ROWS = 500;

const TEXT_ENCODER = new TextEncoder();

/** 복원 구분선. 흐린 글씨(SGR 2)로 전의 화면과 새 셸을 가른다. */
export const RESTORE_SEPARATOR =
  "\r\n\u001b[2m──── 앱을 다시 열어 새 셸을 시작했습니다. 위는 전의 화면입니다. ────\u001b[0m\r\n";

export function exitLine(exit: PtyExit): string {
  const why =
    exit.signal !== null
      ? `신호 ${exit.signal}`
      : exit.code !== null
        ? `코드 ${exit.code}`
        : "코드 없음";
  return `\r\n\u001b[2m──── 프로세스가 끝났습니다(${why}). ────\u001b[0m\r\n`;
}

export function busyNotice(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.startsWith("busy")
    ? "터미널이 입력을 읽지 않아 방금 입력을 보내지 못했습니다. 실행 중인 프로그램이 입력을 받을 때 다시 입력하세요."
    : "입력을 터미널에 보내지 못했습니다. 칸을 닫고 새 세션을 여세요.";
}

function clampCols(cols: number): number {
  return Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(cols) || 80));
}

function clampRows(rows: number): number {
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(rows) || 24));
}

interface Session {
  view: LocalSessionView;
  mirror: MirrorTerminal;
  serialize: (lines: number) => string;
  ptyId: number | null;
  /** 이 세션의 spawn 세대. 다시 시작한 뒤 옛 PTY의 콜백을 버린다. */
  generation: number;
  batcher: AckBatcher | null;
  visible: TerminalLike | null;
  /** 보이는 xterm이 붙는 동안(미러가 밀린 것을 다 파싱하기 전) 온 조각. */
  attachQueue: Uint8Array[] | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persistFirstAt: number | null;
  disposed: boolean;
  titleSub: { dispose(): void } | null;
}

export interface LocalSessionsDeps {
  pty: PtyPort;
  loadMirror: () => Promise<MirrorFactory>;
  storage: () => ScrollbackStorage | null;
  sessionKey?: string;
  now?: () => number;
}

function browserStorage(): ScrollbackStorage | null {
  try {
    if (typeof window === "undefined") return null;
    const ls = window.localStorage;
    return {
      getItem: (k) => ls.getItem(k),
      setItem: (k, v) => ls.setItem(k, v),
      removeItem: (k) => ls.removeItem(k),
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      },
    };
  } catch {
    return null;
  }
}

async function loadBrowserMirror(): Promise<MirrorFactory> {
  const runtime = await import("./localTerminalRuntime");
  return {
    create(cols, rows) {
      const mirror = new runtime.HeadlessTerminal({
        cols,
        rows,
        scrollback: 5_000,
        allowProposedApi: true,
      });
      const serializer = new runtime.SerializeAddon();
      // SerializeAddon의 형식은 브라우저 Terminal을 받지만, 같은 코어라 headless
      // 미러에도 붙는다(Orca가 같은 조합을 쓴다, 제안서 §2.2).
      mirror.loadAddon(serializer as unknown as Parameters<typeof mirror.loadAddon>[0]);
      return {
        mirror: mirror as unknown as MirrorTerminal,
        serialize: (lines) => serializer.serialize({ scrollback: lines }),
      };
    },
  };
}

export function createLocalSessions(deps: LocalSessionsDeps) {
  const sessionKey = deps.sessionKey ?? DOCK_SESSION_KEY;
  const now = deps.now ?? (() => Date.now());
  const sessions = new Map<string, Session>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, LocalSessionView> = new Map();
  let mirrorFactory: Promise<MirrorFactory> | null = null;
  /** 칸이 처음 시작할 때 띄울 프로그램. 새 세션 메뉴가 분할 전에 적는다. */
  const pendingPrograms = new Map<string, PtyProgram>();
  const starting = new Map<string, Promise<void>>();

  const emit = () => {
    const next = new Map<string, LocalSessionView>();
    for (const [id, s] of sessions) next.set(id, s.view);
    snapshot = next;
    listeners.forEach((l) => l());
  };

  const update = (s: Session, patch: Partial<LocalSessionView>) => {
    s.view = { ...s.view, ...patch };
    emit();
  };

  const factory = () => {
    mirrorFactory ??= deps.loadMirror();
    return mirrorFactory;
  };

  // ---- 저장 -----------------------------------------------------------------

  const persistNow = (paneId: string) => {
    const s = sessions.get(paneId);
    if (!s || s.disposed) return;
    if (s.persistTimer !== null) clearTimeout(s.persistTimer);
    s.persistTimer = null;
    s.persistFirstAt = null;
    const storage = deps.storage();
    if (storage === null) {
      if (!s.view.storageFailed) update(s, { storageFailed: true });
      return;
    }
    const data = fitSerialized(s.serialize);
    let ok = data !== null;
    if (data !== null) {
      try {
        const entry = scrollbackEntry(sessionKey, paneId);
        // 모든 칸의 합 상한. 다른 칸이 이미 차지한 만큼을 빼고 본다.
        let others = 0;
        for (const key of storage.keys()) {
          if (key.startsWith(SCROLLBACK_ENTRY_PREFIX) && key !== entry) {
            others += storage.getItem(key)?.length ?? 0;
          }
        }
        const raw = serializeScrollback({
          v: 1,
          data,
          cols: clampCols(s.mirror.cols),
          rows: clampRows(s.mirror.rows),
          savedAt: now(),
        });
        if (others + raw.length > SCROLLBACK_TOTAL_MAX_CHARS) ok = false;
        else storage.setItem(entry, raw);
      } catch {
        ok = false;
      }
    }
    if (s.view.storageFailed === ok) update(s, { storageFailed: !ok });
  };

  const schedulePersist = (s: Session) => {
    const paneId = s.view.paneId;
    const t = now();
    s.persistFirstAt ??= t;
    if (s.persistTimer !== null) clearTimeout(s.persistTimer);
    const waited = t - s.persistFirstAt;
    const delay = Math.max(0, Math.min(PERSIST_IDLE_MS, PERSIST_MAX_WAIT_MS - waited));
    s.persistTimer = setTimeout(() => persistNow(paneId), delay);
  };

  // ---- 출력 -----------------------------------------------------------------

  const onOutput = (s: Session, generation: number, buffer: ArrayBuffer) => {
    if (s.disposed || s.generation !== generation) return;
    const bytes = new Uint8Array(buffer);
    const batcher = s.batcher;
    s.mirror.write(bytes, () => batcher?.add(bytes.byteLength));
    if (s.attachQueue !== null) s.attachQueue.push(bytes);
    else s.visible?.write(bytes);
    schedulePersist(s);
  };

  const onExit = (s: Session, generation: number, exit: PtyExit) => {
    if (s.disposed || s.generation !== generation) return;
    s.batcher?.dispose();
    s.batcher = null;
    s.ptyId = null;
    const line = exitLine(exit);
    s.mirror.write(line);
    if (s.attachQueue !== null) s.attachQueue.push(TEXT_ENCODER.encode(line));
    else s.visible?.write(line);
    update(s, { phase: "exited", exit });
    schedulePersist(s);
  };

  const spawnInto = async (s: Session) => {
    const generation = ++s.generation;
    update(s, { phase: "starting", exit: null, error: null, inputNotice: null });
    try {
      const id = await deps.pty.spawn(
        {
          program: s.view.program,
          cols: clampCols(s.mirror.cols),
          rows: clampRows(s.mirror.rows),
        },
        (buffer) => onOutput(s, generation, buffer),
        (exit) => onExit(s, generation, exit)
      );
      if (s.disposed || s.generation !== generation) {
        void deps.pty.kill(id).catch(() => undefined);
        return;
      }
      s.ptyId = id;
      s.batcher = createAckBatcher(
        (bytes) => {
          void deps.pty.ack(id, bytes).catch(() => undefined);
        },
        {
          schedule: (run, ms) => setTimeout(run, ms),
          cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        }
      );
      // 칸이 첫 출력을 기다리는 동안 크기가 바뀌었을 수 있다.
      void deps.pty.resize(id, clampCols(s.mirror.cols), clampRows(s.mirror.rows)).catch(() => undefined);
      update(s, { phase: "running" });
    } catch (error) {
      if (s.disposed || s.generation !== generation) return;
      update(s, {
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // ---- 공개 -----------------------------------------------------------------

  const api = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): ReadonlyMap<string, LocalSessionView> {
      return snapshot;
    },
    has(paneId: string): boolean {
      return sessions.has(paneId) || starting.has(paneId);
    },

    /** 새 세션 메뉴가 분할 직전에 부른다. 칸이 처음 시작할 때 이 프로그램을 띄운다. */
    setPendingProgram(paneId: string, program: PtyProgram): void {
      pendingPrograms.set(paneId, program);
    },

    /**
     * 칸의 세션이 없으면 만든다. 이 기기에 전의 화면이 있으면 미러에 먼저 쓰고
     * 구분선 뒤에 새 프로그램을 띄운다. 같은 칸에 두 번 불러도 하나만 뜬다.
     */
    ensure(paneId: string, cols: number, rows: number): Promise<void> {
      if (sessions.has(paneId)) return Promise.resolve();
      const inFlight = starting.get(paneId);
      if (inFlight) return inFlight;
      const run = (async () => {
        const program = pendingPrograms.get(paneId) ?? { kind: "shell" as const };
        pendingPrograms.delete(paneId);
        const { mirror, serialize } = (await factory()).create(clampCols(cols), clampRows(rows));
        const s: Session = {
          view: {
            paneId,
            program,
            phase: "starting",
            title: null,
            exit: null,
            error: null,
            inputNotice: null,
            restored: false,
            storageFailed: false,
          },
          mirror,
          serialize,
          ptyId: null,
          generation: 0,
          batcher: null,
          visible: null,
          attachQueue: null,
          persistTimer: null,
          persistFirstAt: null,
          disposed: false,
          titleSub: null,
        };
        s.titleSub = mirror.onTitleChange((title) => {
          const clean = title.trim().slice(0, 120);
          update(s, { title: clean === "" ? null : clean });
        });
        const storage = deps.storage();
        let restored = false;
        try {
          const saved = parseScrollback(storage?.getItem(scrollbackEntry(sessionKey, paneId)));
          if (saved !== null) {
            mirror.write(saved.data);
            mirror.write(RESTORE_SEPARATOR);
            restored = true;
          }
        } catch {
          /* 저장소를 못 읽으면 빈 화면에서 시작한다 */
        }
        s.view = { ...s.view, restored };
        sessions.set(paneId, s);
        emit();
        await spawnInto(s);
      })().finally(() => starting.delete(paneId));
      starting.set(paneId, run);
      return run;
    },

    /**
     * 보이는 xterm을 붙인다. 미러가 받아 둔 것(아직 파싱 중인 것까지)을 모두
     * 파싱한 뒤 그 직렬화를 그리고, 그동안 온 조각을 이어 그린다. 되돌리는
     * 함수는 떼기다.
     */
    attach(paneId: string, terminal: TerminalLike): () => void {
      const s = sessions.get(paneId);
      if (!s) return () => undefined;
      s.visible = terminal;
      s.attachQueue = [];
      s.mirror.write("", () => {
        if (s.visible !== terminal || s.attachQueue === null) return;
        const queued = s.attachQueue;
        s.attachQueue = null;
        terminal.write(s.serialize(5_000));
        for (const chunk of queued) terminal.write(chunk);
      });
      return () => {
        if (s.visible === terminal) {
          s.visible = null;
          s.attachQueue = null;
        }
      };
    },

    /** 키 입력과 붙여넣기. 1 MiB보다 크면 잘라 순서대로 보낸다. */
    input(paneId: string, data: string | Uint8Array): void {
      const s = sessions.get(paneId);
      if (!s || s.ptyId === null) return;
      const id = s.ptyId;
      const bytes = typeof data === "string" ? TEXT_ENCODER.encode(data) : data;
      for (const chunk of chunkBytes(bytes)) {
        deps.pty.write(id, chunk).then(
          () => {
            if (s.view.inputNotice !== null) update(s, { inputNotice: null });
          },
          (error: unknown) => update(s, { inputNotice: busyNotice(error) })
        );
      }
    },

    resize(paneId: string, cols: number, rows: number): void {
      const s = sessions.get(paneId);
      if (!s) return;
      const c = clampCols(cols);
      const r = clampRows(rows);
      if (s.mirror.cols === c && s.mirror.rows === r) return;
      s.mirror.resize(c, r);
      if (s.ptyId !== null) void deps.pty.resize(s.ptyId, c, r).catch(() => undefined);
    },

    /** 끝난 칸에서 같은 프로그램을 다시 띄운다. 화면은 그대로 둔다. */
    restart(paneId: string): Promise<void> {
      const s = sessions.get(paneId);
      if (!s || s.ptyId !== null) return Promise.resolve();
      return spawnInto(s);
    },

    /** 칸을 닫는다: 프로세스를 끝내고 이 기기의 스크롤백도 지운다. */
    close(paneId: string): void {
      pendingPrograms.delete(paneId);
      const s = sessions.get(paneId);
      if (!s) return;
      s.disposed = true;
      if (s.persistTimer !== null) clearTimeout(s.persistTimer);
      s.batcher?.dispose();
      s.titleSub?.dispose();
      if (s.ptyId !== null) void deps.pty.kill(s.ptyId).catch(() => undefined);
      s.mirror.dispose();
      sessions.delete(paneId);
      try {
        deps.storage()?.removeItem(scrollbackEntry(sessionKey, paneId));
      } catch {
        /* 다음 정리(prune)가 지운다 */
      }
      emit();
    },

    /** 지금 배치에 없는 칸의 스크롤백 항목을 지운다. */
    prune(livePaneIds: readonly string[]): void {
      const storage = deps.storage();
      if (!storage) return;
      try {
        for (const key of staleScrollbackEntries(storage.keys(), sessionKey, livePaneIds)) {
          storage.removeItem(key);
        }
      } catch {
        /* 저장소가 없으면 정리할 것도 없다 */
      }
    },

    /** 모든 칸을 지금 저장한다(pagehide 등). */
    persistAll(): void {
      for (const id of sessions.keys()) persistNow(id);
    },

    /** 시험용: 칸의 PTY id. */
    ptyIdOf(paneId: string): number | null {
      return sessions.get(paneId)?.ptyId ?? null;
    },
  };
  return api;
}

export type LocalSessions = ReturnType<typeof createLocalSessions>;

let shared: LocalSessions | null = null;

/** 앱에 하나. 도크가 닫혀도, 칸이 다시 그려져도 같은 세션을 본다. */
export function localSessions(): LocalSessions {
  if (shared === null) {
    shared = createLocalSessions({
      pty: desktopPty,
      loadMirror: loadBrowserMirror,
      storage: browserStorage,
    });
    if (typeof window !== "undefined") {
      const s = shared;
      window.addEventListener("pagehide", () => s.persistAll());
    }
  }
  return shared;
}
