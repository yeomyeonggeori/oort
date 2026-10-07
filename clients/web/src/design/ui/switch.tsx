import { useId } from "react";
import { cn } from "@/design/lib/cn";

// 스위치 (#3578 S1). 켜고 끄는 한 값. Radix switch를 새 의존으로 들이지 않고 네이티브
// `button role="switch"`로 만든다(Space·Enter는 버튼이 이미 준다). 켬은 **잉크**다:
// 신호색이 아니라 주 행동의 색이다(ADR-0189 D3, 신호는 안 읽음·멘션·캐럿·링에만).
// 끔은 `line-strong`(3:1)이라 트랙이 면 위에서 읽힌다.
//
// 이름은 호출한 행의 라벨이 `aria-labelledby`로, 설명은 `aria-describedby`로 건다
// (SettingsToggleRow와 같은 규율: 이름과 문장을 한 덩어리로 읽히지 않게).
// `disabled`는 포커스를 떨구지 않는 `aria-disabled`가 아니라 네이티브다 — 잠긴 스위치는
// 눌러 볼 일이 없다.

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  labelledBy,
  describedBy,
  "aria-label": ariaLabel,
  id,
  className,
  testId,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  labelledBy?: string;
  describedBy?: string;
  "aria-label"?: string;
  id?: string;
  className?: string;
  testId?: string;
}) {
  const autoId = useId();
  return (
    <button
      type="button"
      role="switch"
      id={id ?? autoId}
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-label={labelledBy ? undefined : ariaLabel}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "switch-track press focus-visible:focus-ring disabled:cursor-default disabled:opacity-50",
        className
      )}
    >
      <span aria-hidden="true" className="switch-thumb" />
    </button>
  );
}
