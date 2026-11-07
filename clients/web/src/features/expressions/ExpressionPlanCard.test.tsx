// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { FIXTURE_CHANNEL_ID, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { expressionSetReferenceNotice, type ExpressionSetPlanCard } from "@momo/core/features/expressions/set";
import { EXPRESSION_SET_COPY } from "@momo/core/features/expressions/setCopy";
import {
  FIXTURE_SET_APPROVAL_ID, FIXTURE_SET_PLAN_CARD, FIXTURE_SET_PLAN_CARD_ONE, FIXTURE_SET_PLAN_CARD_SEEN, FIXTURE_SET_PLAN_CARD_WORDS, FIXTURE_SET_REFERENCE_IDS, fixtureSetPlanCard,
} from "@momo/core/features/expressions/setFixtures";
import { EXPRESSION_SET_PLAN_ACTION_ID, expressionSetPlanFromProps } from "@momo/core/features/expressions/setWire";
import type { AgentApprovalCard } from "@momo/core/features/timeline/agentCardModel";
import { authedResponse, fetchAttachmentContent } from "@momo/core/lib/api";
import { LocaleContext } from "@/i18n/localeContext";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import { resetAttachmentPreviewsForTest } from "@/features/attachments/content";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";
import { ExpressionStore } from "./ExpressionStore";
import { createExpressionFixtureTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { ExpressionPlanCard } from "./ExpressionPlanCard";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchAttachmentContent: vi.fn(), authedResponse: vi.fn(), fetchRoster: vi.fn().mockResolvedValue([]) }));

const PNG = () => new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
const send = vi.mocked(authedResponse);
const fetchAttachment = vi.mocked(fetchAttachmentContent);
const BASE = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
const live = (plan: ExpressionSetPlanCard, over: Partial<ExpressionSetPlanCard> = {}): ExpressionSetPlanCard => ({ ...plan, expiresAtMs: Date.now() + 3_600_000, ...over });

function approvalCard(over: Partial<AgentApprovalCard> = {}): AgentApprovalCard {
  return {
    kind: "approval", approvalId: FIXTURE_SET_APPROVAL_ID, title: "세트 계획", status: "pending", isResumeOffer: false, execution: null,
    action: { id: EXPRESSION_SET_PLAN_ACTION_ID, rows: [], omittedRows: 0, rationale: null, requiredRole: null }, detail: { rows: [], withheld: 0 }, channelId: FIXTURE_CHANNEL_ID, ...over,
  };
}
const makeStore = () => new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID));
/** The plan card has no host in the fake server yet (the carrier is the server slice's to fix), so its answers are written by hand. */
const answer = (status: number, json: unknown) => send.mockResolvedValueOnce({ status, json: () => json, text: JSON.stringify(json) } as never);
const accepted = () => answer(200, { status: "approved", approvalId: FIXTURE_SET_APPROVAL_ID });
const sentBody = (call = 0) => JSON.parse(String(send.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;

let korean: Awaited<ReturnType<typeof koreanLocaleForTest>>;
async function mount(plan: ExpressionSetPlanCard | null, options: { card?: AgentApprovalCard; store?: ExpressionStore } = {}) {
  const store = options.store ?? makeStore();
  const view = render(<LocaleContext.Provider value={korean}><ExpressionsContext.Provider value={store}>
    <ExpressionPlanCard card={options.card ?? approvalCard()} plan={plan} />
  </ExpressionsContext.Provider></LocaleContext.Provider>);
  return Object.assign(view, { store });
}
type View = Awaited<ReturnType<typeof mount>>;
const confirm = (view: View) => view.getByTestId("expression-plan-confirm") as HTMLButtonElement;
const revise = (view: View) => view.getByTestId("expression-plan-revise") as HTMLButtonElement;
const cancel = (view: View) => view.getByTestId("expression-plan-cancel") as HTMLButtonElement;
const text = (view: View, id: string) => view.getByTestId(id).textContent;

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); resetSettledApprovalsForTest(); resetAttachmentPreviewsForTest(); vi.clearAllMocks();
  fetchAttachment.mockResolvedValue(PNG());
  send.mockReset();
  korean = await koreanLocaleForTest();
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); });

