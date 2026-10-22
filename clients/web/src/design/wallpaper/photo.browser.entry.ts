import { importPhoto } from "@momo/core/design/wallpaper";
import { canvasPhotoPorts } from "./photo";

// `photo.browser.test.ts`가 진짜 브라우저(Chromium·WebKit)에 올리는 번들의 입구다. 앱이 쓰는 그 포트(`canvasPhotoPorts`)와 그
// 계단(core `importPhoto`)을 그대로 부르고, 결과 바이트를 시험에 돌려준다. 앱 번들에는 들어가지 않는다(아무도 import하지 않는다).

export interface RunResult {
  ok: boolean;
  reason?: string;
  bytes?: number[];
  width?: number;
  height?: number;
  thumb?: number[] | null;
}

async function run(bytes: number[], type: string): Promise<RunResult> {
  const file = new File([new Uint8Array(bytes)], "fixture", { type });
  const outcome = await importPhoto(canvasPhotoPorts, file, file.size);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const photo = new Uint8Array(await outcome.photo.bytes.arrayBuffer());
  const thumb = outcome.photo.thumb ? new Uint8Array(await outcome.photo.thumb.bytes.arrayBuffer()) : null;
  return { ok: true, bytes: Array.from(photo), width: outcome.photo.width, height: outcome.photo.height, thumb: thumb ? Array.from(thumb) : null };
}

(globalThis as unknown as { __wallpaperPhoto: { run: typeof run } }).__wallpaperPhoto = { run };
