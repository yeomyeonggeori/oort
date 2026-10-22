// @vitest-environment jsdom

import { act, createElement, useSyncExternalStore, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperRef } from "@momo/core/design/appearance";
import { THEMES } from "@momo/core/design/themes";
import {
  IMPORT_FAILURE_COPY,
  PRESET_IDS,
  SOLID_IDS,
  WALLPAPER_BAND_COPY,
  WALLPAPER_BLURRY_COPY,
  WALLPAPER_COPY,
  WALLPAPER_NARROW_COPY,
  WALLPAPER_OFF_COPY,
  wallpaperTokensOf,
  wallpaperTreatment,
  type PhotoPorts,
  type WallpaperOffReason,
  type WallpaperVerdict,
} from "@momo/core/design/wallpaper";
import { APPEARANCE_STORAGE_KEY, getAppearance, reloadAppearanceForTest, updateAppearance } from "@/design/theme";
import type { WallpaperPlan } from "@/design/wallpaper/plan";
import type { PhotoStore, StoredPhoto } from "@/design/wallpaper/idb";
import { createWallpaperStore } from "@/design/wallpaper/store";
import { BackdropCard } from "./BackdropCard";
import { WALLPAPER_ROW_OPEN, WallpaperRow } from "./WallpaperRow";

// =============================================================================
// 배경화면 행 (AP-4 #4191). 소유 이슈가 `WALLPAPER_ROW_OPEN`을 켜면 **열린 상태의 구성을 자기 시험에서 단정**한다
// (#4217 인계): 상수만 켜고 컴포넌트가 비어 있으면 빈 「배경」 카드 껍데기가 나오고 슬롯 시험은 그 행을 면제하기 때문이다.
// 런타임(계획)은 가짜로 갈아 끼운다: 어떤 계획에서 어떤 문장이 서는지를 잰다. 계획 자체는 `plan.test.ts`·
// `runtime.test.ts`가 잰다.
// =============================================================================

const state = vi.hoisted(() => ({
  narrow: false,
  plan: null as unknown,
  store: null as unknown as { subscribe(l: () => void): () => void; getView(): unknown },
}));

vi.mock("@/design/wallpaper/runtime", () => ({
  useWallpaperPlan: () => state.plan,
  useNarrowWindow: () => state.narrow,
}));

vi.mock("@/design/wallpaper/store", async () => {
  const actual = await vi.importActual<typeof import("@/design/wallpaper/store")>("@/design/wallpaper/store");
  return {
    ...actual,
    wallpaperStore: () => state.store,
    usePhotoView: () => useSyncExternalStore(state.store.subscribe, state.store.getView, state.store.getView),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

class MemoryPhotos implements PhotoStore {
  record: StoredPhoto | null = null;
  async read() {
    return this.record;
  }
  async write(photo: StoredPhoto) {
    this.record = photo;
  }
  async clear() {
    this.record = null;
  }
}

interface Fake {
  photos: MemoryPhotos;
  decode: "ok" | "null" | "hang";
  release(): void;
}
let fake: Fake;

function newStore(): Fake {
  const photos = new MemoryPhotos();
  const f: Fake = { photos, decode: "ok", release: () => undefined };
  let hang: Promise<void> | null = null;
  const ports: PhotoPorts<File, string, string> = {
    async decode() {
      if (f.decode === "hang") {
        hang = new Promise<void>((resolve) => {
          f.release = resolve;
        });
        await hang;
      }
      return f.decode === "null" ? null : { handle: "bitmap", width: 3000, height: 2000 };
    },
    async encode(_h, { longSide }) {
      return { bytes: `jpeg-${longSide}`, size: 200_000, width: longSide, height: Math.round(longSide * 0.66) };
    },
    release() {},
    now: () => 1_800_000_000_000,
  };
  state.store = createWallpaperStore<File, string, string>({
    photos,
    ports,
    bytesOf: async (blob) => new Uint8Array(blob.length).buffer,
    dataUrlOf: async (blob) => `data:image/jpeg;base64,${blob.replace(/\W/g, "")}`,
    dataUrlOfBytes: async (buffer) => `data:image/jpeg;base64,stored${buffer.byteLength}`,
    appearance: { get: getAppearance, update: updateAppearance },
  });
  return f;
}

function planOf(options: { ref?: WallpaperRef; verdict?: WallpaperVerdict | null; reason?: WallpaperOffReason | null; live?: boolean; hasBand?: boolean } = {}): WallpaperPlan {
  const treatment = options.verdict === null ? null : { ...wallpaperTreatment(wallpaperTokensOf(THEMES.dawnsky.light), "light"), verdict: options.verdict ?? "ok" };
  return {
    ref: options.ref,
    mode: "light",
    resolved: options.verdict !== null,
    treatment,
    hasBand: options.hasBand ?? false,
    decision: { live: options.live ?? false, reason: options.reason ?? null },
    vars: {},
    paint: null,
  };
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  reloadAppearanceForTest();
  fake = newStore();
  state.plan = planOf();
  state.narrow = false;
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  localStorage.clear();
  reloadAppearanceForTest();
});

function mount(tree: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(tree);
  });
  return host;
}

