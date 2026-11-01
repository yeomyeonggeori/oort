import {
  createRememberedLoginStore,
  type RememberedLoginPort,
  type RememberedLoginStore,
} from "@momo/core/features/auth/rememberedLogin";
import { IS_TAURI } from "@/lib/env";

// 「이메일 기억하기」(#4669)의 웹·데스크탑 저장소. 서버 주소를 기억하는 자리
// (`serverBase.ts`의 `momo.web.server.v1`, `recentServers.ts`의 `momo.web.server.history.v1`)
// 바로 옆에 두고, 규칙(서버별·이메일 모양만·끄면 즉시 지움)은 코어 모델이 쥔다.
//
// 데스크탑은 웹과 같은 코드라 같은 localStorage 칸을 쓴다(Tauri 창의 저장소). 로그아웃은
// 이 칸을 건드리지 않는다: 「같은 서버에 다시 들어오면 채워짐」이 이 기능이다. 계정 꼬리가
// 붙은 키만 지우는 `clearDurableForCurrentAccount`와 키 모양이 다르다.

export const REMEMBERED_LOGIN_STORAGE_KEY = "momo.web.login.remembered.v1";

export function browserRememberedLoginPort(): RememberedLoginPort {
  return {
    read() {
      try {
        return localStorage.getItem(REMEMBERED_LOGIN_STORAGE_KEY);
      } catch {
        // localStorage가 없거나 막혀 있으면 기억한 것이 없는 것과 같다.
        return null;
      }
    },
    write(value) {
      try {
        if (value === null) localStorage.removeItem(REMEMBERED_LOGIN_STORAGE_KEY);
        else localStorage.setItem(REMEMBERED_LOGIN_STORAGE_KEY, value);
      } catch {
        // 막힌 저장소(사생활 보호 모드·용량): 이번 실행에서만 기억하고 로그인은 그대로다.
      }
    },
  };
}

/**
 * 화면이 마운트 때 한 번 만들어 쥔다(`useState(createWebRememberedLogin)`). 상태는 저장소 한 칸에만 있고
 * 호출 때마다 읽으므로 다른 탭의 변경도 보이며, 모듈 전역에 따로 쥔 값이 없다.
 *
 * 고른 적이 없을 때의 처음 값: 데스크탑(Tauri)은 켬, 브라우저는 끔(owner 10-27).
 */
export function createWebRememberedLogin(
  options: { defaultEnabled?: boolean } = {}
): RememberedLoginStore {
  return createRememberedLoginStore(browserRememberedLoginPort(), {
    defaultEnabled: options.defaultEnabled ?? IS_TAURI,
  });
}