describe("the plan card: what will be made, and what would be sent, before anything is (L2.5)", () => {
  it("shows the concept, one line per scene, how many pictures, and the three buttons", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    expect(view.getByRole("region", { name: "고양이 세트 계획" })).toBeTruthy();
    expect(text(view, "expression-plan-concept")).toBe("둥근 얼굴의 고양이가 인사하고 기뻐하는 메신저 스티커 세트");
    const scenes = view.getAllByTestId("expression-plan-scene").map((node) => node.textContent);
    expect(scenes).toHaveLength(10);
    expect(scenes[0]).toBe("안녕 손을 흔들며 활짝 웃는 고양이, 굵은 글씨 '안녕'");
    // A GIF names the still it moves and how (the base's display name, then the motion), and carries no scene text of its own.
    expect(scenes[8]).toBe("안녕 통통 바탕: 안녕, 움직임: 통통");
    expect(scenes[9]).toBe("다 했어요 흔들 바탕: 다 했어요, 움직임: 흔들흔들");
    expect(text(view, "expression-plan-pictures")).toBe("만들 그림 10장");
    expect(view.getByTestId("expression-plan-pictures").hasAttribute("data-numeric")).toBe(true);
    expect([confirm(view), revise(view), cancel(view)].map((button) => button.textContent)).toEqual(["이대로 만들기", "장면 고치기", "취소"]);
    expect([confirm(view), revise(view), cancel(view)].every((button) => !button.disabled)).toBe(true);
  });

  it("on the member's first set with pictures: the thumbnails and count, the no-face declaration, and the one-time notice in the words of the core", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    expect(text(view, "expression-plan-references-line")).toBe("보낼 참조 그림 2장");
    await waitFor(() => expect(view.getAllByTestId("expression-set-reference").map((node) => node.getAttribute("data-phase"))).toEqual(["0", "0"]));
    expect(fetchAttachment.mock.calls.map((call) => call[2]).sort()).toEqual([...FIXTURE_SET_REFERENCE_IDS].sort());
    expect(text(view, "expression-plan-declare")).toBe(EXPRESSION_SET_COPY["expressions.set.reference.declare"].ko);
    const notice = view.getByTestId("expression-plan-notice");
    expect(notice.querySelectorAll("p")).toHaveLength(2);
    expect(notice.querySelectorAll("p")[0].textContent).toBe("첨부한 그림이 Hermes의 그림 모델로 전송돼요");
    expect(notice.querySelectorAll("p")[0].textContent).toBe(expressionSetReferenceNotice());
    expect(notice.querySelectorAll("p")[1].textContent).toBe(EXPRESSION_SET_COPY["expressions.set.reference.kept"].ko);
  });

  it("with one reference picture the count, the declaration and the notice all still show (R2-M1)", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD_ONE));
    expect(text(view, "expression-plan-references-line")).toBe("보낼 참조 그림 1장");
    expect(view.getAllByTestId("expression-set-reference")).toHaveLength(1);
    expect(view.getByTestId("expression-plan-declare")).toBeTruthy();
    expect(view.getByTestId("expression-plan-notice")).toBeTruthy();
  });

  it("on the member's next set: the pictures and the declaration again, but not the notice they have seen", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD_SEEN));
    expect(view.getByTestId("expression-plan-declare")).toBeTruthy();
    expect(view.getAllByTestId("expression-set-reference")).toHaveLength(2);
    expect(view.queryByTestId("expression-plan-notice")).toBeNull();
  });

  it("for a set made from words alone: no pictures, no declaration, no notice, and nothing is read from any conversation", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD_WORDS));
    expect(view.queryByTestId("expression-plan-references")).toBeNull();
    expect(view.queryByTestId("expression-plan-declare")).toBeNull();
    expect(view.queryByTestId("expression-plan-notice")).toBeNull();
    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(text(view, "expression-plan-pictures")).toBe("만들 그림 10장");
  });
});

