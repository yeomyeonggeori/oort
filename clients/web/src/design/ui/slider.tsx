import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type Ref } from "react";
import { cn } from "@/design/lib/cn";
import "./slider.css";

// 슬라이더 (AP-3 #4190, 청사진 §5.3-f). 연속된 한 값을 [min, max]에서 고른다.
//
// 네이티브 `input[type=range]` 위에 토큰 스타일을 입힌다(Switch가 네이티브 `button role="switch"`인 것과
// 같은 규율: 새 의존성 없이 브라우저가 이미 주는 것을 쓴다). 포인터 끌기·터치·값의 접근성 매핑은
// 브라우저가 한다. 브라우저가 못 하는 것은 둘이다: 큰 걸음이 범위의 10분의 1이라 PageUp·PageDown이 10이
// 아니고(범위가 25칸이면 2.5), 트랙의 채움 색이 없다. 그래서 키보드는 이 파일이 **전부** 받는다(표준
// 슬라이더 모델, WAI-ARIA APG): 화살표 ±step, PageUp·PageDown ±pageStep, Home·End은 끝. 받은 키는
// `preventDefault`하므로 브라우저가 한 번 더 움직이지 않는다. 채움은 CSSOM 변수 `--slider-fraction`이 나르고
// (JSX `style=` 없음, CSP·프리플라이트의 `inline_style`에 안 걸린다) 규칙은 `slider.css`다.
//
// 이름은 호출한 행의 라벨이 `aria-labelledby`로, 설명은 `aria-describedby`로 건다. `valueText`는
// `aria-valuetext`다: 숫자만으로는 무엇의 몇 퍼센트인지 읽히지 않는 자리의 문장(「80% 불투명」).
// 범위가 한 점(min ≥ max)이면 움직일 수 없으므로 잠근다.

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  onValueChange: (next: number) => void;
  /** 화살표 한 걸음. */
  step?: number;
  /** PageUp·PageDown 한 걸음. */
  pageStep?: number;
  /** `aria-valuetext`. 비우면 숫자 그대로 읽힌다. */
  valueText?: (value: number) => string;
  disabled?: boolean;
  labelledBy?: string;
  describedBy?: string;
  "aria-label"?: string;
  id?: string;
  className?: string;
  testId?: string;
  /** 입력 요소. 값을 바꾼 컨트롤이 사라지며 포커스를 잃는 호출자가 포커스를 되돌릴 때 쓴다. */
  inputRef?: Ref<HTMLInputElement>;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 눌린 키가 만드는 다음 값. 슬라이더의 키가 아니면 `null`. 시험이 같은 표를 읽는다. */
export function sliderKeyTarget(
  key: string,
  value: number,
  range: { min: number; max: number; step: number; pageStep: number }
): number | null {
  const { min, max, step, pageStep } = range;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clamp(value + step, min, max);
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(value - step, min, max);
    case "PageUp":
      return clamp(value + pageStep, min, max);
    case "PageDown":
      return clamp(value - pageStep, min, max);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

export function Slider({
  value,
  min,
  max,
  onValueChange,
  step = 1,
  pageStep = 10,
  valueText,
  disabled = false,
  labelledBy,
  describedBy,
  "aria-label": ariaLabel,
  id,
  className,
  testId,
  inputRef,
}: SliderProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  // 안쪽 ref(채움 변수를 꽂는다)와 호출자의 ref를 함께 채운다.
  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      ref.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = node;
    },
    [inputRef]
  );
  const span = max - min;
  const shown = clamp(value, min, Math.max(min, max));
  const fraction = span > 0 ? (shown - min) / span : 1;

  // 트랙의 채움 길이. 렌더마다 한 번이라 값이 바뀔 때만 쓴다.
  useLayoutEffect(() => {
    ref.current?.style.setProperty("--slider-fraction", String(fraction));
  }, [fraction]);

  const locked = disabled || span <= 0;

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (locked || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = sliderKeyTarget(event.key, shown, { min, max, step, pageStep });
    if (next === null) return;
    event.preventDefault();
    if (next !== shown) onValueChange(next);
  }

  return (
    <input
      ref={setRef}
      type="range"
      id={id}
      min={min}
      max={Math.max(min, max)}
      step={step}
      value={shown}
      disabled={locked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-label={labelledBy ? undefined : ariaLabel}
      aria-valuetext={valueText?.(shown)}
      data-testid={testId}
      onChange={(event) => {
        const next = clamp(Number(event.target.value), min, max);
        if (Number.isFinite(next) && next !== shown) onValueChange(next);
      }}
      onKeyDown={onKeyDown}
      className={cn("slider", className)}
    />
  );
}