const q = (host: HTMLElement, testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const radio = (host: HTMLElement, testId: string) => q(host, testId) as HTMLInputElement;
/** 알림 영역의 문장. 영역은 늘 DOM에 있고(보조기기가 읽도록) 말할 것이 없으면 빈 문자열이다. */
const statusText = (host: HTMLElement) => q(host, "wallpaper-status")?.textContent ?? null;
const stored = () => JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "null") as { wallpaper?: WallpaperRef } | null;

function pick(host: HTMLElement, testId: string) {
  const input = radio(host, testId);
  expect(input, testId).not.toBeNull();
  act(() => {
    input.click();
  });
}

async function chooseFile(host: HTMLElement, file: File) {
  const input = q(host, "wallpaper-file-input") as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const jpeg = () => new File([new Uint8Array(1000)], "photo.jpg", { type: "image/jpeg" });

describe("열린 상태의 구성 (슬롯 시험이 면제하는 자리를 이 시험이 맡는다)", () => {
  it("이 행은 열려 있다", () => {
    expect(WALLPAPER_ROW_OPEN).toBe(true);
  });

  it("카드 「배경」은 빈 껍데기가 아니다: 제목과 배경화면 행이 그려지고 사이드바 색 행(AP-5)은 아직 비어 있다", () => {
    const host = mount(createElement(BackdropCard));
    expect(host.querySelector("h2")?.textContent).toBe("배경");
    expect(q(host, "wallpaper-row")).not.toBeNull();
    expect(q(host, "wallpaper-choices")).not.toBeNull();
    // AP-5의 행은 자기 이슈가 열 때까지 아무것도 그리지 않는다.
    expect(host.textContent).not.toContain("사이드바 색");
  });

  it("고를 수 있는 것: 없음 하나, 단색 여덟, 기본 제공 여섯이 한 라디오 묶음이고 사진 단추가 있다", () => {
    const host = mount(createElement(WallpaperRow));
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(1 + SOLID_IDS.length + PRESET_IDS.length);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.filter((r) => r.checked).map((r) => r.dataset.testid)).toEqual(["wallpaper-none"]);
    expect(q(host, "wallpaper-pick-photo")?.textContent).toContain(WALLPAPER_COPY.pickPhoto);
    expect(host.textContent).toContain(WALLPAPER_COPY.privacy);
    expect(q(host, "wallpaper-reset")).toBeNull();
  });

  it("모든 선택은 이름이 있고 보조기술이 읽는다", () => {
    const host = mount(createElement(WallpaperRow));
    for (const input of host.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      expect(input.getAttribute("aria-label"), input.dataset.testid).toBeTruthy();
    }
    const fieldset = q(host, "wallpaper-choice") as HTMLFieldSetElement;
    expect(fieldset.tagName).toBe("FIELDSET");
    expect(fieldset.querySelector("legend")?.textContent).toBe(WALLPAPER_COPY.label);
    // 파일 입력은 화면에서 숨겨져 있고 탭 순서에 없다(단추가 그 자리다).
    const file = q(host, "wallpaper-file-input") as HTMLInputElement;
    expect(file.getAttribute("aria-hidden")).toBe("true");
    expect(file.tabIndex).toBe(-1);
    expect(file.accept).toBe("image/*");
  });
});

