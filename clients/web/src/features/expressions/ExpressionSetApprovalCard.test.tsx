// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createExpressionFixtureServer } from "@momo/core/features/expressions/fixtureServer";
import { FIXTURE_CHANNEL_ID, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { recommendExpressionKind } from "@momo/core/features/expressions/kind";
import { EXPRESSION_SET_ACTION_ID, type ExpressionSetApproval } from "@momo/core/features/expressions/set";
import {
  FIXTURE_SET_APPROVAL_ID, FIXTURE_SET_NORMAL, FIXTURE_SET_REFERENCE_IDS, FIXTURE_SET_REFUSED, FIXTURE_SET_SAME_NAME, FIXTURE_SET_STREAK_CLOSED,
  fixtureSetBytesHeavy, fixtureSetOverLimit,
} from "@momo/core/features/expressions/setFixtures";
import { expressionSetFromProps } from "@momo/core/features/expressions/setWire";
import type { AgentApprovalCard } from "@momo/core/features/timeline/agentCardModel";
import { authedResponse, fetchAttachmentContent } from "@momo/core/lib/api";
import { LocaleContext } from "@/i18n/localeContext";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import { resetAttachmentPreviewsForTest } from "@/features/attachments/content";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";
import { ExpressionStore } from "./ExpressionStore";
import { createExpressionFixtureTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { ExpressionSetApprovalCard } from "./ExpressionSetApprovalCard";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchAttachmentContent: vi.fn(), authedResponse: vi.fn(), fetchRoster: vi.fn().mockResolvedValue([]) }));
// The pictures are not what these tests are about (their own loading is covered next door); a stub that names the draft it was asked for is enough.
vi.mock("./ExpressionImage", () => ({ ExpressionImage: ({ item }: { item: { draftId?: string } }) => <span data-testid="stub-image" data-draft={item.draftId} /> }));

const PNG = () => new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
const send = vi.mocked(authedResponse);
const fetchAttachment = vi.mocked(fetchAttachmentContent);
const BASE = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
// The core fixtures keep a fixed clock; a drawn card reads the real one, so every card is given an hour from now.
const live = (set: ExpressionSetApproval, over: Partial<ExpressionSetApproval> = {}): ExpressionSetApproval => ({ ...set, expiresAtMs: Date.now() + 3_600_000, ...over });

