// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { MemoryReceipt } from "@momo/core/features/memory/model";
import { RECEIPT_ONLY_READABLE, WITHHELD_EXPLAIN_COPY } from "@momo/core/features/memory/presentation";
import { MemoryReceiptChip } from "./MemoryReceiptChip";
import { CH, RUN, WS, byTestId, click, digest, flush, mount, unmount } from "./memoryTestKit";

const getRunMemoryReceipt = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/memory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/memory/api")>();
  return {
    ...actual,
    getRunMemoryReceipt: (...args: unknown[]) => getRunMemoryReceipt(...args) as unknown,
  };
});

beforeEach(() => {
  getRunMemoryReceipt.mockReset();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function receipt(over: Partial<MemoryReceipt> = {}): MemoryReceipt {
  return {
    runId: RUN,
    channelId: CH,
    servedCount: 1,
    digestIds: [digest().id],
    digests: [digest()],
    budgetChars: 6000,
    usedChars: 900,
    createdAtMs: 1_800_000_000_000,
    ...over,
  };
}

async function render(onJump = vi.fn()) {
  const view = mount(
    createElement(MemoryReceiptChip, { workspaceId: WS, runId: RUN, channelId: CH, onJump })
  );
  await flush();
  await flush();
  return { ...view, onJump };
}

function popover(): HTMLElement | null {
  return document.body.querySelector('[data-testid="memory-receipt-popover"]');
}

describe("기억 n개 참고 칩", () => {
  it("실린 게 없으면 칩을 그리지 않는다", async () => {
    getRunMemoryReceipt.mockResolvedValue(receipt({ servedCount: 0, digestIds: [], digests: [] }));
    const { host } = await render();
    expect(byTestId(host, "memory-receipt-chip")).toBeNull();
  });

  it("영수증이 없거나(404) 요청이 실패해도 칩을 그리지 않는다", async () => {
    for (const status of [404, 500]) {
      unmount();
      getRunMemoryReceipt.mockRejectedValue(new ApiError(status, "x"));
      const { host } = await render();
      expect(byTestId(host, "memory-receipt-chip")).toBeNull();
    }
  });

  it("서버가 알려 준 개수로 라벨을 짓는다", async () => {
    getRunMemoryReceipt.mockResolvedValue(receipt({ servedCount: 3 }));
    const { host } = await render();
    expect(byTestId(host, "memory-receipt-chip")?.textContent).toContain("기억 3개 참고");
    expect(getRunMemoryReceipt).toHaveBeenCalledWith(WS, RUN);
  });

  it("누르면 참고한 요약과 근거 링크를 팝오버로 보여 주고, 링크는 점프한다", async () => {
    getRunMemoryReceipt.mockResolvedValue(receipt());
    const { host, onJump } = await render();
    click(byTestId(host, "memory-receipt-chip"));
    await flush();
    const pop = popover();
    expect(pop).not.toBeNull();
    expect(pop?.textContent).toContain("결제 오류는 재시도 큐를 늘려 해결하기로 했어요.");
    const links = pop?.querySelectorAll('[data-testid="memory-receipt-evidence-link"]');
    expect(links).toHaveLength(2);
    click(links![0]);
    expect(onJump).toHaveBeenCalledWith("00000000-0000-7000-8000-000000000301", 14);
    await flush();
    expect(popover()).toBeNull();
  });

  it("withheldCount가 응답에 없으면 보류 문장을 그리지 않는다", async () => {
    getRunMemoryReceipt.mockResolvedValue(receipt());
    const { host } = await render();
    click(byTestId(host, "memory-receipt-chip"));
    await flush();
    expect(byTestId(document.body, "memory-receipt-withheld")).toBeNull();
    expect(popover()?.textContent).not.toContain("싣지 않은");
  });

  it("withheldCount가 0이어도 보류 문장을 그리지 않는다", async () => {
    getRunMemoryReceipt.mockResolvedValue(receipt({ withheldCount: 0 }));
    const { host } = await render();
    click(byTestId(host, "memory-receipt-chip"));
    await flush();
    expect(byTestId(document.body, "memory-receipt-withheld")).toBeNull();
  });

  it("withheldCount가 있으면 내용 없이 개수와 이유만 말한다", async () => {
    getRunMemoryReceipt.mockResolvedValue(receipt({ withheldCount: 3 }));
    const { host } = await render();
    click(byTestId(host, "memory-receipt-chip"));
    await flush();
    const withheld = byTestId(document.body, "memory-receipt-withheld");
    expect(withheld?.textContent).toContain("이 채널이라 싣지 않은 기억 3개");
    expect(withheld?.textContent).toContain(WITHHELD_EXPLAIN_COPY);
  });

  it("목록에는 볼 수 있는 기억만 나온다고 항상 알린다", async () => {
    getRunMemoryReceipt.mockResolvedValue(receipt({ servedCount: 4 }));
    const { host } = await render();
    click(byTestId(host, "memory-receipt-chip"));
    await flush();
    expect(byTestId(document.body, "memory-receipt-only-readable")?.textContent).toBe(
      RECEIPT_ONLY_READABLE
    );
  });

  it("영수증은 한 번만 받는다(같은 run은 캐시)", async () => {
    getRunMemoryReceipt.mockResolvedValue(receipt());
    const { client } = await render();
    await flush();
    expect(getRunMemoryReceipt).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(["memory", "receipt", WS, RUN])?.status).toBe("success");
  });
});
