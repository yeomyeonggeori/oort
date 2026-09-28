// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fetchRoster, type RosterMember } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import {
  HIDDEN_DEFAULTS_STORAGE_KEY,
  type HarnessProfileRef,
  type ProfileRemoveOutcome,
} from "@momo/core/features/settings/harnessProfiles";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { PtyExit } from "@/lib/tauri";
import { AiMyAccountsSection } from "./AiMyAccountsSection";

// #2878 AA-4: 내 계정 줄의 연결 지점. 가짜 셸·가짜 PTY로 잰다.
// - 기본 로그인 줄: 「목록에서 빼기」는 PTY도 셸 호출도 없이 이 기기 설정만 바꾼다.
// - 프로필 줄: 「다시 로그인」은 #2816 모달을 그 프로필로, 「연결 해제」는 로그아웃
//   PTY → 종료 0 → 셸 삭제. 실패면 삭제를 부르지 않는다.
// - 구독 추가: 셸이 폴더를 만들고 → 모달을 그 프로필로 → 취소면 셸 삭제 → 추가 창으로.

const envSlot = vi.hoisted(() => ({ tauri: true, flag: true }));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return envSlot.tauri;
    },
    get SUBSCRIPTION_AGENTS_BUILD_FLAG() {
      return envSlot.flag;
    },
  };
});

const shell = vi.hoisted(() => ({
  probes: [] as LocalHarnessProbe[],
  profiles: [] as HarnessProfileRef[],
  status: {} as Record<string, LocalHarnessProbe>,
  removeOutcome: "removed" as ProfileRemoveOutcome,
  spawns: [] as { program: Record<string, unknown> }[],
  exit: null as ((e: PtyExit) => void) | null,
  kills: [] as number[],
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    detectLocalHarnesses: vi.fn(async () => shell.probes),
    harnessProfileList: vi.fn(async () => shell.profiles),
    harnessProfileStatus: vi.fn(
      async (p: HarnessProfileRef) =>
        shell.status[`${p.harness}/${p.label}`] ?? {
          id: p.harness,
          installed: true,
          auth: "needs_login",
        },
    ),
    harnessProfileCreate: vi.fn(async (p: HarnessProfileRef) => {
      shell.profiles = [...shell.profiles, p];
    }),
    harnessProfileRemove: vi.fn(async (p: HarnessProfileRef) => {
      if (shell.removeOutcome === "removed") {
        shell.profiles = shell.profiles.filter(
          (row) => row.harness !== p.harness || row.label !== p.label,
        );
      }
      return shell.removeOutcome;
    }),
    openTerminalApp: vi.fn(async () => true),
    desktopPty: {
      spawn: vi.fn(
        async (
          request: { program: Record<string, unknown> },
          _out: unknown,
          onExit: (e: PtyExit) => void,
        ) => {
          shell.spawns.push(request);
          shell.exit = onExit;
          return shell.spawns.length;
        },
      ),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      kill: vi.fn(async (id: number) => void shell.kills.push(id)),
      ack: vi.fn(async () => undefined),
    },
  };
});

vi.mock("@/features/workbench/local/LocalTerminalPane", () => ({
  LocalTerminalPane: () =>
    createElement("div", { "data-testid": "stub-terminal-pane" }),
}));

vi.mock("@/features/workbench/local/localSessions", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/workbench/local/localSessions")
    >();
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

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn() };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return { ...actual, fetchProviderLink: vi.fn(), fetchWorkspace: vi.fn() };
});

const tauri = await import("@/lib/tauri");

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

const owner: RosterMember = {
  id: ME,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "곽성재",
  handle: "seongjae",
  role: "owner",
  channelCount: 0,
  channelIds: [],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
};

const session: SessionContextValue = {
  session: {
    accessToken: "access",
    refreshToken: "refresh",
    member: {
      id: ME,
      workspaceId: WS,
      kind: "human",
      displayName: "곽성재",
      handle: "seongjae",
    },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

const act_ = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(props: { onAddApiKey?: () => void } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          SessionProvider,
          { value: session },
          createElement(AiMyAccountsSection, props),
        ),
      ),
    );
  });
}

function q(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

async function until(testId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = q(testId);
    if (!el) throw new Error(`missing ${testId}`);
    return el;
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openMenu(trigger: HTMLElement) {
  trigger.focus();
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    trigger.click();
  });
}

beforeAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = true;
  // Radix가 쓰는 브라우저 API(jsdom에 없음).
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  // jsdom에는 PointerEvent가 없다. Radix 메뉴는 pointerdown으로 열린다.
  (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ??=
    class extends MouseEvent {};
});

