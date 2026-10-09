// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { forgetUsage } from "@momo/core/features/settings/usageModel";
import { forgetQuota } from "@momo/core/features/settings/quotaModel";
import { UsageSection } from "./UsageSection";
import usageFixtures from "./usageFixtures.json";
import quotaFixtures from "./quotaFixtures.json";

const WS = "00000000-0000-7000-8000-000000000001";

const fetchUsageSummary = vi.hoisted(() => vi.fn());
const fetchProviderQuotaSnapshots = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchUsageSummary: (...args: unknown[]) => fetchUsageSummary(...args) as Promise<unknown>,
    fetchProviderQuotaSnapshots: (...args: unknown[]) =>
      fetchProviderQuotaSnapshots(...args) as Promise<unknown>,
  };
});

// 명부는 이 시험의 관심이 아니다(에이전트별 이름 해석은 usageModel.test가 잰다). 캐시 읽기를 빈 명부로 막는다.
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return { ...actual, useDirectory: () => ({ directory: makeDirectory([]) }) };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

/** 쿼터 고정 응답은 절대 시각을 담는다. 오늘로 밀어야 「오늘 22:00 리셋」 같은 상대 문구가 유지된다. */
function anchored(fixture: (typeof quotaFixtures)["healthy"]) {
  const shift = Date.now() - Date.parse(quotaFixtures._anchor);
  const move = (iso: string | null) =>
    iso && !Number.isNaN(Date.parse(iso)) ? new Date(Date.parse(iso) + shift).toISOString() : iso;
  return {
    ...fixture,
    observedAt: move(fixture.observedAt),
    snapshots: fixture.snapshots.map((row) => ({
      ...row,
      resetsAt: move(row.resetsAt),
      probedAt: move(row.probedAt),
      ingestedAt: move(row.ingestedAt),
    })),
  };
}

beforeEach(() => {
  fetchUsageSummary.mockReset();
  fetchProviderQuotaSnapshots.mockReset();
  fetchUsageSummary.mockResolvedValue(usageFixtures.normal);
  fetchProviderQuotaSnapshots.mockResolvedValue(anchored(quotaFixtures.healthy));
  forgetUsage();
  forgetQuota();
  onlineManager.setOnline(true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  onlineManager.setOnline(true);
});

async function render(waitFor: string | null = "usage-body"): Promise<HTMLElement> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(UsageSection, { workspaceId: WS }))
    )
  );
  if (waitFor) {
    await vi.waitFor(() => {
      expect(host?.querySelector(`[data-testid="${waitFor}"]`)).not.toBeNull();
    });
  }
  return host;
}

const byId = (h: HTMLElement, id: string) => h.querySelector(`[data-testid="${id}"]`);
const h2s = (h: HTMLElement) => [...h.querySelectorAll("h2")].map((n) => n.textContent);
/** 카드 안에 또 하나의 테두리 상자(옛 `rounded-md border` 껍질)가 있는가. 상태 알약(`StatusChip`, inline-flex)은 상자가 아니다. */
const innerBoxes = (h: HTMLElement) =>
  [...h.querySelectorAll("*")].filter(
    (el) =>
      el.classList.contains("border") &&
      !el.classList.contains("inline-flex") &&
      (el.classList.contains("rounded-md") || el.classList.contains("rounded-sm"))
  );

