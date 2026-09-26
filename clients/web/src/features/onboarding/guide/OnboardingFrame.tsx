import type { ReactNode } from "react";
import { cn } from "@/design/lib/cn";

/**
 * 온보딩 2.0 바닥 (ADR-0193 D11). 새벽하늘 `canvas` 세 정지점(시안 `.canvas`,
 * 180° · 42%) 위에 다크에서만 옅은 별. 카드 없이 이 위에 질문을 바로 둔다.
 * 고대비에서는 `canvas-mid` 평면이고 별이 없다.
 *
 * 머리 줄(`top`)은 호출자가 채운다: 뒤로 버튼 · 진행 점 · 창 드래그 영역. 그 줄의
 * 기하(56, 가운데 점)는 `.onboarding-frame > .onboarding-step-chrome`가 진다.
 */
export function OnboardingFrame({
  top,
  children,
  className,
}: {
  top?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "onboarding-frame onboarding-canvas relative flex min-h-full flex-col overflow-x-clip text-ink",
        className
      )}
      data-testid="onboarding-frame"
    >
      <div className="onboarding-canvas-stars" aria-hidden="true" />
      {top}
      <div className="onboarding-frame-body relative">{children}</div>
    </div>
  );
}

/** 질문 한 개의 열(시안 `.col`, 440 · 간격 16). */
export function OnboardingColumn({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("onboarding-frame-col", className)} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * 틀의 입력 그릇과 행동 (D11 「입력 그릇만 surface, 주 행동 잉크 채움, 보조 테두리,
 * 포커스 링 신호색」). `Input`·`Button`에 덧입히는 클래스다.
 */
export const ONBOARDING_FIELD_CLASS = "onboarding-field";
export const ONBOARDING_ACTION_CLASS = "onboarding-action";
