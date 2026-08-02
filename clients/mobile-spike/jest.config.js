const path = require('path');

/**
 * 스파이크 하네스의 jest 설정.
 *
 * 게이트 2는 **웹의 진짜 소스 파일**(clients/web/src)을 import 해서 돌린다.
 * 복사본을 만들면 "무수정 통과"를 증명하지 못하므로 경로만 이어준다.
 *   - `@/…`      → clients/web/src/…
 *   - `./env`    → RN 상수 stub (웹 env.ts 는 Vite 전용 `import.meta.env` 를 읽는다)
 *
 * `./env` 매핑은 이 그래프(deepLink → serverBase → env)에서만 쓰이므로
 * 광범위해 보여도 실제로 가로채는 대상은 하나다.
 */
const WEB_SRC = path.resolve(__dirname, '../web/src');

module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^@/(.*)$': `${WEB_SRC}/$1`,
    '^\\./env$': path.resolve(__dirname, 'src/gate2_url/webEnvStub.ts'),
    // 웹 소스는 clients/web 밖에서 트랜스파일되므로 babel 런타임 헬퍼를
    // 스파이크 쪽 사본으로 고정한다(웹 트리에는 @babel/runtime 이 없다).
    '^@babel/runtime/(.*)$': `${path.resolve(__dirname, 'node_modules/@babel/runtime')}/$1`,
  },
  // react-native-url-polyfill · @shopify/flash-list · @legendapp/list 는 모두
  // ESM 으로 배포된다(node_modules 는 기본 무시 대상). 이 목록이 길다는 것
  // 자체가 관찰 사항이라 남겨 둔다.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-url-polyfill|@shopify/flash-list|@legendapp/list)/)',
  ],
  setupFiles: ['@shopify/flash-list/jestSetup.js'],
};
