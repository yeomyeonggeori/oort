// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleDialog, type ScheduleDialogProps } from "./ScheduleDialog";

// =============================================================================
// ADR-0208 부록 B 1.4·1.9(#4215): 「보낼 시각 고르기」 대화상자를 호스트 없이 잰다. 입력창(만들기)과 목록 행(바꾸기·
// 다시 예약)이 같은 컴포넌트를 쓴다.
// =============================================================================

const NOW = new Date("2026-10-22T14:30:00+09:00").getTime();
const TOMORROW_9 = new Date("2026-10-23T09:00:00+09:00").getTime();

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function propsOf(over: Partial<ScheduleDialogProps> = {}): ScheduleDialogProps {
  return {
    open: true,
    onOpenChange: vi.fn(),
    mode: "create",
    opener: null,
    placeLabel: "#일반",
    preview: "내일 회의 전에 자료 올려 둘게요",
    initialAtMs: TOMORROW_9,
    pending: false,
    error: null,
    offline: false,
    onCommit: vi.fn(),
    nowMs: NOW,
    ...over,
  };
}

async function mount(props: ScheduleDialogProps) {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(createElement(ScheduleDialog, props));
  });
}

const byId = (testId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
function need(testId: string): HTMLElement {
  const el = byId(testId);
  if (!el) throw new Error(`없다: ${testId}`);
  return el;
}
const textOf = (testId: string): string => (byId(testId)?.textContent ?? "").replace(/\s+/g, " ").trim();

function setValue(testId: string, value: string) {
  const el = need(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  return act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    need("schedule-dialog-commit").click();
  });
}

describe("처음 값과 결과 문장", () => {
  it("만들기: 장소·미리보기·날짜·시간·결과 문장·시간대 줄이 처음 시각으로 선다", async () => {
    await mount(propsOf());
    expect(textOf("schedule-dialog")).toContain("보낼 시각 고르기");
    expect(textOf("schedule-dialog")).toContain("고른 시각에 이 메시지를 보내요. 내 기기가 꺼져 있어도 보내요.");
    expect(textOf("schedule-dialog-place")).toBe("#일반");
    expect(textOf("schedule-dialog-preview")).toBe("내일 회의 전에 자료 올려 둘게요");
    expect((need("schedule-dialog-date") as HTMLInputElement).value).toBe("2026-10-23");
    expect((need("schedule-dialog-time") as HTMLInputElement).value).toBe("09:00");
    expect(textOf("schedule-dialog-result")).toBe("내일 오전 9:00에 보내요");
    expect(textOf("schedule-dialog-zone")).toBe("Asia/Seoul (UTC+9) 기준이에요");
    expect(need("schedule-dialog-result").getAttribute("aria-live")).toBe("polite");
    expect(textOf("schedule-dialog-commit")).toBe("예약하기");
  });

  it("값을 고치면 결과 문장이 고른 시각을 다시 말한다", async () => {
    await mount(propsOf());
    await setValue("schedule-dialog-date", "2026-10-26");
    await setValue("schedule-dialog-time", "15:30");
    expect(textOf("schedule-dialog-result")).toBe("10월 26일 (월) 오후 3:30에 보내요");
  });

  it("첨부만 있는 예약은 미리보기 줄이 없다", async () => {
    await mount(propsOf({ preview: "" }));
    expect(byId("schedule-dialog-preview")).toBeNull();
  });

  it("바꾸기와 다시 예약은 제목과 확인 문구가 다르다", async () => {
    await mount(propsOf({ mode: "change" }));
    expect(textOf("schedule-dialog")).toContain("보낼 시각 바꾸기");
    expect(textOf("schedule-dialog-commit")).toBe("변경하기");
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    host?.remove();
    await mount(propsOf({ mode: "rearm" }));
    expect(textOf("schedule-dialog")).toContain("다시 예약하기");
    expect(textOf("schedule-dialog-commit")).toBe("예약하기");
  });

  it("모델 지정이 켜져 있으면 「모델 지정은 예약에 담기지 않아요」 한 줄이 선다", async () => {
    await mount(propsOf({ routingNote: true }));
    expect(textOf("schedule-dialog-routing-note")).toBe("모델 지정은 예약에 담기지 않아요");
  });

  it("모델 지정이 없으면 그 줄이 없다", async () => {
    await mount(propsOf());
    expect(byId("schedule-dialog-routing-note")).toBeNull();
  });
});

