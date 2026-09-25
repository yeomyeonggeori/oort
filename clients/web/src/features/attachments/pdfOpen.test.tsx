// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PDF 열기 (#2701).
//
// 바이트로 가는 길은 여전히 베어러 인가 프록시 하나다(content.ts). 이 파일이 재는
// 것은 그 바이트를 **어떤 문서로** 여는가다:
//   - 서버가 `nosniff` + `Content-Disposition: attachment` 로 막아 둔 실행 경로를
//     화면이 되살리지 않는다. 그래서 새 창에 거는 Blob 의 타입은 서버가 붙인
//     타입이 아니라 이 쪽이 못 박은 `application/pdf` 이고, 머리가 `%PDF-` 가
//     아니면 아예 열지 않는다(HTML 을 PDF 라고 선언한 업로드가 이 출처의 문서로
//     열리는 길을 닫는다).
//   - 팝업 차단은 await 뒤의 window.open 에서 일어난다. 그래서 창은 클릭 순간
//     먼저 열고, 바이트가 오면 그 창의 주소를 바꾼다.
//   - 데스크탑 셸(wry)은 새 창 요청을 버리므로 거기서는 버튼을 세우지 않는다.

const fetchAttachmentContent = vi.fn();

vi.mock("@momo/core/lib/api", () => ({
  fetchAttachmentContent: (...args: unknown[]) => fetchAttachmentContent(...args),
}));

vi.mock("@/app/session", () => ({
  useSession: () => ({ workspaceId: "ws", connStatus: "connected" }),
}));

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

const { openPdfAttachment } = await import("./content");
const { AttachmentList } = await import("../timeline/AttachmentList");

const PDF = {
  id: "0199eeee-0000-7000-8000-0000000000p1",
  name: "Q3-온보딩-리뷰.pdf",
  mime: "application/pdf",
  sizeBytes: 182_000,
};
const LOG = {
  id: "0199eeee-0000-7000-8000-0000000000f1",
  name: "drain-2026-08-09.log",
  mime: "text/plain",
  sizeBytes: 20_480,
};

function bytes(text: string, type: string): Blob {
  return new Blob([new TextEncoder().encode(text)], { type });
}

interface FakeWindow {
  opener: unknown;
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  location: { replace: ReturnType<typeof vi.fn> };
  document: Document;
}

function fakeWindow(): FakeWindow {
  const win: FakeWindow = {
    opener: window,
    closed: false,
    close: vi.fn(() => {
      win.closed = true;
    }),
    location: { replace: vi.fn() },
    document: document.implementation.createHTMLDocument(""),
  };
  return win;
}

let created: Blob[] = [];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  created = [];
  env.tauri = false;
  fetchAttachmentContent.mockReset();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      created.push(blob);
      return `blob:http://localhost/${created.length}`;
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("openPdfAttachment", () => {
  it("re-types the proxied bytes as application/pdf and navigates the pre-opened window", async () => {
    // 프록시가 돌려주는 타입은 믿지 않는다: 여기서는 일부러 octet-stream 이다.
    fetchAttachmentContent.mockResolvedValue(
      bytes("%PDF-1.7\n1 0 obj\n", "application/octet-stream")
    );
    const target = fakeWindow();
    await openPdfAttachment("ws", "ch", PDF, target as unknown as Window);
    expect(fetchAttachmentContent).toHaveBeenCalledWith("ws", "ch", PDF.id);
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("application/pdf");
    expect(target.location.replace).toHaveBeenCalledWith("blob:http://localhost/1");
    // 새 창이 이 탭을 되짚지 못한다(reverse tabnabbing).
    expect(target.opener).toBeNull();
    expect(target.close).not.toHaveBeenCalled();
  });

  it("refuses bytes that are not a PDF and closes the window it opened", async () => {
    fetchAttachmentContent.mockResolvedValue(
      bytes("<html><script>alert(document.cookie)</script>", "application/pdf")
    );
    const target = fakeWindow();
    await expect(
      openPdfAttachment("ws", "ch", PDF, target as unknown as Window)
    ).rejects.toMatchObject({ reason: "not-pdf" });
    expect(created).toHaveLength(0);
    expect(target.location.replace).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalled();
  });

  it("closes the window when the proxy fails", async () => {
    fetchAttachmentContent.mockRejectedValue(new Error("HTTP 404"));
    const target = fakeWindow();
    await expect(
      openPdfAttachment("ws", "ch", PDF, target as unknown as Window)
    ).rejects.toMatchObject({ reason: "failed" });
    expect(target.close).toHaveBeenCalled();
  });
});

