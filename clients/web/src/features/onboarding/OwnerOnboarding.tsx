import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LoginResponse, Member } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import { onboardingDots } from "@momo/core/features/onboarding/guide";
import { titlebarDragProps } from "@/app/sidebarPane";
import { IS_TAURI } from "@/lib/env";
import {
  nextOwnerOnboardingStage,
  resolveOwnerOnboardingStage,
} from "@/features/auth/onboardingFlow";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { OnboardingDots } from "./guide/OnboardingDots";
import { OnboardingColumn, OnboardingFrame } from "./guide/OnboardingFrame";
import { InviteStage } from "./InviteStage";
import {
  clearOwnerOnboardingFlag,
  hasOwnerOnboardingFlag,
  markOwnerOnboardingStage,
  readOwnerOnboardingStage,
  subscribeOwnerOnboarding,
} from "./ownerOnboardingStore";
import { WorkspaceProfileStage } from "./WorkspaceProfileStage";

// Reading this as: onboarding post-claim stage chrome for internal team users
// on web+Tauri, density 5/10, motion 2/10.
//
// Table-driven: this file mounts whatever `resolveOwnerOnboardingStage`
// returns from the pending marker. S1 and S2 share the onboarding 2.0 frame
// (ADR-0193 D11, #2811): 새벽하늘 바닥 위 질문, 코메토 머리, 점 넷. Each stage
// says its own question through KomettoGuide because only the stage knows its
// state (발급 뒤 기쁨, 실패 당황). Skipping S1 after a non-field failure keeps
// the `workspace-profile` marker so a reload offers S1 again.
//
// 점은 claim 경로 전체(claim·S1·S2·AI 연결)다(ADR-0185 증보 §5-2). 스텝 표
// `OWNER_ONBOARDING_STAGES`(2칸)와 그 카운터는 그대로 두고 보이는 것만 점이다.

export function OwnerOnboarding({
  session,
  replaceSessionMember,
  onFinished,
}: {
  session: LoginResponse;
  replaceSessionMember: (member: Member) => void;
  onFinished: () => void;
}) {
  const pending = useSyncExternalStore(
    subscribeOwnerOnboarding,
    readOwnerOnboardingStage,
    readOwnerOnboardingStage
  );
  const [s1Escaped, setS1Escaped] = useState(false);
  const resolved = resolveOwnerOnboardingStage(pending);
  const stage = s1Escaped ? "invite" : resolved;
  const dots = onboardingDots(
    "claim",
    stage === "invite" ? "invite" : "workspace-profile"
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const workspace = useQuery({
    queryKey: workspaceIdentityKey(session.member.workspaceId),
    queryFn: () => fetchWorkspace(session.member.workspaceId),
    retry: false,
  });

  useEffect(() => {
    headingRef.current?.focus();
  }, [stage]);

  function finishStage() {
    if (stage === "workspace-profile" && !hasOwnerOnboardingFlag("invite")) {
      clearOwnerOnboardingFlag("workspace-profile");
      onFinished();
      return;
    }
    const next = nextOwnerOnboardingStage(stage);
    if (next) {
      markOwnerOnboardingStage(next);
      return;
    }
    onFinished();
  }

  function handleSkipS1() {
    setS1Escaped(true);
  }

  const body =
    stage === "workspace-profile" ? (
      <WorkspaceProfileStage
        workspaceId={session.member.workspaceId}
        memberHandle={session.member.handle}
        memberDisplayName={session.member.displayName}
        workspaceName={workspace.data?.name}
        workspaceUpdatedAtMs={workspace.data?.updatedAtMs}
        replaceSessionMember={replaceSessionMember}
        onComplete={finishStage}
        onSkip={handleSkipS1}
        headingRef={headingRef}
      />
    ) : (
      <OnboardingColumn>
        <InviteStage
          workspaceId={session.member.workspaceId}
          workspaceName={workspace.data?.name ?? "oort"}
          onSkip={onFinished}
          onContinue={onFinished}
          headingRef={headingRef}
        />
      </OnboardingColumn>
    );

  return (
    <OnboardingFrame
      top={
        <header
          className="onboarding-step-chrome"
          data-testid="onboarding-step-chrome"
          {...titlebarDragProps(IS_TAURI)}
        >
          <span />
          <OnboardingDots dots={dots} />
          <span aria-hidden="true" />
        </header>
      }
    >
      {body}
    </OnboardingFrame>
  );
}
