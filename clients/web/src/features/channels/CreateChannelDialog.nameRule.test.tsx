// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { channelNameIssue, normalizeChannelName } from "@momo/core/features/channels/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { createAppLocale, type AppLocale } from "@/i18n/localeStore";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import { CreateChannelDialog, type ChannelDraft } from "./CreateChannelDialog";

// 채널 만들기 창의 이름 칸 (#5833, ADR-0225 D13).
//   1. 칸 값은 치는 도중에 바꾸지 않는다(한글 조합이 깨진다). 친 그대로이고, 접는 것은 보낼 때뿐이다.
//   2. 친 것과 저장될 이름이 다를 때만 「#이름 이름으로 만들어져요」 한 줄이 선다. 거절이면 미리보기 대신 오류다.
//   3. 거절 문장은 사전 키로, 화면 언어를 따른다. 낭독(aria-live)은 오류에만 걸린다.
//   4. 조합 중(compositionstart~compositionend)에는 아래 줄이 조합 전의 값에 머문다 — 병음 `ni'h` 같은 조합 글자는 아직 이름이 아니다.
// 높이·y가 움직이지 않는 것은 실제 엔진에서 잰다(`CreateChannelDialog.nameRule.browser.test.ts`).

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

const api = vi.hoisted(() => ({ createChannel: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  createChannel: (...args: unknown[]) => api.createChannel(...args),
}));
vi.mock("@/features/common/useOffline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/common/useOffline")>()),
  useOffline: () => false,
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;
let english: AppLocale;

const session = {
  session: { accessToken: "a", refreshToken: "r", member: { id: ME, workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyeon" } },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
} as unknown as SessionContextValue;

function Host() {
  const [draft, setDraft] = useState<ChannelDraft>({ kind: "public", name: "", topic: "" });
  return createElement(CreateChannelDialog, { open: true, onOpenChange: () => undefined, onCreated: () => undefined, draft, setDraft });
}

async function mount(locale: AppLocale = korean): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(LocaleProvider, { locale, children: createElement(SessionProvider, { value: session, children: createElement(Host) }) })
        )
      )
    );
    await Promise.resolve();
  });
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const input = () => q("create-channel-name") as HTMLInputElement;
const status = () => q("create-channel-name-status")!;
/** 보이는 문장(보이지 않게 겹쳐 둔 자리 예약 층은 aria-hidden이다). */
const visible = () => status().children[1]!.textContent ?? "";
const setValue = (value: string, init: InputEventInit = {}) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input(), value);
    input().dispatchEvent(new InputEvent("input", { bubbles: true, ...init }));
  });
const type = (value: string) => setValue(value);
const composition = (phase: "start" | "end", data = "") =>
  act(async () => {
    input().dispatchEvent(new CompositionEvent(`composition${phase}`, { bubbles: true, data }));
  });
/** 입력기가 지금 조합 중인 글자를 알린다(`compositionupdate`). 칸 값은 `setValue`가 따로 넣는다. */
const update = (data: string) =>
  act(async () => {
    input().dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data }));
  });
