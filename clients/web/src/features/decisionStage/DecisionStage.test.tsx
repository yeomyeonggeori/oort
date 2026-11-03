// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApprovalCard } from "@momo/core/features/timeline/agentCardModel";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import { STAGE_HERO_WINDOW_MS } from "@/design/motion";
import { resetSettledApprovalsForTest, settledApprovalFor } from "@/features/timeline/settledApprovals";
import { DecisionStageHost } from "./DecisionStage";
import { closeDecisionStage, decisionStageSnapshot, openDecisionStage, type DecisionStageRequest } from "./openDecisionStage";

// 이 설정은 CSS 가져오기를 빈 값으로 바꾼다(`?raw`도 빈 문자열). 무대 CSS 규칙을 계산에 올리려면 파일을 읽는다.
// jsdom 의 URL 은 node:fs 가 받지 않으므로 경로 문자열로 푼다.
const stageCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "DecisionStage.css"), "utf8");

const session = vi.hoisted(() => ({ workspaceId: "workspace-stage", connStatus: "connected" }));
const transport = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock("@/app/session", () => ({ useSession: () => session }));
vi.mock("@momo/core/features/timeline/approvalDecision", async (original) => ({
  ...await original<typeof import("@momo/core/features/timeline/approvalDecision")>(),
  decideApproval: transport.decide,
}));

