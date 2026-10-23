import { useEffect } from "react";

/**
 * 로그인 전 공개 두 화면(#4220)이 서 있는 동안의 탭 제목. 시스템 브라우저의 탭에는 이 화면이 무엇인지
 * 말해 주는 것이 제목뿐이다. 떠나면 되돌린다.
 */
export function usePublicTitle(title: string): void {
  useEffect(() => {
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}
