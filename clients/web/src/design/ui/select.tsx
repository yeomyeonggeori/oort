import * as React from "react";
import { cn } from "@/design/lib/cn";

// The platform's own select, not a Radix/shadcn Select (design-taste-web §1
// asks for a one-line reason when a primitive is not used, and here the reason
// runs the other way: the primitive IS `<select>`).
//
// @radix-ui/react-select is not in this client's dependency set, and what it
// would buy is a custom-drawn listbox. What it would cost is the one thing this
// control needs most: the OS picker. These menus carry model handles and effort
// levels, they are read on a laptop and inside the Tauri shell, and the native
// popup already ships type-ahead, keyboard traversal, and a hit target the OS
// keeps usable at any window size. A hand-rolled listbox re-implements all of
// that, and re-implements it in JS on a surface where the composer must not
// lose the caret.
//
// Styling stays on the box only. The popup is OS-drawn and takes no classes;
// that is the trade, and it is the right one here.
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-control w-full min-w-0 rounded-sm border border-line-strong bg-surface px-2 text-body text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";