describe("단색·기본 제공을 고른다", () => {
  it("단색: 레코드에 참조가 저장되고 루트에 종류가 찍히고 「기본으로」가 생긴다", () => {
    const host = mount(createElement(WallpaperRow));
    pick(host, "wallpaper-solid-slate");
    expect(stored()?.wallpaper).toEqual({ kind: "solid", id: "slate" });
    expect(document.documentElement.getAttribute("data-wallpaper")).toBe("solid");
    expect(radio(host, "wallpaper-solid-slate").checked).toBe(true);
    expect(radio(host, "wallpaper-none").checked).toBe(false);
    expect(q(host, "wallpaper-reset")?.textContent).toBe("기본으로");
  });

  it("기본 제공으로 바꾸면 선택이 옮겨 간다", () => {
    const host = mount(createElement(WallpaperRow));
    pick(host, "wallpaper-solid-rose");
    pick(host, "wallpaper-preset-bam");
    expect(stored()?.wallpaper).toEqual({ kind: "preset", id: "bam" });
    expect(radio(host, "wallpaper-preset-bam").checked).toBe(true);
    expect(radio(host, "wallpaper-solid-rose").checked).toBe(false);
    expect(document.documentElement.getAttribute("data-wallpaper")).toBe("preset");
  });

  it("「기본으로」는 선택을 지우고 없음으로 돌아가며 단추도 사라진다", () => {
    const host = mount(createElement(WallpaperRow));
    pick(host, "wallpaper-preset-bam");
    act(() => {
      q(host, "wallpaper-reset")?.click();
    });
    expect(stored()?.wallpaper).toBeUndefined();
    expect(radio(host, "wallpaper-none").checked).toBe(true);
    expect(document.documentElement.hasAttribute("data-wallpaper")).toBe(false);
    expect(q(host, "wallpaper-reset")).toBeNull();
  });

  it("「없음」을 누르면 선택이 풀린다", () => {
    const host = mount(createElement(WallpaperRow));
    pick(host, "wallpaper-solid-sage");
    pick(host, "wallpaper-none");
    expect(stored()?.wallpaper).toBeUndefined();
  });

  it("모르는 id가 저장돼 있어도 「없음」으로 그려진다 (화면을 잠그지 않는다)", () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ v: 2, scheme: "system", theme: "dawnsky", signal: null, density: "comfortable", wallpaper: { kind: "solid", id: "future-color" } }));
    reloadAppearanceForTest();
    const host = mount(createElement(WallpaperRow));
    expect(radio(host, "wallpaper-none").checked).toBe(true);
    expect(q(host, "wallpaper-reset")).toBeNull();
  });
});

