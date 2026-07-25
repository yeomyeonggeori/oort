import { useEffect, useState } from "react";
import { IS_TAURI } from "@/lib/env";
import { appVersion } from "@/lib/tauri";

/**
 * Proves "one codebase, two runtimes": the same bundle reports web vs desktop.
 *
 * In the shell it also names the build (MOMO-606). This is the screen someone is
 * looking at when a connection fails, which is exactly when "which version are
 * you on" gets asked, and it is the one moment the answer is not reachable from
 * 설정 (that lives behind the login).
 */
export function RuntimeBadge() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void appVersion().then((value) => {
      if (alive) setVersion(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  const label = IS_TAURI ? (version ? `desktop ${version}` : "desktop") : "web";

  return (
    <span
      data-testid="runtime-badge"
      data-runtime={IS_TAURI ? "desktop" : "web"}
      className="rounded-sm border border-line px-2 py-1 text-timestamp font-medium text-ink-muted"
      title={
        IS_TAURI
          ? "momo 데스크톱 앱(Tauri 셸)에서 실행 중"
          : "브라우저 탭에서 실행 중"
      }
    >
      {label}
    </span>
  );
}
