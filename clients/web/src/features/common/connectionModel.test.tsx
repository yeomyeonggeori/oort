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
import { resetConnectionDiagForTest } from "./connectionDiag";
import { ConnectionProvider } from "./connectionModel";
import { useOffline } from "./useOffline";
import { resetWakeWatchForTest } from "./wakeWatch";

// 데스크탑 웹뷰인 척(#5660 ⑥-2): `document.hasFocus()`를 믿지 않고 창 사건으로 초점을 따르는 길을 잰다. 기본은 브라우저다.
const shell = vi.hoisted(() => ({ desktop: false }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isDesktop: () => shell.desktop,
}));

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
/** 소켓이 서버에게서 마지막으로 들은 시각(#5660). null 이면 「모른다」(예전 판정 그대로). */
const heard: { at: number | null } = { at: null };
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
    realtime: { reconnect, lastHeardAt: () => heard.at } as unknown as RealtimeHandle,
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
  heard.at = null;
  shell.desktop = false;
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
  resetConnectionDiagForTest();
  resetWakeWatchForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("① 소켓 틈이 화면에 닿는 시간: 1초 미만 침묵, 10초 경계", () => {
  it("끊긴 직후 1초 직전까지는 아무것도 없고, 1초부터 「연결 중」(단추 없음), 10초부터 「끊김」(단추 있음)", () => {
    mountHealthy();
    setStatus("disconnected");
    expect(card()).toBeNull();
    advance(999);
    expect(card()).toBeNull();

    advance(1); // 정확히 1초
    expect(card()!.dataset.tone).toBe("connecting");
    expect(card()!.dataset.phase).toBe("connecting");
    expect(action()).toBeNull();

    advance(8_999); // 정확히 10초 직전
    expect(card()!.dataset.tone).toBe("connecting");

    advance(1); // 정확히 10초
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

  // #5403: 폰과 같은 규칙인지 확인한다 - 깨움이 늦게 울려도(절전·멈춘 타이머) 복구 표시는 보내기 같은 사람의 행동을 기다리지 않고 거두어진다.
  it("깨움이 5분 늦게 울려도 복구 표시는 저절로 거두어진다(다음 사건을 기다리지 않는다)", () => {
    mountHealthy();
    setStatus("disconnected");
    advance(10_000);
    expect(card()!.dataset.tone).toBe("down");
    setStatus("connected");
    expect(card()!.dataset.tone).toBe("recovered");
    // 시각만 5분 뛴다(깨움 타이머는 아직 울리지 않았다). 상태는 그대로이고, 타이머가 울리는 순간 한 번의 판정으로 거둔다.
    vi.setSystemTime(Date.now() + 300_000);
    expect(card()!.dataset.tone).toBe("recovered");
    advance(2_000);
    expect(card()).toBeNull();
    expect(probe().dataset.recovered).toBe("false");
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

describe("⑥-2 돌아온 순간은 확인하고, 끊겼으면 기다리지 않는다 (#5660)", () => {
  const visibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    act(() => void document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  };
  const blur = () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("blur")));
  };
  const focus = () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("focus")));
  };

  it("뒤에서도 핑을 들은 소켓은 30분 숨었다 돌아와도 끊고 다시 열지 않는다", () => {
    mountHealthy();
    visibility("hidden");
    for (let i = 0; i < 72; i += 1) {
      advance(25_000);
      heard.at = Date.now(); // 25초마다 서버 핑
    }
    advance(3_000);
    visibility("visible");
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("30초 넘게 숨었고 그동안 아무것도 듣지 못했으면(잠든 사이 죽은 소켓) 「연결됨」이어도 연다", () => {
    mountHealthy();
    heard.at = Date.now();
    visibility("hidden");
    advance(5 * 60_000);
    visibility("visible");
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("다시 붙기를 기다리는 중이면 5초만 비웠다 돌아와도 곧바로 연다(백오프의 남은 시간을 기다리지 않는다)", () => {
    mountHealthy();
    setStatus("disconnected");
    blur();
    advance(5_000);
    focus();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("끊긴 동안 창을 6초마다 오가도 끊긴 때부터 10초에 「끊김」과 다시 연결 단추가 선다(돌아옴이 시계를 새로 시작하지 않는다)", () => {
    mountHealthy();
    setStatus("disconnected");
    advance(5_700);
    blur();
    advance(300);
    focus(); // 6초: 기다리지 않고 다시 연다
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(card()!.dataset.tone).toBe("connecting");
    advance(4_000); // 끊긴 지 10초
    expect(card()!.dataset.tone).toBe("down");
    expect(action()).not.toBeNull();
    advance(1_700);
    blur();
    advance(300);
    focus(); // 12초: 또 연다, 그래도 「끊김」은 그대로
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(card()!.dataset.tone).toBe("down");
    expect(action()).not.toBeNull();
  });

  it("앱이 뒤에서 시작했어도 자리 비움은 시작한 때부터 센다: 31초 뒤 앞으로 오면 아무것도 듣지 못한 소켓을 연다", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    mount("connected");
    advance(31_000);
    visibility("visible");
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("처음 붙는 중(`connecting`)에는 창을 오가도 손대지 않는다", () => {
    mount("connecting");
    blur();
    advance(5_000);
    focus();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("데스크탑에서 돌아온 순간 `hasFocus()`가 거짓이어도 창 사건으로 돌아옴을 안다", () => {
    shell.desktop = true;
    mountHealthy();
    blur();
    advance(31_000);
    // 데스크탑 웹뷰: 창이 앞에 왔는데 `hasFocus()`는 아직 거짓이다(`useChannelViewingBeat`이 적어 둔 그 현상).
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(document.hasFocus()).toBe(false);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("앞에 둔 채 맥이 20초 잠들었다 깨면(창 사건 없음) 늦게 깬 시계가 소켓을 연다", () => {
    mountHealthy();
    heard.at = Date.now();
    // 잠자기: 시계만 20초 건너뛰고 그동안 타이머는 하나도 돌지 않았다. 깨어난 뒤 첫 시계가 20초 늦게 운다.
    vi.setSystemTime(Date.now() + 20_000);
    advance(5_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("깨어나며 연 직후 창이 앞으로 와도 한 번만 연다(막 붙던 시도를 끊지 않는다)", () => {
    mountHealthy();
    heard.at = Date.now();
    blur();
    vi.setSystemTime(Date.now() + 40_000); // 뒤에 둔 채 40초 잠들었다
    advance(5_000); // 깬 뒤 첫 시계: 늦게 깸 → 연다
    expect(reconnect).toHaveBeenCalledTimes(1);
    setStatus("disconnected"); // 다시 붙는 중
    focus(); // 사람이 곧바로 앞으로 가져왔다
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("타이머만 늦게 깼고 그 사이에도 서버의 말을 들었으면(숨은 탭의 묶인 타이머) 열지 않는다", () => {
    mountHealthy();
    vi.setSystemTime(Date.now() + 20_000);
    heard.at = Date.now() - 2_000; // 멈춘 동안이 아니라 그 뒤에 들었다
    advance(5_000);
    expect(reconnect).not.toHaveBeenCalled();
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

// #5407: 폰과 같은 코어 규칙인지 확인한다 - 「서버에 닿지 못했어요」 카드는 응답 한 건이 와야 걷혔다. 이제 창이 보이는 동안 서 있으면 앱이 스스로 가볍게 다시 확인하고
// (2 · 4 · 8 · 16 · 30초), 서버가 돌아오면 사람의 요청 없이 걷힌다. 숨은 창에서는 보내지 않는다. 사람이 하는 요청은 카드를 세우는 `hit` 뿐이다.
describe("⑧ 서버에 닿지 못함 카드는 앱이 스스로 다시 확인한다 (#5407)", () => {
  let serverUp = false;
  const fetchMock = vi.fn();

  const urls = () => fetchMock.mock.calls.map(([url]) => String(url));
  const probes = () => urls().filter((url) => url.endsWith("/healthz"));
  const humanRequests = () => urls().filter((url) => !url.endsWith("/healthz"));
  const advanceAsync = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const visibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    act(() => void document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  };

  async function hit(path: string) {
    await act(async () => {
      await fetchWithDeadline(`http://server.test${path}`).catch(() => undefined);
    });
  }
  async function declareUnreachable() {
    for (const path of ["/v1/a", "/v1/b", "/v1/c"]) await hit(path);
    expect(card()!.dataset.tone).toBe("unreachable");
  }

  beforeEach(() => {
    serverUp = false;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => {
      if (!serverUp) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("서버가 돌아오면 사람의 요청 없이 카드가 걷힌다: 2초에 첫 확인, 돌아온 뒤 다음 확인(6초)에 「다시 연결됐어요」를 거쳐 비워진다", async () => {
    mountHealthy();
    await declareUnreachable();
    expect(humanRequests()).toHaveLength(3);
    await advanceAsync(1_999);
    expect(probes()).toHaveLength(0);
    await advanceAsync(1);
    expect(probes()).toHaveLength(1);
    expect(card()!.dataset.tone).toBe("unreachable");
    expect(probe().dataset.offline).toBe("true");

    serverUp = true;
    await advanceAsync(3_999);
    expect(probes()).toHaveLength(1);
    expect(card()!.dataset.tone).toBe("unreachable");
    await advanceAsync(1);
    expect(probes()).toHaveLength(2);
    expect(card()!.dataset.tone).toBe("recovered");
    expect(probe().dataset.offline).toBe("false");
    await advanceAsync(2_000);
    expect(card()).toBeNull();
    await advanceAsync(300_000);
    expect(probes()).toHaveLength(2);
    expect(humanRequests()).toHaveLength(3);
  });

  it("숨은 창에서는 확인을 한 건도 보내지 않고, 다시 보이면 2초부터 시작한다", async () => {
    mountHealthy();
    await declareUnreachable();
    visibility("hidden");
    await advanceAsync(300_000);
    expect(probes()).toHaveLength(0);
    visibility("visible");
    await advanceAsync(1_999);
    expect(probes()).toHaveLength(0);
    await advanceAsync(1);
    expect(probes()).toHaveLength(1);
  });

  it("포커스를 잃어도 보이는 창이면 확인한다 (옆 창을 쓰는 중에도 이 창의 카드는 걷혀야 한다)", async () => {
    mountHealthy();
    await declareUnreachable();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("blur")));
    await advanceAsync(2_000);
    expect(probes()).toHaveLength(1);
  });

  it("실시간이 다시 붙으면 요청 없이 걷히고, 확인도 멈춘다", async () => {
    mountHealthy();
    await declareUnreachable();
    await advanceAsync(2_000);
    expect(probes()).toHaveLength(1);
    setStatus("disconnected");
    setStatus("connected");
    expect(card()!.dataset.tone).toBe("recovered");
    await advanceAsync(300_000);
    expect(probes()).toHaveLength(1);
    expect(humanRequests()).toHaveLength(3);
  });
});
