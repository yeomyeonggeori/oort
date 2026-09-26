import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, uuidEq } from "@momo/core/lib/api";
import {
  FIRST_MENTION_AGENT_BADGE,
  firstMentionDraft,
  previewHintedAgent,
} from "@momo/core/features/hostedAgents/firstMention";
import { fetchProviderLink, fetchWorkspace } from "@momo/core/features/settings/api";
import { expressionForState, type GuideState } from "@momo/core/features/onboarding/guide";
import { onboardingDots } from "@momo/core/features/onboarding/guide";
import type {
  LocalHarnessId,
  LocalHarnessProbe,
} from "@momo/core/features/hostedAgents/detect";
import {
  AI_CONNECT_BOUNDARY_NOTE,
  AI_CONNECT_CONTINUE_LABEL,
  AI_CONNECT_DESKTOP_ONLY_NOTE,
  AI_CONNECT_LIST_ERROR_LINE,
  GROK_LABEL,
  AI_CONNECT_PROBING_LINE,
  AI_CONNECT_QUESTION,
  AI_CONNECT_QUESTION_DETAIL,
  AI_CONNECT_REENTRY,
  AI_CONNECT_SERVER_OFF_NOTE,
  AI_CONNECT_SKIP_LABEL,
  AI_CONNECT_SKIPPED_LINE,
  GROK_NOT_INSTALLED_PILL_LABEL,
  HARNESS_LABEL,
  JOIN_BACK_LABEL,
  JOIN_CAP_DETAIL,
  JOIN_CAP_LINE,
  JOIN_CREATING_LINE,
  JOIN_ERROR_LINE,
  JOIN_JOINED_DETAIL,
  JOIN_OFF_LINE,
  JOIN_RECHECK_LABEL,
  JOIN_RETRY_LABEL,
  SUBSCRIPTION_HARNESS_WIRE,
  aiConnectFoundLine,
  aiConnectRows,
  classifyJoinConflict,
  isSubscriptionRow,
  joinConnectDetail,
  joinConnectLine,
  joinJoinedLine,
  joinWaitingLine,
  primaryActionLabel,
  subscriptionAgentIdentity,
  subscriptionConnectPlan,
  subscriptionRowSelectable,
  subscriptionSurface,
  type AiConnectRowId,
  type SubscriptionConnectPlan,
  type SubscriptionSurface,
} from "@momo/core/features/onboarding/aiConnect";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { OnboardingSlideTransition } from "@/features/auth/OnboardingSlideTransition";
import { titlebarDragProps } from "@/app/sidebarPane";
import { IS_TAURI, SUBSCRIPTION_AGENTS_BUILD_FLAG } from "@/lib/env";
import { absoluteApiBase } from "@/lib/serverBase";
import { TruncatingName } from "@/features/hostedAgents/TruncatingName";
import { HostedAgentWizard } from "@/features/hostedAgents/HostedAgentWizard";
import { OneTimeSecretCard } from "@/features/hostedAgents/OneTimeSecretCard";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import { useHostedAgentProbe } from "@/features/hostedAgents/useHostedAgentProbe";
import type { HostedWizardLaunch } from "@/features/hostedAgents/hostedWizardLaunch";
import {
  createHostedConnection,
  getHostedConnection,
} from "@momo/core/features/hostedAgents/api";
import {
  HOSTED_AUTH_MODE,
  hostedFailureMessage,
  parseHostedConnection,
  parsePairingIssuance,
  type HostedAgentConnection,
} from "@momo/core/features/hostedAgents/model";
import { GROK_HOSTED_AGENT_ID } from "@momo/core/features/hostedAgents/detect";
import {
  agentPortEndpoint,
  PAIRING_REVEAL_HEADLINE,
  PAIRING_REVEAL_SCOPE_NOTE,
  PAIRING_REVEAL_WARNING,
} from "@momo/core/features/hostedAgents/presets";
import { seedComposerText } from "@/features/chat/draftStore";
import { elapsedLabel, useTickingNow } from "@/features/agents/agentWorkingSignal";
import { Avatar } from "@/features/timeline/MessageRow";
import {
  memberFor,
  rosterQueryKey,
  useChannels,
  useDirectory,
  workspaceIdentityKey,
} from "@/features/workspace/useWorkspace";
import { KomettoGuide } from "@/features/onboarding/guide/KomettoGuide";
import { OnboardingDots } from "@/features/onboarding/guide/OnboardingDots";
import {
  ONBOARDING_ACTION_CLASS,
  OnboardingFrame,
} from "@/features/onboarding/guide/OnboardingFrame";
import { isDefaultWelcomeChannel } from "./welcomeKickoff";
import { AiConnectList } from "./AiConnectList";
import { SubscriptionConnectBlock } from "./SubscriptionConnectBlock";
import { useLocalHarnessWatch } from "./useLocalHarnessWatch";
import {
  DETECT_INITIAL_MS,
  FIRST_AGENT_AI_HREF,
  FIRST_AGENT_CHANNEL_PENDING,
  FIRST_AGENT_ERROR_REASON_ID,
  FIRST_AGENT_HEADING_ID,
  FIRST_AGENT_LIST_ERROR,
  FIRST_AGENT_OFFLINE_REASON,
  FIRST_AGENT_OFFLINE_REASON_ID,
  FIRST_AGENT_RECHECKING,
  FIRST_AGENT_REENTRY_HREF,
  FIRST_AGENT_REENTRY_LABEL,
  FIRST_AGENT_RETRY_LABEL,
  firstAgentCaptureAgent,
  firstAgentCaptureDetected,
  firstAgentCaptureSecret,
  firstAgentCaptureSubscription,
  firstAgentCard,
  firstAgentDetectingDetail,
  formatDetectPollWait,
  isHostedDetected,
  nextDetectDelayMs,
  readFirstAgentCapturePoseFromLocation,
  shouldAutoPass,
  type FirstAgentCapturePose,
  type FirstAgentStep,
} from "./firstAgent";
import {
  markFirstAgentFocusTarget,
  setFirstAgentResumeHash,
  writeFirstAgentMarker,
  dismissFirstAgentDeferred,
} from "./firstAgentStore";

