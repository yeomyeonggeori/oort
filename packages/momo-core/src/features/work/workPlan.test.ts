import { describe, expect, it } from "vitest";
import type { WorkSession } from "../../lib/api";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit/i18n";
import {
  carriesPlan,
  isLivePlanSession,
  pickPlanSession,
  planSessionsOf,
  workPlanCopy,
  workPlanProgress,
  workPlanSessionLabel,
  workPlanStepWord,
} from "./workPlan";
import type { WorkPlanItem } from "./workSessionModel";

// =============================================================================
// 대화 머리 계획 독의 규칙 (#4578). 화면은 이 값을 그리기만 하므로, 「2 of 4」의 2가 무엇인지, 어떤
// 단계가 「지금 단계」로 서는지, 어떤 세션이 대상인지가 여기서 잠긴다.
// =============================================================================

const CH = "019f9a34-53fd-7f7a-abff-1e1369f61090";
const OTHER_CH = "019f9a34-53fd-7f7a-abff-1e1369f61091";

const copyKo = createMessageCopy({ messageLocale: "ko-KR", catalog: ko });
const copyEn = createMessageCopy({ messageLocale: "en-US" });

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "019F9A34-5405-7FDA-9FB2-C6806F69D8A6",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    channelId: CH,
    memberId: "00000000-0000-7000-8000-000000000101",
    hostId: "019F9A34-53F2-793D-9CA7-5D5480407C9E",
    rootMessageId: "019F9A34-5406-77A9-AB33-B011D56B91F8",
    tool: "claude",
    label: "독 시안 정리",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

const PLAN: WorkPlanItem[] = [
  { content: "코어 모델 읽기", status: "completed" },
  { content: "독 만들기", status: "completed" },
  { content: "시험 쓰기", status: "in_progress" },
  { content: "캡처 장면 적기", status: "pending" },
];

