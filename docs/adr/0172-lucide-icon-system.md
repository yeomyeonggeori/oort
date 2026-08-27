# ADR-0172: 웹 아이콘 체계를 lucide-react로 통일

- Status: **Accepted** (2026-08-25 성재 직접 지시 — "아이콘은 통일성을 위해서 lucide icon을 사용해줘. 더 좋은 라이브러리 있으면 거기를 참고해도 좋아")
- Date: 2026-08-25
- Deciders: 성재 (기안: Fable)

## 배경

buzz 대비 검수(2026-08-25, `claudedocs/buzz-feedback-20260825/`)에서 아이콘 어휘 통일이 지적됐다. **실측 정정(D1 집행 중 확인)**: clients/web은 이미 lucide-react@0.454.0(ISC)을 165곳에서 사실상 표준으로 쓰고 있었고 기능 아이콘 중 손제작 SVG는 0개였다 — 이 ADR은 그 사실상 표준을 **성문화·경계 고정**하는 결정이다(신규 도입이 아님). 이모지 피커의 "무라이브러리" 결정(#1688 계열)은 **이모지 데이터/렌더링**에 대한 것으로, UI 아이콘 라이브러리와는 별개 축이다.

## 결정

1. **lucide-react를 clients/web의 아이콘 정본으로 채택**한다. 선정 근거: ISC 라이선스(permissive 스택 부합)·tree-shakable(사용 아이콘만 번들)·1500+ 세트·shadcn/ui 생태 표준(기존 radix 프리미티브와 동거 관례)·외부 fetch 0(CSP 부합, 컴포넌트 인라인 SVG).
2. 기존 손제작 SVG는 동형 lucide 아이콘으로 전량 교체한다. lucide에 없는 도메인 고유 글리프(마스코트 등)만 로컬 SVG로 남기고 그 목록을 코드 주석으로 성문한다.
3. 크기·스트로크는 디자인 시스템 토큰과 정합(기본 16/20px, `currentColor`) — 세부 규칙은 `docs/design-system/README.md` 아이콘 절을 같은 PR에서 개정한다.
4. 번들 영향은 PR에 실측 기재한다(tree-shaking으로 사용분만 포함).

## 기각한 대안

- **현행 유지(손제작 SVG)**: 통일성 부재가 검수마다 재발, 아이콘당 제작 비용.
- **heroicons/tabler**: 품질 동급이나 shadcn 생태 표준성·아이콘 수에서 lucide 열위. "더 좋은 라이브러리" 조사 결과 lucide 유지 판정.
- **아이콘 폰트/스프라이트**: CSP·번들·트리셰이킹 열위, 사양 관례.

## 결과

- UX-D1 티켓으로 집행(전 표면 스윕). 이후 신규 UI는 lucide 어휘만 사용.
- 폰(clients/mobile)은 이 ADR 범위 밖 — 폰 표면 정본 절차로 별도 결정.
