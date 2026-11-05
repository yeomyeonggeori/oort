import { describe, expect, it } from "vitest";
import { expressionChoice } from "./cards";
import { FIXTURE_EXPRESSIONS, FIXTURE_MEDIA_SET, FIXTURE_READY_DRAFT, fixtureManualDraft } from "./fixtures";
import { createExpressionFixtureServer } from "./fixtureServer";
import {
  DEFAULT_EXPRESSION_PICKER_TAB,
  EXPRESSION_EMOJI_MAX_EDGE,
  EXPRESSION_PICKER_TABS,
  EXPRESSION_TABS,
  EXPRESSION_VIEW_SHELVES,
  EXPRESSION_VIEWS,
  LEGACY_EXPRESSION_KIND,
  expressionActionOf,
  expressionKindOf,
  expressionShelfOf,
  expressionViewOfPickerTab,
  expressionsForShelves,
  expressionsForTab,
  expressionsForView,
  firstFilledShelf,
  firstFilledView,
  isAnimatedExpression,
  recommendExpressionKind,
  recommendedKindForDraft,
} from "./kind";
import type { Expression, ExpressionImage, ExpressionKind, ExpressionMedia } from "./types";

// ADR-0218 증보 4 §10 (#4961). 추천 규칙의 **정본 사례 표**는 `docs/api/expression-kind.vectors.json`이고
// 서버(Rust)와 웹 시험이 그 파일을 읽는다 — 이 패키지는 자기 밖의 파일을 읽을 수 없어서(purity 게이트)
// 여기서는 같은 경계(128 이하/초과, 움직임)를 직접 적는다.

const still = (width: number, height: number): ExpressionImage => ({ mime: "image/png", sha256: "a".repeat(64), bytes: 10, width, height, frameCount: 1, durationMs: 0 });
const moving = (width: number, height: number, frameCount = 2): ExpressionImage => ({ mime: "image/gif", sha256: "b".repeat(64), bytes: 10, width, height, frameCount, durationMs: 200 });
const mediaOf = (large: ExpressionImage): ExpressionMedia => ({ small: large, large, thumb: still(1, 1) });
/** `kind` undefined = a payload from before the field: the key is absent (the fixture's own kind must not leak in). */
const item = (kind: unknown, large: ExpressionImage | null, name = "x_item"): Expression => {
  const made = {
    ...FIXTURE_EXPRESSIONS[0], id: `00000000-0000-4000-8000-${String(name.length).padStart(12, "0")}`, name,
    kind: kind as ExpressionKind, media: large ? mediaOf(large) : null,
  } as Expression;
  if (kind === undefined) delete made.kind;
  return made;
};

describe("추천 규칙 (J4)", () => {
  it("움직이거나 긴 변이 128보다 크면 sticker, 그 밖은 emoji — 경계의 양쪽을 잰다", () => {
    const rows: Array<[string, ExpressionImage, ExpressionKind]> = [
      ["1x1 정지", still(1, 1), "emoji"],
      ["128x128 정지(경계)", still(128, 128), "emoji"],
      ["128x40 정지(경계)", still(128, 40), "emoji"],
      ["40x128 정지(경계)", still(40, 128), "emoji"],
      ["129x64 정지(가로 한 칸 넘음)", still(129, 64), "sticker"],
      ["64x129 정지(세로 한 칸 넘음)", still(64, 129), "sticker"],
      ["512x512 정지", still(512, 512), "sticker"],
      ["1x1 두 프레임", moving(1, 1, 2), "sticker"],
      ["128x128 스물네 프레임(경계의 움직임)", moving(128, 128, 24), "sticker"],
      ["360x360 움직임", moving(360, 360, 16), "sticker"],
    ];
    for (const [name, large, want] of rows) expect(recommendExpressionKind(large), name).toBe(want);
    expect(EXPRESSION_EMOJI_MAX_EDGE).toBe(128);
  });
  it("초안 카드는 준비된 그림에만 추천을 미리 고른다", () => {
    expect(recommendedKindForDraft(FIXTURE_READY_DRAFT)).toBe("sticker");
    expect(recommendedKindForDraft({ ...FIXTURE_READY_DRAFT, state: "ready" as const, code: null, media: mediaOf(still(8, 4)) })).toBe("emoji");
    expect(recommendedKindForDraft(fixtureManualDraft())).toBeNull();
  });
  it("등록 보내기에는 사람이 고른 종류만 실린다(핀은 그대로)", () => {
    const pin = { draftId: FIXTURE_READY_DRAFT.draftId, revision: FIXTURE_READY_DRAFT.revision, sha256: FIXTURE_MEDIA_SET.large.sha256 };
    expect(expressionChoice(FIXTURE_READY_DRAFT, 0)).toEqual(pin);
    expect(expressionChoice(FIXTURE_READY_DRAFT, 0, "emoji")).toEqual({ ...pin, kind: "emoji" });
    expect(expressionChoice(FIXTURE_READY_DRAFT, 0, "sticker")).toEqual({ ...pin, kind: "sticker" });
  });
});

