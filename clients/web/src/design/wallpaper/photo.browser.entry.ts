import { importPhoto } from "@momo/core/design/wallpaper";
import { indexedDbPhotoStore } from "./idb";
import { canvasPhotoPorts } from "./photo";
import { forgetWallpaperOnSignOut, onWallpaperSignOut } from "./signOut";

// `photo.browser.test.ts`가 진짜 브라우저(Chromium·WebKit)에 올리는 번들의 입구다. 앱이 쓰는 그 포트(`canvasPhotoPorts`)와 그
// 계단(core `importPhoto`)을 그대로 부르고, 결과 바이트를 시험에 돌려준다. 사진이 사는 IndexedDB 한 칸(`idb.ts`)과
// 로그아웃의 삭제(`signOut.ts`)도 앱의 그 코드로 진짜 IndexedDB에 건다. 앱 번들에는 들어가지 않는다(아무도 import하지 않는다).

export interface RunResult {
  ok: boolean;
  reason?: string;
  bytes?: number[];
  width?: number;
  height?: number;
  thumb?: number[] | null;
}

async function run(bytes: number[], type: string): Promise<RunResult> {
  const file = new File([new Uint8Array(bytes)], "fixture", { type });
  const outcome = await importPhoto(canvasPhotoPorts, file, file.size);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const photo = new Uint8Array(await outcome.photo.bytes.arrayBuffer());
  const thumb = outcome.photo.thumb ? new Uint8Array(await outcome.photo.thumb.bytes.arrayBuffer()) : null;
  return { ok: true, bytes: Array.from(photo), width: outcome.photo.width, height: outcome.photo.height, thumb: thumb ? Array.from(thumb) : null };
}

(globalThis as unknown as { __wallpaperPhoto: { run: typeof run } }).__wallpaperPhoto = { run };

export interface StoredView {
  rev: number;
  bytes: number[];
  width: number;
  height: number;
  thumb: string | null;
}

/** 시험이 부르는 IndexedDB 한 칸. 부를 때마다 새 연결(`indexedDbPhotoStore()`)로 읽고 써서 메모리 캐시가 답이 될 수 없다. */
const store = {
  async write(bytes: number[], rev: number, thumb: string | null): Promise<void> {
    await indexedDbPhotoStore().write({ v: 1, rev, type: "image/jpeg", bytes: new Uint8Array(bytes).buffer, width: 4, height: 3, thumb });
  },
  async read(): Promise<StoredView | null> {
    const photo = await indexedDbPhotoStore().read();
    if (photo === null) return null;
    return { rev: photo.rev, bytes: Array.from(new Uint8Array(photo.bytes)), width: photo.width, height: photo.height, thumb: photo.thumb };
  },
  async clear(): Promise<void> {
    await indexedDbPhotoStore().clear();
  },
  /** 앱의 로그아웃 경로(`forgetWallpaperOnSignOut`)를 그대로 부르고 구독자가 몇 번 알림을 받았는지 돌려준다. */
  signOut(): number {
    let calls = 0;
    const off = onWallpaperSignOut(() => {
      calls += 1;
    });
    forgetWallpaperOnSignOut();
    off();
    return calls;
  },
};

(globalThis as unknown as { __wallpaperStore: typeof store }).__wallpaperStore = store;
