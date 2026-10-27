// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { DesktopDownloadError } from "@/lib/tauri";
import {
  createDownloadsStore,
  downloadFailureOf,
  DownloadFailedError,
  type DownloadsStore,
  type StorageLike,
} from "./downloadsStore";
import { ATTACHMENT, bytes, fake, SOURCE, type Fake } from "./downloadsTestKit";
import { buttonView, DOWNLOAD_STORAGE_KEY, rowActions, type DownloadItem } from "./downloadsModel";

// =============================================================================
// 다운로드 스토어 (#4587): 한 건이 가는 길(받기 → 셸 저장 → 파일 이름 기록), 진행 알림의 간격,
// 실패의 분류, 다시 받기, 지워진 파일, 저장소. 의존은 손으로 꽂은 가짜다(모듈을 바꿔 끼우지 않는다).
// fixture는 가상 팀(달무리 스튜디오)이다.
// =============================================================================

function only(store: DownloadsStore, id = "dl-1"): DownloadItem {
  const found = store.getItems().find((item) => item.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

let f: Fake;
let store: DownloadsStore;
beforeEach(() => {
  f = fake();
  store = createDownloadsStore(f.deps);
});

describe("한 건이 가는 길", () => {
  it("받고 → 셸에 쓰고 → 셸이 돌려준 파일 이름을 기록한다", async () => {
    f.saveAnswer = { fileName: "2분기 예산안 (1).pdf" };
    const done = store.start({ workspaceId: SOURCE.workspaceId, channelId: SOURCE.channelId, attachment: ATTACHMENT });

    expect(only(store)).toMatchObject({ phase: "receiving", name: "2분기 예산안.pdf", source: SOURCE });
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0]?.source).toEqual(SOURCE);

    f.fetches[0]?.resolve(bytes(1000));
    await done;

    // 셸에는 받은 바이트와 첨부의 이름이 간다. 디스크의 이름은 셸이 정해 돌려준다.
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]?.name).toBe("2분기 예산안.pdf");
    expect(f.saves[0]?.bytes.byteLength).toBe(1000);
    expect(only(store)).toMatchObject({
      phase: "done",
      fileName: "2분기 예산안 (1).pdf",
      receivedBytes: 1000,
      present: true,
      seen: false,
    });
    expect(buttonView(store.getItems()).badge).toBe("done");
  });

  it("끝난 건은 저장소에 남고, 진행 중인 건은 남지 않는다", async () => {
    const first = store.start({ workspaceId: SOURCE.workspaceId, channelId: SOURCE.channelId, attachment: ATTACHMENT });
    const second = store.start({
      workspaceId: SOURCE.workspaceId,
      channelId: SOURCE.channelId,
      attachment: { ...ATTACHMENT, id: "att-2", name: "시안.png", mime: "image/png" },
    });
    f.fetches[0]?.resolve(bytes(10));
    await first;
    const stored = JSON.parse(f.storage.data.get(DOWNLOAD_STORAGE_KEY) ?? "null") as { items: Array<{ id: string }> };
    expect(stored.items.map((entry) => entry.id)).toEqual(["dl-1"]);
    f.fetches[1]?.reject(new TypeError("Failed to fetch"));
    await second.catch(() => undefined);
    const after = JSON.parse(f.storage.data.get(DOWNLOAD_STORAGE_KEY) ?? "null") as { items: unknown[] };
    expect(after.items).toHaveLength(1);
  });

  it("앱을 다시 켜면 끝난 기록이 본 것으로 돌아오고 점을 켜지 않는다", async () => {
    const first = store.start({ workspaceId: SOURCE.workspaceId, channelId: SOURCE.channelId, attachment: ATTACHMENT });
    f.fetches[0]?.resolve(bytes(10));
    await first;
    const restarted = createDownloadsStore({ ...f.deps, storage: f.storage });
    expect(restarted.getItems()).toHaveLength(1);
    expect(restarted.getItems()[0]).toMatchObject({ phase: "done", seen: true, present: null, fileName: "2분기 예산안.pdf" });
    expect(buttonView(restarted.getItems())).toMatchObject({ activity: "idle", badge: "none" });
  });

  it("저장소가 없거나 던지면 기록 없이 돌아간다", async () => {
    const noStorage = createDownloadsStore({ ...f.deps, storage: null });
    const run = noStorage.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    f.fetches[0]?.resolve(bytes(10));
    await run;
    expect(noStorage.getItems()).toHaveLength(1);

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const guarded = createDownloadsStore({ ...f.deps, storage: throwing });
    expect(guarded.getItems()).toEqual([]);
    const second = guarded.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    f.fetches[1]?.resolve(bytes(10));
    await second;
    expect(only(guarded, "dl-2").phase).toBe("done");
    expect(() => guarded.clearHistory()).not.toThrow();
  });
});

