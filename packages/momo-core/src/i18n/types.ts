import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import type { MessageArgs, MessageKey } from './generated/messages';

/** Compiled AST only; P0-5 may supply a pseudo catalog without shipping the compiler. */
export type MessageCatalog = Readonly<Record<string, MessageFormatElement[]>>;
export type CatalogLocale = 'en-US' | 'ko-KR';
export type MessageValues<K extends MessageKey> = MessageArgs[K];
export type MessageArguments<K extends MessageKey> = MessageArgs[K] extends Record<string, never>
  ? [values?: MessageArgs[K]] : [values: MessageArgs[K]];

/** Diagnostics contain codes and registered keys only, never arguments, source text or errors. */
export interface MessageDiagnostic {
  code: 'missing-message' | 'invalid-arguments' | 'format-failed' | 'initialization-failed' | 'unknown-key';
  key?: MessageKey;
}

/** P0-2 composes this service into createLocaleService(context); P0-3/4 load catalogs first. */
export interface MessageServiceOptions {
  messageLocale: string;
  catalog?: MessageCatalog;
  /** Defaults to the bundled English AST; injection supports isolated P0-5/6 tests. */
  fallbackCatalog?: MessageCatalog;
  onDiagnostic?: (diagnostic: MessageDiagnostic) => void;
}

export interface MessageService {
  readonly messageLocale: string;
  /** Plain text only: adapters render this as text, never HTML or a new ICU template. */
  formatMessage<K extends MessageKey>(key: K, ...args: MessageArguments<K>): string;
}
