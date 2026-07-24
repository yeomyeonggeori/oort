import { IS_TAURI } from "@/lib/env";

/** Proves "one codebase, two runtimes": the same bundle reports web vs desktop. */
export function RuntimeBadge() {
  return (
    <span
      data-testid="runtime-badge"
      data-runtime={IS_TAURI ? "desktop" : "web"}
      className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-muted-foreground)]"
      title={IS_TAURI ? "Tauri WKWebView/WebView2" : "browser"}
    >
      {IS_TAURI ? "desktop (Tauri)" : "web"}
    </span>
  );
}
