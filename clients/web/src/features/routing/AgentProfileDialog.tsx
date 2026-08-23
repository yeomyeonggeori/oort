import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { InlineBanner } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { useSession } from "@/app/session";
import { PRIMARY_ACTION_SHORTCUT } from "@/app/keyboardShortcuts";
import { RoutingFields } from "./RoutingFields";
import {
  useAgentEditingCapability,
  useAllowedAgentModels,
  useRoutingCapability,
  type RoutingCapability,
} from "./capability";
import {
  INHERIT_DRAFT,
  agentEffortInheritLabel,
  agentModelInheritLabel,
  appliedModelLabel,
  clearedEffortNotice,
  draftEquals,
  draftFromProfile,
  effectiveModel,
  effortLabel,
  effortsForModel,
  ignoredEffortNotice,
  ignoredModelNotice,
  knownAgentModels,
  modelOptions,
  resolveInheritance,
  type RoutingDraft,
  type RoutingInheritance,
} from "@momo/core/features/routing/routingModel";
import {
  AgentProfileOpenContext,
  OpenAgentProfileContext,
  useAgentProfile,
} from "./useAgentProfile";

// =============================================================================
// 에이전트 프로필 다이얼로그 (ADR-0134 D3 / MOMO-626, MOMO-537 합류).
//
// 에이전트 하나에 걸려 있는 기본 모델과 기본 추론 강도를 여기서 정한다.
// 상속 체인의 2층이고, 비워 두면 1층(에이전트 자신의 모델)이 그대로 쓰인다.
// 그래서 상속 옵션은 "상속"이 아니라 "상속 (에이전트 기본: hermes-agent)"이다:
// 빈 칸이 무엇으로 채워지는지 모르는 채 비워 두게 하지 않는다(D3).
//
// R-1 5장의 에이전트 생성 다이얼로그와 같은 틀을 쓰되(제목 + 폼 + 후행 정렬
// 버튼 2개), 생성이 아니라 편집이라 필드가 둘뿐이다. buzz의 200+ 파일 관리
// 패널이 아니라 간편 편집 노선(레퍼런스 서베이 §7 반면교사).
//
// 두 축은 서버 세대가 다르다(R1 B2). **모델(ADR-0131 D2)은 지금 살아 있는 모든
// 서버가 가지고 있고**(momowebqa 실측: modelPref만 실은 PUT → 200, 멘션 run이
// `resolveProfileModel`로 그 값을 적용), **추론 강도(ADR-0134 D3)는 아직 없는
// 서버가 있다**. 그래서 effort-table 프로브의 결과로 잠기는 것은 강도 상자
// 하나뿐이다. 이 구분이 없으면 MOMO-537(에이전트 기본 모델 편집)이 현재 배포된
// 모든 서버에서 작동 불능이 된다.
//
// 네 가지 상태가 전부 여기 있다(SKILL §5):
//   로딩   프로필이 오기 전에는 같은 높이의 중립 바. 값이 도착할 때 폼이
//          움직이지 않는다.
//   오류   불러오지 못하면 무엇이 실패했고 무엇을 하면 되는지 + [다시 시도].
//   빈     프로필 없음(404). **폼은 그대로 열려 있고 저장이 곧 생성이다** —
//          같은 경로의 PUT이 upsert이기 때문이다(R1 B3). 한 줄 고지 + 액션 하나.
//   오프라인 저장은 진짜로 불가능하므로 진짜 disabled + 이유 배너.
// =============================================================================

const FORM_ID = "agent-profile-form";

/** 확인 중일 때 강도 상자에 붙는 사유. 잠긴 상자는 이유 없이 잠기지 않는다. */
const CHECKING_REASON =
  "이 서버가 추론 강도 축을 지원하는지 확인하는 중입니다.";

