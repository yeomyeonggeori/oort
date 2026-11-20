import type { MessageArgs, MessageKey } from './generated/messages';

/**
 * A key whose message takes no values, so `formatMessage(key)` needs no second argument. A table or model that
 * carries keys in variables (`satisfies Record<Kind, PlainMessageKey>`) narrows to this type; a key that needs
 * values cannot slip in. Before #6020 three features each wrote their own copy of this type.
 */
export type PlainMessageKey = {
  [K in MessageKey]: MessageArgs[K] extends Record<string, never> ? K : never;
}[MessageKey];

/**
 * One sentence a core model hands to a screen: a key and, when the message has arguments, its values. The core never
 * returns the sentence itself; the screen formats it when it draws, in the language it is showing:
 * `formatMessage(ref.key, ref.values as never)` (the same call the channel models' failures already use; the
 * values were checked against the key where the ref was built). Prefer `PlainMessageKey` when no branch has values.
 */
export type MessageRef<K extends MessageKey = MessageKey> = K extends MessageKey
  ? MessageArgs[K] extends Record<string, never>
    ? { key: K; values?: undefined }
    : { key: K; values: MessageArgs[K] }
  : never;
