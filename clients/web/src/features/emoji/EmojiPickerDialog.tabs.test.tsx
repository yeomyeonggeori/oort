// @vitest-environment jsdom
import { useState } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import type { Expression, ExpressionMedia } from "@momo/core/features/expressions/types";
import { createLocaleService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import { ExpressionsContext } from "@/features/expressions/context";
import type { ExpressionTransport } from "@/features/expressions/transport";
import { EmojiPickerDialog } from "./EmojiPickerDialog";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchRoster: vi.fn().mockResolvedValue([]), authedResponse: vi.fn() }));

// #5453, owner 2026-11-07: 탭은 이모티콘 · 이모지 · GIF 이고, 우리 팀이 올린 것과 기본을 탭으로 가르지 않는다. 폰 창과 같은 코어 표(`EXPRESSION_TAB_SHELVES`)를 읽는다:
//   이모티콘 = 움직이지 않는 큰 그림 · 이모지 = 표준 표 + 팀의 작은 이모지 · GIF = 움직이는 큰 그림.
// 「이모지」라는 말은 탭 이름에만 선다(보이는 글자와 낭독 이름 모두). 기대값은 사전에서 읽지 않고 글자로 못 박는다.

const STILL: ExpressionMedia = { small: { ...FIXTURE_MEDIA.png.image }, large: { ...FIXTURE_MEDIA.png.image }, thumb: { ...FIXTURE_MEDIA.png.image } };
const at = (n: number) => `00000000-0000-4000-8000-0000000000${n}`;
// 가짜 보관함: 움직이는 팀 이모지(파티 앵무새) · 움직이는 큰 그림 둘(기절·엄지척)은 공용 fixture, 움직이지 않는 큰 그림(건배)과 작은 이모지(작은 웃음)를 더한다.
const CHEERS: Expression = { ...FIXTURE_EXPRESSIONS[1], id: at(51), name: "cheers_still", displayName: "건배", tags: ["축하"], media: STILL };
const TINY_SMILE: Expression = { ...FIXTURE_EXPRESSIONS[0], id: at(52), name: "smile_tiny", displayName: "작은 웃음", tags: ["웃음"], kind: "emoji", media: STILL };
const LIBRARY: Expression[] = [...FIXTURE_EXPRESSIONS, CHEERS, TINY_SMILE];

function libraryTransport(): ExpressionTransport {
  return {
    async json(request) {
      if (request.method === "GET" && /\/expressions(\?|$)/.test(request.path)) {
        return { workspaceId: FIXTURE_WORKSPACE_ID, version: "9", baseVersion: null, reset: true, addPolicy: "members", items: LIBRARY };
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    },
    async image() {
      return `data:image/png;base64,${FIXTURE_MEDIA.png.bodyBase64}`;
    },
  };
}

async function appLocale(language: "ko-KR" | "en-US"): Promise<AppLocale> {
  const context = resolveLocaleContext(language, { languages: [language], timeZone: "Asia/Seoul" });
  const service = createLocaleService({ ...context, catalog: language === "ko-KR" ? await loadMessageCatalog("ko-KR") : undefined });
  return { service, getSnapshot: () => service.context, subscribe: () => () => undefined } as unknown as AppLocale;
}

const onPick = vi.fn();
const onPickExpression = vi.fn();
const onOpenChange = vi.fn();

function Host({ purpose = "insert", withPreview = true }: { purpose?: "insert" | "reaction" | "status"; withPreview?: boolean }) {
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  return <>
    <button type="button" ref={setOpener}>열기</button>
    <EmojiPickerDialog open onOpenChange={onOpenChange} onPick={onPick} opener={opener} anchor={opener} purpose={purpose} testId="picker" {...(withPreview ? { onPickExpression } : {})} />
  </>;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  onPick.mockReset();
  onPickExpression.mockReset();
  onOpenChange.mockReset();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => {}, configurable: true, writable: true });
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(Element.prototype, "scrollIntoView"); });

