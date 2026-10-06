import { useId } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/design/lib/cn";

// 세그먼트 컨트롤 (#3578 S1). 서로 배타적인 선택 둘~넷. 시안 `.a-seg`의 알약 문법:
// 트랙은 `surface-muted`, 고른 칸은 `surface` + rest 그림자로 올라온다.
//
// 네이티브 `fieldset` + `radio`다. 방향키 이동·그룹 이름·단일 탭 정차는 브라우저가
// 이미 한다(버튼 묶음 `aria-pressed`로 흉내 내면 이 셋을 직접 다시 써야 한다).
// 입력은 화면에서 숨기고(`sr-only`) 라벨이 칸이다. 포커스 링은 칸의 안쪽 인셋이다.
//
// 칸 폭은 라벨에 맞춘 뒤 모든 칸이 같은 폭(`auto-cols-fr`)이다. 고정 폭 3종을 두지
// 않는 이유: 한국어 라벨 길이가 칸마다 다르고, 칸 수가 둘이든 셋이든 같은 규칙이
// 서야 한다. 선택은 저장 버튼 없이 즉시 적용되므로 `onValueChange`가 곧 쓰기다.

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  /** lucide 아이콘 컴포넌트(정적 named import, ADR-0172). */
  Icon?: LucideIcon;
}

export function SegmentedControl<V extends string>({
  legend,
  options,
  value,
  onValueChange,
  disabled = false,
  name,
  className,
  testId,
}: {
  /** 그룹 이름. 화면에는 안 보이고 보조기술이 읽는다. */
  legend: string;
  options: readonly SegmentOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  disabled?: boolean;
  /** 라디오 그룹 이름. 비우면 고유 id. */
  name?: string;
  className?: string;
  testId?: string;
}) {
  const autoName = useId();
  const groupName = name ?? autoName;
  return (
    <fieldset
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "m-0 grid min-w-0 auto-cols-fr grid-flow-col rounded-full bg-surface-muted p-marker disabled:opacity-50",
        className
      )}
    >
      <legend className="sr-only">{legend}</legend>
      {options.map(({ value: optionValue, label, Icon }) => (
        <label
          key={optionValue}
          className={cn(
            "flex h-control-sm cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-full px-3 text-meta font-semibold press has-[:focus-visible]:focus-ring",
            "has-[:disabled]:cursor-default",
            value === optionValue
              ? "bg-surface text-ink shadow-sm"
              : "text-ink-muted hover:text-ink"
          )}
        >
          <input
            type="radio"
            name={groupName}
            value={optionValue}
            checked={value === optionValue}
            onChange={() => onValueChange(optionValue)}
            data-testid={testId ? `${testId}-${optionValue}` : undefined}
            className="sr-only"
          />
          {Icon ? <Icon aria-hidden className="size-4" /> : null}
          {label}
        </label>
      ))}
    </fieldset>
  );
}
