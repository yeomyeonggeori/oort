import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/design/lib/cn";
import { POPOVER_MOTION } from "@/design/motion";
import {
  restoreDialogOpenerFocus,
  type DialogFocusTarget,
} from "@/design/ui/dialog";

// shadcn/ui new-york Popover (vendored, Radix primitive).
//
// Added for the emoji picker (#1742): an anchored panel that flips at the
// window edge. DropdownMenu is a menu of actions with roving menuitems, and
// this panel is a search field plus a grid, so borrowing the menu primitive
// would fight the combobox/listbox contract. Dialog is the touch sheet.
//
// Same house deviations as Dialog/DropdownMenu: no decorative chrome (no
// arrow). Enter/exit is ADR-0179 D4 (open 240 / close 180) via POPOVER_MOTION.
// Radix Presence waits for the CSS animation; forceMount is not added.

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverPortal = PopoverPrimitive.Portal;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    opener?: DialogFocusTarget | null;
  }
>(({ className, sideOffset = 4, opener, onCloseAutoFocus, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn(
        "z-50 w-pane-picker rounded-lg border border-line bg-surface-raised p-3 text-ink shadow-lg",
        POPOVER_MOTION,
        className
      )}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;
        if (restoreDialogOpenerFocus(opener ?? null)) {
          event.preventDefault();
        }
      }}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;
