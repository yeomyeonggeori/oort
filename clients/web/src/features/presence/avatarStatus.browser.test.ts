import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import type { StatusDotTone } from "@momo/core/features/presence/statusDot";
import {
  WEB_STATUS_BADGE_FACES,
  statusBadgeGeometry,
  type StatusBadgeSubject,
} from "@momo/core/features/presence/statusBadge";
import { browserLaunchBlocked } from "@/testing/agentSandbox";
import { AvatarStatus } from "./AvatarStatus";

/**
 * 아바타 상태 점: 도려낸 틈을 **그려진 픽셀**로 잰다 (#5786, owner 2026-11-13 QA 15).
 *
 * 데스크탑 앱은 WebKit(WKWebView)으로 그린다. 마스크의 가장자리·`mask-composite`·`radial-gradient` 의 딱 맞는 멈춤점은
 * 엔진마다 다르게 그려질 수 있으므로 번들 WebKit 과 Chromium 둘 다에서 잰다(다른 브라우저 시험과 같은 규약: 엔진이 없으면
 * 경고를 남기고 건너뛴다. 이 칸의 PR 은 실제로 돈 엔진 수를 적는다).
 *
 * 무엇을 재나(크기 24·32·112 × 네 톤 × 바탕 다섯 × 밝게/어둡게, 기기 배율 2):
 *   틈    점 중심에서 「점 반지름 + 틈/2」 거리의 세 점(왼쪽·왼쪽 위·위 — 아바타 위)이 **바탕 색 그대로**다. 예전의 면색 테는
 *         가리킴·선택·띠·사진 위에서 바탕과 다른 색이었다 — 그 색 테가 없다는 것이 이 줄이다.
 *   점    모양(뜻): 사람 ok 는 가운데가 표식, 사람 warn 은 왼쪽 위(덜어 낸 원)가 바탕이고 오른쪽 아래가 표식, danger 는
 *         가운데(가로 줄)가 바탕이고 위아래가 표식, muted 는 가운데가 바탕이고 고리 자리가 표식. **에이전트 warn 은 채운
 *         원**이다 — 사람의 초승달이 비는 왼쪽 위까지 표식이다(r1 H2: 경고가 「자리 비움」 그림이 되지 않는다). 표식은 바탕과
 *         3:1 이상.
 *   가장자리 도려낸 원의 반지름을 세 방향에서 재어 1 기기 px 안에서 같다(찌그러지거나 계단지지 않는다). 바탕과 아바타
 *         사이의 섞인 픽셀은 2 기기 px 이하(번지지 않는다).
 *   대조  점이 없는 아바타는 같은 자리가 아바타 색이다(이 시험이 도려냄을 실제로 본다는 증거).
 *   큰 얼굴 바깥 그림자가 점이 있을 때와 없을 때 같다(마스크가 그림자를 자르지 않는다).
 */

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = join(HERE, "../../design");
const DSF = 2;

type EngineName = "webkit" | "chromium";