describe("내 사진", () => {
  it("고르면 저장되고 사진 칩과 「다른 사진 고르기」와 지워진다는 안내가 선다", async () => {
    const host = mount(createElement(WallpaperRow));
    await chooseFile(host, jpeg());
    expect(stored()?.wallpaper).toEqual({ kind: "image", width: 2560, height: 1690, rev: 1_800_000_000_000 });
    expect(fake.photos.record?.rev).toBe(1_800_000_000_000);
    expect(radio(host, "wallpaper-photo").checked).toBe(true);
    expect(q(host, "wallpaper-pick-photo")?.textContent).toContain(WALLPAPER_COPY.pickAnotherPhoto);
    expect(host.textContent).toContain(WALLPAPER_COPY.replaceNote);
    expect(statusText(host)).toBe("");
  });

  it("같은 사진을 다시 골라도 변경 이벤트가 오도록 입력을 비운다", async () => {
    const host = mount(createElement(WallpaperRow));
    const input = q(host, "wallpaper-file-input") as HTMLInputElement;
    const spy = vi.fn();
    Object.defineProperty(input, "value", { get: () => "x", set: spy, configurable: true });
    await chooseFile(host, jpeg());
    expect(spy).toHaveBeenCalledWith("");
  });

  it("줄이는 동안에는 단추가 잠기고 상태를 말한다 (진행 낱말 없이)", async () => {
    fake.decode = "hang";
    const host = mount(createElement(WallpaperRow));
    const input = q(host, "wallpaper-file-input") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [jpeg()], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const button = q(host, "wallpaper-pick-photo") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain(WALLPAPER_COPY.busyPhoto);
    await act(async () => {
      fake.release();
    });
    expect((q(host, "wallpaper-pick-photo") as HTMLButtonElement).disabled).toBe(false);
  });

  it("읽지 못한 사진: 이유를 한 줄로 말하고 앞의 선택은 그대로다", async () => {
    fake.decode = "null";
    const host = mount(createElement(WallpaperRow));
    pick(host, "wallpaper-solid-slate");
    await chooseFile(host, jpeg());
    expect(q(host, "wallpaper-status")?.textContent).toBe(IMPORT_FAILURE_COPY.unreadable);
    expect(q(host, "wallpaper-status")?.getAttribute("role")).toBe("status");
    expect(stored()?.wallpaper).toEqual({ kind: "solid", id: "slate" });
  });

  it("다음 선택은 오류 문장을 지운다", async () => {
    fake.decode = "null";
    const host = mount(createElement(WallpaperRow));
    await chooseFile(host, jpeg());
    expect(statusText(host)).not.toBe("");
    pick(host, "wallpaper-preset-bam");
    expect(statusText(host)).toBe("");
  });

  it("파일 선택을 취소하면(파일 없음) 아무 일도 없다", async () => {
    const host = mount(createElement(WallpaperRow));
    const input = q(host, "wallpaper-file-input") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(stored()?.wallpaper).toBeUndefined();
    expect(statusText(host)).toBe("");
  });

  it("사진 선택에서 단색으로 바꾸면 사진 칩과 안내가 사라지고 저장된 사진이 지워진다", async () => {
    const host = mount(createElement(WallpaperRow));
    await chooseFile(host, jpeg());
    expect(fake.photos.record).not.toBeNull();
    pick(host, "wallpaper-solid-slate");
    await act(async () => undefined);
    expect(q(host, "wallpaper-photo")).toBeNull();
    expect(host.textContent).not.toContain(WALLPAPER_COPY.replaceNote);
    expect(fake.photos.record).toBeNull();
  });
});

