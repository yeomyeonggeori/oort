// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocaleService, createMessageService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import type { ReleaseNote } from "@momo/core/features/releaseNotes/model";
import { RELEASE_NOTE_0_1_41 } from "@momo/core/features/releaseNotes/notes/v0_1_41";
import { catalog as koCatalog } from "@momo/core/i18n/generated/ko-KR";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";

const app = vi.hoisted(() => ({ version: null as string | null }));
vi.mock("@/features/updates/store", () => ({ useAppVersion: () => app.version }));

import { ReleaseNotesHost } from "./ReleaseNotesHost";
import {
  RELEASE_NOTES_SEEN_STORAGE_KEY,
  lastSeenReleaseNote,
  markReleaseNoteSeen,
  resetReleaseNotesSeenForTest,
} from "./seenStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 소식의 글은 사전에 있다(#5054): 가짜 소식도 사전에 있는 진짜 키를 쓰고, 기대하는 글은 같은 사전을 읽는 서비스에서 구한다.
// 고정값은 v0.1.41 **파일**에 못 박는다: 등록부의 맨 앞(`RELEASE_NOTES[0]`)은 승격 때 새 소식이 더해지면 바뀐다.
const PINNED = RELEASE_NOTE_0_1_41;
const REAL = PINNED.items;
const koText = createMessageService({ messageLocale: "ko-KR", catalog: koCatalog });

function note(version: string, desktopFrom: string[], phoneOnlyTitle = false): ReleaseNote {
  const item = (index: number, surfaces: ReleaseNote["items"][number]["surfaces"]) => ({ ...REAL[index], surfaces });
  return {
    ...PINNED,
    version,
    releasedOn: "2026-10-31",
    phoneBuild: 3000 + Number(version.split(".")[2]),
    desktopFrom,
    items: [
      item(0, phoneOnlyTitle ? ["phone"] : ["desktop"]),
      item(1, ["phone", "desktop"]),
      item(2, ["phone"]),
      item(3, ["desktop"]),
      item(4, ["desktop"]),
      item(5, ["desktop"]),
    ],
    // 「그 밖에 바뀐 점」은 설정의 버전 상세에만 선다: 첫 실행 자동 창에는 나오지 않는다.
    others: [{ id: "conversations", title: "releaseNotes.topic.conversations", lines: [REAL[6].tryIt] }],
  };
}
const V41 = note("0.1.41", ["0.1.41"]);
const V42 = note("0.1.42", ["0.1.42"]);

function Probe() {
  const location = useLocation();
  return createElement("div", { "data-testid": "where" }, location.pathname + location.search);
}

/** 첫 실행 창의 제목 목록(`ul`)과 지금 서 있는 줄의 글. 「더보기」 단추는 목록 항목이 아니다. */
const titleList = () => screen.getByTestId("release-notes-dialog-titles");
const shownTitles = () => [...titleList().querySelectorAll("li")].map((li) => li.textContent);

function mountHost(notes: readonly ReleaseNote[], wrap: (children: ReactNode) => ReactNode = (children) => children) {
  return render(
    wrap(
      createElement(
        MemoryRouter,
        { initialEntries: ["/channels"] },
        createElement(ReleaseNotesHost, { notes }),
        createElement(Routes, null, createElement(Route, { path: "*", element: createElement(Probe) })),
      ),
    ),
  );
}

async function koreanLocale(): Promise<AppLocale> {
  const context = resolveLocaleContext("ko-KR", { languages: ["ko-KR"], timeZone: "Asia/Seoul" });
  const service = createLocaleService({ ...context, catalog: await loadMessageCatalog("ko-KR") });
  return { service, getSnapshot: () => service.context, subscribe: () => () => undefined } as unknown as AppLocale;
}

