import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { splitFileName } from "@momo/core/features/attachments/model";
import { DownloadPanel } from "./DownloadPanel";
import { newDownload, type DownloadItem } from "./downloadsModel";

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
