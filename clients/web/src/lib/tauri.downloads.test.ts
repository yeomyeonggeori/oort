import { afterEach, describe, expect, it, vi } from "vitest";

// #4587: 다운로드 폴더 다리(`desktopDownloads`). 셸은 파일을 **이름으로만** 부르고(경로는 웹뷰가 들지도
// 보내지도 않는다), 바이트는 raw 본문으로 간다. 셸의 오류 문자열(`downloads.rs`)은 화면이 문장을 고를 수
// 있는 일곱 코드로 접힌다. 브라우저 탭은 이 다리를 아예 건너지 않는다.

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./env");
  vi.doUnmock("@tauri-apps/api/core");
});

async function load(tauri: boolean, invoke = vi.fn()) {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  vi.doMock("./env", async (original) => ({
    ...(await original<typeof import("./env")>()),
    IS_TAURI: tauri,
  }));
  const bridge = await import("./tauri");
  return { ...bridge, invoke };
}

async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => null,
    (error: unknown) => error
  );
}

describe("desktopDownloads (셸)", () => {
  it("save: 바이트는 raw 본문이고 이름은 퍼센트 인코딩 헤더로 가며, 셸이 돌려준 이름을 받는다", async () => {
    const invoke = vi.fn(async () => ({ fileName: "2분기 예산안 (1).pdf" }));
    const { desktopDownloads } = await load(true, invoke);
    const bytes = Uint8Array.from([1, 2, 3]);

    const saved = await desktopDownloads.save(bytes, "2분기 예산안.pdf");

    expect(saved).toEqual({ fileName: "2분기 예산안 (1).pdf" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("download_save", bytes, {
      headers: { "x-oort-file-name": encodeURIComponent("2분기 예산안.pdf") },
    });
  });

  it("reveal·open·openFolder는 이름만 보낸다(경로 필드가 없다)", async () => {
    const invoke = vi.fn(async () => undefined);
    const { desktopDownloads } = await load(true, invoke);

    await desktopDownloads.reveal("a.pdf");
    await desktopDownloads.open("a.pdf");
    await desktopDownloads.openFolder();

    expect(invoke.mock.calls).toEqual([
      ["download_reveal", { request: { fileName: "a.pdf" } }],
      ["download_open", { request: { fileName: "a.pdf" } }],
      ["download_folder_open", undefined],
    ]);
  });

  it("셸의 오류 문자열이 코드로 접힌다", async () => {
    const table: Array<[string, string]> = [
      ["refused: larger than the download ceiling", "too-large"],
      ["refused: this kind of file is not opened from here", "not-openable"],
      ["refused: not a plain file name", "refused"],
      ["refused: outside the downloads folder", "refused"],
      ["denied", "denied"],
      ["disk_full", "disk-full"],
      ["missing", "missing"],
      ["failed", "failed"],
      ["something the shell never says", "failed"],
    ];
    for (const [native, code] of table) {
      const { desktopDownloads, DesktopDownloadError } = await load(
        true,
        vi.fn(async () => {
          throw native;
        })
      );
      const failure = await failureOf(() => desktopDownloads.reveal("a.pdf"));
      expect(failure, native).toBeInstanceOf(DesktopDownloadError);
      expect((failure as { code: string }).code, native).toBe(code);
    }
  });

  it("probe: 이름마다 한 칸, 같은 순서로 돌려받는다. 빈 목록은 셸에 묻지 않는다", async () => {
    const invoke = vi.fn(async () => [true, false, true]);
    const { desktopDownloads } = await load(true, invoke);
    expect(await desktopDownloads.probe(["a.pdf", "b.pdf", "c.pdf"])).toEqual([true, false, true]);
    expect(invoke).toHaveBeenCalledWith("download_probe", {
      request: { fileNames: ["a.pdf", "b.pdf", "c.pdf"] },
    });
    invoke.mockClear();
    expect(await desktopDownloads.probe([])).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("probe: 짧거나 모양이 틀린 답은 답이 아니다(빠진 칸을 「없다」로 읽지 않는다)", async () => {
    for (const answer of [[true], [], null, "yes", { 0: true }]) {
      const { desktopDownloads, DesktopDownloadError } = await load(true, vi.fn(async () => answer));
      const failure = await failureOf(() => desktopDownloads.probe(["a.pdf", "b.pdf"]));
      expect(failure, JSON.stringify(answer)).toBeInstanceOf(DesktopDownloadError);
    }
    const { desktopDownloads } = await load(
      true,
      vi.fn(async () => {
        throw "failed";
      })
    );
    expect(await failureOf(() => desktopDownloads.probe(["a.pdf"]))).toMatchObject({ code: "failed" });
  });
});

describe("desktopDownloads (브라우저 탭)", () => {
  it("전부 failed로 거절하고 셸 다리를 건너지 않는다", async () => {
    const invoke = vi.fn();
    const { desktopDownloads } = await load(false, invoke);
    for (const call of [
      () => desktopDownloads.save(new Uint8Array(1), "a.pdf"),
      () => desktopDownloads.probe(["a.pdf"]),
      () => desktopDownloads.reveal("a.pdf"),
      () => desktopDownloads.open("a.pdf"),
      () => desktopDownloads.openFolder(),
    ]) {
      expect(await failureOf(call)).toMatchObject({ name: "DesktopDownloadError", code: "failed" });
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});
