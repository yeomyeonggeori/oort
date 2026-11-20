import type { PlainMessageKey } from "@momo/core/i18n";

/** 마이크 메뉴가 읽는 사전 키(`catalogs/<언어>/huddles.json`의 `huddles.mic.*`). 시험도 이 표로 문장을 찾는다. */
export const HUDDLE_MIC_KEYS = {
  picker: "huddles.mic.picker",
  menu: "huddles.mic.menu",
  systemDefault: "huddles.mic.systemDefault",
  gain: "huddles.mic.gain",
  permissionPrompt: "huddles.mic.permissionPrompt",
  permissionDenied: "huddles.mic.permissionDenied",
  empty: "huddles.mic.empty",
} as const satisfies Record<string, PlainMessageKey>;
