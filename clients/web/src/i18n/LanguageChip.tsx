import { useId, useState } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { languageChoices, localeAutonyms, type LocalePreference } from "@momo/core/i18n";
import { Button } from "@/design/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { useAppLocale, useLocaleSnapshot } from "./localeContext";
import { availableLocales, type AppLocale } from "./localeStore";

// Reading this as: onboarding for internal team users on web+Tauri,
// density 5/10, motion 2/10.

// 로그인 전 첫 화면 머리 줄 오른쪽의 작은 언어 칩 (#4670). 칩 → 언어 목록 → 즉시 반영이고,
// **설정 › 프로필의 언어 행(`LanguageRow`)과 같은 값**이다: 같은 앱 언어 객체의 같은
// `setPreference`를 부르고(그래서 같은 저장소 `oort.locale.preference`, 같은 사전 불러오기,
// 같은 HTML `lang`), 같은 선택지(코어 `languageChoices`에 `availableLocales`)를 보인다.
// 나중에 언어가 늘면 `availableLocales`만 늘리면 설정 행과 이 칩이 함께 늘어난다.
//
// 목록은 메뉴(`DropdownMenu`의 라디오 묶음)다. 고른 뒤 사전이 들어오고 저장이 끝나면 닫히고,
// 실패하면 열린 채로 그 자리에서 이유와 다시 시도를 말한다(`LanguageRow`의 오류 행과 같은 말).

export function LanguageChip() {
  const locale = useAppLocale();
  // 앱 언어가 없는 독립 fixture에서는 머리 줄 세 칸을 지키는 빈 칸을 둔다.
  return locale ? <LanguageChipControl locale={locale} /> : <span aria-hidden="true" />;
}

function LanguageChipControl({ locale }: { locale: AppLocale }) {
  const snapshot = useLocaleSnapshot(locale);
  const [open, setOpen] = useState(false);
  // 이 칩이 보낸 선택이 끝나기를 기다리는 동안.
  const [pending, setPending] = useState(false);
  const labelId = useId();
  const messages = locale.service;
  const english = snapshot.context.messageLocale === "en-US";
  const shown = localeAutonyms[english ? "en-US" : "ko-KR"];

  async function settle(work: Promise<unknown>) {
    setPending(true);
    try {
      await work;
    } finally {
      setPending(false);
    }
    // 사전과 저장이 끝났으면 닫는다. 실패하면 아래 오류가 읽히도록 열어 둔다.
    if (!locale.getSnapshot().hasError) setOpen(false);
  }

  function choose(value: LocalePreference) {
    if (value === snapshot.preference) {
      setOpen(false);
      return;
    }
    void settle(locale.setPreference(value));
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="language-chip"
          aria-label={messages.formatMessage("settings.profile.languageCurrent", { languageName: shown })}
          aria-busy={pending || undefined}
          // 머리 줄은 창을 끄는 자리다. 칩의 눌림이 창 끌기로 새지 않게 뒤로 버튼과 같이 멈춘다.
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Globe aria-hidden="true" />
          <span data-testid="language-chip-name">{shown}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="language-chip-menu">
        <DropdownMenuLabel id={labelId}>{messages.formatMessage("settings.profile.languageLabel")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={snapshot.preference} aria-labelledby={labelId}>
          {languageChoices(availableLocales).map((choice) => (
            <DropdownMenuRadioItem
              key={choice.preference}
              value={choice.preference}
              // 자칭 표기는 번역하지 않고 자기 언어로 읽힌다(ADR-0213 §5).
              lang={choice.system ? undefined : choice.preference}
              disabled={pending}
              data-testid="language-chip-option"
              data-value={choice.preference}
              onSelect={(event) => {
                event.preventDefault();
                choose(choice.preference);
              }}
            >
              <span className="flex-1">
                {choice.system
                  ? messages.formatMessage("settings.profile.languageSystem")
                  : choice.autonym}
              </span>
              {snapshot.preference === choice.preference ? (
                <Check className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {english ? (
          <p className="px-2 py-1 text-meta text-ink-muted" data-testid="language-chip-partial-notice">
            {messages.formatMessage("settings.profile.languagePartialNotice")}
          </p>
        ) : null}
        {snapshot.hasError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 px-2 py-1 text-meta text-danger"
            data-testid="language-chip-error"
          >
            <span>{messages.formatMessage("settings.profile.languageLoadError")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="tap-target"
              aria-busy={pending || undefined}
              data-testid="language-chip-retry"
              onClick={() => void settle(locale.retry())}
            >
              {/* 거절된 사전 청크는 새 문서만 다시 부를 수 있다(#4915): 단추가 하는 일을 그대로 말한다. */}
              {snapshot.needsReload
                ? messages.formatMessage("settings.profile.languageReload")
                : messages.formatMessage("settings.profile.languageRetry")}
            </Button>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
