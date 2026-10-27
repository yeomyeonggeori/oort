// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #4587: `downloadAttachment`의 두 갈래. 데스크탑 셸에서는 다운로드 매니저(진행·기록·셸 저장)로 가고,
// 브라우저 탭은 예전 `<a download>` 그대로다. 셸에서 `<a download>`는 파일에 닿지 못하므로(wry가 다운로드
// 핸들러 없이는 그 이동을 취소한다) 갈래를 잘못 타면 셸의 단추는 아무 일도 하지 않는다.

const env = vi.hoisted(() => ({ tauri: false }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return env.tauri;
    },
  };
});

const fetchAttachmentContent = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  fetchAttachmentContent: (...args: unknown[]) => fetchAttachmentContent(...args),
}));

const start = vi.hoisted(() => vi.fn());
vi.mock("@/features/downloads/downloadsStore", () => ({
  downloads: { start: (...args: unknown[]) => start(...args) },
}));

const { downloadAttachment } = await import("./content");

const ATTACHMENT = { id: "att-1", name: "2분기 예산안.pdf", mime: "application/pdf", sizeBytes: 1000 };

let created: Blob[];
let clicked: Array<{ href: string; download: string; rel: string }>;

beforeEach(() => {
  env.tauri = false;
  created = [];
  clicked = [];
  fetchAttachmentContent.mockReset();
  start.mockReset();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      created.push(blob);
      return `blob:http://localhost/${created.length}`;
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download, rel: this.rel });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("downloadAttachment", () => {
  it("셸: 다운로드 매니저로 가고 `<a download>`는 쓰지 않는다", async () => {
    env.tauri = true;
    start.mockResolvedValue(undefined);

    await downloadAttachment("ws", "ch", ATTACHMENT);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ workspaceId: "ws", channelId: "ch", attachment: ATTACHMENT });
    expect(fetchAttachmentContent).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
    expect(created).toEqual([]);
  });

  it("셸: 매니저가 못 끝내면 호출자도 거절된다(카드가 자기 자리에서 실패를 말한다)", async () => {
    env.tauri = true;
    start.mockRejectedValue(new Error("download failed: network"));
    await expect(downloadAttachment("ws", "ch", ATTACHMENT)).rejects.toThrow("download failed: network");
  });

  it("브라우저 탭: 예전 길 그대로(받아서 이름 붙인 앵커를 누르고 치운다)", async () => {
    fetchAttachmentContent.mockResolvedValue(new Blob([Uint8Array.from([1, 2, 3])], { type: "application/pdf" }));

    await downloadAttachment("ws", "ch", ATTACHMENT);

    expect(start).not.toHaveBeenCalled();
    expect(fetchAttachmentContent).toHaveBeenCalledWith("ws", "ch", "att-1");
    expect(clicked).toEqual([{ href: "blob:http://localhost/1", download: "2분기 예산안.pdf", rel: "noopener" }]);
    expect(document.body.querySelector("a")).toBeNull();
    // 주소는 한 틱 뒤에 놓는다(즉시 놓으면 Safari가 저장을 시작하기 전에 죽는다).
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/1"));
  });
});
