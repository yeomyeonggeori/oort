// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import { FIXTURE_AI_APPROVAL, FIXTURE_APPROVAL, FIXTURE_MEMBER_ID, FIXTURE_SOURCE_ATTACHMENT_ID, FIXTURE_WORKSPACE_ID, fixtureGeneratedDraft, fixtureManualDraft } from "@momo/core/features/expressions/fixtures";
import type { ExpressionApproval, ExpressionDraft } from "@momo/core/features/expressions/types";
import type { AgentApprovalCard } from "@momo/core/features/timeline/agentCardModel";
import { fetchAttachmentContent } from "@momo/core/lib/api";
import { resetAttachmentPreviewsForTest } from "@/features/attachments/content";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";
import { ExpressionStore } from "./ExpressionStore";
import { createExpressionFixtureTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { ExpressionApprovalCard } from "./ExpressionApprovalCard";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchAttachmentContent: vi.fn(), authedResponse: vi.fn(), fetchRoster: vi.fn().mockResolvedValue([]) }));
// The candidate pictures are not what these tests are about; their own loading is covered next door.
vi.mock("./ExpressionImage", () => ({ ExpressionImage: () => <span data-testid="stub-image" /> }));

// ADR-0218 section 7 G3.8, typed out by hand (the core test pins the golden file to the same table).
const G38 = [
  ["generation_failed", "그림을 만들지 못했어요"],
  ["assembly_source_invalid", "이 그림에는 움직임을 입힐 수 없어요"],
  ["assembly_source_too_large", "그림이 너무 커서 움직임을 입힐 수 없어요"],
  ["assembly_output_too_large", "움직이는 그림이 너무 커요"],
  ["assembly_timeout", "움직임을 입히다가 시간이 다 됐어요"],
  ["assembly_busy", "지금 다른 그림을 처리하고 있어요. 잠시 뒤에 다시 해 주세요"],
] as const;
// Banned words are written in pieces so this file does not contain them either.
const BANNED = [["그", "리기"], ["그", "려"], ["그", "리는"]].map((parts) => parts.join(""));

const CHANNEL_ID = "00000000-0000-4000-8000-000000000004";
const PNG = () => new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
const fetchAttachment = vi.mocked(fetchAttachmentContent);

