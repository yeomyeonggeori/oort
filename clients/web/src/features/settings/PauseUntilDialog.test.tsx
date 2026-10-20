// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PauseUntilDialog } from "./PauseUntilDialog";

// 시험 시계는 **로컬 시계 생성자**로 만든다. 서버가 아니라 이 기기의 달력으로 세는 계약이라
// 에폭 상수를 박으면 시간대가 다른 곳에서만 붉어진다(웹 vitest 는 TZ 를 고정하지만 이 시험은
// 그 사실에 기대지 않는다). 2026년 10월: 16 금 · 17 토 · 18 일 · 19 월.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute, 0, 0).getTime();
const FRI_2107 = at(16, 21, 7);
const SUN_1000 = at(18, 10, 0);

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Props = ComponentProps<typeof PauseUntilDialog>;

function baseProps(over: Partial<Props> = {}): Props {
  return {
    kind: "pause",
    open: true,
    onOpenChange: () => undefined,
    opener: null,
    running: false,
    pending: false,
    failure: null,
    onConfirm: () => undefined,
    nowMs: FRI_2107,
    ...over,
  };
}

function mount(over: Partial<Props> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(createElement(PauseUntilDialog, baseProps(over))));
  return {
    rerender(next: Partial<Props>) {
      act(() =>
        mountedRoot?.render(createElement(PauseUntilDialog, baseProps({ ...over, ...next })))
      );
    },
  };
}

function unmount() {
  act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
}