describe("종류를 읽는 규칙 (J6)", () => {
  it("있으면 그 값, 없거나 모르는 값은 옛 등록과 같은 sticker", () => {
    expect(expressionKindOf({ kind: "emoji" })).toBe("emoji");
    expect(expressionKindOf({ kind: "sticker" })).toBe("sticker");
    expect(expressionKindOf({})).toBe(LEGACY_EXPRESSION_KIND);
    expect(LEGACY_EXPRESSION_KIND).toBe("sticker");
    expect(expressionKindOf({ kind: "huge" as unknown as ExpressionKind })).toBe("sticker");
    expect(expressionKindOf({ kind: null as unknown as ExpressionKind })).toBe("sticker");
  });
  it("움직임은 큰 그림이 GIF인가이고, 그림이 없는 등록은 움직이지 않는다", () => {
    expect(isAnimatedExpression(item("sticker", moving(8, 8)))).toBe(true);
    expect(isAnimatedExpression(item("sticker", still(8, 8)))).toBe(false);
    expect(isAnimatedExpression(item("sticker", null))).toBe(false);
  });
});

describe("네 탭이 겹치지 않는 규칙 (J2)", () => {
  const every = [undefined, "emoji", "sticker", "unknown-future-kind"].flatMap((kind) =>
    [["still", still(8, 8)], ["moving", moving(8, 8)], ["bigstill", still(300, 300)], ["bigmoving", moving(300, 300, 5)]].map(([motion, large]) =>
      item(kind, large as ExpressionImage, `${String(kind ?? "none").replace(/[^a-z]/g, "_")}_${motion as string}`)));
  it("정해진 칸: emoji는 움직여도 팀 이모지, sticker는 움직이면 GIF 아니면 이모티콘", () => {
    const want: Array<[Expression, string]> = [
      [item("emoji", still(8, 8)), "team"],
      [item("emoji", moving(8, 8)), "team"],
      [item("emoji", moving(300, 300)), "team"],
      [item("sticker", still(8, 8)), "emoticon"],
      [item("sticker", still(300, 300)), "emoticon"],
      [item("sticker", moving(8, 8)), "gif"],
      [item("sticker", moving(300, 300)), "gif"],
      // 종류가 없는 옛 등록과 모르는 값은 sticker다.
      [item(undefined, still(8, 8)), "emoticon"],
      [item(undefined, moving(8, 8)), "gif"],
      [item("unknown-future-kind", moving(8, 8)), "gif"],
    ];
    for (const [expression, shelf] of want) expect(expressionShelfOf(expression), `${expression.kind ?? "none"} ${expression.media?.large.mime}`).toBe(shelf);
  });
  it("모든 등록은 이모티콘·팀 이모지·GIF 중 정확히 한 곳에 있다: 합집합은 전체, 교집합은 비어 있다", () => {
    const shelves = ["emoticon", "team", "gif"] as const;
    const placed = shelves.map((tab) => expressionsForTab(every, tab));
    expect(placed.flat().length).toBe(every.length);
    expect(new Set(placed.flat()).size).toBe(every.length);
    for (const original of every) expect(placed.filter((list) => list.includes(original))).toHaveLength(1);
    // 서로 다른 둘씩의 교집합이 비어 있다.
    for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) {
      expect(placed[a].filter((entry) => placed[b].includes(entry))).toEqual([]);
    }
    // 셋 다 비어 있지 않아야 이 시험이 잰다.
    for (const list of placed) expect(list.length).toBeGreaterThan(0);
  });
  it("이모지 탭은 표준 이모지의 자리라 보관함의 등록이 하나도 없다", () => {
    expect(expressionsForTab(every, "emoji")).toEqual([]);
    expect(expressionsForTab([], "emoji")).toEqual([]);
    // 네 탭의 이름과 순서는 폰 시트와 같다.
    expect([...EXPRESSION_TABS]).toEqual(["emoticon", "emoji", "team", "gif"]);
  });
  it("처음 여는 칸은 팀 이모지, 비어 있으면 등록이 있는 첫 칸이다(옛 등록은 모두 sticker라 팀 이모지가 비어 있다)", () => {
    expect(firstFilledShelf([])).toBe("team");
    expect(firstFilledShelf([item("emoji", still(8, 8)), item("sticker", moving(8, 8))])).toBe("team");
    expect(firstFilledShelf([item("sticker", moving(8, 8)), item(undefined, still(8, 8))])).toBe("emoticon");
    expect(firstFilledShelf([item(undefined, moving(8, 8))])).toBe("gif");
    // 지운·숨긴 등록은 세지 않는다.
    expect(firstFilledShelf([{ ...item("emoji", still(8, 8)), status: "hidden" as const, media: null }, item("sticker", moving(8, 8))])).toBe("gif");
    expect(firstFilledShelf([{ ...item("sticker", still(8, 8)), status: "deleted" as const, media: null }])).toBe("team");
  });
  it("차례는 들어온 그대로이고, 거른 등록은 같은 객체다", () => {
    const [first, second] = [item("sticker", still(8, 8), "first_one"), item("sticker", still(8, 8), "second_one")];
    expect(expressionsForTab([second, first], "emoticon")).toEqual([second, first]);
    expect(expressionsForTab([second, first], "emoticon")[0]).toBe(second);
  });
  it("가짜 서버로 등록한 종류가 목록에 그대로 나오고, 말하지 않으면 추천이 나온다", () => {
    const server = createExpressionFixtureServer();
    const base = `/v1/workspaces/${FIXTURE_EXPRESSIONS[0].workspaceId}`;
    const metadata = (name: string) => ({ name, displayName: "그림", tags: [], subjectMemberId: null });
    const register = (name: string, kind?: ExpressionKind) => {
      const draft = server.request({ method: "POST", path: `${base}/expressions/uploads`, body: metadata(name) }).json as { draftId: string; revision: string; media: ExpressionMedia };
      return server.request({ method: "POST", path: `${base}/expressions`, body: { draftId: draft.draftId, revision: draft.revision, sha256: draft.media.large.sha256, ...(kind ? { kind } : {}) } });
    };
    const said = register("fixture_said", "emoji");
    expect(said.status).toBe(201);
    expect((said.json as { expression: Expression }).expression.kind).toBe("emoji");
    // 가짜 서버의 그림은 움직이는 GIF라서 말하지 않으면 sticker다.
    expect((register("fixture_silent").json as { expression: Expression }).expression.kind).toBe("sticker");
    const listed = (server.request({ method: "GET", path: `${base}/expressions` }).json as { items: Expression[] }).items;
    expect(listed.find((entry) => entry.name === "fixture_said")?.kind).toBe("emoji");
    expect(listed.every((entry) => entry.kind === "emoji" || entry.kind === "sticker")).toBe(true);
    // 계약 밖의 값은 400이고(같은 핀에서 종류만 뺀 요청은 등록된다: 400의 까닭은 종류뿐이다), 초안은 남는다.
    const draft = server.request({ method: "POST", path: `${base}/expressions/uploads`, body: metadata("fixture_bad") }).json as { draftId: string; revision: string; media: ExpressionMedia };
    const pin = { draftId: draft.draftId, revision: draft.revision, sha256: draft.media.large.sha256 };
    for (const kind of ["huge", "Emoji", "", null, 1]) {
      expect(server.request({ method: "POST", path: `${base}/expressions`, body: { ...pin, kind } }).status, String(kind)).toBe(400);
    }
    expect(server.request({ method: "POST", path: `${base}/expressions`, body: pin }).status).toBe(201);
  });
});

