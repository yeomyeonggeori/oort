// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { TOOLTIP_DELAY_MS } from "@/design/motion";
import { AttachmentDownloadButton } from "@/features/attachments/AttachmentDownloadButton";
import { AttachmentOpenPdfButton } from "@/features/attachments/AttachmentOpenPdfButton";
import { ReactionChips } from "./ReactionChips";

/**
 * 대화 줄 안 세 단추의 툴팁 방향 (#5980 버그 회귀): 「다른 반응 고르기」 · 파일 카드 내려받기 · PDF 열기.
 * 단추 윗변이 스크롤 칸 윗변에서 알약 + 틈(34)보다 가까우면 아래, 아니면 위(맨 아래 글 포함 — #5965가 위로 돌린 것을 지킨다).
 * jsdom 에는 레이아웃이 없어 칸과 단추의 상자를 정해 둔다. 실제로 잘리지 않는다는 것은 브라우저 측정이 증거다(인계 `worker-5980-handoff.md`).
 */

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
beforeAll(() => { env.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { delete env.IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const PDF = { id: "0199eeee-0000-7000-8000-0000000000p1", name: "분기-보고서.pdf", mime: "application/pdf", sizeBytes: 182_000 };
const SCROLLER_TOP = 100;

const BUTTONS: ReadonlyArray<[string, ReactElement]> = [
  ["reaction-add", createElement(ReactionChips, { chips: [{ emoji: "👍", count: 1, mine: false, memberIds: [] }], directory: makeDirectory([]), myMemberId: undefined, onToggle: () => undefined, onOpenPicker: () => undefined })],
  ["attachment-download", createElement(AttachmentDownloadButton, { workspaceId: WS, channelId: CH, attachment: PDF, joinsMessageRow: true, tooltipSide: "row" })],
  ["attachment-open-pdf", createElement(AttachmentOpenPdfButton, { workspaceId: WS, channelId: CH, attachment: PDF })],
];

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 32, width: 32, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

/** 줄의 스크롤 칸(`timeline-virtuoso`) 안에 단추를 세우고, 단추 윗변이 칸 윗변에서 `gap` 떨어진 상자를 준다. */
function mount(node: ReactElement, testId: string, gap: number): HTMLElement {
  const scroller = document.createElement("div");
  scroller.setAttribute("data-testid", "timeline-virtuoso");
  scroller.getBoundingClientRect = () => rect(SCROLLER_TOP, 600);
  document.body.append(scroller);
  root = createRoot(scroller);
  act(() => root?.render(node));
  const button = scroller.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  button.getBoundingClientRect = () => rect(SCROLLER_TOP + gap, 32);
  return button;
}

function hover(el: Element) {
  const event = new MouseEvent("pointerover", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  act(() => { el.dispatchEvent(event); });
  act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
}

const sideOf = () => document.querySelector<HTMLElement>('[data-testid="tooltip"]')?.dataset.side;

describe("대화 줄 안 세 단추의 툴팁은 단추 자리로 위·아래를 가른다", () => {
  for (const [testId, node] of BUTTONS) {
    it.each([
      [0, "bottom"],
      [16, "bottom"],
      [33, "bottom"],
      [34, "top"],
      [400, "top"],
    ])(`${testId}: 칸 윗변에서 %ipx → %s`, (gap, side) => {
      vi.useFakeTimers();
      const button = mount(node, testId, gap);
      hover(button);
      expect(sideOf()).toBe(side);
    });
  }

  it("키보드 초점으로 열 때도 같은 판정이다", () => {
    const button = mount(BUTTONS[0]![1], "reaction-add", 12);
    button.matches = (selector: string) => selector === ":focus-visible" || Element.prototype.matches.call(button, selector);
    act(() => { button.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    expect(sideOf()).toBe("bottom");
  });
});
