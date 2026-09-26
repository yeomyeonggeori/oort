import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/design/lib/cn";

// shadcn/ui new-york Button (vendored). Radix Slot lets it wrap links/etc.
//
// 새벽하늘 채움 알약 (ADR-0189 D1·D6, DS2-1 #2713). 모양은 시안 A `.a-pill`을
// 그대로 옮겼다: 높이 38, 가로 여백 15, 14px 700, 반경 pill. 버튼은 테두리가
// 아니라 **채움**으로 자기를 말한다 — 3:1 테두리는 텍스트 입력 그릇에만 남는다
// (디자인 시스템 §2.2 개정). 위계는 채움이 진다:
//
//   default      잉크 채움(--primary). 주 행동. 커스텀 신호색이 바꾸지 않는다.
//   destructive  --danger-fill 채움. 무겁되 기본 경로가 아니다(§3.1).
//   secondary    --surface-muted 채움(시안 `.a-pill.sec`). 보조.
//   outline      secondary와 같은 채움 알약. 옛 이름을 쓰는 121곳이 테두리 없이
//                보조로 옮겨 온다(ADR-0189 D6: outline 테두리는 입력 그릇에만).
//   ghost        채움 없음, hover에서만 --surface-hover. 툴바의 조용한 행동.
//
// 채움 위 인셋 포커스 링은 채움의 전경색이다: 잉크 채움은 focus-ring-on-primary
// (--on-primary), 파괴 채움은 focus-ring-on-fill(--on-accent, 값이 --on-danger-fill과
// 같다). 신호색 링이 채움 가장자리에 붙어 사라지지 않게 한다(design-review High).
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-body font-bold press focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-on-primary hover:opacity-90 focus-ring-on-primary",
        secondary: "bg-surface-muted text-ink hover:bg-surface-hover",
        ghost: "text-ink hover:bg-surface-hover",
        destructive:
          "bg-danger-fill text-on-danger-fill hover:opacity-90 focus-ring-on-fill",
        outline: "bg-surface-muted text-ink hover:bg-surface-hover",
      },
      // 폰에서 44px가 되는 것은 **폼의 1급 버튼**뿐이다 (goal P3 1-4).
      //
      // `default`와 `lg`는 폼이 착지하는 자리다 — 로그인의 [로그인], 다이얼로그의
      // [지우기]. `tap-target`은 600px 미만에서만 자라므로(tokens.css) 데스크탑의
      // 시안 기하(38)는 그대로다.
      //
      // `sm`과 `icon`은 툴바·행 안의 조밀한 보조 컨트롤이고, 폰에서 44px가 필요한
      // 자리는 이미 각자 `tap-target`을 자기 className에 달고 있다.
      //
      // `icon`은 원형 아이콘 버튼이다(시안 `.a-send`·`.a-cbtn`, 34). 채움 변형과
      // 함께 쓰면 보내기 버튼, ghost와 함께 쓰면 헤더 아이콘이다.
      size: {
        default: "tap-target h-pill px-pill-inline",
        sm: "h-control-sm px-3 text-meta",
        lg: "tap-target h-control-lg px-6",
        icon: "size-icon-button",
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
