import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
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
import { FirstMentionOnboarding } from "@/features/hostedAgents/FirstMentionOnboarding";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import type { HostedWizardLaunch } from "@/features/hostedAgents/hostedWizardLaunch";
import {
  getHostedConnection,
} from "@momo/core/features/hostedAgents/api";
import {
  parseHostedConnection,
  type HostedAgentConnection,
} from "@momo/core/features/hostedAgents/model";
import {
  PAIRING_REVEAL_HEADLINE,
  PAIRING_REVEAL_SCOPE_NOTE,
  PAIRING_REVEAL_WARNING,
} from "@momo/core/features/hostedAgents/presets";
import { memberFor, useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { isDefaultWelcomeChannel } from "./welcomeKickoff";
import {
  FIRST_AGENT_AI_HREF,
  FIRST_AGENT_CAP_COPY,
  FIRST_AGENT_CARDS,
  FIRST_AGENT_CONTINUE_LABEL,
  FIRST_AGENT_DETECTING_DETAIL,
  FIRST_AGENT_DETECTING_HEADLINE,
  FIRST_AGENT_LEAD,
  FIRST_AGENT_REENTRY_HREF,
  FIRST_AGENT_REENTRY_LABEL,
  FIRST_AGENT_SKIP_LABEL,
  FIRST_AGENT_TITLE,
  FIRST_AGENT_CAPTURE_SECRET,
  firstAgentCard,
  isHostedDetected,
  nextDetectDelayMs,
  readFirstAgentCapturePoseFromLocation,
  shouldAutoPass,
  type FirstAgentCapturePose,
  type FirstAgentCardId,
  type FirstAgentStep,
} from "./firstAgent";
import {
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

export function FirstAgentStage({
  onContinue,
}: {
  onContinue: () => void;
}) {
  const { workspaceId, session } = useSession();
  const offline = useOffline();
  const pose = readCapturePose();
  const [step, setStep] = useState<FirstAgentStep>(() => stepFromPose(pose));
  const [selectedCard, setSelectedCard] = useState<FirstAgentCardId | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [launch, setLaunch] = useState<HostedWizardLaunch | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [detected, setDetected] = useState<HostedAgentConnection | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const autoPassedRef = useRef(false);

  const list = useQuery({
    ...hostedListQuery(workspaceId),
    enabled: pose === null,
  });
  const { directory, isPending: directoryPending } = useDirectory(workspaceId);
  const { groups } = useChannels(workspaceId);

  const welcomeChannelId = useMemo(() => {
    const welcome = groups.channels.find((channel) =>
      isDefaultWelcomeChannel({ kind: channel.kind, name: channel.name })
    );
    return welcome?.id ?? groups.channels[0]?.id ?? "";
  }, [groups.channels]);

  useEffect(() => {
    if (pose !== null || autoPassedRef.current) return;
    if (list.isPending) return;
    if (list.isError) {
      setListError("연결 목록을 불러오지 못했습니다. 나중에 설정에서 이어갈 수 있습니다.");
      return;
    }
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
    const started = Date.now();

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
      const delay = nextDetectDelayMs(Date.now() - started, attempt);
      if (delay === "cap") {
        setStep("cap-exceeded");
        return;
      }
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
  }, [step, connectionId, workspaceId, pose]);

  const finish = (kind: "skipped" | "done") => {
    writeFirstAgentMarker(workspaceId, kind);
    onContinue();
  };

  const handleSkip = () => {
    setWizardOpen(false);
    finish("skipped");
  };

  const handleOpenAi = () => {
    setFirstAgentResumeHash(`#${FIRST_AGENT_AI_HREF}`);
    finish("done");
  };

  const handlePick = (id: string) => {
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

  const items: ChoiceListItem[] = FIRST_AGENT_CARDS.map((card) => ({
    id: card.id,
    label: card.label,
    detail: card.detail,
  }));

  const hintedAgentMemberId = detected?.agentMemberId ?? null;
  const self = session.member;

  const skipRow = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={handleSkip}
        data-testid="first-agent-skip"
      >
        {FIRST_AGENT_SKIP_LABEL}
      </Button>
      <Link
        to={FIRST_AGENT_REENTRY_HREF}
        className="touch-target press rounded-sm text-body text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:focus-ring"
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

  const body = (() => {
    if (pose === "one-time") {
      return (
        <OneTimeSecretCard
          headline={PAIRING_REVEAL_HEADLINE}
          warning={PAIRING_REVEAL_WARNING}
          notes={[PAIRING_REVEAL_SCOPE_NOTE]}
          secretLabel="연결 값"
          secret={FIRST_AGENT_CAPTURE_SECRET}
          copyLabel="연결 값 복사"
          onDone={() => undefined}
          testId="hosted-pairing-card"
        />
      );
    }

    if (step === "detecting" || pose === "detecting") {
      return (
        <div
          className="flex min-w-0 flex-col items-start gap-3"
          data-testid="first-agent-detecting"
          role="status"
        >
          <p className="break-keep text-body text-ink">
            {FIRST_AGENT_DETECTING_HEADLINE}
          </p>
          <p className="break-keep text-body text-ink-muted">
            {FIRST_AGENT_DETECTING_DETAIL}
          </p>
          <Skeleton ready={false} rows={2} className="w-full p-0" />
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
          {skipRow}
          <Button
            type="button"
            className="self-start"
            onClick={() => finish("done")}
            data-testid="first-agent-continue"
          >
            {FIRST_AGENT_CONTINUE_LABEL}
          </Button>
        </div>
      );
    }

    if (step === "mention" || pose === "done") {
      return (
        <div
          className="flex min-w-0 flex-col items-start gap-3"
          data-testid="first-agent-mention"
        >
          {welcomeChannelId !== "" && hintedAgentMemberId !== null ? (
            <FirstMentionOnboarding
              workspaceId={workspaceId}
              channelId={welcomeChannelId}
              members={directory.members}
              selfMemberId={self.id}
              selfKind={self.kind}
              selfRole={memberFor(directory, self.id)?.role ?? "member"}
              rosterSettled={!directoryPending}
              messages={[]}
              pending={[]}
              messagesStatus="ready"
              hintedAgentMemberId={hintedAgentMemberId}
              onRetryMessages={() => undefined}
            />
          ) : (
            <p className="break-keep text-body text-ink">
              첫 멘션은 채널에서 이어갈 수 있습니다.
            </p>
          )}
          {skipRow}
          <Button
            type="button"
            className="self-start"
            onClick={() => finish("done")}
            data-testid="first-agent-continue"
          >
            {FIRST_AGENT_CONTINUE_LABEL}
          </Button>
        </div>
      );
    }

    const autoPassing =
      pose === null &&
      !list.isPending &&
      !list.isError &&
      shouldAutoPass(list.data ?? []);

    return (
      <div className="flex min-w-0 flex-col items-start gap-4" data-testid="first-agent-cards">
        {(list.isPending || autoPassing) && pose === null && (
          <div role="status" data-testid="first-agent-loading">
            <span className="sr-only">연결 목록을 불러옵니다.</span>
            <Skeleton ready={false} rows={3} className="w-full p-0" />
          </div>
        )}
        {offline && (
          <InlineBanner
            tone="neutral"
            message="연결이 끊겼습니다. 목록은 이어서 볼 수 있고, 발급은 다시 연결된 뒤에 할 수 있습니다."
            testId="first-agent-offline"
          />
        )}
        {listError && (
          <InlineBanner
            message={listError}
            testId="first-agent-error"
          />
        )}
        {((!list.isPending && !autoPassing) || pose !== null) && (
          <ChoiceList
            name="first-agent-harness"
            legend="어떤 에이전트를 붙이나요"
            multiple={false}
            items={items}
            selected={selectedCard ? [selectedCard] : []}
            onChange={(next) => {
              const id = next[0];
              if (id) handlePick(id);
            }}
            disabled={offline}
            testId="first-agent-choice"
          />
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
      <div className="flex flex-1 items-center justify-center p-6">
        <OnboardingSlideTransition
          transitionKey={step}
          className="flex w-full justify-center"
        >
          <div
            className="flex w-full max-w-sm flex-col items-start gap-4"
            data-testid="first-agent-stage"
            data-step={step}
          >
            <div className="flex flex-col gap-1">
              <h1 className="text-title font-semibold text-ink">{FIRST_AGENT_TITLE}</h1>
              <p className="break-keep text-body text-ink-muted">{FIRST_AGENT_LEAD}</p>
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
          setStep("detecting");
        }}
      />
    </div>
  );
}
