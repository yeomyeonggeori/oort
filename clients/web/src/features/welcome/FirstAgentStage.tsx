import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { uuidEq } from "@momo/core/lib/api";
import { attachParticle } from "@momo/core/lib/koreanParticle";
import {
  FIRST_MENTION_AGENT_BADGE,
  firstMentionDraft,
  previewHintedAgent,
} from "@momo/core/features/hostedAgents/firstMention";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { OnboardingSlideTransition } from "@/features/auth/OnboardingSlideTransition";
import { titlebarDragProps } from "@/app/sidebarPane";
import { IS_TAURI } from "@/lib/env";
import { ChoiceList, type ChoiceListItem } from "@/features/hostedAgents/ChoiceList";
import { HostedAgentWizard } from "@/features/hostedAgents/HostedAgentWizard";
import { OneTimeSecretCard } from "@/features/hostedAgents/OneTimeSecretCard";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import type { HostedWizardLaunch } from "@/features/hostedAgents/hostedWizardLaunch";
import { getHostedConnection } from "@momo/core/features/hostedAgents/api";
import {
  parseHostedConnection,
  type HostedAgentConnection,
} from "@momo/core/features/hostedAgents/model";
import {
  PAIRING_REVEAL_HEADLINE,
  PAIRING_REVEAL_SCOPE_NOTE,
  PAIRING_REVEAL_WARNING,
} from "@momo/core/features/hostedAgents/presets";
import { seedComposerText } from "@/features/chat/draftStore";
import { elapsedLabel, useTickingNow } from "@/features/agents/agentWorkingSignal";
import { Avatar } from "@/features/timeline/MessageRow";
import { memberFor, useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { isDefaultWelcomeChannel } from "./welcomeKickoff";
import {
  DETECT_INITIAL_MS,
  FIRST_AGENT_AI_HREF,
  FIRST_AGENT_CAP_COPY,
  FIRST_AGENT_CARDS,
  FIRST_AGENT_CHANNEL_PENDING,
  FIRST_AGENT_CONTINUE_LABEL,
  FIRST_AGENT_DETECTING_WAIT,
  FIRST_AGENT_ERROR_REASON_ID,
  FIRST_AGENT_HEADING_ID,
  FIRST_AGENT_LIST_ERROR,
  FIRST_AGENT_MENTION_ACTION,
  FIRST_AGENT_OFFLINE_REASON,
  FIRST_AGENT_OFFLINE_REASON_ID,
  FIRST_AGENT_RECHECK_LABEL,
  FIRST_AGENT_REENTRY_HREF,
  FIRST_AGENT_REENTRY_LABEL,
  FIRST_AGENT_RETRY_LABEL,
  FIRST_AGENT_SKIP_LABEL,
  FIRST_AGENT_SKIP_SENTENCE,
  FIRST_AGENT_TITLE,
  firstAgentCaptureAgent,
  firstAgentCaptureSecret,
  firstAgentCard,
  firstAgentDetectingDetail,
  firstAgentLead,
  formatDetectPollWait,
  isHostedDetected,
  nextDetectDelayMs,
  readFirstAgentCapturePoseFromLocation,
  shouldAutoPass,
  type FirstAgentCapturePose,
  type FirstAgentCardId,
  type FirstAgentStep,
} from "./firstAgent";
import {
  dismissFirstAgentDeferred,
  setFirstAgentResumeHash,
  writeFirstAgentMarker,
} from "./firstAgentStore";

// Reading this as: onboarding (first-agent first-run) for internal team users
// on web+Tauri, density 6/10, motion 2/10.

function readCapturePose(): FirstAgentCapturePose | null {
  return readFirstAgentCapturePoseFromLocation();
}

function stepFromPose(pose: FirstAgentCapturePose | null): FirstAgentStep {
  if (pose === "one-time") return "issuing";
  if (pose === "detecting") return "detecting";
  if (pose === "cap-exceeded") return "cap-exceeded";
  if (pose === "done") return "mention";
  return "cards";
}

function channelHref(channelId: string): string {
  return channelId === "" ? "/" : `/c/${channelId}`;
}

function connectionAllowsChannel(
  connection: HostedAgentConnection,
  channelId: string
): boolean {
  if (channelId === "") return false;
  if (connection.status !== "active") return false;
  return connection.approvedChannelIds.some((id) => uuidEq(id, channelId));
}

export function FirstAgentStage({
  onContinue,
}: {
  onContinue: () => void;
}) {
  const { workspaceId } = useSession();
  const offline = useOffline();
  const pose = readCapturePose();
  const [step, setStep] = useState<FirstAgentStep>(() => stepFromPose(pose));
  const [selectedCard, setSelectedCard] = useState<FirstAgentCardId | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [launch, setLaunch] = useState<HostedWizardLaunch | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [detected, setDetected] = useState<HostedAgentConnection | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detectStartedAtMs, setDetectStartedAtMs] = useState(() => Date.now());
  const [nextPollMs, setNextPollMs] = useState(DETECT_INITIAL_MS);
  const autoPassedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const prevStepRef = useRef(step);

  const list = useQuery({
    ...hostedListQuery(workspaceId),
    enabled: pose === null,
  });
  const { directory } = useDirectory(workspaceId);
  const { groups } = useChannels(workspaceId);

  const welcomeChannel = useMemo(() => {
    return (
      groups.channels.find((channel) =>
        isDefaultWelcomeChannel({ kind: channel.kind, name: channel.name })
      ) ?? groups.channels[0] ?? null
    );
  }, [groups.channels]);
  const welcomeChannelId = welcomeChannel?.id ?? "";

  const nowMs = useTickingNow(step === "detecting");

  useEffect(() => {
    if (prevStepRef.current === step) return;
    prevStepRef.current = step;
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (pose !== null || autoPassedRef.current) return;
    if (list.isPending) return;
    if (list.isError) {
      setListError(FIRST_AGENT_LIST_ERROR);
      return;
    }
    setListError(null);
    if (shouldAutoPass(list.data ?? [])) {
      autoPassedRef.current = true;
      writeFirstAgentMarker(workspaceId, "done");
      onContinue();
    }
  }, [pose, list.isPending, list.isError, list.data, workspaceId, onContinue]);

  useEffect(() => {
    if (step !== "detecting" || connectionId === null || pose !== null) return;
    let cancelled = false;
    let attempt = 0;
    let timer = 0;

    const poll = async () => {
      if (cancelled) return;
      try {
        const connection = parseHostedConnection(
          await getHostedConnection(workspaceId, connectionId)
        );
        if (cancelled) return;
        if (isHostedDetected(connection.status)) {
          setDetected(connection);
          setStep("mention");
          return;
        }
      } catch {
        /* 다음 간격에서 다시 묻는다. 상한이 무한 폴링을 막는다. */
      }
      if (cancelled) return;
      const delay = nextDetectDelayMs(Date.now() - detectStartedAtMs, attempt);
      if (delay === "cap") {
        setStep("cap-exceeded");
        return;
      }
      setNextPollMs(delay);
      attempt += 1;
      timer = window.setTimeout(() => {
        void poll();
      }, delay);
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [step, connectionId, workspaceId, pose, detectStartedAtMs]);

  const finish = (kind: "skipped" | "done") => {
    writeFirstAgentMarker(workspaceId, kind);
    onContinue();
  };

  const handleSkip = () => {
    setWizardOpen(false);
    finish("skipped");
  };

  const handleOpenAi = () => {
    const hash = `#${FIRST_AGENT_AI_HREF}`;
    window.location.hash = hash;
    setFirstAgentResumeHash(hash);
    writeFirstAgentMarker(workspaceId, "deferred");
    dismissFirstAgentDeferred();
    onContinue();
  };

  const handlePick = (id: string) => {
    if (offline || listError) return;
    const cardId = id as FirstAgentCardId;
    setSelectedCard(cardId);
    const card = firstAgentCard(cardId);
    if (card.presetId === null) {
      handleOpenAi();
      return;
    }
    setLaunch({
      presetId: card.presetId,
      displayName: card.displayName,
      handle: card.handle,
      autoAdvance: "create",
    });
    setStep("issuing");
    setWizardOpen(true);
  };

  const handleRecheck = async () => {
    if (offline || connectionId === null) return;
    try {
      const connection = parseHostedConnection(
        await getHostedConnection(workspaceId, connectionId)
      );
      if (isHostedDetected(connection.status)) {
        setDetected(connection);
        setStep("mention");
      }
    } catch {
      /* 한 번 더 물은 뒤에도 없으면 이 자리에 남는다. */
    }
  };

  const handleMentionHandoff = () => {
    const agent =
      previewHintedAgent(directory.members, detected?.agentMemberId ?? null) ??
      (pose === "done" ? firstAgentCaptureAgent() : null);
    if (welcomeChannelId !== "" && agent && agent.handle !== "") {
      seedComposerText(
        workspaceId,
        welcomeChannelId,
        firstMentionDraft(agent.handle)
      );
    }
    const href = `#${channelHref(welcomeChannelId)}`;
    setFirstAgentResumeHash(href);
    window.location.hash = href;
    finish("done");
  };

  const items: ChoiceListItem[] = FIRST_AGENT_CARDS.map((card) => ({
    id: card.id,
    label: card.label,
    detail: card.detail,
  }));

  const hintedAgentMemberId = detected?.agentMemberId ?? null;
  const mentionAgent =
    previewHintedAgent(directory.members, hintedAgentMemberId) ??
    (pose === "done"
      ? {
          connectionId: "",
          agentMemberId: "",
          displayName: firstAgentCaptureAgent().displayName,
          handle: firstAgentCaptureAgent().handle,
        }
      : null);
  const mentionApproved =
    detected !== null && connectionAllowsChannel(detected, welcomeChannelId);
  const rosterAgent =
    mentionAgent === null || mentionAgent.agentMemberId === ""
      ? (directory.members.find((row) => row.kind === "agent") ?? null)
      : (memberFor(directory, mentionAgent.agentMemberId) ?? null);

  const skipRow = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        className="self-start"
        onClick={handleSkip}
        data-testid="first-agent-skip"
      >
        {FIRST_AGENT_SKIP_LABEL}
      </Button>
      <Link
        to={FIRST_AGENT_REENTRY_HREF}
        className="tap-target press inline-flex h-control items-center rounded-sm text-body text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:focus-ring"
        onClick={() => {
          setFirstAgentResumeHash(`#${FIRST_AGENT_REENTRY_HREF}`);
          finish("skipped");
        }}
        data-testid="first-agent-reentry"
      >
        {FIRST_AGENT_REENTRY_LABEL}
      </Link>
    </div>
  );

  const autoPassing =
    pose === null &&
    !list.isPending &&
    !list.isError &&
    shouldAutoPass(list.data ?? []);
  const showLoading = pose === "loading" || (pose === null && (list.isPending || autoPassing));
  const showOffline = pose === "offline" || offline;
  const showError = pose === "error" || Boolean(listError);
  const cardsInert = Boolean(listError) || pose === "error";
  const cardsLocked = showOffline || cardsInert;

  const body = (() => {
    if (pose === "one-time") {
      return (
        <div className="flex min-w-0 flex-col items-start gap-3">
          <OneTimeSecretCard
            headline={PAIRING_REVEAL_HEADLINE}
            warning={PAIRING_REVEAL_WARNING}
            notes={[PAIRING_REVEAL_SCOPE_NOTE]}
            secretLabel="연결 값"
            secret={firstAgentCaptureSecret()}
            copyLabel="연결 값 복사"
            onDone={() => undefined}
            testId="hosted-pairing-card"
          />
          {skipRow}
        </div>
      );
    }

    if (step === "issuing") {
      return null;
    }

    if (step === "detecting" || pose === "detecting") {
      return (
        <div
          className="flex min-w-0 flex-col items-start gap-3"
          data-testid="first-agent-detecting"
        >
          <div role="status" className="flex min-w-0 flex-col items-start gap-3">
            <p
              className="text-body text-ink"
              data-numeric
              data-testid="first-agent-elapsed"
            >
              {elapsedLabel(detectStartedAtMs, nowMs)}
            </p>
            <p className="break-keep text-body text-ink">
              {formatDetectPollWait(nextPollMs)}
            </p>
            <p className="break-keep text-body text-ink-muted">
              {firstAgentDetectingDetail(selectedCard)}
            </p>
            <p className="break-keep text-body text-ink-muted">
              {FIRST_AGENT_DETECTING_WAIT}
            </p>
          </div>
          {skipRow}
        </div>
      );
    }

    if (step === "cap-exceeded" || pose === "cap-exceeded") {
      return (
        <div
          className="flex min-w-0 flex-col items-start gap-3"
          data-testid="first-agent-cap-exceeded"
        >
          <p className="break-keep text-body text-ink">{FIRST_AGENT_CAP_COPY}</p>
          <Button
            type="button"
            className="self-start"
            onClick={() => {
              void handleRecheck();
            }}
            data-testid="first-agent-recheck"
          >
            {FIRST_AGENT_RECHECK_LABEL}
          </Button>
          {skipRow}
        </div>
      );
    }

    if (step === "mention" || pose === "done") {
      const channelName = welcomeChannel?.name ?? "";
      const actionHref = channelHref(welcomeChannelId);
      return (
        <div
          className="flex min-w-0 flex-col items-start gap-3"
          data-testid="first-agent-mention"
        >
          {mentionAgent && mentionAgent.displayName !== "" ? (
            <>
              <div className="flex min-w-0 items-center gap-3">
                <Avatar member={rosterAgent} />
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
                  <p className="min-w-0 truncate text-body font-semibold text-agent">
                    {mentionAgent.displayName}
                  </p>
                  <span className="rounded-sm bg-agent-soft px-1 text-timestamp text-agent">
                    {FIRST_MENTION_AGENT_BADGE}
                  </span>
                  <span className="min-w-0 truncate text-meta text-ink-muted">
                    @{mentionAgent.handle}
                  </span>
                </div>
              </div>
              {mentionApproved && channelName !== "" ? (
                <p className="break-keep text-body text-ink">
                  {`${attachParticle(mentionAgent.displayName, "subject")} ${channelName}에서 답합니다.`}
                </p>
              ) : (
                <p className="break-keep text-body text-ink-muted">
                  {FIRST_AGENT_CHANNEL_PENDING}{" "}
                  <Link
                    to={FIRST_AGENT_REENTRY_HREF}
                    className="press underline underline-offset-2 hover:text-ink focus-visible:focus-ring"
                    onClick={() => {
                      setFirstAgentResumeHash(`#${FIRST_AGENT_REENTRY_HREF}`);
                      finish("skipped");
                    }}
                  >
                    {FIRST_AGENT_REENTRY_LABEL}
                  </Link>
                </p>
              )}
              <Button
                type="button"
                className="self-start"
                onClick={handleMentionHandoff}
                data-testid="first-agent-mention-action"
                data-href={`#${actionHref}`}
              >
                {FIRST_AGENT_MENTION_ACTION}
              </Button>
            </>
          ) : (
            <p className="break-keep text-body text-ink">
              첫 멘션은 채널에서 이어갈 수 있습니다.
            </p>
          )}
          {skipRow}
        </div>
      );
    }

    return (
      <div className="flex min-w-0 flex-col items-start gap-4" data-testid="first-agent-cards">
        {showLoading && (
          <div
            role="status"
            className="flex w-full min-w-0 flex-col items-start gap-3"
            data-testid="first-agent-loading"
          >
            <p className="break-keep text-body text-ink-muted">
              연결 목록을 불러옵니다.
            </p>
            <Skeleton ready={false} rows={3} className="w-full p-0" />
          </div>
        )}
        {showOffline && (
          <InlineBanner
            tone="neutral"
            message={FIRST_AGENT_OFFLINE_REASON}
            messageId={FIRST_AGENT_OFFLINE_REASON_ID}
            testId="first-agent-offline"
          />
        )}
        {showError && (
          <InlineBanner
            message={listError ?? FIRST_AGENT_LIST_ERROR}
            messageId={FIRST_AGENT_ERROR_REASON_ID}
            actionLabel={FIRST_AGENT_RETRY_LABEL}
            onAction={() => {
              setListError(null);
              void list.refetch();
            }}
            testId="first-agent-error"
          />
        )}
        {pose !== "loading" && !showLoading && (
          <>
            <ChoiceList
              name="first-agent-harness"
              legend="어떤 에이전트를 붙이나요"
              multiple={false}
              items={items}
              selected={selectedCard ? [selectedCard] : []}
              onChange={(next) => {
                const id = next[0];
                if (id) setSelectedCard(id as FirstAgentCardId);
              }}
              onActivate={handlePick}
              disabled={cardsLocked}
              describedBy={
                showOffline
                  ? FIRST_AGENT_OFFLINE_REASON_ID
                  : showError
                    ? FIRST_AGENT_ERROR_REASON_ID
                    : undefined
              }
              testId="first-agent-choice"
            />
            <Button
              type="button"
              className="self-start"
              aria-disabled={!selectedCard || cardsLocked || undefined}
              onClick={() => {
                if (!selectedCard || cardsLocked) return;
                handlePick(selectedCard);
              }}
              data-testid="first-agent-continue"
            >
              {FIRST_AGENT_CONTINUE_LABEL}
            </Button>
          </>
        )}
        {skipRow}
      </div>
    );
  })();

  return (
    <div className="flex min-h-full flex-col bg-surface">
      <header
        className="onboarding-step-chrome"
        data-testid="onboarding-step-chrome"
        {...titlebarDragProps(IS_TAURI)}
      />
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <OnboardingSlideTransition
          transitionKey={step}
          className="flex w-full justify-center"
        >
          <div
            className="flex w-full max-w-sm flex-col items-start gap-4"
            data-testid="first-agent-stage"
            data-step={step}
            aria-labelledby={FIRST_AGENT_HEADING_ID}
          >
            <div className="flex flex-col gap-1">
              <h1
                ref={headingRef}
                id={FIRST_AGENT_HEADING_ID}
                tabIndex={-1}
                className="text-title font-semibold text-ink focus-visible:focus-ring"
              >
                {FIRST_AGENT_TITLE}
              </h1>
              <p className="break-keep text-body text-ink-muted">
                {firstAgentLead(step)}
              </p>
              <p className="break-keep text-meta text-ink-muted">
                {FIRST_AGENT_SKIP_SENTENCE}
              </p>
            </div>
            {body}
          </div>
        </OnboardingSlideTransition>
      </div>
      <HostedAgentWizard
        open={wizardOpen && pose === null}
        onOpenChange={(open) => {
          setWizardOpen(open);
          if (!open && step === "issuing" && connectionId === null) {
            setStep("cards");
            setLaunch(null);
          }
        }}
        opener={null}
        launch={launch}
        entry="settings"
        onPairingSaved={(id) => {
          setConnectionId(id);
          setWizardOpen(false);
          setDetectStartedAtMs(Date.now());
          setNextPollMs(DETECT_INITIAL_MS);
          setStep("detecting");
        }}
      />
    </div>
  );
}
