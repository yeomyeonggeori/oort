// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { ROUTE_REGION_DOM_ID } from "@/app/shellNav";
import { closeAdeDrawer, openAdeDrawer } from "@/features/ade/adeDrawerStore";
import { RETURNED, rememberPanelOpener, returnFocusAfterWorkPanelClose } from "./workPanelFocus";

// =============================================================================
// 작업 패널을 닫을 때 캐럿을 돌려주는 순서와 이웃 (#5165). 실제 inert 거절은 브라우저만 한다(jsdom은 inert를 모른다):
// 여기서는 **순서**(inert를 걷은 뒤에 focus)를 `focus()` 호출 시점의 속성으로 잰다. 실제 거절과 폭 차이는
// `scripts/capture-5165.mjs`가 번들 Chromium으로 390·1280에서 잰다.
// =============================================================================

const RUN = "0199AA11-2222-7000-8000-0000000000B1";

function chipSlot(runId: string, messageId: string, withRowTabindex = false) {
  const row = document.createElement("article");
  row.setAttribute("data-testid", "timeline-message");
  row.setAttribute("data-message-id", messageId);
  if (withRowTabindex) row.setAttribute("tabindex", "-1");
  const slot = document.createElement("div");
  slot.setAttribute("data-testid", "request-thought-slot");
  slot.setAttribute("data-run-id", runId);
  const button = document.createElement("button");
  button.setAttribute("data-testid", "request-thought-line");
  slot.append(button);
  row.append(slot);
  return { row, button };
}

function shell() {
  const route = document.createElement("div");
  route.id = ROUTE_REGION_DOM_ID;
  route.setAttribute("tabindex", "-1");
  route.setAttribute("inert", "");
  document.body.append(route);
  return route;
}

afterEach(() => {
  closeAdeDrawer();
  document.body.innerHTML = "";
});

describe("작업 패널을 닫으면 캐럿이 연 요소로 돌아간다 (#5165)", () => {
  it("덮인 라우트의 inert를 먼저 걷고 나서 focus를 부른다 (순서가 폭 차이의 원인이다)", () => {
    const route = shell();
    const { row, button } = chipSlot(RUN, "m-1");
    route.append(row);
    let inertAtFocus: boolean | null = null;
    const nativeFocus = button.focus.bind(button);
    button.focus = (...args: Parameters<HTMLElement["focus"]>) => {
      inertAtFocus = route.hasAttribute("inert");
      nativeFocus(...args);
    };
    const memo = rememberPanelOpener(button, RUN);
    expect(returnFocusAfterWorkPanelClose(button, memo)).toBe(RETURNED.opener);
    expect(inertAtFocus).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it("연 요소가 사라졌으면 같은 run의 칩이, 그것도 없으면 같은 행이, 마지막으로 라우트 상자가 캐럿을 받는다", () => {
    const route = shell();
    const first = chipSlot(RUN, "m-1", true);
    route.append(first.row);
    const memo = rememberPanelOpener(first.button, RUN);
    // 실시간 갱신이 줄을 다시 그렸다: 옛 노드는 DOM에서 빠지고 같은 run의 새 칩이 선다(run id의 대소문자는 달라도 같은 run이다).
    first.row.remove();
    const second = chipSlot(RUN.toLowerCase(), "m-1", true);
    route.append(second.row);
    expect(returnFocusAfterWorkPanelClose(first.button, memo)).toBe(RETURNED.sameRun);
    expect(document.activeElement).toBe(second.button);

    // 칩은 없고 같은 메시지 행만 남았다(초점을 받게 만들어진 행이다).
    second.button.remove();
    second.row.querySelector('[data-testid="request-thought-slot"]')?.remove();
    expect(returnFocusAfterWorkPanelClose(first.button, memo)).toBe(RETURNED.sameRow);
    expect(document.activeElement).toBe(second.row);

    // 행도 없다: 라우트 상자가 받는다. 어떤 경우에도 body가 아니다.
    second.row.remove();
    expect(returnFocusAfterWorkPanelClose(first.button, memo)).toBe(RETURNED.route);
    expect(document.activeElement).toBe(route);
    expect(route.hasAttribute("inert")).toBe(false);
  });

  it("관제 서랍이 라우트를 덮고 있으면 inert는 그 서랍의 몫이라 걷지 않는다", () => {
    const route = shell();
    const { row, button } = chipSlot(RUN, "m-1");
    route.append(row);
    openAdeDrawer();
    returnFocusAfterWorkPanelClose(button, rememberPanelOpener(button, RUN));
    expect(route.hasAttribute("inert")).toBe(true);
  });

  it("돌려줄 곳이 하나도 없을 때만 body로 남고, 그 사실을 알린다", () => {
    const gone = document.createElement("button");
    expect(returnFocusAfterWorkPanelClose(gone, rememberPanelOpener(null, null))).toBe(RETURNED.body);
    expect(document.activeElement).toBe(document.body);
  });
});