let reduce = true;
let opener: HTMLButtonElement;
let motions: Array<{ node: HTMLElement; frames: Keyframe[]; finish: () => void }>;
function approval(id: string, patch: Partial<AgentApprovalCard> = {}): AgentApprovalCard {
  return {
    kind: "approval", approvalId: id, title: `${id} 채널 안내 고정`, status: "pending",
    requestedByMemberId: "agent-stage", isResumeOffer: false, execution: null,
    expiresAtMs: Date.now() + 23 * 3_600_000, isReversible: true,
    summary: "새 팀원이 안내를 바로 찾을 수 있어요",
    action: {
      id: "channel.pin", rows: [{ label: "채널", value: "출시 준비" }], omittedRows: 0,
      rationale: "안내를 대화 위에 두려고 해요", requiredRole: "admin",
    },
    detail: { rows: [{ label: "영향", value: "채널 위에 안내가 보여요" }], withheld: 1 },
    bundle: { canDecide: true, actionType: "workspace_action" }, ...patch,
  };
}
function request(patch: Partial<DecisionStageRequest> = {}): DecisionStageRequest {
  return {
    workspaceId: session.workspaceId,
    cards: ["첫째", "둘째"].map((id) => ({ id, card: approval(id) })),
    context: { viewerKind: "human", viewerMemberId: "reviewer-stage", canDecide: true },
    opener, ...patch,
  };
}
function open(patch: Partial<DecisionStageRequest> = {}) {
  render(<DecisionStageHost />);
  let controller!: ReturnType<typeof openDecisionStage>;
  act(() => { controller = openDecisionStage(request(patch)); });
  return controller;
}
const stage = () => screen.queryByTestId("decision-stage");
const dragArea = () => screen.getByTestId("decision-stage-drag");
const advance = (amount = STAGE_HERO_WINDOW_MS) => act(() => { vi.advanceTimersByTime(amount); });
async function clickDecision(approve = true) {
  await act(async () => { fireEvent.click(screen.getByTestId(approve ? "decision-stage-approve" : "decision-stage-reject")); });
}
function pointer(type: string, node: HTMLElement, x: number, y: number, time: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true }, timeStamp: { value: time + 100 } });
  fireEvent(node, event);
}
function drag(x: number, y: number, elapsed = 500) {
  const node = dragArea();
  pointer("pointerdown", node, 0, 0, 0);
  pointer("pointermove", node, x, y, elapsed);
  pointer("pointerup", node, x, y, elapsed + 1);
}
async function finishHero() {
  await act(async () => { motions.splice(0).forEach((motion) => motion.finish()); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T06:00:00Z"));
  session.workspaceId = "workspace-stage";
  session.connStatus = "connected";
  reduce = true;
  motions = [];
  transport.decide.mockReset().mockResolvedValue({ kind: "committed", status: "approved" });
  resetSettledApprovalsForTest();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") && reduce,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  opener = document.createElement("button");
  opener.textContent = "요청 보기";
  document.body.append(opener);
  opener.focus();
});
afterEach(() => {
  const snapshot = decisionStageSnapshot();
  if (snapshot) act(() => closeDecisionStage(snapshot.ticket));
  cleanup();
  opener.remove();
  document.querySelectorAll(".stage-hero-layer").forEach((node) => node.remove());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

describe("decision stage", () => {
  it("renders public facts, collapsed details, keyboard navigation and returns focus on Escape", () => {
    open();
    expect(stage()?.dataset.stagePhase).toBe("open");
    expect(screen.getByText("2건 중 1번")).toBeTruthy();
    expect(screen.getByText("23시간 남음")).toBeTruthy();
    expect(screen.getByText("왜")).toBeTruthy();
    expect(screen.getAllByText("안내를 대화 위에 두려고 해요")).toHaveLength(2);
    expect(screen.getByText("생각 줄 · 자세히").closest("details")?.open).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "첫째 채널 안내 고정" }));
    fireEvent.keyDown(stage()!, { key: "ArrowRight" });
    expect(screen.getByText("2건 중 2번")).toBeTruthy();
    expect(document.activeElement?.classList.contains("focus-visible:focus-ring")).toBe(true);
    const reject = screen.getByRole("button", { name: "거부" });
    reject.focus();
    fireEvent.keyDown(reject, { key: "Tab", shiftKey: true });
    expect(stage()?.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(stage()!, { key: "Escape" });
    advance(1);
    expect(stage()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(transport.decide).not.toHaveBeenCalled();
  });

  it("only buttons decide, locks duplicate sends/navigation, then checks, advances and completes", async () => {
    let resolve!: (outcome: DecisionOutcome) => void;
    transport.decide.mockImplementationOnce(() => new Promise<DecisionOutcome>((done) => { resolve = done; }));
    open();
    await clickDecision();
    await clickDecision();
    fireEvent.keyDown(stage()!, { key: "ArrowRight" });
    expect(screen.getByText("2건 중 1번")).toBeTruthy();
    expect(transport.decide).toHaveBeenCalledTimes(1);
    expect(transport.decide.mock.calls[0].slice(0, 3)).toEqual(["workspace-stage", "첫째", true]);
    await act(async () => resolve({ kind: "committed", status: "approved" }));
    expect(screen.getByText("승인했어요")).toBeTruthy();
    expect(settledApprovalFor("첫째")?.status).toBe("approved");
    advance();
    expect(screen.getByText("2건 중 2번")).toBeTruthy();
    transport.decide.mockResolvedValueOnce({ kind: "committed", status: "rejected" });
    await clickDecision(false);
    expect(screen.getByText("거부했어요")).toBeTruthy();
    advance();
    expect(screen.getByText("모두 처리했어요")).toBeTruthy();
    advance();
    expect(stage()).toBeNull();
    expect(transport.decide).toHaveBeenCalledTimes(2);
  });

  it("swipes only browse or dismiss, restores short drags, and ignores foreign pointers", () => {
    open();
    drag(0, 99);
    expect(stage()).toBeTruthy();
    drag(-61, 4);
    expect(screen.getByText("2건 중 2번")).toBeTruthy();
    drag(61, 4);
    expect(screen.getByText("2건 중 1번")).toBeTruthy();
    const node = dragArea();
    pointer("pointerdown", node, 0, 0, 0);
    pointer("pointerup", node, 0, 200, 100, 2);
    expect(stage()).toBeTruthy();
    pointer("pointercancel", node, 0, 200, 101);
    expect(stage()).toBeTruthy();
    drag(0, 100);
    expect(stage()).toBeNull();
    expect(transport.decide).not.toHaveBeenCalled();
  });

  it("accepts a fast vertical flick, but never interprets it as approval", () => {
    open();
    drag(0, 20, 20);
    expect(transport.decide).not.toHaveBeenCalled();
    expect(stage()).toBeNull();
  });

  it("restores a paused flick or cancelled drag without swallowing the next button click", async () => {
    open();
    const node = dragArea();
    pointer("pointerdown", node, 0, 0, 0);
    pointer("pointermove", node, 0, 30, 20);
    pointer("pointerup", node, 0, 30, 250);
    expect(stage()).toBeTruthy();
    pointer("pointerdown", node, 0, 0, 300);
    pointer("pointermove", node, 0, 120, 400);
    pointer("pointercancel", node, 0, 120, 401);
    await clickDecision();
    expect(transport.decide).toHaveBeenCalledOnce();
  });

  it("says only the remaining time on the stage: the 「자세히」 of the timeline card is a toggle and the stage has no such toggle there (#4986)", () => {
    open();
    expect(screen.getByTestId("decision-stage-remaining").textContent).toBe("23시간 남음");
    // 누를 수 있는 「자세히」는 무대에 하나다: 「생각 줄 · 자세히」 펼침. 그 밖에 「자세히」로 끝나는 글자가 없다.
    const stageEl = stage()!;
    const withDetail = [...stageEl.querySelectorAll("*")].filter((node) => node.children.length === 0 && /자세히/.test(node.textContent ?? ""));
    expect(withDetail.map((node) => node.tagName + ":" + node.textContent)).toEqual(["SUMMARY:생각 줄 · 자세히"]);
    // 기한을 모르는 카드는 줄 자체가 없다.
    act(() => closeDecisionStage(decisionStageSnapshot()!.ticket));
    open({ cards: [{ id: "무기한", card: approval("무기한", { expiresAtMs: undefined }) }] });
    expect(screen.queryByTestId("decision-stage-remaining")).toBeNull();
  });

  it("names the dialog for screen readers without drawing a pill that reads as a button (#4986)", () => {
    open();
    const title = screen.getByText("결정 보기");
    expect(title.classList.contains("sr-only")).toBe(true);
    expect(title.classList.contains("glass")).toBe(false);
    expect(title.classList.contains("rounded-full")).toBe(false);
    expect(screen.getByRole("dialog", { name: "결정 보기" })).toBeTruthy();
    // 유리 알약은 눌리는 단추의 문법이다: 헤더의 알약은 닫기 하나뿐이다.
    const header = stage()!.querySelector("header")!;
    expect([...header.querySelectorAll(".glass")].map((node) => node.getAttribute("aria-label"))).toEqual(["결정 무대 닫기"]);
  });

  it("marks the current thumbnail with a fill, not with the ring the focus ring also uses (#4986)", () => {
    const style = document.createElement("style");
    style.textContent = stageCss;
    document.head.append(style);
    try {
      open();
      const thumbs = screen.getByRole("group", { name: "결정 썸네일" }).querySelectorAll<HTMLElement>(".decision-stage-thumbnail");
      expect(thumbs).toHaveLength(2);
      const [now, other] = [thumbs[0]!, thumbs[1]!];
      expect(now.getAttribute("aria-current")).toBe("true");
      expect(other.getAttribute("aria-current")).toBeNull();
      // 집의 포커스 링은 신호색 안쪽 윤곽 2px이다: 같은 모양을 「지금」 표시로 쓰지 않는다.
      expect(now.className).not.toMatch(/\bring-/);
      // 선택은 채움이다. jsdom은 `.glass`(토큰 CSS)를 모르므로 이 규칙만 계산에 든다.
      expect(getComputedStyle(now).backgroundColor).toBe("var(--accent-soft)");
      expect(getComputedStyle(other).backgroundColor).not.toBe("var(--accent-soft)");
      // 선택이 옮겨 가면 채움도 따라간다.
      fireEvent.keyDown(stage()!, { key: "ArrowRight" });
      const after = screen.getByRole("group", { name: "결정 썸네일" }).querySelectorAll<HTMLElement>(".decision-stage-thumbnail");
      expect(getComputedStyle(after[0]!).backgroundColor).not.toBe("var(--accent-soft)");
      expect(getComputedStyle(after[1]!).backgroundColor).toBe("var(--accent-soft)");
    } finally { style.remove(); }
  });

  it("dims an arrow that has nowhere to go, and only that arrow (#4986)", () => {
    const style = document.createElement("style");
    style.textContent = stageCss;
    document.head.append(style);
    try {
      open();
      const previous = screen.getByRole("button", { name: "이전 결정" });
      const next = screen.getByRole("button", { name: "다음 결정" });
      // 첫 장: 이전은 끝, 다음은 갈 곳이 있다.
      expect(previous.getAttribute("aria-disabled")).toBe("true");
      expect(getComputedStyle(previous).opacity).toBe("0.5");
      expect(getComputedStyle(previous).pointerEvents).toBe("none");
      expect(next.getAttribute("aria-disabled")).toBeNull();
      expect(getComputedStyle(next).opacity).toBe("");
      // 마지막 장: 반대로 바뀐다.
      fireEvent.click(next);
      expect(next.getAttribute("aria-disabled")).toBe("true");
      expect(getComputedStyle(next).opacity).toBe("0.5");
      expect(previous.getAttribute("aria-disabled")).toBeNull();
      expect(getComputedStyle(previous).opacity).toBe("");
      // 비활성 모양이어도 초점은 받는다(aria-disabled 문법): 키보드 사용자가 길을 잃지 않는다.
      next.focus();
      expect(document.activeElement).toBe(next);
    } finally { style.remove(); }
  });

  it("does not stand arrows and 「0건」 where there is nothing to step through (#4986)", () => {
    const controller = open({ cards: [], loading: true });
    expect(screen.queryByRole("navigation", { name: "결정 넘겨 보기" })).toBeNull();
    expect(screen.queryByText("0건")).toBeNull();
    act(() => controller.update({ loading: false }));
    expect(screen.queryByRole("navigation", { name: "결정 넘겨 보기" })).toBeNull();
    act(() => controller.update({ error: "목록을 읽지 못했어요. 다시 불러 주세요." }));
    expect(screen.queryByRole("button", { name: "이전 결정" })).toBeNull();
    act(() => controller.update({ cards: request().cards, error: null }));
    expect(screen.getByRole("navigation", { name: "결정 넘겨 보기" })).toBeTruthy();
    expect(screen.getByText("2건 중 1번")).toBeTruthy();
  });

  it("has loading, empty, error, retry and cached offline states", () => {
    const retry = vi.fn();
    const controller = open({ cards: [], loading: true, onRetry: retry });
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(4);
    act(() => controller.update({ loading: false }));
    expect(screen.getByText("지금 살펴볼 결정이 없어요.")).toBeTruthy();
    act(() => controller.update({ error: "목록을 읽지 못했어요. 다시 불러 주세요." }));
    fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    expect(retry).toHaveBeenCalledOnce();
    session.connStatus = "disconnected";
    act(() => controller.update({ cards: request().cards, error: null }));
    expect(screen.getByTestId("decision-stage-offline")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "첫째 채널 안내 고정" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
    expect(transport.decide).not.toHaveBeenCalled();
  });

  it("keeps failed decisions retryable with the same idempotency key and no false checkmark", async () => {
    transport.decide.mockResolvedValueOnce({ kind: "error", errorCopy: "연결을 확인하고 다시 눌러 주세요." });
    open();
    await clickDecision();
    expect(screen.getByRole("alert").textContent).toContain("연결을 확인");
    expect(screen.queryByText("승인했어요")).toBeNull();
    await clickDecision();
    expect(transport.decide.mock.calls[0][3]).toBe(transport.decide.mock.calls[1][3]);
    expect(transport.decide.mock.calls[0][3]).toEqual(expect.any(String));
    advance();
    expect(screen.getByText("2건 중 2번")).toBeTruthy();
  });

  it("does not celebrate or advance a missing receipt, and follows a competing decision's status", async () => {
    transport.decide.mockResolvedValueOnce({ kind: "committed" });
    open();
    await clickDecision();
    advance(STAGE_HERO_WINDOW_MS * 3);
    expect(screen.getByText("결정 상태를 확인하지 못했어요. 닫고 다시 열어 주세요.")).toBeTruthy();
    expect(screen.queryByText("승인했어요")).toBeNull();
    expect(screen.getByText("2건 중 1번")).toBeTruthy();
    transport.decide.mockResolvedValueOnce({ kind: "superseded", status: "rejected", note: "다른 곳에서 이미 결정됐어요." });
    await clickDecision();
    expect(screen.getByText("다른 곳에서 이미 결정됐어요.")).toBeTruthy();
    expect(screen.queryByText("승인했어요")).toBeNull();
    advance();
    expect(screen.getByText("2건 중 2번")).toBeTruthy();
  });

  it("reads permission and expiry from the bundle, and closes on workspace changes", () => {
    const controller = open();
    const props = request();
    act(() => controller.update({ context: { ...props.context, canDecide: false } }));
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
    expect(screen.getByText("관리자의 승인을 기다려요")).toBeTruthy();
    act(() => controller.update({
      context: props.context,
      cards: [{ id: "첫째", card: approval("첫째", { expiresAtMs: Date.now() + 30_000 }) }],
    }));
    expect(screen.getByRole("button", { name: "승인" })).toBeTruthy();
    advance(30_000);
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
    session.workspaceId = "another-workspace";
    act(() => controller.update({ error: null }));
    expect(stage()).toBeNull();
    expect(transport.decide).not.toHaveBeenCalled();
  });

  it("holds one-time results in the visible instance, never in the opener store or receipt cache", async () => {
    transport.decide.mockResolvedValueOnce({
      kind: "committed", status: "approved",
      result: { actionId: "workspace.invite.create", ref: null, secretOnce: { kind: "invite_link", value: "https://oort.invalid/invite/stage-only", expiresAtMs: null } },
    });
    open();
    await clickDecision();
    advance(STAGE_HERO_WINDOW_MS * 4);
    expect(screen.getByText("https://oort.invalid/invite/stage-only")).toBeTruthy();
    expect(screen.getByText("2건 중 1번")).toBeTruthy();
    expect(JSON.stringify(decisionStageSnapshot())).not.toContain("stage-only");
    expect(JSON.stringify(settledApprovalFor("첫째"))).not.toContain("stage-only");
    fireEvent.click(screen.getByRole("button", { name: "다음 결정 보기" }));
    expect(screen.queryByText("https://oort.invalid/invite/stage-only")).toBeNull();
    expect(screen.getByText("2건 중 2번")).toBeTruthy();
  });

  it("reduces entry and exit to immediate changes even when WAAPI is available", () => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 100, width: 512, height: 360,
      left: 100, top: 100, right: 612, bottom: 460, toJSON: () => ({}),
    });
    open({ source: () => opener });
    expect(stage()?.dataset.stagePhase).toBe("open");
    expect(animate).not.toHaveBeenCalled();
    drag(0, 99);
    expect(animate.mock.calls.every(([, options]) => options.duration === 0)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "결정 무대 닫기" }));
    // A browser's synthetic click after the drag is swallowed before the next real click.
    if (stage()) fireEvent.click(screen.getByRole("button", { name: "결정 무대 닫기" }));
    expect(stage()).toBeNull();
    expect(animate.mock.calls.every(([, options]) => options.duration === 0)).toBe(true);
  });

  it("ignores updates and close requests from an earlier opener", () => {
    const previous = open();
    act(() => { openDecisionStage(request({ selectedId: "둘째" })); });
    act(() => { previous.close(); previous.update({ cards: [], error: "오래된 요청" }); });
    expect(screen.getByText("2건 중 2번")).toBeTruthy();
    expect(screen.queryByText("오래된 요청")).toBeNull();
  });

  it("uses S1 hero geometry on entry and resolves the current card's origin on exit", async () => {
    reduce = false;
    const secondSource = document.createElement("button");
    document.body.append(secondSource);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      const box = this === opener ? { x: 30, y: 120, width: 150, height: 40 } :
        this === secondSource ? { x: 200, y: 120, width: 150, height: 40 } :
        { x: 240, y: 160, width: 512, height: 360 };
      return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box };
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: vi.fn(function(this: HTMLElement, frames: Keyframe[]) {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      motions.push({ node: this, frames, finish });
      return { finished, cancel: vi.fn() };
    }) });
    open({ source: (id) => id === "첫째" ? opener : secondSource });
    const entry = motions.find((motion) => motion.node.classList.contains("stage-hero"))!;
    expect(entry.frames[0]).toMatchObject({ left: "30px", top: "120px", width: "150px" });
    expect(entry.frames.at(-1)).toMatchObject({ left: "240px", width: "512px" });
    expect(entry.node.hasAttribute("inert")).toBe(true);
    await finishHero();
    fireEvent.keyDown(stage()!, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "결정 무대 닫기" }));
    expect(stage()).toBeNull();
    const exit = motions.find((motion) => motion.node.classList.contains("stage-hero"))!;
    expect(exit.frames.at(-1)).toMatchObject({ left: "200px", top: "120px", width: "150px" });
    expect(document.querySelector<HTMLElement>(".stage-hero-layer")?.inert).toBe(true);
    await finishHero();
    expect(document.querySelector(".stage-hero-layer")).toBeNull();
    secondSource.remove();
  });
});
