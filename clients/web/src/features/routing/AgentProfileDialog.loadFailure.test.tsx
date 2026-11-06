// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { AgentProfileDialog } from "./AgentProfileDialog";

// =============================================================================
// #5242: 에이전트 프로필 대화에서 프로필을 못 읽었을 때. 옛 「에이전트 프로필을 불러오지 못했습니다.」 배너는 원인 상자다:
// 제목 + 오류 객체의 원인을 따르는 이유 + 다시 시도(훅의 `refetch`). 가장자리 규칙은 `AgentProfileDialog.usage.test.tsx`가 잰다.
// =============================================================================

vi.mock("@momo/core/features/settings/agentUsage", async importOriginal => ({
  ...await importOriginal<typeof import("@momo/core/features/settings/agentUsage")>(),
  fetchAgentUsage: vi.fn(async () => ({
    range: { from: "2026-10-01T00:00:00Z", to: "2026-10-30T00:00:00Z", bucket: "day" },
    agents: [], totals: { mine: {}, shared: {} }, hiddenPersonalAgents: 0,
  })),
  saveSubscriptionFee: vi.fn(),
}));
vi.mock("@/app/session", () => ({ useSession: () => ({ workspaceId: "w", connStatus: "connected" }) }));
vi.mock("@/features/workspace/useWorkspace", async importOriginal => ({
  ...await importOriginal<typeof import("@/features/workspace/useWorkspace")>(),
  useDirectory: () => ({ directory: makeDirectory([
    { id: "a", displayName: "기록 도우미", handle: "scribe", kind: "agent", callableBy: "everyone" } as never,
  ]) }),
}));
const handle = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./useAgentProfile", async importOriginal => ({
  ...await importOriginal<typeof import("./useAgentProfile")>(),
  useAgentProfile: () => handle.current,
}));
vi.mock("./capability", async importOriginal => ({
  ...await importOriginal<typeof import("./capability")>(),
  useRoutingCapability: () => ({ support: "absent", table: null, reason: "서버가 표를 보내지 않았습니다.", recheck: () => {} }),
  useAllowedAgentModels: () => null,
  useAgentEditingCapability: () => ({ support: "ready", reason: null, recheck: () => {} }),
}));

let ko: AppLocale;
beforeAll(async () => { ko = await koreanLocale(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const refetch = vi.fn();
const base = {
  profile: null, missing: false, isPending: false, error: null, refetch,
  saving: false, failure: null, clearFailure: () => {}, replace: vi.fn(), save: vi.fn(),
};

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(createElement(LocaleProvider, {
    locale: ko,
    children: createElement(QueryClientProvider, { client }, createElement(AgentProfileDialog, { agentMemberId: "a", onOpenChange: () => {} })),
  }));
}

describe("에이전트 프로필 대화: 프로필 불러오기 실패 (#5242)", () => {
  // 지키는 것: 제목·이유가 오류 객체의 원인을 따라가고, 다시 시도가 훅의 refetch를 부른다.
  it.each([
    [new NetworkError("unreachable", 15_000), "serverUnreachable", "서버에 닿지 못했어요."],
    [new ApiError(500, "boom", "internal"), "", "문제가 생겼어요."],
  ])("%# 읽지 못하면 원인 상자가 서고 다시 시도가 다시 읽는다", async (error, cause, reason) => {
    vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(true);
    refetch.mockClear();
    handle.current = { ...base, error };
    open();
    const box = await screen.findByTestId("agent-profile-error");
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.getAttribute("data-cause") ?? "").toBe(cause);
    expect(box.textContent).toContain("에이전트 프로필을 불러오지 못했어요");
    expect(box.querySelector('[data-testid="load-failure-reason"]')?.textContent).toBe(reason);
    expect(document.body.textContent).not.toContain("에이전트 프로필을 불러오지 못했습니다");
    fireEvent.click(box.querySelector("button") as HTMLElement);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
