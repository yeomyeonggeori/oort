import { describe, expect, it } from "vitest";
import { createServer } from "vite";
import { ENGINES } from "@/design/appearance/compileTokensTestKit";
import type { AgentRunProgress } from "@momo/core/lib/api";

type Controls = {
  setPhase: (phase: AgentRunProgress["phase"] | null) => void;
  setCardStatus: (status: string) => void;
  setSummaryMode: (mode: string) => void;
};

/** 실제 React·토큰·Radix를 띄워 §8.1의 이동 0을 잰다. 캡처는 하지 않아요. */
describe("요청 고리 이동 0", () => {
  it.each(ENGINES)("%s: 생각 줄·칩·요약 버튼·카드 전환이 읽던 자리를 밀지 않는다", async (engine) => {
    const playwright = await import("playwright");
    const browser = await playwright[engine].launch({ headless: true });
    const server = await createServer({
      cacheDir: `/tmp/oort-request-loop-vite-${process.pid}-${engine}`,
      server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
      plugins: [{ name: "request-loop-browser-fixture", configureServer(vite) {
        vite.middlewares.use("/__request-loop", async (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml("/__request-loop", `<!doctype html><html lang="ko"><head><style>
            #root{width:900px;margin:24px}#summary{width:800px}#card-scroller{height:320px;overflow:auto}
            html[data-request-loop-scale="16"]{font-size:16px}html[data-request-loop-scale="24"]{font-size:24px}
            </style></head><body><div id="root"></div><script type="module">import {mountRequestLoopHarness} from '/measure/requestLoop.harness.tsx';mountRequestLoopHarness();</script></body></html>`));
        });
      } }],
    });
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === "string") throw new Error("브라우저 시험 포트가 없어요");
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
      await page.route("**/v1/**", route => route.fulfill({ json: { runId: "run", events: [
        { ordinal: 1, kind: "stage", stage: "소개를 읽었어요", createdAtMs: 1_800_000_000_000 },
      ] } }));
      await page.goto(`http://127.0.0.1:${address.port}/__request-loop`);
      await page.locator("#thought-bottom").waitFor();
      const geometry = () => page.evaluate(() => {
        const y = (id: string) => document.getElementById(id)!.getBoundingClientRect().y;
        return { bottom: y("thought-bottom"), head: document.getElementById("chip-head")!.getBoundingClientRect().height };
      });
      for (const size of [16, 24]) {
        await page.evaluate(value => { document.documentElement.dataset.requestLoopScale = String(value); }, size);
        await page.evaluate(() => (window as unknown as { requestLoopHarness: Controls }).requestLoopHarness.setPhase(null));
        await page.locator('[data-testid="request-thought-slot"]').waitFor({ state: "detached" });
        const baseline = await geometry();
        for (const phase of ["running", "awaiting_approval", "succeeded", "cancelled", "timed_out"] as const) {
          await page.evaluate(value => (window as unknown as { requestLoopHarness: Controls }).requestLoopHarness.setPhase(value), phase);
          await page.locator(`#thought-flow[data-phase="${phase}"]`).waitFor();
          await expect.poll(async () => (await geometry()).bottom).toBe(baseline.bottom);
          expect((await geometry()).head).toBe(baseline.head);
        }
        await page.evaluate(() => (window as unknown as { requestLoopHarness: Controls }).requestLoopHarness.setPhase("running"));
        await page.locator('#thought-flow[data-phase="running"]').waitFor();
        await page.locator('[data-testid="request-thought-line"]').click();
        await page.locator('[data-testid="request-thought-process"]').waitFor();
        expect((await geometry()).bottom).toBe(baseline.bottom);
        expect(await page.locator('[data-testid="responding-dots"]').getAttribute("data-motion")).toBe("still");
        await page.keyboard.press("Escape");
        await page.locator('[data-testid="request-thought-process"]').waitFor({ state: "detached" });
        expect((await geometry()).bottom).toBe(baseline.bottom);
      }
      await page.evaluate(() => { document.documentElement.dataset.requestLoopScale = "16"; });
      await page.locator('[data-testid="thread-request-actions"]').waitFor();
      const summaryHeight = (await page.locator("#summary").boundingBox())!.height;
      await page.evaluate(() => (window as unknown as { requestLoopHarness: Controls }).requestLoopHarness.setSummaryMode("open"));
      await page.locator('[data-testid="thread-request-actions"]').waitFor({ state: "detached" });
      expect((await page.locator("#summary").boundingBox())!.height).toBe(summaryHeight);
      await page.evaluate(() => {
        const above = document.getElementById("above-card")!;
        above.scrollIntoView({ block: "start" });
      });
      const aboveY = (await page.locator("#above-card").boundingBox())!.y;
      await page.evaluate(() => (window as unknown as { requestLoopHarness: Controls }).requestLoopHarness.setCardStatus("approved"));
      await page.locator('[data-bundle-state="done"]').waitFor();
      expect((await page.locator("#above-card").boundingBox())!.y).toBe(aboveY);
      await page.evaluate(() => (window as unknown as { requestLoopHarness: Controls }).requestLoopHarness.setCardStatus("pending"));
      await page.locator('[data-bundle-state="approval"]').waitFor();
      await page.evaluate(() => { const scroller = document.getElementById("card-scroller")!; scroller.scrollTop = scroller.scrollHeight; });
      await page.evaluate(() => (window as unknown as { requestLoopHarness: Controls }).requestLoopHarness.setCardStatus("approved"));
      await page.locator('[data-bundle-state="done"]').waitFor();
      await expect.poll(() => page.evaluate(() => { const scroller = document.getElementById("card-scroller")!; return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop; })).toBe(0);
    } finally { await server.close(); await browser.close(); }
  }, 90_000);
});
