import { useQuery } from "@tanstack/react-query";
import { fetchAgentRunDetail } from "@momo/core/lib/api";
import { TEAM_AI_DELEGATION_CHIP_COPY } from "@momo/core/features/settings/teamAiCopyKeys";
import {
  TEAM_AI_SPENT_LINE_SIZER,
  teamAiSpentLineOf,
  type TeamAiDelegatedAnswer,
  type TeamAiSpentLine,
} from "@momo/core/features/timeline/teamAiDelegationView";
import type { TeamAiReplyMeta as Meta } from "@momo/core/features/timeline/teamAiReply";
import { useSession } from "@/app/session";
import { useRunRow } from "@/features/agents/agentRunProgressStore";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { TeamAiReplyMeta } from "./TeamAiReplyMeta";

// =============================================================================
// 도우미가 Hermes에 맡겨 끝낸 답의 꼬리 (ADR-0201 증보 v4 P8·P15-A15, #5375 = P14-S7).
//
//   찾아본 것 …        [팀 AI · Claude Sonnet 5.5] [Hermes 도움 · 그림]
//   이 답이 쓴 양: 크레딧 토큰 12.3k · Hermes 1회(구독이라 oort가 금액을 못 재요)
//
// 서는 조건은 코어 `teamAiDelegatedAnswerOf` 하나다: **서버 소유 칩 칸**(`team_ai_delegated`)이 있는 에이전트의 도우미
// 답. 칩 칸이 없으면(운영 꺼짐·묶음 꺼짐·맡기지 않음·실패) 이 파일은 불리지 않고, 행은 예전 꼬리 그대로다.
//
// 칩은 모델 칩 **옆**이다(같은 줄, 같은 모양 — 이름이지 상태가 아니라 색이 없다). 이름은 그 Hermes 멤버의 **지금** 표시
// 이름이다(P1: 이름을 글자로 박지 않는다). 멤버 목록에 없으면 사전의 「Hermes」.
//
// 쓴 양은 run의 사실이라 답이 뜬 **뒤에** 온다(진행 읽기의 `spent`, 목록 밖으로 밀린 옛 run이면 run 상세). 그래서 줄의
// 자리는 답이 뜰 때 이미 서 있다: 가장 넓은 갈래(`TEAM_AI_SPENT_LINE_SIZER`)로 그린 보이지 않는 글이 같은 칸에 있어,
// 숫자가 늦게 와도 줄바꿈까지 같은 높이다(「대화 흔들림 0」). 서버 사실이므로 「에이전트 보고」 꼬리표를 달지 않고
// (ADR-0220 P1) 작업 요약 칩과 섞지 않는다.
// =============================================================================

/** 그 Hermes 멤버의 지금 표시 이름. 멤버 목록에 없으면 사전의 이름. */
function useHermesName(directory: Directory): (memberId: string) => string {
  const formatMessage = useFormatMessage();
  const fallback = formatMessage("teamAi.delegation.hermesFallbackName");
  return (memberId) => memberFor(directory, memberId)?.displayName?.trim() || fallback;
}

/** 모델 칩 옆의 「{이름} 도움 · 그림/검색」 칩들. */
export function TeamAiDelegationChips({
  answer,
  directory,
}: {
  answer: TeamAiDelegatedAnswer;
  directory: Directory;
}) {
  const formatMessage = useFormatMessage();
  const nameOf = useHermesName(directory);
  return (
    <>
      {answer.delegations.map((item) => (
        <span
          key={`${item.kind}:${item.agentMemberId}`}
          className="rounded-md bg-muted-soft px-2 py-px text-timestamp font-semibold text-ink-muted"
          data-testid="team-ai-delegation-chip"
          data-kind={item.kind}
        >
          {formatMessage(TEAM_AI_DELEGATION_CHIP_COPY[item.kind], { name: nameOf(item.agentMemberId) })}
        </span>
      ))}
    </>
  );
}

/** 이 답의 run이 쓴 양. 진행 읽기(살아 있는 값)가 먼저고, 거기 없으면 run 상세를 한 번 읽는다. */
function useRunSpent(runId: string | null): TeamAiSpentLine | null {
  const { workspaceId } = useSession();
  const row = useRunRow(runId);
  const live = row?.spent;
  const detail = useQuery({
    queryKey: ["agent-run-spent", workspaceId.toLowerCase(), runId],
    queryFn: async () => (await fetchAgentRunDetail(workspaceId, runId as string)).spent ?? null,
    retry: false,
    staleTime: 60_000,
    enabled: runId !== null && live === undefined,
  });
  return teamAiSpentLineOf(live ?? detail.data ?? undefined);
}

/** 쓴 양 한 줄의 글. */
function spentText(
  line: TeamAiSpentLine,
  hermesName: string,
  formatMessage: ReturnType<typeof useFormatMessage>
): string {
  const label = formatMessage("teamAi.delegation.spentLabel");
  const credits = formatMessage(
    line.estimated ? "teamAi.delegation.spentCreditsEstimated" : "teamAi.delegation.spentCredits",
    { tokens: line.tokens }
  );
  if (line.delegations <= 0) return formatMessage("teamAi.delegation.spentLine", { label, credits });
  const hermes = formatMessage("teamAi.delegation.spentHermes", { name: hermesName, count: line.delegations });
  return formatMessage("teamAi.delegation.spentLineWithHermes", { label, credits, hermes });
}

/** 「이 답이 쓴 양」 한 줄. 자리는 답이 뜰 때부터 서 있고, 숫자가 오면 그 자리에 글이 선다. */
export function TeamAiSpentLineView({
  answer,
  directory,
}: {
  answer: TeamAiDelegatedAnswer;
  directory: Directory;
}) {
  const formatMessage = useFormatMessage();
  const nameOf = useHermesName(directory);
  const line = useRunSpent(answer.runId);
  // 한 요청은 한 번 맡긴다(P2-R R10): 쓴 양의 Hermes는 첫 칩의 멤버다.
  const hermesName = nameOf(answer.delegations[0]?.agentMemberId ?? "");
  return (
    <div className="grid min-w-0 text-meta text-ink-muted" data-testid="team-ai-spent">
      {/* 자리 잡기: 가장 넓은 갈래의 글을 보이지 않게 같은 칸에 둔다(낭독도 하지 않는다). */}
      <p aria-hidden="true" className="invisible col-start-1 row-start-1 min-w-0 break-keep" data-numeric>
        {spentText(TEAM_AI_SPENT_LINE_SIZER, hermesName, formatMessage)}
      </p>
      {line !== null && (
        <p className="col-start-1 row-start-1 min-w-0 break-keep" data-numeric data-testid="team-ai-spent-line">
          {spentText(line, hermesName, formatMessage)}
        </p>
      )}
    </div>
  );
}

/**
 * 위임이 끝난 답의 꼬리 전체: 예전 꼬리(`TeamAiReplyMeta`)의 모델 칩 줄에 칩을 더하고, 그 아래 쓴 양 줄. 예전 꼬리가
 * 없는 답(모델을 싣지 않은 서버)이면 칩만 한 줄로 선다.
 */
export function TeamAiDelegationTail({
  meta,
  answer,
  directory,
}: {
  meta: Meta | null;
  answer: TeamAiDelegatedAnswer;
  directory: Directory;
}) {
  const chips = <TeamAiDelegationChips answer={answer} directory={directory} />;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="team-ai-delegation-tail">
      {meta !== null ? (
        <TeamAiReplyMeta meta={meta} chips={chips} />
      ) : (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">{chips}</div>
      )}
      <TeamAiSpentLineView answer={answer} directory={directory} />
    </div>
  );
}
