import type { LocaleService } from "@momo/core/i18n";

/** The only menu copy source is the shared catalog; Rust receives plain text. */
export function desktopMenuLabels(locale: LocaleService) {
  const t = locale.formatMessage;
  return {
    file: t("desktop.menu.file"), edit: t("desktop.menu.edit"),
    view: t("desktop.menu.view"), window: t("desktop.menu.window"), help: t("desktop.menu.help"),
    undo: t("desktop.menu.undo"), redo: t("desktop.menu.redo"),
    cut: t("desktop.menu.cut"), copy: t("desktop.menu.copy"), paste: t("desktop.menu.paste"),
    selectAll: t("desktop.menu.selectAll"), minimize: t("desktop.menu.minimize"),
    maximize: t("desktop.menu.maximize"), close: t("desktop.menu.close"),
    fullscreen: t("desktop.menu.fullscreen"), hide: t("desktop.menu.hide"),
    hideOthers: t("desktop.menu.hideOthers"), quit: t("desktop.menu.quit"),
  };
}
