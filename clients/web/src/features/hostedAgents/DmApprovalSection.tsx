import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { ConfirmButton, StatusChip } from "@/features/settings/SettingsFields";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { ApiError } from "@momo/core/lib/api";
import {
  getHostedDmApprovals,
  setHostedDmApproval,
} from "@momo/core/features/hostedAgents/api";
import {
  applyHostedDmApproval,
  dmApprovalCloseQuestion,
  dmApprovalFailureMessage,
  dmApprovalLead,
  dmApprovalOpenQuestion,
  dmApprovalReadOnlyNote,
  dmApprovalStateLabel,
  dmApprovalStateTone,
  parseHostedDmApprovals,
  parseHostedDmApprovalWrite,
  DM_APPROVAL_BUSY_LABEL,
  DM_APPROVAL_CLOSE_CONFIRM,
  DM_APPROVAL_CLOSE_LABEL,
  DM_APPROVAL_CONFIRMED_BY_NON_OWNER_NOTE,
  DM_APPROVAL_EMPTY_DETAIL,
  DM_APPROVAL_EMPTY_HEADLINE,
  DM_APPROVAL_HEADLINE,
  DM_APPROVAL_LOADING_LABEL,
  DM_APPROVAL_OFFLINE_NOTE,
  DM_APPROVAL_OPEN_CONFIRM,
  DM_APPROVAL_OPEN_LABEL,
  DM_APPROVAL_OWNER_ONLY_LEAD,
  type HostedDmApprovalRow,
  type HostedDmApprovals,
} from "@momo/core/features/hostedAgents/dmApproval";

// =============================================================================
// 설정 › 에이전트 자격 › 1:1 대화 (ADR-0162 증보 2 / #2915).
//
// 채널 승인은 연결을 만들 때 관리자가 마법사에서 고른다. DM은 그 뒤에 생기고,
// 누가 열지는 **에이전트 소유자**가 정한다. 그래서 이 목록은 마법사가 아니라
// 연결 장부 안, 도어벨 옆에 선다. 관리자는 읽을 수 있고 소유자만 바꾼다
// (`canEdit`는 서버가 정한다. 화면이 소유자 여부를 따로 추측하지 않는다).
//
// 줄은 네 가지다: 소유자 대화(항상 열림, 버튼 없음), 열림, 닫힘, 열 수 없음(구독
// 에이전트). 여는 것은 대화 내용을 외부 에이전트에게 건네는 승인이라 한 번 더
// 묻는다(ConfirmButton).
// =============================================================================

function dmApprovalsQueryKey(workspaceId: string, connectionId: string) {
  return ["hosted-dm-approvals", workspaceId, connectionId] as const;
}

const OFFLINE_NOTE_ID = "hosted-dm-approval-offline-note";

