import { createContext, useContext, useEffect, useRef, useState } from "react";

// =============================================================================
// 셸 내비게이션 상태 (goal B6): 폰 폭인가, 사이드바 서랍이 열려 있는가, 그리고
// 그것을 여는 컨트롤.
//
// 사이드바는 폰에서 격자의 한 열이 아니라 채널 표면을 덮는 서랍이 된다
// (tokens.css `app-shell` / `sidebar-drawer`). 그러면 서랍을 여는 컨트롤이
// 어딘가에 있어야 하는데, 그 자리는 표면마다 다르다: 채널에는 채널 헤더가 있고
// 인박스에는 인박스 헤더가 있다. 그래서 여는 행동은 셸이 소유하고(여기), 그리는
// 자리는 각 표면의 헤더가 소유한다. 표면마다 자기 서랍 상태를 두면 상태가 여덟
// 벌이 되고 그중 일곱은 낡는다 (AppShell의 채널 만들기 다이얼로그가 하나인 것과
// 같은 이유).
// =============================================================================

/**
 * 폰 문턱. tokens.css의 `@media (width < 600px)` 블록들과 **같은 값이어야 한다**
 * — 스타일시트가 서랍으로 만든 폭에서 스크립트도 서랍으로 다뤄야 하고, 둘이
 * 어긋나면 열이 서 있는데 햄버거가 보이거나 그 반대가 된다. ChatShell이 900px
 * 작업 세션 패널에 대해 같은 방식으로 두 곳을 맞춰 두고 있다.
 *
 * 600px인 이유: 이 값 아래가 "한 손에 드는 화면"이다. 세로 폰은 390~430px,
 * 가로 폰은 844px이며(그 폭에서는 240px 열이 여전히 604px를 남긴다), 세로
 * 태블릿은 744~768px다. 600px는 폰 세로만 서랍으로 만들고 나머지는 열로 남긴다.
 */
export const MOBILE_SHELL_QUERY = "(width < 600px)";

export interface ShellNavValue {
  /** 사이드바가 서랍으로 서는 폭인가. */
  isMobile: boolean;
  drawerOpen: boolean;
  /** `opener`는 닫힐 때 캐럿을 돌려줄 자리다 (다이얼로그와 같은 계약). */
  openDrawer: (opener?: HTMLElement | null) => void;
  closeDrawer: () => void;
}

const ShellNavContext = createContext<ShellNavValue | null>(null);

export const ShellNavProvider = ShellNavContext.Provider;

export function useShellNav(): ShellNavValue {
  const value = useContext(ShellNavContext);
  if (!value) throw new Error("useShellNav must be used inside ShellNavProvider");
  return value;
}

/**
 * 창 폭이 폰인가. 첫 렌더에서 이미 답을 알고 시작한다: `false`로 시작한 뒤
 * 효과에서 고치면 폰에서 두 열짜리 셸이 한 프레임 지나갔다가 접힌다.
 */
export function useIsMobileShell(): boolean {
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(MOBILE_SHELL_QUERY).matches
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(MOBILE_SHELL_QUERY);
    const sync = () => setIsMobile(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return isMobile;
}

/**
 * 서랍이 열려 있는 동안 덮인 표면을 탭 순서와 접근성 트리에서 함께 빼낸다.
 *
 * `inert`는 플랫폼 자신의 답이고(포커스 가능성과 보조기술 노출을 한 번에
 * 없앤다), ChatShell이 900px 아래의 작업 세션 서랍에 이미 같은 방식으로 쓰고
 * 있다. React 18은 `inert` prop을 알지 못하므로 속성으로 직접 건다.
 *
 * 이것이 곧 초점 트랩이다: 덮인 쪽이 통째로 inert이면 Tab이 갈 수 있는 곳은
 * 서랍과 스크림 버튼뿐이라, 트랩을 손으로 구현하며 첫/마지막 요소를 추적할
 * 이유가 없다.
 */
export function useInertWhile<T extends HTMLElement = HTMLElement>(
  active: boolean
) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (active) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  }, [active]);
  return ref;
}
