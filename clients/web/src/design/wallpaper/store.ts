import { useSyncExternalStore } from "react";
import type { WallpaperRef } from "@momo/core/design/appearance";
import {
  importPhoto as importPhotoWithPorts,
  type ImportFailure,
  type PhotoPorts,
  type PresetId,
  type SolidId,
} from "@momo/core/design/wallpaper";
import { getAppearance, updateAppearance } from "@/design/theme";
import { defaultPhotoStore, type PhotoStore } from "./idb";
import { canvasPhotoPorts } from "./photo";
import { onWallpaperSignOut } from "./signOut";

// =============================================================================
// 배경화면 스토어: 고른 것(외양 레코드의 참조)과 사진(IndexedDB)을 한 흐름으로 묶는다
// (ADR-0189 증보 3 D4, AP-4 #4191).
//
// 두 곳에 나뉘어 산다. **무엇을 골랐는가**(종류·id·사진의 크기와 번호)는 외양 레코드 `wallpaper`(localStorage,
// `updateAppearance`)이고, **사진 바이트**는 IndexedDB 한 칸(`idb.ts`)이다. 이 파일은 둘을 어긋나지 않게 한다.
//
//   · 사진을 고르면 바이트를 **먼저** 쓰고 성공한 뒤에 참조를 올린다. 저장이 실패하면 앞의 선택이 그대로다.
//   · 단색·기본 제공을 고르거나 「기본으로」를 누르면 참조를 먼저 바꾸고 사진을 지운다(증보 2 D7).
//   · 시작할 때 참조가 사진인데 바이트가 없으면(브라우저가 사이트 데이터를 지웠다, 다른 탭이 지웠다) 참조를
//     「없음」으로 거두고 그 사실을 한 번 말한다.
//   · 로그아웃·세션 경계는 `signOut.ts`가 바이트를 지우고, 이 스토어가 신호를 들어 참조를 거둔다.
//
// 주입할 수 있는 모양(`createWallpaperStore`)으로 짠 이유는 노드에 IndexedDB·캔버스가 없어서다: 시험은 메모리
// 저장소와 가짜 포트로 위 규칙을 잰다. 실제 IndexedDB·캔버스는 브라우저 시험이 잰다.
// =============================================================================

export type PhotoView =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; dataUrl: string; thumb: string | null; rev: number }
  /** 참조가 가리키는 사진이 저장소에 없었다. 참조는 이미 「없음」으로 거뒀고, 다음 선택까지 이 사실을 말한다. */
  | { status: "missing" };

export type WallpaperChoice = { kind: "solid"; id: SolidId } | { kind: "preset"; id: PresetId };

export type ImportResult = { ok: true } | { ok: false; reason: ImportFailure | "save-failed" };

export interface WallpaperStoreDeps<S, H, B> {
  photos: PhotoStore;
  ports: PhotoPorts<S, H, B>;
  bytesOf(blob: B): Promise<ArrayBuffer>;
  dataUrlOf(blob: B): Promise<string>;
  dataUrlOfBytes(bytes: ArrayBuffer): Promise<string>;
  appearance: {
    get(): { wallpaper?: WallpaperRef };
    update(patch: { wallpaper: WallpaperRef | undefined }): void;
  };
}

export interface WallpaperStore<S> {
  getView(): PhotoView;
  subscribe(listener: () => void): () => void;
  /** 참조가 사진이면 바이트를 읽어 올린다. 이미 읽었거나 읽는 중이면 아무것도 하지 않는다. */
  ensureLoaded(): Promise<void>;
  importPhoto(source: S, sourceBytes: number): Promise<ImportResult>;
  choose(choice: WallpaperChoice): void;
  reset(): void;
  /** 로그아웃·세션 경계: 메모리의 사진을 놓고 참조를 거둔다(바이트는 `signOut.ts`가 지운다). */
  forget(): void;
}

