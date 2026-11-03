// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocaleService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import type { ReleaseNote } from "@momo/core/features/releaseNotes/model";
import { RELEASE_NOTES } from "@momo/core/features/releaseNotes/notes";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";

const app = vi.hoisted(() => ({ version: null as string | null }));
vi.mock("@/features/updates/store", () => ({ useAppVersion: () => app.version }));

import { ReleaseNotesSection } from "./ReleaseNotesSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function note(version: string, desktopFrom: string[]): ReleaseNote {
  return {
    version,
    releasedOn: version === "0.1.42" ? "2026-11-05" : "2026-10-31",
    phoneBuild: 3000 + Number(version.split(".")[2]),
    desktopFrom,
    summary: { "ko-KR": `요약 ${version}`, "en-US": `Summary ${version}` },
    items: [
      {
        id: "both",
        surfaces: ["phone", "desktop"],
        copy: {
          "ko-KR": { title: "둘 다 제목", changed: "둘 다 바뀐 점", tryIt: "둘 다 써 보기" },
          "en-US": { title: "Both title", changed: "Both changed", tryIt: "Both try" },
        },
      },
      {
        id: "phone-only",
        surfaces: ["phone"],
        copy: {
          "ko-KR": { title: "폰 제목", changed: "폰 바뀐 점", tryIt: "폰 써 보기" },
          "en-US": { title: "Phone title", changed: "Phone changed", tryIt: "Phone try" },
        },
      },
    ],
  };
}
// 새 소식이 앞에 오지 않게 일부러 거꾸로 넘긴다: 화면이 스스로 줄 세워야 한다.
const OLD_FIRST = [note("0.1.41", ["0.1.41"]), note("0.1.42", ["0.1.42"])];

async function locale(messageLocale: "ko-KR" | "en-US"): Promise<AppLocale> {
  const context = resolveLocaleContext(messageLocale, { languages: [messageLocale], timeZone: "Asia/Seoul" });
  const service = createLocaleService({
    ...context,
    catalog: messageLocale === "ko-KR" ? await loadMessageCatalog("ko-KR") : undefined,
  });
  return { service, getSnapshot: () => service.context, subscribe: () => () => undefined } as unknown as AppLocale;
}

async function mountSection(language: "ko-KR" | "en-US", notes?: readonly ReleaseNote[]) {
  const value = await locale(language);
  return render(
    createElement(LocaleContext.Provider, { value }, createElement(ReleaseNotesSection, notes ? { notes } : {})),
  );
}

beforeEach(() => {
  app.version = null;
});
afterEach(cleanup);

describe("설정 › 업데이트 소식", () => {
  it("목록은 새 소식이 맨 위이고 「지금 쓰는 버전」 표지는 이 앱에 붙는 소식에만 선다", async () => {
    app.version = "0.1.41";
    await mountSection("ko-KR", OLD_FIRST);
    const rows = [...screen.getAllByTestId(/^release-notes-row-/)].map((row) => row.getAttribute("data-testid"));
    expect(rows).toEqual(["release-notes-row-0.1.42", "release-notes-row-0.1.41"]);
    expect(within(screen.getByTestId("release-notes-row-0.1.41")).getByText("지금 쓰는 버전")).toBeTruthy();
    expect(within(screen.getByTestId("release-notes-row-0.1.42")).queryByText("지금 쓰는 버전")).toBeNull();
    expect(screen.getByTestId("release-notes-row-0.1.42").textContent).toContain("2026-11-05 공개");
    cleanup();

    // 앱 버전이 없는 브라우저 탭은 표지 없이 목록만 본다.
    app.version = null;
    await mountSection("ko-KR", OLD_FIRST);
    expect(screen.queryByText("지금 쓰는 버전")).toBeNull();
    expect(screen.getAllByTestId(/^release-notes-row-/)).toHaveLength(2);
  });

  it("버전을 열면 항목마다 바뀐 점·이렇게 써 보세요·보이는 화면이 서고, 돌아오면 포커스가 눌렀던 단추로 간다", async () => {
    await mountSection("ko-KR", OLD_FIRST);
    const opener = screen.getByTestId("release-notes-open-0.1.42");
    expect(opener.getAttribute("aria-label")).toBe("자세히 보기, 버전 0.1.42");
    opener.focus();
    fireEvent.click(opener);

    // 낭독이 새 제목을 읽도록 포커스는 내용의 제목으로 간다.
    const title = screen.getByTestId("release-notes-detail-title");
    expect(title.textContent).toBe("버전 0.1.42");
    expect(document.activeElement).toBe(title);
    const both = screen.getByTestId("release-notes-item-both");
    expect(both.textContent).toContain("둘 다 제목");
    expect(within(both).getByText("바뀐 점").nextElementSibling?.textContent).toBe("둘 다 바뀐 점");
    expect(within(both).getByText("이렇게 써 보세요").nextElementSibling?.textContent).toBe("둘 다 써 보기");
    // 표지: 폰·데스크탑 둘 / 폰 하나. 색이 아니라 글자로 말한다.
    expect([...within(both).getByRole("group", { name: "보이는 화면" }).children].map((chip) => chip.textContent)).toEqual([
      "폰",
      "데스크탑",
    ]);
    expect(
      [...within(screen.getByTestId("release-notes-item-phone-only")).getByRole("group", { name: "보이는 화면" }).children].map(
        (chip) => chip.textContent,
      ),
    ).toEqual(["폰"]);

    fireEvent.click(screen.getByTestId("release-notes-back"));
    expect(screen.getByTestId("release-notes-page")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("release-notes-open-0.1.42"));
  });

  it("영어 UI에서는 같은 소식의 영어 글과 영어 문구가 선다 (실제 v0.1.41 소식)", async () => {
    await mountSection("en-US");
    const row = screen.getByTestId("release-notes-row-0.1.41");
    expect(row.textContent).toContain("Version 0.1.41");
    expect(row.textContent).toContain(RELEASE_NOTES[0].summary["en-US"]);
    fireEvent.click(screen.getByTestId("release-notes-open-0.1.41"));
    const first = RELEASE_NOTES[0].items[0];
    expect(screen.getByTestId("release-notes-item-" + first.id).textContent).toContain(first.copy["en-US"].title);
    expect(screen.getAllByText("What changed")).toHaveLength(RELEASE_NOTES[0].items.length);
    expect(screen.getAllByText("Try it like this")).toHaveLength(RELEASE_NOTES[0].items.length);
    // 소식이 하나도 없으면 빈 상태 한 줄이다.
    cleanup();
    await mountSection("en-US", []);
    expect(screen.getByTestId("release-notes-empty").textContent).toBe("There are no updates to show yet.");
  });
});
