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