const q = <T extends HTMLElement>(testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`) as T | null;

const trigger = () => q<HTMLButtonElement>("pause-until-select")!;
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const optionEls = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

function openList() {
  if (listbox()) return;
  act(() => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function choose(value: string) {
  openList();
  const option = optionEls().find((o) => o.dataset.value === value)!;
  act(() => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function pressKey(key: string) {
  const target = listbox() ?? trigger();
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function type(testId: string, value: string) {
  const input = q<HTMLInputElement>(testId)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(testId: string) {
  await act(async () => {
    q(testId)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const optionTexts = () => {
  openList();
  return optionEls().map((o) => o.textContent);
};

describe("PauseUntilDialog 목록 (ADR-0204 D2)", () => {
  it("자리표시자가 단추에 서고 여섯 선택이 순서대로 목록에 서며, 끝 시각은 라벨 아래 줄이다", () => {
    mount();
    expect(trigger().textContent).toBe("기한을 고르세요");
    expect(trigger().dataset.value).toBe("");
    expect(optionTexts()).toEqual([
      "30분오후 9:37까지",
      "1시간오후 10:07까지",
      "2시간오후 11:07까지",
      "내일 오전 9시까지10월 17일(토)",
      "다음 주 월요일 오전 9시까지10월 19일(월)",
      "직접 고르기",
    ]);
  });

  it("앱이 그린 listbox 다: 네이티브 select 가 아니고, combobox·listbox·option 의미를 갖는다", () => {
    mount();
    expect(trigger().tagName).toBe("BUTTON");
    expect(document.querySelector("select")).toBeNull();
    expect(trigger().getAttribute("role")).toBe("combobox");
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    openList();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(listbox()!.id);
    expect(optionEls().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    // 목록도 「기한」 라벨로 이름을 갖는다(이름 없는 listbox 로 읽히지 않는다).
    const labelId = document.querySelector(`label[for="${trigger().id}"]`)!.id;
    expect(labelId).toBeTruthy();
    expect(listbox()!.getAttribute("aria-labelledby")).toBe(labelId);
  });

  it("고른 항목은 aria-selected 이고 단추에 「라벨 · 끝 시각」으로 읽힌다", () => {
    mount();
    choose("1h");
    expect(trigger().textContent).toBe("1시간 · 오후 10:07까지");
    expect(trigger().dataset.value).toBe("1h");
    expect(listbox()).toBeNull();
    openList();
    expect(optionEls().filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.dataset.value)).toEqual(["1h"]);
  });

  it("키보드: ↓ 로 열고, ↑↓ 로 움직이고, Enter 로 고른다", async () => {
    mount();
    pressKey("ArrowDown");
    expect(listbox()).not.toBeNull();
    const activeValue = () =>
      optionEls().find((o) => o.id === listbox()!.getAttribute("aria-activedescendant"))?.dataset.value;
    expect(activeValue()).toBe("30m");
    pressKey("ArrowDown");
    pressKey("ArrowDown");
    expect(activeValue()).toBe("2h");
    pressKey("ArrowUp");
    expect(activeValue()).toBe("1h");
    pressKey("End");
    expect(activeValue()).toBe("custom");
    pressKey("ArrowDown");
    expect(activeValue()).toBe("custom");
    pressKey("Home");
    expect(activeValue()).toBe("30m");
    pressKey("ArrowDown");
    pressKey("Enter");
    expect(listbox()).toBeNull();
    expect(trigger().dataset.value).toBe("1h");
  });

  it("키보드: Esc 는 목록만 닫고 다이얼로그는 열어 두며, 포커스는 단추로 돌아온다", async () => {
    const onOpenChange = vi.fn();
    mount({ onOpenChange });
    openList();
    expect(document.activeElement).toBe(listbox());
    await act(async () => {
      listbox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(listbox()).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(q("pause-until-dialog")).not.toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(document.activeElement).toBe(trigger());
  });

  it("「직접 끌 때까지」도 「기한 없음」도 고를 수 없다", () => {
    mount();
    for (const text of optionTexts()) {
      expect(text).not.toContain("끌 때까지");
      expect(text).not.toContain("기한 없음");
    }
  });

  it("일요일에는 「내일」과 같은 시각인 「다음 주 월요일」을 뺀다", () => {
    mount({ nowMs: SUN_1000 });
    openList();
    expect(optionEls().map((o) => o.dataset.value)).toEqual([
      "30m",
      "1h",
      "2h",
      "tomorrow",
      "custom",
    ]);
  });

  it("라벨이 선택 칸에 걸려 있고 제목과 설명이 다이얼로그를 설명한다", () => {
    mount({ kind: "dnd" });
    const label = document.querySelector(`label[for="${trigger().id}"]`);
    expect(label?.textContent).toBe("기한");
    const dialog = q("pause-until-dialog")!;
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.textContent).toContain("방해 금지를 언제까지 켤까요?");
    expect(dialog.textContent).toContain("알림도 함께 멈춰요");
  });

  it("알림 일시 중지 쪽은 방해 금지 말을 섞지 않는다", () => {
    mount({ kind: "pause" });
    const dialog = q("pause-until-dialog")!;
    expect(dialog.textContent).toContain("알림을 언제까지 멈출까요?");
    expect(dialog.textContent).not.toContain("방해 금지");
  });
});

describe("PauseUntilDialog 확인", () => {
  it("고르기 전에는 확인이 잠겨 있고, 고르면 풀린다", async () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    const confirm = q<HTMLButtonElement>("pause-until-confirm")!;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("알림 멈추기");
    await click("pause-until-confirm");
    expect(onConfirm).not.toHaveBeenCalled();

    choose("1h");
    expect(q<HTMLButtonElement>("pause-until-confirm")!.disabled).toBe(false);
    await click("pause-until-confirm");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(FRI_2107 + 60 * 60_000);
  });

  it("확인 단추의 동사는 종류를 따른다", () => {
    mount({ kind: "dnd" });
    expect(q("pause-until-confirm")!.textContent).toBe("방해 금지 켜기");
  });

  it("각 선택이 끝나는 시각을 올린다", async () => {
    const expected: Record<string, number> = {
      "30m": FRI_2107 + 30 * 60_000,
      "2h": FRI_2107 + 120 * 60_000,
      tomorrow: at(17, 9),
      nextMonday: at(19, 9),
    };
    for (const [id, atMs] of Object.entries(expected)) {
      const onConfirm = vi.fn();
      mount({ onConfirm });
      choose(id);
      await click("pause-until-confirm");
      expect(onConfirm, id).toHaveBeenCalledWith(atMs);
      unmount();
    }
  });

  it("「30분」은 연 때가 아니라 확인한 때부터 센다", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FRI_2107 });
    const onConfirm = vi.fn();
    mount({ nowMs: undefined, onConfirm });
    choose("30m");
    // 다이얼로그를 연 채로 5분이 지난다.
    vi.setSystemTime(FRI_2107 + 5 * 60_000);
    await click("pause-until-confirm");
    expect(onConfirm).toHaveBeenCalledWith(FRI_2107 + 35 * 60_000);
  });

  it("닫혔다 다시 열면 지난번 선택이 눌려 있지 않다", () => {
    const view = mount();
    choose("2h");
    expect(trigger().dataset.value).toBe("2h");
    view.rerender({ open: false });
    view.rerender({ open: true });
    expect(trigger().dataset.value).toBe("");
    expect(q<HTMLButtonElement>("pause-until-confirm")!.disabled).toBe(true);
  });
});

describe("PauseUntilDialog 직접 고르기", () => {
  it("고르면 한 시간 뒤가 채워진 날짜·시간 칸이 서고, 다른 선택에서는 접힌다", () => {
    mount();
    expect(q("pause-until-custom-date")).toBeNull();
    choose("custom");
    expect(q<HTMLInputElement>("pause-until-custom-date")!.value).toBe("2026-10-16");
    expect(q<HTMLInputElement>("pause-until-custom-time")!.value).toBe("22:07");
    expect(q<HTMLInputElement>("pause-until-custom-date")!.min).toBe("2026-10-16");
    choose("1h");
    expect(q("pause-until-custom-date")).toBeNull();
  });

  it("자정을 넘는 한 시간 뒤면 날짜도 함께 넘어간다", () => {
    mount({ nowMs: at(16, 23, 30) });
    choose("custom");
    expect(q<HTMLInputElement>("pause-until-custom-date")!.value).toBe("2026-10-17");
    expect(q<HTMLInputElement>("pause-until-custom-time")!.value).toBe("00:30");
  });

  it("날짜와 시간을 고쳐 확인하면 그 시각을 올린다", async () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    choose("custom");
    type("pause-until-custom-date", "2026-10-17");
    type("pause-until-custom-time", "21:30");
    await click("pause-until-confirm");
    expect(onConfirm).toHaveBeenCalledWith(at(17, 21, 30));
    expect(q("pause-until-custom-error")).toBeNull();
  });

  it("지난 시각은 올리지 않고 요청하는 말투로 이유를 말한다", async () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    choose("custom");
    type("pause-until-custom-date", "2026-10-16");
    type("pause-until-custom-time", "21:00");
    await click("pause-until-confirm");
    expect(onConfirm).not.toHaveBeenCalled();
    const alert = q("pause-until-custom-error")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("지난 시각은 고를 수 없어요. 다른 시각을 고르세요.");
  });

  it("비어 있거나 읽을 수 없는 칸은 확인하라고 말한다", async () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    choose("custom");
    type("pause-until-custom-time", "");
    await click("pause-until-confirm");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(q("pause-until-custom-error")!.textContent).toBe("날짜와 시각을 확인하세요.");
  });

  it("칸을 고치면 이유 문장이 걷힌다", async () => {
    mount();
    choose("custom");
    type("pause-until-custom-time", "");
    await click("pause-until-confirm");
    expect(q("pause-until-custom-error")).not.toBeNull();
    type("pause-until-custom-time", "23:00");
    expect(q("pause-until-custom-error")).toBeNull();
  });
});

describe("PauseUntilDialog 지금 상태 한 줄", () => {
  it("켜져 있고 기한이 있으면 그 기한을 말한다", () => {
    mount({ running: true, currentUntilMs: at(16, 21, 30) });
    expect(q("pause-until-current")!.textContent).toBe("지금은 오후 9:30까지예요.");
  });

  it("켜져 있는데 기한이 없으면 그렇게 말한다", () => {
    mount({ running: true });
    expect(q("pause-until-current")!.textContent).toBe("지금은 기한이 없어요.");
  });

  it("꺼져 있으면 줄 자체가 없다", () => {
    mount({ running: false, currentUntilMs: at(16, 21, 30) });
    expect(q("pause-until-current")).toBeNull();
  });
});

describe("PauseUntilDialog 네 상태", () => {
  it("저장 중에는 확인이 「저장 중…」으로 잠기고 Esc 로 닫히지 않는다", async () => {
    const onOpenChange = vi.fn();
    mount({ pending: true, onOpenChange });
    const confirm = q<HTMLButtonElement>("pause-until-confirm")!;
    expect(confirm.textContent).toBe("저장 중…");
    expect(confirm.disabled).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("저장 중에는 취소도 닫지 않는다 — 닫는 모든 길이 같은 규칙이다 (design-review H1)", async () => {
    // 취소만 열려 있으면 사람이 「취소」를 눌렀는데 쓰기는 나가서 멈춤이 켜지고, 늦게 온 실패는 닫힌 창
    // 대신 다음에 여는 창에 먼저 보인다.
    const onOpenChange = vi.fn();
    mount({ pending: true, onOpenChange });
    const cancel = q<HTMLButtonElement>("pause-until-cancel")!;
    expect(cancel.disabled).toBe(true);
    await click("pause-until-cancel");
    expect(onOpenChange).not.toHaveBeenCalled();
    // 쓰기가 끝나면(저장 중이 아니면) 취소는 다시 닫는다.
    unmount();
    const again = vi.fn();
    mount({ pending: false, onOpenChange: again });
    expect(q<HTMLButtonElement>("pause-until-cancel")!.disabled).toBe(false);
    await click("pause-until-cancel");
    expect(again).toHaveBeenCalledWith(false);
  });

  it("저장 중이 아니면 Esc 와 취소가 닫는다", async () => {
    const onOpenChange = vi.fn();
    mount({ onOpenChange });
    await click("pause-until-cancel");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("실패 문장은 다이얼로그가 열린 채 알림 띠로 말한다", () => {
    mount({ failure: "알림 일시 중지를 걸지 못했어요. 잠시 후 다시 시도하세요." });
    const banner = q("pause-until-error")!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("알림 일시 중지를 걸지 못했어요.");
  });

  it("오프라인이면 이유를 말하고 선택과 확인이 잠긴다", async () => {
    const onConfirm = vi.fn();
    mount({ offline: true, onConfirm });
    expect(q("pause-until-offline")!.textContent).toContain("연결이 끊겨");
    expect(trigger().disabled).toBe(true);
    openList();
    expect(listbox()).toBeNull();
    expect(q<HTMLButtonElement>("pause-until-confirm")!.disabled).toBe(true);
    await click("pause-until-confirm");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("목록이 열린 채 잠기면(저장·오프라인) 목록이 접힌다", () => {
    const view = mount();
    openList();
    expect(listbox()).not.toBeNull();
    view.rerender({ offline: true });
    expect(listbox()).toBeNull();
  });

  it("문구에 줄표가 없다", () => {
    mount({ kind: "dnd", running: true, failure: "x" });
    expect(q("pause-until-dialog")!.textContent).not.toMatch(/[—–]/);
  });
});
