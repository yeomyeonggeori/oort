import { ExternalLink, GitPullRequest } from "lucide-react";
import {
  RUN_STAGE_CAP,
  agentRunReport,
  artifactChangeText,
  hasRunReport,
} from "@momo/core/features/workbench/runReport";
import { TEAM_BOARD_COPY } from "@momo/core/features/workbench/teamBoard";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 작업 상세의 「에이전트가 알린 단계·결과」 (AT-5 #3518, ADR-0162 증보 3 D11·D12).
//
// `agent_run.output`은 에이전트가 스스로 보낸 값이다. 서버는 형식만 검증하고 사실은
// 보증하지 않는다. 그래서 이 구역은
//   - 단계·브랜치를 **일반 텍스트로만** 그린다: React 텍스트 노드뿐이다. 마크다운 변환,
//     자동 링크, `dangerouslySetInnerHTML`이 없다(시험이 `[x](javascript:…)`와
//     `<img onerror>`가 글자 그대로 남는 것을 잠근다).
//   - 링크가 되는 것은 PR 주소 하나뿐이고, `agentRunReport`가 https와 `/소유자/저장소/
//     pull/번호` 모양을 확인한 것만 `href`가 된다.
// 보고가 하나도 없는 run(mention·옛 서버·아직 아무것도 알리지 않음)에는 아무것도 그리지
// 않는다.
// =============================================================================

const HEADING = "text-meta font-semibold text-ink-muted";

export function RunReportSection({ output }: { output: unknown }) {
  const report = agentRunReport(output);
  if (!hasRunReport(report)) return null;
  const { artifacts, stages } = report;
  const change = artifactChangeText(artifacts);
  const hasArtifacts =
    artifacts.pr !== null ||
    artifacts.branch !== null ||
    artifacts.commits !== null ||
    change !== null;
  return (
    <div className="flex flex-col gap-4" data-testid="run-report">
      {stages.length > 0 && (
        <section aria-labelledby="run-report-stages">
          <h3 id="run-report-stages" className={HEADING}>
            {TEAM_BOARD_COPY.runStepsHeading}
          </h3>
          <ol
            className="mt-1 flex flex-col gap-1"
            data-testid="run-report-stages"
            data-cap={RUN_STAGE_CAP}
          >
            {stages.map((stage, index) => {
              const current = index === stages.length - 1;
              return (
                <li
                  key={`${index}-${stage}`}
                  className="flex items-center gap-2 text-body text-ink"
                  data-tone={current ? "current" : "done"}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      current ? "bg-signal" : "bg-ink-muted"
                    )}
                  />
                  <span className="min-w-0 break-words">{stage}</span>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {hasArtifacts && (
        <section aria-labelledby="run-report-artifacts">
          <h3 id="run-report-artifacts" className={HEADING}>
            {TEAM_BOARD_COPY.runArtifactsHeading}
          </h3>
          <div className="mt-1 flex flex-col gap-2">
            {artifacts.pr !== null && (
              <a
                href={artifacts.pr.href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="run-report-pr"
                className="flex min-w-0 items-center gap-2 rounded-lg border border-line px-3 py-2 text-body text-ink press hover:bg-surface-hover focus-visible:focus-ring"
              >
                <GitPullRequest aria-hidden className="size-4 shrink-0 text-icon" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{artifacts.pr.number}</span>
                  <span className="truncate text-meta text-ink-muted">
                    {artifacts.pr.repo}
                  </span>
                </span>
                <ExternalLink aria-hidden className="size-3 shrink-0 text-icon" />
                <span className="sr-only">새 탭에서 열기</span>
              </a>
            )}
            <dl className="flex flex-col gap-1 text-body">
              {artifacts.branch !== null && (
                <div className="grid grid-cols-3 gap-2">
                  <dt className="min-w-0 text-ink-muted">{TEAM_BOARD_COPY.runBranch}</dt>
                  <dd
                    className="col-span-2 min-w-0 break-all font-mono text-timestamp text-ink"
                    data-testid="run-report-branch"
                  >
                    {artifacts.branch}
                  </dd>
                </div>
              )}
              {(artifacts.commits !== null || change !== null) && (
                <div className="grid grid-cols-3 gap-2">
                  <dt className="min-w-0 text-ink-muted">변경</dt>
                  <dd
                    className="col-span-2 min-w-0 text-ink"
                    data-numeric
                    data-testid="run-report-counts"
                  >
                    {[
                      artifacts.commits !== null ? `커밋 ${artifacts.commits}개` : null,
                      change,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(" · ")}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </section>
      )}
      <p className="break-keep text-meta text-ink-muted">{TEAM_BOARD_COPY.runNote}</p>
    </div>
  );
}
