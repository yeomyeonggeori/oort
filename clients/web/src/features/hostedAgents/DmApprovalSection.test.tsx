// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  getHostedDmApprovals,
  setHostedDmApproval,
} from "@momo/core/features/hostedAgents/api";
import { makeDirectory } from "@/features/workspace/useWorkspace";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { DmApprovalSection } from "./DmApprovalSection";

// =============================================================================
// #2915: 소유자 대화는 버튼 없이 「항상 열림」, 타인 대화는 소유자만 열고 닫는다,
// 소유자가 아니면 목록만 읽는다. 여는 것은 한 번 더 묻는다.
// =============================================================================

vi.mock("@momo/core/features/hostedAgents/api", () => ({
  getHostedDmApprovals: vi.fn(),
  setHostedDmApproval: vi.fn(),
}));

const WS = "00000000-0000-7000-8000-000000000001";
const CONNECTION = "019f9a01-0000-7000-8000-0000000005c1";
const AGENT = "019f9a01-0000-7000-8000-000000000404";
const OWNER = "00000000-0000-7000-8000-000000000101";
const MEMBER = "00000000-0000-7000-8000-000000000102";

function human(id: string, displayName: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName,
    handle: displayName,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const directory = makeDirectory([human(OWNER, "성재"), human(MEMBER, "민지")]);

function wire(canEdit: boolean, memberState = "unapproved") {
  return {
    connectionId: CONNECTION,
    agentMemberId: AGENT,
    ownerMemberId: OWNER,
    canEdit,
    ownerOnly: false,
    dms: [
      { channelId: "dm-owner", counterpartMemberId: OWNER, state: "owner" },
      { channelId: "dm-member", counterpartMemberId: MEMBER, state: memberState },
    ],
  };
}

let root: Root;
let host: HTMLDivElement;

let ko: AppLocale;
beforeAll(async () => {
  ko = await koreanLocale();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(getHostedDmApprovals).mockReset();
  vi.mocked(setHostedDmApproval).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** `korean`은 사전 문장을 단정하는 시험만 켠다(공급자가 없으면 번들된 영어로 물러난다). */
async function render(korean = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = createElement(
    QueryClientProvider,
    { client },
    createElement(DmApprovalSection, {
      workspaceId: WS,
      connectionId: CONNECTION,
      agentLabel: "Claude Code",
      directory,
      offline: false,
      writesLocked: false,
    })
  );
  await act(async () => {
    root.render(korean ? createElement(LocaleProvider, { locale: ko, children: page }) : page);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function rows() {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="hosted-dm-approval-row"]')];
}

describe("DmApprovalSection", () => {
  // #5242: 옛 「1:1 대화 목록을 불러오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.」는 원인을 말하는 한 줄이다.
  it("목록을 못 읽으면 제목 뒤에 원인이 붙은 한 줄이 서고, 다시 시도가 목록을 다시 읽는다", async () => {
    const cases: [Error, string][] = [
      [new NetworkError("unreachable", 15_000), "1:1 대화 목록을 불러오지 못했어요. 서버에 닿지 못했어요."],
      [new ApiError(500, "boom", "internal"), "1:1 대화 목록을 불러오지 못했어요. 문제가 생겼어요."],
    ];
    for (const [error, sentence] of cases) {
      vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(true);
      vi.mocked(getHostedDmApprovals).mockReset();
      vi.mocked(getHostedDmApprovals).mockRejectedValue(error);
      await render(true);
      const note = host.querySelector<HTMLElement>('[data-testid="hosted-dm-approval-error"]');
      expect(note, sentence).not.toBeNull();
      expect(note?.getAttribute("role")).toBe("alert");
      expect(note?.textContent).toContain(sentence);
      expect(note?.textContent).not.toMatch(/\d{3}/);
      const reads = vi.mocked(getHostedDmApprovals).mock.calls.length;
      await act(async () => {
        note?.querySelector("button")?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(vi.mocked(getHostedDmApprovals).mock.calls.length).toBeGreaterThan(reads);
      act(() => root.unmount());
      root = createRoot(host);
      vi.restoreAllMocks();
    }
  });

  it("draws the owner's DM as always open with no control, and lets the owner open another", async () => {
    vi.mocked(getHostedDmApprovals)
      .mockResolvedValueOnce(wire(true))
      .mockResolvedValue(wire(true, "approved"));
    vi.mocked(setHostedDmApproval).mockResolvedValue({
      connectionId: CONNECTION,
      changed: true,
      dm: { channelId: "dm-member", counterpartMemberId: MEMBER, state: "approved" },
    });
    await render();
    const [ownerRow, memberRow] = rows();
    expect(ownerRow.textContent).toContain("성재님과의 대화");
    expect(ownerRow.textContent).toContain("항상 열림");
    expect(ownerRow.querySelector("button")).toBeNull();
    expect(memberRow.textContent).toContain("닫힘");

    const open = memberRow.querySelector<HTMLButtonElement>(
      '[data-testid="hosted-dm-approval-toggle"]'
    )!;
    expect(open.textContent).toBe("대화 열기");
    await act(async () => open.click());
    // One click only asks. Nothing is written until the question is answered.
    expect(setHostedDmApproval).not.toHaveBeenCalled();
    const question = host.querySelector('[data-testid="hosted-dm-approval-toggle-question"]')!;
    expect(question.textContent).toContain("민지님과의 대화 내용을 이 에이전트가 읽고 답하게 할까요?");
    const confirm = [...question.querySelectorAll("button")].find(
      (button) => button.textContent === "열기"
    )!;
    await act(async () => confirm.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(setHostedDmApproval).toHaveBeenCalledWith(WS, CONNECTION, "dm-member", true);
    expect(rows()[1].dataset.state).toBe("approved");
  });

  it("is read-only for someone who is not the owner", async () => {
    vi.mocked(getHostedDmApprovals).mockResolvedValue(wire(false, "approved"));
    await render();
    expect(host.querySelector('[data-testid="hosted-dm-approval-toggle"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="hosted-dm-approval-readonly"]')?.textContent
    ).toBe("성재님(소유자)만 바꿀 수 있어요.");
    expect(rows()[1].textContent).toContain("열림");
  });

  it("says a non-owner's confirm closed every DM, not that only the owner may edit", async () => {
    vi.mocked(getHostedDmApprovals).mockResolvedValue({
      ...wire(false, "not_approvable"),
      confirmedByNonOwner: true,
      dms: [
        { channelId: "dm-owner", counterpartMemberId: OWNER, state: "not_approvable" },
        { channelId: "dm-member", counterpartMemberId: MEMBER, state: "not_approvable" },
      ],
    });
    await render();
    expect(
      host.querySelector('[data-testid="hosted-dm-approval-readonly"]')?.textContent
    ).toContain("소유자가 아닌 멤버가 이 연결을 확인해서");
    expect(host.textContent).not.toContain("항상 열림");
  });

  it("says why a write was refused, next to the row", async () => {
    vi.mocked(getHostedDmApprovals).mockResolvedValue(wire(true));
    const { ApiError } = await import("@momo/core/lib/api");
    vi.mocked(setHostedDmApproval).mockRejectedValue(new ApiError(409, "conflict"));
    await render();
    const open = rows()[1].querySelector<HTMLButtonElement>(
      '[data-testid="hosted-dm-approval-toggle"]'
    )!;
    await act(async () => open.click());
    const confirm = [
      ...host
        .querySelector('[data-testid="hosted-dm-approval-toggle-question"]')!
        .querySelectorAll("button"),
    ].find((button) => button.textContent === "열기")!;
    await act(async () => confirm.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      rows()[1].querySelector('[data-testid="hosted-dm-approval-failure"]')?.textContent
    ).toContain("이 대화는 지금 바꿀 수 없어요.");
  });
});
