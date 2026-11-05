// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkHost } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { SurfaceGate, SurfaceRoute } from "./SurfaceGate";
import { WORK_HOST_OFFLINE_GRACE_MS } from "./useSurfaceProvided";

// =============================================================================
// #2780: `/work` 라우트의 세 답. 호스트 목록을 **읽지 못한 것**을 「호스트가
// 없다」로 말하면 화면이 거짓을 말한다(design-review H-1). 세 경우를 모두 그려
// 서로 다른 문장이 서는지 센다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const hostsAnswer: { run: () => Promise<WorkHost[]> } = {
  run: async () => [],
};

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchWorkHosts: () => hostsAnswer.run() };
});

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: {
        id: "00000000-0000-7000-8000-000000000101",
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
}

async function mount(
  body: ReactElement = createElement(SurfaceRoute, {
    surface: "workConsole",
    children: createElement("div", { "data-testid": "console-body" }),
  }),
  locale?: AppLocale
): Promise<{ el: HTMLElement; client: QueryClient }> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: session() },
      body
    )
  );
  // `locale`은 사전 문장을 한국어로 단정하는 시험만 준다(공급자가 없으면 번들된 영어로 물러난다).
  const tree: ReactElement = locale ? createElement(LocaleProvider, { locale, children: page }) : page;
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
  return { el: host, client };
}

async function settled(client: QueryClient): Promise<void> {
  await vi.waitFor(() => {
    const status = client.getQueryState(["work-hosts", WS])?.status;
    expect(status === "success" || status === "error").toBe(true);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function onlineHost(): WorkHost {
  return {
    id: "00000000-0000-7000-8000-000000000301",
    workspaceId: WS,
    scope: "workspace",
    ownerMemberId: "00000000-0000-7000-8000-000000000101",
    type: "workd",
    displayName: "팀 맥 미니",
    capabilities: {},
    createdAtMs: 1_800_000_000_000,
    online: true,
  };
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("SurfaceRoute (#2780)", () => {
  it("목록을 읽지 못하면 「호스트가 없다」가 아니라 읽지 못했다고 말하고 다시 시도를 준다", async () => {
    hostsAnswer.run = async () => {
      throw new Error("503");
    };
    const { el, client } = await mount();
    await settled(client);
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="surface-route-error-banner"]')).not.toBeNull();
    });
    expect(el.querySelector('[data-testid="surface-unavailable-route"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-body"]')).toBeNull();
    expect(el.querySelector("h1")?.textContent).toBe("작업 콘솔");
  });

  it("목록을 읽었고 온라인 호스트가 없으면 이유를 말하는 빈 상태다", async () => {
    hostsAnswer.run = async () => [{ ...onlineHost(), online: false }];
    const { el, client } = await mount();
    await settled(client);
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="surface-unavailable-route"]')).not.toBeNull();
    });
    expect(el.querySelector('[data-testid="surface-route-error-banner"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-body"]')).toBeNull();
  });

  it("온라인 호스트가 있으면 화면 자체가 선다", async () => {
    hostsAnswer.run = async () => [onlineHost()];
    const { el, client } = await mount();
    await settled(client);
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="console-body"]')).not.toBeNull();
    });
  });

  it("답이 오기 전에는 머리만 서고 「없다」를 먼저 말하지 않는다", async () => {
    hostsAnswer.run = () => new Promise<WorkHost[]>(() => undefined);
    const { el } = await mount();
    expect(el.querySelector('[data-testid="surface-route-pending"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="surface-unavailable-route"]')).toBeNull();
    expect(el.querySelector("h1")?.textContent).toBe("작업 콘솔");
  });
});

// #5279 B: 못 읽은 이유를 말한다. 「호스트가 없다」가 아니라 못 읽었다는 사실은 그대로이고(위 첫 시험), 이제 그 실패 줄이 원인(닫힌 분류)마다 다른 이유를
// 말한다. 위 시험의 `new Error("503")`은 연결 쪽 원인이 아니라 「그 밖」이 되는 경우일 뿐이다: 여기서는 진짜 오류 종류를 던진다.
describe("호스트 목록을 못 읽은 줄의 이유 (#5279 B)", () => {
  it("원인마다 다른 이유를 말한다: 오프라인 / 서버에 닿지 못함 / 그 밖. 상태 코드는 없다", async () => {
    const ko = await koreanLocale();
    const onLine = vi.spyOn(globalThis.navigator, "onLine", "get");
    const cases: [string, () => unknown, boolean, string][] = [
      ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요."],
      ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요."],
      ["그 밖", () => new ApiError(500, "boom", "internal"), true, "문제가 생겼어요."],
    ];
    try {
      for (const [name, failure, online, reason] of cases) {
        onLine.mockReturnValue(online);
        hostsAnswer.run = async () => {
          throw failure();
        };
        const { el, client } = await mount(undefined, ko);
        await settled(client);
        await vi.waitFor(() => {
          expect(el.querySelector('[data-testid="surface-route-error-banner"]'), name).not.toBeNull();
        });
        const text = el.querySelector('[data-testid="surface-route-error-banner"]')?.textContent ?? "";
        expect(text, name).toContain(`코드 실행 호스트 목록을 불러오지 못했어요. ${reason}`);
        expect(text, name).not.toMatch(/\d{3}/);
        act(() => root?.unmount());
        root = null;
        host?.remove();
        host = null;
      }
    } finally {
      onLine.mockRestore();
    }
  });

  it("다시 시도는 호스트 목록을 다시 읽고, 읽히면 줄이 걷힌다", async () => {
    const ko = await koreanLocale();
    let calls = 0;
    hostsAnswer.run = async () => {
      calls += 1;
      if (calls === 1) throw new ApiError(500, "boom", "internal");
      return [onlineHost()];
    };
    const { el, client } = await mount(undefined, ko);
    await settled(client);
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="surface-route-error-banner"]')).not.toBeNull();
    });
    const retry = el.querySelector<HTMLButtonElement>('[data-testid="surface-route-error-banner"] button');
    expect(retry?.textContent).toBe("다시 시도");
    act(() => retry?.click());
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="console-body"]')).not.toBeNull();
    });
    expect(calls).toBe(2);
    expect(el.querySelector('[data-testid="surface-route-error-banner"]')).toBeNull();
  });
});

