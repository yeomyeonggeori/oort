// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import type { RealtimeHandle, RealtimeStatus } from "@/lib/realtime";
import { fetchWithDeadline } from "@momo/core/lib/http";
import { ConnectionCard } from "@/features/sidebar/ConnectionCard";
import { useConnection } from "./connectionContext";
import { ConnectionProvider } from "./connectionModel";
import { useOffline } from "./useOffline";

/**
 * 연결 상태 모델이 화면에 닿는 자리(#5220, #5201 S-B). 코어의 판정 규칙(`model.test.ts`·`screenState.test.ts`)은
 * 거기서 재고, 여기서는 **배선**을 잰다: 소켓·기기·REST·창 복귀가 공급자로 들어가 카드와 쓰기 게이트로
 * 나온다. 시계는 가짜(`vi.useFakeTimers`)이고 숫자는 글자 그대로(1_000, 10_000, 2_000, 30_000) 단정한다.
 */

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const reconnect = vi.fn();
let korean: AppLocale;

beforeAll(async () => {
  korean = await koreanLocaleForTest();
});

function Probe() {
  const { view, recovered } = useConnection();
  const offline = useOffline();
  return (
    <span
      data-testid="probe"
      data-phase={view.phase}
      data-cause={view.cause ?? ""}
      data-offline={String(offline)}
      data-recovered={String(recovered)}
    />
  );
}

function session(connStatus: RealtimeStatus): SessionContextValue {
  return {
    session: {},
    workspaceId: "w",
    realtime: { reconnect } as unknown as RealtimeHandle,
    connStatus,
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function tree(connStatus: RealtimeStatus, wrap: (children: ReactNode) => ReactNode = (c) => c): ReactNode {
  return wrap(
    <SessionProvider value={session(connStatus)}>
      <ConnectionProvider>
        <Probe />
        <ConnectionCard />
      </ConnectionProvider>
    </SessionProvider>
  );
}

function mount(connStatus: RealtimeStatus, wrap?: (children: ReactNode) => ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(tree(connStatus, wrap)));
}

const setStatus = (connStatus: RealtimeStatus) => act(() => root!.render(tree(connStatus)));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const probe = () => document.querySelector<HTMLElement>('[data-testid="probe"]')!;
const card = () => document.querySelector<HTMLElement>('[data-testid="connection-card"]');
const action = () => document.querySelector<HTMLButtonElement>('[data-testid="connection-card-action"]');
const setOnLine = (online: boolean) =>
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });

/** 소켓이 오래 붙어 있던 건강한 상태로 만든다(처음 붙은 뒤 5초 넘게 지나면 틈이 풀린다). */
function mountHealthy() {
  mount("connected");
  advance(60_000);
  expect(card()).toBeNull();
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T04:00:00Z"));
  reconnect.mockReset();
  setOnLine(true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("① 소켓 틈이 화면에 닿는 시간: 1초 미만 침묵, 10초 경계", () => {
  it("끊긴 직후 999ms까지는 아무것도 없고, 1초부터 「연결 중」(단추 없음), 10초부터 「끊김」(단추 있음)", () => {
    mountHealthy();
    setStatus("disconnected");
    expect(card()).toBeNull();
    advance(999);
    expect(card()).toBeNull();

    advance(1); // 1_000ms
    expect(card()!.dataset.tone).toBe("connecting");
    expect(card()!.dataset.phase).toBe("connecting");
    expect(action()).toBeNull();

    advance(8_999); // 9_999ms
    expect(card()!.dataset.tone).toBe("connecting");

    advance(1); // 10_000ms
    expect(card()!.dataset.tone).toBe("down");
    expect(card()!.dataset.cause).toBe("realtimeDown");
    expect(action()).not.toBeNull();
  });

  it("오래 조용했던 앱에서 끊겨도 시계는 그 사건에서 시작한다(낡은 now로 타이머를 걸지 않는다)", () => {
    mountHealthy();
    advance(3_600_000); // 한 시간 동안 아무 사건도 없었다
    setStatus("disconnected");
    advance(999);
    expect(card()).toBeNull();
    advance(1);
    expect(card()!.dataset.tone).toBe("connecting");
  });

  it("10초 안에 다시 붙으면 카드는 말없이 사라지고 복구 표시도 없다", () => {
    mountHealthy();
    setStatus("disconnected");
    advance(5_000);
    expect(card()!.dataset.tone).toBe("connecting");
    setStatus("connected");
    expect(card()).toBeNull();
    advance(3_000);
    expect(card()).toBeNull();
  });

  it("실시간만 끊기면 쓰기 게이트는 처음부터 끝까지 열려 있다 (결정 ③)", () => {
    mountHealthy();
    setStatus("disconnected");
    for (const ms of [0, 999, 1, 8_999, 1, 30_000]) {
      advance(ms);
      expect(probe().dataset.offline).toBe("false");
    }
    expect(probe().dataset.cause).toBe("realtimeDown");
  });
});

describe("② 「끊김」이 보였다가 돌아오면 정확히 2초 「다시 연결됐어요」", () => {
  it("끊김 → 다시 붙음: 확인 표시가 2초 서고 사라진다", () => {
    mountHealthy();
    setStatus("disconnected");
    advance(10_000);
    expect(card()!.dataset.tone).toBe("down");
    setStatus("connected");
    expect(card()!.dataset.tone).toBe("recovered");
    expect(card()!.querySelector('[data-connection-mark="check"]')).not.toBeNull();
    expect(action()).toBeNull();
    advance(1_999);
    expect(card()!.dataset.tone).toBe("recovered");
    advance(1);
    expect(card()).toBeNull();
  });
});

describe("③ 기기 오프라인은 즉시, 그리고 막는다", () => {
  it("오프라인 이벤트에서 기다림 없이 카드가 서고(마크 정지, 단추 없음) 쓰기 게이트가 닫힌다", () => {
    mountHealthy();
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(probe().dataset.offline).toBe("true");
    expect(card()!.dataset.tone).toBe("offline");
    expect(card()!.dataset.cause).toBe("deviceOffline");
    expect(action()).toBeNull();
    expect(card()!.querySelector('[data-connection-mark="still"]')).not.toBeNull();
    expect(card()!.querySelector('[data-oort-loader]')!.getAttribute("data-motion")).toBe("still");
  });

  it("돌아오면 게이트가 열리고, 소켓이 붙으면 복구 표시가 2초 선다", () => {
    mountHealthy();
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event("offline"));
    });
    setStatus("disconnected"); // 브라우저가 오프라인이 되면 centrifuge도 소켓을 닫는다
    advance(2_000);
    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(probe().dataset.offline).toBe("false");
    setStatus("connected");
    expect(card()!.dataset.tone).toBe("recovered");
    advance(2_000);
    expect(card()).toBeNull();
  });
});

