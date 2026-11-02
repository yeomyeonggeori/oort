// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ATTACH_COPY,
  completeUpload,
  draftFor,
  failUpload,
  type AttachmentDraft,
} from "@momo/core/features/attachments/model";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { AttachmentTray } from "./AttachmentTray";

// 입력창 안 첨부 줄의 상호작용 (#5200). 여기서 재는 것:
//   1. 카드 줄의 탭 정거장은 하나이고 ×는 탭 순서에 없다(로빙).
//   2. ×의 낭독 이름은 「{파일 이름} 첨부 빼기」다.
//   3. 카드에서 Backspace/Delete 로 빼면 초점이 옆 카드로, 하나뿐이었으면 글 칸으로 간다.
//   4. 마우스로 ×를 눌러 빼면 초점이 글 칸으로 가고, 초점이 밖에 있으면 건드리지 않는다.
//   5. 넘친 수·폴더 알림, 모두 지우기, 다시 시도.
// 영상·PDF·로그만 쓴다: 이미지 썸네일은 `draftThumbnail.test.tsx` 가 잰다.

let locale: AppLocale;
beforeAll(async () => {
  locale = await koreanLocaleForTest();
});
afterEach(cleanup);

const file = (id: string, name: string, mime = "video/mp4"): AttachmentDraft =>
  completeUpload([draftFor(id, { name, mime, sizeBytes: 2_400_000 })], id, `att-${id}`)[0] as AttachmentDraft;

const five = (): AttachmentDraft[] => [
  file("a", "녹화-온보딩-시연.mp4"),
  file("b", "분기별-리뷰.pdf", "application/pdf"),
  file("c", "drain-2026-11-01.log", "text/plain"),
  file("d", "릴리스-영상.mp4"),
  file("e", "회의록.pdf", "application/pdf"),
];

interface Handlers {
  onRemove: ReturnType<typeof vi.fn>;
  onRetry: ReturnType<typeof vi.fn>;
  onClear: ReturnType<typeof vi.fn>;
  onAcknowledgeNotices: ReturnType<typeof vi.fn>;
  returnFocus: ReturnType<typeof vi.fn>;
}

function renderTray(
  drafts: AttachmentDraft[],
  extra: { rejected?: number; folders?: number; provider?: boolean } = {}
): Handlers {
  const handlers: Handlers = {
    onRemove: vi.fn(),
    onRetry: vi.fn(),
    onClear: vi.fn(),
    onAcknowledgeNotices: vi.fn(),
    returnFocus: vi.fn(),
  };
  const tray = (
    <AttachmentTray
      drafts={drafts}
      rejected={extra.rejected ?? 0}
      folders={extra.folders ?? 0}
      {...handlers}
    />
  );
  render(extra.provider === false ? tray : <LocaleProvider locale={locale}>{tray}</LocaleProvider>);
  return handlers;
}

const cards = () => screen.getAllByTestId("attachment-chip");
const activeCardIndex = () => cards().findIndex((card) => card === document.activeElement);

