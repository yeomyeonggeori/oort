import * as React from "react";
import { cn } from "@/design/lib/cn";
import { TOOLTIP_DELAY_MS, TOOLTIP_MOTION } from "@/design/motion";

// 공용 툴팁 (#4324). Buzz `shared/ui/tooltip.tsx`의 동작을 우리 토큰으로 옮긴 것이다.
//
// Radix Tooltip을 쓰지 않는 이유: 의존을 새로 들이지 않고(NOTICE·잠금 파일), 이 코드베이스의
// 줄 도구 막대는 이미 자기 로빙 그룹(`data-row-action`)을 가져 래퍼가 포커스를 가져가면 안 된다.
// 래퍼는 포커스도 탭 정거장도 만들지 않는 `span`이고, 트리거는 자식 그대로다.
//
// 동작
//   · 가리키면 `TOOLTIP_DELAY_MS`(500) 뒤에 뜬다. 터치 포인터는 띄우지 않는다.
//   · 키보드 초점(`:focus-visible`)은 지연 없이 즉시 뜬다. 마우스 클릭으로 간 초점은 띄우지 않는다.
//   · 눌리면·포인터가 나가면·초점이 나가면·Esc면 닫는다. 닫힘은 즉시다(나타남만 모션이 있다).
//   · 트리거가 이미 `aria-label`로 같은 이름을 갖는다. 툴팁은 눈으로 보는 보조라
//     `aria-hidden`이고 `aria-describedby`로 이름을 두 번 읽히게 하지 않는다.
//   · 면은 `tooltip-surface`(둥근 작은 면, 12×6), 간격 4(`mb-1`/`mt-1`), 위/아래 두 방향이다.

export type TooltipSide = "top" | "bottom";

interface TooltipProps {
  label: string;
  side?: TooltipSide;
  /** 처음부터 떠 있게 한다(갤러리·캡처 전용). 평소는 가리키거나 키보드 초점일 때만 뜬다. */
  defaultOpen?: boolean;
  /** 지연 덮어쓰기. 시험이 쓴다. 기본은 `TOOLTIP_DELAY_MS`. */
  delayMs?: number;
  className?: string;
  children: React.ReactNode;
}

/** 면의 클래스. `rowSurface.browser.test.ts`가 이 상수를 그대로 엔진에 먹여 계산된 값을 잰다. */
export const TOOLTIP_CLASS =
  "tooltip-surface layer-content-float absolute left-1/2 -translate-x-1/2 text-meta";

export const TOOLTIP_SIDE_CLASS: Record<TooltipSide, string> = {
  top: "bottom-full mb-1",
  bottom: "top-full mt-1",
};

function isKeyboardFocus(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return true;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function Tooltip({
  label,
  side = "top",
  defaultOpen = false,
  delayMs = TOOLTIP_DELAY_MS,
  className,
  children,
}: TooltipProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const close = React.useCallback(() => {
    clear();
    setOpen(false);
  }, [clear]);
  React.useEffect(() => clear, [clear]);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        clear();
        timer.current = setTimeout(() => {
          timer.current = null;
          setOpen(true);
        }, delayMs);
      }}
      onPointerLeave={close}
      onPointerDown={close}
      onFocus={(event) => {
        if (!isKeyboardFocus(event.target)) return;
        clear();
        setOpen(true);
      }}
      onBlur={close}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      {children}
      {open && (
        <span
          aria-hidden="true"
          data-testid="tooltip"
          data-side={side}
          className={cn(TOOLTIP_CLASS, TOOLTIP_SIDE_CLASS[side], TOOLTIP_MOTION)}
        >
          {label}
        </span>
      )}
    </span>
  );
}
