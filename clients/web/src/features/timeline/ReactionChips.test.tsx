// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { compile } from "tailwindcss";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import type { ReactionChip } from "@momo/core/features/timeline/reactions";
import {
  REACTION_ADD_HINT,
  REACTION_REMOVE_HINT,
  REACTION_SELF_LABEL,
} from "@momo/core/features/timeline/reactionNames";
import { resetEmojiFrequencyForTests } from "@/features/emoji/frequencyStore";
import {
  MessageHoverToolbar,
  type MessageActionCallbacks,
} from "./MessageActions";
import { HOVER_TOOLBAR_REACTION_SEED } from "./hoverToolbarModel";
import { ReactionChips } from "./ReactionChips";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "11111111-2222-3333-4444-555555555555";
const MINJUN = "aaaaaaaa-bbbb-cccc-dddd-000000000001";
const SEOYEON = "aaaaaaaa-bbbb-cccc-dddd-000000000002";

function member(
  over: Partial<RosterMember> & { id: string; displayName: string; handle: string }
): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const DIRECTORY = makeDirectory([
  member({ id: ME, displayName: "데모 사용자", handle: "demo" }),
  member({ id: MINJUN, displayName: "김민준", handle: "minjun" }),
  member({ id: SEOYEON, displayName: "이서연", handle: "seoyeon" }),
]);

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(node);
  });
  return host;
}

