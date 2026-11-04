import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LoginResponse, Member } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import { onboardingDots } from "@momo/core/features/onboarding/guide";
import { titlebarDragProps } from "@/app/sidebarPane";
import { IS_TAURI } from "@/lib/env";
import {
  OWNER_ONBOARDING_MOUNTED,
  resolveOwnerOnboardingStage,
  type OwnerOnboardingStage,
} from "@/features/auth/onboardingFlow";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { OnboardingDots } from "./guide/OnboardingDots";
import { OnboardingColumn, OnboardingFrame } from "./guide/OnboardingFrame";
import { InviteStage } from "./InviteStage";
import {
  clearOwnerOnboardingFlag,
  acceptSeedWorkspace,
  hasOwnerOnboardingFlag,
  markOwnerOnboardingStage,
  ownerOnboardingS1IsReoffer,
  readOwnerOnboardingFlagKey,
  readOwnerOnboardingStage,
  subscribeOwnerOnboarding,
} from "./ownerOnboardingStore";
import { TeamAiStage } from "./TeamAiStage";
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
// 점은 claim 경로 전체(claim·S1·S2·팀 AI·AI 연결)다(ADR-0185 증보 §5-2). 스텝 표
// `OWNER_ONBOARDING_STAGES`(3칸)와 그 카운터는 그대로 두고 보이는 것만 점이다. 세 번째 칸(팀 AI,
// #4945)은 건너뛸 수 있고, 건너뛰면 서버에 아무것도 쓰지 않는다.

/** S1을 건너뛴 뒤에 서야 할 단계: 표지가 남은 첫 단계, 없으면 초대(예전 동작). */
function pendingAfterProfile(): OwnerOnboardingStage {
  return (
    OWNER_ONBOARDING_MOUNTED.find(
      (candidate) => candidate !== "workspace-profile" && hasOwnerOnboardingFlag(candidate)
    ) ?? "invite"
  );
}

export function OwnerOnboarding({
  session,
  replaceSessionMember,
  onFinished,
}: {
  session: LoginResponse;
  replaceSessionMember: (member: Member) => void;
  onFinished: () => void;
}) {
  // 표지 어느 하나가 바뀌어도 다시 그린다(S1을 건너뛴 채 이어 가면 첫 표지는 그대로이기 때문이다).
  useSyncExternalStore(
    subscribeOwnerOnboarding,
    readOwnerOnboardingFlagKey,
    readOwnerOnboardingFlagKey
  );
  const pending = readOwnerOnboardingStage();
  const [s1Escaped, setS1Escaped] = useState(false);
  // 이 화면이 첫 질문(claim 직후)이 아니라 재질문이면 「이대로 쓸게요」를 준다(#3714).
  const [s1Reoffer] = useState(() => ownerOnboardingS1IsReoffer());
  const resolved = resolveOwnerOnboardingStage(pending);
  // S1을 건너뛴 채 이번 실행을 잇는 동안에는 S1의 표지가 남아 있어도(다음 실행이 다시 묻도록) 그 뒤 단계를 보인다.
  const stage: OwnerOnboardingStage =
    s1Escaped && resolved === "workspace-profile" ? pendingAfterProfile() : resolved;
  // 단계 id가 점 줄의 화면 id와 같다(`OnboardingScreen`).
  const dots = onboardingDots("claim", stage);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const workspace = useQuery({
    queryKey: workspaceIdentityKey(session.member.workspaceId),
    queryFn: () => fetchWorkspace(session.member.workspaceId),
    retry: false,
  });

  useEffect(() => {
    headingRef.current?.focus();
  }, [stage]);

  // 이 단계 다음에 아직 해야 할 단계(표지가 서 있는 것). 이미 끝낸 단계는 건너뛴다.
  function finishStage() {
    const later = OWNER_ONBOARDING_MOUNTED.slice(
      OWNER_ONBOARDING_MOUNTED.indexOf(stage) + 1
    ).find((candidate) => hasOwnerOnboardingFlag(candidate));
    if (later === undefined) {
      if (stage === "workspace-profile") clearOwnerOnboardingFlag("workspace-profile");
      onFinished();
      return;
    }
    markOwnerOnboardingStage(later, { keepWorkspaceProfile: s1Escaped });
  }

  function handleSkipS1() {
    setS1Escaped(true);
  }

  function handleAcceptDefault() {
    acceptSeedWorkspace();
    finishStage();
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
        onAcceptDefault={s1Reoffer ? handleAcceptDefault : undefined}
        headingRef={headingRef}
      />
    ) : stage === "invite" ? (
      <OnboardingColumn>
        <InviteStage
          workspaceId={session.member.workspaceId}
          workspaceName={workspace.data?.name ?? "oort"}
          onSkip={finishStage}
          onContinue={finishStage}
          headingRef={headingRef}
        />
      </OnboardingColumn>
    ) : (
      <OnboardingColumn>
        <TeamAiStage
          workspaceId={session.member.workspaceId}
          onSkip={finishStage}
          onComplete={finishStage}
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
