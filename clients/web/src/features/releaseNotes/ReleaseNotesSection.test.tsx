// @vitest-environment jsdom

import { TYPE } from "@formatjs/icu-messageformat-parser";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocaleService,
  createMessageService,
  loadMessageCatalog,
  resolveLocaleContext,
  type MessageCatalog,
} from "@momo/core/i18n";
import type { ReleaseNote, ReleaseNoteOtherGroup } from "@momo/core/features/releaseNotes/model";
import { RELEASE_NOTE_0_1_41 } from "@momo/core/features/releaseNotes/notes/v0_1_41";
import { catalog as koCatalog } from "@momo/core/i18n/generated/ko-KR";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";

const app = vi.hoisted(() => ({ version: null as string | null }));
vi.mock("@/features/updates/store", () => ({ useAppVersion: () => app.version }));

import { ReleaseNotesSection } from "./ReleaseNotesSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 소식의 글은 사전에 있다(#5054): 가짜 소식도 사전에 있는 **진짜 키**를 쓴다(없는 키는 안전 문구로 나간다). 기대하는 글은 같은
// 사전을 읽는 서비스에서 구해, 글이 바뀌어도 시험이 깨지지 않고 화면이 실제 사전 값을 그리는지만 잰다.
// 고정값은 v0.1.41 **파일**에 못 박는다: 등록부의 맨 앞(`RELEASE_NOTES[0]`)은 승격 때 새 소식이 더해지면 바뀐다.
const REAL = RELEASE_NOTE_0_1_41;
const typing = REAL.items.find((item) => item.id === "typing")!;
const phoneConversation = REAL.items.find((item) => item.id === "phoneConversation")!;
const settings = REAL.items.find((item) => item.id === "settings")!;
const koText = createMessageService({ messageLocale: "ko-KR", catalog: koCatalog });
const enText = createMessageService({ messageLocale: "en-US" });

/** 「그 밖에 바뀐 점」 재료: 공용 주제 이름과, 한 줄로 읽히는 진짜 키들. */
const OTHERS: readonly ReleaseNoteOtherGroup[] = [
  { id: "conversations", title: "releaseNotes.topic.conversations", lines: [typing.tryIt, phoneConversation.tryIt] },
  { id: "settings", title: "releaseNotes.topic.settings", lines: [settings.tryIt] },
];

function note(version: string, desktopFrom: string[], others: readonly ReleaseNoteOtherGroup[] = []): ReleaseNote {
  return {
    ...REAL,
    version,
    releasedOn: version === "0.1.42" ? "2026-11-05" : "2026-10-31",
    phoneBuild: 3000 + Number(version.split(".")[2]),
    desktopFrom,
    items: [
      { ...typing, surfaces: ["phone", "desktop"] },
      { ...phoneConversation, surfaces: ["phone"] },
    ],
    others,
  };
}
// 새 소식이 앞에 오지 않게 일부러 거꾸로 넘긴다: 화면이 스스로 줄 세워야 한다.
const OLD_FIRST = [note("0.1.41", ["0.1.41"]), note("0.1.42", ["0.1.42"], OTHERS)];

type Language = "ko-KR" | "en-US" | "ja-JP";

/** 요약만 번역된 일본어(ADR-0213 P2의 중간 상태): 사전에 없는 키는 영어 문장으로 내려간다. */
const JAPANESE_SUMMARY_ONLY: MessageCatalog = {
  [REAL.summary]: [{ type: TYPE.literal, value: "要約だけ訳した" }],
};

async function locale(messageLocale: Language): Promise<AppLocale> {
  const context = resolveLocaleContext(messageLocale, { languages: [messageLocale], timeZone: "Asia/Seoul" });
  const catalog =
    messageLocale === "ko-KR"
      ? await loadMessageCatalog("ko-KR")
      : messageLocale === "ja-JP"
        ? JAPANESE_SUMMARY_ONLY
        : undefined;
  const service = createLocaleService({ ...context, catalog });
  return { service, getSnapshot: () => service.context, subscribe: () => () => undefined } as unknown as AppLocale;
}