describe("ReactionChips", () => {
  it("renders nothing when there are no chips, so the row keeps its rhythm", () => {
    const root = mount(
      createElement(ReactionChips, {
        chips: [],
        directory: DIRECTORY,
        myMemberId: ME,
        onToggle: () => undefined,
      })
    );
    expect(root.querySelector("[data-testid='reaction-chips']")).toBeNull();
  });

  it("exposes names on hover (title) and keyboard focus, and keeps the toggle", () => {
    const onToggle = vi.fn();
    const chips: ReactionChip[] = [
      {
        emoji: "👍",
        count: 2,
        mine: true,
        memberIds: [ME, MINJUN],
      },
    ];
    const root = mount(
      createElement(ReactionChips, {
        chips,
        directory: DIRECTORY,
        myMemberId: ME,
        onToggle,
        onOpenPicker: () => undefined,
      })
    );
    const chip = root.querySelector<HTMLButtonElement>(
      "[data-testid='reaction-chip']"
    );
    expect(chip).not.toBeNull();
    if (!chip) throw new Error("missing chip");

    const names = `${REACTION_SELF_LABEL}(${REACTION_REMOVE_HINT}), 김민준`;
    expect(chip.getAttribute("title")).toBe(names);
    expect(chip.getAttribute("aria-label")).toBe(`👍 반응 2개, ${names}`);
    expect(chip.getAttribute("data-row-action")).toBe("");
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(chip.getAttribute("title")).toBe(names);

    act(() => {
      chip.focus();
    });
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute("title")).toBe(names);
    expect(chip.getAttribute("aria-label")).toBe(`👍 반응 2개, ${names}`);

    act(() => {
      chip.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("👍");

    const add = root.querySelector("[data-testid='reaction-add']");
    expect(add).not.toBeNull();
    expect(add?.getAttribute("data-row-action")).toBe("");
  });

  it("names other reactors and keeps the add hint on a chip that is not mine", () => {
    const chips: ReactionChip[] = [
      {
        emoji: "🎉",
        count: 2,
        mine: false,
        memberIds: [MINJUN, SEOYEON],
      },
    ];
    const root = mount(
      createElement(ReactionChips, {
        chips,
        directory: DIRECTORY,
        myMemberId: ME,
        onToggle: () => undefined,
      })
    );
    const chip = root.querySelector("[data-testid='reaction-chip']");
    expect(chip?.getAttribute("title")).toBe("김민준, 이서연");
    expect(chip?.getAttribute("aria-label")).toBe(
      `🎉 반응 2개, 김민준, 이서연, ${REACTION_ADD_HINT}`
    );
    expect(chip?.getAttribute("aria-pressed")).toBe("false");
  });
});

// =============================================================================
// 반응 칩 Buzz 기준 (#4879, owner 2026-10-31)
//
// 알약 · 보이는 높이 28 · 이모지 16 · 숫자 13 굵게. 내가 단 칩은 강조 바탕 + 1px 강조 테두리 + 강조색
// 숫자, 안 단 칩은 흐린 바탕 + 테두리 없음 + `ink-muted` 숫자. 색만으로 가르지 않는다(테두리 유무 +
// `aria-pressed`). 빠른 반응(호버 막대)은 내가 단 이모지에도 바탕을 칠하지 않는다.
//
// jsdom은 스타일시트를 읽지 않으므로 클래스 단정만으로는 「클래스가 실제 규칙이 되는가」「그 값이
// 28·16·13·44인가」를 재지 못한다. 그래서 같은 클래스를 Tailwind에 실제로 컴파일해(`tokens.css` 그대로)
// 규칙이 있는지, 읽는 토큰이 몇 px인지 잰다 — 클래스 오타가 조용히 아무것도 안 그리는 일을 막는다.
// =============================================================================

const MINE_CHIP: ReactionChip = {
  emoji: "👍",
  count: 2,
  mine: true,
  memberIds: [ME, MINJUN],
};
const OTHER_CHIP: ReactionChip = {
  emoji: "🎉",
  count: 12,
  mine: false,
  memberIds: [MINJUN, SEOYEON],
};

function classesOf(el: Element | null): string[] {
  if (!el) throw new Error("요소가 없다");
  return Array.from(el.classList);
}

function mountChipRow() {
  const root = mount(
    createElement(ReactionChips, {
      chips: [MINE_CHIP, OTHER_CHIP],
      directory: DIRECTORY,
      myMemberId: ME,
      onToggle: () => undefined,
      onOpenPicker: () => undefined,
    })
  );
  const mine = root.querySelector<HTMLButtonElement>(
    "[data-testid='reaction-chip'][data-mine='true']"
  );
  const other = root.querySelector<HTMLButtonElement>(
    "[data-testid='reaction-chip'][data-mine='false']"
  );
  const add = root.querySelector<HTMLButtonElement>("[data-testid='reaction-add']");
  if (!mine || !other || !add) throw new Error("칩 줄이 그려지지 않았다");
  return { mine, other, add };
}

const numberOf = (chip: Element) => chip.querySelector("[data-numeric]");
const emojiOf = (chip: Element) => chip.firstElementChild;

/** 두 클래스 목록이 서로 다른 토큰 전부(대칭차). */
function differingTokens(a: string[], b: string[]): Set<string> {
  const left = new Set(a);
  const right = new Set(b);
  return new Set([
    ...a.filter((token) => !right.has(token)),
    ...b.filter((token) => !left.has(token)),
  ]);
}

describe("ReactionChips: Buzz 기준 모양 (#4879)", () => {
  it("내가 단 칩: 강조 바탕 + 1px 강조 테두리 + 강조색 글자(숫자), aria-pressed=true", () => {
    const { mine } = mountChipRow();
    const own = classesOf(mine);
    expect(own).toContain("border");
    expect(own).toContain("border-accent");
    expect(own).toContain("bg-accent-soft");
    expect(own).not.toContain("border-transparent");
    expect(own).not.toContain("bg-surface-muted");
    // 숫자 색은 칩(버튼)의 글자색이고 숫자 칸은 그것을 물려받는다(자기 색 클래스가 없다).
    expect(own).toContain("text-signal-text");
    expect(own).not.toContain("text-ink-muted");
    // `text-accent`는 글자에 쓰지 않는다(--signal은 3:1 비텍스트 색, 글자는 --signal-text).
    expect(own).not.toContain("text-accent");
    expect(
      classesOf(numberOf(mine)).filter((token) => /^text-(ink|signal|accent)/.test(token))
    ).toEqual([]);
    expect(mine.getAttribute("aria-pressed")).toBe("true");
  });

  it("안 단 칩: 흐린 바탕 + 테두리 없음 + ink-muted 글자(숫자), aria-pressed=false", () => {
    const { other } = mountChipRow();
    const own = classesOf(other);
    // 「테두리 없음」은 투명 1px이다: 보이는 테두리 색이 하나도 없다.
    expect(own).toContain("border-transparent");
    expect(own.filter((token) => /^border-(accent|line)/.test(token))).toEqual([]);
    expect(own).toContain("bg-surface-muted");
    expect(own).not.toContain("bg-accent-soft");
    expect(own).toContain("text-ink-muted");
    expect(own).not.toContain("text-signal-text");
    expect(
      classesOf(numberOf(other)).filter((token) => /^text-(ink|signal|accent)/.test(token))
    ).toEqual([]);
    expect(other.getAttribute("aria-pressed")).toBe("false");
  });

  it("두 상태의 상자는 같다: 갈리는 클래스는 색 여덟 개뿐이라 눌러 바꿔도 이웃이 밀리지 않는다", () => {
    const { mine, other } = mountChipRow();
    expect(
      differingTokens(classesOf(mine), classesOf(other))
    ).toEqual(
      new Set([
        "border-accent",
        "bg-accent-soft",
        "text-signal-text",
        "active:bg-surface-pressed",
        "border-transparent",
        "bg-surface-muted",
        "text-ink-muted",
        "hover:bg-surface-hover",
      ])
    );
    // 숫자 칸은 두 칩이 클래스까지 같다(색은 칩이 정해 물려준다).
    expect(
      differingTokens(
        classesOf(numberOf(mine)),
        classesOf(numberOf(other))
      )
    ).toEqual(new Set());
  });

  it("알약 · 28 높이 · 이모지 16 역할 · 숫자 13 굵게 · 누르는 영역 tap-target", () => {
    const { mine, other } = mountChipRow();
    for (const chip of [mine, other]) {
      const own = classesOf(chip);
      expect(own).toEqual(
        expect.arrayContaining([
          "rounded-full",
          "h-control-sm",
          "tap-target",
          "press",
        ])
      );
      expect(own).not.toContain("rounded-sm");
      expect(classesOf(emojiOf(chip))).toContain("text-heading");
      expect(classesOf(numberOf(chip))).toEqual(
        expect.arrayContaining(["text-code", "font-semibold"])
      );
    }
  });

  it("더하기 버튼: 칩과 같은 높이 토큰의 원, 흐린 바탕, 테두리 없음, tap-target", () => {
    const { add } = mountChipRow();
    const own = classesOf(add);
    expect(own).toEqual(
      expect.arrayContaining([
        "rounded-full",
        "size-control-sm",
        "bg-surface-muted",
        "tap-target",
        "press",
      ])
    );
    expect(own.filter((token) => token === "border" || token.startsWith("border-"))).toEqual(
      []
    );
    expect(own).not.toContain("rounded-sm");
  });
});

// -----------------------------------------------------------------------------
// 실측: 칩이 쓰는 클래스를 `tokens.css` 그대로 컴파일한다.
// -----------------------------------------------------------------------------

// jsdom 환경에서는 `import.meta.url`이 file: 주소가 아니다 — 이 레포의 다른 jsdom 시험처럼 `process.cwd()`(= clients/web)에서 잡는다.
const DESIGN_DIR = resolve(process.cwd(), "src/design");
const TOKENS_CSS = readFileSync(`${DESIGN_DIR}/tokens.css`, "utf8");
const requireFromHere = createRequire(`${process.cwd()}/package.json`);

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = requireFromHere.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(TOKENS_CSS, { base: DESIGN_DIR, loadStylesheet });
  return compiler.build(candidates).replace(/\s+/g, " ");
}

