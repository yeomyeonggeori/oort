// =============================================================================
// 실제 렌더 픽셀 위에서 글자·아이콘의 대비를 잰다 (AP-4 #4191).
//
// 계산(core `scrim.ts`)이 「어떤 그림이어도 읽힌다」를 말해도, 그 값이 **화면에 실제로 칠해지는지**는 따로 재야 한다.
// 이 도구는 영역 안의 글자·아이콘 요소를 모으고, 스크린샷에서 각 요소 상자의 **가장 흔한 색**(글자 획은 얇아서 바탕이
// 다수다)을 읽어 그 요소의 계산된 색과 WCAG 대비를 낸다. 캡처 스크립트(`capture-4191.mjs`)와 CI 시험
// (`wallpaper.render.browser.test.ts`)이 같은 도구를 쓴다.
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

/**
 * 영역 안의 보이는 글자·아이콘 요소. 투명한 것(불투명도 < 0.99)은 뺀다: 계산된 색에 불투명도가 들어 있지 않다.
 * @param {import("playwright").Page} page
 * @param {string} regionSelector
 */
export async function collectForegrounds(page, regionSelector) {
  return page.evaluate((selector) => {
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
        const r = el.getBoundingClientRect();
        found.push({ kind: "text", label: node.textContent.trim().slice(0, 24), color: getComputedStyle(el).color, rect: [r.x, r.y, r.width, r.height] });
      }
      for (const svg of region.querySelectorAll("svg")) {
        if (!visible(svg)) continue;
        const r = svg.getBoundingClientRect();
        found.push({ kind: "icon", label: svg.getAttribute("class")?.split(" ").find((c) => c.startsWith("lucide-")) || "svg", color: getComputedStyle(svg).color, rect: [r.x, r.y, r.width, r.height] });
      }
    }
    return { items: found, viewportWidth: window.innerWidth };
  }, regionSelector);
}

/**
 * PNG에서 각 사각형의 가장 흔한 색(채널을 2비트 양자화해 센다). `helper`는 아무 빈 페이지다.
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
 * 영역의 글자(4.5:1)·아이콘(3:1)을 스크린샷 위에서 잰다.
 * @returns {Promise<{ png: Buffer; measured: { kind: string; label: string; color: string; bg: number[]; ratio: number; min: number }[] }>}
 */
export async function measureLegibility(page, helper, regionSelector, { textMin = 4.5, iconMin = 3, screenshot } = {}) {
  const { items, viewportWidth } = await collectForegrounds(page, regionSelector);
  const png = screenshot ?? (await page.screenshot({ animations: "disabled", caret: "hide" }));
  const colors = items.length === 0 ? [] : await dominantColors(helper, png, items.map((item) => item.rect), viewportWidth);
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
