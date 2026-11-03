// 게이트 공용: 앵커 착지 행에 붙는 클래스 이름을 제품 소스에서 읽는다.
//
// 정본은 `src/features/inbox/anchor.ts`의 `HIGHLIGHT_CLASS`다. 게이트가 그 이름을 손수 적으면 값이 두 벌이 되고,
// 제품이 이름을 바꿀 때(#4324 2단계: `bg-accent-soft` → `landed-surface`) 게이트는 따라가지 못해 착지는 멀쩡한데
// 낡은 이름을 찾으며 빨개진다(gate:composer 8b, gate:quote, gate:pin이 각각 그렇게 base에서 빨갰다, #5048).
// 그래서 읽는다 — 읽지 못하면 조용히 낡은 값으로 가지 않고 요란하게 죽는다.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @param {string} webRoot `clients/web` 절대경로
 * @returns {string}
 */
export function landingClass(webRoot) {
  const source = readFileSync(
    resolve(webRoot, "src/features/inbox/anchor.ts"),
    "utf8"
  );
  const match = source.match(/const HIGHLIGHT_CLASS = "([^"]+)";/);
  if (match === null) {
    throw new Error("inbox/anchor.ts 의 HIGHLIGHT_CLASS 를 읽지 못했다");
  }
  return match[1];
}
