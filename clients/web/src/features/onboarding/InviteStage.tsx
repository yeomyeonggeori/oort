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
import {
  S2_CONTINUE_LABEL,
  S2_ISSUE_ERROR_ID,
  S2_LEAD,
  S2_OFFLINE_NOTE_ID,
  S2_OFFLINE_REASON,
  S2_PRIMARY_BUSY,
  S2_PRIMARY_LABEL,
  S2_SKIP_LABEL,
  S2_SKIP_SENTENCE,
} from "./s2Copy";

// Reading this as: onboarding S2 (팀원 초대) for internal team users on
// web+Tauri, density 6/10, motion 2/10.

function handleSkipClick(onSkip: () => void): void {
  onSkip();
}

export function InviteStage({
  workspaceId,
  workspaceName = "oort",
  onSkip,
  onContinue,
}: {
  workspaceId: string;
  workspaceName?: string;
  onSkip: () => void;
  onContinue: () => void;
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

  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-s2">
      <div className="flex break-keep flex-col gap-1">
        {S2_LEAD.map((line) => (
          <p key={line} className="break-keep text-body text-ink-muted">
            {line}
          </p>
        ))}
      </div>

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
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {issued ? (
          <Button
            type="button"
            onClick={onContinue}
            data-testid="onboarding-s2-continue"
          >
            {S2_CONTINUE_LABEL}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              aria-disabled={offline || undefined}
              aria-busy={create.isPending || undefined}
              aria-describedby={offline ? S2_OFFLINE_NOTE_ID : undefined}
              className={cn(offline && "opacity-50")}
              onClick={handleIssue}
              data-testid="onboarding-s2-issue"
            >
              {primaryLabel}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleSkipClick(onSkip)}
              data-testid="onboarding-s2-skip"
            >
              {S2_SKIP_LABEL}
            </Button>
          </>
        )}
      </div>

      <p
        className="break-keep text-meta text-ink-muted"
        data-testid="onboarding-s2-reentry"
      >
        {S2_SKIP_SENTENCE}
      </p>
    </div>
  );
}
