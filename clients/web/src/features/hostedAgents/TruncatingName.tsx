import { useLayoutEffect, useRef, useState } from "react";

// =============================================================================
// 잘릴 때만 native `title`. 설정 › 연결 › 에이전트 자격 행과 첫 에이전트
// 보상 행이 같은 에이전트 이름을 보여 주므로 측정 규칙을 한곳에 둔다.
// 길이는 스크립트마다 폭이 달라 휴리스틱이 될 수 없다 — `scrollWidth` 가
// `clientWidth` 를 넘을 때만 툴팁을 켠다.
// =============================================================================

export function TruncatingName({
  name,
  className,
  testId,
  visualOnly = false,
}: {
  name: string;
  className: string;
  testId?: string;
  visualOnly?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      setTruncated(el.scrollWidth > el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [name]);

  return (
    <span
      ref={ref}
      aria-hidden={visualOnly ? true : undefined}
      className={className}
      data-testid={testId}
      title={truncated ? name : undefined}
    >
      {name}
    </span>
  );
}
