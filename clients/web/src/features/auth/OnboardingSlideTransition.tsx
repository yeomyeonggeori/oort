import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/design/lib/cn";
import type {
  OnboardingTransitionDirection,
  OnboardingTransitionEffect,
} from "./onboardingFlow";

// Ported from buzz desktop OnboardingSlideTransition.tsx (Apache-2.0).
// fill-mode is `backwards` (not `both`) so a finished reveal does not leave a
// transform that traps `position: fixed` descendants.

type OnboardingSlideTransitionProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  containerClassName?: string;
  direction?: OnboardingTransitionDirection;
  effect?: OnboardingTransitionEffect;
  transitionKey: string;
};

export function OnboardingSlideTransition({
  children,
  className,
  containerClassName,
  direction = "forward",
  effect = "line-slide",
  transitionKey,
  ...props
}: OnboardingSlideTransitionProps) {
  return (
    <div
      className={cn("onboarding-slide w-full", containerClassName)}
      key={transitionKey}
      {...props}
    >
      <div
        className="onboarding-transition-line flex w-full justify-center"
        data-onboarding-direction={direction}
        data-onboarding-effect={effect}
      >
        <div className={cn("onboarding-transition-content w-full", className)}>
          {children}
        </div>
      </div>
    </div>
  );
}
