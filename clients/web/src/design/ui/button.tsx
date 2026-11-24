import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
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
//   outline      **옛 이름 — 새 코드는 secondary를 쓴다.** secondary와 같은 채움
//                알약이고, 옛 이름을 쓰던 자리가 테두리 없이 보조로 옮겨 왔다(ADR-0189 D6:
//                outline 테두리는 입력 그릇에만). 남은 쓰임을 걷는 일은 DS-13.
//   ghost        채움 없음, hover에서만 --surface-hover. 툴바의 조용한 행동.
//
// 채움 위 인셋 포커스 링은 채움의 전경색이다: 잉크 채움은 focus-ring-on-primary
// (--on-primary), 파괴 채움은 focus-ring-on-fill(--on-accent, 값이 --on-danger-fill과
// 같다). 신호색 링이 채움 가장자리에 붙어 사라지지 않게 한다(design-review High).
//
// 종류 · 크기 · 상태 규격(「언제 무엇」 포함)의 정본은 docs/design-system/components.md
// 「단추」 절이다. 아래 변형 표의 이름과 그 절 표의 이름은 buttonSpec.test.tsx가 대조한다.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-label font-bold press focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
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
  /**
   * 「진행 중」 상태(DS-05 #6074). 돌림 표시가 글자 앞에 서고(원형 `icon` 크기는
   * 글리프 자리를 돌림 표시가 대신한다), 흐려지지 않고, 누름이 전달되지 않는다
   * (`onClick` · 폼 제출 0회). `disabled`가 아니라서 초점은 그 자리에 남는다.
   * 낱말(「저장 중」 등)은 부르는 쪽이 children으로 넘긴다 — 부품은 글을 박지 않는다.
   */
  busy?: boolean;
}

/** 진행 중에는 올림 · 눌림 시각이 서지 않는다: 변형이 단 hover:* 와 `press`를 뺀다. */
function withoutPressFeedback(classes: string): string {
  return classes
    .split(" ")
    .filter((token) => token !== "press" && !token.startsWith("hover:"))
    .join(" ");
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, busy = false, onClick, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    if (!busy) {
      return (
        <Comp
          ref={ref}
          className={cn(buttonVariants({ variant, size, className }))}
          onClick={onClick}
          {...props}
        >
          {children}
        </Comp>
      );
    }
    const spinner = <Loader2 aria-hidden="true" className="spinner-busy" data-button-busy-spinner="" />;
    return (
      <Comp
        ref={ref}
        className={cn(withoutPressFeedback(buttonVariants({ variant, size })), className)}
        aria-busy="true"
        aria-disabled="true"
        data-busy=""
        {...props}
        onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
          // 마우스 · Enter · Space · 폼의 암묵 제출이 모두 이 click 하나로 온다.
          // 기본 동작(제출 · 링크 이동)까지 막아야 「누름 0회」다. 부르는 쪽의 onClick이
          // 하던 stopPropagation도 함께 빠지므로, 줄 전체가 누르는 자리 안의 단추가 줄을
          // 대신 누르지 않게 여기서 멈춘다.
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {spinner}
        {/* 원형 `icon`은 글리프 자리를 돌림 표시가 대신한다(34 안에 둘이 서지 않는다).
            asChild는 Slot이 Slottable을 직접 자식으로 찾아야 해서 조각으로 감싸지 않는다. */}
        {size === "icon" && !asChild ? null : <Slottable>{children}</Slottable>}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { buttonVariants };
