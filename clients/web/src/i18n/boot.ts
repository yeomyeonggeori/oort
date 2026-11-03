import { IS_TAURI } from "@/lib/env";
// Static on purpose (#4915): a lazy chunk here would fail the same way the Korean one can,
// inside `change()` where nothing could ask for it again, and it is 638 bytes.
import { desktopMenuLabels } from "./desktopMenu";
import { browserLocalePort, createAppLocale } from "./localeStore";
import { observeLocaleEnvironment } from "./localeEnvironment";

async function bootLocale() {
  const port = browserLocalePort();
  if (IS_TAURI) {
    const native = await import("@/lib/tauri");
    // Native storage is authoritative; never migrate a browser origin's value into it.
    port.readPreference = native.readLocalePreference;
    port.writePreference = native.writeLocalePreference;
    return createAppLocale(port, {
      syncMenu: async service => { await native.setLocaleMenu(desktopMenuLabels(service)); },
    });
  }
  return createAppLocale(port);
}

// index.html starts this module in the head; main awaits it before mounting any screen.
export const appLocaleReady = bootLocale();

void appLocaleReady.then(observeLocaleEnvironment);