describe("설정 › 사용량 (카드 문법, #3578 S5c)", () => {
  it("정상 응답은 카드 여섯 장을 순서대로 세우고, 카드 안에 상자를 한 겹 더 두르지 않는다", async () => {
    const h = await render();
    await vi.waitFor(() => expect(byId(h, "usage-quota-provider")).not.toBeNull());
    expect(h2s(h)).toEqual(["구독 잔여량", "비용 집계", "합계", "예산", "모델별", "에이전트별"]);
    expect(byId(h, "usage-total-cost")?.textContent).toContain("$18.43");
    expect(byId(h, "usage-estimated")).not.toBeNull();
    expect(innerBoxes(h).map((el) => el.getAttribute("data-testid") ?? el.tagName)).toEqual([]);
  });

  it("제공자 이름은 카드 제목(h2) 아래 h3 이다", async () => {
    const h = await render();
    await vi.waitFor(() => expect(byId(h, "usage-quota-provider")).not.toBeNull());
    const provider = byId(h, "usage-quota-provider");
    expect(provider?.querySelector("h3")).not.toBeNull();
    expect(provider?.querySelector("h4")).toBeNull();
  });

  it("기간 단추는 같은 응답을 다시 읽는다: 7일을 고르면 다른 범위로 요청한다", async () => {
    const h = await render();
    const first = fetchUsageSummary.mock.calls.at(-1)?.[1] as { from: string; to: string };
    const seven = byId(h, "usage-period-7d") as HTMLInputElement;
    expect(seven.type).toBe("radio");
    act(() => seven.click());
    await vi.waitFor(() => expect(fetchUsageSummary.mock.calls.length).toBeGreaterThan(1));
    const last = fetchUsageSummary.mock.calls.at(-1)?.[1] as { from: string; to: string };
    const days = (q: { from: string; to: string }) =>
      Math.round((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000);
    expect(days(first)).toBe(30);
    expect(days(last)).toBe(7);
    expect((byId(h, "usage-period-30d") as HTMLInputElement).checked).toBe(false);
  });

  it("빈 기간은 한 줄과 행동 하나를 주고, 예산 카드는 그대로 둔다", async () => {
    fetchUsageSummary.mockResolvedValue(usageFixtures.emptyPeriod);
    const h = await render("usage-empty");
    expect(byId(h, "usage-empty")?.textContent).toContain("이 기간에 기록된 사용량이 없어요.");
    expect(h2s(h)).toContain("합계");
    expect(h2s(h)).toContain("예산");
    expect(byId(h, "usage-totals")).toBeNull();
  });

  it("예산 한도에 닿으면 상태가 data 속성과 글로 함께 말한다", async () => {
    fetchUsageSummary.mockResolvedValue(usageFixtures.budgetHardLimit);
    const h = await render();
    expect(byId(h, "usage-budget")?.getAttribute("data-budget-state")).toBe("hard_limit");
    expect(byId(h, "usage-budget")?.textContent).toContain("한도");
  });

  it("집계가 없는 서버(404)는 카드 안 배너로 말하고, 구독 잔여량 카드는 따로 산다", async () => {
    fetchUsageSummary.mockRejectedValue(new ApiError(404, "not found"));
    const h = await render("usage-error");
    expect(byId(h, "usage-error")?.textContent).toContain("아직 사용량 집계를 제공하지 않아요");
    expect(byId(h, "usage-error")?.querySelector("button")?.textContent).toBe("다시 시도");
    expect(byId(h, "operator-notice")).toBeNull();
    // 둘은 다른 계약이다: 잔여량 읽기는 성공했다.
    await vi.waitFor(() => expect(byId(h, "usage-quota-provider")).not.toBeNull());
  });

  it("잔여량이 404 여도 비용 집계는 그려진다", async () => {
    fetchProviderQuotaSnapshots.mockRejectedValue(new ApiError(404, "not found"));
    const h = await render();
    await vi.waitFor(() => expect(byId(h, "usage-quota-error")).not.toBeNull());
    expect(byId(h, "usage-total-cost")).not.toBeNull();
  });

  it("읽는 동안은 카드 모양의 뼈대를 그리고 aria-busy 가 켜진다", async () => {
    fetchUsageSummary.mockReturnValue(new Promise(() => {}));
    const h = await render("usage-skeleton");
    expect(byId(h, "usage-panel")?.getAttribute("aria-busy")).toBe("true");
    expect(byId(h, "usage-total-cost")).toBeNull();
    expect(byId(h, "usage-skeleton")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("오프라인이면 요청을 보내지 않고 이유를 말한다", async () => {
    onlineManager.setOnline(false);
    const h = await render("usage-error");
    expect(fetchUsageSummary).not.toHaveBeenCalled();
    expect(byId(h, "usage-error")?.textContent ?? "").not.toBe("");
    expect(byId(h, "usage-total-cost")).toBeNull();
  });

  it("실패해도 확인했던 값이 있으면 같은 카드들을 그대로 두고 배너로 알린다", async () => {
    const h = await render();
    fetchUsageSummary.mockRejectedValue(new ApiError(503, "down"));
    act(() => (byId(h, "usage-refresh") as HTMLButtonElement).click());
    await vi.waitFor(() => expect(byId(h, "usage-last-known")).not.toBeNull());
    expect(byId(h, "usage-last-known-banner")).not.toBeNull();
    expect(byId(h, "usage-total-cost")).not.toBeNull();
    expect(innerBoxes(h)).toEqual([]);
  });
});