describe("timeline PDF card", () => {
  function render(attachments: (typeof PDF)[]) {
    act(() => {
      root.render(<AttachmentList channelId="ch" attachments={attachments} />);
    });
  }

  it("offers an open action on a PDF card only", () => {
    render([PDF, LOG]);
    const cards = host.querySelectorAll('[data-testid="attachment-card"]');
    expect(cards).toHaveLength(2);
    const [pdfCard, logCard] = [...cards];
    const open = pdfCard?.querySelector('[data-testid="attachment-open-pdf"]');
    expect(open).not.toBeNull();
    expect(open?.getAttribute("aria-label")).toBe(`${PDF.name} 새 창에서 PDF 열기`);
    // 행의 단일 로빙 그룹에 들어간다(내려받기와 같은 계약).
    expect(open?.hasAttribute("data-row-action")).toBe(true);
    // 내려받기는 그대로 남는다.
    expect(pdfCard?.querySelector('[data-testid="attachment-download"]')).not.toBeNull();
    expect(logCard?.querySelector('[data-testid="attachment-open-pdf"]')).toBeNull();
  });

  it("opens the window synchronously on click, before any byte arrives", async () => {
    let release!: (blob: Blob) => void;
    fetchAttachmentContent.mockReturnValue(
      new Promise<Blob>((done) => {
        release = done;
      })
    );
    const target = fakeWindow();
    const open = vi.spyOn(window, "open").mockReturnValue(target as unknown as Window);
    render([PDF]);
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="attachment-open-pdf"]'
    );
    act(() => button?.click());
    // 사용자 활성화가 살아 있는 동안 창이 이미 열렸다.
    expect(open).toHaveBeenCalledTimes(1);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    act(() => release(bytes("%PDF-1.4\n", "application/pdf")));
    // FileReader 는 jsdom 에서 여러 틱에 걸쳐 끝난다. 한 틱을 가정하지 않는다.
    await waitFor(() => expect(target.location.replace).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button?.hasAttribute("aria-busy")).toBe(false));
  });

  it("says a blocked popup out loud instead of doing nothing", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    render([PDF]);
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="attachment-open-pdf"]'
    );
    await act(async () => {
      button?.click();
      await new Promise((done) => setTimeout(done, 0));
    });
    const failure = host.querySelector('[data-testid="attachment-open-failed"]');
    expect(failure?.textContent).toMatch(/팝업/);
    expect(fetchAttachmentContent).not.toHaveBeenCalled();
  });

  it("names a non-PDF body instead of opening it", async () => {
    fetchAttachmentContent.mockResolvedValue(bytes("<html>", "application/pdf"));
    const target = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(target as unknown as Window);
    render([PDF]);
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[data-testid="attachment-open-pdf"]')
        ?.click()
    );
    await waitFor(() =>
      expect(
        host.querySelector('[data-testid="attachment-open-failed"]')?.textContent
      ).toMatch(/PDF 형식/)
    );
    expect(target.close).toHaveBeenCalled();
  });

  it("does not render a dead open control inside the desktop shell", () => {
    env.tauri = true;
    render([PDF]);
    expect(host.querySelector('[data-testid="attachment-open-pdf"]')).toBeNull();
    expect(host.querySelector('[data-testid="attachment-download"]')).not.toBeNull();
  });
});
