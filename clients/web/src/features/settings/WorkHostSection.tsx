import { useEffect, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  fetchWorkHostEngine,
  fetchWorkTierPolicy,
  listWorkHosts,
  putWorkHostEngine,
  putWorkTierPolicy,
  type WorkHost,
  type WorkTierPolicy,
  type WorkTierScope,
} from "./api";
import {
  autoTargetLabel,
  CLOUD_TARGET,
  eligibleAutoTargets,
  errorMessage,
  isOperatorDenied,
  relativeSince,
  WORK_ENGINES,
  WORK_TIER_MODES,
  workHostRegistryMessage,
  workHostScopeLabel,
  workHostStatus,
  workHostTypeLabel,
  workTierPolicySaveMessage,
} from "./model";
import {
  ChoiceRadios,
  CopyButton,
  OperatorNotice,
  SectionShell,
  SelectField,
  StatusChip,
  Subsection,
} from "./SettingsFields";

// =============================================================================
// 코드 실행 호스트 (R-1 §5 + AX-6a / MOMO-617): everything about where an agent
// actually runs a command, in one section with three blocks.
//
//   실행 엔진           which engine the workspace runs (ADR-0004: a LABEL only,
//                       never a credential and never a host-local path)
//   등록된 호스트        the ADR-0125 registry: name, kind, liveness, host id
//   호스트 상실 시 재개   the D11 tier policy, member override + workspace default
//
// Three blocks rather than three nav entries: they are one subject, and each
// block owns its own query so an operator-only 403 on one never blanks the
// other two.
//
// Tier NUMBERS (T1/T2/T3) stay internal, exactly as on macOS: the person picks
// a behaviour ("연결 끊김 시 묻기"), never a tier. The mode copy is inherited
// from MomoWorkConsoleCopy.swift so both clients say the same thing about the
// same ledger row.
// =============================================================================

export function WorkHostSection({
  workspaceId,
  memberId,
  offline,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
}) {
  // One read of the registry serves both the list and the auto-target choices.
  const hosts = useQuery({
    queryKey: ["settings", "work-hosts", workspaceId],
    queryFn: () => listWorkHosts(workspaceId),
    retry: false,
  });

  return (
    <SectionShell
      title="코드 실행 호스트"
      lines={[
        "에이전트가 실제로 명령을 돌리는 자리입니다. 어떤 엔진으로 돌릴지, 어디에 등록돼 있는지, 그 자리를 잃으면 어떻게 할지를 정합니다.",
        "여기에는 엔진 이름과 정책만 저장됩니다. 키나 호스트 경로는 저장하지 않습니다.",
      ]}
    >
      <EngineBlock offline={offline} />
      <RegistryBlock hosts={hosts} />
      {/* The QUERY goes down, not `hosts.data ?? []`: an empty array cannot say
          whether the registry is empty, still loading, or refused, and the
          policy block has to tell those apart before it claims a host is not
          registered. */}
      <TierPolicyBlock
        workspaceId={workspaceId}
        memberId={memberId}
        hosts={hosts}
        offline={offline}
      />
    </SectionShell>
  );
}

// --- 실행 엔진 ---------------------------------------------------------------

/**
 * `source: "default"` means no row was ever written and the boot default
 * (opencode) is in force, so the block says that instead of implying a save.
 */