export function DmApprovalSection({
  workspaceId,
  connectionId,
  agentLabel,
  directory,
  offline,
  writesLocked,
}: {
  workspaceId: string;
  connectionId: string;
  agentLabel: string;
  directory: Directory;
  offline: boolean;
  writesLocked: boolean;
}) {
  const client = useQueryClient();
  const key = dmApprovalsQueryKey(workspaceId, connectionId);
  const [failure, setFailure] = useState<{
    channelId: string;
    message: string;
  } | null>(null);
  const [live, setLive] = useState("");

  const list = useQuery({
    queryKey: key,
    queryFn: async () => {
      const parsed = parseHostedDmApprovals(
        await getHostedDmApprovals(workspaceId, connectionId),
      );
      if (parsed === null) throw new Error("dm approvals: unexpected shape");
      return parsed;
    },
    enabled: connectionId !== "",
  });

  const write = useMutation({
    mutationFn: async (input: {
      row: HostedDmApprovalRow;
      approve: boolean;
    }) => {
      const row = parseHostedDmApprovalWrite(
        await setHostedDmApproval(
          workspaceId,
          connectionId,
          input.row.channelId,
          input.approve,
        ),
      );
      if (row === null) throw new Error("dm approval: unexpected shape");
      return row;
    },
    onSuccess: (row, input) => {
      setFailure(null);
      client.setQueryData<HostedDmApprovals>(key, (current) =>
        current === undefined ? current : applyHostedDmApproval(current, row),
      );
      void client.invalidateQueries({ queryKey: key });
      const name = nameOf(input.row.counterpartMemberId);
      setLive(
        input.approve
          ? `${name}님과의 대화를 열었어요.`
          : `${name}님과의 대화를 닫았어요.`,
      );
    },
    onError: (error, input) =>
      setFailure({
        channelId: input.row.channelId,
        message: dmApprovalFailureMessage(
          error instanceof ApiError ? error.status : null,
        ),
      }),
  });

  function nameOf(memberId: string): string {
    return memberFor(directory, memberId)?.displayName ?? "알 수 없는 멤버";
  }

  const data = list.data;
  const ownerName =
    data?.ownerMemberId == null ? null : nameOf(data.ownerMemberId);
  const locked = offline || writesLocked;

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3"
      aria-label={DM_APPROVAL_HEADLINE}
      data-testid="hosted-dm-approval-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h4 className="text-body font-semibold text-ink">
          {DM_APPROVAL_HEADLINE}
        </h4>
        <p className="break-keep text-meta text-ink-muted">
          {data?.ownerOnly
            ? DM_APPROVAL_OWNER_ONLY_LEAD
            : dmApprovalLead(agentLabel)}
        </p>
        {data !== undefined && !data.canEdit && (
          <p
            className="break-keep text-meta text-ink-muted"
            data-testid="hosted-dm-approval-readonly"
          >
            {data.confirmedByNonOwner
              ? DM_APPROVAL_CONFIRMED_BY_NON_OWNER_NOTE
              : dmApprovalReadOnlyNote(ownerName)}
          </p>
        )}
        {data?.canEdit && offline && (
          <p
            id={OFFLINE_NOTE_ID}
            className="break-keep text-meta text-ink-muted"
          >
            {DM_APPROVAL_OFFLINE_NOTE}
          </p>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {live}
        </p>
      </div>

      {list.isPending && (
        <div role="status" data-testid="hosted-dm-approval-loading">
          <span className="sr-only">{DM_APPROVAL_LOADING_LABEL}</span>
          <Skeleton ready={false} rows={2} className="p-0" />
        </div>
      )}

      {list.isError && (
        <InlineBanner
          separator={false}
          message="1:1 대화 목록을 불러오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요."
          actionLabel="다시 시도"
          onAction={() => void list.refetch()}
          testId="hosted-dm-approval-error"
        />
      )}

      {data !== undefined && data.dms.length === 0 && (
        <EmptyInvite
          className="px-0 py-2"
          headline={DM_APPROVAL_EMPTY_HEADLINE}
          detail={DM_APPROVAL_EMPTY_DETAIL}
          testId="hosted-dm-approval-empty"
        />
      )}

      {data !== undefined && data.dms.length > 0 && (
        <ul
          className="flex min-w-0 flex-col divide-y divide-line"
          data-testid="hosted-dm-approval-list"
        >
          {data.dms.map((row) => {
            const name = nameOf(row.counterpartMemberId);
            const editable =
              data.canEdit &&
              (row.state === "approved" || row.state === "unapproved");
            const opening = row.state === "unapproved";
            const busy =
              write.isPending &&
              write.variables?.row.channelId === row.channelId;
            return (
              <li
                key={row.channelId}
                className="flex min-w-0 flex-col gap-2 py-2"
                data-testid="hosted-dm-approval-row"
                data-state={row.state}
              >
                {/* 이름은 줄이지 않는다: 여는 것은 그 사람의 대화를 건네는 승인이라
                    누구인지가 이 줄의 전부다. 폭이 모자라면 칩과 버튼이 아래로
                    내려간다(이름의 flex-basis 가 내용 폭이라 wrap 이 먼저 일어난다). */}
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="grow break-keep text-body text-ink">
                    {name}님과의 대화
                  </span>
                  <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                    <StatusChip tone={dmApprovalStateTone(row.state)}>
                      {dmApprovalStateLabel(row.state)}
                    </StatusChip>
                    {editable && (
                      <ConfirmButton
                        label={
                          opening
                            ? DM_APPROVAL_OPEN_LABEL
                            : DM_APPROVAL_CLOSE_LABEL
                        }
                        subject={`${name}님과의 대화`}
                        question={
                          opening
                            ? dmApprovalOpenQuestion(name)
                            : dmApprovalCloseQuestion(name)
                        }
                        confirmLabel={
                          opening
                            ? DM_APPROVAL_OPEN_CONFIRM
                            : DM_APPROVAL_CLOSE_CONFIRM
                        }
                        confirmDestructive={!opening}
                        busy={busy}
                        busyLabel={DM_APPROVAL_BUSY_LABEL}
                        disabled={locked && !busy}
                        describedBy={offline ? OFFLINE_NOTE_ID : undefined}
                        onConfirm={() => {
                          if (locked || write.isPending) return;
                          write.mutate({ row, approve: opening });
                        }}
                        testId="hosted-dm-approval-toggle"
                      />
                    )}
                  </span>
                </div>
                {failure?.channelId === row.channelId && (
                  <InlineBanner
                    separator={false}
                    message={failure.message}
                    actionLabel="닫기"
                    onAction={() => setFailure(null)}
                    testId="hosted-dm-approval-failure"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