describe("관전·관제 표면은 남의 개인 호스트로도 선다 (#2854 planner 결정 (a))", () => {
  const OTHER = "00000000-0000-7000-8000-000000000102";
  const othersPersonal = (): WorkHost => ({ ...onlineHost(), scope: "member", ownerMemberId: OTHER });

  it("관제 줄·관제 서랍의 문(SurfaceGate ade)이 선다", async () => {
    hostsAnswer.run = async () => [othersPersonal()];
    const { el, client } = await mount(
      createElement(SurfaceGate, {
        surface: "ade",
        children: createElement("div", { "data-testid": "ade-body" }),
      })
    );
    await settled(client);
    await vi.waitFor(() => expect(el.querySelector('[data-testid="ade-body"]')).not.toBeNull());
  });

  it("작업 콘솔 라우트도 선다(채널 멤버는 그 세션을 볼 수 있다)", async () => {
    hostsAnswer.run = async () => [othersPersonal()];
    const { el, client } = await mount();
    await settled(client);
    await vi.waitFor(() => expect(el.querySelector('[data-testid="console-body"]')).not.toBeNull());
  });
});

describe("열린 표면은 호스트가 잠깐 오프라인이 돼도 바로 내려가지 않는다 (#2893)", () => {
  // heartbeat는 90초 창이고 목록은 60초마다 다시 읽는다. 창 경계에서 한 번 흔들린
  // 답에 열어 둔 콘솔·관제 서랍이 사라지면, 보던 작업을 잃는다.
  // 첫 답은 실제 시계로 받고, 그 뒤 시간만 가짜 시계로 민다(벽시계 경합 없음).
  const GRACE = WORK_HOST_OFFLINE_GRACE_MS;
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  async function answer(client: QueryClient, online: boolean): Promise<void> {
    hostsAnswer.run = async () => [{ ...onlineHost(), online }];
    await act(async () => {
      const done = client.refetchQueries({ queryKey: ["work-hosts", WS] });
      await vi.advanceTimersByTimeAsync(1);
      await done;
      await vi.advanceTimersByTimeAsync(1);
    });
    // 양성 대조: 캐시가 정말 그 답으로 바뀌었다.
    expect(client.getQueryData<WorkHost[]>(["work-hosts", WS])?.[0]?.online).toBe(online);
  }

  async function openConsole(): Promise<{ el: HTMLElement; client: QueryClient }> {
    hostsAnswer.run = async () => [onlineHost()];
    const mounted = await mount();
    await settled(mounted.client);
    await vi.waitFor(() =>
      expect(mounted.el.querySelector('[data-testid="console-body"]')).not.toBeNull()
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    return mounted;
  }

  it("유예는 폴 두 번(120초)이다", () => {
    expect(GRACE).toBe(120_000);
  });

  it("열린 작업 콘솔은 유예 동안 남고, 유예가 지나면 빈 상태로 간다", async () => {
    const { el, client } = await openConsole();

    await answer(client, false);
    await advance(GRACE - 1_000);
    expect(el.querySelector('[data-testid="console-body"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="surface-unavailable-route"]')).toBeNull();

    await advance(2_000);
    expect(el.querySelector('[data-testid="console-body"]')).toBeNull();
    expect(el.querySelector('[data-testid="surface-unavailable-route"]')).not.toBeNull();
  });

  it("유예 안에 호스트가 돌아오면 유예를 거두고, 다시 끊기면 처음부터 센다", async () => {
    const { el, client } = await openConsole();

    await answer(client, false);
    await advance(GRACE / 2);
    await answer(client, true);
    await advance(GRACE / 4);
    await answer(client, false);
    // 첫 끊김부터 재면 유예가 이미 지났을 시점이다. 두 번째 끊김부터는 아직이다.
    await advance(GRACE / 2);
    expect(el.querySelector('[data-testid="console-body"]')).not.toBeNull();
    await advance(GRACE / 2 + 1_000);
    expect(el.querySelector('[data-testid="console-body"]')).toBeNull();
  });

  it("열린 관제 서랍(SurfaceGate ade)도 유예 동안 남는다", async () => {
    hostsAnswer.run = async () => [onlineHost()];
    const { el, client } = await mount(
      createElement(SurfaceGate, {
        surface: "ade",
        children: createElement("div", { "data-testid": "ade-body" }),
      })
    );
    await settled(client);
    await vi.waitFor(() => expect(el.querySelector('[data-testid="ade-body"]')).not.toBeNull());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await answer(client, false);
    await advance(GRACE - 1_000);
    expect(el.querySelector('[data-testid="ade-body"]')).not.toBeNull();
    await advance(2_000);
    expect(el.querySelector('[data-testid="ade-body"]')).toBeNull();
  });

  it("호스트가 없을 때 새로 연 화면은 유예 없이 바로 빈 상태다", async () => {
    hostsAnswer.run = async () => [{ ...onlineHost(), online: false }];
    const { el, client } = await mount();
    await settled(client);
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="surface-unavailable-route"]')).not.toBeNull();
    });
    expect(el.querySelector('[data-testid="console-body"]')).toBeNull();
  });
});
