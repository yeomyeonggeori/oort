import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LoginResponse } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/design/ui/card";
import { OortMark } from "@/design/brand/OortMark";
import {
  nextOwnerOnboardingStage,
  ownerOnboardingProgressLabel,
  resolveOwnerOnboardingStage,
} from "@/features/auth/onboardingFlow";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { InviteStage } from "./InviteStage";
import {
  markOwnerOnboardingStage,
  readOwnerOnboardingStage,
  subscribeOwnerOnboarding,
} from "./ownerOnboardingStore";
import { S1_TITLE } from "./s1Copy";
import { S2_TITLE } from "./s2Copy";
import { WorkspaceProfileStage } from "./WorkspaceProfileStage";

// Reading this as: onboarding post-claim stage chrome for internal team users
// on web+Tauri, density 6/10, motion 2/10.
//
// Table-driven: this file mounts whatever `resolveOwnerOnboardingStage`
// returns from the pending marker. S1 and S2 share this card chrome; S2
// stays self-contained.

export function OwnerOnboarding({
  session,
  onFinished,
}: {
  session: LoginResponse;
  onFinished: () => void;
}) {
  const pending = useSyncExternalStore(
    subscribeOwnerOnboarding,
    readOwnerOnboardingStage,
    readOwnerOnboardingStage
  );
  const stage = resolveOwnerOnboardingStage(pending);
  const progress = ownerOnboardingProgressLabel(stage);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const workspace = useQuery({
    queryKey: workspaceIdentityKey(session.member.workspaceId),
    queryFn: () => fetchWorkspace(session.member.workspaceId),
    retry: false,
  });
  const title = stage === "invite" ? S2_TITLE : S1_TITLE;
  const titleTestId =
    stage === "invite" ? "onboarding-s2-title" : "onboarding-s1-title";

  useEffect(() => {
    headingRef.current?.focus();
  }, [stage]);

  function finishStage() {
    const next = nextOwnerOnboardingStage(stage);
    if (next) {
      markOwnerOnboardingStage(next);
      return;
    }
    onFinished();
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm">
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
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-title font-semibold text-ink focus-visible:focus-ring"
            data-testid={titleTestId}
          >
            {title}
          </h2>
        </CardHeader>
        <CardContent>
          {stage === "workspace-profile" && (
            <WorkspaceProfileStage
              workspaceId={session.member.workspaceId}
              memberHandle={session.member.handle}
              workspaceName={workspace.data?.name}
              workspaceUpdatedAtMs={workspace.data?.updatedAtMs}
              onComplete={finishStage}
            />
          )}
          {stage === "invite" && (
            <InviteStage
              workspaceId={session.member.workspaceId}
              workspaceName={workspace.data?.name ?? "oort"}
              onSkip={onFinished}
              onContinue={onFinished}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