describe("지금 배경이 왜 안 보이는지 한 줄로 말한다", () => {
  const solid: WallpaperRef = { kind: "solid", id: "slate" };

  function withChosen(plan: WallpaperPlan): HTMLElement {
    updateAppearance({ wallpaper: solid });
    state.plan = plan;
    return mount(createElement(WallpaperRow));
  }

  it.each<[WallpaperOffReason]>([["reduce-transparency"], ["increase-contrast"], ["unresolved"], ["no-photo"]])("꺼진 이유 %s는 그 문장이다", (reason) => {
    const host = withChosen(planOf({ ref: solid, reason, live: false, verdict: reason === "unresolved" ? null : "ok" }));
    expect(q(host, "wallpaper-status")?.textContent).toBe(WALLPAPER_OFF_COPY[reason]);
    // 선택은 지우지 않는다.
    expect(radio(host, "wallpaper-solid-slate").checked).toBe(true);
    expect(q(host, "wallpaper-reset")).not.toBeNull();
  });

  it("이 테마에서 쓸 수 없으면 선택지가 잠기고 이유를 말한다 (「기본으로」는 계속 누를 수 있다)", () => {
    const host = withChosen(planOf({ ref: solid, verdict: "unavailable", reason: "unavailable", live: false }));
    expect((q(host, "wallpaper-choice") as HTMLFieldSetElement).disabled).toBe(true);
    expect(q(host, "wallpaper-status")?.textContent).toBe(WALLPAPER_OFF_COPY.unavailable);
    const reset = q(host, "wallpaper-reset") as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
  });

  it("고른 것이 없어도 못 쓰는 테마면 미리 막고 이유를 말한다", () => {
    state.plan = planOf({ verdict: "unavailable" });
    const host = mount(createElement(WallpaperRow));
    expect((q(host, "wallpaper-choice") as HTMLFieldSetElement).disabled).toBe(true);
    expect(q(host, "wallpaper-status")?.textContent).toBe(WALLPAPER_OFF_COPY.unavailable);
  });

  it("쓸 수는 있지만 범위가 좁은 테마는 흐림 힌트를 보이고 선택지는 열려 있다", () => {
    state.plan = planOf({ verdict: "blurry" });
    const host = mount(createElement(WallpaperRow));
    expect((q(host, "wallpaper-choice") as HTMLFieldSetElement).disabled).toBe(false);
    expect(q(host, "wallpaper-status")?.textContent).toBe(WALLPAPER_BLURRY_COPY);
  });

  it("띠가 있는 테마에서 깔려 있으면 사진이 가장자리에만 보인다고 말한다 (깔려 있지 않으면 말하지 않는다)", () => {
    const live = withChosen(planOf({ ref: solid, live: true, hasBand: true }));
    expect(q(live, "wallpaper-status")?.textContent).toBe(WALLPAPER_BAND_COPY);
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    state.plan = planOf({ ref: solid, live: false, hasBand: true });
    const off = mount(createElement(WallpaperRow));
    expect(statusText(off)).toBe("");
  });

  it("창이 좁으면(폰 폭) 바닥이 보이지 않는다고 말한다: 선택지는 열려 있고 선택은 저장된다", () => {
    state.narrow = true;
    const host = mount(createElement(WallpaperRow));
    expect(q(host, "wallpaper-status")?.textContent).toBe(WALLPAPER_NARROW_COPY);
    expect((q(host, "wallpaper-choice") as HTMLFieldSetElement).disabled).toBe(false);
    pick(host, "wallpaper-solid-slate");
    expect(stored()?.wallpaper).toEqual({ kind: "solid", id: "slate" });
    expect(q(host, "wallpaper-status")?.textContent).toBe(WALLPAPER_NARROW_COPY);
  });

  it("말할 것이 없으면 문장이 없다", () => {
    const host = mount(createElement(WallpaperRow));
    expect(statusText(host)).toBe("");
  });

  it("알림 영역은 말할 것이 없을 때도 DOM에 있고 자리를 차지하지 않는다 (없던 영역이 내용과 함께 생기면 보조기기가 읽지 않는 일이 잦다)", () => {
    const host = mount(createElement(WallpaperRow));
    const region = q(host, "wallpaper-status");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.childNodes.length).toBe(0);
    expect(region?.className).toContain("empty:hidden");
  });

  it("저장한 사진을 찾지 못했다는 사실은 선택이 거둬진 뒤에도 한 번 말한다", async () => {
    // 참조는 사진인데 저장소에 바이트가 없다: 스토어가 참조를 거두고 status를 missing으로 남긴다.
    updateAppearance({ wallpaper: { kind: "image", width: 10, height: 8, rev: 5 } });
    const host = mount(createElement(WallpaperRow));
    await act(async () => {
      await (state.store as unknown as { ensureLoaded(): Promise<void> }).ensureLoaded();
    });
    expect(getAppearance().wallpaper).toBeUndefined();
    expect(q(host, "wallpaper-status")?.textContent).toBe(WALLPAPER_OFF_COPY["no-photo"]);
  });
});
