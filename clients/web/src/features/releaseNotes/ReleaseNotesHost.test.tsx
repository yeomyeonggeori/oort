// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocaleService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import type { ReleaseNote } from "@momo/core/features/releaseNotes/model";
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

function note(version: string, desktopFrom: string[], phoneOnlyTitle = false): ReleaseNote {
  const item = (id: string, surfaces: ReleaseNote["items"][number]["surfaces"]) => ({
    id,
    surfaces,
    copy: {
      "ko-KR": { title: `제목 ${id}`, changed: `바뀐 점 ${id}`, tryIt: `써 보기 ${id}` },
      "en-US": { title: `Title ${id}`, changed: `Changed ${id}`, tryIt: `Try ${id}` },
    },
  });
  return {
    version,
    releasedOn: "2026-10-31",
    phoneBuild: 3000 + Number(version.split(".")[2]),
    desktopFrom,
    summary: { "ko-KR": `요약 ${version}`, "en-US": `Summary ${version}` },
    items: [
      item("a", phoneOnlyTitle ? ["phone"] : ["desktop"]),
      item("b", ["phone", "desktop"]),
      item("c", ["phone"]),
      item("d", ["desktop"]),
      item("e", ["desktop"]),
      item("f", ["desktop"]),
    ],
  };
}
const V41 = note("0.1.41", ["0.1.41"]);
const V42 = note("0.1.42", ["0.1.42"]);

function Probe() {
  const location = useLocation();
  return createElement("div", { "data-testid": "where" }, location.pathname + location.search);
}

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
    expect(dialog.textContent).toContain("요약 0.1.41");
    // 이 화면(데스크탑)에서 보이는 변화만 제목으로: 폰 전용 항목(c)은 없고, 네 줄까지 보이고 나머지는 접힌다.
    const titles = [...screen.getByTestId("release-notes-dialog-titles").querySelectorAll("li")].map((li) => li.textContent);
    expect(titles).toEqual(["제목 a", "제목 b", "제목 d", "제목 e", "그 밖에 1가지"]);
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
