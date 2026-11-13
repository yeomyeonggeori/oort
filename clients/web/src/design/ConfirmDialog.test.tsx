// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog, ConfirmStage } from "@/design/ui/confirm-dialog";

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
});

describe("ConfirmStage", () => {
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
