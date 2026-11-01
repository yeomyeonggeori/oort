// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import vectors from "../../../../../docs/api/expression-kind.vectors.json";
import { FIXTURE_EXPRESSIONS, FIXTURE_LIST, FIXTURE_MEDIA_SET, FIXTURE_MEMBER_ID, FIXTURE_READY_DRAFT, FIXTURE_WORKSPACE_ID, fixtureManualDraft } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import { EXPRESSION_EMOJI_MAX_EDGE, recommendExpressionKind } from "@momo/core/features/expressions/kind";
import type { Expression, ExpressionDraft, ExpressionKind, ExpressionList, ExpressionMedia } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "./ExpressionStore";
import type { ExpressionTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { ExpressionDraftCard } from "./ExpressionDraftCard";
import { TeamExpressionsPanel } from "./TeamExpressionsPanel";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchRoster: vi.fn().mockResolvedValue([]), authedResponse: vi.fn() }));

// ADR-0218 증보 4 §10 (#4961). 서버(Rust)와 같은 사례 표를 읽는다: 코어 패키지는 자기 밖의 파일을 읽을 수 없어서(purity
// 게이트) 두 구현을 한 표에 묶는 시험은 웹 쪽에 있다.

const wrapper = (store: ExpressionStore, content: React.ReactNode) => <ExpressionsContext.Provider value={store}>{content}</ExpressionsContext.Provider>;
const png = FIXTURE_MEDIA.png.image;
const STILL_MEDIA: ExpressionMedia = { small: { ...png }, large: { ...png }, thumb: { ...png } };
// The fixture drafts carry a fixed clock (FIXTURE_NOW_MS); a card judges expiry by the real one, so a draft shown here is made live.
const live = (draft: ExpressionDraft): ExpressionDraft => ({ ...draft, expiresAtMs: Date.now() + 3_600_000 });
const stillDraft = (media: ExpressionMedia = STILL_MEDIA): ExpressionDraft => live({ ...FIXTURE_READY_DRAFT, state: "ready", code: null, media });
const movingDraft = (): ExpressionDraft => live(FIXTURE_READY_DRAFT);
// A draft made by hand is not one the fixture server holds, so its pictures are answered here: any path is a picture.
const fixtureStore = () => new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, { json: async () => { throw new Error("no request expected"); }, image: async () => "data:image/png;base64,AA==" });

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the kind recommendation shared with the server", () => {
  it("answers every case of docs/api/expression-kind.vectors.json the way the server does", () => {
    expect(EXPRESSION_EMOJI_MAX_EDGE).toBe(vectors.emojiMaxEdge);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(8);
    for (const row of vectors.cases) expect(recommendExpressionKind(row), row.name).toBe(row.kind);
    // The table must hold both sides of each flip, or a changed rule could still pass.
    expect(new Set(vectors.cases.map((row) => row.kind))).toEqual(new Set(["emoji", "sticker"]));
    expect(vectors.cases.some((row) => row.width === 128 && row.frameCount === 1)).toBe(true);
    expect(vectors.cases.some((row) => Math.max(row.width, row.height) === 129 && row.frameCount === 1)).toBe(true);
    expect(vectors.cases.some((row) => Math.max(row.width, row.height) <= 128 && row.frameCount > 1)).toBe(true);
  });
});

describe("the draft card chooses the kind at registration", () => {
  async function ready(view: ReturnType<typeof render>) {
    fireEvent.click(view.getByRole("checkbox"));
    const button = view.getByRole("button", { name: "팀 보관함에 등록" }) as HTMLButtonElement;
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    fireEvent.load(view.container.querySelector("img")!);
    await waitFor(() => expect(button.disabled).toBe(false));
    return button;
  }
  const checked = (view: ReturnType<typeof render>) => (["emoji", "sticker"] as const).filter((kind) => (view.getByTestId(`expression-draft-kind-${kind}`) as HTMLInputElement).checked);

  it("pre-selects the recommendation for the picture, says it picked it, and sends it", async () => {
    for (const [draft, want] of [[stillDraft(), "emoji"], [movingDraft(), "sticker"]] as const) {
      cleanup();
      const approve = vi.fn().mockResolvedValue(undefined);
      const view = render(wrapper(fixtureStore(), <ExpressionDraftCard draft={draft} onReplace={() => {}} onApprove={approve} />));
      expect(checked(view), `${draft.media?.large.mime}`).toEqual([want]);
      expect(view.getByTestId("expression-draft-kind-auto")).toBeTruthy();
      const button = await ready(view);
      fireEvent.click(button); await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
      expect(approve.mock.calls[0][0]).toEqual({ draftId: draft.draftId, revision: draft.revision, sha256: draft.media!.large.sha256, kind: want });
    }
  });
  it("sends the kind the person picked instead, and stops saying it picked one", async () => {
    const approve = vi.fn().mockResolvedValue(undefined);
    const view = render(wrapper(fixtureStore(), <ExpressionDraftCard draft={movingDraft()} onReplace={() => {}} onApprove={approve} />));
    expect(checked(view)).toEqual(["sticker"]);
    fireEvent.click(view.getByTestId("expression-draft-kind-emoji"));
    expect(checked(view)).toEqual(["emoji"]);
    expect(view.queryByTestId("expression-draft-kind-auto")).toBeNull();
    const hint = view.getByTestId("expression-draft-kind-hint").textContent;
    fireEvent.click(view.getByTestId("expression-draft-kind-sticker"));
    expect(view.getByTestId("expression-draft-kind-hint").textContent).not.toBe(hint);
    fireEvent.click(view.getByTestId("expression-draft-kind-emoji"));
    const button = await ready(view);
    fireEvent.click(button); await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve.mock.calls[0][0].kind).toBe("emoji");
  });
  it("does not carry a choice over to a new picture: the pick belongs to the picture it was made on", async () => {
    const approve = vi.fn().mockResolvedValue(undefined);
    const store = fixtureStore();
    const view = render(wrapper(store, <ExpressionDraftCard draft={stillDraft()} onReplace={() => {}} onApprove={approve} />));
    fireEvent.click(view.getByTestId("expression-draft-kind-sticker"));
    expect(checked(view)).toEqual(["sticker"]);
    const other = stillDraft({ ...STILL_MEDIA, large: { ...png, sha256: "c".repeat(64) } });
    view.rerender(wrapper(store, <ExpressionDraftCard draft={{ ...other, revision: "2" }} onReplace={() => {}} onApprove={approve} />));
    expect(checked(view)).toEqual(["emoji"]);
    expect(view.getByTestId("expression-draft-kind-auto")).toBeTruthy();
  });
  it("offers no kind where there is no picture to register", () => {
    const view = render(wrapper(fixtureStore(), <ExpressionDraftCard draft={live(fixtureManualDraft())} onReplace={() => {}} onApprove={vi.fn()} />));
    expect(view.queryByTestId("expression-draft-kind")).toBeNull();
    expect(view.queryByTestId("expression-draft-kind-hint")).toBeNull();
  });
});

