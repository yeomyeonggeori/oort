// @vitest-environment jsdom

import { act, createElement } from "react";
import {cleanupMounts, control, createCopy, flush, mount as mountUi} from "@/testkit";
import {SCHEDULED_COPY} from "@momo/core/features/scheduled/copy";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleGate, type ScheduleGate } from "@momo/core/features/scheduled/gate";
import { scheduledPresets, scheduledZoneLine } from "@momo/core/features/scheduled/presets";
import { ScheduleSendMenu, type ScheduleSendMenuProps } from "./ScheduleSendMenu";

const copy = createCopy(SCHEDULED_COPY);

// =============================================================================
// ADR-0208 부록 B 1.1·1.3·1.10(#4215): 보내기 옆 ▾와 예약 메뉴를 호스트 없이 잰다. 판정(`scheduleGate`)은 진짜이고
// 호출부(입력창·스레드 입력창)가 달아 주는 콜백만 가짜다.
// =============================================================================

const NOW = new Date("2026-10-22T14:30:00+09:00").getTime();
const SUNDAY = new Date("2026-10-25T22:00:00+09:00").getTime();

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanupMounts();
  host = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function gateOf(over: Partial<Parameters<typeof scheduleGate>[0]> = {}): ScheduleGate {
  return scheduleGate({
    offered: true,
    offline: false,
    schedulerDisabled: false,
    text: "내일 회의 전에 자료 올려 둘게요",
    attachments: [],
    commandDraft: false,
    personalCall: false,
    quoting: false,
    pendingCount: 0,
    routingSet: false,
    ...over,
  });
}

function propsOf(over: Partial<ScheduleSendMenuProps> = {}): ScheduleSendMenuProps {
  const presets = scheduledPresets(NOW);
  return {
    gate: gateOf(),
    busy: false,
    presets,
    zoneLine: scheduledZoneLine(presets[0]?.atMs ?? NOW),
    onOpen: vi.fn(),
    onPickPreset: vi.fn(),
    onPickCustom: vi.fn(),
    onBlockedPress: vi.fn(),
    returnFocus: vi.fn(),
    blockedTitle: null,
    testIdPrefix: "composer",
    ...over,
  };
}

let parentClicks = 0;
async function mount(props: ScheduleSendMenuProps) {
  parentClicks = 0;
  await act(async () => {
    host = mountUi(
      createElement("div", { "data-testid": "parent", onClick: () => { parentClicks += 1; } }, createElement(ScheduleSendMenu, props))
    );
  });
}

const settle = (rounds = 2) => flush(rounds);

