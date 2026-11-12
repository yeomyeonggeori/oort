import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserLaunchBlocked } from "@/testing/agentSandbox";

/**
 * `scrollHold` 를 진짜 엔진의 배치로 잰다 (#5649, Chromium).
 *
 * 이 모듈은 줄의 실제 위치(`getBoundingClientRect`) · ResizeObserver · 스크롤 이벤트의 순서에 기대므로 jsdom 으로는 잴 수 없다. 번들한
 * `scrollHold.ts` 를 빈 페이지의 평범한 스크롤 상자(`overflow-anchor:none` — 브라우저 앵커링이 대신 지키지 못하게)에 걸고, 손을 걸지
 * 않은 대조와 나란히 잰다: 대조가 120px 밀리는 장면에서 손을 건 쪽은 제자리여야 한다. 가상 목록 규칙(`virtualListHold`)은 가짜 줄
 * 목록으로 「누가 맡는가」만 잰다(위로 올린 직후 · 앞에 붙은 뒤에는 손대지 않고, 아래로 내린 직후에는 지킨다) — 진짜 가상 목록과의
 * 숫자는 `gates/gate-thread-hold.mjs` 가 실제 번들에서 잰다. 이 파일의 다른 Chromium 시험처럼 번들 Chromium 이 없으면 건너뛴다.
 */

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "../../..");

function detectChromium(): { ok: true } | { ok: false; path: string } {
  const blocked = browserLaunchBlocked();
  if (blocked !== null) return { ok: false, path: blocked };
  try {
    const { chromium } = require_("playwright") as typeof import("playwright");
    const exe = chromium.executablePath();
    return existsSync(exe) ? { ok: true } : { ok: false, path: exe };
  } catch (err) {
    return { ok: false, path: err instanceof Error ? err.message : String(err) };
  }
}
const chromiumAvailability = detectChromium();
const chromiumAvailable = chromiumAvailability.ok;
if (!chromiumAvailable) {
  console.warn(`scrollHold Chromium 시험을 건너뛴다: Playwright Chromium 이 없다 (${chromiumAvailability.path})`);
}

/**
 * `virtualFixing` 은 가상 목록의 위쪽 보정을 흉내 낸다(react-virtuoso 4.18.11 `upwardScrollFixSystem` 을 읽고 옮긴 모형): 줄 크기 변화를
 * **다음 프레임**(rAF)에 처리하고, 그때 스크롤 방향이 「위」이면 바뀐 높이만큼 scrollTop 을 옮긴다. 방향은 스크롤 이벤트마다 정하고
 * (이 모듈이 놓은 스크롤도 센다) 잠시 뒤 지운다(진짜는 50ms — 여기서는 부하로 프레임이 늘어져도 장면이 서게 120ms). 진짜 가상 목록이 아니라 「같은 변화를 한 번 더 보정하는 다른 손」의 모형이다.
 */
type Kind = "plain" | "virtual" | "virtualFixing";
type Probe = {
  /** 보던 줄(창 위 끝에 처음 걸친 줄 아래 둘째 줄)의 위 끝이 장면 동안 움직인 값(px). */
  moved: number;
  scrollTop: number;
  gap: number;
};

declare global {
  interface Window {
    __scrollHold: typeof import("./scrollHold");
    __lab: {
      /** 상자를 새로 짓는다. `rows` 줄(각 50px), 상자 높이 400px. `hold` 가 거짓이면 손을 걸지 않는다(대조). */
      build: (options: { kind: Kind; rows: number; hold: boolean }) => void;
      token: number;
      frames: (count?: number) => Promise<void>;
      /**
       * `steps` 를 차례로 하고(각 단계 뒤 두 프레임), 보던 줄의 이동을 돌려준다. 단계는 프레임 사이의 태스크에서 한다 — 사람의 스크롤처럼
       * 스크롤 이벤트가 그 프레임의 ResizeObserver 보다 먼저 온다. `inFrame` 이면 rAF 안에서 한다(스크립트가 그리기 직전에 옮긴 스크롤:
       * 그 프레임의 ResizeObserver 가 스크롤 이벤트보다 먼저 온다).
       */
      run: (steps: string[], inFrame?: boolean) => Promise<Probe>;
      expectBottom: () => void;
      expectScripted: () => void;
    };
  }
}

