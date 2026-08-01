// =============================================================================
// 홈 화면 설치 안내와 새 버전 알림의 판단 (goal B10).
//
// 순수하다: 브라우저도 React도 저장소도 없다. store.ts가 사실을 모아 오고, 여기는
// 그 사실들로 "무엇을 한 줄 보여줄 것인가"만 정한다. 그래야 이 판단이 폰을 손에
// 들지 않고도 단위 테스트로 확인된다.
// =============================================================================

/** 설치를 권할 수 있는 방법. 브라우저마다 있는 길이 다르다. */
export type InstallInvite =
  /** 브라우저가 설치 프롬프트를 넘겨줬다(크롬 계열). 버튼 하나로 끝난다. */
  | "prompt"
  /**
   * iOS에는 beforeinstallprompt가 없다. 앱이 대신 눌러 줄 수 있는 것이 없으므로
   * 남는 것은 어디를 눌러야 하는지 말해 주는 것뿐이다: 공유 시트 -> 홈 화면에 추가.
   */
  | "ios-share";

export interface InstallContext {
  /** 이미 홈 화면에서 열린 앱인가. */
  standalone: boolean;
  /** 데스크탑 셸(Tauri) 안인가. 여기에는 설치할 홈 화면이 없다. */
  desktopShell: boolean;
  /** 사이드바가 서랍이 되는 폭인가. 이 안내는 폰의 주소창 때문에 있다. */
  phone: boolean;
  /** 이미 한 번 보여 줬는가(닫았든 무시했든). */
  seen: boolean;
  /** beforeinstallprompt를 붙잡아 두었는가. */
  deferredPrompt: boolean;
  /** iOS/iPadOS WebKit인가. */
  ios: boolean;
}

/**
 * 설치 안내를 띄울 것인가, 띄운다면 어느 쪽인가.
 *
 * 순서가 규칙이다. 이미 설치된 사람, 데스크탑 셸, 넓은 창, 이미 본 사람에게는
 * 아무것도 하지 않는다. 남은 경우에만 방법을 고르고, **방법이 없으면 말도 걸지
 * 않는다**: 안드로이드 크롬이 아직 프롬프트를 주지 않았다면 우리가 대신 열어 줄
 * 수 있는 것이 없고, 그때 배너는 사용자가 할 수 없는 일을 권하는 줄이 된다.
 */
export function installInvite(context: InstallContext): InstallInvite | null {
  if (context.standalone) return null;
  if (context.desktopShell) return null;
  if (!context.phone) return null;
  if (context.seen) return null;
  if (context.deferredPrompt) return "prompt";
  if (context.ios) return "ios-share";
  return null;
}

/** 한 줄에 설 수 있는 것은 하나다. */
export type PwaNotice =
  | { kind: "update" }
  | { kind: "install"; invite: InstallInvite };

/**
 * 두 소식이 동시에 참일 때 무엇을 먼저 말할 것인가.
 *
 * 새 버전이 이긴다. 설치 안내는 이 기기에서 언젠가 하면 되는 일이지만, 낡은 셸로
 * 계속 쓰는 것은 지금 고쳐야 하는 상태다. 둘을 위아래로 쌓지 않는 이유는 이
 * 줄들이 셸의 높이를 실제로 가져가기 때문이다: 두 줄이면 폰에서 타임라인이 두
 * 줄만큼 짧아진다.
 */
export function pwaNotice(input: {
  updateReady: boolean;
  invite: InstallInvite | null;
}): PwaNotice | null {
  if (input.updateReady) return { kind: "update" };
  if (input.invite) return { kind: "install", invite: input.invite };
  return null;
}
