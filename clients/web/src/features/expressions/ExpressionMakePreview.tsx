import { useState } from "react";
import type { MotionChoice } from "@momo/core/features/expressions/make";

// =============================================================================
// 「AI와 만들기」 칩의 실시간 미리보기 (#4820 B, ADR-0218 §7 G3.3).
//
// 이 그림은 CSS 애니메이션이 G3.3 표의 움직임을 **비슷하게 흉내 낸 것**이다. 정확한
// 결과(프레임 수, 눌림, 별의 모양과 자리)는 서버 조립이 만들고, 사람은 그 결과를
// 승인 카드에서 따로 본다. 그래서 여기서는 길이와 반복 횟수(총 4회 재생 뒤 멈춤)만
// 표와 맞추고, 시험이 expressions.css 의 값을 코어 표와 대조한다.
//
// - 모양은 data-motion 속성이 고르고, CSS 규칙(expressions.css)이 움직인다. 스타일 속성은 쓰지 않는다.
// - 동작 줄이기면 움직이지 않고 정지 그림만 보인다(CSS 쪽에도 같은 가드가 있다).
// - 누르면 다시 재생한다: playKey 가 바뀌면 무대가 새로 서고 애니메이션이 처음부터 돈다.
// - 장식이라 보조기술에는 숨긴다. 칩의 이름과 설명이 뜻을 전한다.
// =============================================================================

const STARS = [0, 1, 2, 3] as const;

export function ExpressionMakePreview({ motion, src, playKey, reduce, testId }: {
  motion: MotionChoice;
  /** `data:` 주소. 배포 CSP 가 `blob:` 이미지를 막는다. */
  src: string | null;
  playKey: string;
  reduce: boolean;
  testId: string;
}) {
  const animated = !reduce && src !== null && motion !== "still";
  const [stoppedFor, setStoppedFor] = useState<string | null>(null);
  const state = !animated ? "still" : stoppedFor === playKey ? "stopped" : "playing";
  return (
    <span className="expression-make-preview rounded-md bg-surface-hover" data-motion={motion} data-animated={animated ? "true" : "false"} data-state={state} data-testid={testId} aria-hidden="true">
      <span key={playKey} className="expression-make-stage" onAnimationEnd={() => setStoppedFor(playKey)}>
        <span className="expression-make-picture">{src !== null && <img src={src} alt="" className="expression-make-image" draggable={false} />}</span>
        {animated && motion === "sparkle" && STARS.map((star) => <i key={star} className="expression-make-star bg-ink-muted" data-star={star} />)}
      </span>
    </span>
  );
}
