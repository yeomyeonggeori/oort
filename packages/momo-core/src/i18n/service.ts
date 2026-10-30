import { createIntl, createIntlCache, type IntlShape } from '@formatjs/intl';
import { argumentSpecs } from './generated/messages';
import { catalog as english } from './generated/en-US';
import type { MessageKey } from './generated/messages';
import type { MessageCatalog, MessageDiagnostic, MessageService, MessageServiceOptions } from './types';

/** Last resort is independent of both catalogs and contains no key or internal error. */
export const SAFE_MESSAGE = 'Content is unavailable. Please try again.';

function validArguments(key: MessageKey, values: unknown): values is Record<string, string | number | Date> {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return false;
  const input = values as Record<string, unknown>;
  const specs: Readonly<Record<string, string>> = argumentSpecs[key];
  if (Object.keys(input).some(name => !Object.hasOwn(specs, name))) return false;
  return Object.entries(specs).every(([name, kind]) => {
    if (!Object.hasOwn(input, name)) return false;
    const value = input[name];
    if (kind === 'string') return typeof value === 'string';
    if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
    return (value instanceof Date && Number.isFinite(value.getTime()))
      || (typeof value === 'number' && Number.isFinite(value));
  });
}

/** P0-2 recreates this immutable service on locale/catalog changes, discarding formatter caches. */
export function createMessageService(options: MessageServiceOptions): MessageService {
  const fallback = options.fallbackCatalog ?? english;
  const selected = options.catalog ?? (options.messageLocale === 'en-US' ? fallback : {});
  const diagnostic = (code: MessageDiagnostic['code'], key?: MessageKey) => {
    try { options.onDiagnostic?.(key ? { code, key } : { code }); }
    catch { /* A failing observer must not interrupt the safe user message. */ }
  };
  const initialize = (locale: string, messages: MessageCatalog): IntlShape | undefined => {
    try {
      return createIntl({
        locale, messages, defaultLocale: 'en-US', fallbackOnEmptyString: false,
        // FormatJS normally returns source text/IDs after an error. Throw into our fallback instead.
        onError: () => { throw new Error('i18n-format-failed'); },
        onWarn: () => {},
      }, createIntlCache());
    } catch {
      diagnostic('initialization-failed');
      return undefined;
    }
  };
  // Lazy construction also lets an English-only safe path survive a selected-locale failure.
  let selectedIntl: IntlShape | undefined;
  let fallbackIntl: IntlShape | undefined;
  const format = (key: MessageKey, values: Record<string, string | number | Date>): string => {
    const candidates: [string, MessageCatalog, boolean][] = [
      [options.messageLocale, selected, true], ['en-US', fallback, false],
    ];
    for (const [locale, messages, isSelected] of candidates) {
      if (!Object.hasOwn(messages, key) || !Array.isArray(messages[key]) || !messages[key].length) {
        diagnostic('missing-message', key);
        continue;
      }
      try {
        const intl = isSelected
          ? (selectedIntl ??= initialize(locale, messages))
          : (fallbackIntl ??= initialize(locale, messages));
        if (!intl) continue;
        const result = intl.formatMessage({ id: key }, values);
        if (typeof result === 'string' && result.trim() && result !== key) return result;
      } catch { /* Try English; never return FormatJS's source/error fallback. */ }
      diagnostic('format-failed', key);
    }
    return SAFE_MESSAGE;
  };
  return {
    messageLocale: options.messageLocale,
    formatMessage(key, ...args) {
      if (typeof key !== 'string' || !Object.hasOwn(argumentSpecs, key)) {
        diagnostic('unknown-key');
        return SAFE_MESSAGE;
      }
      const values: unknown = args[0] ?? {};
      if (!validArguments(key, values)) {
        diagnostic('invalid-arguments', key);
        return SAFE_MESSAGE;
      }
      return format(key, values);
    },
  };
}
