import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { ApiError, fetchAttachmentContent } from "./api";

// =============================================================================
// 첨부 바이트를 받는 동안의 진행 (#4587, 데스크탑 다운로드 패널).
//
// 패널의 링과 행의 「42%」는 잰 값이어야 한다(`AttachmentDownloadButton`의 오래된 약속:
// 잰 값 없이 퍼센트를 만들지 않는다). 그 값의 출처가 `fetchAttachmentContent`의
// `onProgress`다. 여기서 못박는 것은 넷이다.
//   A. 스트림을 읽으며 `loaded`가 실제 도착한 바이트 수로 늘고, 끝난 Blob은 그 바이트 그대로다.
//   B. `total`은 서버가 말한 Content-Length이고, 말하지 않았거나 압축된 응답이면 null이다.
//   C. 콜백을 주지 않으면 예전 길(`res.blob()`) 그대로다: 폰·웹의 기존 호출은 바뀌지 않는다.
//   D. 실패(404)는 진행을 한 번도 알리지 않고 예전처럼 ApiError로 끝난다.
// =============================================================================

const WS = "019f9b10-0000-7000-8000-000000000001";
const CH = "019f9b10-0000-7000-8000-0000000000c1";

function stage(): void {
  const port: SessionPort = {
    getAccessToken: () => "access",
    getRefreshToken: () => "refresh",
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: port,
  });
}

/** 청크 단위로 도착하는 응답. 청크가 따로 나와야 스트림 읽기가 실제로 재어진다. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

function bytesOf(...parts: number[][]): Uint8Array[] {
  return parts.map((part) => Uint8Array.from(part));
}

async function bytesInside(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

beforeEach(stage);
afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

describe("fetchAttachmentContent onProgress (#4587)", () => {
  it("A. 도착한 만큼 loaded가 늘고, 끝난 Blob은 그 바이트와 타입 그대로다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamed(bytesOf([1, 2, 3], [4, 5], [6, 7, 8, 9]), {
          "content-length": "9",
          "content-type": "application/pdf",
        })
      )
    );
    const seen: Array<[number, number | null]> = [];

    const blob = await fetchAttachmentContent(WS, CH, "att-1", undefined, (loaded, total) =>
      seen.push([loaded, total])
    );

    expect(seen).toEqual([
      [0, 9],
      [3, 9],
      [5, 9],
      [9, 9],
    ]);
    expect(await bytesInside(blob)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(blob.type).toBe("application/pdf");
  });

  it("B. Content-Length를 말하지 않으면 total은 null이다(지어내지 않는다)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamed(bytesOf([1, 2], [3]))));
    const seen: Array<[number, number | null]> = [];

    await fetchAttachmentContent(WS, CH, "att-1", undefined, (loaded, total) =>
      seen.push([loaded, total])
    );

    expect(seen.map(([, total]) => total)).toEqual([null, null, null]);
    expect(seen.map(([loaded]) => loaded)).toEqual([0, 2, 3]);
  });

  it("B. 압축된 응답의 Content-Length는 풀린 바이트 수가 아니므로 total은 null이다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamed(bytesOf([1, 2, 3, 4]), { "content-length": "2", "content-encoding": "gzip" })
      )
    );
    const seen: Array<[number, number | null]> = [];

    await fetchAttachmentContent(WS, CH, "att-1", undefined, (loaded, total) =>
      seen.push([loaded, total])
    );

    // 압축 크기 2에 풀린 4바이트가 도착했다: 이 헤더를 total로 쓰면 200%가 된다.
    expect(seen.at(-1)).toEqual([4, null]);
  });

  it("C. 콜백이 없으면 예전 길(res.blob())이고 같은 바이트를 돌려준다", async () => {
    const response = streamed(bytesOf([7, 8, 9]), { "content-type": "image/png" });
    const blobSpy = vi.spyOn(response, "blob");
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const blob = await fetchAttachmentContent(WS, CH, "att-1");

    expect(blobSpy).toHaveBeenCalledTimes(1);
    expect(await bytesInside(blob)).toEqual([7, 8, 9]);
  });

  it("D. 404는 진행을 알리지 않고 ApiError로 끝난다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
    const onProgress = vi.fn();

    const failure = await fetchAttachmentContent(WS, CH, "att-1", undefined, onProgress).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(404);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