describe("workPlanProgress: 「2 of 4」가 세는 것", () => {
  it("합계: 비면 null, 2의 뜻은 끝난 단계 수, 남은 수는 끝나지 않은 단계 수, 모두 끝나면 allDone", () => {
    // 「0 of 0」을 그릴 곳이 없다.
    expect(workPlanProgress([], true)).toBeNull();
    expect(workPlanProgress([], false)).toBeNull();

    const progress = workPlanProgress(PLAN, true);
    expect(progress?.total).toBe(4);
    expect(progress?.done).toBe(2);
    expect(progress?.remaining).toBe(2);
    expect(progress?.allDone).toBe(false);

    const finished = workPlanProgress(
      PLAN.map((item) => ({ ...item, status: "completed" as const })),
      false
    );
    expect(finished?.allDone).toBe(true);
    expect(finished?.remaining).toBe(0);
    expect(finished?.done).toBe(finished?.total);
  });

  it("돌고 있는 세션에서만 in_progress가 지금 단계로 선다", () => {
    const live = workPlanProgress(PLAN, true);
    expect(live?.steps.map((step) => step.state)).toEqual(["done", "done", "current", "pending"]);
    expect(live?.hasCurrent).toBe(true);

    // 멈춘 세션의 마지막 상태를 지금 하는 일처럼 강조하지 않는다: 그 단계는 대기로 센다.
    const stopped = workPlanProgress(PLAN, false);
    expect(stopped?.steps.map((step) => step.state)).toEqual(["done", "done", "pending", "pending"]);
    expect(stopped?.hasCurrent).toBe(false);
    expect(stopped?.done).toBe(2);
  });

  it("호스트가 쓴 글은 공백을 줄이고 상한에서 자른다(마크업으로 해석하지 않는다)", () => {
    const long = `${"가".repeat(130)}`;
    const progress = workPlanProgress(
      [
        { content: "  줄바꿈\n\n  많은   단계 ", status: "pending" },
        { content: long, status: "pending" },
        { content: "<img src=x onerror=alert(1)>", status: "pending" },
      ],
      true
    );
    expect(progress?.steps[0]?.content).toBe("줄바꿈 많은 단계");
    expect(Array.from(progress?.steps[1]?.content ?? "").length).toBe(121);
    expect(progress?.steps[1]?.content.endsWith("…")).toBe(true);
    // 글자 그대로 남는다: 걸러내거나 바꾸지 않는다.
    expect(progress?.steps[2]?.content).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("대상 세션: 이 대화에서 지금 돌거나 마지막으로 돈 것", () => {
  const running = session({ id: "run-1", status: "running", startedAtMs: 10 });
  const newerEnded = session({ id: "end-new", status: "ended", startedAtMs: 30 });
  const olderEnded = session({ id: "end-old", status: "ended", startedAtMs: 20 });
  const elsewhere = session({ id: "other", channelId: OTHER_CH, status: "running", startedAtMs: 99 });

  it("이 채널 것만, 돌고 있는 것이 새로 끝난 것보다 앞이고, 채널 id는 대소문자와 상관없다", () => {
    const ordered = planSessionsOf([olderEnded, elsewhere, newerEnded, running], CH);
    expect(ordered.map((s) => s.id)).toEqual(["run-1", "end-new", "end-old"]);
    // 서버는 대문자 UUID도 돌려준다.
    const upper = session({ id: "upper", channelId: CH.toUpperCase() });
    expect(planSessionsOf([upper], CH).map((s) => s.id)).toEqual(["upper"]);
  });

  it("사람이 고른 세션이 남아 있으면 그것, 사라졌거나 고른 적 없으면 첫 번째다", () => {
    const candidates = planSessionsOf([running, newerEnded, olderEnded], CH);
    expect(pickPlanSession(candidates, "end-old")?.id).toBe("end-old");
    expect(pickPlanSession(candidates, null)?.id).toBe("run-1");
    expect(pickPlanSession(candidates, "gone")?.id).toBe("run-1");
    expect(pickPlanSession([], "end-old")).toBeNull();
  });

  it("「지금 단계」 자격은 running뿐, 실시간은 계획 프레임만 쌓고, 고르는 줄은 「이름 · 상태」다", () => {
    expect(isLivePlanSession({ status: "running" })).toBe(true);
    for (const status of ["idle", "orphaned", "ended"] as const) {
      expect(isLivePlanSession({ status })).toBe(false);
    }
    // 실시간 꼬리는 계획을 실은 agent.status만 쌓는다: 글 조각·도구 줄·빈 계획은 거른다.
    const plan = [{ content: "읽기", status: "pending" }];
    expect(carriesPlan({ type: "agent.status", payload: { plan } })).toBe(true);
    expect(carriesPlan({ type: "agent.status", payload: { detail: "도구" } })).toBe(false);
    expect(carriesPlan({ type: "agent.status", payload: { plan: [] } })).toBe(false);
    expect(carriesPlan({ type: "agent.partial", payload: { plan } })).toBe(false);
    expect(workPlanSessionLabel(running)).toBe("독 시안 정리 · 실행 중");
    // 이름이 비면 도구 이름을 쓴다.
    expect(workPlanSessionLabel(session({ label: "   ", tool: "codex", status: "ended" }))).toBe(
      "codex · 종료됨"
    );
  });
});

describe("문장은 사전을 거친다", () => {
  const live = workPlanProgress(PLAN, true);
  const stopped = workPlanProgress(PLAN, false);
  const finished = workPlanProgress(
    PLAN.map((item) => ({ ...item, status: "completed" as const })),
    false
  );

  it("단추 이름·제목은 두 언어로, 한정 문장은 필요한 때만, 단계 낱말은 색에만 기대지 않는다", () => {
    if (live === null || stopped === null || finished === null) throw new Error("fixture");
    // 한국어는 「4단계 중 2단계」, 영어는 「2 of 4」.
    const ko2 = workPlanCopy(live, { maybeStale: false }, copyKo);
    expect(ko2.button).toBe("계획 4단계 중 2단계 완료");
    expect(ko2.title).toBe("계획 · 4단계 중 2단계");
    const en2 = workPlanCopy(live, { maybeStale: false }, copyEn);
    expect(en2.button).toBe("Plan, 2 of 4 steps done");
    expect(en2.title).toBe("Plan · 2 of 4");

    // 다 끝나면 제목이 「모두 마쳤어요」이고, 멈춘 세션이어도 「돌고 있지 않아요」를 붙이지 않는다.
    const done = workPlanCopy(finished, { maybeStale: false }, copyKo);
    expect(done.title).toBe("계획 · 모두 마쳤어요");
    expect(done.button).toBe("계획 4단계 모두 완료");
    expect(done.notes).toEqual([]);

    // 한정 문장: 멈춘 세션의 미완 계획과 길어서 못 읽었을 수 있는 계획만 말한다.
    expect(ko2.notes).toEqual([]);
    expect(workPlanCopy(stopped, { maybeStale: false }, copyKo).notes).toEqual([
      "지금은 돌고 있지 않아요. 마지막으로 알린 계획이에요.",
    ]);
    expect(workPlanCopy(live, { maybeStale: true }, copyKo).notes).toEqual([
      "기록이 길어서 마지막 계획이 아닐 수 있어요.",
    ]);

    expect(live.steps.map((step) => workPlanStepWord(step, copyKo))).toEqual([
      "완료",
      "완료",
      "지금 단계",
      "대기",
    ]);
  });
});
