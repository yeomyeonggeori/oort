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
        // 파괴 채움은 --danger가 아니라 --danger-fill이다(MOMO-642 R1 H-2). 위험
        // 위계의 자(채도)가 전경 톤만 다스리는 동안 이 한 줄이 그 자 바깥에
        // 있었고, 그래서 `설치 해제`가 주 버튼 `내 사용 허용`보다 채도가 높아
        // 파괴 보조가 주 액션을 이겼다. 채움 순서(accent > danger-fill)도 이제
        // 토큰에서 재진다 — tokens.css의 --danger-fill 주석과 tokens.contrast의
        // "ranks the primary action fill above the destructive fill" 참조.
        destructive: "bg-danger-fill text-on-danger-fill hover:opacity-90",
        outline:
          "border border-line-strong bg-transparent text-ink hover:bg-surface-hover",
      },
      // 폰에서 44px가 되는 것은 **폼의 1급 버튼**뿐이다 (goal P3 1-4).
      //
      // `default`와 `lg`는 폼이 착지하는 자리다 — 로그인의 [로그인], 다이얼로그의
      // [지우기]. 거기서 32px는 Apple HIG의 44pt에 못 미치고, 오터치의 대가가 가장
      // 큰 버튼이 가장 작다는 뜻이 된다. `tap-target`은 600px 미만에서만 자라므로
      // (tokens.css) 데스크탑의 32px 밀도는 그대로다.
      //
      // `sm`과 `icon`은 일부러 두고 간다. 그 둘은 툴바·행 안의 조밀한 보조
      // 컨트롤이고, 폰에서 44px가 필요한 자리는 이미 각자 `tap-target`을 자기
      // className에 달고 있다(사이드바의 아이콘 버튼들). 여기서 일괄로 키우면
      // 그 판단이 필요한 자리와 아닌 자리가 구분되지 않고, 폰의 행 높이만
      // 전부 올라간다 — 이번 범위는 폼이지 전 앱이 아니다.
      size: {
        default: "tap-target h-control px-4 py-2",
        sm: "h-control-sm px-3 text-meta",
        lg: "tap-target h-control-lg px-6",
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
