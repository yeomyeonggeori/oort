// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHarnessId, LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import {
  HARNESS_LOGIN_CONNECTED_CLOSE_MS,
  LOGIN_TERMINAL_SHOW_LABEL,
} from "@momo/core/features/onboarding/harnessLogin";
import type { PtyExit } from "@/lib/tauri";
import { HarnessLoginDialog, type HarnessLoginFixture } from "./HarnessLoginDialog";

// 모달을 가짜 CLI(가짜 PTY)로 잰다: 기본 흐름에 터미널이 없고, 「터미널로 보기」를
// 펼쳐야만 칸이 붙고, 코드 칸은 보낸 뒤 비고, 연결됨이면 부른 쪽에 알리고 닫힌다.

const cli = vi.hoisted(() => ({
  exit: null as ((e: PtyExit) => void) | null,
  output: null as ((b: ArrayBuffer) => void) | null,
  writes: [] as Uint8Array[],
  kills: [] as number[],
  spawns: [] as unknown[],
  probes: [] as LocalHarnessProbe[],
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    detectLocalHarnesses: vi.fn(async () => cli.probes),
    openTerminalApp: vi.fn(async () => true),
    desktopPty: {
      spawn: vi.fn(async (request: unknown, onOutput: (b: ArrayBuffer) => void, onExit: (e: PtyExit) => void) => {
        cli.spawns.push(request);
        cli.output = onOutput;
        cli.exit = onExit;
        return 7;
      }),
      write: vi.fn(async (_id: number, bytes: Uint8Array) => void cli.writes.push(bytes)),
      resize: vi.fn(async () => undefined),
      kill: vi.fn(async (id: number) => void cli.kills.push(id)),
      ack: vi.fn(async () => undefined),
    },
  };
});

// 보이는 xterm 대신 붙었다는 표지만 남긴다(jsdom에는 캔버스가 없다).
vi.mock("@/features/workbench/local/LocalTerminalPane", () => ({
  LocalTerminalPane: (props: { pane: { id: string }; label?: string; restartable?: boolean }) => (
    <div
      data-testid="stub-terminal-pane"
      data-pane={props.pane.id}
      data-restartable={String(props.restartable)}
      aria-label={props.label}
    />
  ),
}));

// headless 미러 대신 그리기만 하는 가짜.
vi.mock("@/features/workbench/local/localSessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workbench/local/localSessions")>();
  return {
    ...actual,
    loadBrowserMirror: async () => ({
      create: (cols: number, rows: number) => ({
        mirror: {
          cols,
          rows,
          write: (_d: unknown, cb?: () => void) => cb && queueMicrotask(cb),
          resize: () => undefined,
          dispose: () => undefined,
          onTitleChange: () => ({ dispose: () => undefined }),
        },
        serialize: () => "",
      }),
    }),
  };
});

let root: Root | null = null;
let host: HTMLElement;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

function dq(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function click(el: Element | null) {
  if (!el) throw new Error("missing element");
  act(() => (el as HTMLElement).click());
}

function mount(
  harness: LocalHarnessId,
  handlers: {
    onClose?: () => void;
    onConnected?: (id: LocalHarnessId) => void;
    fixture?: HarnessLoginFixture;
  } = {}
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <HarnessLoginDialog
        harness={harness}
        onClose={handlers.onClose ?? (() => undefined)}
        onConnected={handlers.onConnected ?? (() => undefined)}
        onFallbackStarted={() => undefined}
        fixture={handlers.fixture ?? null}
      />
    );
  });
}

