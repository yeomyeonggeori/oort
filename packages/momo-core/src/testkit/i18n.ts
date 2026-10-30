import {createMessageService, messageKeys} from '../i18n';
import type {MessageArguments, MessageDiagnostic, MessageKey, MessageServiceOptions} from '../i18n';

/** Bind the screen's locale/catalog; test queries must never match a silent fallback. */
export function createMessageCopy(options: MessageServiceOptions) {
  if (!messageKeys.length) throw new Error('Empty message key list');
  const failures: MessageDiagnostic[] = [];
  const service = createMessageService({
    ...options,
    onDiagnostic(diagnostic) {
      failures.push(diagnostic);
      options.onDiagnostic?.(diagnostic);
    },
  });
  return <K extends MessageKey>(key: K, ...args: MessageArguments<K>): string => {
    failures.length = 0;
    const label = service.formatMessage(key, ...args);
    if (failures.length) throw new Error(`Message copy: ${failures[0].code} (${key})`);
    if (label.trim() === '') throw new Error(`Empty message copy: ${key}`);
    return label;
  };
}