describe("the three buttons: nothing leaves before the first one", () => {
  it("sends nothing at all while the card is only looked at, opened for editing or closed again", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    fireEvent.click(revise(view));
    fireEvent.click(view.getByTestId("expression-plan-edit-back"));
    expect(send).not.toHaveBeenCalled();
  });

  it("makes it with one approval that carries nothing else, and says it started", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    accepted();
    fireEvent.click(confirm(view));
    await waitFor(() => expect(text(view, "expression-plan-settled")).toBe("만들기를 시작했어요"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(`${BASE}/approvals/${FIXTURE_SET_APPROVAL_ID}/decision`);
    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(["approval_id", "approve", "client_decision_id"]);
    expect(body.approve).toBe(true);
    expect(view.queryByTestId("expression-plan-confirm")).toBeNull();
  });

  it("cancels with one rejection that carries nothing else, and says the plan is closed", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    answer(200, { status: "rejected", approvalId: FIXTURE_SET_APPROVAL_ID });
    fireEvent.click(cancel(view));
    await waitFor(() => expect(text(view, "expression-plan-settled")).toBe("이 계획은 닫혔어요"));
    expect(Object.keys(sentBody()).sort()).toEqual(["approval_id", "approve", "client_decision_id"]);
    expect(sentBody().approve).toBe(false);
  });

  it("does not take a second press while the first is out, and holds every button offline", async () => {
    let release: (value: unknown) => void = () => undefined;
    send.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as never);
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    fireEvent.click(confirm(view));
    fireEvent.click(confirm(view));
    fireEvent.click(cancel(view));
    expect(send).toHaveBeenCalledTimes(1);
    release({ status: 200, json: () => ({ status: "approved" }), text: "{}" });
    await waitFor(() => expect(text(view, "expression-plan-settled")).toBe("만들기를 시작했어요"));
    cleanup(); resetSettledApprovalsForTest();
    const store = makeStore();
    store.setOffline(true);
    const offline = await mount(live(FIXTURE_SET_PLAN_CARD), { store });
    expect([confirm(offline), revise(offline), cancel(offline)].every((button) => button.disabled)).toBe(true);
    expect(offline.getByText("연결되면 다시 시도해 주세요.")).toBeTruthy();
  });

  it("keeps the card open and can be pressed again after a failure, with the same key", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    answer(409, { status: "expression_preview_stale" });
    fireEvent.click(confirm(view));
    await waitFor(() => expect(text(view, "expression-plan-error")).toBe("그림이 바뀌었어요. 카드를 새로 불러온 뒤 다시 골라 주세요."));
    expect(confirm(view).disabled).toBe(false);
    answer(500, {});
    fireEvent.click(confirm(view));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(sentBody(0).client_decision_id).toBe(sentBody(1).client_decision_id);
  });
});

