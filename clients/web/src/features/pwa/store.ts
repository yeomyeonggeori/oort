import { useSyncExternalStore } from "react";
import { IS_TAURI } from "@/lib/env";

// =============================================================================
// 홈 화면 앱으로 서기 (goal B10).
//
// 위치: 이것은 **RN(ADR-0137)을 대체하지 않는다.** 네이티브 클라이언트가 나오기
// 전까지 폰에서 쓰는 사람의 체감을 메우는 임시 다리다. 발단도 그만큼 구체적이다:
// 사파리 주소창이 컴포저를 가려서, 메시지를 쓰는 동안 자기가 친 글자가 안 보였다.
//
// 이 파일이 소유하는 것은 셋이다.
//   1. 서비스 워커 등록과 그 수명(sw.js).
//   2. 브라우저가 넘겨준 설치 프롬프트를 붙잡아 두는 일.
//   3. "이미 한 번 권했다"는 기억.
//
// 매니페스트(public/manifest.json)의 선택들도 여기 적어 둔다. JSON은 주석을 갖지
// 못하고, 이유 없는 값은 다음 사람이 지운다.
//   display: standalone   주소창 없이 뜬다. 이 티켓의 전부다.
//   start_url/scope: "/"  라우팅은 해시(HashRouter)라 경로는 언제나 "/"다.
//   theme_color           tokens.css 다크 --surface 값 하나. 매니페스트의 색은
//   background_color      한 벌뿐이라 스킴을 따라갈 수 없고, 마크 타일
//                         (favicon.svg)이 두 스킴 모두에서 어두운 판으로 고정돼
//                         있으므로(B4.4) 그 판과 같은 어둠을 쓴다. 스킴을
//                         따라가는 색은 index.html의 theme-color 두 줄이 계속
//                         담당한다.
//   icons                 192(런처)·512(스플래시)·512 maskable(런처가 자기
//                         모양으로 잘라내는 판). 전부 favicon.svg에서 떠낸다
//                         (scripts/render-pwa-icons.mjs). 새로 그린 그림은 없다.
// =============================================================================

/** 한 번 권했다는 기억. 값이 아니라 존재 여부만 읽는다. */
const INVITE_SEEN_KEY = "momo.web.pwa-invite.v1";

/**
 * 워커에게 자기가 낡았는지 다시 물어보는 주기. 여섯 시간이고, 설정 > 업데이트의
 * 데스크탑 채널(features/updates/store.ts)과 같은 값이다: 같은 질문에 두 개의
 * 리듬을 두면 둘 중 하나는 이유 없이 존재하게 된다.
 *
 * 이 주기가 필요한 이유는 홈 화면 앱이 **새로고침되지 않기 때문이다.** 탭을 다시
 * 여는 사람은 항해(navigate)마다 브라우저가 알아서 sw.js를 다시 받지만, 아이콘을
 * 눌러 열어 두고 며칠을 쓰는 사람에게는 그런 순간이 오지 않는다.
 */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 크롬 계열이 넘겨주는 설치 프롬프트. lib.dom에 아직 없는 타입이라 여기서 최소한
 * 만 적는다. `prompt()`는 사용자 제스처 안에서 한 번만 부를 수 있다.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaState {
  /** 새 워커가 이 탭을 넘겨받았다. 새로고침하면 새 버전이 뜬다. */
  updateReady: boolean;
  /** 브라우저가 설치 프롬프트를 넘겨줬다. */
  canPrompt: boolean;
  /** 설치 안내를 이미 한 번 보여 줬다. */
  inviteSeen: boolean;
  /** 홈 화면에서 열린 앱인가. */
  standalone: boolean;
}

let state: PwaState = {
  updateReady: false,
  canPrompt: false,
  inviteSeen: readInviteSeen(),
  standalone: standaloneNow(),
};

let started = false;
let deferredPrompt: InstallPromptEvent | null = null;
let registration: ServiceWorkerRegistration | null = null;
let lastUpdateCheck = 0;

const listeners = new Set<() => void>();

function set(next: Partial<PwaState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): PwaState {
  return state;
}

/** 셸과 배너가 같은 사실을 본다. */
export function usePwaState(): PwaState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// ---- 브라우저에게 묻는 것들 --------------------------------------------------

function standaloneNow(): boolean {
  if (typeof window === "undefined") return false;
  // iOS는 display-mode 미디어 쿼리를 늦게 구현했고, 홈 화면 앱은 그 전부터
  // 있었다. 두 신호는 겹칠 뿐 서로를 대체하지 않는다(useOffline과 같은 이유).
  const iosStandalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  const displayMode =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  return iosStandalone || displayMode;
}

/**
 * iOS/iPadOS의 WebKit인가. 여기서만 설치 경로가 "공유 시트"다.
 *
 * 사파리만 보지 않는다: iOS의 크롬과 파이어폭스도 WebKit이고, 그 브라우저들도
 * 공유 시트에 홈 화면에 추가를 갖고 있다.
 */
export function isIosWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+는 자기를 맥이라고 말한다. 손가락이 닿는 맥은 없다.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** 데스크탑 셸에는 설치할 홈 화면이 없다. */
export function isDesktopShell(): boolean {
  return IS_TAURI;
}

function readInviteSeen(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(INVITE_SEEN_KEY) !== null;
  } catch {
    // 사파리 프라이빗 모드는 저장소 접근 자체를 던진다. 기억하지 못하는 것은
    // 배너를 다시 보는 것이지 앱이 서지 못하는 것이 아니다.
    return false;
  }
}

