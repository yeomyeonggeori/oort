/**
 * 스파이크 전용 타입 shim.
 *
 * 게이트 2 테스트는 RN 코어가 폴리필 없이 제공하는 URL 을 직접 import 해
 * 폴리필과 비교한다. 이 경로는 RN 의 공개 표면이 아니라 타입 선언이 없다 —
 * 없다는 사실 자체가 "이건 원래 쓰라고 만든 게 아니다"라는 신호이고,
 * 우리는 비교 대상으로만 쓴다.
 */
declare module 'react-native/Libraries/Blob/URL' {
  export const URL: typeof globalThis.URL;
}
declare module 'react-native/Libraries/Blob/URLSearchParams' {
  export const URLSearchParams: typeof globalThis.URLSearchParams;
}

/**
 * 웹 `env.ts` 가 읽는 `import.meta.env` 는 **Vite 가 빌드타임에 주입**하는 것이다.
 * tsc 에게만 그 존재를 알려 준다.
 *
 * 런타임에는 이 선언이 아무 일도 하지 않으며, 하면 안 된다:
 * Metro/Hermes 는 `import.meta` 자체를 지원하지 않으므로 실행 경로에서는
 * `./env` 가 통째로 `src/gate2_url/webEnvStub.ts` 로 치환된다
 * (metro.config.js / jest.config.js). 이 declare 는 "타입은 서지만 런타임은
 * 못 간다"는 사실을 지우지 않는다 — 그것이 게이트 2의 어댑터 비용이다.
 */
interface ImportMeta {
  env: Record<string, string | undefined>;
}
