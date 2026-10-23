// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import { AVATAR_EDITOR_COPY } from "@momo/core/features/workspace/avatarEditor";
import { avatarBackgroundHex } from "@momo/core/features/workspace/avatarPalette";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { resetEmojiFrequencyForTests } from "@/features/emoji/frequencyStore";
import { resetEmojiSkinToneForTests } from "@/features/emoji/skinToneStore";
import type { CatalogEmoji } from "@/features/emoji/catalog";
import { AvatarEditorDialog, type AvatarEditorDialogProps } from "./AvatarEditorDialog";
import { BRIGHT_GLYPH, DARK_GLYPH, fakeAvatarPorts, sameBytes, type FakeAvatarPortsOptions } from "./avatarTestKit";

// =============================================================================
// 아바타 편집기 대화상자 (#4261). 그림판은 가짜 포트(jsdom 에는 캔버스가 없다)이고, 서버로 가는 길(`uploadMyAvatar`,
// `removeMyAvatar`)은 모의다. 진짜 캔버스에서의 그림은 `canvasPorts.browser.test.ts` 가 잰다.
//
// 이 파일이 못 박는 것:
//   · 이모지·코메토는 **포트가 구운 PNG 그대로** `avatar.png`(image/png)로 올라간다(그려 올린 PNG 가 정본).
//   · 판정이 막는 조합은 서버를 부르지 않는다. 화면의 판정이 낡았어도 저장 길이 한 번 더 막는다.
//   · 「기본으로 되돌리기」는 `removeMyAvatar` 하나이고 업로드가 아니다.
//   · 사진은 고른 파일 그대로 올라가고(변환 없음), 서버 코드마다 다른 문구가 선다.
// 이름은 가상 인물이다(이도현·박서연).
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const NOW = 1_800_000_000_000;

const upload = vi.hoisted(() => vi.fn());
const removeMyAvatar = vi.hoisted(() => vi.fn());
const catalog = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../uploadMyAvatar", () => ({ uploadMyAvatar: (...a: unknown[]) => upload(...a) }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    removeMyAvatar: (...a: unknown[]) => removeMyAvatar(...a),
    fetchMemberAvatar: async () => new Blob(["x"]),
  };
});
vi.mock("@/features/emoji/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/emoji/catalog")>();
  return { ...actual, loadCatalog: () => catalog.load() };
});

const entry = (glyph: string, name: string): CatalogEmoji => ({
  glyph,
  name,
  shortcodes: [name],
  keywords: [name],
  category: "objects",
});
const CATALOG: CatalogEmoji[] = [entry("🚀", "rocket"), entry("🔥", "fire"), entry("👍", "thumbsup")];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;
const memory = new Map<string, string>();

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type: string, init?: MouseEventInit) {
        super(type, init);
      }
    } as unknown as typeof PointerEvent;
  }
});

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  resetEmojiFrequencyForTests();
  resetEmojiSkinToneForTests();
  catalog.load.mockReset().mockResolvedValue(CATALOG);
  upload.mockReset().mockResolvedValue({
    id: "m",
    memberId: MEMBER_ID,
    status: "ready",
    avatarUrl: `/v1/workspaces/${WS}/members/${MEMBER_ID}/avatar/content?v=m`,
  });
  removeMyAvatar.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function me(avatarUrl?: string): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이도현",
    handle: "dohyun",
    ...(avatarUrl ? { avatarUrl } : {}),
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const HAS_AVATAR = `/v1/workspaces/${WS}/members/${MEMBER_ID}/avatar/content?v=old`;

// 색 글자를 소스에 적지 않는다(raw_color 게이트): 팔레트 표(`avatarBackgroundHex`)나 채널 값으로 만든다.
const hash = (digits: string) => `#${digits}`;
const channelHex = (r: number, g: number, b: number) =>
  hash([r, g, b].map((value) => value.toString(16).padStart(2, "0")).join(""));
const FREE_DARK = channelHex(26, 26, 46); // 남색과 다른, 어두운 자유 색
const FREE_YELLOW = channelHex(255, 231, 92); // 노란 바탕
const FREE_NIGHT = channelHex(16, 24, 40); // 밝은 그림이 서는 어두운 자유 색

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: MEMBER_ID, workspaceId: WS, kind: "human", displayName: "이도현", handle: "dohyun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

