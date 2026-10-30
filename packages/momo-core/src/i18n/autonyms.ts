import type { SupportedLocale } from './locale';

/** 자칭 표기 — 언어를 모르는 사람도 되돌릴 수 있게 번역하지 않아요(ADR-0213 §5). */
export const localeAutonyms: Readonly<Record<SupportedLocale, string>> = {
  'ko-KR': '한국어',
  'en-US': 'English',
  'ja-JP': '日本語',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  'es-419': 'Español (Latinoamérica)',
  'fr-FR': 'Français',
};
