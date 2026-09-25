// =============================================================================
// oort 마크 C2-04 Bubble (#2650). 제품 이름 표기가 momo에서 oort로 바뀌면서(B4.4)
// 이 클라이언트가 처음 가진 자기 표식을, owner가 고른 정식 마크로 바꾼 것이다.
// icon-system-exception(ADR-0172): Lucide에 없는 oort 브랜드 마크라 로컬 SVG로
// 남긴다. 기능 아이콘으로 재사용하지 않는다.
//
// 형태는 두 path다.
//   링   — 말풍선 꼬리가 달린 o. 사람과 팀, 그리고 메신저. 꼬리와 위성 쪽 홈이
//          모두 윤곽선의 일부인 닫힌 path 하나다(구멍은 evenodd로 빈다).
//   위성 — 오른쪽 위에서 링에 걸친 원. 에이전트. 링과는 틈으로 떨어져 있다.
//          틈은 배경색으로 칠한 것이 아니라 링에서 잘라낸 홈이라, 어떤 바탕
//          위에서도 한 색으로 성립한다.
//
// path는 손으로 적지 않았다. clients/web/scripts/brand-mark.mjs의 기하에서
// 생성된 값이고, 치수와 근거는 docs/brand/mark/README.md에 있다.
// brandMark.test.ts가 이 파일의 path와 생성기 출력이 같은지 본다.
//
// 기하가 두 벌이다.
//   small   — 24 격자, 16~32px 광학 보정판(틈·위성을 키우고 꼬리를 늘였다). 기본값.
//             로그인·연결 락업처럼 size-4·size-6 자리.
//   display — 64 격자 정본. 32px보다 큰 단색 자리. small을 크게 키우면 틈이
//             두꺼워 보인다. 온보딩 S0의 큰 로고는 #2732부터 KomettoMark(owner가
//             고른 코메토 레퍼런스 래스터)다.
//
// 색은 `currentColor` 하나다. 라이트/다크 두 벌을 두지 않고 부모가 정한 잉크를
// 물려받으므로, 로그인·연결·소유자 온보딩 락업에서 --accent가 그대로 걸린다
// (tokens.css가 유일한 색 출처). 탭 파비콘의 세 색(잉크 타일, 오프화이트 링,
// 호박 위성)은 탭 자산에만 쓴다.
//
// 락업(size-6, 24px)은 코메토로 바꾸지 않는다. 32px 미만에서는 캐릭터의 눈과
// 말풍선 꼬리가 읽히지 않고(docs/brand/mark/README.md 「작은 크기」), 락업은
// 부모의 accent 한 색을 물려받아야 하기 때문이다.
// =============================================================================

const GEOMETRY = {
  small: {
    viewBox: "0 0 24 24",
    ring: "M18.59 10.46A8 8 0 0 1 7.32 20.1A0.5 0.5 0 0 0 6.91 20.08L3.6 21.38A0.75 0.75 0 0 1 2.62 20.4L3.92 17.09A0.5 0.5 0 0 0 3.9 16.68A8 8 0 0 1 13.54 5.41A4.5 4.5 0 0 0 18.59 10.46ZM15 13A4 4 0 1 0 7 13A4 4 0 1 0 15 13Z",
    satellite: "M21 6A3 3 0 1 1 15 6A3 3 0 1 1 21 6Z",
  },
  display: {
    viewBox: "0 0 64 64",
    ring: "M49.19 24.69A20 20 0 0 1 21.24 50.46A1.5 1.5 0 0 0 20.08 50.33L13.64 52.22A1.5 1.5 0 0 1 11.78 50.36L13.67 43.92A1.5 1.5 0 0 0 13.54 42.76A20 20 0 0 1 39.31 14.81A8 8 0 0 0 49.19 24.69ZM43 33A12 12 0 1 0 19 33A12 12 0 1 0 43 33Z",
    satellite: "M53 17A6 6 0 1 1 41 17A6 6 0 1 1 53 17Z",
  },
} as const;

/**
 * oort 마크. 크기는 호출자가 유틸리티로 정한다(`size-4`, `size-6`). 경계 상자가
 * 격자의 가운데 3/4을 차지하므로 lucide 아이콘과 나란히 서도 무게가 맞는다.
 *
 * 기본은 `aria-hidden`이다. 마크는 거의 언제나 바로 옆의 "oort"라는 글자나
 * 이미 이름이 있는 컨트롤을 꾸미는 자리에 서기 때문에, 접근성 트리에 이름을
 * 한 번 더 얹으면 스크린리더가 같은 단어를 두 번 읽는다. 마크가 **혼자**
 * 제품을 가리키는 자리(창 좌상단 홈 타일)에서만 `title`을 넘긴다.
 */
export function OortMark({
  className,
  title,
  optical = "small",
}: {
  className?: string;
  /** 넘기면 접근 가능한 이름이 되고, 넘기지 않으면 장식으로 감춰진다. */
  title?: string;
  /** 그려질 크기. 32px 이하는 small(기본), 그보다 큰 자리는 display. */
  optical?: keyof typeof GEOMETRY;
}) {
  const geometry = GEOMETRY[optical];
  return (
    <svg
      viewBox={geometry.viewBox}
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : "true"}
    >
      <path d={geometry.ring} />
      <path d={geometry.satellite} />
    </svg>
  );
}
