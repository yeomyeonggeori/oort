// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMessageService,
  loadMessageCatalog,
  type LocaleService,
} from "@momo/core/i18n";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { TypingLine } from "./TypingLine";
import { typingLineParts } from "./typingLineParts";

// =============================================================================
// 「입력 중」 줄 (#5567): 카드 아래 늘 잡아 둔 한 줄, 문구는 ko/en 사전, 잘리는 것은 이름(조사째)이고 서술어는 안 잘린다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const A = "00000000-0000-7000-8000-000000000102";
const B = "00000000-0000-7000-8000-000000000103";
const C = "00000000-0000-7000-8000-000000000104";

function human(id: string, displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    role: "member",
    displayName,
    handle,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const directory = makeDirectory([
  human(A, "한지후", "jihu"),
  human(B, "오민재", "minjae"),
  human(C, "서하윤", "hayun"),
]);

let ko: LocaleService["formatMessage"];
let en: LocaleService["formatMessage"];
let korean: AppLocale;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ko = createMessageService({ messageLocale: "ko-KR", catalog: await loadMessageCatalog("ko-KR") }).formatMessage;
  en = createMessageService({ messageLocale: "en-US", catalog: await loadMessageCatalog("en-US") }).formatMessage;
  korean = await koreanLocaleForTest();
});

afterEach(() => cleanup());

const joined = (parts: ReturnType<typeof typingLineParts>) =>
  parts === null ? null : `${parts.before}${parts.name}${parts.attached}${parts.tail}`;

describe("typingLineParts — 사전 문장을 이름(조사째) | 서술어로 나눈다", () => {
  it("한 사람: 「○○님이 입력 중…」, 조사 「님이」는 이름 편에 남고 꼬리는 빈칸으로 시작하는 서술어다", () => {
    const parts = typingLineParts(ko, ["한지후"]);
    expect(joined(parts)).toBe("한지후님이 입력 중…");
    expect(parts).toMatchObject({ before: "", name: "한지후", attached: "님이", tail: " 입력 중…" });
    // 보조기술 문장은 온전하고 말줄임표가 없다.
    expect(parts?.label).toBe("한지후님이 입력 중");
  });

  it("여러 명: 「○○님 외 N명이 입력 중…」(둘부터 뭉친다), 숫자는 꼬리에 있다", () => {
    const two = typingLineParts(ko, ["한지후", "오민재"]);
    expect(joined(two)).toBe("한지후님 외 1명이 입력 중…");
    expect(two).toMatchObject({ name: "한지후", attached: "님", tail: " 외 1명이 입력 중…" });
    const three = typingLineParts(ko, ["한지후", "오민재", "서하윤"]);
    expect(joined(three)).toBe("한지후님 외 2명이 입력 중…");
    expect(three?.label).toBe("한지후님 외 2명이 입력 중");
    // 뒤 사람들의 이름은 보이는 줄에 서지 않는다.
    expect(joined(three)).not.toContain("오민재");
  });

  it("영어 사전도 같은 구조로 나뉜다: 이름 | 「 is typing…」, 복수형은 ICU가 정한다", () => {
    expect(typingLineParts(en, ["Jihu"])).toMatchObject({ name: "Jihu", attached: "", tail: " is typing…" });
    expect(joined(typingLineParts(en, ["Jihu", "Minjae"]))).toBe("Jihu and 1 other are typing…");
    expect(joined(typingLineParts(en, ["Jihu", "Minjae", "Hayun"]))).toBe("Jihu and 2 others are typing…");
  });

  it("아무도 없으면 문장이 없다", () => {
    expect(typingLineParts(ko, [])).toBeNull();
  });

  it("번역에 이름 자리가 없으면 문장 하나가 통째로 줄어드는 쪽에 선다(꼬리가 넘치지 않는다)", () => {
    const noSlot = (() => "누군가 입력 중…") as unknown as LocaleService["formatMessage"];
    expect(typingLineParts(noSlot, ["한지후"])).toMatchObject({ before: "누군가 입력 중…", name: "", tail: "" });
  });
});

describe("<TypingLine> — 늘 잡아 둔 한 줄", () => {
  function mount(memberIds: string[]) {
    return render(
      createElement(LocaleProvider, { locale: korean }, createElement(TypingLine, { memberIds, directory }))
    );
  }

  it("아무도 치지 않아도 줄 상자는 서 있고 안은 비어 있다(나타날 때 아무것도 밀지 않는다)", () => {
    const view = mount([]);
    const box = view.getByTestId("typing-line");
    expect(box.className).toBe("typing-line");
    expect(box.dataset.state).toBe("off");
    expect(box.textContent).toBe("");
    expect(view.queryByTestId("composer-typing")).toBeNull();
  });

  it("한 사람이 치면 같은 상자 안에 문장이 선다: 굵은 이름 · 사람 색 점 · sr-only 문장 · aria-hidden 조각", () => {
    const view = mount([]);
    const box = view.getByTestId("typing-line");
    act(() =>
      view.rerender(
        createElement(LocaleProvider, { locale: korean }, createElement(TypingLine, { memberIds: [A], directory }))
      )
    );
    expect(view.getByTestId("typing-line")).toBe(box);
    expect(box.dataset.state).toBe("on");
    const line = view.getByTestId("composer-typing");
    expect(line.dataset.count).toBe("1");
    const lead = view.getByTestId("composer-typing-lead");
    const tail = view.getByTestId("composer-typing-tail");
    expect(`${lead.textContent}${tail.textContent}`).toBe("한지후님이 입력 중…");
    expect(lead.getAttribute("aria-hidden")).toBe("true");
    expect(tail.getAttribute("aria-hidden")).toBe("true");
    expect(lead.querySelector(".font-bold.text-ink")?.textContent).toBe("한지후");
    expect(view.getByTestId("composer-typing-label").textContent).toBe("한지후님이 입력 중");
    expect(line.closest("[aria-live]")).toBeNull();
    const dots = view.getByTestId("responding-dots");
    expect(dots.dataset.human).toBe("");
    expect(dots.querySelectorAll(".bg-ink-muted")).toHaveLength(3);
    expect(dots.querySelectorAll(".bg-agent")).toHaveLength(0);
  });

  it("명부에 없는 사람은 그리지 않는다(이름 없는 「누군가」는 정보가 0이다)", () => {
    const view = mount(["00000000-0000-7000-8000-0000000009ff"]);
    expect(view.getByTestId("typing-line").dataset.state).toBe("off");
  });
});