/** 조합 중 한 걸음: 입력기가 값을 넣고 조합 글자를 알리는 순서. */
const step = async (value: string, composing: string) => {
  await setValue(value, { inputType: "insertCompositionText", isComposing: true });
  await update(composing);
};
const submit = () =>
  act(async () => {
    q("create-channel-submit")!.click();
    await Promise.resolve();
  });

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
  english = await createAppLocale(
    { readPreference: () => "en-US", writePreference: () => {}, readDevice: () => ({ languages: ["en-US"], timeZone: "UTC" }) },
    { applyLang: () => {} }
  );
});
beforeEach(() => {
  api.createChannel.mockReset();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("칸 값은 치는 도중에 바꾸지 않는다 (D13)", () => {
  it("한글 조합 중에도 칸 값은 입력기가 넣은 그대로이고, 대문자·빈칸도 접지 않는다", async () => {
    await mount();
    await composition("start");
    const steps = ["ㄷ", "디", "디ㅈ", "디자", "디잉", "디자인", "디자인 ", "디자인 ㄹ", "디자인 리", "디자인 릐", "디자인 리뷰"];
    for (const step of steps) {
      await setValue(step, { inputType: "insertCompositionText", isComposing: true });
      expect(input().value).toBe(step);
    }
    await composition("end", "디자인 리뷰");
    expect(input().value).toBe("디자인 리뷰");
    await type("Design Review");
    expect(input().value).toBe("Design Review");
    await type("  Design  Review ");
    expect(input().value).toBe("  Design  Review ");
  });

  it("보낼 때 접은 이름이 나간다", async () => {
    api.createChannel.mockRejectedValue(new ApiError(409, "exists"));
    await mount();
    await type("Design Review");
    await submit();
    expect(api.createChannel).toHaveBeenCalledTimes(1);
    expect(api.createChannel.mock.calls[0]![1]).toMatchObject({ name: "design-review" });
    // 거절이 와도 칸에는 친 그대로가 남는다.
    expect(input().value).toBe("Design Review");

    api.createChannel.mockClear();
    await type("디자인 리뷰");
    await submit();
    expect(api.createChannel.mock.calls[0]![1]).toMatchObject({ name: "디자인-리뷰" });
    expect(input().value).toBe("디자인 리뷰");
  });
});

describe("저장될 이름 미리보기", () => {
  it("친 것과 저장될 이름이 다를 때만 선다", async () => {
    await mount();
    expect(q("create-channel-name-preview")).toBeNull();
    expect(visible()).toContain("글자, 숫자, 하이픈(-), 밑줄(_)로 80자까지");

    await type("디자인 리뷰");
    expect(q("create-channel-name-preview")!.textContent).toBe("#디자인-리뷰 이름으로 만들어져요");
    expect(q("create-channel-name-hint")).toBeNull();

    await type("Design Review");
    expect(q("create-channel-name-preview")!.textContent).toBe("#design-review 이름으로 만들어져요");

    // 이미 접힌 이름은 같은 말을 다시 하지 않는다.
    await type("design-review");
    expect(q("create-channel-name-preview")).toBeNull();
    expect(q("create-channel-name-hint")).not.toBeNull();
    await type("디자인-리뷰");
    expect(q("create-channel-name-preview")).toBeNull();
  });

  it("영어 화면은 영어 문장이고, 이름 자리는 문장 앞뒤 어디든 그대로 선다", async () => {
    await mount(english);
    expect(input().placeholder).toBe("design-review");
    expect(visible()).toContain("Letters, numbers, hyphens (-) and underscores (_), up to 80 characters");
    await type("Design Review");
    expect(q("create-channel-name-preview")!.textContent).toBe("Will be created as #design-review");
  });

  it("자리표시자는 화면 언어의 예이고, 일곱 언어 모두 그대로 쓸 수 있는 이름이다", async () => {
    await mount();
    expect(input().placeholder).toBe("디자인-리뷰");
    const catalogs = import.meta.glob("../../../../../packages/momo-core/src/i18n/catalogs/*/channels.json", { eager: true, import: "default" }) as Record<string, Record<string, string>>;
    const found = Object.entries(catalogs);
    expect(found.length).toBe(7);
    for (const [path, catalog] of found) {
      const example = catalog["channels.nameRule.placeholder"]!;
      expect(channelNameIssue(example), `${path}: ${example}`).toBeNull();
    }
  });
});

describe("거절", () => {
  const cases: [string, string, string][] = [
    ["쓸 수 없는 글자", "a.b", "글자, 숫자, 하이픈(-), 밑줄(_)만 쓸 수 있어요."],
    ["보이지 않는 글자", "ab\u200bcd", "보이지 않는 글자가 들어 있어요. 이름을 지우고 다시 적어 주세요."],
    ["처음·끝 구분자", "-ab", "처음과 끝은 글자나 숫자여야 해요. 하이픈과 밑줄은 가운데에만 쓸 수 있어요."],
    ["80자 넘음", "a".repeat(81), "채널 이름은 80자까지 쓸 수 있어요."],
  ];
  it.each(cases)("%s: 사전 문장이 오류 자리에 서고 미리보기는 서지 않으며, 칸과 aria-describedby로 묶인다", async (_name, value, sentence) => {
    await mount();
    await type(value);
    const error = q("create-channel-name-error")!;
    expect(error.textContent).toBe(sentence);
    expect(q("create-channel-name-preview")).toBeNull();
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toBe(error.id);
    // 낭독은 오류에만 걸린다(polite).
    expect(error.parentElement!.getAttribute("aria-live")).toBe("polite");
    expect(q("create-channel-name-hint")).toBeNull();
  });

  it("빈 이름은 건드리기 전에는 말하지 않고, 보내 보면 말한다", async () => {
    await mount();
    expect(q("create-channel-name-error")).toBeNull();
    await submit();
    expect(q("create-channel-name-error")!.textContent).toBe("채널 이름을 입력해 주세요.");
    expect(api.createChannel).not.toHaveBeenCalled();
  });

  it("미리보기와 안내에는 낭독 영역이 없다(조합 중 글자마다 읽지 않는다)", async () => {
    await mount();
    await type("Design Review");
    const preview = q("create-channel-name-preview")!;
    expect(preview.closest("[aria-live]")).toBeNull();
    expect(input().getAttribute("aria-describedby")).toBe("create-channel-name-preview");
    await type("");
    expect(q("create-channel-name-hint")!.closest("[aria-live]")).toBeNull();
    expect(input().getAttribute("aria-describedby")).toBe("create-channel-name-hint");
  });

  it("서버의 400·409는 같은 오류 자리에 선다", async () => {
    await mount();
    await type("ops-room");
    api.createChannel.mockRejectedValueOnce(new ApiError(409, "exists"));
    await submit();
    expect(q("create-channel-name-error")!.textContent).toBe("같은 이름의 채널이 이미 있습니다. 다른 이름으로 다시 시도하세요.");
    expect(input().getAttribute("aria-describedby")).toBe("create-channel-name-error");

    await type("ops-room2");
    expect(q("create-channel-name-error")).toBeNull();
    api.createChannel.mockRejectedValueOnce(new ApiError(400, "bad"));
    await submit();
    expect(q("create-channel-name-error")!.textContent).toBe("서버가 이 이름을 받지 않았어요. 글자, 숫자, -, _만 쓸 수 있어요.");
  });
});

describe("조합 중인 글자가 아직 글자가 아니면 아래 줄은 조합 전의 값에 머문다", () => {
  it("병음 조합 글자(`ni'h`)는 거절하지 않고, 조합이 끝나면 그 이름을 말한다", async () => {
    await mount();
    await composition("start");
    for (const text of ["n", "ni", "ni'", "ni'h"]) {
      await step(text, text);
      expect(input().value).toBe(text);
      expect(q("create-channel-name-error")).toBeNull();
      expect(q("create-channel-name-preview")).toBeNull();
      expect(q("create-channel-name-hint")).not.toBeNull();
    }
    await step("你好", "你好");
    await composition("end", "你好");
    expect(input().value).toBe("你好");
    expect(q("create-channel-name-error")).toBeNull();
    // 확정된 뒤에 거절될 값이면 그때 말한다.
    await type("ni'h");
    expect(q("create-channel-name-error")).not.toBeNull();
  });

  it("변환 전 가나도 조합 전 줄에 머물고, 확정되면 저장될 이름을 말한다", async () => {
    await mount();
    await type("team");
    await composition("start");
    for (const text of ["で", "でざ", "でざいん"]) {
      await step(`team ${text}`, text);
      expect(q("create-channel-name-error")).toBeNull();
      expect(q("create-channel-name-preview")).toBeNull();
      expect(q("create-channel-name-hint")).not.toBeNull();
    }
    await composition("end", "設計");
    await type("team 設計");
    expect(q("create-channel-name-preview")!.textContent).toBe("#team-設計 이름으로 만들어져요");
  });

  it("병음 조합 중에는 미리보기가 조합 전 이름에 머문다", async () => {
    await mount();
    await type("design");
    await composition("start");
    await step("design ni", "ni");
    expect(q("create-channel-name-hint")).not.toBeNull();
    expect(q("create-channel-name-preview")).toBeNull();
    await step("design 你好", "你好");
    await composition("end", "你好");
    expect(q("create-channel-name-preview")!.textContent).toBe("#design-你好 이름으로 만들어져요");
  });
});

describe("한글은 조합 중인 음절이 곧 친 글자라서 아래 줄이 칸 값을 그대로 따라간다 (검수 r1 H1)", () => {
  // 2벌식으로 `디자인 리뷰`를 치는 17걸음: [칸 값, 조합 중인 글자(조합이 아닐 때는 null)]. 마지막 음절 `뷰`는 확정 전이다.
  const STEPS: [string, string | null][] = [
    ["ㄷ", "ㄷ"], ["디", "디"], ["딪", "딪"], ["디자", "자"], ["디잔", "잔"], ["디자니", "니"], ["디자인", "인"],
    ["디자인 ", null], ["디자인 ㄹ", "ㄹ"], ["디자인 리", "리"], ["디자인 립", "립"], ["디자인 리ㅂ", "ㅂ"], ["디자인 리뷰", "뷰"],
  ];
  const expected = (value: string) => {
    const folded = normalizeChannelName(value);
    return folded !== value ? `#${folded} 이름으로 만들어져요` : null;
  };

  it("걸음마다 아래 줄 = 그때 칸 값을 접은 이름이고, 다 치고 멈춘 화면도 `#디자인-리뷰`다", async () => {
    await mount();
    let composing = false;
    const seen: string[] = [];
    for (const [value, text] of STEPS) {
      if (text === null) {
        await composition("end");
        composing = false;
        await type(value);
      } else {
        if (!composing) {
          await composition("start");
          composing = true;
        }
        await step(value, text);
      }
      expect(input().value).toBe(value);
      expect(q("create-channel-name-error"), `${value}: 조합 중 거절 없음`).toBeNull();
      const want = expected(value);
      expect(q("create-channel-name-preview")?.textContent ?? null, `「${value}」`).toBe(want);
      if (want === null) expect(q("create-channel-name-hint")).not.toBeNull();
      seen.push(`${value}→${q("create-channel-name-preview")?.textContent ?? "안내"}`);
    }
    // 마지막 음절이 확정되지 않은 채 멈춘 화면.
    expect(composing).toBe(true);
    expect(q("create-channel-name-preview")!.textContent).toBe("#디자인-리뷰 이름으로 만들어져요");
    expect(input().getAttribute("aria-describedby")).toBe("create-channel-name-preview");
    expect(seen.length).toBe(STEPS.length);
  });

  it("81번째 음절이 조합 중이어도 「80자까지」 거절이 선다", async () => {
    await mount();
    await type("가".repeat(80));
    expect(q("create-channel-name-error")).toBeNull();
    await composition("start");
    await step("가".repeat(80) + "ㄴ", "ㄴ");
    expect(q("create-channel-name-error")!.textContent).toBe("채널 이름은 80자까지 쓸 수 있어요.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });

  it("한글 조합 중 미리보기는 낭독 영역 밖이다(음절마다 읽지 않는다)", async () => {
    await mount();
    await composition("start");
    await step("디자인 리뷰", "뷰");
    expect(q("create-channel-name-preview")!.closest("[aria-live]")).toBeNull();
  });
});
