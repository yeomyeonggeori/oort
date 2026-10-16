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

function choose(value: string) {
  const select = q<HTMLSelectElement>("pause-until-select")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

const optionTexts = () =>
  [...(q<HTMLSelectElement>("pause-until-select")?.options ?? [])].map((o) => o.textContent);

describe("PauseUntilDialog 목록 (ADR-0204 D2)", () => {
  it("자리표시자 다음에 여섯 선택이 순서대로 서고, 끝 시각이 곁들여진다", () => {
    mount();
    expect(optionTexts()).toEqual([
      "기한을 고르세요",
      "30분 · 오후 9:37까지",
      "1시간 · 오후 10:07까지",
      "2시간 · 오후 11:07까지",
      "내일 오전 9시까지 · 10월 17일(토)",
      "다음 주 월요일 오전 9시까지 · 10월 19일(월)",
      "직접 고르기",
    ]);
    const first = q<HTMLSelectElement>("pause-until-select")!.options[0];
    expect(first.disabled).toBe(true);
    expect(q<HTMLSelectElement>("pause-until-select")!.value).toBe("");
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
    const select = q<HTMLSelectElement>("pause-until-select")!;
    expect([...select.options].map((o) => o.value)).toEqual([
      "",
      "30m",
      "1h",
      "2h",
      "tomorrow",
      "custom",
    ]);
  });

  it("라벨이 선택 칸에 걸려 있고 제목과 설명이 다이얼로그를 설명한다", () => {
    mount({ kind: "dnd" });
    const select = q<HTMLSelectElement>("pause-until-select")!;
    const label = document.querySelector(`label[for="${select.id}"]`);
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
    expect(q<HTMLSelectElement>("pause-until-select")!.value).toBe("2h");
    view.rerender({ open: false });
    view.rerender({ open: true });
    expect(q<HTMLSelectElement>("pause-until-select")!.value).toBe("");
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
    expect(q<HTMLSelectElement>("pause-until-select")!.disabled).toBe(true);
    expect(q<HTMLButtonElement>("pause-until-confirm")!.disabled).toBe(true);
    await click("pause-until-confirm");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("문구에 줄표가 없다", () => {
    mount({ kind: "dnd", running: true, failure: "x" });
    expect(q("pause-until-dialog")!.textContent).not.toMatch(/[—–]/);
  });
});
