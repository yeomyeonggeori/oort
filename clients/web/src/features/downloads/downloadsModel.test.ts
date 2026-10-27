import { describe, expect, it } from "vitest";
import {
  addDownload,
  aggregateRatio,
  applyPresence,
  beginSaving,
  buttonView,
  canRetry,
  completeDownload,
  DOWNLOAD_HISTORY_LIMIT,
  DOWNLOAD_RING_STEPS,
  extensionOf,
  failDownload,
  forgetFinished,
  isOpenableFileName,
  itemRatio,
  markAllSeen,
  markMissing,
  newDownload,
  parseHistory,
  receiveBytes,
  removeDownload,
  ringStep,
  rowActions,
  serializeHistory,
  type DownloadItem,
  type DownloadList,
} from "./downloadsModel";

// =============================================================================
// 다운로드 패널의 순수 모델 (#4587). 시험 대상: 진행 상태 모델, 목록 기록(최근 N개·지워진 파일),
// 단추 상태(없음·진행·완료 점), 행의 행동, 저장·복원. fixture는 가상 팀(달무리 스튜디오)이다.
// =============================================================================

const SOURCE = { workspaceId: "ws-1", channelId: "ch-1", attachmentId: "att-1" };

function item(id: string, over: Partial<DownloadItem> = {}): DownloadItem {
  return {
    ...newDownload({
      id,
      source: { ...SOURCE, attachmentId: `att-${id}` },
      name: `${id}.pdf`,
      mime: "application/pdf",
      sizeBytes: 1000,
      nowMs: 1_000,
    }),
    ...over,
  };
}

function done(id: string, over: Partial<DownloadItem> = {}): DownloadItem {
  return item(id, {
    phase: "done",
    receivedBytes: 1000,
    totalBytes: 1000,
    fileName: `${id}.pdf`,
    finishedAtMs: 2_000,
    seen: true,
    present: true,
    ...over,
  });
}

