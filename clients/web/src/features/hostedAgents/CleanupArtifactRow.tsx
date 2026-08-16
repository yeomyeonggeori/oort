import { useEffect, useRef, useState } from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import {
  ConfirmButton,
  KeyValueRows,
  StatusChip,
  type KeyValue,
} from "@/features/settings/SettingsFields";
import {
  acknowledgeQuestion,
  acknowledgeReady,
  cleanupEvidenceText,
  cleanupKindCopy,
  cleanupRowActionable,
  cleanupRowDetail,
  cleanupRowState,
  cleanupRowStateLabel,
  cleanupRowTitle,
  cleanupRowTone,
  dispositionChoices,
  evidenceIssue,
  evidenceIssueMessage,
  evidencePlaceholder,
  statusChoices,
  CLEANUP_CONFIRM_LABEL,
  type HostedCleanupArtifact,
  type HostedCleanupChoice,
  type HostedCleanupStatus,
} from "@momo/core/features/hostedAgents/cleanup";
import {
  CLEANUP_ACKNOWLEDGE_LABEL,
  CLEANUP_DISPOSITION_DEFER_DETAIL,
  CLEANUP_DISPOSITION_DEFER_LABEL,
  CLEANUP_DISPOSITION_LEGEND,
  CLEANUP_EVIDENCE_LABEL,
  CLEANUP_SAVE_LABEL,
  CLEANUP_STATUS_LEGEND,
} from "@momo/core/features/hostedAgents/disconnect";
import { ChoiceList, type ChoiceListItem } from "./ChoiceList";

// =============================================================================
// 정리 목록 한 줄과, 그 줄에 확인을 적는 폼 (HAP-UX2 / #1362).
//
// 이 컴포넌트가 지켜야 하는 것 셋. 셋 다 판정은 코어에 있고 여기는 그것을 그린다.
//
//   1. **함정 문장은 상시 노출된다.** 커넥터 줄의 「로컬 파일은 남습니다」와
//      routine 줄의 「Active 를 끄는 것은 제거가 아닙니다」는 이 흐름이 존재하는
//      이유 자체다(#1344 실측). disclosure 뒤에 두면 속은 사람이 두 번 속는다.
//   2. **서버가 확인한 줄에는 체크박스가 없다.** `server_verified` 는 이 서버가
//      자기가 폐기한 자격증명에만 쓰는 출처다. 그 줄에 폼을 세우면 사람이 서버의
//      사실을 승인하는 판이 되고, 그 줄을 사람 확인과 같은 모양으로 그리면 oort 가
//      provider 안까지 들여다본 것처럼 읽힌다.
//   3. **처분에는 질문이 선다.** 서버는 이미 해결된 줄의 재결정을 409 로
//      거절한다. 관측만 적는 저장은 언제든 다시 적을 수 있으므로 질문이 없고,
//      처분은 되돌릴 수 없으므로 `ConfirmButton` 이다. 봇 삭제의 질문은 그 자리에서
//      대화 기록을 이름으로 말한다.
//
// 폼은 접혀 있고 한 번에 하나만 열린다(부모가 연 줄의 id 를 들고 있다). 여섯 줄이
// 동시에 라디오 두 벌과 텍스트 상자를 펼치면 그것은 확인 목록이 아니라 설문지다.
// 접힌 쪽을 렌더하지 않는 것은 `FoldToggle` 이 이미 정한 이 레포의 문법이다
// (`details` 는 닫혀 있어도 자식을 DOM 에 만든다).
// =============================================================================

const DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function CleanupArtifactRow({
  artifact,
  open,
  onOpenChange,
  actorName,
  failure,
  onDismissFailure,
  disabled,
  disabledReasonId,
  saving,
  onAcknowledge,
}: {
  artifact: HostedCleanupArtifact;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 확인한 사람의 이름. 명부에서 못 읽으면 `null`. */
  actorName: string | null;
  /** 이 줄의 저장이 거절당한 이유. 다른 줄의 실패는 여기 오지 않는다. */
  failure: string | null;
  onDismissFailure: () => void;
  /** 오프라인이거나 다른 저장이 진행 중이다. */
  disabled: boolean;
  /**
   * 잠긴 이유를 적어 둔 문장의 id.
   *
   * 여섯 줄이 **하나의** 이유로 잠기는 경우가 이 목록의 유일한 잠금이므로, 사유는
   * 목록 머리에 한 번 적고 줄들은 그것을 가리킨다.
   */
  disabledReasonId?: string;
  saving: boolean;
  onAcknowledge: (input: {
    currentStatus: HostedCleanupStatus;
    choice: HostedCleanupChoice | null;
    evidence: string;
  }) => void;
}) {
  const copy = cleanupKindCopy(artifact.kind);
  const state = cleanupRowState(artifact);
  const actionable = cleanupRowActionable(artifact);
  const formId = `cleanup-form-${artifact.id}`;

  // 초점 회수 (design-review H1). 이 표면의 핵심 상호작용은 폼을 여닫는 것인데,
  // 그 두 전이가 초점을 쥔 노드를 통째로 없앤다: 「확인 기록」 트리거는 폼과 같은
  // 자리(형제)에 서므로 폼이 열리면 사라지고, 취소·저장은 폼 자체를 언마운트한다.
  // 남겨 두면 초점은 <body> 로 떨어지고 다음 Tab 은 셸 맨 위에서 다시 시작한다.
  // ConfirmButton 이 「열 때 질문으로, 닫을 때 트리거로」 하는 것과 같은 규율이되,
  // 여기선 트리거가 사라지므로 이 줄에서 사라지지 않는 유일한 지표인 **제목**이
  // 그 자리를 대신한다(열 때 폼 안으로 들어가는 쪽은 폼이 자기 마운트에서 한다).
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
    } else if (wasOpen.current) {
      wasOpen.current = false;
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0"
      data-testid="cleanup-artifact"
      data-artifact-kind={artifact.kind}
      data-artifact-state={state}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* tabIndex -1 + 링: 폼을 닫을 때 초점이 착지하는 안정 지표다 (H1).
                Tab 순서에는 들지 않고 프로그램 초점만 받는다. */}
            <h4
              ref={headingRef}
              tabIndex={-1}
              className="min-w-0 break-keep text-body font-semibold text-ink outline-none focus-visible:focus-ring"
            >
              {cleanupRowTitle(artifact)}
            </h4>
            <StatusChip tone={cleanupRowTone(state)}>
              {cleanupRowStateLabel(artifact)}
            </StatusChip>
          </div>
          <p className="break-keep text-meta text-ink-muted">
            {cleanupRowDetail(artifact)}
          </p>
          {/* 함정은 언제나 여기 있다 (규율 1). 줄이 닫힌 뒤에도 남긴다(follow-up #2):
              secret 의 「따로 복사해 둔 사본은 직접 지우세요」처럼 함정 문장은 처분이
              끝난 뒤에도 참이라, non-actionable 줄에서 지우면 마지막까지 읽혀야 할
              경고가 확인을 적은 순간 사라진다. */}
          <p className="break-keep text-meta text-ink-muted">{copy.caution}</p>
        </div>
        {actionable && !open && (
          // aria-disabled, native `disabled` 가 아니다 (#1403). 바로 윗줄이 잠긴
          // 이유를 가리키는데, native `disabled` 인 버튼은 tab order 를 떠나므로
          // 그 문장이 **닿을 수 없는 곳**에 놓인다: 키보드로 이 줄을 지나는 사람은
          // 왜 못 하는지 듣지 못한 채 회색 버튼만 건너뛴다. 여섯 줄이 하나의
          // 사유로 잠기는 이 목록에서 그것은 사유를 한 번 적은 설계 전체를
          // 무의미하게 만든다. SaveButton·ConfirmButton 이 같은 이유로 이미
          // aria-disabled 다 (SettingsFields). 초점은 남고, 눌러도 아무 일이
          // 일어나지 않는다.
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("shrink-0", disabled && "opacity-50")}
            aria-expanded={false}
            aria-controls={formId}
            aria-label={`${cleanupRowTitle(artifact)} ${CLEANUP_ACKNOWLEDGE_LABEL}`}
            aria-describedby={disabled ? disabledReasonId : undefined}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (disabled) return;
              onOpenChange(true);
            }}
            data-testid="cleanup-open-form"
          >
            {CLEANUP_ACKNOWLEDGE_LABEL}
          </Button>
        )}
      </div>

      {!actionable && <ResolvedFacts artifact={artifact} actorName={actorName} />}

      {actionable && open && (
        <AcknowledgeForm
          id={formId}
          artifact={artifact}
          failure={failure}
          onDismissFailure={onDismissFailure}
          disabled={disabled}
          saving={saving}
          onCancel={() => onOpenChange(false)}
          onSubmit={onAcknowledge}
        />
      )}
    </li>
  );
}