describe("editing the scenes: a new plan, and pictures can only be taken out (L2.5)", () => {
  it("offers a way out for every picture, a row for every scene, and no way to add a picture", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    fireEvent.click(revise(view));
    expect(view.getAllByTestId("expression-set-reference-remove")).toHaveLength(2);
    expect(view.getAllByTestId("expression-plan-edit-slot")).toHaveLength(10);
    // Eight stills have a scene to rewrite; the two GIFs have none (they move a still).
    expect(view.getAllByTestId("expression-plan-edit-scene")).toHaveLength(8);
    expect(view.container.querySelector("input[type=file]")).toBeNull();
    expect(view.queryByTestId("expression-plan-confirm")).toBeNull();
  });

  it("sends the scenes taken out, the pictures taken out and the texts changed, as a rejection that asks for a new plan", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    fireEvent.click(revise(view));
    // Take out the first picture; drop still 0 (which GIF 8 moves, so GIF 8 goes with it); rewrite the scene of still 1 and the name of still 2.
    fireEvent.click(view.getAllByTestId("expression-set-reference-remove")[0]);
    expect(view.getAllByTestId("expression-set-reference")).toHaveLength(1);
    const slots = view.getAllByTestId("expression-plan-edit-slot");
    fireEvent.click(slots[0].querySelector("[data-testid=expression-plan-edit-include]")!);
    const gif = slots[8].querySelector("[data-testid=expression-plan-edit-include]") as HTMLInputElement;
    expect(gif.checked).toBe(false);
    expect(gif.disabled).toBe(true);
    fireEvent.change(slots[1].querySelector("[data-testid=expression-plan-edit-scene]")!, { target: { value: "  두 손을 흔드는 고양이  " } });
    fireEvent.change(slots[2].querySelector("[data-testid=expression-plan-edit-name]")!, { target: { value: "미안" } });
    accepted();
    fireEvent.click(view.getByTestId("expression-plan-edit-submit"));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      approve: false, approval_id: FIXTURE_SET_APPROVAL_ID,
      planRevision: {
        setId: FIXTURE_SET_PLAN_CARD.setId, removeSlots: [0, 8], removeReferences: [FIXTURE_SET_REFERENCE_IDS[0]],
        edits: [{ index: 1, scene: "두 손을 흔드는 고양이" }, { index: 2, displayName: "미안" }],
      },
    });
    await waitFor(() => expect(text(view, "expression-plan-settled")).toBe("이 계획은 닫혔어요"));
  });

  it("will not ask for a plan that has no scene left, no name or no words for a scene", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    fireEvent.click(revise(view));
    const submit = () => view.getByTestId("expression-plan-edit-submit") as HTMLButtonElement;
    expect(submit().disabled).toBe(false);
    const slots = view.getAllByTestId("expression-plan-edit-slot");
    fireEvent.change(slots[3].querySelector("[data-testid=expression-plan-edit-scene]")!, { target: { value: "   " } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(slots[3].querySelector("[data-testid=expression-plan-edit-scene]")!, { target: { value: "좋아요를 외치는 고양이" } });
    expect(submit().disabled).toBe(false);
    fireEvent.change(slots[4].querySelector("[data-testid=expression-plan-edit-name]")!, { target: { value: "" } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(slots[4].querySelector("[data-testid=expression-plan-edit-name]")!, { target: { value: "나중" } });
    for (const slot of slots) {
      const box = slot.querySelector("[data-testid=expression-plan-edit-include]") as HTMLInputElement;
      if (box.checked && !box.disabled) fireEvent.click(box);
    }
    expect(submit().disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("goes back to the plan as it was when the editing is left", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD));
    fireEvent.click(revise(view));
    fireEvent.click(view.getAllByTestId("expression-set-reference-remove")[1]);
    fireEvent.click(view.getByTestId("expression-plan-edit-back"));
    expect(view.getAllByTestId("expression-plan-scene")).toHaveLength(10);
    expect(view.getAllByTestId("expression-set-reference")).toHaveLength(2);
    fireEvent.click(revise(view));
    expect(view.getAllByTestId("expression-set-reference")).toHaveLength(2);
  });
});

describe("a card that is no longer asking", () => {
  it("says it expired when its window has passed, without any button", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD, { expiresAtMs: Date.now() - 1000 }));
    expect(text(view, "expression-plan-settled")).toBe("승인을 기다리다 만료됐어요");
    expect(view.queryByTestId("expression-plan-confirm")).toBeNull();
  });

  it("follows the plan's own state when the message was rewritten after the decision", async () => {
    for (const [state, line] of [["confirmed", "만들기를 시작했어요"], ["cancelled", "이 계획은 닫혔어요"], ["expired", "승인을 기다리다 만료됐어요"]] as const) {
      cleanup();
      const view = await mount(live(FIXTURE_SET_PLAN_CARD, { state }));
      expect(text(view, "expression-plan-settled"), state).toBe(line);
      expect(view.queryByTestId("expression-plan-confirm")).toBeNull();
    }
  });

  it("closes on what the screen itself just decided, even before the message is rewritten", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD), { card: approvalCard({ status: "approved" }) });
    expect(text(view, "expression-plan-settled")).toBe("만들기를 시작했어요");
  });

  it("does not draw a plan that cannot be read, and still lets it be cancelled", async () => {
    const broken = fixtureSetPlanCard({ slots: fixtureSetPlanCard().slots.filter((slot) => slot.index !== 0) });
    const parsed = expressionSetPlanFromProps({ action: { id: EXPRESSION_SET_PLAN_ACTION_ID, expressionSetPlan: live(broken) } });
    expect(parsed).toBeNull();
    const view = await mount(parsed);
    expect(text(view, "expression-plan-unreadable")).toBe("그림 세트를 읽지 못했어요. 도우미에게 다시 만들어 달라고 해 주세요.");
    expect(view.queryByTestId("expression-plan-confirm")).toBeNull();
    answer(200, { status: "rejected" });
    fireEvent.click(cancel(view));
    await waitFor(() => expect(text(view, "expression-plan-settled")).toBe("이 계획은 닫혔어요"));
  });

  it("does not draw a plan of another workspace", async () => {
    const view = await mount(live(FIXTURE_SET_PLAN_CARD, { workspaceId: "00000000-0000-4000-8000-0000000000ff" }));
    expect(view.getByTestId("expression-plan-unreadable")).toBeTruthy();
    expect(view.queryByTestId("expression-plan-confirm")).toBeNull();
  });
});
