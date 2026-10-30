import {createMessageService, loadMessageCatalog} from '@momo/core/i18n';
import type {CatalogLocale} from '@momo/core/i18n';
import {createMessageCopy} from '@momo/core/testkit/i18n';
import {cleanup, render} from '@testing-library/react-native';
import React from 'react';
import {Pressable, TextInput, View} from 'react-native';

import {control, controls, labelled, maybeControl, pressControl, typeInto} from './query';

// Screen behavior uses message keys/roles. Translation assertions belong to copyCatalog.test.ts.
it('ko/en에서 같은 키와 역할로 컨트롤을 구별하고 누르기·입력을 수행한다', async () => {
  for (const messageLocale of ['ko-KR', 'en-US'] as const satisfies readonly CatalogLocale[]) {
    const catalog = await loadMessageCatalog(messageLocale);
    const messages = createMessageService({messageLocale, catalog});
    const copy = createMessageCopy({messageLocale, catalog});
    const onPress = jest.fn();
    const onChangeText = jest.fn();
    render(
      <View>
        <Pressable accessibilityRole="button"
          accessibilityLabel={messages.formatMessage('settings.profile.languageRetry')}
          onPress={onPress} />
        <Pressable accessibilityRole="button"
          accessibilityLabel={messages.formatMessage('settings.profile.languageSystem')} />
        <TextInput accessibilityLabel={messages.formatMessage('settings.profile.languageCurrent', {languageName: 'fixture'})}
          onChangeText={onChangeText} />
      </View>,
    );
    const retry = copy('settings.profile.languageRetry');
    expect(control('button', retry)).toBe(maybeControl('button', retry));
    expect(controls('button', retry)).toHaveLength(1);
    pressControl('button', retry);
    expect(onPress).toHaveBeenCalledTimes(1);
    const label = copy('settings.profile.languageCurrent', {languageName: 'fixture'});
    expect(labelled(label)).toBeTruthy();
    typeInto(label, 'input');
    expect(onChangeText).toHaveBeenCalledWith('input');
    expect(maybeControl('checkbox', retry)).toBeNull();
    cleanup();
  }
});

it('잘못된 사전·키는 안전 문구 버튼과 우연히 맞아도 조회 전에 실패한다', async () => {
  const catalog = await loadMessageCatalog('en-US');
  const messages = createMessageService({messageLocale: 'en-US', catalog: {}, fallbackCatalog: {}});
  const copy = createMessageCopy({messageLocale: 'en-US', catalog: {}, fallbackCatalog: {}});
  render(<Pressable accessibilityRole="button"
    accessibilityLabel={messages.formatMessage('settings.profile.languageRetry')} />);
  expect(() => control('button', copy('settings.profile.languageRetry'))).toThrow(/missing-message/);
  const valid = createMessageCopy({messageLocale: 'en-US', catalog});
  expect(() => maybeControl('button', valid('unknown.key' as never))).toThrow(/unknown-key/);
});
