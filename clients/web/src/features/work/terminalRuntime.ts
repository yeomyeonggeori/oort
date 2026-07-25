// =============================================================================
// The xterm.js runtime, isolated behind one module so it can be code split.
//
// Two reasons this is not a plain import in the component:
//
//   - WEIGHT. xterm plus its stylesheet is the largest dependency in this
//     client, and almost nobody opens a session detail in order to watch a
//     terminal. Loaded on the first 관전 시작 instead of in the shell bundle, it
//     costs nothing to every other surface.
//   - CSS. Vite ties a stylesheet to the chunk that imports it, so putting the
//     `import "...xterm.css"` HERE makes the terminal's styles arrive with the
//     terminal, as a served same-origin stylesheet (`style-src 'self'`) rather
//     than anything injected at runtime by this client.
//
// The library itself is vendored through npm and bundled locally: no CDN, no
// remote font, nothing the CSP or an offline Tauri shell would refuse
// (design-taste-web §1).
//
// What xterm DOES inject at runtime is measured and documented in
// ObserverTerminal.tsx: its DOM renderer writes a <style> element and one
// `setAttribute("style", ...)` per truecolor cell, which needs
// `style-src 'unsafe-inline'`. The production CSP already carries it
// (infra/prod/Caddyfile), so no relaxation is required for this ticket; the
// directive that DOES need attention is connect-src, and that note lives with
// the socket code.
// =============================================================================

import "@xterm/xterm/css/xterm.css";

export { Terminal } from "@xterm/xterm";
export { FitAddon } from "@xterm/addon-fit";
export type { ITheme } from "@xterm/xterm";