/**
 * 이미 닫힌 줄이 남기는 것 — 누가, 언제, 무엇을 보고.
 *
 * 감사 provenance 가 화면에 서는 유일한 자리다. 서버가 확인한 줄에는 사람도
 * 사람의 문장도 없고(`cleanupEvidenceText` 가 영어 운영자 문장을 잘라낸다),
 * 그래서 그 줄은 행이 둘뿐이다. 없는 칸을 「-」로 채우지 않는다.
 */
function ResolvedFacts({
  artifact,
  actorName,
}: {
  artifact: HostedCleanupArtifact;
  actorName: string | null;
}) {
  const evidence = cleanupEvidenceText(artifact);
  const rows: KeyValue[] = [];
  if (artifact.source === "server_verified") {
    rows.push({ key: "확인한 곳", value: "oort 서버", prose: true });
  } else if (actorName !== null) {
    rows.push({ key: "확인한 사람", value: actorName, prose: true });
  }
  if (artifact.acknowledgedAtMs !== undefined) {
    rows.push({
      key: "확인한 때",
      value: DATE_TIME.format(new Date(artifact.acknowledgedAtMs)),
      prose: true,
    });
  }
  if (evidence !== null) {
    rows.push({ key: "확인한 내용", value: evidence, prose: true });
  }
  if (rows.length === 0) return null;
  // 상자 없이 들여쓴 dl (design-review M5). 이 줄은 이미 ul 의 헤어라인과 li 의
  // 구분선 안에 있어, provenance 를 또 테두리로 감싸면 done 뷰에서 테두리가 여섯
  // 겹까지 쌓인다. 들여쓰기만으로 이 문장들이 줄의 하위임을 보인다.
  return (
    <div className="ps-2">
      <KeyValueRows rows={rows} />
    </div>
  );
}