interface Mounted {
  kit: ReturnType<typeof fakeAvatarPorts>;
  onOpenChange: ReturnType<typeof vi.fn>;
  onDone: ReturnType<typeof vi.fn>;
  onBusyChange: ReturnType<typeof vi.fn>;
}

async function mountEditor(
  options: { member?: RosterMember; ports?: FakeAvatarPortsOptions; props?: Partial<AvatarEditorDialogProps> } = {}
): Promise<Mounted> {
  const kit = fakeAvatarPorts(options.ports);
  const onOpenChange = vi.fn();
  const onDone = vi.fn();
  const onBusyChange = vi.fn();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        SessionProvider,
        { value: sessionValue(), children: undefined },
        createElement(
          QueryClientProvider,
          { client },
          createElement(AvatarEditorDialog, {
            open: true,
            onOpenChange,
            workspaceId: WS,
            me: options.member ?? me(),
            offline: false,
            opener: null,
            onDone,
            onBusyChange,
            ports: kit.ports,
            nowMs: NOW,
            ...options.props,
          })
        )
      )
    );
  });
  await settle();
  return { kit, onOpenChange, onDone, onBusyChange };
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const text = (id: string) => q(id)?.textContent ?? "";

async function click(id: string) {
  const node = q(id);
  if (!node) throw new Error(`no element ${id}`);
  await act(async () => {
    node.click();
  });
}

async function chooseMode(mode: "photo" | "emoji" | "preset") {
  await click(`avatar-editor-mode-${mode}`);
  await settle();
}

async function pickEmoji(glyph: string) {
  const cell = qa("[data-emoji-cell]").find((node) => node.textContent === glyph);
  if (!cell) throw new Error(`no emoji cell ${glyph}`);
  await act(async () => {
    cell.click();
  });
  await settle();
}

function pngFile(name = "a.png", size = 8): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

