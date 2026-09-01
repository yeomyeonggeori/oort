import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseInline,
  parseMarkdown,
} from "@momo/core/features/timeline/markdown";
import {
  COMPOSER_FORMAT_ITALIC_DISABLED_REASON,
  COMPOSER_FORMAT_LINK_HINT,
  COMPOSER_FORMAT_LINK_HREF,
  composerFormatHasPendingLink,
  composerFormatItemState,
  shouldShowComposerFormatTray,
  toggleComposerFormat,
} from "./composerFormat";
import { readDraft, writeDraft } from "./draftStore";
import { mentionQueryAt } from "./composerAutocomplete";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-0000000000a1";
const NOW = 1_800_000_000_000;

function text(value: string) {
  return { kind: "text" as const, text: value };
}

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

describe("컴포저 서식 토글 (#1902)", () => {
  it("굵게 왕복: 적용 뒤 안쪽을 재선택하고 다시 누르면 해제한다", () => {
    const applied = toggleComposerFormat(
      "배포 롤백",
      { start: 0, end: 5 },
      "bold"
    );
    expect(applied).toEqual({ value: "**배포 롤백**", start: 2, end: 7 });
    expect(parseInline(applied!.value)).toEqual([
      { kind: "strong", children: [text("배포 롤백")] },
    ]);
    expect(
      toggleComposerFormat(applied!.value, { start: 2, end: 7 }, "bold")
    ).toEqual({ value: "배포 롤백", start: 0, end: 5 });
  });

  it("접사가 선택 밖에 있어도 같은 토글로 해제한다", () => {
    expect(
      toggleComposerFormat("**배포 롤백**", { start: 2, end: 7 }, "bold")
    ).toEqual({ value: "배포 롤백", start: 0, end: 5 });
    expect(
      toggleComposerFormat("**배포 롤백**", { start: 0, end: 9 }, "bold")
    ).toEqual({ value: "배포 롤백", start: 0, end: 5 });
  });

  it("기울임·인라인 코드도 왕복하고 렌더러가 읽는 문법만 넣는다", () => {
    const italic = toggleComposerFormat("soon", { start: 0, end: 4 }, "italic");
    expect(italic).toEqual({ value: "*soon*", start: 1, end: 5 });
    expect(parseInline(italic!.value)).toEqual([
      { kind: "em", children: [text("soon")] },
    ]);
    expect(
      toggleComposerFormat(italic!.value, { start: 1, end: 5 }, "italic")
    ).toEqual({ value: "soon", start: 0, end: 4 });

    const code = toggleComposerFormat("sha", { start: 0, end: 3 }, "code");
    expect(code).toEqual({ value: "`sha`", start: 1, end: 4 });
    expect(parseInline(code!.value)).toEqual([{ kind: "code", text: "sha" }]);
    expect(
      toggleComposerFormat(code!.value, { start: 1, end: 4 }, "code")
    ).toEqual({ value: "sha", start: 0, end: 3 });
  });

  it("링크는 [선택](링크주소) 을 넣고 자리표시를 고른 뒤, 같은 토글로 라벨만 남긴다", () => {
    const applied = toggleComposerFormat(
      "런북",
      { start: 0, end: 2 },
      "link"
    );
    const hrefEnd = 5 + COMPOSER_FORMAT_LINK_HREF.length;
    expect(applied).toEqual({
      value: `[런북](${COMPOSER_FORMAT_LINK_HREF})`,
      start: 5,
      end: hrefEnd,
    });
    expect(COMPOSER_FORMAT_LINK_HREF).toBe("링크주소");
    expect(applied!.value.slice(applied!.start, applied!.end)).toBe(
      COMPOSER_FORMAT_LINK_HREF
    );
    expect(composerFormatHasPendingLink(applied!.value)).toBe(true);
    expect(COMPOSER_FORMAT_LINK_HINT).toBe("링크 주소를 채워 보내세요");
    expect(
      toggleComposerFormat(applied!.value, { start: 5, end: hrefEnd }, "link")
    ).toEqual({ value: "런북", start: 0, end: 2 });
    const linked = "[런북](https://momo.example)";
    expect(
      toggleComposerFormat(linked, { start: 0, end: linked.length }, "link")
    ).toEqual({ value: "런북", start: 0, end: 2 });
  });

  it("빈 선택과 공백만 선택은 무동작이다", () => {
    expect(
      toggleComposerFormat("배포", { start: 2, end: 2 }, "bold")
    ).toBeNull();
    expect(
      toggleComposerFormat("배포  롤백", { start: 2, end: 4 }, "bold")
    ).toBeNull();
  });

  it("끝 공백은 선택 안쪽으로 접사를 밀어 넣어 렌더러가 strong 을 읽는다", () => {
    const applied = toggleComposerFormat(
      "배포 일정 확정 그리고",
      { start: 0, end: 9 },
      "bold"
    );
    expect(applied).toEqual({
      value: "**배포 일정 확정** 그리고",
      start: 2,
      end: 10,
    });
    expect(parseInline(applied!.value)).toEqual([
      { kind: "strong", children: [text("배포 일정 확정")] },
      text(" 그리고"),
    ]);
  });

  it("두 줄 선택은 줄마다 감싸 렌더러가 각 줄을 strong 으로 읽는다", () => {
    const body = "첫째 줄입니다\n둘째 줄입니다";
    const applied = toggleComposerFormat(
      body,
      { start: 0, end: body.length },
      "bold"
    );
    expect(applied).toEqual({
      value: "**첫째 줄입니다**\n**둘째 줄입니다**",
      start: 0,
      end: 23,
    });
    expect(parseMarkdown(applied!.value)).toEqual([
      {
        kind: "paragraph",
        lines: [
          [{ kind: "strong", children: [text("첫째 줄입니다")] }],
          [{ kind: "strong", children: [text("둘째 줄입니다")] }],
        ],
      },
    ]);
    expect(
      toggleComposerFormat(
        applied!.value,
        { start: 0, end: applied!.value.length },
        "bold"
      )
    ).toEqual({ value: body, start: 0, end: body.length });
  });

  it("한국어만 있는 기울임은 코어가 렌더하지 않으므로 넣지 않는다", () => {
    const korean = "배포 일정은 금요일에 확정합니다";
    expect(
      toggleComposerFormat(korean, { start: 0, end: korean.length }, "italic")
    ).toBeNull();
    expect(
      composerFormatItemState(korean, { start: 0, end: korean.length }, "italic")
    ).toEqual({
      pressed: false,
      disabled: true,
      disabledReason: COMPOSER_FORMAT_ITALIC_DISABLED_REASON,
    });
    const mixed = toggleComposerFormat(
      "배포는 freeze 상태입니다",
      { start: 0, end: 16 },
      "italic"
    );
    expect(mixed).toEqual({
      value: "*배포는 freeze 상태입니다*",
      start: 1,
      end: 17,
    });
    expect(parseInline(mixed!.value)).toEqual([
      { kind: "em", children: [text("배포는 freeze 상태입니다")] },
    ]);
    expect(
      composerFormatItemState(
        "배포는 freeze 상태입니다",
        { start: 0, end: 16 },
        "italic"
      )
    ).toEqual({
      pressed: false,
      disabled: false,
      disabledReason: null,
    });
  });

  it("기존 접사와 부분만 겹치면 수리하지 않고 감싼다", () => {
    // "*hello*" 에서 "*hel" 만 고른 기울임: 한 겹을 더 넣는다.
    expect(
      toggleComposerFormat("*hello*", { start: 0, end: 4 }, "italic")
    ).toEqual({ value: "**hel*lo*", start: 1, end: 5 });
  });

  it("굵게 런 안의 기울임은 바깥 별을 빼지 않고 겹친다", () => {
    const nested = toggleComposerFormat(
      "**hello**",
      { start: 2, end: 7 },
      "italic"
    );
    expect(nested).toEqual({ value: "***hello***", start: 3, end: 8 });
  });
});

