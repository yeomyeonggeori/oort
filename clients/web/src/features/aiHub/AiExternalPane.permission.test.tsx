// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { listEventSubscriptions } from "@momo/core/features/settings/eventSubscriptions";
import { SectionHeadingContext, SectionShell } from "@/features/settings/SettingsFields";
import { EventSubscriptionSection } from "@/features/settings/EventSubscriptionSection";

// AIH-8 (#3438): 편집 권한은 현행 OperatorNotice 규칙 그대로다(소유자·관리자 편집, 그 밖은 읽기).
// 허브가 제목을 들고 본문을 품어도 403 안내는 남고, 옛 제목 h2는 겹쳐 서지 않는다.

vi.mock("@momo/core/features/settings/eventSubscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/eventSubscriptions")>();
  return { ...actual, listEventSubscriptions: vi.fn() };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(heading: boolean): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(
            SectionHeadingContext.Provider,
            { value: heading },
            createElement(EventSubscriptionSection, { workspaceId: "w1", offline: false })
          )
        )
      )
    )
  );
  return host;
}

describe("외부 연결 본문의 권한 (AIH-8)", () => {
  it("운영자가 아니면(403) 허브 안에서도 읽기 안내가 서고 편집 폼은 없다", async () => {
    vi.mocked(listEventSubscriptions).mockRejectedValue(new ApiError(403, "forbidden"));
    const el = mount(false);
    await waitFor(() => expect(el.querySelector('[data-testid="operator-notice"]')).not.toBeNull());
    expect(el.querySelector('[data-testid="operator-notice"]')?.textContent).toContain("밖으로 보내는 알림은");
    expect(el.querySelector("h2")).toBeNull();
    expect(el.querySelector("form, input")).toBeNull();
  });

  it("허브가 아닌 곳(기본)에서는 본문이 옛 제목을 그대로 그린다", async () => {
    vi.mocked(listEventSubscriptions).mockRejectedValue(new ApiError(403, "forbidden"));
    const el = mount(true);
    await waitFor(() => expect(el.querySelector('[data-testid="operator-notice"]')).not.toBeNull());
    expect(el.querySelector("h2")?.textContent).toBe("이벤트 구독");
  });

  it("SectionShell 은 접힌 머리에서 제목과 설명을 함께 접는다", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        createElement(
          SectionHeadingContext.Provider,
          { value: false },
          createElement(SectionShell, { title: "제목", lines: ["설명"], children: createElement("p", null, "본문") })
        )
      )
    );
    expect(host.textContent).toBe("본문");
  });
});