const PAGE = `<!doctype html><html><head><style>
html, body { margin: 0; }
#box { height: 400px; overflow-y: auto; overflow-anchor: none; }
.row { height: 50px; box-sizing: border-box; }
.row.grow-120 { height: 170px; }
.row.grow-400 { height: 450px; }
.margin-300 { margin-bottom: 300px; }
</style></head><body><div id="host"></div></body></html>`;

/** 페이지 안의 실험대. 줄은 클래스로 키운다(이 트리의 규칙: 시험도 런타임에 스타일을 쓰지 않는다 — `designSystem.test.ts`). */
function installLab() {
  const frames = (count = 2) =>
    new Promise<void>((done) => {
      const tick = (left: number) => (left === 0 ? done() : requestAnimationFrame(() => tick(left - 1)));
      tick(count);
    });
  let box: HTMLElement;
  let list: HTMLElement;
  let hold: ReturnType<Window["__scrollHold"]["holdScrollPosition"]> | null = null;
  let rowAttribute = "data-row";
  const rowAt = (index: number) => list.children[index] as HTMLElement;
  /** 줄을 `amount`px 키운다(0 · 120 · 400 가운데 하나). */
  const grow = (row: HTMLElement, amount: number) => {
    if (![0, 120, 400].includes(amount)) throw new Error(`모르는 높이: ${amount}`);
    row.classList.toggle("grow-120", amount === 120);
    row.classList.toggle("grow-400", amount === 400);
  };
  const lab: Window["__lab"] = {
    token: 0,
    frames,
    build: ({ kind, rows, hold: withHold }) => {
      hold?.stop();
      hold = null;
      lab.token = 0;
      const virtual = kind !== "plain";
      rowAttribute = virtual ? "data-index" : "data-row";
      const host = document.getElementById("host") as HTMLElement;
      host.replaceChildren();
      box = document.createElement("div");
      box.id = "box";
      // 가상 목록은 스크롤러 안에 상자 하나, 그 안에 줄 목록을 둔다. 평범한 목록은 줄 목록이 스크롤 상자의 자식이다.
      list = document.createElement("div");
      if (virtual) {
        const viewport = document.createElement("div");
        list.dataset.testid = "virtuoso-item-list";
        viewport.append(list);
        box.append(viewport);
      } else box.append(list);
      for (let i = 0; i < rows; i += 1) {
        const row = document.createElement("div");
        row.className = "row";
        row.setAttribute(rowAttribute, `r${i}`);
        list.append(row);
      }
      host.append(box);
      if (kind === "virtualFixing") {
        // 이 모듈보다 먼저 관찰자를 건다: 진짜 가상 목록처럼 그 rAF 가 이 모듈의 다시 확인보다 앞에 돈다.
        let prevTop = box.scrollTop;
        let prevHeight = list.offsetHeight;
        let direction: "up" | "down" | "none" = "none";
        let timer = 0;
        box.addEventListener("scroll", () => {
          if (box.scrollTop !== prevTop) direction = box.scrollTop < prevTop ? "up" : "down";
          prevTop = box.scrollTop;
          if (timer === 0) {
            timer = window.setTimeout(() => {
              timer = 0;
              direction = "none";
            }, 120);
          }
        });
        new ResizeObserver(() => {
          requestAnimationFrame(() => {
            const change = list.offsetHeight - prevHeight;
            prevHeight = list.offsetHeight;
            if (change !== 0 && direction === "up" && box.scrollTop !== 0) box.scrollTop += change;
          });
        }).observe(list);
      }
      if (!withHold) return;
      const { holdScrollPosition, plainListHold, virtualListHold } = window.__scrollHold;
      hold = holdScrollPosition(box, virtual ? virtualListHold(() => lab.token) : plainListHold(rowAttribute));
    },
    expectBottom: () => hold?.expectBottom(),
    expectScripted: () => hold?.expectScripted(),
    run: async (steps, inFrame = false) => {
      const edge = box.getBoundingClientRect().top;
      const rows = [...list.children] as HTMLElement[];
      const first = rows.findIndex((row) => row.getBoundingClientRect().bottom > edge);
      const watch = rows[first + 2] ?? rows[rows.length - 1];
      const before = watch.getBoundingClientRect().top;
      for (const step of steps) {
        if (inFrame) await frames(1);
        else await new Promise((done) => setTimeout(done, 0));
        // `+` 로 이은 동작은 프레임을 넘기지 않고 한 태스크에서 한다(스크롤과 줄 높이 변화가 한 프레임에 겹친다).
        for (const action of step.split("+")) {
          const [name, value] = action.split(":");
          const amount = Number(value);
          if (name === "growAbove") grow(rowAt(1), amount);
          else if (name === "growNext") grow(rowAt(2), amount);
          else if (name === "growLast") grow(rowAt(rows.length - 1), amount);
          else if (name === "scroll") box.scrollTop += amount;
          else if (name === "wheel") {
            // 사람의 손: 휠 이벤트가 먼저 오고 스크롤이 따른다(합성 휠 이벤트는 스스로 스크롤하지 않는다).
            box.dispatchEvent(new WheelEvent("wheel", { deltaY: amount }));
            box.scrollTop += amount;
          }
          else if (name === "expectScripted") hold?.expectScripted();
          else if (name === "scrollToEnd") box.scrollTop = box.scrollHeight;
          else if (name === "margin") list.classList.add("margin-300");
          else if (name === "prepend") lab.token += 1;
          else if (name === "append") {
            const row = document.createElement("div");
            row.className = "row";
            row.setAttribute(rowAttribute, `added${list.children.length}`);
            list.append(row);
          } else if (name === "wait") await new Promise((done) => setTimeout(done, amount));
          else throw new Error(`모르는 단계: ${action}`);
        }
        await frames(2);
      }
      await frames(4);
      return {
        moved: Math.round((watch.getBoundingClientRect().top - before) * 100) / 100,
        scrollTop: box.scrollTop,
        gap: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight),
      };
    },
  };
  window.__lab = lab;
}