describe("선택 서식 트레이 표시 (#1902)", () => {
  it("선택이 있을 때만 보이고 @ 트리거 중에는 숨긴다", () => {
    expect(
      shouldShowComposerFormatTray({
        value: "배포 롤백",
        start: 0,
        end: 2,
        autocompleteVisible: false,
      })
    ).toBe(true);
    expect(
      shouldShowComposerFormatTray({
        value: "배포 롤백",
        start: 2,
        end: 2,
        autocompleteVisible: false,
      })
    ).toBe(false);
    expect(
      shouldShowComposerFormatTray({
        value: "배포 롤백",
        start: 0,
        end: 2,
        autocompleteVisible: true,
      })
    ).toBe(false);
    expect(mentionQueryAt("@her", 4)).toEqual({ start: 0, text: "her" });
    expect(
      shouldShowComposerFormatTray({
        value: "@her",
        start: 0,
        end: 4,
        autocompleteVisible: false,
      })
    ).toBe(false);
  });
});

describe("서식 적용은 초안 저장 경로를 그대로 쓴다 (#1902)", () => {
  it("토글 결과를 writeDraft 에 넣으면 같은 본문이 복원된다", () => {
    const original = "배포 롤백 근거";
    writeDraft(WS, CH, original, NOW);
    const applied = toggleComposerFormat(
      original,
      { start: 0, end: original.length },
      "bold"
    );
    writeDraft(WS, CH, applied!.value, NOW);
    expect(readDraft(WS, CH, NOW)).toBe("**배포 롤백 근거**");
    const undone = toggleComposerFormat(
      applied!.value,
      { start: applied!.start, end: applied!.end },
      "bold"
    );
    writeDraft(WS, CH, undone!.value, NOW);
    expect(readDraft(WS, CH, NOW)).toBe(original);
  });
});
