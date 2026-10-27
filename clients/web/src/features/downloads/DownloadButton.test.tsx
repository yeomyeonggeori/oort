// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopDownloadError } from "@/lib/tauri";
import { DownloadButton } from "./DownloadButton";
import { createDownloadsStore, type DownloadsStore } from "./downloadsStore";
import { ATTACHMENT, bytes, fake, type Fake } from "./downloadsTestKit";

// =============================================================================
// 상단 오른쪽 다운로드 단추와 패널 (#4587). 시험 대상: 단추 상태(없음·진행·완료 점), 웹에서 숨김,
// 패널의 목록·행동·지워진 파일, 낭독. 스토어는 실제고 의존만 가짜다: 모델·스토어·컴포넌트가
// 한 줄로 이어진 채로 잰다. fixture는 가상 팀(달무리 스튜디오)이다.
// =============================================================================

const env = vi.hoisted(() => ({ tauri: true }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return env.tauri;
    },
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // Radix Popover가 jsdom에서 서려면 필요한 최소한(다른 팝오버 시험과 같다).
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});

let host: HTMLDivElement;
let root: Root;
let f: Fake;
let store: DownloadsStore;

function mount(): void {
  act(() => root.render(createElement(DownloadButton, { store })));
}

const q = <T extends Element = HTMLElement>(testId: string, scope: ParentNode = document.body) =>
  scope.querySelector<T>(`[data-testid="${testId}"]`);
