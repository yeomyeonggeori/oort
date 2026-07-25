import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/design/lib/cn";

// shadcn/ui new-york Dialog (vendored, Radix primitive). The palette already
// ships one dialog through cmdk's Command.Dialog, which wraps this same Radix
// root; a form dialog needs the root directly, so it is vendored here rather
// than hand-rolled (design-taste-web §1: reach for the primitive).
//
// Two house deviations from stock shadcn, both deliberate:
//   - no built-in ✕ button. A dialog here closes with Esc and with its own
//     trailing 취소 button, and a third affordance in the corner is the web-card
//     tell, not an accessibility gain.
//   - no enter/exit animation. Motion is feedback (§4), and a dialog appearing
//     where the click was is already the feedback.

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("fixed inset-0 bg-ink/20", className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * The panel. `dialog-panel` (tokens.css) caps its height at the window minus
 * the 32px inset it sits at, so a short window scrolls the panel body and never
 * the document (MOMO-610). Callers put the scrolling box inside.
 */
export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "dialog-panel fixed left-1/2 top-8 flex w-full max-w-lg -translate-x-1/2 flex-col rounded-lg border border-line bg-surface-raised text-ink shadow-lg",
        className
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

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
