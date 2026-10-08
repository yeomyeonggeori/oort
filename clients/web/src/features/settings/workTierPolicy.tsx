import { useRef, useState, type ReactNode } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  fetchWorkTierPolicy,
  putWorkTierPolicy,
  type WorkHost,
  type WorkTierPolicy,
  type WorkTierPolicyInput,
  type WorkTierScope,
} from "@momo/core/features/settings/api";
import {
  autoTargetLabel,
  CLOUD_TARGET,
  eligibleAutoTargets,
  isOperatorDenied,
  WORK_TIER_MODES,
  workTierPolicySaveMessage,
} from "@momo/core/features/settings/model";
import { choiceRadiosHintId } from "./fieldIds";
import { registryState, type RegistryState } from "./workHostsQuery";
import { ChoiceRadios, OperatorNotice, SaveButton, SelectField } from "./SettingsFields";
import { SettingsSection } from "./shell/SettingsSection";

// =============================================================================
// 호스트 상실 시 재개 (ADR-0125 D11), 두 범위가 두 페이지에 산다 (#3578 S4).
//
//   내 정책(scope="member")        설정 > 기기. 이 맥의 주인이 나이고 정책도 나의 것이다.
//   워크스페이스 기본(scope="workspace")  설정 > 실행 호스트. 소유자·관리자만 바꾼다.
//
// 두 카드는 같은 `TierPolicyScope`를 그리고, 재개 대상 선택은 둘 다 등록부를 읽는다
// (`useWorkHosts`: 같은 질의 키라 한 번 읽은 것을 두 페이지가 나눠 쓴다).
// 세션을 돌리던 호스트를 잃었을 때 무엇을 할지가 정책이고, 이미 돌고 있는 세션은 이
// 값을 바꿔도 그대로다.
//
// Tier NUMBERS (T1/T2/T3) stay internal: the person picks a behaviour
// ("연결 끊김 시 묻기"), never a tier. Both radio groups commit the SAME way: pick,
// then press the group's save button. Nothing here writes the ledger on a focus move.
// =============================================================================

const POLICY_DESCRIPTION =
  "세션을 돌리던 호스트를 잃었을 때 무엇을 할지 정해요. 이미 돌고 있는 세션은 이 값을 바꿔도 그대로예요.";
const POLICY_TITLE = "호스트 상실 시 재개";

