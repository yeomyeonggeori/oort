import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/design/lib/cn";
import { MODAL_CONTENT_MOTION, MODAL_OVERLAY_MOTION } from "@/design/motion";

// shadcn/ui new-york Dialog (vendored, Radix primitive). The palette already
// ships one dialog through cmdk's Command.Dialog, which wraps this same Radix
// root; a form dialog needs the root directly, so it is vendored here rather
// than hand-rolled (design-taste-web §1: reach for the primitive).
//
// House deviations from stock shadcn:
//   - no built-in ✕ button. A dialog here closes with Esc and with its own
//     trailing 취소 button, and a third affordance in the corner is the web-card
//     tell, not an accessibility gain.
//   - enter/exit is ADR-0179 D4 (open 200 / close 150) via motion.ts constants.
//     Radix Presence waits for the CSS animation on data-state=closed only when
//     Content stays mounted through close. `{open && <DialogContent/>}` unmounts
//     the Presence subtree first and the exit never plays. forceMount is not
//     added.

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export type DialogFocusTarget = Pick<HTMLElement, "isConnected" | "focus">;

/** Returns focus to a programmatic dialog's opener when it still exists. */
export function restoreDialogOpenerFocus(opener: DialogFocusTarget | null): boolean {
  if (!opener?.isConnected) return false;
  opener.focus();
  return true;
}

type DialogOpener =
  | DialogFocusTarget
  | null
  | React.RefObject<DialogFocusTarget | null>;

function resolveDialogOpener(opener: DialogOpener): DialogFocusTarget | null {
  if (opener && "current" in opener) return opener.current;
  return opener;
}

/**
 * Restores focus after Radix's trap `useEffect` cleanup and before its
 * `onCloseAutoFocus` `setTimeout(0)`. Layout is too early: the trap is still
 * listening and pulls the caret back into the unmounting panel. The timeout is
 * too late: Playwright sees `detached` on the next animation frame (#1865 H-3).
 */
export function useRestoreFocusOnClose(open: boolean, opener: DialogOpener): void {
  const wasOpen = React.useRef(false);
  const openerRef = React.useRef<DialogFocusTarget | null>(null);
  const resolved = resolveDialogOpener(opener);
  if (resolved) openerRef.current = resolved;
  React.useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    restoreDialogOpenerFocus(openerRef.current);
  }, [open]);
}

/**
 * The scrim. `bg-scrim`, not `bg-ink/20`: the overlay's job is to push the page
 * back, and ink is nearly white in dark mode, so borrowing it there brightened
 * the app and left the panel darker than its own surroundings. `--scrim`
 * darkens in both schemes and tokens.contrast.test.ts measures that it does.
 */
export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("fixed inset-0 bg-scrim scrim-blur", MODAL_OVERLAY_MOTION, className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * The panel. `dialog-panel` (tokens.css) caps its height at the window minus
 * the 32px inset it sits at, so a short window scrolls the panel body and never
 * the document (MOMO-610). Callers put the scrolling box inside.
 *
 * Its width is `max-w-pane-md` (512px), the same named measure the ⌘K palette
 * uses, because an overlay is a pane and a pane has a name. It used to be the
 * stock container scale, which is the same number wearing no name: width was
 * the one axis where a new surface could still take a dimension the token file
 * had never heard of (R2 M7, tokens.md §4). Naming the class in this comment
 * would be enough for Tailwind to emit it, so it is not named.
 *
 * Closing returns the caret to whatever opened the dialog. Radix's own
 * `onCloseAutoFocus` focuses `DialogTrigger`, and every dialog in this app is
 * opened programmatically (a sidebar button, a command palette item), so that
 * ref is null and focus fell to `<body>`: a keyboard reader who opened the form
 * from the sidebar + lost their place and had to Tab from the top of the
 * document. The opener is captured during the first render, before Radix's
 * focus scope has moved anything, and restored on the way out.
 */
export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** 닫힐 때 포커스를 돌려줄 엘리먼트. 생략하면 activeElement 추정으로 폴백한다. */
    opener?: DialogFocusTarget | null;
    /** 포털 목적지. 생략하면 document.body. */
    container?: HTMLElement | null;
  }
>(({ className, children, onCloseAutoFocus, opener, container, ...props }, ref) => {
  // `document.activeElement` 추정은 Chromium에서만 맞다. WebKit은 마우스 클릭으로
  // <button>에 포커스를 주지 않아 캡처값이 <body>가 되고, 닫힐 때 돌려줄 자리가
  // 사라진다 — 데스크톱 셸이 WKWebView이므로 배포 대상의 절반이 그쪽이다.
  // 호출부가 실제 엘리먼트를 알고 있으면 `opener`로 넘겨라. 추정은 폴백이다.
  const openerRef = React.useRef<HTMLElement | null>(null);
  if (openerRef.current === null && typeof document !== "undefined") {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }

  return (
    <DialogPortal container={container ?? undefined}>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "dialog-panel fixed left-1/2 top-8 flex w-full max-w-pane-md -translate-x-1/2 flex-col rounded-lg border border-line bg-surface-raised text-ink shadow-lg",
          MODAL_CONTENT_MOTION,
          className
        )}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const target = opener ?? openerRef.current;
          // preventDefault also skips Radix's own handler, which would send the
          // caret to a trigger that does not exist here.
          if (restoreDialogOpenerFocus(target)) {
            event.preventDefault();
          }
        }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

/**
 * 16px, and the description under it stays 14px. Naming a role and a color in
 * one `cn()` used to cost the role: tailwind-merge read `text-title` as a color
 * and kept only `text-ink`, so this title shipped at body size and the dialog
 * had no first line (R2 H1). The two axes are separated in design/lib/cn.ts and
 * asserted in cn.test.ts, which is why the pair below is safe to write.
 */
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-title font-semibold text-ink", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-body text-ink-muted", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