const byId = (testId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
function need(testId: string): HTMLElement {
  const el = byId(testId);
  if (!el) throw new Error(`없다: ${testId}`);
  return el;
}
const trigger = () => control(host!, "button", copy("trigger.label"));

async function openByPointer() {
  await act(async () => {
    trigger().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  await settle(1);
}
async function pressItem(testId: string) {
  const target = need(testId);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle(3);
}
async function key(target: HTMLElement, name: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  await settle(1);
}

describe("입구", () => {
  it("제공되지 않으면(서버에 예약이 없다) 아무것도 그리지 않는다", async () => {
    await mount(propsOf({ gate: gateOf({ offered: false }) }));
    expect(trigger).toThrow();
    expect(byId("composer-schedule-trigger")).toBeNull();
    expect(document.querySelector('[data-testid="composer-schedule-reason"]')).toBeNull();
  });

  it("▾의 이름·역할: 「예약해서 보내기」, aria-haspopup=menu, aria-expanded", async () => {
    await mount(propsOf());
    expect(trigger().getAttribute("aria-label")).toBe(copy("trigger.label"));
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().hasAttribute("aria-disabled")).toBe(false);
    await openByPointer();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("testIdPrefix가 스레드 입력창의 이름을 정한다", async () => {
    await mount(propsOf({ testIdPrefix: "thread-composer" }));
    expect(byId("thread-composer-schedule-trigger")).not.toBeNull();
    expect(byId("composer-schedule-trigger")).toBeNull();
  });
});

describe("열기와 고르기", () => {
  it("열 때 호출부에 ▾ 단추를 알리고, 메뉴는 항목 둘과 「직접 고르기…」와 시간대 줄이다", async () => {
    const props = propsOf();
    await mount(props);
    await openByPointer();
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(props.onOpen).toHaveBeenCalledWith(trigger());
    // 칸 사이에는 간격이 글이 아니라 레이아웃에 있으므로, 칸을 한 칸 띄워 읽는다.
    const items = [...need("composer-schedule-menu").querySelectorAll('[role="menuitem"]')].map((el) =>
      [...el.querySelectorAll("span")].map((span) => span.textContent).join(" ").replace(/\s+/g, " ").trim() || (el.textContent ?? "").trim()
    );
    expect(items).toEqual(["내일 오전 9:00 10월 23일 (금)", "다음 주 월요일 오전 9:00 10월 26일 (월)", "직접 고르기…"]);
    expect(need("composer-schedule-zone").textContent).toBe("Asia/Seoul (UTC+9) 기준이에요");
    // 첫 항목에 초점.
    expect(document.activeElement).toBe(need("composer-schedule-preset-tomorrow"));
  });

  it("일요일에는 둘째 항목이 없다", async () => {
    vi.setSystemTime(SUNDAY);
    await mount(propsOf({ presets: scheduledPresets(SUNDAY) }));
    await openByPointer();
    expect(byId("composer-schedule-preset-tomorrow")).not.toBeNull();
    expect(byId("composer-schedule-preset-next-monday")).toBeNull();
  });

  it("프리셋을 고르면 그 프리셋을 한 번 알리고, 메뉴가 닫힌 뒤 입력창으로 초점을 돌려 달라고 한다", async () => {
    const props = propsOf();
    await mount(props);
    await openByPointer();
    await pressItem("composer-schedule-preset-next-monday");
    expect(props.onPickPreset).toHaveBeenCalledTimes(1);
    expect(props.onPickPreset).toHaveBeenCalledWith(props.presets[1]);
    expect(props.returnFocus).toHaveBeenCalledTimes(1);
    expect(props.onPickCustom).not.toHaveBeenCalled();
    expect(byId("composer-schedule-menu")).toBeNull();
  });

  it("「직접 고르기…」는 메뉴가 닫힌 뒤에 ▾ 단추와 함께 알린다(대화상자와 메뉴의 초점이 싸우지 않는다)", async () => {
    const props = propsOf();
    await mount(props);
    await openByPointer();
    await pressItem("composer-schedule-custom");
    expect(props.onPickCustom).toHaveBeenCalledTimes(1);
    expect(props.onPickCustom).toHaveBeenCalledWith(trigger());
    expect(props.onPickPreset).not.toHaveBeenCalled();
    expect(props.returnFocus).not.toHaveBeenCalled();
  });

  it("Esc로 닫으면 아무것도 고르지 않고 초점은 ▾로 돌아간다", async () => {
    const props = propsOf();
    await mount(props);
    trigger().focus();
    await key(trigger(), "Enter");
    expect(byId("composer-schedule-menu")).not.toBeNull();
    await key(need("composer-schedule-preset-tomorrow"), "Escape");
    await settle(2);
    expect(byId("composer-schedule-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(props.onPickPreset).not.toHaveBeenCalled();
    expect(props.onPickCustom).not.toHaveBeenCalled();
  });

  it("메뉴 안의 누름은 입력창 그릇까지 올라가지 않는다(그릇은 빈 면적에 캐럿을 돌려준다)", async () => {
    await mount(propsOf({ gate: gateOf({ pendingCount: 50 }) }));
    await openByPointer();
    const before = parentClicks;
    await pressItem("composer-schedule-preset-tomorrow");
    expect(parentClicks).toBe(before);
    // 흐린 항목을 눌러도 메뉴가 열린 채 남는다.
    expect(byId("composer-schedule-menu")).not.toBeNull();
  });
});

describe("막힌 ▾는 눌러서 이유를 듣는다", () => {
  const blocked = () =>
    propsOf({
      gate: gateOf({ quoting: true }),
      blockedTitle: `${copy("disabled.quote.reason")}. ${copy("disabled.quote.next")}.`,
    });

  it("aria-disabled(disabled 아님)로 흐리고 title과 aria-describedby가 이유를 합쳐 싣는다", async () => {
    await mount(blocked());
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(trigger().hasAttribute("disabled")).toBe(false);
    expect(trigger().getAttribute("title")).toBe(`${copy("disabled.quote.reason")}. ${copy("disabled.quote.next")}.`);
    const reason = document.getElementById(trigger().getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(`${copy("disabled.quote.reason")}. ${copy("disabled.quote.next")}.`);
    expect(reason?.className).toContain("sr-only");
  });

  it("포인터·Enter·Space·↓는 메뉴를 열지 않고 호출부가 이유를 말하게 한다", async () => {
    const props = blocked();
    await mount(props);
    for (const [index, name] of ["Enter", " ", "ArrowDown"].entries()) {
      await key(trigger(), name);
      expect(props.onBlockedPress).toHaveBeenCalledTimes(index + 1);
      expect(byId("composer-schedule-menu")).toBeNull();
    }
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    await settle(1);
    expect(byId("composer-schedule-menu")).toBeNull();
    expect(props.onBlockedPress).toHaveBeenCalledTimes(4);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("막히지 않은 다른 키는 아무 일도 하지 않는다", async () => {
    const props = blocked();
    await mount(props);
    await key(trigger(), "a");
    await key(trigger(), "Tab");
    expect(props.onBlockedPress).not.toHaveBeenCalled();
  });

  it("오프라인처럼 이유 줄이 없는 사유는 앱의 오프라인 문장을 title에 싣고 낭독 노드를 따로 만들지 않는다", async () => {
    await mount(propsOf({ gate: gateOf({ offline: true }), blockedTitle: "연결이 끊겨 지금은 보낼 수 없습니다" }));
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(trigger().getAttribute("title")).toBe("연결이 끊겨 지금은 보낼 수 없습니다");
  });

  it("요청이 나는 동안(busy)은 aria-busy이고 열리지 않으며 이유도 말하지 않는다", async () => {
    const props = propsOf({ busy: true });
    await mount(props);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(trigger().hasAttribute("aria-disabled")).toBe(false);
    await openByPointer();
    await key(trigger(), "Enter");
    expect(byId("composer-schedule-menu")).toBeNull();
    expect(props.onBlockedPress).not.toHaveBeenCalled();
    expect(props.onOpen).not.toHaveBeenCalled();
  });
});

describe("한도와 모델 지정 안내", () => {
  it("대기 50개: 문장이 맨 위에 서고 세 항목이 모두 aria-disabled이며 같은 문장을 가리킨다", async () => {
    const props = propsOf({ gate: gateOf({ pendingCount: 50 }) });
    await mount(props);
    await openByPointer();
    const limit = need("composer-schedule-limit");
    expect(limit.textContent).toBe(copy("disabled.limit"));
    expect(need("composer-schedule-menu").firstElementChild).toBe(limit);
    const items = [...need("composer-schedule-menu").querySelectorAll('[role="menuitem"]')];
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.hasAttribute("data-disabled")).toBe(false);
      expect(item.getAttribute("aria-describedby")).toBe(limit.id);
    }
    await pressItem("composer-schedule-preset-tomorrow");
    await pressItem("composer-schedule-custom");
    expect(props.onPickPreset).not.toHaveBeenCalled();
    expect(props.onPickCustom).not.toHaveBeenCalled();
  });

  it("흐린 항목에 키보드가 닿는다", async () => {
    await mount(propsOf({ gate: gateOf({ pendingCount: 50 }) }));
    await openByPointer();
    await key(need("composer-schedule-preset-tomorrow"), "ArrowDown");
    expect(document.activeElement).toBe(need("composer-schedule-preset-next-monday"));
    await key(need("composer-schedule-preset-next-monday"), "ArrowDown");
    expect(document.activeElement).toBe(need("composer-schedule-custom"));
  });

  it("49개는 아직 걸 수 있다", async () => {
    await mount(propsOf({ gate: gateOf({ pendingCount: 49 }) }));
    await openByPointer();
    expect(byId("composer-schedule-limit")).toBeNull();
    expect(need("composer-schedule-preset-tomorrow").hasAttribute("aria-disabled")).toBe(false);
  });

  it("모델 지정이 켜져 있으면 「모델 지정은 예약에 담기지 않아요」 한 줄이 선다", async () => {
    await mount(propsOf({ gate: gateOf({ routingSet: true }) }));
    await openByPointer();
    expect(need("composer-schedule-routing-note").textContent).toBe(copy("menu.routingNote"));
  });

  it("모델 지정이 없으면 그 줄이 없다", async () => {
    await mount(propsOf());
    await openByPointer();
    expect(byId("composer-schedule-routing-note")).toBeNull();
  });
});
