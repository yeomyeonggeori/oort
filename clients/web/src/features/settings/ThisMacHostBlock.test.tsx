// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, type UseQueryResult } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkHost } from "@momo/core/features/settings/api";
import type { LocalWorkHostStatus } from "@momo/core/features/settings/thisMacHost";

// =============================================================================
// #2778 설정 › 기기 › 이 맥의 작업 호스트 (#3578 S4가 코드 실행 호스트에서 옮겼다).
//
// 사보타주로 붉어지는 규율:
//   ① 「등록됐지만 오프라인」과 「아직 없음」이 같은 화면이 되면
//   ② 등록 해제가 서버 해지보다 로컬 삭제를 먼저 하면
//   ③ 등록에 이 세션의 토큰·워크스페이스·서버가 아닌 값이 실리면
// =============================================================================

const WS = "0f8fad5b-d9cb-469f-a165-70867728950e";
const HOST = "019a0000-0000-7000-8000-00000000abcd";
const ORIGIN = "https://oort-team.example";

const calls: string[] = [];
const bridge = vi.hoisted(() => ({
  status: vi.fn(),
  register: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  forget: vi.fn(),
}));
const revoke = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({ desktopWorkHost: bridge, isDesktop: () => true }));
vi.mock("@/lib/session", () => ({ getAccessToken: () => "access-token-of-sj" }));
vi.mock("@momo/core/features/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/settings/api")>()),
  resolveServerBaseUrl: () => ORIGIN,
  revokeWorkHost: revoke,
}));

import { ThisMacHostBlock } from "./ThisMacHostBlock";

function local(over: Partial<LocalWorkHostStatus> = {}): LocalWorkHostStatus {
  return {
    sidecar: true,
    registered: { hostId: HOST, workspaceId: WS, ownerMemberId: "m1", serverUrl: ORIGIN },
    running: true,
    heartbeat: { lastOkAtMs: Date.now(), failing: false },
    adapters: [
      { key: "claude", executable: "/opt/homebrew/bin/claude-agent-acp", found: true },
      { key: "codex", executable: "codex-acp", found: false },
    ],
    workFolder: "/Users/sj/oort-work",
    displayNameSuggestion: "성재의 MacBook Pro",
    ...over,
  };
}

