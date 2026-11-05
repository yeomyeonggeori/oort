// @vitest-environment jsdom
// #4508 (ADR-0206 D4·D13, 수용 기준 38): 「데스크탑을 쓰는 동안 폰 알림 늦추기」 칸. 값 저장은 서버의
// 닫힌 집합 {0, 60, 300}에서 이 필드 하나만 쓰고, 옛 서버(404·405)에서는 칸이 숨는다.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneDelaySecs } from "@momo/core/features/settings/notificationPrefs";
import { ApiError } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { PhoneDelayRow } from "./PhoneDelayRow";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

const fetchPhoneDelay = vi.hoisted(() => vi.fn());
const savePhoneDelay = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/notificationPrefs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/notificationPrefs")>();
  return {
    ...actual,
    fetchPhoneDelay: (workspaceId: string) => fetchPhoneDelay(workspaceId) as Promise<PhoneDelaySecs>,
    savePhoneDelay: (workspaceId: string, secs: PhoneDelaySecs) =>
      savePhoneDelay(workspaceId, secs) as Promise<PhoneDelaySecs>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

beforeAll(async () => {
  ko = await koreanLocale();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  fetchPhoneDelay.mockReset();
  savePhoneDelay.mockReset();
  fetchPhoneDelay.mockResolvedValue(60);
  savePhoneDelay.mockImplementation(async (_ws: string, secs: PhoneDelaySecs) => secs);
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

async function mount(offline = false): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: session() },
      createElement(
        "div",
        null,
        createElement(PhoneDelayRow, { offline, offlineReasonId: "offline-reason" }),
        offline ? createElement("p", { id: "offline-reason" }, "연결이 끊겼어요") : null
      )
    )
  );
  await act(async () => {
    root?.render(createElement(LocaleProvider, { locale: ko, children: tree }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** react-query 의 알림(setTimeout 묶음)이 한 번 돌 시간을 준다. */
const flush = () => act(async () => void (await new Promise((done) => setTimeout(done, 25))));

const q = <T extends HTMLElement>(testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`) as T | null;
const radio = (secs: number) => q<HTMLInputElement>(`phone-delay-choice-${secs}`)!;
/** 읽기가 끝나(막대가 사라질) 때까지 기다린다. */
const settled = () => vi.waitFor(() => expect(q("phone-delay-loading")).toBeNull());
async function choose(secs: number): Promise<void> {
  await act(async () => {
    radio(secs).click();
  });
}

describe("PhoneDelayRow", () => {
  it("서버의 값을 보이고, 고르면 이 필드 하나만 저장하고 그 값이 남는다", async () => {
    await mount();
    await settled();
    expect(q("phone-delay-row")?.textContent).toContain("데스크탑을 쓰는 동안 폰 알림 늦추기");
    // 서버 값 60초 = 「1분」. 고를 수 있는 값은 서버의 닫힌 집합 세 개뿐이다(상한 300초).
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="phone-delay"]')];
    expect(radios.map((r) => r.value)).toEqual(["0", "60", "300"]);
    expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
    // 칸의 이름은 화면에 보이는 글(라벨)이고, 보조기술이 읽는 그룹 이름(legend)은 행 제목과 같다.
    expect([...document.querySelectorAll('[data-testid="phone-delay-choice"] label')].map((l) => l.textContent)).toEqual([
      "끔",
      "1분",
      "5분",
    ]);
    expect(q("phone-delay-choice")?.querySelector("legend")?.textContent).toBe(
      "데스크탑을 쓰는 동안 폰 알림 늦추기"
    );
    await choose(300);
    expect(savePhoneDelay).toHaveBeenCalledTimes(1);
    expect(savePhoneDelay).toHaveBeenCalledWith(WS, 300);
    await vi.waitFor(() => expect(radio(300).checked).toBe(true));
    expect(q("phone-delay-save-error")).toBeNull();
    await choose(0);
    expect(savePhoneDelay).toHaveBeenLastCalledWith(WS, 0);
    await vi.waitFor(() => expect(radio(0).checked).toBe(true));
  });

  it("저장이 실패하면 이전 값으로 돌리고 한 줄로 말한다", async () => {
    savePhoneDelay.mockRejectedValue(new ApiError(500, "boom"));
    await mount();
    await settled();
    await choose(300);
    await vi.waitFor(() => expect(q("phone-delay-save-error")).not.toBeNull());
    expect(radio(60).checked).toBe(true);
    expect(radio(300).checked).toBe(false);
    expect(q("phone-delay-save-error")?.textContent).toContain("저장하지 못했어요");
  });

  it("쓰는 동안 칸을 잠그지 않는다: 방향키로 연달아 지나가도 포커스가 남고 쓰기는 고른 순서대로 한 줄로 나간다", async () => {
    const first = deferred<PhoneDelaySecs>();
    const second = deferred<PhoneDelaySecs>();
    savePhoneDelay.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount();
    await settled();
    await choose(0);
    // 첫 쓰기가 끝나기 전에도 칸은 열려 있다(`fieldset disabled` 면 포커스가 사라져 다음 칸을 못 고른다).
    expect(q<HTMLFieldSetElement>("phone-delay-choice")!.disabled).toBe(false);
    await choose(300);
    // 둘째는 첫째가 끝나기 전에는 나가지 않는다. 화면은 이미 마지막으로 고른 값이다.
    expect(savePhoneDelay).toHaveBeenCalledTimes(1);
    expect(savePhoneDelay).toHaveBeenLastCalledWith(WS, 0);
    await vi.waitFor(() => expect(radio(300).checked).toBe(true));
    await act(async () => first.resolve(0));
    await vi.waitFor(() => expect(savePhoneDelay).toHaveBeenCalledTimes(2));
    expect(savePhoneDelay).toHaveBeenLastCalledWith(WS, 300);
    // 첫 쓰기의 답(끔)이 와도 화면은 마지막으로 고른 5분에서 되돌아가지 않는다.
    await flush();
    expect(radio(300).checked).toBe(true);
    expect(radio(0).checked).toBe(false);
    await act(async () => second.resolve(300));
    await flush();
    expect(radio(300).checked).toBe(true);
    expect(q("phone-delay-save-error")).toBeNull();
  });

  it("앞 쓰기가 실패해도 마지막 쓰기가 성공하면 마지막 값이 남고 실패 줄은 없다", async () => {
    const first = deferred<PhoneDelaySecs>();
    const second = deferred<PhoneDelaySecs>();
    savePhoneDelay.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount();
    await settled();
    await choose(0);
    await choose(300);
    await act(async () => first.reject(new ApiError(500, "boom")));
    await vi.waitFor(() => expect(savePhoneDelay).toHaveBeenCalledTimes(2));
    await flush();
    // 앞 쓰기의 실패가 화면을 서버의 옛 값(1분)으로 되돌리지 않는다.
    expect(radio(300).checked).toBe(true);
    await act(async () => second.resolve(300));
    await flush();
    expect(radio(300).checked).toBe(true);
    expect(q("phone-delay-save-error")).toBeNull();
  });

  it("옛 서버(404·405)면 칸을 그리지 않는다. 403(열 수 없는 계정)도 같다", async () => {
    for (const status of [404, 405, 403]) {
      fetchPhoneDelay.mockRejectedValue(new ApiError(status, "no such route"));
      await mount();
      await settled();
      expect(q("phone-delay-row")).toBeNull();
      expect(q("phone-delay-choice")).toBeNull();
      expect(q("phone-delay-error")).toBeNull();
      expect(q("phone-delay-loading")).toBeNull();
      expect(host?.textContent).toBe("");
      act(() => root?.unmount());
      root = null;
      host?.remove();
      host = null;
    }
  });

  it("읽기가 실패하면(5xx·네트워크) 숨기지 않고 이유와 다시 시도를 보인다", async () => {
    fetchPhoneDelay.mockRejectedValueOnce(new ApiError(500, "boom"));
    await mount();
    await vi.waitFor(() => expect(q("phone-delay-error")).not.toBeNull());
    expect(q("phone-delay-row")).toBeNull();
    const error = q("phone-delay-error")!;
    expect(error.textContent).toContain("불러오지 못했어요");
    const retry = [...error.querySelectorAll("button")].find((b) => b.textContent === "다시 시도")!;
    await act(async () => {
      retry.click();
    });
    await vi.waitFor(() => expect(q("phone-delay-error")).toBeNull());
    expect(fetchPhoneDelay).toHaveBeenCalledTimes(2);
    expect(radio(60).checked).toBe(true);
  });

  it("불러오는 동안은 칸 대신 막대 한 줄이다", async () => {
    fetchPhoneDelay.mockReturnValue(new Promise(() => undefined));
    await mount();
    expect(q("phone-delay-loading")).not.toBeNull();
    expect(q("phone-delay-choice")).toBeNull();
  });

  it("오프라인이면 잠기고, 잠긴 이유 문장을 aria-describedby 로 가리킨다", async () => {
    await mount(true);
    await settled();
    const group = q<HTMLFieldSetElement>("phone-delay-choice")!;
    expect(group.disabled).toBe(true);
    expect(group.getAttribute("aria-describedby")?.split(" ")).toContain("offline-reason");
    await act(async () => {
      radio(300).click();
    });
    expect(savePhoneDelay).not.toHaveBeenCalled();
  });
});
