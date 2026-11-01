import {localeAutonyms} from '@momo/core/i18n/autonyms';
import React, {useState} from 'react';
import {PageSheet, usePageSheetClose} from '../design/PageSheet';
import {SheetHeader} from '../design/SheetChrome';
import {SheetScroll} from '../design/sheetParts';
import {OnboardingGhostButton} from '../features/onboarding/OnboardingControls';
import {LanguageChoices} from './LanguageSettings';
import {useMobileLocale} from './LocaleProvider';

// =============================================================================
// 로그인 전 첫 화면(M0 환영·M-b/M-a 폼)의 작은 언어 칩 (#4670). 칩 → 언어 시트 → 즉시 반영이고, 고른 값은 **설정 ›
// 프로필 › 언어와 같다**: 시트가 설정 페이지와 같은 부품(`LanguageChoices`)을 쓰므로 같은 컨트롤러의 같은
// `setPreference`, 같은 MMKV 칸(`oort.mobile.locale.v1`), 같은 목록(코어 `languageChoices`)이다.
//
// 칩은 막대 왼쪽의 「뒤로」와 같은 말씨의 가벼운 단추다(`OnboardingGhostButton`): 지금 쓰는 말의 자칭 표기(「한국어」·
// 「English」) 하나. 번역하지 않고 자기 언어로 읽히며, 새 아이콘도 새 모양도 만들지 않았다. 앱의 언어 서비스가 없는
// 격리 하네스에서는 그리지 않는다(제품 앱은 늘 provider 안이다).
// =============================================================================

export function LanguageChip(): React.JSX.Element | null {
  const current = useMobileLocale();
  const [open, setOpen] = useState(false);
  if (!current) return null;
  const {locale, effectiveLocale} = current;
  const name = localeAutonyms[effectiveLocale];
  return (
    <>
      <OnboardingGhostButton
        label={name}
        accessibilityLabel={locale.formatMessage('settings.profile.languageCurrent', {languageName: name})}
        accessibilityHint={locale.formatMessage('connect.language.hint')}
        onPress={() => setOpen(true)}
        testID="language-chip"
      />
      {open ? <LanguageSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function LanguageSheet({onClose}: {onClose: () => void}): React.JSX.Element | null {
  const current = useMobileLocale();
  if (!current) return null;
  const {locale} = current;
  const label = locale.formatMessage('settings.profile.languageLabel');
  const closeLabel = locale.formatMessage('connect.language.close');
  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel={label}
      scrimLabel={closeLabel}
      scrimTestID="language-sheet-scrim"
      testID="language-sheet">
      <SheetHeader title={label} closeLabel={closeLabel} closeTestID="language-sheet-close" />
      <SheetScroll testID="language-sheet-scroll">
        <SheetChoices />
      </SheetScroll>
    </PageSheet>
  );
}

/** 저장이 **성공하면** 시트가 미끄러져 내려간다. 실패하면 설정 페이지와 같이 이유와 다시 시도를 시트 안에서 말한다. */
function SheetChoices(): React.JSX.Element {
  const close = usePageSheetClose();
  return <LanguageChoices onChosen={close ?? undefined} />;
}