describe("카드 줄의 모양과 탭 정거장", () => {
  it("카드마다 모양이 서고 탭 정거장은 정확히 하나이며 ×는 탭 순서에 없다", () => {
    renderTray(five());
    expect(cards()).toHaveLength(5);
    expect(cards().every((card) => card.getAttribute("data-card-shape") === "file")).toBe(true);
    expect(cards().filter((card) => card.tabIndex === 0)).toHaveLength(1);
    expect(cards()[0]?.tabIndex).toBe(0);
    for (const remove of screen.getAllByTestId("attachment-chip-remove")) {
      expect(remove.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("초점을 받은 카드가 새 탭 정거장이 된다", () => {
    renderTray(five());
    act(() => cards()[3]?.focus());
    expect(cards().filter((card) => card.tabIndex === 0)).toEqual([cards()[3]]);
  });

  it("줄은 하나의 목록이고 이름에 개수가 있다", () => {
    renderTray(five());
    const list = screen.getByTestId("attachment-list-scroll");
    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("aria-label")).toBe(`${ATTACH_COPY.tray} 5`);
  });

  it("첨부도 알림도 없으면 아무것도 그리지 않는다", () => {
    renderTray([]);
    expect(screen.queryByTestId("attachment-tray")).toBeNull();
  });
});

describe("× 의 낭독 이름", () => {
  it("「{파일 이름} 첨부 빼기」다", () => {
    renderTray(five());
    const label = screen.getAllByTestId("attachment-chip-remove")[0]?.getAttribute("aria-label");
    expect(label).toBe("녹화-온보딩-시연.mp4 첨부 빼기");
  });

  it("이름을 보일 수 없는 파일은 일반 이름으로 말한다(무작위 토큰을 읽지 않는다)", () => {
    renderTray([file("x", "geGngQxZ3pLmK9aVbT2wRq-pQ.mp4")]);
    expect(screen.getByTestId("attachment-chip-remove").getAttribute("aria-label")).toBe("동영상 첨부 빼기");
  });

  it("×와 카드 전체에는 네이티브 툴팁(title)이 없다: 작은 모서리 단추 위의 큰 툴팁이 방해였다", () => {
    renderTray(five());
    expect(screen.getAllByTestId("attachment-chip-remove").every((x) => !x.hasAttribute("title"))).toBe(true);
    expect(cards().every((card) => !card.hasAttribute("title"))).toBe(true);
    // 잘린 이름의 전체는 이름 글자 위에서만 뜬다.
    expect(screen.getAllByTestId("attachment-chip-name")[0]?.getAttribute("title")).toBe("녹화-온보딩-시연.mp4");
  });

  it("영어 사전에서는 영어 문장이다(사전을 거친다)", () => {
    renderTray(five(), { provider: false });
    expect(screen.getAllByTestId("attachment-chip-remove")[1]?.getAttribute("aria-label")).toBe(
      "Remove attachment 분기별-리뷰.pdf"
    );
  });
});

describe("키보드로 빼기", () => {
  it("가운데 카드에서 Delete → 그 카드가 빠지고 초점이 옆(다음) 카드로 간다", () => {
    const handlers = renderTray(five());
    act(() => cards()[2]?.focus());
    fireEvent.keyDown(cards()[2] as HTMLElement, { key: "Delete" });
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
    expect(handlers.onRemove).toHaveBeenCalledWith("c");
    expect(activeCardIndex()).toBe(3);
    expect(handlers.returnFocus).not.toHaveBeenCalled();
  });

  it("Backspace 도 같다", () => {
    const handlers = renderTray(five());
    act(() => cards()[0]?.focus());
    fireEvent.keyDown(cards()[0] as HTMLElement, { key: "Backspace" });
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
    expect(handlers.onRemove).toHaveBeenCalledWith("a");
    expect(activeCardIndex()).toBe(1);
  });

  it("마지막 카드에서는 앞 카드로 초점이 간다", () => {
    const handlers = renderTray(five());
    act(() => cards()[4]?.focus());
    fireEvent.keyDown(cards()[4] as HTMLElement, { key: "Delete" });
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
    expect(handlers.onRemove).toHaveBeenCalledWith("e");
    expect(activeCardIndex()).toBe(3);
  });

  it("하나뿐인 카드를 빼면 초점이 글 칸으로 간다(returnFocus)", () => {
    const handlers = renderTray([file("solo", "하나.mp4")]);
    act(() => cards()[0]?.focus());
    fireEvent.keyDown(cards()[0] as HTMLElement, { key: "Delete" });
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
    expect(handlers.onRemove).toHaveBeenCalledWith("solo");
    expect(handlers.returnFocus).toHaveBeenCalledOnce();
  });

  it("Delete 는 초점이 없는 카드나 수정 키가 눌린 키는 건드리지 않는다", () => {
    const handlers = renderTray(five());
    fireEvent.keyDown(cards()[1] as HTMLElement, { key: "Delete", metaKey: true });
    fireEvent.keyDown(cards()[1] as HTMLElement, { key: "Backspace", altKey: true });
    fireEvent.keyDown(cards()[1] as HTMLElement, { key: "Delete", ctrlKey: true });
    fireEvent.keyDown(cards()[1] as HTMLElement, { key: "Delete", shiftKey: true });
    expect(handlers.onRemove).not.toHaveBeenCalled();
  });

  it("←/→/Home/End 로 카드 사이를 옮기고 끝에서 돌지 않는다", () => {
    renderTray(five());
    act(() => cards()[1]?.focus());
    fireEvent.keyDown(cards()[1] as HTMLElement, { key: "ArrowRight" });
    expect(activeCardIndex()).toBe(2);
    fireEvent.keyDown(cards()[2] as HTMLElement, { key: "End" });
    expect(activeCardIndex()).toBe(4);
    fireEvent.keyDown(cards()[4] as HTMLElement, { key: "ArrowRight" });
    expect(activeCardIndex()).toBe(4);
    fireEvent.keyDown(cards()[4] as HTMLElement, { key: "Home" });
    expect(activeCardIndex()).toBe(0);
    fireEvent.keyDown(cards()[0] as HTMLElement, { key: "ArrowLeft" });
    expect(activeCardIndex()).toBe(0);
  });

  it("카드 줄의 키는 카드 안 단추(다시 시도)의 것이 아니다", () => {
    const failed = failUpload([draftFor("f", { name: "x.log", mime: "text/plain", sizeBytes: 10 })], "f", "unavailable");
    const handlers = renderTray(failed);
    const retry = screen.getByTestId("attachment-chip-retry");
    act(() => retry.focus());
    fireEvent.keyDown(retry, { key: "Delete" });
    expect(handlers.onRemove).not.toHaveBeenCalled();
  });
});

describe("마우스로 ×를 눌러 빼기", () => {
  it("초점이 그 카드(×) 안에 있으면 글 칸으로 돌려준다: 옆 카드로 가면 Backspace 한 번에 다음 첨부가 지워진다", () => {
    const handlers = renderTray(five());
    const remove = screen.getAllByTestId("attachment-chip-remove")[1] as HTMLElement;
    act(() => remove.focus());
    fireEvent.click(remove);
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
    expect(handlers.onRemove).toHaveBeenCalledWith("b");
    expect(handlers.returnFocus).toHaveBeenCalledOnce();
    expect(activeCardIndex()).toBe(-1);
  });

  it("초점이 밖(글 칸 등)에 있으면 건드리지 않는다: 없던 초점을 만들지 않는다", () => {
    const outside = document.createElement("textarea");
    document.body.append(outside);
    outside.focus();
    const handlers = renderTray(five());
    fireEvent.click(screen.getAllByTestId("attachment-chip-remove")[2] as HTMLElement);
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
    expect(handlers.onRemove).toHaveBeenCalledWith("c");
    expect(handlers.returnFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe("올리는 중·실패", () => {
  it("실패한 카드는 failed 모양이고 ×가 늘 보이도록 표시된다", () => {
    const failed = failUpload([draftFor("f", { name: "x.log", mime: "text/plain", sizeBytes: 10 })], "f", "mismatch");
    renderTray(failed);
    expect(cards()[0]?.getAttribute("data-card-shape")).toBe("failed");
    expect(screen.getByTestId("attachment-chip-remove").hasAttribute("data-always-visible")).toBe(true);
    expect(screen.getByTestId("attachment-chip-status").textContent).toContain("올라간 파일이 고른 파일과 다릅니다");
  });

  it("실패한 카드에 되돌릴 값이 있으면 아이콘 다시 시도가 서고 이름이 낭독된다", () => {
    const failed = failUpload([draftFor("f", { name: "x.log", mime: "text/plain", sizeBytes: 10 })], "f", "mismatch");
    const handlers = renderTray(failed);
    const retry = screen.getByTestId("attachment-chip-retry");
    expect(retry.getAttribute("aria-label")).toBe(ATTACH_COPY.retry);
    expect(retry.textContent).toBe("");
    fireEvent.click(retry);
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
    expect(handlers.onRetry).toHaveBeenCalledWith("f");
  });

  it("되돌릴 값이 없는 실패(상한 초과)에는 다시 시도가 없고 다음 행동이 문장에 있다", () => {
    const huge = draftFor("h", { name: "huge.bin", mime: "application/octet-stream", sizeBytes: 101 * 1024 * 1024 });
    renderTray([huge]);
    expect(screen.queryByTestId("attachment-chip-retry")).toBeNull();
    const status = screen.getByTestId("attachment-chip-status").textContent ?? "";
    expect(status).toContain("100MB를 초과함");
    expect(status).toContain("더 작은 파일을 고르세요");
  });

  it("올라가는 중인 파일 카드는 진행 막대와 「크기 · 낱말」을 보이고, 끝나면 크기만 보인다", () => {
    const uploading: AttachmentDraft = {
      ...draftFor("u", { name: "큰-영상.mp4", mime: "video/mp4", sizeBytes: 4_400_000 }),
      status: "uploading",
      progress: 0.42,
    };
    const { rerender } = render(
      <LocaleProvider locale={locale}>
        <AttachmentTray drafts={[uploading]} rejected={0} folders={0} onRemove={vi.fn()} onRetry={vi.fn()} onClear={vi.fn()} onAcknowledgeNotices={vi.fn()} />
      </LocaleProvider>
    );
    expect(screen.getByTestId("attachment-chip-progress").getAttribute("value")).toBe("0.42");
    expect(screen.getByTestId("attachment-chip-status").textContent).toContain(ATTACH_COPY.uploading);
    expect(screen.getByTestId("attachment-chip-percent").textContent).toBe("42%");
    rerender(
      <LocaleProvider locale={locale}>
        <AttachmentTray drafts={[completeUpload([uploading], "u", "att-u")[0] as AttachmentDraft]} rejected={0} folders={0} onRemove={vi.fn()} onRetry={vi.fn()} onClear={vi.fn()} onAcknowledgeNotices={vi.fn()} />
      </LocaleProvider>
    );
    expect(screen.queryByTestId("attachment-chip-progress")).toBeNull();
    const visible = within(screen.getByTestId("attachment-chip-status")).getByText("4.2 MB");
    expect(visible.getAttribute("aria-hidden")).toBe("true");
  });

  it("막힘 안내 줄은 비어도 자리를 지킨다(공백 한 칸) — 사라지면서 대화를 밀지 않는다", () => {
    renderTray(five());
    const blocked = screen.getByTestId("attachment-blocked");
    expect(blocked.hasAttribute("data-block-reason")).toBe(false);
    expect(blocked.textContent).toBe(" ");
  });
});

describe("알림과 모두 지우기", () => {
  it("20개를 넘긴 수는 짧은 한 문장으로 말하고, 확인으로 끈다", () => {
    const handlers = renderTray(five(), { rejected: 13 });
    const notice = screen.getByTestId("attachment-rejected");
    expect(notice.textContent).toContain("13개는 한 메시지의 상한(20개)을 넘어 넣지 못했습니다.");
    fireEvent.click(within(notice).getByRole("button", { name: "확인" }));
    expect(handlers.onAcknowledgeNotices).toHaveBeenCalledOnce();
  });

  it("폴더 알림은 코어의 문장이다", () => {
    renderTray(five(), { folders: 1 });
    expect(screen.getByTestId("attachment-rejected").textContent).toContain(ATTACH_COPY.folderRejected);
  });

  it("카드가 없어도 폴더 알림은 선다(줄은 없고 알림만)", () => {
    renderTray([], { folders: 2 });
    expect(screen.queryByTestId("attachment-list-scroll")).toBeNull();
    expect(screen.getByTestId("attachment-rejected")).toBeTruthy();
  });

  it("「모두 지우기」는 넷부터이고 줄의 발치 오른쪽에 선다", () => {
    const handlers = renderTray(five());
    const clear = screen.getByTestId("attachment-clear");
    expect(clear.textContent).toBe(ATTACH_COPY.clearAll);
    expect(clear.parentElement?.contains(screen.getByTestId("attachment-blocked"))).toBe(true);
    fireEvent.click(clear);
    expect(handlers.onClear).toHaveBeenCalledOnce();
  });

  it("셋 이하에서는 모두 지우기가 없다", () => {
    renderTray(five().slice(0, 3));
    expect(screen.queryByTestId("attachment-clear")).toBeNull();
  });
});

describe("휠로 가로로 민다", () => {
  function wheel(list: HTMLElement, init: WheelEventInit): WheelEvent {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    act(() => {
      list.dispatchEvent(event);
    });
    return event;
  }

  function sizedList(): HTMLElement {
    renderTray(five());
    const list = screen.getByTestId("attachment-list-scroll");
    let left = 0;
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(list, "scrollWidth", { configurable: true, value: 900 });
    Object.defineProperty(list, "scrollLeft", { configurable: true, get: () => left, set: (v: number) => { left = v; } });
    return list;
  }

  it("세로 휠을 가로 이동으로 바꾸고 기본 동작을 막는다", () => {
    const list = sizedList();
    const event = wheel(list, { deltaY: 120 });
    expect(list.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it("끝에서는 가로채지 않는다(휠은 원래 자리로 간다)", () => {
    const list = sizedList();
    list.scrollLeft = 600;
    const event = wheel(list, { deltaY: 100 });
    expect(list.scrollLeft).toBe(600);
    expect(event.defaultPrevented).toBe(false);
  });

  it("가로 제스처·핀치(ctrl)는 그대로 둔다", () => {
    const list = sizedList();
    expect(wheel(list, { deltaX: 80, deltaY: 10 }).defaultPrevented).toBe(false);
    expect(wheel(list, { deltaY: 80, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(list.scrollLeft).toBe(0);
  });
});
