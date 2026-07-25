import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/design/lib/cn";

// shadcn/ui new-york Button (vendored). Radix Slot lets it wrap links/etc.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-body font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-on-accent hover:opacity-90",
        secondary:
          "border border-line bg-surface-raised text-ink hover:bg-surface-hover",
        ghost: "text-ink hover:bg-surface-hover",
        destructive: "bg-danger text-on-danger hover:opacity-90",
        outline:
          "border border-line-strong bg-transparent text-ink hover:bg-surface-hover",
      },
      size: {
        default: "h-control px-4 py-2",
        sm: "h-control-sm px-3 text-meta",
        lg: "h-control-lg px-6",
        icon: "size-control",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { buttonVariants };
