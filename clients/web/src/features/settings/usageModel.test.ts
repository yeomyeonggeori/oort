import { beforeEach, describe, expect, it } from "vitest";
import { formatMicroUsd } from "@/features/timeline/agentCardModel";
import fixtures from "./usageFixtures.json";
import {
  USAGE_PERIODS,
  barShare,
  budgetGrainLabel,
  budgetStatus,
  costConfidence,
  forgetUsage,
  formatBucketStart,
  formatIsoDay,
  formatRange,
  isEmptyUsage,
  largestCost,
  parseUsageSummary,
  peakBucket,
  percentOf,
  recallUsage,
  relativeSince,
  rememberUsage,
  usageErrorCopy,
  usageQuery,
  usageView,
  type UsageSummary,
} from "./usageModel";

// The three fixtures are the contract shapes the engine ticket (MOMO-615) is
// implementing in parallel: a populated range, an empty range (200 with zeros,
// not a 404), and a workspace sitting on its hard limit. They live in
// usageFixtures.json so scripts/capture-usage.mjs renders the exact same bytes
// these assertions are written against.

const normal = parseUsageSummary(fixtures.normal);
const emptyPeriod = parseUsageSummary(fixtures.emptyPeriod);
const hardLimit = parseUsageSummary(fixtures.budgetHardLimit);

describe("parseUsageSummary (계약 v1)", () => {
  it("reads the populated fixture whole", () => {
    expect(normal.range).toEqual({
      from: "2026-06-25T00:00:00Z",
      to: "2026-07-25T00:00:00Z",
      bucket: "day",
    });
    expect(normal.totals.costMicroUsd).toBe(18_432_500);
    expect(normal.totals.estimatedMicroUsd).toBe(2_140_000);
    expect(normal.buckets).toHaveLength(10);
    expect(normal.byModel.map((m) => m.model)).toEqual([
      "claude-opus-5",
      "gpt-5.6-sol",
      "claude-haiku-4.5",
    ]);
    expect(normal.byAgent).toHaveLength(2);
    expect(normal.budget?.state).toBe("normal");
  });

  it("lower-cases agent UUIDs, because the server sends them upper-cased", () => {
    expect(normal.byAgent[0].agentMemberId).toBe(
      "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90"
    );
    expect(normal.byAgent.every((a) => a.agentMemberId === a.agentMemberId.toLowerCase())).toBe(
      true
    );
  });

  it("keeps an empty range as zeros and a null budget, never as an error", () => {
    expect(emptyPeriod.totals.costMicroUsd).toBe(0);
    expect(emptyPeriod.byModel).toEqual([]);
    expect(emptyPeriod.byAgent).toEqual([]);
    expect(emptyPeriod.budget).toBeNull();
    expect(isEmptyUsage(emptyPeriod)).toBe(true);
    expect(isEmptyUsage(normal)).toBe(false);
  });

  it("tolerates missing lists and fields rather than blanking the panel", () => {
    const sparse = parseUsageSummary({ range: { bucket: "week" } });
    expect(sparse.range.bucket).toBe("week");
    expect(sparse.totals.costMicroUsd).toBe(0);
    expect(sparse.buckets).toEqual([]);
    expect(sparse.budget).toBeNull();
  });

  it("refuses a body that is not an object", () => {
    expect(() => parseUsageSummary(null)).toThrow();
    expect(() => parseUsageSummary("nope")).toThrow();
    expect(() => parseUsageSummary([1, 2])).toThrow();
  });

  it("falls back to day for an unknown bucket and normal for an unknown state", () => {
    const odd = parseUsageSummary({
      range: { from: "", to: "", bucket: "fortnight" },
      budget: { state: "über" },
    });
    expect(odd.range.bucket).toBe("day");
    expect(odd.budget?.state).toBe("normal");
  });
});

describe("usageQuery", () => {
  const NOW = Date.parse("2026-07-25T09:00:00Z");

  it("asks for the selected window and bucket", () => {
    expect(usageQuery("7d", "day", NOW)).toEqual({
      from: "2026-07-18T09:00:00.000Z",
      to: "2026-07-25T09:00:00.000Z",
      bucket: "day",
    });
    expect(usageQuery("30d", "week", NOW).from).toBe("2026-06-25T09:00:00.000Z");
  });

  it("stays far inside the contract ceiling of 93 days", () => {
    for (const period of USAGE_PERIODS) expect(period.days).toBeLessThanOrEqual(93);
  });
});