function approvalCard(over: Partial<AgentApprovalCard> = {}): AgentApprovalCard {
  return {
    kind: "approval", approvalId: FIXTURE_SET_APPROVAL_ID, title: "그림 세트 등록 요청", status: "pending", isResumeOffer: false, execution: null,
    action: { id: EXPRESSION_SET_ACTION_ID, rows: [], omittedRows: 0, rationale: null, requiredRole: null }, detail: { rows: [], withheld: 0 }, channelId: FIXTURE_CHANNEL_ID, ...over,
  };
}
const makeStore = () => new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID));
/** The fake server hosts the card's approval; its answers come back the way `authedResponse` hands them over. */
function serve(set: ExpressionSetApproval) {
  const server = createExpressionFixtureServer({ nowMs: Date.now(), sets: [{ approvalId: FIXTURE_SET_APPROVAL_ID, approval: set }] });
  send.mockImplementation(async (path, init) => {
    const response = server.request({ method: "POST", path, body: JSON.parse(String(init?.body)) });
    return { status: response.status, json: () => response.json, text: JSON.stringify(response.json) } as never;
  });
}
const answer = (status: number, json: unknown) => send.mockResolvedValueOnce({ status, json: () => json, text: JSON.stringify(json) } as never);
const sentBody = (call = 0) => JSON.parse(String(send.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;

let korean: Awaited<ReturnType<typeof koreanLocaleForTest>>;
async function mount(set: ExpressionSetApproval | null, options: { card?: AgentApprovalCard; store?: ExpressionStore; result?: Parameters<typeof ExpressionSetApprovalCard>[0]["result"] } = {}) {
  const store = options.store ?? makeStore();
  const tree = (current: ExpressionSetApproval | null) => <LocaleContext.Provider value={korean}><ExpressionsContext.Provider value={store}>
    <ExpressionSetApprovalCard card={options.card ?? approvalCard()} set={current} result={options.result ?? null} />
  </ExpressionsContext.Provider></LocaleContext.Provider>;
  const view = render(tree(set));
  return Object.assign(view, { store, again: (next: ExpressionSetApproval | null) => view.rerender(tree(next)) });
}
type View = Awaited<ReturnType<typeof mount>>;
const tiles = (view: View) => view.getAllByTestId("expression-set-tile") as HTMLButtonElement[];
const pressed = (view: View) => tiles(view).map((tile) => tile.getAttribute("aria-pressed"));
const register = (view: View) => view.getByTestId("expression-set-register") as HTMLButtonElement;
const decline = (view: View) => view.getByTestId("expression-set-decline") as HTMLButtonElement;

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); resetSettledApprovalsForTest(); resetAttachmentPreviewsForTest(); vi.clearAllMocks();
  fetchAttachment.mockResolvedValue(PNG());
  send.mockReset();
  korean = await koreanLocaleForTest();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the set card: a grid the person keeps or leaves, one approval for all of it (L5, L6)", () => {
  it("shows every picture of the default set with its name, all kept, and says the numbers once", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL));
    expect(view.getByRole("grid").getAttribute("aria-label")).toBe("고양이 세트 그림 목록");
    expect(view.getAllByRole("row").map((row) => within(row).getAllByRole("gridcell").length)).toEqual([4, 4, 2]);
    expect(tiles(view)).toHaveLength(10);
    expect(pressed(view)).toEqual(Array(10).fill("true"));
    // L9: one approval reserves up to forty names for good, so the whole name list is on the card (none cut, none folded away).
    for (const slot of FIXTURE_SET_NORMAL.slots) expect(view.getByText(`:${slot.name}:`)).toBeTruthy();
    expect(view.getByTestId("expression-set-summary").textContent).toBe("그림 10개");
    expect(view.getByTestId("expression-set-summary").hasAttribute("data-numeric")).toBe(true);
    expect(register(view).textContent).toBe("10개 등록");
    expect(register(view).disabled).toBe(false);
    // The rights sentence appears once for the set, not once per picture (L6.5); what the agent wrote is labelled as the agent's.
    expect(view.getAllByTestId("expression-set-rights")).toHaveLength(1);
    expect(view.getByTestId("expression-set-rights").textContent).toBe("저장해도 되는 그림인지 확인해 주세요. 고른 그림만 등록돼요.");
    expect(view.getByTestId("expression-set-prompt").textContent).toBe("에이전트가 쓴 설명: 둥근 얼굴의 고양이가 인사하고 기뻐하는 메신저 스티커 세트");
    expect(view.getAllByTestId("stub-image").map((node) => node.getAttribute("data-draft"))).toEqual(FIXTURE_SET_NORMAL.slots.map((slot) => (slot.state === "ready" ? slot.draftId : null)));
  });

  it("lets a picture be left out and put back, and counts what is kept in the one button", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL));
    fireEvent.click(tiles(view)[3]);
    expect(pressed(view)[3]).toBe("false");
    expect(tiles(view)[3].closest("[role=gridcell]")?.getAttribute("aria-selected")).toBe("false");
    expect(register(view).textContent).toBe("9개 등록");
    fireEvent.click(tiles(view)[3]);
    expect(pressed(view)[3]).toBe("true");
    expect(register(view).textContent).toBe("10개 등록");
  });

  it("turns the approval off when nothing is kept, and back on when something is", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL));
    fireEvent.click(view.getByTestId("expression-set-select-all"));
    expect(view.getByTestId("expression-set-select-all").textContent).toBe("전체 선택");
    expect(pressed(view)).toEqual(Array(10).fill("false"));
    expect(register(view).disabled).toBe(true);
    expect(register(view).textContent).toBe("0개 등록");
    fireEvent.click(register(view));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(tiles(view)[0]);
    expect(register(view).disabled).toBe(false);
    expect(register(view).textContent).toBe("1개 등록");
    // The decline stays: not keeping anything is also an answer.
    expect(decline(view).disabled).toBe(false);
  });

  it("sends only what was kept, in one decision, and answers with a numbers-only result line", async () => {
    const set = live(FIXTURE_SET_NORMAL);
    serve(set);
    const view = await mount(set);
    fireEvent.click(tiles(view)[1]);
    fireEvent.click(tiles(view)[9]);
    fireEvent.click(register(view));
    await waitFor(() => expect(view.getByTestId("expression-set-settled").textContent).toBe("8개를 팀 보관함에 저장했어요"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(`${BASE}/approvals/${FIXTURE_SET_APPROVAL_ID}/decision`);
    const body = sentBody();
    expect(body.approve).toBe(true);
    expect(body.approval_id).toBe(FIXTURE_SET_APPROVAL_ID);
    expect(typeof body.client_decision_id).toBe("string");
    expect("expressionChoice" in body).toBe(false);
    const choices = body.expressionChoices as Array<{ draftId: string; revision: string; sha256: string; kind: string }>;
    const kept = set.slots.filter((slot) => slot.index !== 1 && slot.index !== 9);
    expect(choices.map((choice) => choice.draftId)).toEqual(kept.map((slot) => (slot.state === "ready" ? slot.draftId : "")));
    // What the person saw travels as the pin: the large picture's hash and revision, and the kind the server would pick.
    for (const [at, choice] of choices.entries()) {
      const slot = kept[at];
      expect(slot.state === "ready" && choice.sha256 === slot.media.large.sha256 && choice.revision === slot.revision && choice.kind === recommendExpressionKind(slot.media.large)).toBe(true);
    }
    expect(view.queryByTestId("expression-set-grid")).toBeNull();
    expect(view.queryByTestId("expression-set-error")).toBeNull();
  });

  it("applies the kind the person chose to everything kept, and says nothing is chosen while the recommendations differ", async () => {
    const set = live(FIXTURE_SET_NORMAL);
    serve(set);
    const view = await mount(set);
    // The 1-pixel fixture pictures: the eight stills recommend a small emoticon, the two GIFs a large one. Neither side is shown as picked.
    expect(["emoji", "sticker"].map((kind) => (view.getByTestId(`expression-set-kind-${kind}`) as HTMLInputElement).checked)).toEqual([false, false]);
    fireEvent.click(view.getByTestId("expression-set-kind-sticker"));
    expect((view.getByTestId("expression-set-kind-sticker") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(register(view));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const kinds = (sentBody().expressionChoices as Array<{ kind: string }>).map((choice) => choice.kind);
    expect(kinds).toEqual(Array(10).fill("sticker"));
  });

  it("shows the shared recommendation as picked when the kept pictures agree", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL));
    // Keep only the two GIFs (indexes 8 and 9): both recommend the large kind, so that side shows as picked.
    fireEvent.click(view.getByTestId("expression-set-select-all"));
    fireEvent.click(tiles(view)[8]);
    fireEvent.click(tiles(view)[9]);
    expect((view.getByTestId("expression-set-kind-sticker") as HTMLInputElement).checked).toBe(true);
    expect((view.getByTestId("expression-set-kind-emoji") as HTMLInputElement).checked).toBe(false);
    expect(within(tiles(view)[8]).getByText("GIF")).toBeTruthy();
    expect(within(tiles(view)[0]).queryByText("GIF")).toBeNull();
  });

  it("registers what is left when a name was taken in the meantime, and reports only counts", async () => {
    const set = live(FIXTURE_SET_SAME_NAME);
    serve(set);
    const view = await mount(set);
    fireEvent.click(register(view));
    // thumbs_up is in the team library already: the server skips it and registers the other three.
    await waitFor(() => expect(view.getByTestId("expression-set-settled").textContent).toBe("3개를 저장하고 1개는 건너뛰었어요"));
    expect(view.getByTestId("expression-set-settled").textContent).not.toMatch(/thumbs_up/);
  });

  it("declines the whole set with one request that carries no choices", async () => {
    const set = live(FIXTURE_SET_NORMAL);
    serve(set);
    const view = await mount(set);
    fireEvent.click(decline(view));
    await waitFor(() => expect(view.getByTestId("expression-set-settled").textContent).toBe("저장하지 않았어요"));
    const body = sentBody();
    expect(body.approve).toBe(false);
    expect("expressionChoices" in body).toBe(false);
    expect("expressionChoice" in body).toBe(false);
  });
});

