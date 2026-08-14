import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import {
  Field,
  KeyValueRows,
  StatusChip,
  CopyButton,
} from "@/features/settings/SettingsFields";
import {
  channelLabel,
  memberFor,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import { uuidEq } from "@momo/core/lib/api";
import { normalizedId } from "@momo/core/features/agents/hubModel";
import {
  agentDisplayNameIssue,
  agentDisplayNameIssueMessage,
  agentHandleIssue,
  agentHandleIssueMessage,
  normalizeAgentHandle,
} from "@/features/agentHub/createModel";
import {
  confirmHostedConnection,
  createHostedConnection,
  regenerateHostedPairing,
} from "@momo/core/features/hostedAgents/api";
import {
  boundedLabel,
  connectionFacts,
  hostedFailureMessage,
  hostedStatusDetail,
  hostedStatusLabel,
  hostedStatusTone,
  isHostedOperatorDenied,
  isHostedTerminal,
  parseActivationIssuance,
  parsePairingIssuance,
  HOSTED_AUTH_MODE,
  type HostedAgentConnection,
  type RevealedActiveCredential,
  type RevealedPairingChallenge,
} from "@momo/core/features/hostedAgents/model";
import {
  awaitingProof,
  confirmStateGate,
  hostedLiveMessage,
  hostedStepSpec,
  hostedWizardStep,
  HOSTED_CLOSED_NOTICE,
  HOSTED_WIZARD_LEAD,
  HOSTED_WIZARD_STEPS,
  HOSTED_WIZARD_TITLE,
  pairingExpiry,
  regenerateGate,
  testMentionGate,
  testMentionSentence,
  type HostedWizardStep,
} from "@momo/core/features/hostedAgents/wizard";
import {
  approvalConsequence,
  APPROVAL_CHANGE_NOTE,
  APPROVAL_SECURITY_NOTE,
  buildConfirmApproval,
  channelApprovalChoices,
  DEFAULT_HOSTED_SCOPES,
  HOSTED_SCOPE_CHOICES,
  normalizeScopes,
  type ApprovalChannelInput,
} from "@momo/core/features/hostedAgents/approval";
import {
  ACTIVE_REVEAL_HEADLINE,
  ACTIVE_REVEAL_PROOF_NOTE,
  ACTIVE_REVEAL_WARNING,
  agentPortEndpoint,
  hostedPreset,
  hostedRoutineLabel,
  HOSTED_AUTH_MODE_CHOICES,
  HOSTED_PRESETS,
  HOSTED_ROUTINE_TEMPLATE,
  PAIRING_REVEAL_HEADLINE,
  PAIRING_REVEAL_SCOPE_NOTE,
  PAIRING_REVEAL_WARNING,
  UNRESOLVABLE_ENDPOINT_NOTICE,
  type HostedPresetId,
} from "@momo/core/features/hostedAgents/presets";
import {
  serverSaysAbsent,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";
import { absoluteApiBase } from "@/lib/serverBase";
import { ChoiceList, type ChoiceListItem } from "./ChoiceList";
import {
  hostedConnectionQuery,
  hostedConnectionQueryKey,
  hostedListQuery,
  hostedListQueryKey,
  hostedWorkspaceQuery,
  purgeHostedCredentials,
  HOSTED_CREDENTIAL_MUTATION_SCOPE,
} from "./hostedCredentialScope";
import { OneTimeSecretCard } from "./OneTimeSecretCard";

// =============================================================================
// "Bring your hosted agent" pairing wizard (ADR-0162, goal HAP-UX1 / #1360).
//
// 다섯 단계이고, 그중 둘은 **이 화면이 일으키지 않는 사건**을 기다린다: 감지는
// 상대 에이전트가 다이얼인해야 일어나고, 활성은 그 에이전트가 새 자격증명으로
// 증명해야 일어난다. 그래서 진행도는 서버 상태에서 도출되고
// (`@momo/core/features/hostedAgents/wizard`), 이 파일이 들고 있는 지역 상태는
// 코어가 알 수 없는 것들뿐이다: 지금 화면에 떠 있는 비밀값, 폼 초안, 아직 저장되지
// 않은 승인 선택.
//
// ## 비밀값 둘, 규율 하나
//
// 연결 값과 active 자격증명은 서로 다른 비밀이다(ADR-0162 D6). 둘 다 컴포넌트
// 상태에서만 살고, 쿼리 캐시·localStorage·URL·로그 어디에도 가지 않으며,
// 다음 넷 중 어느 것이 일어나도 메모리 사본이 버려진다:
//
//   1. 사람이 「저장했습니다」를 누른다
//   2. 다이얼로그가 닫힌다(언마운트 정리)
//   3. 값이 만료되거나 재발급된다
//   4. **서버 상태가 그 값을 소비했다고 말한다** — 감지되는 순간 연결 값은 죽은
//      문자열이므로, 화면에 남겨 두면 아직 쓸 수 있는 값처럼 보인다
//
// Esc 와 바깥 클릭은 값이 떠 있는 동안 막는다. 이 표면은 Radix 다이얼로그 안이라
// `useEscapeGuard` 가 아니라 `onEscapeKeyDown` 이 그 자리다: 층 스택은 열린
// 다이얼로그가 있으면 아예 넘기지 않으므로(design/ui/escapeLayer.ts), 여기서 층을
// 잡으면 아무 일도 하지 않는 층이 하나 늘 뿐이다.
//
// ## 왜 목록을 먼저 보는가
//
// 이 흐름은 사람이 화면을 떠난 사이에 진행된다(provider 설정을 하러 간다). 그래서
// 다시 열었을 때 처음부터 시작하라고 하면 그 사람은 두 번째 전용 에이전트를
// 만든다. 진행 중인 연결이 있으면 먼저 그것을 보여주고, 서버 상태가 자리를
// 복원한다.
// =============================================================================

type WizardScreen = "picker" | HostedWizardStep;

interface Draft {
  displayName: string;
  handle: string;
}

const EMPTY_DRAFT: Draft = { displayName: "", handle: "" };

export function HostedAgentWizard({
  open,
  onOpenChange,
  opener,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener?: DialogFocusTarget | null;
}) {
  if (!open) return null;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <HostedWizardBody onClose={() => onOpenChange(false)} opener={opener ?? null} />
    </Dialog>
  );
}

function HostedWizardBody({
  onClose,
  opener,
}: {
  onClose: () => void;
  opener: DialogFocusTarget | null;
}) {
  const { workspaceId, session } = useSession();
  const client = useQueryClient();
  const offline = useOffline();
  const { directory } = useDirectory(workspaceId);
  const { groups } = useChannels(workspaceId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startingNew, setStartingNew] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [presetId, setPresetId] = useState<HostedPresetId>("generic");
  const [pairing, setPairing] = useState<RevealedPairingChallenge | null>(null);
  const [issued, setIssued] = useState<RevealedActiveCredential | null>(null);
  const [channelSelection, setChannelSelection] = useState<string[]>([]);
  const [scopeSelection, setScopeSelection] = useState<string[]>([
    ...DEFAULT_HOSTED_SCOPES,
  ]);
  const [failure, setFailure] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const list = useQuery(hostedListQuery(workspaceId));
  const workspace = useQuery(hostedWorkspaceQuery(workspaceId));
  const connectionId = selectedId ?? "";
  const detail = useQuery({
    ...hostedConnectionQuery(
      workspaceId,
      connectionId,
      // 남의 프로세스를 기다리는 두 구간에서만 되묻는다. 오프라인에서는 되물어야
      // 할 상대가 없다.
      !offline && selectedId !== null
    ),
    enabled: selectedId !== null,
  });

  const connection: HostedAgentConnection | null =
    detail.data ?? issued?.connection ?? pairing?.connection ?? null;
  const step = hostedWizardStep(connection, pairing !== null);
  const screen: WizardScreen = resolveScreen({
    step,
    selectedId,
    startingNew,
    listPending: list.isPending,
    listFailed: list.isError,
    resumable: resumableConnections(list.data ?? []),
  });

  // 고른 연결의 상태를 아직 한 번도 읽지 못한 두 자리. 화면이 그 사이를 1단계로
  // 메우면 사람은 자기가 이어서 진행하려던 연결이 사라졌다고 읽는다.
  const detailLoading = selectedId !== null && connection === null && detail.isPending;
  const detailError =
    selectedId !== null && connection === null && detail.isError
      ? detail.error
      : null;

  const agent = connection ? memberFor(directory, connection.agentMemberId) : null;
  const agentLabel = agent?.displayName ?? draft.displayName.trim();
  const agentHandle = agent?.handle ?? normalizeAgentHandle(draft.handle);
  const endpoint = agentPortEndpoint(absoluteApiBase());

  // 비밀값이 떠 있으면 이 다이얼로그는 닫히지 않는다. 서버가 원문을 보관하지
  // 않으므로 Esc 한 번이 다시 만들 수 없는 값을 확인 없이 없앤다.
  const holdingSecret = pairing !== null || issued !== null;

  // 1분에 한 번 시계를 돌린다. 만료 표시는 분 단위라 그보다 잦게 돌 이유가 없고,
  // 초 단위로 뛰는 숫자는 읽는 사람을 재촉할 뿐이다.
  useEffect(() => {
    if (pairing === null) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  // 서버가 "그 값은 이미 소비됐다"고 말하면 메모리 사본도 버린다. 감지된 뒤의
  // 연결 값은 죽은 문자열이고, 화면에 남겨 두면 아직 쓸 수 있는 것처럼 보인다.
  const serverStatus = connection?.status;
  useEffect(() => {
    if (serverStatus !== undefined && serverStatus !== "pairing_pending") {
      setPairing(null);
    }
  }, [serverStatus]);

  // 언마운트에서 캐시에 남은 원문을 비운다. 「저장했습니다」를 누르지 않고 떠나는
  // 경로가 정확히 이것이고, 그 경로에만 보장이 없다.
  useEffect(() => () => void purgeHostedCredentials(client), [client]);

  function forgetSecrets() {
    setPairing(null);
    setIssued(null);
    purgeHostedCredentials(client);
  }

  function pickConnection(id: string) {
    forgetSecrets();
    setFailure(null);
    setSelectedId(normalizedId(id));
    setStartingNew(false);
  }

  const create = useMutation({
    ...HOSTED_CREDENTIAL_MUTATION_SCOPE,
    mutationFn: async () => {
      const wire = await createHostedConnection(workspaceId, {
        displayName: draft.displayName.trim(),
        handle: normalizeAgentHandle(draft.handle),
        authMode: HOSTED_AUTH_MODE,
      });
      return parsePairingIssuance(wire);
    },
    onSuccess: (issuance) => {
      setFailure(null);
      setDraft(EMPTY_DRAFT);
      setSelectedId(normalizedId(issuance.connection.id));
      setStartingNew(false);
      setPairing(issuance);
      setNowMs(Date.now());
      // 비밀값 없는 커넥션만 캐시에 심는다(타입이 비밀값을 담지 못한다).
      client.setQueryData(
        hostedConnectionQueryKey(workspaceId, normalizedId(issuance.connection.id)),
        issuance.connection
      );
      void client.invalidateQueries({ queryKey: hostedListQueryKey(workspaceId) });
    },
    onError: (error) => setFailure(hostedFailureMessage("create", error)),
  });

  const regenerate = useMutation({
    ...HOSTED_CREDENTIAL_MUTATION_SCOPE,
    // 한 번에 한 값만 화면에 둔다: 새 값을 받으러 가는 순간 앞선 카드는 곧
    // 대체될 값을 저장하라고 말하는 판이 된다.
    onMutate: () => forgetSecrets(),
    mutationFn: async () => {
      if (selectedId === null) throw new Error("no connection");
      const wire = await regenerateHostedPairing(workspaceId, selectedId);
      return parsePairingIssuance(wire, { connectionId: selectedId });
    },
    onSuccess: (issuance) => {
      setFailure(null);
      setPairing(issuance);
      setNowMs(Date.now());
      client.setQueryData(
        hostedConnectionQueryKey(workspaceId, normalizedId(issuance.connection.id)),
        issuance.connection
      );
      void client.invalidateQueries({ queryKey: hostedListQueryKey(workspaceId) });
    },
    onError: (error) => setFailure(hostedFailureMessage("regenerate", error)),
  });

  const channelInputs = useMemo<ApprovalChannelInput[]>(() => {
    const named = groups.channels.map((channel) => ({
      id: channel.id,
      label: `#${channelLabel(channel, directory, session.member.id)}`,
      kind: channel.kind,
      ...(channel.archivedAtMs === undefined
        ? {}
        : { archivedAtMs: channel.archivedAtMs }),
    }));
    const dms = groups.dms.map((channel) => ({
      id: channel.id,
      label: channelLabel(channel, directory, session.member.id),
      kind: channel.kind,
    }));
    return [...named, ...dms];
  }, [groups.channels, groups.dms, directory, session.member.id]);

  const confirm = useMutation({
    ...HOSTED_CREDENTIAL_MUTATION_SCOPE,
    mutationFn: async () => {
      if (connection === null || selectedId === null) throw new Error("no connection");
      const approval = buildConfirmApproval(
        connection,
        channelInputs,
        channelSelection,
        scopeSelection
      );
      const wire = await confirmHostedConnection(workspaceId, selectedId, approval);
      return parseActivationIssuance(wire, { connectionId: selectedId });
    },
    onSuccess: (activation) => {
      setFailure(null);
      setPairing(null);
      setIssued(activation);
      client.setQueryData(
        hostedConnectionQueryKey(workspaceId, normalizedId(activation.connection.id)),
        activation.connection
      );
      void client.invalidateQueries({ queryKey: hostedListQueryKey(workspaceId) });
    },
    onError: (error) => setFailure(hostedFailureMessage("confirm", error)),
  });

  const busy = create.isPending || regenerate.isPending || confirm.isPending;
  const preset = hostedPreset(presetId);
  const spec = hostedStepSpec(step);
  const live = screen === "picker"
    ? "진행 중인 연결 목록입니다. 이어서 진행하거나 새 연결을 만드세요."
    : detailLoading
      ? "연결 상태를 불러오는 중입니다."
      : hostedLiveMessage(step, connection);

  return (
    <DialogContent
      opener={opener}
      className="max-h-full"
      onEscapeKeyDown={(event) => {
        // 다시 만들 수 없는 값 앞에서 Esc 의 올바른 뜻은 무반응이다.
        if (holdingSecret || busy) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (holdingSecret || busy) event.preventDefault();
      }}
      data-testid="hosted-agent-wizard"
    >
      <div className="flex min-w-0 flex-col gap-1 border-b border-line p-4">
        <DialogTitle>{HOSTED_WIZARD_TITLE}</DialogTitle>
        <DialogDescription className="break-keep">
          {HOSTED_WIZARD_LEAD}
        </DialogDescription>
        {screen !== "picker" && screen !== "closed" && (
          <StepRail current={spec.number} />
        )}
        {/* 상태 전이는 소리로도 알린다. 비밀값은 절대 담기지 않는다. */}
        <p role="status" aria-live="polite" className="sr-only">
          {live}
        </p>
      </div>

      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 마지막으로 받은 상태는 계속 볼 수 있고, 값 발급과 승인은 다시 연결된 뒤에 할 수 있습니다."
          testId="hosted-wizard-offline"
        />
      )}
      {failure && (
        <InlineBanner
          message={failure}
          actionLabel="닫기"
          onAction={() => setFailure(null)}
          testId="hosted-wizard-failure"
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        {detailLoading && (
          <div role="status">
            <span className="sr-only">연결 상태를 불러오는 중입니다.</span>
            <SkeletonRows rows={4} className="p-0" />
          </div>
        )}
        {detailError !== null && (
          <InlineBanner
            separator={false}
            message={hostedFailureMessage("get", detailError)}
            actionLabel="다시 시도"
            onAction={() => void detail.refetch()}
            testId="hosted-wizard-detail-error"
          />
        )}

        {!detailLoading && detailError === null && screen === "picker" && (
          <PickerScreen
            connections={resumableConnections(list.data ?? [])}
            pending={list.isPending}
            error={list.isError ? list.error : null}
            onRetry={() => void list.refetch()}
            onPick={pickConnection}
            onStartNew={() => {
              forgetSecrets();
              setFailure(null);
              setStartingNew(true);
            }}
            nameFor={(id) => memberFor(directory, id)?.displayName ?? "이름을 읽지 못한 에이전트"}
          />
        )}

        {!detailLoading && detailError === null && screen === "identity" && (
          <IdentityStep
            draft={draft}
            setDraft={setDraft}
            touched={touched}
            presetId={presetId}
            setPresetId={setPresetId}
            disabled={offline || busy}
          />
        )}

        {screen === "pairing" && pairing !== null && (
          <PairingStep
            preset={preset}
            endpoint={endpoint}
            routineLabel={hostedRoutineLabel(
              workspace.data?.name ?? "oort",
              agentLabel
            )}
            pairing={pairing}
            nowMs={nowMs}
            onDone={() => {
              setPairing(null);
              purgeHostedCredentials(client);
            }}
          />
        )}

        {screen === "detecting" && connection !== null && (
          <DetectingStep
            connection={connection}
            agentLabel={agentLabel}
            checking={detail.isFetching}
            onRecheck={() => void detail.refetch()}
          />
        )}

        {screen === "expired" && connection !== null && (
          <ExpiredStep connection={connection} />
        )}

        {screen === "approval" && connection !== null && (
          <ApprovalStep
            connection={connection}
            agentLabel={agentLabel}
            channels={channelInputs}
            channelSelection={channelSelection}
            setChannelSelection={setChannelSelection}
            scopeSelection={scopeSelection}
            setScopeSelection={setScopeSelection}
            disabled={offline || busy}
          />
        )}

        {screen === "activation" && connection !== null && (
          <ActivationStep
            connection={connection}
            agentLabel={agentLabel}
            agentHandle={agentHandle}
            issued={issued}
            checking={detail.isFetching}
            channelName={approvedChannelName(connection, channelInputs)}
            onRecheck={() => void detail.refetch()}
            onDone={() => {
              setIssued(null);
              purgeHostedCredentials(client);
            }}
          />
        )}

        {screen === "closed" && (
          <InlineBanner
            tone="neutral"
            separator={false}
            message={HOSTED_CLOSED_NOTICE}
            testId="hosted-wizard-closed"
          />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line p-4">
        <WizardActions
          screen={screen}
          connection={connection}
          holdingSecret={holdingSecret}
          offline={offline}
          busy={busy}
          creating={create.isPending}
          regenerating={regenerate.isPending}
          confirming={confirm.isPending}
          draftReady={draftReady(draft)}
          onCreate={() => {
            setTouched(true);
            if (!draftReady(draft) || offline || busy) return;
            create.mutate();
          }}
          onRegenerate={() => {
            if (offline || busy) return;
            regenerate.mutate();
          }}
          onConfirm={() => {
            if (offline || busy) return;
            confirm.mutate();
          }}
          onClose={onClose}
        />
      </div>
    </DialogContent>
  );
}

// ---- 화면 고르기 -----------------------------------------------------------

/** 이 마법사가 이어서 진행할 수 있는 연결들. 해제 계열은 UX2 의 것이다. */
function resumableConnections(
  connections: readonly HostedAgentConnection[]
): HostedAgentConnection[] {
  return connections.filter((row) => !isHostedTerminal(row.status));
}

function resolveScreen(input: {
  step: HostedWizardStep;
  selectedId: string | null;
  startingNew: boolean;
  listPending: boolean;
  listFailed: boolean;
  resumable: readonly HostedAgentConnection[];
}): WizardScreen {
  if (input.selectedId !== null) return input.step;
  if (input.startingNew) return "identity";
  // 목록이 오기 전에는 목록 화면에 머문다. 한 프레임 1단계를 보여 줬다가 거두면
  // 사람은 자기가 이미 만든 연결이 사라졌다고 읽는다.
  if (input.listPending) return "picker";
  // 실패도 목록 화면에 머문다. 앞 판은 여기서 1단계로 떨어졌고, 그래서 **읽지
  // 못한 목록**이 "연결이 하나도 없음"처럼 보였다(캡처 레인이 잡았다). 이미 연결이
  // 있는데 못 읽은 사람에게 새로 만들라고 권하는 것은 쌍둥이 전용 에이전트를
  // 만들라는 말이고, 목록 오류 배너도 그 자리에서만 설 수 있다.
  if (input.listFailed) return "picker";
  return input.resumable.length > 0 ? "picker" : "identity";
}

function draftReady(draft: Draft): boolean {
  return (
    agentDisplayNameIssue(draft.displayName) === null &&
    agentHandleIssue(draft.handle) === null
  );
}

function approvedChannelName(
  connection: HostedAgentConnection,
  channels: readonly ApprovalChannelInput[]
): string | null {
  const first = connection.approvedChannelIds[0];
  if (first === undefined) return null;
  return channels.find((channel) => uuidEq(channel.id, first))?.label ?? null;
}

// ---- 진행 표시 --------------------------------------------------------------

/**
 * 다섯 단계와 지금 자리.
 *
 * 탭이 아니라 목록이다: 사람이 눌러서 이동할 수 있는 자리가 아니고, 다음 단계는
 * 이 화면이 아니라 서버가 연다. 순서가 있는 목록이므로 `ol` 이다.
 */
function StepRail({ current }: { current: number }) {
  return (
    <nav aria-label="연결 단계" className="pt-2">
      <ol className="flex flex-wrap gap-2">
        {HOSTED_WIZARD_STEPS.map((step) => {
          const state =
            step.number === current
              ? "current"
              : step.number < current
                ? "done"
                : "todo";
          return (
            <li key={step.id} className="shrink-0">
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1 rounded-sm px-2 py-px text-timestamp",
                  state === "current" && "bg-accent-soft text-ink",
                  state === "done" && "text-ink-muted",
                  state === "todo" && "text-ink-muted opacity-50"
                )}
                data-testid="hosted-step-chip"
                data-step-state={state}
              >
                <span data-numeric>{step.number}</span>
                <span>{step.title}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepHeading({ step }: { step: HostedWizardStep }) {
  const spec = hostedStepSpec(step);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="break-keep text-body font-semibold text-ink">{spec.title}</h3>
      <p className="break-keep text-meta text-ink-muted">{spec.purpose}</p>
    </div>
  );
}

// ---- 0. 이어서 진행 ---------------------------------------------------------

function PickerScreen({
  connections,
  pending,
  error,
  onRetry,
  onPick,
  onStartNew,
  nameFor,
}: {
  connections: readonly HostedAgentConnection[];
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  onPick: (id: string) => void;
  onStartNew: () => void;
  nameFor: (agentMemberId: string) => string;
}) {
  if (pending) {
    return (
      <div role="status">
        <span className="sr-only">진행 중인 연결을 불러오는 중입니다.</span>
        <SkeletonRows rows={3} className="p-0" />
      </div>
    );
  }
  if (error) {
    if (isHostedOperatorDenied(error)) {
      return (
        <EmptyInvite
          className="px-0"
          headline="호스티드 에이전트 연결은 오너나 관리자만 다룹니다."
          detail="이 워크스페이스의 관리자에게 연결을 요청하세요."
          testId="hosted-wizard-denied"
        />
      );
    }
    // 표가 앞서 갔거나 서버가 뒤처졌을 때(goal B12 의 이중 방어 (b)). 없는 기능을
    // 장애로 그리면 사람은 자기 네트워크를 의심하며 다시 시도를 반복한다.
    if (serverSaysAbsent(error)) {
      const surface = serverSurface("hostedAgentPairing");
      return (
        <EmptyInvite
          className="px-0"
          headline={surface.absentReason}
          detail={surface.fallback}
          testId="hosted-wizard-absent"
        />
      );
    }
    return (
      <InlineBanner
        separator={false}
        message={hostedFailureMessage("list", error)}
        actionLabel="다시 시도"
        onAction={onRetry}
        testId="hosted-wizard-list-error"
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div>
        <h3 className="text-body font-semibold text-ink">진행 중인 연결</h3>
        <p className="break-keep text-meta text-ink-muted">
          이어서 진행하면 중단한 자리에서 다시 시작합니다. 상태는 서버가 기억합니다.
        </p>
      </div>
      <ul className="flex flex-col overflow-hidden rounded-md border border-line">
        {connections.map((row) => (
          <li key={row.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => onPick(row.id)}
              className="flex w-full min-w-0 flex-col items-start gap-1 p-2 text-left hover:bg-surface-hover focus-visible:focus-ring"
              data-testid="hosted-wizard-resume"
              data-connection-id={normalizedId(row.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-body text-ink">
                  {boundedLabel(nameFor(row.agentMemberId))}
                </span>
                <StatusChip tone={chipTone(row)}>
                  {hostedStatusLabel(row.status)}
                </StatusChip>
              </span>
              <span className="break-keep text-meta text-ink-muted">
                {hostedStatusDetail(row)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {/* 두 번째 연결은 두 번째 전용 에이전트를 만든다는 뜻이다(ADR-0162 D6:
          한 연결 = 한 전용 멤버). 그 사실을 버튼 옆에 적어 두지 않으면 이어서
          진행할 자리를 못 찾은 사람이 여기를 누르고 명부에 쌍둥이를 남긴다. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onStartNew}
          data-testid="hosted-wizard-start-new"
        >
          다른 에이전트 새로 연결
        </Button>
        <span className="break-keep text-meta text-ink-muted">
          새 연결은 전용 에이전트를 하나 더 만듭니다.
        </span>
      </div>
    </div>
  );
}

function chipTone(connection: HostedAgentConnection) {
  const tone = hostedStatusTone(connection.status);
  return tone === "neutral" ? ("muted" as const) : tone;
}

// ---- 1. 이름 ----------------------------------------------------------------

function IdentityStep({
  draft,
  setDraft,
  touched,
  presetId,
  setPresetId,
  disabled,
}: {
  draft: Draft;
  setDraft: (next: Draft) => void;
  touched: boolean;
  presetId: HostedPresetId;
  setPresetId: (next: HostedPresetId) => void;
  disabled: boolean;
}) {
  const nameIssue = agentDisplayNameIssue(draft.displayName);
  const handleIssue = agentHandleIssue(draft.handle);
  const presetItems: ChoiceListItem[] = HOSTED_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.verified ? preset.label : `${preset.label} (확인되지 않음)`,
    detail: preset.verified
      ? preset.detail
      : `${preset.detail} ${preset.unverifiedNote ?? ""}`.trim(),
  }));
  const authItems: ChoiceListItem[] = HOSTED_AUTH_MODE_CHOICES.map((choice) => ({
    id: choice.id,
    label: choice.label,
    detail: choice.detail,
    ...(choice.disabled ? { disabled: true } : {}),
  }));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <StepHeading step="identity" />
      <div className="flex min-w-0 flex-col gap-3">
        <Field
          label="표시 이름"
          htmlFor="hosted-display-name"
          hint="사람들이 목록과 대화에서 보는 이름입니다."
          error={touched && nameIssue ? agentDisplayNameIssueMessage(nameIssue) : null}
        >
          <Input
            id="hosted-display-name"
            value={draft.displayName}
            disabled={disabled}
            onChange={(event) =>
              setDraft({ ...draft, displayName: event.target.value })
            }
            placeholder="Grok 리서치"
            data-testid="hosted-display-name"
          />
        </Field>
        <Field
          label="핸들"
          htmlFor="hosted-handle"
          hint="채널에서 이 이름으로 부릅니다. 영문 소문자, 숫자, 하이픈, 밑줄."
          error={touched && handleIssue ? agentHandleIssueMessage(handleIssue) : null}
        >
          <Input
            id="hosted-handle"
            value={draft.handle}
            disabled={disabled}
            onChange={(event) => setDraft({ ...draft, handle: event.target.value })}
            placeholder="grok-research"
            data-testid="hosted-handle"
          />
        </Field>
      </div>
      <ChoiceList
        name="hosted-preset"
        legend="어떤 에이전트를 붙이나요"
        hint="preset은 설정 순서와 문구만 바꿉니다. 만들어지는 연결은 같습니다."
        multiple={false}
        items={presetItems}
        selected={[presetId]}
        onChange={(next) => setPresetId((next[0] ?? "generic") as HostedPresetId)}
        disabled={disabled}
        testId="hosted-preset"
      />
      <ChoiceList
        name="hosted-auth-mode"
        legend="인증 방식"
        multiple={false}
        items={authItems}
        selected={[HOSTED_AUTH_MODE]}
        onChange={() => undefined}
        disabled={disabled}
        testId="hosted-auth-mode"
      />
    </div>
  );
}

// ---- 2. 연결 값 -------------------------------------------------------------

function PairingStep({
  preset,
  endpoint,
  routineLabel,
  pairing,
  nowMs,
  onDone,
}: {
  preset: ReturnType<typeof hostedPreset>;
  endpoint: string | null;
  routineLabel: string;
  pairing: RevealedPairingChallenge;
  nowMs: number;
  onDone: () => void;
}) {
  const expiry = pairingExpiry(pairing.pairingExpiresAtMs, nowMs);
  const rows = [
    {
      key: "Agent Port 주소",
      value: endpoint ?? UNRESOLVABLE_ENDPOINT_NOTICE,
      token: endpoint !== null,
    },
  ];
  if (preset.id === "grok") {
    rows.push({ key: "routine 이름", value: routineLabel, token: false });
    rows.push({ key: "routine 지시", value: HOSTED_ROUTINE_TEMPLATE, token: false });
  }
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <StepHeading step="pairing" />
      <SetupSteps preset={preset} />
      {endpoint && (
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton
            value={endpoint}
            label="주소 복사"
            subject="Agent Port 주소"
            testId="hosted-copy-endpoint"
          />
          {preset.id === "grok" && (
            <CopyButton
              value={routineLabel}
              label="routine 이름 복사"
              subject="routine 이름"
              testId="hosted-copy-routine"
            />
          )}
        </div>
      )}
      <OneTimeSecretCard
        headline={PAIRING_REVEAL_HEADLINE}
        warning={PAIRING_REVEAL_WARNING}
        notes={[PAIRING_REVEAL_SCOPE_NOTE]}
        rows={rows}
        secretLabel="연결 값"
        secret={pairing.pairingCredential}
        copyLabel="연결 값 복사"
        expiryLabel={expiry.label}
        onDone={onDone}
        testId="hosted-pairing-card"
      />
    </div>
  );
}

function SetupSteps({ preset }: { preset: ReturnType<typeof hostedPreset> }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-meta font-medium text-ink">{preset.label} 설정 순서</h4>
      {!preset.verified && preset.unverifiedNote && (
        <p className="break-keep text-meta text-warn" data-testid="hosted-preset-unverified">
          {preset.unverifiedNote}
        </p>
      )}
      <ol className="flex list-outside list-decimal flex-col gap-1 ps-4">
        {preset.steps.map((line) => (
          <li key={line} className="break-keep text-body text-ink-muted">
            {line}
          </li>
        ))}
      </ol>
      {preset.leavesBehind && (
        <p className="break-keep text-meta text-ink-muted">{preset.leavesBehind}</p>
      )}
    </div>
  );
}

// ---- 3. 감지 대기 -----------------------------------------------------------

function DetectingStep({
  connection,
  agentLabel,
  checking,
  onRecheck,
}: {
  connection: HostedAgentConnection;
  agentLabel: string;
  checking: boolean;
  onRecheck: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <StepHeading step="detecting" />
      <EmptyInvite
        className="px-0"
        headline="아직 다이얼인이 오지 않았습니다."
        detail="provider 설정에 값을 넣고 커넥터나 routine을 한 번 실행하면 이 화면이 바뀝니다. 이 창을 열어 둔 채로 다녀와도 됩니다."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-busy={checking || undefined}
            onClick={onRecheck}
            data-testid="hosted-recheck"
          >
            {checking && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {checking ? "확인 중" : "지금 확인"}
          </Button>
        }
        testId="hosted-detecting-empty"
      />
      <KeyValueRows
        rows={connectionFacts(connection, agentLabel).map((fact) => ({
          key: fact.key,
          value: fact.value,
          numeric: fact.token,
          prose: !fact.token,
        }))}
      />
    </div>
  );
}

// ---- 만료 -------------------------------------------------------------------

function ExpiredStep({ connection }: { connection: HostedAgentConnection }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <StepHeading step="expired" />
      <InlineBanner
        separator={false}
        message={hostedStatusDetail(connection)}
        testId="hosted-expired"
      />
      <p className="break-keep text-body text-ink-muted">
        이미 넣어 둔 값은 더 이상 통하지 않습니다. 새 값을 발급하면 provider 설정의
        값을 그것으로 바꿔야 합니다.
      </p>
    </div>
  );
}

// ---- 4. 사람 확인 -----------------------------------------------------------

function ApprovalStep({
  connection,
  agentLabel,
  channels,
  channelSelection,
  setChannelSelection,
  scopeSelection,
  setScopeSelection,
  disabled,
}: {
  connection: HostedAgentConnection;
  agentLabel: string;
  channels: readonly ApprovalChannelInput[];
  channelSelection: string[];
  setChannelSelection: (next: string[]) => void;
  scopeSelection: string[];
  setScopeSelection: (next: string[]) => void;
  disabled: boolean;
}) {
  const channelItems: ChoiceListItem[] = channelApprovalChoices(channels).map(
    (choice) => ({
      id: choice.id,
      label: choice.label,
      detail: choice.detail,
      ...(choice.disabled ? { disabled: true } : {}),
    })
  );
  const scopeItems: ChoiceListItem[] = HOSTED_SCOPE_CHOICES.map((choice) => ({
    id: choice.id,
    label: choice.label,
    detail: choice.required
      ? `${choice.detail} ${choice.requiredReason ?? ""}`.trim()
      : choice.detail,
    ...(choice.required ? { locked: true } : {}),
  }));
  const scopes = normalizeScopes(scopeSelection);
  const approvedCount = channelApprovalChoices(channels).filter(
    (choice) => !choice.disabled && channelSelection.includes(choice.id)
  ).length;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <StepHeading step="approval" />
      <KeyValueRows
        rows={connectionFacts(connection, agentLabel).map((fact) => ({
          key: fact.key,
          value: fact.value,
          numeric: fact.token,
          prose: !fact.token,
        }))}
      />
      <p className="break-keep text-body text-ink" data-testid="hosted-security-note">
        {APPROVAL_SECURITY_NOTE}
      </p>
      {channelItems.length === 0 ? (
        <EmptyInvite
          className="px-0"
          headline="승인할 채널이 없습니다."
          detail="채널을 먼저 만들고 다시 열면 그 채널을 승인할 수 있습니다."
          testId="hosted-approval-no-channels"
        />
      ) : (
        <ChoiceList
          name="hosted-channels"
          legend="닿을 채널"
          hint="고른 채널에서만 이 에이전트가 부름을 받습니다."
          multiple
          items={channelItems}
          selected={channelSelection}
          onChange={setChannelSelection}
          disabled={disabled}
          testId="hosted-channels"
        />
      )}
      <ChoiceList
        name="hosted-scopes"
        legend="열어 줄 권한"
        multiple
        items={scopeItems}
        selected={scopes}
        onChange={setScopeSelection}
        disabled={disabled}
        testId="hosted-scopes"
      />
      <div className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface-hover p-3">
        <p className="break-keep text-body text-ink" data-testid="hosted-consequence">
          {approvalConsequence(agentLabel, approvedCount, scopes)}
        </p>
        <p className="break-keep text-meta text-ink-muted">{APPROVAL_CHANGE_NOTE}</p>
      </div>
    </div>
  );
}

// ---- 5. 자격증명 교체과 활성 -------------------------------------------------

function ActivationStep({
  connection,
  agentLabel,
  agentHandle,
  issued,
  checking,
  channelName,
  onRecheck,
  onDone,
}: {
  connection: HostedAgentConnection;
  agentLabel: string;
  agentHandle: string;
  issued: RevealedActiveCredential | null;
  checking: boolean;
  channelName: string | null;
  onRecheck: () => void;
  onDone: () => void;
}) {
  const waiting = awaitingProof(connection);
  const mention = testMentionGate(connection);
  const firstChannel = connection.approvedChannelIds[0];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <StepHeading step="activation" />
      {issued !== null ? (
        <OneTimeSecretCard
          headline={ACTIVE_REVEAL_HEADLINE}
          warning={ACTIVE_REVEAL_WARNING}
          notes={[ACTIVE_REVEAL_PROOF_NOTE]}
          secretLabel="Agent Port 자격증명"
          secret={issued.credential}
          copyLabel="자격증명 복사"
          onDone={onDone}
          testId="hosted-active-card"
        />
      ) : waiting ? (
        <EmptyInvite
          className="px-0"
          headline="새 자격증명으로 첫 요청이 오기를 기다리는 중입니다."
          detail="provider 설정의 값을 새 자격증명으로 바꾸고 커넥터나 routine을 한 번 실행하세요. 그 요청이 성공해야 활성이 됩니다."
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-busy={checking || undefined}
              onClick={onRecheck}
              data-testid="hosted-recheck"
            >
              {checking && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {checking ? "확인 중" : "지금 확인"}
            </Button>
          }
          testId="hosted-awaiting-proof"
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <p className="break-keep text-body text-ink" data-testid="hosted-active-note">
            {hostedStatusDetail(connection)}
          </p>
          {mention.allowed && firstChannel ? (
            <div className="flex min-w-0 flex-col gap-2">
              <p className="break-keep text-body text-ink-muted">
                {testMentionSentence(channelName ?? "승인한 채널", agentHandle)}
              </p>
              <Button variant="outline" size="sm" className="self-start" asChild>
                <Link to={`/c/${normalizedId(firstChannel)}`} data-testid="hosted-test-mention">
                  채널 열고 테스트 멘션
                </Link>
              </Button>
            </div>
          ) : (
            <p className="break-keep text-body text-ink-muted" data-testid="hosted-mention-blocked">
              {mention.blockedCopy}
            </p>
          )}
        </div>
      )}
      <KeyValueRows
        rows={connectionFacts(connection, agentLabel).map((fact) => ({
          key: fact.key,
          value: fact.value,
          numeric: fact.token,
          prose: !fact.token,
        }))}
      />
    </div>
  );
}

// ---- 푸터 -------------------------------------------------------------------

function WizardActions({
  screen,
  connection,
  holdingSecret,
  offline,
  busy,
  creating,
  regenerating,
  confirming,
  draftReady: ready,
  onCreate,
  onRegenerate,
  onConfirm,
  onClose,
}: {
  screen: WizardScreen;
  connection: HostedAgentConnection | null;
  holdingSecret: boolean;
  offline: boolean;
  busy: boolean;
  creating: boolean;
  regenerating: boolean;
  confirming: boolean;
  draftReady: boolean;
  onCreate: () => void;
  onRegenerate: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // 값이 떠 있는 동안 나가는 길은 그 카드의 「저장했습니다」 하나다. 닫기 버튼을
  // 함께 세우면 다시 만들 수 없는 값 옆에 그것을 버리는 버튼을 놓는 셈이다.
  if (holdingSecret) {
    return (
      <p className="text-meta text-ink-muted" data-testid="hosted-hold-note">
        값을 옮긴 뒤 저장했습니다를 누르면 이어서 진행합니다.
      </p>
    );
  }

  const regen = regenerateGate(connection);
  const confirmState = confirmStateGate(connection);

  return (
    <>
      {(screen === "detecting" || screen === "expired") &&
        (regen.allowed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={offline || busy || undefined}
            aria-busy={regenerating || undefined}
            className={cn((offline || busy) && "opacity-50")}
            onClick={onRegenerate}
            data-testid="hosted-regenerate"
          >
            {regenerating && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {regenerating ? "발급 중" : "연결 값 다시 발급"}
          </Button>
        ) : (
          // 사유는 호버 뒤가 아니라 글로 선다. 잠긴 컨트롤 옆에 tooltip 만 다는
          // 것은 키보드와 스크린리더에게 아무 말도 하지 않는 것과 같다.
          <p
            className="break-keep text-meta text-ink-muted"
            data-testid="hosted-regenerate-blocked"
          >
            {regen.blockedCopy}
          </p>
        ))}
      <Button type="button" variant="outline" size="sm" onClick={onClose} data-testid="hosted-close">
        닫기
      </Button>
      {screen === "identity" && (
        <Button
          type="button"
          size="sm"
          aria-disabled={offline || busy || !ready || undefined}
          aria-busy={creating || undefined}
          className={cn((offline || busy || !ready) && "opacity-50")}
          onClick={onCreate}
          data-testid="hosted-create"
        >
          {creating && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {creating ? "만드는 중" : "연결 만들기"}
        </Button>
      )}
      {screen === "approval" && (
        <Button
          type="button"
          size="sm"
          aria-disabled={offline || busy || !confirmState.allowed || undefined}
          aria-busy={confirming || undefined}
          className={cn(
            (offline || busy || !confirmState.allowed) && "opacity-50"
          )}
          onClick={onConfirm}
          data-testid="hosted-confirm"
        >
          {confirming && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {confirming ? "승인 저장 중" : "이 범위로 승인"}
        </Button>
      )}
    </>
  );
}