const qa = (testId: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const button = () => q<HTMLButtonElement>("download-button") as HTMLButtonElement;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function start(attachment = ATTACHMENT): Promise<void> {
  let run: Promise<void> = Promise.resolve();
  act(() => {
    run = store.start({ workspaceId: "ws-dalmuri", channelId: "ch-design", attachment });
  });
  return run;
}

async function finish(index: number, size = 1000): Promise<void> {
  await act(async () => {
    f.fetches[index]?.resolve(bytes(size));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openPanel(): void {
  act(() => button().click());
}

beforeEach(() => {
  env.tauri = true;
  f = fake();
  store = createDownloadsStore(f.deps);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("웹(브라우저)에서는 숨는다", () => {
  it("셸이 아니면 단추도 패널도 그리지 않고 스토어를 건드리지 않는다", () => {
    env.tauri = false;
    const spy = vi.spyOn(store, "subscribe");
    mount();
    expect(host.innerHTML).toBe("");
    expect(q("download-button")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("셸이면 단추가 선다", () => {
    mount();
    expect(button()).not.toBeNull();
  });
});

describe("단추 상태: 없음 · 진행 · 완료 점", () => {
  it("아무것도 없으면 아이콘뿐이다(링도 점도 없다)", () => {
    mount();
    expect(button().getAttribute("aria-label")).toBe("다운로드");
    expect(button().getAttribute("data-activity")).toBe("idle");
    expect(button().getAttribute("data-badge")).toBe("none");
    expect(q("download-ring")).toBeNull();
    expect(q("download-dot")).toBeNull();
  });

  it("받는 중이면 링이 서고, 한 바이트도 못 받았으면 도는 링(unknown)이다", async () => {
    mount();
    void start();
    await settle();
    expect(button().getAttribute("data-activity")).toBe("progress");
    expect(button().getAttribute("aria-label")).toBe("다운로드, 받는 중 1개");
    const ring = q("download-ring") as HTMLElement;
    expect(ring.getAttribute("data-ring-step")).toBe("unknown");
    expect(ring.className).toContain("spinner-busy");
  });

  it("잰 바이트가 오면 그 비율의 칸이 되고 돌지 않는다", async () => {
    mount();
    void start();
    await settle();
    act(() => f.fetches[0]?.progress(500, 1000));
    const ring = q("download-ring") as HTMLElement;
    expect(ring.getAttribute("data-ring-step")).toBe("6");
    expect(ring.className).not.toContain("spinner-busy");
    act(() => f.fetches[0]?.progress(1000, 1000));
    expect((q("download-ring") as HTMLElement).getAttribute("data-ring-step")).toBe("12");
  });

  it("끝나면 링이 사라지고 점이 켜진다. 점의 뜻은 이름에도 있다", async () => {
    mount();
    void start();
    await settle();
    await finish(0);
    expect(q("download-ring")).toBeNull();
    const dot = q("download-dot") as HTMLElement;
    expect(dot.getAttribute("data-tone")).toBe("done");
    expect(button().getAttribute("data-badge")).toBe("done");
    expect(button().getAttribute("aria-label")).toBe("다운로드, 새로 받은 파일 1개");
  });

  it("실패는 위험색 점이고 이름이 말한다", async () => {
    mount();
    void start().catch(() => undefined);
    await settle();
    await act(async () => {
      f.fetches[0]?.reject(new TypeError("Failed to fetch"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((q("download-dot") as HTMLElement).getAttribute("data-tone")).toBe("failed");
    expect(button().getAttribute("aria-label")).toBe("다운로드, 받지 못한 파일이 있어요");
  });

  it("링과 점은 함께 설 수 있다", async () => {
    mount();
    void start();
    await settle();
    await finish(0);
    void start({ ...ATTACHMENT, id: "att-2", name: "시안.png" });
    await settle();
    expect(q("download-ring")).not.toBeNull();
    expect(q("download-dot")).not.toBeNull();
  });

  it("링이 도는 동안에도 이름이 점의 뜻을 말한다(새로 받은 것 · 받지 못한 것)", async () => {
    mount();
    void start();
    await settle();
    await finish(0);
    void start({ ...ATTACHMENT, id: "att-2", name: "시안.png" }).catch(() => undefined);
    await settle();
    expect(button().getAttribute("aria-label")).toBe("다운로드, 받는 중 1개, 새로 받은 파일 1개");
    // 새로 받은 것이 하나, 이어서 받는 것이 하나, 그 사이 이어 받던 것이 실패: 점은 실패가 먼저 말한다.
    await act(async () => {
      f.fetches[1]?.reject(new TypeError("Failed to fetch"));
      await Promise.resolve();
      await Promise.resolve();
    });
    void start({ ...ATTACHMENT, id: "att-3", name: "회의록.txt" });
    await settle();
    expect(button().getAttribute("data-activity")).toBe("progress");
    expect(button().getAttribute("data-badge")).toBe("failed");
    expect(button().getAttribute("aria-label")).toBe("다운로드, 받는 중 1개, 받지 못한 파일이 있어요");
  });

  it("패널 대화상자에 이름이 있다(안쪽 section만이 아니라)", async () => {
    mount();
    openPanel();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-label")).toBe("다운로드");
  });

  it("목록을 열면 점이 꺼진다", async () => {
    mount();
    void start();
    await settle();
    await finish(0);
    expect(q("download-dot")).not.toBeNull();
    openPanel();
    await settle();
    expect(q("download-panel")).not.toBeNull();
    expect(q("download-dot")).toBeNull();
    expect(button().getAttribute("data-badge")).toBe("none");
  });

  it("열려 있는 동안 끝난 건은 점을 켜지 않는다", async () => {
    mount();
    openPanel();
    await settle();
    void start();
    await settle();
    await finish(0);
    expect(q("download-dot")).toBeNull();
    expect(qa("download-row")).toHaveLength(1);
  });

  it("단추는 끌기 속성이 없다(속성 없는 단추만 Tauri 끌기에서 빠져 눌린다)", async () => {
    mount();
    void start();
    await settle();
    await finish(0);
    void start({ ...ATTACHMENT, id: "att-2" });
    await settle();
    for (const element of [button(), q("download-ring"), q("download-dot"), button().querySelector("svg")]) {
      expect(element?.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
    expect(button().tagName).toBe("BUTTON");
    expect(button().getAttribute("type")).toBe("button");
  });

  it("끝난 건을 낭독한다(점은 색이라 보조기술은 이 줄로 안다)", async () => {
    f.saveAnswer = { fileName: "예산안 (1).pdf" };
    mount();
    expect(q("download-announcement")?.textContent).toBe("");
    void start();
    await settle();
    await finish(0);
    expect(q("download-announcement")?.textContent).toBe("예산안 (1).pdf 받기를 마쳤어요");
  });
});

describe("패널", () => {
  it("비어 있으면 한 줄 안내가 서고 폴더 열기는 그대로 있다", async () => {
    mount();
    openPanel();
    await settle();
    expect(q("download-empty")?.textContent).toContain("받은 파일이 아직 없어요");
    expect(q("download-list")).toBeNull();
    expect(q("download-open-folder")?.textContent).toContain("다운로드 폴더 열기");
    expect(q("download-panel")?.textContent).toContain("다운로드 폴더에 저장돼요");
  });

  it("받는 중인 행은 잰 바이트와 막대를 보이고 행동이 없다", async () => {
    mount();
    void start();
    await settle();
    act(() => f.fetches[0]?.progress(500, 1000));
    openPanel();
    await settle();
    const row = qa("download-row")[0] as HTMLElement;
    expect(row.getAttribute("data-phase")).toBe("receiving");
    expect(q("download-row-status", row)?.textContent).toBe("500 B / 1000 B");
    const bar = q<HTMLProgressElement>("download-row-progress", row) as HTMLProgressElement;
    expect(bar.value).toBe(0.5);
    expect(row.querySelectorAll("button")).toHaveLength(0);
  });

  it("길이를 모르는 막대는 값이 없다(indeterminate)", async () => {
    mount();
    void start({ ...ATTACHMENT, sizeBytes: 0 });
    await settle();
    openPanel();
    await settle();
    const bar = q<HTMLProgressElement>("download-row-progress") as HTMLProgressElement;
    expect(bar.hasAttribute("value")).toBe(false);
  });

  it("끝난 행은 셸이 돌려준 이름과 크기, 그리고 세 행동을 보인다", async () => {
    f.saveAnswer = { fileName: "2분기 예산안 (1).pdf" };
    mount();
    void start();
    await settle();
    await finish(0);
    openPanel();
    await settle();
    const row = qa("download-row")[0] as HTMLElement;
    expect(row.getAttribute("data-phase")).toBe("done");
    expect(row.textContent).toContain("2분기 예산안 (1).pdf");
    expect(q("download-row-status", row)?.textContent).toBe("1000 B");
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("title"))).toEqual([
      "열기",
      "Finder에서 보기",
      "다시 다운로드",
    ]);
    // 이름은 파일 이름과 행동이다(같은 이름의 단추가 줄마다 서므로).
    expect(q("download-action-reveal", row)?.getAttribute("aria-label")).toBe(
      "2분기 예산안 (1).pdf Finder에서 보기"
    );
  });

  it("열기와 Finder에서 보기는 셸이 돌려준 파일 이름으로 간다", async () => {
    f.saveAnswer = { fileName: "2분기 예산안 (1).pdf" };
    mount();
    void start();
    await settle();
    await finish(0);
    openPanel();
    await settle();
    await act(async () => {
      (q("download-action-open") as HTMLElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      (q("download-action-reveal") as HTMLElement).click();
      await Promise.resolve();
    });
    expect(f.opens).toEqual(["2분기 예산안 (1).pdf"]);
    expect(f.reveals).toEqual(["2분기 예산안 (1).pdf"]);
  });

  it("열 때마다 셸에 파일이 아직 있는지 묻고, 지워진 파일은 다시 다운로드만 남긴다", async () => {
    mount();
    void start();
    await settle();
    await finish(0);
    f.probeAnswer = [false];
    openPanel();
    await settle();
    const row = qa("download-row")[0] as HTMLElement;
    expect(row.getAttribute("data-present")).toBe("false");
    expect(q("download-row-status", row)?.textContent).toBe("파일이 지워졌어요");
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("title"))).toEqual(["다시 다운로드"]);
  });

  it("다시 다운로드는 같은 요청으로 새 건을 시작한다", async () => {
    mount();
    void start();
    await settle();
    await finish(0);
    f.probeAnswer = [false];
    openPanel();
    await settle();
    await act(async () => {
      (q("download-action-redownload") as HTMLElement).click();
      await Promise.resolve();
    });
    expect(f.fetches).toHaveLength(2);
    expect(f.fetches[1]?.source).toEqual({ workspaceId: "ws-dalmuri", channelId: "ch-design", attachmentId: "att-budget" });
    expect(qa("download-row")).toHaveLength(1);
    expect(qa("download-row")[0]?.getAttribute("data-phase")).toBe("receiving");
  });

  it("실패한 행은 이유와 다음 행동(다시 시도)을 말한다", async () => {
    mount();
    void start().catch(() => undefined);
    await settle();
    await act(async () => {
      f.fetches[0]?.reject(new TypeError("Failed to fetch"));
      await Promise.resolve();
      await Promise.resolve();
    });
    openPanel();
    await settle();
    const row = qa("download-row")[0] as HTMLElement;
    expect(row.getAttribute("data-phase")).toBe("failed");
    expect(q("download-row-status", row)?.textContent).toBe("연결이 끊겨 받지 못했어요. 연결을 확인하고 다시 시도하세요");
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("title"))).toEqual(["다시 시도"]);
    await act(async () => {
      (q("download-action-retry") as HTMLElement).click();
      await Promise.resolve();
    });
    expect(f.fetches).toHaveLength(2);
  });

  it("고칠 수 없는 실패(404)는 행동 없이 이유만 말한다", async () => {
    mount();
    void start().catch(() => undefined);
    await settle();
    const { ApiError } = await import("@momo/core/lib/api");
    await act(async () => {
      f.fetches[0]?.reject(new ApiError(404, "HTTP 404"));
      await Promise.resolve();
      await Promise.resolve();
    });
    openPanel();
    await settle();
    const row = qa("download-row")[0] as HTMLElement;
    expect(q("download-row-status", row)?.textContent).toBe(
      "첨부파일이 없거나 볼 권한이 없어요. 보낸 사람에게 다시 요청해 보세요"
    );
    expect(row.querySelectorAll("button")).toHaveLength(0);
  });

  it("열 수 없는 종류는 열기 단추가 없다. 셸이 거절하면 그 행 아래에서 말한다", async () => {
    f.saveAnswer = { fileName: "setup.command" };
    mount();
    void start({ ...ATTACHMENT, name: "setup.command", mime: "text/x-shellscript" });
    await settle();
    await finish(0);
    openPanel();
    await settle();
    expect(q("download-action-open")).toBeNull();
    expect(q("download-action-reveal")).not.toBeNull();

    // 모델의 목록과 셸의 목록이 어긋난 날: 단추는 서 있지만 셸이 거절한다.
    f.saveAnswer = { fileName: "notes.pdf" };
    void start({ ...ATTACHMENT, id: "att-2", name: "notes.pdf" });
    await settle();
    await finish(1);
    f.rowError = new DesktopDownloadError("not-openable");
    await act(async () => {
      (q("download-action-open") as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(q("download-row-notice")?.textContent).toContain("이 종류의 파일은 여기서 열지 않아요");
  });

  it("폴더 열기는 스토어에 닿고, 못 열면 한 줄로 말한다", async () => {
    mount();
    openPanel();
    await settle();
    f.folderError = new DesktopDownloadError("failed");
    await act(async () => {
      (q("download-open-folder") as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(q("download-folder-notice")?.textContent).toBe("다운로드 폴더를 열지 못했어요");
  });

  it("가장 최근 건이 위에 선다", async () => {
    f.saveAnswer = { fileName: "첫째.pdf" };
    mount();
    void start();
    await settle();
    await finish(0);
    f.saveAnswer = { fileName: "둘째.png" };
    void start({ ...ATTACHMENT, id: "att-2", name: "둘째.png", mime: "image/png" });
    await settle();
    await finish(1);
    openPanel();
    await settle();
    expect(qa("download-row").map((row) => row.querySelector("[title]")?.getAttribute("title"))).toEqual([
      "둘째.png",
      "첫째.pdf",
    ]);
  });
});