beforeEach(() => {
  envSlot.tauri = true;
  envSlot.flag = true;
  shell.probes = [
    { id: "claude", installed: true, auth: "logged_in" },
    { id: "codex", installed: true, auth: "logged_in" },
  ];
  shell.profiles = [];
  shell.status = {};
  shell.removeOutcome = "removed";
  shell.spawns = [];
  shell.exit = null;
  shell.kills = [];
  localStorage.clear();
  window.history.replaceState(null, "", "/#/settings?section=ai");
  vi.mocked(fetchRoster).mockReset();
  vi.mocked(fetchRoster).mockResolvedValue([owner]);
  vi.mocked(fetchWorkspace).mockReset();
  vi.mocked(fetchWorkspace).mockResolvedValue({
    id: WS,
    slug: "team",
    name: "우리 팀",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled: true,
  });
  for (const fn of [
    tauri.harnessProfileCreate,
    tauri.harnessProfileRemove,
    tauri.desktopPty.spawn,
  ] as const) {
    vi.mocked(fn).mockClear();
  }
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("기본 로그인 줄: 목록에서만 뺀다 (Q2)", () => {
  it("PTY·셸 삭제 없이 이 기기 목록에서만 빠지고, 다시 보이게 할 수 있다", async () => {
    mount();
    await until("my-account-claude");
    await openMenu(await until("my-account-claude-more"));
    const item = await until("my-account-claude-menu-destructive");
    expect(item.textContent).toBe("목록에서 빼기");
    await act(async () => item.click());
    const dialog = await until("my-account-unlink-dialog");
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(q("my-account-unlink-body")?.textContent).toContain(
      "로그아웃하지 않아요",
    );
    await act(async () => q("my-account-unlink-confirm")!.click());
    await flush();
    expect(q("my-account-claude")).toBeNull();
    expect(q("my-account-codex")).not.toBeNull();
    expect(localStorage.getItem(HIDDEN_DEFAULTS_STORAGE_KEY)).toBe(
      '["claude"]',
    );
    await waitFor(() => expect(document.activeElement).toBe(q("subscription-entry-open")));
    // 로그아웃도, 폴더 삭제도, PTY도 없다.
    expect(tauri.desktopPty.spawn).not.toHaveBeenCalled();
    expect(tauri.harnessProfileRemove).not.toHaveBeenCalled();

    {
      const el = await until("my-account-restore-hidden");
      await act(async () => el.click());
    }
    await until("my-account-claude");
    expect(localStorage.getItem(HIDDEN_DEFAULTS_STORAGE_KEY)).toBe("[]");
  });
});

describe("프로필 줄: #2816 모달과 해제 (ADR-0190 D3-f)", () => {
  beforeEach(() => {
    shell.profiles = [{ harness: "claude", label: "회사" }];
    shell.status = {
      "claude/회사": { id: "claude", installed: true, auth: "needs_login" },
    };
  });

  it("「다시 로그인」은 같은 로그인 모달을 그 프로필로 연다", async () => {
    mount();
    const relogin = await until("my-account-claude/회사-login");
    expect(relogin.textContent).toBe("다시 로그인");
    await act(async () => relogin.click());
    const dialog = await until("harness-login-dialog");
    expect(dialog.getAttribute("data-profile")).toBe("회사");
    await waitFor(() => expect(shell.spawns).toHaveLength(1));
    expect(shell.spawns[0]!.program).toEqual({
      kind: "login",
      id: "claude",
      method: "browser",
      profile: "회사",
    });
  });

  it("연결 해제: 시안 문장 → 로그아웃 PTY(그 프로필) → 종료 0 → 셸 삭제 → 줄이 사라진다", async () => {
    mount();
    await openMenu(await until("my-account-claude/회사-more"));
    const item = await until("my-account-claude/회사-menu-destructive");
    expect(item.textContent).toBe("연결 해제");
    await act(async () => item.click());
    await until("my-account-unlink-dialog");
    expect(q("my-account-unlink-title")?.textContent).toBe(
      "Claude · 회사 연결을 해제할까요?",
    );
    expect(q("my-account-unlink-body")?.textContent).toBe(
      "이 계정 전용 폴더의 로그인을 Claude Code로 로그아웃하고 목록에서 뺍니다. 터미널에서 쓰던 claude 로그인은 그대로예요.",
    );
    // 확인 전에는 아무것도 돌지 않는다.
    expect(shell.spawns).toEqual([]);
    await act(async () => q("my-account-unlink-confirm")!.click());
    await waitFor(() => expect(shell.spawns).toHaveLength(1));
    expect(shell.spawns[0]!.program).toEqual({
      kind: "logout",
      id: "claude",
      profile: "회사",
    });
    expect(q("my-account-unlink-profile")?.getAttribute("data-phase")).toBe(
      "signing-out",
    );
    await act(async () => shell.exit!({ id: 1, code: 0, signal: null }));
    await waitFor(() =>
      expect(tauri.harnessProfileRemove).toHaveBeenCalledWith({
        harness: "claude",
        label: "회사",
      }),
    );
    await waitFor(() => expect(q("my-account-unlink-dialog")).toBeNull());
    await waitFor(() => expect(q("my-account-claude/회사")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(q("subscription-entry-open")));
  });

  it("로그아웃 실패: 폴더를 지우지 않고, 정직한 문장과 「터미널로 보기」를 준다", async () => {
    mount();
    await openMenu(await until("my-account-claude/회사-more"));
    {
      const el = await until("my-account-claude/회사-menu-destructive");
      await act(async () => el.click());
    }
    {
      const el = await until("my-account-unlink-confirm");
      await act(async () => el.click());
    }
    await waitFor(() => expect(shell.spawns).toHaveLength(1));
    await act(async () => shell.exit!({ id: 1, code: 1, signal: null }));
    await waitFor(() =>
      expect(q("my-account-unlink-profile")?.getAttribute("data-phase")).toBe(
        "failed",
      ),
    );
    expect(q("my-account-unlink-title")?.textContent).toBe(
      "로그아웃하지 못했어요.",
    );
    expect(q("my-account-unlink-body")?.textContent).toContain(
      "계정 폴더는 그대로 두었어요",
    );
    expect(q("my-account-unlink-terminal-toggle")).not.toBeNull();
    expect(q("my-account-unlink-retry")).not.toBeNull();
    expect(tauri.harnessProfileRemove).not.toHaveBeenCalled();
    expect(q("my-account-claude/회사")).not.toBeNull();
  });

  it("셸이 아직 로그인됨이라 하면 폴더가 남았다고 말한다", async () => {
    shell.removeOutcome = "still_signed_in";
    mount();
    await openMenu(await until("my-account-claude/회사-more"));
    {
      const el = await until("my-account-claude/회사-menu-destructive");
      await act(async () => el.click());
    }
    {
      const el = await until("my-account-unlink-confirm");
      await act(async () => el.click());
    }
    await waitFor(() => expect(shell.spawns).toHaveLength(1));
    await act(async () => shell.exit!({ id: 1, code: 0, signal: null }));
    await waitFor(() =>
      expect(q("my-account-unlink-title")?.textContent).toBe(
        "아직 로그인돼 있어요.",
      ),
    );
    expect(q("my-account-unlink-body")?.textContent).toContain(
      "계정 폴더를 지우지 않았어요",
    );
  });
});

describe("구독 추가: 폴더 → 모달(그 프로필) → 취소면 폴더 정리 (시안 §4)", () => {
  it("라벨로 폴더를 만들고 모달을 그 프로필로 연다. 취소하면 셸이 지우고 추가 창으로 돌아온다", async () => {
    mount();
    {
      const el = await until("subscription-entry-open");
      await act(async () => el.click());
    }
    await until("add-subscription-dialog");
    const input = (await until("add-subscription-label")) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "회사" } });
    });
    expect(q("add-subscription-submit")?.textContent).toBe(
      "Claude Code로 로그인",
    );
    await act(async () => q("add-subscription-submit")!.click());
    await waitFor(() =>
      expect(tauri.harnessProfileCreate).toHaveBeenCalledWith({
        harness: "claude",
        label: "회사",
      }),
    );
    const dialog = await until("harness-login-dialog");
    expect(dialog.getAttribute("data-profile")).toBe("회사");
    await waitFor(() => expect(shell.spawns).toHaveLength(1));
    expect(shell.spawns[0]!.program).toMatchObject({
      kind: "login",
      id: "claude",
      profile: "회사",
    });

    {
      const el = await until("harness-login-cancel");
      await act(async () => el.click());
    }
    // 추가 창으로는 곧바로 돌아온다.
    const again = (await until("add-subscription-label")) as HTMLInputElement;
    expect(again.value).toBe("회사");
    // 로그인 CLI가 끝나기 전에는 폴더를 치우지 않는다(#2996 재검수 M-1).
    await waitFor(() => expect(shell.kills).toEqual([1]));
    await flush();
    expect(tauri.harnessProfileRemove).not.toHaveBeenCalled();
    // CLI가 끝나면 그때 셸에 정리를 맡긴다.
    await act(async () => shell.exit!({ id: 1, code: null, signal: "SIGHUP" }));
    await waitFor(() =>
      expect(tauri.harnessProfileRemove).toHaveBeenCalledWith({
        harness: "claude",
        label: "회사",
      }),
    );
  });

  it("로그인 CLI가 제한 시간 안에 끝나지 않으면 폴더를 치우지 않는다", async () => {
    mount();
    {
      const el = await until("subscription-entry-open");
      await act(async () => el.click());
    }
    const input = (await until("add-subscription-label")) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "개인2" } });
    });
    await act(async () => q("add-subscription-submit")!.click());
    await until("harness-login-dialog");
    await waitFor(() => expect(shell.spawns).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => q("harness-login-cancel")!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(tauri.harnessProfileRemove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("같은 라벨은 셸에 가기 전에 막는다", async () => {
    shell.profiles = [{ harness: "claude", label: "회사" }];
    mount();
    {
      const el = await until("subscription-entry-open");
      await act(async () => el.click());
    }
    const input = (await until("add-subscription-label")) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "회사" } });
    });
    await act(async () => q("add-subscription-submit")!.click());
    expect(q("add-subscription-error")?.textContent).toBe(
      "이 이름의 계정이 이미 있어요.",
    );
    expect(tauri.harnessProfileCreate).not.toHaveBeenCalled();
  });

  it("설치된 CLI가 없으면 설치 안내가 있는 AI 연결 화면으로 간다", async () => {
    shell.probes = [
      { id: "claude", installed: false, auth: "unknown" },
      { id: "codex", installed: false, auth: "unknown" },
    ];
    mount();
    {
      const el = await until("subscription-entry-open");
      await act(async () => el.click());
    }
    expect(window.location.hash).toBe("#/ai-connect?from=settings");
    expect(q("add-subscription-dialog")).toBeNull();
  });
});

