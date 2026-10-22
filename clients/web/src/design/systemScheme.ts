// =============================================================================
// 지금 이 기기의 시스템은 어느 쪽인가 (AP-1a #4186, 청사진 §5.2-i).
//
// 「시스템 설정 따르기」를 고른 사람에게 그 문장이 지금 무엇을 뜻하는지 말해 주기 위한
// 값이다. 구독하는 이유는 그 답이 앱이 떠 있는 동안 바뀔 수 있기 때문이다(macOS의 일몰
// 자동 전환).
//
// 신호원은 둘이다.
//   · 브라우저 미디어 질의의 `change` — 모든 곳에서.
//   · 네이티브 창이 알리는 OS 외양 변경 — 데스크탑에서만. WKWebView는 미디어 질의 값을
//     바꾸고도 `change`를 쏘지 않거나 늦게 쏠 수 있어서(Buzz `ThemeProvider.tsx:600-619`
//     주석), 데스크탑은 네이티브 신호를 믿을 신호로 함께 듣는다. 어느 쪽이든 **마지막으로
//     말한 쪽**이 이긴다.
//
// 브라우저 탭에서는 네이티브 신호원이 아예 불리지 않는다(없거나, 불려도 즉시 no-op이다).
//
// 이 파일은 `window`·Tauri를 직접 모른다. 두 신호원을 인자로 받는 공장이라 진짜 브라우저·
// 진짜 셸 없이도 규칙을 잰다. 실제 연결은 `theme.ts`가 한다(미디어 질의 문자열이 그
// 파일에만 있어야 하는 이유는 theme.test.ts의 「스킴을 듣는 표면은 테마 저장소도 듣는다」).
// =============================================================================

export type SystemScheme = "light" | "dark";

/** `MediaQueryList`의 우리가 쓰는 부분. */
export interface MediaLike {
  matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
}

export interface SystemSchemeSources {
  /** 브라우저 미디어 질의. 없으면 `null`. */
  media(): MediaLike | null;
  /**
   * 네이티브 신호원(데스크탑 전용). 구독을 열고 해제 함수로 풀린다. 주지 않으면 미디어
   * 질의만 듣는다. 실패해도 던지지 않아야 하고, 던져도 여기서 삼킨다.
   */
  native?: (handler: (scheme: SystemScheme) => void) => Promise<() => void>;
  /**
   * 네이티브 신호원을 **지금** 열어도 되는가(데스크탑 셸인가). 구독할 때마다 부른다. 모듈을
   * 불러오는 순간이 아니라 구독하는 순간에 묻는 까닭: 이 모듈을 쓰는 스토어는 앱 거의 모든
   * 곳에서 가져가므로, 불러오는 순간에 셸 판정을 읽으면 그 판정을 가짜로 갈아 끼운 시험(부분
   * 모의)이 모듈 로드 중에 터진다. 주지 않으면 `native`가 있는 한 연다. 던지면 닫힌 것으로 본다.
   */
  nativeEnabled?: () => boolean;
}

export interface SystemSchemeStore {
  /** 지금 값. 말한 적 있는 마지막 신호, 없으면 미디어 질의를 지금 읽는다. */
  get(): SystemScheme;
  subscribe(listener: () => void): () => void;
}

export function createSystemScheme(sources: SystemSchemeSources): SystemSchemeStore {
  // 신호원이 마지막으로 말한 값. 아직 아무도 말하지 않았으면 `null`이고, 그때는 미디어
  // 질의를 매번 새로 읽는다(시험이 질의 값을 바꿔 가며 같은 모듈에 묻는다).
  //
  // **기억은 구독이 살아 있는 동안만 믿을 수 있다.** 듣는 이가 아무도 없는 사이에 OS가
  // 바뀌면 이 값은 그 변화를 못 들어서 낡는다: 설정 화면을 열어 둔 채 한 번 전환을 겪고,
  // 화면을 떠난 사이에 되돌아온 사람이 화면을 다시 열면 「지금 이 기기의 시스템은 다크예요」가
  // 거짓이 된다. 그래서 마지막 구독이 풀리는 순간 버려 다음 읽기가 질의를 새로 읽게 한다.
  let spoken: SystemScheme | null = null;
  let subscribers = 0;
  // 지금 열려 있는 구독의 듣는 이들. 한 신호원이 말하면 모두 깨운다(아래 `say`).
  const heard = new Set<{ listener: () => void }>();

  /**
   * 신호원이 말하면 기억을 바꾸고 열려 있는 **모든** 구독의 듣는 이를 깨운다. 구독마다 자기 미디어 질의를 갖고, 질의는
   * 만들어진 뒤의 변화만 쏜다. 변화 직후에 열린 구독의 질의는 그 변화를 듣지 못하는데, 먼저 열려 있던 구독(예: 배경화면
   * 런타임, AP-4)의 질의가 말해 기억이 바뀌고 나면 나중 구독의 듣는 이는 아무도 깨우지 않아 낡은 값에 머물렀다(설정 화면을
   * 막 열 때 「시스템은 다크예요」가 라이트로 돌아오지 않았다). 같은 값을 여러 구독이 되풀이해 말하면 알림은 한 번이다.
   */
  const say = (scheme: SystemScheme): void => {
    if (spoken === scheme) return;
    spoken = scheme;
    for (const entry of [...heard]) entry.listener();
  };

  const get = (): SystemScheme => {
    if (spoken !== null) return spoken;
    return sources.media()?.matches ? "dark" : "light";
  };

  const nativeAllowed = (): boolean => {
    try {
      return sources.nativeEnabled ? sources.nativeEnabled() : true;
    } catch {
      return false;
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    subscribers += 1;
    const entry = { listener };
    heard.add(entry);
    const media = sources.media();
    const onMedia = (event: { matches: boolean }) => say(event.matches ? "dark" : "light");
    media?.addEventListener("change", onMedia);

    // 구독이 풀린 뒤에 네이티브 약속이 늦게 풀리는 경쟁: 풀린 구독이 새 해제 함수를
    // 쥐고 있지 않도록 도착하자마자 되돌린다.
    let disposed = false;
    let unlistenNative: (() => void) | null = null;
    const native = nativeAllowed() ? sources.native : undefined;
    if (native) {
      let pending: Promise<() => void>;
      try {
        pending = native((scheme) => {
          if (disposed) return;
          say(scheme);
        });
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(
        (unlisten) => {
          if (disposed) unlisten();
          else unlistenNative = unlisten;
        },
        () => {
          // 네이티브 신호가 없는 셸(권한·구버전)은 미디어 질의만으로 간다.
        }
      );
    }

    return () => {
      // 해제는 한 번만 센다: 두 번 부르는 호출자가 구독 수를 음수로 몰지 못하게.
      if (disposed) return;
      disposed = true;
      heard.delete(entry);
      media?.removeEventListener("change", onMedia);
      unlistenNative?.();
      unlistenNative = null;
      subscribers -= 1;
      if (subscribers === 0) spoken = null;
    };
  };

  return { get, subscribe };
}