describe("진행 알림", () => {
  it("잰 바이트가 목록에 반영되고 퍼센트가 한 칸 바뀔 때만 구독자를 깨운다", () => {
    void store.start({ workspaceId: "w", channelId: "c", attachment: { ...ATTACHMENT, sizeBytes: 1000 } });
    const listener = vi.fn();
    store.subscribe(listener);
    const progress = f.fetches[0]?.progress as (loaded: number, total: number | null) => void;

    progress(0, 1000);
    expect(only(store)).toMatchObject({ receivedBytes: 0, totalBytes: 1000 });
    const afterFirst = listener.mock.calls.length;
    // 같은 시각에 1바이트씩 100번: 퍼센트는 열 번만 바뀐다.
    for (let loaded = 1; loaded <= 100; loaded += 1) progress(loaded, 1000);
    const wakes = listener.mock.calls.length - afterFirst;
    expect(only(store).receivedBytes).toBeGreaterThan(0);
    expect(wakes).toBeLessThanOrEqual(11);
    expect(wakes).toBeGreaterThanOrEqual(10);
  });

  it("길이를 모르면 시간 간격(250ms)마다 반영한다", () => {
    void store.start({ workspaceId: "w", channelId: "c", attachment: { ...ATTACHMENT, sizeBytes: 0 } });
    const listener = vi.fn();
    store.subscribe(listener);
    const progress = f.fetches[0]?.progress as (loaded: number, total: number | null) => void;
    progress(100, null);
    expect(only(store).receivedBytes).toBe(100);
    const afterFirst = listener.mock.calls.length;
    progress(200, null);
    progress(300, null);
    expect(listener.mock.calls.length).toBe(afterFirst);
    expect(only(store).receivedBytes).toBe(100);
    f.clock.now += 250;
    progress(400, null);
    expect(only(store).receivedBytes).toBe(400);
  });

  it("건너뛴 알림은 잃지 않는다: 마지막 값은 다 받은 뒤의 저장 단계가 맞춘다", async () => {
    const run = store.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    const progress = f.fetches[0]?.progress as (loaded: number, total: number | null) => void;
    progress(10, 1000);
    progress(11, 1000);
    f.fetches[0]?.resolve(bytes(1000));
    await run;
    expect(only(store)).toMatchObject({ phase: "done", receivedBytes: 1000, totalBytes: 1000 });
  });
});

