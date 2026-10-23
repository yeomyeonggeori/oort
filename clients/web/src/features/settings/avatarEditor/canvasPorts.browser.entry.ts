import {
  composeAvatarPng,
  renderAvatarPng,
  sampleAvatarForeground,
  judgeAvatarDraft,
  type AvatarCompose,
  type AvatarDraft,
} from "@momo/core/features/workspace/avatarEditor";
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

(globalThis as unknown as { __avatarPorts: { compose: typeof compose; render: typeof render; judge: typeof judge } }).__avatarPorts = {
  compose,
  render,
  judge,
};
