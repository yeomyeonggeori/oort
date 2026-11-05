import {
  parseCatalog,
  supportedEmojis,
  type CatalogEmoji,
  type RawCatalog,
} from '@momo/core/features/emoji/catalog';
import {iosEmojiVersion} from '@momo/core/features/emoji/support';
import {Platform} from 'react-native';

/** 한 번 푼 목록: OS·버전이 같으면 같은 배열이다 — 시트를 열 때마다 1900여 칸을 다시 풀지 않는다(#5330). */
let parsed: {key: string; entries: CatalogEmoji[]} | null = null;

/** Bundled with the app: no network, cached failure or offline dependency. */
export async function loadPhoneEmojiCatalog() {
  const key = `${Platform.OS}:${String(Platform.Version)}`;
  if (parsed?.key === key) return parsed.entries;
  const raw =
    require('@momo/core/features/emoji/emojiCatalog.json') as RawCatalog;
  const entries = supportedEmojis(
    parseCatalog(raw),
    Platform.OS === 'ios' ? iosEmojiVersion(String(Platform.Version)) : 0,
  );
  parsed = {key, entries};
  return entries;
}
