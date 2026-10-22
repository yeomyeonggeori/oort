import { DERIVED_PALETTE, paletteOf } from "@momo/core/design/themeResolve";
import { getAppearance, subscribeTheme } from "@/design/theme";
import type { DerivedApplierOptions } from "./derivedApplier";

// 파생 테마를 루트에 꽂는 구독 (ADR-0189 증보 3 D2, AP-1b #4188). **메인 번들의 얇은 문**이다.
//
// 카탈로그·사용자 테마는 정적 CSS가 없어서 파생 엔진의 변수를 `<html>`에 꽂아야 서지만, 엔진(카탈로그 씨앗 표·파생
// 산수, gzip 약 10KB)은 메인 번들에 넣지 않는다. 이 파일은 저장소를 구독하다가 **저장된 테마가 파생 테마가 되면** 그때
// `derivedApplier`(지연 청크)를 싣고, 싣고 나면 모든 변경을 그쪽에 넘긴다(첫 파티로 돌아갈 때 자기가 꽂은 변수를
// 걷는 일도 그쪽이 한다). 로드되기 전에는 부트 캐시가 첫 페인트를 맡고(캐시가 없으면 한 프레임 기본 테마, 청사진
// §5.2-i가 허용), 로드를 기다리는 사이에 선택이 바뀌어도 로드 뒤에 **그때의** 저장소를 다시 읽는다.
// 번들 크기 게이트(`gate:theme-bundle`)가 이 경계를 지킨다: 누가 엔진을 정적으로 가져오면 메인 청크가 예산을 넘는다.

type Applier = { sync(): void };

export function startDerivedTheme(
  options: DerivedApplierOptions & { load?: () => Promise<Applier> } = {}
): { sync(): void; stop(): void } {
  let applier: Applier | null = null;
  let loading = false;
  const load =
    options.load ??
    (() => import("./derivedApplier").then((mod) => mod.createDerivedApplier(options)));
  function sync(): void {
    if (applier) return applier.sync();
    // 로드 중에는 다시 싣지 않는다(적용기가 둘이면 꽂은 변수의 기록이 둘로 갈린다).
    if (loading || paletteOf(getAppearance().theme) !== DERIVED_PALETTE) return;
    loading = true;
    load().then(
      (loaded) => {
        applier = loaded;
        loaded.sync(); // 기다리는 사이에 선택이 바뀌었을 수 있으니 그때의 저장소를 다시 읽는다.
      },
      () => {
        loading = false; // 실패는 삼키고(앱은 기본 테마로 선다) 다음 변경에서 다시 시도한다.
      }
    );
  }
  sync();
  return { sync, stop: subscribeTheme(sync) };
}
