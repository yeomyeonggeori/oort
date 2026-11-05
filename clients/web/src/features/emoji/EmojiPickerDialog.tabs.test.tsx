// @vitest-environment jsdom
import { useState } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { createLocaleService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import { ExpressionsContext } from "@/features/expressions/context";
import { createExpressionFixtureTransport } from "@/features/expressions/transport";
import { EmojiPickerDialog } from "./EmojiPickerDialog";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchRoster: vi.fn().mockResolvedValue([]), authedResponse: vi.fn() }));

// #5330, owner 2026-11-05: 사용자에게 보이는 이름은 「이모티콘」 하나다. 웹 고르개도 폰 시트와 같은 세 탭(이모티콘 · 기본 · GIF)이고 「이모지」·「팀 이모지」·「우리 팀」이
// 화면에 없다. 탭 이름은 사전의 것이고(폰 시트와 같은 키), 기대값은 사전에서 읽지 않고 글자로 못 박는다.

async function appLocale(language: "ko-KR" | "en-US"): Promise<AppLocale> {
  const context = resolveLocaleContext(language, { languages: [language], timeZone: "Asia/Seoul" });
  const service = createLocaleService({ ...context, catalog: language === "ko-KR" ? await loadMessageCatalog("ko-KR") : undefined });
  return { service, getSnapshot: () => service.context, subscribe: () => () => undefined } as unknown as AppLocale;
}

function Host({ purpose = "insert" }: { purpose?: "insert" | "reaction" | "status" }) {
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  return <>
    <button type="button" ref={setOpener}>열기</button>
    <EmojiPickerDialog open onOpenChange={() => {}} onPick={() => {}} opener={opener} anchor={opener} purpose={purpose} testId="picker" />
  </>;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => {}, configurable: true, writable: true });
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(Element.prototype, "scrollIntoView"); });

async function open(language: "ko-KR" | "en-US", purpose?: "insert" | "reaction" | "status") {
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID));
  await store.refresh();
  const locale = await appLocale(language);
  return render(<LocaleContext.Provider value={locale}><ExpressionsContext.Provider value={store}><Host purpose={purpose} /></ExpressionsContext.Provider></LocaleContext.Provider>);
}
const names = () => screen.queryAllByRole("button", { name: /메시지에 넣기$/ }).map((button) => (button.getAttribute("aria-label") ?? "").replace(" 메시지에 넣기", "")).sort();

describe("the web picker has the phone sheet's three tabs and one name (#5330)", () => {
  const WORDS = {
    "ko-KR": { group: "표현 종류", tabs: ["이모티콘", "기본", "GIF"] },
    "en-US": { group: "Kinds", tabs: ["Emoticons", "Emoji", "GIF"] },
  } as const;
  it.each([["ko-KR"], ["en-US"]] as const)("%s: the tabs stand in the order emoticon · basic · GIF, open on the basic table, and each opens its own panel", async (language) => {
    await open(language);
    const group = await screen.findByRole("group", { name: WORDS[language].group });
    const tabs = within(group).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual([...WORDS[language].tabs]);
    // 처음 여는 탭은 앞 판과 같은 표준 그림 문자 표(「기본」)다.
    expect(tabs.map((tab) => tab.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    expect(await screen.findByLabelText("이모티콘 검색")).toBeTruthy();
    expect(screen.queryByTestId("team-expressions")).toBeNull();
    // 이모티콘: 작은 것(파티 앵무새, `emoji` 종류)이 선다. 보기는 탭이 정하므로 패널은 자기 보기 고르기를 그리지 않는다.
    fireEvent.click(tabs[0]);
    await screen.findByTestId("team-expressions");
    await waitFor(() => expect(names()).toEqual(["파티 앵무새"]));
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(tabs.map((tab) => tab.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    // GIF: 움직이는 큰 이모티콘 둘.
    fireEvent.click(tabs[2]);
    await waitFor(() => expect(names()).toEqual(["기절", "엄지척"]));
    // 기본: 표준 표로 돌아온다.
    fireEvent.click(tabs[1]);
    expect(await screen.findByLabelText("이모티콘 검색")).toBeTruthy();
    expect(screen.queryByTestId("team-expressions")).toBeNull();
  });
  it("ko-KR: no 이모지 · 팀 이모지 on the open picker, on any tab (visible words and accessible names), and no 「우리 팀」 heading", async () => {
    await open("ko-KR");
    const picker = await screen.findByTestId("picker");
    const names = () => `${Array.from(picker.querySelectorAll("[aria-label],[title],[placeholder]")).map((node) => `${node.getAttribute("aria-label")} ${node.getAttribute("title")} ${node.getAttribute("placeholder")}`).join(" ")} ${picker.getAttribute("aria-label")}`;
    const tabs = within(await screen.findByRole("group", { name: "표현 종류" })).getAllByRole("button");
    for (const tab of [tabs[1], tabs[0], tabs[2], tabs[1]]) {
      fireEvent.click(tab);
      await waitFor(() => expect(picker.querySelector("[data-testid='team-expressions'], [aria-label='이모티콘 검색']")).not.toBeNull());
      expect(picker.textContent).not.toMatch(/이모지|우리 팀/);
      expect(names()).not.toMatch(/이모지/);
    }
    expect(picker.getAttribute("aria-label")).toBe("이모티콘 넣기");
  });
  it("the status picker has no tabs: it chooses a standard glyph only (no library there)", async () => {
    await open("ko-KR", "status");
    await screen.findByTestId("picker");
    expect(screen.queryByRole("group", { name: "표현 종류" })).toBeNull();
    expect(await screen.findByLabelText("이모티콘 검색")).toBeTruthy();
  });
});
