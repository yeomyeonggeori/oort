// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHarnessId, LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import { HARNESS_LOGIN_CONNECTED_CLOSE_MS } from "@momo/core/features/onboarding/harnessLogin";
import { ApiError } from "@momo/core/lib/api";
import type { PtyExit } from "@/lib/tauri";
import { HarnessLoginDialog, type RegisterContext } from "./HarnessLoginDialog";

// 로그인이 끝난 같은 창이 「이 맥의 Claude Code를 @이름으로 부를 수 있게 할까요?」를
// 묻고, 사람이 누르기 전에는 서버도 셸도 부르지 않으며, 멈춤(Claude 기본 꺼짐)은
// 오류 모양이 아닌지를 가짜 CLI와 가짜 서버로 잰다.

const cli = vi.hoisted(() => ({
  exit: null as ((e: PtyExit) => void) | null,
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
      spawn: vi.fn(async (request: unknown, _o: unknown, onExit: (e: PtyExit) => void) => {
        cli.spawns.push(request);
        cli.exit = onExit;
        return 7;
      }),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
      ack: vi.fn(async () => undefined),
    },
  };
});

vi.mock("@/features/workbench/local/LocalTerminalPane", () => ({
  LocalTerminalPane: () => <div data-testid="stub-terminal-pane" />,
}));

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

const AGENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const VALUE = "pairing-FAKE3389VALUE.zzzzzzzzzzzz";
const ENDPOINT = "https://oort.example.test/v1/mcp/agent-port";

function wire(harness: "claude_code" | "codex" = "claude_code") {
  return {
    agent: { id: AGENT_ID, handle: "kim-claude", displayName: "kim-claude" },
    connection: {
      id: "c1",
      agentMemberId: AGENT_ID,
      status: "pairing_pending",
      authMode: "static_bearer",
      audience: "/v1/mcp/agent-port",
      approvedChannelIds: [],
      approvedScopes: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      invocationScope: "owner_only",
      subscriptionHarness: harness,
    },
    reused: false,
    pairingCredential: VALUE,
    pairingExpiresAtMs: 9_999_999_999_999,
  };
}

const calls = {
  register: vi.fn(),
  connect: vi.fn(),
  agents: vi.fn(),
};
let registerImpl: () => Promise<unknown>;
let connectImpl: () => Promise<unknown>;

function context(): RegisterContext {
  return {
    memberHandle: "kim",
    onOpenAgents: () => calls.agents(),
    deps: {
      register: async (body) => {
        calls.register(body);
        return registerImpl();
      },
      device: async () => ({ deviceId: "oort-abcdef0123456789", deviceLabel: null }),
      connect: async (request) => {
        calls.connect(request);
        return connectImpl() as ReturnType<RegisterContext["deps"]["connect"]>;
      },
      endpoint: () => ENDPOINT,
    },
  };
}

let root: Root | null = null;
let host: HTMLElement;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
const dq = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function click(el: Element | null) {
  if (!el) throw new Error("missing element");
  act(() => (el as HTMLElement).click());
}

function mount(
  harness: LocalHarnessId,
  extra: {
    onClose?: () => void;
    register?: RegisterContext | null;
    startAt?: "login" | "register";
  } = {}
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <HarnessLoginDialog
        harness={harness}
        onClose={extra.onClose ?? (() => undefined)}
        onConnected={() => undefined}
        onFallbackStarted={() => undefined}
        register={extra.register === undefined ? context() : extra.register}
        startAt={extra.startAt}
      />
    );
  });
}

async function loginSucceeds(harness: LocalHarnessId) {
  cli.probes = [{ id: harness, installed: true, auth: "logged_in" }];
  await flush();
  act(() => cli.exit?.({ id: 7, code: 0, signal: null }));
  await flush();
}

beforeEach(() => {
  cli.exit = null;
  cli.spawns = [];
  cli.probes = [];
  calls.register.mockReset();
  calls.connect.mockReset();
  calls.agents.mockReset();
  registerImpl = async () => wire();
  connectImpl = async () => ({ outcome: "connected" });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("로그인 → 확인 → 만드는 중 → 끝", () => {
  it("로그인 뒤 닫히지 않고 같은 창이 질문하며, 누르기 전에는 아무것도 부르지 않는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onClose = vi.fn();
    mount("claude", { onClose });
    await loginSucceeds("claude");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HARNESS_LOGIN_CONNECTED_CLOSE_MS * 3);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(dq("register-confirm")).not.toBeNull();
    expect(dq("register-line")?.textContent).toBe(
      "이 맥의 Claude Code를 @kim-claude로 부를 수 있게 할까요?"
    );
    expect((dq("register-name") as HTMLInputElement).value).toBe("kim-claude");
    expect(dq("register-create")?.textContent).toBe("@kim-claude 만들기");
    expect(dq("harness-login-dialog")?.textContent).toContain("로그인 정보는 oort에 저장하지 않아요.");
    expect(calls.register).not.toHaveBeenCalled();
    expect(calls.connect).not.toHaveBeenCalled();
  });

  it("[@이름 만들기]를 누르면 등록 뒤 연결하고 완료 화면, 값은 DOM에 없다", async () => {
    mount("claude");
    await loginSucceeds("claude");
    click(dq("register-create"));
    await flush();
    expect(calls.register).toHaveBeenCalledTimes(1);
    expect(calls.connect).toHaveBeenCalledWith({
      harness: "claude",
      endpoint: ENDPOINT,
      agentId: AGENT_ID,
      credential: VALUE,
    });
    expect(dq("register-done")).not.toBeNull();
    expect(dq("register-line")?.textContent).toBe("@kim-claude를 만들었어요.");
    expect(document.body.textContent).not.toContain("FAKE3389");
    click(dq("register-agents"));
    expect(calls.agents).toHaveBeenCalledTimes(1);
  });

  it("「나중에」는 아무것도 만들지 않고 닫는다", async () => {
    const onClose = vi.fn();
    mount("claude", { onClose });
    await loginSucceeds("claude");
    click(dq("register-later"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls.register).not.toHaveBeenCalled();
    expect(calls.connect).not.toHaveBeenCalled();
  });

  it("이미 로그인된 CLI(startAt=register)는 PTY 없이 곧장 확인 단계", async () => {
    mount("claude", { startAt: "register" });
    await flush();
    expect(cli.spawns).toEqual([]);
    expect(dq("register-confirm")).not.toBeNull();
    expect(calls.register).not.toHaveBeenCalled();
  });

  it("register 맥락이 없으면(일반 멤버·웹) 예전처럼 연결됨 뒤 닫힌다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onClose = vi.fn();
    mount("claude", { onClose, register: null });
    await loginSucceeds("claude");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HARNESS_LOGIN_CONNECTED_CLOSE_MS);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dq("register-confirm")).toBeNull();
  });
});