function engineMissing(name: EngineName): string | null {
  const blocked = browserLaunchBlocked();
  if (blocked !== null) return blocked;
  try {
    const playwright = require_("playwright") as typeof import("playwright");
    const exe = playwright[name].executablePath();
    return existsSync(exe) ? null : exe;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const ENGINES: EngineName[] = (["webkit", "chromium"] as const).filter((name) => {
  const missing = engineMissing(name);
  if (missing !== null) console.warn(`avatar status: Playwright ${name} missing (${missing})`);
  return missing === null;
});

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

const FACE_CLASS: Record<number, string> = {
  24: "flex size-6 rounded-full border border-line bg-avatar-1-soft",
  32: "flex size-8 rounded-full border border-line bg-avatar-3-soft",
  112: "flex avatar-hero rounded-full bg-avatar-5-soft",
};

async function buildCss(): Promise<string> {
  const compiler = await compile(readFileSync(join(DESIGN, "tokens.css"), "utf8"), {
    base: DESIGN,
    loadStylesheet,
  });
  const candidates = new Set<string>([
    "avatar-status",
    "status-shape-moon",
    "status-shape-bar",
    "status-shape-ring",
    "band-surface",
    "bg-surface",
    "bg-surface-hover",
    "bg-signal-soft",
  ]);
  for (const cls of Object.values(FACE_CLASS)) for (const c of cls.split(" ")) candidates.add(c);
  const noeul = readFileSync(join(DESIGN, "themes/palettes/noeul.css"), "utf8");
  return `${compiler.build([...candidates])}\n${noeul}`;
}

/** 바탕 다섯: 쉬는 면 · 가리킨 줄 · 짙은 색 바탕(색 테가 가장 잘 드러나는 곳) · 띠(노을, 사이드바) · 사진 아바타(쉬는 면 위). */
const BACKDROPS = ["surface", "hover", "tinted", "band", "photo"] as const;
type Backdrop = (typeof BACKDROPS)[number];
/** 열: 사람의 네 상태 · 점 없음 · 에이전트 경고(채운 원이어야 한다). */
const TONES: readonly { tone: StatusDotTone | null; subject: StatusBadgeSubject }[] = [
  { tone: "ok", subject: "human" },
  { tone: "warn", subject: "human" },
  { tone: "danger", subject: "human" },
  { tone: "muted", subject: "human" },
  { tone: null, subject: "human" },
  { tone: "warn", subject: "agent" },
];

const CELL = 176;
const PAD = 32;

interface Cell {
  backdrop: Backdrop;
  face: number;
  tone: StatusDotTone | null;
  subject: StatusBadgeSubject;
  x: number;
  y: number;
}

function layout(): Cell[] {
  const cells: Cell[] = [];
  let row = 0;
  for (const backdrop of BACKDROPS) {
    for (const face of WEB_STATUS_BADGE_FACES) {
      TONES.forEach(({ tone, subject }, col) => cells.push({ backdrop, face, tone, subject, x: col * CELL, y: row * CELL }));
      row += 1;
    }
  }
  return cells;
}

function pageHtml(css: string, cells: Cell[]): string {
  const body = cells
    .map((cell) => {
      const faceClass = FACE_CLASS[cell.face]!;
      const face = createElement("span", {
        className: cell.backdrop === "photo" ? `${faceClass} photo` : faceClass,
      });
      const avatar = renderToStaticMarkup(
        createElement(AvatarStatus, {
          face: cell.face as 24 | 32 | 112,
          tone: cell.tone,
          kind: cell.subject,
          children: face,
        })
      );
      const inner = `<div class="at">${avatar}</div>`;
      // 띠 칸만 노을 팔레트(띠가 있는 첫 파티 테마)의 사이드바 안이다. 앱과 같은 겹: 팔레트가 바깥(앱에서는 문서 뿌리),
      // 사이드바가 그 안이라 사이드바 묶음(주황·빨강 → on-band 단계, 점 초록 → 섞은 값)이 팔레트를 이긴다. 나머지는
      // 기본 팔레트(새벽하늘).
      const body =
        cell.backdrop === "band"
          ? `<div class="fill sidebar-drawer bd-band">${inner}</div>`
          : `<div class="fill bd-${cell.backdrop}">${inner}</div>`;
      const scope = cell.backdrop === "band" ? ' data-palette-preview="noeul"' : "";
      return `<div class="cell"${scope} style="left:${cell.x}px;top:${cell.y}px">${body}</div>`;
    })
    .join("\n");
  return `<!doctype html><html lang="ko"><head>
<style>${css}
body { margin: 0; }
.cell { position: absolute; width: ${CELL}px; height: ${CELL}px; }
.fill { position: absolute; inset: 0; }
.at { position: absolute; left: ${PAD}px; top: ${PAD}px; display: flex; }
.bd-surface, .bd-photo { background: var(--surface); }
.bd-hover { background: var(--surface-hover); }
.bd-tinted { background: var(--signal); }
.bd-band { background: var(--band); }
.photo { background: linear-gradient(135deg, var(--agent), var(--signal) 60%, var(--ok)); }
</style></head><body>${body}</body></html>`;
}

// ---- PNG → 픽셀 (스크린샷 전용: 8비트 RGB·RGBA, 비인터레이스. scripts/capture-5242.mjs 의 복호기와 같은 모양) ----
interface Image {
  width: number;
  channels: number;
  data: Buffer;
}
function decodePng(png: Buffer): Image {
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9]!;
    }
    if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? data[y * stride + x - channels]! : 0;
      const up = y > 0 ? data[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels]! : 0;
      let value = raw[y * (stride + 1) + 1 + x]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - upLeft;
        const dl = Math.abs(guess - left);
        const du = Math.abs(guess - up);
        const dul = Math.abs(guess - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      }
      data[y * stride + x] = value & 255;
    }
  }
  return { width, channels, data };
}

type Px = readonly [number, number, number];
/** CSS px 좌표의 기기 픽셀(그 점을 덮는 픽셀). */
function px(img: Image, cssX: number, cssY: number): Px {
  const x = Math.floor(cssX * DSF);
  const y = Math.floor(cssY * DSF);
  const i = (y * img.width + x) * img.channels;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}
