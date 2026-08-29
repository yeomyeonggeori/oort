import { OortMark } from "@/design/brand/OortMark";
import { OortCloudField } from "./OortCloudField";

/**
 * S0: a single-look deep-space landing. Two choices, no progress bar.
 * The mark path is the product OortMark; only scale and colour change.
 */
export function LandingStep({
  onChooseServer,
  onChooseInvite,
}: {
  onChooseServer: () => void;
  onChooseInvite: () => void;
}) {
  return (
    <div
      className="onboarding-landing relative flex min-h-full flex-col bg-onboarding-space text-onboarding-ink"
      data-testid="onboarding-landing"
    >
      <div className="onboarding-starfield pointer-events-none absolute inset-0" />
      <OortCloudField />
      <h1 className="sr-only">oort</h1>
      <div className="relative flex flex-1 flex-col items-center justify-center p-6">
        <div className="onboarding-mark" data-testid="onboarding-mark">
          <OortMark className="size-onboarding-mark text-onboarding-accent" />
        </div>
      </div>
      <div className="relative flex flex-col items-center gap-3 p-6">
        <button
          type="button"
          className="tap-target onboarding-focus-on-fill h-control-lg w-full max-w-sm rounded-sm bg-onboarding-accent px-4 text-body font-medium text-onboarding-on-accent focus-visible:focus-ring"
          data-testid="onboarding-choose-server"
          onClick={onChooseServer}
        >
          우리 팀 서버로 접속
        </button>
        <button
          type="button"
          className="tap-target onboarding-focus h-control-lg w-full max-w-sm rounded-sm border border-onboarding-line bg-transparent px-4 text-body font-medium text-onboarding-ink focus-visible:focus-ring"
          data-testid="onboarding-choose-invite"
          onClick={onChooseInvite}
        >
          초대 링크로 참여
        </button>
      </div>
    </div>
  );
}