function rememberInviteSeen(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(INVITE_SEEN_KEY, "1");
    }
  } catch {
    /* 위와 같다 */
  }
}

// ---- 서비스 워커 -------------------------------------------------------------

/**
 * 이 런타임에서 워커를 등록해도 되는가.
 *
 * https(또는 명시적 seam)로 좁히는 것은 보수가 아니라 정확도다. 워커는 자기가
 * 붙은 오리진의 응답을 가로채므로, 켜도 되는 자리가 아닌 곳에서 켜지면 그
 * 오리진에서 벌어지는 모든 이상 현상의 첫 번째 용의자가 된다.
 *
 *   - Tauri 셸: 패키징된 CSP가 worker-src 'none'이고, WKWebView는 custom scheme
 *     에서 워커를 주지도 않는다. 데스크탑 앱은 자기 업데이터를 갖고 있다.
 *   - dev/캡처/게이트 빌드: MODE로 걸러진다. 게이트가 모의한 /v1 위에 워커가
 *     끼어들면, 실패했을 때 원인을 두 겹으로 파야 한다.
 *   - http: 로컬 preview가 여기다. 검증할 때만 `?pwa`로 연다(?stress, ?agentwork
 *     과 같은 종류의 seam).
 */
function serviceWorkerEligible(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  if (isDesktopShell()) return false;
  if (import.meta.env.MODE !== "production") return false;
  if (window.location.protocol === "https:") return true;
  return new URLSearchParams(window.location.search).has("pwa");
}

function checkForWorkerUpdate(): void {
  if (!registration) return;
  const now = Date.now();
  if (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return;
  lastUpdateCheck = now;
  void registration.update().catch(() => {
    // 네트워크가 없어서 못 물어본 것과 새 버전이 없는 것은 사용자에게 같은
    // 화면이다: 아무 일도 일어나지 않는다.
  });
}

async function registerServiceWorker(): Promise<void> {
  // 등록은 첫 페인트와 경쟁하지 않는다. 워커가 주는 이득은 **다음** 실행에서
  // 나오므로, 이번 실행의 로딩을 조금이라도 늦출 이유가 없다.
  if (document.readyState !== "complete") {
    await new Promise<void>((resolve) =>
      window.addEventListener("load", () => resolve(), { once: true })
    );
  }

  // 이 탭이 이미 워커의 통제를 받고 있었는가. 이 한 줄이 "첫 설치"와 "새 버전"을
  // 가른다: sw.js의 clients.claim()은 두 경우 모두 controllerchange를 쏘는데,
  // 첫 설치에서 "새 버전이 준비됐습니다"라고 말하면 처음 온 사람에게 방금 받은
  // 것을 새로고침하라고 시키는 셈이다.
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    set({ updateReady: true });
  });

  try {
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    lastUpdateCheck = Date.now();
  } catch (error) {
    // 워커가 없는 앱은 그냥 웹앱이다. 기능이 하나 덜 있을 뿐 아무것도 깨지지
    // 않으므로, 이 실패는 콘솔까지만 간다.
    console.warn("[momo] service worker did not register", error);
    return;
  }

  window.setInterval(checkForWorkerUpdate, UPDATE_CHECK_INTERVAL_MS);
  // 홈 화면 앱이 실제로 "돌아오는" 순간. 주기 타이머는 백그라운드에서 조여지고,
  // 사람이 앱을 다시 열어 보는 이 순간이 물어보기 가장 좋은 때다.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForWorkerUpdate();
  });
}

// ---- 시작 -------------------------------------------------------------------

/**
 * 한 번만. main.tsx가 부른다.
 *
 * 워커를 등록하지 못하는 런타임에서도 나머지는 계속한다: 설치 프롬프트를 붙잡는
 * 일과 홈 화면 여부를 아는 일은 워커와 상관이 없다.
 */
export function startPwa(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  // 크롬 계열은 설치할 수 있다고 판단한 순간 이 이벤트를 쏘고, 막지 않으면 자기
  // 배너를 띄운다. 붙잡아 두는 이유는 **때를 고르기 위해서**가 아니라 문구를
  // 고르기 위해서다: 브라우저 배너는 이 앱이 무엇인지 말하지 못한다.
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    set({ canPrompt: true });
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    rememberInviteSeen();
    set({ canPrompt: false, inviteSeen: true, standalone: standaloneNow() });
  });

  if (serviceWorkerEligible()) void registerServiceWorker();
}

// ---- 행동 -------------------------------------------------------------------

/**
 * 브라우저의 설치 프롬프트를 연다. 결과와 무관하게 이 안내는 끝난다: 거절한
 * 사람에게 같은 줄을 다시 보여 주는 것은 안내가 아니라 조르는 것이다.
 */
export async function promptInstall(): Promise<void> {
  const pending = deferredPrompt;
  dismissInstallInvite();
  if (!pending) return;
  deferredPrompt = null;
  set({ canPrompt: false });
  try {
    await pending.prompt();
    await pending.userChoice;
  } catch (error) {
    console.warn("[momo] install prompt did not open", error);
  }
}

/** 안내를 닫는다. 이 기기에서는 다시 뜨지 않는다. */
export function dismissInstallInvite(): void {
  rememberInviteSeen();
  set({ inviteSeen: true });
}

/** 새 버전으로 넘어간다. 이미 활성화된 워커가 새 셸을 갖고 있다. */
export function applyUpdate(): void {
  window.location.reload();
}
