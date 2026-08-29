import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// =============================================================================
// shadcn/ui class-merge helper, taught the house typography scale.
//
// tokens.css clears Tailwind's stock text sizes (`--text-*: initial`) and
// replaces them with semantic ROLES: text-timestamp / text-meta / text-body /
// text-title / text-display (SKILL §3). tailwind-merge ships with the stock
// scale, so it does not recognise those names, falls back to its catch-all
// `text-<anything>` rule, and files them under text-COLOR. A later color in the
// same call then "wins" the conflict and the size class is dropped:
//
//   twMerge("px-1 text-timestamp", "bg-agent-soft text-agent")
//     -> "px-1 bg-agent-soft text-agent"        // 11px silently became 14px
//
// It fails silently in both directions (nothing throws, the class simply is not
// in the DOM), which is how the sidebar turn pill shipped at body size next to
// an 11px unread count. Registering the roles as font sizes makes the two
// groups distinct again: a role and a color coexist, two roles still collapse
// to the last one, which is what a size conflict should do.
// =============================================================================

/** The semantic type roles from tokens.css `@theme { --text-* }`. */
const TEXT_ROLES = ["timestamp", "meta", "body", "title", "display"] as const;

/**
 * The named measures from tokens.css `@theme { --spacing-* }` that are words,
 * not numbers: marker(2) · row(6) · control-sm/control/control-lg(28/32/40) ·
 * action-sm/action(96/144) · chat-min · rail 3종 · pane 5종 · settings-nav ·
 * diff-body · terminal-body · terminal-dock 3종 · terminal-floor ·
 * timeline-strip · preview-frame · tray-max · onboarding-mark ·
 * onboarding-copy.
 * `--spacing-px`만 뺀다 — `w-px`류는
 * stock Tailwind라 tailwind-merge가 이미 안다. 이 목록과 tokens.css의 일치는
 * cn.test.ts가 정본을 읽어 단정한다.
 *
 * Same failure class as the text roles above, caught on the sizing axis
 * (2026-08-23 재연 QA): stock tailwind-merge does not recognise `max-w-pane-md`,
 * so it cannot see that `max-w-none` conflicts with it. Both classes reach the
 * DOM and the STYLESHEET order picks the winner — which was `max-w-pane-md`,
 * so the image lightbox (#1686) that passes `max-w-none` to escape the dialog
 * width cap rendered as a 512px strip pinned to the viewport's left edge.
 * Registering the whole word-measure vocabulary in every sizing group makes
 * "later class wins" hold wherever a named measure can appear.
 */
export const NAMED_MEASURES = [
  "marker",
  "row",
  "control-sm",
  "control",
  "control-lg",
  "action-sm",
  "action",
  "chat-min",
  "rail",
  "rail-tile",
  "rail-marker",
  "pane-sm",
  "pane",
  "pane-md",
  "pane-lg",
  "pane-picker",
  "settings-nav",
  "diff-body",
  "terminal-body",
  "terminal-dock",
  "terminal-dock-lg",
  "terminal-dock-reserve",
  "terminal-floor",
  "timeline-strip",
  "preview-frame",
  "tray-max",
  "onboarding-mark",
  "onboarding-copy",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TEXT_ROLES] }],
      w: [{ w: [...NAMED_MEASURES] }],
      "min-w": [{ "min-w": [...NAMED_MEASURES] }],
      "max-w": [{ "max-w": [...NAMED_MEASURES] }],
      h: [{ h: [...NAMED_MEASURES] }],
      "min-h": [{ "min-h": [...NAMED_MEASURES] }],
      "max-h": [{ "max-h": [...NAMED_MEASURES] }],
    },
  },
});

/** shadcn/ui class-merge helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
