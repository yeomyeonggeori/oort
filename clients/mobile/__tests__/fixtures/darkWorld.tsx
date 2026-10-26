import React from 'react';
import {render as renderWithTestingLibrary} from '@testing-library/react-native';

import {FixedScheme} from '../../src/design/theme';

// `@testing-library/react-native` 를 그대로 다시 내보내고 `render` 하나만 바꾼다. 이 파일을
// 쓰는 시험은 import 경로 한 줄만 `./fixtures/darkWorld` 로 다르고 나머지는 같다.
export * from '@testing-library/react-native';

// =============================================================================
// 다크 세상 — 폰의 기본이 라이트가 되기 전에 쓰인 시험의 가정을 **이름 붙여** 적는다 (#4526).
//
// 폰이 다크 한 벌이던 시절의 낱값(`expect(style.color).toBe(color.text)` — `color` 는
// `tokens.ts` 의 다크 낱값)을 단정하는 시험들이 있다. 그 시험들은 프로바이더 없이 그리고,
// 프로바이더 밖(`DETACHED`)은 시스템을 따랐으며 `jest.setup.js` 가 시스템을 다크로 목킹해서
// 다크가 나왔다. 가정이 어디에도 적혀 있지 않았고, 프로바이더 밖의 기본이 라이트가 되자
// (ADR-0189 증보 5) 그 가정이 **조용히 깨졌다**.
//
// 이 래퍼는 그것을 시험 쪽에서 말로 한다: `FixedScheme scheme="dark"` 로 감싸 그린다. 이 시험들이
// 지키는 것은 「다크 스킴의 색 배선」이고 기본 스킴이 무엇이냐가 아니므로(그것은
// `themeDefault4526.test.tsx`), 단정은 한 글자도 바뀌지 않았다.
//
// 쓰지 말아야 할 자리: 기본 스킴·프로바이더 밖 기본·저장된 선택을 **검사하는** 시험. 그런 시험은
// 감싸이지 않은 `render` 를 써야 하고, 이 래퍼가 그 사실을 가린다.
// =============================================================================

/**
 * 「다크를 고른 폰」의 저장소 내용(`momo.mobile.appearance.v1`). `ThemeProvider` 안에서 그리는
 * 시험은 바깥을 감싸도 안쪽 프로바이더가 이기므로, 저장된 선택으로 다크를 세운다 — 저장된 선택은
 * 폰의 기본이 건드리지 않는다.
 */
export const DARK_CHOSEN_RECORD = JSON.stringify({
  v: 2,
  scheme: 'dark',
  theme: 'dawnsky',
  signal: null,
  density: 'comfortable',
});

type RenderParams = Parameters<typeof renderWithTestingLibrary>;

export function render(
  ui: RenderParams[0],
  options?: RenderParams[1],
): ReturnType<typeof renderWithTestingLibrary> {
  const Outer = options?.wrapper;
  const wrapper = ({children}: {children: React.ReactNode}): React.JSX.Element => (
    <FixedScheme scheme="dark">{Outer ? <Outer>{children}</Outer> : children}</FixedScheme>
  );
  return renderWithTestingLibrary(ui, {...options, wrapper});
}
