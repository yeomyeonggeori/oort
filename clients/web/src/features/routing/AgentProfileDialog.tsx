import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
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
import { RoutingFields } from "./RoutingFields";
import {
  UNSUPPORTED_REASON,
  useRoutingCapability,
  type RoutingCapability,
} from "./capability";
import {
  agentEffortInheritLabel,
  agentModelInheritLabel,
  clearedEffortNotice,
  draftEquals,
  draftFromProfile,
  effectiveModel,
  effortLabel,
  effortsForModel,
  ignoredEffortNotice,
  resolveInheritance,
  type RoutingDraft,
  type RoutingInheritance,
} from "./routingModel";
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
// 네 가지 상태가 전부 여기 있다(SKILL §5):
//   로딩   프로필이 오기 전에는 같은 높이의 중립 바. 값이 도착할 때 폼이
//          움직이지 않는다.
//   오류   불러오지 못하면 무엇이 실패했고 무엇을 하면 되는지 + [다시 시도].
//          404는 오류가 아니라 "아직 프로필이 없다"는 빈 상태로 나눠 말한다.
//   빈     프로필 없음. 저장할 대상이 없으므로 폼 대신 사실만.
//   오프라인 저장은 진짜로 불가능하므로 진짜 disabled + 이유 배너.
// =============================================================================

const FORM_ID = "agent-profile-form";

/**
 * capability가 ready가 아닐 때 이 화면이 하는 말.
 *
 * 사유(왜 우리가 그렇게 믿는가)는 capability가 주고, 결과(그래서 이 화면에서
 * 무엇이 달라지는가)는 화면이 붙인다. 두 문장을 합쳐 두면 컴포저와 이 화면이
 * 서로 다른 결과를 같은 사유에 붙일 수 없다.
 */
function capabilityNotice(capability: RoutingCapability): string | null {
  if (capability.support === "ready" || capability.support === "checking") {
    return null;
  }
  const consequence =
    capability.support === "absent"
      ? "모델과 추론 강도를 여기서 바꿀 수 없고, 에이전트는 서버가 정한 기본값으로 답합니다."
      : "확인될 때까지 모델과 추론 강도를 바꿀 수 없습니다.";
  return `${capability.reason ?? UNSUPPORTED_REASON} ${consequence}`;
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
      지금 적용: 모델 {inheritance.model.value}, 추론 강도{" "}
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

/** 같은 높이의 중립 바. 값이 도착해도 폼이 위아래로 튀지 않는다. */
function ProfileSkeleton() {
  return (
    <div
      className="flex flex-col gap-3 p-4"
      aria-hidden="true"
      data-testid="agent-profile-skeleton"
    >
      {[0, 1].map((row) => (
        <div key={row} className="flex flex-col gap-1">
          <span className="block h-4 w-16 rounded-sm bg-surface-hover" />
          <span className="block h-control w-full rounded-sm bg-surface-hover" />
        </div>
      ))}
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
  const offline = useOffline();
  const handle = useAgentProfile(agentMemberId);
  const formRef = useRef<HTMLFormElement>(null);

  // 초안은 프로필이 도착한 뒤 한 번 심는다. 이후에는 사람이 편집한 값이 정본
  // 이므로, 백그라운드 refetch가 타이핑 중인 선택을 되돌리지 않는다.
  const [draft, setDraft] = useState<RoutingDraft | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);
  const saved = useMemo(
    () => (handle.profile ? draftFromProfile(handle.profile) : null),
    [handle.profile]
  );
  const current = draft ?? saved;

  const notFound = handle.error instanceof ApiError && handle.error.status === 404;
  const agentName = member?.displayName ?? "에이전트";
  const title = `${agentName} 라우팅`;
  const description =
    "이 에이전트가 기본으로 쓸 모델과 추론 강도입니다. 비워 두면 상속합니다.";
  const notice = capabilityNotice(capability);
  const editable =
    capability.support === "ready" && capability.table !== null && !offline;

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
    if (!current || handle.saving || !editable || !dirty) return;
    const ok = await handle.save(current);
    if (ok) {
      setCleared(null);
      onOpenChange(false);
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
        disabled={!editable || !dirty}
        aria-busy={handle.saving || undefined}
        data-testid="agent-profile-save"
      >
        {handle.saving && <Loader2 aria-hidden="true" className="spinner-busy" />}
        {handle.saving ? "저장 중" : "변경 저장"}
      </Button>
    </div>
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
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

  if (notFound) {
    return (
      <Frame
        title={title}
        description={description}
        footer={footer}
        blockClose={false}
      >
        <p className="p-4 text-body text-ink-muted" data-testid="agent-profile-empty">
          이 에이전트에는 아직 프로필이 없습니다. 프로필이 만들어지면 여기에서
          모델과 추론 강도를 정할 수 있습니다.
        </p>
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
  const inheritance = resolveInheritance(table, inheritedModel, handle.profile);
  const modelForEfforts = effectiveModel(current, inheritedModel);

  return (
    <Frame
      title={title}
      description={description}
      footer={footer}
      onKeyDown={onKeyDown}
      blockClose={handle.saving}
    >
      {notice && (
        <InlineBanner
          tone="neutral"
          message={notice}
          actionLabel={capability.support === "unknown" ? "다시 확인" : undefined}
          onAction={
            capability.support === "unknown" ? capability.recheck : undefined
          }
          testId="agent-profile-capability"
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
          inheritedModel={inheritedModel}
          modelInheritLabel={agentModelInheritLabel(inheritedModel)}
          effortInheritLabel={agentEffortInheritLabel(
            table ? effortsForModel(table, modelForEfforts).defaultEffort : null
          )}
          draft={current}
          onChange={(next, clearedEffort) =>
            onFieldChange(next, clearedEffort, inheritedModel)
          }
          disabled={!editable}
          disabledReason={
            offline
              ? "연결이 끊긴 동안에는 바꿀 수 없습니다."
              : notice
                ? "위에 적힌 이유로 지금은 바꿀 수 없습니다."
                : null
          }
          clearedEffort={cleared}
          ignoredNotice={
            inheritance.ignoredEffortPref
              ? ignoredEffortNotice(
                  inheritance.model.value,
                  inheritance.ignoredEffortPref
                )
              : null
          }
        />

        <AppliedLine inheritance={inheritance} testId="agent-profile-applied" />

        {handle.failure && (
          <p
            className="text-meta text-danger"
            role="alert"
            data-testid="agent-profile-save-error"
          >
            {handle.failure.message}
          </p>
        )}
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
