// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecheckWhenElapsed } from "./useRecheckWhenElapsed";

// =============================================================================
// #2899 design-review H3 — 기한이 지나면 자기 화면이 서버에 다시 묻는다.
//
// 서버는 만료 시각에 이벤트를 보내지 않고, 질의 클라이언트는 30초 동안 신선하다고 믿으며 포커스
// 재조회도 꺼져 있다. 이 훅이 없으면 기한이 지난 뒤에도 아바타·프로필 메뉴·설정 스위치가 낡은 값을
// 말한다. 이 훅은 화면을 스스로 풀지 않고 **다시 읽을 뿐**이다.
//
// 시계와 타이머를 가짜로 쓴다(약속은 진짜다).
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 9, day, hour, minute, second, 0).getTime();
const NOW = at(16, 21, 7);

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let client: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;

function Probe({ untilMs }: { untilMs: number | undefined }) {
  useRecheckWhenElapsed(WS, untilMs);
  return null;
}

function mount(untilMs: number | undefined) {
  client = new QueryClient();
  invalidate = vi.spyOn(client, "invalidateQueries");
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const render = (next: number | undefined) =>
    act(() => {
      mountedRoot?.render(
        createElement(QueryClientProvider, { client }, createElement(Probe, { untilMs: next }))
      );
    });
  render(untilMs);
  return { render };
}

const askedKeys = () =>
  invalidate.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));
const ROSTER = JSON.stringify(["roster", WS]);
const RULES = JSON.stringify(["settings", "notification-rules", WS]);

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.useRealTimers();
});

describe("useRecheckWhenElapsed (#2899 H3)", () => {
  it("이미 지난 기한이면 마운트하자마자 규칙과 명부를 다시 묻는다", () => {
    mount(at(16, 21, 0));
    expect(askedKeys()).toContain(RULES);
    expect(askedKeys()).toContain(ROSTER);
  });

  it("아직 오지 않은 기한이면 묻지 않고, 기한이 오는 순간에 한 번 깨어 묻는다", () => {
    mount(at(16, 21, 7, 53)); // 53초 뒤 — 분 틱(60초)보다 이르다
    expect(invalidate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(52_000);
    });
    expect(invalidate).not.toHaveBeenCalled();
    // 기한(+여유 0.5초) 직후: 분 틱(60초)을 기다리지 않는다.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(askedKeys()).toContain(RULES);
    expect(askedKeys()).toContain(ROSTER);
  });

  it("지난 뒤에도 서버가 켜져 있다고 답하는 동안은 분 틱마다 다시 묻는다", () => {
    mount(at(16, 21, 0));
    invalidate.mockClear();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(askedKeys()).toContain(RULES);
    expect(askedKeys()).toContain(ROSTER);
    invalidate.mockClear();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(askedKeys()).toContain(RULES);
  });

  it("기한이 없으면 아무것도 묻지 않고 타이머도 들지 않는다", () => {
    mount(undefined);
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("기한이 지워지면(서버의 새 답이 왔다) 더는 묻지 않는다", () => {
    const { render } = mount(at(16, 21, 0));
    invalidate.mockClear();
    render(undefined);
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