describe("추가 창의 「API 키 · 팀이 함께」 (시안 §4 1)", () => {
  it("운영자가 아니면(키 폼 없음) 잠겨 있고, 구독이 기본 선택이다", async () => {
    mount();
    {
      const el = await until("subscription-entry-open");
      await act(async () => el.click());
    }
    await until("add-subscription-dialog");
    expect(q("add-kind-subscription")?.getAttribute("aria-checked")).toBe("true");
    expect(q("add-kind-api-key")?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => q("add-kind-api-key")!.click());
    expect(q("add-kind-api-key")?.getAttribute("aria-checked")).toBe("false");
  });

  it("운영자면 「다음」이 팀 연결의 같은 키 폼을 연다(폴더도 PTY도 없다)", async () => {
    const onAddApiKey = vi.fn();
    mount({ onAddApiKey });
    {
      const el = await until("subscription-entry-open");
      await act(async () => el.click());
    }
    const apiKey = await until("add-kind-api-key");
    expect(apiKey.getAttribute("aria-disabled")).toBeNull();
    await act(async () => apiKey.click());
    expect(q("add-subscription-label")).toBeNull();
    expect(q("add-subscription-submit")?.textContent).toBe("다음");
    await act(async () => q("add-subscription-submit")!.click());
    expect(onAddApiKey).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(q("add-subscription-dialog")).toBeNull());
    expect(tauri.harnessProfileCreate).not.toHaveBeenCalled();
    expect(tauri.desktopPty.spawn).not.toHaveBeenCalled();
  });
});