describe("cost confidence (추정치 분리 표기)", () => {
  it("splits the total into settled and estimated, never adding them", () => {
    const split = costConfidence(normal.totals);
    expect(split.estimatedMicroUsd).toBe(2_140_000);
    expect(split.settledMicroUsd).toBe(16_292_500);
    expect(split.settledMicroUsd + split.estimatedMicroUsd).toBe(
      normal.totals.costMicroUsd
    );
    expect(split.estimatedPercent).toBe(11);
    expect(split.allSettled).toBe(false);
  });

  it("reports a fully reconciled range as settled", () => {
    const split = costConfidence(hardLimit.totals);
    expect(split.allSettled).toBe(true);
    expect(split.settledMicroUsd).toBe(9_420_000);
    expect(split.estimatedPercent).toBe(0);
  });

  it("never renders a negative charge when the estimate exceeds the total", () => {
    const split = costConfidence({
      costMicroUsd: 1_000,
      estimatedMicroUsd: 5_000,
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(split.settledMicroUsd).toBe(0);
  });

  it("formats cost with the shared formatter, so $0.001 never rounds to $0", () => {
    expect(formatMicroUsd(normal.totals.costMicroUsd)).toBe("$18.43");
    expect(formatMicroUsd(0)).toBe("$0");
  });
});

describe("breakdown bars", () => {
  it("scales each row against the largest row, not the total", () => {
    const max = largestCost(normal.byModel);
    expect(max).toBe(12_100_000);
    expect(barShare(12_100_000, max)).toBe(100);
    expect(barShare(4_832_500, max)).toBe(40);
    expect(barShare(1_500_000, max)).toBe(12);
  });

  it("keeps a nonzero row visible and a zero row empty", () => {
    expect(barShare(1, 10_000_000)).toBe(1);
    expect(barShare(0, 10_000_000)).toBe(0);
    expect(barShare(5, 0)).toBe(0);
  });

  it("finds the most expensive bucket, not the last one", () => {
    const peak = peakBucket(normal.buckets);
    expect(peak?.start).toBe("2026-07-21T00:00:00Z");
    expect(peak?.costMicroUsd).toBe(3_420_000);
    expect(peakBucket(emptyPeriod.buckets)).toBeNull();
    expect(peakBucket([{ start: "x", costMicroUsd: 0, promptTokens: 0, completionTokens: 0 }])).toBeNull();
  });
});

describe("budget", () => {
  it("reads normal state against spent plus reserved", () => {
    const status = budgetStatus(normal.budget!, formatMicroUsd);
    expect(status.tone).toBe("ok");
    expect(status.label).toBe("한도 안");
    expect(status.observedMicroUsd).toBe(19_682_500);
    expect(status.usedPercent).toBe(39);
    expect(status.detail).toBe("한도 $50.00 중 $19.68을 썼습니다.");
  });

  it("states the hard limit without claiming the server blocks anything", () => {
    const status = budgetStatus(hardLimit.budget!, formatMicroUsd);
    expect(status.tone).toBe("danger");
    expect(status.label).toBe("한도 도달");
    expect(status.observedMicroUsd).toBe(50_200_000);
    expect(status.usedPercent).toBe(100);
    expect(status.detail).toContain("예산을 다시 정하거나");
    expect(status.detail).not.toContain("막힙니다");
  });

  it("marks the soft limit as 주의, not as a failure", () => {
    const status = budgetStatus(
      { ...normal.budget!, state: "soft_limit", spentMicroUsd: 41_000_000 },
      formatMicroUsd
    );
    expect(status.tone).toBe("warn");
    expect(status.label).toBe("주의");
  });

  it("names the grain in Korean and passes an unknown grain through", () => {
    expect(budgetGrainLabel("workspace")).toBe("워크스페이스 전체");
    expect(budgetGrainLabel("agent_channel")).toBe("에이전트와 채널별");
    expect(budgetGrainLabel("team_quarter")).toBe("team_quarter");
  });
});

describe("formatting", () => {
  it("renders a range as two local days plus the bucket unit", () => {
    expect(formatRange(normal.range)).toBe("2026-06-25 ~ 2026-07-25 · 일별");
    expect(formatRange({ ...normal.range, bucket: "week" })).toContain("주별");
  });

  it("labels a bucket at the grain it covers", () => {
    expect(formatBucketStart("2026-07-21T00:00:00Z", "day")).toBe("2026-07-21");
    expect(formatBucketStart("2026-07-21T00:00:00Z", "week")).toBe("2026-07-21 주");
    expect(formatBucketStart("2026-07-01T00:00:00Z", "month")).toBe("2026-07");
  });

  it("returns unparseable input untouched instead of Invalid Date", () => {
    expect(formatIsoDay("not-a-date")).toBe("not-a-date");
  });

  it("floors percentages so a remainder never rounds up to a full share", () => {
    expect(percentOf(999, 1000)).toBe(99);
    expect(percentOf(1, 0)).toBe(0);
  });

  it("ages the last-known stamp in whole units", () => {
    const now = Date.parse("2026-07-25T09:00:00Z");
    expect(relativeSince(now - 5_000, now)).toBe("방금");
    expect(relativeSince(now - 180_000, now)).toBe("3분 전");
    expect(relativeSince(now - 7_200_000, now)).toBe("2시간 전");
    expect(relativeSince(now - 3 * 86_400_000, now)).toBe("3일 전");
    expect(relativeSince(now + 5_000, now)).toBe("방금");
  });
});

describe("failure copy", () => {
  it("turns the pre-engine 404 into a sentence with a next step", () => {
    expect(usageErrorCopy(404, "HTTP 404")).toBe(
      "이 서버는 아직 사용량 집계를 제공하지 않습니다. 서버를 업데이트한 뒤 다시 열어보세요."
    );
  });

  it("points a rejected range back at the control that sets it", () => {
    expect(usageErrorCopy(400, "HTTP 400")).toContain("기간을 좁혀");
  });

  it("keeps the server's own message for everything else", () => {
    expect(usageErrorCopy(503, "집계 중입니다.")).toBe("집계 중입니다.");
    expect(usageErrorCopy(null, "서버에 닿지 못했습니다.")).toBe(
      "서버에 닿지 못했습니다."
    );
  });
});

describe("마지막 확인값 폴백 (P15 내구층)", () => {
  const WS = "00000000-0000-7000-8000-000000000001";
  const NOW = Date.parse("2026-07-25T09:00:00Z");
  const CHECKED = NOW - 180_000;

  beforeEach(() => forgetUsage());

  it("recalls a remembered summary case-insensitively by workspace id", () => {
    rememberUsage(WS.toUpperCase(), normal, CHECKED);
    expect(recallUsage(WS)?.summary.totals.costMicroUsd).toBe(18_432_500);
    expect(recallUsage(WS)?.checkedAtMs).toBe(CHECKED);
  });

  it("forgets everything on sign-out", () => {
    rememberUsage(WS, normal, CHECKED);
    forgetUsage();
    expect(recallUsage(WS)).toBeNull();
  });

  function view(over: Partial<Parameters<typeof usageView>[0]> = {}) {
    return usageView({
      pending: false,
      data: null,
      dataUpdatedAtMs: 0,
      errorMessage: null,
      offline: false,
      lastKnown: null,
      nowMs: NOW,
      ...over,
    });
  }

  it("prefers fresh data over anything cached", () => {
    const state = view({
      data: normal,
      dataUpdatedAtMs: NOW,
      lastKnown: { summary: emptyPeriod, checkedAtMs: CHECKED },
      offline: true,
    });
    expect(state.kind).toBe("ready");
    expect(state.kind === "ready" && state.summary.totals.costMicroUsd).toBe(
      18_432_500
    );
  });

  it("labels data that survived a failed refresh instead of passing it off as live", () => {
    const state = view({
      data: normal,
      dataUpdatedAtMs: CHECKED,
      errorMessage: "서버에 닿지 못했습니다.",
    });
    expect(state.kind).toBe("last-known");
    if (state.kind !== "last-known") throw new Error("expected last-known");
    expect(state.checkedAtMs).toBe(CHECKED);
    expect(state.notice).toContain("마지막으로 확인한 값(3분 전)");
  });

  it("shows the last confirmed answer with its age when the read fails", () => {
    const state = view({
      errorMessage: "서버가 15초 안에 응답하지 않았습니다.",
      lastKnown: { summary: normal, checkedAtMs: CHECKED },
    });
    expect(state.kind).toBe("last-known");
    if (state.kind !== "last-known") throw new Error("expected last-known");
    expect(state.notice).toBe(
      "서버가 15초 안에 응답하지 않았습니다. 마지막으로 확인한 값(3분 전)을 표시합니다."
    );
    expect(state.checkedAtMs).toBe(CHECKED);
    expect(state.summary.totals.costMicroUsd).toBe(18_432_500);
  });

  it("says what happened with nothing to fall back on", () => {
    const state = view({ errorMessage: "요청을 끝내지 못했습니다." });
    expect(state).toEqual({ kind: "error", message: "요청을 끝내지 못했습니다." });
  });

  it("keeps the cached range rendering while offline, undimmed", () => {
    const state = view({
      offline: true,
      lastKnown: { summary: normal, checkedAtMs: CHECKED },
    });
    expect(state.kind).toBe("last-known");
    expect(state.kind === "last-known" && state.notice).toContain("연결이 끊겼습니다.");
  });

  it("states the offline case plainly when there is no cached answer", () => {
    const state = view({ offline: true });
    expect(state).toEqual({
      kind: "error",
      message: "연결이 끊겼습니다. 다시 연결되면 사용량을 불러옵니다.",
    });
  });

  it("shows bars, not the previous range's numbers, while a new range loads", () => {
    const state = view({
      pending: true,
      lastKnown: { summary: normal, checkedAtMs: CHECKED },
    });
    expect(state).toEqual({ kind: "loading" });
  });

  it("carries the empty flag through the cached path too", () => {
    const state = view({
      errorMessage: "요청을 끝내지 못했습니다.",
      lastKnown: { summary: emptyPeriod, checkedAtMs: CHECKED },
    });
    expect(state.kind === "last-known" && state.empty).toBe(true);
  });

  it("round-trips a remembered summary through the view without reshaping it", () => {
    rememberUsage(WS, hardLimit, CHECKED);
    const cached = recallUsage(WS);
    const state = view({ errorMessage: "끊겼습니다.", lastKnown: cached });
    const summary: UsageSummary | undefined =
      state.kind === "last-known" ? state.summary : undefined;
    expect(summary?.budget?.state).toBe("hard_limit");
  });
});
