// =============================================================================
// 실제 렌더 픽셀 위에서 글자·아이콘의 대비를 잰다 (AP-4 #4191).
//
// 계산(core `scrim.ts`)이 「어떤 그림이어도 읽힌다」를 말해도, 그 값이 **화면에 실제로 칠해지는지**는 따로 재야 한다.
// 이 도구는 영역 안의 글자·아이콘 요소를 모으고, 각 요소가 **실제로 서 있는 바탕**을 스크린샷에서 읽어, 그 요소의
// 계산된 색과 WCAG 대비를 낸다.
//
// ## 바탕을 어떻게 읽는가 (한 번 잘못 읽은 적이 있다)
//
// 처음에는 요소 상자 안에서 가장 흔한 색을 바탕으로 읽었다(「획은 얇아서 바탕이 다수다」). 그 가정이 촘촘한 아이콘에서
// 깨진다: 설정 목록의 「워크스페이스」 아이콘(건물, 창문 격자)은 상자의 큰 몫이 획이고, 바탕은 그라디언트 디더링으로 서너 칸의
// 색으로 쪼개져서, 획 자신의 색이 최빈값이 됐다(바탕 = 아이콘 색, 대비 1.04). 눈으로 보면 읽히는 아이콘이다 — 측정이 틀렸다.
// 그래서 **글자·아이콘만 투명하게 만든 같은 장면**을 한 번 더 찍어서 각 상자의 바탕을 읽는다. 획이 없으니 바탕은 추정이
// 아니라 직접 읽은 값이고, 획의 모양·밀도에 속지 않는다. 투명하게 되었는지는 계산된 색으로 확인하고(안 되었으면 던진다),
// 사람이 보는 「글자가 있는 쪽」 스크린샷은 따로 돌려준다.
// =============================================================================

const channelOf = (rgb) => {
  const v = rgb / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const luminance = ([r, g, b]) => 0.2126 * channelOf(r) + 0.7152 * channelOf(g) + 0.0722 * channelOf(b);
export const contrastOf = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
export const parseRgb = (text) => (text.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

/** 모은 요소에 붙이는 표지. 바탕을 읽는 동안 이 요소들의 색만 투명하게 한다. */
const FOREGROUND_TAG = "data-legibility-fg";
const HIDE_FOREGROUND_CSS = `
  [${FOREGROUND_TAG}] { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }
  [${FOREGROUND_TAG}] * { stroke: transparent !important; fill: transparent !important; }
`;

/**
 * 영역 안의 보이는 글자·아이콘 요소. 투명한 것(불투명도 < 0.99)은 뺀다: 계산된 색에 불투명도가 들어 있지 않다.
 * @param {import("playwright").Page} page
 * @param {string} regionSelector
 */
export async function collectForegrounds(page, regionSelector) {
  return page.evaluate(([selector, TAG]) => {
    const found = [];
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const cs = getComputedStyle(node);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.99) return false;
      }
      return true;
    };
    for (const region of document.querySelectorAll(selector)) {
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const el = node.parentElement;
        if (!el || seen.has(el) || !visible(el)) continue;
        seen.add(el);
        el.setAttribute(TAG, "");
        const r = el.getBoundingClientRect();
        found.push({ kind: "text", label: node.textContent.trim().slice(0, 24), color: getComputedStyle(el).color, rect: [r.x, r.y, r.width, r.height] });
      }
      for (const svg of region.querySelectorAll("svg")) {
        if (!visible(svg)) continue;
        svg.setAttribute(TAG, "");
        const r = svg.getBoundingClientRect();
        found.push({ kind: "icon", label: svg.getAttribute("class")?.split(" ").find((c) => c.startsWith("lucide-")) || "svg", color: getComputedStyle(svg).color, rect: [r.x, r.y, r.width, r.height] });
      }
    }
    return { items: found, viewportWidth: window.innerWidth };
  }, [regionSelector, FOREGROUND_TAG]);
}

/**
 * PNG에서 각 사각형의 가장 흔한 색(채널을 2비트 양자화해 센다). 글자가 없는 장면에서 읽으므로 최빈값이 바탕이다. `helper`는 아무 빈 페이지다.
 * @param {import("playwright").Page} helper
 * @param {Buffer} png
 * @param {number[][]} rects CSS 픽셀 기준 [x, y, w, h]
 * @param {number} viewportWidth
 */
