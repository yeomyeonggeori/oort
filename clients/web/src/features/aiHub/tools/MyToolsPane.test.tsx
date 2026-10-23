// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import { PERSONAL_AGENT_COPY, type PersonalAgentSummary } from "@momo/core/features/ai/harnessCard";
import { listWorkHosts, type WorkHost } from "@momo/core/features/settings/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { MirrorFactory, PtyPort } from "@/features/workbench/local/localSessions";
import type { PtyExit, PtySpawnRequest } from "@/lib/tauri";
import { MyToolsPane } from "./MyToolsPane";
import { createHarnessSessionStore, type HarnessSessionStore } from "./harnessSessionStore";
import { PersonalAgentError, type PersonalAgentPort } from "./personalAgentPort";

// ADR-0198 D3 (#3568): 내 도구 카드. 로그인(공식 CLI 종료 코드) × 호스트(서버 online),
// 모달을 닫아도 남는 로그인, 확인 전에는 말하지 않는 「연결 안 됨」, 「문의 중」 부재,
// 개인 에이전트 별칭 토글을 가짜 PTY·가짜 서버로 잰다.

const shell = vi.hoisted(() => ({ probes: [] as LocalHarnessProbe[], gate: null as null | Promise<void>, tauri: true }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return shell.tauri;
    },
  };
});
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    detectLocalHarnesses: vi.fn(async () => {
      if (shell.gate) await shell.gate;
      return shell.probes;
    }),
  };
});
vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return { ...actual, listWorkHosts: vi.fn() };
});
vi.mock("../MyPersonalKeysSection", () => ({ MyPersonalKeysSection: () => null }));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000102";

const session: SessionContextValue = {
  session: {
    accessToken: "access",
    refreshToken: "refresh",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

const host = (over: Partial<WorkHost>): WorkHost => ({
  id: "h1",
  workspaceId: WS,
  scope: "member",
  ownerMemberId: ME,
  type: "mac",
  displayName: "내 맥",
  publicKey: "k",
  capabilities: {},
  createdAtMs: 1,
  online: true,
  ...over,
});

// ---- 가짜 PTY ----------------------------------------------------------------------
function fakePty() {
  const spawns: PtySpawnRequest[] = [];
  const exits: ((e: PtyExit) => void)[] = [];
  const kills: number[] = [];
  const pty: PtyPort = {
    spawn: vi.fn(async (request, _onOutput, onExit) => {
      spawns.push(request);
      exits.push(onExit);
      return spawns.length;
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
        serialize: () => "",
      };
    },
  };
  return {
    spawns,
    kills,
    pty,
    loadMirror: async () => factory,
    exit(index: number, code: number | null) {
      exits[index]?.({ id: index + 1, code, signal: null });
    },
  };
}

// ---- 가짜 개인 에이전트 서버 ---------------------------------------------------------
function fakePort(initial: PersonalAgentSummary[] = [], listState: "ok" | "unavailable" = "ok") {
  let agents = [...initial];
  const enable = vi.fn(async (harness: "claude_code" | "codex", alias: string) => {
    if (alias === "taken") throw new PersonalAgentError(409, "personal_agent_alias_taken");
    const existing = agents.find((a) => a.harness === harness);
    const agent: PersonalAgentSummary = {
      id: existing?.id ?? `agent-${alias}`,
      handle: alias,
      displayName: alias,
      harness,
      enabled: true,
      label: "곽성재의 개인 에이전트",
    };
    agents = [...agents.filter((a) => a.harness !== harness), agent];
    return agent;
  });
  const disable = vi.fn(async (id: string) => {
    agents = agents.map((a) => (a.id === id ? { ...a, enabled: false } : a));
    return agents.find((a) => a.id === id)!;
  });
  const port: PersonalAgentPort = {
    list: vi.fn(async () => (listState === "ok" ? { state: "ok" as const, agents } : { state: "unavailable" as const })),
    enable,
    disable,
  };
  return { port, enable, disable };
}

const probes = (claude: LocalHarnessProbe["auth"], codex: LocalHarnessProbe["auth"] = "needs_login"): LocalHarnessProbe[] => [
  { id: "claude", installed: true, auth: claude },
  { id: "codex", installed: true, auth: codex },
];

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let el: HTMLElement | null = null;
/** 마지막으로 세운 트리의 쿼리 클라이언트. 어떤 쿼리를 다시 읽게 했는지 잴 때 쓴다. */
let lastClient: QueryClient | null = null;

function mount(options: { store: HarnessSessionStore; port: PersonalAgentPort }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastClient = client;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(SessionProvider, { value: session }, createElement(MyToolsPane, { sessions: options.store, port: options.port }))
        )
      )
    );
  });
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const card = (h: "claude" | "codex") => q(`tool-card-${h}`);
async function until<T>(read: () => T | null | undefined | false): Promise<T> {
  return waitFor(() => {
    const value = read();
    if (!value) throw new Error("not yet");
    return value;
  });
}
const click = (target: HTMLElement | null) => {
  if (!target) throw new Error("missing click target");
  act(() => target.click());
};
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => {
  shell.probes = probes("logged_in");
  shell.gate = null;
  shell.tauri = true;
  vi.mocked(listWorkHosts).mockResolvedValue([host({})]);
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  vi.clearAllMocks();
});

