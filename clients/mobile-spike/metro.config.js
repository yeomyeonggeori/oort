const path = require('path');
const fs = require('fs');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro 설정 — 스파이크 하네스.
 *
 * 게이트 2의 판정 기준은 "deepLink.ts 가 **무수정** 통과하는가"다.
 * 복사본을 두면 그 질문에 답할 수 없으므로, 웹 소스 트리를 watchFolders 에
 * 넣고 `@/…` 를 그쪽으로 직접 해석한다.
 *
 * 단 하나 갈아끼우는 것이 `./env` 다: 웹 env.ts 는 Vite 전용 `import.meta.env`
 * 를 읽는데 Metro/Hermes 는 `import.meta` 를 지원하지 않는다. 이 교체 하나가
 * 게이트 2에서 실측된 어댑터 비용 전부다(src/gate2_url/webEnvStub.ts 참조).
 */
const WEB_SRC = path.resolve(__dirname, '../web/src');
const ENV_STUB = path.resolve(__dirname, 'src/gate2_url/webEnvStub.ts');

/** `@/x/y` → clients/web/src/x/y (.ts / .tsx 를 차례로 시도) */
function resolveWebSource(rest) {
  const base = path.join(WEB_SRC, rest);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return c;
    }
  }
  return null;
}

const config = {
  watchFolders: [WEB_SRC],
  resolver: {
    // 웹 소스는 clients/web 밖에서 트랜스파일되므로, babel 런타임 헬퍼와
    // 일반 패키지를 전부 스파이크 쪽 node_modules 에서 찾게 고정한다.
    // (clients/web 트리에는 @babel/runtime 이 없다.)
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
    extraNodeModules: {
      '@babel/runtime': path.resolve(__dirname, 'node_modules/@babel/runtime'),
    },
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName.startsWith('@/')) {
        const filePath = resolveWebSource(moduleName.slice(2));
        if (filePath) {
          return {type: 'sourceFile', filePath};
        }
      }
      // 웹 소스 안에서 온 `./env` 만 가로챈다.
      if (
        moduleName === './env' &&
        typeof context.originModulePath === 'string' &&
        context.originModulePath.startsWith(WEB_SRC)
      ) {
        return {type: 'sourceFile', filePath: ENV_STUB};
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
