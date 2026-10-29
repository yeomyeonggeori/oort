// @vitest-environment jsdom
// ADR-0186 증보 v5 U-b-3 (#4705): 「에이전트의 먼저 제안」 끄개는 확인된 서버·관리자에게만 선다.
// 없으면 켜짐이다.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { AgentInitiativeSetting } from "./AgentInitiativeSetting";

// 경계는 HTTP 한 곳이다. 코어의 읽기·물음·저장은 진짜로 돈다.
const request = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    settingsRequest: (...args: unknown[]) => request(...args) as Promise<unknown>,
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // 중괄호가 필요하다: mock 자신을 돌려주면 vitest 가 그것을 정리 훅으로 불러 버린다.
  request.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 보낸 PATCH 본문들(물음과 저장). GET 은 빠진다. */
function patches(): Array<Record<string, unknown>> {
  return request.mock.calls
    .map((call) => call[1] as { method?: string; body?: string } | undefined)
    .filter((init): init is { method: string; body: string } => init?.method === "PATCH")
    .map((init) => JSON.parse(init.body) as Record<string, unknown>);
}

/** 가방을 읽는 GET 에는 `bag` 을, PATCH 에는 `onPatch` 의 답을 준다. */
function serve(bag: unknown, onPatch: (body: Record<string, unknown>) => Promise<unknown>) {
  request.mockImplementation((_path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PATCH") {
      return onPatch(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
    }
    return bag instanceof Error ? Promise.reject(bag) : Promise.resolve(bag);
  });
}

async function mount(offline = false): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgentInitiativeSetting, { workspaceId: WS, offline })
      )
    );
  });
  await flush();
  return host;
}

const card = (view: HTMLElement) =>
  view.querySelector('[data-testid="workspace-agent-initiative-card"]');
const toggle = (view: HTMLElement) =>
  view.querySelector<HTMLButtonElement>('[data-testid="workspace-agent-initiative"]');
const saveError = (view: HTMLElement) =>
  view.querySelector('[data-testid="workspace-agent-initiative-save-error"]');
const probeRefusal = () =>
  Promise.reject(new ApiError(400, "agent_initiative must be true or false"));

describe("에이전트의 먼저 제안 끄개", () => {
  it("키가 없고 서버가 안다고 답하면 켜진 스위치가 선다(없으면 켜짐)", async () => {
    serve({}, probeRefusal);
    const view = await mount();
    expect(patches()).toHaveLength(1);
    expect(card(view)).not.toBeNull();
    expect(toggle(view)?.getAttribute("aria-checked")).toBe("true");
  });

  it("가방에 값이 있으면 묻지 않고 그 값을 보여 준다", async () => {
    serve({ agent_initiative: false }, probeRefusal);
    const view = await mount();
    expect(patches()).toHaveLength(0);
    expect(toggle(view)?.getAttribute("aria-checked")).toBe("false");
  });

  it("키를 모르는 서버에서는 아무것도 그리지 않는다", async () => {
    serve({}, () => Promise.reject(new ApiError(400, "unknown settings key: agent_initiative")));
    const view = await mount();
    expect(card(view)).toBeNull();
    expect(view.textContent).toBe("");
  });

  it("확인하지 못하면 그리지 않는다", async () => {
    serve({}, () => Promise.resolve({}));
    const view = await mount();
    expect(card(view)).toBeNull();
  });

  it("관리자가 아니면(가방 403) 묻지도 그리지도 않는다", async () => {
    serve(new ApiError(403, "forbidden"), probeRefusal);
    const view = await mount();
    expect(card(view)).toBeNull();
    expect(patches()).toHaveLength(0);
  });

  it("끄면 false 를 저장하고, 실패하면 이유를 말하며 스위치가 되돌아온다", async () => {
    let answer: () => Promise<unknown> = () => Promise.reject(new ApiError(500, "boom"));
    serve({ agent_initiative: true }, () => answer());
    const view = await mount();
    await act(async () => {
      toggle(view)?.click();
    });
    await flush();
    expect(patches().at(-1)).toEqual({ agent_initiative: false });
    expect(saveError(view)).not.toBeNull();
    expect(toggle(view)?.getAttribute("aria-checked")).toBe("true");

    answer = () => Promise.resolve({ agent_initiative: false });
    await act(async () => {
      toggle(view)?.click();
    });
    await flush();
    expect(patches().at(-1)).toEqual({ agent_initiative: false });
    expect(toggle(view)?.getAttribute("aria-checked")).toBe("false");
    expect(saveError(view)).toBeNull();
  });

  it("오프라인이면 눌러도 저장하지 않는다", async () => {
    serve({ agent_initiative: true }, probeRefusal);
    const view = await mount(true);
    await act(async () => {
      toggle(view)?.click();
    });
    await flush();
    expect(patches()).toHaveLength(0);
  });
});
