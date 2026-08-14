import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  ConfirmButton,
  KeyValueRows,
  StatusChip,
} from "@/features/settings/SettingsFields";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { uuidEq } from "@momo/core/lib/api";
import { normalizedId } from "@momo/core/features/agents/hubModel";
import {
  serverSaysAbsent,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";
import {
  acknowledgeHostedCleanupArtifact,
  completeHostedDisconnect,
  disconnectHostedConnection,
} from "@momo/core/features/hostedAgents/api";
import {
  buildAcknowledgement,
  type HostedCleanupArtifact,
  type HostedCleanupChoice,
  type HostedCleanupStatus,
} from "@momo/core/features/hostedAgents/cleanup";
import {
  cleanupProgress,
  cleanupProgressSentence,
  disconnectLiveMessage,
  disconnectStartGate,
  manifestRepairGate,
  parseArtifactAcknowledgement,
  parseDisconnectCompletion,
  parseDisconnectStart,
  revokeFacts,
  terminalGate,
  CLEANUP_HEADLINE,
  CLEANUP_INDEPENDENCE_NOTE,
  CLEANUP_LEAD,
  CLEANUP_OFFLINE_NOTE,
  DISCONNECT_HISTORY_NOTE,
  DISCONNECT_IMMEDIATE_HEADLINE,
  DISCONNECT_IMMEDIATE_ITEMS,
  DISCONNECT_NOT_DONE_HEADLINE,
  DISCONNECT_NOT_DONE_ITEMS,
  DISCONNECT_SECTION_LEAD,
  DISCONNECT_START_CONFIRM_LABEL,
  DISCONNECT_START_LABEL,
  DISCONNECT_START_QUESTION,
  MANIFEST_REPAIR_LABEL,
  MANIFEST_REPAIR_NOTE,
  TERMINAL_CONFIRM_LABEL,
  TERMINAL_DONE_DETAIL,
  TERMINAL_DONE_HEADLINE,
  TERMINAL_HEADLINE,
  TERMINAL_LABEL,
  TERMINAL_LEAD,
  TERMINAL_QUESTION,
  type HostedConnectionDetail,
} from "@momo/core/features/hostedAgents/disconnect";
import {
  hostedFailureMessage,
  hostedStatusDetail,
  hostedStatusLabel,
  hostedStatusTone,
  isHostedOperatorDenied,
  type HostedAgentConnection,
} from "@momo/core/features/hostedAgents/model";
import { CleanupArtifactRow } from "./CleanupArtifactRow";
import { hostedListQuery } from "./hostedCredentialScope";
import {
  hostedConnectionDetailQuery,
  hostedConnectionDetailQueryKey,
  invalidateHostedConnection,
} from "./hostedDisconnectScope";

// =============================================================================
// 호스티드 연결의 해제 — 즉시 끊기는 것과 사람이 확인하는 것 (HAP-UX2 / #1362).
//
// 이 화면이 마법사(UX1)와 **다른 표면**인 이유는 방향이 반대이기 때문이다.
// 마법사는 값을 발급하고 권한을 여는 흐름이라 다이얼로그 안에서 한 번에 끝나고,
// 이 화면은 며칠에 걸쳐 오가는 장부다: provider 설정을 열러 갔다가 돌아오고,
// 두 번째로 훑다가 못 본 항목을 찾고, 다른 사람이 이어서 확인한다. 그래서 자리도
// 다르다 — 마법사는 「에이전트 만들기」 옆 다이얼로그이고, 이 화면은 그 에이전트의
// 상세 탭이다. 해제는 연결을 만들 때가 아니라 그 에이전트를 보다가 하는 일이다.
//
// ## 화면이 하지 않는 세 가지
//
//   1. **정리해 주지 않는다.** oort 는 provider 안에 손을 넣을 수 없다. 이 목록의
//      모든 줄은 사람이 provider 화면에서 직접 하고, 여기는 그 확인을 적는다.
//   2. **끝났다고 먼저 말하지 않는다.** terminal `disconnected` 는 서버가 정한다.
//      이 화면의 확정 버튼은 서버에 물어보는 버튼이지 상태를 바꾸는 버튼이 아니고,
//      막혀 있을 때는 **왜 막혔는지**를 옆에 적는다.
//   3. **기록을 지우는 일로 보이지 않는다.** 해제 확인 화면이 반드시 두 문단인
//      이유가 그것이다: 지금 끊기는 것과, 이 버튼이 하지 않는 것.
//
// ## 상태는 언제나 서버에서 온다
//
// 지역 상태는 둘뿐이고 둘 다 서버가 알 수 없는 것이다: 지금 열려 있는 폼이 어느
// 줄인가, 그리고 방금 실패한 요청의 문구. 새로고침 · 오프라인 · 재시도 뒤에
// 복원되는 것은 전부 서버 상태이고, 이 화면이 자기 진행도를 따로 세지 않는 것이
// 그 복원을 공짜로 만든다.
// =============================================================================

export function HostedConnectionSection({
  agentMemberId,
  agentLabel,
  offline,
}: {
  agentMemberId: string;
  agentLabel: string;
  /**
   * 화면이 서버에 닿지 못한다.
   *
   * 훅을 여기서 부르지 않고 라우트에서 받는 것이 이 화면의 형제들(프로필·이력)이
   * 이미 하는 것이다. 라우트가 그 사실 하나로 자기 배너를 세우므로, 판단이 두
   * 곳에서 따로 나면 배너와 잠금이 한 프레임 어긋난다.
   */
  offline: boolean;
}) {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const { directory } = useDirectory(workspaceId);

  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  // 실패 문구는 **어느 행동의 것인지**를 함께 든다. 이 화면은 한 화면에 다 들어가지
  // 않는 장부라(여섯 줄 각자가 폼을 펼친다), 맨 위 배너 하나로 답하면 800px 아래에서
  // 저장을 누른 사람에게 그 답이 화면 밖에서 뜬다. 인라인 배너의 「in context」는
  // 토스트가 아니라는 뜻만이 아니라, **그 컨트롤 옆**이라는 뜻이다.
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(
    null
  );

  const list = useQuery(hostedListQuery(workspaceId));
  const found =
    list.data?.find((row) => uuidEq(row.agentMemberId, agentMemberId)) ?? null;
  const connectionId = found === null ? "" : normalizedId(found.id);
  const detail = useQuery({
    ...hostedConnectionDetailQuery(workspaceId, connectionId),
    enabled: found !== null,
  });

  // 목록의 한 줄도 커넥션이다. 단건이 아직 안 왔을 때 그 줄로 머리글을 그리면
  // 화면이 비어 있는 대신 상태를 말한다 — 정리 목록만 그때 없다.
  const connection: HostedAgentConnection | null = detail.data?.connection ?? found;
  const artifacts: readonly HostedCleanupArtifact[] = detail.data?.artifacts ?? [];

  function writeDetail(next: HostedConnectionDetail) {
    client.setQueryData(
      hostedConnectionDetailQueryKey(workspaceId, normalizedId(next.connection.id)),
      next
    );
    invalidateHostedConnection(client, workspaceId, normalizedId(next.connection.id));
  }

  const start = useMutation({
    mutationFn: async () => {
      if (found === null) throw new Error("no connection");
      const wire = await disconnectHostedConnection(workspaceId, connectionId);
      return parseDisconnectStart(wire, { connectionId: found.id });
    },
    onSuccess: (started) => {
      setFailure(null);
      setOpenArtifactId(null);
      writeDetail(started);
    },
    onError: (error) =>
      setFailure({
        scope: "start",
        message: hostedFailureMessage("disconnect", error),
      }),
  });

  const acknowledge = useMutation({
    mutationFn: async (input: {
      artifact: HostedCleanupArtifact;
      currentStatus: HostedCleanupStatus;
      choice: HostedCleanupChoice | null;
      evidence: string;
    }) => {
      const body = buildAcknowledgement(
        input.artifact.kind,
        input.currentStatus,
        input.choice,
        input.evidence
      );
      const wire = await acknowledgeHostedCleanupArtifact(
        workspaceId,
        connectionId,
        input.artifact.id,
        body
      );
      return parseArtifactAcknowledgement(wire, { artifactId: input.artifact.id });
    },
    onSuccess: (acknowledged) => {
      setFailure(null);
      setOpenArtifactId(null);
      // 방금 받은 줄을 장부에 끼워 넣는다. 다시 받아 오기 전까지의 그 몇 백
      // 밀리초 동안에도 남은 수와 「다음은 무엇」이 맞아야 한다.
      if (connection !== null) {
        writeDetail({
          connection,
          artifacts: artifacts.map((row) =>
            row.id === acknowledged.artifact.id ? acknowledged.artifact : row
          ),
        });
      }
    },
    onError: (error, variables) =>
      setFailure({
        scope: variables.artifact.id,
        message: hostedFailureMessage("acknowledge", error),
      }),
  });

  const complete = useMutation({
    mutationFn: async () => {
      if (found === null) throw new Error("no connection");
      const wire = await completeHostedDisconnect(workspaceId, connectionId);
      return parseDisconnectCompletion(wire, { connectionId: found.id });
    },
    onSuccess: (completed) => {
      setFailure(null);
      // 확정의 피드백은 배너가 아니라 **화면 자체**다: 「해제 끝내기」 상자가
      // 「이 연결은 해제됐습니다」로 바뀌고 상태 칩이 함께 바뀐다. 그 위에 같은
      // 문장을 배너로 한 번 더 세우면 한 화면에 같은 말이 둘이고, 둘 중 어느
      // 것이 지금의 사실인지 읽는 사람이 판단해야 한다. 소리로는 live region 이
      // 그 전이를 알린다.
      writeDetail(completed);
    },
    onError: (error) =>
      setFailure({
        scope: "complete",
        message: hostedFailureMessage("complete", error),
      }),
  });

  const busy = start.isPending || acknowledge.isPending || complete.isPending;
  const live = disconnectLiveMessage(connection, artifacts);

  return (
    <section
      className="flex min-w-0 flex-col gap-4 p-4"
      aria-label={`${agentLabel} 호스티드 연결`}
      data-testid="hosted-connection-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-title font-semibold text-ink">호스티드 연결</h3>
        <p className="break-keep text-body text-ink-muted">
          {DISCONNECT_SECTION_LEAD}
        </p>
        {/* 상태 전이는 소리로도 알린다. 이 표면에는 비밀값이 오지 않는다. */}
        <p role="status" aria-live="polite" className="sr-only">
          {live}
        </p>
      </div>

      {list.isPending && (
        <div role="status">
          <span className="sr-only">호스티드 연결을 불러오는 중입니다.</span>
          <SkeletonRows rows={3} className="p-0" />
        </div>
      )}

      {!list.isPending && list.isError && <ListFailure error={list.error} onRetry={() => void list.refetch()} />}

      {!list.isPending && !list.isError && found === null && (
        <EmptyInvite
          className="px-0"
          headline="이 에이전트는 호스티드 연결로 들어오지 않았습니다."
          detail="이 워크스페이스가 직접 실행하는 에이전트이므로 provider에 정리할 설정이 없습니다."
          testId="hosted-disconnect-absent"
        />
      )}

      {found !== null && connection !== null && (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusChip tone={chipTone(connection)}>
              {hostedStatusLabel(connection.status)}
            </StatusChip>
            <p className="min-w-0 flex-1 break-keep text-meta text-ink-muted">
              {hostedStatusDetail(connection)}
            </p>
          </div>

          {detail.isPending && (
            <div role="status">
              <span className="sr-only">정리 목록을 불러오는 중입니다.</span>
              <SkeletonRows rows={4} className="p-0" />
            </div>
          )}
          {detail.isError && (
            <InlineBanner
              separator={false}
              message={hostedFailureMessage("get", detail.error)}
              actionLabel="다시 시도"
              onAction={() => void detail.refetch()}
              testId="hosted-disconnect-detail-error"
            />
          )}

          {connection.status !== "cleanup_pending" &&
            connection.status !== "disconnected" && (
              <StartPanel
                connection={connection}
                failure={failure?.scope === "start" ? failure.message : null}
                onDismissFailure={() => setFailure(null)}
                offline={offline}
                busy={busy}
                starting={start.isPending}
                onStart={() => {
                  if (offline || busy) return;
                  start.mutate();
                }}
              />
            )}

          {(connection.status === "cleanup_pending" ||
            connection.status === "disconnected") && (
            <>
              <RevokedFacts connection={connection} />
              <CleanupPanel
                connection={connection}
                artifacts={artifacts}
                openArtifactId={openArtifactId}
                setOpenArtifactId={setOpenArtifactId}
                nameFor={(memberId) =>
                  memberFor(directory, memberId)?.displayName ?? null
                }
                failure={failure}
                onDismissFailure={() => setFailure(null)}
                offline={offline}
                busy={busy}
                saving={acknowledge.isPending}
                onAcknowledge={(artifact, input) => {
                  if (offline || busy) return;
                  acknowledge.mutate({ artifact, ...input });
                }}
                repairing={start.isPending}
                onRepair={() => {
                  if (offline || busy) return;
                  start.mutate();
                }}
              />
              <TerminalPanel
                connection={connection}
                artifacts={artifacts}
                failure={failure?.scope === "complete" ? failure.message : null}
                onDismissFailure={() => setFailure(null)}
                offline={offline}
                busy={busy}
                completing={complete.isPending}
                onComplete={() => {
                  if (offline || busy) return;
                  complete.mutate();
                }}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

/** 잠긴 줄들이 함께 가리키는 사유 문장의 id. 한 화면에 하나뿐이다. */
const OFFLINE_NOTE_ID = "hosted-cleanup-offline-note";

function chipTone(connection: HostedAgentConnection) {
  const tone = hostedStatusTone(connection.status);
  return tone === "neutral" ? ("muted" as const) : tone;
}

/** 목록을 못 읽은 세 갈래. 미제공과 권한 없음은 장애가 아니다. */
function ListFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isHostedOperatorDenied(error)) {
    return (
      <EmptyInvite
        className="px-0"
        headline="호스티드 에이전트 연결은 오너나 관리자만 다룹니다."
        detail="이 연결을 해제하려면 이 워크스페이스의 관리자에게 요청하세요."
        testId="hosted-disconnect-denied"
      />
    );
  }
  if (serverSaysAbsent(error)) {
    const surface = serverSurface("hostedAgentPairing");
    return (
      <EmptyInvite
        className="px-0"
        headline={surface.absentReason}
        detail={surface.fallback}
        testId="hosted-disconnect-unsupported"
      />
    );
  }
  return (
    <InlineBanner
      separator={false}
      message={hostedFailureMessage("list", error)}
      actionLabel="다시 시도"
      onAction={onRetry}
      testId="hosted-disconnect-list-error"
    />
  );
}

// ---- 아직 살아 있는 연결 ----------------------------------------------------

/**
 * 해제 전 화면. **두 문단이 같은 크기로 선다.**
 *
 * 「지금 바로 일어나는 일」만 적은 확인 화면은 두 방향으로 거짓말한다: 사람은
 * provider 에 남을 것들을 모른 채 끊고, 동시에 대화 기록까지 지워질까 봐 망설인다.
 * 두 문단을 나란히 두는 것이 이 화면 전체의 논지이고, 그래서 disclosure 뒤가 아니라
 * 버튼 위에 펼쳐져 있다.
 */
function StartPanel({
  connection,
  failure,
  onDismissFailure,
  offline,
  busy,
  starting,
  onStart,
}: {
  connection: HostedAgentConnection;
  failure: string | null;
  onDismissFailure: () => void;
  offline: boolean;
  busy: boolean;
  starting: boolean;
  onStart: () => void;
}) {
  const gate = disconnectStartGate(connection);
  const blockedId = "hosted-disconnect-start-blocked";
  const blocked = !gate.allowed || offline;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h4 className="text-body font-semibold text-ink">
            {DISCONNECT_IMMEDIATE_HEADLINE}
          </h4>
          <ul className="flex list-outside list-disc flex-col gap-1 ps-4">
            {DISCONNECT_IMMEDIATE_ITEMS.map((item) => (
              <li key={item} className="break-keep text-meta text-ink-muted">
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h4 className="text-body font-semibold text-ink">
            {DISCONNECT_NOT_DONE_HEADLINE}
          </h4>
          <ul className="flex list-outside list-disc flex-col gap-1 ps-4">
            {DISCONNECT_NOT_DONE_ITEMS.map((item) => (
              <li key={item} className="break-keep text-meta text-ink-muted">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="break-keep text-meta text-ink-muted">{DISCONNECT_HISTORY_NOTE}</p>
      {failure !== null && (
        <InlineBanner
          separator={false}
          message={failure}
          actionLabel="닫기"
          onAction={onDismissFailure}
          testId="hosted-disconnect-failure"
        />
      )}
      {blocked && (
        <p id={blockedId} className="break-keep text-meta text-ink-muted">
          {gate.allowed
            ? "연결이 끊겨 있어 지금은 해제를 시작할 수 없습니다."
            : gate.blockedCopy}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {starting ? (
          // 진행 중인 컨트롤을 `disabled` 로 만들지 않는 것이 이 레포의 규율이다
          // (States.tsx `actionBusy`): 회색이 되는 컨트롤은 「지금 일어나는 중」이
          // 아니라 「당신은 이걸 못 한다」로 읽힌다. 초점은 남고, 눌러도 아무 일이
          // 일어나지 않으며, 낱말과 aria-busy 가 상태를 말한다.
          <Button
            type="button"
            variant="destructive"
            size="sm"
            aria-disabled
            aria-busy
            className="opacity-50"
          >
            해제하는 중
          </Button>
        ) : (
          <ConfirmButton
            label={DISCONNECT_START_LABEL}
            question={DISCONNECT_START_QUESTION}
            confirmLabel={DISCONNECT_START_CONFIRM_LABEL}
            describedBy={blocked ? blockedId : undefined}
            disabled={blocked || busy}
            onConfirm={onStart}
            testId="hosted-disconnect-start"
          />
        )}
      </div>
    </div>
  );
}

// ---- 이미 끊긴 것 -----------------------------------------------------------

/** 첫 걸음이 이미 한 일 셋. 한 transaction 의 결과라 부분 참이 없다. */
function RevokedFacts({ connection }: { connection: HostedAgentConnection }) {
  const facts = revokeFacts(connection);
  if (facts.length === 0) return null;
  return (
    <div
      className="rounded-md border border-line p-3"
      data-testid="hosted-disconnect-revoked"
    >
      <h4 className="pb-2 text-body font-semibold text-ink">oort 쪽에서 끊긴 것</h4>
      <KeyValueRows
        rows={facts.map((fact) => ({
          key: fact.key,
          value: fact.value,
          prose: true,
        }))}
      />
    </div>
  );
}

// ---- 정리 장부 --------------------------------------------------------------

function CleanupPanel({
  connection,
  artifacts,
  openArtifactId,
  setOpenArtifactId,
  nameFor,
  failure,
  onDismissFailure,
  offline,
  busy,
  saving,
  onAcknowledge,
  repairing,
  onRepair,
}: {
  connection: HostedAgentConnection;
  artifacts: readonly HostedCleanupArtifact[];
  openArtifactId: string | null;
  setOpenArtifactId: (id: string | null) => void;
  nameFor: (memberId: string) => string | null;
  failure: { scope: string; message: string } | null;
  onDismissFailure: () => void;
  offline: boolean;
  busy: boolean;
  saving: boolean;
  onAcknowledge: (
    artifact: HostedCleanupArtifact,
    input: {
      currentStatus: HostedCleanupStatus;
      choice: HostedCleanupChoice | null;
      evidence: string;
    }
  ) => void;
  repairing: boolean;
  onRepair: () => void;
}) {
  const progress = cleanupProgress(artifacts);
  const repair = manifestRepairGate(connection);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h4 className="text-body font-semibold text-ink">{CLEANUP_HEADLINE}</h4>
        <p className="break-keep text-meta text-ink-muted">{CLEANUP_LEAD}</p>
        <p className="break-keep text-meta text-ink-muted">
          {CLEANUP_INDEPENDENCE_NOTE}
        </p>
        {/* 두 분모가 다르다 (follow-up #6): 「resolved/total」은 필수·선택을 가리지
            않는 전체이고, 문장의 「N개 남았습니다」는 미해결 **필수** 수다. 지금
            픽스처는 전부 required:true 라 둘이 어긋나지 않지만, 선택 항목이 서면
            (미해결 선택 줄은 total 에는 들지만 「남았습니다」에는 안 든다) 두 수가
            벌어진다. 그때는 분모를 필수 수로 맞추거나 문장이 선택 줄을 따로 말해야
            한다. */}
        <p
          className="break-keep text-meta text-ink"
          data-testid="hosted-cleanup-progress"
        >
          <span data-numeric className="font-mono">
            {progress.resolved}/{progress.total}
          </span>{" "}
          {cleanupProgressSentence(progress)}
        </p>
        {/* 잠긴 여섯 줄이 가리키는 한 문장. 줄마다 반복하면 같은 사실이 여섯 번
            서고, 빼면 회색 버튼이 「당신은 이걸 못 한다」로 읽힌다. */}
        {offline && (
          <p
            id={OFFLINE_NOTE_ID}
            className="break-keep text-meta text-ink-muted"
            data-testid="hosted-cleanup-offline"
          >
            {CLEANUP_OFFLINE_NOTE}
          </p>
        )}
      </div>

      {artifacts.length === 0 ? (
        <EmptyInvite
          className="px-0"
          headline="정리 목록이 비어 있습니다."
          detail={MANIFEST_REPAIR_NOTE}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!repair.allowed || offline || busy}
              aria-busy={repairing || undefined}
              onClick={onRepair}
              data-testid="hosted-cleanup-repair"
            >
              {repairing ? "복원하는 중" : MANIFEST_REPAIR_LABEL}
            </Button>
          }
          testId="hosted-cleanup-empty"
        />
      ) : (
        <ul
          className="flex flex-col overflow-hidden rounded-md border border-line"
          data-testid="hosted-cleanup-manifest"
        >
          {artifacts.map((artifact) => (
            <CleanupArtifactRow
              key={artifact.id}
              artifact={artifact}
              open={openArtifactId === artifact.id}
              onOpenChange={(next) => setOpenArtifactId(next ? artifact.id : null)}
              actorName={
                artifact.acknowledgedBy === undefined
                  ? null
                  : (nameFor(artifact.acknowledgedBy) ?? "이름을 읽지 못한 멤버")
              }
              failure={
                failure?.scope === artifact.id ? failure.message : null
              }
              onDismissFailure={onDismissFailure}
              disabled={offline || busy}
              disabledReasonId={offline ? OFFLINE_NOTE_ID : undefined}
              saving={saving && openArtifactId === artifact.id}
              onAcknowledge={(input) => onAcknowledge(artifact, input)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- 마지막 걸음 ------------------------------------------------------------

function TerminalPanel({
  connection,
  artifacts,
  failure,
  onDismissFailure,
  offline,
  busy,
  completing,
  onComplete,
}: {
  connection: HostedAgentConnection;
  artifacts: readonly HostedCleanupArtifact[];
  failure: string | null;
  onDismissFailure: () => void;
  offline: boolean;
  busy: boolean;
  completing: boolean;
  onComplete: () => void;
}) {
  if (connection.status === "disconnected") {
    return (
      <div
        className="flex min-w-0 flex-col gap-1 rounded-md border border-line p-3"
        data-testid="hosted-disconnect-terminal"
      >
        <h4 className="text-body font-semibold text-ink">{TERMINAL_DONE_HEADLINE}</h4>
        <p className="break-keep text-meta text-ink-muted">{TERMINAL_DONE_DETAIL}</p>
      </div>
    );
  }
  const gate = terminalGate(connection, artifacts);
  const blockedId = "hosted-disconnect-terminal-blocked";
  const blocked = !gate.allowed || offline;
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-md border border-line p-3"
      data-testid="hosted-disconnect-terminal"
    >
      <h4 className="text-body font-semibold text-ink">{TERMINAL_HEADLINE}</h4>
      <p className="break-keep text-meta text-ink-muted">{TERMINAL_LEAD}</p>
      {failure !== null && (
        <InlineBanner
          separator={false}
          message={failure}
          actionLabel="닫기"
          onAction={onDismissFailure}
          testId="hosted-disconnect-failure"
        />
      )}
      {/* 막힌 이유는 언제나 버튼 옆에 있다. 남은 수와 다음 항목이 그 문장이다. */}
      {blocked && (
        <p
          id={blockedId}
          className="break-keep text-meta text-ink-muted"
          data-testid="hosted-terminal-blocked"
        >
          {gate.allowed
            ? "연결이 끊겨 있어 지금은 해제를 확정할 수 없습니다."
            : gate.blockedCopy}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {completing ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-disabled
            aria-busy
            className="opacity-50"
          >
            확정하는 중
          </Button>
        ) : (
          <ConfirmButton
            label={TERMINAL_LABEL}
            question={TERMINAL_QUESTION}
            confirmLabel={TERMINAL_CONFIRM_LABEL}
            describedBy={blocked ? blockedId : undefined}
            disabled={blocked || busy}
            onConfirm={onComplete}
            testId="hosted-disconnect-complete"
          />
        )}
      </div>
    </div>
  );
}