function makeStore() {
  return new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID));
}
function approvalCard(over: Partial<AgentApprovalCard> = {}): AgentApprovalCard {
  return { kind: "approval", approvalId: "approval", title: "팀 그림 등록 요청", status: "pending", isResumeOffer: false, execution: null, action: { id: "expression.create", rows: [], omittedRows: 0, rationale: null, requiredRole: null }, detail: { rows: [], withheld: 0 }, channelId: CHANNEL_ID, ...over };
}
// The core fixtures keep a fixed clock; a drawn card reads the real one, so give each candidate an hour from now.
const live = (payload: ExpressionApproval): ExpressionApproval => ({ ...payload, candidates: payload.candidates.map((draft) => ({ ...draft, expiresAtMs: Date.now() + 3_600_000 })) });
const tree = (store: ExpressionStore, payload: ExpressionApproval, card: AgentApprovalCard) => <ExpressionsContext.Provider value={store}><ExpressionApprovalCard card={card} payload={live(payload)} result={null} /></ExpressionsContext.Provider>;
function mount(payload: ExpressionApproval, card: AgentApprovalCard = approvalCard(), store: ExpressionStore = makeStore()) {
  const view = render(tree(store, payload, card));
  /** Draw the same card again with new props, as the timeline does on every update. */
  return Object.assign(view, { store, drawAgain: (next: AgentApprovalCard = card) => view.rerender(tree(store, payload, next)) });
}
const source = (view: ReturnType<typeof mount>) => view.queryByTestId("expression-approval-source");
const approval = (...candidates: ExpressionDraft[]): ExpressionApproval => ({ v: 1, candidates });

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); resetSettledApprovalsForTest(); resetAttachmentPreviewsForTest(); vi.clearAllMocks();
  fetchAttachment.mockResolvedValue(PNG());
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the approval card head for an AI-made request", () => {
  it("says how many pictures there are and shows the original photo with a thumbnail", async () => {
    const view = mount(FIXTURE_AI_APPROVAL);
    expect(view.getByTestId("expression-approval-count").textContent).toBe("그림 3장");
    // Design rule: a number carries data-numeric so it sets in tabular figures.
    expect(view.getByTestId("expression-approval-count").hasAttribute("data-numeric")).toBe(true);
    expect(source(view)?.getAttribute("data-state")).toBe("loading");
    expect(view.getByTestId("expression-approval-source-loading")).toBeTruthy();
    await waitFor(() => expect(source(view)?.getAttribute("data-state")).toBe("ready"));
    const thumb = view.getByTestId("expression-approval-source-thumb") as HTMLImageElement;
    expect(thumb.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(thumb.getAttribute("alt")).toBe("");
    expect(source(view)?.textContent).toBe("원본 사진");
    expect(view.queryByTestId("expression-approval-source-loading")).toBeNull();
    // The thumbnail goes through the conversation's own attachment route, once, for the one photo.
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(fetchAttachment.mock.calls[0]).toEqual([FIXTURE_WORKSPACE_ID, CHANNEL_ID, FIXTURE_SOURCE_ATTACHMENT_ID]);
  });
  it("keeps the same thumbnail when the card is drawn again, without asking for the photo twice", async () => {
    const view = mount(FIXTURE_AI_APPROVAL);
    await waitFor(() => expect(source(view)?.getAttribute("data-state")).toBe("ready"));
    const thumb = view.getByTestId("expression-approval-source-thumb");
    const row = source(view);
    view.drawAgain(approvalCard({ title: "팀 그림 등록 요청 2" }));
    view.drawAgain(approvalCard({ title: "팀 그림 등록 요청 3" }));
    expect(view.getByTestId("expression-approval-source-thumb")).toBe(thumb);
    expect(source(view)).toBe(row);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });
  it("does not claim the photo is gone while offline, asks for nothing, and loads it when the connection returns", async () => {
    const store = makeStore();
    store.setOffline(true);
    const view = mount(FIXTURE_AI_APPROVAL, approvalCard(), store);
    expect(source(view)?.getAttribute("data-state")).toBe("offline");
    expect(source(view)?.textContent).toBe("원본 사진");
    expect(view.queryByTestId("expression-approval-source-thumb")).toBeNull();
    expect(view.queryByTestId("expression-approval-source-loading")).toBeNull();
    expect(fetchAttachment).not.toHaveBeenCalled();
    act(() => { store.setOffline(false); });
    await waitFor(() => expect(source(view)?.getAttribute("data-state")).toBe("ready"));
    expect(view.getByTestId("expression-approval-source-thumb")).toBeTruthy();
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });
  it("keeps 원본 사진 없음 for a request made from words alone even offline, since the card itself says so", () => {
    const store = makeStore();
    store.setOffline(true);
    const view = mount(approval(fixtureGeneratedDraft(1, { sourceAttachmentId: null })), approvalCard(), store);
    expect(source(view)?.getAttribute("data-state")).toBe("none");
    expect(source(view)?.textContent).toBe("원본 사진 없음");
  });
  it("asks for the one original once even when four candidates name it", async () => {
    const view = mount(approval(...[1, 2, 3, 4].map((index) => fixtureGeneratedDraft(index))));
    expect(view.getByTestId("expression-approval-count").textContent).toBe("그림 4장");
    await waitFor(() => expect(source(view)?.getAttribute("data-state")).toBe("ready"));
    expect(view.getAllByTestId("expression-approval-source")).toHaveLength(1);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });
  it("says 원본 사진 없음 when the photo is gone, with no thumbnail left behind", async () => {
    fetchAttachment.mockRejectedValue(new Error("gone"));
    const view = mount(FIXTURE_AI_APPROVAL);
    await waitFor(() => expect(source(view)?.getAttribute("data-state")).toBe("missing"));
    expect(source(view)?.textContent).toBe("원본 사진 없음");
    expect(view.queryByTestId("expression-approval-source-thumb")).toBeNull();
    expect(view.queryByTestId("expression-approval-source-loading")).toBeNull();
  });
  it("says 원본 사진 없음 for a request made from words alone, and never asks for a photo", () => {
    const view = mount(approval(fixtureGeneratedDraft(1, { sourceAttachmentId: null }), fixtureGeneratedDraft(2, { sourceAttachmentId: null })));
    expect(source(view)?.getAttribute("data-state")).toBe("none");
    expect(source(view)?.textContent).toBe("원본 사진 없음");
    expect(view.getByTestId("expression-approval-count").textContent).toBe("그림 2장");
    expect(fetchAttachment).not.toHaveBeenCalled();
  });
  it("says 원본 사진 없음 and asks for nothing when the card has no conversation to open it in", () => {
    const view = mount(FIXTURE_AI_APPROVAL, approvalCard({ channelId: undefined as unknown as string }));
    expect(source(view)?.getAttribute("data-state")).toBe("missing");
    expect(source(view)?.textContent).toBe("원본 사진 없음");
    expect(fetchAttachment).not.toHaveBeenCalled();
  });
  it("shows the card as it was when the server does not send the pointer: a count, no source line, no request", () => {
    const old = [1, 2].map((index) => { const draft = fixtureGeneratedDraft(index); const { sourceAttachmentId: _gone, ...origin } = draft.origin; return { ...draft, origin } as ExpressionDraft; });
    const view = mount(approval(...old));
    expect(source(view)).toBeNull();
    expect(view.getByTestId("expression-approval-count").textContent).toBe("그림 2장");
    expect(view.getAllByTestId("expression-draft")).toHaveLength(2);
    expect(fetchAttachment).not.toHaveBeenCalled();
  });
  it("changes nothing on a request that was not made by an AI", () => {
    const view = mount(FIXTURE_APPROVAL);
    expect(view.queryByTestId("expression-approval-head")).toBeNull();
    expect(view.getAllByTestId("expression-draft")).toHaveLength(2);
    expect(view.getByText("후보 중 한 장만 골라 팀 보관함에 등록해요.")).toBeTruthy();
  });
  it("keeps the head off a settled card, where there is nothing left to choose", () => {
    const view = mount(FIXTURE_AI_APPROVAL, approvalCard({ status: "approved", summary: "팀 보관함에 저장했어요" }));
    expect(view.queryByTestId("expression-approval-head")).toBeNull();
    expect(fetchAttachment).not.toHaveBeenCalled();
  });
  it("keeps the head off a card whose candidates belong to another workspace", () => {
    const view = mount(approval({ ...fixtureGeneratedDraft(1), workspaceId: "00000000-0000-4000-8000-0000000000ff" }));
    expect(view.queryByTestId("expression-approval-head")).toBeNull();
    expect(fetchAttachment).not.toHaveBeenCalled();
  });
  it("shows no money, token or limit anywhere in the head", async () => {
    const view = mount(FIXTURE_AI_APPROVAL);
    await waitFor(() => expect(source(view)?.getAttribute("data-state")).toBe("ready"));
    const head = view.getByTestId("expression-approval-head").textContent ?? "";
    expect(head).toBe("그림 3장원본 사진");
    expect(head.match(/\d+/gu)).toEqual(["3"]);
    expect(head).not.toMatch(/[$₩]|\d\s*원|토큰|달러|한도|가격|비용/u);
  });
});