beforeEach(() => {
  localStorage.clear();
  resetReleaseNotesSeenForTest();
  app.version = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("업데이트 소식: 처음 열 때 한 번", () => {
  it("업데이트 뒤 처음 열면 뜨고, 닫으면 같은 버전에서는 다시 뜨지 않는다 (한국어)", async () => {
    app.version = "0.1.41";
    const locale = await koreanLocale();
    const wrap = (children: ReactNode) => createElement(LocaleContext.Provider, { value: locale }, children);
    const first = mountHost([V41], wrap);
    const dialog = await screen.findByTestId("release-notes-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(screen.getByRole("dialog", { name: "업데이트 소식" })).toBe(dialog);
    expect(dialog.textContent).toContain("버전 0.1.41");
    expect(dialog.textContent).toContain(koText.formatMessage(PINNED.summary));
    // 이 화면(데스크탑)에서 보이는 변화만 제목으로: 폰 전용 항목(c)은 없고, 네 줄까지 보이고 나머지는 「더보기」 뒤에 있다.
    expect(shownTitles()).toEqual([
      koText.formatMessage(REAL[0].title),
      koText.formatMessage(REAL[1].title),
      koText.formatMessage(REAL[3].title),
      koText.formatMessage(REAL[4].title),
    ]);
    expect(screen.getByRole("button", { name: "더보기" })).toBe(screen.getByTestId("release-notes-dialog-more"));
    // 「그 밖에 N가지」 문장은 없다(#5298). 「그 밖에 바뀐 점」은 자동 창에 없다(설정의 버전 상세에만 선다).
    expect(dialog.textContent).not.toContain("그 밖에");
    expect(dialog.textContent).not.toContain(koText.formatMessage(REAL[6].tryIt));
    // 포커스는 단추가 아니라 대화상자 자신이다: 입력 도중에 뜬 창이 다음 Enter를 먹지 않는다.
    expect(document.activeElement).toBe(dialog);
    expect(lastSeenReleaseNote()).toBeNull();

    fireEvent.click(screen.getByTestId("release-notes-close"));
    expect(lastSeenReleaseNote()).toBe("0.1.41");
    expect(localStorage.getItem(RELEASE_NOTES_SEEN_STORAGE_KEY)).toBe("0.1.41");
    await waitFor(() => expect(screen.queryByTestId("release-notes-dialog")).toBeNull());

    // 같은 버전으로 다시 열어도(앱을 다시 켜는 것과 같다) 뜨지 않는다.
    first.unmount();
    resetReleaseNotesSeenForTest();
    mountHost([V41], wrap);
    await Promise.resolve();
    expect(screen.queryByTestId("release-notes-dialog")).toBeNull();
  });

  it("「더보기」는 나머지를 같은 불릿 목록에 이어서 펼치고, 단추는 사라지며, 초점은 처음 새로 선 항목으로 간다 (#5298)", async () => {
    app.version = "0.1.41";
    const locale = await koreanLocale();
    mountHost([V41], (children) => createElement(LocaleContext.Provider, { value: locale }, children));
    const dialog = await screen.findByTestId("release-notes-dialog");
    const list = titleList();
    // 불릿 목록은 진짜 목록 마크업이다(낭독이 「목록, 5개 항목」을 말한다). 마커 모양은 CSS라 jsdom은 그리지 못한다: 실제 브라우저가
    // 그린 마커는 캡처 때 계산된 `list-style-type`으로 잰다.
    expect(list.tagName).toBe("UL");
    expect(list.className).toMatch(/\blist-disc\b/);
    expect(list.id).not.toBe("");
    expect(shownTitles()).toHaveLength(4);
    const more = screen.getByTestId("release-notes-dialog-more");
    expect(more.tagName).toBe("BUTTON");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe(list.id);
    // 단추는 목록 항목이 아니다: 항목 마커가 서지 않고, 항목 수(낭독의 「5개 항목」)에 섞이지 않는다.
    expect(list.contains(more)).toBe(false);

    fireEvent.click(more);

    // 나머지가 그 자리에서 이어서 선다: 앞의 네 줄은 그대로이고 뒤에 한 줄이 붙는다.
    const items = [...list.querySelectorAll("li")];
    expect(items.map((li) => li.textContent)).toEqual([
      koText.formatMessage(REAL[0].title),
      koText.formatMessage(REAL[1].title),
      koText.formatMessage(REAL[3].title),
      koText.formatMessage(REAL[4].title),
      koText.formatMessage(REAL[5].title),
    ]);
    expect(screen.queryByTestId("release-notes-dialog-more")).toBeNull();
    expect(dialog.textContent).not.toContain("그 밖에");
    // 단추가 사라져도 초점이 <body>로 떨어지지 않는다: 처음 새로 선 항목이 받아서 낭독이 그 항목부터 읽는다.
    expect(document.activeElement).toBe(items[4]);
    // 그 항목은 Tab 순서에 끼지 않는다(프로그램만 옮길 수 있다). 앞의 네 줄은 원래대로 초점을 받지 않는다.
    expect(items[4].getAttribute("tabindex")).toBe("-1");
    expect(items.slice(0, 4).some((li) => li.hasAttribute("tabindex"))).toBe(false);
    // 펼친 뒤에도 닫는 길은 그대로다.
    fireEvent.click(screen.getByTestId("release-notes-close"));
    expect(lastSeenReleaseNote()).toBe("0.1.41");
  });

  it("항목이 네 개 이하이면 「더보기」는 서지 않고 네 줄이 모두 보인다 (경계 4개, #5298)", async () => {
    app.version = "0.1.41";
    const locale = await koreanLocale();
    // 폰 전용 제목을 하나 줄이면 데스크탑 항목은 정확히 네 개다.
    mountHost([note("0.1.41", ["0.1.41"], true)], (children) =>
      createElement(LocaleContext.Provider, { value: locale }, children),
    );
    const dialog = await screen.findByTestId("release-notes-dialog");
    expect(shownTitles()).toEqual([
      koText.formatMessage(REAL[1].title),
      koText.formatMessage(REAL[3].title),
      koText.formatMessage(REAL[4].title),
      koText.formatMessage(REAL[5].title),
    ]);
    // 대화상자의 단추는 두 행동뿐이다(언어와 무관하게 잰다).
    expect(within(dialog).getAllByRole("button").map((button) => button.getAttribute("data-testid"))).toEqual([
      "release-notes-close",
      "release-notes-details",
    ]);
    expect(dialog.textContent).not.toContain("그 밖에");
  });

  it("영어 UI에서는 「Show more」이고 「N more changes」 문장은 없다 (#5298)", async () => {
    app.version = "0.1.41";
    mountHost([V41]);
    const dialog = await screen.findByTestId("release-notes-dialog");
    expect(screen.getByTestId("release-notes-dialog-more").textContent).toBe("Show more");
    expect(dialog.textContent).not.toMatch(/more change/i);
  });

  it("새 소식에서는 다시 뜨고, 소식이 없는 버전(다음 채널 개발 빌드)이나 앱 버전이 없는 브라우저 탭에서는 뜨지 않는다", async () => {
    // 41을 닫은 기기가 42로 업데이트했다.
    markReleaseNoteSeen("0.1.41");
    app.version = "0.1.42";
    mountHost([V41, V42]);
    const dialog = await screen.findByTestId("release-notes-dialog");
    expect(dialog.textContent).toContain("Version 0.1.42");
    cleanup();

    for (const version of ["0.1.0-next.1", "0.1.40", null]) {
      app.version = version;
      localStorage.clear();
      resetReleaseNotesSeenForTest();
      mountHost([V41, V42]);
      await Promise.resolve();
      expect(screen.queryByTestId("release-notes-dialog"), String(version)).toBeNull();
      cleanup();
    }
  });

  it("「자세히 보기」는 창을 닫고 봤다고 적고 설정의 업데이트 소식으로 간다", async () => {
    app.version = "0.1.41";
    mountHost([V41]);
    await screen.findByTestId("release-notes-dialog");
    fireEvent.click(screen.getByTestId("release-notes-details"));
    expect(screen.getByTestId("where").textContent).toBe("/settings?section=releaseNotes");
    expect(lastSeenReleaseNote()).toBe("0.1.41");
    await waitFor(() => expect(screen.queryByTestId("release-notes-dialog")).toBeNull());
  });

  it("Esc로 닫아도 기록되고, 저장소를 못 써도 이번 실행에서는 두 번 뜨지 않는다", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    app.version = "0.1.41";
    const first = mountHost([V41]);
    const dialog = await screen.findByTestId("release-notes-dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("release-notes-dialog")).toBeNull());
    expect(lastSeenReleaseNote()).toBe("0.1.41");
    expect(localStorage.getItem(RELEASE_NOTES_SEEN_STORAGE_KEY)).toBeNull();
    first.unmount();
    // 메모리 값이 이번 실행을 지킨다(저장소 값은 없다).
    mountHost([V41]);
    await Promise.resolve();
    expect(screen.queryByTestId("release-notes-dialog")).toBeNull();
    // 더 새 소식을 본 기기의 값은 낮아지지 않는다.
    markReleaseNoteSeen("0.1.40");
    expect(lastSeenReleaseNote()).toBe("0.1.41");
  });
});