describe("재진입을 닫으면 초점이 「구독 추가」로 돌아온다 (#2909 review M3)", () => {
  it("ai-connect → settings 해시 전환 뒤 다음 프레임에 초점", async () => {
    mount();
    const add = await until("subscription-entry-open");
    window.history.replaceState(null, "", "/#/ai-connect?from=settings");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    window.history.replaceState(null, "", "/#/settings?section=ai");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await act(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
    });
    expect(document.activeElement).toBe(add);
  });
});

const CROSS = import.meta.glob(
  [
    "./AiMyAccountsSection.tsx",
    "../chat/AiConnectCard.tsx",
    "../welcome/FirstAgentStage.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

describe("교차: 설정·채팅 카드·온보딩이 같은 로그인 모달을 쓴다 (#2816·#2961·#2878)", () => {
  it("세 표면 모두 같은 모듈의 HarnessLoginDialog 를 그린다", () => {
    expect(Object.keys(CROSS)).toHaveLength(3);
    for (const [name, src] of Object.entries(CROSS)) {
      expect(src, name).toMatch(
        /\bHarnessLoginDialog\b[^;]*from "(@\/features\/welcome\/harnessLogin|\.\/harnessLogin)\/HarnessLoginDialog"/,
      );
      expect(src, name).toContain("<HarnessLoginDialog");
      // 스스로 로그인 명령을 만들지 않는다.
      expect(/kind:\s*"login"/.test(src), name).toBe(false);
    }
  });
});
