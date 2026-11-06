// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import vectors from "../../../../../docs/api/expression-kind.vectors.json";
import { FIXTURE_EXPRESSIONS, FIXTURE_LIST, FIXTURE_MEDIA_SET, FIXTURE_MEMBER_ID, FIXTURE_READY_DRAFT, FIXTURE_WORKSPACE_ID, fixtureManualDraft } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import { EXPRESSION_EMOJI_MAX_EDGE, recommendExpressionKind } from "@momo/core/features/expressions/kind";
import type { Expression, ExpressionDraft, ExpressionKind, ExpressionList, ExpressionMedia } from "@momo/core/features/expressions/types";
import { createLocaleService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";
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

// 종류 이름·설명의 낱말은 owner 2026-11-05(#5330)가 정했다: 화면의 이름은 「이모티콘」 하나이고 종류는 그 크기로 가른다 — `emoji` = 작은 이모티콘,
// `sticker` = 큰 이모티콘(앞 판은 「팀 이모지」·「이모티콘」이라 한 화면에 이름이 둘이었다). 기대값은 사전에서 읽지 않고 **글자로 못 박는다**: 사전에서
// 읽으면 사전이 옛 낱말로 돌아가도 시험이 함께 따라가서 빨개지지 않는다. 같은 키를 폰 초안 단계가 쓰므로 폰 시험(`expressionKind.test.tsx`)이 같은 글자를 못 박는다.
const KIND_WORDS = {
  "ko-KR": {
    labels: ["작은 이모티콘", "큰 이모티콘"],
    hintEmoji: "작은 그림이에요. 글 사이와 반응에 써요. 움직여도 작은 이모티콘이에요.",
    hintSticker: "큰 그림이에요. 크게 보내고, 움직이면 GIF에서 볼 수 있어요.",
    retired: /스티커|팀 GIF|이모지/,
  },
  "en-US": {
    labels: ["Small emoticon", "Large emoticon"],
    hintEmoji: "A small picture. Use it between words and in reactions. It stays a small emoticon even when it moves.",
    hintSticker: "A large picture. It is sent big, and a moving one shows under GIF.",
    retired: /Sticker|Team GIF|Team emoji/,
  },
} as const;
async function appLocale(language: keyof typeof KIND_WORDS): Promise<AppLocale> {
  const context = resolveLocaleContext(language, { languages: [language], timeZone: "Asia/Seoul" });
  const service = createLocaleService({ ...context, catalog: language === "ko-KR" ? await loadMessageCatalog("ko-KR") : undefined });
  return { service, getSnapshot: () => service.context, subscribe: () => () => undefined } as unknown as AppLocale;
}

describe("the kind picker speaks the ADR-0218 §10 words", () => {
  it.each([["ko-KR"], ["en-US"]] as const)("%s: the two options carry the decided names in the core order, the hint follows the choice, and no retired name is on the card", async (language) => {
    const words = KIND_WORDS[language];
    const value = await appLocale(language);
    const view = render(<LocaleContext.Provider value={value}>{wrapper(fixtureStore(), <ExpressionDraftCard draft={movingDraft()} onReplace={() => {}} onApprove={vi.fn()} />)}</LocaleContext.Provider>);
    // The options as a person meets them: in document order, each labelled with the decided name (not only the test id).
    const radios = view.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.getAttribute("data-testid"))).toEqual(["expression-draft-kind-emoji", "expression-draft-kind-sticker"]);
    words.labels.forEach((label, index) => expect(view.getByLabelText(label), label).toBe(radios[index]));
    // A moving picture is recommended as an emoticon; its hint says where a moving one is found. Choosing the other kind changes the hint.
    expect(view.getByTestId("expression-draft-kind-hint").textContent).toBe(words.hintSticker);
    fireEvent.click(radios[0]);
    expect(view.getByTestId("expression-draft-kind-hint").textContent).toBe(words.hintEmoji);
    // The words the planner retired are nowhere on the card: neither as text nor as an accessible name.
    expect(view.container.innerHTML).not.toMatch(words.retired);
  });
});