beforeEach(() => {
  cli.exit = null;
  cli.output = null;
  cli.writes = [];
  cli.kills = [];
  cli.spawns = [];
  cli.probes = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("HarnessLoginDialog", () => {
  it("기본 흐름: 공식 로그인 명령이 숨은 PTY에서 돌고, 터미널은 보이지 않는다", async () => {
    mount("claude");
    await flush();
    expect(cli.spawns).toEqual([
      { program: { kind: "login", id: "claude", method: "browser" }, cols: 80, rows: 24 },
    ]);
    expect(dq("harness-login-dialog")?.getAttribute("data-phase")).toBe("waiting");
    expect(dq("harness-login-line")?.textContent).toBe("브라우저에서 로그인하고 있어요.");
    expect(dq("stub-terminal-pane")).toBeNull();
    expect(dq("harness-login-terminal")).toBeNull();
    const toggle = dq("harness-login-terminal-toggle");
    expect(toggle?.textContent).toBe(LOGIN_TERMINAL_SHOW_LABEL);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    // 평문 단추: 단추 안에 로고·그림이 없다(ADR-0193 증보 약관 판단 2).
    expect(dq("harness-login-dialog")?.querySelectorAll("button svg, button img").length).toBe(0);
  });

  it("「터미널로 보기」를 펼치면 그 PTY가 붙고, 다시 시작 단추는 없다", async () => {
    mount("claude");
    await flush();
    click(dq("harness-login-terminal-toggle"));
    await flush();
    const pane = dq("stub-terminal-pane");
    expect(pane?.getAttribute("data-pane")).toBe("login-1");
    expect(pane?.getAttribute("data-restartable")).toBe("false");
    expect(pane?.getAttribute("aria-label")).toBe("Claude Code로 로그인 터미널");
  });

  it("코드 칸: 보낸 코드는 PTY 입력으로만 가고 칸은 곧바로 빈다", async () => {
    mount("claude");
    await flush();
    click(dq("harness-login-code-toggle"));
    const input = dq("harness-login-code-input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "PASTED-2816-code");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      (dq("harness-login-code-form") as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(cli.writes.map((b) => new TextDecoder().decode(b))).toEqual(["PASTED-2816-code\r"]);
    expect((dq("harness-login-code-input") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain("PASTED-2816");
  });

  it("연결됨: 상태 명령이 로그인됨이면 부른 쪽에 알리고 잠깐 뒤 닫는다", async () => {
    const onConnected = vi.fn();
    const onClose = vi.fn();
    cli.probes = [{ id: "claude", installed: true, auth: "logged_in" }];
    mount("claude", { onConnected, onClose });
    await flush();
    vi.useFakeTimers();
    act(() => cli.exit?.({ id: 7, code: 0, signal: null }));
    await flush();
    expect(dq("harness-login-line")?.textContent).toBe("연결됐어요.");
    expect(onConnected).toHaveBeenCalledWith("claude");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HARNESS_LOGIN_CONNECTED_CLOSE_MS);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("취소하면 PTY를 끝낸다", async () => {
    const onClose = vi.fn();
    mount("codex", { onClose });
    await flush();
    click(dq("harness-login-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    root = null;
    expect(cli.kills).toEqual([7]);
  });

  it("Codex 실패: 기기 코드로 다시 시도하면 device 줄이 뜨고 터미널이 펼쳐진다", async () => {
    cli.probes = [{ id: "codex", installed: true, auth: "needs_login" }];
    mount("codex");
    await flush();
    act(() => cli.exit?.({ id: 7, code: 1, signal: null }));
    await flush();
    expect(dq("harness-login-dialog")?.getAttribute("data-phase")).toBe("failed");
    click(dq("harness-login-device"));
    await flush();
    expect(cli.spawns.at(-1)).toEqual({
      program: { kind: "login", id: "codex", method: "device" },
      cols: 80,
      rows: 24,
    });
    expect(dq("stub-terminal-pane")?.getAttribute("data-pane")).toBe("login-2");
  });

  it("캡처 픽스처는 PTY를 만들지 않는다", async () => {
    mount("claude", { fixture: { status: { phase: "failed", reason: "timeout" } } });
    await flush();
    expect(cli.spawns).toEqual([]);
    expect(dq("harness-login-line")?.textContent).toBe("로그인이 끝나지 않았어요.");
  });
});
