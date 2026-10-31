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
  label: string;
}> = [
  { tone: 0, glyph: "\u270B", label: "기본 피부" },
  { tone: 1, glyph: "\u270B\u{1F3FB}", label: "밝은 피부" },
  { tone: 2, glyph: "\u270B\u{1F3FC}", label: "중간 밝은 피부" },
  { tone: 3, glyph: "\u270B\u{1F3FD}", label: "중간 피부" },
  { tone: 4, glyph: "\u270B\u{1F3FE}", label: "중간 어두운 피부" },
  { tone: 5, glyph: "\u270B\u{1F3FF}", label: "어두운 피부" },
];
