import { describe, expect, it, vi } from "vitest";
import type { WallpaperRef } from "@momo/core/design/appearance";
import type { PhotoPorts } from "@momo/core/design/wallpaper";
import type { PhotoStore, StoredPhoto } from "./idb";
import { createWallpaperStore, type WallpaperStoreDeps } from "./store";

// 배경 스토어의 규칙을 메모리 저장소와 가짜 포트로 잰다 (AP-4 #4191). 진짜 IndexedDB·캔버스는 브라우저 쪽
// (`capture-4191.mjs`의 단정, `photo.browser.test.ts`)이 잰다.

class MemoryPhotos implements PhotoStore {
  record: StoredPhoto | null = null;
  writes = 0;
  clears = 0;
  failWrite = false;
  /** 읽기를 붙잡아 두는 자리(경쟁 시험). */
  gate: Promise<void> | null = null;
  async read() {
    if (this.gate) await this.gate;
    return this.record;
  }
  async write(photo: StoredPhoto) {
    this.writes += 1;
    if (this.failWrite) throw new Error("quota");
    this.record = photo;
  }
  async clear() {
    this.clears += 1;
    this.record = null;
  }
}

const bytes = (n: number) => new Uint8Array(n).buffer;

interface Harness {
  photos: MemoryPhotos;
  store: ReturnType<typeof createWallpaperStore<string, string, string>>;
  appearance: { wallpaper?: WallpaperRef };
  updates: (WallpaperRef | undefined)[];
  ports: PhotoPorts<string, string, string>;
}

function harness(options: { decode?: "ok" | "null"; size?: number; wallpaper?: WallpaperRef } = {}): Harness {
  const photos = new MemoryPhotos();
  const appearance: { wallpaper?: WallpaperRef } = options.wallpaper ? { wallpaper: options.wallpaper } : {};
  const updates: (WallpaperRef | undefined)[] = [];
  const ports: PhotoPorts<string, string, string> = {
    async decode() {
      return options.decode === "null" ? null : { handle: "bitmap", width: 3000, height: 2000 };
    },
    async encode(_h, { longSide }) {
      return { bytes: `jpeg:${longSide}`, size: options.size ?? 200_000, width: longSide, height: Math.round(longSide * 0.66) };
    },
    release() {},
    now: () => 1_800_000_000_000,
  };
  const deps: WallpaperStoreDeps<string, string, string> = {
    photos,
    ports,
    bytesOf: async (blob) => bytes(blob.length),
    dataUrlOf: async (blob) => `data:image/jpeg;base64,${blob.replace(/\W/g, "")}`,
    dataUrlOfBytes: async (buffer) => `data:image/jpeg;base64,stored${buffer.byteLength}`,
    appearance: {
      get: () => appearance,
      update: (patch) => {
        updates.push(patch.wallpaper);
        if (patch.wallpaper === undefined) delete appearance.wallpaper;
        else appearance.wallpaper = patch.wallpaper;
      },
    },
  };
  return { photos, store: createWallpaperStore(deps), appearance, updates, ports };
}

describe("사진을 고른다", () => {
  it("바이트를 먼저 쓰고 성공한 뒤에 참조를 올린다 (참조에는 바이트가 없다)", async () => {
    const h = harness();
    const order: string[] = [];
    const write = h.photos.write.bind(h.photos);
    h.photos.write = async (photo) => {
      order.push("write");
      await write(photo);
    };
    const update = vi.fn(() => order.push("update"));
    // 참조 갱신 시점을 기록하려고 updates 대신 감시한다.
    const original = h.updates.push.bind(h.updates);
    h.updates.push = (...items) => {
      update();
      return original(...items);
    };
    const result = await h.store.importPhoto("file", 4_000_000);
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["write", "update"]);
    expect(h.appearance.wallpaper).toEqual({ kind: "image", width: 2560, height: 1690, rev: 1_800_000_000_000 });
    expect(JSON.stringify(h.appearance)).not.toContain("jpeg");
    expect(h.photos.record?.rev).toBe(1_800_000_000_000);
    expect(h.photos.record?.type).toBe("image/jpeg");
    expect(h.photos.record?.thumb).toMatch(/^data:image\/jpeg/);
    expect(h.store.getView()).toMatchObject({ status: "ready", rev: 1_800_000_000_000 });
  });

  it("저장이 실패하면 앞의 선택이 그대로다 (참조도 보이는 상태도 바뀌지 않는다)", async () => {
    const h = harness({ wallpaper: { kind: "solid", id: "slate" } });
    h.photos.failWrite = true;
    const result = await h.store.importPhoto("file", 4_000_000);
    expect(result).toEqual({ ok: false, reason: "save-failed" });
    expect(h.appearance.wallpaper).toEqual({ kind: "solid", id: "slate" });
    expect(h.updates).toEqual([]);
    expect(h.store.getView()).toEqual({ status: "none" });
  });

  it("읽지 못한 사진과 너무 큰 사진은 거절하고 아무것도 저장하지 않는다", async () => {
    const unreadable = harness({ decode: "null" });
    expect(await unreadable.store.importPhoto("file", 1000)).toEqual({ ok: false, reason: "unreadable" });
    expect(unreadable.photos.writes).toBe(0);
    const tooLarge = harness({ size: 9_000_000 });
    expect(await tooLarge.store.importPhoto("file", 1000)).toEqual({ ok: false, reason: "too-large" });
    expect(tooLarge.photos.writes).toBe(0);
    expect(tooLarge.updates).toEqual([]);
  });

  it("사진을 다시 고르면 저장소의 사진이 한 장으로 덮어써진다", async () => {
    const h = harness();
    await h.store.importPhoto("a", 1000);
    const first = h.photos.record;
    h.ports.now = () => 1_800_000_000_999;
    await h.store.importPhoto("b", 1000);
    expect(h.photos.writes).toBe(2);
    expect(h.photos.record?.rev).not.toBe(first?.rev);
  });
});

