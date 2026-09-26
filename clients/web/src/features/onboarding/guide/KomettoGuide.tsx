import type { ReactNode, Ref } from "react";
import {
  assertGuideLine,
  type KomettoExpression,
} from "@momo/core/features/onboarding/guide";
import { cn } from "@/design/lib/cn";
import { KomettoFace, type KomettoGuideSize } from "./KomettoFace";

// Reading this as: onboarding for internal team users on web+Tauri,
// density 5/10, motion 2/10 (crossfade + one wag, reduced-motion off).

/**
 * 코메토 안내자 (ADR-0193 D11, #2807 OB2-1). 머리(72) 또는 히어로(280) 코메토 +
 * 말풍선 한 문장. 온보딩 2.0의 모든 화면이 이것으로 질문을 말한다.
 *
 * - `line`은 필수이고 비어 있으면 던진다(`assertGuideLine`). 표정만으로 상태를
 *   전하지 않는다. 표정은 core `GUIDE_STATE_TABLE`로 상태에서 고른다.
 * - 스크린리더: 말풍선이 `aria-live="polite"` + `aria-atomic` 영역이다. 마운트 때
 *   이미 있는 문장은 읽는 순서대로 한 번 읽히고, 같은 화면에서 문장이 바뀌면
 *   (감지 중 → 감지 성공) 바뀐 문장 전체가 한 번 알려진다. 코메토 그림은 장식이다.
 * - `as`: 화면의 질문이면 `h1`로 둔다(카드 제목 자리를 이 문장이 맡는다).
 * - `lineRef`: 단계가 바뀔 때 포커스가 내려앉을 자리(#2811 claim 뒤 S1·S2). 주면
 *   문장이 `tabIndex={-1}`과 포커스 링을 얻는다.
 */
export function KomettoGuide({
  expression,
  line,
  detail,
  size = "head",
  as: Line = "p",
  className,
  lineRef,
  lineTestId = "kometto-guide-line",
  lineId,
  children,
}: {
  expression: KomettoExpression;
  line: string;
  /** 말풍선 둘째 줄(시안 `.bubble small`). 선택. */
  detail?: string;
  size?: KomettoGuideSize;
  as?: "p" | "h1" | "h2";
  className?: string;
  lineRef?: Ref<HTMLHeadingElement>;
  lineTestId?: string;
  /** 문장의 `id`. 화면 영역이 `aria-labelledby`로 이 문장을 이름으로 삼을 때(#2814). */
  lineId?: string;
  /** 말풍선 안 문장 뒤에 붙는 것(예: 서버 칩). 거의 쓰지 않는다. */
  children?: ReactNode;
}) {
  const text = assertGuideLine(line);
  return (
    <div
      className={cn("kometto-guide", className)}
      data-size={size}
      data-expression={expression}
      data-testid="kometto-guide"
    >
      <KomettoFace expression={expression} size={size} />
      <div
        className="kometto-guide-bubble"
        aria-live="polite"
        aria-atomic="true"
        data-testid="kometto-guide-bubble"
      >
        <Line
          ref={lineRef as Ref<HTMLHeadingElement & HTMLParagraphElement>}
          id={lineId}
          tabIndex={lineRef ? -1 : undefined}
          className={cn(
            "break-keep text-title font-semibold text-ink",
            lineRef && "rounded-sm focus-visible:focus-ring"
          )}
          data-testid={lineTestId}
        >
          {text}
        </Line>
        {detail && (
          <p
            className="break-keep text-body text-ink-muted"
            data-testid="kometto-guide-detail"
          >
            {detail}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
