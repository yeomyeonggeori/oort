import {
  parseCatalog,
  supportedEmojis,
  type RawCatalog,
} from '@momo/core/features/emoji/catalog';
import {iosEmojiVersion} from '@momo/core/features/emoji/support';
import {Platform} from 'react-native';

/** Bundled with the app: no network, cached failure or offline dependency. */
export async function loadPhoneEmojiCatalog() {
  const raw =
    require('@momo/core/features/emoji/emojiCatalog.json') as RawCatalog;
  return supportedEmojis(
    parseCatalog(raw),
    Platform.OS === 'ios' ? iosEmojiVersion(String(Platform.Version)) : 0,
  );
}