describe("a slot the server could not make", () => {
  it.each(G38)("%s sits in its slot as the table's sentence next to a hand upload", (code, line) => {
    const view = mount(approval(fixtureGeneratedDraft(1), { ...fixtureGeneratedDraft(2), state: "manual_upload_required", code, media: null } as ExpressionDraft));
    const [ready, failed] = view.getAllByTestId("expression-draft");
    expect(failed.getAttribute("data-state")).toBe("manual_upload_required");
    expect(within(failed).getByRole("status").textContent).toBe(line);
    expect(within(failed).getByRole("button", { name: "직접 올리기" })).toBeTruthy();
    expect(within(failed).queryByRole("button", { name: "팀 보관함에 등록" })).toBeNull();
    expect(within(failed).queryByTestId("stub-image")).toBeNull();
    // The picture that did get made stays choosable and says the ordinary sentence.
    expect(ready.getAttribute("data-state")).toBe("ready");
    expect(within(ready).getByRole("status").textContent).toBe("이 그림을 팀 보관함에 저장할까요?");
    expect(view.getByTestId("expression-approval-count").textContent).toBe("그림 1장");
  });
  it("keeps the card standing with a plain sentence for a reason this build has never seen", () => {
    const unknown = { ...fixtureManualDraft(), code: "future_failure" } as unknown as ExpressionDraft;
    const view = mount(approval(fixtureGeneratedDraft(1), unknown));
    const failed = view.getAllByTestId("expression-draft")[1];
    expect(within(failed).getByRole("status").textContent).toBe("그림을 준비하지 못했어요. 직접 올려 주세요.");
    expect(within(failed).getByRole("button", { name: "직접 올리기" })).toBeTruthy();
  });
  it("counts nothing and offers only hand uploads when every slot failed", () => {
    const failed = [1, 2].map((index) => ({ ...fixtureGeneratedDraft(index), state: "manual_upload_required", code: "generation_failed", media: null }) as ExpressionDraft);
    const view = mount(approval(...failed));
    expect(view.queryByTestId("expression-approval-count")).toBeNull();
    expect(view.getAllByRole("button", { name: "직접 올리기" })).toHaveLength(2);
    expect(view.getAllByRole("status").map((node) => node.textContent)).toEqual(["그림을 만들지 못했어요", "그림을 만들지 못했어요"]);
  });
});