function EngineBlock({ offline }: { offline: boolean }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["settings", "work-host-engine"],
    queryFn: fetchWorkHostEngine,
    retry: false,
  });

  const [engine, setEngine] = useState<string | null>(null);

  // Seed the choice from the server once, then let the operator drive it.
  useEffect(() => {
    if (query.data && engine === null) setEngine(query.data.engine);
  }, [query.data, engine]);

  const save = useMutation({
    mutationFn: (next: string) => putWorkHostEngine(next),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["settings", "work-host-engine"] }),
  });

  const lines = ["엔진은 워크스페이스마다 하나입니다. 오너나 관리자만 바꿉니다."];

  if (query.isPending) {
    return (
      <Subsection title="실행 엔진" lines={lines}>
        <SkeletonRows rows={3} />
      </Subsection>
    );
  }

  if (query.isError) {
    return (
      <Subsection title="실행 엔진" lines={lines}>
        {isOperatorDenied(query.error) ? (
          <OperatorNotice
            who="코드 실행 엔진은 워크스페이스 오너나 관리자만 바꿀 수 있습니다."
            contact="변경이 필요하면 워크스페이스 관리자에게 문의하세요."
          />
        ) : (
          <InlineBanner
            message={errorMessage(query.error)}
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="work-host-error"
          />
        )}
      </Subsection>
    );
  }

  const current = query.data;
  const selected = engine ?? current.engine;
  const dirty = selected !== current.engine;

  return (
    <Subsection title="실행 엔진" lines={lines}>
      {/* One flat status line, not a raised card: the radios below already show
          which engine is selected, so a bordered box repeating it was elevation
          spent on nothing and pushed the other two blocks under the fold. */}
      <div
        className="flex min-w-0 flex-wrap items-center gap-2"
        data-testid="work-host-card"
      >
        <p className="text-body font-medium text-ink">{current.engine}</p>
        {current.source === "database" ? (
          <StatusChip tone="ok">이 워크스페이스에 저장됨</StatusChip>
        ) : (
          <StatusChip tone="muted">기본값 사용 중</StatusChip>
        )}
        {current.updatedAtMs && (
          <span className="text-meta text-ink-muted">
            마지막 저장{" "}
            <span className="font-mono" data-numeric>
              {new Date(current.updatedAtMs).toLocaleString("ko-KR")}
            </span>
          </span>
        )}
      </div>

      <ChoiceRadios
        name="work-host-engine"
        legend="엔진"
        choices={WORK_ENGINES}
        value={selected}
        onChange={setEngine}
        disabled={save.isPending}
      />

      {save.isError && (
        <p className="text-meta text-danger" role="alert">
          {errorMessage(save.error)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={offline || !dirty || save.isPending}
          onClick={() => save.mutate(selected)}
          data-testid="work-host-save"
        >
          {save.isPending ? "저장 중" : "엔진 저장"}
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEngine(current.engine)}
          >
            되돌리기
          </Button>
        )}
      </div>

      <p className="text-meta text-ink-muted">
        실행 하나하나의 승인 경계는 에이전트 카드의 승인 흐름에서 다룹니다. 이
        블록은 어떤 엔진을 쓸지만 정합니다.
      </p>
    </Subsection>
  );
}

// --- 등록된 호스트 -----------------------------------------------------------

const REGISTRY_LINES = [
  "데스크톱 앱과 workd 데몬이 스스로 등록합니다. 이 화면에서 등록하지는 않습니다.",
];

/**
 * The registry as a list you can read, not a key dump: name, kind, liveness and
 * the host id an operator pastes into `MOMO_WORK_HOST_ID`. The signing public
 * key is in the payload and stays out of the row on purpose.
 *
 * Revoked rows are kept because the server keeps them: a host revoked yesterday
 * is the answer to "왜 안 붙지", and dropping it would make this list disagree
 * with the ledger the policy validates its target against.
 */
function RegistryBlock({
  hosts,
}: {
  hosts: UseQueryResult<WorkHost[], unknown>;
}) {
  if (hosts.isPending) {
    return (
      <Subsection title="등록된 호스트" lines={REGISTRY_LINES}>
        <SkeletonRows rows={2} />
      </Subsection>
    );
  }

  if (hosts.isError) {
    return (
      <Subsection title="등록된 호스트" lines={REGISTRY_LINES}>
        {/* Same shape as the engine block one heading above: a 403 here means
            the reader is not a member of this workspace, which is an answer and
            not a failure, so it does not get a retry button that is guaranteed
            to fail. The other statuses get Korean copy instead of the wire
            message ("not a workspace member") the route logs. */}
        {isOperatorDenied(hosts.error) ? (
          <OperatorNotice
            who="등록된 호스트 목록은 이 워크스페이스의 멤버만 볼 수 있습니다."
            contact="초대가 아직 처리되지 않았는지 워크스페이스 관리자에게 확인하세요."
          />
        ) : (
          <InlineBanner
            message={workHostRegistryMessage()}
            actionLabel="등록 목록 다시 불러오기"
            onAction={() => void hosts.refetch()}
            testId="work-hosts-error"
          />
        )}
      </Subsection>
    );
  }

  if (hosts.data.length === 0) {
    return (
      <Subsection title="등록된 호스트" lines={REGISTRY_LINES}>
        <EmptyInvite
          headline="등록된 호스트가 아직 없습니다."
          detail="momo 데스크톱 앱으로 이 워크스페이스에 로그인하면 그 자리가 호스트로 등록됩니다."
          testId="work-hosts-empty"
        />
      </Subsection>
    );
  }

  return (
    <Subsection title="등록된 호스트" lines={REGISTRY_LINES}>
      <p className="text-meta text-ink-muted">
        등록{" "}
        <span className="font-mono text-ink" data-numeric>
          {hosts.data.length}
        </span>
        대
      </p>
      <ul
        className="flex flex-col overflow-hidden rounded-md border border-line"
        data-testid="work-host-list"
      >
        {hosts.data.map((host) => (
          <HostRow key={host.id} host={host} />
        ))}
      </ul>
    </Subsection>
  );
}