/** 컴파일된 CSS 안의 선택자 글자(`hover:x`는 `.hover\:x`)를 정규식 조각으로 만든다. */
function selectorPattern(className: string): string {
  const cssSelector = `.${className.replace(/[^\w-]/g, (c) => `\\${c}`)}`;
  return cssSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 변형 없는 유틸리티 한 줄의 선언부. 없으면 빈 문자열. */
function declarationsOf(css: string, className: string): string {
  const match = css.match(new RegExp(`${selectorPattern(className)} \\{([^}]*)\\}`));
  return match ? match[1].trim() : "";
}

/** 그 클래스가 어떤 규칙의 선택자로든 컴파일 결과에 있는가(변형 포함). */
function hasRule(css: string, className: string): boolean {
  return new RegExp(`${selectorPattern(className)}(?![\\w-])`).test(css);
}

/** `--name: <n>px;` 의 n. */
function tokenPx(name: string): number {
  const match = TOKENS_CSS.match(new RegExp(`${name}:\\s*([\\d.]+)px`));
  if (!match) throw new Error(`${name} 이 px로 정의되어 있지 않다`);
  return Number(match[1]);
}

/** `--name: calc(var(--type-rem) * m)` 의 m × 16(기본 글자 크기 1rem). */
function roleFontPx(name: string): number {
  const match = TOKENS_CSS.match(
    new RegExp(`${name}:\\s*calc\\(var\\(--type-rem\\) \\* ([\\d.]+)\\)`)
  );
  if (!match) throw new Error(`${name} 이 역할 크기로 정의되어 있지 않다`);
  return Number(match[1]) * 16;
}

describe("ReactionChips: 클래스가 실제 규칙이 되고 값이 28 · 16 · 13 · 44다 (#4879)", () => {
  it("쓴 클래스는 전부 규칙이 있고, 칩이 읽는 토큰이 목표 값이다", async () => {
    const { mine, other, add } = mountChipRow();
    const used = new Set<string>();
    for (const el of [
      mine,
      other,
      add,
      numberOf(mine),
      numberOf(other),
      emojiOf(mine),
      emojiOf(other),
    ]) {
      for (const token of classesOf(el)) used.add(token);
    }
    const css = await buildCss([...used]);
    // 오타·없는 토큰은 규칙이 0개다 — jsdom은 그것을 모른다.
    expect([...used].filter((token) => !hasRule(css, token))).toEqual([]);

    // 보이는 높이: 칩은 `h-control-sm`, 더하기는 `size-control-sm` — 같은 토큰을 읽고 그 값이 26~28이다.
    expect(declarationsOf(css, "h-control-sm")).toBe(
      "height: var(--spacing-control-sm);"
    );
    expect(declarationsOf(css, "size-control-sm")).toBe(
      "width: var(--spacing-control-sm); height: var(--spacing-control-sm);"
    );
    const height = tokenPx("--spacing-control-sm");
    expect(height).toBeGreaterThanOrEqual(26);
    expect(height).toBeLessThanOrEqual(28);

    // 글자: 이모지 16(`text-heading`), 숫자 13(`text-code`) 굵게(600).
    expect(declarationsOf(css, "text-heading")).toContain(
      "font-size: var(--text-heading);"
    );
    expect(declarationsOf(css, "text-code")).toContain(
      "font-size: var(--text-code);"
    );
    expect(roleFontPx("--text-heading")).toBe(16);
    expect(roleFontPx("--text-code")).toBe(13);
    expect(declarationsOf(css, "font-semibold")).toContain(
      "font-weight: var(--font-weight-semibold);"
    );
    expect(css).toContain("--font-weight-semibold: 600;");

    // 테두리: 1px, 내 칩은 강조색, 안 단 칩은 투명.
    expect(declarationsOf(css, "border")).toContain("border-width: 1px;");
    expect(declarationsOf(css, "border-accent")).toBe("border-color: var(--accent);");
    expect(declarationsOf(css, "border-transparent")).toBe("border-color: transparent;");
    expect(declarationsOf(css, "rounded-full")).toContain("border-radius: calc(infinity * 1px);");
  });

  it("600px 아래 누르는 영역은 44px이고, 칩과 더하기 둘 다 그 유틸을 든다", async () => {
    const { mine, other, add } = mountChipRow();
    for (const el of [mine, other, add]) {
      expect(classesOf(el)).toContain("tap-target");
    }
    const css = await buildCss(["tap-target"]);
    expect(css).toMatch(
      /@media \(width < 600px\) \{ \.tap-target \{ min-block-size: var\(--tap-target\); min-inline-size: var\(--tap-target\); \} \}/
    );
    expect(tokenPx("--tap-target")).toBe(44);
  });
});

// -----------------------------------------------------------------------------
// 빠른 반응(호버 막대): 내가 단 이모지에도 바탕색을 칠하지 않는다 — owner 2026-10-31.
// -----------------------------------------------------------------------------

describe("빠른 반응: 내가 단 이모지는 색을 칠하지 않는다 (#4879)", () => {
  const AVAILABLE: MessageActionAvailability = {
    reply: true,
    quote: true,
    react: true,
    pin: true,
    remind: true,
    edit: true,
    delete: true,
  };
  const COPY_STATE = {
    canCopy: true,
    copied: false,
    canCopyLink: true,
    copiedLink: false,
    pinned: false,
  };

  // 슬롯 순서가 시드(👍 ✅ 🙏) 그대로이게 한다. 정리는 마운트 전에만 한다 — 마운트된 막대가 남은 채
  // 저장소를 비우면 act 밖의 갱신이 된다(앞 시험이 누른 이모지의 빈도는 다음 시험의 beforeEach가 지운다).
  beforeEach(() => resetEmojiFrequencyForTests());

  function mountToolbar(mineEmojis: string[], onReact: (emoji: string) => void) {
    const callbacks: MessageActionCallbacks = {
      onReply: () => undefined,
      onQuote: () => undefined,
      onCopy: () => undefined,
      onCopyLink: () => undefined,
      onReact,
      onPin: () => undefined,
      onRemind: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
    };
    const root = mount(
      createElement(MessageHoverToolbar, {
        available: AVAILABLE,
        copyState: COPY_STATE,
        callbacks,
        onOpenPicker: () => undefined,
        menuOpen: false,
        onMenuOpenChange: () => undefined,
        mineEmojis: new Set(mineEmojis),
      })
    );
    const [first, second] = HOVER_TOOLBAR_REACTION_SEED;
    const slot = (emoji: string) => {
      const el = root.querySelector<HTMLButtonElement>(
        `[data-testid="toolbar-react-${emoji}"]`
      );
      if (!el) throw new Error(`${emoji} 슬롯이 없다`);
      return el;
    };
    return { mine: slot(first), other: slot(second), first, second };
  }

  it("내가 단 이모지에도 바탕 클래스가 없고, 안 단 것과 같은 모양이다", () => {
    const { mine, other } = mountToolbar(
      [HOVER_TOOLBAR_REACTION_SEED[0]],
      () => undefined
    );
    for (const button of [mine, other]) {
      // 변형 없는 `bg-*`(= 가만히 있을 때 칠해지는 바탕)가 하나도 없다.
      expect(classesOf(button).filter((token) => /^bg-/.test(token))).toEqual([]);
    }
    expect(mine.className).toBe(other.className);
  });

  it("바탕을 없애도 aria-pressed와 라벨이 상태를 말하고, 누르면 반응 콜백이 간다", async () => {
    const onReact = vi.fn();
    const { mine, other, first, second } = mountToolbar([HOVER_TOOLBAR_REACTION_SEED[0]], onReact);
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    expect(mine.getAttribute("aria-label")).toBe(`${first} 반응 취소`);
    expect(other.getAttribute("aria-pressed")).toBe("false");
    expect(other.getAttribute("aria-label")).toBe(`${second} 반응 남기기`);
    await act(async () => {
      mine.click();
    });
    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onReact).toHaveBeenCalledWith(first);
  });
});