function setup(initialAgents: PersonalAgentSummary[] = []) {
  const cli = fakePty();
  // 셸 상태 명령과 같은 입구: 게이트로 답을 붙잡을 수 있다.
  const detect = async () => {
    if (shell.gate) await shell.gate;
    return shell.probes;
  };
  const store = createHarnessSessionStore(() => ({
    login: { pty: cli.pty, loadMirror: cli.loadMirror, detect },
    unlink: { pty: cli.pty, loadMirror: cli.loadMirror, remove: vi.fn(), verify: detect },
  }));
  const server = fakePort(initialAgents);
  return { cli, store, server };
}

describe("로그인 × 호스트 상태", () => {
  it.each([
    ["logged_in", [host({})], "connected", "on", "연결됨", "내 맥 켜짐"],
    ["logged_in", [host({ online: false })], "connected", "off", "연결됨", "내 맥 꺼짐"],
    ["needs_login", [host({ online: false })], "reauth", "off", "다시 인증", "내 맥 꺼짐"],
    ["needs_login", [], "reauth", "unregistered", "다시 인증", "미등록"],
    ["unknown", [host({})], "unknown", "on", "확인 못 했어요", "내 맥 켜짐"],
    // 남의 개인 맥과 워크스페이스 공용은 「내 맥」이 아니다.
    ["logged_in", [host({ ownerMemberId: OTHER }), host({ id: "h2", scope: "workspace" })], "connected", "unregistered", "연결됨", "미등록"],
  ] as const)("%s + 호스트 %j → %s / %s", async (auth, hosts, view, hostView, loginText, hostText) => {
    shell.probes = probes(auth);
    vi.mocked(listWorkHosts).mockResolvedValue([...hosts]);
    const { store, server } = setup();
    mount({ store, port: server.port });
    await until(() => card("claude")?.getAttribute("data-login") === view && card("claude")?.getAttribute("data-host") === hostView);
    expect(q("tool-card-claude-login-pill")?.textContent).toBe(loginText);
    expect(q("tool-card-claude-host-pill")?.textContent).toBe(hostText);
  });

  it("호스트 목록을 못 읽으면 꺼짐이 아니라 확인 못 했다고 말한다", async () => {
    vi.mocked(listWorkHosts).mockRejectedValue(new Error("boom"));
    const { store, server } = setup();
    mount({ store, port: server.port });
    await until(() => card("claude")?.getAttribute("data-host") === "unknown");
    expect(q("tool-card-claude-host-pill")?.textContent).toBe("내 맥 확인 못 했어요");
  });

  it("호스트 목록을 못 읽으면 「다시 읽기」가 있고 누르면 다시 읽는다", async () => {
    vi.mocked(listWorkHosts).mockRejectedValue(new Error("boom"));
    const { store, server } = setup();
    mount({ store, port: server.port });
    await until(() => q("tool-card-claude-host-retry"));
    const calls = vi.mocked(listWorkHosts).mock.calls.length;
    vi.mocked(listWorkHosts).mockResolvedValue([host({})]);
    click(q("tool-card-claude-host-retry"));
    await until(() => card("claude")?.getAttribute("data-host") === "on");
    expect(vi.mocked(listWorkHosts).mock.calls.length).toBeGreaterThan(calls);
    expect(q("tool-card-claude-host-retry")).toBeNull();
  });

  it("「문의 중」은 어디에도 없다(Claude 개인 에이전트가 켜져 있어도)", async () => {
    const { store, server } = setup([
      { id: "a1", handle: "my-claude", displayName: "my-claude", harness: "claude_code", enabled: true, label: "곽성재의 개인 에이전트" },
    ]);
    mount({ store, port: server.port });
    await until(() => card("claude")?.getAttribute("data-personal") === "on");
    expect(document.body.textContent).not.toContain("문의 중");
  });
});

