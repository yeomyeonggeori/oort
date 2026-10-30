import { useRef } from "react";
import { localeAutonyms, type LocalePreference } from "@momo/core/i18n";
import { ListboxSelect } from "@/design/ui/listbox-select";
import { Button } from "@/design/ui/button";
import { useAppLocale, useLocaleSnapshot } from "@/i18n/localeContext";
import { availableLocales, type AppLocale } from "@/i18n/localeStore";
import { SettingsRow } from "./shell/SettingsRow";

function LanguageControl({ locale }: { locale: AppLocale }) {
  const snapshot = useLocaleSnapshot(locale);
  const retryHasFocus = useRef(false);
  const t = locale.service.formatMessage;
  const english = snapshot.context.messageLocale === "en-US";
  return (
    <SettingsRow
      label={t("settings.profile.languageLabel")}
      labelId="profile-language-label"
      description={t("settings.profile.languageHint")}
      descriptionId="profile-language-hint"
      testId="profile-language-row"
      stack
    >
      <div className="flex w-full min-w-0 flex-col gap-2" aria-busy={snapshot.status === "loading" || undefined}>
        <ListboxSelect<LocalePreference>
          id="profile-language"
          value={snapshot.preference}
          placeholder={t("settings.profile.languageSystem")}
          aria-labelledby="profile-language-label"
          aria-describedby="profile-language-hint profile-language-current"
          aria-busy={snapshot.status === "loading" || undefined}
          options={[
            { value: "system", label: t("settings.profile.languageSystem") },
            ...availableLocales.map(value => ({ value, label: localeAutonyms[value] })),
          ]}
          onValueChange={(value: LocalePreference) => { void locale.setPreference(value); }}
        />
        <div className={`h-1 w-full rounded-full bg-surface-muted ${snapshot.status === "loading" ? "" : "invisible"}`} aria-hidden="true" />
        <p id="profile-language-current" role="status" className="text-meta text-ink-muted">
          {t("settings.profile.languageCurrent", { languageName: localeAutonyms[english ? "en-US" : "ko-KR"] })}
        </p>
        {english ? (
          <p className="text-meta text-ink-muted" data-testid="language-partial-notice">
            <span className="font-semibold">{t("settings.profile.languageBeta")}</span>{" "}
            {t("settings.profile.languagePartialNotice")}
          </p>
        ) : null}
        {snapshot.hasError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-meta text-danger">
            <span>{t("settings.profile.languageLoadError")}</span>
            <Button
              variant="outline"
              size="sm"
              className="tap-target"
              aria-busy={snapshot.status === "loading" || undefined}
              onFocus={() => { retryHasFocus.current = true; }}
              onBlur={() => { retryHasFocus.current = false; }}
              onClick={() => {
                void locale.retry().then(() => {
                  if (retryHasFocus.current && locale.getSnapshot().status === "ready") {
                    document.getElementById("profile-language")?.focus();
                    retryHasFocus.current = false;
                  }
                });
              }}
            >
              {t("settings.profile.languageRetry")}
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}

export function LanguageRow() {
  const locale = useAppLocale();
  return locale ? <LanguageControl locale={locale} /> : null;
}
