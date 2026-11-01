// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dismissTemporarySurfaces } from "@momo/core/features/notifications/entryDismiss";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";

// 알림이 새 입구로 들어오면(#4667) 열려 있던 대화상자가 걷힌다. 앱의 대화상자 쉰다섯이 모두 `design/ui/dialog.tsx` 의 이 Root 라 구독은 거기 하나다.
// (이 시험은 `design/ui/` 가 아니라 `design/` 에 둔다 — 그 디렉터리의 새 파일은 `controlBorders.test.ts`·`designSystem.test.ts` 가 프리미티브로 센다.)
// 걷는 길은 Esc 와 같은 `onOpenChange(false)` 다 — 대화상자가 스스로 거절하는 규칙(저장 중에는 닫지 않음)도 그대로 지켜진다.

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
});

function mount(element: ReactElement): void {
  mountedHost = document.createElement("div");
  document.body.append(mountedHost);
  mountedRoot = createRoot(mountedHost);
  act(() => mountedRoot?.render(element));
}

const panel = () => document.querySelector('[role="dialog"]');

function Body() {
  return createElement(
    DialogContent,
    null,
    createElement(DialogTitle, null, "시험 대화상자"),
    createElement(DialogDescription, null, "알림 입구 시험")
  );
}

/** 제어되는 대화상자. 닫기 요청을 `onOpenChange` 로 받아 `refuse` 가 참이면 거절한다(저장 중에는 닫지 않는 대화상자처럼). */
function Controlled({ onOpenChange, refuse = false }: { onOpenChange: (open: boolean) => void; refuse?: boolean }) {
  const [open, setOpen] = useState(true);
  return createElement(
    Dialog,
    {
      open,
      onOpenChange: (next: boolean) => {
        onOpenChange(next);
        if (!next && refuse) return;
        setOpen(next);
      },
    },
    createElement(Body)
  );
}

const enter = () =>
  act(() => {
    dismissTemporarySurfaces();
  });

describe("Dialog — 알림 입구가 걷는다 (#4667)", () => {
  it("열려 있는 제어 대화상자는 `onOpenChange(false)` 로 닫힌다 — 한 번만, 그리고 닫힌 뒤에는 다시 묻지 않는다", () => {
    const onOpenChange = vi.fn();
    mount(createElement(Controlled, { onOpenChange }));
    expect(panel()).not.toBeNull();

    enter();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(panel()).toBeNull();

    enter();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("처음부터 닫혀 있는 대화상자에는 아무것도 묻지 않는다", () => {
    const onOpenChange = vi.fn();
    mount(createElement(Dialog, { open: false, onOpenChange }, createElement(Body)));
    enter();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it("비제어(`defaultOpen`) 대화상자도 닫힌다 — 상태를 이 Root 가 쥔다", () => {
    mount(createElement(Dialog, { defaultOpen: true }, createElement(Body)));
    expect(panel()).not.toBeNull();
    enter();
    expect(panel()).toBeNull();
  });

  it("스스로 거절하는 대화상자는 거절한 채 열려 있다 — Esc 와 같은 문이라 규칙이 그대로다", () => {
    const onOpenChange = vi.fn();
    mount(createElement(Controlled, { onOpenChange, refuse: true }));
    enter();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(panel()).not.toBeNull();
  });
});
