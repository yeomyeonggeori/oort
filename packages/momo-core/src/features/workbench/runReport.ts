import { prFacts } from "./teamBoard";

// =============================================================================
// 호스팅 에이전트가 스스로 알린 작업 보고 (AT-5 #3518, ADR-0162 증보 3 D11·D12).
//
// `agent_run.output`은 `{ stages: string[], artifacts: { prUrl?, branch?, added?,
// deleted?, commits? } }`다. 에이전트가 보낸 **자기 보고**이고 서버는 형식만 검증한다:
// 값이 사실인지는 모른다. 그래서 이 모듈은
//   - 모양이 틀리거나 없는 값은 조용히 비운다(오래된 서버·다른 종류의 run은 `output`
//     모양이 다르다). 예외를 던지지 않는다.
//   - 문자열(`stages`, `branch`)은 **그대로 돌려준다.** 일반 텍스트로만 그리는 것은
//     화면의 일이고, 여기서 이스케이프하거나 변환하지 않는다(이중 변환이 낳는 모호함을
//     피한다). 링크가 될 수 있는 것은 `prUrl` 하나뿐이고 `prFacts`가 https·모양을 본다.
// =============================================================================

/** 서버가 한 run에 담는 단계 표식 상한(D11). 화면도 같은 상한으로 자른다. */
export const RUN_STAGE_CAP = 12;

export interface RunArtifacts {
  /** 검증된 https PR 주소만. 아니면 null. */
  pr: { number: string; repo: string; href: string } | null;
  branch: string | null;
  added: number | null;
  deleted: number | null;
  commits: number | null;
}

export interface RunReport {
  stages: string[];
  artifacts: RunArtifacts;
}

function count(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function plain(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export const EMPTY_RUN_REPORT: RunReport = Object.freeze({
  stages: Object.freeze([]) as unknown as string[],
  artifacts: Object.freeze({
    pr: null,
    branch: null,
    added: null,
    deleted: null,
    commits: null,
  }),
});

export function agentRunReport(output: unknown): RunReport {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return EMPTY_RUN_REPORT;
  }
  const source = output as Record<string, unknown>;
  const stages = Array.isArray(source["stages"])
    ? source["stages"]
        .filter((stage): stage is string => typeof stage === "string" && stage !== "")
        .slice(-RUN_STAGE_CAP)
    : [];
  const rawArtifacts = source["artifacts"];
  const artifacts =
    typeof rawArtifacts === "object" &&
    rawArtifacts !== null &&
    !Array.isArray(rawArtifacts)
      ? (rawArtifacts as Record<string, unknown>)
      : {};
  return {
    stages,
    artifacts: {
      pr: prFacts(plain(artifacts, "prUrl")),
      branch: plain(artifacts, "branch"),
      added: count(artifacts, "added"),
      deleted: count(artifacts, "deleted"),
      commits: count(artifacts, "commits"),
    },
  };
}

/** 「+128 −40」 한 덩어리. 둘 다 없으면 null. */
export function artifactChangeText(artifacts: RunArtifacts): string | null {
  if (artifacts.added === null && artifacts.deleted === null) return null;
  return `+${artifacts.added ?? 0} −${artifacts.deleted ?? 0}`;
}

/** 활동 줄과 상세가 같이 쓰는 한 줄 요약: 「PR #12 · 커밋 2개 · +30 −4」. 없는 것은 말하지 않는다. */
export function artifactSummary(report: RunReport): string | null {
  const { artifacts } = report;
  const parts = [
    artifacts.pr?.number ?? null,
    artifacts.commits !== null ? `커밋 ${artifacts.commits}개` : null,
    artifactChangeText(artifacts),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function hasRunReport(report: RunReport): boolean {
  const a = report.artifacts;
  return (
    report.stages.length > 0 ||
    a.pr !== null ||
    a.branch !== null ||
    a.added !== null ||
    a.deleted !== null ||
    a.commits !== null
  );
}
