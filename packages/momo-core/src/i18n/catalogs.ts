import type { CatalogLocale, MessageCatalog } from './types';

/**
 * Every ADR-0213 language has its own chunk. ko/en are complete; the other five are drafts whose
 * missing keys show English (the service's fallback), and none of them is a visible choice until
 * P2's native review (#5589). Metro includes all chunks for P0-4 offline use.
 */
export async function loadMessageCatalog(locale: CatalogLocale): Promise<MessageCatalog> {
  switch (locale) {
    case 'ko-KR': return (await import('./generated/ko-KR')).catalog;
    case 'en-US': return (await import('./generated/en-US')).catalog;
    case 'ja-JP': return (await import('./generated/ja-JP')).catalog;
    case 'zh-Hans': return (await import('./generated/zh-Hans')).catalog;
    case 'zh-Hant': return (await import('./generated/zh-Hant')).catalog;
    case 'es-419': return (await import('./generated/es-419')).catalog;
    case 'fr-FR': return (await import('./generated/fr-FR')).catalog;
    default: return (await import('./generated/en-US')).catalog;
  }
}