// Reading this as: onboarding (D4 AI 연결, #2814) for internal team users on
// web+Tauri, density 6/10, motion 2/10 (line-slide between steps, kometto
// crossfade; reduced-motion off).

// =============================================================================
// D4 「누구의 AI로 생각할까요?」 (ADR-0193 D2·D4·D6·D11, 시안 D4).
//
// 한 화면이 네 모양을 산다: 목록 → (구독) 연결 명령 ① → 감지 대기 ② → 합류 ③.
// 감지 계약은 #2216 그대로다: Agent Port 연결 값 발급 → 서버 status 로만 감지,
// 2초 → 30초 백오프, 5분 상한. 구독 줄로 합류하는 연결만 `owner_only` +
// `subscriptionHarness`를 싣는다(#2815). 연결 값은 이 컴포넌트 상태에만 산다.
// =============================================================================

function stepFromPose(pose: FirstAgentCapturePose | null): FirstAgentStep {
  switch (pose) {
    case "one-time":
      return "issuing";
    case "detecting":
    case "sub-waiting":
      return "detecting";
    case "cap-exceeded":
    case "sub-cap":
      return "cap-exceeded";
    case "done":
    case "sub-joined":
      return "mention";
    case "sub-connect":
      return "connect";
    case "skipped":
      return "skipped";
    default:
      return "cards";
  }
}

const CAPTURE_SUB_POSES = new Set<FirstAgentCapturePose>([
  "sub-connect",
  "sub-waiting",
  "sub-cap",
  "sub-joined",
]);