function only(list: DownloadList, id: string): DownloadItem {
  const found = list.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

describe("진행 상태 전이", () => {
  it("받는 중 → 저장 중 → 끝남, 셸이 돌려준 파일 이름이 기록된다", () => {
    let list: DownloadList = addDownload([], item("a", { sizeBytes: 5000 }));
    expect(only(list, "a").phase).toBe("receiving");

    list = receiveBytes(list, "a", 2500, 5000);
    expect(only(list, "a")).toMatchObject({ receivedBytes: 2500, totalBytes: 5000 });
    expect(itemRatio(only(list, "a"))).toBe(0.5);

    list = beginSaving(list, "a", 5000);
    expect(only(list, "a")).toMatchObject({ phase: "saving", receivedBytes: 5000, totalBytes: 5000 });

    list = completeDownload(list, "a", "예산안 (1).pdf", 9_000);
    expect(only(list, "a")).toMatchObject({
      phase: "done",
      fileName: "예산안 (1).pdf",
      finishedAtMs: 9_000,
      present: true,
      seen: false,
      failure: null,
    });
  });

  it("받은 양은 줄지 않고 말한 전체를 넘지 않는다", () => {
    let list: DownloadList = addDownload([], item("a"));
    list = receiveBytes(list, "a", 600, 1000);
    // 늦게 도착한 오래된 알림.
    expect(receiveBytes(list, "a", 300, 1000)).toBe(list);
    // 전체를 넘겨 말하는 알림은 전체에서 멈춘다.
    list = receiveBytes(list, "a", 5000, 1000);
    expect(only(list, "a").receivedBytes).toBe(1000);
  });

  it("전체를 처음 알게 되면 그 값을 쥐고, 이후 알림이 null이어도 잃지 않는다", () => {
    let list: DownloadList = addDownload([], item("a", { sizeBytes: 0 }));
    list = receiveBytes(list, "a", 100, null);
    expect(only(list, "a").totalBytes).toBeNull();
    list = receiveBytes(list, "a", 200, 800);
    expect(only(list, "a").totalBytes).toBe(800);
    list = receiveBytes(list, "a", 300, null);
    expect(only(list, "a")).toMatchObject({ totalBytes: 800, receivedBytes: 300 });
  });

  it("실패는 이유를 들고 끝나며, 끝난 건은 더 바뀌지 않는다", () => {
    let list: DownloadList = addDownload([], item("a"));
    list = failDownload(list, "a", "network", 5_000);
    expect(only(list, "a")).toMatchObject({ phase: "failed", failure: "network", seen: false });
    expect(receiveBytes(list, "a", 10, 1000)).toBe(list);
    expect(completeDownload(list, "a", "x.pdf", 6_000)).toBe(list);
    expect(failDownload(list, "a", "gone", 7_000)).toBe(list);
  });

  it("모르는 id와 의미 없는 전이는 같은 배열을 돌려준다(헛된 갱신이 없다)", () => {
    const list: DownloadList = [done("a")];
    expect(receiveBytes(list, "nope", 1, 1)).toBe(list);
    expect(beginSaving(list, "a", 10)).toBe(list);
    expect(removeDownload(list, "nope")).toBe(list);
    expect(markMissing(list, "nope")).toBe(list);
    expect(markAllSeen(list)).toBe(list);
  });
});

describe("진행률", () => {
  it("한 바이트도 못 받았으면 0%가 아니라 모른다(null)", () => {
    expect(itemRatio(item("a"))).toBeNull();
    expect(aggregateRatio([item("a")])).toBeNull();
  });

  it("전체를 모르고 첨부 메타의 크기도 없으면 null이다", () => {
    const unknown = item("a", { sizeBytes: 0, receivedBytes: 500 });
    expect(itemRatio(unknown)).toBeNull();
  });

  it("서버가 길이를 말하지 않으면 첨부 메타의 크기로 가늠한다", () => {
    const sized = item("a", { sizeBytes: 2000, receivedBytes: 500, totalBytes: null });
    expect(itemRatio(sized)).toBe(0.25);
  });

  it("진행 중인 건 전체의 한 비율은 크기로 가중하고, 하나라도 모르면 전체가 모른다", () => {
    const small = item("small", { sizeBytes: 1000, receivedBytes: 1000, totalBytes: 1000 });
    const big = item("big", { sizeBytes: 9000, receivedBytes: 0, totalBytes: null });
    // 큰 쪽은 아직 한 바이트도 못 받았다: 일부만 재서 막대를 그리면 모르는 건이 끝날 때 뛴다.
    expect(aggregateRatio([small, big])).toBeNull();
    const halfBig = item("big", { sizeBytes: 9000, receivedBytes: 4500, totalBytes: 9000 });
    // (1000 + 4500) / (1000 + 9000)
    expect(aggregateRatio([small, halfBig])).toBeCloseTo(0.55, 5);
    // 끝난 건은 비율에 들어가지 않는다.
    expect(aggregateRatio([done("x"), halfBig])).toBeCloseTo(0.5, 5);
    expect(aggregateRatio([done("x")])).toBeNull();
  });

  it("링은 시작했으면 적어도 한 칸이고 끝은 열두 칸이다", () => {
    expect(DOWNLOAD_RING_STEPS).toBe(12);
    expect(ringStep(0.001)).toBe(1);
    expect(ringStep(0.5)).toBe(6);
    expect(ringStep(0.99)).toBe(12);
    expect(ringStep(1)).toBe(12);
  });
});

describe("목록 기록: 최근 N개와 지워진 파일", () => {
  it("한도를 넘으면 가장 오래된 끝난 건부터 버린다", () => {
    let list: DownloadList = [];
    for (let n = 1; n <= 5; n += 1) list = addDownload(list, done(`d${n}`), 3);
    expect(list.map((entry) => entry.id)).toEqual(["d5", "d4", "d3"]);
  });

  it("진행 중인 건은 한도 때문에 버리지 않는다", () => {
    let list: DownloadList = [];
    list = addDownload(list, item("running"), 2);
    list = addDownload(list, done("d1"), 2);
    list = addDownload(list, done("d2"), 2);
    list = addDownload(list, done("d3"), 2);
    // 가장 오래된 running은 끝나지 않았으므로 남고, 끝난 d1·d2가 먼저 나간다.
    expect(list.map((entry) => entry.id)).toEqual(["d3", "running"]);
    const allRunning = addDownload(
      addDownload(addDownload([], item("r1"), 2), item("r2"), 2),
      item("r3"),
      2
    );
    expect(allRunning.map((entry) => entry.id)).toEqual(["r3", "r2", "r1"]);
  });

  it("기본 한도는 30이다", () => {
    expect(DOWNLOAD_HISTORY_LIMIT).toBe(30);
    let list: DownloadList = [];
    for (let n = 0; n < 40; n += 1) list = addDownload(list, done(`d${n}`));
    expect(list).toHaveLength(30);
    expect(list[0]?.id).toBe("d39");
    expect(list.at(-1)?.id).toBe("d10");
  });

  it("셸의 답이 있으면 지워진 파일을 표시하고, 답에 없는 이름은 아는 대로 둔다", () => {
    const list: DownloadList = [
      done("kept", { fileName: "kept.pdf" }),
      done("gone", { fileName: "gone.pdf" }),
      done("unasked", { fileName: "unasked.pdf" }),
      item("running"),
    ];
    const next = applyPresence(
      list,
      new Map([
        ["kept.pdf", true],
        ["gone.pdf", false],
      ])
    );
    expect(only(next, "kept").present).toBe(true);
    expect(only(next, "gone").present).toBe(false);
    expect(only(next, "unasked").present).toBe(true);
    expect(only(next, "running").present).toBeNull();
    // 같은 답을 다시 반영해도 배열은 그대로다.
    expect(applyPresence(next, new Map([["gone.pdf", false]]))).toBe(next);
  });

  it("행동이 먼저 알아낸 지워짐도 같은 표시가 된다", () => {
    const list: DownloadList = [done("a")];
    expect(only(markMissing(list, "a"), "a").present).toBe(false);
  });

  it("기록 지우기는 끝난 건만 잊고 진행 중인 건은 남긴다", () => {
    const list: DownloadList = [item("running"), done("a"), failDownload([item("f")], "f", "failed", 1)[0] as DownloadItem];
    expect(forgetFinished(list).map((entry) => entry.id)).toEqual(["running"]);
    const onlyRunning: DownloadList = [item("running")];
    expect(forgetFinished(onlyRunning)).toBe(onlyRunning);
  });
});

describe("상단 단추의 상태: 없음 · 진행 · 완료 점", () => {
  it("아무것도 없거나 이미 본 것뿐이면 없음이다", () => {
    expect(buttonView([])).toEqual({
      activity: "idle",
      step: null,
      badge: "none",
      activeCount: 0,
      unseenCount: 0,
    });
    expect(buttonView([done("a"), done("b")]).badge).toBe("none");
  });

  it("받는 중이면 진행이다: 잰 값이 있으면 칸, 없으면 모르는 링(step null)", () => {
    const measured = [item("a", { receivedBytes: 500, totalBytes: 1000 })];
    expect(buttonView(measured)).toMatchObject({ activity: "progress", step: 6, activeCount: 1 });
    expect(buttonView([item("a")])).toMatchObject({ activity: "progress", step: null });
  });

  it("끝났는데 안 본 것이 있으면 점이다. 실패가 완료보다 먼저 말한다", () => {
    expect(buttonView([done("a", { seen: false })])).toMatchObject({
      activity: "idle",
      badge: "done",
      unseenCount: 1,
    });
    const failed = failDownload([item("f")], "f", "network", 5)[0] as DownloadItem;
    expect(buttonView([done("a", { seen: false }), failed]).badge).toBe("failed");
  });

  it("링과 점은 함께 설 수 있다(받는 사이 앞의 것이 끝났다)", () => {
    const view = buttonView([item("run", { receivedBytes: 100, totalBytes: 1000 }), done("a", { seen: false })]);
    expect(view).toMatchObject({ activity: "progress", badge: "done" });
  });

  it("목록을 열면(모두 본 것) 점이 꺼지고 링은 그대로다", () => {
    const list: DownloadList = [item("run", { receivedBytes: 100, totalBytes: 1000 }), done("a", { seen: false })];
    const seen = markAllSeen(list);
    expect(buttonView(seen)).toMatchObject({ activity: "progress", badge: "none" });
    // 진행 중인 건은 건드리지 않는다: 끝나면 그때 점이 켜진다.
    expect(only(seen, "run").seen).toBe(false);
    const finished = completeDownload(seen, "run", "run.pdf", 3_000);
    expect(buttonView(finished)).toMatchObject({ activity: "idle", badge: "done" });
  });
});

describe("행의 행동", () => {
  it("진행 중에는 없다", () => {
    expect(rowActions(item("a"))).toEqual([]);
    expect(rowActions(item("a", { phase: "saving" }))).toEqual([]);
  });

  it("실패는 같은 요청이 달라질 수 있을 때만 다시 시도를 준다", () => {
    for (const failure of ["network", "auth", "denied", "disk-full", "failed"] as const) {
      expect(canRetry(failure)).toBe(true);
      expect(rowActions(item("a", { phase: "failed", failure }))).toEqual(["retry"]);
    }
    for (const failure of ["gone", "too-large"] as const) {
      expect(canRetry(failure)).toBe(false);
      expect(rowActions(item("a", { phase: "failed", failure }))).toEqual([]);
    }
  });

  it("끝났고 파일이 있으면 열기 · Finder에서 보기 · 다시 다운로드", () => {
    expect(rowActions(done("a"))).toEqual(["open", "reveal", "redownload"]);
    // 아직 묻지 않았으면(null) 있다고 본다. 틀리면 셸이 missing으로 답하고 행이 고친다.
    expect(rowActions(done("a", { present: null }))).toEqual(["open", "reveal", "redownload"]);
  });

  it("지워진 파일은 다시 다운로드뿐이다", () => {
    expect(rowActions(done("a", { present: false }))).toEqual(["redownload"]);
  });

  it("실행·설치하는 종류는 열기를 주지 않고 Finder 보기만 남긴다", () => {
    expect(rowActions(done("a", { fileName: "setup.command" }))).toEqual(["reveal", "redownload"]);
    expect(rowActions(done("a", { fileName: "page.HTML" }))).toEqual(["reveal", "redownload"]);
  });

  it("확장자는 셸과 같은 규칙으로 읽는다", () => {
    expect(extensionOf("a.pdf.command")).toBe("command");
    expect(extensionOf("RUN.COMMAND")).toBe("command");
    expect(extensionOf("evil.exe.")).toBe("exe");
    expect(extensionOf("evil.exe ")).toBe("exe");
    expect(extensionOf("no-extension")).toBe("");
    expect(extensionOf(".hidden")).toBe("");
    expect(extensionOf("report (1)")).toBe("");
    expect(extensionOf(`x.${"e".repeat(17)}`)).toBe("");
    expect(isOpenableFileName("report.pdf")).toBe(true);
    expect(isOpenableFileName("install.pkg")).toBe(false);
    expect(isOpenableFileName("a.pdf.command")).toBe(false);
  });
});

describe("저장과 복원", () => {
  it("끝난 것만 저장하고 돌아온 기록은 본 것이다", () => {
    const list: DownloadList = [
      item("running"),
      failDownload([item("f")], "f", "failed", 1)[0] as DownloadItem,
      done("b", { finishedAtMs: 3_000, fileName: "b (1).pdf" }),
      done("a", { finishedAtMs: 2_000 }),
    ];
    // 저장되는 것 자체가 끝난 둘뿐이다(복원이 걸러 주기 전에, 쓰는 쪽에서 이미).
    const written = JSON.parse(serializeHistory(list)) as { v: number; items: Array<{ id: string }> };
    expect(written.v).toBe(1);
    expect(written.items.map((entry) => entry.id)).toEqual(["b", "a"]);
    const restored = parseHistory(serializeHistory(list));
    expect(restored.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(restored[0]).toMatchObject({
      phase: "done",
      fileName: "b (1).pdf",
      seen: true,
      present: null,
      source: { workspaceId: "ws-1", channelId: "ch-1", attachmentId: "att-b" },
    });
    expect(buttonView(restored).badge).toBe("none");
  });

  it("저장은 최근 N개이고 복원은 최신이 위다", () => {
    const list: DownloadList = [];
    const many = Array.from({ length: 8 }, (_, n) => done(`d${n}`, { finishedAtMs: 1_000 + n }));
    const serialized = serializeHistory(many.reverse().concat(list), 5);
    const restored = parseHistory(serialized, 5);
    expect(restored.map((entry) => entry.id)).toEqual(["d7", "d6", "d5", "d4", "d3"]);
  });

  it("모양이 틀린 항목과 손상된 저장소는 말없이 버린다", () => {
    const good = JSON.parse(serializeHistory([done("a")])) as { v: number; items: Record<string, unknown>[] };
    const entry = good.items[0] as Record<string, unknown>;
    const damaged = {
      v: 1,
      items: [
        entry,
        { ...entry, id: "no-file", fileName: "" },
        { ...entry, id: "bad-size", sizeBytes: -1 },
        { ...entry, id: "bad-time", finishedAtMs: "x" },
        { ...entry, id: "long", name: "n".repeat(600) },
        { ...entry, id: "a" },
        "garbage",
        null,
      ],
    };
    expect(parseHistory(JSON.stringify(damaged)).map((e) => e.id)).toEqual(["a"]);
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory("{not json")).toEqual([]);
    expect(parseHistory(JSON.stringify({ v: 2, items: [entry] }))).toEqual([]);
    expect(parseHistory(JSON.stringify([entry]))).toEqual([]);
  });
});
