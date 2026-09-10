import { useBrowserOffline } from "@/features/common/useOffline";
import { InlineBanner } from "@/features/common/States";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { IssuedInviteCard } from "@/features/settings/IssuedInviteCard";
import { useIssueInvite } from "@/features/settings/useIssueInvite";
import { errorMessage, buildJoinLink } from "@momo/core/features/settings/model";
import { resolveServerBaseUrl } from "@momo/core/features/settings/api";
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
  const joinLink = issued
    ? buildJoinLink(resolveServerBaseUrl(), issued.code)
    : "";
  const { copied, copy } = useClipboardCopy(joinLink);

  const handleIssue = () => {
    if (offline || create.isPending) return;
    if (issued) {
      void copy();
      return;
    }
    create.mutate({
      role: OWNER_INVITE_ROLE,
      maxUses: OWNER_INVITE_MAX_USES,
      expiresAtMs: Date.now() + OWNER_INVITE_TTL_MS,
    });
  };

  const primaryLabel = create.isPending
    ? S2_PRIMARY_BUSY
    : copied
      ? `${S2_PRIMARY_LABEL}됨`
      : S2_PRIMARY_LABEL;

  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-s2">
      <p className="text-body text-ink">
        {S2_LEAD[0]} {S2_LEAD[1]}
      </p>

      {offline && (
        <InlineBanner
          tone="neutral"
          message={S2_OFFLINE_REASON}
          messageId={S2_OFFLINE_NOTE_ID}
          testId="onboarding-s2-offline"
        />
      )}

      {create.isError && (
        <InlineBanner
          tone="error"
          message={errorMessage(create.error)}
          messageId={S2_ISSUE_ERROR_ID}
          actionLabel="다시 시도"
          onAction={handleIssue}
          testId="onboarding-s2-error"
        />
      )}

      {issued && (
        <IssuedInviteCard
          issued={issued}
          workspaceName={workspaceName}
          issuedRef={issuedRef}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
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
        {issued && (
          <Button
            type="button"
            variant="secondary"
            onClick={onContinue}
            data-testid="onboarding-s2-continue"
          >
            {S2_CONTINUE_LABEL}
          </Button>
        )}
      </div>

      <p className="text-meta text-ink-muted" data-testid="onboarding-s2-reentry">
        {S2_SKIP_SENTENCE}
      </p>
    </div>
  );
}