describe("문구", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (name: string) => readFileSync(join(here, name), "utf8");
  const core = (name: string) => `../../../../../packages/momo-core/src/features/${name}`;
  it("화면에 선 글자와 이번 칸의 모든 소스에 손으로 그린다는 말이 없어요", async () => {
    const view = mount(FIXTURE_AI_APPROVAL);
    await waitFor(() => expect(source(view)?.getAttribute("data-state")).toBe("ready"));
    const shown = view.container.textContent ?? "";
    expect(shown.length).toBeGreaterThan(40);
    const files = ["ExpressionSourceRow.tsx", "ExpressionApprovalCard.tsx", "ExpressionApprovalCard.test.tsx", core("expressions/cardCopy.ts"), core("expressions/cards.ts"), core("expressions/fixtures.ts"), core("expressions/generatedCards.test.ts"), core("approvals/approvalOutcome.ts"), core("approvals/expression-failure-copy.json")];
    const hits = [shown, ...files.map(read)].flatMap((text, index) => text.length === 0 ? [`empty:${index}`] : BANNED.filter((word) => text.includes(word)).map((word) => `${index}:${word.length}`));
    expect(hits).toEqual([]);
    expect(BANNED.some((word) => ["그림을 ", "그", "려요"].join("").includes(word))).toBe(true);
  });
  it("웹 파일에는 이번 줄의 한국어 문구가 한 글자도 없어요: 문구는 코어 한 곳에서 와요", () => {
    const code = read("ExpressionSourceRow.tsx").replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
    expect(code.length).toBeGreaterThan(400);
    expect(code).not.toMatch(/[ㄱ-ㅎ가-힣]/u);
    // The approval card already had its own sentences; the head added none of them.
    const head = read("ExpressionApprovalCard.tsx").split("\n").filter((line) => /expressionApprovalSummary|head\b|head\./u.test(line)).join("\n");
    expect(head.length).toBeGreaterThan(200);
    expect(head).not.toMatch(/[ㄱ-ㅎ가-힣]/u);
  });
});
