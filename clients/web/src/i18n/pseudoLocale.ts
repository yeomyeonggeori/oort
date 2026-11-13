import type { MessageCatalog } from "@momo/core/i18n";

/**
 * 의사 언어 en-XA (#5589, ADR-0213 §4). 개발 서버(`vite`)와 캡처용 `--mode design` 빌드에서만 켤 수 있다.
 * 출시 빌드(`npm run build`)에서는 이 값이 상수 false가 되어 아래 동적 import까지 번들에서 빠진다.
 * 언어 목록(`availableLocales`)에는 넣지 않는다: 사람이 고르는 언어가 아니라 사전 밖 글을 찾는 도구다.
 */
export const PSEUDO_LOCALE_BUILD = import.meta.env.DEV || import.meta.env.MODE === "design";

const QUERY = /[?&]pseudo=([01])(?:&|$)/;
const STORAGE_KEY = "oort.locale.pseudo";

/** `?pseudo=1`은 이 탭에서 켜고 `?pseudo=0`은 끈다. 둘 다 없으면 이 탭에 남긴 선택을 따른다. */
export function pseudoLocaleRequested(
  search: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined,
): boolean {
  if (!PSEUDO_LOCALE_BUILD) return false;
  const asked = QUERY.exec(search)?.[1];
  try {
    if (asked === "1") storage?.setItem(STORAGE_KEY, "1");
    if (asked === "0") storage?.removeItem(STORAGE_KEY);
    return storage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return asked === "1";
  }
}

/** 영어 사전을 의사 언어로 바꾼 사전. 코어의 변환과 영어 사전은 이 함수가 불릴 때만 받는다. */
export async function loadPseudoCatalog(): Promise<{ locale: string; catalog: MessageCatalog }> {
  const [pseudo, english] = await Promise.all([
    import("@momo/core/i18n/pseudo"),
    import("@momo/core/i18n/generated/en-US"),
  ]);
  return { locale: pseudo.PSEUDO_LOCALE, catalog: pseudo.pseudoCatalog(english.catalog) };
}
