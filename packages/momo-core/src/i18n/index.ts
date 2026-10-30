export { createMessageService, SAFE_MESSAGE } from './service';
export { loadMessageCatalog } from './catalogs';
/** P0-6 reads this nonempty key list and argument schema for the existing copy testkit. */
export { messageKeys, argumentSpecs } from './generated/messages';
export type { MessageKey, MessageArgs } from './generated/messages';
export type {
  CatalogLocale, MessageCatalog, MessageValues, MessageArguments,
  MessageService, MessageServiceOptions, MessageDiagnostic,
} from './types';