function HostRow({ host }: { host: WorkHost }) {
  const status = workHostStatus(host);
  const facts = [workHostTypeLabel(host.type), workHostScopeLabel(host.scope)];
  if (host.revokedAtMs) {
    facts.push(`해지 ${relativeSince(host.revokedAtMs)}`);
  } else if (host.lastSeenAtMs) {
    facts.push(`마지막 연결 ${relativeSince(host.lastSeenAtMs)}`);
  }

  return (
    <li
      className="flex min-w-0 flex-wrap items-start justify-between gap-2 border-b border-line p-2 last:border-b-0"
      data-testid="work-host-row"
      data-host-status={status.label}
    >
      <div className="flex min-w-0 flex-col gap-px">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-words text-body text-ink">
            {host.displayName}
          </span>
          <StatusChip tone={status.tone}>{status.label}</StatusChip>
        </div>
        <span className="text-meta text-ink-muted">{facts.join(", ")}</span>
        {/* The id is the point of the row: it is what MOMO_WORK_HOST_ID takes
            and what an auto-target 409 names, so it is readable, not hidden. */}
        <span
          className="min-w-0 break-all font-mono text-meta text-ink-muted"
          data-numeric
        >
          {host.id}
        </span>
      </div>
      <CopyButton
        value={host.id}
        label="호스트 ID 복사"
        subject={host.displayName}
        testId="work-host-copy-id"
      />
    </li>
  );
}

// --- 호스트 상실 시 재개 -----------------------------------------------------

const POLICY_LINES = [
  "세션을 돌리던 호스트를 잃었을 때 무엇을 할지 정합니다. 이미 돌고 있는 세션은 이 값을 바꿔도 그대로입니다.",
];

/**
 * ADR-0125 D11. Two groups for two scopes: the signed-in member's override, and
 * the workspace default it falls back to. A member who is neither owner nor
 * admin gets a 403 on the workspace read, which is an answer and not a failure,
 * so their own group keeps working and the default is stated in one line
 * instead of being drawn as a control whose save is guaranteed to fail.
 */
function TierPolicyBlock({
  workspaceId,
  memberId,
  hosts,
  offline,
}: {
  workspaceId: string;
  memberId: string;
  hosts: UseQueryResult<WorkHost[], unknown>;
  offline: boolean;
}) {
  const mine = useQuery({
    queryKey: ["settings", "work-tier-policy", workspaceId, "member"],
    queryFn: () => fetchWorkTierPolicy(workspaceId, "member"),
    retry: false,
  });
  const workspace = useQuery({
    queryKey: ["settings", "work-tier-policy", workspaceId, "workspace"],
    queryFn: () => fetchWorkTierPolicy(workspaceId, "workspace"),
    retry: false,
  });

  if (mine.isPending) {
    return (
      <Subsection title="호스트 상실 시 재개" lines={POLICY_LINES}>
        <SkeletonRows rows={2} />
      </Subsection>
    );
  }

  if (mine.isError) {
    return (
      <Subsection title="호스트 상실 시 재개" lines={POLICY_LINES}>
        {/* mac 정본과 같은 문장: 실패했다는 사실보다 세션이 무사하다는 사실이
            먼저 필요하다. */}
        <InlineBanner
          message="정책을 불러오지 못했습니다. 기존 세션은 그대로 유지됩니다."
          actionLabel="정책 다시 불러오기"
          onAction={() => void mine.refetch()}
          testId="work-tier-policy-error"
        />
      </Subsection>
    );
  }

  const registry = registryState(hosts);

  return (
    <Subsection title="호스트 상실 시 재개" lines={POLICY_LINES}>
      {/* One fieldset per scope rather than one shared box: 자동 재개 opens a
          재개 대상 control underneath, and in a shared group that control reads
          as belonging to whichever scope the eye lands on. The legend gives
          each group a name a screen reader announces on entry. */}
      <div className="flex flex-col gap-4" data-testid="work-tier-policy">
        <TierPolicyScope
          scope="member"
          title="내 정책"
          workspaceId={workspaceId}
          memberId={memberId}
          policy={mine.data}
          registry={registry}
          offline={offline}
        />

        {workspace.isPending && <SkeletonRows rows={2} />}

        {workspace.data && (
          <TierPolicyScope
            scope="workspace"
            title="워크스페이스 기본"
            workspaceId={workspaceId}
            memberId={memberId}
            policy={workspace.data}
            registry={registry}
            offline={offline}
          />
        )}

        {/* Four states here too. A 403 is the permission answer; anything else
            used to delete the row silently, which left an admin reading "내
            정책 … 워크스페이스 기본값을 상속 중" with no way to learn what the
            inherited value is or that the read failed at all. */}
        {workspace.isError &&
          (isOperatorDenied(workspace.error) ? (
            <p className="text-meta text-ink-muted">
              워크스페이스 기본값은 오너나 관리자만 보고 바꿉니다. 내 정책은 그
              기본값 위에 얹힙니다.
            </p>
          ) : (
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-meta text-ink-muted">워크스페이스 기본</p>
              <InlineBanner
                message="워크스페이스 기본값을 불러오지 못했습니다. 내 정책은 그대로 바꿀 수 있습니다."
                actionLabel="기본값 다시 불러오기"
                onAction={() => void workspace.refetch()}
                testId="work-tier-workspace-error"
              />
            </div>
          ))}
      </div>
      {/* No trailing paragraph about 자동 재개 any more: each option now carries
          its own description in the group above, and repeating it under the
          control was the same sentence twice. */}
    </Subsection>
  );
}