/** design 캡처가 세우는 감지 결과. 제품 경로는 셸을 묻는다. */
function captureHarness(pose: FirstAgentCapturePose | null): {
  surface: SubscriptionSurface;
  probes: LocalHarnessProbe[] | null;
  watch?: Partial<Record<LocalHarnessId, { polling: boolean; expired: boolean }>>;
} | null {
  if (pose === null) return null;
  const ready: LocalHarnessProbe = { id: "claude", installed: true, auth: "logged_in" };
  const codexLogin: LocalHarnessProbe = { id: "codex", installed: true, auth: "needs_login" };
  switch (pose) {
    case "sub-probing":
      return { surface: "rows", probes: null };
    case "sub-install":
      return {
        surface: "rows",
        probes: [
          { id: "claude", installed: false, auth: "unknown" },
          { id: "codex", installed: false, auth: "unknown" },
        ],
      };
    case "sub-polling":
      return {
        surface: "rows",
        probes: [ready, codexLogin],
        watch: { codex: { polling: true, expired: false } },
      };
    case "sub-recheck":
      return {
        surface: "rows",
        probes: [ready, codexLogin],
        watch: { codex: { polling: false, expired: true } },
      };
    case "server-off":
      return { surface: "server-off", probes: [] };
    case "web":
      return { surface: "desktop-only", probes: [] };
    case "sub-ready":
    case "sub-connect":
    case "sub-waiting":
    case "sub-cap":
    case "sub-joined":
      return { surface: "rows", probes: [ready, codexLogin] };
    default:
      return { surface: "hidden", probes: [] };
  }
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

interface SubscriptionJoin {
  harness: LocalHarnessId;
  agentDisplayName: string;
  plan: SubscriptionConnectPlan | null;
}

export function FirstAgentStage({
  onContinue,
}: {
  onContinue: () => void;
}) {
  const { workspaceId, session } = useSession();
  const queryClient = useQueryClient();
  const offline = useOffline();
  const pose = readFirstAgentCapturePoseFromLocation();
  const capture = captureHarness(pose);
  const [step, setStep] = useState<FirstAgentStep>(() => stepFromPose(pose));
  const [selected, setSelected] = useState<AiConnectRowId | null>(
    pose === "sub-ready" ? "claude" : null
  );
  const [wizardOpen, setWizardOpen] = useState(false);
  const [launch, setLaunch] = useState<HostedWizardLaunch | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [detected, setDetected] = useState<HostedAgentConnection | null>(
    () => firstAgentCaptureDetected(pose)
  );
  const [listError, setListError] = useState<string | null>(null);
  const [detectStartedAtMs, setDetectStartedAtMs] = useState(() => Date.now());
  const [nextPollMs, setNextPollMs] = useState(DETECT_INITIAL_MS);
  const [recheckStatus, setRecheckStatus] = useState<string | null>(null);
  const [join, setJoin] = useState<SubscriptionJoin | null>(() => {
    if (pose === null || !CAPTURE_SUB_POSES.has(pose)) return null;
    const fixture = firstAgentCaptureSubscription();
    return {
      harness: "claude",
      agentDisplayName: fixture.agentDisplayName,
      plan: subscriptionConnectPlan("claude", fixture.endpoint, fixture.credential),
    };
  });
  const [joinFailure, setJoinFailure] = useState<string | null>(null);
  const [joinPending, setJoinPending] = useState(false);
  const [serverRefused, setServerRefused] = useState(false);
  const autoPassedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const prevStepRef = useRef(step);

  const list = useQuery({
    ...hostedListQuery(workspaceId),
    enabled: pose === null,
  });
  const providerLink = useQuery({
    queryKey: ["settings", "provider-link"],
    queryFn: fetchProviderLink,
    retry: false,
    enabled: pose === null,
  });
  const workspace = useQuery({
    queryKey: workspaceIdentityKey(workspaceId),
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
    enabled: pose === null && SUBSCRIPTION_AGENTS_BUILD_FLAG,
  });
  const { directory } = useDirectory(workspaceId);
  const { groups } = useChannels(workspaceId);
  const grokProbe = useHostedAgentProbe();

  const surface: SubscriptionSurface =
    capture?.surface ??
    (serverRefused
      ? "server-off"
      : subscriptionSurface({
          isDesktop: IS_TAURI,
          buildFlag: SUBSCRIPTION_AGENTS_BUILD_FLAG,
          serverEnabled: workspace.data ? workspace.data.subscriptionAgentsEnabled : null,
        }));
  const harness = useLocalHarnessWatch({
    enabled: surface === "rows",
    fixture: capture ? { probes: capture.probes, watch: capture.watch } : null,
  });
  const rows = aiConnectRows(surface);

  const refreshRoster = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: rosterQueryKey(workspaceId) });
  }, [queryClient, workspaceId]);

  const welcomeChannel = useMemo(() => {
    return (
      groups.channels.find((channel) =>
        isDefaultWelcomeChannel({ kind: channel.kind, name: channel.name })
      ) ?? groups.channels[0] ?? null
    );
  }, [groups.channels]);
  const welcomeChannelId = welcomeChannel?.id ?? "";

  // 진행 점 경로: 이 화면은 claim(소유자) 또는 초대 가입 뒤에만 선다(first-run
  // 표지를 찍는 곳이 그 둘이다). 명부가 오기 전에는 점을 그리지 않는다(2→4 깜빡임).
  const self = memberFor(directory, session.member.id);
  const dots =
    self == null
      ? null
      : onboardingDots(self.role === "owner" ? "claim" : "invite", "ai-connect");

  const nowMs = useTickingNow(step === "detecting");

  useEffect(() => {
    if (prevStepRef.current === step) return;
    prevStepRef.current = step;
    headingRef.current?.focus();
  }, [step]);

  // 첫 준비된 구독 줄을 미리 고른다(시안: Claude Code 줄이 선택된 채로 선다).
  useEffect(() => {
    if (selected !== null || surface !== "rows") return;
    const first = rows.find(
      (id) => isSubscriptionRow(id) && subscriptionRowSelectable(harness.pill(id))
    );
    if (first) setSelected(first);
  }, [selected, surface, rows, harness]);

  useEffect(() => {
    if (pose !== null || autoPassedRef.current) return;
    if (list.isPending || providerLink.isPending) return;
    if (list.isError) {
      setListError(FIRST_AGENT_LIST_ERROR);
      return;
    }
    setListError(null);
    if (shouldAutoPass(list.data ?? [], providerLink.data?.configured === true)) {
      autoPassedRef.current = true;
      writeFirstAgentMarker(workspaceId, "done");
      onContinue();
    }
  }, [
    pose,
    list.isPending,
    list.isError,
    list.data,
    providerLink.isPending,
    providerLink.data,
    workspaceId,
    onContinue,
  ]);

  // 감지 폴링: 구독 ①(connect)에서도 돈다. 사람이 명령을 이미 쳤을 수 있다.
  useEffect(() => {
    if ((step !== "detecting" && step !== "connect") || connectionId === null) return;
    if (pose !== null) return;
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
          refreshRoster();
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
  }, [step, connectionId, workspaceId, pose, detectStartedAtMs, refreshRoster]);

  const finish = (kind: "skipped" | "done") => {
    writeFirstAgentMarker(workspaceId, kind);
    onContinue();
  };

  const handleSkip = () => {
    setWizardOpen(false);
    setStep("skipped");
  };

  const handleOpenAi = () => {
    const hash = `#${FIRST_AGENT_AI_HREF}`;
    window.location.hash = hash;
    setFirstAgentResumeHash(hash);
    writeFirstAgentMarker(workspaceId, "deferred");
    dismissFirstAgentDeferred();
    onContinue();
  };

  const startSubscriptionJoin = async (id: LocalHarnessId, extraTaken: string[] = []) => {
    setJoinFailure(null);
    setJoinPending(true);
    setStep("connect");
    const taken = new Set(
      [...directory.members.map((member) => member.handle.toLowerCase()), ...extraTaken]
    );
    const identity = subscriptionAgentIdentity(id, session.member, taken);
    setJoin({ harness: id, agentDisplayName: identity.displayName, plan: null });
    const endpoint = agentPortEndpoint(absoluteApiBase());
    try {
      if (endpoint === null) throw new Error("no agent port endpoint");
      const revealed = parsePairingIssuance(
        await createHostedConnection(workspaceId, {
          displayName: identity.displayName,
          handle: identity.handle,
          authMode: HOSTED_AUTH_MODE,
          invocationScope: "owner_only",
          subscriptionHarness: SUBSCRIPTION_HARNESS_WIRE[id],
        })
      );
      setJoin({
        harness: id,
        agentDisplayName: identity.displayName,
        plan: subscriptionConnectPlan(id, endpoint, revealed.pairingCredential),
      });
      setConnectionId(revealed.connection.id);
      setDetectStartedAtMs(Date.now());
      setNextPollMs(DETECT_INITIAL_MS);
      refreshRoster();
      setJoinPending(false);
    } catch (error) {
      setJoinPending(false);
      if (error instanceof ApiError && error.status === 409) {
        const refusal = classifyJoinConflict(error.message);
        if (refusal === "subscription-off") {
          // 서버가 방금 킬 스위치를 내렸다(D6). 구독 줄을 걷고 목록으로 돌아간다.
          setServerRefused(true);
          setJoin(null);
          setSelected(null);
          setStep("cards");
          setJoinFailure(JOIN_OFF_LINE);
          return;
        }
        if (refusal === "handle-taken" && extraTaken.length === 0) {
          void startSubscriptionJoin(id, [identity.handle]);
          return;
        }
      }
      setJoinFailure(
        endpoint === null ? hostedFailureMessage("create", new Error()) : hostedFailureMessage("create", error)
      );
    }
  };

  const handlePick = (id: AiConnectRowId) => {
    if (offline || listError) return;
    setSelected(id);
    if (isSubscriptionRow(id)) {
      if (!subscriptionRowSelectable(harness.pill(id))) return;
      void startSubscriptionJoin(id);
      return;
    }
    if (id === "api-key") {
      handleOpenAi();
      return;
    }
    const card = firstAgentCard("grok");
    setJoin(null);
    setLaunch({
      presetId: "grok",
      displayName: card.displayName,
      handle: card.handle,
      autoAdvance: "create",
    });
    setStep("issuing");
    setWizardOpen(true);
  };

  const handleRecheck = async () => {
    if (offline || connectionId === null) return;
    setRecheckStatus(FIRST_AGENT_RECHECKING);
    setDetectStartedAtMs(Date.now());
    try {
      const connection = parseHostedConnection(
        await getHostedConnection(workspaceId, connectionId)
      );
      if (isHostedDetected(connection.status)) {
        setDetected(connection);
        refreshRoster();
        setRecheckStatus(null);
        setStep("mention");
        return;
      }
    } catch {
      /* 아래에서 감지 대기로 돌아간다. */
    }
    setRecheckStatus(null);
    setNextPollMs(DETECT_INITIAL_MS);
    setStep("detecting");
  };

  const handleBackToList = () => {
    setJoin(null);
    setConnectionId(null);
    setJoinFailure(null);
    setStep("cards");
  };

  const hintedAgentMemberId =
    detected?.agentMemberId ??
    (pose === "done" || pose === "sub-joined" ? firstAgentCaptureAgent().agentMemberId : null);

  const handleMentionHandoff = () => {
    const agent = previewHintedAgent(directory.members, hintedAgentMemberId);
    if (welcomeChannelId !== "" && agent && agent.handle !== "") {
      seedComposerText(workspaceId, welcomeChannelId, firstMentionDraft(agent.handle));
    }
    const href = `#${channelHref(welcomeChannelId)}`;
    setFirstAgentResumeHash(href);
    markFirstAgentFocusTarget();
    window.location.hash = href;
    finish("done");
  };
  const mentionAgent = previewHintedAgent(directory.members, hintedAgentMemberId);
  const mentionApproved =
    detected !== null && connectionAllowsChannel(detected, welcomeChannelId);
  const rosterAgent =
    mentionAgent === null ? null : (memberFor(directory, mentionAgent.agentMemberId) ?? null);

  const autoPassing =
    pose === null &&
    !list.isPending &&
    !providerLink.isPending &&
    !list.isError &&
    shouldAutoPass(list.data ?? [], providerLink.data?.configured === true);
  const showLoading =
    pose === "loading" ||
    (pose === null && (list.isPending || providerLink.isPending || autoPassing));
  const showOffline = pose === "offline" || offline;
  const showError = pose === "error" || Boolean(listError);
  const listLocked = showOffline || showError;

  const grokPill =
    grokProbe.desktop &&
    grokProbe.ready &&
    !grokProbe.probes.some((probe) => probe.id === GROK_HOSTED_AGENT_ID && (probe.bundlePresent || probe.processRunning))
      ? GROK_NOT_INSTALLED_PILL_LABEL
      : null;

  // ---- 코메토 한 문장 (D11: 상태와 표정 1:1, 문장이 함께 간다) ----------------
  const harnessLabel = join ? HARNESS_LABEL[join.harness] : GROK_LABEL;
  const joinedName =
    join?.agentDisplayName ||
    (mentionAgent && mentionAgent.displayName !== "" ? mentionAgent.displayName : "에이전트");
  const guide = ((): { state: GuideState; line: string; detail?: string } => {
    switch (step) {
      case "skipped":
        return { state: "skipped", line: AI_CONNECT_SKIPPED_LINE };
      case "connect":
        if (joinFailure) return { state: "trouble", line: JOIN_ERROR_LINE };
        if (joinPending || !join?.plan) return { state: "checking", line: JOIN_CREATING_LINE };
        return {
          state: "awaiting",
          line: joinConnectLine(join.harness),
          detail: joinConnectDetail(join.harness),
        };
      case "issuing":
        return { state: "awaiting", line: AI_CONNECT_QUESTION };
      case "detecting":
        return { state: "checking", line: joinWaitingLine(harnessLabel) };
      case "cap-exceeded":
        return { state: "trouble", line: JOIN_CAP_LINE, detail: JOIN_CAP_DETAIL };
      case "mention":
      case "done":
        return {
          state: "success",
          line: joinJoinedLine(joinedName),
          detail: join ? JOIN_JOINED_DETAIL : undefined,
        };
      default: {
        if (joinFailure) return { state: "trouble", line: joinFailure };
        if (showError) return { state: "trouble", line: AI_CONNECT_LIST_ERROR_LINE };
        if (surface === "rows") {
          if (harness.probes === null) {
            return { state: "checking", line: AI_CONNECT_PROBING_LINE };
          }
          const ready = rows.find(
            (id) => isSubscriptionRow(id) && subscriptionRowSelectable(harness.pill(id))
          );
          if (ready && isSubscriptionRow(ready)) {
            return {
              state: "success",
              line: aiConnectFoundLine(ready),
              detail: AI_CONNECT_QUESTION_DETAIL,
            };
          }
        }
        return { state: "awaiting", line: AI_CONNECT_QUESTION, detail: AI_CONNECT_QUESTION_DETAIL };
      }
    }
  })();

  const reentry = (
    <p className="onboarding-reentry" data-testid="first-agent-reentry-line">
      {AI_CONNECT_REENTRY}
    </p>
  );

  const skipButton = (
    <Button
      type="button"
      variant="ghost"
      className="ai-connect-skip"
      onClick={handleSkip}
      data-testid="first-agent-skip"
    >
      {AI_CONNECT_SKIP_LABEL}
    </Button>
  );

  const body = (() => {
    if (step === "skipped") {
      return (
        <div className="flex flex-col gap-3" data-testid="first-agent-skipped">
          <Button
            type="button"
            className={ONBOARDING_ACTION_CLASS}
            onClick={() => {
              setFirstAgentResumeHash(`#${FIRST_AGENT_AI_HREF}`);
              finish("skipped");
            }}
            data-testid="first-agent-skipped-continue"
          >
            {AI_CONNECT_CONTINUE_LABEL}
          </Button>
        </div>
      );
    }

    if (pose === "one-time") {
      return (
        <div className="flex min-w-0 flex-col items-stretch gap-3">
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
          {reentry}
        </div>
      );
    }

    if (step === "issuing") return null;

    if (step === "connect") {
      return (
        <div className="flex min-w-0 flex-col gap-3" data-testid="first-agent-connect">
          {joinFailure ? (
            <InlineBanner
              message={joinFailure}
              actionLabel={JOIN_RETRY_LABEL}
              onAction={() => {
                if (join) void startSubscriptionJoin(join.harness);
              }}
              testId="first-agent-connect-error"
            />
          ) : join?.plan ? (
            <SubscriptionConnectBlock
              harness={join.harness}
              plan={join.plan}
              onHandedOff={() => setStep("detecting")}
            />
          ) : (
            <div role="status" className="w-full" data-testid="first-agent-connect-pending">
              <Skeleton ready={false} rows={1} className="p-0" />
            </div>
          )}
          <div className="ai-connect-actions">
            <Button
              type="button"
              variant="ghost"
              className="ai-connect-skip"
              onClick={handleBackToList}
              data-testid="first-agent-back"
            >
              {JOIN_BACK_LABEL}
            </Button>
            {skipButton}
          </div>
          {reentry}
        </div>
      );
    }

    if (step === "detecting") {
      return (
        <div className="flex min-w-0 flex-col gap-3" data-testid="first-agent-detecting">
          {join?.plan && (
            <SubscriptionConnectBlock harness={join.harness} plan={join.plan} onHandedOff={() => undefined} />
          )}
          <div role="status" className="flex min-w-0 flex-col gap-1">
            <p
              className="flex min-w-0 flex-wrap items-baseline gap-2 text-meta text-ink-muted"
              data-testid="first-agent-elapsed"
            >
              <span data-numeric>{elapsedLabel(detectStartedAtMs, nowMs)}</span>
              <span>{formatDetectPollWait(nextPollMs)}</span>
            </p>
            {!join && (
              <p className="break-keep text-body text-ink-muted">
                {firstAgentDetectingDetail("grok")}
              </p>
            )}
          </div>
          <div className="ai-connect-actions">{skipButton}</div>
          {reentry}
        </div>
      );
    }

    if (step === "cap-exceeded") {
      return (
        <div className="flex min-w-0 flex-col gap-3" data-testid="first-agent-cap-exceeded">
          {join?.plan && (
            <SubscriptionConnectBlock harness={join.harness} plan={join.plan} onHandedOff={() => undefined} />
          )}
          <p
            role="status"
            className="break-keep text-meta text-ink-muted"
            data-testid="first-agent-recheck-status"
          >
            {recheckStatus ?? ""}
          </p>
          <div className="ai-connect-actions">
            <Button
              type="button"
              className={cn(ONBOARDING_ACTION_CLASS, "flex-1")}
              onClick={() => {
                void handleRecheck();
              }}
              data-testid="first-agent-recheck"
            >
              {JOIN_RECHECK_LABEL}
            </Button>
            {skipButton}
          </div>
          {reentry}
        </div>
      );
    }

    if (step === "mention" || step === "done") {
      const channelName = welcomeChannel?.name ?? "";
      const actionHref = channelHref(welcomeChannelId);
      return (
        <div className="flex w-full min-w-0 flex-col items-stretch gap-3" data-testid="first-agent-mention">
          {mentionAgent && mentionAgent.displayName !== "" && (
            <div className="ai-connect-joined">
              <div className="shrink-0">
                <Avatar member={rosterAgent} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-px" data-testid="first-agent-mention-column">
                <div className="flex min-w-0 items-baseline gap-2">
                  <TruncatingName
                    name={join?.agentDisplayName || mentionAgent.displayName}
                    className="min-w-0 truncate text-body font-semibold text-agent"
                    testId="first-agent-mention-name"
                  />
                  <span className="shrink-0 rounded-sm bg-agent-soft px-1 text-timestamp text-agent">
                    {FIRST_MENTION_AGENT_BADGE}
                  </span>
                </div>
                <TruncatingName
                  name={`@${pose === "sub-joined" ? firstAgentCaptureSubscription().agentHandle : mentionAgent.handle}`}
                  className="min-w-0 truncate text-meta text-ink-muted"
                  testId="first-agent-mention-handle"
                />
              </div>
            </div>
          )}
          {mentionApproved && channelName !== "" ? null : (
            <p className="break-keep text-meta text-ink-muted" data-testid="first-agent-channel-pending">
              {FIRST_AGENT_CHANNEL_PENDING}{" "}
              <Link
                to={FIRST_AGENT_REENTRY_HREF}
                className="tap-target press inline-flex items-center whitespace-nowrap rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:focus-ring"
                onClick={() => {
                  setFirstAgentResumeHash(`#${FIRST_AGENT_REENTRY_HREF}`);
                  finish("skipped");
                }}
                data-testid="first-agent-reentry"
              >
                {FIRST_AGENT_REENTRY_LABEL}
              </Link>
            </p>
          )}
          <Button
            type="button"
            className={ONBOARDING_ACTION_CLASS}
            onClick={handleMentionHandoff}
            data-testid="first-agent-mention-action"
            data-href={`#${actionHref}`}
          >
            {AI_CONNECT_CONTINUE_LABEL}
          </Button>
        </div>
      );
    }

    const primaryLocked = selected === null || listLocked;
    return (
      <div className="flex w-full min-w-0 flex-col items-stretch gap-3" data-testid="first-agent-cards">
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
        {showLoading ? (
          <div role="status" className="flex w-full min-w-0 flex-col gap-3" data-testid="first-agent-loading">
            <p className="break-keep text-body text-ink-muted">연결 목록을 불러옵니다.</p>
            <div className="w-full min-w-0">
              <Skeleton ready={false} rows={3} className="p-0" />
            </div>
          </div>
        ) : (
          <>
            {surface === "desktop-only" && (
              <p className="ai-connect-note" data-testid="first-agent-desktop-only">
                <NoteIcon />
                <span>{AI_CONNECT_DESKTOP_ONLY_NOTE}</span>
              </p>
            )}
            {surface === "server-off" && (
              <p className="ai-connect-note" data-testid="first-agent-server-off">
                <NoteIcon />
                <span>{AI_CONNECT_SERVER_OFF_NOTE}</span>
              </p>
            )}
            <AiConnectList
              rows={rows}
              selected={selected}
              onSelect={setSelected}
              pill={harness.pill}
              onLoginStart={harness.startLoginWatch}
              onRecheck={harness.recheck}
              grokPill={grokPill}
              locked={listLocked}
              describedBy={
                showOffline
                  ? FIRST_AGENT_OFFLINE_REASON_ID
                  : showError
                    ? FIRST_AGENT_ERROR_REASON_ID
                    : undefined
              }
            />
            {surface === "rows" && (
              <p className="ai-connect-note" data-testid="first-agent-boundary-note">
                <NoteIcon />
                <span>{AI_CONNECT_BOUNDARY_NOTE}</span>
              </p>
            )}
            <div className="ai-connect-actions">
              <Button
                type="button"
                className={cn(
                  ONBOARDING_ACTION_CLASS,
                  "flex-1",
                  primaryLocked &&
                    "pointer-events-none cursor-default opacity-50 hover:opacity-50 aria-disabled:active:transform-none"
                )}
                aria-disabled={primaryLocked || undefined}
                onClick={() => {
                  if (primaryLocked || selected === null) return;
                  handlePick(selected);
                }}
                data-testid="first-agent-continue"
              >
                {primaryActionLabel(selected)}
              </Button>
              {skipButton}
            </div>
          </>
        )}
        {reentry}
      </div>
    );
  })();

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
      <OnboardingSlideTransition transitionKey={step} className="flex w-full justify-center">
        <div
          className="onboarding-frame-col ai-connect-col"
          data-testid="first-agent-stage"
          data-step={step}
          role="region"
          aria-labelledby={FIRST_AGENT_HEADING_ID}
        >
          <KomettoGuide
            as="h1"
            expression={expressionForState(guide.state)}
            line={guide.line}
            detail={guide.detail}
            lineRef={headingRef}
            lineTestId={FIRST_AGENT_HEADING_ID}
            lineId={FIRST_AGENT_HEADING_ID}
          />
          {body}
        </div>
      </OnboardingSlideTransition>
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
          refreshRoster();
          setStep("detecting");
        }}
      />
    </OnboardingFrame>
  );
}

function NoteIcon() {
  return (
    <svg
      className="ai-connect-note-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16.5v.01" />
    </svg>
  );
}
