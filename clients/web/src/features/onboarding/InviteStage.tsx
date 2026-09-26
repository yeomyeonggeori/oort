import type { Ref } from "react";
import { expressionForState, type GuideState } from "@momo/core/features/onboarding/guide";
import { useBrowserOffline } from "@/features/common/useOffline";
import { InlineBanner } from "@/features/common/States";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { IssuedInviteCard } from "@/features/settings/IssuedInviteCard";
import { useIssueInvite } from "@/features/settings/useIssueInvite";
import { inviteIssueErrorCopy } from "@/features/settings/inviteIssueError";
import {
  OWNER_INVITE_MAX_USES,
  OWNER_INVITE_ROLE,
  OWNER_INVITE_TTL_MS,
} from "@/features/auth/onboardingFlow";
import { KomettoGuide } from "./guide/KomettoGuide";
import { ONBOARDING_ACTION_CLASS } from "./guide/OnboardingFrame";
import {
  S2_CODE_NOTE,
  S2_CONTINUE_LABEL,
  S2_DETAIL,
  S2_ISSUE_ERROR_ID,
  S2_ISSUED_LINE,
  S2_OFFLINE_LINE,
  S2_OFFLINE_NOTE_ID,
  S2_OFFLINE_REASON,
  S2_PRIMARY_BUSY,
  S2_PRIMARY_LABEL,
  S2_SKIP_LABEL,
  S2_SKIP_SENTENCE,
  S2_TITLE,
  S2_TROUBLE_LINE,
} from "./s2Copy";

// Reading this as: onboarding S2 (팀원 초대, 온보딩 2.0 D3) for internal team
// users on web+Tauri, density 5/10, motion 2/10.
//
// 코메토가 이 화면의 질문을 말한다(ADR-0193 D11). 발급 전 대기, 발급 뒤 기쁨,
// 발급 실패·오프라인은 당황. 표정이 바뀔 때 문장도 함께 바뀐다.

function handleSkipClick(onSkip: () => void): void {
  onSkip();
}

function s2Guide(state: GuideState): { line: string; detail?: string } {
  switch (state) {
    case "success":
      // 「지금 전달하세요」는 발급 카드가 이미 말한다. 코메토는 한 문장만(#2811 review).
      return { line: S2_ISSUED_LINE };
    case "trouble":
      return { line: S2_TROUBLE_LINE };
    default:
      return { line: S2_TITLE, detail: S2_DETAIL };
  }
}

export function InviteStage({
  workspaceId,
  workspaceName = "oort",
  onSkip,
  onContinue,
  headingRef,
}: {
  workspaceId: string;
  workspaceName?: string;
  onSkip: () => void;
  onContinue: () => void;
  /** 단계 착지 포커스(OwnerOnboarding). 코메토의 문장이 받는다. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const offline = useBrowserOffline();
  const { issued, issuedRef, create } = useIssueInvite(workspaceId);
  const issueError = create.isError ? inviteIssueErrorCopy(create.error) : null;

  const handleIssue = () => {
    if (offline || create.isPending) return;
    create.mutate({
      role: OWNER_INVITE_ROLE,
      maxUses: OWNER_INVITE_MAX_USES,
      expiresAtMs: Date.now() + OWNER_INVITE_TTL_MS,
    });
  };

  const primaryLabel = create.isPending ? S2_PRIMARY_BUSY : S2_PRIMARY_LABEL;
  const state: GuideState = issued
    ? "success"
    : issueError || offline
      ? "trouble"
      : "awaiting";
  const guide =
    state === "trouble" && offline && !issueError
      ? { line: S2_OFFLINE_LINE }
      : s2Guide(state);

  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-s2">
      <KomettoGuide
        as="h1"
        expression={expressionForState(state)}
        line={guide.line}
        detail={guide.detail}
        lineRef={headingRef}
        lineTestId="onboarding-s2-title"
      />

      {offline && (
        <InlineBanner
          tone="neutral"
          message={S2_OFFLINE_REASON}
          messageId={S2_OFFLINE_NOTE_ID}
          testId="onboarding-s2-offline"
        />
      )}

      {issueError && (
        <div title={issueError.detail}>
          <InlineBanner
            tone="error"
            message={issueError.message}
            messageId={S2_ISSUE_ERROR_ID}
            actionLabel="다시 시도"
            onAction={handleIssue}
            testId="onboarding-s2-error"
          />
        </div>
      )}

      {issued && (
        <IssuedInviteCard
          issued={issued}
          workspaceName={workspaceName}
          issuedRef={issuedRef}
          copyMode="single"
          footnote={S2_CODE_NOTE}
        />
      )}

      {issued ? (
        <Button
          type="button"
          className={ONBOARDING_ACTION_CLASS}
          onClick={onContinue}
          data-testid="onboarding-s2-continue"
        >
          {S2_CONTINUE_LABEL}
        </Button>
      ) : (
        <Button
          type="button"
          aria-disabled={offline || undefined}
          aria-busy={create.isPending || undefined}
          aria-describedby={offline ? S2_OFFLINE_NOTE_ID : undefined}
          className={cn(ONBOARDING_ACTION_CLASS, offline && "opacity-50")}
          onClick={handleIssue}
          data-testid="onboarding-s2-issue"
        >
          {primaryLabel}
        </Button>
      )}

      <p className="onboarding-reentry" data-testid="onboarding-s2-reentry">
        {issued ? null : (
          <>
            <Button
              type="button"
              variant="ghost"
              className="onboarding-skip"
              onClick={() => handleSkipClick(onSkip)}
              data-testid="onboarding-s2-skip"
            >
              {S2_SKIP_LABEL}
            </Button>
            <span className="onboarding-reentry-sep" aria-hidden="true"> · </span>
          </>
        )}
        {S2_SKIP_SENTENCE}
      </p>
    </div>
  );
}