describe("실패", () => {
  it("이유가 분류되어 기록되고, 약속은 DownloadFailedError로 거절된다", async () => {
    const run = store.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    f.fetches[0]?.reject(new ApiError(404, "HTTP 404"));
    const failure = await run.then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(DownloadFailedError);
    expect((failure as DownloadFailedError).failure).toBe("gone");
    expect(only(store)).toMatchObject({ phase: "failed", failure: "gone", seen: false });
    expect(buttonView(store.getItems()).badge).toBe("failed");
    expect(rowActions(only(store))).toEqual([]);
  });

  it("셸이 쓰지 못한 이유(권한·공간·상한)가 그대로 이유가 된다", async () => {
    for (const [code, expected] of [
      ["denied", "denied"],
      ["disk-full", "disk-full"],
      ["too-large", "too-large"],
      ["refused", "failed"],
      ["failed", "failed"],
    ] as const) {
      const local = fake();
      const s = createDownloadsStore(local.deps);
      local.saveAnswer = new DesktopDownloadError(code);
      const run = s.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
      local.fetches[0]?.resolve(bytes(10));
      await run.catch(() => undefined);
      expect(only(s).failure, code).toBe(expected);
    }
  });

  it("오류의 종류가 이유를 고른다", () => {
    expect(downloadFailureOf(new ApiError(401, "HTTP 401"))).toBe("auth");
    expect(downloadFailureOf(new ApiError(403, "HTTP 403"))).toBe("gone");
    expect(downloadFailureOf(new ApiError(404, "HTTP 404"))).toBe("gone");
    expect(downloadFailureOf(new ApiError(500, "HTTP 500"))).toBe("failed");
    expect(downloadFailureOf(new NetworkError("unreachable", 15_000))).toBe("network");
    expect(downloadFailureOf(new TypeError("Failed to fetch"))).toBe("network");
    expect(downloadFailureOf(new Error("boom"))).toBe("failed");
    expect(downloadFailureOf("string")).toBe("failed");
  });

  it("다시 시도하면 실패 행이 새 건으로 바뀐다. 다시 해도 같은 이유는 새로 만들지 않는다", async () => {
    const run = store.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    f.fetches[0]?.reject(new TypeError("Failed to fetch"));
    await run.catch(() => undefined);
    expect(only(store).failure).toBe("network");

    const retry = store.retry("dl-1");
    expect(store.getItems().map((item) => item.id)).toEqual(["dl-2"]);
    expect(f.fetches[1]?.source).toEqual({ workspaceId: "w", channelId: "c", attachmentId: "att-budget" });
    f.fetches[1]?.resolve(bytes(10));
    await retry;
    expect(only(store, "dl-2").phase).toBe("done");

    // 404는 몇 번을 해도 같다: 아무것도 하지 않는다.
    const gone = store.start({ workspaceId: "w", channelId: "c", attachment: { ...ATTACHMENT, id: "att-x" } });
    f.fetches[2]?.reject(new ApiError(404, "HTTP 404"));
    await gone.catch(() => undefined);
    // 기다리지 않는다: 잘못 다시 보내면 영원히 열린 약속이 되어 시험이 붉어지는 대신 멈춘다.
    void store.retry("dl-3");
    await Promise.resolve();
    expect(f.fetches).toHaveLength(3);
    expect(only(store, "dl-3").phase).toBe("failed");
  });
});

describe("다시 다운로드", () => {
  async function finished(): Promise<void> {
    const run = store.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    f.fetches[0]?.resolve(bytes(10));
    await run;
  }

  it("파일이 있는 행은 남기고 새 건을 만든다(다른 파일이다)", async () => {
    await finished();
    f.saveAnswer = { fileName: "2분기 예산안 (1).pdf" };
    const again = store.redownload("dl-1");
    f.fetches[1]?.resolve(bytes(10));
    await again;
    expect(store.getItems().map((item) => [item.id, item.fileName])).toEqual([
      ["dl-2", "2분기 예산안 (1).pdf"],
      ["dl-1", "2분기 예산안.pdf"],
    ]);
  });

  it("파일이 지워진 행은 새 건이 대신하고 저장소에서도 사라진다", async () => {
    await finished();
    f.probeAnswer = [false];
    await store.refreshPresence();
    expect(only(store).present).toBe(false);
    const again = store.redownload("dl-1");
    expect(store.getItems().map((item) => item.id)).toEqual(["dl-2"]);
    const stored = JSON.parse(f.storage.data.get(DOWNLOAD_STORAGE_KEY) ?? "null") as { items: unknown[] };
    expect(stored.items).toHaveLength(0);
    f.fetches[1]?.resolve(bytes(10));
    await again;
    expect(only(store, "dl-2").phase).toBe("done");
  });

  it("끝나지 않은 건에는 아무것도 하지 않는다", async () => {
    void store.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    void store.redownload("dl-1");
    void store.retry("dl-1");
    await Promise.resolve();
    expect(f.fetches).toHaveLength(1);
  });
});

