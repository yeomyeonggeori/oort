import {Platform} from 'react-native';
import {resolveCatalogEmoji} from '@momo/core/features/emoji/catalog';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';

it('loads the bundled core catalog offline and gates new glyphs by the actual OS version', async () => {
  const version = jest
    .spyOn(Platform, 'Version', 'get')
    .mockReturnValue('26.4');
  const fetch = jest.spyOn(globalThis, 'fetch');
  const current = await loadPhoneEmojiCatalog();
  expect(current.length).toBeGreaterThan(1900);
  expect(resolveCatalogEmoji(current, '👍')?.koreanName).toContain('엄지');
  expect(resolveCatalogEmoji(current, '🫫')).toBeUndefined(); // Emoji 18, not yet verified on Apple
  version.mockReturnValue('14.5');
  const old = await loadPhoneEmojiCatalog();
  expect(old.length).toBeLessThan(current.length);
  expect(resolveCatalogEmoji(old, '🫱🏻‍🫲🏿')).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
  version.mockRestore();
});

// #5330: 시트를 열 때마다(기본 탭을 다시 열 때마다) 1900여 칸을 다시 풀지 않는다 — 같은 OS·버전이면 푼 목록이 같은 배열이고, 버전이 바뀌면 다시 푼다.
it('parses the bundled catalog once per OS version and hands every later caller the same list (#5330)', async () => {
  const version = jest.spyOn(Platform, 'Version', 'get').mockReturnValue('26.4');
  const first = await loadPhoneEmojiCatalog();
  const second = await loadPhoneEmojiCatalog();
  expect(second).toBe(first); // 같은 배열 — 두 번째는 풀지 않았다
  version.mockReturnValue('14.5');
  const older = await loadPhoneEmojiCatalog();
  expect(older).not.toBe(first); // 버전이 다르면 다른 목록(지원하는 그림이 다르다)
  expect(older.length).toBeLessThan(first.length);
  expect(await loadPhoneEmojiCatalog()).toBe(older);
  version.mockRestore();
});