describe("the team panel's three views do not overlap", () => {
  let serial = 40;
  const still = (name: string, kind: ExpressionKind | undefined): Expression => {
    const made = { ...FIXTURE_EXPRESSIONS[1], id: `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`, name, displayName: name, tags: [], kind, media: STILL_MEDIA } as Expression;
    if (kind === undefined) delete made.kind;
    return made;
  };
  const moving = (name: string, kind: ExpressionKind | undefined): Expression => ({ ...still(name, kind), media: FIXTURE_MEDIA_SET });
  const CATALOGUE = [still("emoji_still", "emoji"), moving("emoji_moving", "emoji"), still("sticker_still", "sticker"), moving("sticker_moving", "sticker"), still("older_still", undefined), moving("older_moving", undefined)];
  function storeOf(items: Expression[]) {
    const list: ExpressionList = { ...FIXTURE_LIST, version: "9", items };
    const transport: ExpressionTransport = { json: async () => list, image: async () => "data:image/png;base64,AA==" };
    const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
    return store;
  }
  const names = (view: ReturnType<typeof render>) => Array.from(view.container.querySelectorAll("ul[aria-label='팀 표현 목록'] li button[aria-label$='메시지에 넣기']")).map((button) => (button.getAttribute("aria-label") ?? "").replace(" 메시지에 넣기", ""));

  it("puts every registration in exactly one view: emoji by kind, sticker split by motion, an older one as a sticker", async () => {
    const store = storeOf(CATALOGUE); await store.refresh();
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    await act(async () => {});
    const seen: Record<string, string[]> = {};
    seen.emoji = names(view).sort();
    fireEvent.click(view.getByLabelText("스티커")); seen.sticker = names(view).sort();
    fireEvent.click(view.getByLabelText("팀 GIF")); seen.gif = names(view).sort();
    expect(seen).toEqual({
      emoji: ["emoji_moving", "emoji_still"],
      sticker: ["older_still", "sticker_still"],
      gif: ["older_moving", "sticker_moving"],
    });
    const all = [...seen.emoji, ...seen.sticker, ...seen.gif];
    expect(all.sort()).toEqual(CATALOGUE.map((item) => item.name).sort());
    expect(new Set(all).size).toBe(CATALOGUE.length);
  });
  it("opens on the first filled view, so a team whose pictures all pre-date the kind sees them at once; a pick is kept", async () => {
    const store = storeOf([still("older_still", undefined), moving("older_moving", undefined)]); await store.refresh();
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    await act(async () => {});
    // Every earlier registration is a sticker, so the team-emoji view is empty and the sticker view is the first with pictures.
    expect(names(view)).toEqual(["older_still"]);
    expect((view.getByLabelText("스티커") as HTMLInputElement).checked).toBe(true);
    expect(view.container.textContent).not.toContain("Nothing in this view yet");
    // Once the person picks a view, that view stays, even an empty one.
    fireEvent.click(view.getByLabelText("이모지"));
    expect(names(view)).toEqual([]);
    expect((view.getByLabelText("이모지") as HTMLInputElement).checked).toBe(true);
    expect(view.container.textContent).toContain("Nothing in this view yet");
  });
  it("says a view is empty, not that the team has no pictures, when only another view has some", async () => {
    const store = storeOf([still("only_emoji", "emoji")]); await store.refresh();
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    await act(async () => {});
    expect(names(view)).toEqual(["only_emoji"]);
    fireEvent.click(view.getByLabelText("스티커"));
    expect(names(view)).toEqual([]);
    expect(view.container.textContent).toContain("Nothing in this view yet");
    expect(view.container.textContent).not.toContain("아직 팀 그림이 없어요");
    const none = storeOf([]); await none.refresh();
    cleanup();
    const bare = render(wrapper(none, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    await act(async () => {});
    expect(bare.container.textContent).toContain("아직 팀 그림이 없어요");
  });
});
