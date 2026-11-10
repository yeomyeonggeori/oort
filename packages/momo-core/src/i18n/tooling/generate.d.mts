import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';

export const COMPLETE_LOCALES: readonly ['en-US', 'ko-KR'];
export const DRAFT_LOCALES: readonly ['ja-JP', 'zh-Hans', 'zh-Hant', 'es-419', 'fr-FR'];

export function compileCatalogs(root?: string): {
  catalogs: Record<string, Record<string, MessageFormatElement[]>>;
  args: Record<string, Record<string, 'string' | 'number' | 'date'>>;
};
export function generate(options?: {
  catalogRoot?: string;
  outputRoot?: string;
  check?: boolean;
}): Record<string, string>;