describe("확인 (UI 명세 0.5·1.4)", () => {
  it("확인하면 고른 시각의 에포크를 올린다", async () => {
    const props = propsOf();
    await mount(props);
    await setValue("schedule-dialog-date", "2026-10-24");
    await submit();
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith(new Date("2026-10-24T09:00:00+09:00").getTime());
  });

  it("마지막 칸에서 Enter로도 제출된다(폼 제출)", async () => {
    const props = propsOf();
    await mount(props);
    await act(async () => {
      need("schedule-dialog-time").closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onCommit).toHaveBeenCalledWith(TOMORROW_9);
  });

  it("지금보다 1분 안의 시각은 서버를 부르기 전에 말한다", async () => {
    const props = propsOf();
    await mount(props);
    await setValue("schedule-dialog-date", "2026-10-22");
    await setValue("schedule-dialog-time", "14:30");
    await submit();
    expect(textOf("schedule-dialog-error")).toBe("1분 뒤부터 예약할 수 있어요");
    expect(props.onCommit).not.toHaveBeenCalled();
    // 값을 고치면 오류 줄이 걷힌다.
    await setValue("schedule-dialog-time", "15:30");
    expect(byId("schedule-dialog-error")).toBeNull();
  });

  it("120일을 넘는 시각은 120일 안에서 골라 달라고 말한다", async () => {
    const props = propsOf();
    await mount(props);
    await setValue("schedule-dialog-date", "2027-04-01");
    await submit();
    expect(textOf("schedule-dialog-error")).toBe("120일 안에서 골라 주세요");
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("비어 있거나 없는 날짜는 확인해 달라고 말한다", async () => {
    const props = propsOf();
    await mount(props);
    await setValue("schedule-dialog-date", "");
    await submit();
    expect(textOf("schedule-dialog-error")).toBe("날짜와 시간을 확인해 주세요");
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("날짜 칸에는 120일 뒤까지만 고를 수 있는 max가 걸려 있다", async () => {
    await mount(propsOf());
    expect((need("schedule-dialog-date") as HTMLInputElement).max).toBe("2027-02-19");
  });
});

describe("진행·오류·잠금 (UI 명세 0.5·0.6·1.9)", () => {
  it("요청이 나는 동안: 칸이 잠기고 확인은 「예약 중」(aria-busy), 취소·Esc·바깥 누름은 닫지 않는다", async () => {
    const props = propsOf({ pending: true });
    await mount(props);
    expect((need("schedule-dialog-date") as HTMLInputElement).disabled).toBe(true);
    expect((need("schedule-dialog-time") as HTMLInputElement).disabled).toBe(true);
    expect(textOf("schedule-dialog-commit")).toBe("예약 중");
    expect(need("schedule-dialog-commit").getAttribute("aria-busy")).toBe("true");
    expect((need("schedule-dialog-cancel") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      need("schedule-dialog").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(props.onOpenChange).not.toHaveBeenCalled();
    // 확인을 또 눌러도 두 번째 요청이 없다(제출 자체가 잠겨 있다).
    await act(async () => {
      need("schedule-dialog-time").closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("바꾸기에서 진행 낱말은 「저장 중」이다", async () => {
    await mount(propsOf({ mode: "change", pending: true }));
    expect(textOf("schedule-dialog-commit")).toBe("저장 중");
  });

  it("취소와 Esc는 닫는다", async () => {
    const props = propsOf();
    await mount(props);
    await act(async () => {
      need("schedule-dialog-cancel").click();
    });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("호출부의 오류는 role=alert 줄로 서고 다음 행동 줄도 함께 선다", async () => {
    await mount(propsOf({ error: { text: "이 서버에서는 예약을 쓸 수 없어요", next: "관리자에게 물어보세요" } }));
    expect(need("schedule-dialog-error").getAttribute("role")).toBe("alert");
    expect([...need("schedule-dialog-error").querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "이 서버에서는 예약을 쓸 수 없어요",
      "관리자에게 물어보세요",
    ]);
  });

  it("오프라인: 칸과 확인이 흐리고 안내 한 줄이 오류 줄 자리에 선다", async () => {
    await mount(propsOf({ offline: true, error: { text: "다른 오류" } }));
    expect(textOf("schedule-dialog-error")).toBe("연결이 없어서 지금은 할 수 없어요. 연결되면 다시 눌러 주세요.");
    expect((need("schedule-dialog-commit") as HTMLButtonElement).disabled).toBe(true);
    expect((need("schedule-dialog-date") as HTMLInputElement).disabled).toBe(true);
  });

  it("마감 30초 안으로 잠기면 저장이 잠기고 「곧 보내서 바꿀 수 없어요」를 말한다(오프라인·오류보다 먼저)", async () => {
    await mount(propsOf({ mode: "change", lock: "tooLate", offline: true, error: { text: "다른 오류" } }));
    expect(textOf("schedule-dialog-error")).toBe("곧 보내서 바꿀 수 없어요. 지금 보내거나 지울 수 있어요.");
    expect((need("schedule-dialog-commit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("서버가 예약을 껐으면 「예약하기」가 흐리고 이유와 다음 행동이 오류 줄 자리에 서며 제출해도 올리지 않는다 (명세 0.5 ③)", async () => {
    const props = propsOf({ unavailable: true });
    await mount(props);
    expect((need("schedule-dialog-commit") as HTMLButtonElement).disabled).toBe(true);
    expect([...need("schedule-dialog-error").querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "이 서버에서는 예약을 쓸 수 없어요",
      "관리자에게 물어보세요",
    ]);
    expect(need("schedule-dialog-error").getAttribute("role")).toBe("alert");
    await act(async () => {
      need("schedule-dialog-time").closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onCommit).not.toHaveBeenCalled();
    // 취소는 눌린다: 닫을 길은 남아 있다.
    expect((need("schedule-dialog-cancel") as HTMLButtonElement).disabled).toBe(false);
    // 칸도 오프라인과 같이 잠긴다: 눌러도 같은 거절만 돌아오는 화면에서 시각을 고르게 하지 않는다.
    expect((need("schedule-dialog-date") as HTMLInputElement).disabled).toBe(true);
    expect((need("schedule-dialog-time") as HTMLInputElement).disabled).toBe(true);
  });

  it("오류 줄 자리의 우선순위: 잠금 > 오프라인 > 예약을 끈 서버 > 호출부의 오류", async () => {
    await mount(propsOf({ unavailable: true, error: { text: "다른 오류" } }));
    expect(textOf("schedule-dialog-error")).toContain("이 서버에서는 예약을 쓸 수 없어요");
    expect(textOf("schedule-dialog-error")).not.toContain("다른 오류");
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    host?.remove();
    await mount(propsOf({ unavailable: true, offline: true }));
    expect(textOf("schedule-dialog-error")).toBe("연결이 없어서 지금은 할 수 없어요. 연결되면 다시 눌러 주세요.");
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    host?.remove();
    // 잠금(마감 30초 안)이 가장 먼저 말한다: 서버가 껐고 오프라인이어도 이 행은 곧 나가는 행이다.
    await mount(propsOf({ mode: "change", lock: "tooLate", unavailable: true, offline: true }));
    expect(textOf("schedule-dialog-error")).toBe("곧 보내서 바꿀 수 없어요. 지금 보내거나 지울 수 있어요.");
  });

  it("이미 나간 행이면 「이미 보냈어요」", async () => {
    await mount(propsOf({ mode: "change", lock: "gone" }));
    expect(textOf("schedule-dialog-error")).toBe("이미 보냈어요");
    expect((need("schedule-dialog-commit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("잠긴 대화상자에서 제출해도 올리지 않는다", async () => {
    const props = propsOf({ mode: "change", lock: "tooLate" });
    await mount(props);
    await act(async () => {
      need("schedule-dialog-time").closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onCommit).not.toHaveBeenCalled();
  });
});

describe("초점", () => {
  it("열리면 초점은 날짜 칸이다", async () => {
    await mount(propsOf());
    expect(document.activeElement).toBe(need("schedule-dialog-date"));
  });

  it("닫히면 초점은 연 단추로 돌아가고, 호출부가 가로채면 그쪽이 이긴다", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    function Host({ onClose }: { onClose?: (event: Event) => void }) {
      const [open, setOpen] = useState(true);
      return createElement(ScheduleDialog, {
        ...propsOf({ opener, ...(onClose === undefined ? {} : { onCloseAutoFocus: onClose }) }),
        open,
        onOpenChange: setOpen,
      });
    }
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    await act(async () => {
      mountedRoot?.render(createElement(Host));
    });
    await act(async () => {
      need("schedule-dialog-cancel").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(opener);

    // 가로채면: 호출부가 `preventDefault`하고 다른 곳으로 보낸다.
    const other = document.createElement("input");
    document.body.append(other);
    const onClose = vi.fn((event: Event) => {
      event.preventDefault();
      other.focus();
    });
    act(() => mountedRoot?.unmount());
    mountedRoot = createRoot(host);
    await act(async () => {
      mountedRoot?.render(createElement(Host, { onClose }));
    });
    await act(async () => {
      need("schedule-dialog-cancel").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(other);
  });
});
