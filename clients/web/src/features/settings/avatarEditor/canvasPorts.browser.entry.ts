import {
  AVATAR_PNG_SIZE,
  AVATAR_PRESET_CROP,
  composeAvatarPng,
  renderAvatarPng,
  sampleAvatarForeground,
  judgeAvatarDraft,
  type AvatarCompose,
  type AvatarDraft,
  type AvatarPresetId,
} from "@momo/core/features/workspace/avatarEditor";
import { KOMETTO_EXPRESSION_ASSETS } from "@/features/onboarding/guide/komettoExpressions";
import { canvasAvatarPorts } from "./canvasPorts";

// `canvasPorts.browser.test.ts` 가 진짜 브라우저(Chromium·WebKit)에 올리는 번들의 입구다. 앱이 쓰는 그 포트와 그
// 모델(core `composeAvatarPng`)을 그대로 부르고 결과를 시험에 돌려준다. 앱 번들에는 들어가지 않는다.

export interface ComposeResult {
  ok: boolean;
  reason?: string;
  bytes?: number[];
  share?: number;
}

async function compose(draft: AvatarDraft): Promise<ComposeResult> {
  const outcome: AvatarCompose = await composeAvatarPng(canvasAvatarPorts, draft);
  return outcome.ok
    ? { ok: true, bytes: Array.from(outcome.png), share: outcome.share }
    : { ok: false, reason: outcome.reason };
}

/** 판정 없는 미리보기 길(묻히는 조합도 굽는다). */
async function render(draft: AvatarDraft): Promise<ComposeResult> {
  const outcome = await renderAvatarPng(canvasAvatarPorts, draft);
  return outcome.ok ? { ok: true, bytes: Array.from(outcome.png) } : { ok: false, reason: outcome.reason };
}

/** 표본의 판정만(글리프를 그리고 읽고 잰다). */
async function judge(draft: AvatarDraft): Promise<{ ok: boolean; reason?: string; share: number }> {
  const sample = await sampleAvatarForeground(canvasAvatarPorts, draft);
  if (!sample.ok) return { ok: false, reason: sample.reason, share: 0 };
  const verdict = judgeAvatarDraft(draft, sample.pixels);
  return verdict.ok ? { ok: true, share: verdict.share } : { ok: false, reason: verdict.reason, share: verdict.share };
}

/**
 * 코메토의 **기준 그림과의 차이**: 정본 컷을 `AVATAR_PRESET_CROP` 으로 자르고 단색 바탕 위에 한 번 그린 것이 기준이다(포트를 거치지
 * 않는다). 포트가 구운 PNG 를 디코드해 기준과 **픽셀 단위로 대조하고 다른 채널 값의 개수만** 돌려준다(백만 개의 값을 시험으로 옮기지
 * 않으려고 대조를 페이지 안에서 한다). 0 이면 자르기와 배경색 조합 말고는 아무것도 얹지 않았다(새 그림·외곽선·그림자 금지).
 */
async function differencesFromPlainCrop(bytes: number[], input: { preset: AvatarPresetId; bg: string }): Promise<number> {
  const image = new Image();
  image.src = KOMETTO_EXPRESSION_ASSETS[input.preset];
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PNG_SIZE;
  canvas.height = AVATAR_PNG_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = input.bg;
  context.fillRect(0, 0, AVATAR_PNG_SIZE, AVATAR_PNG_SIZE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  context.drawImage(
    image,
    AVATAR_PRESET_CROP.x * side,
    AVATAR_PRESET_CROP.y * side,
    AVATAR_PRESET_CROP.size * side,
    AVATAR_PRESET_CROP.size * side,
    0,
    0,
    AVATAR_PNG_SIZE,
    AVATAR_PNG_SIZE
  );
  const expected = context.getImageData(0, 0, AVATAR_PNG_SIZE, AVATAR_PNG_SIZE).data;

  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
  const probe = document.createElement("canvas");
  probe.width = bitmap.width;
  probe.height = bitmap.height;
  const probeContext = probe.getContext("2d", { willReadFrequently: true })!;
  probeContext.drawImage(bitmap, 0, 0);
  const actual = probeContext.getImageData(0, 0, bitmap.width, bitmap.height).data;
  if (actual.length !== expected.length) return Number.MAX_SAFE_INTEGER;
  let different = 0;
  for (let i = 0; i < actual.length; i += 1) if (actual[i] !== expected[i]) different += 1;
  return different;
}

(globalThis as unknown as { __avatarPorts: { compose: typeof compose; render: typeof render; judge: typeof judge; differencesFromPlainCrop: typeof differencesFromPlainCrop } }).__avatarPorts = {
  compose,
  render,
  judge,
  differencesFromPlainCrop,
};