describe("로그인 중 인라인 유지", () => {
  it("모달을 닫아도(닫고 계속하기) PTY는 살아 있고 카드가 로그인 중을 말한다. 취소해야 끝난다", async () => {
    shell.probes = probes("needs_login");
    const { cli, store, server } = setup();
    mount({ store, port: server.port });
    await until(() => card("claude")?.getAttribute("data-login") === "reauth");
    click(q("tool-card-claude-login"));
    await until(() => q("harness-login-dialog"));
    expect(cli.spawns[0]?.program).toMatchObject({ kind: "login", id: "claude" });
    expect(card("claude")?.getAttribute("data-login")).toBe("logging-in");

    click(q("harness-login-detach"));
    await until(() => q("harness-login-dialog") === null);
    expect(card("claude")?.getAttribute("data-login")).toBe("logging-in");
    expect(q("tool-card-claude-progress")).not.toBeNull();
    expect(cli.kills).toEqual([]);

    // 다시 열 수 있다.
    click(q("tool-card-claude-open"));
    await until(() => q("harness-login-dialog"));
    click(q("harness-login-detach"));
    await until(() => q("harness-login-dialog") === null);

    click(q("tool-card-claude-cancel"));
    await until(() => card("claude")?.getAttribute("data-login") === "reauth");
    expect(cli.kills).toEqual([1]);
  });

  it("닫은 채 로그인이 끝나면 카드가 스스로 연결됨으로 바뀐다", async () => {
    shell.probes = probes("needs_login");
    const { cli, store, server } = setup();
    mount({ store, port: server.port });
    await until(() => card("claude")?.getAttribute("data-login") === "reauth");
    click(q("tool-card-claude-login"));
    await until(() => q("harness-login-dialog"));
    click(q("harness-login-detach"));
    await until(() => q("harness-login-dialog") === null);

    shell.probes = probes("logged_in");
    act(() => cli.exit(0, 0));
    await until(() => card("claude")?.getAttribute("data-login") === "connected");
    expect(q("tool-card-claude-progress")).toBeNull();
  });
});

