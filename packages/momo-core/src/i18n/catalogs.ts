import type { CatalogLocale, MessageCatalog } from './types';

/** P0-3 awaits a language chunk before switching; Metro includes both chunks for P0-4 offline use. */
export async function loadMessageCatalog(locale: CatalogLocale): Promise<MessageCatalog> {
  switch (locale) {
    case 'ko-KR': return (await import('./generated/ko-KR')).catalog;
    case 'en-US': return (await import('./generated/en-US')).catalog;
    default: return (await import('./generated/en-US')).catalog;
  }
}