describe("닫기 보호", () => {
  it("만드는 중에는 Esc로 닫히지 않고(값·작업을 잃지 않게), 끝난 뒤 확인 단계의 Esc는 닫는다", async () => {
    let release: (value: unknown) => void = () => undefined;
    registerImpl = () => new Promise((resolve) => (release = resolve));
    const onClose = vi.fn();
    mount("claude", { startAt: "register", onClose });
    await flush();
    const esc = () =>
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
      });
    esc();
    expect(onClose).toHaveBeenCalled(); // 확인 단계: 닫힌다
    const closedAt = onClose.mock.calls.length;
    click(dq("register-create"));
    await flush();
    expect(dq("register-registering")).not.toBeNull();
    esc();
    expect(onClose).toHaveBeenCalledTimes(closedAt); // 만드는 중: 닫히지 않는다
    release(wire());
    await flush();
    expect(dq("register-done")).not.toBeNull();
  });
});

describe("Claude 멈춤은 오류 모양이 아니다", () => {
  it("회색 · 문의 중, 사람이 직접 쓰는 길만, 경고 표지 없음", async () => {
    registerImpl = async () => {
      throw new ApiError(409, "claude subscription agents are paused on this server", "claude_subscription_agent_paused");
    };
    mount("claude", { startAt: "register" });
    await flush();
    click(dq("register-create"));
    await flush();
    const calm = dq("register-calm");
    expect(calm?.getAttribute("data-refusal")).toBe("paused");
    expect(dq("register-calm-badge")?.textContent).toBe("회색 · 문의 중");
    expect(dq("register-line")?.textContent).toBe(
      "이 서버에서는 Claude Code 구독으로 쓰는 에이전트가 잠시 멈춰 있어요."
    );
    // 오류 표현이 하나도 없다: 경고 역할, 위험 색, 오류 표정, 다시 시도.
    const dialog = dq("harness-login-dialog")!;
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    expect(dialog.innerHTML).not.toMatch(/danger|destructive|text-warn|bg-warn/);
    expect(dq("kometto-guide")?.getAttribute("data-expression")).not.toBe("flustered");
    expect(dq("register-retry")).toBeNull();
    expect(dq("register-failed")).toBeNull();
    expect(dialog.textContent).not.toMatch(/실패|오류|만들지 못했/);
    // 서버 영어 문장은 화면에 없다.
    expect(dialog.textContent).not.toContain("paused on this server");
    // 셸은 부르지 않았다.
    expect(calls.connect).not.toHaveBeenCalled();
    expect(dialog.querySelectorAll("button").length).toBe(1);
  });

  it("그 밖의 서버 오류만 실패 모양과 다시 시도가 있다", async () => {
    registerImpl = async () => {
      throw new ApiError(500, "boom");
    };
    mount("claude", { startAt: "register" });
    await flush();
    click(dq("register-create"));
    await flush();
    expect(dq("register-failed")).not.toBeNull();
    expect(dq("register-line")?.textContent).toMatch(/^만들지 못했어요: /);
    expect(dq("register-retry")).not.toBeNull();
  });
});

describe("Codex와 실패 폴백", () => {
  it("Codex: 등록 뒤 같은 창에 주소·연결 값 두 칸, 셸은 부르지 않는다", async () => {
    registerImpl = async () => wire("codex");
    mount("codex", { startAt: "register" });
    await flush();
    click(dq("register-create"));
    await flush();
    expect(calls.connect).not.toHaveBeenCalled();
    expect(dq("register-manual")?.getAttribute("data-why")).toBe("codex");
    expect(dq("first-agent-connect-endpoint")).not.toBeNull();
    expect(dq("first-agent-connect-credential")).not.toBeNull();
    expect(dq("register-manual-toggle")).toBeNull();
  });

  it("CLI 연결이 안 되면 접힌 「직접 하려면」, 펼치면 명령", async () => {
    connectImpl = async () => ({ outcome: "manual", reason: "cli_failed" });
    mount("claude", { startAt: "register" });
    await flush();
    click(dq("register-create"));
    await flush();
    expect(dq("register-manual")?.getAttribute("data-why")).toBe("cli-failed");
    expect(dq("register-manual-body")).toBeNull();
    expect(dq("register-manual-toggle")?.textContent).toBe("직접 하려면");
    click(dq("register-manual-toggle"));
    expect(dq("first-agent-connect-command-text")?.textContent).toContain("claude mcp add");
  });
});