function row(over: Partial<WorkHost> = {}): WorkHost {
  return {
    id: HOST,
    workspaceId: WS,
    scope: "member",
    ownerMemberId: "m1",
    type: "workd",
    displayName: "성재 맥북, 집 작업실",
    publicKey: "PK",
    capabilities: {},
    createdAtMs: 1,
    online: true,
    lastSeenAtMs: Date.now() - 5 * 60_000,
    ...over,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  calls.length = 0;
  for (const fn of Object.values(bridge)) fn.mockReset();
  revoke.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(status: LocalWorkHostStatus, hosts: WorkHost[] | undefined, offline = false) {
  bridge.status.mockResolvedValue(status);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const query = { data: hosts } as UseQueryResult<WorkHost[], unknown>;
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ThisMacHostBlock, { workspaceId: WS, hosts: query, offline })
      )
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const state = () => container.querySelector("[data-testid=this-mac]")?.getAttribute("data-this-mac-state");
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("이 맥 — 네 상태가 서로 다른 문장과 행동을 갖는다", () => {
  it("아직 없음: 등록 양식, 찾은 도구와 작업 폴더를 보인다", async () => {
    await render(local({ registered: null }), []);
    expect(state()).toBe("not_registered");
    expect(container.textContent).toContain("이 맥은 아직 작업 호스트가 아니에요.");
    expect(container.textContent).toContain("claude");
    expect(container.textContent).not.toContain("codex,");
    expect(container.textContent).toContain("/Users/sj/oort-work");
    expect(byTestId("this-mac-register-submit")?.textContent).toBe("이 맥을 호스트로 등록");
  });

  it("등록됐지만 꺼져 있음: 켜기, 「아직 없음」 문장은 없다", async () => {
    await render(local({ running: false, heartbeat: null }), [row({ online: false })]);
    expect(state()).toBe("offline");
    expect(container.textContent).toContain("등록됨, 꺼져 있음");
    expect(container.textContent).not.toContain("아직 작업 호스트가 아니에요");
    expect(byTestId("this-mac-start")?.textContent).toBe("작업 호스트 켜기");
    bridge.start.mockResolvedValue(local());
    await click(byTestId("this-mac-start"));
    expect(bridge.start).toHaveBeenCalledTimes(1);
  });

  it("켜져 있지만 서버에 닿지 못함: 이유와 마지막 연결을 말한다", async () => {
    await render(
      local({ heartbeat: { lastOkAtMs: null, failing: true } }),
      [row({ online: false })]
    );
    expect(container.textContent).toContain("등록됨, 오프라인");
    expect(byTestId("this-mac-sentence")?.textContent).toContain("서버에 닿지 못하고 있어요. 마지막 연결 5분 전.");
    expect(byTestId("this-mac-restart")).not.toBeNull();
  });

  it("온라인: 서버 목록의 이름과 끄기", async () => {
    await render(local(), [row()]);
    expect(state()).toBe("online");
    expect(container.textContent).toContain("성재 맥북, 집 작업실");
    expect(container.textContent).toContain("온라인");
    expect(byTestId("this-mac-stop")).not.toBeNull();
  });

  it("해지됨: 등록 정보 지우기만 권한다", async () => {
    await render(local(), [row({ revokedAtMs: 1 })]);
    expect(state()).toBe("revoked");
    expect(byTestId("this-mac-revoked")).not.toBeNull();
  });

  it("어댑터가 없으면 등록 대신 설치 안내와 다시 확인", async () => {
    await render(
      local({ registered: null, adapters: [{ key: "claude", executable: "claude-agent-acp", found: false }] }),
      []
    );
    expect(byTestId("this-mac-no-adapter")).not.toBeNull();
    expect(byTestId("this-mac-register-submit")).toBeNull();
  });
});

describe("등록과 해제의 순서", () => {
  it("등록은 이 세션의 서버·워크스페이스·토큰과 적은 이름을 싣는다", async () => {
    await render(local({ registered: null }), []);
    bridge.register.mockResolvedValue(local());
    await click(byTestId("this-mac-register-submit"));
    expect(bridge.register).toHaveBeenCalledWith({
      serverUrl: ORIGIN,
      workspaceId: WS,
      displayName: "성재의 MacBook Pro",
      accessToken: "access-token-of-sj",
    });
  });

  it("등록 실패는 셸 코드가 아니라 문장으로", async () => {
    await render(local({ registered: null }), []);
    bridge.register.mockRejectedValue("no_acp_adapter");
    await click(byTestId("this-mac-register-submit"));
    expect(byTestId("this-mac-register-error")?.textContent).toContain("ACP 어댑터를 찾지 못했어요");
  });

  it("해제는 서버 해지가 먼저, 그다음 로컬 삭제", async () => {
    await render(local(), [row()]);
    revoke.mockImplementation(async () => {
      calls.push("revoke");
    });
    bridge.forget.mockImplementation(async () => {
      calls.push("forget");
      return local({ registered: null, running: false, heartbeat: null });
    });
    await click(byTestId("this-mac-unregister"));
    const confirm = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "등록 해제" && button.getAttribute("data-testid") !== "this-mac-unregister"
    );
    await click(confirm ?? null);
    expect(calls).toEqual(["revoke", "forget"]);
    expect(revoke).toHaveBeenCalledWith(WS, HOST);
  });

  it("서버 해지가 실패하면 로컬 키는 지우지 않는다", async () => {
    await render(local(), [row()]);
    revoke.mockRejectedValue(new Error("HTTP 500"));
    await click(byTestId("this-mac-unregister"));
    const confirm = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "등록 해제" && button.getAttribute("data-testid") !== "this-mac-unregister"
    );
    await click(confirm ?? null);
    expect(bridge.forget).not.toHaveBeenCalled();
    expect(byTestId("this-mac-action-error")).not.toBeNull();
  });
});
