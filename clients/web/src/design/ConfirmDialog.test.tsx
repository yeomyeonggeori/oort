// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CONFIRM_ARM_MS, ConfirmDialog, ConfirmStage } from "@/design/ui/confirm-dialog";

// #5780 — 공용 확인 창의 계약: 초점은 취소로, 위험 확정은 위험 채움, 진행 중에는 한 번만·닫히지 않음,
// 잠긴 까닭을 가리킴. 대화상자(처음 뜨는 창)와 단계(떠 있는 표면 안, §3.4)가 같은 몸이다.

afterEach(() => {
  cleanup();
});

const COPY = {
  title: "이서연 님의 역할을 바꿀까요?",
  confirmLabel: "역할 바꾸기",
  busyLabel: "바꾸는 중",
  cancelLabel: "취소",
  testId: "c",
};

function DialogHarness({ busy = false, onConfirm = () => {} }: { busy?: boolean; onConfirm?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <ConfirmDialog
        {...COPY}
        open={open}
        onOpenChange={setOpen}
        busy={busy}
        tone="destructive"
        warning="되돌릴 수 없어요."
        description="관리자 → 소유자"
        onConfirm={onConfirm}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("alertdialog 로 뜨고, 초점은 취소에 있고, 위험 확정은 위험 채움이다", async () => {
    render(<DialogHarness />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(COPY.title);
    expect(dialog.getAttribute("aria-describedby")).not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("c-cancel")));
    expect(screen.getByTestId("c-confirm").dataset.tone).toBe("destructive");
    expect(screen.getByTestId("c-confirm").className).toContain("bg-danger-fill");
    expect(screen.getByTestId("c-warning").textContent).toBe("되돌릴 수 없어요.");
  });

  it("취소는 닫는다", () => {
    render(<DialogHarness />);
    fireEvent.click(screen.getByTestId("c-cancel"));
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("진행 중에는 확정이 진행 낱말이고 다시 눌러도 부르지 않으며 Esc 가 닫지 않는다", () => {
    const onConfirm = vi.fn();
    render(<DialogHarness busy onConfirm={onConfirm} />);
    const confirm = screen.getByTestId("c-confirm");
    expect(confirm.textContent).toBe("바꾸는 중");
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("진행 중에는 취소도 잠긴다: aria-disabled 이고 눌러도 닫히지 않는다(요청이 이미 나갔다, #5780 검수 r1 H1)", () => {
    render(<DialogHarness busy />);
    const cancel = screen.getByTestId("c-cancel");
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cancel);
    expect(screen.getByTestId("state").textContent).toBe("open");
  });
});

describe("ConfirmStage", () => {
  it("진행 중에는 취소가 aria-disabled 이고 눌러도 부르지 않는다. 오프라인 잠김(lockedReason)만으로는 취소가 잠기지 않는다", () => {
    const onCancel = vi.fn();
    const { rerender } = render(<ConfirmStage {...COPY} busy onConfirm={() => {}} onCancel={onCancel} autoFocus={false} />);
    const cancel = screen.getByTestId("c-cancel");
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancel);
    expect(onCancel).not.toHaveBeenCalled();
    rerender(<ConfirmStage {...COPY} lockedReason="오프라인" onConfirm={() => {}} onCancel={onCancel} autoFocus={false} />);
    expect(screen.getByTestId("c-cancel").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByTestId("c-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("표면 안의 단계: 대화상자를 더 세우지 않고, 초점은 취소, 잠긴 까닭을 가리키며 확정을 막는다", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmStage
        {...COPY}
        description="멤버 → 관리자"
        lockedReason="오프라인이라 지금은 바꿀 수 없어요."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    const stage = screen.getByTestId("c");
    expect(stage.getAttribute("role")).toBe("group");
    expect(document.getElementById(stage.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(COPY.title);
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("c-cancel")));
    const confirm = screen.getByTestId("c-confirm");
    expect(confirm.dataset.tone).toBe("default");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(confirm.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "오프라인이라 지금은 바꿀 수 없어요."
    );
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("c-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// #5781 · #5818 검수 High: 메뉴 줄·관리 줄을 누른 자리에 위험 확정 단추가 서면, 더블클릭·떨리는 손의 둘째 누름(250~400ms 뒤)이
// 그대로 확정을 눌렀다. 확정은 선 뒤 `CONFIRM_ARM_MS` 동안 누름·Enter·Space 를 받지 않고, 취소는 처음부터 받는다.
describe("확정의 첫 반 초 (#5781)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["stage", "dialog"] as const)("%s: 서자마자·250·400 밀리초의 누름·Enter·Space 는 확정을 부르지 않고, 모양은 그대로이며, 시간이 지나면 받는다", (host) => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    if (host === "stage") {
      render(<ConfirmStage {...COPY} tone="destructive" onConfirm={onConfirm} onCancel={onCancel} />);
    } else {
      render(<DialogHarness onConfirm={onConfirm} />);
    }
    expect(CONFIRM_ARM_MS).toBe(500);
    const confirm = screen.getByTestId("c-confirm");
    const look = { className: confirm.className, disabled: confirm.getAttribute("aria-disabled") };
    for (const at of [0, 250, 400]) {
      act(() => {
        vi.advanceTimersByTime(at === 0 ? 0 : at - (at === 400 ? 250 : 0));
      });
      fireEvent.pointerDown(confirm);
      fireEvent.click(confirm);
      const enter = fireEvent.keyDown(confirm, { key: "Enter" });
      const space = fireEvent.keyUp(confirm, { key: " " });
      expect(onConfirm).not.toHaveBeenCalled();
      // Enter·Space 의 기본 동작(단추 누름)도 막는다.
      expect(enter).toBe(false);
      expect(space).toBe(false);
      // 눈과 보조기술에는 평소 모양 그대로다(흐림·잠김 표시 없음).
      expect({ className: confirm.className, disabled: confirm.getAttribute("aria-disabled") }).toEqual(look);
    }
    act(() => {
      vi.advanceTimersByTime(CONFIRM_ARM_MS - 400);
    });
    expect(confirm.dataset.armed).toBe("true");
    expect(fireEvent.keyDown(confirm, { key: "Enter" })).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("취소는 처음부터 받는다", () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    render(<ConfirmStage {...COPY} tone="destructive" onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("c-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