function AcknowledgeForm({
  id,
  artifact,
  failure,
  onDismissFailure,
  disabled,
  saving,
  onCancel,
  onSubmit,
}: {
  id: string;
  artifact: HostedCleanupArtifact;
  failure: string | null;
  onDismissFailure: () => void;
  disabled: boolean;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    currentStatus: HostedCleanupStatus;
    choice: HostedCleanupChoice | null;
    evidence: string;
  }) => void;
}) {
  const statuses = statusChoices(artifact.kind);
  const dispositions = dispositionChoices(artifact.kind);
  const [status, setStatus] = useState<HostedCleanupStatus>(
    // 씨앗 상태(`unknown`)는 고를 수 없으므로 첫 줄에서 시작한다. 서버가 이미
    // 관측을 갖고 있으면 그것을 이어받는다: 사람이 앞서 적은 답을 지우고 다시
    // 묻는 폼은 「아까 뭐라고 했더라」를 만든다.
    statuses.some((choice) => choice.id === artifact.currentStatus)
      ? artifact.currentStatus
      : (statuses[0]?.id ?? "present")
  );
  const [choice, setChoice] = useState<HostedCleanupChoice | null>(null);
  const [evidence, setEvidence] = useState("");
  const [touched, setTouched] = useState(false);

  const evidenceId = `${id}-evidence`;
  const issue = choice === null ? null : evidenceIssue(evidence);
  const ready = acknowledgeReady(artifact.kind, choice, evidence);
  const blockedId = `${id}-blocked`;
  // 되돌릴 수 없는 쪽인가 (코어가 정한다, cleanup.ts). 이 폼은 열려 있는 동안에만
  // 마운트되므로 이 effect 는 「열림」의 순간 정확히 한 번 돈다: 폼을 연 트리거가
  // 방금 언마운트됐으니 초점을 폼 안 첫 컨트롤(첫 관측 라디오)로 들여온다 (H1).
  const formRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    formRef.current
      ?.querySelector<HTMLElement>('input[type="radio"]')
      ?.focus();
  }, []);

  const statusItems: ChoiceListItem[] = statuses.map((item) => ({
    id: item.id,
    label: item.label,
    detail: item.detail,
  }));
  const dispositionItems: ChoiceListItem[] = [
    ...dispositions.map((item) => ({
      id: item.id,
      label: item.label,
      detail: item.detail,
    })),
    {
      id: "defer",
      label: CLEANUP_DISPOSITION_DEFER_LABEL,
      detail: CLEANUP_DISPOSITION_DEFER_DETAIL,
    },
  ];

  function submit() {
    setTouched(true);
    if (!ready || disabled || saving) return;
    onSubmit({ currentStatus: status, choice, evidence });
  }

  return (
    <div
      ref={formRef}
      id={id}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-line-strong p-3"
      data-testid="cleanup-form"
    >
      <ChoiceList
        name={`${id}-status`}
        legend={CLEANUP_STATUS_LEGEND}
        multiple={false}
        items={statusItems}
        selected={[status]}
        onChange={(next) => {
          const picked = next[0];
          if (picked !== undefined) setStatus(picked as HostedCleanupStatus);
        }}
        disabled={disabled || saving}
        testId="cleanup-status"
      />

      <ChoiceList
        name={`${id}-disposition`}
        legend={CLEANUP_DISPOSITION_LEGEND}
        multiple={false}
        items={dispositionItems}
        selected={[choice ?? "defer"]}
        onChange={(next) => {
          const picked = next[0];
          setChoice(
            picked === undefined || picked === "defer"
              ? null
              : (picked as HostedCleanupChoice)
          );
        }}
        disabled={disabled || saving}
        testId="cleanup-disposition"
      />

      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={evidenceId} className="text-meta text-ink-muted">
          {CLEANUP_EVIDENCE_LABEL}
        </label>
        <textarea
          id={evidenceId}
          name="evidence"
          rows={3}
          value={evidence}
          spellCheck={false}
          disabled={disabled || saving}
          aria-invalid={touched && issue !== null ? true : undefined}
          aria-describedby={`${evidenceId}-hint${
            touched && issue !== null ? ` ${evidenceId}-error` : ""
          }`}
          placeholder={evidencePlaceholder(artifact.kind)}
          onChange={(event) => setEvidence(event.target.value)}
          data-testid="cleanup-evidence"
          className="w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p id={`${evidenceId}-hint`} className="break-keep text-meta text-ink-muted">
          {choice === null
            ? "본 것만 기록할 때는 비워 둘 수 있습니다. 처분을 고르면 반드시 적어야 합니다."
            : "이 문장이 나중에 이 해제를 설명하는 근거로 남습니다."}
        </p>
        {touched && issue !== null && (
          <p id={`${evidenceId}-error`} role="alert" className="break-keep text-meta text-danger">
            {evidenceIssueMessage(issue)}
          </p>
        )}
      </div>

      {/* 거절은 그것을 부른 컨트롤 옆에 선다. 여섯 줄이 각자 폼을 펼치는 장부에서
          맨 위 배너 하나는 「in context」가 아니다. */}
      {failure !== null && (
        <InlineBanner
          separator={false}
          message={failure}
          actionLabel="닫기"
          onAction={onDismissFailure}
          testId="hosted-disconnect-failure"
        />
      )}
      {/* 저장이 막힌 이유는 버튼 옆에 상시 노출된다. 죽은 버튼만 있는 화면은
          사람에게 아무것이나 눌러 보게 만든다. */}
      {!ready && (
        <p id={blockedId} className="break-keep text-meta text-ink-muted">
          {choice === null
            ? "처분을 고르지 않았습니다. 지금 저장하면 본 것만 기록됩니다."
            : "확인한 내용을 적어야 이 답을 기록할 수 있습니다."}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* 「닫기」가 아니다: 바로 위 거절 배너의 액션이 「닫기」이고, 두 낱말이
            같으면 100px 안에 같은 말을 하는 두 버튼이 선다. 이 버튼이 버리는 것은
            메시지가 아니라 **적던 확인**이다.

            저장이 날아가는 동안 잠기되 사라지지는 않는다 (#1403): 이 세 컨트롤은
            한 줄에 서 있고, 그중 하나가 tab order 에서 빠지면 저장을 기다리는
            사람의 손 밑에서 줄의 구성이 바뀐다. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-disabled={saving || undefined}
          className={cn(saving && "opacity-50")}
          onClick={() => {
            if (saving) return;
            onCancel();
          }}
          data-testid="cleanup-cancel"
        >
          취소
        </Button>
        {choice === null ? (
          // 관측만 적는 저장에는 질문이 없다. 다시 적을 수 있는 기록이기 때문이다.
          //
          // 진행 중인 컨트롤을 `disabled` 로 만들지 않는 것이 이 레포의 규율이고
          // (States.tsx `actionBusy`, HostedConnectionSection 의 「해제하는 중」),
          // 여기서는 그것이 초점 문제이기도 하다: 저장을 시작하는 것이 이 버튼
          // 자신이라 native `disabled` 는 방금 Enter 를 누른 손에서 초점을 빼앗아
          // <body> 로 떨군다. 옆 가지의 ConfirmButton 은 이미 aria-disabled 이므로
          // 같은 자리의 두 갈래가 같은 문법을 쓴다.
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={disabled || saving || undefined}
            aria-busy={saving || undefined}
            className={cn((disabled || saving) && "opacity-50")}
            onClick={() => {
              if (disabled || saving) return;
              submit();
            }}
            data-testid="cleanup-save"
          >
            {saving ? "저장하는 중" : CLEANUP_SAVE_LABEL}
          </Button>
        ) : (
          <ConfirmButton
            label={CLEANUP_SAVE_LABEL}
            subject={cleanupRowTitle(artifact)}
            describedBy={ready ? undefined : blockedId}
            question={acknowledgeQuestion(artifact.kind, choice)}
            confirmLabel={CLEANUP_CONFIRM_LABEL}
            // 확정 버튼의 색은 답이 정한다 (design-review M1). 「봇을 남깁니다」는
            // 대화 기록을 지키는 답이라 red 가 아니다 — destructive 플래그는 코어가
            // 이미 각 처분에 실어 두었다(cleanup.ts). 두 걸음 가드는 그대로다.
            confirmDestructive={
              dispositions.find((item) => item.id === choice)?.destructive ??
              true
            }
            disabled={disabled || saving || !ready}
            onConfirm={submit}
            testId="cleanup-save"
          />
        )}
      </div>
    </div>
  );
}
