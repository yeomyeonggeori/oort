import { useState, type AnimationEvent } from "react";
import type { KomettoExpression } from "@momo/core/features/onboarding/guide";
import { usePrefersReducedMotion } from "@/design/hooks/usePrefersReducedMotion";
import { KOMETTO_EXPRESSION_ASSETS } from "./komettoExpressions";

export type KomettoGuideSize = "head" | "hero";

type FaceState = {
  shown: KomettoExpression;
  /** 크로스페이드 동안 사라지는 앞 표정. 없으면 null. */
  leaving: KomettoExpression | null;
  /** 이 마운트에서 표정이 한 번이라도 바뀌었나(첫 그림은 페이드하지 않는다). */
  changed: boolean;
  /** 기쁨으로 들어선 직후 한 번 흔든다. */
  wag: boolean;
};

/**
 * 코메토 얼굴 (ADR-0193 D11). 상자는 크기가 고정이고 두 겹이 같은 자리에 겹친다.
 *
 * - 표정이 바뀌면 앞 표정은 사라지고 새 표정이 나타난다(제자리 120ms 크로스페이드).
 * - 기쁨으로 **바뀔 때** 꼬리를 한 번 흔든다(360ms). 처음부터 기쁨으로 마운트된
 *   화면은 흔들지 않는다: 흔들기는 「감지 성공」의 반응이지 화면의 인사가 아니다.
 * - reduced-motion이면 앞 표정 겹을 아예 만들지 않고 흔들기도 켜지 않는다. 겹을
 *   남겨 두고 animationend를 기다리면, 애니메이션이 없는 환경에서 그 이벤트가
 *   오지 않아 두 얼굴이 겹친 채 남는다.
 *
 * 그림은 장식이다(`alt=""`, 상자 `aria-hidden`). 상태는 말풍선 문장이 말한다.
 */
export function KomettoFace({
  expression,
  size = "head",
}: {
  expression: KomettoExpression;
  size?: KomettoGuideSize;
}) {
  const reduced = usePrefersReducedMotion();
  const [face, setFace] = useState<FaceState>({
    shown: expression,
    leaving: null,
    changed: false,
    wag: false,
  });

  if (face.shown !== expression) {
    setFace({
      shown: expression,
      leaving: reduced ? null : face.shown,
      changed: !reduced,
      wag: !reduced && expression === "happy",
    });
  }

  const onBoxAnimationEnd = (event: AnimationEvent<HTMLSpanElement>) => {
    if (event.target !== event.currentTarget) return;
    setFace((prev) => (prev.wag ? { ...prev, wag: false } : prev));
  };

  return (
    <span
      className="kometto-face"
      data-size={size}
      data-expression={face.shown}
      data-wag={face.wag ? "true" : undefined}
      data-testid="kometto-face"
      aria-hidden="true"
      onAnimationEnd={onBoxAnimationEnd}
    >
      {face.leaving !== null && (
        <img
          key={`leaving-${face.leaving}`}
          className="kometto-face-layer"
          data-phase="leaving"
          data-testid="kometto-face-leaving"
          src={KOMETTO_EXPRESSION_ASSETS[face.leaving]}
          alt=""
          draggable={false}
          onAnimationEnd={(event) => {
            event.stopPropagation();
            setFace((prev) => ({ ...prev, leaving: null }));
          }}
        />
      )}
      <img
        key={face.shown}
        className="kometto-face-layer"
        data-phase={face.changed ? "entering" : "rest"}
        data-testid="kometto-face-current"
        src={KOMETTO_EXPRESSION_ASSETS[face.shown]}
        alt=""
        draggable={false}
        onAnimationEnd={(event) => event.stopPropagation()}
      />
    </span>
  );
}