describe("scrollHold — 진짜 엔진의 배치 (#5649, Chromium)", () => {
  let browser: import("playwright").Browser | null = null;
  let page: import("playwright").Page;

  beforeAll(async () => {
    if (!chromiumAvailable) return;
    const { chromium } = await import("playwright");
    const esbuild = await import("esbuild");
    const bundled = await esbuild.build({
      absWorkingDir: WEB_ROOT,
      entryPoints: [join(HERE, "scrollHold.ts")],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__scrollHold",
      platform: "browser",
      alias: { "@": join(WEB_ROOT, "src"), "@momo/core": join(WEB_ROOT, "../../packages/momo-core/src") },
      logLevel: "silent",
    });
    const js = bundled.outputFiles[0]?.text;
    if (!js) throw new Error("esbuild 가 scrollHold 번들을 내지 않았다");
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(PAGE);
    await page.addScriptTag({ content: js });
    await page.evaluate(installLab);
  }, 40_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** 장면 하나: 상자를 짓고, 자리를 잡고, 단계를 돌린다. */
  async function scene(options: { kind: Kind; rows?: number; hold: boolean; startTop: number | "bottom"; before?: string[]; steps: string[]; inFrame?: boolean }) {
    return page.evaluate(async ({ kind, rows = 40, hold, startTop, before = [], steps, inFrame = false }) => {
      const lab = window.__lab;
      lab.build({ kind, rows, hold });
      const box = document.getElementById("box") as HTMLElement;
      box.scrollTop = startTop === "bottom" ? box.scrollHeight : startTop;
      // 처음 자리 잡는 스크롤이 「방금 한 사람의 스크롤」이 아니게 기다린다(가상 목록 규칙의 150ms 창).
      await new Promise((done) => setTimeout(done, 250));
      if (before.length > 0) await lab.run(before);
      return lab.run(steps, inFrame);
    }, options);
  }

  it.skipIf(!chromiumAvailable)("평범한 목록: 위를 읽는 중 위 밖 줄이 120px 자라고 줄어도 보던 줄은 제자리다 — 손이 없으면 120px 밀린다", async () => {
    const control = await scene({ kind: "plain", hold: false, startTop: 500, steps: ["growAbove:120"] });
    expect(control.moved).toBe(120);
    const grown = await scene({ kind: "plain", hold: true, startTop: 500, steps: ["growAbove:120"] });
    expect(Math.abs(grown.moved)).toBeLessThanOrEqual(1);
    expect(grown.scrollTop).toBe(620);
    const shrunk = await scene({ kind: "plain", hold: true, startTop: 500, before: ["growAbove:120"], steps: ["growAbove:0"] });
    expect(Math.abs(shrunk.moved)).toBeLessThanOrEqual(1);
    expect(shrunk.scrollTop).toBe(500);
  });

  it.skipIf(!chromiumAvailable)("평범한 목록: 스크롤과 같은 프레임에 줄이 자라도 보던 줄은 스크롤한 만큼만 움직인다", async () => {
    // 스크롤 이벤트가 그 프레임의 ResizeObserver 보다 먼저 온다: 거기서 자리를 다시 적으면 자람이 섞여 사라진다(대조 = 손 없음 90px).
    const steps = ["scroll:30", "growAbove:120+scroll:30"];
    const control = await scene({ kind: "plain", hold: false, startTop: 500, steps });
    expect(control.moved).toBe(60);
    const held = await scene({ kind: "plain", hold: true, startTop: 500, steps });
    expect(Math.abs(held.moved - -60)).toBeLessThanOrEqual(1);
    expect(held.scrollTop).toBe(680);
    // 스크립트가 그리기 직전에 옮긴 스크롤(스크롤 이벤트가 아직 오지 않았다)도 뜻한 이동이다: 되돌리지 않고 자람만 바로잡는다.
    const scripted = await scene({ kind: "plain", hold: true, startTop: 500, steps: ["growAbove:120+scroll:200"], inFrame: true });
    expect(Math.abs(scripted.moved - -200)).toBeLessThanOrEqual(1);
    expect(scripted.scrollTop).toBe(820);
  });

  it.skipIf(!chromiumAvailable)("평범한 목록: 스크롤해 내려와 닿은 바닥은 줄이 자라고 새 줄이 붙어도 바닥이다", async () => {
    const control = await scene({ kind: "plain", hold: false, startTop: "bottom", steps: ["growLast:120", "append:1"] });
    expect(control.gap).toBe(170);
    const held = await scene({ kind: "plain", hold: true, startTop: "bottom", steps: ["growLast:120", "append:1"] });
    expect(held.gap).toBeLessThanOrEqual(1);
  });

  it.skipIf(!chromiumAvailable)("평범한 목록: 지켜보는 상자의 크기는 그대로인 채 내용 높이만 바뀐 뒤에도, 바닥에 닿으면 다시 바닥으로 안다", async () => {
    // 바깥 여백은 줄 목록 상자의 크기를 바꾸지 않아 ResizeObserver 가 오지 않는다. 그 변화를 스크롤 이벤트에서 「맡겨 둔」 채로 붙들면
    // 그 뒤 스크롤해 내려와도 바닥으로 읽지 못해 새 줄을 따라가지 않는다.
    const held = await scene({ kind: "plain", hold: true, startTop: 500, steps: ["margin:300+scroll:30", "scrollToEnd:1", "append:1+append:1"] });
    // 붙은 두 줄(100px)은 바닥 여유(64px)보다 크다: 바닥으로 알고 있어야만 따라간다.
    expect(held.gap).toBeLessThanOrEqual(1);
  });

  it.skipIf(!chromiumAvailable)("평범한 목록: 한 화면에 다 들어와 맨 위에 선 목록은 넘치게 자라도 맨 위다(맨 위에 선 채로는 바닥이 아니다)", async () => {
    const held = await scene({ kind: "plain", rows: 6, hold: true, startTop: 0, steps: ["growLast:400", "append:1"] });
    expect(held.scrollTop).toBe(0);
    expect(held.gap).toBeGreaterThan(300);
  });

  it.skipIf(!chromiumAvailable)("평범한 목록: 위를 읽던 중 「이제 바닥」을 알리면 바닥으로 가고, 그 뒤 자람에도 바닥이다", async () => {
    const result = await page.evaluate(async () => {
      const lab = window.__lab;
      lab.build({ kind: "plain", rows: 40, hold: true });
      const box = document.getElementById("box") as HTMLElement;
      box.scrollTop = 500;
      await lab.frames(3);
      lab.expectBottom();
      await lab.frames(3);
      const gapAfterSignal = box.scrollHeight - box.scrollTop - box.clientHeight;
      const after = await lab.run(["append:1", "growLast:120"]);
      return { gapAfterSignal, gap: after.gap };
    });
    expect(result.gapAfterSignal).toBeLessThanOrEqual(1);
    expect(result.gap).toBeLessThanOrEqual(1);
  });

  it.skipIf(!chromiumAvailable)("가상 목록 규칙: 사람이 휠로 내린 직후의 자람은 지키고, 위로 올린 직후 · 스크립트가 옮긴 직후 · 앞에 붙은 뒤의 자람은 목록의 몫으로 둔다", async () => {
    // 가만히: 지킨다(이 칸 전부터).
    const still = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["growAbove:120"] });
    expect(Math.abs(still.moved)).toBeLessThanOrEqual(1);
    // 휠로 아래로 내린 직후(150ms 안): 가상 목록은 방향이 「위」일 때만 스스로 보정한다 — 이 모듈이 지킨다(#5649, 수리 전 120px).
    const down = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["wheel:30", "growAbove:120"] });
    expect(Math.abs(down.moved - -30)).toBeLessThanOrEqual(1);
    // 휠로 내리는 것과 같은 프레임.
    const downSameFrame = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["wheel:30", "growAbove:120+wheel:30"] });
    expect(Math.abs(downSameFrame.moved - -60)).toBeLessThanOrEqual(1);
    // **스크립트가** 아래로 옮긴 스크롤(메시지로 이동)과 같은 프레임의 자람: 손대지 않는다 — 목록이 자리를 다시 놓는 중에 붙들면 이동을 무른다.
    const scripted = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["scroll:30+growAbove:120"] });
    expect(scripted.moved).toBe(90);
    // 위로 올리는 프레임: 손대지 않는다 — 가상 목록의 위쪽 보정과 겹치면 두 번 보정된다(이 가짜 목록에는 그 보정이 없어 그대로 밀린다).
    const up = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["scroll:-30+growAbove:120"] });
    expect(up.moved).toBe(150);
    // 위로 올리고 150ms 가 지난 뒤: 다시 지킨다.
    const upLater = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["scroll:-30", "wait:220", "growAbove:120"] });
    expect(Math.abs(upLater.moved - 30)).toBeLessThanOrEqual(1);
    // 앞에 붙었다(`firstItemIndex` 가 바뀜): 그 높이는 목록이 스스로 메운다 — 손대지 않는다.
    const prepended = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["prepend:1+growAbove:120"] });
    expect(prepended.moved).toBe(120);
  });

  it.skipIf(!chromiumAvailable)("가상 목록 규칙: 휠 직후에 스크립트가 옮긴 스크롤(「최신 메시지로 이동」)은 손대지 않는다 — `expectScripted` 가 없으면 사람의 스크롤로 오해해 붙든다(#5649 검수 H1)", async () => {
    // 휠 30px 뒤 곧바로 스크립트가 30px 옮기며 위 밖 줄이 120px 자란다(같은 프레임). 알렸으면 목록의 몫: 손대지 않는다(보던 줄 −30 −30 +120 = +60).
    const scripted = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["wheel:30", "expectScripted:1", "scroll:30+growAbove:120"] });
    expect(scripted.moved).toBe(60);
    // 알리지 않으면 휠 직후의 스크롤이라 사람의 손으로 쳐 붙든다 — 스크립트의 이동을 무르는 길이다(H1 의 원인).
    const unannounced = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["wheel:30", "scroll:30+growAbove:120"] });
    expect(Math.abs(unannounced.moved - -60)).toBeLessThanOrEqual(1);
    // 알린 뒤 사람이 휠로 끼어들면 창이 닫혀 다시 사람의 손으로 친다.
    const handBack = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["expectScripted:1", "wheel:30", "growAbove:120+wheel:30"] });
    expect(Math.abs(handBack.moved - -60)).toBeLessThanOrEqual(1);
    // 알린 스크롤이 이어지는 동안(스크롤 이벤트마다 창이 이어진다): 시작 1초 안의 첫 스크롤 뒤 300ms 안에 이어진 스크롤도 스크립트의 것이다.
    const continued = await scene({ kind: "virtual", hold: true, startTop: 500, steps: ["wheel:30", "expectScripted:1", "scroll:30", "wait:100", "scroll:30+growAbove:120"] });
    expect(continued.moved).toBe(30);
  });

  it.skipIf(!chromiumAvailable)("가상 목록 규칙: 목록이 같은 변화를 한 번 더 보정해도 그리기 전에 되돌린다 — 가만히, 그리고 아래로 내리는 중", async () => {
    // 위 밖 줄이 줄면 이 모듈이 위로 바로잡고, 그 스크롤이 목록에는 「위」로 보여 다음 프레임에 같은 높이를 한 번 더 옮긴다(#5575: 127.5px).
    const still = await scene({ kind: "virtualFixing", hold: true, startTop: 500, before: ["growAbove:120"], steps: ["growAbove:0"] });
    expect(Math.abs(still.moved)).toBeLessThanOrEqual(1);
    expect(still.scrollTop).toBe(500);
    // 아래로 내리는 것과 같은 프레임에 줄었다: 사람의 스크롤(30px)은 그대로 두고, 목록의 두 번째 보정만 되돌린다.
    const scrolling = await scene({ kind: "virtualFixing", hold: true, startTop: 500, before: ["growAbove:120"], steps: ["growAbove:0+wheel:30"] });
    expect(Math.abs(scrolling.moved - -30)).toBeLessThanOrEqual(1);
    expect(scrolling.scrollTop).toBe(530);
    // 앞의 확인이 아직 도는 동안(3프레임) 다른 줄이 또 줄었다, 이번에는 스크롤과 같은 프레임에: 두 번째 변화도 관찰자가 바로잡고
    // 확인을 다시 걸어야 목록의 두 번째 보정을 본다(확인이 rAF 에서 먼저 바로잡거나, 먼저 걸린 채로 두면 120px 이 남는다).
    const twice = await scene({
      kind: "virtualFixing",
      hold: true,
      startTop: 500,
      before: ["growAbove:120+growNext:120"],
      steps: ["growAbove:0", "growNext:0+wheel:30"],
    });
    expect(Math.abs(twice.moved - -30)).toBeLessThanOrEqual(1);
    // 모형이 정말 한 번 더 보정한다는 대조: 위로 올리는 프레임의 자람은 이 모듈이 손대지 않고 모형이 메운다(보던 줄은 스크롤한 만큼만).
    const upward = await scene({ kind: "virtualFixing", hold: true, startTop: 500, steps: ["scroll:-30+growAbove:120"] });
    expect(Math.abs(upward.moved - 30)).toBeLessThanOrEqual(1);
  });
});
