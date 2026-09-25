import * as React from "react";
import { cn } from "@/design/lib/cn";

// `tap-target` (goal P3 1-4). `--spacing-control`은 32px이고 그 값은 옳다 —
// 포인터에게 32px 칸은 정확한 밀도이고, 그 토큰을 44px로 올리면 설정·에이전트
// 허브의 폼이 데스크탑에서 한 화면에 들어가지 않는다. 그래서 토큰이 아니라 **이
// 컨트롤**이 폭에 따라 자란다: `tap-target`은 600px 미만에서만 min-block-size를
// 44px로 세우므로(tokens.css) 넓은 창의 기하는 한 px도 움직이지 않는다.
//
// 입력 칸이 첫 번째인 이유: 로그인은 폰에서 가장 먼저 만나는 화면이고, 거기서
// 잘못 눌린 칸은 "이 앱은 내 손가락을 못 받는다"는 첫인상이 된다. WCAG 2.5.8
// AA(24×24)는 32px도 통과하지만 Apple HIG의 44pt는 통과하지 못한다.
//
// 새벽하늘 (ADR-0189 D6, DS2-1 #2713): 3:1 테두리(--line-strong)가 남는 유일한
// 컨트롤이 이 텍스트 입력 그릇이다. 기하는 시안 A 사이드바 검색 `.a-search`의
// 높이 36을 따르고, 반경은 웹 사다리의 「행·입력」 14다(시안 값 12는 사다리 밖).
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        "tap-target flex h-field w-full rounded-lg border border-line-strong bg-transparent px-3 py-1 text-body text-ink transition-colors placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});
Input.displayName = "Input";
