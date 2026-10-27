import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { splitFileName } from "@momo/core/features/attachments/model";
import { DownloadPanel } from "./DownloadPanel";
import { newDownload, type DownloadFailure, type DownloadItem } from "./downloadsModel";
import { DOWNLOAD_COPY, downloadFailureCopy } from "./downloadsCopy";

// =============================================================================
// 패널 행의 파일 이름은 앞부분이 공백으로 끝나도 공백을 잃지 않는다 (#4587, 실기 캡처에서 발견).
//
// `splitFileName`은 확장자 앞 두 글자를 꼬리로 떼므로 「끊기는 파일.zip」은 「끊기는 」+「파일.zip」이 된다. 앞부분 칸이
// `truncate`(`white-space: nowrap`)이면 브라우저가 줄 끝의 공백을 접어 화면에는 「끊기는파일.zip」이 선다. DOM 텍스트에는 공백이
// 있어서 jsdom 시험(`textContent`)은 이 결함을 못 본다: 폭을 재야 한다. 이 시험은 **진짜 `DownloadPanel`을 서버 렌더한 마크업**에
// `tokens.css`를 Tailwind로 컴파일한 CSS를 얹어 WebKit(WKWebView의 엔진)과 Chromium에 먹이고, 앞부분 폭 + 꼬리 폭이 같은 글자를 한
// 덩어리로 그린 폭과 같은지 잰다(공백이 접히면 공백 한 칸만큼 모자란다).
// =============================================================================

const NAMES = [
  "끊기는 파일.zip",
  "분기 결산 자료.xlsx",
  "회의록 정리.txt",
  "달무리 스튜디오 2분기 예산안 최종.pdf",
  "시안 캡처 (1).png",
];

function doneItem(name: string, index: number): DownloadItem {
  return {
    ...newDownload({
      id: `dl-${index}`,
      source: { workspaceId: "ws-dalmuri", channelId: "ch-design", attachmentId: `att-${index}` },
      name,
      mime: "application/octet-stream",
      sizeBytes: 1000,
      nowMs: 10_000,
    }),
    phase: "done",
    fileName: name,
    finishedAtMs: 11_000,
    seen: true,
    present: true,
  };
}