/**
 * 추론 강도 축에 대해 이 화면이 하는 말. **모델 축에 대해서는 아무 말도 하지 않는다.**
 *
 * 사유(왜 우리가 그렇게 믿는가)는 capability가 주고, 결과(그래서 이 화면에서
 * 무엇이 달라지는가)는 화면이 붙인다. 두 문장을 합쳐 두면 컴포저와 이 화면이
 * 서로 다른 결과를 같은 사유에 붙일 수 없다.
 */
function effortNotice(capability: RoutingCapability): string | null {
  if (capability.support === "ready") return null;
  if (capability.support === "checking") return CHECKING_REASON;
  const consequence =
    capability.support === "absent"
      ? "추론 강도는 여기서 정할 수 없습니다. 모델은 그대로 저장됩니다."
      : "확인될 때까지 추론 강도는 정할 수 없습니다. 모델은 그대로 저장됩니다.";
  return `${capability.reason ?? ""} ${consequence}`.trim();
}

/**
 * 지금 이 에이전트에 실제로 걸려 있는 값 한 줄. 저장 전 상태를 그대로 읽는다.
 *
 * 강도가 지정되지 않았을 때 표의 기본값은 괄호 안 참고로만 적는다. 서버는 그
 * 경우 강도를 아예 보내지 않으므로, 표의 값을 적용값처럼 쓰면 이 줄이 서버가
 * 하지 않는 일을 했다고 말하게 된다. 표를 못 받았으면 괄호도 없다.
 */
function AppliedLine({
  inheritance,
  testId,
}: {
  inheritance: RoutingInheritance;
  testId: string;
}) {
  const effort = inheritance.effort.value;
  const fallback = inheritance.modelDefaultEffort;
  return (
    <p className="text-meta text-ink-muted" data-testid={testId}>
      지금 적용: 모델 {appliedModelLabel(inheritance.model.value)}, 추론 강도{" "}
      {effort !== null
        ? effortLabel(effort)
        : fallback !== null
          ? `지정 없음 (모델 기본 ${effortLabel(fallback)})`
          : "지정 없음"}
    </p>
  );
}

function Frame({
  title,
  description,
  children,
  footer,
  onKeyDown,
  blockClose,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  blockClose: boolean;
}) {
  return (
    <DialogContent
      data-testid="agent-profile-dialog"
      onKeyDown={onKeyDown}
      onEscapeKeyDown={(event) => {
        if (blockClose) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (blockClose) event.preventDefault();
      }}
    >
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </div>
      {children}
      {footer}
    </DialogContent>
  );
}

/**
 * 같은 높이의 중립 바. 값이 도착해도 폼이 위아래로 튀지 않는다.
 *
 * 바는 장식이라 접근성 트리에서 빼지만, **로딩 자체는 말한다**(R2 M5). 바만 두면
 * 화면을 보지 않는 사람에게 이 다이얼로그는 제목과 설명 뒤로 아무 일도 일어나지
 * 않는 상자이고(저장 버튼은 disabled), 상태 4종 중 loading이 그 경로에서만 비어
 * 있게 된다. 문장은 도착과 함께 사라지므로 라이브 리전으로 읽힌다.
 */
