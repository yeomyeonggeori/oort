import { Button } from "@/design/ui/button";
import { DeviceLinkCard } from "@/features/settings/DeviceLinkCard";

/**
 * Post-login first-run card (ADR-0180 D7 ships here, not as onboarding S5).
 * App owns this so the session gate cannot unmount it.
 */
export function PhoneLinkFirstRun({ onEnterApp }: { onEnterApp: () => void }) {
  return (
    <div className="flex min-h-full flex-col bg-surface">
      <div className="flex flex-1 items-center justify-center p-6">
        <div
          className="flex w-full max-w-2xl flex-col items-start gap-4"
          data-testid="onboarding-phone-link"
        >
          <div className="flex flex-col gap-1">
            <h1 className="text-title font-semibold text-ink">폰에서도 쓰기</h1>
            <p className="break-keep text-body text-ink-muted">
              같은 계정으로 폰을 붙이려면 지금 QR을 만들 수 있습니다. 나중에 설정
              기기에서도 열 수 있습니다.
            </p>
          </div>
          <DeviceLinkCard />
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={onEnterApp}
            data-testid="onboarding-enter-app"
          >
            앱으로 들어가기
          </Button>
        </div>
      </div>
    </div>
  );
}
