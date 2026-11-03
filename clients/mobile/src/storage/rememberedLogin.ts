import {
  createRememberedLoginStore,
  type RememberedLoginPort,
  type RememberedLoginStore,
} from '@momo/core/features/auth/rememberedLogin';
import {NON_SECRET_KEYS, nonSecretStore} from './kv';

// =============================================================================
// 「이메일 기억하기」(#4669)의 폰 저장소 — 서버 주소를 기억하는 자리(`serverBase.ts`)의 옆이다. 규칙(서버별 ·
// 이메일 모양만 · 끄면 즉시 지움)은 코어 모델이 쥐고, 이 파일은 MMKV 한 칸을 건네는 일만 한다.
//
// 처음 값은 **켬**이다(폰·데스크탑 켬, 웹 끔 — owner 10-27). 사람이 끄면 그 선택이 남는다.
// =============================================================================

export function mobileRememberedLoginPort(): RememberedLoginPort {
  return {
    read() {
      try {
        return nonSecretStore().getString(NON_SECRET_KEYS.rememberedLogin) ?? null;
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        if (value === null) nonSecretStore().remove(NON_SECRET_KEYS.rememberedLogin);
        else nonSecretStore().set(NON_SECRET_KEYS.rememberedLogin, value);
      } catch {
        // 저장소를 못 쓰면 이번 실행에서만 기억하고 로그인은 그대로다(`serverBase.ts`와 같은 약속).
      }
    },
  };
}

export function createMobileRememberedLogin(): RememberedLoginStore {
  return createRememberedLoginStore(mobileRememberedLoginPort(), {defaultEnabled: true});
}
