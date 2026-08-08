/**
 * 게이트 2 — `clients/web/src/lib/env.ts` 의 RN 대역(stub).
 *
 * **이 파일의 존재 자체가 실측 결과다.** 보고서에 그대로 실린다.
 *
 * `deepLink.ts` 는 무수정으로 옮길 수 있지만, 그 의존 사슬이
 *   deepLink.ts → @/lib/serverBase → ./env
 * 이고 `env.ts` 는 `import.meta.env` (Vite 전용)를 읽는다.
 * Metro/Hermes 는 `import.meta` 를 지원하지 않으므로 env.ts 는 **그대로 못 간다**.
 *
 * 다만 이것은 URL/딥링크 문제가 아니라 **번들러 문제**이며,
 * serverBase 가 실제로 쓰는 export 는 아래 둘뿐이다 (나머지 3개는 로그인 폼 전용).
 * 즉 게이트 2의 어댑터 비용은 "env.ts 46줄을 RN용 상수 파일로 교체" 하나다.
 */

/** 웹에서는 빌드타임 VITE_MOMO_API_BASE. RN 에서는 서버를 사람이 고르므로 항상 "". */
export const API_BASE_DEFAULT = '';

/** RN 은 Tauri WebView 가 아니다. 항상 false. */
export const IS_TAURI = false;

/** serverBase 는 쓰지 않지만 env.ts 의 표면을 맞춰 둔다. */
export const CONFIGURED_WORKSPACE = '';
export const DEV_EMAIL = '';
export const DEV_PASSWORD = '';