describe("④ 서버에 닿지 못함은 REST 결과에서 온다", () => {
  async function request(path: string, outcome: "unreachable" | "ok") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (outcome === "unreachable") throw new TypeError("Failed to fetch");
        return new Response("{}", { status: 200 });
      })
    );
    await act(async () => {
      await fetchWithDeadline(`http://server.test${path}`).catch(() => undefined);
    });
  }

  it("서로 다른 요청 3건이 연달아 닿지 못하면 카드(단추 있음)가 서고 쓰기가 막힌다. 응답 한 건이면 풀린다", async () => {
    mountHealthy();
    await request("/v1/a", "unreachable");
    await request("/v1/b", "unreachable");
    expect(probe().dataset.offline).toBe("false"); // 두 건은 아직 선언이 아니다
    expect(card()).toBeNull();
    await request("/v1/c", "unreachable");
    expect(probe().dataset.offline).toBe("true");
    expect(probe().dataset.cause).toBe("serverUnreachable");
    expect(card()!.dataset.tone).toBe("unreachable");
    expect(action()).not.toBeNull();

    await request("/v1/d", "ok");
    expect(probe().dataset.offline).toBe("false");
    expect(card()!.dataset.tone).toBe("recovered");
  });

  it("같은 요청이 세 번 실패해도 한 건이다(막지 않는다)", async () => {
    mountHealthy();
    for (let i = 0; i < 3; i += 1) await request("/v1/a", "unreachable");
    expect(probe().dataset.offline).toBe("false");
  });
});

describe("⑤ 「지금 다시 연결」", () => {
  it("누르면 소켓을 다시 열고(1회) 카드는 곧바로 「연결 중」이 되며 새 10초를 센다", () => {
    mountHealthy();
    setStatus("disconnected");
    advance(10_000);
    const button = action()!;
    act(() => button.click());
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(card()!.dataset.tone).toBe("connecting");
    expect(action()).toBeNull();
    // 누른 단추가 사라지므로 초점은 <body>가 아니라 카드가 받는다.
    expect(document.activeElement).toBe(card());

    advance(9_999);
    expect(card()!.dataset.tone).toBe("connecting");
    advance(1);
    expect(card()!.dataset.tone).toBe("down");
  });
});

describe("⑥ 창이 30초 넘게 숨었다 돌아오면 소켓을 새로 연다", () => {
  const visibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    act(() => void document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  };

  it("30초 숨었다 보이면 한 번 연다(멀쩡해 보이는 소켓도)", () => {
    mountHealthy();
    visibility("hidden");
    advance(30_000);
    visibility("visible");
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("29초 숨었다 보이면 건드리지 않는다", () => {
    mountHealthy();
    visibility("hidden");
    advance(29_999);
    visibility("visible");
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("창 포커스를 30초 잃었다 돌아와도 같다(보임 없이 포커스만 오가는 데스크탑)", () => {
    mountHealthy();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("blur")));
    advance(31_000);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("숨김과 포커스 이벤트가 겹쳐 와도 한 번만 연다", () => {
    mountHealthy();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("blur")));
    visibility("hidden");
    advance(40_000);
    visibility("visible");
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});

describe("⑦ 문장은 사전 키로만 나온다", () => {
  it("한국어 사전에서 끊김 카드의 제목·이유·단추가 해요체 문장으로 풀린다", () => {
    mount("connected", (children) => <LocaleProvider locale={korean}>{children}</LocaleProvider>);
    advance(60_000);
    act(() => root!.render(tree("disconnected", (children) => <LocaleProvider locale={korean}>{children}</LocaleProvider>)));
    advance(10_000);
    expect(card()!.querySelector('[data-testid="connection-card-title"]')!.textContent).toBe("실시간 연결이 끊겼어요");
    expect(card()!.querySelector('[data-testid="connection-card-detail"]')!.textContent).toBe("새 글이 늦게 보일 수 있어요.");
    expect(action()!.textContent).toBe("지금 다시 연결");
  });
});