async function mountSection(language: Language, notes?: readonly ReleaseNote[]) {
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
    // 줄의 요약은 사전의 글이다.
    expect(screen.getByTestId("release-notes-row-0.1.42").textContent).toContain(koText.formatMessage(REAL.summary));
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
    const both = screen.getByTestId("release-notes-item-typing");
    expect(both.textContent).toContain(koText.formatMessage(typing.title));
    expect(within(both).getByText("바뀐 점").nextElementSibling?.textContent).toBe(koText.formatMessage(typing.changed));
    expect(within(both).getByText("이렇게 써 보세요").nextElementSibling?.textContent).toBe(
      koText.formatMessage(typing.tryIt),
    );
    // 표지: 폰·데스크탑 둘 / 폰 하나. 색이 아니라 글자로 말한다.
    expect([...within(both).getByRole("group", { name: "보이는 화면" }).children].map((chip) => chip.textContent)).toEqual([
      "폰",
      "데스크탑",
    ]);
    expect(
      [...within(screen.getByTestId("release-notes-item-phoneConversation")).getByRole("group", { name: "보이는 화면" }).children].map(
        (chip) => chip.textContent,
      ),
    ).toEqual(["폰"]);

    fireEvent.click(screen.getByTestId("release-notes-back"));
    expect(screen.getByTestId("release-notes-page")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("release-notes-open-0.1.42"));
  });

  it("버전 상세에는 핵심 아래에 「그 밖에 바뀐 점」이 주제별 한 줄로 서고, 목록에는 없다", async () => {
    await mountSection("ko-KR", OLD_FIRST);
    // 목록에는 없다.
    expect(screen.queryByTestId("release-notes-others")).toBeNull();
    fireEvent.click(screen.getByTestId("release-notes-open-0.1.42"));

    const others = screen.getByTestId("release-notes-others");
    expect(within(others).getByRole("heading", { name: "그 밖에 바뀐 점" })).toBeTruthy();
    // 핵심 항목들 뒤에 선다.
    const detail = screen.getByTestId("release-notes-detail");
    const lastItem = screen.getByTestId("release-notes-item-phoneConversation");
    expect(lastItem.compareDocumentPosition(others) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(detail.contains(others)).toBe(true);
    // 주제는 소식이 적은 순서이고, 주제 이름 아래에 한 줄씩이다.
    const groups = [...others.querySelectorAll("[data-testid^='release-notes-other-']")];
    expect(groups.map((group) => group.getAttribute("data-testid"))).toEqual([
      "release-notes-other-conversations",
      "release-notes-other-settings",
    ]);
    // 줄은 불릿 목록 항목이다(#5298): 마커가 서는 진짜 `ul`·`li`. 마커 모양은 CSS라 jsdom은 그리지 못한다(캡처 때 계산된
    // `list-style-type`으로 잰다).
    for (const group of groups) {
      const list = group.querySelector("ul");
      expect(list, group.getAttribute("data-testid") ?? "").not.toBeNull();
      expect(list?.className).toMatch(/\blist-disc\b/);
    }
    const lines = (group: Element) => [...group.querySelectorAll("li")].map((line) => line.textContent);
    expect(groups[0].textContent).toContain("대화");
    expect(lines(groups[0])).toEqual([koText.formatMessage(typing.tryIt), koText.formatMessage(phoneConversation.tryIt)]);
    expect(groups[1].textContent).toContain("설정");
    expect(lines(groups[1])).toEqual([koText.formatMessage(settings.tryIt)]);
  });

  it("그 밖에 바뀐 점이 비어 있는 소식에는 머리글도 칸도 서지 않는다", async () => {
    await mountSection("ko-KR", OLD_FIRST);
    fireEvent.click(screen.getByTestId("release-notes-open-0.1.41"));
    expect(screen.getByTestId("release-notes-detail")).toBeTruthy();
    expect(screen.queryByTestId("release-notes-others")).toBeNull();
    expect(screen.queryByText("그 밖에 바뀐 점")).toBeNull();
  });

  it("영어 UI에서는 같은 소식의 영어 글과 영어 문구가 선다 (실제 v0.1.41 소식)", async () => {
    await mountSection("en-US", [REAL]);
    const row = screen.getByTestId("release-notes-row-0.1.41");
    expect(row.textContent).toContain("Version 0.1.41");
    expect(row.textContent).toContain(enText.formatMessage(REAL.summary));
    fireEvent.click(screen.getByTestId("release-notes-open-0.1.41"));
    const first = REAL.items[0];
    expect(screen.getByTestId("release-notes-item-" + first.id).textContent).toContain(enText.formatMessage(first.title));
    expect(screen.getAllByText("What changed")).toHaveLength(REAL.items.length);
    expect(screen.getAllByText("Try it like this")).toHaveLength(REAL.items.length);
    // 소식이 하나도 없으면 빈 상태 한 줄이다.
    cleanup();
    await mountSection("en-US", []);
    expect(screen.getByTestId("release-notes-empty").textContent).toBe("There are no updates to show yet.");
    cleanup();

    // 「그 밖에 바뀐 점」의 머리글·주제 이름도 영어다.
    await mountSection("en-US", OLD_FIRST);
    fireEvent.click(screen.getByTestId("release-notes-open-0.1.42"));
    const others = screen.getByTestId("release-notes-others");
    expect(within(others).getByRole("heading", { name: "Other changes" })).toBeTruthy();
    expect(screen.getByTestId("release-notes-other-conversations").textContent).toContain("Conversations");
  });

  it("사전이 일부만 번역된 언어(일본어)는 번역된 키만 그 언어이고 나머지는 영어 글이다 (ADR-0213 영어 대체)", async () => {
    await mountSection("ja-JP", [REAL]);
    const row = screen.getByTestId("release-notes-row-0.1.41");
    expect(row.textContent).toContain("要約だけ訳した");
    // 번역이 없는 문구는 영어이지 한국어가 아니다.
    expect(row.textContent).toContain("Version 0.1.41");
    expect(row.textContent).not.toContain("버전");
    fireEvent.click(screen.getByTestId("release-notes-open-0.1.41"));
    const item = screen.getByTestId("release-notes-item-" + typing.id);
    expect(item.textContent).toContain(enText.formatMessage(typing.title));
    expect(item.textContent).toContain(enText.formatMessage(typing.changed));
    expect(item.textContent).not.toContain(koText.formatMessage(typing.title));
  });
});
