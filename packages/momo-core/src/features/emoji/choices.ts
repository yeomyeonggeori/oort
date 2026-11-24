import type { PlainMessageKey } from "../../i18n/keys";
import type { SkinTone } from "./catalog";

/** Shared empty-history seed; selection counts take precedence over this order. */
export const PICKER_EMOJI = [
  "👍",
  "👎",
  "✅",
  "❌",
  "🙏",
  "🎉",
  "👀",
  "😄",
  "😂",
  "😅",
  "🤔",
  "😮",
  "😭",
  "🔥",
  "💯",
  "✨",
  "🚀",
  "🐛",
  "🛠️",
  "📌",
  "📝",
  "🔍",
  "⏳",
  "⚠️",
  "❤️",
  "💡",
  "🙌",
  "👏",
  "☕",
  "🍀",
  "🥲",
  "🫡",
] as const;

export const EMOJI_SKIN_OPTIONS: ReadonlyArray<{
  tone: SkinTone;
  glyph: string;
  labelKey: PlainMessageKey;
}> = [
  { tone: 0, glyph: "\u270B", labelKey: "emoji.tone.default" },
  { tone: 1, glyph: "\u270B\u{1F3FB}", labelKey: "emoji.tone.light" },
  { tone: 2, glyph: "\u270B\u{1F3FC}", labelKey: "emoji.tone.mediumLight" },
  { tone: 3, glyph: "\u270B\u{1F3FD}", labelKey: "emoji.tone.medium" },
  { tone: 4, glyph: "\u270B\u{1F3FE}", labelKey: "emoji.tone.mediumDark" },
  { tone: 5, glyph: "\u270B\u{1F3FF}", labelKey: "emoji.tone.dark" },
];