describe("grey slots: the same place, nothing to choose, nothing to retry (L7)", () => {
  it("gives a refused, failed, unmade and base-less scene a tile that cannot be kept, with one line saying why", async () => {
    const view = await mount(live(FIXTURE_SET_REFUSED));
    const all = tiles(view);
    expect(all).toHaveLength(10);
    const greyAt = [2, 3, 4, 7, 8];
    for (const at of greyAt) {
      expect(all[at].hasAttribute("data-gray"), `tile ${at}`).toBe(true);
      expect(all[at].getAttribute("aria-disabled"), `tile ${at}`).toBe("true");
      // A grey tile is not a choice at all: no pressed state for a reader to announce, no selected cell.
      expect(all[at].hasAttribute("aria-pressed"), `tile ${at}`).toBe(false);
      expect(all[at].closest("[role=gridcell]")?.hasAttribute("aria-selected"), `tile ${at}`).toBe(false);
    }
    const reasons = ["이 장면은 그림 모델이 만들 수 없다고 했어요", "이 장면은 그림 모델이 만들 수 없다고 했어요", "이 장면은 그림을 만들지 못했어요", "시간이 모자라서 이 장면은 만들지 못했어요", "바탕이 되는 그림이 없어서 움직임을 입히지 못했어요"];
    greyAt.forEach((at, order) => {
      expect(all[at].getAttribute("aria-label")).toBe(`선택할 수 없는 칸, ${reasons[order]}. ${FIXTURE_SET_REFUSED.slots[at].displayName}`);
      expect(within(all[at]).getByText(reasons[order])).toBeTruthy();
    });
    // Kept: the five that exist. Header: numbers only.
    expect(view.getByTestId("expression-set-summary").textContent).toBe("그림 5개 · 만들지 못한 장면 5개");
    expect(register(view).textContent).toBe("5개 등록");
  });

  it("does nothing when a grey tile is pressed, and has no upload or retry anywhere on the card", async () => {
    const view = await mount(live(FIXTURE_SET_REFUSED));
    const before = pressed(view);
    fireEvent.click(tiles(view)[2]);
    fireEvent.click(tiles(view)[8]);
    expect(pressed(view)).toEqual(before);
    expect(register(view).textContent).toBe("5개 등록");
    // Nothing on the card offers a way round a refusal: no file input, and no button or sentence that says upload, retry or try again.
    expect(view.container.querySelector("input[type=file]")).toBeNull();
    const words = view.container.textContent ?? "";
    for (const word of ["다시", "올리", "시도", "바꿔", "다르게"]) expect(words, word).not.toContain(word);
  });

  it("keeps the grey tiles of a closed streak in place too, and counts them as scenes not made", async () => {
    const view = await mount(live(FIXTURE_SET_STREAK_CLOSED));
    expect(view.getByTestId("expression-set-summary").textContent).toBe("그림 3개 · 만들지 못한 장면 7개");
    expect(tiles(view).filter((tile) => tile.hasAttribute("data-gray")).map((tile) => tile.getAttribute("data-index"))).toEqual(["2", "3", "4", "5", "6", "7", "9"]);
  });

  it("can still be declined when nothing was made at all, and offers nothing to register", async () => {
    const nothing = live(FIXTURE_SET_REFUSED, { slots: FIXTURE_SET_REFUSED.slots.map((slot) => ({ index: slot.index, kind: slot.kind, state: "gray" as const, code: "refused" as const, name: slot.name, displayName: slot.displayName, tags: slot.tags })) });
    expect(expressionSetFromProps({ action: { id: EXPRESSION_SET_ACTION_ID, expressionSet: nothing } })).not.toBeNull();
    serve(nothing);
    const view = await mount(nothing);
    expect(tiles(view).every((tile) => tile.hasAttribute("data-gray"))).toBe(true);
    expect(view.getByTestId("expression-set-summary").textContent).toBe("그림 0개 · 만들지 못한 장면 10개");
    expect(register(view).disabled).toBe(true);
    expect(view.queryByTestId("expression-set-kind")).toBeNull();
    fireEvent.click(decline(view));
    await waitFor(() => expect(view.getByTestId("expression-set-settled").textContent).toBe("저장하지 않았어요"));
  });
});

