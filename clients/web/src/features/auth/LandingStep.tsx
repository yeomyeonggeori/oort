import type { Ref } from "react";
import { OortMark } from "@/design/brand/OortMark";
import { OortCloudField } from "./OortCloudField";

/**
 * S0: a single-look deep-space landing. Two choices, no progress bar.
 * The mark path is the product OortMark; only scale and colour change.
 * Hero lockup is mark + wordmark "oort" + one-line intro (#1882).
 */
export function LandingStep({
  onChooseServer,
  onChooseInvite,
  serverChoiceRef,
  inviteChoiceRef,
}: {
  onChooseServer: () => void;
  onChooseInvite: () => void;
  serverChoiceRef?: Ref<HTMLButtonElement>;
  inviteChoiceRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div
      className="onboarding-landing relative flex min-h-full flex-col bg-onboarding-space text-onboarding-ink"
      data-testid="onboarding-landing"
    >
      <div className="onboarding-starfield pointer-events-none absolute inset-0" />
      <OortCloudField />
      <div className="relative flex flex-1 flex-col items-center justify-center p-6">
        <div
          className="brand-lockup onboarding-lockup flex flex-col items-center gap-3 text-center"
          data-testid="onboarding-lockup"
        >
          <div className="onboarding-mark" data-testid="onboarding-mark">
            <OortMark className="text-onboarding-accent" />
          </div>
          <h1
            className="onboarding-wordmark font-semibold leading-none tracking-tight"
            data-testid="onboarding-wordmark"
          >
            oort
          </h1>
          <p
            className="onboarding-tagline max-w-onboarding-copy break-keep text-body text-onboarding-ink"
            data-testid="onboarding-tagline"
          >
            사람과 에이전트가 같은 자리에서 일하는 메신저.
          </p>
        </div>
      </div>
      <div className="relative flex flex-col items-center gap-3 p-6">
        <button
          ref={serverChoiceRef}
          type="button"
          className="tap-target onboarding-focus-on-fill press inline-flex h-control-lg w-full max-w-sm items-center justify-center rounded-sm bg-onboarding-accent px-4 text-body font-medium text-onboarding-on-accent focus-visible:focus-ring"
          data-testid="onboarding-choose-server"
          onClick={onChooseServer}
        >
          우리 팀 서버로 접속
        </button>
        <button
          ref={inviteChoiceRef}
          type="button"
          className="tap-target onboarding-focus press inline-flex h-control-lg w-full max-w-sm items-center justify-center rounded-sm border border-onboarding-line bg-transparent px-4 text-body font-medium text-onboarding-ink focus-visible:focus-ring"
          data-testid="onboarding-choose-invite"
          onClick={onChooseInvite}
        >
          초대 링크로 참여
        </button>
      </div>
    </div>
  );
}