describe("다른 배경으로 바꾼다", () => {
  it("단색을 고르면 참조를 먼저 바꾸고 사진을 지운다", async () => {
    const h = harness();
    await h.store.importPhoto("file", 1000);
    expect(h.photos.record).not.toBeNull();
    h.store.choose({ kind: "solid", id: "rose" });
    expect(h.appearance.wallpaper).toEqual({ kind: "solid", id: "rose" });
    expect(h.store.getView()).toEqual({ status: "none" });
    await Promise.resolve();
    expect(h.photos.record).toBeNull();
    expect(h.photos.clears).toBe(1);
  });

  it("「기본으로」는 참조를 지우고 사진도 지운다", async () => {
    const h = harness();
    await h.store.importPhoto("file", 1000);
    h.store.reset();
    expect(h.appearance.wallpaper).toBeUndefined();
    await Promise.resolve();
    expect(h.photos.record).toBeNull();
    expect(h.store.getView()).toEqual({ status: "none" });
  });

  it("구독자는 보이는 사진 상태가 바뀔 때마다 알림을 받고 해제하면 끊긴다", async () => {
    const h = harness();
    const seen: string[] = [];
    const off = h.store.subscribe(() => seen.push(h.store.getView().status));
    await h.store.importPhoto("file", 1000);
    h.store.reset();
    off();
    h.store.choose({ kind: "preset", id: "bam" });
    expect(seen).toEqual(["ready", "none"]);
  });
});

describe("시작할 때", () => {
  it("참조가 사진이고 바이트가 있으면 읽어 올린다", async () => {
    const h = harness({ wallpaper: { kind: "image", width: 10, height: 8, rev: 5 } });
    h.photos.record = { v: 1, rev: 5, type: "image/jpeg", bytes: bytes(1234), width: 10, height: 8, thumb: "data:image/jpeg;base64,t" };
    await h.store.ensureLoaded();
    expect(h.store.getView()).toEqual({ status: "ready", dataUrl: "data:image/jpeg;base64,stored1234", thumb: "data:image/jpeg;base64,t", rev: 5 });
    expect(h.appearance.wallpaper).toEqual({ kind: "image", width: 10, height: 8, rev: 5 });
  });

  it("참조가 사진인데 바이트가 없으면 참조를 「없음」으로 거두고 그 사실을 남긴다", async () => {
    const h = harness({ wallpaper: { kind: "image", width: 10, height: 8, rev: 5 } });
    await h.store.ensureLoaded();
    expect(h.appearance.wallpaper).toBeUndefined();
    expect(h.store.getView()).toEqual({ status: "missing" });
  });

  it("참조가 사진이 아니면 읽지 않는다", async () => {
    const h = harness({ wallpaper: { kind: "solid", id: "slate" } });
    const read = vi.spyOn(h.photos, "read");
    await h.store.ensureLoaded();
    expect(read).not.toHaveBeenCalled();
    expect(h.store.getView()).toEqual({ status: "none" });
  });

  it("이미 읽었거나 읽는 중이면 다시 읽지 않는다", async () => {
    const h = harness({ wallpaper: { kind: "image", width: 10, height: 8, rev: 5 } });
    h.photos.record = { v: 1, rev: 5, type: "image/jpeg", bytes: bytes(10), width: 10, height: 8, thumb: null };
    const read = vi.spyOn(h.photos, "read");
    await Promise.all([h.store.ensureLoaded(), h.store.ensureLoaded()]);
    await h.store.ensureLoaded();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("읽는 도중 사람이 다른 배경을 고르면 늦게 도착한 읽기는 버려진다", async () => {
    const h = harness({ wallpaper: { kind: "image", width: 10, height: 8, rev: 5 } });
    h.photos.record = { v: 1, rev: 5, type: "image/jpeg", bytes: bytes(10), width: 10, height: 8, thumb: null };
    let release!: () => void;
    h.photos.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = h.store.ensureLoaded();
    expect(h.store.getView()).toEqual({ status: "loading" });
    h.store.choose({ kind: "solid", id: "slate" });
    release();
    await loading;
    expect(h.store.getView()).toEqual({ status: "none" });
    expect(h.appearance.wallpaper).toEqual({ kind: "solid", id: "slate" });
  });
});

describe("로그아웃·세션 경계", () => {
  it("사진 선택이면 메모리의 사진을 놓고 참조를 거둔다", async () => {
    const h = harness();
    await h.store.importPhoto("file", 1000);
    h.store.forget();
    expect(h.appearance.wallpaper).toBeUndefined();
    expect(h.store.getView()).toEqual({ status: "none" });
  });

  it("단색·기본 제공 선택은 취향이라 남긴다", () => {
    const h = harness({ wallpaper: { kind: "preset", id: "bam" } });
    h.store.forget();
    expect(h.appearance.wallpaper).toEqual({ kind: "preset", id: "bam" });
    expect(h.updates).toEqual([]);
  });

  it("읽는 도중의 로그아웃도 늦은 읽기를 버린다 (다음 사람의 화면에 앞 사람의 사진이 올라오지 않는다)", async () => {
    const h = harness({ wallpaper: { kind: "image", width: 10, height: 8, rev: 5 } });
    h.photos.record = { v: 1, rev: 5, type: "image/jpeg", bytes: bytes(10), width: 10, height: 8, thumb: null };
    let release!: () => void;
    h.photos.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = h.store.ensureLoaded();
    h.store.forget();
    release();
    await loading;
    expect(h.store.getView()).toEqual({ status: "none" });
    expect(h.appearance.wallpaper).toBeUndefined();
  });
});