async function open(language: "ko-KR" | "en-US", options: Parameters<typeof Host>[0] = {}) {
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, libraryTransport());
  await store.refresh();
  const locale = await appLocale(language);
  return render(<LocaleContext.Provider value={locale}><ExpressionsContext.Provider value={store}><Host {...options} /></ExpressionsContext.Provider></LocaleContext.Provider>);
}
/** 팀 보관함의 목록 버튼(이모티콘·GIF 탭)과 이모지 탭의 팀 이모지 줄 버튼이 말하는 이름들. */
const listNames = () => screen.queryAllByRole("button", { name: /메시지에 넣기$/ }).map((button) => (button.getAttribute("aria-label") ?? "").replace(" 메시지에 넣기", "")).sort();
const stripNames = () => within(screen.getByTestId("team-emoji-strip")).getAllByRole("button").map((button) => button.getAttribute("aria-label")).sort();

describe("고르개의 세 탭: 이모티콘 · 이모지 · GIF (#5453)", () => {
  const WORDS = {
    "ko-KR": { group: "표현 종류", tabs: ["이모티콘", "이모지", "GIF"] },
    "en-US": { group: "Kinds", tabs: ["Emoticons", "Emoji", "GIF"] },
  } as const;
  // #5482, planner 결정: 웹·폰 모두 처음 열면 첫 탭은 「이모티콘」이다(앞 판은 이모지였다). 폰 창(`ExpressionKeyboardPanel`)과 같은 코어 상수 하나로 연다.
  it.each([["ko-KR"], ["en-US"]] as const)("%s: 탭은 이모티콘 · 이모지 · GIF 차례이고 처음에는 이모티콘(큰 그림 목록)이 열려 있다", async (language) => {
    await open(language);
    const group = await screen.findByRole("group", { name: WORDS[language].group });
    const tabs = within(group).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual([...WORDS[language].tabs]);
    expect(tabs.map((tab) => tab.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    // 열린 본문도 이모티콘 탭의 것이다: 팀 보관함의 큰 그림 목록이 서고 표준 이모지 표(검색 칸)와 팀 이모지 줄은 없다.
    expect(await screen.findByTestId("team-expressions")).toBeTruthy();
    expect(screen.queryByTestId("emoji-search")).toBeNull();
    expect(screen.queryByTestId("team-emoji-strip")).toBeNull();
  });

  it("각 탭이 모으는 것: 이모티콘 = 움직이지 않는 큰 그림, 이모지 = 표준 표 + 팀의 작은 이모지(움직여도), GIF = 움직이는 큰 그림 — 우리 팀 · 기본 구분이 없다", async () => {
    await open("ko-KR");
    const tabs = within(await screen.findByRole("group", { name: "표현 종류" })).getAllByRole("button");
    // 이모티콘(처음): 움직이지 않는 큰 그림만.
    await screen.findByTestId("team-expressions");
    await waitFor(() => expect(listNames()).toEqual(["건배"]));
    expect(screen.queryByTestId("emoji-search")).toBeNull();
    expect(screen.queryByTestId("team-emoji-strip")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByLabelText("이모티콘 검색")).toBeTruthy();
    // 이모지: 표준 표가 서고, 그 위에 팀의 작은 이모지 둘이 같은 탭에 섞여 선다. 큰 그림은 없다.
    fireEvent.click(tabs[1]);
    await waitFor(() => expect(stripNames()).toEqual(["작은 웃음", "파티 앵무새"]));
    expect(screen.getByTestId("emoji-search")).toBeTruthy();
    expect(listNames()).toEqual([]);
    // GIF: 움직이는 큰 그림 둘 - 움직이는 작은 이모지(파티 앵무새)는 여기가 아니라 이모지 탭이다.
    fireEvent.click(tabs[2]);
    await waitFor(() => expect(listNames()).toEqual(["기절", "엄지척"]));
    expect(screen.getByLabelText("GIF 검색")).toBeTruthy();
    // 이모지로 돌아오면 같은 줄이 다시 선다.
    fireEvent.click(tabs[1]);
    await waitFor(() => expect(stripNames()).toEqual(["작은 웃음", "파티 앵무새"]));
  });

  it("ko-KR: 「이모지」는 탭 이름에만 서고 「우리 팀」 「기본」 탭은 없다 — 모든 탭에서 보이는 글자와 낭독 이름 모두", async () => {
    await open("ko-KR");
    const picker = await screen.findByTestId("picker");
    const names = () => `${Array.from(picker.querySelectorAll("[aria-label],[title],[placeholder]")).map((node) => `${node.getAttribute("aria-label")} ${node.getAttribute("title")} ${node.getAttribute("placeholder")}`).join(" ")} ${picker.getAttribute("aria-label")}`;
    const tabs = within(await screen.findByRole("group", { name: "표현 종류" })).getAllByRole("button");
    for (const tab of [tabs[1], tabs[0], tabs[2], tabs[1]]) {
      fireEvent.click(tab);
      await waitFor(() => expect(picker.querySelector("[data-testid='team-expressions'], [data-testid='emoji-search']")).not.toBeNull());
      // 탭 줄을 걷어 낸 나머지에는 「이모지」가 없다. 탭 줄 안에서는 정확히 그 탭 하나의 이름뿐이다.
      const rest = (picker.textContent ?? "").replace("이모지", "");
      expect(rest).not.toMatch(/이모지/);
      expect(picker.textContent?.split("이모지")).toHaveLength(2);
      const named = names();
      expect(named.split("이모지")).toHaveLength(1);
      // 우리 팀 · 기본으로 가르던 말도 이제 없다.
      expect(`${picker.textContent} ${named}`).not.toMatch(/우리 팀|기본/);
    }
    expect(tabs.map((tab) => tab.textContent)).toEqual(["이모티콘", "이모지", "GIF"]);
    expect(picker.getAttribute("aria-label")).toBe("이모티콘 넣기");
  });

  it("미리 보기 길(메인 컴포저): 이모티콘·GIF 를 고르면 글을 넣지 않고 표현 자체를 넘기며 고르개를 닫는다. 작은 이모지는 계속 글로 들어간다", async () => {
    await open("ko-KR");
    const tabs = within(await screen.findByRole("group", { name: "표현 종류" })).getAllByRole("button");
    fireEvent.click(tabs[0]);
    fireEvent.click(await screen.findByRole("button", { name: "건배 메시지에 넣기" }));
    expect(onPickExpression).toHaveBeenCalledTimes(1);
    expect(onPickExpression.mock.calls[0]?.[0]).toMatchObject({ id: CHEERS.id, name: "cheers_still" });
    expect(onPick).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(tabs[2]);
    fireEvent.click(await screen.findByRole("button", { name: "기절 메시지에 넣기" }));
    expect(onPickExpression).toHaveBeenCalledTimes(2);
    expect(onPickExpression.mock.calls[1]?.[0]).toMatchObject({ name: "ki_jeol" });
    // 이모지 탭의 팀 이모지: 입력칸에 `:이름:`.
    fireEvent.click(tabs[1]);
    fireEvent.click(await screen.findByTestId("team-emoji-smile_tiny"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(":smile_tiny:");
    expect(onPickExpression).toHaveBeenCalledTimes(2);
  });

  it("예전 길(스레드 입력칸·반응): 미리 보기 길을 받지 않으면 이모티콘도 `:이름:` 글로 넘어간다", async () => {
    await open("ko-KR", { withPreview: false });
    const tabs = within(await screen.findByRole("group", { name: "표현 종류" })).getAllByRole("button");
    fireEvent.click(tabs[0]);
    fireEvent.click(await screen.findByRole("button", { name: "건배 메시지에 넣기" }));
    expect(onPick).toHaveBeenCalledWith(":cheers_still:");
    expect(onPickExpression).not.toHaveBeenCalled();
  });

  it("상태 고르개에는 탭도 팀 이모지 줄도 없다: 표준 그림 문자만 고른다", async () => {
    await open("ko-KR", { purpose: "status" });
    await screen.findByTestId("picker");
    expect(screen.queryByRole("group", { name: "표현 종류" })).toBeNull();
    expect(await screen.findByTestId("emoji-search")).toBeTruthy();
    expect(screen.queryByTestId("team-emoji-strip")).toBeNull();
  });

  it("이모지 탭의 검색 칸 하나가 표와 팀 이모지를 함께 거른다", async () => {
    await open("ko-KR");
    fireEvent.click(within(await screen.findByRole("group", { name: "표현 종류" })).getAllByRole("button")[1]);
    await waitFor(() => expect(stripNames()).toEqual(["작은 웃음", "파티 앵무새"]));
    fireEvent.change(screen.getByTestId("emoji-search"), { target: { value: "앵무" } });
    await waitFor(() => expect(stripNames()).toEqual(["파티 앵무새"]));
    fireEvent.change(screen.getByTestId("emoji-search"), { target: { value: "존재하지않는이름" } });
    await waitFor(() => expect(screen.queryByTestId("team-emoji-strip")).toBeNull());
  });
});
