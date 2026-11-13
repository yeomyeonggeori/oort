import { IS_TAURI } from "@/lib/env";
// Static on purpose (#4915): a lazy chunk here would fail the same way the Korean one can,
// inside `change()` where nothing could ask for it again, and it is 638 bytes.
import { desktopMenuLabels } from "./desktopMenu";
import { browserLocalePort, createAppLocale } from "./localeStore";
import { observeLocaleEnvironment } from "./localeEnvironment";
import { PSEUDO_LOCALE_BUILD, loadPseudoCatalog, pseudoLocaleRequested } from "./pseudoLocale";

async function bootLocale() {
  const port = browserLocalePort();
  // 개발·design 빌드의 `?pseudo=1`만(#5589). 출시 빌드에서는 상수 false라 이 갈래와 의사 사전 청크가 사라진다.
  const pseudo = PSEUDO_LOCALE_BUILD && pseudoLocaleRequested(window.location.search, window.sessionStorage)
    ? { pseudo: loadPseudoCatalog } : {};
  if (IS_TAURI) {
    const native = await import("@/lib/tauri");
    // Native storage is authoritative; never migrate a browser origin's value into it.
    port.readPreference = native.readLocalePreference;
    port.writePreference = native.writeLocalePreference;
    return createAppLocale(port, {
      ...pseudo,
      syncMenu: async service => { await native.setLocaleMenu(desktopMenuLabels(service)); },
    });
  }
  return createAppLocale(port, pseudo);
}

// index.html starts this module in the head; main awaits it before mounting any screen.
export const appLocaleReady = bootLocale();

void appLocaleReady.then(observeLocaleEnvironment);
