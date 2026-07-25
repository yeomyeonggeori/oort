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

const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...TEXT_ROLES] }] } },
});

/** shadcn/ui class-merge helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