function page(css: string, markup: string): string {
  const refs = NAMES.map(
    (name, i) => `<span id="ref-${i}" class="text-label" style="display:inline-block;white-space:pre">${name}</span>`
  ).join("<br>");
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
</style></head><body style="width:480px"><div id="host">${markup}</div><div>${refs}</div></body></html>`;
}

describe("패널 행 이름의 공백 (#4587)", () => {
  it("전제: 이 이름들은 앞부분이 공백으로 끝나는 분할을 실제로 만든다", () => {
    const endsWithSpace = NAMES.filter((name) => splitFileName(name).head.endsWith(" "));
    // 두 개 이상이 이 상황이어야 이 시험이 결함을 겨냥한다(`splitFileName`이 바뀌어 전제가 사라지면 붉다).
    expect(endsWithSpace.length).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(ENGINES.length === 0)(
    "앞부분 폭 + 꼬리 폭 = 한 덩어리로 그린 폭이다(끝 공백이 접히지 않는다)",
    async () => {
      const markup = renderToStaticMarkup(
        createElement(DownloadPanel, {
          items: NAMES.map(doneItem),
          notices: {},
          folderNotice: null,
          onAction: () => undefined,
          onOpenFolder: () => undefined,
        })
      );
      const candidates = [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);
      const css = await compileTokensCss([...candidates, "text-label"]);
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 480, height: 640 } });
          try {
            const view = await ctx.newPage();
            await view.setContent(page(css, markup));
            const measured = await view.evaluate(() => {
              const rows = [...document.querySelectorAll('[data-testid="download-row"]')];
              return rows.map((row, i) => {
                const title = row.querySelector("span[title]") as HTMLElement;
                const [head, tail] = [...title.children] as HTMLElement[];
                const full = document.getElementById(`ref-${i}`) as HTMLElement;
                return {
                  name: title.getAttribute("title"),
                  head: head?.getBoundingClientRect().width ?? 0,
                  tail: tail?.getBoundingClientRect().width ?? 0,
                  full: full.getBoundingClientRect().width,
                  headText: head?.textContent ?? "",
                  whiteSpace: head ? getComputedStyle(head).whiteSpace : "",
                };
              });
            });
            expect(measured).toHaveLength(NAMES.length);
            for (const row of measured) {
              const gap = Math.abs(row.head + row.tail - row.full);
              if (gap > 0.6) {
                problems.push(
                  `${engine} 「${row.name}」: 앞부분 ${row.head.toFixed(2)} + 꼬리 ${row.tail.toFixed(2)} = ${(row.head + row.tail).toFixed(2)} ≠ 한 덩어리 ${row.full.toFixed(2)} (white-space: ${row.whiteSpace})`
                );
              }
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    60_000
  );
});

// -----------------------------------------------------------------------------
// 패널의 문장은 어절에서 끊긴다 (#4587, design-review H2).
//
// 실기 캡처에서 가장 흔한 실패 문장이 「…다시 시도하」 / 「세요」로 갈렸다: 이 패널의 글에 `break-keep`이 없어서 브라우저가
// 한글 음절 사이 어디서든 줄을 바꿨다. 이 레포는 한국어를 어절에서 끊는다(`word-break: keep-all`). 렌더 폭에 달린 결함이라
// 문자열 시험은 못 본다: 진짜 `DownloadPanel`을 **팝오버 폭(`w-pane-picker` + `p-3`)** 에 그려 엔진이 만든 줄 경계를 글자별
// `Range` 사각형으로 읽고, 새 줄의 첫 글자 바로 앞이 공백이 아니면(= 낱말 한가운데서 끊김) 위반으로 센다.
// -----------------------------------------------------------------------------

const FAILURES: DownloadFailure[] = ["network", "auth", "gone", "too-large", "denied", "disk-full", "failed"];

function failedItem(failure: DownloadFailure, index: number): DownloadItem {
  return {
    ...newDownload({
      id: `fl-${index}`,
      source: { workspaceId: "ws-dalmuri", channelId: "ch-design", attachmentId: `att-fl-${index}` },
      name: `실패 ${index}.pdf`,
      mime: "application/pdf",
      sizeBytes: 1000,
      nowMs: 10_000,
    }),
    phase: "failed",
    failure,
    finishedAtMs: 11_000,
    seen: true,
  };
}

function panelMarkup(items: DownloadItem[], withNotices: boolean): string {
  return renderToStaticMarkup(
    createElement(DownloadPanel, {
      items,
      notices: withNotices
        ? { "fl-keep": DOWNLOAD_COPY.notOpenable }
        : {},
      folderNotice: withNotices ? DOWNLOAD_COPY.folderFailed : null,
      onAction: () => undefined,
      onOpenFolder: () => undefined,
    })
  );
}

describe("패널 문장의 줄바꿈 (#4587)", () => {
  it.skipIf(ENGINES.length === 0)(
    "실패 이유 일곱 · 행 아래 안내 · 폴더 안내 · 빈 상태 · 저장 위치 문장은 모두 어절 경계에서만 줄을 바꾼다",
    async () => {
      const done: DownloadItem = {
        ...doneItem("회의록 정리.txt", 99),
        id: "fl-keep",
      };
      const filled = panelMarkup([...FAILURES.map(failedItem), done], true);
      const empty = panelMarkup([], false);
      const candidates = [...(filled + empty).matchAll(/class="([^"]*)"/g)]
        .flatMap((m) => (m[1] ?? "").split(/\s+/))
        .filter(Boolean);
      const css = await compileTokensCss([...candidates, "w-pane-picker", "p-3", "text-label"]);
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 800, height: 900 } });
          try {
            const view = await ctx.newPage();
            for (const [label, markup] of [["목록", filled], ["빈 상태", empty]] as const) {
              await view.setContent(
                `<!doctype html><html lang="ko"><head><style>${css}\nhtml,body{margin:0}</style></head><body><div id="host" class="w-pane-picker p-3">${markup}</div></body></html>`
              );
              const result = await view.evaluate(() => {
                const selectors = [
                  '[data-testid="download-row-status"]',
                  '[data-testid="download-row-notice"]',
                  '[data-testid="download-folder-notice"]',
                  '[data-testid="download-empty"] p',
                  '[data-testid="download-panel"] > p:last-child',
                ];
                const out: Array<{ sel: string; text: string; lines: number; broken: string[] }> = [];
                for (const sel of selectors) {
                  for (const el of document.querySelectorAll(sel)) {
                    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                    let prevTop: number | null = null;
                    let prevIndex = -1;
                    let prevNode: Node | null = null;
                    let lines = 1;
                    const broken: string[] = [];
                    while (walker.nextNode()) {
                      const node = walker.currentNode as Text;
                      const text = node.textContent ?? "";
                      for (let i = 0; i < text.length; i += 1) {
                        const range = document.createRange();
                        range.setStart(node, i);
                        range.setEnd(node, i + 1);
                        const rects = range.getClientRects();
                        if (rects.length === 0 || (rects[0]!.width === 0 && /\s/.test(text[i]!))) continue;
                        const top = Math.round(rects[0]!.top);
                        if (prevTop !== null && top > prevTop + 2) {
                          lines += 1;
                          // 새 줄의 첫 글자: 바로 앞(같은 글 노드)에 공백이 없으면 낱말 한가운데서 끊긴 것이다.
                          const between = prevNode === node ? text.slice(prevIndex + 1, i) : " ";
                          if (!/\s/.test(between)) broken.push(`${text.slice(Math.max(0, i - 4), i)}|${text.slice(i, i + 4)}`);
                        }
                        prevTop = top;
                        prevIndex = i;
                        prevNode = node;
                      }
                    }
                    out.push({ sel, text: (el.textContent ?? "").slice(0, 40), lines, broken });
                  }
                }
                return out;
              });
              const wrapped = result.filter((r) => r.lines >= 2).length;
              if (label === "목록" && wrapped < 3) {
                problems.push(`${engine} ${label}: 두 줄 이상으로 접힌 문장이 ${wrapped}개뿐이다(장면이 줄바꿈을 만들지 못했다)`);
              }
              for (const r of result) {
                if (r.broken.length > 0) {
                  problems.push(`${engine} ${label} ${r.sel} 「${r.text}…」 ${r.lines}줄, 낱말 한가운데서 끊김: ${r.broken.join(" / ")}`);
                }
              }
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    90_000
  );

  it("이유 문장은 실제로 쓰는 일곱 이유 전부다(시험이 한 이유를 빠뜨리지 않는다)", () => {
    const all = FAILURES.map((f) => downloadFailureCopy(f));
    expect(new Set(all).size).toBe(7);
    // 가장 흔한 실패(연결 끊김)는 패널 폭에서 두 줄로 접히는 길이다: 이 시험의 전제.
    expect(downloadFailureCopy("network").length).toBeGreaterThan(30);
  });
});