export async function dominantColors(helper, png, rects, viewportWidth) {
  return helper.evaluate(
    async ([b64, boxes, width]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const factor = bitmap.width / width;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext("2d", { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0);
      return boxes.map(([x, y, w, h]) => {
        const sx = Math.max(0, Math.floor(x * factor));
        const sy = Math.max(0, Math.floor(y * factor));
        const sw = Math.max(1, Math.min(bitmap.width - sx, Math.ceil(w * factor)));
        const sh = Math.max(1, Math.min(bitmap.height - sy, Math.ceil(h * factor)));
        const data = g.getImageData(sx, sy, sw, sh).data;
        const counts = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const key = ((data[i] >> 2) << 16) | ((data[i + 1] >> 2) << 8) | (data[i + 2] >> 2);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        let best = 0;
        let bestKey = 0;
        for (const [key, count] of counts) if (count > best) { best = count; bestKey = key; }
        return [((bestKey >> 16) & 255) << 2, ((bestKey >> 8) & 255) << 2, (bestKey & 255) << 2];
      });
    },
    [png.toString("base64"), rects, viewportWidth]
  );
}

/**
 * 모은 글자·아이콘만 투명하게 한 같은 장면을 찍는다(바탕 읽기용). 표지와 임시 스타일은 끝나면 걷는다.
 * @param {import("playwright").Page} page
 */
async function screenshotWithoutForegrounds(page, options) {
  await page.evaluate((css) => {
    const style = document.createElement("style");
    style.setAttribute("data-legibility-hide", "");
    style.textContent = css;
    document.head.appendChild(style);
  }, HIDE_FOREGROUND_CSS);
  try {
    // 색 전환이 있는 요소가 끝까지 투명해지도록 두 프레임을 기다린다(스크린샷도 전환을 끝으로 보낸다).
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const hidden = await page.evaluate((tag) => {
      const els = [...document.querySelectorAll(`[${tag}]`)];
      return { total: els.length, opaque: els.filter((el) => getComputedStyle(el).color !== "rgba(0, 0, 0, 0)").length };
    }, FOREGROUND_TAG);
    // 투명하게 되지 않았다면 바탕이 아니라 글자를 읽게 된다. 조용히 틀리지 말고 던진다.
    if (hidden.opaque > 0) throw new Error(`legibility: ${hidden.opaque}/${hidden.total} foreground elements stayed opaque while reading the backdrop`);
    return await page.screenshot({ ...options, animations: "disabled", caret: "hide" });
  } finally {
    await page.evaluate((tag) => {
      document.querySelectorAll("style[data-legibility-hide]").forEach((el) => el.remove());
      document.querySelectorAll(`[${tag}]`).forEach((el) => el.removeAttribute(tag));
    }, FOREGROUND_TAG);
  }
}

/**
 * 영역의 글자(4.5:1)·아이콘(3:1)을 스크린샷 위에서 잰다. `png`는 사람이 보는 장면(글자가 있다)이고, 바탕은 글자를
 * 투명하게 한 같은 장면에서 읽는다.
 * @returns {Promise<{ png: Buffer; measured: { kind: string; label: string; color: string; bg: number[]; ratio: number; min: number }[] }>}
 */
export async function measureLegibility(page, helper, regionSelector, { textMin = 4.5, iconMin = 3, screenshot } = {}) {
  const { items, viewportWidth } = await collectForegrounds(page, regionSelector);
  const png = screenshot ?? (await page.screenshot({ animations: "disabled", caret: "hide" }));
  const backdrop = items.length === 0 ? null : await screenshotWithoutForegrounds(page, {});
  const colors = backdrop === null ? [] : await dominantColors(helper, backdrop, items.map((item) => item.rect), viewportWidth);
  const measured = items.map((item, index) => ({
    kind: item.kind,
    label: item.label,
    color: item.color,
    bg: colors[index],
    ratio: contrastOf(parseRgb(item.color), colors[index]),
    min: item.kind === "icon" ? iconMin : textMin,
  }));
  return { png, measured };
}
