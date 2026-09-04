// @vitest-environment jsdom

import {
  act,
  createElement,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "./dialog";

/**
 * UX-R1b R4 H-1 — Radix OverlayImpl writes `pointer-events: auto` inline
 * (`style: { pointerEvents: "auto", ...overlayProps.style }`), so
 * `data-[state=closed]:pointer-events-none` never takes effect. The overlay
 * must own the same property from `open` / `data-state`. Restoring the R3
 * class-only overlay (no inline assignment) leaves this case red.
 */

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function Host({
  initialOpen,
  overlay,
}: {
  initialOpen: boolean;
  overlay: "content" | "force-held";
}) {
  const [open, setOpen] = useState(initialOpen);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "close-dialog",
        onClick: () => setOpen(false),
      },
      "닫기"
    ),
    createElement(
      Dialog,
      { open, onOpenChange: setOpen },
      overlay === "content"
        ? createElement(
            DialogContent,
            null,
            createElement(DialogTitle, null, "채널 만들기")
          )
        : createElement(
            DialogPortal,
            { forceMount: true },
            createElement(DialogOverlay, {
              forceMount: true,
              "data-testid": "probe-overlay",
            } as ComponentPropsWithoutRef<typeof DialogOverlay> & {
              "data-testid": string;
            }),
            createElement(
              DialogPrimitive.Content,
              { forceMount: true },
              createElement(DialogTitle, null, "채널 만들기")
            )
          )
    )
  );
}

async function mount(overlay: "content" | "force-held"): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(Host, {
    initialOpen: true,
    overlay,
  });
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

function overlayNode(host: HTMLElement): HTMLElement | null {
  return (
    (host.ownerDocument.querySelector(
      "[data-testid='probe-overlay']"
    ) as HTMLElement | null) ??
    (host.ownerDocument.querySelector(".bg-scrim") as HTMLElement | null)
  );
}

describe("DialogOverlay closed pointer-events (#1997 H-1)", () => {
  it("inline pointer-events is none while data-state=closed (class-only is red)", async () => {
    const host = await mount("force-held");
    const openOverlay = overlayNode(host);
    expect(openOverlay).not.toBeNull();
    expect(openOverlay?.getAttribute("data-state")).toBe("open");
    expect(openOverlay?.style.pointerEvents).not.toBe("none");

    await act(async () => {
      (host.querySelector("[data-testid='close-dialog']") as HTMLButtonElement).click();
    });

    const closed = overlayNode(host);
    expect(closed).not.toBeNull();
    expect(closed?.getAttribute("data-state")).toBe("closed");
    // Inline is the layer Radix writes. A closed class cannot beat it; this
    // assertion is red if the primitive only keeps
    // `data-[state=closed]:pointer-events-none`.
    expect(closed?.style.pointerEvents).toBe("none");
    expect(getComputedStyle(closed as HTMLElement).pointerEvents).toBe("none");
  });

  it("DialogContent (R1a house path) inherits the same closed overlay", async () => {
    const host = await mount("content");
    expect(overlayNode(host)?.getAttribute("data-state")).toBe("open");

    await act(async () => {
      (host.querySelector("[data-testid='close-dialog']") as HTMLButtonElement).click();
    });

    const closed = overlayNode(host);
    if (closed === null) {
      // Presence may detach immediately in jsdom without a CSS animation.
      // The force-held case above is the closed-window assertion; this path
      // still proves DialogContent mounts the same DialogOverlay.
      return;
    }
    expect(closed.getAttribute("data-state")).toBe("closed");
    expect(closed.style.pointerEvents).toBe("none");
  });
});
