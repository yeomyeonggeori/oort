import type { OnboardingDots as OnboardingDotsModel } from "@momo/core/features/onboarding/guide";

/**
 * 진행 점 (ADR-0193 D10). 숫자 카운터 대신이다. 현재 칸은 신호색 막대, 지난 칸은
 * 흐린 잉크 점, 남은 칸은 옅은 점(시안 `.dots`). 모델이 null이면(첫 화면·첫 대화)
 * 아무것도 그리지 않는다.
 *
 * 점 자체는 장식이고, 스크린리더는 숨김 문장 「4단계 중 2단계」를 읽는다
 * (Buzz는 점을 aria-hidden으로만 두었다. oort는 문장을 둔다).
 */
export function OnboardingDots({ dots }: { dots: OnboardingDotsModel | null }) {
  if (dots === null) return null;
  return (
    <div
      className="onboarding-dots"
      data-testid="onboarding-dots"
      data-total={dots.total}
      data-current={dots.current}
    >
      <span className="sr-only" data-testid="onboarding-dots-label">
        {dots.label}
      </span>
      {dots.dots.map((state, index) => (
        <span
          key={index}
          className="onboarding-dot"
          data-state={state}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
