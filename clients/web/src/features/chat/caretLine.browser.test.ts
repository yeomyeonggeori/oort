import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { COMPOSER_TEXTAREA_CLASS } from "./ComposerCard";

// =============================================================================
// 캐럿이 입력칸의 첫 **화면** 줄에 있는가: 진짜 엔진에서 (#5489 M1, 검증 7a-2).
//
// jsdom 에는 배치가 없어 감김을 잴 수 없다(`caretLine.test.ts` 는 가짜 배치로 배선만 잰다). 이 시험은 `caretLine.ts` 를 한 덩어리 스크립트로 묶어 Chromium·WebKit
// 에 올리고, **진짜 입력칸**(`COMPOSER_TEXTAREA_CLASS` 와 `tokens.css` 컴파일 결과)에 길게 감긴 한국어 글을 넣어 캐럿 위치마다 판정한다.
//
// 정답표는 판정 함수와 **다른 길**로 얻는다: 캐럿 앞 글만 든 복제 입력칸의 `scrollHeight` 로 센 화면 줄 수다(진짜 textarea 의 배치). 캐럿 앞 글이 한 화면 줄이면
// 첫 줄이다. 판정 함수(거울의 표지 윗선 비교)가 모든 캐럿 자리에서 이 정답표와 같아야 한다: 첫 줄은 참, 감긴 둘째·셋째 줄과 줄바꿈 뒤는 거짓이다.
// 가드가 실패할 수 있다는 증거: 옛 판정(줄바꿈만 본다)이면 감긴 글의 아래 줄이 참이 되어 이 시험이 붉다(사보타주 1). 감긴 줄이 실제로 있다는 것도 단정한다.
// =============================================================================

const ENTRY = fileURLToPath(new URL("./caretLine.ts", import.meta.url));
const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** 판정 함수를 한 덩어리 스크립트로 묶는다(IIFE, 전역 `CaretLineEntry`). */
async function bundle(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: WEB_ROOT,
    resolve: { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } },
    build: { write: false, minify: false, lib: { entry: ENTRY, formats: ["iife"], name: "CaretLineEntry" } },
  });
  const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string }[] };
  const chunk = output.output.find((item) => item.type === "chunk");
  if (!chunk?.code) throw new Error("bundle produced no chunk");
  return chunk.code;
}

interface Sample {
  position: number;
  /** 판정 함수의 답. */
  first: boolean;
  /** 정답표: 캐럿 앞 글이 차지하는 화면 줄 수. */
  lines: number;
}

// 첫 줄에 이모지가 든다(줄 상자가 더 높을 수 있다). 줄바꿈 없이 한 문단으로 길게 감긴다.
const WRAPPED =
  "😂 오늘 배포 끝나고 나서 확인할 것들을 정리해 봤어요 로그가 정상인지 알림이 잘 가는지 롤백 절차가 문서에 있는지 한 번씩 봐 주세요 그래도 이상한 게 없으면 마무리하고 퇴근할게요 ㅋㅋㅋ";
const WITH_NEWLINE = "첫 줄이에요\n둘째 줄이에요";

describe("캐럿 첫 화면 줄 판정은 진짜 엔진의 감김과 같다 (#5489 M1)", () => {
  it.skipIf(ENGINES.length === 0)(
    "폰 폭과 넓은 폭의 입력칸에서, 캐럿 자리마다 판정 = 캐럿 앞 글이 한 화면 줄인가 (감긴 아래 줄·줄바꿈 뒤는 거짓)",
    async () => {
      const css = await compileTokensCss(COMPOSER_TEXTAREA_CLASS.split(/\s+/));
      const script = await bundle();
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const { width, minLines } of [{ width: 300, minLines: 3 }, { width: 720, minLines: 2 }]) {
            const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
            try {
              await page.setContent(`<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#box { width: ${width}px; box-sizing: border-box; }
.oracle { height: 0; min-height: 0; max-height: none; overflow: hidden; }
</style></head><body class="bg-surface text-ink"><div id="box"><textarea id="t" rows="1" class="${COMPOSER_TEXTAREA_CLASS}"></textarea></div></body></html>`);
              await page.addScriptTag({ content: script });
              for (const [name, text] of [["감긴 글", WRAPPED], ["줄바꿈 글", WITH_NEWLINE]] as const) {
                const samples = await page.evaluate((value): Sample[] => {
                  const field = document.getElementById("t") as HTMLTextAreaElement;
                  field.value = value;
                  const api = (globalThis as unknown as { CaretLineEntry: { caretOnFirstVisualLine(el: HTMLTextAreaElement): boolean } }).CaretLineEntry;
                  /** 정답표: 같은 입력칸의 복제에 캐럿 앞 글만 넣고 스크롤 높이로 센 화면 줄 수. */
                  const linesOf = (prefix: string): number => {
                    const copy = field.cloneNode(false) as HTMLTextAreaElement;
                    copy.removeAttribute("id");
                    copy.value = prefix;
                    copy.classList.add("oracle");
                    field.parentElement?.append(copy);
                    const cs = getComputedStyle(copy);
                    const pad = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
                    const n = Math.round((copy.scrollHeight - pad) / Number.parseFloat(cs.lineHeight));
                    copy.remove();
                    return Math.max(n, 1);
                  };
                  const out: Sample[] = [];
                  for (let position = 0; position <= value.length; position += 1) {
                    field.setSelectionRange(position, position);
                    out.push({ position, first: api.caretOnFirstVisualLine(field), lines: linesOf(value.slice(0, position)) });
                  }
                  return out;
                }, text);
                const at = `${engine} ${width}px ${name}`;
                // 측정이 의미 있으려면 글이 정말 여러 화면 줄로 감겨 있어야 한다.
                const total = Math.max(...samples.map((s) => s.lines));
                if (name === "감긴 글" && total < minLines) problems.push(`${at}: 화면 줄이 ${total}개뿐이다(${minLines}개 이상으로 감겨야 한다)`);
                if (name === "줄바꿈 글" && total < 2) problems.push(`${at}: 줄바꿈 글이 ${total}줄뿐이다`);
                const wrong = samples.filter((s) => s.first !== (s.lines === 1));
                if (wrong.length > 0) {
                  problems.push(`${at}: 판정이 정답표와 다른 캐럿 자리 ${wrong.length}곳 ${JSON.stringify(wrong.slice(0, 4))}`);
                }
                // 양쪽 답이 모두 나와야 한다(한쪽만 나오는 가드는 아무것도 못 재고 초록이 된다).
                if (!samples.some((s) => s.first) || !samples.some((s) => !s.first)) problems.push(`${at}: 참과 거짓이 모두 나오지 않았다`);
              }
              // 거울은 재고 나면 지워진다.
              const mirrors = await page.evaluate(() => document.querySelectorAll("[data-composer-format-mirror]").length);
              if (mirrors !== 0) problems.push(`${engine} ${width}px: 거울 ${mirrors}개가 남았다`);
            } finally {
              await page.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    240_000
  );
});
