import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';

export function compileCatalogs(root?: string): {
  catalogs: Record<string, Record<string, MessageFormatElement[]>>;
  args: Record<string, Record<string, 'string' | 'number' | 'date'>>;
};
export function generate(options?: {
  catalogRoot?: string;
  outputRoot?: string;
  check?: boolean;
}): Record<string, string>;
