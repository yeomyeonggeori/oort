import { useEffect, useState } from "react";

/**
 * Only the browser's half of the answer (`navigator.onLine`).
 *
 * A leaf file so both `useOffline` (the write gate) and the connection model's provider can read the
 * browser without importing each other. Everything that only needs the browser's own word (the
 * routes that mount above the shell, the emoji picker's chunk-load check) calls `useBrowserOffline`
 * and sees no change; it is re-exported from `useOffline.ts`, where the other 38 files import it.
 *
 * The browser's offline is immediate and certain (the machine itself says it has no network), which
 * is why the connection model takes it as a fact with no waiting (`deviceOnline`).
 */
export function readBrowserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function useBrowserOffline(): boolean {
  const [browserOffline, setBrowserOffline] = useState(() => !readBrowserOnline());
  useEffect(() => {
    const online = () => setBrowserOffline(false);
    const offline = () => setBrowserOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);
  return browserOffline;
}