/** The empty auto target, before a host is picked. Never sent to the server. */
const NO_TARGET = "";

/**
 * What the panel is allowed to say about the registry.
 *
 * `hosts` is one query shared by the list and the target picker, and "이 호스트는
 * 등록에 없습니다" is only true once it has actually answered. While it is in
 * flight or failed there is no ledger to compare against, so the target control
 * says so instead of drawing a picker whose every claim would be a guess.
 */
type RegistryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; hosts: WorkHost[] };

function registryState(query: UseQueryResult<WorkHost[], unknown>): RegistryState {
  if (query.isPending) return { status: "loading" };
  if (query.isError) return { status: "error" };
  return { status: "ready", hosts: query.data ?? [] };
}

function TierPolicyScope({
  scope,
  title,
  workspaceId,
  memberId,
  policy,
  registry,
  offline,
}: {
  scope: WorkTierScope;
  title: string;
  workspaceId: string;
  memberId: string;
  policy: WorkTierPolicy;
  registry: RegistryState;
  offline: boolean;
}) {
  const client = useQueryClient();
  // 자동 재개 is not a legal row until it has a target (the server answers 400
  // to auto without one), so picking that mode only opens the target control
  // and the save happens when a target is chosen. It is the one unsaved value
  // on this surface, and because turning it on costs money the group says out
  // loud that nothing has been written yet.
  const [draftAuto, setDraftAuto] = useState(false);

  // Nothing is disabled while a save is in flight (a keyboard user would lose
  // focus on every change), so two PUTs can overlap. Only the newest one is
  // allowed to write the cache; an older reply landing last would otherwise
  // repaint the panel with the value the person already moved away from.
  const latestSave = useRef(0);

  const save = useMutation({
    mutationFn: async (input: { mode: string; autoTarget?: string }) => {
      const ticket = ++latestSave.current;
      const next = await putWorkTierPolicy(workspaceId, scope, input);
      return { ticket, next };
    },
    onSuccess: ({ ticket, next }) => {
      if (ticket !== latestSave.current) return;
      setDraftAuto(false);
      client.setQueryData(
        ["settings", "work-tier-policy", workspaceId, scope],
        next
      );
    },
  });

  // What the controls show. While a PUT is in flight they show the value being
  // written, not the value the server still holds: these are radios, so the
  // stored value would otherwise snap the selection back the instant the person
  // clicks and jump forward again when the reply lands. The hint says a save is
  // running, and a failure falls straight back to `policy` (the server's truth)
  // with the error underneath.
  const shown =
    save.isPending && save.variables
      ? save.variables
      : draftAuto
        ? { mode: "auto", autoTarget: undefined }
        : { mode: policy.mode, autoTarget: policy.autoTarget };
  const mode = shown.mode;
  const target = shown.autoTarget ?? NO_TARGET;

  function pickMode(next: string) {
    if (next === mode) return;
    if (next === "auto") {
      setDraftAuto(true);
      return;
    }
    setDraftAuto(false);
    save.mutate({ mode: next });
  }

  function pickTarget(next: string) {
    if (next === NO_TARGET || next === target) return;
    save.mutate({ mode: "auto", autoTarget: next });
  }

  // Save state in words, most transient first. 자동 재개 in draft is the one
  // that matters: the radio is already on 자동 재개 and the server has heard
  // nothing, so leaving this panel drops it.
  const stateHint = save.isPending
    ? "정책을 저장하는 중입니다."
    : draftAuto
      ? "아직 저장되지 않았습니다. 재개 대상을 고르면 자동 재개가 저장됩니다."
      : offline
        ? "연결이 끊겨 지금은 바꿀 수 없습니다."
        : scope === "member" && policy.inherited
          ? "워크스페이스 기본값을 상속 중입니다. 다른 값을 고르면 내 정책으로 저장됩니다."
          : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ChoiceRadios
        name={`work-tier-mode-${scope}`}
        legend={title}
        choices={WORK_TIER_MODES}
        value={mode}
        onChange={pickMode}
        disabled={offline}
        busy={save.isPending}
        hint={stateHint}
        testId={`work-tier-mode-${scope}`}
      />

      {mode === "auto" && (
        <AutoTargetField
          scope={scope}
          scopeTitle={title}
          memberId={memberId}
          target={target}
          registry={registry}
          draft={draftAuto}
          busy={save.isPending}
          disabled={offline}
          onPick={pickTarget}
        />
      )}

      {save.isError && (
        <p
          className="text-meta text-danger"
          role="alert"
          data-testid={`work-tier-save-error-${scope}`}
        >
          {workTierPolicySaveMessage(save.error)}
        </p>
      )}
    </div>
  );
}