export function createWallpaperStore<S, H, B>(deps: WallpaperStoreDeps<S, H, B>): WallpaperStore<S> {
  let view: PhotoView = { status: "none" };
  /** 읽는 중인 일이 낡았는지 가리는 번호. 선택이 바뀌면 올려서 늦게 도착한 읽기를 버린다. */
  let generation = 0;
  const listeners = new Set<() => void>();

  function setView(next: PhotoView): void {
    view = next;
    for (const listener of [...listeners]) listener();
  }

  /** 참조를 바꾸고 사진을 놓는다. 참조가 먼저다: 화면이 바로 따라온다. */
  function replace(next: WallpaperRef | undefined): void {
    generation += 1;
    deps.appearance.update({ wallpaper: next });
    if (view.status !== "none") setView({ status: "none" });
    void deps.photos.clear();
  }

  return {
    getView: () => view,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async ensureLoaded() {
      const ref = deps.appearance.get().wallpaper;
      if (ref?.kind !== "image") {
        if (view.status === "ready" || view.status === "loading") setView({ status: "none" });
        return;
      }
      if (view.status === "ready" || view.status === "loading") return;
      generation += 1;
      const mine = generation;
      setView({ status: "loading" });
      const stored = await deps.photos.read();
      if (mine !== generation) return;
      if (stored === null) {
        // 참조는 있는데 바이트가 없다: 선택을 거두고 이유를 남긴다.
        setView({ status: "missing" });
        if (deps.appearance.get().wallpaper?.kind === "image") deps.appearance.update({ wallpaper: undefined });
        return;
      }
      let dataUrl: string;
      try {
        dataUrl = await deps.dataUrlOfBytes(stored.bytes);
      } catch {
        if (mine !== generation) return;
        setView({ status: "missing" });
        if (deps.appearance.get().wallpaper?.kind === "image") deps.appearance.update({ wallpaper: undefined });
        return;
      }
      if (mine !== generation) return;
      setView({ status: "ready", dataUrl, thumb: stored.thumb, rev: stored.rev });
    },

    async importPhoto(source, sourceBytes) {
      const outcome = await importPhotoWithPorts(deps.ports, source, sourceBytes);
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      const { photo } = outcome;
      let dataUrl: string;
      let thumb: string | null = null;
      try {
        const bytes = await deps.bytesOf(photo.bytes);
        dataUrl = await deps.dataUrlOf(photo.bytes);
        if (photo.thumb !== null) thumb = await deps.dataUrlOf(photo.thumb.bytes).catch(() => null);
        await deps.photos.write({
          v: 1,
          rev: photo.rev,
          type: "image/jpeg",
          bytes,
          width: photo.width,
          height: photo.height,
          thumb,
        });
      } catch {
        return { ok: false, reason: "save-failed" };
      }
      generation += 1;
      setView({ status: "ready", dataUrl, thumb, rev: photo.rev });
      deps.appearance.update({
        wallpaper: { kind: "image", width: photo.width, height: photo.height, rev: photo.rev },
      });
      return { ok: true };
    },

    choose(choice) {
      replace(choice);
    },

    reset() {
      replace(undefined);
    },

    forget() {
      generation += 1;
      if (view.status !== "none") setView({ status: "none" });
      if (deps.appearance.get().wallpaper?.kind === "image") deps.appearance.update({ wallpaper: undefined });
    },
  };
}

// ---- 앱이 쓰는 한 벌 ------------------------------------------------------------

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("wallpaper data url"));
    };
    reader.onerror = () => reject(new Error("wallpaper data url"));
    reader.readAsDataURL(blob);
  });
}

let instance: WallpaperStore<Blob> | null = null;

/** 앱의 스토어. 처음 부를 때 만들고, 그때 로그아웃 신호를 듣기 시작한다. */
export function wallpaperStore(): WallpaperStore<Blob> {
  if (instance === null) {
    const created = createWallpaperStore<Blob, ImageBitmap, Blob>({
      photos: defaultPhotoStore(),
      ports: canvasPhotoPorts,
      bytesOf: (blob) => blob.arrayBuffer(),
      dataUrlOf: blobToDataUrl,
      dataUrlOfBytes: (bytes) => blobToDataUrl(new Blob([bytes], { type: "image/jpeg" })),
      appearance: { get: getAppearance, update: updateAppearance },
    });
    onWallpaperSignOut(created.forget);
    instance = created;
  }
  return instance;
}

export function usePhotoView(): PhotoView {
  const store = wallpaperStore();
  return useSyncExternalStore(store.subscribe, store.getView, store.getView);
}
