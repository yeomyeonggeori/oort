// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { CreatedInvite, InviteCode } from "@momo/core/features/settings/api";
import { InviteSection } from "./InviteSection";

const WS = "00000000-0000-7000-8000-000000000001";
const NOW = Date.now();

const listInvites = vi.hoisted(() => vi.fn());
const createInvite = vi.hoisted(() => vi.fn());
const fetchWorkspace = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    listInvites: (...args: unknown[]) => listInvites(...args) as Promise<unknown>,
    createInvite: (...args: unknown[]) => createInvite(...args) as Promise<unknown>,
    fetchWorkspace: (...args: unknown[]) => fetchWorkspace(...args) as Promise<unknown>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

function invite(over: Partial<InviteCode> = {}): InviteCode {
  return {
    id: "00000000-0000-7000-8000-000000000901",
    workspaceId: WS,
    codePreview: "K7Q2XM",
    role: "member",
    maxUses: 5,
    usedCount: 2,
    expiresAtMs: NOW + 5 * 86_400_000,
    createdBy: "00000000-0000-7000-8000-000000000101",
    createdAtMs: NOW - 1000,
    updatedAtMs: NOW - 1000,
    ...over,
  };
}

beforeEach(() => {
  listInvites.mockReset();
  createInvite.mockReset();
  fetchWorkspace.mockReset();
  listInvites.mockResolvedValue([]);
  fetchWorkspace.mockResolvedValue({
    id: WS,
    slug: "dawn",
    name: "새벽팀",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled: false,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function render(offline = false, settle = true): Promise<HTMLElement> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(InviteSection, { workspaceId: WS, offline })
      )
    )
  );
  if (settle) {
    await vi.waitFor(() => {
      expect(host?.querySelector('[data-testid="skeleton"][data-ready="false"]')).toBeNull();
    });
  }
  return host;
}

const byId = (h: HTMLElement, id: string) => h.querySelector(`[data-testid="${id}"]`);

describe("설정 › 멤버와 초대", () => {
  it("발급한 링크가 없으면 빈 상태 문장과 만들기 폼이 함께 선다", async () => {
    const h = await render();
    expect(byId(h, "invite-empty")?.textContent).toContain("아직 발급한 초대 링크가 없어요.");
    expect(byId(h, "invite-list")).toBeNull();
    expect(byId(h, "invite-create-form")).not.toBeNull();
    expect([...h.querySelectorAll("h2")].map((n) => n.textContent)).toEqual([
      "발급한 초대 링크",
      "새 초대 링크",
    ]);
  });

  it("목록은 코드 끝, 상태, 역할, 사용 수를 한 줄로 보여 준다", async () => {
    listInvites.mockResolvedValue([
      invite(),
      invite({ id: "x2", codePreview: "ZZ19PA", usedCount: 5 }),
    ]);
    const h = await render();
    const rows = h.querySelectorAll('[data-testid="invite-list"] li');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("K7Q2XM");
    expect(rows[0]?.textContent).toContain("사용 가능");
    expect(rows[0]?.textContent).toContain("2/5명 사용");
    expect(rows[1]?.textContent).toContain("모두 사용됨");
    expect(byId(h, "invite-empty")).toBeNull();
  });

  it("목록 403은 카드 안 운영자 안내이고 폼과 다시 시도 단추가 없다", async () => {
    listInvites.mockRejectedValue(new ApiError(403, "admin required"));
    const h = await render();
    expect(byId(h, "operator-notice")?.textContent).toContain("소유자나 관리자만 발급할 수 있어요");
    expect(byId(h, "invite-create-form")).toBeNull();
    expect(byId(h, "invite-error")).toBeNull();
  });

  it("목록 500은 다시 시도 단추를 주고 운영자 안내는 없다", async () => {
    listInvites.mockRejectedValue(new ApiError(500, "boom"));
    const h = await render();
    expect(h.querySelector('[data-testid="invite-error"] button')).not.toBeNull();
    expect(byId(h, "operator-notice")).toBeNull();
  });

  it("읽는 동안은 스켈레톤이고 만들기 폼이 아직 없다", async () => {
    listInvites.mockReturnValue(new Promise(() => undefined));
    const h = await render(false, false);
    expect(h.querySelector('[data-testid="skeleton"][data-ready="false"]')).not.toBeNull();
    expect(byId(h, "invite-create-form")).toBeNull();
  });

  it("오프라인이면 만들기가 잠기고 이유를 말하며 POST하지 않는다", async () => {
    const h = await render(true);
    const button = byId(h, "invite-create") as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe("invite-create-offline-note");
    expect(byId(h, "invite-create-offline")?.textContent).toContain("다시 연결되면 이어서 만들 수 있어요");
    await act(async () => {
      button.click();
    });
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("사용 횟수 칸은 1에서 10000까지만 받는다 (브라우저가 먼저 막는다)", async () => {
    const h = await render();
    const input = h.querySelector("#invite-max-uses") as HTMLInputElement;
    expect([input.min, input.max, input.type]).toEqual(["1", "10000", "number"]);
  });

  it("발급하면 역할·횟수·만료를 보내고 코드를 한 번만 보이는 카드가 선다", async () => {
    const created: CreatedInvite = { invite: invite({ codePreview: "AB12CD" }), code: "oort-AB12CD-secret-sample" };
    createInvite.mockResolvedValue(created);
    const h = await render();
    await act(async () => {
      (byId(h, "invite-create") as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(byId(h, "invite-issued")).not.toBeNull());
    expect(createInvite).toHaveBeenCalledTimes(1);
    const [ws, input] = createInvite.mock.calls[0] as [string, { role: string; maxUses: number; expiresAtMs: number }];
    expect(ws).toBe(WS);
    expect(input.role).toBe("member");
    expect(input.maxUses).toBe(1);
    expect(input.expiresAtMs).toBeGreaterThan(NOW + 6 * 86_400_000);
    expect(byId(h, "invite-issued-card")?.querySelector("h2")?.textContent).toBe("방금 만든 초대 링크");
    expect(byId(h, "invite-issued")?.textContent).toContain("oort-AB12CD-secret-sample");
    expect(byId(h, "invite-issued")?.className).not.toContain("border-ok");
  });

  it("발급 실패는 알림 문장으로 말하고 카드는 서지 않는다", async () => {
    createInvite.mockRejectedValue(new ApiError(500, "boom"));
    const h = await render();
    await act(async () => {
      (byId(h, "invite-create") as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(h.querySelector('[role="alert"]')).not.toBeNull());
    expect(byId(h, "invite-issued")).toBeNull();
  });
});