/**
 * The 재개 대상 control, which only exists in 자동 재개.
 *
 * It has four states of its own because the registry it reads from does: while
 * that read is in flight or failed the control is a line of text, not a picker,
 * because every option list it could draw would be a claim about a ledger it
 * has not seen. Only in `ready` does it say what is and is not registered.
 */
function AutoTargetField({
  scope,
  scopeTitle,
  memberId,
  target,
  registry,
  draft,
  busy,
  disabled,
  onPick,
}: {
  scope: WorkTierScope;
  scopeTitle: string;
  memberId: string;
  target: string;
  registry: RegistryState;
  draft: boolean;
  busy: boolean;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  const id = `work-tier-target-${scope}`;

  if (registry.status !== "ready") {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-meta text-ink-muted">재개 대상</p>
        <p
          className="text-body text-ink-muted"
          role="status"
          data-testid={`${id}-unavailable`}
        >
          {registry.status === "loading"
            ? "등록된 호스트를 불러오는 중입니다. 목록이 도착하면 대상을 고를 수 있습니다."
            : "등록된 호스트를 불러오지 못해 지금은 대상을 고를 수 없습니다. 위 등록된 호스트 블록을 확인하세요."}
        </p>
      </div>
    );
  }

  const hosts = registry.hosts;
  const eligible = eligibleAutoTargets(hosts, scope, memberId);
  const stored = hosts.find((h) => h.id.toLowerCase() === target.toLowerCase());

  const choices = [
    ...(target === NO_TARGET
      ? [{ id: NO_TARGET, label: "대상 고르기", disabled: true }]
      : []),
    { id: CLOUD_TARGET, label: "momo Cloud" },
    ...eligible.map((host) => ({ id: host.id, label: host.displayName })),
  ];

  // A stored target can point at a host that has since been revoked or left the
  // registry, and a <select> whose value matches no option renders blank. Carry
  // it as its own option so the control states what is actually in the ledger,
  // named for what it is and not selectable again: the server answers 409 for
  // it, so offering it as a choice would be offering a save that cannot land.
  const staleTarget =
    target !== NO_TARGET &&
    !choices.some((c) => c.id.toLowerCase() === target.toLowerCase());
  if (staleTarget) {
    choices.unshift({
      id: target,
      label: autoTargetLabel(target, hosts),
      disabled: true,
    });
  }

  const hint = staleTarget
    ? stored?.revokedAtMs
      ? "지금 저장된 대상은 해지된 호스트입니다. 다른 대상을 고르세요."
      : stored
        ? "지금 저장된 대상은 이 정책에서 쓸 수 없는 호스트입니다. 다른 대상을 고르세요."
        : "지금 저장된 대상이 등록 목록에 없습니다. 다른 대상을 고르세요."
    : draft
      ? "대상을 고르면 자동 재개가 저장됩니다."
      : eligible.length === 0
        ? "등록된 호스트 중 고를 수 있는 것이 없어 momo Cloud만 고를 수 있습니다."
        : undefined;

  return (
    <SelectField
      id={id}
      label="재개 대상"
      // Both scopes draw this control, so the visible label alone is two
      // identical names in one panel.
      ariaLabel={`${scopeTitle} 재개 대상`}
      hint={hint}
      value={target}
      choices={choices}
      onChange={onPick}
      disabled={disabled}
      busy={busy}
      testId={id}
    />
  );
}
