// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryReceipt } from "@momo/core/features/memory/model";
import {
  INSPECTOR_NOTHING_READABLE,
  INSPECTOR_TITLE,
  WITHHELD_EXPLAIN_COPY,
} from "@momo/core/features/memory/presentation";
import { MemoryReceiptChip } from "./MemoryReceiptChip";
import { CH, ITEM, RUN, WS, byTestId, click, digest, flush, mount, unmount } from "./memoryTestKit";

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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const SERVED_ITEM = {
  id: ITEM,
  channelId: CH,
  kind: "decision" as const,
  origin: "confirmed" as const,
  body: "결제 재시도 큐는 두 배로 늘려서 운영하기로 했어요.",
  validFromMs: Date.parse("2026-09-03T10:00:00+09:00"),
  sourceCount: 2,
};

function receipt(over: Partial<MemoryReceipt> = {}): MemoryReceipt {
  return {
    runId: RUN,
    channelId: CH,
    servedCount: 2,
    digestIds: [digest().id],
    digests: [digest({ model: "claude-haiku-5" })],
    itemIds: [ITEM],
    items: [SERVED_ITEM],
    budgetChars: 6000,
    usedChars: 1234,
    createdAtMs: 1_800_000_000_000,
    ...over,
  };
}

async function openInspector(data: MemoryReceipt, onJump = vi.fn()) {
  getRunMemoryReceipt.mockResolvedValue(data);
  const view = mount(
    createElement(MemoryReceiptChip, { workspaceId: WS, runId: RUN, channelId: CH, onJump })
  );
  await flush();
  await flush();
  click(byTestId(view.host, "memory-receipt-chip"));
  await flush();
  click(document.body.querySelector('[data-testid="memory-receipt-inspect"]'));
  await flush();
  return { ...view, onJump };
}

const inspector = () =>
  document.body.querySelector<HTMLElement>('[data-testid="memory-inspector"]');
const within = (id: string) =>
  inspector()?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;

describe("서빙 인스펙터: 이 답에 쓰인 기억", () => {
  it("칩의 팝오버에서 열고, 실린 요약과 항목과 예산을 그대로 보여 준다", async () => {
    await openInspector(receipt());
    expect(inspector()?.textContent).toContain(INSPECTOR_TITLE);
    expect(within("memory-inspector-summary")?.textContent).toContain("기억 2개를 참고해서 답했어요");
    expect(within("memory-inspector-budget")?.textContent).toBe("기억 칸 1,234자 / 6,000자 사용");
    expect(within("memory-inspector-digest")?.textContent).toContain("재시도 큐를 늘려");
    expect(within("memory-inspector-digest")?.textContent).toContain("요약한 모델 claude-haiku-5");
    expect(within("memory-inspector-item")?.textContent).toContain("결정");
    expect(within("memory-inspector-item")?.textContent).toContain("사람이 확인했어요");
    expect(within("memory-inspector-item")?.textContent).toContain("9월 3일의 기억 · 근거 2개");
  });

  it("항목은 기억 브라우저의 그 항목으로 잇는다", async () => {
    await openInspector(receipt());
    expect(within("memory-inspector-item-link")?.getAttribute("href")).toBe(`/memory?item=${ITEM}`);
  });

  it("요약의 근거 링크는 같은 채널이면 그 자리로 점프하고 인스펙터를 닫는다", async () => {
    const { onJump } = await openInspector(receipt());
    click(within("memory-inspector-evidence-link"));
    await flush();
    expect(onJump).toHaveBeenCalledWith(digest().evidence[0]?.messageId, digest().evidence[0]?.seq);
    expect(inspector()?.getAttribute("data-state")).not.toBe("open");
  });

  it("보류 개수는 API가 준 값이 0보다 클 때만 그리고 내용은 없다", async () => {
    await openInspector(receipt({ withheldCount: 3 }));
    expect(within("memory-inspector-withheld")?.textContent).toContain("이 채널이라 싣지 않은 기억 3개");
    expect(within("memory-inspector-withheld")?.textContent).toContain(WITHHELD_EXPLAIN_COPY);
  });

  it("보류 필드가 없거나 0이면 아무 줄도 그리지 않는다", async () => {
    await openInspector(receipt());
    expect(within("memory-inspector-withheld")).toBeNull();
    unmount();
    document.body.innerHTML = "";
    await openInspector(receipt({ withheldCount: 0 }));
    expect(within("memory-inspector-withheld")).toBeNull();
    expect(inspector()?.textContent).not.toContain("싣지 않은");
  });

  it("열어 볼 수 있는 기억이 하나도 없으면 그렇다고만 말하고 개수를 맞춘다", async () => {
    await openInspector(
      receipt({ servedCount: 2, digestIds: [], digests: [], itemIds: [], items: [] })
    );
    expect(within("memory-inspector-nothing")?.textContent).toBe(INSPECTOR_NOTHING_READABLE);
    expect(within("memory-inspector-unlisted")?.textContent).toBe("열어 볼 수 없는 기억 2개");
    expect(within("memory-inspector-digests")).toBeNull();
    expect(within("memory-inspector-items")).toBeNull();
  });

  it("항목 필드가 없는 옛 서버의 영수증도 요약만으로 그린다", async () => {
    const data = receipt({ servedCount: 1 });
    delete data.items;
    delete data.itemIds;
    await openInspector(data);
    expect(within("memory-inspector-digests")).not.toBeNull();
    expect(within("memory-inspector-items")).toBeNull();
    expect(within("memory-inspector-unlisted")).toBeNull();
  });

  it("서버가 준 것보다 많이 그리지 않는다: 일부만 열 수 있으면 나머지는 개수로만 말한다", async () => {
    await openInspector(receipt({ servedCount: 4 }));
    expect(within("memory-inspector-unlisted")?.textContent).toBe("열어 볼 수 없는 기억 2개");
    expect(inspector()?.querySelectorAll('[data-testid="memory-inspector-item"]')).toHaveLength(1);
  });

  it("팝오버 목록에도 실린 항목이 나온다", async () => {
    getRunMemoryReceipt.mockResolvedValue(receipt());
    const view = mount(createElement(MemoryReceiptChip, { workspaceId: WS, runId: RUN, channelId: CH }));
    await flush();
    await flush();
    click(byTestId(view.host, "memory-receipt-chip"));
    await flush();
    const popover = document.body.querySelector('[data-testid="memory-receipt-popover"]');
    expect(popover?.querySelectorAll('[data-testid="memory-receipt-item"]')).toHaveLength(1);
  });

  it("닫기로 닫는다", async () => {
    await openInspector(receipt());
    click(within("memory-inspector-close"));
    await flush();
    expect(inspector()?.getAttribute("data-state")).not.toBe("open");
  });
});