// owner 2026-11-05(#5330): 사용자에게 보이는 이름은 「이모티콘」 하나다. J2의 네 칸(서버 종류·API·칸의 분류)은 그대로이고, 화면이 팀 이모지 칸과 이모티콘 칸을
// 한 보기 「이모티콘」으로 합친다. 합치는 곳은 코어의 이 몇 줄뿐이고 폰도 웹도 같은 함수를 쓴다.
describe("화면의 두 보기 — 팀 이모지 칸과 이모티콘 칸이 한 보기다 (owner 2026-11-05)", () => {
  const every = [undefined, "emoji", "sticker", "unknown-future-kind"].flatMap((kind) =>
    [["still", still(8, 8)], ["moving", moving(8, 8)], ["bigstill", still(300, 300)], ["bigmoving", moving(300, 300, 5)]].map(([motion, large]) =>
      item(kind, large as ExpressionImage, `${String(kind ?? "none").replace(/[^a-z]/g, "_")}_${motion as string}`)));
  it("보기는 이모티콘(= 팀 이모지 칸 + 이모티콘 칸)과 GIF 둘이다 — 합치는 표는 한 곳", () => {
    expect([...EXPRESSION_VIEWS]).toEqual(["emoticon", "gif"]);
    expect(EXPRESSION_VIEW_SHELVES).toEqual({ emoticon: ["team", "emoticon"], gif: ["gif"] });
  });
  it("모든 등록은 이모티콘·GIF 중 정확히 한 보기에 있다: 합집합은 전체, 교집합은 비어 있고, 각 보기는 J2 칸의 합과 같다", () => {
    const emoticon = expressionsForView(every, "emoticon");
    const gif = expressionsForView(every, "gif");
    expect(emoticon.length + gif.length).toBe(every.length);
    expect(new Set([...emoticon, ...gif]).size).toBe(every.length);
    expect(emoticon.filter((entry) => gif.includes(entry))).toEqual([]);
    // 둘 다 비어 있지 않아야 이 시험이 잰다.
    expect(emoticon.length).toBeGreaterThan(0);
    expect(gif.length).toBeGreaterThan(0);
    // 보기는 J2 칸의 합이다: 이모티콘 = 팀 이모지 칸 ∪ 이모티콘 칸, GIF = GIF 칸(분류 자체는 바뀌지 않았다).
    expect(new Set(emoticon)).toEqual(new Set([...expressionsForTab(every, "team"), ...expressionsForTab(every, "emoticon")]));
    expect(gif).toEqual(expressionsForTab(every, "gif"));
    // 작은 이모티콘(emoji 종류)은 움직여도 이모티콘 보기에 선다.
    expect(emoticon).toContainEqual(item("emoji", moving(8, 8), "emoji_moving"));
  });
  it("여러 칸의 합은 들어온 차례 그대로이고 같은 객체다", () => {
    const [first, second, third] = [item("sticker", still(8, 8), "first_one"), item("emoji", still(8, 8), "second_one"), item("sticker", moving(8, 8), "third_one")];
    const merged = expressionsForShelves([third, second, first], ["team", "emoticon"]);
    expect(merged).toEqual([second, first]);
    expect(merged[0]).toBe(second);
    expect(expressionsForShelves([third, second, first], [])).toEqual([]);
  });
  it("처음 여는 보기는 이모티콘, 거기가 비고 GIF에만 등록이 있으면 GIF다 — 지운·숨긴 등록은 세지 않는다", () => {
    expect(firstFilledView([])).toBe("emoticon");
    expect(firstFilledView([item("emoji", still(8, 8)), item("sticker", moving(8, 8))])).toBe("emoticon");
    expect(firstFilledView([item(undefined, still(8, 8))])).toBe("emoticon");
    expect(firstFilledView([item("sticker", moving(8, 8))])).toBe("gif");
    expect(firstFilledView([{ ...item("emoji", still(8, 8)), status: "hidden" as const, media: null }, item("sticker", moving(8, 8))])).toBe("gif");
    expect(firstFilledView([{ ...item("sticker", still(8, 8)), status: "deleted" as const, media: null }])).toBe("emoticon");
  });
  it("탭은 이모티콘 · 기본 · GIF 이고 처음 여는 탭은 기본이며, 기본(표준 표)은 보관함의 보기가 아니다", () => {
    expect([...EXPRESSION_PICKER_TABS]).toEqual(["emoticon", "emoji", "gif"]);
    expect(DEFAULT_EXPRESSION_PICKER_TAB).toBe("emoji");
    expect(expressionViewOfPickerTab("emoji")).toBeNull();
    expect(expressionViewOfPickerTab("emoticon")).toBe("emoticon");
    expect(expressionViewOfPickerTab("gif")).toBe("gif");
    // 보관함을 보는 탭은 정확히 보기들이다.
    expect(EXPRESSION_PICKER_TABS.flatMap((tab) => expressionViewOfPickerTab(tab) ?? [])).toEqual([...EXPRESSION_VIEWS]);
  });
  it("고른 뒤의 동작은 등록이 선 칸이 정한다: 작은 팀 이모지 칸은 입력칸에 넣고, 이모티콘·GIF 칸은 보낸다 — 한 보기 안에 둘이 함께 선다", () => {
    for (const entry of every) expect(expressionActionOf(entry), `${entry.kind ?? "none"} ${entry.name}`).toBe(expressionShelfOf(entry) === "team" ? "insert" : "send");
    const emoticon = expressionsForView(every, "emoticon").map(expressionActionOf);
    expect(new Set(emoticon)).toEqual(new Set(["insert", "send"]));
    expect(new Set(expressionsForView(every, "gif").map(expressionActionOf))).toEqual(new Set(["send"]));
  });
});