describe("what is never drawn, and what it says instead", () => {
  it("does not draw a set past the limits, and does not offer to register anything of it", async () => {
    for (const bad of [fixtureSetOverLimit(), fixtureSetBytesHeavy()]) {
      cleanup();
      const parsed = expressionSetFromProps({ action: { id: EXPRESSION_SET_ACTION_ID, expressionSet: live(bad) } });
      expect(parsed).toBeNull();
      const view = await mount(parsed);
      expect(view.getByTestId("expression-set-unreadable").textContent).toBe("그림 세트를 읽지 못했어요. 도우미에게 다시 만들어 달라고 해 주세요.");
      expect(view.queryByTestId("expression-set-grid")).toBeNull();
      expect(view.queryByTestId("expression-set-register")).toBeNull();
      expect(decline(view)).toBeTruthy();
    }
  });

  it("does not draw a set that belongs to another workspace", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL, { workspaceId: "00000000-0000-4000-8000-0000000000ff" }));
    expect(view.getByTestId("expression-set-unreadable")).toBeTruthy();
    expect(view.queryByTestId("expression-set-grid")).toBeNull();
  });

  it("shows what the person decided elsewhere without a grid, and a result from the message when there is one", async () => {
    const result = { setId: FIXTURE_SET_NORMAL.setId, registered: [], skipped: [] };
    const view = await mount(live(FIXTURE_SET_NORMAL), { card: approvalCard({ status: "approved" }), result });
    expect(view.getByTestId("expression-set-settled").textContent).toBe("0개를 팀 보관함에 저장했어요");
    expect(view.queryByTestId("expression-set-grid")).toBeNull();
    cleanup();
    const expired = await mount(live(FIXTURE_SET_NORMAL, { expiresAtMs: Date.now() - 1000 }));
    expect(expired.getByTestId("expression-set-settled").textContent).toBe("승인을 기다리다 만료됐어요");
    expect(expired.queryByTestId("expression-set-register")).toBeNull();
  });
});