describe("the team panel's two views do not overlap", () => {
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

  it("puts every registration in exactly one view: the small emoji and the still stickers share the emoticon view, the moving stickers are the GIF view, an older one is a sticker", async () => {
    const store = storeOf(CATALOGUE); await store.refresh();
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    await act(async () => {});
    const seen: Record<string, string[]> = {};
    // The view names are the dictionary's (English in this fixture locale): Emoticon · GIF. The panel opens on the first filled view: the emoticon view.
    seen.emoticon = names(view).sort();
    fireEvent.click(view.getByLabelText("GIF")); seen.gif = names(view).sort();
    expect(seen).toEqual({
      emoticon: ["emoji_moving", "emoji_still", "older_still", "sticker_still"],
      gif: ["older_moving", "sticker_moving"],
    });
    const all = [...seen.emoticon, ...seen.gif];
    expect(all.sort()).toEqual(CATALOGUE.map((item) => item.name).sort());
    expect(new Set(all).size).toBe(CATALOGUE.length);
  });
  it("lets the host name the view: no view picker and no 「우리 팀」 heading of its own, and the view is the one asked for", async () => {
    const store = storeOf(CATALOGUE); await store.refresh();
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" view="gif" onPick={() => {}} />));
    await act(async () => {});
    expect(names(view).sort()).toEqual(["older_moving", "sticker_moving"]);
    expect(view.queryAllByRole("radio")).toHaveLength(0);
    expect(view.container.textContent).not.toContain("우리 팀");
    view.rerender(wrapper(store, <TeamExpressionsPanel purpose="insert" view="emoticon" onPick={() => {}} />));
    expect(names(view).sort()).toEqual(["emoji_moving", "emoji_still", "older_still", "sticker_still"]);
  });
  it("opens on the first filled view, so a team whose pictures are all moving stickers sees them at once; a pick is kept", async () => {
    const store = storeOf([moving("sticker_moving", "sticker")]); await store.refresh();
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    await act(async () => {});
    // The emoticon view is empty and the GIF view is the first with pictures.
    expect(names(view)).toEqual(["sticker_moving"]);
    expect((view.getByLabelText("GIF") as HTMLInputElement).checked).toBe(true);
    expect(view.container.textContent).not.toContain("Nothing in this view yet");
    // Once the person picks a view, that view stays, even an empty one.
    fireEvent.click(view.getByLabelText("Emoticon"));
    expect(names(view)).toEqual([]);
    expect((view.getByLabelText("Emoticon") as HTMLInputElement).checked).toBe(true);
    expect(view.container.textContent).toContain("Nothing in this view yet");
  });
  it("says a view is empty, not that the team has no pictures, when only another view has some", async () => {
    const store = storeOf([still("only_emoji", "emoji")]); await store.refresh();
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    await act(async () => {});
    expect(names(view)).toEqual(["only_emoji"]);
    fireEvent.click(view.getByLabelText("GIF"));
    expect(names(view)).toEqual([]);
    expect(view.container.textContent).toContain("Nothing in this view yet");
    expect(view.container.textContent).not.toContain("아직 팀 그림이 없어요");
    const none = storeOf([]); await none.refresh();
    cleanup();
    const bare = render(wrapper(none, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    await act(async () => {});
    expect(bare.container.textContent).toContain("아직 팀 그림이 없어요");
  });

  // 패널의 두 보기 이름은 폰 시트의 탭 이름(owner 10-31, #4942 → 11-05 #5330)과 같은 체계이고, 카드의 두 종류 이름은 그 이름 앞에 「작은/큰」을 붙인 말이다.
  // 보기의 값이 곧 코어의 보기 이름(`emoticon`·`gif`)이라 값마다 이름 하나다. 기대값은 사전에서 읽지 않고 글자로 못 박는다.
  const VIEW_WORDS = {
    "ko-KR": { names: ["이모티콘", "GIF"], legend: "팀 표현 보기", retired: /스티커|팀 GIF|이모지/, oldName: "팀 이모지", kinds: ["작은 이모티콘", "큰 이모티콘"] },
    "en-US": { names: ["Emoticon", "GIF"], legend: "Team expression views", retired: /Sticker|Team GIF|Team emoji/, oldName: "Team emoji", kinds: ["Small emoticon", "Large emoticon"] },
  } as const;
  it.each([["ko-KR"], ["en-US"]] as const)("%s: the two views are named like the phone's tabs and the card's kinds, and the group is named in the same language", async (language) => {
    const words = VIEW_WORDS[language];
    const locale = await appLocale(language);
    const store = storeOf(CATALOGUE); await store.refresh();
    const panel = render(<LocaleContext.Provider value={locale}>{wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />)}</LocaleContext.Provider>);
    await act(async () => {});
    const inPanel = within(panel.container);
    const radios = inPanel.getAllByRole("radio") as HTMLInputElement[];
    // One name per view, in the panel's order, and each name labels exactly that view's input.
    expect(radios.map((radio) => radio.value)).toEqual(["emoticon", "gif"]);
    words.names.forEach((name, index) => expect(inPanel.getByLabelText(name), name).toBe(radios[index]));
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([...words.names]);
    // The group has a name in the same language (it was a Korean literal in every language before).
    expect(inPanel.getByRole("group", { name: words.legend })).toBe(radios[0].closest("fieldset"));
    // The names the owner retired are gone: neither as a label nor anywhere in the markup.
    expect(inPanel.queryByLabelText(words.oldName)).toBeNull();
    expect(panel.container.innerHTML).not.toMatch(words.retired);
    // The card's two kinds are that name with a size in front (the card is mounted in the same language).
    const card = render(<LocaleContext.Provider value={locale}>{wrapper(fixtureStore(), <ExpressionDraftCard draft={movingDraft()} onReplace={() => {}} onApprove={vi.fn()} />)}</LocaleContext.Provider>);
    const kindNames = within(card.container).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent);
    expect(kindNames).toEqual([...words.kinds]);
    // The sheet's tabs are a different word from the views (owner 11-06, #5427): the first tab says where the pictures come from (Team), the view that lists them says what they are (Emoticon). The GIF view is still the GIF tab.
    const t = locale.service.formatMessage;
    expect(t("expressions.sheet.tabEmoticon")).toBe(language === "ko-KR" ? "우리 팀" : "Team");
    expect(words.names[0]).not.toBe(t("expressions.sheet.tabEmoticon"));
    expect(words.names[1]).toBe(t("expressions.sheet.tabGif"));
    expect(words.kinds[0].endsWith(words.names[0].toLowerCase())).toBe(true);
    expect(words.kinds[1].endsWith(words.names[0].toLowerCase())).toBe(true);
  });
});
