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
import { ConnectionDiagSection } from "@/features/settings/ConnectionDiagSection";
import { ConnectionProvider } from "./connectionModel";
import { readConnectionDiag, resetConnectionDiagForTest } from "./connectionDiag";

const desktop = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isDesktop: () => desktop.on,
}));

/**
 * 연결 판정 진단 기록의 배선(#5587). 코어의 「무엇을 남기나」는 `diagnosticLog.test.ts`가 재고, 여기서는 실제 공급자(`ConnectionProvider`)와
 * 실제 `fetchWithDeadline`을 거쳐 이 기기의 저장소에 무엇이 남는지, 설정 카드가 그것을 어떻게 보이고 복사하는지를 잰다.
 */

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const SLOT = "momo.connection.diag.v1";
const SERVER = "https://oort.example/v1/workspaces/ws-7f3a/channels/ch-91c2";

let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;

beforeAll(async () => {
  korean = await koreanLocaleForTest();
});

function session(connStatus: RealtimeStatus): SessionContextValue {
  return {
    session: {},
    workspaceId: "w",
    realtime: { reconnect: vi.fn() } as unknown as RealtimeHandle,
    connStatus,
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function tree(connStatus: RealtimeStatus, extra: ReactNode = null): ReactNode {
  return (
    <LocaleProvider locale={korean}>
      <SessionProvider value={session(connStatus)}>
        <ConnectionProvider>{extra}</ConnectionProvider>
      </SessionProvider>
    </LocaleProvider>
  );
}

function mount(connStatus: RealtimeStatus, extra: ReactNode = null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(tree(connStatus, extra)));
}

const kinds = () => readConnectionDiag().map((entry) => entry.kind);
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const setOnLine = (online: boolean) =>
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });

async function failDistinct(paths: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Load failed");
    })
  );
  for (const path of paths) {
    await act(async () => {
      await fetchWithDeadline(`${SERVER}/${path}`).catch(() => null);
    });
  }
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  desktop.on = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T04:00:00Z"));
  window.localStorage.removeItem(SLOT);
  resetConnectionDiagForTest();
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
  window.localStorage.removeItem(SLOT);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("공급자가 이 기기에 남기는 것 (#5587)", () => {
  it("기기 오프라인·서버에 닿지 못함의 전이와 실패 분류를 남기고, 저장된 값에는 주소가 없다", async () => {
    mount("connected");
    advance(10_000);

    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event("offline"));
    });
    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event("online"));
    });
    await failDistinct(["a", "b", "c"]);

    expect(kinds()).toEqual([
      "socket.connected",
      "device.offline",
      "send.blocked.deviceOffline",
      "device.online",
      "send.open",
      "rest.fail.network",
      "rest.fail.network",
      "rest.fail.network",
      "rest.declared",
      "send.blocked.serverUnreachable",
    ]);
    const stored = window.localStorage.getItem(SLOT) ?? "";
    expect(stored).toContain('"send.blocked.serverUnreachable"');
    expect(stored).not.toMatch(/ws-7f3a|ch-91c2|oort\.example|Load failed/);
  });

  it("창 숨김·보임·초점과, 예정보다 크게 늦게 깬 타이머(앱이 잠듦)를 남긴다", () => {
    mount("connected");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true })); // 브라우저처럼 문서에서 창까지 오른다
    });
    // 앱이 4분 동안 돌지 않았다: 벽시계만 흐르고 5초 시계는 깨는 순간 돈다.
    vi.setSystemTime(Date.now() + 4 * 60_000);
    advance(5_000);
    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true })); // 브라우저처럼 문서에서 창까지 오른다
      window.dispatchEvent(new Event("focus"));
    });
    expect(kinds()).toEqual(["socket.connected", "window.blur", "window.hidden", "wake.late.1m", "window.visible", "window.focus"]);
  });

  it("데스크탑이 아니면(브라우저 탭) 아무것도 남기지 않는다", async () => {
    desktop.on = false;
    mount("connected");
    await failDistinct(["a", "b", "c"]);
    expect(kinds()).toEqual([]);
    expect(window.localStorage.getItem(SLOT)).toBeNull();
  });
});

describe("설정 > 업데이트 > 연결 기록", () => {
  it("오늘의 횟수를 묶음별로 보이고, 복사 단추가 시각과 종류만 든 글을 복사한다", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    mount("connected", <ConnectionDiagSection appVersion="0.1.46" />);
    await failDistinct(["a", "b", "c"]);

    const row = (id: string) =>
      document.querySelector(`[data-testid="connection-log-${id}"]`)?.textContent?.replace(/\s+/g, " ");
    expect(row("send-blocked")).toContain("보낼 수 없음1번");
    expect(row("rest-failed")).toContain("서버 응답 없음3번");
    expect(row("device-offline")).toContain("기기 오프라인0번");

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="connection-log-copy"]')!.click();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = String(writeText.mock.calls[0]?.[0 as never]);
    const lines = copied.split("\n");
    expect(lines[0]).toBe("0.1.46");
    for (const line of lines.slice(1)) expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z [a-z]+(\.[a-zA-Z0-9]+)+$/);
    expect(copied).toContain("send.blocked.serverUnreachable");
    expect(document.querySelector('[data-testid="connection-log-copy"]')?.textContent).toBe("복사됨");
  });
});