describe("when the decision does not go through", () => {
  it("keeps the card open and says why for each closed refusal, and sends the same decision again with the same key", async () => {
    const set = live(FIXTURE_SET_NORMAL);
    const view = await mount(set);
    const refusals = [
      ["expression_preview_stale", "그림이 바뀌었어요. 카드를 새로 불러온 뒤 다시 골라 주세요."],
      ["expression_name_reserved", "고른 이름이 모두 이미 쓰이고 있어요. 다른 그림을 골라 주세요."],
      ["expression_quota", "보관함이 가득 차서 저장하지 못했어요."],
    ] as const;
    for (const [code, line] of refusals) {
      answer(409, { status: code, approvalId: FIXTURE_SET_APPROVAL_ID });
      fireEvent.click(register(view));
      await waitFor(() => expect(view.getByTestId("expression-set-error").textContent).toBe(line));
      expect(register(view).disabled).toBe(false);
      expect(view.getByTestId("expression-set-grid")).toBeTruthy();
    }
    const keys = send.mock.calls.map((_, at) => sentBody(at).client_decision_id);
    expect(new Set(keys).size).toBe(1);
  });

  it("says it did not go through when the answer is not a receipt or never arrives, and can be pressed again", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL));
    send.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(register(view));
    await waitFor(() => expect(view.getByTestId("expression-set-error").textContent).toBe("결정하지 못했어요. 권한과 연결을 확인하고 다시 눌러 주세요."));
    answer(500, {});
    fireEvent.click(register(view));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(register(view).disabled).toBe(false));
    expect(view.getByTestId("expression-set-error")).toBeTruthy();
  });

  it("closes the card when the server says it was decided elsewhere", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL));
    answer(409, { status: "rejected", approvalId: FIXTURE_SET_APPROVAL_ID });
    fireEvent.click(register(view));
    await waitFor(() => expect(view.getByTestId("expression-set-settled").textContent).toBe("저장하지 않았어요"));
    expect(view.queryByTestId("expression-set-grid")).toBeNull();
  });

  it("does not let a second press through while the first is being sent", async () => {
    let release: (value: unknown) => void = () => undefined;
    send.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as never);
    const view = await mount(live(FIXTURE_SET_NORMAL));
    fireEvent.click(register(view));
    await waitFor(() => expect(register(view).textContent).toBe("등록 중"));
    fireEvent.click(register(view));
    fireEvent.click(decline(view));
    expect(send).toHaveBeenCalledTimes(1);
    expect(tiles(view).every((tile) => tile.getAttribute("aria-disabled") === "true")).toBe(true);
    await act(async () => { release({ status: 500, json: () => ({}), text: "{}" }); });
    await waitFor(() => expect(register(view).disabled).toBe(false));
  });

  it("holds every button while offline and says so, and asks for nothing from the server", async () => {
    const store = makeStore();
    store.setOffline(true);
    const view = await mount(live(FIXTURE_SET_NORMAL), { store });
    expect(register(view).disabled).toBe(true);
    expect(decline(view).disabled).toBe(true);
    expect(view.getByText("연결되면 다시 시도해 주세요.")).toBeTruthy();
    fireEvent.click(register(view));
    expect(send).not.toHaveBeenCalled();
  });

  it("lets only the person shown approve a set with a face", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL, { subjectMemberId: "00000000-0000-4000-8000-0000000000aa" }));
    expect(register(view).disabled).toBe(true);
    expect(view.getByText("얼굴 당사자만 승인할 수 있어요.")).toBeTruthy();
    expect(decline(view).disabled).toBe(false);
    cleanup();
    const own = await mount(live(FIXTURE_SET_NORMAL, { subjectMemberId: FIXTURE_MEMBER_ID }));
    expect(register(own).disabled).toBe(false);
  });
});

