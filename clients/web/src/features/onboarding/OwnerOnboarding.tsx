import type { LoginResponse } from "@momo/core/lib/api";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/design/ui/card";
import { OortMark } from "@/design/brand/OortMark";
import {
  initialOwnerOnboardingStage,
  ownerOnboardingProgressLabel,
} from "@/features/auth/onboardingFlow";
import { InviteStage } from "./InviteStage";
import { S2_TITLE } from "./s2Copy";

// Reading this as: onboarding post-claim stage chrome for internal team users
// on web+Tauri, density 6/10, motion 2/10.
//
// Table-driven: this file mounts whatever `initialOwnerOnboardingStage`
// returns. S2 is self-contained; S1 inserts by changing the table, not S2.

export function OwnerOnboarding({
  session,
  onFinished,
}: {
  session: LoginResponse;
  onFinished: () => void;
}) {
  const stage = initialOwnerOnboardingStage();
  const progress = ownerOnboardingProgressLabel(stage);

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <h1 className="brand-lockup flex items-center gap-2 font-semibold leading-none tracking-tight">
              <OortMark className="size-6 shrink-0 text-accent" />
              <span className="text-title">oort</span>
            </h1>
            <p
              className="font-mono text-meta text-ink-muted"
              data-testid="onboarding-progress"
              data-numeric
            >
              {progress}
            </p>
          </div>
          <h2 className="text-title text-ink">{S2_TITLE}</h2>
        </CardHeader>
        <CardContent>
          {stage === "invite" && (
            <InviteStage
              workspaceId={session.member.workspaceId}
              onSkip={onFinished}
              onContinue={onFinished}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