const near = (a: Px, b: Px, tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const lum = ([r, g, b]: Px) => {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a: Px, b: Px) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const show = (p: Px) => p.join(",");

/** 한 칸을 재고 어긋난 것을 글로 돌려준다. */
function measureCell(img: Image, cell: Cell, label: string): string[] {
  const problems: string[] = [];
  const { dot, gap } = statusBadgeGeometry(cell.face);
  const ox = cell.x + PAD;
  const oy = cell.y + PAD;
  const backdrop = px(img, cell.x + 4, cell.y + 4);
  const c = cell.face - dot / 2; // 점 중심(아바타 상자 기준)
  const at = (dx: number, dy: number) => px(img, ox + c + dx, oy + c + dy);
  const gapR = dot / 2 + gap / 2;
  const diag = Math.SQRT1_2;
  const gapPoints: [string, number, number][] = [
    ["왼쪽", -gapR, 0],
    ["왼쪽 위", -gapR * diag, -gapR * diag],
    ["위", 0, -gapR],
  ];
  // 사진 칸의 바탕은 쉬는 면이다(점 둘레 틈에 비쳐야 하는 것은 사진이 아니라 바탕).
  for (const [where, dx, dy] of gapPoints) {
    const got = at(dx, dy);
    if (cell.tone === null) continue;
    if (!near(got, backdrop)) problems.push(`${label} 틈(${where}) ${show(got)} ≠ 바탕 ${show(backdrop)}`);
  }
  const faceInside = px(img, ox + cell.face * 0.3, oy + cell.face * 0.3);
  if (near(faceInside, backdrop, 2) && cell.backdrop !== "photo") {
    problems.push(`${label} 아바타가 그려지지 않았다(${show(faceInside)})`);
  }
  if (cell.tone === null) {
    // 대조: 점이 없으면 같은 자리가 아바타다(도려내지 않는다).
    const got = at(-gapR, 0);
    if (near(got, backdrop, 2)) problems.push(`${label} 점이 없는데 틈 자리가 바탕이다(${show(got)})`);
    return problems;
  }
  const mark = (where: string, dx: number, dy: number) => {
    const got = at(dx, dy);
    // 짙은 색 바탕(신호색)은 점이 실제로 서는 자리가 아니다: 색 테가 드러나는지만 보는 칸이라 표식은 바탕과 「다르기만」
    // 하면 된다. 점이 서는 바탕(면·가리킴·띠·사진 옆 면)에서는 3:1 이다.
    const min = cell.backdrop === "tinted" ? 1 : 3;
    const r = ratio(got, backdrop);
    if (r < min || near(got, backdrop)) problems.push(`${label} 표식(${where}) ${show(got)} 대 바탕 ${r.toFixed(2)} < ${min}`);
  };
  const hole = (where: string, dx: number, dy: number) => {
    const got = at(dx, dy);
    if (!near(got, backdrop)) problems.push(`${label} 빈 곳(${where}) ${show(got)} ≠ 바탕 ${show(backdrop)}`);
  };
  const r = dot / 2;
  if (cell.subject === "agent") {
    // 에이전트 경고 = 채운 원: 가운데도, 사람의 초승달이 비는 왼쪽 위도 표식이다.
    mark("가운데", 0, 0);
    mark("왼쪽 위(초승달이면 빈 곳)", -r * 0.5, -r * 0.5);
  } else switch (cell.tone) {
    case "ok":
      mark("가운데", 0, 0);
      break;
    case "warn":
      hole("덜어 낸 왼쪽 위", -r * 0.5, -r * 0.5);
      mark("오른쪽 아래", r * 0.55, r * 0.55);
      break;
    case "danger":
      hole("가운데 줄", 0, 0);
      mark("줄 위", 0, -(gap / 2 + (r - gap / 2) / 2));
      mark("줄 아래", 0, gap / 2 + (r - gap / 2) / 2);
      break;
    case "muted":
      hole("가운데", 0, 0);
      mark("고리", -(r - gap / 2), 0);
      break;
  }
  // 가장자리: 구멍 반지름을 세 방향에서(점 중심에서 바깥으로 걸어 처음 「바탕이 아닌」 픽셀) — 같아야 한다.
  if (cell.backdrop !== "photo") {
    const radii = [
      [-1, 0],
      [-diag, -diag],
      [0, -1],
    ].map(([ux, uy]) => {
      let steps = 0;
      for (let d = r + 0.75; d < r + gap + 3; d += 1 / DSF) {
        steps += 1;
        if (!near(at(ux! * d, uy! * d), backdrop)) return { d, blend: 0 };
      }
      return { d: Number.NaN, blend: steps };
    });
    const ds = radii.map((x) => x.d);
    if (ds.some(Number.isNaN)) problems.push(`${label} 구멍 끝을 못 찾았다 ${ds.join("/")}`);
    else if (Math.max(...ds) - Math.min(...ds) > 1 / DSF + 1e-6) problems.push(`${label} 구멍 반지름이 방향마다 다르다 ${ds.join("/")}`);
    // 번짐: 구멍 끝에서 아바타 색이 될 때까지의 섞인 픽셀 수(왼쪽 방향).
    const faceColor = at(-(r + gap + 3), 0);
    let mixed = 0;
    for (let d = r + gap - 1; d < r + gap + 3; d += 1 / DSF) {
      const p = at(-d, 0);
      if (!near(p, backdrop) && !near(p, faceColor)) mixed += 1;
    }
    if (mixed > 2) problems.push(`${label} 가장자리가 ${mixed} 기기 px 번진다`);
  }
  return problems;
}

describe("아바타 상태 점 — 도려낸 틈을 픽셀로 (#5786)", () => {
  it.skipIf(ENGINES.length === 0)(
    "WebKit·Chromium × 밝게/어둡게 × 24·32·112 × 네 톤 × 바탕 다섯: 틈은 바탕 그대로, 모양·가장자리·큰 얼굴 그림자",
    async () => {
      const css = await buildCss();
      const cells = layout();
      const html = pageHtml(css, cells);
      const playwright = await import("playwright");
      const problems: string[] = [];
      const ran: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const scheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({
              viewport: { width: CELL * TONES.length, height: CELL * BACKDROPS.length * WEB_STATUS_BADGE_FACES.length },
              deviceScaleFactor: DSF,
              colorScheme: scheme,
            });
            try {
              const page = await ctx.newPage();
              await page.setContent(html);
              // 띠 칸에 정말 띠가 섰는지(팔레트가 안 걸리면 띠 칸이 아무것도 재지 않는다).
              const band = await page.evaluate(() => getComputedStyle(document.querySelector(".bd-band")!).backgroundColor);
              const surface = await page.evaluate(() => getComputedStyle(document.querySelector(".bd-surface")!).backgroundColor);
              expect(band, `${engine} ${scheme} 띠`).not.toBe(surface);
              const img = decodePng(await page.screenshot({ fullPage: true, animations: "disabled" }));
              for (const cell of cells) {
                problems.push(
                  ...measureCell(img, cell, `${engine} ${scheme} ${cell.backdrop} ${cell.face} ${cell.subject} ${cell.tone ?? "점 없음"}`)
                );
              }
              // 큰 얼굴 그림자: 점 있는 칸과 없는 칸의 아바타 바로 아래(가운데, 4px 아래)가 같다.
              const hero = (tone: StatusDotTone | null) =>
                cells.find((c) => c.backdrop === "surface" && c.face === 112 && c.tone === tone && c.subject === "human")!;
              const below = (cell: Cell) => px(img, cell.x + PAD + 56, cell.y + PAD + 112 + 4);
              if (!near(below(hero("ok")), below(hero(null)), 2)) {
                problems.push(`${engine} ${scheme} 큰 얼굴 그림자가 점 때문에 달라졌다 ${show(below(hero("ok")))} / ${show(below(hero(null)))}`);
              }
              // 그림자가 정말 그려지는 자리를 재는가(밝게만: 어둡게는 그림자가 띠 바탕과 거의 같다).
              const heroBackdrop = px(img, hero(null).x + 4, hero(null).y + 4);
              if (scheme === "light" && near(below(hero(null)), heroBackdrop, 1)) {
                problems.push(`${engine} ${scheme} 큰 얼굴 아래에 그림자가 없다 — 그림자 비교가 아무것도 재지 않는다`);
              }
              ran.push(`${engine} ${scheme} ${cells.length}칸`);
              // 눈으로 볼 판(400%): `AVATAR_STATUS_SHOTS=<폴더>` 일 때만.
              const shots = process.env.AVATAR_STATUS_SHOTS;
              if (shots) {
                const zoom = await browser.newContext({
                  viewport: { width: CELL * TONES.length, height: CELL * BACKDROPS.length * WEB_STATUS_BADGE_FACES.length },
                  deviceScaleFactor: 4,
                  colorScheme: scheme,
                });
                try {
                  const zp = await zoom.newPage();
                  await zp.setContent(html);
                  await zp.screenshot({ path: join(shots, `avatar-status-grid-${engine}-${scheme}-400.png`), fullPage: true });
                } finally {
                  await zoom.close();
                }
              }
            } finally {
              await ctx.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      console.log(`avatar status measured: ${ran.join(" · ")}`);
      expect(problems).toEqual([]);
      expect(ran.length).toBe(ENGINES.length * 2);
    },
    180_000
  );
});