describe("the grid by keyboard and for a reader", () => {
  it("is one tab stop, and the arrows move across and down by the four columns", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL));
    expect(tiles(view).map((tile) => tile.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    act(() => tiles(view)[0].focus());
    const key = (name: string) => fireEvent.keyDown(document.activeElement!, { key: name });
    key("ArrowRight");
    expect(document.activeElement).toBe(tiles(view)[1]);
    key("ArrowDown");
    expect(document.activeElement).toBe(tiles(view)[5]);
    key("ArrowLeft");
    expect(document.activeElement).toBe(tiles(view)[4]);
    key("ArrowUp");
    expect(document.activeElement).toBe(tiles(view)[0]);
    // The edges do not wrap and do not leave the grid.
    key("ArrowLeft");
    key("ArrowUp");
    expect(document.activeElement).toBe(tiles(view)[0]);
    key("End");
    expect(document.activeElement).toBe(tiles(view)[9]);
    key("ArrowDown");
    expect(document.activeElement).toBe(tiles(view)[9]);
    key("Home");
    expect(document.activeElement).toBe(tiles(view)[0]);
    // The one tab stop follows the focus.
    key("ArrowRight");
    expect(tiles(view).map((tile) => tile.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1, -1, -1, -1]);
  });

  it("walks onto a grey tile too, so a reader hears why it cannot be kept", async () => {
    const view = await mount(live(FIXTURE_SET_REFUSED));
    act(() => tiles(view)[1].focus());
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tiles(view)[2]);
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^선택할 수 없는 칸, /);
  });

  it("names a kept tile by its display name and its fixed name", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL));
    expect(tiles(view)[0].getAttribute("aria-label")).toBe("안녕, cat_hello");
    expect(view.getByRole("button", { name: "안녕, cat_hello" })).toBe(tiles(view)[0]);
  });
});

describe("the reference pictures the set was made from", () => {
  it("shows the pictures it came from with their count, opened through the conversation's own route", async () => {
    const view = await mount(live(FIXTURE_SET_NORMAL));
    expect(view.getByText("참고한 그림 2장")).toBeTruthy();
    await waitFor(() => expect(view.getAllByTestId("expression-set-reference").map((node) => node.getAttribute("data-phase"))).toEqual(["0", "0"]));
    expect(fetchAttachment.mock.calls.map((call) => call[2]).sort()).toEqual([...FIXTURE_SET_REFERENCE_IDS].sort());
    expect(fetchAttachment.mock.calls.every((call) => call[0] === FIXTURE_WORKSPACE_ID && call[1] === FIXTURE_CHANNEL_ID)).toBe(true);
  });

  it("has no reference row for a set made from words alone", async () => {
    const view = await mount(live(FIXTURE_SET_SAME_NAME));
    expect(view.queryByTestId("expression-set-source")).toBeNull();
    expect(fetchAttachment).not.toHaveBeenCalled();
  });

  it("asks for nothing while offline and does not call the picture gone", async () => {
    const store = makeStore();
    store.setOffline(true);
    const view = await mount(live(FIXTURE_SET_NORMAL), { store });
    expect(view.getAllByTestId("expression-set-reference").map((node) => node.getAttribute("data-phase"))).toEqual(["2", "2"]);
    expect(fetchAttachment).not.toHaveBeenCalled();
  });
});

describe("a new set replaces the choice of the old one", () => {
  it("goes back to everything kept for a different set, and keeps the choice when the same set is drawn again", async () => {
    const set = live(FIXTURE_SET_NORMAL);
    const view = await mount(set);
    fireEvent.click(tiles(view)[0]);
    view.again(live(FIXTURE_SET_NORMAL, { expiresAtMs: set.expiresAtMs }));
    expect(pressed(view)[0]).toBe("false");
    view.again(live({ ...FIXTURE_SET_SAME_NAME, setId: "00000000-0000-4000-8000-000000000403" }));
    await waitFor(() => expect(pressed(view)).toEqual(["true", "true", "true", "true"]));
  });
});