describe("지워진 파일과 행 행동", () => {
  async function finished(): Promise<void> {
    const run = store.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    f.fetches[0]?.resolve(bytes(10));
    await run;
  }

  it("셸의 답이 목록에 반영되고, 못 물으면 아는 대로 둔다", async () => {
    await finished();
    f.probeAnswer = [false];
    await store.refreshPresence();
    expect(only(store).present).toBe(false);
    expect(rowActions(only(store))).toEqual(["redownload"]);

    f.probeAnswer = new DesktopDownloadError("failed");
    await store.refreshPresence();
    // 모르는 것은 「없다」가 아니다.
    expect(only(store).present).toBe(false);
    f.probeAnswer = [true];
    await store.refreshPresence();
    expect(only(store).present).toBe(true);
  });

  it("물은 수와 다른 길이의 답은 답이 아니다: 빠진 칸을 「없다」로 읽지 않는다", async () => {
    f.saveAnswer = { fileName: "예산안.pdf" };
    const run = store.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    f.fetches[0]?.resolve(bytes(10));
    await run;
    f.saveAnswer = { fileName: "시안.png" };
    const second = store.start({ workspaceId: "w", channelId: "c", attachment: { ...ATTACHMENT, id: "att-2", name: "시안.png" } });
    f.fetches[1]?.resolve(bytes(10));
    await second;
    f.probeAnswer = [];
    await store.refreshPresence();
    f.probeAnswer = [false];
    await store.refreshPresence();
    // 두 파일을 물었는데 칸이 하나뿐이거나 없으니 어느 파일도 지워진 것으로 읽히지 않는다.
    expect(store.getItems().map((item) => item.present)).toEqual([true, true]);
    // 목록은 최신이 위다: 시안.png가 첫 칸, 예산안.pdf가 둘째 칸.
    f.probeAnswer = [true, false];
    await store.refreshPresence();
    expect(store.getItems().map((item) => [item.fileName, item.present])).toEqual([
      ["시안.png", true],
      ["예산안.pdf", false],
    ]);
  });

  it("이름이 같은 두 행은 한 번만 묻고 같은 답을 받는다", async () => {
    for (const index of [0, 1]) {
      const run = store.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
      f.fetches[index]?.resolve(bytes(10));
      await run;
    }
    const asked: string[][] = [];
    const spied = createDownloadsStore({
      ...f.deps,
      storage: f.storage,
      probe: async (names) => {
        asked.push([...names]);
        return names.map(() => false);
      },
    });
    expect(spied.getItems()).toHaveLength(2);
    await spied.refreshPresence();
    expect(asked).toEqual([["2분기 예산안.pdf"]]);
    expect(spied.getItems().map((item) => item.present)).toEqual([false, false]);
  });

  it("끝난 파일이 없으면 셸에 묻지 않는다", async () => {
    const probe = vi.fn(async () => []);
    const empty = createDownloadsStore({ ...f.deps, probe });
    await empty.refreshPresence();
    expect(probe).not.toHaveBeenCalled();
  });

  it("열기와 Finder 보기는 셸이 돌려준 파일 이름으로 한다", async () => {
    f.saveAnswer = { fileName: "2분기 예산안 (2).pdf" };
    await finished();
    expect(await store.open("dl-1")).toBe("ok");
    expect(await store.reveal("dl-1")).toBe("ok");
    expect(f.opens).toEqual(["2분기 예산안 (2).pdf"]);
    expect(f.reveals).toEqual(["2분기 예산안 (2).pdf"]);
  });

  it("행동이 먼저 알아낸 지워짐은 행을 고치고, 열 수 없는 종류와 실패는 결과로 말한다", async () => {
    await finished();
    f.rowError = new DesktopDownloadError("not-openable");
    expect(await store.open("dl-1")).toBe("not-openable");
    expect(only(store).present).toBe(true);

    f.rowError = new DesktopDownloadError("failed");
    expect(await store.reveal("dl-1")).toBe("failed");

    f.rowError = new DesktopDownloadError("missing");
    expect(await store.open("dl-1")).toBe("missing");
    expect(only(store).present).toBe(false);

    expect(await store.open("nope")).toBe("failed");
  });

  it("폴더 열기는 성공하면 true, 못 열면 false다", async () => {
    expect(await store.openFolder()).toBe(true);
    f.folderError = new DesktopDownloadError("failed");
    expect(await store.openFolder()).toBe(false);
  });
});

describe("본 것과 기록 지우기", () => {
  it("목록을 열면 점이 꺼지고, 기록 지우기는 끝난 건과 저장소만 지운다", async () => {
    const run = store.start({ workspaceId: "w", channelId: "c", attachment: ATTACHMENT });
    f.fetches[0]?.resolve(bytes(10));
    await run;
    expect(buttonView(store.getItems()).badge).toBe("done");
    store.markSeen();
    expect(buttonView(store.getItems()).badge).toBe("none");

    void store.start({ workspaceId: "w", channelId: "c", attachment: { ...ATTACHMENT, id: "att-2" } });
    store.clearHistory();
    expect(store.getItems().map((item) => item.id)).toEqual(["dl-2"]);
    expect(f.storage.data.has(DOWNLOAD_STORAGE_KEY)).toBe(false);
  });

  it("바뀌지 않으면 구독자를 깨우지 않는다", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.markSeen();
    store.clearHistory();
    expect(listener).not.toHaveBeenCalled();
  });
});
