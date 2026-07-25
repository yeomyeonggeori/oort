import { IS_TAURI } from "@/lib/env";

/** Proves "one codebase, two runtimes": the same bundle reports web vs desktop. */
export function RuntimeBadge() {
  return (
    <span
      data-testid="runtime-badge"
      data-runtime={IS_TAURI ? "desktop" : "web"}
      className="rounded-sm border border-line px-2 py-1 text-timestamp font-medium text-ink-muted"
      title={IS_TAURI ? "Tauri WKWebView/WebView2" : "browser"}
    >
      {IS_TAURI ? "desktop (Tauri)" : "web"}
    </span>
  );
}