/** 상태 줄(스켈레톤·배너)은 행이 아니라서 카드 안 여백을 직접 든다. */
export function CardBody({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-2 p-4">{children}</div>;
}

/**
 * 내 정책. A member who is no longer in the workspace gets a 403 on their own
 * policy, which is an answer and not a failure, so it does not get a retry button
 * that is guaranteed to fail.
 */
export function MyTierPolicySection({
  workspaceId,
  memberId,
  hosts,
  offline,
}: {
  workspaceId: string;
  memberId: string;
  /** The QUERY goes down, not `hosts.data ?? []`: see `registryState`. */
  hosts: UseQueryResult<WorkHost[], unknown>;
  offline: boolean;
}) {
  const mine = useQuery({
    queryKey: ["settings", "work-tier-policy", workspaceId, "member"],
    queryFn: () => fetchWorkTierPolicy(workspaceId, "member"),
    retry: false,
  });

  return (
    <SettingsSection
      title={POLICY_TITLE}
      description={POLICY_DESCRIPTION}
      testId="work-tier-policy-card"
    >
      {mine.isPending ? (
        <CardBody>
          <Skeleton ready={false} rows={2} />
        </CardBody>
      ) : mine.isError ? (
        <CardBody>
          {isOperatorDenied(mine.error) ? (
            <OperatorNotice
              bare
              who="내 정책은 이 워크스페이스의 멤버만 보고 바꿀 수 있어요."
              contact="초대가 아직 처리되지 않았는지 워크스페이스 관리자에게 확인하세요."
            />
          ) : offline ? (
            <InlineBanner
              message="연결이 끊겨 정책을 불러올 수 없어요. 기존 세션은 그대로 유지돼요."
              separator={false}
              className="px-0"
              testId="work-tier-policy-error"
            />
          ) : (
            /* mac 정본과 같은 문장: 실패했다는 사실보다 세션이 무사하다는 사실이
               먼저 필요하다. */
            <InlineBanner
              message="정책을 불러오지 못했어요. 기존 세션은 그대로 유지돼요."
              actionLabel="정책 다시 불러오기"
              onAction={() => void mine.refetch()}
              separator={false}
              className="px-0"
              testId="work-tier-policy-error"
            />
          )}
        </CardBody>
      ) : (
        <div data-testid="work-tier-policy">
          <TierPolicyScope
            scope="member"
            title="내 정책"
            workspaceId={workspaceId}
            memberId={memberId}
            policy={mine.data}
            registry={registryState(hosts)}
            offline={offline}
          />
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * 워크스페이스 기본값. Owner and admin only: anyone else gets a 403 on the read,
 * which is an answer, so the card states it in one line instead of drawing a
 * control whose save is guaranteed to fail. Anything else is a retryable error,
 * never a silently missing row.
 */
export function WorkspaceTierPolicySection({
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
  const workspace = useQuery({
    queryKey: ["settings", "work-tier-policy", workspaceId, "workspace"],
    queryFn: () => fetchWorkTierPolicy(workspaceId, "workspace"),
    retry: false,
  });

  return (
    <SettingsSection
      title="워크스페이스 기본 재개 정책"
      description="내 정책을 따로 정하지 않은 멤버에게 적용돼요. 내 정책은 설정의 기기에서 정해요."
      testId="work-tier-workspace-card"
    >
      {workspace.isPending ? (
        <CardBody>
          <Skeleton ready={false} rows={2} />
        </CardBody>
      ) : workspace.isError ? (
        <CardBody>
          {isOperatorDenied(workspace.error) ? (
            <p className="break-keep text-meta text-ink-muted" data-testid="work-tier-workspace-denied">
              워크스페이스 기본값은 소유자나 관리자만 보고 바꿔요. 내 정책은 그 기본값 위에 얹혀요.
            </p>
          ) : offline ? (
            <InlineBanner
              message="연결이 끊겨 워크스페이스 기본값을 불러올 수 없어요. 다시 연결되면 불러와요."
              separator={false}
              className="px-0"
              testId="work-tier-workspace-error"
            />
          ) : (
            <InlineBanner
              message="워크스페이스 기본값을 불러오지 못했어요."
              actionLabel="기본값 다시 불러오기"
              onAction={() => void workspace.refetch()}
              separator={false}
              className="px-0"
              testId="work-tier-workspace-error"
            />
          )}
        </CardBody>
      ) : (
        <div data-testid="work-tier-policy">
          <TierPolicyScope
            scope="workspace"
            title="워크스페이스 기본"
            workspaceId={workspaceId}
            memberId={memberId}
            policy={workspace.data}
            registry={registryState(hosts)}
            offline={offline}
          />
        </div>
      )}
    </SettingsSection>
  );
}

/** The empty auto target, before a host is picked. Never sent to the server. */
const NO_TARGET = "";

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

  // EXPLICIT COMMIT.
  //
  // These are native radios, so arrow-key roving IS selection: moving focus
  // through the group fires onChange on every stop. When onChange wrote the
  // ledger, a keyboard user walking t1_only -> ask -> auto sent a PUT for the
  // value they were only passing through, moved updatedAtMs on the D11 policy
  // row, and had nothing on screen to undo it with. Two visually identical
  // radio groups in one panel must not have opposite commit models either, and
  // the engine block already had a save button, so this one gets one too.
  const [draft, setDraft] = useState<WorkTierPolicyInput | null>(null);

  // Nothing is disabled while a save is in flight (a keyboard user would lose
  // focus on every change), so two PUTs can overlap. Only the newest one is
  // allowed to write the cache; an older reply landing last would otherwise
  // repaint the panel with the value the person already moved away from.
  const latestSave = useRef(0);

  const save = useMutation({
    mutationFn: async (input: WorkTierPolicyInput) => {
      const ticket = ++latestSave.current;
      const next = await putWorkTierPolicy(workspaceId, scope, input);
      return { ticket, next };
    },
    onSuccess: ({ ticket, next }) => {
      if (ticket !== latestSave.current) return;
      setDraft(null);
      client.setQueryData(
        ["settings", "work-tier-policy", workspaceId, scope],
        next
      );
    },
    // A reply the ticket check throws away still LANDED on the server, so the
    // cache would otherwise keep showing a value the ledger no longer holds.
    // Whatever the outcome, re-read the row the server actually has.
    onSettled: () => {
      void client.invalidateQueries({
        queryKey: ["settings", "work-tier-policy", workspaceId, scope],
      });
    },
  });

  // What the controls show: the draft while there is one, the server row
  // otherwise. A save in flight keeps showing the draft (these are radios; the
  // stored value would snap the selection back and forward again), and a
  // failure leaves it in place so the person can retry or revert rather than
  // silently losing what they picked.
  const stored: WorkTierPolicyInput = {
    mode: policy.mode,
    autoTarget: policy.mode === "auto" ? policy.autoTarget : undefined,
  };
  const shown = draft ?? stored;
  const mode = shown.mode;
  const target = shown.autoTarget ?? NO_TARGET;
  const storedTarget = stored.autoTarget ?? NO_TARGET;

  const dirty =
    mode !== stored.mode ||
    target.toLowerCase() !== storedTarget.toLowerCase();
  // The server answers 400 to auto without a target, so the button says so
  // instead of offering a save that cannot land.
  const needsTarget = mode === "auto" && target === NO_TARGET;

  function pickMode(next: string) {
    if (next === mode) return;
    setDraft(
      next === "auto"
        ? { mode: "auto", autoTarget: stored.autoTarget }
        : { mode: next }
    );
  }

  function pickTarget(next: string) {
    if (next === NO_TARGET) return;
    setDraft({ mode: "auto", autoTarget: next });
  }

  function commit() {
    // Guarded rather than disabled: a disabled button drops focus to <body>
    // mid-save, which is exactly the keyboard defect the radios avoid.
    if (save.isPending || !dirty || needsTarget || offline) return;
    save.mutate(mode === "auto" ? { mode, autoTarget: target } : { mode });
  }

  // Save state in words, most transient first.
  const stateHint = save.isPending
    ? "정책을 저장하는 중이에요."
    : needsTarget
      ? "자동 재개는 재개 대상을 고른 뒤에 저장돼요."
      : dirty
        ? "아직 저장되지 않았어요. 저장 버튼을 눌러야 적용돼요."
        : offline
          ? "연결이 끊겨 지금은 바꿀 수 없어요."
          : scope === "member" && policy.inherited
            ? "워크스페이스 기본값을 상속 중이에요. 다른 값을 골라 저장하면 내 정책이 돼요."
            : undefined;

  // Two scopes draw the same two buttons, so the visible labels carry the scope
  // instead of leaving two identical "저장" stops in the tab order.
  const saveLabel = scope === "member" ? "내 정책 저장" : "워크스페이스 기본 저장";
  // 이름을 한 번만 적는다: 되돌리기가 이 그룹의 상태 문장을 자기 사유로 가리킨다.
  const modeRadiosName = `work-tier-mode-${scope}`;

  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      <ChoiceRadios
        name={modeRadiosName}
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
          unsaved={dirty}
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

      <div className="flex flex-wrap items-center gap-2">
        <SaveButton
          label={saveLabel}
          canSave={dirty && !needsTarget && !offline}
          busy={save.isPending}
          onSave={commit}
          testId={`work-tier-save-${scope}`}
        />
        {/* 되돌리기 규칙 (#1559 회전 1 · #1595 M5):
            저장 중에는 잠기고, 잠긴 사실은 흐림과 `aria-disabled` 로 말하며,
            사유는 이 그룹이 이미 세워 둔 「정책을 저장하는 중이에요」를 가리킨다.
            한 패널의 같은 자리가 다른 모양이면 다음 사람은 그 차이가 의도인지
            알 수 없다. */}
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${title} 되돌리기`}
            aria-disabled={save.isPending || undefined}
            aria-describedby={
              save.isPending ? choiceRadiosHintId(modeRadiosName) : undefined
            }
            className={cn(save.isPending && "opacity-50")}
            onClick={() => {
              if (save.isPending) return;
              setDraft(null);
            }}
            data-testid={`work-tier-revert-${scope}`}
          >
            되돌리기
          </Button>
        )}
      </div>
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
  unsaved,
  busy,
  disabled,
  onPick,
}: {
  scope: WorkTierScope;
  scopeTitle: string;
  memberId: string;
  target: string;
  registry: RegistryState;
  /** The block has a pick the server has not been told about yet. */
  unsaved: boolean;
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
            ? "등록된 호스트를 불러오는 중이에요. 목록이 도착하면 대상을 고를 수 있어요."
            : "등록된 호스트를 불러오지 못해 지금은 대상을 고를 수 없어요. 잠시 뒤 다시 확인하세요."}
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
    { id: CLOUD_TARGET, label: "oort Cloud" },
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

  // A stale stored target is not a footnote, it is the state of the policy: the
  // server answers 409 for this exact row, so the panel is currently describing
  // a setting that cannot run. It says so in --danger with role="alert", the
  // same way this block already draws a save failure, instead of a muted line
  // that reads like help text next to a normally selected 자동 재개 radio.
  const hint = staleTarget
    ? stored?.revokedAtMs
      ? "지금 저장된 대상은 해지된 호스트여서 이 정책은 실행되지 않아요. 다른 대상을 고른 뒤 저장하세요."
      : stored
        ? "지금 저장된 대상은 이 정책이 쓸 수 없는 호스트여서 이 정책은 실행되지 않아요. 다른 대상을 고른 뒤 저장하세요."
        : "지금 저장된 대상이 등록 목록에 없어 이 정책은 실행되지 않아요. 다른 대상을 고른 뒤 저장하세요."
    : unsaved
      ? "아직 저장되지 않았어요. 저장 버튼을 눌러야 적용돼요."
      : eligible.length === 0
        ? "등록된 호스트 중 고를 수 있는 것이 없어 oort Cloud만 고를 수 있어요."
        : undefined;

  return (
    <SelectField
      id={id}
      label="재개 대상"
      // Both scopes draw this control, so the visible label alone is two
      // identical names in one panel.
      ariaLabel={`${scopeTitle} 재개 대상`}
      hint={hint}
      hintTone={staleTarget ? "danger" : "muted"}
      value={target}
      choices={choices}
      onChange={onPick}
      disabled={disabled}
      busy={busy}
      testId={id}
    />
  );
}