async function pickPhoto(file: File) {
  const input = q("profile-avatar-input") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function typeColor(value: string) {
  const input = q("avatar-color-input") as HTMLInputElement;
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  await act(async () => {
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

const saveDisabled = () => q("avatar-editor-save")?.getAttribute("aria-disabled") === "true";
const chipDisabled = (id: string) => (q(`avatar-color-${id}`) as HTMLInputElement).disabled;
const checked = (id: string) => (q(id) as HTMLInputElement).checked;

/** jsdom 의 File 에는 `arrayBuffer()` 가 없다. 브라우저와 같은 바이트를 FileReader 로 읽는다. */
function fileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

describe("AvatarEditorDialog: 열기와 사진", () => {
  it("처음에는 사진 탭이고 저장이 잠겨 있으며 지금의 내 아바타를 미리보기로 보인다", async () => {
    await mountEditor();
    expect(checked("avatar-editor-mode-photo")).toBe(true);
    expect(saveDisabled()).toBe(true);
    expect(text("avatar-editor-status")).toBe(AVATAR_EDITOR_COPY.photoEmpty);
    expect(q("avatar-editor-preview")?.getAttribute("data-source")).toBe("current");
    // 사진이 없는 사람의 지금 아바타는 이름의 첫 글자다(세 크기 모두 진짜 컴포넌트).
    expect(text("avatar-editor-preview")).toContain("이");
    expect(q("avatar-editor-reset")).toBeNull();
  });

  it("대화상자는 제목과 설명을 갖고, 종류 고르기와 배경색은 이름 붙은 그룹이다", async () => {
    await mountEditor();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.textContent).toContain(AVATAR_EDITOR_COPY.title);
    expect(q("avatar-editor-mode")?.querySelector("legend")?.textContent).toBe(AVATAR_EDITOR_COPY.modeLegend);
    await chooseMode("emoji");
    const group = document.body.querySelector('[role="radiogroup"][aria-labelledby]');
    expect(group).not.toBeNull();
    const label = document.getElementById(group?.getAttribute("aria-labelledby") ?? "");
    expect(label?.textContent).toBe(AVATAR_EDITOR_COPY.colorLegend);
    for (const chip of qa('[data-testid^="avatar-color-"][type="radio"]')) {
      expect(chip.getAttribute("aria-label"), chip.getAttribute("data-testid") ?? "").toBeTruthy();
    }
  });

  it("사진을 고르면 미리보기가 바뀌고, 저장하면 고른 파일 그대로 올리며 처음이면 「올렸어요」를 말한다", async () => {
    const mounted = await mountEditor();
    const file = pngFile();
    await pickPhoto(file);
    expect(q("avatar-editor-preview")?.getAttribute("data-source")).toBe("draft");
    expect(q("avatar-editor-preview")?.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png/);
    expect(saveDisabled()).toBe(false);
    const spy = vi.spyOn(client, "invalidateQueries");
    await click("avatar-editor-save");
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    // 변환 없음: 서버로 가는 것은 고른 그 파일(같은 객체)이다.
    expect(upload.mock.calls[0]?.[0]).toBe(WS);
    expect(upload.mock.calls[0]?.[1]).toBe(file);
    expect(upload.mock.calls[0]?.[2]).toBeTypeOf("function");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["roster", WS] });
    expect(mounted.onDone).toHaveBeenCalledWith("프로필 사진을 올렸어요.");
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("이미 아바타가 있으면 「바꿨어요」를 말한다", async () => {
    const mounted = await mountEditor({ member: me(HAS_AVATAR) });
    await pickPhoto(pngFile());
    await click("avatar-editor-save");
    await settle();
    expect(mounted.onDone).toHaveBeenCalledWith("프로필 사진을 바꿨어요.");
  });

  it("허용 밖 형식·5MiB 초과는 서버를 부르지 않고 해요체 오류를 말하며, 앞에 고른 사진은 그대로다", async () => {
    await mountEditor();
    await pickPhoto(pngFile("keep.png"));
    expect(q("avatar-editor-preview")?.getAttribute("data-source")).toBe("draft");
    await pickPhoto(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }));
    expect(text("avatar-editor-error")).toMatch(/PNG, JPG, GIF, WebP/);
    await pickPhoto(pngFile("big.png", 5 * 1024 * 1024 + 1));
    expect(text("avatar-editor-error")).toBe("프로필 사진은 5MB까지 올릴 수 있어요.");
    expect(q("avatar-editor-preview")?.getAttribute("data-source")).toBe("draft");
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    [413, /5MB까지/],
    [422, /4096px/],
    [409, /다시 골라/],
    [429, /너무 자주/],
  ])("서버 %i 는 구분된 문구로 말하고 대화상자는 열려 있다", async (status, pattern) => {
    upload.mockRejectedValue(new ApiError(status, "x"));
    const mounted = await mountEditor();
    await pickPhoto(pngFile());
    await click("avatar-editor-save");
    await settle();
    expect(text("avatar-editor-error")).toMatch(pattern);
    expect(mounted.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mounted.onDone).not.toHaveBeenCalled();
  });
});

describe("AvatarEditorDialog: 이모지 (그려 올린 PNG 가 정본)", () => {
  it("이모지를 안 골랐으면 저장이 잠기고 다음 행동을 한 줄로 말한다", async () => {
    await mountEditor();
    await chooseMode("emoji");
    expect(saveDisabled()).toBe(true);
    expect(text("avatar-editor-status")).toBe(AVATAR_EDITOR_COPY.emojiEmpty);
    expect(q("avatar-editor-preview")?.getAttribute("data-source")).toBe("current");
  });

  it("이모지를 고르면 미리보기가 구운 그림으로 바뀌고, 저장은 avatar.png 를 포트가 구운 바이트 그대로 올린다", async () => {
    const mounted = await mountEditor();
    await chooseMode("emoji");
    await pickEmoji("🚀");
    expect(q("avatar-editor-preview")?.getAttribute("data-source")).toBe("draft");
    expect(q("avatar-editor-preview")?.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(saveDisabled()).toBe(false);
    const mark = mounted.kit.mark();
    await click("avatar-editor-save");
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    const file = upload.mock.calls[0]?.[1] as File;
    expect([file.name, file.type]).toEqual(["avatar.png", "image/png"]);
    const baked = mounted.kit.since(mark);
    expect(baked.length).toBeGreaterThanOrEqual(1);
    // 서버로 가는 바이트 = 저장을 누른 뒤 포트가 구운 PNG 그대로(한 바이트도 바뀌지 않는다).
    expect(sameBytes(await fileBytes(file), baked[baked.length - 1])).toBe(true);
    expect(mounted.onDone).toHaveBeenCalledWith(AVATAR_EDITOR_COPY.doneSaved);
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("고른 이모지·색이 그리기 계획에 그대로 실린다 (글리프는 고른 글자, 배경은 고른 색)", async () => {
    const mounted = await mountEditor();
    await chooseMode("emoji");
    await pickEmoji("🔥");
    await click("avatar-color-wine");
    await settle();
    const full = mounted.kit.log.filter((line) => line.startsWith("fill:512:"));
    expect(full.at(-1)).toBe(`fill:512:${avatarBackgroundHex("wine")}`);
    expect(mounted.kit.log).toContain("paint:512:emoji");
  });

  it("밝은 그림은 연한 칩을 흐리게 하고(고를 수 없다) 진한 칩만 열어 둔다, 이유를 한 줄로 말한다", async () => {
    await mountEditor({ ports: { glyph: BRIGHT_GLYPH } });
    await chooseMode("emoji");
    await pickEmoji("🚀");
    expect(chipDisabled("butter")).toBe(true);
    expect(chipDisabled("sky")).toBe(true);
    expect(chipDisabled("navy")).toBe(false);
    expect(chipDisabled("forest")).toBe(false);
    expect(text("avatar-color-blocked-hint")).toBe(AVATAR_EDITOR_COPY.colorBlockedHint);
    // 흐린 칩을 눌러도 바뀌지 않는다(native disabled).
    await click("avatar-color-butter");
    expect(checked("avatar-color-butter")).toBe(false);
  });

  it("고른 색을 건드리지 않았는데 그림이 묻히면 첫 통과 색으로 옮긴다 (어두운 그림은 남색에서 연한 색으로)", async () => {
    await mountEditor({ ports: { glyph: DARK_GLYPH } });
    await chooseMode("emoji");
    expect(checked("avatar-color-navy")).toBe(true);
    await pickEmoji("🔥");
    expect(checked("avatar-color-navy")).toBe(false);
    expect(checked("avatar-color-butter")).toBe(true);
    expect((q("avatar-color-input") as HTMLInputElement).value).toBe(avatarBackgroundHex("butter"));
    expect(saveDisabled()).toBe(false);
  });

  it("사용자가 색을 직접 골랐으면 옮기지 않는다: 묻히는 색은 그대로 남고 저장이 막힌다", async () => {
    const mounted = await mountEditor({ ports: { glyph: DARK_GLYPH } });
    await chooseMode("emoji");
    await typeColor(FREE_DARK); // 처음 칸의 값(남색)과 달라야 입력 이벤트가 선다
    await pickEmoji("🔥");
    expect((q("avatar-color-input") as HTMLInputElement).value).toBe(FREE_DARK);
    expect(saveDisabled()).toBe(true);
    expect(text("avatar-editor-status")).toBe(AVATAR_EDITOR_COPY.emojiLowContrast);
    await click("avatar-editor-save");
    await settle();
    expect(upload).not.toHaveBeenCalled();
    expect(mounted.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("직접 입력한 색이 묻히면 저장이 막히고 이유를 말한다 (정해진 팔레트 밖의 색도 같은 판정)", async () => {
    await mountEditor({ ports: { glyph: BRIGHT_GLYPH } });
    await chooseMode("emoji");
    await pickEmoji("🚀");
    await typeColor(FREE_YELLOW); // 노란 바탕 위의 밝은 그림
    expect(saveDisabled()).toBe(true);
    expect(text("avatar-editor-status")).toBe(AVATAR_EDITOR_COPY.emojiLowContrast);
    expect(q("avatar-editor-save")?.getAttribute("aria-describedby")).toBeTruthy();
    await click("avatar-editor-save");
    await settle();
    expect(upload).not.toHaveBeenCalled();
    // 통과하는 자유 색으로 바꾸면 열린다.
    await typeColor(FREE_NIGHT);
    expect(saveDisabled()).toBe(false);
  });

  it("색 입력이 #RRGGBB 꼴이 아니면 칸을 떠난 뒤 한 줄로 말하고 저장은 막힌다, 세 자리 줄임 꼴은 받는다", async () => {
    await mountEditor({ ports: { glyph: BRIGHT_GLYPH } });
    await chooseMode("emoji");
    await pickEmoji("🚀");
    await typeColor(hash("12"));
    expect(q("avatar-color-problem")).toBeNull(); // 쓰는 중에는 말하지 않는다
    await act(async () => {
      (q("avatar-color-input") as HTMLInputElement).dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await settle();
    expect(text("avatar-color-problem")).toBe(AVATAR_EDITOR_COPY.invalidColor);
    expect(q("avatar-color-input")?.getAttribute("aria-invalid")).toBe("true");
    expect(saveDisabled()).toBe(true);
    await typeColor(hash("123"));
    expect(q("avatar-color-problem")).toBeNull();
    expect((q("avatar-color-input") as HTMLInputElement).value).toBe(hash("123"));
    expect(saveDisabled()).toBe(false);
  });

  it("화면의 판정이 낡았어도 저장 길이 한 번 더 막는다: 서버를 부르지 않고 이유를 말한다", async () => {
    // 화면이 표본을 잰 뒤에 그림이 바뀐 것처럼(글꼴이 늦게 도착했다) 저장 길의 표본만 묻히는 그림이다. 저장 단추는 열려 있지만
    // 쓰기는 일어나지 않는다.
    let stale = false;
    const mounted = await mountEditor({ ports: { glyph: () => (stale ? DARK_GLYPH : BRIGHT_GLYPH) } });
    await chooseMode("emoji");
    await pickEmoji("🚀");
    expect(saveDisabled()).toBe(false);
    stale = true;
    await click("avatar-editor-save");
    await settle();
    expect(upload).not.toHaveBeenCalled();
    expect(text("avatar-editor-error")).toBe(AVATAR_EDITOR_COPY.emojiLowContrast);
    expect(mounted.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("이 기기가 이모지를 그리지 못하면(글꼴에 없다) 저장이 막히고 다른 이모지를 권한다", async () => {
    await mountEditor({ ports: { paintOk: false } });
    await chooseMode("emoji");
    await pickEmoji("🚀");
    expect(saveDisabled()).toBe(true);
    expect(text("avatar-editor-status")).toBe(AVATAR_EDITOR_COPY.emojiBlank);
  });

  it("카탈로그를 받는 동안은 패널의 막대가 서고, 받으면 이모지가 선다 (불러오는 중)", async () => {
    let finish: (entries: CatalogEmoji[]) => void = () => undefined;
    catalog.load.mockReturnValue(new Promise<CatalogEmoji[]>((resolve) => (finish = resolve)));
    await mountEditor();
    await chooseMode("emoji");
    expect(qa("[data-emoji-cell]")).toHaveLength(0);
    expect(q("avatar-emoji-picker")).not.toBeNull();
    await act(async () => {
      finish(CATALOG);
    });
    await settle();
    expect(qa("[data-emoji-cell]").length).toBeGreaterThan(0);
  });
});

describe("AvatarEditorDialog: 코메토", () => {
  it("정본 표정 여섯이 구워진 작은 그림으로 서고, 고르면 미리보기와 저장이 따라간다", async () => {
    const mounted = await mountEditor({ ports: { glyph: BRIGHT_GLYPH } });
    await chooseMode("preset");
    expect(qa('[data-testid="avatar-preset-picker"] input[type="radio"]')).toHaveLength(6);
    expect(qa('[data-testid="avatar-preset-picker"] img')).toHaveLength(6);
    expect(checked("avatar-preset-idle")).toBe(true);
    await click("avatar-preset-happy");
    await settle();
    expect(checked("avatar-preset-happy")).toBe(true);
    expect(q("avatar-editor-preview")?.getAttribute("data-source")).toBe("draft");
    expect(saveDisabled()).toBe(false);
    const mark = mounted.kit.mark();
    await click("avatar-editor-save");
    await settle();
    const file = upload.mock.calls[0]?.[1] as File;
    expect([file.name, file.type]).toEqual(["avatar.png", "image/png"]);
    const baked = mounted.kit.since(mark);
    expect(sameBytes(await fileBytes(file), baked[baked.length - 1])).toBe(true);
    expect(mounted.kit.log).toContain("paint:512:art");
    expect(mounted.onDone).toHaveBeenCalledWith(AVATAR_EDITOR_COPY.doneSaved);
  });

  it("코메토는 진한 배경에서만 서므로 연한 칩이 흐려진다", async () => {
    await mountEditor({ ports: { glyph: BRIGHT_GLYPH } });
    await chooseMode("preset");
    expect(chipDisabled("butter")).toBe(true);
    expect(chipDisabled("navy")).toBe(false);
    expect(checked("avatar-color-navy")).toBe(true);
  });

  it("묻히는 코메토는 저장 길에서도 막힌다", async () => {
    let stale = false;
    await mountEditor({ ports: { glyph: () => (stale ? DARK_GLYPH : BRIGHT_GLYPH) } });
    await chooseMode("preset");
    await click("avatar-preset-happy");
    await settle();
    expect(saveDisabled()).toBe(false);
    stale = true;
    await click("avatar-editor-save");
    await settle();
    expect(upload).not.toHaveBeenCalled();
    expect(text("avatar-editor-error")).toBe(AVATAR_EDITOR_COPY.presetLowContrast);
  });

  it("탭마다 색을 따로 쥔다: 이모지에서 고른 색이 코메토로 새지 않는다", async () => {
    await mountEditor({ ports: { glyph: BRIGHT_GLYPH } });
    await chooseMode("emoji");
    await click("avatar-color-forest");
    await chooseMode("preset");
    expect(checked("avatar-color-navy")).toBe(true);
    await chooseMode("emoji");
    expect(checked("avatar-color-forest")).toBe(true);
  });
});

describe("AvatarEditorDialog: 기본으로 되돌리기", () => {
  it("아바타가 있을 때만 보이고, 제자리 확인 뒤에야 removeMyAvatar 하나를 부른다 (업로드가 아니다)", async () => {
    const mounted = await mountEditor({ member: me(HAS_AVATAR) });
    expect(q("avatar-editor-reset")).not.toBeNull();
    await click("avatar-editor-reset");
    expect(removeMyAvatar).not.toHaveBeenCalled();
    const spy = vi.spyOn(client, "invalidateQueries");
    await click("avatar-editor-reset-confirm");
    await settle();
    expect(removeMyAvatar).toHaveBeenCalledTimes(1);
    expect(removeMyAvatar).toHaveBeenCalledWith(WS);
    expect(upload).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["roster", WS] });
    expect(mounted.onDone).toHaveBeenCalledWith(AVATAR_EDITOR_COPY.doneReset);
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("되돌리기가 실패하면 오류를 말하고 닫히지 않는다", async () => {
    removeMyAvatar.mockRejectedValue(new ApiError(500, "x"));
    const mounted = await mountEditor({ member: me(HAS_AVATAR) });
    await click("avatar-editor-reset");
    await click("avatar-editor-reset-confirm");
    await settle();
    expect(text("avatar-editor-error")).toBe(AVATAR_EDITOR_COPY.resetFailed);
    expect(mounted.onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("AvatarEditorDialog: 오프라인과 진행", () => {
  it("오프라인이면 배너가 말하고 저장·되돌리기가 잠긴다 (고르는 일은 열려 있다)", async () => {
    const mounted = await mountEditor({ member: me(HAS_AVATAR), props: { offline: true } });
    expect(text("avatar-editor-offline")).toContain(AVATAR_EDITOR_COPY.offline);
    await pickPhoto(pngFile());
    expect(q("avatar-editor-preview")?.getAttribute("data-source")).toBe("draft");
    expect(saveDisabled()).toBe(true);
    await click("avatar-editor-save");
    await settle();
    expect(upload).not.toHaveBeenCalled();
    expect(q("avatar-editor-reset")?.getAttribute("aria-disabled")).toBe("true");
    await click("avatar-editor-reset");
    expect(q("avatar-editor-reset-question")).toBeNull();
    expect(removeMyAvatar).not.toHaveBeenCalled();
    expect(mounted.onDone).not.toHaveBeenCalled();
  });

  it("올리는 동안은 닫히지 않고 진행 문장과 aria-busy 가 선다, 끝나면 닫힌다", async () => {
    let finish: () => void = () => undefined;
    upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ id: "m", memberId: MEMBER_ID, status: "ready", avatarUrl: HAS_AVATAR });
        })
    );
    const mounted = await mountEditor();
    await pickPhoto(pngFile());
    await click("avatar-editor-save");
    const save = q("avatar-editor-save");
    expect(save?.getAttribute("aria-busy")).toBe("true");
    expect(save?.textContent).toContain(AVATAR_EDITOR_COPY.saving);
    expect(mounted.onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      (upload.mock.calls[0]?.[2] as (fraction: number) => void)(0.4);
    });
    expect(text("avatar-editor-status")).toBe("올리는 중 40%.");
    // 취소도 Esc 도 닫지 못한다.
    await click("avatar-editor-cancel");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(mounted.onOpenChange).not.toHaveBeenCalled();
    await act(async () => {
      finish();
    });
    await settle();
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
    expect(mounted.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("올리지 않는 동안은 취소가 닫는다", async () => {
    const mounted = await mountEditor();
    await click("avatar-editor-cancel");
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
    expect(upload).not.toHaveBeenCalled();
  });
});