function ProfileSkeleton() {
  return (
    <div className="flex flex-col p-4" data-testid="agent-profile-skeleton">
      <p className="sr-only" role="status" data-testid="agent-profile-loading">
        에이전트 라우팅 설정을 불러오는 중입니다.
      </p>
      <div className="flex flex-col gap-3" aria-hidden="true">
        {[0, 1].map((row) => (
          <div key={row} className="flex flex-col gap-1">
            <span className="block h-4 w-16 rounded-sm bg-surface-hover" />
            <span className="block h-control w-full rounded-sm bg-surface-hover" />
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentProfilePanel({
  agentMemberId,
  onOpenChange,
}: {
  agentMemberId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspaceId } = useSession();
  const directory = useDirectory(workspaceId).directory;
  const member = memberFor(directory, agentMemberId);
  const capability = useRoutingCapability();
  const allowedModels = useAllowedAgentModels(agentMemberId);
  const editing = useAgentEditingCapability(agentMemberId);
  const offline = useOffline();
  const handle = useAgentProfile(agentMemberId);
  const formRef = useRef<HTMLFormElement>(null);

  // 초안은 프로필이 도착한 뒤 한 번 심는다. 이후에는 사람이 편집한 값이 정본
  // 이므로, 백그라운드 refetch가 타이핑 중인 선택을 되돌리지 않는다.
  const [draft, setDraft] = useState<RoutingDraft | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);
  // 프로필이 없으면 저장 전 상태는 "아무것도 지정하지 않음"이다. 그것이 곧
  // 이 폼의 기준선이고, 사람이 무엇 하나라도 고르면 dirty가 된다.
  const saved = useMemo(
    () =>
      handle.profile
        ? draftFromProfile(handle.profile)
        : handle.missing
          ? INHERIT_DRAFT
          : null,
    [handle.profile, handle.missing]
  );
  const current = draft ?? saved;

  const agentName = member?.displayName ?? "에이전트";
  const title = `${agentName} 라우팅`;
  const description =
    "이 에이전트가 기본으로 쓸 모델과 추론 강도입니다. 비워 두면 상속합니다.";

  const effortReady = capability.support === "ready" && capability.table !== null;
  const notice = effortNotice(capability);
  // 프로필 쓰기 자체가 있는 서버인가(capability.ts ④). 이 줄이 없던 동안 위
  // 주석은 "모델은 서버 세대와 무관하게 저장된다"고 적혀 있었고, Swift 서버들에
  // 대해서는 사실이었다. B5.2 서버에서는 아니다: `GET …/profile`은 200을 답하고
  // `PUT`은 없다(diff matrix D-4). 그래서 이 다이얼로그는 프로필을 읽어 열리고,
  // 모델 상자를 열어 주고, [변경 저장]에서 404를 받았다. 읽을 수 있다는 사실이
  // 저장할 수 있다는 뜻은 아니므로 이제 쓰기 축은 쓰기 축에게 물어본다.
  const profileWritable = editing.support === "ready";
  const writeBlockedReason = offline
    ? "연결이 끊긴 동안에는 바꿀 수 없습니다."
    : profileWritable
      ? null
      : editing.support === "checking"
        ? "이 서버가 프로필 편집을 받는지 확인하는 중입니다."
        : editing.reason;
  const modelEditable = profileWritable && !offline;
  const effortEditable = effortReady && profileWritable && !offline;

  const dirty =
    current !== null && saved !== null && !draftEquals(current, saved);

  const onFieldChange = useCallback(
    (next: RoutingDraft, clearedEffort: string | null, inheritedModel: string) => {
      setDraft(next);
      handle.clearFailure();
      // 비워진 강도는 "무엇을" 뿐 아니라 "어느 모델 때문에"까지 말해야 한다.
      // 기준은 바뀐 뒤의 유효 모델이다.
      setCleared(
        clearedEffort === null
          ? null
          : clearedEffortNotice(
              effectiveModel(next, inheritedModel),
              clearedEffort
            )
      );
    },
    [handle]
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!current || handle.saving || offline || !profileWritable || !dirty) return;
    const result = await handle.save(current);
    if (result.ok) {
      setCleared(null);
      onOpenChange(false);
      return;
    }
    // 서버가 강도 필드를 모른다고 답했다. 그 값을 폼에 남겨 두면 다음 저장도
    // 같은 400을 받는다. 되돌려 놓고, 실패 문구가 시키는 "모델만 바꿔서 저장"이
    // 실제로 가능한 상태로 만든다(R1 H1).
    if (result.effortUnsupported) {
      setDraft({ model: current.model, effort: null });
      setCleared(null);
    }
  }

  const footer = (
    <div className="flex items-center justify-end gap-2 border-t border-line p-4">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={handle.saving}
        onClick={() => onOpenChange(false)}
        data-testid="agent-profile-cancel"
      >
        취소
      </Button>
      <Button
        type="submit"
        form={FORM_ID}
        size="sm"
        // 바쁜 것은 비활성이 아니다: 진행 중에는 대비를 유지하고 버튼 안
        // 스피너로 말하며, 클릭은 submit이 막는다(채널 만들기와 같은 규칙).
        disabled={offline || !profileWritable || !dirty}
        aria-busy={handle.saving || undefined}
        data-testid="agent-profile-save"
      >
        {handle.saving && <Loader2 aria-hidden="true" className="spinner-busy" />}
        {handle.saving ? "저장 중" : "변경 저장"}
      </Button>
    </div>
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (PRIMARY_ACTION_SHORTCUT.matches(event)) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  if (handle.isPending) {
    return (
      <Frame
        title={title}
        description={description}
        footer={footer}
        blockClose={false}
      >
        <ProfileSkeleton />
      </Frame>
    );
  }

  if (handle.error || current === null) {
    return (
      <Frame
        title={title}
        description={description}
        footer={footer}
        blockClose={false}
      >
        <InlineBanner
          message="에이전트 프로필을 불러오지 못했습니다."
          actionLabel="다시 시도"
          onAction={handle.refetch}
          testId="agent-profile-error"
        />
      </Frame>
    );
  }

  // 표는 강도의 유효값을 재는 자일 뿐이므로, 표가 없어도 모델 층은 계산된다.
  const table = capability.table;
  const inheritedModel = member?.agentModel ?? "";
  const inheritance = resolveInheritance(
    table, inheritedModel, handle.profile, allowedModels
  );
  const modelForEfforts = effectiveModel(current, inheritedModel);
  const models = modelOptions(
    table,
    inheritedModel,
    knownAgentModels(directory.members),
    allowedModels
  );
  // 거절이 어느 상자로 가는가. 모델로 배달된 문장은 폼 아래 알림에서 빠진다.
  const modelError =
    handle.failure?.field === "model" ? handle.failure.message : null;
  const formError =
    handle.failure && handle.failure.field !== "model"
      ? handle.failure.message
      : undefined;

  return (
    <Frame
      title={title}
      description={description}
      footer={footer}
      onKeyDown={onKeyDown}
      blockClose={handle.saving}
    >
      {handle.missing && (
        <InlineBanner
          tone="neutral"
          message={
            profileWritable
              ? "이 에이전트에는 아직 프로필이 없습니다. 여기서 저장하면 프로필이 만들어집니다."
              : "이 에이전트에는 아직 프로필이 없습니다."
          }
          testId="agent-profile-empty"
        />
      )}
      {/* 확정된 판정만 배너가 된다. 확인 중은 결론이 아니라서 상자 옆 사유로만
          말하고, 다이얼로그를 열 때마다 배너가 깜빡이지 않는다. */}
      {(editing.support === "absent" || editing.support === "unknown") && !offline && (
        <InlineBanner
          tone={editing.support === "absent" ? "neutral" : "error"}
          message={
            editing.support === "absent"
              ? `${editing.reason ?? ""} 지금 적용된 값은 아래에서 볼 수 있습니다.`.trim()
              : (editing.reason ?? "이 서버가 프로필 편집을 받는지 확인하지 못했습니다.")
          }
          {...(editing.support === "unknown"
            ? { actionLabel: "다시 확인", onAction: editing.recheck }
            : {})}
          testId="agent-profile-write-unsupported"
        />
      )}
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 변경은 다시 연결된 뒤에 저장할 수 있습니다."
          testId="agent-profile-offline"
        />
      )}

      <form
        id={FORM_ID}
        ref={formRef}
        onSubmit={submit}
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
      >
        <RoutingFields
          idPrefix="agent-profile"
          table={table}
          models={models}
          allowedModelsReceived={allowedModels !== null}
          inheritedModel={inheritedModel}
          modelInheritLabel={agentModelInheritLabel(inheritedModel)}
          effortInheritLabel={agentEffortInheritLabel(
            table ? effortsForModel(table, modelForEfforts).defaultEffort : null
          )}
          draft={current}
          onChange={(next, clearedEffort) =>
            onFieldChange(next, clearedEffort, inheritedModel)
          }
          modelDisabled={!modelEditable}
          modelDisabledReason={writeBlockedReason}
          effortDisabled={!effortEditable}
          effortDisabledReason={
            // 쓰기 자체가 막힌 상태에서 강도 상자가 할 말은 강도 이야기가 아니라
            // "여기서는 아무것도 저장되지 않는다"이다.
            writeBlockedReason ?? notice
          }
          clearedNotice={cleared}
          ignoredNotice={
            inheritance.ignoredModelPref
              ? ignoredModelNotice(inheritance.ignoredModelPref, inheritance.model.value)
              : inheritance.ignoredEffortPref
                ? ignoredEffortNotice(
                  inheritance.model.value,
                  inheritance.ignoredEffortPref
                )
                : null
          }
          // 서버가 모델을 거절했으면 그 문장은 모델 상자 옆에 선다. 폼 아래 알림은
          // 그때 비는데, 같은 문장을 두 곳에 두면 사람은 서로 다른 두 문제가
          // 있다고 읽는다(RoutingFields의 sharedReason과 같은 규칙).
          modelError={modelError}
        />

        {capability.support === "unknown" && !offline && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={capability.recheck}
            data-testid="agent-profile-recheck"
          >
            추론 강도 지원 다시 확인
          </Button>
        )}

        <AppliedLine inheritance={inheritance} testId="agent-profile-applied" />

        {/* 라이브 리전은 내용보다 먼저, 그리고 **렌더된 채로** 붙어 있어야 읽힌다
            (R1 M6). display:none으로 감추면 접근성 트리에서 빠져 마운트를 미룬
            것과 같아지므로, 비어 있을 때는 내용이 없어 높이가 0인 상태로 둔다.

            모델 상자로 배달된 거절은 여기 오지 않는다. 그 문장은 이미 상자 옆에
            서 있고, 같은 말을 두 번 적으면 사람은 두 개의 다른 문제로 읽는다. */}
        <p
          className="text-meta text-danger"
          role="alert"
          data-testid="agent-profile-save-error"
        >
          {formError}
        </p>
      </form>
    </Frame>
  );
}

export function AgentProfileDialog({
  agentMemberId,
  onOpenChange,
}: {
  agentMemberId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={agentMemberId !== null}
      onOpenChange={(open) => onOpenChange(open)}
    >
      {/* 열려 있는 동안에만 마운트한다: 지난 시도의 거절과 초안이 다음 열기까지
          따라오지 않고, 열리는 순간의 document.activeElement가 곧 "무엇이 이걸
          열었나"이기 때문이다(dialog.tsx가 그 값을 잡아 닫을 때 돌려준다). */}
      {agentMemberId !== null && (
        <AgentProfilePanel
          key={agentMemberId}
          agentMemberId={agentMemberId}
          onOpenChange={onOpenChange}
        />
      )}
    </Dialog>
  );
}

/** 셸 하나가 다이얼로그 하나를 들고, 진입점들에는 여는 동사만 내려보낸다. */
export function AgentProfileProvider({ children }: { children: ReactNode }) {
  const [agentMemberId, setAgentMemberId] = useState<string | null>(null);
  const open = useCallback((id: string) => setAgentMemberId(id), []);
  return (
    <OpenAgentProfileContext.Provider value={open}>
      <AgentProfileOpenContext.Provider value={agentMemberId !== null}>
        {children}
      </AgentProfileOpenContext.Provider>
      <AgentProfileDialog
        agentMemberId={agentMemberId}
        onOpenChange={(next) => {
          if (!next) setAgentMemberId(null);
        }}
      />
    </OpenAgentProfileContext.Provider>
  );
}
