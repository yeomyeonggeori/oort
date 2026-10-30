import {
  createEmojiFrequencyStore,
  createEmojiSkinToneStore,
} from '@momo/core/features/emoji/preferences';
import {
  NON_SECRET_KEYS,
  nonSecretStore,
  type NonSecretKey,
} from '../../storage/kv';

function storage(key: NonSecretKey) {
  return {
    read: () => nonSecretStore().getString(key),
    write: (value: string | null) => {
      if (value === null) nonSecretStore().remove(key);
      else nonSecretStore().set(key, value);
    },
  };
}

// Device-local preferences, same lifetime as the existing web stores.
export const emojiFrequency = createEmojiFrequencyStore(
  storage(NON_SECRET_KEYS.emojiFrequency),
);
export const emojiSkinTone = createEmojiSkinToneStore(
  storage(NON_SECRET_KEYS.emojiSkinTone),
);
