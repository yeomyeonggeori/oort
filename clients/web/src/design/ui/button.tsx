import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/design/lib/cn";

// shadcn/ui new-york Button (vendored). Radix Slot lets it wrap links/etc.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-body font-medium press focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // 채움이 --accent 라 인셋 focus-ring 이 --accent 면 amber-on-amber 로 사라진다
        // (design-review High). focus-ring-on-fill 이 링을 --on-accent 로 돌린다.
        default: "bg-accent text-on-accent hover:opacity-90 focus-ring-on-fill",
        // 경계는 --line 이었다 (#1210 D1). --line 은 **나누는** 선이고
        // --line-strong 이 **컨트롤을 그리는** 선이라고 tokens.css:33-34 가 이미
        // 적어 두었는데, 이 한 줄만 그 규칙 밖에 있었다. 실측:
        //
        //   경계 --line on --surface          라이트 1.32:1 · 다크 1.43:1
        //   채움 --surface-raised on --surface 라이트 1.07:1 · 다크 1.10:1
        //
        // WCAG 1.4.11 은 「채움이 컨트롤을 식별시키면 경계는 면제」인데 그 채움이
        // 1.07:1 이라 아무것도 식별시키지 않는다. 즉 **경계도 채움도 3:1 이 아닌
        // 버튼**이었고, 바로 아래 형제 `outline`(--line-strong, 3.59/3.56:1)이
        // 같은 모양으로 그 규칙을 지키고 있었다. 대비 수리에서 이런 자리를 고르는
        // 자가 없어서 리뷰가 매번 픽셀 샘플링으로 찾아냈다(#1205 리뷰 H1 이
        // 만난 값이 여기다 — 삭제 다이얼로그의 [취소]가 이 변형이다).
        //
        // 고치는 축이 **명도**인 이유: 위험 위계의 자는 채도이고(tokens.css 의
        // --danger 주석) 그 자가 다스리는 것은 전경 톤이다. --line-strong 은
        // 무채색이라 그 순서에 끼어들지 않는다 — 파괴>주>보조 위계는 채움이
        // 그대로 진다(--danger-fill 7.02/6.42:1 > --accent 5.34/8.94:1 >>
        // --surface-raised 1.07/1.10:1). 보조가 얻는 것은 목소리가 아니라 윤곽이다.
        //
        // `outline` 과 남는 차이는 **채움의 고도**다: 이 변형은 종이 한 단 위에
        // 서고(bg-surface-raised) `outline` 은 자기가 놓인 표면을 그대로 보인다.
        // 그 차이가 두 이름이 뜻하는 전부이고, 경계는 이제 둘 다 같은 규칙이다.
        secondary:
          "border border-line-strong bg-surface-raised text-ink hover:bg-surface-hover",
        ghost: "text-ink hover:bg-surface-hover",
        // 파괴 채움은 --danger가 아니라 --danger-fill이다(MOMO-642 R1 H-2). 위험
        // 위계의 자(채도)가 전경 톤만 다스리는 동안 이 한 줄이 그 자 바깥에
        // 있었고, 그래서 `설치 해제`가 주 버튼 `내 사용 허용`보다 채도가 높아
        // 파괴 보조가 주 액션을 이겼다. 채움 순서(accent > danger-fill)도 이제
        // 토큰에서 재진다 — tokens.css의 --danger-fill 주석과 tokens.contrast의
        // "ranks the primary action fill above the destructive fill" 참조.
        // default 와 같은 이유: 채움 위 인셋 링이 사라지지 않게 --on-danger-fill(값이
        // --on-accent 와 같다)로. focus-ring-on-fill 이 그 대비색을 세운다.
        destructive:
          "bg-danger-fill text-on-danger-fill hover:opacity-90 focus-ring-on-fill",
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

/** DS-2 red proof: a new ui/ export must turn the gallery test red. */
export function GalleryDummyProbe() {
  return null;
}

export { buttonVariants };