describe("연결 끊기", () => {
  async function connectedCard() {
    const ctx = setup();
    mount({ store: ctx.store, port: ctx.server.port });
    await until(() => card("claude")?.getAttribute("data-login") === "connected");
    return ctx;
  }

  it("확인 문장을 먼저 말하고, 기본 위치 로그아웃(프로필 없음) 한 줄만 연다", async () => {
    const { cli } = await connectedCard();
    click(q("tool-card-claude-disconnect"));
    expect(q("tool-card-claude-disconnect-confirm")?.textContent).toContain("터미널에서 쓰던 로그인도 같이 풀려요");
    expect(cli.spawns).toEqual([]);
    click(q("tool-card-claude-disconnect-go"));
    await until(() => cli.spawns.length === 1);
    expect(cli.spawns[0]?.program).toEqual({ kind: "logout", id: "claude" });
  });

  it("키보드 초점: 누른 단추가 사라져도 body로 떨어지지 않고, 그대로 두면 처음 단추로 돌아온다", async () => {
    await connectedCard();
    const disconnect = q("tool-card-claude-disconnect");
    act(() => disconnect?.focus());
    click(disconnect);
    await until(() => document.activeElement === q("tool-card-claude-disconnect-keep"));
    click(q("tool-card-claude-disconnect-keep"));
    await until(() => document.activeElement === q("tool-card-claude-disconnect"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("끊기가 끝나면 사라진 「끊는 중」 줄 대신 「로그인」으로 초점이 간다", async () => {
    const { cli } = await connectedCard();
    click(q("tool-card-claude-disconnect"));
    click(q("tool-card-claude-disconnect-go"));
    await until(() => cli.spawns.length === 1);
    shell.probes = probes("needs_login");
    act(() => cli.exit(0, 0));
    await until(() => card("claude")?.getAttribute("data-login") === "disconnected");
    await until(() => document.activeElement === q("tool-card-claude-login"));
  });

  it("로그아웃이 0으로 끝나도 상태 명령이 로그인 아님을 알리기 전에는 「연결 안 됨」을 말하지 않는다", async () => {
    const { cli } = await connectedCard();
    click(q("tool-card-claude-disconnect"));
    click(q("tool-card-claude-disconnect-go"));
    await until(() => cli.spawns.length === 1);
    // 상태 명령이 아직 답하지 않는다.
    let release: () => void = () => undefined;
    shell.gate = new Promise<void>((resolve) => (release = resolve));
    shell.probes = probes("needs_login");
    act(() => cli.exit(0, 0));
    await until(() => card("claude")?.getAttribute("data-login") === "disconnecting");
    expect(q("tool-card-claude-login-pill")?.textContent).toBe("연결 끊는 중");
    expect(document.body.textContent).not.toContain("연결 안 됨");
    await act(async () => release());
    await until(() => card("claude")?.getAttribute("data-login") === "disconnected");
    expect(q("tool-card-claude-login-pill")?.textContent).toBe("연결 안 됨");
  });

  it("로그아웃 뒤에도 아직 로그인이면 끊겼다고 하지 않고 이유를 말한다", async () => {
    const { cli } = await connectedCard();
    click(q("tool-card-claude-disconnect"));
    click(q("tool-card-claude-disconnect-go"));
    await until(() => cli.spawns.length === 1);
    shell.probes = probes("logged_in");
    act(() => cli.exit(0, 0));
    await until(() => q("tool-card-claude-disconnect-failed"));
    expect(q("tool-card-claude-disconnect-failed")?.textContent).toContain("아직 로그인돼 있어요");
    expect(card("claude")?.getAttribute("data-login")).toBe("connected");
    expect(document.body.textContent).not.toContain("연결 안 됨");
  });

  it("로그아웃 CLI가 0이 아니게 끝나면 상태가 로그인 아님이어도 끊김으로 치지 않는다", async () => {
    const { cli } = await connectedCard();
    click(q("tool-card-claude-disconnect"));
    click(q("tool-card-claude-disconnect-go"));
    await until(() => cli.spawns.length === 1);
    shell.probes = probes("needs_login");
    act(() => cli.exit(0, 1));
    await until(() => q("tool-card-claude-disconnect-failed"));
    expect(document.body.textContent).not.toContain("연결 안 됨");
  });
});

// #4252: 「연결 끊기」는 이 맥의 CLI 로그인만 푼다. 멤버인 개인 에이전트는 따로 켜져 있고, 그것이 대화 목록에
// 「오프라인」으로 남는다. 두 컨트롤이 한 카드에 있어 둘을 같은 것으로 읽은 사람에게 조용히 남던 자리다.
describe("연결을 끊어도 개인 에이전트는 켜져 있다 (#4252)", () => {
  const ON = {
    id: "a1",
    handle: "my-claude",
    displayName: "my-claude",
    harness: "claude_code" as const,
    enabled: true,
    label: "곽성재의 개인 에이전트",
  };

  it("개인 에이전트가 켜져 있으면 끊기 확인이 그 사실과 정리하는 길(스위치)을 말한다", async () => {
    const ctx = setup([ON]);
    mount({ store: ctx.store, port: ctx.server.port });
    await until(() => card("claude")?.getAttribute("data-login") === "connected");
    await until(() => card("claude")?.getAttribute("data-personal") === "on");
    click(q("tool-card-claude-disconnect"));
    const line = q("tool-card-claude-disconnect-keeps-agent");
    expect(line?.textContent).toContain("연결을 끊어도 개인 에이전트는 켜져 있어요");
    // 약속은 사이드바에서 보게 될 결과와 같다: 끄면 다 읽은 대화가 목록 끝의 「나간 멤버와의 대화」 줄로 접힌다(design-review M3).
    expect(line?.textContent).toContain("다 읽은 대화는 「나간 멤버와의 대화」로 접혀요");
    // 낱말은 스위치의 이름과 같다(이름이 둘이면 컨트롤도 둘이다).
    expect(line?.textContent).toContain(`「${PERSONAL_AGENT_COPY.toggleLabel}」를 끄면`);
  });

  it("개인 에이전트가 꺼져 있거나 없으면 그 문장은 없다", async () => {
    const ctx = setup();
    mount({ store: ctx.store, port: ctx.server.port });
    await until(() => card("claude")?.getAttribute("data-login") === "connected");
    click(q("tool-card-claude-disconnect"));
    expect(q("tool-card-claude-disconnect-confirm")).not.toBeNull();
    expect(q("tool-card-claude-disconnect-keeps-agent")).toBeNull();
  });

  it("끊긴 뒤에도 켜져 있는 개인 에이전트의 줄이 그 사실을 말한다", async () => {
    const ctx = setup([ON]);
    mount({ store: ctx.store, port: ctx.server.port });
    await until(() => card("claude")?.getAttribute("data-personal") === "on");
    await until(() => card("claude")?.getAttribute("data-login") === "connected");
    click(q("tool-card-claude-disconnect"));
    click(q("tool-card-claude-disconnect-go"));
    await until(() => ctx.cli.spawns.length === 1);
    shell.probes = probes("needs_login");
    act(() => ctx.cli.exit(0, 0));
    await until(() => card("claude")?.getAttribute("data-login") === "disconnected");
    expect(q("tool-card-claude-personal")?.textContent).toContain("연결돼 있지 않아도 개인 에이전트는 켜져 있어요");
    expect(q("tool-card-claude-personal")?.textContent).toContain("다 읽은 대화는 「나간 멤버와의 대화」로 접혀요");
    // 켜져 있는 그대로다: 스위치는 아직 켜짐이고 서버는 끄라는 요청을 받은 적이 없다.
    expect(card("claude")?.getAttribute("data-personal")).toBe("on");
    expect(ctx.server.disable).not.toHaveBeenCalled();
  });

  it("연결이 있는 동안에는 평소 힌트 그대로다", async () => {
    const ctx = setup([ON]);
    mount({ store: ctx.store, port: ctx.server.port });
    await until(() => card("claude")?.getAttribute("data-personal") === "on");
    await until(() => card("claude")?.getAttribute("data-login") === "connected");
    expect(q("tool-card-claude-personal")?.textContent).toContain("나만 부를 수 있어요");
    expect(q("tool-card-claude-personal")?.textContent).not.toContain("연결돼 있지 않아도");
  });

  it("문장의 낱말은 스위치 이름에서 갈라지지 않는다 (「이 스위치」 같은 새 낱말이 없다)", () => {
    for (const sentence of [PERSONAL_AGENT_COPY.disconnectKeepsAgent, PERSONAL_AGENT_COPY.toolOffKeepsAgent]) {
      expect(sentence).toContain(`「${PERSONAL_AGENT_COPY.toggleLabel}」`);
      expect(sentence).not.toContain("스위치");
    }
  });

  it("두 문장은 짧다 (스위치에 포커스할 때마다 읽히므로 두 문장 안에서 끝난다, design-review L5)", () => {
    for (const sentence of [PERSONAL_AGENT_COPY.disconnectKeepsAgent, PERSONAL_AGENT_COPY.toolOffKeepsAgent]) {
      expect(sentence.length).toBeLessThanOrEqual(80);
      expect(sentence.split(/(?<=요\.)\s/)).toHaveLength(2);
    }
  });
});

describe("개인 에이전트로 쓰기", () => {
  it("켜기: 스위치 → 별칭 → 개인 표식과 호스트 상태. 별칭은 소문자로 접어 보낸다", async () => {
    const { store, server } = setup();
    mount({ store, port: server.port });
    await until(() => q("tool-card-claude-personal")?.getAttribute("data-read") === "ok");
    expect(q("tool-card-claude-personal-badge")).toBeNull();
    click(q("tool-card-claude-personal-switch"));
    const input = (await until(() => q("tool-card-claude-alias-input"))) as HTMLInputElement;
    type(input, "My-Claude");
    click(q("tool-card-claude-alias-submit"));
    await until(() => card("claude")?.getAttribute("data-personal") === "on");
    expect(server.enable).toHaveBeenCalledWith("claude_code", "my-claude");
    expect(q("tool-card-claude-personal-badge")?.textContent).toBe("개인");
    expect(q("tool-card-claude-alias")?.textContent).toBe("@my-claude");
    // 켜진 카드는 호스트 상태도 함께 보인다.
    expect(q("tool-card-claude-host-pill")?.textContent).toBe("내 맥 켜짐");
  });

  it("잘못된 별칭은 보내지 않고 이유를 말한다", async () => {
    const { store, server } = setup();
    mount({ store, port: server.port });
    await until(() => q("tool-card-codex-personal")?.getAttribute("data-read") === "ok");
    click(q("tool-card-codex-personal-switch"));
    const input = (await until(() => q("tool-card-codex-alias-input"))) as HTMLInputElement;
    type(input, "한글 별칭");
    click(q("tool-card-codex-alias-submit"));
    await until(() => q("tool-card-codex-personal-error"));
    expect(server.enable).not.toHaveBeenCalled();
  });

  it("별칭 중복(409 personal_agent_alias_taken)은 구체 문구로 말하고 켜지지 않는다", async () => {
    const { store, server } = setup();
    mount({ store, port: server.port });
    await until(() => q("tool-card-claude-personal")?.getAttribute("data-read") === "ok");
    click(q("tool-card-claude-personal-switch"));
    const input = (await until(() => q("tool-card-claude-alias-input"))) as HTMLInputElement;
    type(input, "taken");
    click(q("tool-card-claude-alias-submit"));
    const error = await until(() => q("tool-card-claude-personal-error"));
    expect(error.textContent).toContain("이미 쓰는 별칭");
    expect(card("claude")?.getAttribute("data-personal")).toBe("off");
  });

  it("끄기: 스위치를 끄면 그 멤버를 비활성으로 보낸다", async () => {
    const { store, server } = setup([
      { id: "a1", handle: "my-claude", displayName: "my-claude", harness: "claude_code", enabled: true, label: "곽성재의 개인 에이전트" },
    ]);
    mount({ store, port: server.port });
    await until(() => card("claude")?.getAttribute("data-personal") === "on");
    click(q("tool-card-claude-personal-switch"));
    await until(() => card("claude")?.getAttribute("data-personal") === "off");
    expect(server.disable).toHaveBeenCalledWith("a1");
    expect(q("tool-card-claude-personal-badge")).toBeNull();
  });

  it("끄면 명부도 다시 읽는다: 꺼진 멤버는 서버 명부(활성만)에서 빠지므로 사이드바 DM 이 이름 그대로 남지 않는다 (#4252)", async () => {
    const { store, server } = setup([
      { id: "a1", handle: "my-claude", displayName: "my-claude", harness: "claude_code", enabled: true, label: "곽성재의 개인 에이전트" },
    ]);
    mount({ store, port: server.port });
    await until(() => card("claude")?.getAttribute("data-personal") === "on");
    const invalidate = vi.spyOn(lastClient!, "invalidateQueries");
    click(q("tool-card-claude-personal-switch"));
    await until(() => card("claude")?.getAttribute("data-personal") === "off");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["roster", WS] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ai", "personal-agents", WS] });
  });

  it("켜도 명부를 다시 읽는다 (새 멤버가 멘션·DM 목록에 선다)", async () => {
    const { store, server } = setup();
    mount({ store, port: server.port });
    await until(() => q("tool-card-claude-personal")?.getAttribute("data-read") === "ok");
    const invalidate = vi.spyOn(lastClient!, "invalidateQueries");
    click(q("tool-card-claude-personal-switch"));
    const input = (await until(() => q("tool-card-claude-alias-input"))) as HTMLInputElement;
    type(input, "my-claude");
    click(q("tool-card-claude-alias-submit"));
    await until(() => card("claude")?.getAttribute("data-personal") === "on");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["roster", WS] });
  });

  it("서버에 라우트가 없으면 스위치 대신 차분한 한 줄이다", async () => {
    const cli = fakePty();
    const store = createHarnessSessionStore(() => ({
      login: { pty: cli.pty, loadMirror: cli.loadMirror, detect: async () => shell.probes },
      unlink: { pty: cli.pty, loadMirror: cli.loadMirror, remove: vi.fn(), verify: async () => shell.probes },
    }));
    const server = fakePort([], "unavailable");
    mount({ store, port: server.port });
    await until(() => q("tool-card-claude-personal")?.getAttribute("data-read") === "unavailable");
    expect(q("tool-card-claude-personal-switch")).toBeNull();
    expect(q("tool-card-claude-personal")?.textContent).toContain("아직 개인 에이전트를 켤 수 없어요");
  });
});

describe("웹(데스크탑 아님)", () => {
  it("로그인 상태를 말하지 않고 맥에서 확인하라고 하며, 호스트 상태와 앱 받기 길은 보인다", async () => {
    shell.tauri = false;
    const { store, server } = setup();
    mount({ store, port: server.port });
    await until(() => card("claude")?.getAttribute("data-host") === "on");
    expect(card("claude")?.getAttribute("data-login")).toBe("remote");
    expect(q("tool-card-claude-login-pill")).toBeNull();
    expect(q("tool-card-claude-login")).toBeNull();
    expect(q("tool-card-claude-web-note")?.textContent).toContain("내 맥에서 확인해요");
    expect(q("ai-accounts-get-app")).not.toBeNull();
    // 서버가 하는 일(개인 에이전트)은 웹에서도 된다.
    await until(() => q("tool-card-claude-personal")?.getAttribute("data-read") === "ok");
    expect(q("tool-card-claude-personal-switch")).not.toBeNull();
  });
});
