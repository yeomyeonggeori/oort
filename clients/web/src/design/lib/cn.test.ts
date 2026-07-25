import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "@/design/ui/button";
import { cn } from "./cn";

/**
 * The typography roles in tokens.css are custom names, and tailwind-merge only
 * knows the stock scale. Left untaught it files `text-timestamp` under
 * text-COLOR and a later color class deletes it, with nothing thrown and no
 * build warning: the class is simply absent from the DOM and the element
 * renders one role too large.
 *
 * That is not a hypothetical. It shipped twice, independently: the sidebar
 * agent turn pill measured 14px beside an 11px unread count (MOMO-613 R2 H-1),
 * and the dialog title rendered at body size while every filled `size="sm"`
 * button lost its `--on-accent` label (MOMO-614 R2 H1/H2). These assertions are
 * the mechanical check both lessons turn into.
 */

const tokensCss = readFileSync(
  new URL("../tokens.css", import.meta.url),
  "utf8"
);

/** Every `--text-<role>: ...` in tokens.css. `[a-z]+` (no hyphen) is what keeps
 *  the `--text-<role>--line-height` twins out of the list. */
function declaredRoles(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/--text-([a-z]+):\s*[0-9.]+rem/gi)) {
    out.add(m[1]);
  }
  return [...out].sort();
}

describe("cn", () => {
  it("keeps a type role when a text color follows it", () => {
    expect(cn("shrink-0 rounded-sm px-1 text-timestamp", "bg-agent-soft text-agent"))
      .toBe("shrink-0 rounded-sm px-1 text-timestamp bg-agent-soft text-agent");
    expect(cn("text-meta", "text-ink-muted")).toBe("text-meta text-ink-muted");
  });

  it("keeps a type role when the color comes first", () => {
    expect(cn("text-warn", "text-timestamp")).toBe("text-warn text-timestamp");
  });

  it("still collapses two type roles to the last one", () => {
    expect(cn("text-body", "text-timestamp")).toBe("text-timestamp");
    expect(cn("text-timestamp", "text-meta")).toBe("text-meta");
  });

  it("still collapses two text colors to the last one", () => {
    expect(cn("text-agent", "text-ink-muted")).toBe("text-ink-muted");
  });

  it("still merges ordinary conflicts", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("rounded-sm", "rounded-md")).toBe("rounded-md");
  });

  it("knows every type role tokens.css declares", () => {
    // A role added to tokens.css but not to cn.ts would silently disappear the
    // first time someone put a color next to it, so the two lists are pinned
    // together rather than kept in sync by memory.
    for (const role of declaredRoles(tokensCss)) {
      expect(cn(`text-${role}`, "text-ink-muted"), role).toBe(
        `text-${role} text-ink-muted`
      );
    }
  });
});

describe("cn: role and color are different axes", () => {
  it("keeps both across separate arguments, which is how overrides arrive", () => {
    // DialogTitle's own class list, plus a caller recoloring it.
    expect(cn("text-title font-semibold text-ink", "text-ink-muted")).toBe(
      "text-title font-semibold text-ink-muted"
    );
  });

  it("lets a caller override the role and the color independently", () => {
    expect(cn("text-meta text-ink-muted", "text-body text-ink")).toBe(
      "text-body text-ink"
    );
    expect(cn("text-meta text-ink-muted", "text-ink")).toBe("text-meta text-ink");
  });
});

describe("Button keeps its label color at every size", () => {
  // R2 H2: the accent fill is unreadable if `text-meta` evicts `text-on-accent`.
  // Button renders `cn(buttonVariants(...))`, so the merge is what ships.
  it("filled sizes all carry text-on-accent", () => {
    for (const size of ["default", "sm", "lg", "icon"] as const) {
      expect(cn(buttonVariants({ variant: "default", size }))).toContain(
        "text-on-accent"
      );
    }
  });

  it("the small size is still 12px", () => {
    expect(cn(buttonVariants({ variant: "default", size: "sm" }))).toContain(
      "text-meta"
    );
  });

  it("destructive keeps text-on-danger at small size", () => {
    expect(cn(buttonVariants({ variant: "destructive", size: "sm" }))).toContain(
      "text-on-danger"
    );
  });
});
